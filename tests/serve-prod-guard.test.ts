// serve-prod-guard — `mjs dev`/`mjs serve --prod` (opts.env,
// drapeau CLI) sans NODE_ENV=production laissait /__mjs/theme(.json) ET /__mjs/errors(.json)
// ouverts en « production » réelle — les gardes ne testaient QUE process.env.NODE_ENV, jamais le
// paramètre `env` déjà reçu par createRenderHandler/startRenderServer (render-request.ts:84,
// correctif déjà en place pour le corps d'erreur SSR). Le correctif ferme le CÔTÉ `mjs dev`
// (StaticServer, server/index.ts) + la fonction PARTAGÉE (viewer-page.ts, isProdEnv/
// isViewerAllowed/warnIfJournalViewerOpenInProd).
//
// Résidu non couvert ici (fichiers hors de ce test) :
//   - render-server.ts:288 (garde /__mjs/theme PROPRE à `mjs serve`, hors fichiers modifiables)
//   - cli.ts (câblage --prod → StaticServer/createRenderHandler)

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { isViewerAllowed, warnIfJournalViewerOpenInProd, isProdEnv } from '../src/server/viewer-page.js'
import { createJournal, type Journal } from '../src/server/journal.js'

function setup() {
  const root   = mjsTmp('prod-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  return { root, outDir }
}

describe('isProdEnv (fonction) — OR env/NODE_ENV, même patron que render-request.ts:84', () => {
  const origEnv = process.env.NODE_ENV
  afterEach(() => { process.env.NODE_ENV = origEnv })

  it('env:"prod" SANS NODE_ENV → prod', () => {
    delete process.env.NODE_ENV
    assert.equal(isProdEnv('prod'), true)
  })
  it('NODE_ENV=production SANS env → prod (second signal conservé)', () => {
    process.env.NODE_ENV = 'production'
    assert.equal(isProdEnv(undefined), true)
  })
  it('ni env ni NODE_ENV → pas prod', () => {
    delete process.env.NODE_ENV
    assert.equal(isProdEnv(undefined), false)
  })
  it('env:"dev" SANS NODE_ENV → pas prod', () => {
    delete process.env.NODE_ENV
    assert.equal(isProdEnv('dev'), false)
  })
})

describe('isViewerAllowed / warnIfJournalViewerOpenInProd — env prime, cf. isProdEnv', () => {
  const origEnv = process.env.NODE_ENV
  afterEach(() => { process.env.NODE_ENV = origEnv })

  it('journal.viewer absent + env:"prod" SANS NODE_ENV → refusé', () => {
    delete process.env.NODE_ENV
    const url = new URL('http://x/__mjs/errors')
    assert.equal(isViewerAllowed(undefined, url, 'prod'), false)
  })
  it('journal.viewer absent + env:"dev" (ou absent) SANS NODE_ENV → autorisé', () => {
    delete process.env.NODE_ENV
    const url = new URL('http://x/__mjs/errors')
    assert.equal(isViewerAllowed(undefined, url, 'dev'), true)
    assert.equal(isViewerAllowed(undefined, url, undefined), true)
  })
  it('journal.viewer:true + env:"prod" SANS NODE_ENV → avertissement émis', () => {
    delete process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      warnIfJournalViewerOpenInProd(true, 'prod')
      assert.equal(calls.length, 1)
    } finally {
      console.error = origError
    }
  })
})

describe('StaticServer (mjs dev) — /__mjs/theme.json et /__mjs/errors.json, env sans NODE_ENV', () => {
  it('env:"prod" SANS NODE_ENV → 404 sur les deux routes', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out' }
    const journal: Journal = createJournal({ dir: join(root, 'log') })
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', config, configDir: root, manifestPath: join(outDir, 'manifest.js'), journal, env: 'prod' })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const theme  = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      const errors = await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(theme.status, 404)
      assert.equal(errors.status, 404)
    } finally {
      await server.stop()
      journal.close()
      process.env.NODE_ENV = origEnv
    }
  })

  it('SANS --prod (env absent), SANS NODE_ENV → 200 sur les deux routes (comportement dev)', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    delete process.env.NODE_ENV
    const config: any = { sourceDir: 'src', outputDir: 'out' }
    const journal: Journal = createJournal({ dir: join(root, 'log') })
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', config, configDir: root, manifestPath: join(outDir, 'manifest.js'), journal })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const theme  = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      const errors = await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(theme.status, 200)
      assert.equal(errors.status, 200)
    } finally {
      await server.stop()
      journal.close()
      process.env.NODE_ENV = origEnv
    }
  })
})
