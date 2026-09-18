// bundler — clé de config `css` du bundler. Trois valeurs :
//   · 'bundle' (défaut) — comportement historique, UN SEUL mjs_styles-<hash>.js importé
//     par le manifeste pour toute page. Sortie garantie BYTE-identique à l'ancien comportement :
//     bundleSharedStyles()/writeManifest() ne sont jamais retouchés sur ce chemin.
//   · 'split' — un fichier `mjs_style_<nom>-<hash>.js` PAR feuille partagée, importé
//     SEULEMENT par les modules qui la déclarent (`@css nom`) — le gain mesuré sur le
//     site de doc (~25 % de CSS mort par page). `mjs_root` reste toujours eager
//     (adopté sur le document, jamais déclaré par un composant). DEUX FILETS DE SÉCURITÉ
//     : (1) une feuille qu'aucun module ne déclare reste importée par
//     le manifeste (repli eager) ; (2) une feuille réclamée par un `<@view css="nom">`
//     LITTÉRAL (cf. runtime/mjs_element.ts) reste AUSSI eager, MÊME si un module la
//     déclare par ailleurs via `@css` — sans ce 2e filet, une page qui charge la vue
//     sans jamais charger ce module hériterait d'un `µ.CSS[nom]` vide, silencieusement
//     (seule trace : `µ.warn` « Orphelin CSS hérité » à l'exécution).
//   · 'lazy' — valeur légale à la CONFIG (mjs.config.json), mais PAS ENCORE implémentée :
//     choisie, elle fait échouer le BUILD avec un message dédié nommant les alternatives.
//
// Couvre aussi `µ._themeCssByName` (manifeste), jumeau de `µ._themeCss` mais PAR thème —
// un thème vers SON propre CSS, jamais celui des autres.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { basename, join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig } from '../src/bundler/config.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — clé css', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("défaut (`css` absent) produit la MÊME sortie que `css: 'bundle'` explicite — mécanisme historique intact", async function () {
    const source = ['<style @css="partagee"></style>', '<div>x</div>'].join('\n')

    const p1 = makeProject('css-default')
    writeFileSync(join(p1.stylesDir, 'partagee.sass'), '.p\n  color: red\n')
    writeFileSync(join(p1.srcDir, 'comp.mjs'), source)
    const b1 = new Bundler({ sourceDir: p1.srcDir, outputDir: p1.outDir, manifestPath: p1.manifest, stylesheetsDir: p1.stylesDir })
    const s1 = await b1.compile()
    assert.equal(s1.errors.length, 0, s1.errors.map(e => e.message).join('\n'))
    assert.equal(b1.cssMode, 'bundle', 'défaut attendu : bundle')
    const out1 = readFileSync(p1.manifest, 'utf-8')
    await b1.close()

    const p2 = makeProject('css-bundle-explicit')
    writeFileSync(join(p2.stylesDir, 'partagee.sass'), '.p\n  color: red\n')
    writeFileSync(join(p2.srcDir, 'comp.mjs'), source)
    const b2 = new Bundler({ sourceDir: p2.srcDir, outputDir: p2.outDir, manifestPath: p2.manifest, stylesheetsDir: p2.stylesDir, css: 'bundle' })
    const s2 = await b2.compile()
    assert.equal(s2.errors.length, 0, s2.errors.map(e => e.message).join('\n'))
    const out2 = readFileSync(p2.manifest, 'utf-8')
    await b2.close()

    const hash1 = out1.match(/mjs_styles-([a-f0-9]{8})\.js/)
    const hash2 = out2.match(/mjs_styles-([a-f0-9]{8})\.js/)
    assert.ok(hash1 && hash2, `les deux manifestes doivent importer mjs_styles-<hash>.js (mécanisme historique). out1:\n${out1}\nout2:\n${out2}`)
    assert.equal(hash1![1], hash2![1], 'même CSS source → même hash, que `css` soit absent ou explicitement \'bundle\'')
    assert.ok(!readdirSync(p1.outDir).some(f => f.startsWith('mjs_style_')), 'mode bundle : aucun fichier mjs_style_<nom> (split) ne doit exister')
  })

  // MÊME DÉFAUT QUE 'lazy', jamais porté ici : `dark-theme` et `dark_theme` se normalisent
  // tous deux en `mjs_style_dark_theme`. Le contenu du module JS diffère bien (il embarque
  // `µ.CSS['<nom>']`), donc les URL diffèrent — mais `writeHashed` appelle `cleanupOldHashes` sur
  // le STEM : écrire la seconde SUPPRIME le fichier de la première. Le composant A importe alors
  // une URL morte → 404 → tout le graphe de modules de la page tombe. Le build, lui, annonce
  // 0 erreur et 0 avertissement.
  it('deux noms de feuille qui se normalisent pareil : les DEUX fichiers restent sur le disque', async function () {
    const p = makeProject('split-collision')
    writeFileSync(join(p.stylesDir, 'dark-theme.sass'), '.x\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'dark_theme.sass'), '.x\n  color: red\n')
    writeFileSync(join(p.srcDir, 'comp-a.mjs'), '<style @css="dark-theme"></style>\n\n<div class="x">a</div>')
    writeFileSync(join(p.srcDir, 'comp-b.mjs'), '<style @css="dark_theme"></style>\n\n<div class="x">b</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    // chaque composant importe une feuille : les deux chemins importés doivent EXISTER
    const files = readdirSync(p.outDir)
    const compA = files.find(f => /^comp-a-/.test(f))!
    const compB = files.find(f => /^comp-b-/.test(f))!
    for (const [nom, comp] of [['dark-theme', compA], ['dark_theme', compB]] as const) {
      const js = readFileSync(join(p.outDir, comp), 'utf-8')
      const imports = [...js.matchAll(/import\s+['"]([^'"]*mjs_style_[^'"]+)['"]/g)].map(m => basename(m[1]))
      assert.equal(imports.length, 1, `${nom} : un import de feuille attendu, obtenu ${JSON.stringify(imports)}`)
      assert.ok(existsSync(join(p.outDir, imports[0])), `${nom} : le fichier importé ${imports[0]} a été SUPPRIMÉ du disque (404 à l'exécution). Présents : ${files.filter(f => f.startsWith('mjs_style_')).join(', ')}`)
    }
    await bundler.close()
  })

  it("mode 'split' : chaque feuille partagée émet SON PROPRE fichier mjs_style_<nom>-<hash>.js", async function () {
    const p = makeProject('css-split-files')
    writeFileSync(join(p.stylesDir, 'alpha.sass'), '.alpha\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    for (const name of ['alpha', 'beta']) {
      const hp = bundler.splitStyleHashedPaths[name]
      assert.ok(hp, `chemin haché manquant pour la feuille '${name}'`)
      const fname = basename(hp)
      assert.match(fname, new RegExp(`^mjs_style_${name}-[a-f0-9]{8}\\.js$`), `nom de fichier inattendu pour '${name}' : ${fname}`)
      assert.ok(existsSync(join(p.outDir, fname)), `fichier absent sur disque : ${fname}`)
      const content = readFileSync(join(p.outDir, fname), 'utf-8')
      assert.match(content, new RegExp(`µ\\.CSS\\["${name}"\\]`), `contenu attendu (µ.CSS["${name}"]) absent de ${fname} :\n${content}`)
    }
    await bundler.close()
  })

  it("mode 'split' : un module qui déclare 2 feuilles (`@css alpha beta`) reçoit 2 imports, jamais celui d'une 3e non déclarée (gamma)", async function () {
    const p = makeProject('css-split-imports')
    writeFileSync(join(p.stylesDir, 'alpha.sass'), '.alpha\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    writeFileSync(join(p.stylesDir, 'gamma.sass'), '.gamma\n  color: green\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), ['<style @css="alpha beta"></style>', '<div>x</div>'].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const compPath = join(p.outDir, basename(stats.manifest['comp']))
    const compSrc = readFileSync(compPath, 'utf-8')
    const alphaPath = bundler.splitStyleHashedPaths['alpha']
    const betaPath = bundler.splitStyleHashedPaths['beta']
    const gammaPath = bundler.splitStyleHashedPaths['gamma']
    assert.ok(alphaPath && betaPath && gammaPath, 'les 3 feuilles doivent être compilées (même si comp.mjs n\'en déclare que 2)')
    assert.ok(compSrc.includes(`import '${alphaPath}';`), `import de 'alpha' manquant dans comp.mjs compilé :\n${compSrc}`)
    assert.ok(compSrc.includes(`import '${betaPath}';`), `import de 'beta' manquant dans comp.mjs compilé :\n${compSrc}`)
    assert.ok(!compSrc.includes(`import '${gammaPath}';`), `comp.mjs importe 'gamma' alors qu'il ne la déclare pas (@css alpha beta) :\n${compSrc}`)
    await bundler.close()
  })

  it("mode 'split' : une feuille qu'aucun module ne déclare (`@css`) reste importée par le manifeste (filet de sécurité)", async function () {
    const p = makeProject('css-split-orphan')
    writeFileSync(join(p.stylesDir, 'alpha.sass'), '.alpha\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    writeFileSync(join(p.stylesDir, 'gamma.sass'), '.gamma\n  color: green\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), ['<style @css="alpha beta"></style>', '<div>x</div>'].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const gammaPath = bundler.splitStyleHashedPaths['gamma']
    assert.ok(gammaPath, 'gamma doit quand même être compilée')
    assert.ok(bundler.splitEagerHashedPaths.includes(gammaPath), 'gamma (déclarée par personne) doit rester dans les chemins eager')
    const manifestSrc = readFileSync(p.manifest, 'utf-8')
    // styles/animations partent en `Promise.all([import(...), ...])` (cf. writeManifest,
    // bundler/index.ts) — recherche de l'appel `import(...)`, peu importe s'il est SEUL
    // ou un ÉLÉMENT du tableau `Promise.all`.
    assert.ok(manifestSrc.includes(`import(${JSON.stringify(gammaPath)})`), `le manifeste doit importer gamma (orpheline) en eager :\n${manifestSrc}`)
    // alpha/beta, déclarées, ne doivent PAS repartir en eager (tout l'intérêt du mode split)
    const alphaPath = bundler.splitStyleHashedPaths['alpha']
    assert.ok(!bundler.splitEagerHashedPaths.includes(alphaPath), 'alpha est déclarée par comp.mjs — ne doit pas être eager')
    assert.ok(stats.warnings.some(w => w.includes('gamma') && w.includes('eager')),
      `un avertissement d'info doit lister la feuille orpheline restée eager. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it("mode 'split' : une feuille DÉCLARÉE par un module (`@css`) ET réclamée par un `<@view css=\"…\">` d'un AUTRE module reste importée par LE MANIFESTE (eager) ET par le module qui la déclare", async function () {
    const p = makeProject('css-split-view-filet')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    // comp-b déclare beta via @css — SANS le 2e filet, elle ne serait donc PAS eager.
    writeFileSync(join(p.srcDir, 'comp-b.mjs'), ['<style @css="beta"></style>', '<div>b</div>'].join('\n'))
    // page-y ne charge JAMAIS comp-b — elle réclame beta UNIQUEMENT via <@view css="…">.
    writeFileSync(join(p.srcDir, 'page-y.page.mjs'), ['<div>', '  <@view app-content css="beta">', '</div>'].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const betaPath = bundler.splitStyleHashedPaths['beta']
    assert.ok(betaPath, 'beta doit être compilée')

    // (a) reste importée par LE MANIFESTE, malgré la déclaration @css ailleurs (comp-b)
    assert.ok(bundler.splitEagerHashedPaths.includes(betaPath),
      'beta, réclamée par <@view css="beta"> dans page-y, doit rester eager MÊME SI comp-b la déclare via @css')
    const manifestSrc = readFileSync(p.manifest, 'utf-8')
    assert.ok(manifestSrc.includes(`import(${JSON.stringify(betaPath)})`), `le manifeste doit importer beta :\n${manifestSrc}`)

    // (b) ET continue d'être importée par comp-b, qui la déclare — les DEUX, pas l'un ou l'autre
    const compBSrc = readFileSync(join(p.outDir, basename(stats.manifest['comp-b'])), 'utf-8')
    assert.ok(compBSrc.includes(`import '${betaPath}';`),
      `comp-b.mjs (qui déclare @css beta) doit continuer à l'importer lui-même :\n${compBSrc}`)

    // avertissement DISTINCT de celui des orphelines : nomme beta ET la raison "<@view css=…>"
    assert.ok(stats.warnings.some(w => w.includes('beta') && w.includes('<@view') && !w.includes("qu'aucun module ne déclare")),
      `l'avertissement doit distinguer la raison "<@view css=…>" de la raison "aucun module ne déclare". warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it('mode \'split\' : `css="a b"` (deux noms) sur un `<@view>` force EAGER les DEUX feuilles nommées', async function () {
    const p = makeProject('css-split-view-filet-deuxnoms')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    writeFileSync(join(p.stylesDir, 'gamma.sass'), '.gamma\n  color: green\n')
    // beta est déclarée ailleurs (comp-b) — sans le filet <@view>, elle resterait cachée.
    // gamma n'est déclarée par personne — sert à vérifier que les DEUX noms du même
    // attribut sont bien extraits, pas seulement le premier.
    writeFileSync(join(p.srcDir, 'comp-b.mjs'), ['<style @css="beta"></style>', '<div>b</div>'].join('\n'))
    writeFileSync(join(p.srcDir, 'page-y.page.mjs'), ['<div>', '  <@view app-content css="beta gamma">', '</div>'].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const betaPath = bundler.splitStyleHashedPaths['beta']
    const gammaPath = bundler.splitStyleHashedPaths['gamma']
    assert.ok(betaPath && gammaPath, 'les deux feuilles doivent être compilées')
    assert.deepEqual([...bundler.viewRequestedSheets].sort(), ['beta', 'gamma'], 'les DEUX noms de css="beta gamma" doivent être extraits, pas seulement le premier')
    assert.ok(bundler.splitEagerHashedPaths.includes(betaPath), 'beta (nommée dans css="beta gamma") doit être eager')
    assert.ok(bundler.splitEagerHashedPaths.includes(gammaPath), 'gamma (nommée dans css="beta gamma") doit être eager')
    await bundler.close()
  })

  it("mode 'bundle' (défaut) : un `<@view css=\"…\">` n'a AUCUN effet — sortie inchangée, aucun scan (coût nul hors split)", async function () {
    const p = makeProject('css-bundle-view-noop')
    writeFileSync(join(p.stylesDir, 'beta.sass'), '.beta\n  color: blue\n')
    writeFileSync(join(p.srcDir, 'comp-b.mjs'), ['<style @css="beta"></style>', '<div>b</div>'].join('\n'))
    writeFileSync(join(p.srcDir, 'page-y.page.mjs'), ['<div>', '  <@view app-content css="beta">', '</div>'].join('\n'))
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.equal(bundler.cssMode, 'bundle')

    assert.equal(bundler.viewRequestedSheets.size, 0, 'mode bundle : le scan <@view css=…> ne doit JAMAIS tourner')
    assert.equal(bundler.splitEagerHashedPaths.length, 0, 'mode bundle : aucun chemin split eager (mécanisme inactif)')
    const manifestSrc = readFileSync(p.manifest, 'utf-8')
    assert.match(manifestSrc, /mjs_styles-[a-f0-9]{8}\.js/, 'mode bundle : import historique unique, inchangé')
    assert.ok(!readdirSync(p.outDir).some(f => f.startsWith('mjs_style_')), "mode bundle : aucun fichier mjs_style_<nom> (split) ne doit exister")
    await bundler.close()
  })

  it("mode 'split' : `mjs_root` reste TOUJOURS eager (jamais déclaré par un module), importé par le manifeste", async function () {
    const p = makeProject('css-split-root')
    writeFileSync(join(p.stylesDir, 'mjs_root.sass'), '.app\n  color: purple\n')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'split' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    assert.ok(bundler.splitRootHashedPath, 'mjs_root doit produire son propre fichier split')
    assert.match(basename(bundler.splitRootHashedPath!), /^mjs_style_root-[a-f0-9]{8}\.js$/)
    const rootSrc = readFileSync(join(p.outDir, basename(bundler.splitRootHashedPath!)), 'utf-8')
    assert.match(rootSrc, /document\.adoptedStyleSheets/, 'mjs_root doit rester adopté sur le document, pas dans un shadow')
    assert.match(rootSrc, /color:purple/)
    const manifestSrc = readFileSync(p.manifest, 'utf-8')
    assert.ok(manifestSrc.includes(`import(${JSON.stringify(bundler.splitRootHashedPath)})`), `le manifeste doit toujours importer mjs_root :\n${manifestSrc}`)
    await bundler.close()
  })

  it("`css: 'lazy'` compile (le mode n'est plus refusé) et n'écrit AUCUN module JS de feuille", async function () {
    const p = makeProject('css-lazy')
    writeFileSync(join(p.stylesDir, 'theme.sass'), '.card\n  color: teal\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<style @css="theme"></style>\n\n<div class="card">x</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(!readdirSync(p.outDir).some(f => /^mjs_style_theme-[a-f0-9]{8}\.js$/.test(f)), "mode lazy : la feuille ne doit PAS devenir un module JS (c'est le mode split)")
    assert.ok(!readdirSync(p.outDir).some(f => /^mjs_styles-[a-f0-9]{8}\.js$/.test(f)), 'mode lazy : aucun bundle de styles unique (c\'est le mode bundle)')
    await bundler.close()
  })

  describe('µ._themeCssByName (manifeste) — une entrée PAR thème, jamais le CSS des autres', function () {
    it('2 thèmes déclarés : chaque nom pointe vers SON PROPRE css, pas celui du voisin', async function () {
      const p = makeProject('css-themebyname')
      writeFileSync(join(p.srcDir, 'alpha.theme.mjs'), '<theme>\n  $$brand: red\n</theme>\n')
      writeFileSync(join(p.srcDir, 'beta.theme.mjs'), '<theme>\n  $$brand: blue\n</theme>\n')
      const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

      const manifestSrc = readFileSync(p.manifest, 'utf-8')
      const m = manifestSrc.match(/µ\._themeCssByName = (\{.*?\});/)
      assert.ok(m, `µ._themeCssByName absent du manifeste :\n${manifestSrc}`)
      const byName = JSON.parse(m![1]) as Record<string, string>
      assert.deepEqual(Object.keys(byName).sort(), ['alpha', 'beta'])
      assert.match(byName.alpha, /--mjs-brand: red/)
      assert.match(byName.beta, /--mjs-brand: blue/)
      assert.ok(!byName.alpha.includes('blue'), `l'entrée 'alpha' ne doit PAS porter le css de 'beta' : ${byName.alpha}`)
      assert.ok(!byName.beta.includes('red'), `l'entrée 'beta' ne doit PAS porter le css d'alpha' : ${byName.beta}`)
      // n'écarte rien de µ._themeCss (agrégat existant : les feuilles s'ajoutent à côté, sans rien retirer)
      assert.match(manifestSrc, /µ\._themeCss = /)
      await bundler.close()
    })

    it('aucun thème dans le projet : µ._themeCssByName n\'est PAS émis (comme µ._themeCss)', async function () {
      const p = makeProject('css-themebyname-none')
      writeFileSync(join(p.srcDir, 'comp.mjs'), '<div>x</div>')
      const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const manifestSrc = readFileSync(p.manifest, 'utf-8')
      assert.ok(!manifestSrc.includes('_themeCssByName'), `aucun thème dans le projet : _themeCssByName ne doit pas apparaître :\n${manifestSrc}`)
      await bundler.close()
    })
  })
})

describe('bundler/config — clé `css` (validation mjs.config.json)', function () {
  const tmp = (cfg: any) => {
    const root = mjsTmp('css-cfg')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
    return root
  }

  it("les 3 valeurs légales ('bundle'/'split'/'lazy') sont acceptées, aucune ne lève", function () {
    assert.doesNotThrow(() => findConfig(tmp({ css: 'bundle' })))
    assert.doesNotThrow(() => findConfig(tmp({ css: 'split' })))
    assert.doesNotThrow(() => findConfig(tmp({ css: 'lazy' })))
  })

  it("une valeur inconnue ('bogus') lève, nommant la clé et les valeurs légales", function () {
    assert.throws(() => findConfig(tmp({ css: 'bogus' })), /css invalide : 'bogus'/)
    assert.throws(() => findConfig(tmp({ css: 'bogus' })), /bundle, split, lazy/)
  })

  it('un type non-chaîne (nombre) lève la même erreur — pas un crash générique', function () {
    assert.throws(() => findConfig(tmp({ css: 42 })), /css invalide/)
  })
})
