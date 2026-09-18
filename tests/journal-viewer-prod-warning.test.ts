// journal-viewer-prod-warning — avertissement AU DÉMARRAGE (une seule fois, jamais par requête)
// quand `journal.viewer: true` est EXPLICITE dans la config ET que NODE_ENV vaut 'production' :
// la page est alors servie SANS authentification (cf. viewer-page.ts:isViewerAllowed, JSDoc). Le
// défaut (viewer absent) reste silencieux hors comme en production — c'est le cas normal du dev.
// Couvre les 2 points d'entrée joignables (`mjs dev` → StaticServer/index.ts, `mjs serve` →
// startRenderServer/render-server.ts) via la fonction factorisée warnIfJournalViewerOpenInProd
// (viewer-page.ts), plus un test direct sur la fonction elle-même.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StaticServer } from '../src/server/index.js'
import { startRenderServer } from '../src/server/render-server.js'
import { warnIfJournalViewerOpenInProd } from '../src/server/viewer-page.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())
after(async () => { await terminateSharedWorkerPool() })

// même minimum viable que journal-dev-endpoints.test.ts (manifest RÉALISTE, sourceDir/outputDir).
function setup() {
  const root   = mjsTmp('journal-viewer-prod-warning')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  return { root, outDir }
}

describe('warnIfJournalViewerOpenInProd (fonction) — les 4 croisements', () => {
  it('NODE_ENV production + journal.viewer: true EXPLICITE → avertissement émis', () => {
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      process.env.NODE_ENV = 'production'
      warnIfJournalViewerOpenInProd(true)
      assert.equal(calls.length, 1)
    } finally {
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })

  it('NODE_ENV pas \'production\' (dev) → pas émis même avec journal.viewer: true', () => {
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      process.env.NODE_ENV = 'development'
      warnIfJournalViewerOpenInProd(true)
      assert.equal(calls.length, 0)
    } finally {
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })

  it('production + journal.viewer ABSENT (défaut hors prod) → pas émis', () => {
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    try {
      process.env.NODE_ENV = 'production'
      warnIfJournalViewerOpenInProd(undefined)
      assert.equal(calls.length, 0)
    } finally {
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })
})

describe('avertissement au démarrage — mjs dev (StaticServer)', () => {
  it('émis UNE SEULE FOIS à la construction, jamais par requête', async function () {
    this.timeout(15000)
    const { root, outDir } = setup()
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    let server: StaticServer | null = null
    try {
      process.env.NODE_ENV = 'production'
      const config: any = { sourceDir: 'src', outputDir: 'out', journal: { viewer: true } }
      server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', config, configDir: root })
      assert.equal(calls.filter((a) => String(a[0]).includes('journal.viewer')).length, 1)
      await server.start()
      const port = (server.server!.address() as any).port
      await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      await fetch(`http://127.0.0.1:${port}/__mjs/errors.json`)
      assert.equal(calls.filter((a) => String(a[0]).includes('journal.viewer')).length, 1)
    } finally {
      if (server) await server.stop()
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })
})

describe('avertissement au démarrage — mjs serve (startRenderServer)', () => {
  it('production + journal.viewer: true → émis une fois au démarrage', async function () {
    this.timeout(15000)
    const { root } = setup()
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    let running: Awaited<ReturnType<typeof startRenderServer>> | null = null
    try {
      process.env.NODE_ENV = 'production'
      const config: any = { sourceDir: 'src', outputDir: 'out', journal: { viewer: true } }
      running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
      assert.equal(calls.filter((a) => String(a[0]).includes('journal.viewer')).length, 1)
    } finally {
      if (running) await running.close()
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })

  it('production + journal.viewer ABSENT → pas émis', async function () {
    this.timeout(15000)
    const { root } = setup()
    const origEnv = process.env.NODE_ENV
    const origError = console.error
    const calls: any[] = []
    console.error = (...args: any[]) => { calls.push(args) }
    let running: Awaited<ReturnType<typeof startRenderServer>> | null = null
    try {
      process.env.NODE_ENV = 'production'
      const config: any = { sourceDir: 'src', outputDir: 'out' }
      running = await startRenderServer(config, root, { port: 0, host: '127.0.0.1' })
      assert.equal(calls.filter((a) => String(a[0]).includes('journal.viewer')).length, 0)
    } finally {
      if (running) await running.close()
      console.error = origError
      process.env.NODE_ENV = origEnv
    }
  })
})
