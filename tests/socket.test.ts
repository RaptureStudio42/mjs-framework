// Tests déterministes de µ.socket — on remplace WebSocket par un faux serveur
// en mémoire piloté par le test (open/message/drop), pas de réseau réel.
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
const delay = (ms: number) => new Promise(r => setTimeout(r, ms))
function open(µ: any, url: string, opts?: any) {
  const s = µ.socket(url, opts); s.connect(); const ws = last(); ws._mjs_open()
  ws._srv({ t: 'µ:welcome', p: {} }); return { s, ws }
}

describe('µ.socket — cœur', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('handshake : connecting → open après µ:welcome', () => {
    const µ = makeMu(); const s = µ.socket('wss://x'); s.connect()
    assert.equal(s.state, 'connecting')
    const ws = last(); ws._mjs_open()
    assert.equal(ws.sent[0].t, 'µ:hello')
    assert.equal(s.state, 'connecting')        // pas open tant que pas de welcome
    ws._srv({ t: 'µ:welcome', p: {} })
    assert.equal(s.state, 'open'); assert.equal(s.connected, true)
    s.destroy()
  })

  it('auth = valeur (objet, pas une fonction) : transmise telle quelle dans µ:hello.p.auth', () => {
    const µ = makeMu()
    const jeton = { user: 'alice', token: 'xyz' }
    const s = µ.socket('wss://x-auth-obj', { auth: jeton }); s.connect()
    const ws = last(); ws._mjs_open()
    const hello = ws.sent.find((m: any) => m.t === 'µ:hello')
    assert.deepEqual(hello.p.auth, jeton)
    s.destroy()
  })

  it('auth = valeur (string) : transmise telle quelle dans µ:hello.p.auth', () => {
    const µ = makeMu()
    const s = µ.socket('wss://x-auth-str', { auth: 'jeton-brut' }); s.connect()
    const ws = last(); ws._mjs_open()
    const hello = ws.sent.find((m: any) => m.t === 'µ:hello')
    assert.equal(hello.p.auth, 'jeton-brut')
    s.destroy()
  })

  it('on/send + dispatch ; off stoppe la réception', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x2')
    const recu: any[] = []
    const off = s.on('move', (p: any) => recu.push(p))
    ws._srv({ t: 'move', p: { x: 1 } }); assert.deepEqual(recu, [{ x: 1 }])
    off(); ws._srv({ t: 'move', p: { x: 2 } }); assert.deepEqual(recu, [{ x: 1 }])
    s.destroy()
  })

  it('send hors-ligne mis en file puis flushé au welcome', () => {
    const µ = makeMu(); const s = µ.socket('wss://x3'); s.connect()
    s.send('a', { n: 1 }); const ws = last()
    assert.ok(!ws.sent.find((m: any) => m.t === 'a'))
    ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} })
    assert.ok(ws.sent.find((m: any) => m.t === 'a' && m.p.n === 1))
    s.destroy()
  })

  it('µ:denied → closed, AUCUNE reconnexion', async () => {
    const µ = makeMu()
    const s = µ.socket('wss://x4', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); const ws = last(); ws._mjs_open()
    ws._srv({ t: 'µ:denied', p: { reason: 'bad token' } })
    assert.equal(s.state, 'closed'); assert.deepEqual(s.lastError, { reason: 'bad token' })
    const n = MockWS.instances.length; await delay(10)
    assert.equal(MockWS.instances.length, n)
    s.destroy()
  })

  // le refus était MUET : le socket se fermait pour de bon et l'appli n'avait
  // aucun moyen d'apprendre qu'elle devait aller chercher un jeton frais. Miroir de 'welcome'.
  it("µ:denied → l'événement 'denied' est dispatché, APRÈS la fermeture", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://x4-denied', { reconnect: { backoff: [0], jitter: 0 } })
    const vus: any[] = []
    let etatAuHandler: string | null = null
    s.on('denied', (p: any) => { vus.push(p); etatAuHandler = s.state })
    s.connect(); const ws = last(); ws._mjs_open()
    ws._srv({ t: 'µ:denied', p: { message: 'jeton expiré' } })
    assert.equal(vus.length, 1)
    assert.deepEqual(vus[0], { message: 'jeton expiré' })
    // le handler voit un socket DÉJÀ au repos : un connect() appelé de là rouvre pour de bon
    assert.equal(etatAuHandler, 'closed')
    s.destroy()
  })

  it("'denied' : rouvrir depuis le handler repart sur une WS neuve (le rattrapage de jeton)", async () => {
    const µ = makeMu()
    let jeton = 'perime'
    const s = µ.socket('wss://x4-reprise', { auth: () => ({ token: jeton }), reconnect: { backoff: [0], jitter: 0 } })
    s.on('denied', () => { jeton = 'frais'; s.connect() })
    s.connect(); const ws = last(); ws._mjs_open()
    assert.equal(ws.sent[0].p.auth.token, 'perime')
    const n = MockWS.instances.length
    ws._srv({ t: 'µ:denied', p: { message: 'expiré' } })
    assert.equal(MockWS.instances.length, n + 1, 'une WS neuve doit être ouverte depuis le handler')
    const ws2 = last(); ws2._mjs_open()
    assert.equal(ws2.sent[0].p.auth.token, 'frais', 'le hello rejoué doit porter le jeton neuf')
    s.destroy()
  })

  it('coupure inattendue → reconnecting puis nouvelle WS', async () => {
    const µ = makeMu()
    const { s, ws } = open(µ, 'wss://x5', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    const n = MockWS.instances.length
    ws._mjs_drop(); assert.equal(s.state, 'reconnecting')
    await delay(10); assert.equal(MockWS.instances.length, n + 1)
    s.destroy()
  })

  it('resub : la liste des types abonnés est renvoyée dans µ:hello', () => {
    const µ = makeMu(); const { s, ws: _mjs_ws } = open(µ, 'wss://x5b')
    s.on('move', () => {}); s.on('chat', () => {})
    s.close(); s.connect(); const ws2 = last(); ws2._mjs_open()
    const hello = ws2.sent.find((m: any) => m.t === 'µ:hello')
    assert.deepEqual(hello.p.resub.sort(), ['chat', 'move'])
    s.destroy()
  })

  it('request : résout sur µ:ack, rejette sur e:true et sur timeout', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x6')
    const p = s.request('ping', { a: 1 })
    const req = ws.sent.find((m: any) => m.t === 'ping'); assert.ok(req.id)
    ws._srv({ t: 'µ:ack', id: req.id, p: { pong: true } })
    assert.deepEqual(await p, { pong: true })
    const p2 = s.request('boom', {})
    const id2 = ws.sent.find((m: any) => m.t === 'boom').id
    ws._srv({ t: 'µ:ack', id: id2, e: true, p: { code: 'nope' } })
    await assert.rejects(p2, (e: any) => e.code === 'nope')
    const p3 = s.request('slow', {}, { timeout: 5 })
    await assert.rejects(p3, (e: any) => e.code === 'timeout')
    s.destroy()
  })

  it('latency mise à jour sur µ:pong', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x7', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    assert.ok(s.latency >= 0)
    s.destroy()
  })

  it('cooldown : 1er envoi passe, les trop rapprochés sont jetés', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8')
    assert.equal(s.send('atk', {}, { cooldown: 10000 }), true)
    const c1 = ws.sent.filter((m: any) => m.t === 'atk').length
    s.send('atk', {}, { cooldown: 10000 })
    assert.equal(ws.sent.filter((m: any) => m.t === 'atk').length, c1)
    s.destroy()
  })

  it('coalesce : intervalle en MS, un seul envoi et le DERNIER payload gagne (débit max 1/intervalle)', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8b')
    const before = ws.sent.filter((m: any) => m.t === 'pos').length
    s.send('pos', { n: 1 }, { coalesce: 20 })
    s.send('pos', { n: 2 }, { coalesce: 20 })                     // écrase la trame en attente
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos').length, before)   // rien émis tout de suite (trailing)
    await delay(35)
    const posts = ws.sent.filter((m: any) => m.t === 'pos')
    assert.equal(posts.length, before + 1)                       // un SEUL envoi sur l'intervalle
    assert.equal(posts[posts.length - 1].p.n, 2)                 // le dernier payload gagne
    s.destroy()
  })

  it('debounce : rien ne part tant que les envois s\'enchaînent, la DERNIÈRE charge part après le silence', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8c')
    const before = ws.sent.filter((m: any) => m.t === 'q').length
    for (let i = 1; i <= 3; i++) { s.send('q', { n: i }, { debounce: 30 }); await delay(5) }
    assert.equal(ws.sent.filter((m: any) => m.t === 'q').length, before)   // rien juste après le 3e envoi
    await delay(45)
    const qs = ws.sent.filter((m: any) => m.t === 'q')
    assert.equal(qs.length, before + 1)                           // exactement UN envoi
    assert.equal(qs[qs.length - 1].p.n, 3)                        // la dernière charge, pas la 1re
    s.destroy()
  })

  it("debounce ≠ coalesce : sous activité continue, coalesce a déjà émis quand debounce n'a rien émis", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8d')
    const beforeA = ws.sent.filter((m: any) => m.t === 'a').length
    const beforeB = ws.sent.filter((m: any) => m.t === 'b').length
    for (let i = 1; i <= 7; i++) {
      s.send('a', { n: i }, { coalesce: 30 })
      s.send('b', { n: i }, { debounce: 30 })
      await delay(10)
    }
    assert.ok(ws.sent.filter((m: any) => m.t === 'a').length >= beforeA + 1, 'coalesce émet déjà à cadence fixe')
    assert.equal(ws.sent.filter((m: any) => m.t === 'b').length, beforeB, "debounce : rien émis, l'activité continue repousse le silence")
    await delay(45)
    assert.equal(ws.sent.filter((m: any) => m.t === 'b').length, beforeB + 1, 'le silence arrive enfin : un seul envoi part')
    s.destroy()
  })

  it('debounce: true retombe sur opts.debounceMs du socket (ouvert avec debounceMs: 20)', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8e', { debounceMs: 20 })
    const before = ws.sent.filter((m: any) => m.t === 'q2').length
    s.send('q2', { n: 1 }, { debounce: true })
    await delay(10)
    assert.equal(ws.sent.filter((m: any) => m.t === 'q2').length, before, 'pas encore, avant le silence de 20ms')
    await delay(20)
    assert.equal(ws.sent.filter((m: any) => m.t === 'q2').length, before + 1, 'parti après opts.debounceMs')
    s.destroy()
  })

  it('cooldown + debounce : le 2e envoi sous cooldown est jeté, le 1er part après le silence', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8f')
    const before = ws.sent.filter((m: any) => m.t === 'q3').length
    assert.equal(s.send('q3', { n: 1 }, { cooldown: 10000, debounce: 20 }), true)
    assert.equal(s.send('q3', { n: 2 }, { cooldown: 10000, debounce: 20 }), false)   // jeté par le cooldown
    await delay(30)
    const q3s = ws.sent.filter((m: any) => m.t === 'q3')
    assert.equal(q3s.length, before + 1)
    assert.equal(q3s[q3s.length - 1].p.n, 1)                      // seul le 1er a passé le cooldown
    s.destroy()
  })

  it('debounce: 0 → rien de synchrone (arme quand même un timer), un seul envoi après le silence avec la DERNIÈRE charge (0 testait faux et sautait l\'anti-rebond)', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8g')
    const before = ws.sent.filter((m: any) => m.t === 'q4').length
    s.send('q4', { n: 1 }, { debounce: 0 })
    s.send('q4', { n: 2 }, { debounce: 0 })
    assert.equal(ws.sent.filter((m: any) => m.t === 'q4').length, before, 'rien de synchrone : debounce:0 arme un timer, ne part pas immédiatement')
    await delay(5)
    const q4s = ws.sent.filter((m: any) => m.t === 'q4')
    assert.equal(q4s.length, before + 1)
    assert.equal(q4s[q4s.length - 1].p.n, 2, 'la dernière charge, pas la 1re')
    s.destroy()
  })

  it('debounce: -5 → ramené à 0 AVANT setTimeout, aucun avertissement Node (TimeoutNegativeWarning)', async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8h')
    const before = ws.sent.filter((m: any) => m.t === 'q5').length
    const warnings: any[] = []
    const onWarning = (w: any) => warnings.push(w)
    process.on('warning', onWarning)
    s.send('q5', { n: 1 }, { debounce: -5 })
    await delay(5)
    process.off('warning', onWarning)
    assert.equal(ws.sent.filter((m: any) => m.t === 'q5').length, before + 1, 'parti après clamp à 0')
    assert.ok(!warnings.find((w: any) => w.name === 'TimeoutNegativeWarning'), 'la valeur négative doit être clampée dans send(), jamais passée telle quelle à setTimeout')
    s.destroy()
  })

  it("debounce: '30' (chaîne numérique) → 0 envoi avant 20ms, 1 envoi après 45ms (la chaîne se perdait en silence, envoi immédiat)", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8i')
    const before = ws.sent.filter((m: any) => m.t === 'q6').length
    s.send('q6', { n: 1 }, { debounce: '30' })
    await delay(20)
    assert.equal(ws.sent.filter((m: any) => m.t === 'q6').length, before, 'rien avant 20ms : la chaîne doit armer le debounce, pas partir tout de suite')
    await delay(25)
    assert.equal(ws.sent.filter((m: any) => m.t === 'q6').length, before + 1, 'parti après le silence de 30ms')
    s.destroy()
  })

  it("coalesce: 0 → rien de synchrone (arme un timer au tour de boucle suivant), un seul envoi avec la DERNIÈRE charge après delay(5) (0 testait faux, même travers que l'ancien debounce: 0)", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8j')
    const before = ws.sent.filter((m: any) => m.t === 'q7').length
    s.send('q7', { n: 1 }, { coalesce: 0 })
    s.send('q7', { n: 2 }, { coalesce: 0 })
    assert.equal(ws.sent.filter((m: any) => m.t === 'q7').length, before, 'rien de synchrone : coalesce:0 arme un timer, ne part pas immédiatement')
    await delay(5)
    const q7s = ws.sent.filter((m: any) => m.t === 'q7')
    assert.equal(q7s.length, before + 1)
    assert.equal(q7s[q7s.length - 1].p.n, 2, 'la dernière charge, pas la 1re')
    s.destroy()
  })

  it("coalesce: '20' (chaîne numérique) → même regroupement qu'un nombre, un seul envoi avec le DERNIER payload (débit max 1/intervalle)", async () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x8k')
    const before = ws.sent.filter((m: any) => m.t === 'pos2').length
    s.send('pos2', { n: 1 }, { coalesce: '20' })
    s.send('pos2', { n: 2 }, { coalesce: '20' })                   // écrase la trame en attente
    assert.equal(ws.sent.filter((m: any) => m.t === 'pos2').length, before)   // rien émis tout de suite (trailing)
    await delay(35)
    const pos2s = ws.sent.filter((m: any) => m.t === 'pos2')
    assert.equal(pos2s.length, before + 1)                        // un SEUL envoi sur l'intervalle
    assert.equal(pos2s[pos2s.length - 1].p.n, 2)                  // le dernier payload gagne
    s.destroy()
  })

  it("debounce: 'abc' (invalide) → envoi immédiat (option ignorée), µ.warn appelé UNE seule fois même après 3 envois", async () => {
    const µ = makeMu()
    const warnings: any[] = []
    µ.warn = (msg: any) => warnings.push(msg)                     // espion local, remplace le no-op de makeMu
    const { s, ws } = open(µ, 'wss://x8l')
    const before = ws.sent.filter((m: any) => m.t === 'q8').length
    s.send('q8', { n: 1 }, { debounce: 'abc' })
    s.send('q8', { n: 2 }, { debounce: 'abc' })
    s.send('q8', { n: 3 }, { debounce: 'abc' })
    assert.equal(ws.sent.filter((m: any) => m.t === 'q8').length, before + 3, 'option ignorée : chaque envoi part immédiatement, comme sans debounce')
    assert.equal(warnings.length, 1, 'un seul avertissement même après 3 envois invalides')
    assert.ok(String(warnings[0]).includes('debounce'), "le message nomme l'option en cause")
    s.destroy()
  })

  it('singleton par URL', () => {
    const µ = makeMu()
    const a = µ.socket('wss://same'); const b = µ.socket('wss://same')
    assert.equal(a, b); a.destroy()
  })

  it('close() volontaire → closed, pas de reconnexion', async () => {
    const µ = makeMu()
    const { s } = open(µ, 'wss://x9', { reconnect: { backoff: [0], jitter: 0 } })
    const n = MockWS.instances.length; s.close()
    assert.equal(s.state, 'closed'); await delay(10)
    assert.equal(MockWS.instances.length, n)
    s.destroy()
  })
})

describe('µ.socket — stream (deltas + séquence + resync)', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('applique add/update/remove/reset', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://st1')
    const $$x = s.stream('ennemis')
    assert.ok(ws.sent.find((m: any) => m.t === 'µ:sub-stream'))
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'reset', values: { a: { hp: 10 } } } })
    assert.deepEqual($$x.a, { hp: 10 })
    ws._srv({ t: 'ennemis', seq: 2, p: { op: 'add', key: 'b', value: { hp: 5 } } })
    assert.deepEqual($$x.b, { hp: 5 })
    ws._srv({ t: 'ennemis', seq: 3, p: { op: 'update', key: 'a', patch: { hp: 8 } } })
    assert.deepEqual($$x.a, { hp: 8 })
    ws._srv({ t: 'ennemis', seq: 4, p: { op: 'remove', key: 'b' } })
    assert.ok(!('b' in $$x))
    s.destroy()
  })

  it('détecte un trou de séquence et demande un resync', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://st2')
    s.stream('pos')
    ws._srv({ t: 'pos', seq: 1, p: { op: 'add', key: 'a', value: {} } })
    ws.sent.length = 0
    // saut 2→5 : trou
    ws._srv({ t: 'pos', seq: 5, p: { op: 'add', key: 'b', value: {} } })
    const resync = ws.sent.find((m: any) => m.t === 'µ:resync')
    assert.ok(resync); assert.equal(resync.p.from, 1)
    s.destroy()
  })

  it('un delta de stream ne tombe PAS dans les handlers on()', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://st3')
    s.stream('flux'); const recu: any[] = []
    s.on('flux', (p: any) => recu.push(p))
    ws._srv({ t: 'flux', seq: 1, p: { op: 'add', key: 'a', value: {} } })
    assert.deepEqual(recu, [])
    s.destroy()
  })
})

describe('µ.socket — presence & rooms', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('presence : reset/join/leave maintiennent la liste', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pr1')
    const $$j = s.presence()
    assert.ok(ws.sent.find((m: any) => m.t === 'µ:sub-presence'))
    ws._srv({ t: 'µ:presence', p: { op: 'reset', peers: { a: { nom: 'Bob' } } } })
    assert.deepEqual($$j.a, { nom: 'Bob' })
    ws._srv({ t: 'µ:presence', p: { op: 'join', id: 'b', meta: { nom: 'Lia' } } })
    assert.deepEqual($$j.b, { nom: 'Lia' })
    ws._srv({ t: 'µ:presence', p: { op: 'leave', id: 'a' } })
    assert.ok(!('a' in $$j))
    s.destroy()
  })

  it('room : envoi/réception scopés au salon + join envoyé', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rm1')
    const zone = s.room('zone-A')
    assert.ok(ws.sent.find((m: any) => m.t === 'µ:join' && m.p.room === 'zone-A'))
    const recu: any[] = []
    zone.on('move', (p: any) => recu.push(p))
    zone.send('move', { x: 1 })
    assert.ok(ws.sent.find((m: any) => m.t === 'zone-A/move'))   // envoi préfixé
    ws._srv({ t: 'zone-A/move', p: { x: 9 } })                   // réception préfixée
    assert.deepEqual(recu, [{ x: 9 }])
    ws._srv({ t: 'move', p: { x: 0 } })                          // hors room → ignoré
    assert.deepEqual(recu, [{ x: 9 }])
    s.destroy()
  })

  it('sendTo : même trame que send(room+"/"+type,...), et AUCUN µ:join (contraste room().send qui joint)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rm1b')
    s.send('partie-42/coup', { case: 12 })
    const direct = ws.sent[ws.sent.length - 1]
    s.sendTo('partie-42', 'coup', { case: 12 })
    const viaSendTo = ws.sent[ws.sent.length - 1]
    assert.deepEqual(viaSendTo, direct)
    assert.ok(!ws.sent.find((m: any) => m.t === 'µ:join'))       // sendTo n'a jamais rejoint le salon
    s.destroy()
  })

  it('kick serveur : µ:left déclenche room.onLeft(reason)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rm2')
    const zone = s.room('zone-B'); let raison: any = null
    zone.onLeft((r: any) => { raison = r })
    ws._srv({ t: 'µ:left', p: { room: 'zone-B', reason: 'changement de zone' } })
    assert.equal(raison, 'changement de zone')
    s.destroy()
  })

  it('µ:bye → socket fermé, pas de reconnexion', async () => {
    const µ = makeMu()
    const { s, ws } = open(µ, 'wss://rm3', { reconnect: { backoff: [0], jitter: 0 } })
    const n = MockWS.instances.length
    ws._srv({ t: 'µ:bye', p: { reason: 'banni' } })
    assert.equal(s.state, 'closed'); await delay(10)
    assert.equal(MockWS.instances.length, n)
    s.destroy()
  })
})

describe("µ.socket — accueil (sock.on('welcome') / sock.resumed)", () => {
  beforeEach(() => { MockWS.instances = [] })

  it("on('welcome', …) reçoit la charge du µ:welcome, SANS le champ session", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://wc1')
    const recu: any[] = []
    s.on('welcome', (p: any) => recu.push(p))
    ws._srv({ t: 'µ:welcome', p: { serverTime: 123, session: { id: 'i', key: 'k' } } })
    assert.deepEqual(recu, [{ serverTime: 123 }])
    s.destroy()
  })

  it('resumed : false avant tout welcome, toujours false après un accueil neuf', () => {
    const µ = makeMu(); const s = µ.socket('wss://wc2'); s.connect()
    assert.equal(s.resumed, false); assert.equal(s._mjs_st.resumed, false)
    const ws = last(); ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: {} })
    assert.equal(s.resumed, false)
    s.destroy()
  })

  it('resumed : true après un µ:welcome portant resumed:true — _mjs_st.resumed reflète le contrat interne, comme les 4 autres champs réactifs', () => {
    const µ = makeMu(); const s = µ.socket('wss://wc4'); s.connect()
    const ws = last(); ws._mjs_open()
    ws._srv({ t: 'µ:welcome', p: { resumed: true } })
    assert.equal(s._mjs_st.resumed, true); assert.equal(s.resumed, true)
    s.destroy()
  })

  it("un handler 'welcome' qui throw ne casse pas la connexion : reste 'open', les messages suivants passent", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://wc3')
    s.on('welcome', () => { throw new Error('boom') })
    const recu: any[] = []
    s.on('move', (p: any) => recu.push(p))
    ws._srv({ t: 'µ:welcome', p: { serverTime: 1 } })
    assert.equal(s.state, 'open')
    ws._srv({ t: 'move', p: { x: 1 } })
    assert.deepEqual(recu, [{ x: 1 }])
    s.destroy()
  })
})
