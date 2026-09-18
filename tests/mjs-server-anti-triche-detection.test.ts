// Tests anti-triche (détection par coup, TOUT opt-in, anti-cheat au
// maximum) — MÊME harnais direct fakeApp()/fakeClient() que tests/mjs-server-anti-triche.test.ts
// (quota par défaut) pour les mécaniques internes non observables sur le fil, + un VRAI
// client µ.socket (MÊME patron que tests/mjs-server-action.test.ts, tests o/p sur la couture _ack)
// pour l'interaction _n/predict et le greffage app.stats().game de bout en bout. Couvre les 4 mesures :
//  1. def.suspect(coup, contexte) — {rejeter:true} rejette (throw), `true` seul journalise SANS
//     rejeter (politique de rejet PAR DÉFAUT : explicite uniquement), absent/falsy → RAS.
//  2. def.antiRejeu — seq (_n s'il existe déjà côté predict, SINON _s dédié) monotone PAR SIÈGE,
//     cohabite SANS CONFLIT avec _n/_ack de µ.predict (lecture SEULE, jamais consommé/muté).
//  3. def.limits.moveIntervalMs — cadence instantanée PAR siège (horloge SERVEUR), distincte du
//     débit moyen limits.moves.
//  4. journal anti-triche borné (100 entrées) + compteurs app.stats().game.coupsSuspects/
//     coupsRejetesAntiTriche (greffe ADDITIVE sur app.stats(), cf. index.ts) + hook def.onSuspicion.
// Non-régression : resolveGameDef sans les 3 options → suspect/onSuspicion null, antiRejeu false,
// limits.moveIntervalMs null (comportement STRICTEMENT inchangé) ; suites mjs-server-anti-triche/
// mjs-server-action/socket-game lancées À PART confirment
// qu'aucun jeu existant ne bouge.
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

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

async function connecter(transport: MemoryTransport, id: string): Promise<any> {
  const µ = makeClient(transport)
  const s = µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
  s.connect(); await tick()
  return s
}

// --- harnais DIRECT (sans transport) — MÊME patron que tests/mjs-server-anti-triche.test.ts (section
// « quota par défaut ») : pour les mécaniques internes non observables sur le fil -------------------
function fakeApp(): any { return { send() {} } }
function fakeClient(identityId: string): any {
  return { id: 'fake-' + identityId, identity: { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}
// stats "jeu" attachées MANUELLEMENT (cf. matchmaking.ts::create(), qui fait ça pour de vrai en usage
// réel) — le harnais direct bypass matchmaking.ts, donc game._gameStats resterait `null` sans cette
// ligne (les compteurs restent alors simplement invisibles — comportement vérifié en section 5).
function gameStats() { return { suspectMoves: 0, rejectedMoves: 0 } }

describe('MJS-Server — anti-triche (détection par coup : def.suspect/antiRejeu/limits.moveIntervalMs + journal/stats/onSuspicion)', () => {

  describe('1. def.suspect(coup, contexte)', () => {
    it("{rejeter:true} → coup REJETÉ (throw, jamais appliqué), journalisé, coupsSuspects ET coupsRejetesAntiTriche incrémentés, onSuspicion appelé", () => {
      const evenements: any[] = []
      const def = resolveGameDef('susp-reject', {
        seats: 1, state: () => ({ n: 0 }),
        moves: { inc: (game: any) => { game.state.n++ } },
        suspect: () => ({ reject: true, reason: 'triche-detectee' }),
        onSuspicion: (ev: any) => evenements.push(ev),
      })
      const game = createGame(fakeApp(), def, () => {}, 'p1')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      assert.throws(() => game._onMove(c1, 'inc', {}), /suspect/)
      assert.equal(game.state.n, 0, 'le coup rejeté ne doit JAMAIS avoir été appliqué')
      assert.equal(game._antiCheatLog().length, 1)
      assert.equal(game._antiCheatLog()[0].reason, 'triche-detectee')
      assert.equal(game._antiCheatLog()[0].rejected, true)
      assert.equal(game._gameStats.suspectMoves, 1)
      assert.equal(game._gameStats.rejectedMoves, 1)
      assert.equal(evenements.length, 1)
      assert.equal(evenements[0].reason, 'triche-detectee')
      game._destroy()
    })

    it("true SEUL (sans rejeter) → coup APPLIQUÉ quand même, journalisé, SEUL coupsSuspects incrémenté (coupsRejetesAntiTriche reste à 0)", () => {
      const def = resolveGameDef('susp-log', {
        seats: 1, state: () => ({ n: 0 }),
        moves: { inc: (game: any) => { game.state.n++ } },
        suspect: () => true,
      })
      const game = createGame(fakeApp(), def, () => {}, 'p2')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})   // ne throw PAS
      assert.equal(game.state.n, 1, 'le coup DOIT avoir été appliqué — true seul ne rejette jamais')
      assert.equal(game._antiCheatLog().length, 1)
      assert.equal(game._antiCheatLog()[0].rejected, false)
      assert.equal(game._antiCheatLog()[0].reason, 'suspect', 'raison PAR DÉFAUT quand def.suspect renvoie true sans objet {raison}')
      assert.equal(game._gameStats.suspectMoves, 1)
      assert.equal(game._gameStats.rejectedMoves, 0)
      game._destroy()
    })

    it('absent → coup normal, journal VIDE, compteurs à 0 (comportement inchangé)', () => {
      const def = resolveGameDef('susp-absent', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'p3')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 1)
      assert.deepEqual(game._antiCheatLog(), [])
      assert.equal(game._gameStats.suspectMoves, 0)
      game._destroy()
    })

    it('renvoie false explicite → RAS, journal VIDE (même politique que absent)', () => {
      const def = resolveGameDef('susp-false', {
        seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
        suspect: () => false,
      })
      const game = createGame(fakeApp(), def, () => {}, 'p4')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 1)
      assert.deepEqual(game._antiCheatLog(), [])
      game._destroy()
    })

    it('contexte reçu = { seat: INDEX numérique, game: instance entière, type: game.type, turn, phase } — jamais le MjsServerSeat complet', () => {
      let vu: any = null
      const def = resolveGameDef('susp-ctx', {
        seats: 2, state: () => ({}), moves: { inc: () => {} },
        phases: { jeu: ['inc'] },
        suspect: (move: string, ctx: any) => { vu = ctx; return false },
      })
      const game = createGame(fakeApp(), def, () => {}, 'p5')
      game.phase = 'jeu'
      const c1 = fakeClient('j1')
      const player = game._createSeat(c1)
      game._createSeat(fakeClient('j2'))
      game._onMove(c1, 'inc', {})
      assert.equal(typeof vu.seat, 'number', 'siege doit être un INDEX numérique, jamais l’objet MjsServerSeat (pas de .clients exposé)')
      assert.equal(vu.seat, player.seat)
      assert.equal(vu.game, game, 'game = l’instance ENTIÈRE, MÊME accès que def.moves/intents/simulate/view')
      assert.equal(vu.type, 'susp-ctx')
      assert.equal(vu.phase, 'jeu')
      assert.equal(vu.turn, null)
      game._destroy()
    })

    it('contexte.p = charge BRUTE du coup — permet au hook de rejeter sur le CONTENU, pas seulement le nom', () => {
      const def = resolveGameDef('susp-p', {
        seats: 1, state: () => ({ n: 0 }),
        moves: { inc: (game: any, _j: any, p: any) => { game.state.n += p.valeur } },
        suspect: (move: string, ctx: any) => (ctx.p && ctx.p.valeur > 100) ? { reject: true, reason: 'valeur-enorme' } : false,
      })
      const game = createGame(fakeApp(), def, () => {}, 'psp1')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', { valeur: 5 })
      assert.equal(game.state.n, 5, 'coup normal accepté — contenu sous le seuil')
      assert.throws(() => game._onMove(c1, 'inc', { valeur: 500 }), /valeur-enorme/, 'contexte.p doit permettre au hook d’inspecter le CONTENU du coup')
      assert.equal(game.state.n, 5, 'le coup rejeté ne doit JAMAIS avoir été appliqué')
      game._destroy()
    })
  })

  describe('2. def.antiRejeu (séquence _n/_s, monotone PAR SIÈGE)', () => {
    it('seq répétée ou inférieure (_s) → REJETÉE (rejeu/doublon), état non muté, compteur incrémenté', () => {
      const def = resolveGameDef('rejeu-1', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, antiReplay: true })
      const game = createGame(fakeApp(), def, () => {}, 'r1')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', { _s: 5 })
      assert.throws(() => game._onMove(c1, 'inc', { _s: 5 }), /rejeu/, 'MÊME seq → rejeu/doublon')
      assert.throws(() => game._onMove(c1, 'inc', { _s: 3 }), /rejeu/, 'seq INFÉRIEURE → rejeu')
      assert.equal(game.state.n, 1, 'seuls les coups ACCEPTÉS mutent l’état')
      assert.equal(game._gameStats.rejectedMoves, 2)
      game._destroy()
    })

    it('seq croissante (_s) → TOUJOURS acceptée', () => {
      const def = resolveGameDef('rejeu-2', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, antiReplay: true })
      const game = createGame(fakeApp(), def, () => {}, 'r2')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      for (let s = 1; s <= 5; s++) game._onMove(c1, 'inc', { _s: s })
      assert.equal(game.state.n, 5)
      game._destroy()
    })

    it('seq trop en avance (au-delà de la fenêtre) → rejetée (rejeu-fenetre) — protège contre un seq empoisonné', () => {
      const def = resolveGameDef('rejeu-3', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, antiReplay: true })
      const game = createGame(fakeApp(), def, () => {}, 'r3')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', { _s: 1 })
      assert.throws(() => game._onMove(c1, 'inc', { _s: 999999 }), /avance/)
      assert.equal(game.state.n, 1)
      game._destroy()
    })

    it('coup SANS _n ni _s → jamais bloqué par l’anti-rejeu (rétro-compat totale)', () => {
      const def = resolveGameDef('rejeu-4', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, antiReplay: true })
      const game = createGame(fakeApp(), def, () => {}, 'r4')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 2)
      game._destroy()
    })

    it('def.antiRejeu ABSENT → aucun contrôle, même avec un _s répété', () => {
      const def = resolveGameDef('rejeu-5', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'r5')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', { _s: 5 })
      game._onMove(c1, 'inc', { _s: 5 })   // MÊME seq, mais antiRejeu absent → jamais bloqué
      assert.equal(game.state.n, 2)
      game._destroy()
    })

    it('interaction µ.predict (_n, wire réel, mode action) : flux _n CROISSANT → JAMAIS de faux rejet, _ack continue de refléter le dernier _n APPLIQUÉ (réconciliation intacte)', async () => {
      const { transport, app } = await startApp()
      app.game('predict-ok', {
        seats: 1, code: true, tick: 20,
        antiReplay: true,
        state: () => ({ x: 0 }),
        intents: { bouger: (game: any, _joueur: any, p: any) => { game.state.x += p.dx } },
        moves: {},
      })
      const s = await connecter(transport, 'x')
      const rep = await s.request('µgame:play', { type: 'predict-ok', code: true })
      await tick(60)   // laisse passer la 1re diffusion (vue complète) avant d'observer
      const etats: any[] = []
      s.on('µgame:state', (p: any) => etats.push(p))
      for (const n of [1, 2, 3]) {
        const ack = await s.request('µgame:move', { game: rep.game, move: 'bouger', p: { dx: 1, _n: n } })
        assert.equal(ack.ok, true, `_n=${n} doit être ACCEPTÉ (flux predict légitime, croissant) — jamais rejeté par antiRejeu`)
      }
      await tick(70)
      assert.equal(etats[etats.length - 1]._ack, 3, '_ack doit refléter le dernier _n APPLIQUÉ — réconciliation predict INTACTE, jamais perturbée par antiRejeu (lecture seule de _n, cf. _extractAntiReplaySeq)')
      assert.equal(app.stats().game.rejectedMoves, 0, 'aucun rejet — flux predict légitime')
      await app.stop()
    })
  })

  describe('3. def.limits.moveIntervalMs (cadence instantanée, horloge SERVEUR)', () => {
    it('2 coups à < moveIntervalMs → le 2e est REJETÉ, journalisé (raison cadence), état muté une seule fois', () => {
      const def = resolveGameDef('cad-1', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, limits: { moves: null, moveIntervalMs: 10000 } })
      const game = createGame(fakeApp(), def, () => {}, 'c1')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      assert.throws(() => game._onMove(c1, 'inc', {}), /cadence/)
      assert.equal(game.state.n, 1)
      assert.equal(game._antiCheatLog().filter((e: any) => e.reason === 'rate').length, 1)
      assert.equal(game._gameStats.rejectedMoves, 1)
      game._destroy()
    })

    it('coups ESPACÉS (> moveIntervalMs) → tous acceptés', async () => {
      const def = resolveGameDef('cad-2', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, limits: { moves: null, moveIntervalMs: 20 } })
      const game = createGame(fakeApp(), def, () => {}, 'c2')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      await tick(30)
      game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 2)
      game._destroy()
    })

    it('option ABSENTE → aucun contrôle de cadence, même en rafale synchrone', () => {
      const def = resolveGameDef('cad-3', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, limits: { moves: null } })
      const game = createGame(fakeApp(), def, () => {}, 'c3')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      for (let i = 0; i < 10; i++) game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 10)
      game._destroy()
    })

    it('validation : limits.moveIntervalMs doit être un nombre > 0', () => {
      assert.throws(() => resolveGameDef('cad-bad1', { seats: 1, state: () => ({}), moves: {}, limits: { moveIntervalMs: 0 } }), /moveIntervalMs/)
      assert.throws(() => resolveGameDef('cad-bad2', { seats: 1, state: () => ({}), moves: {}, limits: { moveIntervalMs: -5 } }), /moveIntervalMs/)
      assert.throws(() => resolveGameDef('cad-bad3', { seats: 1, state: () => ({}), moves: {}, limits: { moveIntervalMs: 'x' as any } }), /moveIntervalMs/)
    })
  })

  describe('4. journal anti-triche borné + compteurs + def.onSuspicion + app.stats().game', () => {
    it('anneau plafonné à 100 entrées (JOURNAL_ANTITRICHE_MAX) — au-delà, les plus anciennes sont écrasées, MAIS le compteur reste exact (lui n’est pas plafonné)', () => {
      const def = resolveGameDef('journal-1', {
        seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
        limits: { moves: null }, suspect: () => true,
      })
      const game = createGame(fakeApp(), def, () => {}, 'j1')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      for (let i = 0; i < 130; i++) game._onMove(c1, 'inc', {})
      const journal = game._antiCheatLog()
      assert.equal(journal.length, 100, 'anneau plafonné à 100, jamais plus')
      assert.equal(game._gameStats.suspectMoves, 130, 'le COMPTEUR reste exact (130) — seul le JOURNAL est plafonné, pas les stats')
      game._destroy()
    })

    it('def.onSuspicion appelé à CHAQUE événement journalisé, avec la MÊME forme que l’entrée du journal', () => {
      const evenements: any[] = []
      const def = resolveGameDef('journal-2', {
        seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } },
        suspect: () => ({ reason: 'x' }),
        onSuspicion: (ev: any) => evenements.push(ev),
      })
      const game = createGame(fakeApp(), def, () => {}, 'j2')
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      game._onMove(c1, 'inc', {})
      assert.equal(evenements.length, 2)
      assert.deepEqual(evenements[0], game._antiCheatLog()[0])
      game._destroy()
    })

    it('app.stats().game.coupsSuspects/coupsRejetesAntiTriche — AGRÉGÉS app-entière, greffe ADDITIVE sur app.stats() (rétro-compatible : rien retiré du registre MJS-WS)', async () => {
      const { transport, app } = await startApp({ onLog: () => {} })   // refus INTENTIONNEL — pas de bruit
      app.game('stats-1', {
        seats: 1, code: true, state: () => ({ n: 0 }),
        moves: { inc: (game: any) => { game.state.n++ } },
        suspect: (move: string) => move === 'inc' ? { reject: true } : false,
      })
      const avant = app.stats()
      assert.equal(avant.game.suspectMoves, 0)
      assert.ok(avant.connexions, 'le reste du registre MJS-WS (connexions, garde, messages…) doit toujours être présent — greffe ADDITIVE, rien retiré')
      const s = await connecter(transport, 'x')
      const rep = await s.request('µgame:play', { type: 'stats-1', code: true })
      await assert.rejects(s.request('µgame:move', { game: rep.game, move: 'inc' }))
      const apres = app.stats()
      assert.equal(apres.game.suspectMoves, 1)
      assert.equal(apres.game.rejectedMoves, 1)
      await app.stop()
    })
  })

  describe('5. non-régression — un jeu SANS suspect/antiRejeu/moveIntervalMs se comporte EXACTEMENT comme avant', () => {
    it('resolveGameDef sans les 3 options → suspect/onSuspicion null, antiRejeu false, limits.moveIntervalMs null (défauts inertes)', () => {
      const def = resolveGameDef('noop-1', { seats: 1, state: () => ({}), moves: {} })
      assert.equal(def.suspect, null)
      assert.equal(def.antiReplay, false)
      assert.equal(def.onSuspicion, null)
      assert.equal(def.limits.moveIntervalMs, null)
    })

    it('un flood de coups (dans la limite du quota par défaut) ne journalise RIEN, ne touche à aucun compteur', () => {
      const def = resolveGameDef('noop-2', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'nr1')
      game._gameStats = gameStats()
      const c1 = fakeClient('j1')
      game._createSeat(c1)
      for (let i = 0; i < 20; i++) game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 20)
      assert.deepEqual(game._antiCheatLog(), [])
      assert.equal(game._gameStats.suspectMoves, 0)
      assert.equal(game._gameStats.rejectedMoves, 0)
      game._destroy()
    })

    it('validation : def.suspect doit être une fonction, def.antiRejeu doit être true (ou absent), def.onSuspicion doit être une fonction', () => {
      assert.throws(() => resolveGameDef('bad-1', { seats: 1, state: () => ({}), moves: {}, suspect: 'x' as any }), /suspect doit être une fonction/)
      assert.throws(() => resolveGameDef('bad-2', { seats: 1, state: () => ({}), moves: {}, antiReplay: false as any }), /antiReplay doit être true/)
      assert.throws(() => resolveGameDef('bad-3', { seats: 1, state: () => ({}), moves: {}, onSuspicion: 'x' as any }), /onSuspicion doit être une fonction/)
    })

    it("clé inconnue proche de 'suspect'/'antiRejeu' → suggestion orthographique (même patron que le reste de resolveGameDef)", () => {
      assert.throws(() => resolveGameDef('typo-1', { seats: 1, state: () => ({}), moves: {}, suspet: () => {} } as any), /suspect/)
      assert.throws(() => resolveGameDef('typo-2', { seats: 1, state: () => ({}), moves: {}, antiRejou: true } as any), /antiReplay/)
    })

    it('mode lockstep : def.suspect/antiRejeu/limits.moveIntervalMs restent AUTORISÉS (mode-agnostique — un ORDRE reste un coup pour ces gardes génériques)', () => {
      assert.doesNotThrow(() => resolveGameDef('lock-1', {
        mode: 'lockstep', seats: 2, tick: 10, moves: {},
        suspect: () => false, antiReplay: true, limits: { moveIntervalMs: 50 },
      }))
    })

    it('mode lockstep (wire réel) : un ordre suspect+rejeté n’apparaît JAMAIS dans µgame:orders, un ordre normal y apparaît toujours', async () => {
      const { transport, app } = await startApp({ onLog: () => {} })   // refus INTENTIONNEL — pas de bruit
      app.game('lock-wire', {
        mode: 'lockstep', seats: 1, code: true, tick: 20,
        moves: {},
        suspect: (move: string) => move === 'triche' ? { reject: true } : false,
      })
      const s = await connecter(transport, 'x')
      const rep = await s.request('µgame:play', { type: 'lock-wire', code: true })
      const orders: any[] = []
      s.on('µgame:orders', (p: any) => orders.push(...p.orders))
      await assert.rejects(s.request('µgame:move', { game: rep.game, move: 'triche' }), (e: any) => /suspect/i.test(String(e)))
      const ackOk = await s.request('µgame:move', { game: rep.game, move: 'ok' })
      assert.equal(ackOk.ok, true)
      await tick(120)
      assert.ok(orders.every((o: any) => o.move !== 'triche'), 'le coup suspect rejeté ne doit JAMAIS apparaître dans les ordres diffusés')
      assert.ok(orders.some((o: any) => o.move === 'ok'), 'le coup normal doit apparaître normalement')
      await app.stop()
    })
  })
})
