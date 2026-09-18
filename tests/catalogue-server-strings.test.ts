// catalogue-server-strings : 3 chaînes EN DUR (français
// figé, jamais couvert par messages/fr.ts+en.ts) — promues ici au catalogue
// (server.form-champ-reserve-ignore, server.browser-popup-fermee, server.ssr-await-rejete-sans-
// branche). Preuve RÉELLE du hors-catalogue : `setMessagesLang('en')` ne changeait RIEN au texte
// observé (français quoi qu'il arrive) — après promotion, la même bascule fait sortir l'anglais.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { setMessagesLang } from '../src/messages/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createServeEntry } from '../src/server/serve-entry.js'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

after(() => sweepRegistered())
after(async () => { await terminateSharedWorkerPool() })

describe('action-pipeline — champ réservé : message au catalogue', () => {
  const FIXTURE = `export default {
    actions: {
      '/echo/:id': (params, body, req) -> { errors: { nom: body.nom } }
    }
  }
  `

  function setup() {
    const root   = mjsTmp('champ-reserve')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
    writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
    const config: any = { sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js' }
    return { root, config }
  }

  async function startDev(config: any, root: string) {
    const entry = await createServeEntry(config, root)
    const server = new StaticServer({
      rootDir: join(root, 'out'), port: 0, host: '127.0.0.1', config, configDir: root,
      manifestPath: join(root, 'out', 'manifest.js'), entry: entry ?? undefined,
    })
    await server.start()
    const port = (server.server!.address() as any).port
    return { port, close: async () => { await server.stop(); entry?.close() } }
  }

  function spyConsoleError(): { calls: string[], restore: () => void } {
    const original = console.error
    const calls: string[] = []
    console.error = (...args: any[]) => { calls.push(String(args[0])) }
    return { calls, restore: () => { console.error = original } }
  }

  afterEach(() => setMessagesLang('fr'))

  it("lang 'en' + urlencoded __proto__=x : l'avertissement sort en ANGLAIS (catalogue, pas figé fr)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    setMessagesLang('en')
    const spy = spyConsoleError()
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/echo/1`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: '__proto__=hostile&nom=Alice',
      })
      assert.equal(res.status, 422)
      assert.ok(spy.calls.some(c => /rejected/.test(c) && /reserved name/.test(c) && c.includes('__proto__')),
        `attendu un avertissement EN ANGLAIS (« rejected »/« reserved name ») — observés : ${JSON.stringify(spy.calls)}`)
      assert.ok(!spy.calls.some(c => /refusé/.test(c)), `AVANT le fix : toujours « refusé » (fr), quelle que soit la langue — observés : ${JSON.stringify(spy.calls)}`)
    } finally { spy.restore(); await dev.close() }
  })
})

describe('render-browser — popup fermée : message au catalogue', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    try {
      const { chromium } = await import('playwright')
      chromiumReady = existsSync(chromium.executablePath())
    } catch {
      chromiumReady = false
    }
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test catalogue-server-strings (popup) skippé. Activer : `npx playwright install chromium`')
    }
  })

  afterEach(() => setMessagesLang('fr'))

  it("lang 'en' : le log de fermeture de popup sort en ANGLAIS (catalogue, pas figé fr)", async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const { createBrowserRenderer } = await import('../src/server/render-browser.js')
    const root = mjsTmp('popup-catalogue')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'popup.mjs'), `
<script lang="coffee">
µmount ->
  window.open('about:blank', '_blank')
</script>
<p>popup</p>
`)
    setMessagesLang('en')
    const captured: string[] = []
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root, log: (msg: string) => captured.push(msg) })
    try {
      await renderer.renderPage('mjs-popup', { settleMs: 1000 })
      // marge pour laisser le temps à l'écouteur 'page' (asynchrone) de refermer la popup —
      // même marge que tests/browser-popup-leak.test.ts.
      await new Promise((r) => setTimeout(r, 300))
      assert.ok(captured.some(c => /popup closed/.test(c)), `attendu un log EN ANGLAIS (« popup closed ») — observés : ${JSON.stringify(captured)}`)
      assert.ok(!captured.some(c => /popup fermée/.test(c)), `AVANT le fix : toujours « popup fermée » (fr), quelle que soit la langue — observés : ${JSON.stringify(captured)}`)
    } finally {
      await renderer.close()
    }
  })
})

describe('renderToString — {await} rejetée sans branche {error} : warning au catalogue', function () {
  this.timeout(30000)
  afterEach(() => setMessagesLang('fr'))

  it("lang 'en' : le warning sort en ANGLAIS (catalogue, pas figé fr)", async () => {
    const root = mjsTmp('await-reject-catalogue')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'noerr.mjs'), `
<script lang="coffee">
$p = new Promise (resolve, reject) -> reject(new Error('boom-catalogue'))
</script>
<div class="wrap">
{await $p}
  <p class="pending">chargement…</p>
{success val}
  <p class="ok">{val}</p>
{end}
</div>
`)
    setMessagesLang('en')
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-noerr', settleMs: 800 })
    assert.ok(res.warnings.some(w => /rejected/.test(w) && /boom-catalogue/.test(w)),
      `attendu un warning EN ANGLAIS (« rejected ») citant l'erreur — warnings reçus : ${JSON.stringify(res.warnings)}`)
    assert.ok(!res.warnings.some(w => /rejetée/.test(w)), `AVANT le fix : toujours « rejetée » (fr), quelle que soit la langue — warnings reçus : ${JSON.stringify(res.warnings)}`)
  })
})
