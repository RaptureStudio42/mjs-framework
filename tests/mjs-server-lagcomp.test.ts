// Tests compensation de lag SERVEUR (netcode) — history.ts (tampon circulaire) +
// game.rewind/timeSeenBy (game.ts). MÊME esprit que les tests e/l de mjs-server-action.test.ts :
// Partie construite et pilotée DIRECTEMENT (resolveGameDef + createGame + fakeApp/fakeClient) — AUCUNE
// trame sur le fil pour history/rewind (le JEU les appelle lui-même depuis ses propres intents, ex.
// 'tirer'), donc pas besoin du harnais socket complet. Ticks poussés À LA MAIN (_runTick()),
// espacés de petits `await tick(ms)` RÉELS pour obtenir des horodatages distincts et déterministes.
import assert from 'node:assert/strict'
import { resolveGameDef, createGame } from '../src/mjs-server/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// --- MÊMES fakes que tests/mjs-server-action.test.ts (tests e/l) — app/client minimaux, aucun socket ---
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-'+ identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('MJS-Server — compensation de lag (history, rewind, timeSeenBy)', () => {
  it('a. l\'anneau se remplit et écrase circulairement (taille bornée à def.history.ticks)', async () => {
    const def = resolveGameDef('lag-a', {
      seats: 1, tick: 20, moves: {},
      state: () => ({ entites: { c: { x: 0, y: 0 } } }),
      simulate: (game: any) => { game.state.entites.c.x += 1 },
      history: { ticks: 3, extract: (game: any) => ({ c: { x: game.state.entites.c.x, y: 0 } }) },
    })
    const game = createGame(fakeApp(), def, () => {}, 'pa')
    for (let i = 0; i < 7; i++) { game._runTick(); await tick(5) }
    const dernierTick = game.rewind(Date.now(), (_positions: any, meta: any) => meta.tick)
    assert.equal(dernierTick, 7, 'sanity : le dernier tick poussé est bien le 7e')
    const plusVieuxDispo = game.rewind(0, (_positions: any, meta: any) => meta.tick)
    assert.equal(plusVieuxDispo, 5, 'anneau de taille 3 après 7 ticks → seules les entrées 5,6,7 survivent (1-4 écrasées)')
    game._destroy()
  })

  it('b. rewind(instant précis) retrouve la position d\'IL Y A n ticks, pas la courante (mouvement linéaire)', async () => {
    const def = resolveGameDef('lag-b', {
      seats: 1, tick: 20, moves: {},
      state: () => ({ entites: { c: { x: 0, y: 0 } } }),
      simulate: (game: any) => { game.state.entites.c.x += 10 },
      history: { ticks: 20, extract: (game: any) => ({ c: { x: game.state.entites.c.x, y: 0 } }) },
    })
    const game = createGame(fakeApp(), def, () => {}, 'pb')
    const horodatages: number[] = []
    for (let i = 0; i < 6; i++) { game._runTick(); horodatages.push(Date.now()); await tick(8) }
    assert.equal(game.state.entites.c.x, 60, 'sanity : la position courante a bien avancé (6 × 10)')
    const positionFigée = game.rewind(horodatages[2], (positions: any) => positions.c.x)
    assert.equal(positionFigée, 30, 'rewind à l\'instant du 3e tick doit retrouver x=30, pas x=60 (position courante)')
    game._destroy()
  })

  it('c. bornes : instant trop ancien → plus vieille entrée dispo (écart signalé) ; instant futur → entrée courante', async () => {
    const def = resolveGameDef('lag-c', {
      seats: 1, tick: 20, moves: {},
      state: () => ({ entites: { cible: { x: 0, y: 0 } } }),
      simulate: (game: any) => { game.state.entites.cible.x += 20 },
      history: { ticks: 4, interp: 0, extract: (game: any) => ({ cible: { x: game.state.entites.cible.x, y: 0 } }) },
    })
    const game = createGame(fakeApp(), def, () => {}, 'pc')
    for (let i = 0; i < 4; i++) { game._runTick(); await tick(5) }
    const { tick: tickVieux, gap } = game.rewind(1, (_positions: any, meta: any) => ({ tick: meta.tick, gap: meta.gap }))
    assert.equal(tickVieux, 1, 'instant très ancien (1970) → la plus vieille entrée dispo (tick 1, rien encore évincé à 4 ticks poussés)')
    assert.ok(gap > 1000, `écart doit être signalé (grand, instant demandé très antérieur), reçu ${gap}ms`)
    const tickFutur = game.rewind(Date.now() + 60000, (_positions: any, meta: any) => meta.tick)
    assert.equal(tickFutur, 4, 'instant futur → l\'entrée COURANTE (tick 4, le dernier poussé)')
    game._destroy()
  })

  it('d. timeSeenBy recule d\'autant que la latence simulée de la connexion (+ retard d\'interpolation)', () => {
    const def = resolveGameDef('lag-d', { seats: 1, tick: 20, state: () => ({}), moves: {}, history: { ticks: 10, extract: () => ({}), interp: 40 } })
    const game = createGame(fakeApp(), def, () => {}, 'pd')
    const client = fakeClient('j1')
    client.latency = 150   // latence simulée (mesure ping/pong MJS-WS, cf. core.ts handlePing) — 150 ms
    const player = { seat: 0, id: 'j1', clients: new Set([client]), connected: true }
    const avant = Date.now()
    const instant = game.timeSeenBy(player)
    const attendu = avant - (150 + 40)   // latence + interp
    assert.ok(Math.abs(instant - attendu) <= 15, `instant attendu ≈ ${attendu} (± 15ms de marge d'exécution), reçu ${instant}`)
    game._destroy()
  })

  it('e. TIR COMPENSÉ : viser où le tireur VOYAIT la cible touche ; viser sa position COURANTE rate (preuve du gain)', async () => {
    const def = resolveGameDef('lag-e', {
      seats: 1, tick: 20, moves: {},
      state: () => ({ entites: { cible: { x: 0, y: 0 } } }),
      simulate: (game: any) => { game.state.entites.cible.x += 20 },   // cible traverse à vitesse constante, déterministe (ignore dt)
      history: { ticks: 30, interp: 0, extract: (game: any) => ({ cible: { x: game.state.entites.cible.x, y: game.state.entites.cible.y } }) },
    })
    const game = createGame(fakeApp(), def, () => {}, 'pe')

    for (let i = 0; i < 2; i++) { game._runTick(); await tick(15) }   // ticks 1-2 (avec attente après chacun)
    game._runTick()   // tick 3 — LE TIREUR VOIT ÇA et vise ici : capture IMMÉDIATE, sans attente avant la lecture (sinon l'instant dérive vers le tick suivant, cf. piège du 1er jet de ce test)
    const instantVisé   = Date.now()
    const positionVisée = { x: game.state.entites.cible.x, y: 0 }   // ce que le tireur voit et vise (x=60)

    for (let i = 0; i < 7; i++) { await tick(15); game._runTick() }   // le temps du tir/réseau passe — attente D'ABORD, tick ENSUITE (ticks 4..10, chacun nettement après instantVisé)
    const positionCouranteAuTir = { x: game.state.entites.cible.x, y: 0 }   // x=200 — TRÈS différente de positionVisée

    const latenceSimulee = Date.now() - instantVisé
    assert.ok(latenceSimulee >= 80, `sanity : latence simulée doit ressembler à un vrai aller réseau (~150ms attendus), reçu ${latenceSimulee}ms`)

    const client = fakeClient('tireur')
    client.latency = latenceSimulee
    const player = { seat: 0, id: 'tireur', clients: new Set([client]), connected: true }

    const RAYON = 5
    const distance = (p: any, c: any) => Math.hypot(p.x - c.x, p.y - c.y)

    // SANS compensation — le serveur comparerait la visée (positionVisée, ce que le tireur a cliqué)
    // contre la position COURANTE (déjà avancée pendant l'aller réseau) → RATÉ
    assert.ok(distance(positionVisée, positionCouranteAuTir) > RAYON, 'sanity : sans compensation, la visée (ancienne position) contre la position COURANTE doit RATER')

    // AVEC compensation — rewind à l'instant que le tireur voyait retrouve la cible LÀ où il visait → TOUCHÉ
    const touché = game.rewind(game.timeSeenBy(player), (positions: any) => distance(positionVisée, positions.cible) <= RAYON)
    assert.ok(touché, 'rewind doit valider le tir compensé : la cible EST là où le tireur la voyait')

    game._destroy()
  })

  it('f. def.history sans tick (mode événementiel, tick=0) → erreur claire', () => {
    assert.throws(() => resolveGameDef('lag-f', { seats: 1, state: () => ({}), moves: {}, history: { ticks: 10 } }), /history nécessite tick > 0/)
  })

  it('g. def.history sans def.space NI extraire → erreur claire ; AVEC space, extraire redevient optionnel (repli sur le snapshot du space)', () => {
    assert.throws(() => resolveGameDef('lag-g1', { seats: 1, tick: 20, state: () => ({}), moves: {}, history: { ticks: 10 } }), /extract est requis/)

    const defAvecSpace = resolveGameDef('lag-g2', { seats: 1, tick: 20, state: () => ({}), moves: {}, space: { cell: 5 }, history: { ticks: 10 } })
    const game = createGame(fakeApp(), defAvecSpace, () => {}, 'pg')
    game.space!.set('e1', 3, 4)
    game._runTick()   // pousse via l'extracteur PAR DÉFAUT (snapshot du space, aucun `extraire` fourni)
    const positions = game.rewind(Date.now(), (positions: any) => positions)
    assert.deepEqual(positions, { e1: { x: 3, y: 4 } }, 'extracteur par défaut = snapshot du space (id → {x,y})')
    game._destroy()
  })

  it('h. fin de partie : le tampon d\'history est coupé (vidé), aucune fuite de timer ni d\'état', async () => {
    const def = resolveGameDef('lag-h', {
      seats: 1, tick: 20, moves: {},
      state: () => ({ entites: { c: { x: 0, y: 0 } } }),
      simulate: (game: any) => { game.state.entites.c.x += 1 },
      history: { ticks: 5, extract: (game: any) => ({ c: { x: game.state.entites.c.x, y: 0 } }) },
    })
    const game = createGame(fakeApp(), def, () => {}, 'ph')
    game._createSeat(fakeClient('j'))   // démarre la VRAIE boucle de tick (20Hz)
    await tick(120)   // laisse tourner quelques ticks réels — le tampon se remplit
    assert.doesNotThrow(() => game.rewind(Date.now(), () => true), 'sanity : le tampon contient bien des entrées avant destruction')
    game._destroy()
    assert.equal(game._tickHandle, null, '_destroy() coupe la VRAIE boucle de tick — aucun setInterval résiduel')
    assert.throws(() => game.rewind(Date.now(), () => true), /tampon vide/, 'après _destroy(), le tampon doit être VIDÉ — aucune entrée ne survit')
  })

  it('i. clé inconnue dans def.history : le message cite le vrai nom de l\'option', () => {
    assert.throws(
      () => resolveGameDef('lag-i', { seats: 1, tick: 20, state: () => ({}), moves: {}, history: { ticks: 10, extract: () => ({}), tick: 3 } as any }),
      (err: Error) => /\.history\.tick\b/.test(err.message) && !/\.histo\./.test(err.message),
      'la clé fautive doit être désignée par `history.tick`, jamais par un ancien nom',
    )
  })
})
