// Tests mode 'lockstep' de MJS-Server (game.ts/lockstep.ts/matchmaking.ts, « netcode ») —
// MÊME technique que tests/mjs-server-action.test.ts (VRAI client µ.socket, `new
// Function('µ', src)(stub)`, MemoryTransport). Couvre : liste FERMÉE d'interdits (state/view/deltas/
// intents/simulate/space/history, onDivergence hors lockstep), tick>0 requis, un ordre → diffusé à TOUS
// groupé par tick, plusieurs ordres rapprochés groupés dans LE MÊME tick, graine déterministe (pure +
// observée sur le fil), journal d'ordres qui grandit et se rejoue intégralement (µgame:resync),
// divergence PAR QUORUM anti-triche (hash minoritaire face à la majorité absolue identifié
// suspect + event+hook ; hashs égaux → silence) — cf. tests/mjs-server-lockstep-anti-triche.test.ts
// pour l'auto-contradiction, la fenêtre bornée et le cas N pair scindé 50/50.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolveGameDef, deterministicSeed } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'

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

async function startApp(opts: MjsServerOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

async function connecter(transport: MemoryTransport, id: string): Promise<any> {
  const µ = makeClient(transport)
  const s = µ.socket('memory://'+ id, { auth: () => ({ id }), reconnect: { enabled: false } })
  s.connect(); await tick()
  return s
}

// client CÔTÉ mjs_lockstep.ts (journal tronqué au resync) — mjs_socket.ts + mjs_game.ts +
// mjs_det.ts + mjs_lockstep.ts CONCATÉNÉS, MÊME patron que tests/socket-lockstep.test.ts (µ.lockstep posé
// sur CE µ-là, propre à chaque client) — makeClient()/connecter() ci-dessus restent volontairement
// SOCKET SEUL (mjs_socket.ts uniquement), inchangés, pour ne rien risquer sur les tests a-j existants.
const lockstepClientSrc = ['mjs_socket.ts', 'mjs_game.ts', 'mjs_det.ts', 'mjs_lockstep.ts']
  .map(f => readFileSync(join(__dirname, '../src/runtime/'+ f), 'utf8'))
  .join('\n')

// `erreurs` capture les µ.error(msg) — permet d'affirmer le log français explicite SANS dépendre de la
// console réelle (même esprit que µ.warn/µ.log stubbés plus haut)
function makeMuLockstep(erreurs: string[]): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: (msg: string) => erreurs.push(String(msg)), warn: () => {}, log: () => {} }
  new Function('µ', lockstepClientSrc)(µ)
  return µ
}

async function connecterAvecMuLockstep(transport: MemoryTransport, id: string, erreurs: string[]): Promise<{ µ: any; sock: any }> {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  const µ = makeMuLockstep(erreurs)
  const sock = µ.socket('memory://'+ id, { auth: () => ({ id }), reconnect: { enabled: false } })
  sock.connect(); await tick()
  return { µ, sock }
}

// jeu de démo « duel-lockstep » — 2 places (code privé), tick RAPIDE (40Hz/25ms) ; `moves: {}` requis
// par le type mais JAMAIS invoqué en lockstep (aucune whitelist de noms de coup demandée)
function declarerJeuLockstep(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  app.game('duel-lockstep', { mode: 'lockstep', seats: 2, code: true, tick: 40, seatTtl: 300, emptyTtl: 200, moves: {}, ...overrides })
}

async function deuxJoueurs(app: MjsServerApp, transport: MemoryTransport): Promise<{ sx: any; sy: any; rep: any }> {
  const sx = await connecter(transport, 'x')
  const rep = await sx.request('µgame:play', { type: 'duel-lockstep', code: true })
  const sy = await connecter(transport, 'y')
  await sy.request('µgame:play', { type: 'duel-lockstep', code: rep.code })
  return { sx, sy, rep }
}

describe("MJS-Server — mode 'lockstep' déterministe", () => {
  it('a. liste FERMÉE d\'interdits : state/view/deltas/intents/simulate/space/history lèvent en lockstep ; onDivergence lève HORS lockstep', () => {
    const base = { mode: 'lockstep' as const, seats: 2, tick: 20, moves: {} }
    assert.throws(() => resolveGameDef('t1', { ...base, state: () => ({}) } as any), /state interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t2', { ...base, view: () => ({}) } as any), /view interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t3', { ...base, deltas: true } as any), /deltas interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t4', { ...base, intents: { x: () => {} } } as any), /intents interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t5', { ...base, simulate: () => {} } as any), /simulate interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t6', { ...base, space: { cell: 1 } } as any), /space interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t7', { ...base, history: { ticks: 5 } } as any), /history interdit en mode 'lockstep'/)
    assert.throws(() => resolveGameDef('t8', { seats: 2, tick: 0, moves: {}, state: () => ({}), onDivergence: () => {} } as any), /onDivergence nécessite mode: 'lockstep'/)
    assert.doesNotThrow(() => resolveGameDef('ok', base as any))
  })

  it('b. mode lockstep exige tick > 0 (cadence de regroupement des ordres)', () => {
    assert.throws(() => resolveGameDef('t', { mode: 'lockstep', seats: 2, moves: {} } as any), /tick doit être > 0 en mode 'lockstep'/)
    assert.doesNotThrow(() => resolveGameDef('t2', { mode: 'lockstep', seats: 2, tick: 10, moves: {} } as any))
  })

  it('c. un ordre reçu (µgame:move) devient un ORDRE (jamais exécuté) — diffusé à TOUS (µgame:orders) groupé par tick, MÊME trame pour les deux joueurs', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { sx, sy, rep } = await deuxJoueurs(app, transport)
    const ordresX: any[] = [], ordresY: any[] = []
    sx.on('µgame:orders', (p: any) => ordresX.push(p))
    sy.on('µgame:orders', (p: any) => ordresY.push(p))
    const ack = await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1 } })
    assert.equal(ack.ok, true)
    assert.equal(ack.result, undefined, 'jamais exécuté côté serveur — aucun résultat')
    await tick(90)
    const trouveX = ordresX.find(o => o.orders.length > 0)
    assert.ok(trouveX, 'un tick contenant l\'ordre doit être diffusé')
    assert.deepEqual(trouveX.orders, [{ player: 'x', move: 'bouger', p: { dx: 1 } }])
    const trouveY = ordresY.find(o => o.tick === trouveX.tick)
    assert.deepEqual(trouveY, trouveX, 'MÊME trame pour les deux joueurs — l\'égalité d\'entrée est le cœur du déterminisme')
    await app.stop()
  })

  it('d. plusieurs ordres rapprochés (envoyés avant la clôture du tick courant) sont GROUPÉS dans UNE seule trame µgame:orders', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { sx, sy, rep } = await deuxJoueurs(app, transport)
    const recus: any[] = []
    sx.on('µgame:orders', (p: any) => recus.push(p))
    const p1 = sx.request('µgame:move', { game: rep.game, move: 'a', p: null })
    const p2 = sy.request('µgame:move', { game: rep.game, move: 'b', p: null })
    await Promise.all([p1, p2])
    await tick(90)
    const avecOrdres = recus.filter(r => r.orders.length > 0)
    assert.equal(avecOrdres.length, 1, 'les 2 ordres doivent atterrir dans le MÊME tick')
    assert.equal(avecOrdres[0].orders.length, 2)
    await app.stop()
  })

  it('e. graine déterministe : même id de partie ⇒ même seed TOUJOURS (pure) ; observée identique sur le fil pour les DEUX sièges de la MÊME partie', async () => {
    assert.equal(deterministicSeed('partie1'), deterministicSeed('partie1'))
    assert.notEqual(deterministicSeed('partie1'), deterministicSeed('partie2'))
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'duel-lockstep', code: true })
    assert.equal(typeof rep.seed, 'number')
    assert.equal(rep.seed, deterministicSeed(rep.game))
    const sy = await connecter(transport, 'y')
    const rep2 = await sy.request('µgame:play', { type: 'duel-lockstep', code: rep.code })
    assert.equal(rep2.seed, rep.seed, 'même partie ⇒ même seed pour les deux sièges')
    await app.stop()
  })

  it('f. le journal d\'ordres grandit à chaque tick (même vide) et se rejoue INTÉGRALEMENT à la reconnexion (µgame:resync)', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const { sx, rep } = await deuxJoueurs(app, transport)
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1 } })
    await tick(90)
    const resyncRep = await sx.request('µgame:resync', { game: rep.game })
    assert.equal(resyncRep.seed, rep.seed)
    assert.ok(Array.isArray(resyncRep.journal) && resyncRep.journal.length >= 2, 'plusieurs ticks journalisés, même vides')
    const tousLesOrdres = resyncRep.journal.flatMap((g: any) => g.orders)
    assert.ok(tousLesOrdres.some((o: any) => o.move === 'bouger' && o.player === 'x'))
    await app.stop()
  })

  it("g. divergence par QUORUM (anti-triche) : 3 sièges, 2 hash CONCORDANTS + 1 DIFFÉRENT au même tick → µgame:event 'divergence' {tick, suspects:[siège minoritaire], raison:'quorum'} à tous + def.onDivergence — jamais la majorité honnête blâmée. ADAPTÉ au modèle quorum (cf. lockstep.ts) : l'ANCIEN test (2 sièges, hashs différents) supposait « 1er hash = référence », un modèle EMPOISONNABLE par un seul siège — remplacé par receiveHash(joueur, tick, h, sieges) avec majorité ABSOLUE floor(N/2)+1 ; à N=2, un désaccord 1 contre 1 n'atteint JAMAIS floor(2/2)+1=2 (tie structurellement indécidable, cf. tête de fichier lockstep.ts) — d'où 3 sièges ICI pour qu'une vraie majorité existe, cf. test dédié plus bas (tests/mjs-server-lockstep-anti-triche.test.ts) pour le cas N=2 qui ne déclenche RIEN.", async () => {
    const { transport, app } = await startApp()
    const divergences: any[] = []
    declarerJeuLockstep(app, { seats: 3, onDivergence: (_partie: any, info: any) => divergences.push(info) })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'duel-lockstep', code: true })
    const sy = await connecter(transport, 'y')
    await sy.request('µgame:play', { type: 'duel-lockstep', code: rep.code })
    const sz = await connecter(transport, 'z')
    await sz.request('µgame:play', { type: 'duel-lockstep', code: rep.code })
    const eventsX: any[] = []
    sx.on('µgame:event', (p: any) => eventsX.push(p))
    // tick=1 (PAS 5) : à cet instant du test, le serveur vient tout juste de démarrer sa boucle
    // 40Hz — le tout 1er tick (25ms) n'a pas encore clos (tickCompte serveur ENCORE à 0), cf.
    // lockstep.ts DELAI_AVANT_TICKS=4 (fenêtre anti-triche) : un tick 5 serait REJETÉ
    // d'emblée (hors petite marge avant), symptôme constaté à l'exécution — PAS un souci de logique
    // quorum, juste un choix de tick à revoir avec la fenêtre bornée désormais en place.
    sx.send('µgame:hash', { game: rep.game, tick: 1, h: 'aaa' })
    sy.send('µgame:hash', { game: rep.game, tick: 1, h: 'aaa' })
    sz.send('µgame:hash', { game: rep.game, tick: 1, h: 'bbb' })
    await tick(30)
    assert.equal(divergences.length, 1, 'un seul signalement pour ce tick')
    assert.equal(divergences[0].tick, 1)
    assert.deepEqual(divergences[0].suspects, ['z'], 'le siège MINORITAIRE identifié — jamais x/y (majorité honnête)')
    assert.equal(divergences[0].reason, 'quorum')
    assert.ok(eventsX.some(e => e.type === 'divergence' && e.p.tick === 1 && e.p.suspects?.includes('z')))
    await app.stop()
  })

  it('h. hashs CONCORDANTS au même tick → silence (aucun événement, aucun onDivergence)', async () => {
    const { transport, app } = await startApp()
    const divergences: any[] = []
    declarerJeuLockstep(app, { onDivergence: (_partie: any, info: any) => divergences.push(info) })
    const { sx, sy, rep } = await deuxJoueurs(app, transport)
    const eventsX: any[] = []
    sx.on('µgame:event', (p: any) => eventsX.push(p))
    sx.send('µgame:hash', { game: rep.game, tick: 7, h: 'pareil' })
    sy.send('µgame:hash', { game: rep.game, tick: 7, h: 'pareil' })
    await tick(30)
    assert.equal(divergences.length, 0)
    assert.equal(eventsX.filter(e => e.type === 'divergence').length, 0)
    await app.stop()
  })

  it('i. lockstepJournal:{maxTicks:2} (opt-in, cf. game.ts) plafonne le journal en ANNEAU — µgame:resync ne renvoie jamais plus que les 2 DERNIERS ticks, même largement après leur clôture', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app, { lockstepJournal: { maxTicks: 2 } })
    const { sx, rep } = await deuxJoueurs(app, transport)
    await tick(200)   // 40Hz/25ms — largement plus de 2 ticks clos, preuve que l'anneau évince bien
    const resyncRep = await sx.request('µgame:resync', { game: rep.game })
    assert.equal(resyncRep.journal.length, 2, 'jamais plus que maxTicks, quel que soit le nombre de ticks réellement écoulés')
    const ticks = resyncRep.journal.map((g: any) => g.tick)
    assert.ok(ticks[1] > ticks[0], 'les 2 entrées retenues sont bien les 2 DERNIERS ticks (contigus, ordre croissant)')
    await app.stop()
  })

  it("j. lockstepJournal : validation — nécessite mode 'lockstep', maxTicks doit être un entier ≥ 1", () => {
    assert.throws(() => resolveGameDef('tj1', { seats: 2, tick: 0, moves: {}, state: () => ({}), lockstepJournal: { maxTicks: 5 } } as any), /lockstepJournal nécessite mode: 'lockstep'/)
    const base = { mode: 'lockstep' as const, seats: 2, tick: 20, moves: {} }
    assert.throws(() => resolveGameDef('tj2', { ...base, lockstepJournal: { maxTicks: 0 } } as any), /lockstepJournal\.maxTicks doit être un entier ≥ 1/)
    assert.throws(() => resolveGameDef('tj3', { ...base, lockstepJournal: { maxTicks: 1.5 } } as any), /lockstepJournal\.maxTicks doit être un entier ≥ 1/)
    assert.throws(() => resolveGameDef('tj4', { ...base, lockstepJournal: { maxTicks: -1 } } as any), /lockstepJournal\.maxTicks doit être un entier ≥ 1/)
    assert.doesNotThrow(() => resolveGameDef('tj5', { ...base, lockstepJournal: { maxTicks: 5 } } as any))
  })
})

describe("mjs_lockstep.ts CLIENT — journal TRONQUÉ au resync détecté", () => {
  it("k. maxTicks petit + client en retard : le journal reçu au resync ne commence plus au tick 1 (tête tronquée) — log français explicite + événement client 'divergence' {raison:'journal-truncated'}, le replay continue", async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app, { lockstepJournal: { maxTicks: 2 } })
    const erreursX: string[] = []
    const { µ: µx, sock: sockx } = await connecterAvecMuLockstep(transport, 'x', erreursX)
    const partieX = sockx.game('duel-lockstep', { code: true })
    const etatX = µx.lockstep(partieX, { state0: () => ({ compte: 0 }), apply: (etat: any, ordre: any) => { if (ordre.move === 'ajouter') etat.compte += ordre.p.n } })
    await tick(30)
    const code = partieX.state.code
    const sy = await connecter(transport, 'y')
    await sy.request('µgame:play', { type: 'duel-lockstep', code })
    await tick(200)   // 40Hz/25ms — largement plus de 2 ticks clos, l'anneau maxTicks:2 a purgé la tête (cf. test i)
    const eventsX: any[] = []
    partieX.on('event', (f: any) => eventsX.push(f))
    await sockx._mjs_resyncGame(partieX)   // MÊME accès `_`-préfixé volontaire que tests/socket-lockstep.test.ts (test e)
    await tick(60)
    assert.ok(erreursX.some(m => /journal tronqué/.test(m) && /resync déterministe impossible/.test(m)), 'log français explicite, ticks mentionnés')
    assert.ok(eventsX.some(e => e.type === 'divergence' && e.p.reason === 'journal-truncated'), "événement client 'divergence' raison journal_tronque")
    assert.equal(typeof etatX.compte, 'number', 'le replay continue malgré le journal tronqué — comportement actuel préservé')
    await app.stop()
  })

  it('l. partie neuve, resync COMPLET (journal depuis le tick 1, aucun trou) : AUCUN signalement — non-régression stricte', async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const erreursX: string[] = []
    const { µ: µx, sock: sockx } = await connecterAvecMuLockstep(transport, 'x', erreursX)
    const partieX = sockx.game('duel-lockstep', { code: true })
    µx.lockstep(partieX, { state0: () => ({ compte: 0 }), apply: (etat: any, ordre: any) => { if (ordre.move === 'ajouter') etat.compte += ordre.p.n } })
    await tick(30)
    const code = partieX.state.code
    const sy = await connecter(transport, 'y')
    await sy.request('µgame:play', { type: 'duel-lockstep', code })
    await partieX.move('ajouter', { n: 3 })
    await tick(90)
    const eventsX: any[] = []
    partieX.on('event', (f: any) => eventsX.push(f))
    await sockx._mjs_resyncGame(partieX)
    await tick(60)
    assert.equal(erreursX.length, 0, 'aucun log — journal complet depuis le tick 1')
    assert.equal(eventsX.filter(e => e.type === 'divergence' && e.p.reason === 'journal-truncated').length, 0, 'aucun événement client — journal vide au départ ou complet = chemin nominal')
    await app.stop()
  })

  it("m. trou artificiel au milieu du journal (tick 1 → tick 3, saut de 2 — jamais produit par le vrai serveur, closeTick incrémente TOUJOURS de 1, cf. lockstep.ts : filet défensif exercé directement) → détecté", async () => {
    const { transport, app } = await startApp()
    declarerJeuLockstep(app)
    const erreursX: string[] = []
    const { µ: µx, sock: sockx } = await connecterAvecMuLockstep(transport, 'x', erreursX)
    const partieX = sockx.game('duel-lockstep', { code: true })
    µx.lockstep(partieX, { state0: () => ({ compte: 0 }), apply: () => {} })
    await tick(30)
    const eventsX: any[] = []
    partieX.on('event', (f: any) => eventsX.push(f))
    // trou FABRIQUÉ — exercé directement via le canal 'state' (MÊME chemin qu'un vrai µgame:resync, cf.
    // mjs_lockstep.ts::_mjlockstepReinit), accès `_mjs_handlers` `_`-préfixé volontaire (même esprit que
    // sockx._mjs_resyncGame ailleurs dans ce fichier)
    const frameTroue = { seed: 42, journal: [{ tick: 1, orders: [] }, { tick: 3, orders: [] }], game: partieX.state.gameId, phase: null, turn: null, seq: 999 }
    ;((partieX._mjs_handlers['state'] as any[]) || []).slice().forEach((fn: any) => fn(frameTroue))
    await tick(10)
    assert.ok(erreursX.some(m => /journal tronqué/.test(m) && /tick 3/.test(m)), 'log mentionne le tick concerné')
    assert.ok(eventsX.some(e => e.type === 'divergence' && e.p.reason === 'journal-truncated' && e.p.tick === 3 && e.p.expected === 2), 'anomalie localisée au bon tick')
    await app.stop()
  })
})
