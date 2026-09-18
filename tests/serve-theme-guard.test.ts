// serve-theme-guard — la garde
// /__mjs/theme(.json) de `mjs serve` (render-server.ts:288) testait EXCLUSIVEMENT
// process.env.NODE_ENV, jamais le drapeau `env`/--prod déjà reçu par startRenderServer (cf.
// tests/serve-prod-guard.test.ts, note sur le résidu non couvert) — un `mjs serve --prod`
// sans NODE_ENV=production exporté séparément laissait l'atelier de variables de thème ouvert en
// production réelle. Correctif : isProdEnv(opts.env) (viewer-page.ts), même patron que
// server/index.ts (StaticServer, déjà fermé côté `mjs dev`).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'

function setup() {
  const root   = mjsTmp('theme-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  return { root, srcDir, outDir }
}

describe('startRenderServer (mjs serve) — garde /__mjs/theme.json, env sans NODE_ENV', () => {
  it('env:"prod" SANS NODE_ENV → 404 sur /__mjs/theme.json', async function () {
    this.timeout(15000)
    const { root, srcDir, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out', pagesDir: srcDir }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1', env: 'prod' })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme.json`)
      assert.equal(res.status, 404)
    } finally {
      await running.close()
      process.env.NODE_ENV = origEnv
    }
  })

  it('SANS --prod (env absent), SANS NODE_ENV → 200 sur /__mjs/theme.json (comportement dev)', async function () {
    this.timeout(15000)
    const { root, srcDir, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out', pagesDir: srcDir }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme.json`)
      assert.equal(res.status, 200)
    } finally {
      await running.close()
      process.env.NODE_ENV = origEnv
    }
  })
})
