// dev-pathprefix-render — une page de
// `render.routes` dont l'URL vit SOUS `pathPrefix` (ex. `/modularjs/faq`, préfixe par défaut
// `/modularjs`) répondait 404 sur `mjs dev` (server/index.ts:428 aiguille tout `pathPrefix + '/'`
// vers les fichiers statiques, sans repli rendu), alors que `mjs serve` (render-server.ts) retombe
// déjà sur le rendu quand l'asset n'existe pas. Alignés : fichier absent sous le préfixe → même
// repli rendu (`serveRenderFallback`) — même fiche JSON (X-MJS-Nav) et même HTML que `mjs serve`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { createServeEntry } from '../src/server/serve-entry.js'
import { startRenderServer } from '../src/server/render-server.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

function setup() {
  const root   = mjsTmp('dev-pathprefix')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Accueil</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      default: 'ssr',
      routes: {
        '/':            { component: 'mjs-home', mode: 'ssr' },
        // route dont l'URL tombe SOUS le pathPrefix par défaut ('/modularjs')
        '/modularjs/faq': { component: 'mjs-home', mode: 'ssr' },
      },
    },
  }
  return { root, outDir, config }
}

describe('mjs dev — repli render.routes sous pathPrefix', () => {
  let root: string, outDir: string, config: any
  let dev: StaticServer
  let devPort: number
  let renderHandler: Awaited<ReturnType<typeof createRenderHandler>>
  let entry: Awaited<ReturnType<typeof createServeEntry>>

  before(async function () {
    this.timeout(20000)
    ;({ root, outDir, config } = setup())
    renderHandler = await createRenderHandler(config, root)
    entry = await createServeEntry(config, root)
    dev = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      config, configDir: root, manifestPath: join(outDir, 'manifest.js'),
      renderHandle: renderHandler.handle, entry,
    })
    await dev.start()
    devPort = (dev.server!.address() as any).port
  })

  after(async () => {
    await dev.stop()
    entry.close()
    await renderHandler.close()
  })

  it('/modularjs/faq (fichier absent sous le préfixe) → 200, pas 404', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs/faq`)
    assert.equal(res.status, 200)
  })

  it('/modularjs/faq avec X-MJS-Nav:1 → fiche JSON (module résolu), comme mjs serve', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs/faq`, { headers: { 'X-MJS-Nav': '1' } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /json/)
    const body = await res.json() as any
    assert.equal(body.module, 'mjs-home')
    assert.equal(body.url, '/modularjs/faq')
  })

  it('parité stricte HTML avec mjs serve pour la même config/fixture', async function () {
    this.timeout(20000)
    const serve = await startRenderServer(config, root, { port: 0 })
    try {
      const [resDev, resServe] = await Promise.all([
        fetch(`http://127.0.0.1:${devPort}/modularjs/faq`),
        fetch(`http://127.0.0.1:${serve.port}/modularjs/faq`),
      ])
      assert.equal(resDev.status, resServe.status)
      const [htmlDev, htmlServe] = await Promise.all([resDev.text(), resServe.text()])
      assert.equal(htmlDev, htmlServe)
    } finally {
      await serve.close()
    }
  })

  it('/modularjs (préfixe EXACT, sans suite) garde son comportement HISTORIQUE (assets, 404)', async () => {
    // non-régression du cas limite déjà couvert par serve-dev-parity.test.ts : url === pathPrefix
    // reste traité comme AVANT (branche assets, rel === '' → répertoire, jamais un statSync qui
    // lève) — mon repli vit dans le `catch` (fichier ABSENT), pas dans cette branche explicite.
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs`)
    assert.equal(res.status, 404)
  })
})
