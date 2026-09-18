// Tests mode ACTION de MJS-Server (game.ts/space.ts) — MÊME technique
// que tests/mjs-server-core.test.ts (VRAI client µ.socket, `new Function('µ', src)(stub)`,
// MemoryTransport). Jeu de référence : « mini-monde » déclaré ici (2 places/code privé, tick 20 Hz
// — rapide pour les tests —, 1 intention 'bouger' {dx,dy}, 1 move classique 'chat', vue filtrée par
// voisinage AoI + secret propre à chaque joueur). Couvre : boucle de tick (démarrage/arrêt/dt/
// slowTick), intentions en file (dernière gagne), coexistence avec les moves classiques, deltas par
// joueur (repli vue complète, zéro trame, taille), space.ts (Tchebychev), non-noyade de µpersist.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolveGameDef, createGame } from '../src/mjs-server/index.js'
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

// --- jeu de démo « mini-monde » — 2 places (code privé), entités sur une grille AoI (space cell=2),
// 1 intention 'bouger' {dx,dy} (dernière gagne), 1 move classique 'chat' (immédiat, hors boucle) ;
// vue filtrée par voisinage (space.query rayon 2) + secret PROPRE à chaque joueur (jamais celui d'un
// autre, cf. test m) — MÊME patron `overrides` que declarerMorpion (tests/mjs-server-core.test.ts).
function declarerMiniMonde(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  const { hooks: hooksOverride, ...autresOverrides } = overrides
  app.game('mini-monde', {
    seats: 2,
    code: true,
    tick: 20,
    seatTtl: 200,
    emptyTtl: 150,
    state: () => ({ entites: {}, dernierChat: null }),
    intents: {
      bouger: (game: any, player: any, p: any) => {
        const e = game.state.entites[player.id]
        if (!e) return
        e.x += p.dx; e.y += p.dy
        game.space?.set(player.id, e.x, e.y)
      },
    },
    moves: {
      chat: (game: any, player: any, p: any) => { game.state.dernierChat = { de: player.id, texte: p.texte }; return { ok: true } },
    },
    view: (game: any, player: any) => {
      if (!player) return { entites: {}, dernierChat: null }
      const moi = game.state.entites[player.id]
      const voisins = moi && game.space ? game.space.query(moi.x, moi.y, 2) : Object.keys(game.state.entites)
      const entites: any = {}
      for (const id of voisins) {
        const e = game.state.entites[id]
        if (!e) continue
        entites[id] = { x: e.x, y: e.y, nom: e.nom, couleur: e.couleur }   // champs PUBLICS statiques (jamais modifiés par 'bouger') — un déplacement ne touche QUE x/y
        if (id === player.id) entites[id].secret = e.secret   // UNIQUEMENT la sienne — jamais celle d'un autre (cf. test m)
      }
      return { entites, dernierChat: game.state.dernierChat }
    },
    space: { cell: 2 },
    ...autresOverrides,
    hooks: {
      onJoin: (game: any, player: any) => {
        game.state.entites[player.id] = { x: 0, y: 0, nom: 'joueur-'+ player.id, couleur: 'couleur-'+ player.id, secret: 'sec-'+ player.id }
        game.space?.set(player.id, 0, 0)
      },
      onLeave: (game: any, player: any) => { delete game.state.entites[player.id]; game.space?.remove(player.id) },
      ...hooksOverride,
    },
  })
}

/** mini-applicateur de delta ÉCRIT DANS LE TEST — préfigure le client :
 *  `vue` remplace tout, `delta` applique chaque op sur une copie locale reconstruite. */
function appliquerDelta(local: any, frame: any): any {
  if ('view' in frame) return JSON.parse(JSON.stringify(frame.view))
  const racine = local ?? {}
  for (const op of frame.delta) {
    const segments = op.p.split('.')
    const dernier = segments.pop()
    let noeud = racine
    for (const seg of segments) { if (!(seg in noeud)) noeud[seg] = {}; noeud = noeud[seg] }
    if ('x' in op) delete noeud[dernier]
    else noeud[dernier] = op.v
  }
  return racine
}

// --- tests e/l : mécaniques internes NON observables sur le fil (timers/space) — Partie construite
// et pilotée DIRECTEMENT, MÊME esprit que tests 11-13 de mjs-server-core.test.ts
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-'+ identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('MJS-Server — mode action (tick, intentions, deltas, zones d\'intérêt)', () => {
  it('a. tick>0 accepté, la boucle tourne : mutations rapprochées → au plus 1 diffusion PAR TICK (pas 1 par mutation)', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app)
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const etats: any[] = []
    sx.on('µgame:state', (p: any) => etats.push(p))
    // .request() — µgame:move est enregistré via app.serve() SEUL (jamais app.on()) : côté MJS-WS,
    // routeAppMessage n'invoque un handler serve() QUE si le message porte un id (cf. core.ts),
    // ce que seul .request() attache ; un .send() fire-and-forget y serait silencieusement AVALÉ
    for (let i = 0; i < 6; i++) await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0 } })
    await tick(110)   // ~2 périodes à 20Hz (50ms/tick)
    assert.ok(etats.length >= 1, 'au moins 1 diffusion doit avoir eu lieu')
    assert.ok(etats.length <= 3, `au plus ~2-3 diffusions sur 110ms à 20Hz (jamais 6, une par mutation), reçu ${etats.length}`)
    await app.stop()
  })

  it("b. intentions : 3 'bouger' rapprochés du même joueur → SEULE la dernière est appliquée au tick (pas cumulatif)", async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app)
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0 } })
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 0, dy: 1 } })
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 5, dy: 5 } })   // seule celle-ci doit compter — les 3 restent BIEN avant le prochain tick (50ms)
    await tick(70)   // > 1 période (50ms)
    const resync = await sx.request('µgame:resync', { game: rep.game })
    assert.equal(resync.view.entites.x.x, 5, "si les 3 s'étaient cumulées, x vaudrait 6")
    assert.equal(resync.view.entites.x.y, 5)
    await app.stop()
  })

  it('c. simulate reçoit un dt cohérent (~50ms à 20Hz, mesuré — pas la période nominale figée)', async () => {
    const { transport, app } = await startApp()
    const dts: number[] = []
    declarerMiniMonde(app, { simulate: (_partie: any, dt: number) => { dts.push(dt) } })
    const sx = await connecter(transport, 'x')
    await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(260)   // ~5 périodes
    assert.ok(dts.length >= 3, `attendu plusieurs ticks sur 260ms à 20Hz, reçu ${dts.length}`)
    for (const dt of dts) assert.ok(dt >= 25 && dt <= 100, `dt hors tolérance : ${dt}ms (attendu ~50ms)`)
    await app.stop()
  })

  it('d. moves classiques (chat) marchent en parallèle de la boucle — appliqués IMMÉDIATEMENT, hors tick', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app)
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const ack = await sx.request('µgame:move', { game: rep.game, move: 'chat', p: { texte: 'salut' } })
    assert.deepEqual(ack, { ok: true, result: { ok: true } })
    // AUCUN tick() entre l'ack et ce resync — la mutation doit déjà être visible SANS attendre la boucle
    const resyncImmediat = await sx.request('µgame:resync', { game: rep.game })
    assert.equal(resyncImmediat.view.dernierChat.texte, 'salut')
    await app.stop()
  })

  it('e. boucle de tick STOPPÉE (aucun setInterval résiduel) à la vidange, à .end() et à ._destroy()', () => {
    const def = resolveGameDef('te', { seats: 2, tick: 20, state: () => ({}), intents: { bouger: () => {} }, moves: {} })

    const p1 = createGame(fakeApp(), def, () => {}, 'pe1')
    assert.equal(p1._tickHandle, null, 'sanity : rien avant le 1er siège')
    const c1 = fakeClient('e1')
    p1._createSeat(c1)
    assert.notEqual(p1._tickHandle, null, 'la boucle démarre au 1er siège assis')
    p1._onDisconnect(c1)   // seul joueur, déconnecté → partie vide
    assert.equal(p1._tickHandle, null, 'coupée quand la partie se vide (aucun connecté)')
    p1._destroy()

    const p2 = createGame(fakeApp(), def, () => {}, 'pe2')
    p2._createSeat(fakeClient('e2'))
    assert.notEqual(p2._tickHandle, null)
    p2.end({ fin: true })
    assert.equal(p2._tickHandle, null, ".end() coupe la boucle même si le siège reste connecté")
    p2._destroy()

    const p3 = createGame(fakeApp(), def, () => {}, 'pe3')
    p3._createSeat(fakeClient('e3a')); p3._createSeat(fakeClient('e3b'))   // 2 connectés — la vidange seule ne se déclencherait pas
    assert.notEqual(p3._tickHandle, null)
    p3._destroy()
    assert.equal(p3._tickHandle, null, '_destroy() coupe la boucle inconditionnellement')
  })

  it("f. slowTick tire à SA propre cadence (indépendante de tick, nettement plus lente ici)", async () => {
    const { transport, app } = await startApp()
    let ticksVus = 0; let appelsLents = 0
    declarerMiniMonde(app, {
      simulate: () => { ticksVus++ },
      slowTick: { hz: 5, fn: () => { appelsLents++ } },   // 5Hz = 200ms/appel, contre tick=20Hz=50ms
    })
    const sx = await connecter(transport, 'x')
    await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(430)
    assert.ok(appelsLents >= 1 && appelsLents <= 4, `slowTick (5Hz) : attendu ~2 appels sur 430ms, reçu ${appelsLents}`)
    assert.ok(ticksVus > appelsLents * 1.5, `tick principal (20Hz, ${ticksVus}) doit être nettement plus fréquent que slowTick (${appelsLents})`)
    await app.stop()
  })

  it("g. deltas : la 2e diffusion porte un delta MINIMAL (1 entité déplacée → 1-2 ops), pas la vue entière", async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const so = await connecter(transport, 'o')   // 2e joueur — donne à la vue assez de « bulk » (2 entités) pour qu'un delta de 2 champs reste < 60%
    await so.request('µgame:play', { type: 'mini-monde', code: rep.code })
    const frames: any[] = []
    sx.on('µgame:state', (p: any) => frames.push(p))
    await tick(60)   // 1er tick — vue complète (repli 1re fois)
    assert.ok(frames.length >= 1)
    assert.ok('view' in frames[0] && !('delta' in frames[0]), 'la 1re diffusion doit être une vue complète')
    frames.length = 0
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 1 } })
    await tick(60)   // le(s) tick(s) suivant(s) appliquent + diffusent
    assert.ok(frames.length >= 1)
    const suivante = frames[frames.length - 1]
    assert.ok('delta' in suivante && !('view' in suivante), 'la diffusion suivante doit porter un delta, pas une vue complète')
    assert.ok(suivante.delta.length >= 1 && suivante.delta.length <= 2, `delta attendu minimal (1-2 ops pour 1 entité déplacée), reçu ${suivante.delta.length} : ${JSON.stringify(suivante.delta)}`)
    assert.ok(suivante.delta.every((op: any) => op.p.startsWith('entites.x.')), 'les chemins doivent cibler PRÉCISÉMENT entites.x.x / entites.x.y (jamais O, immobile)')
    await app.stop()
  })

  it('h. deltas : le tout premier envoi ET une réponse à µgame:resync sont TOUJOURS une vue complète', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const frames: any[] = []
    sx.on('µgame:state', (p: any) => frames.push(p))
    await tick(60)
    assert.ok(frames.length >= 1)
    assert.ok('view' in frames[0] && !('delta' in frames[0]), '1re diffusion = vue complète')
    const resync = await sx.request('µgame:resync', { game: rep.game })
    assert.ok('view' in resync && resync.view.entites, 'µgame:resync répond TOUJOURS une vue complète (jamais un delta)')
    await app.stop()
  })

  it('i. deltas : changement énorme (>~60% de la vue) → repli vue complète (pas de delta)', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, {
      deltas: true,
      moves: {
        chat: (game: any, player: any, p: any) => { game.state.dernierChat = { de: player.id, texte: p.texte } },
        metamorphose: (game: any) => {
          const gros: any = {}
          for (let i = 0; i < 10; i++) gros['nouveau'+ i] = { x: i, y: i, secret: 'valeur-assez-longue-repetee-'.repeat(3) }
          game.state.entites = gros   // remplace TOUT — l'ancienne entité 'x' disparaît aussi
        },
      },
    })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(60)   // 1re diffusion — vue complète (repli 1re fois), établit la baseline
    const frames: any[] = []
    sx.on('µgame:state', (p: any) => frames.push(p))
    await sx.request('µgame:move', { game: rep.game, move: 'metamorphose' })
    await tick(60)
    assert.ok(frames.length >= 1, 'la diffusion du tick suivant doit avoir eu lieu')
    const frame = frames[frames.length - 1]
    assert.ok('view' in frame && !('delta' in frame), 'changement énorme → repli vue complète, pas un delta')
    await app.stop()
  })

  it('j. deltas : rien ne change → AUCUNE trame émise pour ce round', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(60)   // 1er tick — vue complète (repli 1re fois), laisse passer
    const frames: any[] = []
    sx.on('µgame:state', (p: any) => frames.push(p))
    await tick(150)   // plusieurs ticks supplémentaires, RIEN ne bouge
    assert.equal(frames.length, 0, 'aucune mutation → aucune trame µgame:state, même après plusieurs ticks')
    await app.stop()
  })

  it('k. deltas et vue-complète appliqués côté test convergent vers le MÊME état (mini-applicateur préfigurant le client)', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const so = await connecter(transport, 'o')   // 2e joueur — assez de bulk pour que le flux contienne de VRAIS deltas (pas seulement des replis vue complète, cf. test g)
    await so.request('µgame:play', { type: 'mini-monde', code: rep.code })
    let local: any = null
    let vuDelta = false
    sx.on('µgame:state', (p: any) => { if ('delta' in p) vuDelta = true; local = appliquerDelta(local, p) })
    await tick(60)   // 1re diffusion (vue complète) — amorce `local`
    assert.ok(local, 'la 1re diffusion doit avoir amorcé la reconstruction locale')
    for (let i = 0; i < 4; i++) { await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0 } }); await tick(55) }
    assert.ok(vuDelta, 'sanity : au moins UNE trame du flux doit avoir été un VRAI delta (sinon le test ne prouve que le chemin vue complète)')
    const verite = await sx.request('µgame:resync', { game: rep.game })
    assert.deepEqual(local, verite.view, "l'état reconstruit à partir des deltas doit être identique à une vue complète fraîche")
    await app.stop()
  })

  it('l. space.query : voisinage correct (distance de Tchebychev), remove() retire bien l\'entité', () => {
    const def = resolveGameDef('tl', { seats: 1, state: () => ({}), moves: {}, space: { cell: 5 } })
    const game = createGame(fakeApp(), def, () => {}, 'pl')
    const space = game.space!
    space.set('a', 0, 0)
    space.set('b', 3, 3)     // Tchebychev(0,0→3,3) = 3
    space.set('c', 10, 10)   // bien plus loin
    space.set('d', -4, 2)    // Tchebychev(0,0→-4,2) = 4

    assert.deepEqual(space.query(0, 0, 3).sort(), ['a', 'b'], 'rayon 3 : a (0) et b (3) dedans, c et d dehors')
    assert.deepEqual(space.query(0, 0, 4).sort(), ['a', 'b', 'd'], 'rayon 4 : d (distance 4) entre aussi')

    space.remove('b')
    assert.deepEqual(space.query(0, 0, 3).sort(), ['a'], 'b retiré → absent de toute requête suivante')

    space.set('a', 20, 20)   // déplacement — doit quitter son ancienne cellule
    assert.deepEqual(space.query(0, 0, 3), [], 'a déplacé loin → ne doit plus apparaître près de (0,0)')
    assert.deepEqual(space.query(20, 20, 1), ['a'], 'a doit apparaître à sa NOUVELLE position')

    game._destroy()
  })

  it('m. deltas : le delta envoyé à X ne contient JAMAIS le champ secret de O', async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    const repX = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const so = await connecter(transport, 'o')
    await so.request('µgame:play', { type: 'mini-monde', code: repX.code })
    const framesX: any[] = []
    sx.on('µgame:state', (p: any) => framesX.push(p))
    await tick(60)   // 1re diffusion (vue complète) — la vue de X ne doit déjà contenir aucun secret de O
    for (const f of framesX) assert.ok(!JSON.stringify(f).includes('sec-o'), 'la vue initiale de X ne doit jamais contenir le secret de O')
    framesX.length = 0
    await so.request('µgame:move', { game: repX.game, move: 'chat', p: { texte: 'hop' } })   // change dernierChat (partagé) sans toucher aux positions
    await tick(60)
    assert.ok(framesX.length >= 1, 'X doit avoir reçu au moins une diffusion après le changement')
    for (const f of framesX) assert.ok(!JSON.stringify(f).includes('sec-o'), 'le delta envoyé à X ne doit jamais contenir le secret de O')
    await app.stop()
  })

  it('n. µpersist : pas noyé par la cadence de tick (nombre de save() borné par le débounce/plancher, PAS 1 par tick)', async () => {
    let appelsSave = 0
    const adapter = { load: async () => [], save: () => { appelsSave++ }, remove: () => {} }
    const { transport, app } = await startApp({ persist: { adapter, debounce: 30, snapshotEvery: 120 } })
    declarerMiniMonde(app, { simulate: (game: any) => { game.state.ticks = (game.state.ticks ?? 0) + 1 } })
    const sx = await connecter(transport, 'x')
    await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(520)   // ~10 ticks à 20Hz — simulate mute state.ticks à CHAQUE tick (mutation continue)
    await app.stop()   // rafale finale incluse — même celle-ci reste comptée dans la borne
    assert.ok(appelsSave >= 1, 'le plancher périodique (120ms) doit avoir sauvé au moins une fois sur 520ms')
    assert.ok(appelsSave < 10, `strictement moins que le nombre de ticks (10) — preuve que ce n'est PAS 1 save par tick, reçu ${appelsSave}`)
  })

  it("o. couture _ack : une intention numérotée (p._n) fait apparaître _ack = dernier _n appliqué, sur une trame DELTA", async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app, { deltas: true })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(60)   // 1re diffusion (vue complète, repli 1re fois) — laisse passer avant d'observer
    const etats: any[] = []
    sx.on('µgame:state', (p: any) => etats.push(p))
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0, _n: 3 } })
    await tick(70)
    assert.ok(etats.length >= 1, 'au moins une diffusion attendue après le move numéroté')
    assert.equal(etats[etats.length - 1]._ack, 3, "l'_ack doit refléter le dernier _n appliqué")
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0, _n: 7 } })
    await tick(70)
    assert.equal(etats[etats.length - 1]._ack, 7, "l'_ack doit avancer avec le _n suivant, jamais reculer")
    await app.stop()
  })

  it("p. couture _ack : sans _n dans p, _ack reste ABSENT de la trame (rétro-compat totale, vue complète)", async () => {
    const { transport, app } = await startApp()
    declarerMiniMonde(app)
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    const etats: any[] = []
    sx.on('µgame:state', (p: any) => etats.push(p))
    await sx.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, dy: 0 } })
    await tick(70)
    assert.ok(etats.length >= 1, 'au moins une diffusion attendue')
    for (const e of etats) assert.ok(!('_ack' in e), 'sans _n envoyé, _ack ne doit JAMAIS apparaître sur la trame')
    await app.stop()
  })

  it('q. robustesse boucle de tick : simulate async qui rejette est capturé en log error, la partie continue au tick suivant', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { transport, app } = await startApp({ onLog: (level: string, message: string) => logs.push({ level, message }) })
    let appels = 0
    declarerMiniMonde(app, { simulate: async () => { appels++; if (appels === 1) throw new Error('boom simulate') } })
    const sx = await connecter(transport, 'x')
    const rep = await sx.request('µgame:play', { type: 'mini-monde', code: true })
    await tick(150)   // ~3 périodes à 20Hz — laisse le rejet du 1er tick se propager (microtâche) et le(s) tick(s) suivant(s) s'exécuter
    const erreurs = logs.filter(l => l.level === 'error')
    assert.ok(erreurs.length >= 1, 'le rejet de simulate doit avoir été capturé et loggé en error')
    assert.ok(erreurs.some(e => e.message.includes('boucle de tick')), `le message doit mentionner boucle de tick, reçu : ${JSON.stringify(erreurs)}`)
    assert.ok(appels >= 2, `la partie doit continuer d'appeler simulate malgré l'échec du 1er tick, reçu ${appels} appel(s)`)
    const resync = await sx.request('µgame:resync', { game: rep.game })
    assert.ok(resync.view.entites, 'la partie doit rester vivante et interrogeable après le rejet, sans crash')
    await app.stop()
  })
})
