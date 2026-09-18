// Test de régression — `room(name).leave()`
// (mjs_socket.ts) ne retirait JAMAIS les handlers enregistrés via
// `room(name).on(type, h)`. Le proxy renvoyé par `room()` est un pur namespace
// de préfixe SANS état propre (`prefix = name + '/'`, tout vit sur le socket
// PARTAGÉ `self`) : `on()` empile en réalité dans `self._mjs_handlers[prefix +
// type]`. `leave()` se contentait de `delete self._mjs_rooms[name]` + envoyer
// `µ:leave` — chaque closure enregistrée (souvent liée au composant qui vient
// de quitter le salon, DOM/state capturés) restait référencée à VIE tant que
// le SOCKET reste vivant (réf-compté, potentiellement partagé par plusieurs
// composants qui n'ont pas tous quitté) — fuite mémoire + un message serveur
// arrivant APRÈS le leave (résiduel réseau) invoquerait quand même un handler
// d'un composant qui a déjà quitté/été détruit.
//
// Fix : `leave()` purge tout `_mjs_handlers`/`_mjs_subs` namespacé sous le préfixe du
// salon, via `self.off(key)` (réutilise sa propre logique de nettoyage).

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

describe('µ.socket — room().leave() ne fuit plus les handlers', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("un message serveur pour le salon quitté n'invoque PLUS le handler après leave()", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlA')
    const zone = s.room('lobby')
    const recu: any[] = []
    zone.on('chat', (p: any) => recu.push(p))
    ws._srv({ t: 'lobby/chat', p: { msg: 'avant' } })
    assert.deepEqual(recu, [{ msg: 'avant' }], 'sanity : le handler fonctionne avant leave()')

    zone.leave()
    ws._srv({ t: 'lobby/chat', p: { msg: 'apres' } })
    assert.deepEqual(recu, [{ msg: 'avant' }],
      "AVANT le fix : le handler restait enregistré et recevait aussi le message post-leave()")
  })

  it("_mjs_handlers/_mjs_subs ne conservent AUCUNE clé sous le préfixe du salon après leave()", () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://rlB')
    const zone = s.room('team')
    zone.on('move', () => {})
    zone.on('chat', () => {})
    assert.ok('team/move' in s._mjs_handlers && 'team/chat' in s._mjs_handlers, 'sanity : les 2 handlers sont bien enregistrés')

    zone.leave()
    const leaked = Object.keys(s._mjs_handlers).filter(k => k.indexOf('team/') === 0)
    assert.deepEqual(leaked, [], `AVANT le fix : ${JSON.stringify(Object.keys(s._mjs_handlers))} — les clés team/* survivaient au leave()`)
    assert.equal('team/move' in s._mjs_subs, false)
    assert.equal('team/chat' in s._mjs_subs, false)
  })

  it('plusieurs handlers empilés sur LE MÊME type de salon : TOUS retirés par un seul leave()', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlC')
    const zone = s.room('lobby')
    const recuA: any[] = [], recuB: any[] = []
    zone.on('chat', (p: any) => recuA.push(p))
    zone.on('chat', (p: any) => recuB.push(p))
    zone.leave()
    ws._srv({ t: 'lobby/chat', p: { msg: 'x' } })
    assert.deepEqual(recuA, [])
    assert.deepEqual(recuB, [])
  })

  it("leave() sur le salon A ne touche PAS aux handlers du salon B (pas de sur-purge)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlD')
    const zoneA = s.room('a')
    const zoneB = s.room('b')
    const recuB: any[] = []
    zoneA.on('chat', () => { throw new Error('ne doit jamais être appelé') })
    zoneB.on('chat', (p: any) => recuB.push(p))

    zoneA.leave()
    ws._srv({ t: 'b/chat', p: { ok: true } })
    assert.deepEqual(recuB, [{ ok: true }], 'le salon b, non quitté, continue de recevoir ses messages')
  })

  it("leave() ne touche PAS aux handlers hors salon (sock.on direct, sans préfixe)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlE')
    const zone = s.room('lobby')
    const recuGlobal: any[] = []
    s.on('ping', (p: any) => recuGlobal.push(p))
    zone.on('chat', () => {})

    zone.leave()
    ws._srv({ t: 'ping', p: { n: 1 } })
    assert.deepEqual(recuGlobal, [{ n: 1 }], "un handler enregistré directement sur le socket (pas via room()) survit au leave() d'un salon")
  })

  it('après leave() puis re-room() (vrai rejoin) : un NOUVEAU on() fonctionne normalement', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlF')
    const zone1 = s.room('lobby')
    zone1.on('chat', () => { throw new Error('handler périmé ne doit plus tourner') })
    zone1.leave()

    const zone2 = s.room('lobby')
    const recu: any[] = []
    zone2.on('chat', (p: any) => recu.push(p))
    ws._srv({ t: 'lobby/chat', p: { fresh: true } })
    assert.deepEqual(recu, [{ fresh: true }], 're-join propre : le nouveau handler reçoit bien les messages')
  })

  it('double leave() successif (cleanup @destroy appelé 2×) : pas de crash, comportement idempotent', () => {
    const µ = makeMu(); const { s } = open(µ, 'wss://rlG')
    const zone = s.room('lobby')
    zone.on('chat', () => {})
    assert.doesNotThrow(() => { zone.leave(); zone.leave() })
    assert.deepEqual(Object.keys(s._mjs_handlers).filter(k => k.indexOf('lobby/') === 0), [])
  })

  it("leave() purge AUSSI _mjs_streams/_mjs_presence/_mjs_subs du salon — plus de resub du salon quitté après reconnexion", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlH', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    const zone = s.room('partie-42')
    zone.stream('positions')
    zone.presence()
    assert.ok('partie-42/positions' in s._mjs_streams, 'sanity : le stream du salon est enregistré')
    assert.ok('partie-42' in s._mjs_presence, 'sanity : la présence du salon est enregistrée')

    zone.leave()
    assert.deepEqual(Object.keys(s._mjs_streams).filter((k: string) => k.indexOf('partie-42/') === 0), [],
      'AVANT le fix : _mjs_streams gardait partie-42/positions à vie (leave() ne purgeait que _mjs_handlers)')
    assert.equal('partie-42' in s._mjs_presence, false, 'AVANT le fix : _mjs_presence gardait partie-42 à vie')
    assert.equal('stream:partie-42/positions' in s._mjs_subs, false)
    assert.equal('presence:partie-42' in s._mjs_subs, false)

    // Reconnexion : le salon quitté ne doit PAS être ré-abonné (stream/présence).
    ws._mjs_drop()
    await new Promise((r) => setTimeout(r, 10))
    const ws2 = last()
    ws2._mjs_open(); ws2._srv({ t: 'µ:welcome', p: {} })
    const resub = ws2.sent.filter((m: any) =>
      (m.t === 'µ:sub-stream' && (m.p.stream || '').indexOf('partie-42/') === 0)
      || (m.t === 'µ:sub-presence' && m.p.room === 'partie-42'),
    )
    assert.deepEqual(resub, [], 'AVANT le fix : _mjs_onWelcome ré-abonnait le salon QUITTÉ à chaque reconnexion')
    s.destroy()
  })

  it("kick serveur (µ:left) purge streams/présence/handlers du salon, symétrique à leave()", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rlI')
    const zone = s.room('zone-X')
    zone.on('chat', () => { throw new Error('handler du salon kické ne doit plus tourner') })
    zone.stream('pos')
    zone.presence()
    let raison: any = null
    zone.onLeft((r: any) => { raison = r })

    ws._srv({ t: 'µ:left', p: { room: 'zone-X', reason: 'kick' } })
    assert.equal(raison, 'kick', 'le callback onLeft est invoqué AVANT la purge (il peut lire l\'état une dernière fois)')
    assert.deepEqual(Object.keys(s._mjs_handlers).filter((k: string) => k.indexOf('zone-X/') === 0), [], 'AVANT le fix : handlers du salon kické non purgés')
    assert.deepEqual(Object.keys(s._mjs_streams).filter((k: string) => k.indexOf('zone-X/') === 0), [], 'streams du salon kické purgés')
    assert.equal('zone-X' in s._mjs_presence, false, 'présence du salon kické purgée')
    // Message résiduel réseau arrivant APRÈS le kick : n'invoque plus le handler.
    assert.doesNotThrow(() => ws._srv({ t: 'zone-X/chat', p: {} }))
    s.destroy()
  })
})
