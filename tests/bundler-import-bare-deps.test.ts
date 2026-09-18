// Test de régression — `collectTransitiveImportClosure`/preResolveAssets
// ne suivaient QUE la forme AVEC parenthèses (`µimport('chemin')`), via
// MU_IMPORT_CALL_RE. La forme NUE sans parenthèses (`µimport 'chemin'`, appel
// Civet/CoffeeScript légal côté compilation) était invisible à
// cette regex — un module .civet @import-é qui appelle lui-même
// `µimport 'vendor/x.js'` (sans parenthèses) voyait cette cible absente de la
// fermeture transitive → ni le hash de cache ni `partialDependents` ne la
// connaissaient → édition de l'asset µimport-é jamais recompilée en mjs dev.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — invalidation des .mjs qui @import un module .civet appelant µimport SANS parenthèses', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("édition d'un asset µimport 'chemin' (forme nue SANS parenthèses) DANS un module .civet @import-é → le .mjs parent est recompilé", async function () {
    const root = mjsTmp('muimport-bare')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(join(srcDir, 'vendor'), { recursive: true })

    const vendorPath = join(srcDir, 'vendor', 'lib.js')
    writeFileSync(vendorPath, 'export const v = 1\n')
    writeFileSync(join(srcDir, 'helper.module.civet'), [
      "export loadLib = -> await µimport 'vendor/lib.js'",
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
      "vendor/lib.js (cible du µimport nu SANS parenthèses, DANS le module .civet @import-é) doit apparaître dans partialDependents, sinon le watcher n'invalide jamais app.mjs à son édition")

    const vendorFile1 = readdirSync(outDir).find(f => /^lib-/.test(f))!
    const helperFile1 = readdirSync(outDir).find(f => /^helper\.module-/.test(f))!
    assert.ok(readFileSync(join(outDir, helperFile1), 'utf8').includes(vendorFile1.replace(/\.js$/, '')),
      'build #1 : le module helper compilé doit référencer le vendor hashé v1')

    // Édite l'asset µimport-é (forme nue) — MÊME instance de bundler (simule le watcher).
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
