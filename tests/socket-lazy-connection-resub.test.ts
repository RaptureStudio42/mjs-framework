// `stream()`/`presence()`/
// `room()` envoient leur message dédié (`µ:sub-stream`/`µ:sub-presence`/
// `µ:join`) IMMÉDIATEMENT via `_mjs_rawSend()`, qui n'envoie RÉELLEMENT que si le
// WebSocket est déjà `readyState === 1` (OPEN) — sinon il échoue
// SILENCIEUSEMENT (retourne juste `false`, aucune trace, aucune queue).
//
// C'est le cas le PLUS COURANT : le 1er appel à l'un de ces 3 crée le socket
// en connexion PARESSEUSE (`_mjs_ensure()` → `connect()`), qui reste 'connecting'
// pendant tout le round-trip réseau + handshake `µ:hello`/`µ:welcome`. Le
// message dédié part alors qu'aucune connexion n'existe encore → perdu à vie,
// SAUF si quelque chose le réémet une fois la connexion établie. Contrairement
// à `send()` (dont les envois ratés sont mis en `_mjs_queue` et rejoués au
// `µ:welcome`), ces 3 messages dédiés n'avaient AUCUN filet.
//
// Fix : `_mjs_onWelcome` réémet désormais explicitement `µ:sub-stream`/
// `µ:sub-presence`/`µ:join` pour CHAQUE stream/presence/room actuellement
// suivi(e), à CHAQUE (re)connexion — pas seulement la première.

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

describe('µ.socket — connexion paresseuse : stream/presence/room ne se perdent plus', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("stream() sur un socket PAS ENCORE ouvert : µ:sub-stream est réémis au µ:welcome, pas perdu", () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-stream')
    const $$x = s.stream('ennemis') // 1er appel : crée le socket, PAS encore ouvert (readyState=0)
    const ws = last()
    assert.equal(ws.readyState, 0, 'le mock WebSocket vient juste être créé (connexion paresseuse)')
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:sub-stream'), "AVANT ouverture : rien n'a pu partir (readyState≠1)")

    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })

    assert.ok(
      ws.sent.find((m: any) => m.t === 'µ:sub-stream' && m.p.stream === 'ennemis'),
      "AVANT le fix : µ:sub-stream n'était JAMAIS réémis après l'ouverture — l'abonnement était perdu à vie",
    )
    // Bout-en-bout : un delta serveur arrive bien maintenant.
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'add', key: 'a', value: { hp: 10 } } })
    assert.deepEqual($$x.a, { hp: 10 })
    s.destroy()
  })

  it("presence() sur un socket PAS ENCORE ouvert : µ:sub-presence est réémis au µ:welcome, pas perdu", () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-presence')
    const $$j = s.presence('salle-1')
    const ws = last()
    assert.equal(ws.readyState, 0)
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:sub-presence'))

    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })

    const sub = ws.sent.find((m: any) => m.t === 'µ:sub-presence')
    assert.ok(sub, "AVANT le fix : µ:sub-presence n'était JAMAIS réémis — la presence restait vide à vie")
    assert.equal(sub.p.room, 'salle-1')

    ws._srv({ t: 'µ:presence', p: { room: 'salle-1', op: 'reset', peers: { a: { nom: 'Bob' } } } })
    assert.deepEqual($$j.a, { nom: 'Bob' })
    s.destroy()
  })

  it("presence() SANS room (globale) : µ:sub-presence réémis avec room=undefined (pas '')", () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-presence-global')
    s.presence() // pas de room → clé interne '' — vérifie qu'on ne réémet pas room:''
    const ws = last()
    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })
    const sub = ws.sent.find((m: any) => m.t === 'µ:sub-presence')
    assert.ok(sub)
    assert.equal(sub.p.room, undefined, "la presence globale doit réémettre room=undefined, comme l'appel initial")
    s.destroy()
  })

  it("room() sur un socket PAS ENCORE ouvert : µ:join est réémis au µ:welcome, pas perdu", () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-room')
    const zone = s.room('zone-A')
    const ws = last()
    assert.equal(ws.readyState, 0)
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:join'))

    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })

    assert.ok(
      ws.sent.find((m: any) => m.t === 'µ:join' && m.p.room === 'zone-A'),
      "AVANT le fix : µ:join n'était JAMAIS réémis — la room n'était jamais rejointe côté serveur",
    )
    // Bout-en-bout : les messages scopés à la room fonctionnent.
    const recu: any[] = []
    zone.on('move', (p: any) => recu.push(p))
    ws._srv({ t: 'zone-A/move', p: { x: 5 } })
    assert.deepEqual(recu, [{ x: 5 }])
    s.destroy()
  })

  it("reconnexion (drop puis nouvelle WS) : stream/presence/room actifs sont TOUS réémis, pas seulement au 1er connect", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-reconnect', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    s.stream('flux')
    s.presence('r1')
    s.room('zone-B')
    const ws1 = last()
    ws1._mjs_open()
    ws1._srv({ t: 'µ:welcome', p: {} })
    // Tous réémis au 1er welcome (cas déjà couvert ci-dessus) — on vide et on drop.
    ws1.sent.length = 0

    ws1._mjs_drop()
    assert.equal(s.state, 'reconnecting')
    await new Promise(r => setTimeout(r, 10))

    const ws2 = last()
    assert.notEqual(ws2, ws1, 'une nouvelle connexion WS a bien été créée')
    ws2._mjs_open()
    ws2._srv({ t: 'µ:welcome', p: {} })

    assert.ok(ws2.sent.find((m: any) => m.t === 'µ:sub-stream' && m.p.stream === 'flux'), 'stream réémis après reconnexion')
    assert.ok(ws2.sent.find((m: any) => m.t === 'µ:sub-presence' && m.p.room === 'r1'), 'presence réémise après reconnexion')
    assert.ok(ws2.sent.find((m: any) => m.t === 'µ:join' && m.p.room === 'zone-B'), 'room réémise après reconnexion')
    s.destroy()
  })

  it("un stream QUITTÉ (jamais actif) n'est PAS réémis (pas de fuite d'abonnements fantômes)", () => {
    const µ = makeMu()
    const s = µ.socket('wss://lazy-noop')
    s.connect() // sans ça, aucun WebSocket n'est créé (µ.socket seul reste totalement paresseux)
    const ws = last()
    ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })
    // Aucun stream/presence/room jamais demandé → aucun message dédié à réémettre.
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:sub-stream'))
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:sub-presence'))
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:join'))
    s.destroy()
  })
})
