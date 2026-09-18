// Test de régression — motif dominant du
// volet (« erreur avalée → build vert ») : `processIncludes` (macros.ts,
// `<@include>`) ne faisait qu'un `console.error` DANS LE WORKER pour un
// partial introuvable / une inclusion circulaire — jamais remonté dans
// `stats.errors` du bundler. `mjs build` continuait de rapporter un succès
// (exit 0) alors que le composant est réellement INCOMPLET (le `<@include>`
// manquant ne produit AUCUN contenu). Un pipeline CI qui ne grep pas les
// logs bruts (juste le code de sortie) ne voyait JAMAIS le problème.
//
// Fix : accumulé dans `IncludeAccumulator.errors` (macros.ts) → propagé via
// `TranspileData.macroErrors` (transpiler/index.ts) → `_compileMjsInner`
// (bundler/index.ts) throw si non-vide, remonté dans `stats.errors` par le
// mécanisme parallelMap déjà en place.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — <@include> introuvable/circulaire remonté dans stats.errors (pas juste console.error)', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("<@include partial-inexistant> → stats.errors non vide (AVANT : build vert)", async function () {
    const root = mjsTmp('macro-err-missing')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'page.mjs'), '<div><@include partial-inexistant></div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : un <@include> introuvable ne faisait qu'un console.error DANS LE WORKER, jamais remonté dans stats.errors — build vert malgré un composant incomplet")
    assert.match(stats.errors.map(e => e.message).join('\n'), /Partial introuvable/)
    await bundler.close()
  })

  it("<@include> circulaire (A inclut A via un chemin déjà résolu ailleurs) → stats.errors non vide", async function () {
    const root = mjsTmp('macro-err-cycle')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // page.mjs inclut _a deux fois — la 2e via le chemin déjà résolu ; comme
    // _a lui-même essaie de se ré-inclure, ça déclenche la garde anti-cycle
    // (acc.expanding) de processIncludes.
    writeFileSync(join(srcDir, '_a.mjs'), '<span><@include a></span>')
    writeFileSync(join(srcDir, 'page.mjs'), '<div><@include a></div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : une inclusion circulaire ne faisait qu'un console.error, jamais remonté dans stats.errors")
    assert.match(stats.errors.map(e => e.message).join('\n'), /circulaire/)
    await bundler.close()
  })

  it('un <@include> valide (partial existant, pas de cycle) compile toujours sans erreur (non-régression)', async function () {
    const root = mjsTmp('macro-err-ok')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, '_header.mjs'), '<h1>Titre</h1>')
    writeFileSync(join(srcDir, 'page.mjs'), '<div><@include header></div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })
})
