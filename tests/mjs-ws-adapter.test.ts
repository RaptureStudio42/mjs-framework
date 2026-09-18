// Tests boucle complète de l'adaptateur multi-processus (adapter.ts) — MÊME technique
// que tests/mjs-ws-core.test.ts : VRAI client µ.socket (`new Function('µ', src)`), mais CETTE
// fois deux apps MJS-WS SÉPARÉES (transport MemoryTransport chacune — deux « process » simulés
// dans le MÊME processus mocha) partageant un MemoryAdapter sur le MÊME bus (createMemoryAdapterBus)
// — exactement le rôle que jouerait Redis entre deux VRAIS process. cf. tests/mjs-ws-adapter-redis.test.ts
// pour le protocole RESP en isolation (sans Redis vivant) et docs/23-mjs-ws.md pour le guide.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { MemoryAdapter, createMemoryAdapterBus } from '../src/mjs-ws/adapter.js'
import type { MemoryAdapterBus, MjsWsAdapter } from '../src/mjs-ws/adapter.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

// --- adaptateur factice EXPOSANT ignoresOrigin/reconnexions (tests 9-10) — implémente
// MjsWsAdapter au minimum + 2 getters NUMÉRIQUES EN PLUS, jamais déclarés dans l'interface elle-même :
// c'est tout le sens du duck typing sobre câblé dans core.ts (app.stats()), pas un besoin d'étendre
// le contrat MjsWsAdapter pour le prouver.
class FakeAdapterWithLocalCounters implements MjsWsAdapter {
  readonly processId = 'fake-proc-1'
  readonly prefix    = 'mjs-ws'
  ignoresOrigin = 3
  reconnexions  = 2
  async start(): Promise<void> {}
  async stop(): Promise<void> {}
  publish(): void {}
  subscribe(): void {}
  async incr(): Promise<number> { return 1 }
  async setLease(): Promise<void> {}
  async removeLease(): Promise<void> {}
  async listLeases(): Promise<string[]> { return [] }
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))
const SECRET = 'secret-cluster-test-1234567890'

// --- même technique que les autres tests MJS-WS — vrai client µ.socket sur MemoryTransport ---

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport, trace?: Array<{ url: string; msg: any }>): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    if (trace) {
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { trace.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    return ws
  }
  return makeMu()
}

// démarre une app avec MemoryTransport + un MemoryAdapter posé sur le bus PARTAGÉ fourni — le
// partage du bus EST la simulation « même Redis, process différents ». `now` = horloge injectée
// dans l'adaptateur (simuler un bail expiré sans vrai délai, cf. test 8).
async function startApp(
  bus: MemoryAdapterBus, opts: MjsWsOptions = {}, now?: () => number,
): Promise<{ transport: MemoryTransport; app: MjsWsApp; adapter: MemoryAdapter }> {
  const transport = new MemoryTransport()
  const adapter   = new MemoryAdapter({ bus, now })
  const app       = mjsWs({ transport, heartbeat: 0, adapter, ...opts })
  await app.listen()
  return { transport, app, adapter }
}

// --- requêtes signées vers le pont (test 3, /send par user) — mêmes helpers que mjs-ws-bridge.test.ts ---

// chaîne DIRIGÉE + INJECTIVE — direction 'in' (commande admin entrante /send),
// cf. tests/mjs-ws-bridge.test.ts pour la couverture directe de la séparation de domaine.
function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  const canonical = fields.map(f => f.length +':'+ f).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

async function postSigned(port: number, path: string, body: any): Promise<{ status: number; json: any }> {
  const bodyStr = JSON.stringify(body)
  const ts  = Math.floor(Date.now() / 1000)
  const sig = sign(SECRET, 'POST', path, bodyStr, ts)
  const res  = await fetch('http://127.0.0.1:'+ port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
    body: bodyStr,
  })
  const text = await res.text()
  return { status: res.status, json: JSON.parse(text) }
}

// démarre une app AVEC le pont universel — lit le port RÉEL (éphémère) depuis onLog, même
// technique que mjs-ws-bridge.test.ts (le pont n'expose sciemment aucune API publique pour ça)
async function startAppWithBridge(bus: MemoryAdapterBus, opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; bridgePort: number }> {
  const transport = new MemoryTransport()
  const adapter   = new MemoryAdapter({ bus })
  let bridgePort  = 0
  const app = mjsWs({
    transport, heartbeat: 0, adapter, bridge: { port: 0, secret: SECRET }, ...opts,
    onLog: (level, message, meta) => { if (meta && typeof (meta as any).port === 'number' && /pont universel en écoute/.test(message)) bridgePort = (meta as any).port },
  })
  await app.listen()
  return { transport, app, bridgePort }
}

describe('MJS-WS — adaptateur multi-processus (MemoryAdapter, boucle complète)', () => {
  it('1. broadcast : posté sur A, reçu par les clients de A ET de B (une seule fois chacun)', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)
    const µA = makeClient(tA); const sA = µA.socket('memory://b-a'); sA.connect(); await tick()
    const µB = makeClient(tB); const sB = µB.socket('memory://b-b'); sB.connect(); await tick()
    const recuA: any[] = []; const recuB: any[] = []
    sA.on('annonce', (p: any) => recuA.push(p))
    sB.on('annonce', (p: any) => recuB.push(p))

    appA.broadcast('annonce', { texte: 'maintenance' })
    await tick()

    assert.deepEqual(recuA, [{ texte: 'maintenance' }])   // local — inchangé
    assert.deepEqual(recuB, [{ texte: 'maintenance' }])   // traversé jusqu'à l'AUTRE processus
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('2. room.send : traverse vers les membres de B, jamais vers un non-membre de B', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: _tA, app: appA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)
    const µB1 = makeClient(tB); const sB1 = µB1.socket('memory://rb1'); sB1.connect(); sB1.room('zone'); await tick()
    const µB2 = makeClient(tB); const sB2 = µB2.socket('memory://rb2'); sB2.connect(); await tick()   // PAS membre
    const recu1: any[] = []; const recu2: any[] = []
    sB1.room('zone').on('tick', (p: any) => recu1.push(p))
    sB2.on('zone/tick', (p: any) => recu2.push(p))
    assert.equal(appB.room('zone').size, 1)

    appA.room('zone').send('zone/tick', { n: 1 })   // A n'a AUCUN membre local de 'zone'
    await tick()

    assert.deepEqual(recu1, [{ n: 1 }])
    assert.deepEqual(recu2, [])
    sB1.destroy(); sB2.destroy(); await appA.stop(); await appB.stop()
  })

  it("3. pont /send par 'user' : POSTÉ sur A, atteint les connexions de l'utilisateur sur B", async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA, bridgePort: portA } = await startAppWithBridge(bus, { auth: (h: any) => ({ id: h.auth.uid }) })
    const { transport: tB, app: appB } = await startApp(bus, { auth: (h: any) => ({ id: h.auth.uid }) })
    const µA = makeClient(tA); const sA = µA.socket('memory://sa', { auth: () => ({ uid: 'autre' }) }); sA.connect(); await tick()
    const µB = makeClient(tB); const sB = µB.socket('memory://sb', { auth: () => ({ uid: '42' }) }); sB.connect(); await tick()
    const recuA: any[] = []; const recuB: any[] = []
    sA.on('notif', (p: any) => recuA.push(p))
    sB.on('notif', (p: any) => recuB.push(p))

    const res = await postSigned(portA, '/send', { user: '42', type: 'notif', p: { texte: 'colis expédié' } })
    assert.deepEqual(res.json, { ok: true, sent: 0 })   // AUCUNE connexion locale à A pour user '42' — sent compte A SEULEMENT
    await tick()

    assert.deepEqual(recuB, [{ texte: 'colis expédié' }])   // reçu quand même — via la propagation cluster
    assert.deepEqual(recuA, [])   // 'autre' n'est pas visé
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it("4. room.kick posé sur A atteint un membre connecté à B ; connexion de B TOUJOURS ouverte", async () => {
    const bus = createMemoryAdapterBus()
    const { transport: _tA, app: appA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)
    appA.serve('ping', () => 'pong')   // jamais atteint ici — juste pour prouver que B répond encore après le kick
    appB.serve('ping', () => 'pong')
    const µB = makeClient(tB); const sB = µB.socket('memory://k1')
    sB.connect()
    const zone = sB.room('zone')
    let leftReason: any = null
    zone.onLeft((reason: any) => { leftReason = reason })
    await tick()
    assert.equal(appB.room('zone').size, 1)
    const cible = Array.from(appB.room('zone').clients)[0]

    appA.room('zone').kick(cible.id, 'triche')   // A ne connaît l'id QUE par une source externe (ex. le pont) — jamais l'objet
    await tick()

    assert.equal(leftReason, 'triche')
    assert.equal(appB.room('zone').size, 0)
    assert.equal(sB.state, 'open')                        // kick de SALON ≠ déconnexion
    assert.equal(await sB.request('ping', {}), 'pong')     // connexion toujours utilisable
    sB.destroy(); await appA.stop(); await appB.stop()
  })

  it("5. flux multi-processus : seq GLOBAUX stricts, mêmes deltas même ordre aux 2 abonnés, µ:resync couvre les deltas venus de l'AUTRE processus", async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)
    const mondeA = appA.stream('monde')
    const mondeB = appB.stream('monde')

    const traceA: Array<{ url: string; msg: any }> = []
    const µA = makeClient(tA, traceA)
    const sA = µA.socket('memory://ma', { reconnect: { backoff: [0], jitter: 0 } })
    sA.connect()
    const $$mA = sA.stream('monde')
    await tick()

    const µB = makeClient(tB)
    const sB = µB.socket('memory://mb')
    sB.connect()
    const $$mB = sB.stream('monde')
    await tick()

    mondeA.add('a', { v: 1 }); await tick()       // seq 1 — produit par A
    mondeB.add('b', { v: 2 }); await tick()       // seq 2 — produit par B
    mondeA.update('a', { v: 10 }); await tick()   // seq 3 — produit par A

    assert.deepEqual({ ...$$mA }, { a: { v: 10 }, b: { v: 2 } })
    assert.deepEqual({ ...$$mA }, { ...$$mB })          // les DEUX abonnés convergent au même état
    assert.deepEqual({ ...$$mA }, mondeA.snapshot())
    assert.deepEqual({ ...$$mB }, mondeB.snapshot())

    const seqsA = traceA.filter(f => f.msg.t === 'monde' && f.msg.p.op !== 'reset').map(f => f.msg.seq)
    assert.deepEqual(seqsA, [1, 2, 3])   // seq GLOBAL strict, sans trou ni doublon, MÊME ordre que la production

    // coupure de A puis un delta produit par B PENDANT son absence → le resync du retour doit le couvrir
    sA._mjs_ws.close(1006, 'coupure simulée')
    assert.equal(sA.state, 'reconnecting')
    mondeB.add('c', { v: 3 })   // seq 4 — produit par B, A absent
    await tick(30)
    assert.equal(sA.state, 'open')
    assert.deepEqual({ ...$$mA }, { a: { v: 10 }, b: { v: 2 }, c: { v: 3 } })   // rattrapé, delta DISTANT compris
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('6. réordonnancement : deux deltas distants reçus INVERSÉS → appliqués dans l\'ordre du seq', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA } = await startApp(bus)
    const injector = new MemoryAdapter({ bus })   // 3e « process » — publie directement, sans passer par un flux applicatif
    await injector.start()

    const trace: Array<{ url: string; msg: any }> = []
    appA.stream('ordre')   // déclaré côté A, jamais muté localement (seq=0)
    const µA = makeClient(tA, trace)
    const sA = µA.socket('memory://ord')
    sA.connect()
    const $$m = sA.stream('ordre')
    await tick()

    // publiés dans l'ordre 2 PUIS 1 — le tampon de réordonnancement doit les appliquer 1 PUIS 2
    injector.publish('mjs-ws:stream', { name: 'ordre', seq: 2, p: { op: 'add', key: 'b', value: { v: 2 } } })
    injector.publish('mjs-ws:stream', { name: 'ordre', seq: 1, p: { op: 'add', key: 'a', value: { v: 1 } } })
    await tick()

    assert.deepEqual({ ...$$m }, { a: { v: 1 }, b: { v: 2 } })
    const seqs = trace.filter(f => f.msg.t === 'ordre' && f.msg.p.op !== 'reset').map(f => f.msg.seq)
    assert.deepEqual(seqs, [1, 2], 'reçus dans l\'ordre du SEQ, pas l\'ordre d\'ARRIVÉE (2 puis 1)')
    sA.destroy(); await appA.stop()
  })

  it('7. origin : une publication ne se retourne JAMAIS contre son propre processus (pas de double-livraison locale)', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA } = await startApp(bus)
    const { transport: _tB, app: appB } = await startApp(bus)   // 2e process nécessaire, sinon rien ne "traverse" (cf. adapter.ts)
    const µA = makeClient(tA); const sA = µA.socket('memory://o1'); sA.connect(); await tick()
    const recu: any[] = []
    sA.on('x', (p: any) => recu.push(p))

    appA.broadcast('x', { n: 1 })
    await tick()

    assert.deepEqual(recu, [{ n: 1 }])   // UNE fois — pas deux (locale + écho pub/sub mal filtré)
    sA.destroy(); await appA.stop(); await appB.stop()
  })

  it('8. présence fusionnée : les pairs des DEUX processus sont visibles ; bail expiré → purge + leave émis aux abonnés locaux', async () => {
    let fakeNow = Date.now()
    const bus = createMemoryAdapterBus()
    const now = () => fakeNow
    const { transport: tA, app: appA } = await startApp(bus, { auth: (h: any) => ({ id: h.auth.uid }) }, now)
    const { transport: tB, app: appB } = await startApp(bus, { auth: (h: any) => ({ id: h.auth.uid }) }, now)

    const µA = makeClient(tA); const sA = µA.socket('memory://pa', { auth: () => ({ uid: 'ana' }) }); sA.connect()
    const $$pres = sA.presence()   // store réactif — vérifie aussi le DELTA leave, pas juste l'accesseur ponctuel
    await tick()
    const µB = makeClient(tB); const sB = µB.socket('memory://pb', { auth: () => ({ uid: 'bob' }) }); sB.connect(); await tick()

    // accesseur interne (GET /presence utilise la MÊME source, cf. bridge.ts ctx.presence) —
    // room absente = présence GLOBALE, room().send/kick s'y ajoutent, jamais retirent
    const idsOnA = ((appA as any)._presence() as Array<{ id: string; meta: unknown }>).map(p => p.id).sort()
    assert.deepEqual(idsOnA, ['ana', 'bob'], 'les pairs des DEUX processus, vus depuis A')
    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana', 'bob'], 'même chose côté store réactif client')

    // simule la mort de B (bail JAMAIS renouvelé) — avance l'horloge au-delà du TTL (10 s) puis
    // force la vérification sur A SANS attendre le cycle réel ~3 s (accroche de test, cf. core.ts)
    fakeNow += 15000
    await (appA as any)._cluster.checkLeasesNow()
    await tick()

    const idsOnANow = ((appA as any)._presence() as Array<{ id: string; meta: unknown }>).map(p => p.id)
    assert.deepEqual(idsOnANow, ['ana'], 'bob purgé — son bail est expiré')
    assert.deepEqual(Object.keys({ ...$$pres }), ['ana'], 'leave REÇU par le store réactif du client de A (pas juste la donnée interne)')

    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  // Une lacune connue est désormais comblée — adapter-redis.ts expose désormais
  // ignoresOrigin/reconnexions (getters LOCAUX), câblés dans app.stats() au moment du snapshot.
  it('9. adaptateur exposant ignoresOrigin/reconnexions (duck typing) → visibles dans app.stats()', async () => {
    const transport = new MemoryTransport()
    const app = mjsWs({ transport, heartbeat: 0, adapter: new FakeAdapterWithLocalCounters() })
    await app.listen()
    const snap = app.stats()
    assert.equal(snap.adaptateur.ignoresOrigin, 3)
    assert.equal(snap.adaptateur.reconnexions, 2)
    await app.stop()
  })

  it("10. adaptateur SANS ces getters (MemoryAdapter) → champs à 0, comme avant (aucune régression)", async () => {
    const bus = createMemoryAdapterBus()
    const { app } = await startApp(bus)
    const snap = app.stats()
    assert.equal(snap.adaptateur.ignoresOrigin, 0)
    assert.equal(snap.adaptateur.reconnexions, 0)
    await app.stop()
  })
})
