// La garde « extension = asset, 404 » (server/index.ts:483-499, render-server.ts:
// 334-341) s'appliquait AVANT toute consultation de render.routes — une route DÉCLARÉE avec
// extension ('/modularjs/sitemap.xml', sitemap/robots…) tombait en 404 au lieu de rendre, sur les
// DEUX serveurs ; et sur `mjs serve`, la garde s'appliquait même HORS du préfixe ('/sitemap.xml' →
// 404 sur serve, 200 sur dev). Fix : une route résolue par `resolvePage` passe TOUJOURS au rendu,
// extension ou pas ; la garde ne vaut que pour un chemin non déclaré.

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
  const root   = mjsTmp('route-declaree-extension')
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
        '/':                      { component: 'mjs-home', mode: 'ssr' },
        // route DÉCLARÉE avec extension, sous le préfixe par défaut ('/modularjs')
        '/modularjs/sitemap.xml': { component: 'mjs-home', mode: 'ssr' },
        // même route déclarée, mais HORS du préfixe (sitemap/robots à la racine du site)
        '/sitemap.xml':           { component: 'mjs-home', mode: 'ssr' },
      },
    },
  }
  return { root, outDir, config }
}

describe('route render.routes déclarée avec extension : rendue, jamais 404', () => {
  let root: string, outDir: string, config: any
  let dev: StaticServer
  let devPort: number
  let serve: Awaited<ReturnType<typeof startRenderServer>>
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
    serve = await startRenderServer(config, root, { port: 0 })
  })

  after(async () => {
    await dev.stop()
    entry.close()
    await renderHandler.close()
    await serve.close()
  })

  it('mjs dev — /modularjs/sitemap.xml (déclarée, sous préfixe) → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs/sitemap.xml`)
    assert.equal(res.status, 200)
  })

  it('mjs serve — /modularjs/sitemap.xml (déclarée, sous préfixe) → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${serve.port}/modularjs/sitemap.xml`)
    assert.equal(res.status, 200)
  })

  it('mjs dev — /sitemap.xml (déclarée, hors préfixe) → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/sitemap.xml`)
    assert.equal(res.status, 200)
  })

  it('mjs serve — /sitemap.xml (déclarée, hors préfixe) → 200', async () => {
    const res = await fetch(`http://127.0.0.1:${serve.port}/sitemap.xml`)
    assert.equal(res.status, 200)
  })

  it('mjs dev — /modularjs/inexistant.js (non déclarée, sous préfixe) → 404 (non-régression)', async () => {
    const res = await fetch(`http://127.0.0.1:${devPort}/modularjs/inexistant.js`)
    assert.equal(res.status, 404)
  })

  it('mjs serve — /modularjs/inexistant.js (non déclarée, sous préfixe) → 404 (non-régression)', async () => {
    const res = await fetch(`http://127.0.0.1:${serve.port}/modularjs/inexistant.js`)
    assert.equal(res.status, 404)
  })
})
