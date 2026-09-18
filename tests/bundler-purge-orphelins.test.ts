// Test de régression — purge des orphelins d'outputDir après
// un `mjs build` réussi. Le build remplace déjà l'ancienne empreinte d'un fichier qui CHANGE
// (cleanupOldHashes), mais jamais un NOM qui DISPARAÎT (composant renommé ou supprimé) : mesuré
// sur un cas réel, 893 fichiers / 17 Mo dans outputDir pour 330 écrits par le dernier build.
// Rien n'est SERVI (le manifeste ne les référence plus), mais le dossier MENT sur ce que le site
// contient réellement. Cf. Bundler.pruneOrphans (src/bundler/index.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, unlinkSync, readdirSync, existsSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// composant réactif minimal (UN <script>) — sondé : un template SANS <script>
// n'émet AUCUNE carte de source en dev, ce composant EN émet une (writeHashed(..., map)), ce qui
// permet de couvrir le sort du .map dans les mêmes scénarios (orphelin retiré / survivant).
const comp = (lettre: string) => [
  '<script>',
  '  $x = 1',
  '</script>',
  `<p>{$x} ${lettre}</p>`,
].join('\n')

describe('Bundler.pruneOrphans() — purge des orphelins d\'outputDir après un build sans erreur', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("un composant renommé/supprimé laisse un orphelin retiré par pruneOrphans() ; rien d'orphelin sur un build neuf ; étrangers/stables intacts ; .map d'un émis survit", async function () {
    const root   = mjsTmp('purge-orphelins')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'a.mjs'), comp('a'))
    writeFileSync(join(srcDir, 'b.mjs'), comp('b'))

    // manifestPath DANS outDir (pas à côté) : prouve qu'un nom STABLE survit même logé au même
    // endroit que les fichiers hachés qu'il faut, lui, retirer.
    const bundler1 = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js') })
    const stats1 = await bundler1.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))

    // 1. rien d'orphelin sur un build tout juste sorti : tout ce qui est sur disque vient d'être émis
    const { removed: removed1, failed: failed1 } = bundler1.pruneOrphans()
    assert.deepEqual(removed1, [], 'un build neuf ne doit rien avoir à purger')
    assert.deepEqual(failed1, [])
    await bundler1.close()

    // le sinistre mesuré en production : un composant renommé (suppression + fichier neuf)
    unlinkSync(join(srcDir, 'b.mjs'))
    writeFileSync(join(srcDir, 'c.mjs'), comp('c'))

    const avant = readdirSync(outDir)
    const bJs  = avant.find(f => /^b-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(bJs, `attendu un b-<hash>.js après le 1er build, trouvé : ${avant.join(', ')}`)
    const bMap = avant.find(f => f === `${bJs}.map`)

    // 2. dépose AVANT le 2e compile — fichiers étrangers/stables (jamais dans la famille hachée du
    // bundler) et fichiers de la famille hachée jamais émis par ce projet (« zombies »)
    writeFileSync(join(outDir, 'notes.txt'), 'hello\n')
    writeFileSync(join(outDir, 'index.html'), '<html></html>\n')
    writeFileSync(join(outDir, 'card.wide.css'), '.card{color:red}\n')
    writeFileSync(join(outDir, '.mangle-cache.json'), '{}')
    mkdirSync(join(outDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(outDir, 'i18n', 'fr', 'x-abcdef12.json'), '{}')
    mkdirSync(join(outDir, 'mjs_pages'), { recursive: true })
    writeFileSync(join(outDir, 'mjs_pages', 'index.html'), '<html></html>\n')
    writeFileSync(join(outDir, 'zombie-0123abcd.js'), 'export {}\n')
    writeFileSync(join(outDir, 'zombie-0123abcd.js.map'), '{}')
    writeFileSync(join(outDir, 'hero-960-89abcdef.webp'), Buffer.from([1, 2, 3]))

    // NOUVELLE instance : this.cache/emittedThisCompile repartent de zéro, isole proprement la
    // ré-invocation (même motif que bundler-binary-asset-cleanup.test.ts)
    const bundler2 = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js') })
    const stats2 = await bundler2.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))

    const { removed, failed } = bundler2.pruneOrphans()
    assert.deepEqual(failed, [])
    const attendus = [bJs, ...(bMap ? [bMap] : []), 'hero-960-89abcdef.webp', 'zombie-0123abcd.js', 'zombie-0123abcd.js.map']
      .sort((a, b) => a! < b! ? -1 : a! > b! ? 1 : 0)
    assert.deepEqual(removed, attendus, `attendu exactement l'orphelin b (+ son .map) et les 3 zombies, trouvé : ${removed.join(', ')}`)

    const apres = readdirSync(outDir)
    // 1./2. l'orphelin et les zombies ont disparu
    assert.ok(!apres.includes(bJs!), 'le .js orphelin doit avoir disparu')
    if (bMap) assert.ok(!apres.includes(bMap), 'le .map orphelin doit avoir disparu')
    assert.ok(!apres.includes('zombie-0123abcd.js') && !apres.includes('zombie-0123abcd.js.map') && !apres.includes('hero-960-89abcdef.webp'),
      'les 3 zombies (famille hachée jamais émise) doivent avoir disparu')
    // 2. étrangers/stables intacts
    assert.ok(existsSync(join(outDir, 'notes.txt')), 'notes.txt (étranger) doit survivre')
    assert.ok(existsSync(join(outDir, 'index.html')), 'index.html (étranger) doit survivre')
    assert.ok(existsSync(join(outDir, 'card.wide.css')), 'card.wide.css (nom stable, CSS de layout) doit survivre')
    assert.ok(existsSync(join(outDir, '.mangle-cache.json')), '.mangle-cache.json (dotfile) doit survivre')
    assert.ok(existsSync(join(outDir, 'i18n', 'fr', 'x-abcdef12.json')), 'i18n/fr/ (sous-dossier) doit survivre intact')
    assert.ok(existsSync(join(outDir, 'mjs_pages', 'index.html')), 'mjs_pages/ (sous-dossier) doit survivre intact')
    // 3. a/c (émis ce tour-ci) et leur .map survivent, le manifeste (nom stable) aussi
    const aJs = apres.find(f => /^a-[a-f0-9]{8}\.js$/.test(f))
    const cJs = apres.find(f => /^c-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(aJs, 'a doit survivre')
    assert.ok(cJs, 'c doit survivre')
    assert.ok(apres.includes(`${aJs}.map`), `le .map de a (émis ce tour-ci) doit survivre — vu : ${apres.join(', ')}`)
    assert.ok(apres.includes(`${cJs}.map`), `le .map de c (émis ce tour-ci) doit survivre — vu : ${apres.join(', ')}`)
    assert.ok(apres.some(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f)), 'le runtime doit survivre')
    assert.ok(apres.includes('bundle.js'), 'le manifeste (nom stable, logé DANS outputDir) doit survivre')

    await bundler2.close()
  })

  it('aucun compile() encore : pruneOrphans() ne touche rien (garde muette EXCLUE)', async function () {
    const root   = mjsTmp('purge-garde-sans-compile')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'zombie-89abcdef.js'), 'export {}\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js') })
    const { removed, failed } = bundler.pruneOrphans()
    assert.deepEqual(removed, [])
    assert.deepEqual(failed, [])
    assert.ok(existsSync(join(outDir, 'zombie-89abcdef.js')), 'sans compile() encore tourné, rien ne doit être touché')
  })

  it('compile() EN ERREUR : pruneOrphans() ne touche rien — un build partiel garde tout', async function () {
    const root   = mjsTmp('purge-garde-erreur')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // fixture d'erreur vérifiée manuellement : parenthèse jamais refermée → échec de parse Civet
    writeFileSync(join(srcDir, 'bad.mjs'), [
      '<script>',
      '  x = (',
      '</script>',
      '<p>x</p>',
    ].join('\n'))
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'zombie-89abcdef.js'), 'export {}\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js') })
    const stats = await bundler.compile()
    assert.ok(stats.errors.length > 0, 'la fixture doit produire au moins une erreur de compile')

    const { removed, failed } = bundler.pruneOrphans()
    assert.deepEqual(removed, [], 'un build en erreur ne doit RIEN purger (build partiel : garde tout)')
    assert.deepEqual(failed, [])
    assert.ok(existsSync(join(outDir, 'zombie-89abcdef.js')), 'le zombie doit survivre à un build en erreur')

    await bundler.close()
  })

  it('le manifeste survit à pruneOrphans() même si son nom collisionne avec la famille hachée', async function () {
    const root   = mjsTmp('purge-manifest-collision')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'a.mjs'), comp('a'))

    // manifestPath au nom `bundle-deadbeef.js` — matche HASHED_OUTPUT_RE (8 hex) : writeManifest()
    // écrit hors de emittedThisCompile, AVANT le fix pruneOrphans() le retirait au build qui vient
    // de l'écrire
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle-deadbeef.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(existsSync(join(outDir, 'bundle-deadbeef.js')), 'le manifeste doit exister après compile()')

    const { removed, failed } = bundler.pruneOrphans()
    assert.deepEqual(failed, [])
    assert.ok(!removed.includes('bundle-deadbeef.js'), `le manifeste ne doit JAMAIS apparaître dans removed, trouvé : ${removed.join(', ')}`)
    assert.ok(existsSync(join(outDir, 'bundle-deadbeef.js')), 'le manifeste doit SURVIVRE à pruneOrphans() malgré la collision de nom')

    await bundler.close()
  })

  it('le manifeste survit aussi quand son dossier est un LIEN SYMBOLIQUE vers outputDir', async function () {
    const root   = mjsTmp('purge-manifest-symlink')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'real-out')
    const alias  = join(root, 'alias-out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    symlinkSync(outDir, alias)
    writeFileSync(join(srcDir, 'a.mjs'), comp('a'))

    // outputDir = dossier réel, manifestPath via l'alias : même dossier physique, deux chaînes différentes — la comparaison
    // de chaînes du 1er correctif laissait manifestName à null, le manifeste repartait dans la purge
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(alias, 'bundle-deadbeef.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(existsSync(join(outDir, 'bundle-deadbeef.js')), 'le manifeste doit exister dans le dossier réel après compile()')

    const { removed, failed } = bundler.pruneOrphans()
    assert.deepEqual(failed, [])
    assert.ok(!removed.includes('bundle-deadbeef.js'), `le manifeste ne doit JAMAIS apparaître dans removed, trouvé : ${removed.join(', ')}`)
    assert.ok(existsSync(join(outDir, 'bundle-deadbeef.js')), 'le manifeste doit SURVIVRE à pruneOrphans() derrière un lien symbolique')

    await bundler.close()
  })

  it('un composant redemandé une 2e fois DANS LE MÊME compile() (hit intra-compile) ne bloque pas la purge', async function () {
    const root   = mjsTmp('purge-cache-hit-intra')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const compPath = join(srcDir, 'a.mjs')
    writeFileSync(compPath, comp('a'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    // AUCUN nouveau compile() ici — redemande le MÊME composant PAR LA MÉTHODE PUBLIQUE qui passe
    // par this.cache : motif réel (resolveTagShortcuts/une inclusion redemande un
    // composant déjà compilé PLUS TARD dans le MÊME tour) — 11 hits de ce genre mesurés sur un
    // build froid réel (685 fichiers), sans qu'aucun 2e compile() n'ait jamais tourné.
    await bundler.compileMjs(compPath)

    // dépose un zombie APRÈS le compile, AVANT pruneOrphans() : sa disparition prouve que la purge
    // a réellement tourné (pas juste « rien à faire »)
    writeFileSync(join(outDir, 'zombie-0123abcd.js'), 'export {}\n')

    const { removed, failed, skipped } = bundler.pruneOrphans()
    assert.equal(skipped, undefined, `un hit intra-compile ne doit JAMAIS bloquer la purge, trouvé skipped=${skipped}`)
    assert.deepEqual(removed, ['zombie-0123abcd.js'], `le zombie doit être retiré (preuve que la purge a bien tourné), trouvé : ${removed.join(', ')}`)
    assert.deepEqual(failed, [])
    assert.ok(!existsSync(join(outDir, 'zombie-0123abcd.js')), 'le zombie doit avoir disparu')

    await bundler.close()
  })

  it('un compile qui a resservi un composant depuis le cache refuse de purger — ses assets annexes ne sont jamais réinjectés', async function () {
    const root   = mjsTmp('purge-cache-hit')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp-asset.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('logo.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([1, 2, 3]))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const logoAvant = readdirSync(outDir).find(f => /^logo-[a-f0-9]{8}\.png$/.test(f))
    assert.ok(logoAvant, `attendu un logo-<hash>.png après le 1er compile, trouvé : ${readdirSync(outDir).join(', ')}`)

    // 2e compile, SANS RIEN CHANGER, MÊME instance : comp-asset.mjs cache-hit (this.cache) —
    // resolveOneAsset() n'est pas rappelé, logo-<hash>.png n'entre PAS dans emittedThisCompile
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))

    const { removed, failed, skipped } = bundler.pruneOrphans()
    assert.equal(skipped, 'cache', `un compile qui a resservi son cache doit refuser de purger, trouvé removed=${removed.join(', ')}`)
    assert.deepEqual(removed, [])
    assert.deepEqual(failed, [])
    assert.ok(existsSync(join(outDir, logoAvant!)), 'le logo doit survivre — AVANT le fix, pruneOrphans() le retirait (jamais réinjecté par le cache hit)')

    // instance NEUVE sur le MÊME dossier : cache FROID (comme mjs build), le compile réémet tout —
    // pruneOrphans() doit tourner normalement (skipped absent), rien d'orphelin
    const bundlerNeuf = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats3 = await bundlerNeuf.compile()
    assert.equal(stats3.errors.length, 0, stats3.errors.map(e => e.message).join('\n'))
    const p3 = bundlerNeuf.pruneOrphans()
    assert.equal(p3.skipped, undefined, `un compile à cache froid ne doit pas être skippé, trouvé : ${p3.skipped}`)
    assert.deepEqual(p3.removed, [], "rien d'orphelin sur un cache froid qui réémet tout")
    assert.ok(existsSync(join(outDir, logoAvant!)), 'le logo doit toujours être là')

    await bundler.close()
    await bundlerNeuf.close()
  })
})
