// Tests boucle complète de l'option `sessionExclusive` (session exclusive par identité,
// src/mjs-ws/core.ts + src/mjs-ws/sessions.ts) — MÊME technique que tests/mjs-ws-resume.test.ts /
// tests/mjs-ws-adapter.test.ts : VRAI client µ.socket sur MemoryTransport pour le comportement
// observable (state/lastError/reconnexion), + un petit client BRUT maison (rawHello) quand il faut
// voir la trame µ:bye et le code de fermeture EXACTS (le vrai client les absorbe dans son propre
// contrat réactif). Un cas inter-processus (MemoryAdapter partagé, MÊME pattern que le test 4 de
// mjs-ws-adapter.test.ts) + un cas de session parquée révoquée (sessions.ts::dismissByIdentity).
// Cf. docs/23-mjs-ws.md §8.5 (guide) + docs/25-protocole-mjs-ws.md (code 4003, µ:bye 'replace').
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { MemoryAdapter, createMemoryAdapterBus } from '../src/mjs-ws/adapter.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { buildRunPlan } from '../src/cli/ws.js'
import type { EntryContract } from '../src/cli/ws.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

// branche globalThis.WebSocket sur CE transport — trace optionnelle des trames ENTRANTES (mêmes
// principes que makeClient(transport, trace) de tests/mjs-ws-adapter.test.ts)
function makeClient(transport: MemoryTransport, trace?: any[]): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    if (trace) {
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { trace.push(JSON.parse(ev.data)); fn(ev) }) },
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

// client BRUT (protocole à la main, PAS le vrai µ.socket) — utile ici pour observer la trame
// µ:bye et le code de fermeture EXACTS, sans passer par l'abstraction (state/lastError) du vrai
// client. MÊME idée que rawClient() de tests/mjs-ws-resume.test.ts, mais `helloP` paramétrable
// (auth/session) — celui-là est câblé pour un hello anonyme sans reprise.
async function rawHello(transport: MemoryTransport, url: string, helloP: Record<string, unknown> = {}): Promise<{ ws: any; frames: any[] }> {
  const ws = transport.connect({ url })
  const frames: any[] = []
  ws.onmessage = (ev: any) => frames.push(JSON.parse(ev.data))
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [], ...helloP } }))
  await tick()
  return { ws, frames }
}

describe('MJS-WS — session exclusive par identité (option sessionExclusive)', () => {
  it("1. 2e hello même identité → le 1er reçoit µ:bye {reason:'replace'} puis close 4003, le 2e est accueilli normalement", async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, auth: (hello: any) => ({ id: hello.auth.uid }) })
    const a = await rawHello(transport, 'memory://sx1a', { auth: { uid: 'u1' } })
    let closedCode: number | null = null
    a.ws.onclose = (ev: any) => { closedCode = ev.code }

    const µB = makeClient(transport)
    const sB = µB.socket('memory://sx1b', { auth: () => ({ uid: 'u1' }) })
    sB.connect(); await tick()

    assert.equal(sB.state, 'open', 'le 2e est accueilli normalement')
    const bye = a.frames.find((f: any) => f.t === 'µ:bye')
    assert.ok(bye, 'le 1er a bien reçu un µ:bye')
    assert.deepEqual(bye.p, { reason: 'replace' })
    assert.equal(closedCode, 4003, 'fermeture avec le code dédié 4003')

    sB.destroy(); await app.stop()
  })

  it('2. reprise de session (même identité, MÊME session) : sessionExclusive NE l\'éjecte PAS — un retour n\'est jamais un hello frais', async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })
    const recu: any[] = []
    const µ = makeClient(transport, recu)
    const s = µ.socket('memory://sx2', { auth: () => ({ uid: 'r1' }), reconnect: { backoff: [50], jitter: 0 } })
    s.connect(); await tick()
    const w1 = recu.find(f => f.t === 'µ:welcome')

    s._mjs_ws.close(1006, 'coupure simulée')
    await tick(90)   // reprise (backoff 50 ms)
    assert.equal(s.state, 'open')
    const w2 = recu.filter(f => f.t === 'µ:welcome')[1]
    assert.equal(w2.p.resumed, true, 'reprise réussie — jamais un accueil frais')
    assert.equal(w2.p.session.id, w1.p.session.id)
    assert.ok(!recu.some(f => f.t === 'µ:bye'), 'aucune éjection sur une reprise — sessionExclusive ne s\'applique qu\'au hello FRAIS')
    s.destroy(); await app.stop()
  })

  it('3. identités DIFFÉRENTES : sessionExclusive n\'éjecte personne', async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µA = makeClient(transport); const sA = µA.socket('memory://sx3a', { auth: () => ({ uid: 'a' }) }); sA.connect(); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://sx3b', { auth: () => ({ uid: 'b' }) }); sB.connect(); await tick()
    assert.equal(sA.state, 'open')
    assert.equal(sB.state, 'open')
    assert.equal(Array.from(app.clients).length, 2)
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('4. identité ANONYME (auth sans `id`) : sessionExclusive n\'éjecte JAMAIS', async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, auth: () => ({ pseudo: 'invite' }) })   // pas de `id` → identityIdOf = null
    const µA = makeClient(transport); const sA = µA.socket('memory://sx4a'); sA.connect(); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://sx4b'); sB.connect(); await tick()
    assert.equal(sA.state, 'open')
    assert.equal(sB.state, 'open')
    assert.equal(Array.from(app.clients).length, 2)
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('5. option OFF (défaut) : deux connexions de la MÊME identité cohabitent — AUCUNE régression', async () => {
    const { transport, app } = await startApp({ auth: (hello: any) => ({ id: hello.auth.uid }) })   // sessionExclusive ABSENT (défaut false)
    const µA = makeClient(transport); const sA = µA.socket('memory://sx5a', { auth: () => ({ uid: 'm1' }) }); sA.connect(); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://sx5b', { auth: () => ({ uid: 'm1' }) }); sB.connect(); await tick()
    assert.equal(sA.state, 'open', 'les deux onglets cohabitent — comportement historique inchangé')
    assert.equal(sB.state, 'open')
    assert.equal(Array.from(app.clients).length, 2)
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('6. session PARQUÉE de la même identité (grâce en cours) : révoquée par le hello frais du remplaçant — la reprise échoue ensuite', async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })

    const a = await rawHello(transport, 'memory://sx6a', { auth: { uid: 'p1' } })
    const w1 = a.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w1 && w1.p.session)

    a.ws.close(1006, 'coupure simulée')   // A tombe SANS dire au revoir — éligible au parcage
    await tick()
    assert.equal(app.stats().connexions.parquees, 1, 'A est parqué (grâce en cours)')

    const b = await rawHello(transport, 'memory://sx6b', { auth: { uid: 'p1' } })   // hello FRAIS, MÊME identité
    const w2 = b.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w2, 'B est accueilli normalement')
    assert.equal(app.stats().connexions.parquees, 0, 'la session parquée de A a été révoquée (purgée, pas juste ignorée)')

    // rejeu de l'ANCIENNE session de A (identité 'p1' aussi — déclenche À SON TOUR une éviction de
    // B, effet de bord ATTENDU du même mécanisme : seule l'issue de CE rejeu nous intéresse ici)
    const c = await rawHello(transport, 'memory://sx6c', { auth: { uid: 'p1' }, session: { id: w1.p.session.id, key: w1.p.session.key } })
    const w3 = c.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w3)
    assert.equal(w3.p.resumed, false, 'la session révoquée de A ne peut plus jamais être reprise — accueil frais')
    assert.notEqual(w3.p.session.id, w1.p.session.id)

    await app.stop()
  })

  // NOTE — µ:left (protocole, cf. rooms.ts) ne s'applique JAMAIS ici : réservé au kick de salon
  // EXPLICITE (room().kick(), connexion gardée OUVERTE) ; l'éjection sessionExclusive passe par le
  // départ DÉFINITIF (dismissClient → finalizeCleanup → roomsEngine.onDisconnect), qui ne l'émet
  // jamais (cf. son commentaire « départ partagé leave()/kick()/disconnect() »). Ce qu'on VÉRIFIE
  // donc ici : les deltas de présence — et l'agrégation MULTI-ONGLETS (rooms.ts::addPeer/removePeer,
  // clé = IDENTITÉ) joue à PLEIN : B (même identité 'e1') rejoint l'agrégat GLOBAL de façon
  // SYNCHRONE (roomsEngine.onWelcome, dans le MÊME hello qui déclenche l'éviction) AVANT que le
  // retrait ASYNCHRONE de A (fermeture réelle de sa connexion, cf. dismissClient) ne soit traité —
  // la présence GLOBALE ne voit donc JAMAIS l'identité 'e1' disparaître (un membre restant : B).
  // Le salon 'zone', lui, N'A JAMAIS vu B (B ne l'a pas rejoint) : son agrégat tombe bien à zéro au
  // départ de A — un VRAI leave de salon, contrairement au global.
  it("7. nettoyage complet à l'éjection : présence de SALON émet un leave (B n'était pas membre) ; présence GLOBALE n'en émet PAS (même identité, agrégation multi-onglets) ; le salon est bien quitté", async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, auth: (hello: any) => ({ id: hello.auth.uid }) })
    const recuO: any[] = []
    const µO = makeClient(transport, recuO)
    const sO = µO.socket('memory://sx7o', { auth: () => ({ uid: 'obs' }) })
    sO.connect(); sO.presence(); sO.presence('zone'); await tick()

    const µA = makeClient(transport)
    const sA = µA.socket('memory://sx7a', { auth: () => ({ uid: 'e1' }) })
    sA.connect(); sA.room('zone'); await tick()
    assert.equal(app.room('zone').size, 1)
    recuO.length = 0

    const µB = makeClient(transport)
    const sB = µB.socket('memory://sx7b', { auth: () => ({ uid: 'e1' }) })   // MÊME identité — ne rejoint PAS 'zone'
    sB.connect(); await tick()

    assert.equal(sA.state, 'closed')
    const leavesGlobal = recuO.filter(f => f.t === 'µ:presence' && f.p.op === 'leave' && f.p.room === undefined)
    const leavesZone   = recuO.filter(f => f.t === 'µ:presence' && f.p.op === 'leave' && f.p.room === 'zone')
    assert.equal(leavesGlobal.length, 0, "AUCUN leave GLOBAL — B (même identité) a déjà rejoint l'agrégat avant le retrait de A")
    assert.equal(leavesZone.length, 1, "leave de SALON émis — B n'a jamais rejoint 'zone', contrairement à A")
    assert.equal(app.room('zone').size, 0, 'le salon est bien quitté')

    sA.destroy(); sB.destroy(); sO.destroy(); await app.stop()
  })

  it('8. inter-processus (adaptateur partagé) : un hello frais sur le process A évince la connexion de la MÊME identité connectée au process B', async () => {
    const bus = createMemoryAdapterBus()
    const commonOpts: MjsWsOptions = { sessionExclusive: true, auth: (hello: any) => ({ id: hello.auth.uid }) }
    const transportA = new MemoryTransport(); const adapterA = new MemoryAdapter({ bus })
    const appA = mjsWs({ transport: transportA, heartbeat: 0, adapter: adapterA, ...commonOpts }); await appA.listen()
    const transportB = new MemoryTransport(); const adapterB = new MemoryAdapter({ bus })
    const appB = mjsWs({ transport: transportB, heartbeat: 0, adapter: adapterB, ...commonOpts }); await appB.listen()

    const traceB: any[] = []
    const µB = makeClient(transportB, traceB)
    const sB = µB.socket('memory://cx8b', { auth: () => ({ uid: 'z1' }) })
    sB.connect(); await tick()
    assert.equal(sB.state, 'open')

    const µA = makeClient(transportA)
    const sA = µA.socket('memory://cx8a', { auth: () => ({ uid: 'z1' }) })   // MÊME identité, AUTRE process
    sA.connect(); await tick()

    assert.equal(sA.state, 'open', 'le nouvel arrivant (process A) est accueilli')
    assert.equal(sB.state, 'closed', 'la connexion sur B (même identité) a été éjectée via le cluster')
    const bye = traceB.find(f => f.t === 'µ:bye')
    assert.ok(bye, 'µ:bye reçu côté B')
    assert.deepEqual(bye.p, { reason: 'replace' })

    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('9. client (vrai µ.socket) : éjecté par sessionExclusive → closed, AUCUNE reconnexion même avec reconnect activé', async () => {
    const { transport, app } = await startApp({ sessionExclusive: true, auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://sx9a', { auth: () => ({ uid: 'w1' }), reconnect: { backoff: [0], jitter: 0 } })
    sA.connect(); await tick()
    assert.equal(sA.state, 'open')
    const before = (transport as any)._clients.length

    const µB = makeClient(transport)
    const sB = µB.socket('memory://sx9b', { auth: () => ({ uid: 'w1' }) })
    sB.connect(); await tick()

    assert.equal(sA.state, 'closed')
    await tick(20)
    assert.equal(sA.state, 'closed', 'toujours fermé')
    assert.equal((transport as any)._clients.length, before + 1, 'seul B a ouvert une connexion — A n\'a PAS reconnecté')

    sA.destroy(); sB.destroy(); await app.stop()
  })

  it("10. client : code de fermeture 4003 SANS µ:bye préalable (trame perdue) → TERMINAL quand même, aucune reconnexion", async () => {
    const { transport, app } = await startApp({ auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://sx10', { auth: () => ({ uid: 'z' }), reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')

    s._mjs_ws.close(4003, 'replace')   // simule la trame µ:bye PERDUE — seul le close 4003 arrive
    assert.equal(s.state, 'closed', 'terminal même sans le µ:bye')
    assert.deepEqual(s.lastError, { code: 'replaced' })

    await tick(20)
    assert.equal(s.state, 'closed', 'aucune reconnexion déclenchée')
    s.destroy(); await app.stop()
  })

  // --- mode 'refuse' (sessionExclusive — 2 modes) — l'EXISTANT gagne, à l'inverse de
  // 'replace' testé ci-dessus (tests 1-10, INCHANGÉS) ---------------------------------------

  it("11. mode 'refuse' : 2e hello même identité (session VIVANTE) → REFUSÉ (µ:denied + close 4004), la 1re connexion reste INTACTE", async () => {
    const { transport, app } = await startApp({ sessionExclusive: 'refuse', auth: (hello: any) => ({ id: hello.auth.uid }) })
    app.serve('ping', () => ({ pong: true }))
    const µA = makeClient(transport)
    const sA = µA.socket('memory://sx11a', { auth: () => ({ uid: 'u1' }) })
    sA.connect(); await tick()
    assert.equal(sA.state, 'open')

    // hello brut À LA MAIN (pas rawHello()) — onclose posé AVANT l'envoi : CE hello est celui
    // refusé, contrairement à rawHello(a, ...) plus haut où le refus arrive TOUJOURS après coup
    const bws: any = transport.connect({ url: 'memory://sx11b' })
    const bFrames: any[] = []
    bws.onmessage = (ev: any) => bFrames.push(JSON.parse(ev.data))
    let bClosedCode: number | null = null
    bws.onclose = (ev: any) => { bClosedCode = ev.code }
    await tick()
    bws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [], auth: { uid: 'u1' } } }))
    await tick()

    const denied = bFrames.find((f: any) => f.t === 'µ:denied')
    assert.ok(denied, 'B a reçu un µ:denied')
    assert.equal(denied.p.message, 'session déjà active pour cette identité')
    assert.equal(bClosedCode, 4004, 'fermeture avec le code dédié 4004')

    assert.equal(sA.state, 'open', "A n'a jamais été touchée")
    const res = await sA.request('ping', {})
    assert.deepEqual(res, { pong: true }, 'A échange toujours normalement — pas juste "encore ouverte"')

    sA.destroy(); await app.stop()
  })

  it("12. client : code de fermeture 4004 SANS µ:denied préalable (trame perdue) → TERMINAL quand même, aucune reconnexion (miroir du test 10)", async () => {
    const { transport, app } = await startApp({ auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://sx12', { auth: () => ({ uid: 'z' }), reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')

    s._mjs_ws.close(4004, 'denied')   // simule la trame µ:denied PERDUE — seul le close 4004 arrive
    assert.equal(s.state, 'closed', 'terminal même sans le µ:denied')
    assert.deepEqual(s.lastError, { code: 'refused' })

    await tick(20)
    assert.equal(s.state, 'closed', 'aucune reconnexion déclenchée')
    s.destroy(); await app.stop()
  })

  it("13. mode 'replace' explicite (chaîne) ≡ true : 2e hello même identité → le 1er reçoit µ:bye {reason:'replace'} puis close 4003, le 2e est accueilli normalement", async () => {
    const { transport, app } = await startApp({ sessionExclusive: 'replace', auth: (hello: any) => ({ id: hello.auth.uid }) })
    const a = await rawHello(transport, 'memory://sx13a', { auth: { uid: 'u1' } })
    let closedCode: number | null = null
    a.ws.onclose = (ev: any) => { closedCode = ev.code }

    const µB = makeClient(transport)
    const sB = µB.socket('memory://sx13b', { auth: () => ({ uid: 'u1' }) })
    sB.connect(); await tick()

    assert.equal(sB.state, 'open', 'le 2e est accueilli normalement')
    const bye = a.frames.find((f: any) => f.t === 'µ:bye')
    assert.ok(bye, 'le 1er a bien reçu un µ:bye')
    assert.deepEqual(bye.p, { reason: 'replace' })
    assert.equal(closedCode, 4003, "fermeture avec le code dédié 4003 — même comportement que sessionExclusive: true")

    sB.destroy(); await app.stop()
  })

  it("14. mode 'refuse' avec UNIQUEMENT une session PARQUÉE : le hello frais du remplaçant est ACCUEILLI (rien de vivant à refuser), la parquée est purgée ; un rejeu ultérieur de l'ancienne identité (retombé en hello frais, session révoquée) est À SON TOUR refusé — B, vivant, n'est jamais évincé", async () => {
    const { transport, app } = await startApp({ sessionExclusive: 'refuse', resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} })

    const a = await rawHello(transport, 'memory://sx14a', { auth: { uid: 'p1' } })
    const w1 = a.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w1 && w1.p.session)

    a.ws.close(1006, 'coupure simulée')   // A tombe SANS dire au revoir — éligible au parcage
    await tick()
    assert.equal(app.stats().connexions.parquees, 1, 'A est parqué (grâce en cours)')

    const b = await rawHello(transport, 'memory://sx14b', { auth: { uid: 'p1' } })   // hello FRAIS, MÊME identité
    const w2 = b.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w2, 'B est accueilli — aucune session VIVANTE à refuser, seulement une parquée')
    assert.ok(!b.frames.some((f: any) => f.t === 'µ:denied'), 'B ne reçoit jamais de µ:denied ici')
    assert.equal(app.stats().connexions.parquees, 0, 'la session parquée de A a été purgée (même mécanisme que le mode replace)')

    // rejeu de l'ANCIENNE session de A (identité 'p1' aussi, session révoquée → reprise impossible,
    // retombe en hello FRAIS pour la MÊME identité) — sous 'refuse', B (vivant) n'est JAMAIS évincé
    // par ce rejeu : le rejeu est lui-même REFUSÉ, à l'inverse du mode 'replace' (cf. test 6,
    // où ce même rejeu évince B)
    const c = await rawHello(transport, 'memory://sx14c', { auth: { uid: 'p1' }, session: { id: w1.p.session.id, key: w1.p.session.key } })
    const denied = c.frames.find((f: any) => f.t === 'µ:denied')
    assert.ok(denied, "le rejeu de l'ancienne session de A, retombé en hello frais, est refusé — B (vivant) n'est jamais évincé")
    assert.equal(denied.p.message, 'session déjà active pour cette identité')
    assert.equal(app.stats().connexions.actives, 1, 'B toujours seul actif — aucune éviction')

    await app.stop()
  })

  it("15. mode 'refuse' : identités DIFFÉRENTES non affectées — 2 connexions vivantes cohabitent", async () => {
    const { transport, app } = await startApp({ sessionExclusive: 'refuse', auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µA = makeClient(transport); const sA = µA.socket('memory://sx15a', { auth: () => ({ uid: 'a' }) }); sA.connect(); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://sx15b', { auth: () => ({ uid: 'b' }) }); sB.connect(); await tick()
    assert.equal(sA.state, 'open')
    assert.equal(sB.state, 'open')
    assert.equal(Array.from(app.clients).length, 2)
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it("16. valeur invalide (résolution programmatique) : 'evince' → erreur claire listant les valeurs valides", () => {
    const transport = new MemoryTransport()
    assert.throws(
      () => mjsWs({ transport, sessionExclusive: 'evince' as any }),
      /sessionExclusive invalide : "evince" — valeurs valides : true, false, 'replace', 'refuse'/,
    )
  })

  // --- correctif fuite cluster (mode 'refuse') — le kick distant (canal identity:kick) ne doit
  // JAMAIS évincer une connexion VIVANTE sur un AUTRE process, seulement des sessions parquées
  // (calqués sur le test 8 ci-dessus, MÊME technique bus mémoire partagé) -------------------------

  it("17. cluster + mode 'refuse' : session VIVANTE sur le process B, hello frais MÊME identité sur A → A est accueilli (limite par-processus), B reste INTACT (AUCUN µ:bye)", async () => {
    const bus = createMemoryAdapterBus()
    const commonOpts: MjsWsOptions = { sessionExclusive: 'refuse', auth: (hello: any) => ({ id: hello.auth.uid }) }
    const transportA = new MemoryTransport(); const adapterA = new MemoryAdapter({ bus })
    const appA = mjsWs({ transport: transportA, heartbeat: 0, adapter: adapterA, ...commonOpts }); await appA.listen()
    const transportB = new MemoryTransport(); const adapterB = new MemoryAdapter({ bus })
    const appB = mjsWs({ transport: transportB, heartbeat: 0, adapter: adapterB, ...commonOpts }); await appB.listen()

    const traceB: any[] = []
    const µB = makeClient(transportB, traceB)
    const sB = µB.socket('memory://cx17b', { auth: () => ({ uid: 'z2' }) })
    sB.connect(); await tick()
    assert.equal(sB.state, 'open')

    const µA = makeClient(transportA)
    const sA = µA.socket('memory://cx17a', { auth: () => ({ uid: 'z2' }) })   // MÊME identité, AUTRE process
    sA.connect(); await tick()

    assert.equal(sA.state, 'open', "le hello frais sur A est accepté — 'refuse' ne garantit l'exclusivité QUE par processus (cf. §8.5)")
    assert.equal(sB.state, 'open', 'B (vivant, AUTRE process) reste INTACT — le kick distant ne doit jamais tuer une session vivante')
    assert.ok(!traceB.some(f => f.t === 'µ:bye'), "B ne reçoit AUCUN µ:bye — pas d'éviction cross-process en mode 'refuse'")

    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it("18. cluster + mode 'refuse' : session PARQUÉE (uniquement) sur le process B, hello frais sur A → A est accueilli, la parquée de B est purgée via le cluster (reprise impossible ensuite), et une 2e identité VIVANTE ailleurs (A) n'est jamais touchée par ce nettoyage", async () => {
    const bus = createMemoryAdapterBus()
    const commonOpts: MjsWsOptions = { sessionExclusive: 'refuse', resume: true, auth: (hello: any) => ({ id: hello.auth.uid }), onLog: () => {} }
    const transportA = new MemoryTransport(); const adapterA = new MemoryAdapter({ bus })
    const appA = mjsWs({ transport: transportA, heartbeat: 0, adapter: adapterA, ...commonOpts }); await appA.listen()
    const transportB = new MemoryTransport(); const adapterB = new MemoryAdapter({ bus })
    const appB = mjsWs({ transport: transportB, heartbeat: 0, adapter: adapterB, ...commonOpts }); await appB.listen()

    // B : hello brut → welcome → coupure SANS adieu (parcage, grâce en cours), MÊME technique que
    // le test 6 (parcage local) mais sur le process B
    const b = await rawHello(transportB, 'memory://cx18b', { auth: { uid: 'z3' } })
    const w1 = b.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w1 && w1.p.session)
    b.ws.close(1006, 'coupure simulée')
    await tick()
    assert.equal(appB.stats().connexions.parquees, 1, 'B est parqué (grâce en cours) — AUCUNE connexion vivante de cette identité nulle part')

    const µA = makeClient(transportA)
    const sA = µA.socket('memory://cx18a', { auth: () => ({ uid: 'z3' }) })   // MÊME identité, AUTRE process
    sA.connect(); await tick()
    assert.equal(sA.state, 'open', 'A est accueilli — aucune session VIVANTE nulle part dans le cluster')
    assert.equal(appB.stats().connexions.parquees, 0, 'la parquée de B a été purgée via le cluster (kick parkedOnly)')

    // rejeu de la session parquée de B (purgée) → reprise impossible, accueil frais — et ce 2e hello
    // FRAIS (même identité, retombé après échec de reprise) ne doit PAS non plus évincer A (vivant,
    // autre process) : même bug potentiel que le test 17, exercé une 2e fois dans l'autre sens
    const c = await rawHello(transportB, 'memory://cx18c', { auth: { uid: 'z3' }, session: { id: w1.p.session.id, key: w1.p.session.key } })
    const w2 = c.frames.find((f: any) => f.t === 'µ:welcome')
    assert.ok(w2, 'accueil frais malgré la session fournie — la parquée révoquée ne peut plus être reprise')
    assert.equal(w2.p.resumed, false)
    assert.equal(sA.state, 'open', "A (vivant, autre process) n'est jamais touché par ce 2e cycle refuse/purge sur B")

    sA.destroy(); await appA.stop(); await appB.stop()
  })
})

describe('cli/ws — buildRunPlan : précédence sessionExclusive (entry > config)', () => {
  it("config seule → transmise telle quelle ; entry + config → warn doublon et l'ENTRY prime en bloc", () => {
    const warns: string[] = []
    const warn = (message: string) => { warns.push(message) }

    const seul: EntryContract = { options: {} }
    const planA = buildRunPlan(seul, { sessionExclusive: true }, undefined, warn)
    assert.equal(planA.options.sessionExclusive, true)
    assert.equal(warns.length, 0)

    const deux: EntryContract = { options: { sessionExclusive: false } }
    const planB = buildRunPlan(deux, { sessionExclusive: true }, undefined, warn)
    assert.equal(planB.options.sessionExclusive, false, "l'entry prime — même un false explicite face à un true en config")
    assert.equal(warns.length, 1)
    assert.match(warns[0], /sessionExclusive défini à la fois dans l'entry et dans mjs\.config\.json \(ws\.sessionExclusive\) — l'entry prime/)
  })
})
