// Test de régression — quand un module `.civet` (ou `.coffee`) importé via
// `@import` change, les `.mjs` qui l'importent doivent être recompilés pour
// mettre à jour leur référence vers le nouveau hash.
//
// Bug : `partialDependents` ne suivait QUE les partials `_*.mjs` (inclus via
// `<@include>`). Les modules importés via `@import` n'étaient pas tracked
// → édition du .civet → nouveau hash → mais le .mjs garde son cache et
// référence l'ancien hash → import 404 au prochain chargement. Et le watcher
// filtrait via `isPartial = basename.startsWith('_')` → invalidait jamais
// pour les .civet.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — invalidation des .mjs qui @import un module .civet', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('édition d\'un module .civet → le .mjs parent référence le NOUVEAU hash', async function () {
    const root = mjsTmp('import-deps')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    const civetPath = join(srcDir, 'helper.civet')
    const mjsPath = join(srcDir, 'app.mjs')

    writeFileSync(civetPath, 'export hello = -> "v1"')
    writeFileSync(mjsPath, [
      "@import hello 'helper.civet'",
      '<script>val = hello()</script>',
      '<p>{val}</p>',
    ].join('\n'))

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })

    // Build #1
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const findHash = (prefix: string): string => {
      const f = readdirSync(outDir).find((n: string) => n.startsWith(prefix + '-'))
      if (!f) throw new Error(`no compiled file for ${prefix}`)
      const m = f.match(/-([a-f0-9]+)\.js$/)
      if (!m) throw new Error(`bad name ${f}`)
      return m[1]
    }
    const civetHash1 = findHash('helper')
    const appFile1 = readdirSync(outDir).find((n: string) => /^app-/.test(n))!
    const appSrc1 = readFileSync(join(outDir, appFile1), 'utf8')
    assert.ok(appSrc1.includes(`helper-${civetHash1}`),
      `build #1 : le .mjs doit référencer helper-${civetHash1}, got:\n${appSrc1.slice(0, 200)}`)

    // Modifie le .civet — son hash doit changer.
    writeFileSync(civetPath, 'export hello = -> "v2-modified"')

    // Build #2 (même instance bundler — simule le watcher).
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const civetHash2 = findHash('helper')
    assert.notEqual(civetHash2, civetHash1, 'le hash du .civet doit changer après modif')

    // Le .mjs doit avoir été RECOMPILÉ avec une référence au nouveau hash.
    const appFile2 = readdirSync(outDir).find((n: string) => /^app-/.test(n) && n !== appFile1)
      ?? readdirSync(outDir).find((n: string) => /^app-/.test(n))!
    const appSrc2 = readFileSync(join(outDir, appFile2), 'utf8')
    assert.ok(appSrc2.includes(`helper-${civetHash2}`),
      `build #2 : le .mjs doit référencer le NOUVEAU helper-${civetHash2} (et plus l'ancien). Sinon le .mjs reste figé sur un fichier qui n'existe plus → import 404 en runtime.`)

    await bundler.close()
  })

  // Régression : les chemins `µasset('…')`
  // n'étaient enregistrés NI dans le hash de cache du .mjs NI dans
  // partialDependents. En watch, éditer l'asset (logo.png, ou un .civet
  // référencé par µasset) ne ré-invalidait JAMAIS le parent → cache hit → ancien
  // asset servi (voire hashedPath disparu après cleanupOldHashes → 404 silencieux).
  it("édition d'un asset µasset() (MÊME bundler) → le .mjs parent est recompilé et référence le nouveau hash", async function () {
    const root = mjsTmp('asset-dep')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const logoPath = join(srcDir, 'logo.png')
    writeFileSync(logoPath, Buffer.from([1, 2, 3]))
    writeFileSync(join(srcDir, 'card.mjs'), [
      '<script lang="coffee">',
      "  src = µasset('logo.png')",
      '</script>',
      '<p>{src}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })

    // Build #1
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const logo1 = readdirSync(outDir).find(f => /^logo-/.test(f))!
    const card1 = readdirSync(outDir).find(f => /^card-/.test(f))!
    assert.ok(readFileSync(join(outDir, card1), 'utf8').includes(logo1.replace(/\.png$/, '')),
      'build #1 : card.mjs doit référencer le logo hashé v1')

    // Édite l'asset — MÊME instance de bundler (simule le watcher).
    writeFileSync(logoPath, Buffer.from([9, 9, 9, 9, 9]))
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const logo2 = readdirSync(outDir).find(f => /^logo-/.test(f))!
    assert.notEqual(logo2, logo1,
      "AVANT le fix A1 : card.mjs faisait un CACHE HIT (le hash ne dépendait pas de logo.png) → resolveOneAsset('logo.png') jamais ré-appelé, ancien logo servi")
    const card2 = readdirSync(outDir).find(f => /^card-/.test(f))!
    assert.ok(readFileSync(join(outDir, card2), 'utf8').includes(logo2.replace(/\.png$/, '')),
      'build #2 : card.mjs doit avoir été recompilé et référencer le NOUVEAU logo hashé')

    await bundler.close()
  })

  // Régression — `collectTransitiveImportClosure` ne suivait QUE la forme
  // AVEC identifiant (`@import name 'chemin'`) : un module .civet @import-é qui
  // appelle lui-même `µimport('vendor/x.js')` (forme NUE, appel direct sans
  // binding nommé) voyait cette cible absente de la fermeture transitive → ni le
  // hash de cache ni `partialDependents` (reverse-map du watcher) ne la
  // connaissaient → édition de l'asset µimport-é jamais recompilée en mjs dev.
  it("édition d'un asset µimport() DANS un module .civet @import-é (forme nue) → le .mjs parent est recompilé", async function () {
    const root = mjsTmp('muimport-nue')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(join(srcDir, 'vendor'), { recursive: true })

    const vendorPath = join(srcDir, 'vendor', 'lib.js')
    writeFileSync(vendorPath, 'export const v = 1\n')
    writeFileSync(join(srcDir, 'helper.module.civet'), [
      "export loadLib = -> await µimport('vendor/lib.js')",
    ].join('\n'))
    writeFileSync(join(srcDir, 'app.mjs'), [
      "@import loadLib 'helper.module.civet'",
      '<script>val = 1</script>',
      '<p>{val}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    assert.ok(bundler.partialDependents.has(vendorPath),
      "vendor/lib.js (cible du µimport nu, DANS le module .civet @import-é) doit apparaître dans partialDependents, sinon le watcher n'invalide jamais app.mjs à son édition")

    const vendorFile1 = readdirSync(outDir).find(f => /^lib-/.test(f))!
    const helperFile1 = readdirSync(outDir).find(f => /^helper\.module-/.test(f))!
    assert.ok(readFileSync(join(outDir, helperFile1), 'utf8').includes(vendorFile1.replace(/\.js$/, '')),
      'build #1 : le module helper compilé doit référencer le vendor hashé v1')

    // Édite l'asset µimport-é — MÊME instance de bundler (simule le watcher).
    writeFileSync(vendorPath, 'export const v = 2\n')
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const vendorFile2 = readdirSync(outDir).find(f => /^lib-/.test(f))!
    assert.notEqual(vendorFile2, vendorFile1, 'le hash du vendor doit changer après modif')

    const helperFile2 = readdirSync(outDir).find(f => /^helper\.module-/.test(f) && f !== helperFile1)
      ?? readdirSync(outDir).find(f => /^helper\.module-/.test(f))!
    assert.ok(readFileSync(join(outDir, helperFile2), 'utf8').includes(vendorFile2.replace(/\.js$/, '')),
      "build #2 : le module helper doit avoir été recompilé et référencer le NOUVEAU vendor hashé (sinon cache hit périmé, staleness silencieuse)")

    await bundler.close()
  })
})
