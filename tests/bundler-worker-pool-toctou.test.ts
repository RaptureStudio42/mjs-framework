// Régression : `ensureWorkerPool()`
// testait `_sharedWorkerPool` (la VALEUR déjà résolue) avant de créer un
// nouveau pool — entre ce test et l'assignation (après un
// `await resolveWorkerScript()`), N appels CONCURRENTS (compilation en
// parallelMap de plusieurs fichiers .mjs) voyaient TOUS "pas encore de pool"
// avant que le premier n'ait fini : jusqu'à PARALLEL_LIMIT pools créés, tous
// sauf le DERNIER à assigner `_sharedWorkerPool` ORPHELINS (leurs threads
// jamais terminate(), fuite jusqu'à l'OOM documentée), et
// `resolveWorkerScript()` (écrit worker-<hash>.mjs) appelé en concurrence sur
// le même fichier.
//
// Fix : mémoïse la PROMESSE de création (pas juste la valeur résolue) — tout
// appel concurrent attend la MÊME création en vol au lieu d'en lancer une
// nouvelle.

import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject() {
  const root = mjsTmp('pool-toctou')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('bundler — ensureWorkerPool() : pas de TOCTOU (pools dupliqués, threads orphelins)', function () {
  this.timeout(20000)

  afterEach(async () => {
    await terminateSharedWorkerPool()
  })

  it('N appels CONCURRENTS à ensureWorkerPool() partagent tous le MÊME pool (un seul créé)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    const pools = await Promise.all([
      (bundler as any).ensureWorkerPool(),
      (bundler as any).ensureWorkerPool(),
      (bundler as any).ensureWorkerPool(),
      (bundler as any).ensureWorkerPool(),
      (bundler as any).ensureWorkerPool(),
    ])

    const unique = new Set(pools)
    assert.equal(
      unique.size, 1,
      `AVANT le fix : ${unique.size} pools distincts créés pour 5 appels concurrents (TOCTOU) — tous sauf 1 orphelins, threads jamais terminate()`,
    )
    await bundler.close()
  })

  it('appels concurrents depuis PLUSIEURS Bundlers distincts : toujours un seul pool partagé', async function () {
    const p1 = makeProject()
    const p2 = makeProject()
    const bundlerA = new Bundler({ sourceDir: p1.srcDir, outputDir: p1.outDir, manifestPath: p1.manifest })
    const bundlerB = new Bundler({ sourceDir: p2.srcDir, outputDir: p2.outDir, manifestPath: p2.manifest })

    const pools = await Promise.all([
      (bundlerA as any).ensureWorkerPool(),
      (bundlerB as any).ensureWorkerPool(),
      (bundlerA as any).ensureWorkerPool(),
      (bundlerB as any).ensureWorkerPool(),
    ])

    assert.equal(new Set(pools).size, 1, 'un seul pool partagé même entre Bundlers distincts (design voulu)')
    await bundlerA.close()
    await bundlerB.close()
  })

  it('un compile() réel (parallelMap sur plusieurs .mjs) ne fuit aucun pool orphelin', async function () {
    // Test d'intégration : reproduit le SCÉNARIO RÉEL du bug (plusieurs .mjs
    // compilés en parallelMap, chacun appelant ensureWorkerPool()).
    const { srcDir, outDir, manifest } = makeProject()
    const { writeFileSync } = await import('node:fs')
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(srcDir, `c${i}.mjs`), `<script lang="coffee">$x = ${i}</script>\n<p>{$x}</p>`)
    }
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })
})
