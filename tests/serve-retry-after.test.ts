// serve-retry-after — `mjs dev` (server/index.ts:626) pose l'en-tête
// Retry-After sur un 503 de plafond de rendu SSR (RenderGate, render-request.ts), `mjs serve`
// (render-server.ts) ne le posait JAMAIS — `r.retryAfter` (RenderResponse) n'était lu nulle part
// dans ce fichier (cf. tests/serve-ssr-throttle.test.ts, en-tête de fichier : « testé … via
// mjs dev pour l'en-tête Retry-After » — asymétrie non couverte côté mjs serve). Aligné : même
// en-tête, même valeur (RENDER_RETRY_AFTER_S).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

// composant délibérément LENT ({await} + setTimeout 300ms) : garantit que la 1ère requête reste
// « inFlight » assez longtemps pour que la 2e (envoyée en même temps) trouve la porte fermée —
// avec maxQueue:0, aucune marge d'attente, la course serait sinon flaky sur un rendu trop rapide.
const LENT_SRC = `
<script lang="coffee">
$p = new Promise (resolve) -> setTimeout((-> resolve('fini')), 300)
</script>
<div class="wrap">
{await $p}
  <p class="pending">chargement…</p>
{success val}
  <p class="ok">{val}</p>
{end}
</div>
`

describe('en-tête Retry-After sur mjs serve (startRenderServer) — aligné sur mjs dev', () => {
  it('render.renderQueue concurrency:1/maxQueue:0, 2 requêtes simultanées sur un composant lent → une 503 avec Retry-After', async function () {
    this.timeout(20000)
    const root   = mjsTmp('serve-retry-after')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'lent.mjs'), LENT_SRC)
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: {
        routes: { '/lent': { component: 'mjs-lent', mode: 'ssr' } },
        renderQueue: { concurrency: 1, maxQueue: 0 },
      },
    }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const results = await Promise.all(
        Array.from({ length: 2 }, () =>
          fetch(`http://127.0.0.1:${running.port}/lent`).then(r => ({ status: r.status, retryAfter: r.headers.get('retry-after') }))))
      const busy = results.filter(r => r.status === 503)
      assert.ok(busy.length > 0, 'plafond serré (1/0) + composant lent : au moins une des 2 requêtes simultanées doit être refusée')
      assert.ok(busy.every(r => r.retryAfter === '1'), 'chaque 503 côté mjs serve doit porter Retry-After (aligné sur mjs dev, server/index.ts)')
    } finally {
      await running.close()
    }
  })
})
