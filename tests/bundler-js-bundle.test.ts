// bundler — clé de config `js` (« fusionner les petits composants
// à la construction »). Deux valeurs :
//   · 'split' (défaut) — comportement historique, UN fichier haché PAR unité (composant, module,
//     cœur) + le manifeste qui les orchestre. Sortie garantie BYTE-identique à l'ancien
//     comportement : emitPendingUnits()/writeManifest() ne sont jamais retouchés sur ce chemin.
//   · 'bundle' — TOUT (cœur, styles partagés, animations, manifeste externe, modules,
//     composants) fusionné dans le SEUL fichier `manifestPath`, via esbuild.build() en mémoire
//     sur des modules VIRTUELS ('mjs:core', 'mjs:setup', 'mjs:unit/<stem>'…). Exige
//     `css: 'bundle'` (défaut) : incompatible avec `css: 'split'`/`'lazy'`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { join, basename } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { setMessagesLang } from '../src/messages/index.js'
import { stripEsm } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

function makeProject(prefix: string): { root: string; srcDir: string; stylesDir: string; outDir: string; manifestPath: string } {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifestPath: join(root, 'out/bundle.js') }
}

// fixture partagée : parent → 2 enfants (balises littérales), un module `@import`-é, une
// animation `@transition.fade`, une feuille partagée `@css theme` — cf. § 5.1 de la conception.
function writeFixture(p: ReturnType<typeof makeProject>, cfgExtra: Record<string, unknown> = {}): void {
  writeFileSync(join(p.srcDir, 'util.civet'), 'export triple := (x) -> x * 3\n')
  writeFileSync(join(p.stylesDir, 'theme.sass'), '.parent\n  color: red\n')
  writeFileSync(join(p.srcDir, 'child-a.mjs'), '<p class="child-a">A</p>\n')
  writeFileSync(join(p.srcDir, 'child-b.mjs'), '<p class="child-b">B</p>\n')
  writeFileSync(join(p.srcDir, 'app-parent.mjs'), [
    '@import triple \'util.civet\'',
    '',
    '<style @css="theme"></style>',
    '<script>',
    '$show ?= true',
    '</script>',
    '',
    '<p class="triple">{triple(2)}</p>',
    '{if $show}<p class="fade" @transition.fade>fondu</p>{end}',
    '<mjs-child-a></mjs-child-a>',
    '<mjs-child-b></mjs-child-b>'
  ].join('\n'))
  writeFileSync(join(p.root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', stylesheetsDir: 'styles', ...cfgExtra,
  }))
}

async function buildFixture(p: ReturnType<typeof makeProject>, cfgExtra: Record<string, unknown> = {}): Promise<{ bundler: Bundler; stats: any }> {
  writeFixture(p, cfgExtra)
  const found = findConfig(p.root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  return { bundler, stats }
}

// montage happy-dom d'un manifeste 'bundle' : contrairement à src/testing/index.ts
// (createHarness), qui suppose le layout ÉCLATÉ (mjs_core-*.js + un fichier par composant sur
// disque), un manifeste 'bundle' est un SEUL module ES autoporteur — chargé ici comme le fait
// déjà server/renderToString.ts (stripEsm + window.eval) pour son propre cœur.
async function mountBundle(manifestPath: string): Promise<{ window: any; document: any }> {
  let HappyDOM: any
  try {
    HappyDOM = await import('happy-dom')
  } catch {
    throw new Error('happy-dom absent — dépendance de dev/peer optionnelle')
  }
  const window: any = new HappyDOM.Window({ url: 'http://localhost/' })
  const document: any = window.document
  const src = stripEsm(readFileSync(manifestPath, 'utf-8'))
  window.eval(src)
  return { window, document }
}

describe('bundler — clé js', function () {
  this.timeout(30000)

  after(async () => { await terminateSharedWorkerPool() })

  describe("mode 'bundle' — assemblage en un seul fichier", function () {
    it('outputDir ne contient AUCUN .js hormis les satellites (aucun mjs_core/mjs_styles/mjs_anims/composant écrit séparément)', async function () {
      const p = makeProject('js-bundle-fichiers')
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const manifestName = basename(p.manifestPath)
      const jsFiles = existsSync(p.outDir) ? readdirSync(p.outDir).filter(f => f.endsWith('.js') && f !== manifestName) : []
      assert.deepEqual(jsFiles, [], `outputDir ne doit contenir aucun .js séparé (hors manifeste), trouvé : ${jsFiles.join(', ')}`)
      assert.ok(existsSync(p.manifestPath), 'le manifeste doit exister')
    })

    it('stats.sizes contient une ligne pour bundle.js avec sa taille RÉELLE (seule sortie JS du mode)', async function () {
      const p = makeProject('js-bundle-sizes')
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      assert.equal(stats.sizes.length, 1, `stats.sizes doit contenir EXACTEMENT bundle.js, trouvé : ${JSON.stringify(stats.sizes)}`)
      const [entry] = stats.sizes
      assert.equal(entry.name, 'bundle')
      assert.equal(entry.bytes, statSync(p.manifestPath).size, 'la taille rapportée doit être la taille RÉELLE du fichier sur disque')
      assert.ok(entry.bytes > 0, 'un manifeste fusionné (cœur + 3 composants) ne peut pas peser 0 octet')
    })

    it('bundle.js est un module ES valide, contient le cœur ET les 3 définitions, aucun repère ni spécificateur mjs: résiduel', async function () {
      const p = makeProject('js-bundle-contenu')
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const text = readFileSync(p.manifestPath, 'utf-8')
      assert.equal(text.includes('-ZZZZZZZZ.'), false, 'aucun repère non résolu ne doit survivre')
      // un COMMENTAIRE de frontière de module ('// mjsv:mjs:core', posé par esbuild.build() en
      // dev non minifié) n'est pas un bogue — seul un import/spécificateur RÉEL et encore actif
      // ('import "mjs:...) en serait un.
      assert.equal(/\bfrom\s*['"]mjs:|import\(\s*['"]mjs:|import\s*['"]mjs:/.test(text), false, 'aucun import mjs: ne doit survivre à esbuild.build()')
      assert.ok(text.includes('"mjs-child-a"'), 'le cœur doit contenir la définition de child-a')
      assert.ok(text.includes('"mjs-child-b"'), 'le cœur doit contenir la définition de child-b')
      assert.ok(text.includes('"mjs-app-parent"'), 'le cœur doit contenir la définition de parent')
      assert.ok(text.includes('µ.Element'), 'le cœur du runtime doit être présent')
      // `_dir_<Classe>` (transpiler/template.ts:22) : en mode bundle, remplacé par le littéral
      // urlPrefix ('/out/' ici) — jamais laissé en `new URL('.', import.meta.url).href`, qui
      // pointerait vers le dossier du FICHIER UNIQUE, pas forcément celui des satellites.
      assert.ok(text.includes('"/out/"'), 'le littéral urlPrefix doit remplacer _dir_ dans au moins un composant')
      assert.equal(/new URL\(\s*['"]\.['"]\s*,\s*import\.meta\.url\s*\)\.href/.test(text), false, '_dir_ ne doit jamais rester en new URL(\'.\', import.meta.url).href dans un composant fusionné')
    })

    it('montage happy-dom réel : enfants rendus, animation et feuille partagée posées, µ.paths uniforme, import { µ } possible', async function () {
      const p = makeProject('js-bundle-montage')
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const { window, document } = await mountBundle(p.manifestPath)
      const µ = window.µ
      assert.ok(µ, 'µ doit être exposé sur window (build de dev)')
      assert.ok(µ.anim && typeof µ.anim.fade === 'function', 'µ.anim.fade doit être défini (animation utilisée par @transition.fade)')
      assert.ok(µ.CSS && µ.CSS['theme'], 'µ.CSS[\'theme\'] doit être posé (feuille partagée @css)')
      assert.ok(µ.paths['app-parent'], 'µ.paths doit connaître "parent"')
      assert.ok(µ.paths['child-a'], 'µ.paths doit connaître "child-a"')
      assert.equal(µ.paths['app-parent'], µ.paths['child-a'], 'toutes les entrées de µ.paths pointent vers le MÊME fichier (le bundle lui-même)')

      const el = document.createElement('mjs-app-parent')
      document.body.appendChild(el)
      await new Promise(r => setTimeout(r, 0))
      const shadow = el._shadow ?? el
      assert.equal(shadow.querySelector('.triple')?.textContent, '6', 'le module @import-é (triple) doit fonctionner')
      assert.ok(shadow.querySelector('mjs-child-a'), 'child-a doit être présent dans le rendu')
      assert.ok(shadow.querySelector('mjs-child-b'), 'child-b doit être présent dans le rendu')
      const childA = shadow.querySelector('mjs-child-a')
      const childAShadow = childA._shadow ?? childA
      assert.equal(childAShadow.querySelector('.child-a')?.textContent, 'A', 'child-a doit avoir rendu son propre contenu (donc être bien défini/upgradé)')
    })

    it('mode module : `import { µ }` du fichier assemblé fonctionne (export { µ } en toute fin)', async function () {
      const p = makeProject('js-bundle-export')
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const text = readFileSync(p.manifestPath, 'utf-8')
      assert.ok(/\bexport\s*\{/.test(text), 'le fichier assemblé doit exporter µ')
    })

    it("ordre : les enfants sont définis AVANT le parent (µ._def, ordre textuel)", async function () {
      const p = makeProject('js-bundle-ordre')
      // build de DEV (non minifié) : la chaîne du tag survit à la minification, mais rester
      // en dev simplifie la lecture directe du texte sans dépendre du style de guillemets choisi.
      const { stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const text = readFileSync(p.manifestPath, 'utf-8')
      const idxA = text.indexOf('µ._def("mjs-child-a"')
      const idxB = text.indexOf('µ._def("mjs-child-b"')
      const idxParent = text.indexOf('µ._def("mjs-app-parent"')
      assert.ok(idxA >= 0 && idxB >= 0 && idxParent >= 0, 'les 3 définitions doivent être présentes')
      assert.ok(idxA < idxParent, 'child-a doit se définir avant parent')
      assert.ok(idxB < idxParent, 'child-b doit se définir avant parent')
    })

    it('déterminisme : 3 constructions fraîches → bundle.js identique à l\'octet', async function () {
      const md5s: string[] = []
      for (let i = 0; i < 3; i++) {
        const p = makeProject('js-bundle-determ-'+ i)
        const { stats } = await buildFixture(p, { js: 'bundle' })
        assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
        md5s.push(createHash('md5').update(readFileSync(p.manifestPath)).digest('hex'))
      }
      assert.equal(md5s[1], md5s[0], 'build 2 doit être identique au build 1')
      assert.equal(md5s[2], md5s[0], 'build 3 doit être identique au build 1')
    })

    it('deux compile() identiques (même instance) : écriture sautée (mtime inchangé)', async function () {
      const p = makeProject('js-bundle-skip-write')
      const { bundler, stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const before = statSync(p.manifestPath).mtimeMs
      await new Promise(r => setTimeout(r, 20))
      const stats2 = await bundler.compile()
      assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
      const after = statSync(p.manifestPath).mtimeMs
      assert.equal(after, before, 'contenu inchangé → écriture sautée, mtime stable')
    })

    it('cache : composant inchangé réutilisé sans retranspiler ; composant modifié réassemblé correctement', async function () {
      const p = makeProject('js-bundle-cache')
      const { bundler, stats } = await buildFixture(p, { js: 'bundle' })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      // espion sur compileMjsCold (jamais appelé pour un cache-hit) : compte les recompilations
      // RÉELLES, plutôt qu'un détail interne du pool de transpilation.
      const spy = { calls: [] as string[] }
      const originalCold = (bundler as any).compileMjsCold.bind(bundler)
      ;(bundler as any).compileMjsCold = (file: string, ...rest: any[]) => { spy.calls.push(file); return originalCold(file, ...rest) }
      writeFileSync(join(p.srcDir, 'child-a.mjs'), '<p class="child-a">A modifié</p>\n')
      const stats2 = await bundler.compile()
      assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
      assert.equal(spy.calls.length, 1, `seul child-a (modifié) doit être retranspilé, jamais child-b/parent (cache-hit) — appels : ${spy.calls.join(', ')}`)
      assert.ok(spy.calls[0].endsWith('child-a.mjs'), 'le seul appel doit concerner child-a.mjs')
      const { document } = await mountBundle(p.manifestPath)
      const el = document.createElement('mjs-app-parent')
      document.body.appendChild(el)
      await new Promise(r => setTimeout(r, 0))
      const shadow = el._shadow ?? el
      const childA = shadow.querySelector('mjs-child-a')
      const childAShadow = childA._shadow ?? childA
      assert.equal(childAShadow.querySelector('.child-a')?.textContent, 'A modifié', 'le composant modifié doit refléter le nouveau contenu après réassemblage')
    })
  })

  describe("mode 'split' (défaut) — non-régression stricte", function () {
    it('défaut (`js` absent) === `js: \'split\'` explicite : mêmes fichiers, octet pour octet', async function () {
      const p1 = makeProject('js-split-defaut-a')
      const p2 = makeProject('js-split-defaut-b')
      const { stats: s1 } = await buildFixture(p1, {})
      const { stats: s2 } = await buildFixture(p2, { js: 'split' })
      assert.equal(s1.errors.length, 0)
      assert.equal(s2.errors.length, 0)
      const names1 = readdirSync(p1.outDir).sort()
      const names2 = readdirSync(p2.outDir).sort()
      assert.deepEqual(names1, names2, 'mêmes noms de fichiers (mêmes hashes, mêmes empreintes)')
      for (const f of names1) {
        if (f === '.mangle-cache.json') continue // dérive selon l'ordre d'insertion inter-process, non fonctionnel
        assert.deepEqual(readFileSync(join(p1.outDir, f)), readFileSync(join(p2.outDir, f)), `${f} doit être identique`)
      }
    })
  })

  describe("clé `js` × `css` — incompatibilité de configuration", function () {
    const tmp = (cfg: any) => {
      const root = mjsTmp('js-cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
      return root
    }

    it("les 2 valeurs légales ('split'/'bundle') sont acceptées, aucune ne lève", function () {
      assert.doesNotThrow(() => findConfig(tmp({ js: 'split' })))
      assert.doesNotThrow(() => findConfig(tmp({ js: 'bundle' })))
    })

    it("une valeur inconnue ('bogus') lève, nommant la clé et les valeurs légales", function () {
      assert.throws(() => findConfig(tmp({ js: 'bogus' })), /js invalide : 'bogus'/)
      assert.throws(() => findConfig(tmp({ js: 'bogus' })), /split, bundle/)
    })

    it('un type non-chaîne (nombre) lève la même erreur — pas un crash générique', function () {
      assert.throws(() => findConfig(tmp({ js: 42 })), /js invalide/)
    })

    it("js: 'bundle' + css: 'split' lève une erreur de config claire (fr)", function () {
      assert.throws(() => findConfig(tmp({ js: 'bundle', css: 'split' })), /js: 'bundle' est incompatible avec css/)
    })

    it("js: 'bundle' + css: 'lazy' lève aussi", function () {
      assert.throws(() => findConfig(tmp({ js: 'bundle', css: 'lazy' })), /js: 'bundle' est incompatible avec css/)
    })

    it("js: 'bundle' + css absent (défaut 'bundle') ne lève pas", function () {
      assert.doesNotThrow(() => findConfig(tmp({ js: 'bundle' })))
    })

    it("js: 'bundle' + css: 'bundle' explicite ne lève pas", function () {
      assert.doesNotThrow(() => findConfig(tmp({ js: 'bundle', css: 'bundle' })))
    })
  })

  describe("clé `csp` × `js: 'bundle'` — impasse de configuration (aucune valeur de css ne satisferait les deux)", function () {
    const tmp = (cfg: any) => {
      const root = mjsTmp('csp-js-cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(cfg))
      return root
    }

    it("csp: true + js: 'bundle' (css absent, défaut 'bundle') lève le message DÉDIÉ, pas le message css générique", function () {
      assert.throws(() => findConfig(tmp({ csp: true, js: 'bundle' })), /csp: true est incompatible avec js: 'bundle'/)
    })

    it("csp: true + js: 'bundle' + css: 'split' lève ENCORE le message dédié (pas « posez css: split », déjà posé, impasse)", function () {
      assert.throws(() => findConfig(tmp({ csp: true, js: 'bundle', css: 'split' })), /csp: true est incompatible avec js: 'bundle'/)
    })

    it("csp: true + js: 'bundle' + css: 'lazy' lève aussi le message dédié", function () {
      assert.throws(() => findConfig(tmp({ csp: true, js: 'bundle', css: 'lazy' })), /csp: true est incompatible avec js: 'bundle'/)
    })

    it("csp: true + js: 'split' (défaut) : message css générique INCHANGÉ, pas le message dédié", function () {
      assert.throws(() => findConfig(tmp({ csp: true, js: 'split' })), /csp: true est incompatible avec css: 'bundle'/)
    })

    it("csp: true + css: 'split' SANS js : message css générique INCHANGÉ (non-régression)", function () {
      assert.doesNotThrow(() => findConfig(tmp({ csp: true, css: 'split' })))
    })

    it("js: 'bundle' + css: 'split' SANS csp : message js×css générique INCHANGÉ (non-régression)", function () {
      assert.throws(() => findConfig(tmp({ js: 'bundle', css: 'split' })), /js: 'bundle' est incompatible avec css/)
    })

    it("csp: true + js: 'bundle' : le message anglais existe et dit la même chose (parité)", function () {
      // findConfig() pose la langue ambiante d'après la clé `lang` du config LU (jamais une
      // langue posée avant l'appel, cf. tests/config-json-parse-error.test.ts) : passe par 'en'
      // ICI, dans le fichier, pas par un setMessagesLang() externe qui serait aussitôt écrasé.
      // la langue ambiante est un état GLOBAL du catalogue : remise en français après, sinon tout
      // test joué ensuite dans le même processus lit ses messages en anglais
      try {
        assert.throws(() => findConfig(tmp({ csp: true, js: 'bundle', lang: 'en' })), /csp: true is incompatible with js: 'bundle'/)
      }
      finally {
        setMessagesLang('fr')
      }
    })
  })
})
