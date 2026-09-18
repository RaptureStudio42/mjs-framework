// Tests anti-triche, volet spectateurs (TOUT opt-in, anti-cheat au
// maximum) — MÊME harnais direct fakeApp()/fakeClient() que tests/mjs-server-anti-triche-detection.
// test.ts pour les mécaniques internes non observables sur le fil, + un VRAI client µ.socket/
// sock.game (mjs_socket.ts + mjs_game.ts, MÊME patron que tests/socket-game.test.ts) pour le
// protocole et le store réactif. Couvre :
//  1. VUE SÛRE du spectateur — def.spectatorView / def.view(partie, null) en repli / ni l'un ni
//     l'autre → {} + avertissement UNE SEULE FOIS par partie (JAMAIS l'état brut par défaut).
//  2. sièges — un spectateur n'occupe AUCUN siège (places préservées) ; un coup de spectateur est
//     rejeté « spectateur : lecture seule » ; départ volontaire/déconnexion nettoyés ; idempotence.
//  3. diffusion — µgame:state relayé aux spectateurs à chaque round (jamais µgame:end/left/seat).
//  4. protocole µgame:play { spectateur:true } sur socket brut (validation, places, vue, rejet de coup).
//  5. client réactif sock.game (mjs_game.ts) — store.spectateur/store.siege, .move() rejeté,
//     .leave(), et le garde-fou de reconnexion (jamais de resync spectateur, cf. mjs_game.ts).
//  6. non-régression — un jeu sans spectateur inchangé ; resolveGameDef sans spectatorView.
// Suites lancées À PART pour prouver qu'aucun jeu
// existant ne bouge : mjs-server-anti-triche*, mjs-server-matchmaking, mjs-server-core, mjs-server-action,
// socket-game.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer, resolveGameDef, createGame } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp } from '../src/mjs-server/index.js'
import type { MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const gameSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_game.ts'), 'utf8')
// CONCATÉNÉS (MÊME patron que tests/socket-game.test.ts) — mjs_game.ts référence `MjsSocket` en
// identifiant NU, jamais chargé seul. Les sections 4/5 ci-dessous s'en servent différemment :
// section 4 = socket BRUT (s.request direct, protocole), section 5 = sock.game() (store réactif).
const clientSrc = socketSrc + '\n' + gameSrc

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

// --- harnais DIRECT (sans transport) — MÊME patron que tests/mjs-server-anti-triche-detection.test.ts
function fakeApp(): any { return { send() {} } }
// variante qui CAPTURE les envois — pour prouver la diffusion vers les spectateurs (section 3)
function fakeAppCapture(): any {
  const envoyes: any[] = []
  return { send: (client: any, type: string, p: any) => envoyes.push({ client, type, p }), _envoyes: envoyes }
}
function fakeClient(identityId: string): any {
  return { id: 'fake-' + identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('MJS-Server — anti-triche (spectateurs, lecture seule)', () => {

  describe('1. VUE SÛRE du spectateur — 3 cas (harnais direct)', () => {
    it('def.spectatorView défini → utilisée telle quelle (jamais def.view, même s’il existe)', () => {
      const def = resolveGameDef('spec-view-1', {
        seats: 2, state: () => ({ secret: 42 }), moves: {},
        view: () => ({ PIEGE: 'ne doit jamais être vu — spectatorView prime' }),
        spectatorView: () => ({ safe: true }),
      })
      const game = createGame(fakeApp(), def, () => {}, 'sv1')
      const { view } = game._addSpectator(fakeClient('regardeur'))
      assert.deepEqual(view, { safe: true })
      game._destroy()
    })

    it('def.spectatorView ABSENT, def.view déclaré par l’auteur → appelée avec joueur=null (marqueur), jamais l’état d’un vrai joueur', () => {
      const def = resolveGameDef('spec-view-2', {
        seats: 2, state: () => ({ secretA: 'x', secretB: 'y' }), moves: {},
        view: (game: any, player: any) => player ? { monSecret: (game.state as any)['secret' + player.id] } : { spectator: true },
      })
      const game = createGame(fakeApp(), def, () => {}, 'sv2')
      const { view } = game._addSpectator(fakeClient('regardeur'))
      assert.deepEqual(view, { spectator: true }, 'def.view appelée avec joueur=null — jamais un secret de joueur inventé')
      game._destroy()
    })

    it('NI spectatorView NI view déclarés → {} STRICT (jamais l’état brut par défaut) + avertissement UNE SEULE FOIS par partie', () => {
      const avertissements: any[] = []
      const def = resolveGameDef('spec-view-3', { seats: 1, state: () => ({ n: 99 }), moves: {} }, (level, message) => avertissements.push({ level, message }))
      const game = createGame(fakeApp(), def, () => {}, 'sv3')
      const { view } = game._addSpectator(fakeClient('r1'))
      assert.deepEqual(view, {}, 'JAMAIS l’état brut (n:99) à un spectateur par défaut')
      assert.equal(avertissements.length, 1)
      assert.equal(avertissements[0].level, 'warn')
      assert.match(avertissements[0].message, /spectateur sans def\.spectatorView\/def\.view/)

      // un 2e spectateur + une diffusion explicite NE DOIVENT PAS réavertir (throttle par partie)
      game._addSpectator(fakeClient('r2'))
      game._broadcastToSpectators()
      assert.equal(avertissements.length, 1, 'avertissement émis AU PLUS UNE FOIS par partie, jamais par spectateur/diffusion')
      game._destroy()
    })
  })

  describe('2. sièges / rejet de coup / nettoyage (harnais direct)', () => {
    it('rejoint SANS consommer de siège — places préservées, un vrai joueur peut toujours prendre TOUS les sièges', () => {
      const def = resolveGameDef('spec-places', { seats: 2, state: () => ({}), moves: { inc: () => {} } })
      const game = createGame(fakeApp(), def, () => {}, 'pl1')
      game._addSpectator(fakeClient('r1'))
      game._addSpectator(fakeClient('r2'))
      assert.deepEqual(game.players, [null, null], 'AUCUN siège occupé par les spectateurs')
      const j1 = game._createSeat(fakeClient('joueur-1'))
      const j2 = game._createSeat(fakeClient('joueur-2'))
      assert.equal(j1.seat, 0)
      assert.equal(j2.seat, 1)
      assert.throws(() => game._createSeat(fakeClient('joueur-3')), /complète/, 'partie pleine à 2 — les spectateurs n’ont RIEN consommé')
      game._destroy()
    })

    it('coup d’un spectateur → REJETÉ « spectateur : lecture seule » (jamais appliqué)', () => {
      const def = resolveGameDef('spec-move', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'mv1')
      const cr = fakeClient('regardeur')
      game._addSpectator(cr)
      assert.throws(() => game._onMove(cr, 'inc', {}), /spectateur : lecture seule/)
      assert.equal(game.state.n, 0)
      game._destroy()
    })

    it('un client totalement inconnu (ni siège ni spectateur) garde le message générique INCHANGÉ (non-régression)', () => {
      const def = resolveGameDef('spec-move-2', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'mv2')
      assert.throws(() => game._onMove(fakeClient('inconnu'), 'inc', {}), /vous n.êtes pas assis/)
      game._destroy()
    })

    it('départ volontaire (_quitter) → retiré de _spectateurs ; un coup ultérieur redevient le message générique (plus « lecture seule »)', () => {
      const def = resolveGameDef('spec-leave', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'lv1')
      const cr = fakeClient('regardeur')
      game._addSpectator(cr)
      assert.doesNotThrow(() => game._leave(cr), '_quitter gère un spectateur SANS throw')
      assert.throws(() => game._onMove(cr, 'inc', {}), /vous n.êtes pas assis/, 'plus dans _spectateurs — message générique')
      game._destroy()
    })

    it('_quitter sur un client totalement inconnu → throw INCHANGÉ (non-régression)', () => {
      const def = resolveGameDef('spec-leave-2', { seats: 1, state: () => ({}), moves: {} })
      const game = createGame(fakeApp(), def, () => {}, 'lv2')
      assert.throws(() => game._leave(fakeClient('inconnu')), /vous n.êtes pas assis/)
      game._destroy()
    })

    it('déconnexion (_onDisconnect) → retiré de _spectateurs, retourne true ; client étranger → false (non-régression)', () => {
      const def = resolveGameDef('spec-disc', { seats: 1, state: () => ({}), moves: {} })
      const game = createGame(fakeApp(), def, () => {}, 'dc1')
      const cr = fakeClient('regardeur')
      game._addSpectator(cr)
      assert.equal(game._onDisconnect(cr), true)
      assert.equal(game._spectators.has(cr), false)
      assert.equal(game._onDisconnect(fakeClient('jamais-vu')), false)
      game._destroy()
    })

    it('idempotent : rejoindre 2x avec la MÊME connexion ne fait rien de plus (Set)', () => {
      const def = resolveGameDef('spec-idem', { seats: 1, state: () => ({}), moves: {}, spectatorView: () => ({ ok: true }) })
      const game = createGame(fakeApp(), def, () => {}, 'id1')
      const cr = fakeClient('regardeur')
      game._addSpectator(cr)
      game._addSpectator(cr)
      assert.equal(game._spectators.size, 1)
      game._destroy()
    })
  })

  describe('3. diffusion (harnais direct, fakeAppCapture)', () => {
    it('µgame:state relayé au spectateur à chaque round (vue sûre) — un joueur normal continue de recevoir la sienne', async () => {
      const app = fakeAppCapture()
      const def = resolveGameDef('spec-diff', {
        seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
        spectatorView: (game: any) => ({ compteur: game.state.n }),
      })
      const game = createGame(app, def, () => {}, 'df1')
      const cj = fakeClient('joueur')
      const cr = fakeClient('regardeur')
      game._createSeat(cj)
      game._addSpectator(cr)
      app._envoyes.length = 0   // ignore le bruit d'installation (µgame:seat…)
      game._onMove(cj, 'inc', {})
      await tick()   // _marquerSale groupe par microtâche (tick=0) — tick() franchit la frontière macrotâche
      const versSpectateur = app._envoyes.filter((e: any) => e.client === cr)
      assert.equal(versSpectateur.length, 1)
      assert.equal(versSpectateur[0].type, 'µgame:state')
      assert.deepEqual(versSpectateur[0].p.view, { compteur: 1 })
      game._destroy()
    })

    it('µgame:end/left/seat NE SONT PAS relayés aux spectateurs — scope volontairement restreint à µgame:state (à signaler si besoin élargi)', () => {
      const app = fakeAppCapture()
      const def = resolveGameDef('spec-end', { seats: 1, state: () => ({}), moves: {} })
      const game = createGame(app, def, () => {}, 'df2')
      game._addSpectator(fakeClient('regardeur'))
      app._envoyes.length = 0
      game.end({ ok: true })
      assert.equal(app._envoyes.filter((e: any) => e.type === 'µgame:end').length, 0)
      game._destroy()
    })
  })

  describe('4. protocole µgame:play { spectateur: true } (wire réel, socket brut)', () => {
    function declarerJeu(app: MjsServerApp): void {
      app.game('spectable', {
        seats: 2, code: true, seatTtl: 300, emptyTtl: 5000,
        state: () => ({ grille: [0, 0] }),
        moves: { inc: (game: any, player: any) => { game.state.grille[player.seat]++ } },
        view: (game: any, player: any) => player ? { grille: game.state.grille, monSiege: player.seat } : null,
        spectatorView: (game: any) => ({ grille: game.state.grille, regarde: true }),
      })
    }

    it('rejoint par code, en spectateur : siege null, spectateur true, places INCHANGÉES, vue via spectatorView', async () => {
      const { transport, app } = await startApp()
      declarerJeu(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'spectable', code: true })

      const sR = connecter(transport, 'regardeur'); sR.connect(); await tick()
      const repR = await sR.request('µgame:play', { type: 'spectable', code: repA.code, spectator: true })
      assert.equal(repR.seat, null)
      assert.equal(repR.spectator, true)
      assert.equal(repR.game, repA.game)
      assert.deepEqual(repR.view, { grille: [0, 0], regarde: true })

      // µgame:seat n'est PAS relayé aux spectateurs (scope restreint à µgame:state, cf. section 3) —
      // on l'observe donc depuis un JOUEUR (sA) pour prouver que le roster reste bien à 2 occupants.
      const seats: any[] = []
      sA.on('µgame:seat', (p: any) => seats.push(p))
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      await sB.request('µgame:play', { type: 'spectable', code: repA.code })
      await tick()
      const dernier = seats[seats.length - 1]
      assert.equal(dernier.seatCount, 2)
      assert.equal(dernier.seats.filter((s: any) => s !== null).length, 2, 'seulement 2 sièges occupés — le spectateur n’en a PRIS aucun')
      await app.stop()
    })

    it('diffusion : le spectateur reçoit µgame:state (vue sûre) à chaque coup, jamais un champ spécifique à un siège', async () => {
      const { transport, app } = await startApp()
      declarerJeu(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'spectable', code: true })
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      await sB.request('µgame:play', { type: 'spectable', code: repA.code })
      const sR = connecter(transport, 'r'); sR.connect(); await tick()
      await sR.request('µgame:play', { type: 'spectable', code: repA.code, spectator: true })

      const etats: any[] = []
      sR.on('µgame:state', (p: any) => etats.push(p))
      await sA.request('µgame:move', { game: repA.game, move: 'inc' })
      await tick()
      assert.ok(etats.length >= 1)
      assert.deepEqual(etats[etats.length - 1].view, { grille: [1, 0], regarde: true })
      assert.equal('monSiege' in etats[etats.length - 1].view, false, 'jamais un champ propre à un SIÈGE dans la vue spectateur')
      await app.stop()
    })

    it('coup d’un spectateur → ack REJETÉ « lecture seule »', async () => {
      const { transport, app } = await startApp({ onLog: () => {} })
      declarerJeu(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'spectable', code: true })
      const sR = connecter(transport, 'r'); sR.connect(); await tick()
      const repR = await sR.request('µgame:play', { type: 'spectable', code: repA.code, spectator: true })
      await assert.rejects(sR.request('µgame:move', { game: repR.game, move: 'inc' }), (e: any) => /lecture seule/i.test(String(e)))
      await app.stop()
    })

    it('validation : spectateur nécessite un code STRING existant ; def.code=false → refus clair ; spectateur doit être true|absent', async () => {
      const { transport, app } = await startApp({ onLog: () => {} })
      declarerJeu(app)
      app.game('sans-code-spec', { seats: 1, state: () => ({}), moves: {} })
      const s = connecter(transport, 'x'); s.connect(); await tick()
      await assert.rejects(s.request('µgame:play', { type: 'spectable', spectator: true }), (e: any) => /code/i.test(String(e)))
      await assert.rejects(s.request('µgame:play', { type: 'spectable', code: true, spectator: true }), (e: any) => /code/i.test(String(e)))
      await assert.rejects(s.request('µgame:play', { type: 'sans-code-spec', code: 'ZZZZZ', spectator: true }), (e: any) => /parties privées/i.test(String(e)))
      await assert.rejects(s.request('µgame:play', { type: 'spectable', code: 'INCONNU', spectator: true }), (e: any) => /code inconnu/i.test(String(e)))
      await assert.rejects(s.request('µgame:play', { type: 'spectable', spectator: 'oui' as any }), (e: any) => /spectator/i.test(String(e)))
      await app.stop()
    })

    it('départ (µgame:leave) et déconnexion d’un spectateur : ack ok / nettoyage silencieux, la partie continue normalement pour les joueurs', async () => {
      const { transport, app } = await startApp()
      declarerJeu(app)
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'spectable', code: true })
      const sR = connecter(transport, 'r'); sR.connect(); await tick()
      const repR = await sR.request('µgame:play', { type: 'spectable', code: repA.code, spectator: true })
      const ack = await sR.request('µgame:leave', { game: repR.game })
      assert.deepEqual(ack, { ok: true })

      const sR2 = connecter(transport, 'r2'); sR2.connect(); await tick()
      await sR2.request('µgame:play', { type: 'spectable', code: repA.code, spectator: true })
      sR2._mjs_ws.close(1006, 'coupure spectateur')
      await tick()
      const ackMove = await sA.request('µgame:move', { game: repA.game, move: 'inc' })
      assert.equal(ackMove.ok, true, 'la partie n’est aucunement perturbée par le va-et-vient de spectateurs')
      await app.stop()
    })
  })

  describe('5. client réactif sock.game (mjs_game.ts, wire réel)', () => {
    function declarerJeu(app: MjsServerApp): void {
      app.game('spectable-client', {
        seats: 2, code: true, seatTtl: 300, emptyTtl: 5000,
        state: () => ({ grille: [0, 0] }),
        moves: { inc: (game: any, player: any) => { game.state.grille[player.seat]++ } },
        view: (game: any, player: any) => player ? { grille: game.state.grille, monSiege: player.seat } : null,
        spectatorView: (game: any) => ({ grille: game.state.grille }),
      })
    }

    it('store.spectateur=true, store.siege=null, vue via spectatorView ; .move() TOUJOURS rejeté ; .leave() fonctionne sans changement', async () => {
      const { transport, app } = await startApp()
      declarerJeu(app)
      const µa = makeClient(transport)
      const sa = µa.socket('memory://ca', { auth: () => ({ id: 'ca' }), reconnect: { enabled: false } })
      const ha = sa.game('spectable-client', { code: true })
      await tick()

      const µr = makeClient(transport)
      const sr = µr.socket('memory://cr', { auth: () => ({ id: 'cr' }), reconnect: { enabled: false } })
      const hr = sr.game('spectable-client', { code: ha.state.code, spectator: true })
      await tick()

      assert.equal(hr.state.status, 'playing')
      assert.equal(hr.state.spectator, true)
      assert.equal(hr.state.seat, null)
      assert.deepEqual(hr.state.grille, [0, 0])
      assert.equal(ha.state.spectator, false, 'un joueur normal garde spectateur=false')

      await assert.rejects(hr.move('inc'), (e: any) => /lecture seule/i.test(String(e)))

      await ha.move('inc')
      await tick()
      assert.deepEqual(hr.state.grille, [1, 0], 'le store du spectateur reçoit bien les poussées µgame:state')

      hr.leave()
      assert.equal(hr.state.status, 'left')
      await tick()
      await app.stop()
    })

    it('reconnexion : un spectateur N’EST PAS resynchronisé automatiquement (aucun siège à retrouver) — pas de statut « erreur » parasite', async () => {
      const { transport, app } = await startApp()
      declarerJeu(app)
      const µa = makeClient(transport)
      const sa = µa.socket('memory://cb', { auth: () => ({ id: 'cb' }), reconnect: { enabled: false } })
      const ha = sa.game('spectable-client', { code: true })
      await tick()

      const µr = makeClient(transport)
      const sr = µr.socket('memory://cr2', { auth: () => ({ id: 'cr2' }), reconnect: { backoff: [50], jitter: 0 } })
      const hr = sr.game('spectable-client', { code: ha.state.code, spectator: true })
      await tick()
      assert.equal(hr.state.status, 'playing')

      sr._mjs_ws.close(1006, 'coupure spectateur simulée')
      await tick(150)   // > backoff — la CONNEXION revient toute seule (reconnexion générique µ.socket)

      assert.equal(sr.state, 'open', 'la connexion doit avoir repris')
      assert.equal(hr.state.status, 'playing', 'jamais basculé en "erreur" — aucun resync spectateur tenté, cf. mjs_game.ts::_mjs_onGameWelcome')
      await app.stop()
    })
  })

  describe('6. non-régression', () => {
    it('resolveGameDef sans spectatorView → def.spectatorView = null (défaut inerte)', () => {
      const def = resolveGameDef('nr-1', { seats: 1, state: () => ({}), moves: {} })
      assert.equal(def.spectatorView, null)
    })

    it('def.spectatorView doit être une fonction si fourni ; clé inconnue proche → suggestion orthographique', () => {
      assert.throws(() => resolveGameDef('nr-2', { seats: 1, state: () => ({}), moves: {}, spectatorView: 'x' as any }), /spectatorView doit être une fonction/)
      assert.throws(() => resolveGameDef('nr-3', { seats: 1, state: () => ({}), moves: {}, spectatorVew: () => {} } as any), /spectatorView/)
    })

    it('un jeu SANS spectateur (aucun client ne rejoint en spectateur) se comporte EXACTEMENT comme avant', async () => {
      const { transport, app } = await startApp()
      app.game('classique', {
        seats: 2, code: true, seatTtl: 300, emptyTtl: 5000,
        state: () => ({ n: 0 }),
        moves: { inc: (game: any) => { game.state.n++ } },
        view: (game: any) => ({ n: game.state.n }),
      })
      const sA = connecter(transport, 'a'); sA.connect(); await tick()
      const repA = await sA.request('µgame:play', { type: 'classique', code: true })
      assert.equal(repA.seat, 0)
      const sB = connecter(transport, 'b'); sB.connect(); await tick()
      const repB = await sB.request('µgame:play', { type: 'classique', code: repA.code })
      assert.equal(repB.seat, 1)
      const ack = await sA.request('µgame:move', { game: repA.game, move: 'inc' })
      assert.equal(ack.ok, true)
      await app.stop()
    })
  })
})
