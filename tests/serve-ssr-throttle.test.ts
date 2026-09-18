// serve-ssr-throttle — aucun plafond de concurrence ne bornait le
// rendu SSR par requête (moteur happy-dom, défaut de l'axe `request`) : une route paramétrée
// (`/produit/:id`) offre un espace d'URLs quasi infini, chacune un rendu complet EN MÊME TEMPS que
// toutes les autres (15 requêtes concurrentes, 15/15 → 200, AUCUNE 503 : rejouée avant correctif,
// RED confirmé). Le correctif ajoute une file bornée (render-request.ts, RenderGate) : défaut 4
// rendus simultanés / 32 en attente, clé de config `render.renderQueue` (`concurrency`/
// `maxQueue`). La protection vit dans render-request.ts (createRenderHandler.handle), chokepoint
// PARTAGÉ par `mjs dev` ET `mjs serve` — testé ici via `mjs serve` (startRenderServer) pour la
// preuve principale (mêmes défauts que la sonde), et via `mjs dev` (StaticServer) pour l'en-tête
// Retry-After (posé par server/index.ts, avec un plafond serré pour une saturation déterministe).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { startRenderServer } from '../src/server/render-server.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

const PRODUIT_SRC = `
<script lang="coffee">
@id = ''
</script>
<h1>{@id}</h1>
`

describe('plafond de concurrence SSR — 400 requêtes simultanées, défauts', () => {
  it('aucune requête ne bloque le serveur ; certaines 503 ; aucune exception ; réutilisable après la rafale', async function () {
    this.timeout(30000)
    // 400 et non 40 : un rendu de composant trivial se termine avant que 36 requêtes ne s'accumulent
    // (transpilation dans le processus principal sous le seuil de fichiers) — la rafale doit dépasser le plafond
    const N = 400
    const root   = mjsTmp('ssr-throttle')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'produit.mjs'), PRODUIT_SRC)
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/produit/:id': { component: 'mjs-produit', mode: 'ssr' } } },
    }
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const results = await Promise.all(
        Array.from({ length: N }, (_, i) =>
          fetch(`http://127.0.0.1:${running.port}/produit/${i}`).then(r => r.status)))
      const ok    = results.filter(s => s === 200)
      const busy  = results.filter(s => s === 503)
      const autre = results.filter(s => s !== 200 && s !== 503)
      assert.deepEqual(autre, [], 'aucune requête ne doit répondre autre chose que 200/503 (aucune exception serveur)')
      assert.ok(busy.length > 0, 'au moins une requête doit être refusée (503) — preuve du plafond, ' + N + ' requêtes > défauts 4+32')
      assert.ok(ok.length > 0, 'au moins une requête doit aboutir (200) — le serveur ne bloque jamais tout')

      // le serveur reste utilisable APRÈS la rafale (pas de crash, pas de blocage durable)
      const after = await fetch(`http://127.0.0.1:${running.port}/produit/apres-rafale`)
      assert.equal(after.status, 200)
    } finally {
      await running.close()
    }
  })
})

describe('en-tête Retry-After sur mjs dev (StaticServer) — plafond serré pour preuve déterministe', () => {
  it('render.renderQueue concurrency:1/maxQueue:1 → au moins une 503 avec Retry-After', async function () {
    this.timeout(20000)
    const root   = mjsTmp('ssr-throttle-dev')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'produit.mjs'), PRODUIT_SRC)
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
    const config: any = {
      sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
      render: {
        routes: { '/produit/:id': { component: 'mjs-produit', mode: 'ssr' } },
        renderQueue: { concurrency: 1, maxQueue: 1 },
      },
    }
    const renderHandler = await createRenderHandler(config, root)
    const dev = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', config, configDir: root, manifestPath: join(outDir, 'manifest.js'), renderHandle: renderHandler.handle })
    await dev.start()
    const port = (dev.server!.address() as any).port
    try {
      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          fetch(`http://127.0.0.1:${port}/produit/${i}`).then(r => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))))
      const busy = results.filter(r => r.status === 503)
      assert.ok(busy.length > 0, 'plafond serré (1/1) : au moins une des 6 requêtes concurrentes doit être refusée')
      assert.ok(busy.every(r => r.retryAfter === '1'), 'chaque 503 côté mjs dev porte Retry-After (posé par server/index.ts)')
    } finally {
      await dev.stop()
      await renderHandler.close()
    }
  })
})
