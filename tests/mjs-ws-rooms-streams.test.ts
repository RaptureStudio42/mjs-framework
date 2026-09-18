// Tests boucle complète des étapes 3-4 de MJS-WS (« les salons » rooms.ts +
// « les flux » streams.ts) contre le VRAI client µ.socket — même technique que
// tests/mjs-ws-core.test.ts (MemoryTransport + factory WebSocket globale), avec
// en plus un ESPION de trames entrantes posé dans la factory : il intercepte
// l'assignation de `onmessage` par le client et trace chaque JSON reçu, y
// compris À TRAVERS les reconnexions (chaque tentative crée un nouveau
// WebSocket, l'espion suit) — indispensable pour vérifier le JSON émis au
// millimètre (`room` ABSENT en présence globale, seq d'origine au rejeu,
// aucun reset parasite après un resync incrémental).
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

// factory WebSocket + espion : trace {url, msg} pour CHAQUE trame serveur→client,
// toutes connexions confondues (reconnexions comprises) — filtrer par url ensuite
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

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// client BRUT (sans µ.socket) : parle le protocole à la main et garde les trames
// en CHAÎNES — la seule façon de prouver qu'une clé est ABSENTE du JSON émis
async function rawClient(transport: MemoryTransport, url: string): Promise<{ ws: any; frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { ws, frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

describe('MJS-WS — salons & présence (boucle complète, vrai client µ.socket)', () => {
  it('1. join + room().send : reçu par les membres seulement, except respecté', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport); const sA = µA.socket('memory://r1a'); sA.connect(); sA.room('zone'); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://r1b'); sB.connect(); sB.room('zone'); await tick()
    const µC = makeClient(transport); const sC = µC.socket('memory://r1c'); sC.connect(); await tick()   // PAS membre
    const recuA: any[] = []; const recuB: any[] = []; const recuC: any[] = []
    sA.room('zone').on('tick', (p: any) => recuA.push(p))
    sB.room('zone').on('tick', (p: any) => recuB.push(p))
    sC.on('zone/tick', (p: any) => recuC.push(p))   // écoute le type mais n'est PAS membre → ne doit rien voir
    await tick()

    assert.equal(app.room('zone').size, 2)
    app.room('zone').send('zone/tick', { n: 1 })   // type verbatim — le préfixe salon est une convention CLIENT, le serveur n'ajoute rien
    await tick()
    assert.deepEqual(recuA, [{ n: 1 }])
    assert.deepEqual(recuB, [{ n: 1 }])
    assert.deepEqual(recuC, [])

    const membreA = Array.from(app.clients).find((c: any) => app.room('zone').has(c))!
    app.room('zone').send('zone/tick', { n: 2 }, { except: membreA })
    await tick()
    assert.equal(recuA.length + recuB.length, 3)   // un seul des deux a reçu le 2e (l'excepté non)
    sA.destroy(); sB.destroy(); sC.destroy(); await app.stop()
  })

  it('1b. app.sendTo(salon, type, p) = sucre pour room(salon).send(salon+"/"+type, p) : même diffusion aux membres', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport); const sA = µA.socket('memory://r1d'); sA.connect(); sA.room('partie-42'); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://r1e'); sB.connect(); await tick()   // PAS membre
    const recuA: any[] = []; const recuB: any[] = []
    sA.room('partie-42').on('coup', (p: any) => recuA.push(p))
    sB.on('partie-42/coup', (p: any) => recuB.push(p))
    await tick()

    app.sendTo('partie-42', 'coup', { case: 12 })
    await tick()
    assert.deepEqual(recuA, [{ case: 12 }])   // membre : reçoit
    assert.deepEqual(recuB, [])               // non-membre : rien, MÊME scoping que room().send()

    // équivalence explicite avec la forme manuelle documentée (docs/23-mjs-ws.md §4)
    app.room('partie-42').send('partie-42/coup', { case: 99 })
    await tick()
    assert.deepEqual(recuA, [{ case: 12 }, { case: 99 }])
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('2. garde join qui refuse (false et throw) → pas membre + µ:error côté client', async () => {
    const { transport, app } = await startApp({ rooms: { join: (room: string) => { if (room === 'boom') throw new Error('explosé'); return room !== 'privé' } } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://r2')
    s.connect(); await tick()
    s.room('privé'); await tick()
    assert.equal(app.room('privé').size, 0)
    assert.ok(s.lastError && /refusé/.test(s.lastError.message))
    s.room('boom'); await tick(1100)   // throttle µ:error (1 s) : le 2e refus attend sa fenêtre
    assert.equal(app.room('boom').size, 0)
    s.room('ouvert'); await tick()
    assert.equal(app.room('ouvert').size, 1)   // la garde n'a bloqué QUE les refusés
    s.destroy(); await app.stop()
  })

  // même famille de course que la reprise (finishResume) et l'auth (handleHello) :
  // une connexion qui tombe PENDANT la garde `rooms.join` async (onDisconnect a déjà tout purgé)
  // ne doit PLUS rejoindre le salon quand cette garde finit par répondre — sinon un membre
  // FANTÔME reste inscrit à vie (aucun futur onDisconnect ne le reverra, il n'a lieu qu'UNE
  // fois par connexion), gonflant `size`/présence de salon sans qu'aucune connexion réelle
  // ne soit derrière.
  it("2b. connexion qui tombe PENDANT la garde rooms.join async : aucun membre fantôme dans le salon", async () => {
    let releaseJoin: ((v: boolean) => void) | null = null
    const { transport, app } = await startApp({ rooms: { join: () => new Promise<boolean>(resolve => { releaseJoin = resolve }) } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://r2b', { reconnect: { enabled: false } })
    s.connect(); await tick()
    s.room('zone')   // µ:join envoyé, la garde async démarre
    await tick()
    assert.ok(releaseJoin, 'la garde join() doit être en attente')

    s._mjs_ws.close(1006, 'coupure pendant la garde join')
    await tick()

    releaseJoin!(true)   // la garde finit par accepter — la connexion, elle, est déjà partie
    await tick()

    assert.equal(app.room('zone').size, 0, 'aucun membre fantôme après une déconnexion pendant la garde')
    await app.stop()
  })

  it("3. kick → µ:left UNIQUE {room, reason}, onLeft client déclenché, plus membre serveur, connexion TOUJOURS ouverte", async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    app.serve('ping', () => 'pong')
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://r3')
    s.connect()
    const zone = s.room('zone')
    let leftReason: any = null
    zone.onLeft((reason: any) => { leftReason = reason })
    await tick()
    assert.equal(app.room('zone').size, 1)

    const cible = Array.from(app.clients)[0]
    app.room('zone').kick(cible, 'triche')
    await tick()
    assert.equal(leftReason, 'triche')
    assert.equal(app.room('zone').size, 0)
    assert.equal(app.room('zone').has(cible), false)
    assert.equal(s.state, 'open')                            // kick de SALON ≠ fermeture (µ:bye)
    assert.equal(await s.request('ping', {}), 'pong')        // la connexion sert encore
    const lefts = trace.filter(f => f.msg.t === 'µ:left')
    assert.equal(lefts.length, 1)                            // message UNIQUE
    assert.deepEqual(lefts[0].msg.p, { room: 'zone', reason: 'triche' })
    s.destroy(); await app.stop()
  })

  it("4. présence GLOBALE : reset avec peers, delta join à l'arrivée d'un 2e client, delta leave à sa déconnexion — et `room` ABSENT du JSON émis", async () => {
    const { transport, app } = await startApp()
    const brut = await rawClient(transport, 'memory://r4-brut')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: {} })   // présence globale : room ABSENT du JSON (undefined verbatim côté client)
    await tick()
    assert.equal(brut.frames.length, 1)
    const reset = JSON.parse(brut.frames[0])
    assert.equal(reset.t, 'µ:presence')
    assert.equal(reset.p.op, 'reset')
    assert.ok(!('room' in reset.p), 'présence globale : la clé room ne doit PAS exister dans le JSON émis')
    assert.equal(Object.keys(reset.p.peers).length, 1)   // le client brut lui-même (seul authentifié)

    brut.frames.length = 0
    const µ = makeClient(transport)
    const s = µ.socket('memory://r4-vrai')
    s.connect(); await tick()
    const joins = brut.frames.map(f => JSON.parse(f)).filter(m => m.t === 'µ:presence' && m.p.op === 'join')
    assert.equal(joins.length, 1)
    assert.ok(!('room' in joins[0].p), 'delta join global : room ABSENT du JSON')

    brut.frames.length = 0
    s.destroy()   // fermeture volontaire → déconnexion → disparition de la présence globale
    await tick()
    const leaves = brut.frames.map(f => JSON.parse(f)).filter(m => m.t === 'µ:presence' && m.p.op === 'leave')
    assert.equal(leaves.length, 1)
    assert.equal(leaves[0].p.id, joins[0].p.id)   // même peer qui apparaît puis disparaît
    assert.ok(!('room' in leaves[0].p), 'delta leave global : room ABSENT du JSON')
    await app.stop()
  })

  it('5. présence DE SALON : reset avec méta, delta join/leave — via le store réactif du vrai client', async () => {
    const { transport, app } = await startApp({
      auth:  (hello: any) => ({ id: hello.auth.uid, pseudo: hello.auth.pseudo }),
      rooms: { meta: (client: any) => ({ pseudo: client.identity.pseudo }) },
    })
    const µA = makeClient(transport); const sA = µA.socket('memory://r5a', { auth: () => ({ uid: 'u1', pseudo: 'Ana' }) })
    sA.connect(); sA.room('zone'); await tick()

    // B observe la présence du salon SANS le rejoindre (abonné-présence ≠ membre)
    const µB = makeClient(transport); const sB = µB.socket('memory://r5b', { auth: () => ({ uid: 'u2', pseudo: 'Bob' }) })
    sB.connect()
    const $$pres = sB.presence('zone')
    await tick()
    assert.deepEqual({ ...$$pres }, { u1: { pseudo: 'Ana' } })   // reset : membres du salon avec leur méta
    assert.equal(app.room('zone').size, 1)                       // B observateur, PAS membre

    const µC = makeClient(transport); const sC = µC.socket('memory://r5c', { auth: () => ({ uid: 'u3', pseudo: 'Carl' }) })
    sC.connect(); const salonC = sC.room('zone'); await tick()
    assert.deepEqual({ ...$$pres }, { u1: { pseudo: 'Ana' }, u3: { pseudo: 'Carl' } })   // delta join reçu par B

    salonC.leave(); await tick()
    assert.deepEqual({ ...$$pres }, { u1: { pseudo: 'Ana' } })   // delta leave reçu par B
    sA.destroy(); sB.destroy(); sC.destroy(); await app.stop()
  })

  it('6. AGRÉGATION multi-connexions : 2 connexions même identity.id = 1 peer, leave seulement à la fermeture de la DERNIÈRE, méta de la plus récente', async () => {
    const { transport, app } = await startApp({
      auth:  (hello: any) => ({ id: hello.auth.uid, pseudo: hello.auth.pseudo }),
      rooms: { meta: (client: any) => ({ pseudo: client.identity.pseudo }) },
    })
    const µO = makeClient(transport); const sO = µO.socket('memory://r6-obs', { auth: () => ({ uid: 'obs' }) })
    sO.connect()
    const $$global = sO.presence()
    await tick()
    assert.deepEqual(Object.keys({ ...$$global }), ['obs'])

    // 1re connexion de l'utilisateur 7 → delta join
    const µ1 = makeClient(transport); const s1 = µ1.socket('memory://r6-a', { auth: () => ({ uid: 7, pseudo: 'onglet-1' }) })
    s1.connect(); await tick()
    assert.deepEqual({ ...$$global }['7'], { pseudo: 'onglet-1' })

    // 2e connexion du MÊME utilisateur → toujours UN SEUL peer, pas de doublon
    const µ2 = makeClient(transport); const s2 = µ2.socket('memory://r6-b', { auth: () => ({ uid: 7, pseudo: 'onglet-2' }) })
    s2.connect(); s2.room('zone'); await tick()
    assert.equal(Object.keys({ ...$$global }).length, 2)   // obs + '7', jamais deux fois '7'

    // méta = connexion la plus récente : un nouvel abonné voit 'onglet-2'
    const µN = makeClient(transport); const sN = µN.socket('memory://r6-n', { auth: () => ({ uid: 'neuf' }) })
    sN.connect()
    const $$vu = sN.presence()
    await tick()
    assert.deepEqual({ ...$$vu }['7'], { pseudo: 'onglet-2' })

    // ferme la 1re connexion → l'utilisateur 7 reste présent (il lui reste un onglet)
    s1.destroy(); await tick()
    assert.ok(({ ...$$global })['7'], 'peer conservé tant qu\'une connexion de cet id reste ouverte')
    // ferme la DERNIÈRE → delta leave, peer disparu (des présences globale ET de salon)
    s2.destroy(); await tick()
    assert.equal(({ ...$$global })['7'], undefined)
    assert.equal(app.room('zone').size, 0)
    sO.destroy(); sN.destroy(); await app.stop()
  })
})

describe('MJS-WS — flux à journal borné + resync incrémental (boucle complète)', () => {
  it('7. sub → reset snapshot de l\'état courant, au seq courant', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const monde = app.stream('monde')
    monde.add('e1', { x: 1 })
    monde.add('e2', { x: 2 })
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f7')
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    assert.deepEqual({ ...$$m }, { e1: { x: 1 }, e2: { x: 2 } })
    const reset = trace.find(f => f.msg.t === 'monde')!
    assert.equal(reset.msg.seq, 2)             // reset émis AU seq courant (2 mutations)
    assert.equal(reset.msg.p.op, 'reset')
    assert.equal(monde.size, 2)
    s.destroy(); await app.stop()
  })

  it('8. add/update/remove → le store client suit exactement, seq strictement croissants par flux', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const monde = app.stream('monde')
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f8')
    s.connect()
    const $$m = s.stream('monde')
    await tick()

    monde.add('a', { x: 1, y: 2 })
    monde.update('a', { y: 9 })       // fusion 1 niveau : x conservé
    monde.add('b', { x: 5 })
    monde.remove('b')
    await tick()
    assert.deepEqual({ ...$$m }, { a: { x: 1, y: 9 } })
    assert.deepEqual({ ...$$m }, monde.snapshot())   // client == serveur
    const seqs = trace.filter(f => f.msg.t === 'monde' && f.msg.p.op !== 'reset').map(f => f.msg.seq)
    assert.deepEqual(seqs, [1, 2, 3, 4])             // strictement croissants, sans trou
    s.destroy(); await app.stop()
  })

  it('9. RESYNC INCRÉMENTAL : coupure, 3 mutations dans la fenêtre du journal, reconnexion réelle → rattrapage par REJEU aux seq d\'origine, AUCUN reset après le premier', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const monde = app.stream('monde')
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f9', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    monde.add('a', { v: 1 })   // seq 1 — reçu : lastSeq passe à 1 (déclenchera µ:resync, pas sub-stream)
    await tick()
    assert.deepEqual({ ...$$m }, { a: { v: 1 } })

    s._mjs_ws.close(1006, 'coupure simulée')   // coupure réseau — PAS un close() volontaire
    assert.equal(s.state, 'reconnecting')
    monde.add('b', { v: 2 })               // seq 2 ┐
    monde.update('a', { v: 10 })           // seq 3 ├ ratées pendant la coupure, toutes au journal
    monde.add('c', { v: 3 })               // seq 4 ┘
    await tick(30)                         // backoff [0] → reconnexion + salve µ:resync {from:1}
    assert.equal(s.state, 'open')

    assert.deepEqual({ ...$$m }, { a: { v: 10 }, b: { v: 2 }, c: { v: 3 } })
    assert.deepEqual({ ...$$m }, monde.snapshot())
    const frames = trace.filter(f => f.msg.t === 'monde')
    const resets = frames.filter(f => f.msg.p.op === 'reset')
    assert.equal(resets.length, 1, 'un SEUL reset (celui du tout premier abonnement) — le rattrapage est un rejeu, jamais une photo complète')
    const rattrapage = frames.slice(frames.findIndex(f => f.msg.seq === 2)).map(f => f.msg.seq)
    assert.deepEqual(rattrapage, [2, 3, 4], 'rejeu aux seq D\'ORIGINE du journal, dans l\'ordre')
    s.destroy(); await app.stop()
  })

  it('10. trou HORS fenêtre (journal: 2, 5 mutations pendant la coupure) → reset complet, état final juste', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const monde = app.stream('monde', { journal: 2 })
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f10', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    monde.add('a', { v: 1 })   // seq 1, reçu
    await tick()

    s._mjs_ws.close(1006, 'coupure simulée')
    for (let i = 2; i <= 6; i++) monde.add('k' + i, { v: i })   // seq 2..6 — le journal (taille 2) n'en garde que 5,6
    trace.length = 0
    await tick(30)
    assert.equal(s.state, 'open')

    assert.deepEqual({ ...$$m }, monde.snapshot())   // rattrapé quand même — par photo complète
    const frames = trace.filter(f => f.msg.t === 'monde')
    assert.equal(frames.length, 1)
    assert.equal(frames[0].msg.p.op, 'reset', 'trou plus large que le journal → reset complet, pas de rejeu partiel')
    assert.equal(frames[0].msg.seq, 6)
    s.destroy(); await app.stop()
  })

  it('11. reset() serveur = NOUVELLE ÉPOQUE : journal vidé, un resync post-reset → reset complet (jamais un rejeu qui traverse) ; en ligne, le client l\'accepte à n\'importe quel seq', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const monde = app.stream('monde')
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f11', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    monde.add('a', { v: 1 })   // seq 1, reçu
    await tick()

    // EN LIGNE : reset accepté par le client abonné, puis les deltas suivants s'enchaînent sans resync
    monde.reset({ z: { v: 0 } })   // seq 2, journal vidé
    monde.add('w', { v: 7 })       // seq 3
    await tick()
    assert.deepEqual({ ...$$m }, { z: { v: 0 }, w: { v: 7 } })
    assert.ok(!trace.some(f => f.msg.t === 'µ:resync'), 'trace = trames REÇUES par le client : aucune anomalie signalée')

    // COUPURE puis reset pendant l'absence : le rejeu ne doit JAMAIS traverser l'époque
    s._mjs_ws.close(1006, 'coupure simulée')
    monde.add('x', { v: 8 })           // seq 4 (encore l'ancienne époque, au journal)
    monde.reset({ neuf: { v: 1 } })    // seq 5 — ÉPOQUE NEUVE, journal vidé
    monde.add('y', { v: 2 })           // seq 6
    trace.length = 0
    await tick(30)
    assert.equal(s.state, 'open')
    assert.deepEqual({ ...$$m }, { neuf: { v: 1 }, y: { v: 2 } })
    assert.deepEqual({ ...$$m }, monde.snapshot())
    const frames = trace.filter(f => f.msg.t === 'monde')
    assert.equal(frames[0].msg.p.op, 'reset', 'resync depuis une époque révolue → photo complète d\'office')
    assert.ok(!frames.some(f => f.msg.seq != null && f.msg.seq <= 4 && f.msg.p.op !== 'reset'), 'aucun delta de l\'ancienne époque rejoué')
    s.destroy(); await app.stop()
  })

  it('12. flux jamais déclaré côté serveur → reset vide seq 0 + warn, sans abonnement fantôme', async () => {
    const warns: string[] = []
    const { transport, app } = await startApp({ onLog: (level: any, message: string) => { if (level === 'warn') warns.push(message) } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://f12')
    s.connect()
    const $$f = s.stream('fantome')
    await tick()
    assert.deepEqual({ ...$$f }, {})
    assert.ok(warns.some(w => w.includes('fantome')), 'warn onLog : abonnement à un flux non déclaré')

    // déclaré APRÈS coup : le sub d'avant n'a PAS créé d'abonnement fantôme
    const fantome = app.stream('fantome')
    fantome.add('a', { v: 1 })
    await tick()
    assert.deepEqual({ ...$$f }, {}, 'pas abonné rétroactivement — un flux répondu « inconnu » ne pousse rien')
    s.destroy(); await app.stop()
  })

  // `streams` (streams.ts) ne rétrécissait JAMAIS : un flux par PARTIE
  // (cas d'usage documenté, §5 doc 23) fuyait à vie, et onDisconnect (À CHAQUE déconnexion,
  // tous clients confondus) itérait un registre toujours plus gros. destroy() retire le flux
  // du registre — un futur abonné retombe sur le fallback "jamais déclaré" (reset vide + warn),
  // EXACTEMENT comme s'il n'avait jamais existé.
  it("13b. app.stream(nom).destroy() : disparaît du registre — un futur abonné retombe sur 'jamais déclaré'", async () => {
    const { transport, app } = await startApp()
    const s1 = app.stream('partie-1')
    s1.add('e1', { x: 1 })
    assert.equal(app.stats().flux.nombre, 1)

    s1.destroy()
    assert.equal(app.stats().flux.nombre, 0, 'le flux détruit ne compte plus dans le registre')

    const µ = makeClient(transport)
    const s = µ.socket('memory://destroy1')
    s.connect(); await tick()
    const $$stream = s.stream('partie-1')
    await tick()
    assert.deepEqual({ ...$$stream }, {}, 'fallback "jamais déclaré" — pas un vestige de l\'ancien état')

    s.destroy(); await app.stop()
  })

  it('13. deux flux indépendants : compteurs seq séparés, abonnés séparés', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app } = await startApp()
    const alpha = app.stream('alpha')
    const beta  = app.stream('beta')
    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://f13')
    s.connect()
    const $$a = s.stream('alpha')   // abonné à alpha SEULEMENT
    await tick()
    alpha.add('x', 1)   // alpha seq 1
    beta.add('y', 2)    // beta seq 1 — compteur À PART, et personne d'abonné
    alpha.add('z', 3)   // alpha seq 2
    await tick()
    assert.deepEqual({ ...$$a }, { x: 1, z: 3 })
    const alphaSeqs = trace.filter(f => f.msg.t === 'alpha' && f.msg.p.op !== 'reset').map(f => f.msg.seq)
    assert.deepEqual(alphaSeqs, [1, 2])
    assert.ok(!trace.some(f => f.msg.t === 'beta'), 'pas abonné à beta → aucune trame beta reçue')
    s.destroy(); await app.stop()
  })
})
