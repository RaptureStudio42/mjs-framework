// `mjs serve --prod` (opts.env) sans
// NODE_ENV=production laissait l'atelier `/__mjs/errors`(.json) ouvert en production réelle —
// `render-server.ts` appelait `isViewerAllowed(journalCfg?.viewer, url)` (l.251) et
// `warnIfJournalViewerOpenInProd(journalCfg?.viewer)` (l.134) SANS `opts.env`, alors que les deux
// fonctions (viewer-page.ts) l'acceptent déjà en 3ᵉ paramètre — un correctif antérieur avait fermé la garde JUMELLE
// `/__mjs/theme` (l.291, `isProdEnv(opts.env)`) mais oublié celle-ci. Même patron que
// tests/serve-theme-guard.test.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer } from '../src/server/render-server.js'

function setup() {
  const root   = mjsTmp('errors-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  return { root, srcDir, outDir }
}

describe('startRenderServer (mjs serve) — garde /__mjs/errors(.json), env sans NODE_ENV', () => {
  it('env:"prod" SANS NODE_ENV → 404 sur /__mjs/errors.json ET /__mjs/errors', async function () {
    this.timeout(15000)
    const { root, srcDir, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out', pagesDir: srcDir, manifestPath: 'out/manifest.js' }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1', env: 'prod' })
    try {
      const json = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)
      const page = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(json.status, 404)
      assert.equal(page.status, 404)
    } finally {
      await running.close()
      process.env.NODE_ENV = origEnv
    }
  })

  it('SANS --prod (env absent), SANS NODE_ENV → 200 sur /__mjs/errors.json ET /__mjs/errors (comportement dev)', async function () {
    this.timeout(15000)
    const { root, srcDir, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out', pagesDir: srcDir, manifestPath: 'out/manifest.js' }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const json = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors.json`)
      const page = await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)
      assert.equal(json.status, 200)
      assert.equal(page.status, 200)
    } finally {
      await running.close()
      process.env.NODE_ENV = origEnv
    }
  })
})
