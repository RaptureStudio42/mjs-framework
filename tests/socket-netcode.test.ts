// Tests netcode CLIENT — interpolation à tampon (µ.interp) + prédiction du
// mouvement propre/réconciliation (µ.predict) — MÊME patron que tests/socket-game.test.ts (VRAI
// serveur MJS-Server, MemoryTransport, mode tick RAPIDE pour le test) : mjs_interp.ts/mjs_predict.ts
// sont posés PAR-DESSUS sock.game(), CONCATÉNÉS avec mjs_socket.ts + mjs_game.ts dans le MÊME
// `new Function` (ordre CANONIQUE du bundler, cf. src/bundler/index.ts::resolveRuntimeFiles).
// Temps piloté par de petits `await` RÉELS (tick 40Hz de test) — pas de fake timers, MêME esprit que
// tests/mjs-server-action.test.ts (le harnais mjs-ws/setInterval n'en connaît pas).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = ['mjs_socket.ts', 'mjs_game.ts', 'mjs_interp.ts', 'mjs_predict.ts']
  .map(f => readFileSync(join(__dirname, '../src/runtime/'+ f), 'utf8'))
  .join('\n')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

async function startApp(opts: MjsServerOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

// contrairement à connecter() des autres suites socket-*, on a besoin ICI de GARDER `µ` (pas
// seulement le socket) : µ.interp/µ.predict sont posés sur CE `µ`-là, propre à chaque client.
async function connecterAvecMu(transport: MemoryTransport, id: string): Promise<{ µ: any; sock: any }> {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  const µ = makeMu()
  const sock = µ.socket('memory://'+ id, { auth: () => ({ id }), reconnect: { enabled: false } })
  sock.connect()
  await tick()
  return { µ, sock }
}

// jeu de démo « net-jeu » — 2 places (code privé, 1 seul joueur suffit pour jouer, cf.
// tests/mjs-server-action.test.ts), tick RAPIDE (40Hz/25ms), deltas:true (permet un VRAI trou
// d'arrivée — zéro changement ⇒ zéro trame, cf. test c) ; intents.bouger CAPE le déplacement PAR
// APPEL à ±3 (force une divergence testable si un client prédit plus large, cf. test h) ; un move
// CLASSIQUE 'direct' (jamais capé, jamais mis en file, jamais acquitté) sert au test i (_ack
// absent) ; la vue expose `entites` (toutes) ET `moi` (raccourci vers SA PROPRE entité,
// exemple `champs: ['moi']`).
function declarerNetJeu(app: MjsServerApp, overrides: Record<string, any> = {}): void {
  const { hooks: hooksOverride, ...autresOverrides } = overrides
  app.game('net-jeu', {
    seats: 2,
    code: true,
    tick: 40,
    seatTtl: 300,
    emptyTtl: 200,
    deltas: true,
    state: () => ({ entites: {} }),
    intents: {
      bouger: (game: any, player: any, p: any) => {
        const e = game.state.entites[player.id]
        if (!e) return
        e.x += Math.max(-3, Math.min(3, p.dx || 0))
        e.y += Math.max(-3, Math.min(3, p.dy || 0))
      },
    },
    moves: {
      direct: (game: any, player: any, p: any) => {
        const e = game.state.entites[player.id]
        if (e) e.x += p.dx
      },
    },
    view: (game: any, player: any) => ({
      entites: game.state.entites,
      moi: player && game.state.entites[player.id] ? game.state.entites[player.id] : null,
    }),
    ...autresOverrides,
    hooks: {
      onJoin: (game: any, player: any) => { game.state.entites[player.id] = { x: 0, y: 0, name: 'j-'+ player.id } },
      onLeave: (game: any, player: any) => { delete game.state.entites[player.id] },
      ...hooksOverride,
    },
  })
}

describe('netcode — µ.interp (interpolation à tampon)', () => {
  // µ.interp choisit sa boucle via `typeof requestAnimationFrame === 'function'` (mjs_interp.ts
  // l.46-48), repli setInterval(16ms) sinon — le repli qui TIRE réellement en Node (cf. tête de
  // fichier du module). Mocha CHARGE tous les fichiers de la suite avant d'exécuter le moindre
  // test : un fichier transition-*/crossfade-* qui pose un rAF FACTICE sur `globalThis` au
  // top-level (hors hook, queue manuelle jamais auto-vidée) l'a déjà fait ICI au moment où CE
  // describe s'exécute, même si son propre after() de restauration ne tourne que plus tard dans
  // l'ordre d'exécution — la présence seule de `requestAnimationFrame` suffit à faire bifurquer
  // vers cette boucle qui ne tire jamais, le miroir n'est alors jamais peuplé. Neutralisation
  // stricte à chaque test, restauration fidèle : clé ABSENTE à l'origine ⇒ delete en sortie
  // (jamais une valeur undefined qui laisserait la clé posée), clé PRÉSENTE ⇒ valeur d'origine
  // réinjectée telle quelle.
  let __hadRaf: boolean, __prevRaf: any, __hadCancelRaf: boolean, __prevCancelRaf: any
  beforeEach(() => {
    __hadRaf        = 'requestAnimationFrame' in globalThis
    __prevRaf       = (globalThis as any).requestAnimationFrame
    __hadCancelRaf  = 'cancelAnimationFrame' in globalThis
    __prevCancelRaf = (globalThis as any).cancelAnimationFrame
    delete (globalThis as any).requestAnimationFrame
    delete (globalThis as any).cancelAnimationFrame
  })
  afterEach(() => {
    if (__hadRaf) (globalThis as any).requestAnimationFrame = __prevRaf
    else delete (globalThis as any).requestAnimationFrame
    if (__hadCancelRaf) (globalThis as any).cancelAnimationFrame = __prevCancelRaf
    else delete (globalThis as any).cancelAnimationFrame
  })

  it("a. 3 états espacés → le miroir passe par des valeurs INTERMÉDIAIRES (lerp réel, pas des sauts discrets)", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app, { simulate: (game: any) => { for (const id in game.state.entites) game.state.entites[id].x += 4 } })
    const { µ, sock } = await connecterAvecMu(transport, 'a')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)   // laisse la partie s'asseoir + quelques ticks passer (brut déjà en mouvement)
    const miroir = µ.interp(game, { fields: ['entites'], delay: 2 })
    let vuIntermediaire = false
    for (let i = 0; i < 25 && !vuIntermediaire; i++) {
      await tick(12)
      const e = miroir.entites['a']
      if (e && typeof e.x === 'number' && e.x % 4 !== 0) vuIntermediaire = true
    }
    assert.ok(vuIntermediaire, 'au moins un échantillon du miroir doit être une valeur LERPÉE (non multiple de 4) — preuve de vraie interpolation, pas un simple aiguillage vers le dernier connu')
    miroir.stop()
    await app.stop()
  })

  it('b. retard ≈ 2 périodes mesuré (le miroir reste en retrait du brut d\'environ 2 ticks de mouvement, en régime établi)', async () => {
    const { transport, app } = await startApp()
    const INC = 4
    declarerNetJeu(app, { simulate: (game: any) => { for (const id in game.state.entites) game.state.entites[id].x += INC } })
    const { µ, sock } = await connecterAvecMu(transport, 'b')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    const miroir = µ.interp(game, { fields: ['entites'], delay: 2 })
    await tick(500)   // laisse la moyenne glissante (8 échantillons) se stabiliser sur la cadence réelle
    const brut  = game.state.entites['b'].x
    const lisse = miroir.entites['b'].x
    const ecart = brut - lisse
    assert.ok(ecart >= INC && ecart <= INC * 3.5, `écart brut/lissé attendu ~2 ticks de mouvement (≈${INC * 2}), reçu ${ecart} (brut=${brut}, lissé=${lisse})`)
    miroir.stop()
    await app.stop()
  })

  it("c. trou d'arrivée (mouvement serveur coupé) → extrapolation bornée PUIS gel (valeur stable ensuite)", async () => {
    const { transport, app } = await startApp()
    let actif = true
    declarerNetJeu(app, { simulate: (game: any) => { if (actif) { for (const id in game.state.entites) game.state.entites[id].x += 4 } } })
    const { µ, sock } = await connecterAvecMu(transport, 'c')
    const game = sock.game('net-jeu', { code: true })
    await tick(200)   // mouvement établi — plusieurs échantillons + période mesurée
    const miroir = µ.interp(game, { fields: ['entites'], delay: 2 })
    await tick(150)
    actif = false   // coupe le mouvement SERVEUR — deltas:true ⇒ plus AUCUNE trame (vrai trou réseau, pas juste une valeur figée transmise)
    await tick(300)   // largement au-delà de la fenêtre d'extrapolation (~1 période ≈ 25ms)
    const val1 = miroir.entites['c'].x
    assert.ok(Number.isFinite(val1), 'la valeur figée doit rester FINIE (aucune dérive vers NaN/Infinity)')
    await tick(150)
    const val2 = miroir.entites['c'].x
    assert.equal(val2, val1, 'après le trou, le miroir doit être GELÉ (aucun changement supplémentaire, extrapolation jamais illimitée)')
    miroir.stop()
    await app.stop()
  })

  it("d. stop() coupe la boucle + les abonnements — le miroir n'évolue plus, même si le brut continue", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app, { simulate: (game: any) => { for (const id in game.state.entites) game.state.entites[id].x += 4 } })
    const { µ, sock } = await connecterAvecMu(transport, 'd')
    const game = sock.game('net-jeu', { code: true })
    await tick(150)
    const miroir = µ.interp(game, { fields: ['entites'], delay: 2 })
    await tick(150)
    miroir.stop()
    const brutApresStop = game.state.entites['d'].x
    const geleA = JSON.parse(JSON.stringify(miroir.entites))
    await tick(300)   // le brut, lui, continue de bouger largement
    const geleB = JSON.parse(JSON.stringify(miroir.entites))
    assert.deepEqual(geleB, geleA, 'stop() doit figer le miroir DÉFINITIVEMENT')
    assert.ok(game.state.entites['d'].x > brutApresStop, 'sanity : le brut, lui, a continué de bouger après stop()')
    await app.stop()
  })
})

describe('netcode — µ.predict (prédiction du mouvement propre + réconciliation)', () => {
  const appliquerNaif = (frag: any, name: string, p: any) => { if (name === 'bouger') { frag.moi.x += p.dx || 0; frag.moi.y += p.dy || 0 } }

  it('e. move() numérote _n de façon CROISSANTE dans le payload réseau (p._n, à côté du payload du jeu)', async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { µ, sock } = await connecterAvecMu(transport, 'e')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    const envoyes: any[] = []
    const origRequest = sock.request.bind(sock)
    sock.request = (type: string, payload: any, opts?: any) => { if (type === 'µgame:move') envoyes.push(payload); return origRequest(type, payload, opts) }
    const miroir = µ.predict(game, { fields: ['moi'], apply: appliquerNaif })
    game.move('bouger', { dx: 1, dy: 0 })
    game.move('bouger', { dx: 1, dy: 0 })
    game.move('bouger', { dx: 1, dy: 0 })
    assert.equal(envoyes.length, 3, 'sanity : 3 appels → 3 requêtes µgame:move envoyées')
    assert.ok(typeof envoyes[0].p._n === 'number', "le payload réseau doit porter un _n numérique aux côtés de p")
    assert.ok(envoyes[0].p._n < envoyes[1].p._n, '_n doit croître entre le 1er et le 2e envoi')
    assert.ok(envoyes[1].p._n < envoyes[2].p._n, '_n doit croître entre le 2e et le 3e envoi')
    miroir.stop()
    await tick(120)
    await app.stop()
  })

  it("f. application locale IMMÉDIATE : le fragment prédit bouge AVANT tout retour serveur (aucun await entre move() et la lecture)", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { µ, sock } = await connecterAvecMu(transport, 'f')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    const miroir = µ.predict(game, { fields: ['moi'], apply: appliquerNaif })
    const before = miroir.moi.x
    game.move('bouger', { dx: 5, dy: 0 })
    const apres = miroir.moi.x   // AUCUN await entre les deux lignes — preuve d'une application SYNCHRONE
    assert.equal(apres, before + 5, 'le fragment doit refléter le mouvement immédiatement, sans attendre le serveur')
    miroir.stop()
    await tick(150)
    await app.stop()
  })

  it("g. réconciliation : le serveur applique + acquitte → la file se purge, le fragment CONVERGE vers le serveur (et y reste, pas de rejeu fantôme)", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { µ, sock } = await connecterAvecMu(transport, 'g')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    const miroir = µ.predict(game, { fields: ['moi'], apply: appliquerNaif })
    game.move('bouger', { dx: 1 })   // sous le cap serveur (±3) — pas de divergence ici, cf. test h
    await tick(120)   // laisse le serveur traiter (tick 25ms) + acquitter
    assert.equal(game.state.moi.x, 1, 'sanity : le serveur a bien appliqué le mouvement')
    assert.equal(miroir.moi.x, 1, 'le fragment prédit doit converger EXACTEMENT vers la vérité serveur')
    await tick(120)   // une nouvelle diffusion SANS nouveau move : preuve INDIRECTE que la file a bien été PURGÉE
    assert.equal(miroir.moi.x, 1, 'le fragment doit rester stable — aucune ré-application fantôme de l\'ancienne intention')
    miroir.stop()
    await app.stop()
  })

  it("h. correction serveur DIVERGENTE (cap ±3) : le fragment SNAPPE à la vérité serveur puis REJOUE les non-confirmées PAR-DESSUS (pas de téléportation des intentions en attente)", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { µ, sock } = await connecterAvecMu(transport, 'h')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    // appliquer NAÏF (sans cap) — divergera DÉLIBÉRÉMENT du serveur, qui lui cape à ±3 (cf. declarerNetJeu)
    const miroir = µ.predict(game, { fields: ['moi'], apply: appliquerNaif })
    game.move('bouger', { dx: 10 })
    assert.equal(miroir.moi.x, 10, 'prédiction locale NAÏVE (non cappée) — immédiate')
    await tick(120)   // le serveur applique CAPÉ (dx effectif 3) et acquitte
    assert.equal(game.state.moi.x, 3, 'sanity : le serveur a cappé le déplacement à 3')
    assert.equal(miroir.moi.x, 3, "le fragment doit SNAPPER à la vérité serveur (3) — jamais rester sur la prédiction naïve (10) ni la moyenner")
    game.move('bouger', { dx: 1 })   // sous le cap — nouvelle intention, encore NON confirmée
    assert.equal(miroir.moi.x, 4, 'rejoué IMMÉDIATEMENT par-dessus la base serveur CORRIGÉE (3 + 1 = 4), pas sur la base naïve (10 + 1)')
    await tick(120)   // le serveur applique ce 2e mouvement (3+1=4, sous le cap — pas de re-divergence) et acquitte
    assert.equal(game.state.moi.x, 4)
    assert.equal(miroir.moi.x, 4, 'convergence finale')
    miroir.stop()
    await app.stop()
  })

  it("i. _ack absent (coup CLASSIQUE, jamais mis en file) → µ.predict reste propre (pas de double-comptage, pas de crash)", async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { µ, sock } = await connecterAvecMu(transport, 'i')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    const miroir = µ.predict(game, { fields: ['moi'], apply: (frag: any, name: string, p: any) => { if (name === 'direct') frag.moi.x += p.dx } })
    const frames: any[] = []
    game.on('state', (f: any) => frames.push(f))
    game.move('direct', { dx: 5 })
    assert.equal(miroir.moi.x, 5, 'prédiction locale immédiate, même pour un move classique')
    await tick(120)
    assert.equal(game.state.moi.x, 5, "sanity : le move classique s'est appliqué côté serveur")
    assert.ok(frames.length >= 1, 'au moins une diffusion attendue')
    for (const f of frames) assert.ok(!('_ack' in f), "un move CLASSIQUE ne doit JAMAIS produire d'_ack")
    assert.equal(miroir.moi.x, 5, 'grâce au filet ackVu (jeu sans _n jamais vu), le fragment converge SANS double-comptage (pas 10)')
    miroir.stop()
    await app.stop()
  })

  it('j. non-régression : SANS µ.interp/µ.predict, la coalescence des intentions (dernière gagne) reste identique à avant', async () => {
    const { transport, app } = await startApp()
    declarerNetJeu(app)
    const { sock } = await connecterAvecMu(transport, 'j')
    const game = sock.game('net-jeu', { code: true })
    await tick(80)
    // 3 appels rapprochés, MÊME esprit que tests/mjs-server-action.test.ts test b — µ.predict/µ.interp
    // JAMAIS invoqués ici (juste chargés dans le bundle, cf. tête de fichier) : seule la DERNIÈRE
    // intention doit compter, comportement documenté et INCHANGÉ.
    await game.move('bouger', { dx: 1 })
    await game.move('bouger', { dx: 2 })
    await game.move('bouger', { dx: 3 })
    await tick(120)
    assert.equal(game.state.moi.x, 3, 'sans µ.predict/µ.interp, seule la DERNIÈRE intention rapprochée doit avoir été appliquée — inchangé par la présence des nouveaux modules dans le bundle')
    await app.stop()
  })
})
