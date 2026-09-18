// Régression : `_invalidator` (µspring ET
// µ.interpolate) était un SLOT UNIQUE — pas une collection :
//   (a) un ressort/interpolateur PARTAGÉ (singleton/module) affiché par 2
//       composants voyait le 2ᵉ `_mjs_attachInvalidator` ÉCRASER le 1ᵉʳ → seul
//       le DERNIER composant monté se re-rendait.
//   (b) au destroy d'un composant, rien ne détachait son invalidator → un
//       ressort encore actif continuait d'appeler `_mjs_notifyMutation` sur un
//       composant MORT (retenu en mémoire).
//
// Fix : `Map<owner, fn>` — un ré-attach du MÊME owner remplace son entrée
// (pas d'accumulation), et `_mjs_notifyInvalidators` purge PARESSEUSEMENT les
// owners `_mjs_dead` au moment de la notification.

import assert from 'node:assert/strict'

;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} }, warn() {} }
await import('../src/runtime/mjs_spring.js')
await import('../src/runtime/mjs_interpolate.js')
const µ = (globalThis as any).µ

describe('µspring/µ.interpolate — invalidateurs multi-owner (fix Map)', function () {
  it('µspring : DEUX owners attachés sont TOUS LES DEUX notifiés (pas juste le dernier)', () => {
    const s = µ.spring(0, 0.3, 0.5)
    let callsA = 0, callsB = 0
    const ownerA = {}
    const ownerB = {}
    s._mjs_attachInvalidator(ownerA, () => { callsA++ })
    s._mjs_attachInvalidator(ownerB, () => { callsB++ })
    s.value = 100
    s._mjs_step()
    assert.ok(callsA > 0, "AVANT le fix : ownerA (attaché en premier) n'était JAMAIS notifié (écrasé par ownerB)")
    assert.ok(callsB > 0, 'ownerB doit aussi être notifié')
  })

  it("µspring : ré-attacher le MÊME owner remplace son entrée (pas d'accumulation)", () => {
    const s = µ.spring(0, 0.3, 0.5)
    const owner = {}
    let calls = 0
    s._mjs_attachInvalidator(owner, () => { calls++ })
    s._mjs_attachInvalidator(owner, () => { calls++ }) // ré-attach (ex. re-render)
    assert.equal(s._mjs_invalidators.size, 1, 'un seul owner = une seule entrée, malgré 2 attach')
    s.value = 50
    s._mjs_step()
    assert.equal(calls, 1, 'un seul appel par _mjs_step, pas 2 (pas de doublon de closure)')
  })

  it('µspring : un owner marqué _mjs_dead est purgé et ne reçoit plus de notification', () => {
    const s = µ.spring(0, 0.3, 0.5)
    let callsAlive = 0, callsDead = 0
    const alive = {}
    const dead = { _mjs_dead: true }
    s._mjs_attachInvalidator(alive, () => { callsAlive++ })
    s._mjs_attachInvalidator(dead, () => { callsDead++ })
    assert.equal(s._mjs_invalidators.size, 2)
    s.value = 100
    s._mjs_step()
    assert.equal(callsDead, 0, "AVANT le fix : le composant mort restait notifié indéfiniment (retenu en mémoire)")
    assert.ok(callsAlive > 0, 'le survivant doit toujours être notifié')
    assert.equal(s._mjs_invalidators.size, 1, "l'entrée morte doit être purgée de la Map (pas de fuite mémoire)")
  })

  it('µ.interpolate : mêmes garanties multi-owner que µspring', () => {
    const it = µ.interpolate(0, 100)
    let callsA = 0, callsB = 0
    const ownerA = {}
    const ownerB = { _mjs_dead: true }
    it._mjs_attachInvalidator(ownerA, () => { callsA++ })
    it._mjs_attachInvalidator(ownerB, () => { callsB++ })
    it.value = 100
    it._mjs_step(performance.now() + 50)
    assert.ok(callsA > 0, 'owner vivant notifié')
    assert.equal(callsB, 0, 'owner mort jamais notifié')
    assert.equal(it._mjs_invalidators.size, 1, 'owner mort purgé')
  })

  it('cas nominal (un seul owner, jamais mort) : comportement inchangé', () => {
    const s = µ.spring(0, 0.3, 0.5)
    let calls = 0
    s._mjs_attachInvalidator({}, () => { calls++ })
    s.value = 10
    s._mjs_step()
    assert.equal(calls, 1)
  })
})
