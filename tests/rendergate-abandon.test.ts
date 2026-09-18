// (a) une requête EN FILE (RenderGate, render-request.ts) puis
// abandonnée par le client (socket fermée / AbortSignal) gardait sa place jusqu'à SON TOUR NATUREL
// — amplification, la file reste pleine pour les suivants alors que le client n'attend déjà plus
// personne (sans le correctif : requête suivante → 503). `run()` retire
// désormais l'entrée de la file dès l'abandon (signal transmis en 3ᵉ
// paramètre de `RenderHandler.handle`, câblé côté `mjs dev`/server/index.ts via `req.on('close')`
// — `mjs serve`/render-server.ts N'EST PAS câblé ici, fichier restreint à sa table MIME).
// (b) `new RenderGate(0, N)` bloquait TOUT rendu à vie (contredit l'invariant en
// commentaire, render-request.ts:90-92) — clampé `concurrency ≥ 1`/`maxQueue ≥ 0` au constructeur,
// voie « middleware » (`createRenderHandler()` direct, hors mjs.config.json/
// validateRenderQueueConfig).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// composant délibérément LENT ({await} + setTimeout) — garantit qu'un rendu reste « inFlight »
// assez longtemps pour que les suivants trouvent la porte fermée (même patron que
// tests/serve-ssr-throttle.test.ts).
const LENT_SRC = `
<script lang="coffee">
@id = ''
$p = new Promise (resolve) -> setTimeout((-> resolve('fini')), 500)
</script>
{await $p}{success v}<h1>{@id}</h1>{end}
`

function setupLent() {
  const root = mjsTmp('rendergate')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'lent.mjs'), LENT_SRC)
  return root
}

describe('RenderGate — abandon en file et clamp concurrency', () => {
  it('RenderGate(0, N) clampé à 1 : createRenderHandler() direct rend un résultat (pas de blocage définitif)', async function () {
    this.timeout(20000)
    const root = mjsTmp('rendergate-clamp')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'home.mjs'), '<h1>salut</h1>')
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/': { component: 'mjs-home', mode: 'ssr' } }, renderQueue: { concurrency: 0, maxQueue: 5 } },
    }
    const handler = await createRenderHandler(config, root)
    try {
      const t0 = Date.now()
      const r = await handler.handle('/')
      const elapsed = Date.now() - t0
      // une porte bloquée ne rend JAMAIS : la borne ne sert qu'à séparer ce blocage d'un premier rendu
      // à froid (compilation + démarrage du rendu serveur), qui dépasse la seconde sous la charge d'une suite complète
      assert.ok(elapsed < 10000, `rendu en ${elapsed}ms, attendu < 10000ms (concurrency:0 clampé à 1)`)
      assert.equal(r.status, 200)
    } finally {
      await handler.close()
    }
  })

  it('abandon EN FILE (signal AbortController, voie middleware createRenderHandler direct) : la requête suivante obtient une place', async function () {
    this.timeout(20000)
    const root = setupLent()
    const config: any = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/lent/:id': { component: 'mjs-lent', mode: 'ssr' } }, renderQueue: { concurrency: 1, maxQueue: 1 } },
    }
    const handler = await createRenderHandler(config, root)
    try {
      const p0 = handler.handle('/lent/0')   // occupe le seul slot actif (~500ms)
      await sleep(30)
      const ac = new AbortController()
      const p1 = handler.handle('/lent/1', {}, ac.signal)   // va EN FILE (maxQueue:1)
      await sleep(30)
      ac.abort()   // abandon PENDANT l'attente
      await sleep(40)
      // requête 2, envoyée APRÈS l'abandon mais BIEN AVANT le tour naturel de la requête 0 (~500ms) :
      // 503 = la place abandonnée n'a PAS été libérée ; autre chose que 503 = libérée immédiatement.
      const r2 = await handler.handle('/lent/2')
      assert.notEqual(r2.status, 503, 'la file devrait avoir une place libre : la requête 1 abandonnée ne doit plus l\'occuper')
      const r0 = await p0
      assert.equal(r0.status, 200, 'la requête qui occupait le seul slot actif doit aboutir normalement')
      const r1 = await p1
      assert.equal(r1.status, 503, 'la requête abandonnée reçoit quand même une réponse (jamais de promesse qui ne se résout jamais)')
    } finally {
      await handler.close()
    }
  })

  it('mjs dev (StaticServer, HTTP réel) : AbortController côté client pendant la file libère la place', async function () {
    this.timeout(20000)
    const root = setupLent()
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
    const config: any = {
      sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
      render: { routes: { '/lent/:id': { component: 'mjs-lent', mode: 'ssr' } }, renderQueue: { concurrency: 1, maxQueue: 1 } },
    }
    const renderHandler = await createRenderHandler(config, root)
    const dev = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      config, configDir: root, manifestPath: join(outDir, 'manifest.js'),
      renderHandle: renderHandler.handle,
    })
    await dev.start()
    try {
      const port = (dev.server!.address() as any).port
      const p0 = fetch(`http://127.0.0.1:${port}/lent/0`).then(r => r.status)
      await sleep(30)
      const ac = new AbortController()
      const p1 = fetch(`http://127.0.0.1:${port}/lent/1`, { signal: ac.signal }).catch(e => 'aborted:' + e.name)
      await sleep(30)
      ac.abort()
      await sleep(40)
      const s2 = await fetch(`http://127.0.0.1:${port}/lent/2`).then(r => r.status)
      assert.notEqual(s2, 503, 'requête 2 (envoyée juste après l\'abandon HTTP de la requête 1) doit obtenir une place')
      assert.equal(await p0, 200)
      assert.equal(await p1, 'aborted:AbortError')
    } finally {
      await dev.stop()
      await renderHandler.close()
    }
  })
})
