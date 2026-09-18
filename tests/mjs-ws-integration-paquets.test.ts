// Tests d'INTÉGRATION — vérification de la composition de 5 livraisons :
// sessionExclusive, CSS à chaud dev (orthogonal),
// module Chat (+ durcissements), module Comptes, module Lobby.
// Chacune est déjà testée ISOLÉMENT et verte (tests/mjs-ws-session-exclusive.test.ts,
// tests/mjs-ws-accounts.test.ts, tests/mjs-ws-chat.test.ts, tests/mjs-ws-lobby.test.ts) — ce fichier
// vérifie qu'elles marchent ENSEMBLE (composition réelle app.use × 3 + option serveur) et résistent
// aux abus TRANSVERSAUX (une identité de compte traversant plusieurs paquets/onglets à la fois).
//
// MÊME technique que les fichiers ci-dessus : vrai client µ.socket sur MemoryTransport pour le
// protocole observable (state/lastError/request), + un client BRUT (rawHello, repris tel quel de
// mjs-ws-session-exclusive.test.ts) quand il faut voir la trame µ:bye/µ:welcome EXACTE (session
// {id,key}, code de fermeture) sans l'abstraction du vrai client.
//
// Élévation invité→compte : PAR RECONNEXION (sock.close()+sock.connect() avec le token posé en
// auth), PAS par sock.refresh() — cf. docs/27-accounts.md §5 et src/runtime/mjs_accounts.ts::
// _accountElevate (le patron réel du client). `eleverParReconnexion` ci-dessous reprend VERBATIM la
// technique de tests/mjs-ws-accounts.test.ts (le socket brut request/send, pas mjs_accounts.ts lui-
// même, couvert par tests/socket-accounts.test.ts).
//
// Note de conception (scénario 3, sous-tests a/b) : « un muet ouvre un 2e onglet » exige DEUX
// connexions VIVANTES en même temps sous la MÊME identité — structurellement incompatible avec
// sessionExclusive:true (qui éjecterait la 1re à l'arrivée de la 2e). Ces sous-tests composent donc
// comptes+chat+lobby SANS sessionExclusive (déploiement multi-onglets classique, cf. le commentaire
// de chat.ts::buckets « 2 onglets = même quota »/« compatible sessionExclusive/anti-triche
// sans rien faire de spécial ») ; sessionExclusive revient au premier plan dans les scénarios 1, 2
// et 3e (là où une ÉJECTION réelle a lieu).
import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, accountsPackage, accountsAuth, hasRole, chatPackage, lobbyPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp } from '../src/mjs-ws/index.js'
import type { MjsWsAccountsOptions } from '../src/mjs-ws/accounts.js'
import type { MjsWsChatOptions } from '../src/mjs-ws/chat.js'
import type { MjsWsLobbyOptions } from '../src/mjs-ws/lobby.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

const SECRET = 'secret-test-integration-paquets'

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

// branche globalThis.WebSocket sur CE transport — trace optionnelle des trames ENTRANTES (repris de
// mjs-ws-session-exclusive.test.ts::makeClient)
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

// client BRUT (protocole à la main) — repris VERBATIM de mjs-ws-session-exclusive.test.ts::rawHello,
// pour observer une trame µ:welcome/µ:bye EXACTE (session {id,key}, reason) sans l'abstraction du
// vrai client — utilisé UNIQUEMENT au scénario 2 (carte de session révoquée).
async function rawHello(transport: MemoryTransport, url: string, helloP: Record<string, unknown> = {}): Promise<{ ws: any; frames: any[] }> {
  const ws = transport.connect({ url })
  const frames: any[] = []
  ws.onmessage = (ev: any) => frames.push(JSON.parse(ev.data))
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [], ...helloP } }))
  await tick()
  return { ws, frames }
}

interface FullAppOpts {
  sessionExclusive?: boolean
  resume?: boolean
  comptesOpts?: Partial<MjsWsAccountsOptions>
  chatOpts?: MjsWsChatOptions
  lobbyOpts?: MjsWsLobbyOptions
}

// COMPOSITION COMPLÈTE — mjsWs({sessionExclusive?, auth: accountsAuth(SECRET)}) + les 3 paquets
// applicatifs (comptes/chat/lobby), MÊME secret partagé entre `auth` et `accountsPackage` (cf.
// docs/27-accounts.md §5, condition sine qua non de l'élévation).
async function startFullApp(o: FullAppOpts = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({
    transport, heartbeat: 0, onLog: () => {}, auth: accountsAuth(SECRET),
    sessionExclusive: o.sessionExclusive === true,
    ...(o.resume ? { resume: true } : {}),
  })
  app.use(accountsPackage({ ...o.comptesOpts, secret: SECRET }))
  app.use(chatPackage(o.chatOpts))
  app.use(lobbyPackage(o.lobbyOpts))
  await app.listen()
  return { transport, app }
}

// connexion ANONYME — accountsAuth laisse passer un hello sans token (identité anonyme, cf.
// accounts.ts::accountsAuth)
function connectAnonyme(transport: MemoryTransport, url: string): any {
  const s = makeClient(transport).socket(url, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect()
  return s
}

// connexion FRAÎCHE directement avec un token compte au hello (PAS une élévation par reconnexion —
// scénario 1 seul l'utilise ; scénarios 2/3 simulent directement « 2 onglets du même compte »)
function connectAvecJeton(transport: MemoryTransport, url: string, token: string, trace?: any[]): any {
  const s = makeClient(transport, trace).socket(url, { auth: () => token, reconnect: { enabled: false } })
  s.connect()
  return s
}

// élévation invité→compte PAR RECONNEXION — MÊME technique que src/runtime/mjs_accounts.ts::
// _accountElevate / tests/mjs-ws-accounts.test.ts::eleverParReconnexion (docs/27-accounts.md §5)
function eleverParReconnexion(s: any, token: string): Promise<void> {
  return new Promise((resolve) => {
    s.opts.auth = () => token
    s.on('welcome', function onWelcome() { s.off('welcome', onWelcome); resolve() })
    s.close(); s.connect()
  })
}

// bootstrap — crée un compte via une connexion anonyme JETABLE, renvoie le token, referme la
// connexion de bootstrap (jamais réutilisée pour le test lui-même)
async function createAccount(transport: MemoryTransport, url: string, name: string, secret = 'motdepasse123'): Promise<string> {
  const boot = connectAnonyme(transport, url)
  await tick()
  const res = await boot.request('account:create', { name, secret })
  boot.destroy(); await tick()
  return res.token
}

// rejoint le hall/salon MJS-WS bas niveau (µ:join) — préalable à toute action lobby:*/chat:*, MÊME
// exigence que sock.lobby()/sock.chat() en coulisses (cf. tests/mjs-ws-lobby.test.ts/mjs-ws-chat.test.ts)
function joinHall(s: any, hall = 'hall', prefixe = 'lobby:'): void { s.room(prefixe + hall) }
function joinSalon(s: any, salon: string, prefixe = 'chat:'): void { s.room(prefixe + salon) }

// mémoire bornée du paquet Lobby — fait franchir le seuil de balayage GLOBAL
// (BALAYAGE_TOUTES_LES_ACTIONS = 50, lobby.ts), MÊME technique que tests/mjs-ws-lobby.test.ts::
// declencherBalayageGlobal — nécessaire au scénario 3e (retrait d'annonce d'un identité éjectée,
// jamais poussé en LIVE, seulement au prochain passage de balayage).
async function declencherBalayageLobby(transport: MemoryTransport): Promise<void> {
  const s = connectAnonyme(transport, 'memory://bruit-integration-lobby')
  await tick()
  for (let i = 0; i < 80; i++) s.send('lobby:block', { hall: 'bruit', identityId: 'x' })
  await tick()
  s.destroy(); await tick()
}

describe('MJS-WS — intégration des paquets', () => {

  describe('1. composition complète — boot sain, invité → lobby → compte → élévation par reconnexion → retour au lobby/chat avec le pseudo de compte', () => {
    it("un invité anonyme entre au lobby, crée un compte, s'élève par RECONNEXION avec le token (docs/27 §5), revient au lobby ET au chat avec son pseudo de compte", async () => {
      const { transport, app } = await startFullApp({ sessionExclusive: true })
      const s = makeClient(transport).socket('memory://comp1', { auth: () => undefined, reconnect: { enabled: false } })

      // .room() AVANT connect() est sûr — _mjs_rooms[name] mémorisé côté client, rejoué au welcome
      // (mjs_socket.ts::_mjs_onWelcome, ligne « for (var __rm in this._mjs_rooms) { this._mjs_sendJoin(__rm) } »)
      joinHall(s)
      s.connect()
      await tick()
      assert.equal(s.state, 'open', 'boot sain — les 4 briques (sessionExclusive+comptes+chat+lobby) cohabitent sans lever au démarrage')

      const entreeInvite = await s.request('lobby:enter', {})
      assert.equal(entreeInvite.me.name, entreeInvite.me.id, 'invité anonyme — pseudo = id de connexion (repli peerIdOf, aucun compte)')

      const creation = await s.request('account:create', { name: 'zora', secret: 'motdepasse123' })
      assert.equal(typeof creation.token, 'string')

      await eleverParReconnexion(s, creation.token)
      await tick()   // laisse le re-join automatique de 'lobby:hall' (resub post-reconnexion) atteindre le serveur

      const identity = Array.from(app.clients).find((c: any) => c.identity && c.identity.name === 'zora') as any
      assert.ok(identity, "la nouvelle connexion (post-élévation) porte bien l'identité du compte")
      assert.deepEqual(identity.identity.roles, [])

      const entreeCompte = await s.request('lobby:enter', {})
      assert.equal(entreeCompte.me.name, 'zora', 'revient au lobby avec son pseudo de COMPTE (nouvelle entrée — nouvelle identité, nouveau peerId)')
      assert.ok(entreeCompte.members.some((p: any) => p.name === 'zora'))

      // chat aussi — même identité visible dans le 3e paquet composé (comptes → chat, via
      // client.identity.name, cf. chat.ts::nameOf) — preuve que les 4 briques cohabitent bien,
      // pas seulement 2 à la fois
      s.room('chat:general')
      await tick()
      const messages: any[] = []
      s.on('chat:message', (p: any) => messages.push(p))
      s.send('chat:send', { room: 'general', text: 'salut depuis mon compte' })
      await tick()
      assert.equal(messages.length, 1)
      assert.equal(messages[0].from.name, 'zora', 'chatPackage résout aussi le pseudo de compte')

      s.destroy(); await app.stop()
    })
  })

  describe('2. session exclusive × comptes — 2 hellos FRAIS au MÊME token (identité de compte)', () => {
    it("la 1re connexion reçoit µ:bye{reason:'replace'} + close 4003 ; son appartenance lobby/chat est nettoyée ; son ancienne carte de session {id,key} ne permet plus de reprise", async () => {
      const { transport, app } = await startFullApp({ sessionExclusive: true, resume: true })
      const token = await createAccount(transport, 'memory://sx2-boot', 'kara')

      // connexion A — BRUTE (protocole à la main), PAS le vrai client : seule façon d'observer le
      // code de fermeture EXACT — mjs_socket.ts::_mjs_teardown détache ws.onclose (le remet à null) DÈS
      // le traitement du µ:bye, avant même que l'évènement de fermeture réel n'arrive (vérifié : un
      // 1er essai avec le vrai client + wrapper sur _mjs_ws.onclose restait bloqué à `null`). MÊME
      // contrainte, MÊME solution que tests/mjs-ws-session-exclusive.test.ts::rawHello (test 1/6).
      const a = await rawHello(transport, 'memory://sx2a', { auth: token })
      const w1 = a.frames.find((f: any) => f.t === 'µ:welcome')
      assert.ok(w1 && w1.p.session, 'carte de session émise (resume:true)')
      let closedCode: number | null = null
      a.ws.onclose = (ev: any) => { closedCode = ev.code }

      // A rejoint le hall lobby + le salon chat — µ:join bas niveau, MÊME trame EXACTE que
      // mjs_socket.ts::_mjs_sendJoin (`{t:'µ:join', p:{room:name}}`) — nécessaire pour vérifier ensuite
      // le nettoyage d'appartenance
      a.ws.send(JSON.stringify({ t: 'µ:join', p: { room: 'lobby:hall' } }))
      a.ws.send(JSON.stringify({ t: 'µ:join', p: { room: 'chat:general' } }))
      await tick()

      const aRef = Array.from(app.clients).find((c: any) => c.identity && c.identity.name === 'kara') as any
      assert.ok(aRef, 'A bien indexée côté serveur')
      assert.ok(app.room('lobby:hall').has(aRef), 'A membre du hall AVANT éviction')
      assert.ok(app.room('chat:general').has(aRef), 'A membre du salon chat AVANT éviction')

      // connexion B — hello FRAIS, MÊME token (PAS une reprise : aucune p.session envoyée par un
      // client tout neuf) → sessionExclusive doit éjecter A
      const b = await rawHello(transport, 'memory://sx2b', { auth: token })
      const w2 = b.frames.find((f: any) => f.t === 'µ:welcome')
      assert.ok(w2, 'B (même token) accueillie normalement — prend la place')

      const bye = a.frames.find((f: any) => f.t === 'µ:bye')
      assert.ok(bye, 'A a bien reçu µ:bye')
      assert.deepEqual(bye.p, { reason: 'replace' })
      assert.equal(closedCode, 4003, 'fermeture avec le code dédié sessionExclusive')

      // nettoyage — A n'est plus indexée côté serveur, ni membre d'aucun salon/hall
      assert.ok(!Array.from(app.clients).includes(aRef), 'A retirée de app.clients')
      assert.equal(app.room('lobby:hall').has(aRef), false, 'appartenance lobby nettoyée')
      assert.equal(app.room('chat:general').has(aRef), false, 'appartenance chat nettoyée')

      // reprise — l'ANCIENNE carte {id,key} de A (issue de son welcome, AVANT l'éviction) ne permet
      // plus de reprise : dismissClient() → sessionsEngine.discard(client) est appelé à l'éjection (core.ts)
      const c = await rawHello(transport, 'memory://sx2c', { auth: token, session: { id: w1.p.session.id, key: w1.p.session.key } })
      const w3 = c.frames.find((f: any) => f.t === 'µ:welcome')
      assert.ok(w3, 'C accueillie (le token reste valide — seule la REPRISE est refusée)')
      assert.equal(w3.p.resumed, false, "l'ancienne session de A ne peut plus être reprise — accueil frais")
      assert.notEqual(w3.p.session.id, w1.p.session.id)

      a.ws.close(); b.ws.close(); c.ws.close()
      await app.stop()
    })
  })

  describe('3. anti-abus transversaux (comptes + chat + lobby composés — cf. tête de fichier pour le choix sessionExclusive on/off par sous-test)', () => {
    it("a. le MUET chat suit l'IDENTITÉ — un 2e onglet du même compte reste muet (sessionExclusive absent : 2 onglets légitimes coexistent)", async () => {
      const { transport, app } = await startFullApp({
        comptesOpts: { roles: (c) => c.name === 'moderateur1' ? ['moderateur'] : [] },
        chatOpts: { moderators: (identity) => hasRole(identity, 'moderateur') },
      })

      const jetonMod = await createAccount(transport, 'memory://sx3a-boot-mod', 'moderateur1')
      const token    = await createAccount(transport, 'memory://sx3a-boot', 'bavard1')

      const mod     = connectAvecJeton(transport, 'memory://sx3a-mod', jetonMod)
      const onglet1 = connectAvecJeton(transport, 'memory://sx3a-o1', token)
      const onglet2 = connectAvecJeton(transport, 'memory://sx3a-o2', token)   // 2e onglet, MÊME compte
      await tick()
      assert.equal(onglet1.state, 'open'); assert.equal(onglet2.state, 'open')

      joinSalon(mod, 'general'); joinSalon(onglet1, 'general'); joinSalon(onglet2, 'general')
      await tick()

      const moi1 = await onglet1.request('chat:me', {})
      mod.send('chat:mute', { room: 'general', identityId: moi1.id, durationMs: 5000 })
      await tick()

      const recu1: any[] = []; const recu2: any[] = []
      onglet1.on('chat:message', (p: any) => recu1.push(p))
      onglet2.on('chat:message', (p: any) => recu2.push(p))

      onglet1.send('chat:send', { room: 'general', text: 'depuis onglet 1' })
      await tick()
      assert.deepEqual(recu1, [], "l'onglet muté ne passe pas")
      assert.equal(onglet1.lastError.message, 'chat-muted')

      onglet2.send('chat:send', { room: 'general', text: 'depuis onglet 2' })
      await tick()
      assert.deepEqual(recu2, [], "le 2e onglet — MÊME compte — reste TOUJOURS muet (suit l'identité, pas la connexion)")
      assert.equal(onglet2.lastError.message, 'chat-muted')

      onglet1.destroy(); onglet2.destroy(); mod.destroy(); await app.stop()
    })

    it('b. le SEAU DE DÉBIT chat est PARTAGÉ entre les onglets d\'une même identité (compte)', async () => {
      const { transport, app } = await startFullApp()
      const token = await createAccount(transport, 'memory://sx3b-boot', 'partageur1')

      const o1 = connectAvecJeton(transport, 'memory://sx3b-o1', token)
      const o2 = connectAvecJeton(transport, 'memory://sx3b-o2', token)
      await tick()
      joinSalon(o1, 'general'); joinSalon(o2, 'general')
      await tick()

      const recu2: any[] = []
      o2.on('chat:message', (p: any) => recu2.push(p))

      for (let i = 1; i <= 5; i++) o1.send('chat:send', { room: 'general', text: 'o1-' + i })   // épuise le seau (burst défaut 5) DEPUIS l'onglet 1
      await tick()
      assert.equal(recu2.length, 5, "o2 reçoit bien les 5 messages d'o1 comme tout membre du salon (rediffusion normale)")
      o2.send('chat:send', { room: 'general', text: 'depuis-o2' })   // MÊME identité → seau déjà vide
      await tick()
      assert.equal(recu2.filter((m: any) => m.text === 'depuis-o2').length, 0, "l'onglet 2 partage le quota de l'onglet 1 (même identité de compte) — son propre envoi n'est jamais rediffusé")
      assert.equal(o2.lastError.message, 'chat-rate')

      o1.destroy(); o2.destroy(); await app.stop()
    })

    describe('c. lobby — invitations en composition avec comptes (débit + blocage)', () => {
      it('c1. anti-spam — > 6/min PAR IDENTITÉ (compte) → lobby-rate', async () => {
        const { transport, app } = await startFullApp()
        const jetonA = await createAccount(transport, 'memory://sx3c1-bootA', 'emetteur1')
        const jetonB = await createAccount(transport, 'memory://sx3c1-bootB', 'cible1')
        const jetonC = await createAccount(transport, 'memory://sx3c1-bootC', 'autrui1')

        const a = connectAvecJeton(transport, 'memory://sx3c1-a', jetonA)
        const b = connectAvecJeton(transport, 'memory://sx3c1-b', jetonB)
        const c = connectAvecJeton(transport, 'memory://sx3c1-c', jetonC)
        await tick()
        joinHall(a); joinHall(b); joinHall(c)
        await tick()
        await a.request('lobby:enter', {})   // A doit avoir sa PROPRE entrée (presence entry) pour pouvoir inviter (cf. lobby.ts::lobby:invite)
        const idB = (await b.request('lobby:enter', {})).me.id
        const idC = (await c.request('lobby:enter', {})).me.id

        const recuInvB: any[] = []
        b.on('lobby:invitation', (p: any) => recuInvB.push(p))
        for (let i = 0; i < 6; i++) a.send('lobby:invite', { identityId: idB })
        await tick()
        assert.equal(recuInvB.length, 6, 'les 6 premières passent (burst par défaut)')

        a.send('lobby:invite', { identityId: idC })   // 7e — MÊME seau (émetteur), cible DIFFÉRENTE
        await tick()
        assert.equal(a.lastError.message, 'lobby-rate', "le seau est par IDENTITÉ ÉMETTRICE, pas par cible — même en composition avec comptes")

        a.destroy(); b.destroy(); c.destroy(); await app.stop()
      })

      it("c2. blocage — invitation après lobby:block → silencieusement ignorée (aucune erreur visible côté émetteur)", async () => {
        const { transport, app } = await startFullApp()
        const jetonA = await createAccount(transport, 'memory://sx3c2-bootA', 'emetteur2')
        const jetonB = await createAccount(transport, 'memory://sx3c2-bootB', 'cible2')

        const a = connectAvecJeton(transport, 'memory://sx3c2-a', jetonA)
        const b = connectAvecJeton(transport, 'memory://sx3c2-b', jetonB)
        await tick()
        joinHall(a); joinHall(b)
        await tick()
        const idA = (await a.request('lobby:enter', {})).me.id
        const idB = (await b.request('lobby:enter', {})).me.id

        b.send('lobby:block', { identityId: idA })
        await tick()

        const recuInvB: any[] = []
        b.on('lobby:invitation', (p: any) => recuInvB.push(p))
        a.send('lobby:invite', { identityId: idB, note: 'coucou' })
        await tick()
        assert.deepEqual(recuInvB, [], 'B (bloqueur) ne reçoit rien')
        assert.equal(a.lastError, null, "A (bloquée à son insu) ne voit AUCUNE erreur — indistinguable d'un envoi normal")

        a.destroy(); b.destroy(); await app.stop()
      })
    })

    it('d. lobby:status — texte de 61 caractères → lobby-text-invalid (borne stricte, défaut 60 ; 60 exactement passe)', async () => {
      const { transport, app } = await startFullApp()
      const token = await createAccount(transport, 'memory://sx3d-boot', 'bavard2')
      const s = connectAvecJeton(transport, 'memory://sx3d', token)
      await tick()
      joinHall(s)
      await tick()
      await s.request('lobby:enter', {})

      const deltas: any[] = []
      s.on('lobby:member', (p: any) => deltas.push(p))

      s.send('lobby:status', { status: 'free', text: 'x'.repeat(61) })
      await tick()
      assert.deepEqual(deltas, [], 'rejeté — rien diffusé')
      assert.equal(s.lastError.message, 'lobby-text-invalid')

      // borne INCLUSE — 60 exactement passe (et ne percute pas le débit statut : la tentative
      // rejetée ci-dessus n'a jamais posé dernierChangementStatutAt, cf. lobby.ts::lobby:status,
      // validation AVANT le contrôle de débit)
      s.send('lobby:status', { status: 'free', text: 'x'.repeat(60) })
      await tick()
      assert.equal(deltas.length, 1)
      assert.equal(deltas[0].text.length, 60)

      s.destroy(); await app.stop()
    })

    it("e. l'annonce d'un client ÉJECTÉ par sessionExclusive est retirée pour les autres (balayage)", async () => {
      const { transport, app } = await startFullApp({ sessionExclusive: true })
      const token    = await createAccount(transport, 'memory://sx3e-boot', 'annonceur1')
      const jetonObs = await createAccount(transport, 'memory://sx3e-bootObs', 'observateur1')

      const a   = connectAvecJeton(transport, 'memory://sx3e-a', token)
      const obs = connectAvecJeton(transport, 'memory://sx3e-obs', jetonObs)
      await tick()
      joinHall(a); joinHall(obs)
      await tick()
      await a.request('lobby:enter', {})
      await obs.request('lobby:enter', {})

      a.send('lobby:advertise', { title: 'Table ouverte' })
      await tick()

      const retraits: any[] = []
      obs.on('lobby:withdrawn', (p: any) => retraits.push(p))

      // éviction — connexion FRAÎCHE, MÊME token (B ne rejoint PAS le hall : l'identité doit devenir
      // structurellement ABSENTE du hall, pas juste déconnectée-puis-reconnectée dedans)
      const b = connectAvecJeton(transport, 'memory://sx3e-b', token)
      await tick()
      assert.equal(a.state, 'closed', 'A bien éjectée par sessionExclusive')

      await declencherBalayageLobby(transport)   // le retrait n'est jamais poussé en LIVE à l'éjection, seulement au balayage (cf. balayerHall)

      assert.equal(retraits.length, 1, "l'annonce de l'identité éjectée est bien retirée pour les autres membres du hall")

      a.destroy(); b.destroy(); obs.destroy(); await app.stop()
    })
  })

  describe('4. CSS à chaud (dev-only) — orthogonalité avec les paquets serveur (dist/ statique)', () => {
    it('dist/mjs-ws.js ne contient AUCUNE trace de µ._hotCss (mécanisme dev runtime/cli, jamais côté serveur)', function () {
      const distMjsWs = join(__dirname, '../dist/mjs-ws.js')
      if (!existsSync(distMjsWs)) { this.skip(); return }   // dist/ gitignored, non reconstruit ici (build:self interdit ici)
      const contenu = readFileSync(distMjsWs, 'utf8')
      assert.ok(!contenu.includes('_hotCss'), 'le rechargement CSS à chaud (commit 4cdc26e) est un mécanisme dev runtime/cli — jamais dans le bundle serveur mjs-ws')
    })

    it('dist/index.js contient bien µ._hotCss (bundler/cli)', function () {
      const distIndex = join(__dirname, '../dist/index.js')
      if (!existsSync(distIndex)) { this.skip(); return }
      const contenu = readFileSync(distIndex, 'utf8')
      assert.ok(contenu.includes('_hotCss'), 'µ._hotCss (commit 4cdc26e) doit être présent dans le bundle bundler/cli (dist/index.js)')
    })
  })
})
