// deux défauts sur `room()` :
//
//   1. `room(name)` appelé 2 FOIS pour LE MÊME nom (2 composants distincts
//      qui rejoignent le même salon, ou un composant qui re-render et
//      rappelle room() sans garder sa référence) renvoyait TOUJOURS un
//      `µ:join` au serveur, même déjà membre — gaspillage réseau au mieux,
//      double comptage côté serveur (présence, membres) au pire. Fix :
//      `_mjs_rooms[name]` sert de garde (déjà le registre d'appartenance relu
//      par `_mjs_onWelcome` pour le re-join auto après reconnexion). Garde
//      symétrique ajoutée sur `leave()`.
//
//   2. Le paramètre `room` de `_mjs_sendNow(type, payload, room)` était mort
//      (aucun des 2 appelants — send(), _mjs_coalesceSend() — ne le passait
//      jamais, le scoping par salon se fait par PRÉFIXE de type). Retiré.

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

describe('µ.socket — room() : garde anti-doublon join/leave', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('2 appels room() pour le MÊME nom : un SEUL µ:join envoyé', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmA')
    s.room('lobby')
    s.room('lobby') // 2e composant, même salon
    const joins = ws.sent.filter((m: any) => m.t === 'µ:join' && m.p.room === 'lobby')
    assert.equal(joins.length, 1, 'AVANT le fix : un 2e µ:join partait à chaque room() répété, même déjà membre')
    s.destroy()
  })

  it('room() sur 2 salons DIFFÉRENTS : un join CHACUN (la garde ne bloque pas les salons distincts)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmB')
    s.room('a')
    s.room('b')
    assert.ok(ws.sent.find((m: any) => m.t === 'µ:join' && m.p.room === 'a'))
    assert.ok(ws.sent.find((m: any) => m.t === 'µ:join' && m.p.room === 'b'))
    s.destroy()
  })

  it('leave() puis room() de nouveau : un NOUVEAU join repart (la garde ne bloque pas un vrai re-join)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmC')
    const zone = s.room('lobby')
    zone.leave()
    s.room('lobby')
    const joins = ws.sent.filter((m: any) => m.t === 'µ:join' && m.p.room === 'lobby')
    assert.equal(joins.length, 2, 'après un vrai leave(), un nouveau join() doit repartir normalement')
    s.destroy()
  })

  it('2 leave() successifs sur le MÊME salon : un SEUL µ:leave envoyé', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmD')
    const zone = s.room('lobby')
    zone.leave()
    zone.leave() // double cleanup (ex. @destroy appelé 2 fois)
    const leaves = ws.sent.filter((m: any) => m.t === 'µ:leave' && m.p.room === 'lobby')
    assert.equal(leaves.length, 1, 'AVANT le fix : un 2e µ:leave partait pour un salon déjà quitté')
    s.destroy()
  })

  it("send/on/request/stream scopés au salon continuent de fonctionner (comportement inchangé)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmE')
    const zone = s.room('zone-A')
    s.room('zone-A') // 2e appel, ne doit rien casser
    const recu: any[] = []
    zone.on('move', (p: any) => recu.push(p))
    zone.send('move', { x: 1 })
    assert.ok(ws.sent.find((m: any) => m.t === 'zone-A/move'))
    ws._srv({ t: 'zone-A/move', p: { x: 9 } })
    assert.deepEqual(recu, [{ x: 9 }])
    s.destroy()
  })
})

describe('µ.socket — join-optimiste : erreur de garde retire le salon, pas de re-join automatique', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('join refusé (µ:error reçu) → le salon sort de _mjs_rooms, PAS de re-join au welcome suivant', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rgA', { reconnect: { backoff: [0], jitter: 0 } })
    s.room('vip')
    assert.ok('vip' in s._mjs_rooms, 'sanity : join optimiste posé avant la réponse serveur')
    ws._srv({ t: 'µ:error', p: { message: 'accès au salon refusé' } })
    assert.equal('vip' in s._mjs_rooms, false, 'AVANT le fix : le salon refusé restait dans _mjs_rooms')

    ws._mjs_drop()
    await new Promise((r) => setTimeout(r, 10))
    const ws2 = last()
    ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    const rejoins = ws2.sent.filter((m: any) => m.t === 'µ:join' && m.p.room === 'vip')
    assert.deepEqual(rejoins, [], 'AVANT le fix : le salon refusé repartait en µ:join à CHAQUE reconnexion, pour toujours')
    s.destroy()
  })

  it('join accepté (aucune erreur reçue) → re-join au welcome suivant INCHANGÉ', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rgB', { reconnect: { backoff: [0], jitter: 0 } })
    s.room('lobby')   // aucune erreur reçue ensuite — le join est réputé accepté

    ws._mjs_drop()
    await new Promise((r) => setTimeout(r, 10))
    const ws2 = last()
    ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    const rejoins = ws2.sent.filter((m: any) => m.t === 'µ:join' && m.p.room === 'lobby')
    assert.equal(rejoins.length, 1, 'salon accepté : comportement inchangé, re-join automatique au welcome suivant')
    s.destroy()
  })

  it('nouvel appel sock.room(name) après refus → nouvelle tentative explicite', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rgC')
    s.room('vip')
    ws._srv({ t: 'µ:error', p: { message: 'refus' } })
    assert.equal('vip' in s._mjs_rooms, false)

    s.room('vip')   // l'appli retente explicitement, comme documenté
    const joins = ws.sent.filter((m: any) => m.t === 'µ:join' && m.p.room === 'vip')
    assert.equal(joins.length, 2, 'le 1er join (refusé) + le nouvel appel explicite après retrait de _mjs_rooms')
    s.destroy()
  })

  it("dégâts collatéraux : l'erreur ne retire QUE le salon en attente le plus ancien (FIFO), jamais presence/stream d'un AUTRE salon", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rgD')
    s.room('a')
    const zoneB = s.room('b')
    zoneB.presence()
    zoneB.stream('pos')
    ws._srv({ t: 'µ:error', p: { message: 'refus' } })   // corrèle au PREMIER salon en attente (FIFO) : 'a'
    assert.equal('a' in s._mjs_rooms, false, "le salon EN ATTENTE le plus ancien ('a') est retiré")
    assert.ok('b' in s._mjs_rooms, "le salon 'b' (non concerné par cette erreur) reste intact")
    assert.ok('b' in s._mjs_presence, 'présence du salon b intacte — jamais touchée par _mjs_onGuardError')
    assert.ok('b/pos' in s._mjs_streams, 'stream du salon b intact — jamais touché par _mjs_onGuardError')
    s.destroy()
  })

  it('µ:error SANS aucun salon en attente : no-op silencieux (comportement pub/sub existant préservé)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rgE')
    assert.doesNotThrow(() => ws._srv({ t: 'µ:error', p: { message: 'débit dépassé, ralentis' } }))
    assert.deepEqual(s.lastError, { message: 'débit dépassé, ralentis' }, 'lastError reste posé normalement (comportement inchangé)')
    s.destroy()
  })
})

describe('µ.socket — _mjs_sendNow : paramètre room mort retiré', () => {
  it('la signature ne déclare plus de 3e paramètre room', () => {
    assert.match(src, /_mjs_sendNow = function\(type, payload\)/, 'AVANT le fix : _mjs_sendNow(type, payload, room) déclarait un paramètre jamais passé par aucun appelant')
    assert.doesNotMatch(src, /_mjs_sendNow = function\(type, payload, room\)/)
  })

  it('send() simple continue de fonctionner (comportement inchangé)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rmF')
    s.send('ping', { a: 1 })
    assert.ok(ws.sent.find((m: any) => m.t === 'ping' && m.p.a === 1))
    s.destroy()
  })
})
