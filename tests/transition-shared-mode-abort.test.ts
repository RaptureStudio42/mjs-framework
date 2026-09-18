// le mode `.shared`
// (`@transition.name.shared`, @keyframes CSS partagé — cf. mjs_easing.ts
// `_runSharedTransition`/`µ.anim._mjs_runShared`) ne posait JAMAIS
// `node._mjs_transition_state`. Or `µ._mjs_runTransition` n'interrompt une
// transition PRÉCÉDENTE sur le même node QUE via `prev.abort()`, où `prev =
// node._mjs_transition_state` — sans cette pose, deux transitions `.shared`
// qui se chevauchent (ex. toggle rapide) ne se voient JAMAIS : la 2e écrase
// `node.style.animation`, puis le `animationcancel` natif déclenché par cet
// écrasement réveille le `onEnd` de la 1ʳᵉ, qui réassigne `node.style.animation
// = prev1` (SA valeur d'avant, pas celle de la 2e transition) PAR-DESSUS la
// 2e — la 2e transition est silencieusement stompée juste après avoir démarré.
//
// Fix : `_mjs_runShared` pose désormais un `state` avec `abort()` sur
// `node._mjs_transition_state`. `abort()` retire les listeners + release les
// keyframes + resolve la Promise AVANT que l'appelant n'écrive la nouvelle
// valeur (même ordre que les modes tick/css) — l'`animationcancel` natif ne
// trouve alors plus aucun listener à faire réagir.

import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win: any = new Window({ url: 'http://localhost/' })
// Fusion (PAS remplacement) sur le `µ` global partagé entre TOUS les fichiers
// de test du process Mocha — cf. transition-tick-abort-resolves.test.ts pour
// le détail de la régression croisée vécue avec un `= X || {...}` wholesale.
;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
await import('../src/runtime/mjs_easing.js')

function makeCfg() {
  return { css: (t: number, _u: number) => ({ opacity: String(t) }), duration: 400 }
}

describe('µ._mjs_runTransition (mode .shared) — abort quand une 2e transition démarre sur le même node', function () {
  // `document` posé PAR TEST, valeur d'origine restaurée à la fin : csp-runtime.test.ts fait
  // `delete globalThis.document` en afterEach — une pose au CHARGEMENT du fichier ne survit
  // pas à un groupe où il passe avant (vert seul, rouge en groupe)
  let __prevDoc: any
  before(() => { __prevDoc = (globalThis as any).document })
  beforeEach(() => { (globalThis as any).document = win.document })
  after(() => { if(__prevDoc !== undefined) (globalThis as any).document = __prevDoc; else delete (globalThis as any).document })

  it('pose bien node._mjs_transition_state (contrairement à avant le fix)', function () {
    const node: any = win.document.createElement('div')
    node._mjs_anim_mode = 'shared'
    µ._mjs_runTransition(node, makeCfg(), 'in')
    assert.ok(node._mjs_transition_state, 'AVANT le fix : jamais posé → prev.abort() introuvable pour une 2e transition')
    assert.equal(typeof node._mjs_transition_state.abort, 'function')
  })

  it("abort de la 1ère transition retire bien SON listener — un animationcancel qui suit n'exécute plus SON onEnd (qui stomperait avec SA PROPRE prev, distincte de celle de la 2e)", async function () {
    const node: any = win.document.createElement('div')
    node._mjs_anim_mode = 'shared'
    // Valeur bien distincte de tout hash `_kf_…` généré, pour désambiguïser
    // sans équivoque "onEnd de la 1ère transition a fait ça" (restaurerait à
    // CETTE valeur, sa `prev` à ELLE) vs "onEnd de la 2e a fait ça" (restaurerait
    // à `anim1Value`, SA `prev` à elle).
    node.style.animation = 'initial-anim 100ms'

    const p1 = µ._mjs_runTransition(node, makeCfg(), 'in')
    const anim1Value = node.style.animation
    assert.ok(anim1Value && anim1Value !== 'initial-anim 100ms', 'la 1ère transition doit poser SA valeur (@keyframes)')

    // 2e transition sur le MÊME node AVANT que la 1ère ne se termine — déclenche
    // en interne `prev.abort()` (cf. µ._mjs_runTransition, ligne ~657-659).
    const p2 = µ._mjs_runTransition(node, makeCfg(), 'out')
    const anim2Value = node.style.animation
    assert.ok(anim2Value, 'la 2e transition doit poser SA valeur')
    assert.notEqual(anim2Value, anim1Value, 'les 2 transitions ont des @keyframes distincts (in vs out)')

    // La 1ère Promise doit résoudre (abortée), pas rester bloquée.
    await Promise.race([
      p1,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — p1 (.shared) jamais résolue après abort')), 500)),
    ])

    // === filtre e.target / e.animationName ===
    // En VRAI navigateur, avoir remplacé `node.style.animation` pour la 2e
    // transition émet un `animationcancel` pour l'ANCIENNE anim (le keyframe de la
    // 1ère transition, `name1`). Cet event vise le node animé (`e.target === node`)
    // : le `onEnd` de la 2e transition — seul listener encore en place après
    // l'abort de la 1ère — le reçoit. SANS le filtre `animationName`, il settlerait
    // aussitôt et restaurerait `prev2` (= anim1Value) PAR-DESSUS la 2e transition
    // qui vient pourtant de démarrer → 2e transition TUÉE ~1 frame après son
    // départ. AVEC le filtre : `e.animationName` (name1) ≠ le keyframe de CETTE
    // transition (name2) → event ignoré → la 2e transition est CONSERVÉE.
    const name1 = anim1Value.split(' ')[0]
    const name2 = anim2Value.split(' ')[0]
    assert.notEqual(name1, name2, 'les 2 keyframes doivent différer pour que le test discrimine')

    const evOld: any = new win.Event('animationcancel')
    evOld.animationName = name1 // animationcancel de l'ANCIENNE anim (transition 1)
    node.dispatchEvent(evOld)
    assert.equal(
      node.style.animation, anim2Value,
      "06-02 : l'animationcancel de l'ancienne anim (name1) ne doit PAS stomper la 2e transition — " +
      'le filtre e.animationName la CONSERVE (anim2Value maintenue)',
    )

    // La 2e transition se termine ensuite normalement (son PROPRE animationend :
    // e.target === node ET e.animationName === name2) → restaure sa prev + résout.
    const evOwn: any = new win.Event('animationend')
    evOwn.animationName = name2
    node.dispatchEvent(evOwn)
    await p2
  })

  it('un animationend BUBBLÉ depuis un ENFANT ne résout pas la transition .shared du parent (filtre e.target)', async function () {
    const node: any = win.document.createElement('div')
    const child: any = win.document.createElement('span')
    node.appendChild(child)
    node._mjs_anim_mode = 'shared'

    const p = µ._mjs_runTransition(node, makeCfg(), 'in')
    const parentAnim = node.style.animation
    assert.ok(parentAnim, 'la transition .shared du parent a posé son animation')
    const parentName = parentAnim.split(' ')[0]

    let resolved = false
    p.then(() => { resolved = true })

    // Un DESCENDANT termine SA propre animation CSS → l'event BUBBLE jusqu'au
    // listener du parent (e.target === l'enfant). SANS filtre e.target, le parent
    // croirait SON intro finie : restaure `prev` (anim coupée) + settle (Promise
    // résolue à tort, groupe d'outro faussé). AVEC filtre : e.target !== node →
    // ignoré.
    child.dispatchEvent(new win.Event('animationend', { bubbles: true }))
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(resolved, false, "06-02 : un animationend bubblé d'un enfant ne doit pas résoudre la transition .shared du parent")
    assert.equal(node.style.animation, parentAnim, "06-02 : l'animation du parent ne doit pas être restaurée par un event d'enfant")

    // La vraie fin de la transition du parent (son propre event, e.target === node) résout.
    const evOwn: any = new win.Event('animationend')
    evOwn.animationName = parentName
    node.dispatchEvent(evOwn)
    await p
    assert.equal(resolved, true, 'la fin légitime (event du node lui-même) résout bien la transition')
  })

  it("abort() retire bien les listeners : un animationcancel tardif sur la transition ABORTÉE ne fait plus rien (pas de double-release des keyframes)", async function () {
    const node: any = win.document.createElement('div')
    node._mjs_anim_mode = 'shared'
    const p1 = µ._mjs_runTransition(node, makeCfg(), 'in')
    const _state1 = node._mjs_transition_state

    const p2 = µ._mjs_runTransition(node, makeCfg(), 'out')
    await p1

    // Un animationcancel qui arriverait malgré tout pour la transition abortée
    // ne doit plus rien faire (listeners déjà retirés par settle() dans abort()).
    assert.doesNotThrow(() => node.dispatchEvent(new win.Event('animationcancel')))

    node.dispatchEvent(new win.Event('animationend'))
    await p2
  })
})
