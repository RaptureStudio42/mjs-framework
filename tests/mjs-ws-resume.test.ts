// Tests boucle complète de MJS-WS (sessions.ts —
// reprise de session opt-in) contre le VRAI client µ.socket : coupures et
// reconnexions RÉELLES (même technique que tests/mjs-ws-rooms-streams.test.ts),
// avec un espion de trames ENTRANTES et SORTANTES routé PAR URL — indispensable
// ici : la factory WebSocket est globale, et un client qui se RECONNECTE après
// la création d'un autre serait sinon espionné par la trace du dernier posé.
// Ce fichier = le cœur (protocole, tampon, rejeu, reprise) ; les cas limites
// (débordement, multi-onglets, expiration, µ:bye, clé tournée, config) sont
// dans tests/mjs-ws-resume-edge.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

interface Spy { in?: Array<{ url: string; msg: any }>; out?: Array<{ url: string; msg: any }> }

// factory WebSocket UNIQUE routée par URL — chaque client (reconnexions comprises)
// retrouve SES espions, quel que soit l'ordre de création des autres clients
function wireWebSocket(transport: MemoryTransport, perUrl: Record<string, Spy> = {}): void {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    const spy = perUrl[url]
    if (spy && spy.in) {
      const bucket = spy.in
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { bucket.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    if (spy && spy.out) {
      const bucket   = spy.out
      const origSend = ws.send.bind(ws)
      ws.send = (data: string) => { bucket.push({ url, msg: JSON.parse(data) }); origSend(data) }
    }
    return ws
  }
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// client BRUT (sans µ.socket) : trames gardées en CHAÎNES — la seule façon de
// prouver qu'une clé est ABSENTE du JSON émis (octets identiques à avant)
async function rawClient(transport: MemoryTransport, url: string): Promise<{ ws: any; frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { ws, frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

describe('MJS-WS — reprise de session (boucle complète, vrai client µ.socket)', () => {
  it('1. resume OFF : µ:welcome ne porte NI session NI resumed — octets STRICTEMENT identiques à avant', async () => {
    const { transport, app } = await startApp()
    const brut = await rawClient(transport, 'memory://s1')
    assert.equal(brut.frames.length, 1)
    assert.equal(brut.frames[0], '{"t":"µ:welcome","p":{}}')   // la trame HISTORIQUE, à l'octet près
    await app.stop()
  })

  it('2. resume ON : welcome porte session {id, clé} + resumed:false ; le hello suivant du client la REJOUE ; reprise → même id, clé TOURNÉE', async () => {
    const { transport, app } = await startApp({ resume: true })
    const recu: any[] = []; const emis: any[] = []
    wireWebSocket(transport, { 'memory://s2': { in: recu, out: emis } })
    const µ = makeMu()
    const s = µ.socket('memory://s2', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    const w1 = recu.find(f => f.msg.t === 'µ:welcome')!.msg
    assert.equal(w1.p.resumed, false)
    assert.equal(typeof w1.p.session.id, 'string')
    assert.equal(typeof w1.p.session.key, 'string')
    assert.ok(w1.p.session.id.length >= 16 && w1.p.session.key.length >= 64, 'id et clé aléatoires crypto (hex)')

    s._mjs_ws.close(1006, 'coupure simulée')   // coupure réseau — PAS un close() volontaire
    await tick(30)                          // backoff [0] → reconnexion quasi immédiate
    assert.equal(s.state, 'open')
    const hellos = emis.filter(f => f.msg.t === 'µ:hello')
    assert.equal(hellos.length, 2)
    assert.ok(!('session' in hellos[0].msg.p), '1er hello : jamais de session (il n\'en a pas encore)')
    assert.deepEqual(hellos[1].msg.p.session, { id: w1.p.session.id, key: w1.p.session.key }, 're-hello : le client rejoue EXACTEMENT le {id, clé} reçu')
    const welcomes = recu.filter(f => f.msg.t === 'µ:welcome')
    assert.equal(welcomes.length, 2)
    assert.equal(welcomes[1].msg.p.resumed, true)
    assert.equal(welcomes[1].msg.p.session.id, w1.p.session.id, 'même session (même id)')
    assert.notEqual(welcomes[1].msg.p.session.key, w1.p.session.key, 'clé TOURNÉE à chaque welcome')
    s.destroy(); await app.stop()
  })

  it('3. coupure → app.send + room.send + broadcast pendant la grâce → rejeu ORDONNÉ après le welcome, resumed:true, salon/présence JAMAIS bougés (aucun delta aux autres)', async () => {
    const { transport, app } = await startApp({ resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recuA: any[] = []; const recuO: any[] = []
    wireWebSocket(transport, { 'memory://s3a': { in: recuA }, 'memory://s3o': { in: recuO } })
    // backoff [50] : une VRAIE fenêtre de grâce — avec [0], la reconnexion (macrotask posée
    // à la coupure) passerait AVANT le code du test, et les envois partiraient au client
    // déjà repris (en direct, sans jamais toucher le tampon)
    const µA = makeMu(); const sA = µA.socket('memory://s3a', { auth: () => ({ uid: 'a' }), reconnect: { backoff: [50], jitter: 0 } })
    sA.connect(); sA.room('zone'); await tick()
    const µO = makeMu(); const sO = µO.socket('memory://s3o', { auth: () => ({ uid: 'obs' }) })
    sO.connect(); sO.presence(); sO.presence('zone'); await tick()
    const clientA = Array.from(app.clients).find((c: any) => c.identity.id === 'a')!
    recuO.length = 0

    sA._mjs_ws.close(1006, 'coupure simulée')
    await tick()   // laisse le parcage se poser (microtask du transport) — la reconnexion, elle, attend 50 ms
    assert.equal(app.room('zone').size, 1, 'salon CONSERVÉ pendant la grâce — le parqué est toujours membre')
    assert.ok(Array.from(app.clients).includes(clientA), 'le parqué reste visible de app.clients (présence différée)')
    app.send(clientA, 'notif', { n: 1 })                      // ciblé — TAMPONNÉ (aucune connexion pendant 50 ms)
    app.room('zone').send('zone/info', { n: 2 })              // salon — tamponné
    app.broadcast('annonce', { n: 3 })                        // global — tamponné
    await tick(90)                                            // reconnexion réelle à ~50 ms
    assert.equal(sA.state, 'open')

    const types = recuA.map(f => f.msg.t)
    const iW = types.lastIndexOf('µ:welcome')
    assert.equal(recuA[iW].msg.p.resumed, true)
    const iN = types.indexOf('notif'); const iZ = types.indexOf('zone/info'); const iB = types.indexOf('annonce')
    assert.ok(iN > iW && iZ > iN && iB > iZ, `rejeu ORDONNÉ juste après le welcome (welcome@${iW} < notif@${iN} < zone/info@${iZ} < annonce@${iB})`)
    // l'observateur n'a JAMAIS vu 'a' partir ni revenir — ni en présence globale ni en présence de salon
    assert.ok(!recuO.some(f => f.msg.t === 'µ:presence'), 'aucun delta de présence émis aux autres pendant toute la coupure/reprise')
    assert.equal(app.room('zone').size, 1)
    sA.destroy(); sO.destroy(); await app.stop()
  })

  it('4. deltas de flux pendant la grâce : EXCLUS du tampon — jamais doublés au retour (le µ:resync les couvre)', async () => {
    const { transport, app } = await startApp({ resume: true, onLog: () => {} })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://s4': { in: recu } })
    const monde = app.stream('monde')
    const µ = makeMu(); const s = µ.socket('memory://s4', { reconnect: { backoff: [50], jitter: 0 } })
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    monde.add('a', { v: 1 })   // seq 1 — reçu en ligne (lastSeq passe à 1)
    await tick()

    s._mjs_ws.close(1006, 'coupure simulée')
    await tick()                        // parqué — la reconnexion attend 50 ms
    monde.add('b', { v: 2 })            // seq 2 ┐ pendant la grâce : au journal du flux,
    monde.update('a', { v: 10 })        // seq 3 ┘ JAMAIS au tampon de session (exclusion seq)
    await tick(90)
    assert.equal(s.state, 'open')

    assert.deepEqual({ ...$$m }, { a: { v: 10 }, b: { v: 2 } })
    assert.deepEqual({ ...$$m }, monde.snapshot())
    const seqs = recu.filter(f => f.msg.t === 'monde' && f.msg.seq != null).map(f => f.msg.seq)
    assert.equal(new Set(seqs).size, seqs.length, `aucun seq reçu en double (resync seul les couvre) — reçus : ${seqs.join(',')}`)
    s.destroy(); await app.stop()
  })

  it('5. µ:left pendant la grâce (kick de salon d\'un parqué) : INCLUS au tampon — délivré au retour, après le welcome', async () => {
    const { transport, app } = await startApp({ resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://s5': { in: recu } })
    const µ = makeMu(); const s = µ.socket('memory://s5', { auth: () => ({ uid: 'a' }), reconnect: { backoff: [50], jitter: 0 } })
    s.connect()
    let leftReason: any = null
    s.room('zone').onLeft((reason: any) => { leftReason = reason })
    await tick()
    assert.equal(app.room('zone').size, 1)

    s._mjs_ws.close(1006, 'coupure simulée')
    await tick()                            // parqué — la reconnexion attend 50 ms
    app.room('zone').kick('a', 'triche')   // kick d'un PARQUÉ — par id agrégé
    assert.equal(app.room('zone').size, 0, 'le kick opère immédiatement côté serveur, même sur un parqué')
    await tick(90)
    assert.equal(s.state, 'open')

    const types = recuTypes(recu)
    const iW = types.lastIndexOf('µ:welcome'); const iL = types.indexOf('µ:left')
    assert.ok(iL > iW, 'µ:left rejoué APRÈS le welcome de reprise')
    assert.equal(leftReason, 'triche', 'le callback onLeft du client a bien reçu le kick raté')
    s.destroy(); await app.stop()
  })

  it('6. clé falsifiée ou identité différente → accueil FRAIS silencieux (resumed:false, session neuve, pas de rejeu, pas de crash)', async () => {
    let calls = 0
    const { transport, app } = await startApp({ resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://s6': { in: recu } })
    const µ = makeMu(); const s = µ.socket('memory://s6', { auth: () => ({ uid: 'u1' }), reconnect: { backoff: [50], jitter: 0 } })
    s.connect(); await tick()
    const w1 = recu.find(f => f.msg.t === 'µ:welcome')!.msg

    // clé FALSIFIÉE (bonne longueur, contenu faux) — timingSafeEqual doit refuser sans lever
    const clientRef = Array.from(app.clients)[0]
    s._mjs_ws.close(1006, 'coupure simulée')
    await tick()                              // parqué — la reconnexion attend 50 ms
    app.send(clientRef, 'secret', { n: 2 })   // tamponné — ne doit JAMAIS être rejoué à l'imposteur
    s._mjs_session = { id: w1.p.session.id, key: 'f'.repeat(w1.p.session.key.length) }
    await tick(90)
    assert.equal(s.state, 'open', 'pas de crash — le handshake aboutit en accueil frais')
    const w2 = recu.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w2.p.resumed, false)
    assert.notEqual(w2.p.session.id, w1.p.session.id, 'session NEUVE — jamais l\'ancienne sans la bonne clé')
    assert.ok(!recu.some(f => f.msg.t === 'secret' && f.msg.p.n === 2), 'le tampon de l\'ancienne session n\'est JAMAIS rejoué')

    // identité DIFFÉRENTE (clé pourtant valide) — l'auth re-vérifiée doit prouver le MÊME utilisateur
    const { transport: t2, app: app2 } = await startApp({ resume: true, auth: () => ({ id: 'u' + (++calls) }), onLog: () => {} })
    const recu2: any[] = []
    wireWebSocket(t2, { 'memory://s6b': { in: recu2 } })
    const µ2 = makeMu(); const s2 = µ2.socket('memory://s6b', { reconnect: { backoff: [50], jitter: 0 } })
    s2.connect(); await tick()
    const w3 = recu2.find(f => f.msg.t === 'µ:welcome')!.msg   // identity u1
    s2._mjs_ws.close(1006, 'coupure simulée')
    await tick(90)                                             // re-auth → identity u2 ≠ u1, session rejouée VALIDE
    assert.equal(s2.state, 'open')
    const w4 = recu2.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w4.p.resumed, false, 'identité différente = accueil frais, malgré une clé juste')
    assert.notEqual(w4.p.session.id, w3.p.session.id)
    s.destroy(); s2.destroy(); await app.stop(); await app2.stop()
  })

  it('7. expiration de la grâce sans retour : leave de présence émis À CE MOMENT (pas avant), session morte, retour ensuite = frais', async () => {
    const { transport, app } = await startApp({ resume: { grace: 120 }, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recuA: any[] = []; const recuO: any[] = []
    wireWebSocket(transport, { 'memory://s7a': { in: recuA }, 'memory://s7o': { in: recuO } })
    const µA = makeMu(); const sA = µA.socket('memory://s7a', { auth: () => ({ uid: 'a' }), reconnect: { backoff: [300], jitter: 0 } })   // backoff > grâce : il reviendra APRÈS l'expiration
    sA.connect(); await tick()
    const wA = recuA.find(f => f.msg.t === 'µ:welcome')!.msg
    const µO = makeMu(); const sO = µO.socket('memory://s7o', { auth: () => ({ uid: 'obs' }) })
    sO.connect(); sO.presence(); await tick()
    recuO.length = 0

    sA._mjs_ws.close(1006, 'coupure simulée')
    await tick(60)    // mi-grâce : l'utilisateur est ENCORE là (présence différée)
    assert.ok(!recuO.some(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'leave'), 'aucun leave pendant la grâce')
    await tick(120)   // grâce (120 ms) expirée → purge historique différée
    const leaves = recuO.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'leave')
    assert.equal(leaves.length, 1, 'LE leave part à l\'expiration — exactement un')
    assert.equal(leaves[0].msg.p.id, 'a')

    await tick(180)   // backoff 300 ms écoulé → le client revient, session expirée en main
    assert.equal(sA.state, 'open')
    const w2 = recuA.filter(f => f.msg.t === 'µ:welcome')[1].msg
    assert.equal(w2.p.resumed, false, 'session expirée = accueil frais')
    assert.notEqual(w2.p.session.id, wA.p.session.id)
    sA.destroy(); sO.destroy(); await app.stop()
  })

  it("8. sock.resumed et sock.on('welcome', …) reflètent la reprise CÔTÉ CLIENT (pas seulement sur le fil) : true après une VRAIE reprise, false pour un accueil neuf", async () => {
    const { transport, app } = await startApp({ resume: true })
    wireWebSocket(transport)
    const µ = makeMu()
    const s = µ.socket('memory://s8', { reconnect: { backoff: [0], jitter: 0 } })
    const welcomes: any[] = []
    s.on('welcome', (p: any) => welcomes.push(p))
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    assert.equal(s.resumed, false, 'accueil neuf : resumed=false')
    assert.equal(welcomes.length, 1)
    assert.equal(welcomes[0].resumed, false)
    assert.ok(!('session' in welcomes[0]), 'la charge remontée à l\'appli ne porte jamais la carte de session')

    s._mjs_ws.close(1006, 'coupure simulée')   // coupure réseau — PAS un close() volontaire
    await tick(30)                          // backoff [0] → reconnexion quasi immédiate
    assert.equal(s.state, 'open')
    assert.equal(s.resumed, true, 'reprise réussie : resumed=true côté client aussi')
    assert.equal(welcomes.length, 2)
    assert.equal(welcomes[1].resumed, true)
    assert.ok(!('session' in welcomes[1]))
    s.destroy(); await app.stop()
  })
})

function recuTypes(recu: Array<{ url: string; msg: any }>): string[] {
  return recu.map(f => f.msg.t)
}
