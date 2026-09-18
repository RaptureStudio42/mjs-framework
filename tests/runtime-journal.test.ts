// Runtime : étage CLIENT du journal d'erreurs (mjs_journal.ts, module optionnel 'journal').
// Même harnais que tests/runtime-title.test.ts : Bundler réel → mjs_core-*.js (avec `runtime:
// ['journal']`, preuve que le module optionnel est réellement sélectionnable/bundlé, cf.
// CANONICAL), évalué dans une fenêtre happy-dom, interactions par VRAIS événements DOM.
//
// happy-dom, deux pièges vérifiés empiriquement avant d'écrire ce fichier :
//   - `console` vu depuis `window.eval(...)` n'est PAS le `console` Node ambiant — on stubbe
//     `window.console.error` (l'objet PROPRE à cette fenêtre), jamais le `console` global du test.
//   - `navigator.sendBeacon(url, blob)` reçoit un VRAI Blob happy-dom — son contenu ne s'obtient
//     QUE via `blob.text()` (async, aucune propriété interne synchrone exposée).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function buildCore(): Promise<string> {
  const root = mjsTmp('journal-runtime')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'placeholder.mjs'), `<script>\n$x = 0\n</script>\n<div>ph</div>`)
  // Preuve END-TO-END que 'journal' est un module runtime OPTIONNEL réellement
  // sélectionnable (OPTIONAL_RUNTIME_MODULES + CANONICAL, cf. config.ts/bundler/index.ts) : sans
  // cette sélection, `_mjs_journalSend`/l'écouteur 'error' n'existeraient simplement pas dans le core.
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['journal'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js introuvable')
  return stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
}

describe('runtime — journal client (mjs_journal.ts)', function () {
  this.timeout(40000)

  let coreCode: string

  before(async function () {
    coreCode = await buildCore()
  })

  after(async () => {
    await terminateSharedWorkerPool()
  })

  // fabrique une fenêtre FRAÎCHE par test (état module — `sent`/`seen` — remis à zéro à chaque
  // évaluation du cœur, exactement comme un vrai rechargement de page).
  function makeWindow(path = '/app?x=1'): any {
    const window: any = new Window({ url: 'http://localhost' + path })
    window.eval(`${coreCode}\nglobalThis.µ = µ;`)
    window.µ.version = 'abcd1234'  // posé normalement par le manifeste (writeManifest) — simulé ici
    return window
  }

  type Call = { url: string, blob: any }
  function stubBeacon(window: any): Call[] {
    const calls: Call[] = []
    window.navigator.sendBeacon = (url: string, blob: any) => {
      calls.push({ url, blob })
      return true
    }
    return calls
  }
  async function bodyOf(call: Call): Promise<any> {
    return JSON.parse(await call.blob.text())
  }

  it('µ.config.journal false (défaut) : une erreur réelle n\'envoie RIEN', () => {
    const window = makeWindow()
    const calls = stubBeacon(window)
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom', error: new window.Error('boom') }))
    assert.equal(calls.length, 0)
  })

  it('µ.config.journal true : erreur window.onerror → sendBeacon appelé 1 fois, payload JSON conforme ≤ 8 Ko', async () => {
    const window = makeWindow('/page?a=1')
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'boom client', error: new window.Error('boom client') }))
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, '/__mjs/errors')
    assert.equal(calls[0].blob.type, 'application/json')
    const payload = await bodyOf(calls[0])
    assert.equal(payload.message, 'boom client')
    assert.equal(typeof payload.pile, 'string')
    assert.equal(payload.url, '/page?a=1')
    assert.equal(payload.version, 'abcd1234')
    assert.ok(!('source' in payload), 'le CLIENT ne pose jamais source — c\'est le serveur qui la force')
    assert.ok(Buffer.byteLength(JSON.stringify(payload), 'utf-8') <= 8192)
  })

  it('dédoublonnage : la MÊME erreur répétée plusieurs fois n\'envoie qu\'UNE fois', () => {
    const window = makeWindow()
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    for (let i = 0; i < 5; i++) {
      window.dispatchEvent(new window.ErrorEvent('error', { message: 'boucle', error: new window.Error('boucle') }))
    }
    assert.equal(calls.length, 1)
  })

  it('des erreurs DIFFÉRENTES envoient chacune (jusqu\'au plafond)', () => {
    const window = makeWindow()
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'erreur-A', error: new window.Error('erreur-A') }))
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'erreur-B', error: new window.Error('erreur-B') }))
    assert.equal(calls.length, 2)
  })

  it('plafond 20 envois par session : au-delà, une erreur DISTINCTE de plus n\'envoie plus rien', () => {
    const window = makeWindow()
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    for (let i = 0; i < 25; i++) {
      window.dispatchEvent(new window.ErrorEvent('error', { message: 'distincte-' + i, error: new window.Error('distincte-' + i) }))
    }
    assert.equal(calls.length, 20)
  })

  it('unhandledrejection : promesse rejetée → capturée comme une erreur', async () => {
    const window = makeWindow()
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    const ev = new window.Event('unhandledrejection')
    ev.reason = new window.Error('promesse rejetée')
    window.dispatchEvent(ev)
    assert.equal(calls.length, 1)
    const payload = await bodyOf(calls[0])
    assert.equal(payload.message, 'promesse rejetée')
  })

  it('µ.error enrobé : envoie au journal ET préserve l\'appel console.error d\'origine', async () => {
    const window = makeWindow()
    window.µ.config.journal = true
    const calls = stubBeacon(window)
    const consoleCalls: any[] = []
    window.console.error = (...args: any[]) => { consoleCalls.push(args) }
    window.µ.error('un message applicatif', new window.Error('detail'))
    assert.equal(consoleCalls.length, 1, 'le console.error ORIGINAL doit toujours tourner')
    assert.equal(consoleCalls[0][0], 'un message applicatif')
    assert.equal(consoleCalls[0][1].message, 'detail')
    assert.equal(calls.length, 1, 'ET le journal doit avoir reçu le signalement')
    const payload = await bodyOf(calls[0])
    assert.match(payload.message, /un message applicatif/)
  })

  it('µ.error : µ.config.journal false → console.error d\'origine tourne quand même, mais RIEN n\'est envoyé', () => {
    const window = makeWindow()
    const calls = stubBeacon(window)
    const consoleCalls: any[] = []
    window.console.error = (...args: any[]) => { consoleCalls.push(args) }
    window.µ.error('message', new window.Error('x'))
    assert.equal(consoleCalls.length, 1)
    assert.equal(calls.length, 0)
  })

  it('sendBeacon ABSENT → repli fetch(..., { method: "POST", keepalive: true })', async () => {
    const window = makeWindow()
    window.µ.config.journal = true
    window.navigator.sendBeacon = undefined
    const fetchCalls: any[] = []
    window.fetch = (url: string, opts: any) => {
      fetchCalls.push({ url, opts })
      return Promise.resolve({ ok: true })
    }
    window.dispatchEvent(new window.ErrorEvent('error', { message: 'sans-beacon', error: new window.Error('sans-beacon') }))
    assert.equal(fetchCalls.length, 1)
    assert.equal(fetchCalls[0].url, '/__mjs/errors')
    assert.equal(fetchCalls[0].opts.method, 'POST')
    assert.equal(fetchCalls[0].opts.keepalive, true)
    const payload = JSON.parse(fetchCalls[0].opts.body)
    assert.equal(payload.message, 'sans-beacon')
  })

  it('un veilleur qui planterait resterait MUET (try/catch) — sendBeacon qui jette ne remonte jamais', () => {
    const window = makeWindow()
    window.µ.config.journal = true
    window.navigator.sendBeacon = () => { throw new Error('réseau explosé') }
    window.fetch = () => Promise.resolve({ ok: true })
    assert.doesNotThrow(() => {
      window.dispatchEvent(new window.ErrorEvent('error', { message: 'x', error: new window.Error('x') }))
    })
  })
})
