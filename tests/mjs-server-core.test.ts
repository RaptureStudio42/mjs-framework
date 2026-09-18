// Tests mécanique de jeu de MJS-Server (sièges/phases/tour/vues/journal/serialize) contre le VRAI
// client µ.socket, MÊME technique que tests/mjs-ws-core.test.ts (`new Function('µ', src)(stub)`,
// MemoryTransport). Jeu de référence : MORPION déclaré ici (places 2, phases attente/jeu/fin,
// turns roundrobin + timeout court, vue qui masque un champ privé par joueur). Tous les délais
// (seatTtl/emptyTtl/turns.timeout) sont volontairement COURTS pour des tests rapides.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolveGameDef, createGame, restoreGame } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { creerRegistre, defSchema, encode, decode } from '../src/schema/core.js'
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

// identité = hello.auth TEL QUEL par défaut (passe-plat) — chaque test connecte ses clients avec
// `auth: () => ({ id: 'x' })` côté µ.socket (cf. mjs-ws-core.test.ts test 15, MÊME idiome) : sans
// ce passe-plat serveur, `client.identity` resterait `undefined` et peerIdOf() replierait sur
// l'id de CONNEXION (change à chaque reconnexion) — resync/tour-par-identité ne marcheraient plus.
async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

// --- morpion de référence — places 2, code privé possible, phases/tour/vue filtrée ------------
// (state()/moves/view partagent `partie.state` non typé ici : tests, pas le framework — `any` partout)

function declarerMorpion(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  const { hooks: hooksOverride, ...autresOverrides } = overrides
  app.game('morpion', {
    seats: 2,
    code: true,
    seatTtl: 60,
    emptyTtl: 150,
    state: () => ({ grille: Array(9).fill(null), lettres: {}, secrets: {}, prets: {} }),
    moves: {
      pret: (game: any, player: any) => {
        game.state.prets[player.id] = true
        const assis = game.players.filter(Boolean).length
        if (assis === 2 && Object.keys(game.state.prets).length === 2) { game.to('jeu'); game.next() }
      },
      jouer: (game: any, player: any, p: any) => {
        if (game.state.grille[p.i] != null) throw new Error('case occupée')
        game.state.grille[p.i] = game.state.lettres[player.id]
        game.next()
      },
    },
    view: (game: any, player: any) => {
      const { secrets, ...pub } = game.state
      return { ...pub, monSecret: player ? secrets[player.id] : null }
    },
    phases: { attente: ['pret'], jeu: ['jouer'], fin: [] },
    turns: { order: 'roundrobin', timeout: 60 },
    ...autresOverrides,
    hooks: {
      onJoin: (game: any, player: any) => {
        const lettre = game.players.filter(Boolean).length === 1 ? 'X' : 'O'
        game.state.lettres[player.id] = lettre
        game.state.secrets[player.id] = 'secret-de-' + lettre
      },
      ...hooksOverride,
    },
  })
}

/** connecte 2 clients authentifiés (identités STABLES — requis pour resync), fait asseoir les 2
 *  via la file publique — X (siège 0) apprend son siège par la PUSH µgame:start (déjà en file
 *  quand O la complète), O (siège 1) l'apprend directement dans l'ack de sa propre requête. */
async function asseoirDeux(transport: MemoryTransport): Promise<{ sx: any; so: any; demarrageX: any; reponseO: any }> {
  const µx = makeClient(transport); const sx = µx.socket('memory://mx', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
  const µo = makeClient(transport); const so = µo.socket('memory://mo', { auth: () => ({ id: 'o' }), reconnect: { enabled: false } })
  sx.connect(); so.connect(); await tick()
  let demarrageX: any = null
  sx.on('µgame:start', (p: any) => { demarrageX = p })
  const repX = await sx.request('µgame:play', { type: 'morpion' })
  assert.deepEqual(repX, { queue: 1 })
  const reponseO = await so.request('µgame:play', { type: 'morpion' })
  await tick()
  return { sx, so, demarrageX, reponseO }
}

/** les 2 sièges disent 'pret' (phase attente → jeu, tour au siège 0) */
async function directeursPrets(sx: any, so: any, gameId: string): Promise<void> {
  await sx.request('µgame:move', { game: gameId, move: 'pret' })
  await so.request('µgame:move', { game: gameId, move: 'pret' })
  await tick()
}

// --- tests 11-13 : mécaniques internes NON observables sur le fil (journal/anti-abus/serialize)
// — Partie construite et pilotée DIRECTEMENT (createGame/_createSeat/_onMove), sans
// transport ni socket : même esprit que mjs-ws-core.test.ts test 16 (transport-espion direct pour
// une garde interne précise). `fakeApp()` : seul `.send()` est appelé par Game (diffusion), une
// app complète serait un mock inutilement lourd pour vérifier une mécanique interne.
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-' + identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('MJS-Server — cœur (sièges, phases, tour, vues, journal, serialize)', () => {
  it('1. appariement 2 joueurs : µgame:play ×2 → siège 0/1, vues initiales cohérentes, µgame:start reçu par le 1er', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { demarrageX, reponseO } = await asseoirDeux(transport)
    assert.equal(demarrageX.seat, 0)
    assert.equal(reponseO.seat, 1)
    assert.equal(demarrageX.game, reponseO.game)
    assert.equal(demarrageX.phase, 'attente')
    assert.equal(reponseO.phase, 'attente')
    assert.deepEqual(demarrageX.view.grille, Array(9).fill(null))
    await app.stop()
  })

  it("2. les 2 sièges disent 'pret' → phase 'jeu', tour au siège 0 (X)", async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    const etats: any[] = []
    sx.on('µgame:state', (p: any) => etats.push(p))
    await directeursPrets(sx, so, reponseO.game)
    const dernier = etats[etats.length - 1]
    assert.equal(dernier.phase, 'jeu')
    assert.equal(dernier.turn, 'x')   // identity.id du siège 0
    await app.stop()
  })

  it('3. coup valide → LES DEUX joueurs reçoivent leur propre vue (grille commune, secrets différents)', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    await directeursPrets(sx, so, reponseO.game)
    const vuesX: any[] = []; const vuesO: any[] = []
    sx.on('µgame:state', (p: any) => vuesX.push(p.view))
    so.on('µgame:state', (p: any) => vuesO.push(p.view))
    await sx.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 4 } })
    await tick()
    const dernierX = vuesX[vuesX.length - 1]; const dernierO = vuesO[vuesO.length - 1]
    assert.equal(dernierX.grille[4], 'X')
    assert.equal(dernierO.grille[4], 'X')   // grille PARTAGÉE — les deux la voient identique
    assert.notEqual(dernierX.monSecret, dernierO.monSecret)   // mais leur part privée diffère
    await app.stop()
  })

  it('4. coup hors tour refusé (ack erreur, aucun crash)', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    await directeursPrets(sx, so, reponseO.game)   // tour à X (siège 0)
    await assert.rejects(
      so.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 0 } }),
      (e: any) => /tour/i.test(e),
    )
    await app.stop()
  })

  it("5. coup interdit par la phase refusé ('jouer' avant les 2 'pret', encore en 'attente')", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerMorpion(app)
    const { sx, reponseO } = await asseoirDeux(transport)
    await assert.rejects(
      sx.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 0 } }),
      (e: any) => /phase/i.test(e),
    )
    await app.stop()
  })

  it("6. throw d'un move (case occupée) → refus ack propre, le serveur continue de répondre ensuite", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // throw INTENTIONNEL — pas de bruit
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    await directeursPrets(sx, so, reponseO.game)
    await sx.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 0 } })
    await tick()
    // tour passé à O — O rejoue la case 0 (déjà prise par X) : le THROW vient du move lui-même,
    // pas d'une garde (c'est bien SON tour) — exactement le cas « throw d'un move »
    await assert.rejects(
      so.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 0 } }),
      (e: any) => /occupée/i.test(e),
    )
    // preuve que rien n'a été emporté (process ni partie) : un coup valide APRÈS le throw aboutit, MÊME tour (le refus n'a pas consommé le tour de O)
    const ack = await so.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 1 } })
    assert.equal(ack.ok, true)
    await app.stop()
  })

  it("6b. robustesse — move ASYNC qui REJETTE → l'ack rejette proprement (SANS le fix, ça résolvait {ok:true,resultat:{}} au lieu de rejeter — preuve de régression)", async () => {
    const { transport, app } = await startApp({ onLog: () => {} })   // throw INTENTIONNEL — pas de bruit
    // phases: undefined désactive la restriction de phase (moves entièrement remplacé, pret/jouer
    // absents ici — inutile pour ce test, cf. commentaire de tête de declarerMorpion pour le patron)
    declarerMorpion(app, {
      phases: undefined,
      moves: { echoue: async () => { throw new Error('échec async attendu') } },
    })
    const { sx, reponseO } = await asseoirDeux(transport)
    await assert.rejects(
      sx.request('µgame:move', { game: reponseO.game, move: 'echoue' }),
      /échec async attendu/,
    )
    await app.stop()
  })

  it("6c. robustesse — move ASYNC qui RÉSOUT après un await → la VRAIE valeur de résolution atterrit dans resultat (SANS le fix, resultat valait {} — Promise non attendue sérialisée telle quelle)", async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app, {
      phases: undefined,
      moves: { calcule: async (_partie: any, _joueur: any, p: any) => { await tick(); return { double: p.n * 2 } } },
    })
    const { sx, reponseO } = await asseoirDeux(transport)
    const ack = await sx.request('µgame:move', { game: reponseO.game, move: 'calcule', p: { n: 21 } })
    assert.equal(ack.ok, true)
    assert.deepEqual(ack.result, { double: 42 }, 'la vraie valeur de résolution, jamais {}')
    await app.stop()
  })

  it('7. timeout de tour SANS onTurnTimeout → next() automatique (le tour avance tout seul)', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    const tours: string[] = []
    sx.on('µgame:state', (p: any) => tours.push(p.turn))
    await directeursPrets(sx, so, reponseO.game)   // tour = x (siège 0)
    assert.equal(tours[tours.length - 1], 'x')
    await tick(90)   // turns.timeout = 60ms — X ne joue JAMAIS
    assert.equal(tours[tours.length - 1], 'o', 'sans onTurnTimeout, le tour doit avoir tourné tout seul')
    await app.stop()
  })

  it('8. timeout de tour AVEC onTurnTimeout → le hook est appelé, PAS de next() automatique (celui-là appartient à l\'auteur)', async () => {
    const { transport, app } = await startApp()
    let appele = 0
    declarerMorpion(app, { hooks: { onTurnTimeout: (_game: any) => { appele++ } } })
    const { sx, so, reponseO } = await asseoirDeux(transport)
    const tours: string[] = []
    sx.on('µgame:state', (p: any) => tours.push(p.turn))
    await directeursPrets(sx, so, reponseO.game)
    await tick(90)
    assert.equal(appele, 1, 'onTurnTimeout doit avoir été appelé exactement une fois')
    assert.equal(tours[tours.length - 1], 'x', "le tour NE doit PAS avoir avancé tout seul : c'est à onTurnTimeout de décider")
    await app.stop()
  })

  it("9. état secret : la vue de X ne contient JAMAIS le champ privé de O (secrets absent, monSecret propre à chacun)", async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { demarrageX, reponseO } = await asseoirDeux(transport)
    assert.equal(demarrageX.view.secrets, undefined, "le champ brut 'secrets' (contient TOUS les joueurs) ne doit jamais fuiter dans une vue")
    assert.equal(reponseO.view.secrets, undefined)
    assert.equal(demarrageX.view.monSecret, 'secret-de-X')
    assert.equal(reponseO.view.monSecret, 'secret-de-O')
    assert.notEqual(demarrageX.view.monSecret, reponseO.view.monSecret)
    await app.stop()
  })

  it('10. next() fait tourner le tour entre les 2 sièges à chaque coup', async () => {
    const { transport, app } = await startApp()
    declarerMorpion(app)
    const { sx, so, reponseO } = await asseoirDeux(transport)
    await directeursPrets(sx, so, reponseO.game)
    const tours: string[] = []
    sx.on('µgame:state', (p: any) => tours.push(p.turn))
    await sx.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 0 } })
    await tick()
    assert.equal(tours[tours.length - 1], 'o')
    await so.request('µgame:move', { game: reponseO.game, move: 'jouer', p: { i: 1 } })
    await tick()
    assert.equal(tours[tours.length - 1], 'x')
    await app.stop()
  })

  it('11. journal borné à 200 entrées (les plus anciennes tombent, les coups restent tous appliqués)', () => {
    // limits.moves: null — ce test flood 250 coups SYNCHRONES (zéro temps réel écoulé) pour
    // vérifier le plafond du JOURNAL, rien à voir avec l'anti-abus : sans ce `null` explicite, le
    // quota anti-triche (défaut DEFAULT_MOVES_LIMIT = 30/s depuis ce durcissement, cf.
    // game.ts) ferait throw dès le 31e appel et casserait ce test — désactivé ICI en connaissance
    // de cause (cf. test 12 juste après, qui couvre lui le quota par défaut).
    const def = resolveGameDef('t11', { seats: 2, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, limits: { moves: null } })
    const game = createGame(fakeApp(), def, () => {}, 'p11')
    const c1 = fakeClient('j1')
    game._createSeat(c1); game._createSeat(fakeClient('j2'))
    for (let i = 0; i < 250; i++) game._onMove(c1, 'inc', {})
    assert.equal(game.journal.length, 200, 'journal plafonné à 200')
    assert.equal((game.state as { n: number }).n, 250, 'sanity : les 250 coups ont bien tous été appliqués, seul le JOURNAL est borné')
    game._destroy()
  })

  it('12. limites anti-abus (limits.moves) : flood → refus après N coups dans la fenêtre, état non muté par le refus', () => {
    const def = resolveGameDef('t12', {
      seats: 2, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
      limits: { moves: [3, 10000] },   // 3 coups max / 10s — largement plus lent que la boucle du test
    })
    const game = createGame(fakeApp(), def, () => {}, 'p12')
    const c1 = fakeClient('j1')
    game._createSeat(c1); game._createSeat(fakeClient('j2'))
    game._onMove(c1, 'inc', {})
    game._onMove(c1, 'inc', {})
    game._onMove(c1, 'inc', {})
    assert.throws(() => game._onMove(c1, 'inc', {}), /trop de coups/)
    assert.equal((game.state as { n: number }).n, 3, 'le 4e coup refusé ne doit PAS avoir muté l\'état')
    game._destroy()
  })

  it('12b. limites anti-abus : un nom de coup INEXISTANT entame quand même le seau (pas de contournement du quota par spam de coups invalides)', () => {
    const def = resolveGameDef('t12b', {
      seats: 2, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
      limits: { moves: [3, 10000] },   // 3 coups max / 10s
    })
    const game = createGame(fakeApp(), def, () => {}, 'p12b')
    const c1 = fakeClient('j1')
    game._createSeat(c1); game._createSeat(fakeClient('j2'))
    assert.throws(() => game._onMove(c1, 'nexistepas', {}), /coup inconnu/)
    assert.throws(() => game._onMove(c1, 'nexistepas', {}), /coup inconnu/)
    assert.throws(() => game._onMove(c1, 'nexistepas', {}), /coup inconnu/)
    // le seau est déjà VIDE après ces 3 noms invalides — un 4e appel, même avec un coup VALIDE, doit
    // être refusé pour quota et non pas exécuté (preuve que le jeton a bien été consommé plus haut)
    assert.throws(() => game._onMove(c1, 'inc', {}), /trop de coups/)
    assert.equal((game.state as { n: number }).n, 0, 'aucun coup valide n\'a pu s\'exécuter, le quota était déjà épuisé')
    game._destroy()
  })

  it('13. serialize()/restoreGame() aller-retour fidèle (état, phase, tour, sièges, journal, minuteries réarmées)', () => {
    const def = resolveGameDef('t13', {
      seats: 2, state: () => ({ n: 0 }),
      moves: { inc: (game: any) => { game.state.n++; game.next() } },
      phases: { a: ['inc'], b: [] },
      turns: { order: 'roundrobin', timeout: 5000 },
      timers: { peremption: () => {} },
    })
    const game = createGame(fakeApp(), def, () => {}, 'p13')
    const c1 = fakeClient('j1'); const c2 = fakeClient('j2')
    game._createSeat(c1); game._createSeat(c2)
    game.to('a')
    game.next()                          // tour → j1
    game._onMove(c1, 'inc', {})  // n=1, next() interne → tour → j2
    game.timer('peremption', 30000)

    const snap = game.serialize()
    const json = JSON.parse(JSON.stringify(snap))   // preuve JSON-able bout en bout, pas juste un objet JS pratique
    assert.equal(json.journal.length, 1)
    assert.equal(json.state.n, 1)
    assert.equal(json.phase, 'a')
    assert.equal(json.turn, 'j2')
    assert.equal(json.seats.length, 2)
    assert.ok(json.timers.some((m: any) => m.name === 'peremption'))
    assert.ok(json.timers.some((m: any) => m.name === 'µturn'), 'turns actif → la minuterie de tour tourne aussi')

    const restauree = restoreGame(fakeApp(), def, () => {}, json)
    assert.deepEqual(restauree.state, { n: 1 })
    assert.equal(restauree.phase, 'a')
    assert.equal(restauree.turn, 'j2')
    assert.equal(restauree.journal.length, 1)
    assert.equal(restauree.players.length, 2)
    assert.equal(restauree.players[0]!.id, 'j1')
    assert.equal(restauree.players[0]!.connected, false, 'personne rattaché tant que resync n\'a pas eu lieu')
    assert.equal(restauree.players[0]!.clients.size, 0)
    assert.ok(restauree._timers.has('peremption'), 'minuterie auteur RÉARMÉE par restoreGame')
    assert.ok(restauree._timers.has('µturn'), 'minuterie de tour RÉARMÉE elle aussi')

    game._destroy(); restauree._destroy()
  })

  // --- 13b-13d : .end() IDEMPOTENT (game.ts:402-408) — un
  // move métier qui rappelle game.end() (pattern resign/gameOver) avant que la grâce `emptyTtl`
  // ne détruise la partie ne doit REJOUER ni hooks.onEnd, ni la diffusion µgame:end, ni réarmer la
  // minuterie `µvide` (sinon partie maintenue vivante indéfiniment) — cf. `_ended` (game.ts).

  it("13b. .end() rejoué (move rappelant game.end() 2×) → onEnd 1×, µgame:end diffusé 1×, µvide PAS réarmée (destruction au terme du emptyTtl D'ORIGINE, pas repoussée)", async () => {
    let onEndAppele = 0
    const envois: string[] = []
    const app: any = { send: (_c: any, type: string) => { envois.push(type) } }
    const def = resolveGameDef('t13b', {
      seats: 1, state: () => ({}), limits: { moves: null }, emptyTtl: 60,
      moves: { finir: (game: any, player: any) => { game.end({ gagnant: player.id }) } },
      hooks: { onEnd: () => { onEndAppele++ } },
    })
    const game = createGame(app, def, () => {}, 'p13b')
    const c1 = fakeClient('j1')
    game._createSeat(c1)

    game._onMove(c1, 'finir', {})   // 1er end() — comportement normal
    await tick(30)                             // < emptyTtl (60ms) : encore dans la grâce
    assert.throws(() => game._onMove(c1, 'finir', {}), /termin/)   // 2e coup APRÈS .end() : refusé net (garde _ended de _onMove) — aucun rejeu de end(), aucune mutation

    assert.equal(onEndAppele, 1, 'onEnd ne doit être appelé QU\'UNE fois, jamais rejoué par un 2e end()')
    assert.equal(envois.filter(t => t === 'µgame:end').length, 1, 'µgame:end ne doit être diffusé QU\'UNE fois')
    assert.equal(game._destroyed, false, 'encore dans la fenêtre de grâce à ce stade (t≈30ms < emptyTtl 60ms)')

    // preuve que µvide n'a PAS été réarmée par le 2e end() : sans le fix, le 2e appel (à t≈30ms)
    // repousserait la destruction à t≈90ms — ICI on attend jusqu'à t≈75ms (> 60ms d'origine, mais
    // < 90ms qu'un réarmement aurait produit) et on vérifie que la partie est DÉJÀ détruite.
    await tick(45)
    assert.equal(game._destroyed, true, 'la partie doit avoir été détruite au terme du emptyTtl D\'ORIGINE (µvide non réarmée par le end() rejoué)')
  })

  it('13c. non-régression — end() unique : diffuse la fin, reste interrogeable pendant emptyTtl, puis détruite', async () => {
    let onEndAppele = 0
    const envois: string[] = []
    const app: any = { send: (_c: any, type: string) => { envois.push(type) } }
    const def = resolveGameDef('t13c', {
      seats: 1, state: () => ({}), limits: { moves: null }, emptyTtl: 50,
      moves: { finir: (game: any, player: any) => { game.end({ gagnant: player.id }) } },
      hooks: { onEnd: () => { onEndAppele++ } },
    })
    const game = createGame(app, def, () => {}, 'p13c')
    const c1 = fakeClient('j1')
    game._createSeat(c1)

    game._onMove(c1, 'finir', {})
    assert.equal(onEndAppele, 1)
    assert.equal(envois.filter(t => t === 'µgame:end').length, 1)
    assert.equal(game._destroyed, false, 'grâce emptyTtl : encore interrogeable juste après end()')
    assert.doesNotThrow(() => game.viewFor(game.players[0]), 'vueDe() ne throw pas pendant la grâce (partie encore interrogeable)')

    await tick(70)   // > emptyTtl (50ms)
    assert.equal(game._destroyed, true, 'détruite après la grâce, comportement normal inchangé')
  })

  it("13d. end() appelé APRÈS la destruction (post-emptyTtl) reste un no-op (comportement `_destroyed` existant intact)", async () => {
    let onEndAppele = 0
    const envois: string[] = []
    const app: any = { send: (_c: any, type: string) => { envois.push(type) } }
    const def = resolveGameDef('t13d', {
      seats: 1, state: () => ({}), limits: { moves: null }, emptyTtl: 30,
      moves: { finir: (game: any, player: any) => { game.end({ gagnant: player.id }) } },
      hooks: { onEnd: () => { onEndAppele++ } },
    })
    const game = createGame(app, def, () => {}, 'p13d')
    const c1 = fakeClient('j1')
    game._createSeat(c1)

    game._onMove(c1, 'finir', {})
    await tick(50)   // > emptyTtl (30ms) : détruite
    assert.equal(game._destroyed, true)
    assert.equal(onEndAppele, 1)

    assert.doesNotThrow(() => game.end({ gagnant: 'j1' }), 'end() post-destruction ne throw jamais')
    assert.equal(onEndAppele, 1, 'end() post-destruction reste un no-op — onEnd toujours à 1')
    assert.equal(envois.filter(t => t === 'µgame:end').length, 1, 'aucune diffusion supplémentaire post-destruction')
  })

  it("14. préfixe 'µgame:' réservé : app.serve()/app.on() d'un type interne par l'appli hôte → erreur claire", async () => {
    const { app } = await startApp()
    assert.throws(() => app.serve('µgame:play', () => {}), /préfixe réservé/i)
    assert.throws(() => app.on('µgame:autre-chose', () => {}), /préfixe réservé/i)
    // un type applicatif NORMAL reste libre — la garde ne vise QUE le préfixe réservé
    assert.doesNotThrow(() => app.serve('achat', () => 'ok'))
    await app.stop()
  })

  it("15. préfixe 'µgame:' réservé AUSSI aux schémas µschema — et la contre-preuve du danger", async () => {
    // CONTRE-PREUVE D'ABORD — sans cette garde, que se passe-t-il VRAIMENT ? On rejoue à la main ce
    // que ferait le moteur : un schéma déclaré sous 'µgame:state' + la trame telle que la construit
    // game.ts::_buildFrame (`view` est un OBJET). Si ce test ne voyait PAS la vue détruite, la garde
    // ci-dessous ne protégerait rien et le test serait aveugle.
    const registre = creerRegistre()
    const trame    = { game: 'g1', view: { hp: 100, gold: 42 }, phase: 'play', turn: 3, seq: 7 }
    defSchema(registre, 'µgame:state', { game: 'str8', view: 'str16', phase: 'str8', turn: 'u16', seq: 'u32' })
    const relu = decode(registre, encode(registre, 'µgame:state', trame)).objet
    assert.equal(relu.view, '[object Object]', 'CONTRE-PREUVE : la vue est DÉTRUITE en silence, aucune erreur levée')
    assert.equal(relu.turn, 3, 'CONTRE-PREUVE : le reste de la trame passe très bien — rien ne signale la perte')

    // la garde, aux deux portes
    assert.throws(() => mjsServer({ transport: new MemoryTransport(), schemas: { 'µgame:state': { seq: 'u32' } } }), /préfixe réservé/i, 'opts.schemas')
    const { app } = await startApp()
    assert.throws(() => app.schema('µgame:state', { seq: 'u32' }), /préfixe réservé/i, 'app.schema()')
    // un schéma applicatif NORMAL reste libre — la garde ne vise QUE le préfixe réservé
    assert.doesNotThrow(() => app.schema('chat:msg', { room: 'str8', n: 'u16' }))
    await app.stop()
  })
})
