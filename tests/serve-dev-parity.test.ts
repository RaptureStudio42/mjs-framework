// Parité `mjs dev` (StaticServer)/`mjs serve`
// (startRenderServer) sur render.routes — protocole JSON X-MJS-Nav, props du
// chargeur serve.server.mjs injectées au 1er chargement HTML, et collision pathPrefix sans
// frontière de segment. AVANT ce correctif, `mjs dev` échouait aux 3 (server/index.ts:serveRenderFallback
// ignorait X-MJS-Nav/this.entry, et comparait le pathPrefix en préfixe de CHAÎNE nu) alors que
// docs/19-ssr.md affirme la parité.

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
  const root   = mjsTmp('dev-parity')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Accueil</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  // chargeur serve.server.mjs — props MINIMALES sur '/'
  writeFileSync(join(root, 'serve.server.mjs'), `export default {
  props: {
    '/': (params, req) -> { message: 'depuis-entry' }
  }
}
`)
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: {
      default: 'ssr',
      routes: {
        '/':                { component: 'mjs-home', mode: 'ssr' },
        // URL qui commence par le MÊME MOT que pathPrefix par défaut ('/modularjs'), sans
        // frontière de séparateur après.
        '/modularjs-notes': { component: 'mjs-home', mode: 'ssr' },
      },
    },
  }
  return { root, outDir, config }
}

describe('parité mjs dev / mjs serve — render.routes', function () {
  this.timeout(20000)   // premiers rendus compilés à froid : le défaut de 2 s ne tient pas sous charge
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

  it('X-MJS-Nav:1 reçoit du JSON (comme mjs serve), pas le shell HTML', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/`, { headers: { 'X-MJS-Nav': '1', 'Accept': 'application/json' } })
    assert.equal(res.status, 200)
    assert.match(res.headers.get('content-type') || '', /json/)
    const body = await res.json() as any
    assert.equal(body.module, 'mjs-home')
    assert.equal(body.url, '/')
  })

  it('props du chargeur serve.server.mjs injectées au 1er chargement HTML (__mjs_res)', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/`)
    const body = await res.text()
    assert.match(body, /__mjs_res/)
    assert.match(body, /depuis-entry/)
  })

  it('/modularjs-notes (préfixe /modularjs sans frontière) rend la page, pas un 404', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs-notes`)
    assert.equal(res.status, 200)
  })

  it('/modularjs (préfixe EXACT, sans suite) garde son comportement HISTORIQUE (assets)', async () => {
    // non-régression du cas limite : url === pathPrefix doit rester traité comme AVANT (branche
    // assets), pas basculer vers le rendu — ici aucun fichier "" n'existe → 404, comme avant.
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs`)
    assert.equal(res.status, 404)
  })

  it('parité stricte — même fiche JSON que mjs serve pour la même config/fixture', async function () {
    this.timeout(20000)
    const serve = await startRenderServer(config, root, { port: 0 })
    try {
      const [resDev, resServe] = await Promise.all([
        fetch(`http://127.0.0.1:${devPort}/`, { headers: { 'X-MJS-Nav': '1' } }),
        fetch(`http://127.0.0.1:${serve.port}/`, { headers: { 'X-MJS-Nav': '1' } }),
      ])
      const [jsonDev, jsonServe] = await Promise.all([resDev.json(), resServe.json()])
      assert.deepEqual(jsonDev, jsonServe)
    } finally {
      await serve.close()
    }
  })
})
