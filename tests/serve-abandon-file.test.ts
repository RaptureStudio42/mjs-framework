// L'abandon en
// file (AbortSignal, RenderGate.run — render-request.ts) était câblé dans `mjs dev` (server/index.ts,
// req.on('close') → AbortController) mais PAS dans `mjs serve` (render-server.ts, fichier alors
// restreint à sa table MIME) — un 503
// persistant côté `mjs serve` après l'abandon d'une requête en file (RED confirmé).
// Même câblage qu'index.ts : AbortController posé sur `req.on('close')`, signal
// transmis en 3ᵉ paramètre de `handler.handle`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// composant délibérément LENT ({await} + setTimeout 400ms) — garantit qu'un rendu reste
// « inFlight » assez longtemps pour que les suivants trouvent la porte fermée (même patron que
// tests/rendergate-abandon.test.ts).
const LENT_SRC = `
<script lang="coffee">
@id = ''
$p = new Promise (resolve) -> setTimeout((-> resolve('fini')), 400)
</script>
{await $p}{success v}<h1>{@id}</h1>{end}
`

describe('mjs serve (startRenderServer) — abandon en file libère la place', () => {
  it('requête A occupe le seul slot, B entre en file puis est abandonnée (socket détruite), C obtient la place de B (200, pas 503)', async function () {
    this.timeout(20000)
    const root   = mjsTmp('serve-abandon-file')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'lent.mjs'), LENT_SRC)
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/lent/:id': { component: 'mjs-lent', mode: 'ssr' } }, renderQueue: { concurrency: 1, maxQueue: 1 } },
    }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const pA = fetch(`http://127.0.0.1:${running.port}/lent/a`).then(r => r.status)   // occupe le seul slot actif (~400ms)
      await sleep(30)
      const ac = new AbortController()
      const pB = fetch(`http://127.0.0.1:${running.port}/lent/b`, { signal: ac.signal }).catch(e => 'aborted:' + e.name)   // va EN FILE (maxQueue:1)
      await sleep(30)
      ac.abort()   // abandon PENDANT l'attente — détruit la socket côté client
      await sleep(40)
      // requête C, envoyée juste après l'abandon de B mais BIEN AVANT le tour naturel de A
      // (~400ms) : 503 = la place abandonnée n'a PAS été libérée ; 200 = libérée immédiatement.
      const statusC = await fetch(`http://127.0.0.1:${running.port}/lent/c`).then(r => r.status)
      assert.equal(statusC, 200, 'la requête C (envoyée juste après l\'abandon de B) doit obtenir la place libérée : 200, pas 503')
      assert.equal(await pA, 200, 'la requête qui occupait le seul slot actif doit aboutir normalement')
      assert.equal(await pB, 'aborted:AbortError')
    } finally {
      await running.close()
    }
  })
})
