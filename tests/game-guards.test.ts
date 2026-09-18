// Trois correctifs du moteur de partie (game.ts), harnais direct fakeApp()/fakeClient()
// (MÊME patron que tests/mjs-server-anti-triche-detection.test.ts) : pas besoin d'un vrai transport
// pour ces 3 mécaniques internes (peerIdOf, garde _ended, restoreGame).
//  1. identity.id vide/blanche ne collisionne plus deux connexions sur le même siège.
//  2. un coup après .end() est refusé (throw), jamais appliqué, jamais diffusé.
//  3. un rejeu bloqué avant redémarrage reste bloqué APRÈS restoreGame (anti-rejeu persisté).
import assert from 'node:assert/strict'
import { resolveGameDef, createGame, peerIdOf, restoreGame } from '../src/mjs-server/index.js'

function fakeApp(): any { return { send() {} } }
function fakeClient(id: string, identityId?: string): any {
  return { id, identity: identityId === undefined ? undefined : { id: identityId }, latency: null, meta: {}, send() {}, close() {} }
}

describe('correctifs game.ts', () => {
  describe('peerIdOf — identité vide/blanche', () => {
    it("identity.id === '' → repli sur l'id de connexion (pas de collision)", () => {
      const a = fakeClient('conn-a', '')
      const b = fakeClient('conn-b', '')
      assert.equal(peerIdOf(a), 'conn-a')
      assert.equal(peerIdOf(b), 'conn-b')
    })

    it("identity.id === '   ' (blanche) → même repli", () => {
      const c = fakeClient('conn-c', '   ')
      assert.equal(peerIdOf(c), 'conn-c')
    })

    it('deux connexions sans identité stable obtiennent deux sièges distincts', () => {
      const def = resolveGameDef('s1-1-seats', { seats: 2, state: () => ({}), moves: {} })
      const game = createGame(fakeApp(), def, () => {}, 'g1')
      const a = fakeClient('conn-a', '')
      const b = fakeClient('conn-b', '')
      const seatA = game._createSeat(a)
      const seatB = game._createSeat(b)
      assert.notEqual(seatA.seat, seatB.seat)
      assert.equal(game.players.filter((j: any) => j).length, 2)
      game._destroy()
    })
  })

  describe('garde _ended dans _onMove', () => {
    it('un coup après .end() est REJETÉ (throw), jamais appliqué', () => {
      const def = resolveGameDef('s2-1-move', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } } })
      const game = createGame(fakeApp(), def, () => {}, 'g2')
      const c1 = fakeClient('conn-1', 'j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', {})
      assert.equal(game.state.n, 1)
      game.end({ vainqueur: 'j1' })
      assert.throws(() => game._onMove(c1, 'inc', {}), /terminée|ended/)
      assert.equal(game.state.n, 1, 'le coup après .end() ne doit JAMAIS avoir été appliqué')
      game._destroy()
    })

    it('même garde sur _receiveHash (mode lockstep) — ignoré silencieusement après .end()', () => {
      const def = resolveGameDef('s2-1-hash', { seats: 1, mode: 'lockstep', tick: 10, moves: {} })
      const game = createGame(fakeApp(), def, () => {}, 'g3')
      const c1 = fakeClient('conn-1', 'j1')
      game._createSeat(c1)
      game.end(null)
      assert.doesNotThrow(() => game._receiveHash(c1, 1, 'hash-quelconque'))
      game._destroy()
    })
  })

  describe('restoreGame préserve l\'anti-rejeu par joueur', () => {
    it('un rejeu bloqué AVANT redémarrage reste bloqué APRÈS restoreGame', () => {
      const def = resolveGameDef('s2-2-restore', { seats: 1, state: () => ({ n: 0 }), moves: { inc: (game: any) => { game.state.n++ } }, antiReplay: true })
      const game = createGame(fakeApp(), def, () => {}, 'g4')
      const c1 = fakeClient('conn-1', 'j1')
      game._createSeat(c1)
      game._onMove(c1, 'inc', { _s: 5 })
      assert.equal(game.state.n, 1)
      assert.throws(() => game._onMove(c1, 'inc', { _s: 5 }), /rejeu/, 'rejeu AVANT redémarrage doit déjà être bloqué')

      const snapshot = game.serialize()
      game._destroy()

      const restored = restoreGame(fakeApp(), def, () => {}, snapshot)
      const c2 = fakeClient('conn-2', 'j1')
      restored._createSeat(c2)
      assert.throws(() => restored._onMove(c2, 'inc', { _s: 5 }), /rejeu/, 'même seq (5) rejouée APRÈS restoreGame doit rester bloquée')
      assert.equal(restored.state.n, 1, 'le rejeu ne doit jamais avoir été réappliqué après restauration (n reste au 1 du snapshot)')
      restored._destroy()
    })
  })
})
