// `request(type, payload,
// {waitForOpen: true})` appelé hors-ligne (socket pas encore 'open') envoyait
// `_mjs_rawSend()` IMMÉDIATEMENT — silencieusement jeté par `_mjs_rawSend` (readyState !== 1)
// — puis RIEN ne relayait la requête une fois la connexion ouverte, contrairement
// à `send()` dont la file `_mjs_queue` est explicitement rejouée dans `_mjs_onWelcome`.
// Résultat : la requête n'était JAMAIS réellement transmise, et le timeout
// finissait TOUJOURS par rejeter — même si la connexion s'ouvrait 100ms plus
// tard. L'option ne changeait donc rien d'observable pour l'appelant, à part
// retarder un échec devenu inévitable jusqu'à l'échéance du timeout.
//
// Fix : la requête est mise en attente (`_mjs_pendingOpenReqs`) si le socket n'est
// pas encore ouvert, puis réellement envoyée dans `_mjs_onWelcome` (même relais
// que la file `_mjs_queue` de send()) — le timeout reste le filet de sécurité si
// la connexion n'aboutit jamais.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

class MockWS {
  static instances: MockWS[] = []
  url: string; readyState = 0; sent: any[] = []
  onopen: any; onmessage: any; onclose: any; onerror: any
  constructor(url: string) { this.url = url; MockWS.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  _mjs_open() { this.readyState = 1; this.onopen && this.onopen({}) }
  _srv(obj: any) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) }
  _mjs_drop(code = 1006) { this.readyState = 3; this.onclose && this.onclose({ code }) }
}
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
const last = () => MockWS.instances[MockWS.instances.length - 1]

describe('µ.socket — request({waitForOpen:true}) hors-ligne', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("la requête ne part PAS tant que le socket n'est pas open, puis part VRAIMENT à l'ouverture", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo1')
    const p = s.request('ping', { a: 1 }, { waitForOpen: true })
    const ws = last()
    // `_mjs_ensure()` (appelé en tête de request()) a déclenché connect() : le
    // socket est 'connecting', pas encore 'open'.
    assert.equal(s.state, 'connecting')
    assert.ok(!ws.sent.find((m: any) => m.t === 'ping'), "rien ne doit partir tant que le socket n'est pas open")

    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })

    const req = ws.sent.find((m: any) => m.t === 'ping')
    assert.ok(req, "AVANT le fix : la requête n'était JAMAIS réellement transmise à l'ouverture (perdue dans _mjs_rawSend)")
    ws._srv({ t: 'µ:ack', id: req.id, p: { pong: true } })
    assert.deepEqual(await p, { pong: true })
    s.destroy()
  })

  it("connexion qui n'ouvre JAMAIS : le timeout de secours reste actif (pas d'attente infinie)", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo2')
    const p = s.request('ping', {}, { waitForOpen: true, timeout: 5 })
    // ws._mjs_open()/_srv(welcome) jamais appelés : la connexion ne s'ouvre jamais.
    await assert.rejects(p, (e: any) => e.code === 'timeout')
    s.destroy()
  })

  it("après expiration du timeout, une ouverture ULTÉRIEURE ne renvoie pas la requête abandonnée", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo3')
    const p = s.request('ping', {}, { waitForOpen: true, timeout: 5 })
    await assert.rejects(p, (e: any) => e.code === 'timeout')

    const ws = last()
    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })
    assert.ok(!ws.sent.find((m: any) => m.t === 'ping'), "requête déjà rejetée (timeout) : ne doit pas ressurgir sur une ouverture ultérieure")
    s.destroy()
  })

  it("sans waitForOpen, hors-ligne : rejette IMMÉDIATEMENT avec code 'offline' (comportement de base inchangé)", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo4')
    const p = s.request('ping', {})
    await assert.rejects(p, (e: any) => e.code === 'offline')
    s.destroy()
  })

  it("déjà open au moment de l'appel : envoi immédiat, waitForOpen n'a aucun effet", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo5'); s.connect()
    const ws = last(); ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} })

    const p = s.request('ping', { a: 1 }, { waitForOpen: true })
    const req = ws.sent.find((m: any) => m.t === 'ping')
    assert.ok(req, 'socket déjà open : envoi synchrone comme sans waitForOpen')
    ws._srv({ t: 'µ:ack', id: req.id, p: { ok: true } })
    assert.deepEqual(await p, { ok: true })
    s.destroy()
  })

  it("survit à l'échec d'une TENTATIVE : NON rejetée au drop, puis transmise après reconnexion", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://wfo6', { reconnect: { backoff: [10], jitter: 0 }, heartbeat: 0 })
    s.connect() // tentative 1 en cours (jamais open)
    const reqP = s.request('load', {}, { waitForOpen: true, timeout: 5000 })
    let settled = false
    reqP.then(() => { settled = true }, () => { settled = true })

    const ws1 = last()
    ws1._mjs_drop() // la 1re tentative échoue (serveur indispo)
    await new Promise((r) => setTimeout(r, 1))
    assert.equal(settled, false,
      "AVANT le fix : le teardown de la tentative ratée rejetait 'closed' immédiatement (interaction waitForOpen × teardown)")

    await new Promise((r) => setTimeout(r, 25)) // la reconnexion aboutit (backoff 10ms)
    const ws2 = last()
    assert.notEqual(ws2, ws1, 'une nouvelle WS a bien été créée par le backoff')
    ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    const req = ws2.sent.find((m: any) => m.t === 'load')
    assert.ok(req, "AVANT le fix : jamais retransmise (entrée _mjs_reqs purgée au teardown) → l'option redevenait inopérante dès qu'UNE tentative échouait")
    ws2._srv({ t: 'µ:ack', id: req.id, p: { ok: true } })
    assert.deepEqual(await reqP, { ok: true })
    s.destroy()
  })
})
