// Tests boucle complète de MJS-WS (« le standardiste » + « le videur ») contre
// le VRAI client µ.socket — même technique de chargement que tests/socket.test.ts
// (`new Function('µ', src)(stub)`), mais le faux WebSocket est fourni par
// MemoryTransport (src/mjs-ws/transport.ts) au lieu d'un mock ad-hoc : le client
// tourné vers un `mjsWs()` réel, sans réseau. Timers réels courts (ms), comme
// socket.test.ts — pas de fake clock.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { awaitBounded, MjsWsAuthDenied } from '../src/mjs-ws/core.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsConnection, MjsWsTransport } from '../src/mjs-ws/transport.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// même stub minimal que tests/socket.test.ts — µ.state non réactif (simple
// copie) : ces tests portent sur le PROTOCOLE, pas sur la réactivité MJS.
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

// branche globalThis.WebSocket sur CE transport mémoire, charge un client frais
function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// --- transport-espion pour le test 16 — pas MemoryTransport : on a besoin de
// contrôler PRÉCISÉMENT le délai avant le rappel onClose, hors de portée de son API publique.
// Implémente directement MjsWsTransport/MjsWsConnection (transport.ts, LECTURE SEULE : aucune
// modification du fichier) — une SEULE connexion, `close()` ne rappelle onClose qu'après `delayMs`.
function makeSlowCloseTransport(delayMs: number): { transport: MjsWsTransport; conn: MjsWsConnection; closeFired: () => boolean } {
  let closeFired = false
  let handler: ((conn: MjsWsConnection) => void) | null = null
  const conn: MjsWsConnection = {
    bufferedAmount: 0,
    remoteInfo: {},
    send() {},
    close(code, reason) {
      setTimeout(() => { closeFired = true; conn.onClose?.(code ?? 1000, reason ?? '') }, delayMs)
    },
    onMessage: null,
    onClose: null,
  }
  const transport: MjsWsTransport = {
    onConnection(h) { handler = h },
    async start() { handler?.(conn) },
    async stop() {},
  }
  return { transport, conn, closeFired: () => closeFired }
}

describe('MJS-WS — cœur du protocole + protections (boucle complète, vrai client µ.socket)', () => {
  it('1. connexion → hello → welcome → state open côté client', async () => {
    const { transport, app } = await startApp()
    const µ = makeClient(transport)
    const s = µ.socket('memory://t1')
    s.connect()
    await tick()
    assert.equal(s.state, 'open')
    assert.equal(s.connected, true)
    s.destroy(); await app.stop()
  })

  it('2. auth refusée → µ:denied → le client ne retente pas', async () => {
    const { transport, app } = await startApp({ auth: () => false })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t2', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await tick()
    assert.equal(s.state, 'closed')
    assert.ok(s.lastError && /refus/i.test(s.lastError.message))
    const before = (transport as any)._clients.length
    await tick(20)
    assert.equal((transport as any)._clients.length, before)   // aucune nouvelle tentative
    s.destroy(); await app.stop()
  })

  it('3. request() → serve() → µ:ack (succès et rejet sur throw)', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // le throw de 'boom' est INTENTIONNEL — pas de bruit
    app.serve('ping', (p: any) => ({ pong: true, n: p.n }))
    app.serve('boom', () => { throw new Error('nope') })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t3')
    s.connect(); await tick()
    const res = await s.request('ping', { n: 1 })
    assert.deepEqual(res, { pong: true, n: 1 })
    await assert.rejects(s.request('boom', {}), (e: any) => e === 'nope')
    s.destroy(); await app.stop()
  })

  it('4. pub/sub : broadcast à 2 clients, except respecté', async () => {
    const { transport, app } = await startApp()
    app.on('chat', (p: any, client: any) => app.broadcast('chat', p, { except: client }))
    const µA = makeClient(transport); const sA = µA.socket('memory://t4a'); sA.connect(); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://t4b'); sB.connect(); await tick()
    const recuA: any[] = []; const recuB: any[] = []
    sA.on('chat', (p: any) => recuA.push(p))
    sB.on('chat', (p: any) => recuB.push(p))
    sA.send('chat', { texte: 'salut' })
    await tick()
    assert.deepEqual(recuB, [{ texte: 'salut' }])
    assert.deepEqual(recuA, [])   // except a bien exclu l'émetteur
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('5. ping → pong : latence mesurée côté client, ts verbatim', async () => {
    const { transport, app } = await startApp({ heartbeat: 20 })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t5', { heartbeat: 20 })
    s.connect(); await tick()
    await tick(45)   // laisse au moins 1 aller-retour ping/pong passer
    assert.equal(typeof s.latency, 'number')
    assert.ok(s.latency >= 0)
    s.destroy(); await app.stop()
  })

  it('6. watchdog serveur : client qui ne ping pas → fermé après ~2.5×heartbeat', async () => {
    const { transport, app } = await startApp({ heartbeat: 30, onLog: () => {} })   // le kick est INTENTIONNEL
    const µ = makeClient(transport)
    const s = µ.socket('memory://t6', { heartbeat: 0, reconnect: { enabled: false } })   // client SANS ping
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    await tick(120)   // 2.5 × 30ms = 75ms de silence attendu + marge
    assert.equal(s.state, 'closed')   // kické, pas de reconnexion (enabled:false)
    s.destroy(); await app.stop()
  })

  it('7. rate-limit : rafale > burst → µ:error puis kick après kickAfter violations', async () => {
    const { transport, app } = await startApp({ limits: { rate: 5, burst: 5, kickAfter: 3 }, onLog: () => {} })   // kick INTENTIONNEL
    const µ = makeClient(transport)
    const s = µ.socket('memory://t7', { reconnect: { enabled: false } })
    s.connect(); await tick()
    for (let i = 0; i < 30; i++) s.send('spam', { i })
    await tick(60)
    assert.ok(s.lastError && String(s.lastError.message).includes('débit'))
    assert.equal(s.state, 'closed')
    s.destroy(); await app.stop()
  })

  it('8. stop() → µ:bye reçu côté client, fermeture propre', async () => {
    const { transport, app } = await startApp()
    const µ = makeClient(transport)
    const s = µ.socket('memory://t8', { reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    await app.stop()
    await tick()
    assert.equal(s.state, 'closed')
    assert.deepEqual(s.lastError, {})
    s.destroy()
  })

  it('9. payload > maxPayload → close(1009)', async () => {
    const { transport, app } = await startApp({ limits: { maxPayload: 200 }, onLog: () => {} })   // kick INTENTIONNEL
    const ws = transport.connect({ url: 'memory://t9' })
    await tick()
    let closedCode: number | null = null
    ws.onclose = (ev: any) => { closedCode = ev.code }
    ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: 'x'.repeat(500) } }))
    await tick()
    assert.equal(closedCode, 1009)
    await app.stop()
  })

  it("10. handler serve() qui throw : le process survit, le client reçoit un ack d'erreur", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // le throw de 'boom' est INTENTIONNEL — pas de bruit
    app.serve('boom', () => { throw new Error('kaboom') })
    app.serve('ping', () => 'pong')
    const µ = makeClient(transport)
    const s = µ.socket('memory://t10')
    s.connect(); await tick()
    await assert.rejects(s.request('boom', {}), (e: any) => e === 'kaboom')
    // le serveur répond ENCORE après le throw → preuve que rien n'a été emporté (process ni connexion)
    const res = await s.request('ping', {})
    assert.equal(res, 'pong')
    s.destroy(); await app.stop()
  })

  it('11. protocol ≠ 1 → µ:denied', async () => {
    const { transport, app } = await startApp()
    const ws = transport.connect({ url: 'memory://t11' })
    await tick()
    const received: any[] = []
    ws.onmessage = (ev: any) => received.push(JSON.parse(ev.data))
    ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 2, auth: undefined, resub: [], rooms: [] } }))
    await tick()
    assert.equal(received.length, 1)
    assert.equal(received[0].t, 'µ:denied')
    await app.stop()
  })

  it('12. salve post-welcome réelle, y compris après une reconnexion (stream/presence/room actifs avant)', async () => {
    // écrit à l'origine contre les réponses-stub des étapes 1-2 (présence toujours
    // vide) — depuis les étapes 3-4 la présence est RÉELLE : le client authentifié
    // se voit LUI-MÊME dans la présence globale (id de connexion, faute d'identity).
    const { transport, app } = await startApp({ onLog: () => {} })   // flux 'ennemis' jamais déclaré côté app → warn INTENTIONNEL (reset vide honnête)
    const µ = makeClient(transport)
    const s = µ.socket('memory://t12', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); await tick()
    const $$stream = s.stream('ennemis')
    const $$pres   = s.presence()
    s.room('zone-A')
    await tick()
    assert.deepEqual({ ...$$stream }, {})   // reset initial (µ:sub-stream) déjà appliqué — flux non déclaré : vide
    assert.equal(s.state, 'open')
    assert.equal(Object.keys({ ...$$pres }).length, 1)   // présence globale réelle : soi-même

    s._mjs_ws.close(1006, 'coupure simulée')    // coupure réseau simulée — PAS un close() volontaire
    assert.equal(s.state, 'reconnecting')
    await tick(30)                          // backoff [0] → reconnecte quasi immédiatement
    assert.equal(s.state, 'open')           // resynchro post-welcome (resync/sub-presence/join) n'a rien cassé
    assert.deepEqual({ ...$$stream }, {})
    assert.equal(Object.keys({ ...$$pres }).length, 1)   // re-reset reçu : le nouveau moi (id de connexion NEUF — sans identity, l'agrégation suit la connexion)

    s.destroy(); await app.stop()
  })

  // `log()` (core.ts) est le SEUL point de passage de tous les niveaux, appelé depuis
  // des dizaines de sites, y compris dans une chaîne `.catch(err => log(...))` (FIFO par
  // connexion) : un `onLog` utilisateur qui THROW y traverserait sans être rattrapé → rejet de
  // promesse jamais géré → CRASH du process (comportement PAR DÉFAUT de Node depuis la 15) pour
  // un simple bug de journalisation. La connexion 'bad' ci-dessous, jamais réutilisée après son
  // JSON invalide, est PRÉCISÉMENT le scénario qui rend un rejet non rattrapé observable (rien
  // d'autre ne s'accroche plus tard à sa chaîne FIFO pour le « couvrir »).
  it("13. onLog utilisateur qui THROW (bug d'intégration log) : ne fait JAMAIS tomber le serveur", async () => {
    let sawUnhandled = false
    const onUnhandled = () => { sawUnhandled = true }
    process.on('unhandledRejection', onUnhandled)
    try {
      const { transport, app } = await startApp({ onLog: () => { throw new Error('bug de journalisation') } })
      app.serve('ping', () => 'pong')

      const bad = transport.connect({ url: 'memory://t13-bad' })
      await tick()
      bad.send('{ceci nest pas du JSON')   // → onInvalidJson → log('warn', ...) → onLog throw
      await tick(20)

      // le serveur répond ENCORE à un AUTRE client → rien n'a été emporté (process ni transport)
      const µ = makeClient(transport)
      const s = µ.socket('memory://t13-ok')
      s.connect(); await tick()
      const res = await s.request('ping', {})
      assert.equal(res, 'pong')
      s.destroy(); await app.stop()
      await tick(10)
    } finally {
      process.off('unhandledRejection', onUnhandled)
    }
    assert.equal(sawUnhandled, false, "onLog qui throw a produit un rejet de promesse non géré (aurait fait tomber le process, hors test)")
  })

  // la connexion tombe PENDANT un auth() async (DB/réseau lent, cas réel et courant) :
  // AVANT le fix, handleHello continuait quand même après le await — roomsEngine.onWelcome()
  // ajoutait un pair de présence FANTÔME pour une connexion déjà purgée par finalizeCleanup
  // (jamais revue par un futur onDisconnect, puisqu'il n'a lieu qu'UNE fois par connexion) :
  // fuite permanente + un utilisateur qui semble éternellement en ligne pour tous les autres.
  it("14. connexion qui tombe PENDANT auth() async : aucun pair de présence fantôme", async () => {
    let releaseAuth: ((v: unknown) => void) | null = null
    const { transport, app } = await startApp({
      onLog: () => {},
      auth:  () => new Promise(resolve => { releaseAuth = resolve }),
    })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t14', { reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.ok(releaseAuth, 'auth() doit être en attente')

    s._mjs_ws.close(1006, 'coupure pendant auth')   // la connexion tombe PENDANT que le serveur attend encore auth()
    await tick()

    // auth() finit PAR résoudre (réseau lent...) — la suite du handshake ne doit PLUS s'exécuter
    releaseAuth!({ id: 'devrait-rester-fantome' })
    await tick()

    assert.equal(app.stats().connexions.actives, 0, 'aucune connexion active : celle-ci n\'a jamais complété son welcome')

    // un 2e client observe la présence globale : un pair fantôme apparaîtrait ici (son PROPRE
    // hello passe aussi par `auth`, ré-affectant releaseAuth — on le débloque à son tour)
    const µ2 = makeClient(transport)
    const s2 = µ2.socket('memory://t14-observer')
    s2.connect(); await tick()
    assert.ok(releaseAuth, 'auth() de s2 doit être en attente')
    releaseAuth!({ id: 'observer' })
    await tick()
    const $$pres = s2.presence()
    await tick()
    const peers = Object.keys({ ...$$pres })
    assert.equal(peers.length, 1, `présence attendue = {soi-même} seul, reçu : ${JSON.stringify(peers)}`)

    s2.destroy(); await app.stop()
  })

  // le pont universel (bridge.ts, POST /send { user }) sait déjà viser
  // TOUTES les connexions d'un même utilisateur ; côté code serveur, seul app.send(client, …)
  // existait (UNE connexion précise). app.sendUser(id, …) comble l'asymétrie, MÊME résolution
  // (peerIdOf : identity.id, repli id de connexion) que le pont.
  it('15. sendUser(id, type, p) : TOUTES les connexions de cet identity.id reçoivent, une AUTRE identité ne reçoit rien', async () => {
    const { transport, app } = await startApp({ auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µA1 = makeClient(transport); const sA1 = µA1.socket('memory://su-a1', { auth: () => ({ uid: 'u1' }) })
    const µA2 = makeClient(transport); const sA2 = µA2.socket('memory://su-a2', { auth: () => ({ uid: 'u1' }) })
    const µB  = makeClient(transport); const sB  = µB.socket('memory://su-b', { auth: () => ({ uid: 'u2' }) })
    sA1.connect(); sA2.connect(); sB.connect(); await tick()
    const recuA1: any[] = []; const recuA2: any[] = []; const recuB: any[] = []
    sA1.on('notif', (p: any) => recuA1.push(p))
    sA2.on('notif', (p: any) => recuA2.push(p))
    sB.on('notif', (p: any) => recuB.push(p))

    app.sendUser('u1', 'notif', { hello: true })
    await tick()

    assert.deepEqual(recuA1, [{ hello: true }])
    assert.deepEqual(recuA2, [{ hello: true }])
    assert.deepEqual(recuB, [], "une AUTRE identité (u2) ne doit rien recevoir")

    sA1.destroy(); sA2.destroy(); sB.destroy(); await app.stop()
  })

  // stop() dismiss chaque client puis coupe le transport,
  // mais conn.close() ne RETOURNE rien (contrat MjsWsConnection) : le VRAI signal de fin (onClose,
  // qui déclenche finalizeCleanup — webhook 'disconnect', purge salons/flux/sessions) arrive sur un
  // tick ULTÉRIEUR. AVANT le fix, stop() pouvait résoudre avant que ces nettoyages n'aient tourné.
  it('16. stop() attend la fermeture ASYNCHRONE (onClose artificiellement lent) avant de résoudre', async () => {
    const { transport, conn, closeFired } = makeSlowCloseTransport(120)
    const app = mjsWs({ transport, heartbeat: 0 })
    await app.listen()

    conn.onMessage!(JSON.stringify({ t: 'µ:hello', p: { protocol: 1 } }))
    await tick(10)
    assert.equal(app.stats().connexions.actives, 1, 'sanity : le client factice est bien authentifié avant stop()')
    assert.equal(closeFired(), false, 'sanity : onClose pas encore déclenché avant stop()')

    await app.stop()
    assert.equal(closeFired(), true, "AVANT le fix : stop() résolvait AVANT le rappel onClose (asynchrone) du transport")
  })

  // la branche TIMEOUT (~2s en production, cf. STOP_CLOSE_TIMEOUT_MS core.ts) se teste en
  // ISOLATION sur awaitBounded avec un timeoutMs COURT injecté — jamais en attendant 2s réelles
  // dans la suite (cf. tests/mjs-ws-bridge-ratelimit.test.ts pour le même principe côté horloge).
  it('17. awaitBounded : résout AU TIMEOUT si une promesse ne se tient jamais (jamais de pendaison)', async () => {
    const never = new Promise<void>(() => {})
    const t0 = Date.now()
    await awaitBounded([never], 30)
    assert.ok(Date.now() - t0 < 250, 'doit résoudre proche du timeoutMs injecté (30ms), jamais pendre indéfiniment')
  })

  it('18. awaitBounded : résout dès que TOUTES les promesses sont tenues, sans attendre le timeout', async () => {
    const t0 = Date.now()
    await awaitBounded([Promise.resolve(), new Promise<void>(r => setTimeout(r, 5))], 2000)
    assert.ok(Date.now() - t0 < 500, 'ne doit pas attendre les 2000ms du timeout alors que tout est déjà résolu bien avant')
  })

  it('19. awaitBounded([]) : résout immédiatement (rien à attendre, ex. stop() sans client connecté)', async () => {
    const t0 = Date.now()
    await awaitBounded([], 2000)
    assert.ok(Date.now() - t0 < 50)
  })

  // pour MJS-Server — accroche générique de déconnexion DÉFINITIVE :
  // un module de composition (MJS-Server) a besoin d'être prévenu SANS monter un pont HTTP juste
  // pour ça (opts.bridge). Cf. docs/23-mjs-ws.md §1/§8.2 point 5.
  it('20. onDisconnect(client, reason) : appelé UNE fois à la déconnexion définitive, jamais pour un client jamais authentifié', async () => {
    const vus: Array<{ id: string; reason: string | undefined }> = []
    const { transport, app } = await startApp({ auth: () => ({ id: 'u1' }), onDisconnect: (c, reason) => vus.push({ id: c.id, reason }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t20', { reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(vus.length, 0, 'rien avant la coupure')
    s._mjs_ws.close(1006, 'coupure simulée')
    await tick()
    assert.equal(vus.length, 1, 'sans resume : déconnexion immédiate = définitive tout de suite')
    assert.equal(vus[0].reason, 'coupure simulée')

    // connexion RAW jamais authentifiée (aucun µ:hello envoyé, cf. test 14) : sa fermeture ne
    // doit JAMAIS déclencher le rappel — même garde `wasAuthenticated` que le webhook du pont
    const raw = transport.connect({ url: 'memory://t20-raw' })
    await tick()
    raw.close(1006, 'jamais dit bonjour')
    await tick()
    assert.equal(vus.length, 1, 'connexion jamais authentifiée : onDisconnect ne doit pas tirer')

    s.destroy(); await app.stop()
  })

  it("21. onDisconnect(client, reason) : DIFFÉRÉ à l'expiration de la grâce quand `resume` est actif — jamais pendant la grâce", async () => {
    const vus: Array<{ reason: string | undefined }> = []
    const { transport, app } = await startApp({ auth: () => ({ id: 'u1' }), resume: { grace: 40 }, onDisconnect: (_c, reason) => vus.push({ reason }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://t21', { reconnect: { enabled: false } })
    s.connect(); await tick()
    s._mjs_ws.close(1006, 'coupure réseau')
    await tick()
    assert.equal(vus.length, 0, 'encore en grâce : pas encore définitif')
    assert.equal(app.stats().connexions.parquees, 1)
    await tick(70)   // grâce (40ms) dépassée
    assert.equal(vus.length, 1, "grâce expirée : le rappel tire MAINTENANT, pas avant")
    assert.equal(vus[0].reason, 'coupure réseau')
    await app.stop()
  })

  // fuite d'erreur à un client NON authentifié — AVANT le fix, le catch
  // de handleHello renvoyait errMessage(err) BRUT dans µ:denied, quelle que soit la provenance de
  // l'exception : un bug interne à opts.auth (DB en rade, etc.) fuitait donc son message tel quel
  // à un client PAS ENCORE authentifié. Un refus MÉTIER explicite (MjsWsAuthDenied, le nouveau
  // contrat public) doit lui continuer à atteindre le client verbatim — cf. son commentaire de
  // tête (core.ts) pour la distinction complète, et tests/mjs-ws-proxy.test.ts test 2 pour la
  // MÊME garantie côté proxy de décisions (authIsProxy, non touché par ce test).
  it("22. auth() qui THROW : exception interne masquée (générique) au client, refus métier explicite (MjsWsAuthDenied) transmis tel quel", async () => {
    const warnLogs: string[] = []
    const { transport, app } = await startApp({
      onLog: (level, message) => { if (level === 'warn') warnLogs.push(message) },   // le throw des 2 scénarios est INTENTIONNEL — capté, pas du bruit
      auth: (hello: any) => {
        if (hello.auth?.mode === 'bug')          throw new Error('connexion DB xyz échouée')
        if (hello.auth?.mode === 'refus-metier') throw new MjsWsAuthDenied('mot de passe incorrect')
        return { id: 'ok' }
      },
    })

    // 1. exception interne (bug/panne) — le détail ne doit JAMAIS atteindre le client
    const wsBug = transport.connect({ url: 'memory://t22-bug' })
    await tick()
    const receivedBug: any[] = []
    wsBug.onmessage = (ev: any) => receivedBug.push(JSON.parse(ev.data))
    wsBug.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: { mode: 'bug' } } }))
    await tick()
    assert.equal(receivedBug.length, 1)
    assert.equal(receivedBug[0].t, 'µ:denied')
    assert.ok(!String(receivedBug[0].p.message).includes('DB xyz'), `le détail interne a fuité au client : ${receivedBug[0].p.message}`)
    assert.ok(warnLogs.some(m => m.includes('DB xyz échouée')), 'le détail interne doit malgré tout être loggé côté serveur (warn)')

    // 2. refus MÉTIER explicite (MjsWsAuthDenied) — le message doit atteindre le client tel quel
    const wsMetier = transport.connect({ url: 'memory://t22-metier' })
    await tick()
    const receivedMetier: any[] = []
    wsMetier.onmessage = (ev: any) => receivedMetier.push(JSON.parse(ev.data))
    wsMetier.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: { mode: 'refus-metier' } } }))
    await tick()
    assert.equal(receivedMetier.length, 1)
    assert.equal(receivedMetier[0].t, 'µ:denied')
    assert.equal(receivedMetier[0].p.message, 'mot de passe incorrect')

    await app.stop()
  })

  // course d'état à la fermeture refusée — AVANT le fix, sendDeniedAndClose
  // fermait la connexion SANS marquer client.state en terminal SYNCHRONE : le passage n'arrivait
  // qu'async via onClose. Un client brut qui pipeline sur le MÊME socket un µ:hello invalide PUIS
  // un µ:hello valide (écrits avant que la trame close n'ait pu tourner) voyait son 2e hello encore
  // routé vers handleHello (state encore 'hello') — authentification possible sur une connexion
  // déjà refusée. Cf. state (MjsWsClientImpl)/sendDeniedAndClose/handleRaw pour le fix.
  it('23. 2e µ:hello pipeliné après un refus (µ:denied) sur le MÊME socket : ignoré, pas de double-authentification', async () => {
    const { transport, app } = await startApp({
      onLog: () => {},   // le refus du 1er hello est INTENTIONNEL — pas de bruit
      auth: (hello: any) => hello.auth?.token === 'bon-jeton' ? { id: 'u1' } : false,
    })
    const ws = transport.connect({ url: 'memory://t23' })
    await tick()
    const received: any[] = []
    ws.onmessage = (ev: any) => received.push(JSON.parse(ev.data))

    // pipeline : les DEUX trames écrites AVANT que quoi que ce soit n'ait eu la chance de tourner
    ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: { token: 'mauvais-jeton' } } }))
    ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: { token: 'bon-jeton' } } }))
    await tick(20)

    assert.equal(received.filter(m => m.t === 'µ:welcome').length, 0, 'le 2e hello ne doit JAMAIS authentifier — aucun µ:welcome')
    assert.equal(received.filter(m => m.t === 'µ:denied').length, 1, 'un SEUL µ:denied — le 1er refus lui-même ne doit pas être traité en double')
    assert.equal(app.stats().connexions.accueillies, 0, 'stats accueillies non incrémentée pour ce socket')
    assert.equal(app.stats().connexions.refusees, 1)
    assert.equal(Array.from(app.clients).length, 0, 'aucun client authentifié enregistré')

    await app.stop()
  })
})
