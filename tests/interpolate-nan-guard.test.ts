// Régression : `µ.interpolate` n'avait
// AUCUNE garde NaN/Infinity, contrairement à `µspring` (qui a déjà
// `_mjsDeepFinite`). `$x = input.valueAsNumber` sur un champ number VIDÉ
// (NaN, cas banal) corrompait l'interpolateur À VIE : `target=NaN` (le
// court-circuit `target===newTarget` ne protège pas, `NaN===NaN` est faux),
// `_mjs_step` calculait `current=NaN` dès le 1er tick, puis `_mjs_startValue =
// this.current` au `set` SUIVANT capturait ce NaN — même avec des cibles
// valides ensuite, l'interpolateur restait mort.

import assert from 'node:assert/strict'

;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} }, warn() {} }
await import('../src/runtime/mjs_interpolate.js')
const µ = (globalThis as any).µ

describe('µ.interpolate — garde NaN/Infinity', () => {
  it('value = NaN est IGNORÉ (pas de corruption)', () => {
    const it = µ.interpolate(10)
    it.value = NaN
    assert.equal(it.target, 10, 'la cible ne doit pas devenir NaN')
    assert.equal(Number.isFinite(it.current), true, 'current doit rester fini')
  })

  it("après un value=NaN rejeté, une cible VALIDE ensuite fonctionne toujours (pas de corruption permanente)", () => {
    const it = µ.interpolate(10)
    it.value = NaN
    it.value = 50
    assert.equal(it.target, 50, "AVANT le fix : l'interpolateur restait corrompu à vie après un seul NaN")
    it._mjs_step(performance.now() + it.duration) // force la fin de la transition
    assert.equal(Number.isFinite(it.current), true)
    assert.ok(Math.abs(it.current - 50) < 1)
  })

  it('value = Infinity est IGNORÉ', () => {
    const it = µ.interpolate(0)
    it.value = Infinity
    assert.equal(it.target, 0)
  })

  it('value = "not a number" (type non-number) est IGNORÉ', () => {
    const it = µ.interpolate(5)
    ;(it as any).value = 'oops'
    assert.equal(it.target, 5)
  })

  it('_mjs_step ne propage jamais NaN même si next le devient (filet de sécurité)', () => {
    const it = µ.interpolate(10)
    // Force un état interne incohérent pour tester le filet de _mjs_step (pas
    // atteignable via l'API publique depuis le fix du setter — on le simule
    // directement pour couvrir la ceinture+bretelles).
    ;(it as any)._mjs_startValue = NaN
    ;(it as any)._mjs_startTime = performance.now() - 10
    it._mjs_step(performance.now())
    assert.equal(Number.isFinite(it.current), true, 'le filet de _mjs_step doit rattraper un calcul non-fini')
  })

  it('cas nominal (valeurs valides) : convergence normale inchangée', () => {
    const it = µ.interpolate(0, 100)
    it.value = 100
    const start = performance.now()
    it._mjs_step(start + 100)
    assert.ok(Math.abs(it.current - 100) < 1)
  })
})
