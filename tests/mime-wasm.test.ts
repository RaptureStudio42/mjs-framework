// mime-wasm — `.wasm` absent de la table MIME
// (render-server.ts, `MIME`) — servi en `application/octet-stream` au lieu d'`application/wasm`,
// sur `mjs dev` (server/index.ts, MIME_TYPES spread sur MIME) ET `mjs serve` (render-server.ts, MIME
// directement). UNE seule table (MIME, render-server.ts) déjà partagée — pas de
// duplication à fusionner, seule l'extension manquait.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { startRenderServer } from '../src/server/render-server.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(async () => { await terminateSharedWorkerPool() })

describe('table MIME — .wasm', () => {
  it('mjs dev (StaticServer) sert .wasm en application/wasm', async () => {
    const rootDir = mjsTmp('mime-wasm-dev')
    writeFileSync(join(rootDir, 'module-a1b2c3d4.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    const server = new StaticServer({ rootDir, port: 0, host: '127.0.0.1' })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/modularjs/module-a1b2c3d4.wasm`)
      assert.match(res.headers.get('content-type') || '', /^application\/wasm/)
    } finally {
      await server.stop()
    }
  })

  it('mjs serve (startRenderServer) sert .wasm en application/wasm', async () => {
    const root   = mjsTmp('mime-wasm-serve')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'module-a1b2c3d4.wasm'), Buffer.from([0x00, 0x61, 0x73, 0x6d]))
    const config: any = { sourceDir: 'src', outputDir: 'out' }
    const running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/module-a1b2c3d4.wasm`)
      assert.match(res.headers.get('content-type') || '', /^application\/wasm/)
    } finally {
      await running.close()
    }
  })
})
