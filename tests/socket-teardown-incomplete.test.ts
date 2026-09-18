// teardown incomplet, 3
// restes qui pouvaient survivre à la fermeture/destruction d'un socket :
//
//   1. `_mjs_teardown()` (appelé par close() ET par une coupure inattendue) ne
//      rejetait JAMAIS les request() en attente d'un `µ:ack` — elles
//      patientaient jusqu'à leur PROPRE timeout individuel, alors que la
//      connexion sur laquelle elles ont été envoyées vient de mourir : le
//      serveur ne peut PLUS jamais accuser réception de cet id, même après
//      une reconnexion (nouvelle poignée de main, nouvelle session côté
//      serveur). Fix : rejet immédiat, inconditionnel.
//
//   2. Un timer `_mjs_coalesceSend` en vol au moment de `destroy()` n'était
//      jamais annulé — il rappelait `_mjs_sendNow()` PLUS TARD sur un socket
//      mort, qui repoussait silencieusement le message dans `_mjs_queue`, que
//      plus AUCUN `_mjs_onWelcome` ne rejouera jamais (et maintenait le socket
//      artificiellement vivant en mémoire via la closure du timer). Fix :
//      id du timer conservé (`slot.timer`), annulé dans destroy().
//
//   3. `_mjs_queue` (messages hors-ligne en attente de reconnexion) n'était
//      jamais vidée par `destroy()` — des messages qui ne seront JAMAIS
//      rejoués (destroy() est définitif) restaient en mémoire sans raison.
//      Fix : `_mjs_queue = []` dans destroy().

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
function open(µ: any, url: string, opts?: any) {
  const s = µ.socket(url, opts); s.connect(); const ws = last()
  ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} }); return { s, ws }
}

describe('µ.socket — _mjs_teardown() rejette les request() en attente (pas de longue attente inutile)', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("close() rejette IMMÉDIATEMENT une request() en attente d'ack (pas besoin d'attendre son timeout de 5s)", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://td1')
    const p = s.request('ping', {}, { timeout: 5000 })
    assert.ok(ws.sent.find((m: any) => m.t === 'ping'))
    s.close()
    await assert.rejects(p, (e: any) => e.code === 'closed', "AVANT le fix : rien ne rejetait cette promesse avant son timeout de 5000ms")
  })

  it('une coupure INATTENDUE (avec reconnexion prévue) rejette aussi la request en attente (id mort quoi qu\'il arrive)', async () => {
    const µ = makeMu()
    const { s, ws } = open(µ, 'wss://td2', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    const p = s.request('ping', {}, { timeout: 5000 })
    ws._mjs_drop() // coupure réseau, PAS un close() volontaire — une reconnexion va être tentée
    assert.equal(s.state, 'reconnecting')
    await assert.rejects(p, (e: any) => e.code === 'closed', "un id de request appartient à la connexion MORTE — le reconnect ne peut pas le sauver")
    s.destroy()
  })

  it('une request qui A DÉJÀ reçu son ack avant teardown reste résolue normalement (pas re-rejetée)', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://td3')
    const p = s.request('ping', {})
    const req = ws.sent.find((m: any) => m.t === 'ping')
    ws._srv({ t: 'µ:ack', id: req.id, p: { pong: true } })
    assert.deepEqual(await p, { pong: true })
    assert.doesNotThrow(() => s.close(), 'fermer après résolution ne doit rien re-rejeter ni planter')
    s.destroy()
  })
})

describe('µ.socket — destroy() annule les timers _mjs_coalesceSend en vol', () => {
  beforeEach(() => { MockWS.instances = [] })

  let __prevSetTimeout: any, __prevClearTimeout: any
  let fakeNow = 0
  let timers: Array<{ id: number, at: number, fn: Function }> = []
  let nextId = 1
  function fakeSetTimeout(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn }); return id }
  function fakeClearTimeout(id: number) { timers = timers.filter(t => t.id !== id) }
  function advance(ms: number) {
    const target = fakeNow + ms
    for (let guard = 0; guard < 10000; guard++) {
      let earliest: any = null
      for (const t of timers) { if (t.at <= target && (!earliest || t.at < earliest.at)) earliest = t }
      if (!earliest) break
      fakeNow = earliest.at
      timers = timers.filter(t => t !== earliest)
      earliest.fn()
    }
    fakeNow = target
  }
  beforeEach(() => {
    fakeNow = 0; timers = []; nextId = 1
    __prevSetTimeout = (globalThis as any).setTimeout
    __prevClearTimeout = (globalThis as any).clearTimeout
    ;(globalThis as any).setTimeout = fakeSetTimeout
    ;(globalThis as any).clearTimeout = fakeClearTimeout
  })
  afterEach(() => {
    ;(globalThis as any).setTimeout = __prevSetTimeout
    ;(globalThis as any).clearTimeout = __prevClearTimeout
  })

  it('un coalesce programmé puis destroy() : le timer ne rappelle plus _mjs_sendNow (rien ne réapparaît dans _mjs_queue)', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://td4')
    s.send('pos', { x: 1 }, { coalesce: 50 })   // trailing : un timer est programmé
    assert.equal(Object.keys((s as any)._mjs_coalesce).length, 1, 'un slot coalesce doit être programmé')
    assert.ok((s as any)._mjs_coalesce.pos.timer != null, 'un timer trailing est bien en vol')

    s.destroy()
    advance(1000) // dépasse largement les 50ms — si le timer n'était pas annulé, il tirerait ici

    assert.equal((s as any)._mjs_queue.length, 0, "AVANT le fix : le timer coalesce non annulé rappelait _mjs_sendNow() après destroy(), repoussant le message dans _mjs_queue")
  })

  it('coalesce SANS destroy() : le comportement normal (envoi différé) fonctionne toujours', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://td5')
    const before = ws.sent.filter((m: any) => m.t === 'pos').length
    s.send('pos', { x: 1 }, { coalesce: 50 })
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos').length, before, 'pas encore envoyé avant expiration du délai (trailing)')
    advance(60)
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos').length, before + 1, 'envoyé après expiration (comportement nominal)')
    s.destroy()
  })

  it('un debounce programmé puis destroy() : le timer ne rappelle plus _mjs_sendNow (rien ne réapparaît dans _mjs_queue)', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://td7')
    s.send('pos', { x: 1 }, { debounce: 50 })   // un timer de silence est programmé
    assert.equal(Object.keys((s as any)._mjs_debounce).length, 1, 'un slot debounce doit être programmé')
    assert.ok((s as any)._mjs_debounce.pos.timer != null, 'un timer debounce est bien en vol')

    s.destroy()
    advance(1000) // dépasse largement les 50ms — si le timer n'était pas annulé, il tirerait ici

    assert.equal((s as any)._mjs_queue.length, 0, "AVANT le fix : le timer debounce non annulé rappelait _mjs_sendNow() après destroy(), repoussant le message dans _mjs_queue")
  })

  it('debounce SANS destroy() : le comportement normal (envoi après le silence) fonctionne toujours', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://td8')
    const before = ws.sent.filter((m: any) => m.t === 'pos').length
    s.send('pos', { x: 1 }, { debounce: 50 })
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos').length, before, 'pas encore envoyé avant la fin du silence')
    advance(60)
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos').length, before + 1, 'envoyé après le silence (comportement nominal)')
    s.destroy()
  })
})

describe('µ.socket — close() annule aussi les timers _mjs_coalesceSend/_mjs_debounceSend en vol (pas seulement destroy())', () => {
  beforeEach(() => { MockWS.instances = [] })

  let __prevSetTimeout: any, __prevClearTimeout: any
  let fakeNow = 0
  let timers: Array<{ id: number, at: number, fn: Function }> = []
  let nextId = 1
  function fakeSetTimeout(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn }); return id }
  function fakeClearTimeout(id: number) { timers = timers.filter(t => t.id !== id) }
  function advance(ms: number) {
    const target = fakeNow + ms
    for (let guard = 0; guard < 10000; guard++) {
      let earliest: any = null
      for (const t of timers) { if (t.at <= target && (!earliest || t.at < earliest.at)) earliest = t }
      if (!earliest) break
      fakeNow = earliest.at
      timers = timers.filter(t => t !== earliest)
      earliest.fn()
    }
    fakeNow = target
  }
  beforeEach(() => {
    fakeNow = 0; timers = []; nextId = 1
    __prevSetTimeout = (globalThis as any).setTimeout
    __prevClearTimeout = (globalThis as any).clearTimeout
    ;(globalThis as any).setTimeout = fakeSetTimeout
    ;(globalThis as any).clearTimeout = fakeClearTimeout
  })
  afterEach(() => {
    ;(globalThis as any).setTimeout = __prevSetTimeout
    ;(globalThis as any).clearTimeout = __prevClearTimeout
  })

  it('debounce en vol puis close() (SANS destroy) : rien dans _mjs_queue, et un reconnect sur le MÊME socket ne rejoue rien', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://tc1')
    s.send('pos', { x: 1 }, { debounce: 50 })
    assert.ok((s as any)._mjs_debounce.pos.timer != null, 'timer debounce en vol avant close()')

    s.close()
    advance(60)   // dépasse largement les 50ms — si le timer n'était pas annulé, il tirerait ici

    assert.equal((s as any)._mjs_queue.length, 0, "close() doit annuler le debounce en vol, rien ne doit atterrir dans _mjs_queue")

    s.connect()
    const ws2 = last(); ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    assert.ok(!ws2.sent.find((m: any) => m.t === 'pos'), "le debounce annulé par close() ne doit JAMAIS repartir à la reconnexion")
    s.destroy()
  })

  it('coalesce en vol puis close() (SANS destroy) : rien dans _mjs_queue, et un reconnect sur le MÊME socket ne rejoue rien', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://tc2')
    s.send('pos', { x: 1 }, { coalesce: 50 })
    assert.ok((s as any)._mjs_coalesce.pos.timer != null, 'timer coalesce en vol avant close()')

    s.close()
    advance(60)

    assert.equal((s as any)._mjs_queue.length, 0, 'close() doit annuler le coalesce en vol, rien ne doit atterrir dans _mjs_queue')

    s.connect()
    const ws2 = last(); ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    assert.ok(!ws2.sent.find((m: any) => m.t === 'pos'), "le coalesce annulé par close() ne doit JAMAIS repartir à la reconnexion")
    s.destroy()
  })

  it('close() puis destroy() : pas de double libération qui lève (purge idempotente)', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://tc3')
    s.send('pos', { x: 1 }, { debounce: 50 })
    s.close()
    assert.doesNotThrow(() => s.destroy(), 'un 2e passage sur des timers déjà purgés ne doit jamais lever')
  })
})

describe('µ.socket — destroy() vide _mjs_queue (messages hors-ligne qui ne seront jamais rejoués)', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('des messages en attente de reconnexion ne survivent pas à un destroy() définitif', () => {
    const µ = makeMu()
    const s = µ.socket('wss://td6') // jamais ouvert : send() va directement dans _mjs_queue
    s.send('chat', { text: 'hello' })
    assert.equal((s as any)._mjs_queue.length, 1)

    s.destroy()
    assert.equal((s as any)._mjs_queue.length, 0, 'AVANT le fix : ces messages restaient en mémoire indéfiniment, sans aucune chance future de être rejoués')
  })
})
