// `precision` est une propriété
// PUBLIQUE du ressort (`this.precision`, lue par `_mjsSpringStep`). À
// `precision <= 0` (ou NaN/Infinity — ex. un slider mal câblé, un
// `spring.precision = 0`), la condition de settle (`|vel| < precision` ET
// `|tgt-next| < precision`) devient INATTEIGNABLE → `_mjs_step` ne retourne jamais
// false → tâche µ.Ticker/rAF IMMORTELLE, même après destroy du composant.
// EXACTE même classe de bug que `damping=0` (cf. spring-damping-zero.test.ts).
// Fix : accessor `precision` clampé à un plancher epsilon (`_mjsClampPrecision`),
// aligné sur les accessors damping/stiffness qui bornent déjà pour cette raison.

import assert from 'node:assert/strict'

;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} } }
await import('../src/runtime/mjs_spring.js')
const µ = (globalThis as any).µ

function settleOrTimeout(s: any, max = 2000): { settled: boolean; iterations: number } {
  let i = 0
  while (i < max) {
    i++
    if (!s._mjs_step()) return { settled: true, iterations: i }
  }
  return { settled: false, iterations: i }
}

describe('µ.spring — precision : plancher epsilon (plus de Ticker immortel)', () => {
  it('precision <= 0 (0, négative, NaN) est clampée à une valeur strictement positive', () => {
    const s = µ.spring(0)
    s.precision = 0
    assert.ok(s.precision > 0, `precision=0 doit être clampée, reçu ${s.precision}`)
    s.precision = -5
    assert.ok(s.precision > 0, `precision négative doit être clampée, reçu ${s.precision}`)
    s.precision = NaN
    assert.ok(s.precision > 0, `precision NaN doit être clampée, reçu ${s.precision}`)
  })

  it('une precision légitime (> 0) est conservée telle quelle', () => {
    const s = µ.spring(0)
    s.precision = 0.5
    assert.equal(s.precision, 0.5)
  })

  it('un ressort avec precision=0 SETTLE quand même en temps fini (pas de boucle rAF immortelle)', () => {
    const s = µ.spring(0, 0.15, 0.8)
    s.precision = 0
    s.value = 100
    const { settled, iterations } = settleOrTimeout(s)
    assert.ok(settled, `AVANT le fix : |vel| < 0 jamais vrai → jamais settled (${iterations} itérations sans converger)`)
    assert.ok(Math.abs(s.current - 100) < 1, `converge vers la cible, reçu ${s.current}`)
  })

  it('valeur par défaut inchangée (0.01)', () => {
    const s = µ.spring(0)
    assert.equal(s.precision, 0.01)
  })
})
