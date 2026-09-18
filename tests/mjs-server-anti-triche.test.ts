// Tests anti-triche (socle, anti-cheat au maximum) — durcissement de
// l'intégrité de base du jeu, MÊME harnais que tests/mjs-server-core.test.ts et
// tests/mjs-server-matchmaking.test.ts (VRAI client µ.socket, `new Function('µ', src)(stub)`,
// MemoryTransport, + `fakeApp`/`fakeClient` pour les mécaniques internes non observables sur le
// fil, cf. tests/mjs-server-core.test.ts tests 11-13). Couvre 4 problèmes CONFIRMÉS et leurs
// correctifs :
//  1. dédup de siège par IDENTITÉ (game.ts::_createSeat) — 2 onglets d'une même identité ne
//     doivent JAMAIS produire 2 sièges dans la même partie (fuite d'état secret + tour par tour cassé).
//  2. idempotence de file (matchmaking.ts::playQueued) — un spam de µgame:play ne doit JAMAIS
//     produire plus d'UN ticket par identité (sièges fantômes, partie jamais vidée).
//  3. autorisation de coup (game.ts::_onMove) — le siège auteur vient TOUJOURS de la
//     CONNEXION, jamais d'un champ de la charge `p` (vérification — déjà correct par construction,
//     tests de non-régression ICI).
//  4. quota de coups PAR DÉFAUT (game.ts::DEFAULT_MOVES_LIMIT) — CHANGEMENT DE COMPORTEMENT
//     assumé : absence de `limits.moves` = 30 coups/s (avant : aucun quota) ; `null` explicite
//     désactive toujours le quota.
//  5. vue sûre par défaut (game.ts::resolveGameDef) — avertissement (jamais un échec) quand
//     def.view est absente sur un jeu à plusieurs sièges (fuite d'état complet silencieuse sinon).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolveGameDef, createGame } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp } from '../src/mjs-server/index.js'
import type { MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// identité = hello.auth TEL QUEL (passe-plat, cf. mjs-server-core.test.ts) — requis pour que
// peerIdOf() donne un id STABLE (le point même de ce fichier : dédup par identité)
async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

function connecter(transport: MemoryTransport, id: string): any {
  const µ = makeClient(transport)
  return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
}

// --- jeu de référence « duel » — places 2, code + file publique, 1 seul move 'inc' qui enregistre
// SON auteur (state.dernierAuteur, cf. section 3 « usurpation »), vue = état entier (public, aucun
// secret ici — la vue SÛRE PAR DÉFAUT est couverte à part, section 5, avec ses propres jeux ad hoc),
// tour par tour démarré dès les 2 sièges occupés (roundrobin) -----------------------------------
function declarerDuel(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  app.game('duel', {
    seats: 2,
    code: true,
    seatTtl: 60,
    emptyTtl: 150,
    state: () => ({ n: 0, dernierAuteur: null as string | null }),
    moves: { inc: (game: any, player: any) => { game.state.n++; game.state.dernierAuteur = player.id } },
    view: (game: any) => game.state,
    turns: { order: 'roundrobin', timeout: 5000 },
    hooks: {
      onJoin: (game: any) => { if (game.players.filter(Boolean).length === game.def.seats) game.next() },
    },
    ...overrides,
  })
}

// --- harnais DIRECT (sans transport) — MÊME patron que tests/mjs-server-core.test.ts tests 11-13,
// pour les mécaniques internes non observables sur le fil (quota par défaut) ---------------------
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-' + identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('MJS-Server — anti-triche (socle : dédup de siège, idempotence de file, autorisation de coup, quota par défaut, vue sûre)', () => {

  describe('1. dédup de siège par identité (game.ts::_createSeat)', () => {
    it('code privé : 2 onglets (2 connexions) de la MÊME identité → 1 seul siège, le 2e onglet est RÉATTACHÉ (pas un 2e siège)', async () => {
      const { transport, app } = await startApp()
      declarerDuel(app)
      const sA1 = connecter(transport, 'a'); sA1.connect(); await tick()
      const repA1 = await sA1.request('µgame:play', { type: 'duel', code: true })
      assert.equal(repA1.seat, 0)

      const sA2 = connecter(transport, 'a')   // MÊME identité 'a', 2e CONNEXION (pas un resync — un 2e µgame:play)
      sA2.connect(); await tick()
      const repA2 = await sA2.request('µgame:play', { type: 'duel', code: repA1.code })
      assert.equal(repA2.seat, 0, 'même identité → RÉATTACHÉ au siège 0, jamais un 2e siège')
      assert.equal(repA2.game, repA1.game)

      // preuve indirecte que le slot 1 est resté LIBRE (pas consommé par le 2e onglet) — une 3e
      // identité DISTINCTE rejoint et obtient bien le siège 1 (places=2 toujours respecté)
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      const repB = await sB.request('µgame:play', { type: 'duel', code: repA1.code })
      assert.equal(repB.seat, 1, 'siège 1 toujours libre : le 2e onglet de a n\'a PAS pris de siège')

      // les 2 onglets de 'a' voient bien le MÊME siège EN DIRECT : un move déclenché par le 2e
      // onglet (sA2) doit être diffusé aux DEUX connexions de 'a' (clients du MÊME MjsServerSeat)
      const etatsA1: any[] = []; const etatsA2: any[] = []
      sA1.on('µgame:state', (p: any) => etatsA1.push(p))
      sA2.on('µgame:state', (p: any) => etatsA2.push(p))
      await sA2.request('µgame:move', { game: repA1.game, move: 'inc' })
      await tick()
      assert.ok(etatsA1.length > 0, 'onglet 1 doit recevoir la diffusion déclenchée par onglet 2 (même siège)')
      assert.ok(etatsA2.length > 0)
      assert.equal(etatsA1[etatsA1.length - 1].view.n, 1)
      await app.stop()
    })

    it('2 IDENTITÉS distinctes par code → 2 sièges séparés (non-régression, jamais fusionnées)', async () => {
      const { transport, app } = await startApp()
      declarerDuel(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'duel', code: true })
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      const repB = await sB.request('µgame:play', { type: 'duel', code: repA.code })
      assert.equal(repA.seat, 0)
      assert.equal(repB.seat, 1)
      assert.notEqual(repA.seat, repB.seat)
      await app.stop()
    })

    it("file publique : une identité déjà ASSISE (via code) qui appelle play() SANS code → réattachée à SA partie, jamais un 2e ticket/2e siège", async () => {
      const { transport, app } = await startApp()
      declarerDuel(app)
      const sA1 = connecter(transport, 'a'); sA1.connect(); await tick()
      const repA1 = await sA1.request('µgame:play', { type: 'duel', code: true })   // A déjà assise (code) au siège 0
      const sA2 = connecter(transport, 'a')   // 2e onglet, MÊME identité
      sA2.connect(); await tick()
      const repA2 = await sA2.request('µgame:play', { type: 'duel' })   // file PUBLIQUE, sans code
      assert.equal(repA2.seat, 0, 'réattachée à SA partie existante (via code), pas un nouveau ticket de file')
      assert.equal(repA2.game, repA1.game)
      await app.stop()
    })
  })

  describe('2. idempotence de file (matchmaking.ts::playQueued — 1 ticket par identité, jamais N)', () => {
    it('un client qui play() ×5 avant appariement → 1 SEUL ticket en file (pas 5 sièges fantômes)', async () => {
      const { transport, app } = await startApp()
      declarerDuel(app)   // places 2, file PUBLIQUE (sans code)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const attentes: any[] = []
      for (let i = 0; i < 5; i++) attentes.push(await sA.request('µgame:play', { type: 'duel' }))
      for (const r of attentes) assert.deepEqual(r, { queue: 1 }, 'chaque appel répété doit renvoyer le MÊME état de file — jamais un 2e ticket')

      // si les 5 appels avaient créé 5 tickets fantômes, 'places' (2) aurait déjà été atteint par
      // 'a' SEULE (2 tickets fantômes suffiraient) — ici, il faut bien une IDENTITÉ DIFFÉRENTE
      // ('b') pour compléter le groupe à 2, preuve qu'il n'y avait qu'1 ticket réel
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      const repB = await sB.request('µgame:play', { type: 'duel' })
      assert.equal(repB.seat, 1)
      await app.stop()
    })

    it("_verifierVide s'arme normalement après le départ d'un client qui avait spammé play() (registre de file bien nettoyé, pas de fuite)", async () => {
      const { transport, app } = await startApp()
      declarerDuel(app, { emptyTtl: 60 })
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      for (let i = 0; i < 5; i++) await sA.request('µgame:play', { type: 'duel' })
      sA._mjs_ws.close(1006, 'départ après spam')
      await tick()
      // 'a' n'est plus en file (retiré à la déconnexion, cf. onClientDisconnect) — une NOUVELLE
      // connexion de la MÊME identité doit repartir de zéro (nouveau ticket, {attente:1}), pas
      // rester bloquée derrière une entrée fantôme jamais nettoyée
      const sA2 = connecter(transport, 'a'); sA2.connect(); await tick()
      const rep = await sA2.request('µgame:play', { type: 'duel' })
      assert.deepEqual(rep, { queue: 1 }, 'registre de file nettoyé à la déconnexion — pas de fantôme bloquant un nouveau ticket')
      await app.stop()
    })
  })

  describe("3. autorisation de coup (game.ts::_onMove — le siège auteur vient TOUJOURS de la CONNEXION, jamais de la charge)", () => {
    it('connexion NON assise → µgame:move rejeté clairement', async () => {
      const { transport, app } = await startApp({ onLog: () => {} })   // refus INTENTIONNEL — pas de bruit
      declarerDuel(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'duel', code: true })
      const sB = connecter(transport, 'b'); sB.connect(); await tick()   // B ne rejoint JAMAIS cette partie
      await assert.rejects(
        sB.request('µgame:move', { game: repA.game, move: 'inc' }),
        (e: any) => /pas assis/i.test(String(e)),
      )
      await app.stop()
    })

    it("hors tour → rejeté (seul le siège dont c'est le tour peut jouer)", async () => {
      const { transport, app } = await startApp({ onLog: () => {} })
      declarerDuel(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'duel', code: true })
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      await sB.request('µgame:play', { type: 'duel', code: repA.code })
      await tick()   // onJoin → .next() dès les 2 sièges complets → tour au siège 0 ('a')
      await assert.rejects(
        sB.request('µgame:move', { game: repA.game, move: 'inc' }),
        (e: any) => /tour/i.test(String(e)),
      )
      await app.stop()
    })

    it("usurpation de siège par la charge (p) → IMPOSSIBLE : l'auteur d'un coup vient TOUJOURS de la connexion, jamais d'un champ de p", async () => {
      const { transport, app } = await startApp({ onLog: () => {} })
      declarerDuel(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'duel', code: true })
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      await sB.request('µgame:play', { type: 'duel', code: repA.code })
      await tick()   // tour au siège 0 ('a')

      // B (siège 1, PAS son tour) tente de jouer en PRÉTENDANT être le siège 0 via la charge — ces
      // champs sont des données de jeu ORDINAIRES pour def.moves, jamais consultés par
      // _onMove pour déterminer l'auteur (cf. game.ts : joueur = _findSeatOf(client))
      await assert.rejects(
        sB.request('µgame:move', { game: repA.game, move: 'inc', p: { seat: 0, player: 'a', id: 'a' } }),
        (e: any) => /tour/i.test(String(e)),
        "la charge prétendant être le siège 0 doit être IGNORÉE — B reste B, toujours hors tour",
      )

      // preuve positive symétrique : A (siège 0, VRAIMENT son tour) joue avec une charge qui
      // prétend être B — le coup passe ET reste attribué au VRAI auteur (connexion de A)
      const etats: any[] = []
      sA.on('µgame:state', (p: any) => etats.push(p))
      const ack = await sA.request('µgame:move', { game: repA.game, move: 'inc', p: { seat: 1, player: 'b' } })
      assert.equal(ack.ok, true, "le VRAI auteur (connexion de A) doit pouvoir jouer sur SON tour, la charge falsifiée n'y change rien")
      await tick()
      const dernier = etats[etats.length - 1]
      assert.equal(dernier.view.dernierAuteur, 'a', "le VRAI auteur (a) doit être crédité — jamais 'b' malgré la charge falsifiée")
      await app.stop()
    })
  })

  describe('4. quota de coups PAR DÉFAUT (game.ts::DEFAULT_MOVES_LIMIT — CHANGEMENT DE COMPORTEMENT assumé)', () => {
    it("résolution : absence de limits.moves → défaut [30, 1000] (30 coups/s) ; null explicite → préservé (jamais réinterprété comme absent) ; tuple explicite → tel quel", () => {
      const parDefaut = resolveGameDef('quota-defaut', { seats: 2, state: () => ({}), moves: {} })
      assert.deepEqual(parDefaut.limits.moves, [30, 1000])

      const desactive = resolveGameDef('quota-null', { seats: 2, state: () => ({}), moves: {}, limits: { moves: null } })
      assert.equal(desactive.limits.moves, null, 'null explicite doit être PRÉSERVÉ — piège `??` qui le confondrait avec "absent"')

      const explicite = resolveGameDef('quota-explicite', { seats: 2, state: () => ({}), moves: {}, limits: { moves: [7, 5000] } })
      assert.deepEqual(explicite.limits.moves, [7, 5000])
    })

    it('validation : limits.moves malformé (ni tuple valide ni null) → erreur claire, jamais un crash de destructuration', () => {
      assert.throws(() => resolveGameDef('quota-bad1', { seats: 1, state: () => ({}), moves: {}, limits: { moves: [0, 100] as any } }), /limits\.moves doit être/)
      assert.throws(() => resolveGameDef('quota-bad2', { seats: 1, state: () => ({}), moves: {}, limits: { moves: 'x' as any } }), /limits\.moves doit être/)
    })

    it('sans déclarer limits : un flood de moves SYNCHRONES finit par être throttlé par le défaut (30/s), état non muté par les refus', () => {
      const def = resolveGameDef('quota-flood', { seats: 2, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'pq1')
      const c1 = fakeClient('j1')
      game._createSeat(c1); game._createSeat(fakeClient('j2'))
      let succes = 0; let throttle = false
      for (let i = 0; i < 60 && !throttle; i++) {
        try { game._onMove(c1, 'inc', {}); succes++ }
        catch (e) { throttle = true; assert.match(String(e), /trop de coups/) }
      }
      assert.ok(throttle, "un flood d'au moins 60 coups synchrones (bien au-delà de la capacité 30 du seau par défaut) doit finir par être throttlé — SANS que le jeu ait rien déclaré")
      assert.ok(succes <= 30, `pas plus que la capacité du seau (30) ne doit passer avant le 1er refus, reçu : ${succes}`)
      assert.equal(game.state.n, succes, "l'état ne doit pas avoir été muté par le(s) coup(s) refusé(s)")
      game._destroy()
    })

    it('limits:{moves:null} EXPLICITE → désactive le quota (aucun throttle, même en rafale)', () => {
      const def = resolveGameDef('quota-null-flood', { seats: 2, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, limits: { moves: null } })
      const game = createGame(fakeApp(), def, () => {}, 'pq2')
      const c1 = fakeClient('j1')
      game._createSeat(c1); game._createSeat(fakeClient('j2'))
      for (let i = 0; i < 100; i++) game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 100, 'aucun throttle : les 100 coups doivent tous être passés')
      game._destroy()
    })
  })

  describe('5. vue sûre par défaut (game.ts::resolveGameDef — avertissement SEUL, jamais un échec)', () => {
    it('app.game sans def.view sur un jeu à PLUSIEURS sièges → warn émis, contenu explicite', async () => {
      const logs: Array<{ level: string; message: string }> = []
      const { app } = await startApp({ onLog: (level: string, message: string) => logs.push({ level, message }) })
      app.game('sans-vue', { seats: 2, state: () => ({ secret: 42 }), moves: {} })
      // filtré sur le SUJET (« def.view absente ») et pas sur le simple niveau 'warn' : ces apps de
      // test fournissent `auth` sans `verifyOrigin`, ce qui déclenche légitimement l'avertissement
      // de configuration du volet ws — compter tous les warns confondrait les deux
      const avert = logs.filter(l => l.level === 'warn' && /def\.view absente/.test(l.message))
      assert.equal(avert.length, 1, 'exactement un avertissement attendu à la déclaration du jeu')
      assert.match(avert[0].message, /état COMPLET/)
      await app.stop()
    })

    it('app.game AVEC def.view déclarée → AUCUN avertissement', async () => {
      const logs: Array<{ level: string; message: string }> = []
      const { app } = await startApp({ onLog: (level: string, message: string) => logs.push({ level, message }) })
      app.game('avec-vue', { seats: 2, state: () => ({ secret: 42 }), moves: {}, view: () => ({ ok: true }) })
      assert.equal(logs.filter(l => l.level === 'warn' && /def\.view absente/.test(l.message)).length, 0)
      await app.stop()
    })

    it('places:1 (solo) sans def.view → PAS d\'avertissement (un seul siège, rien à cloisonner entre sièges)', async () => {
      const logs: Array<{ level: string; message: string }> = []
      const { app } = await startApp({ onLog: (level: string, message: string) => logs.push({ level, message }) })
      app.game('solo', { seats: 1, state: () => ({}), moves: {} })
      assert.equal(logs.filter(l => l.level === 'warn' && /def\.view absente/.test(l.message)).length, 0)
      await app.stop()
    })

    it("mode 'lockstep' sans def.view (interdit de toute façon) → PAS d'avertissement (aucun état serveur à masquer)", async () => {
      const logs: Array<{ level: string; message: string }> = []
      const { app } = await startApp({ onLog: (level: string, message: string) => logs.push({ level, message }) })
      app.game('lock', { mode: 'lockstep', seats: 2, tick: 10, moves: {} })
      assert.equal(logs.filter(l => l.level === 'warn' && /def\.view absente/.test(l.message)).length, 0)
      await app.stop()
    })

    it('resolveGameDef() appelée DIRECTEMENT sans logger → aucun throw (3e argument optionnel, no-op silencieux par défaut)', () => {
      assert.doesNotThrow(() => resolveGameDef('direct', { seats: 2, state: () => ({}), moves: {} }))
    })
  })
})
