// "flash-zombie" — un cancel()
// individuel qui libère le `fill:'forwards'` DÈS QUE CE nœud finit son outro,
// même s'il fait partie d'un GROUPE (`_mjs_destroyNodeAndChildren`, plusieurs
// `elements` avec chacune leur transition, `Promise.all` les attend TOUTES
// avant de retirer le groupe du DOM). Si ce nœud a une durée plus courte qu'un
// sibling/enfant du même groupe, son fill se libère AVANT que le groupe soit
// retiré → il "rebondit" visuellement à son état naturel (ex. height auto au
// lieu de 0) pendant que le reste du groupe est encore visible — flash réel,
// proportionnel à l'écart de durée entre membres.
//
// Fix : le cancel() est DIFFÉRÉ (`node._mjs_pendingFillRelease`, mjs_easing.ts)
// pour une transition 'out' ; `_mjs_destroyNodeAndChildren` (mjs_element.ts)
// consomme ce hook pour CHAQUE membre du groupe juste après que
// `Promise.all(transitions)` se soit résolu (plus aucun risque de flash à ce
// moment — tout le groupe est arrivé à terme).
//
// WAAPI (`element.animate()`) n'existe pas sous happy-dom (confirmé
// empiriquement — cf. transition-css-no-flash.test.ts) : on fournit un
// `node.animate()` FAKE entièrement contrôlable (Promise `finished` pilotée à
// la main) pour exercer la VRAIE logique de `µ._mjs_runTransition` sans navigateur.

import assert from 'node:assert/strict'

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

// `node.animate()` fake : retourne un objet Animation minimal, avec `.finished`
// piloté manuellement (pas de vrai moteur d'anim) et un `.cancel()` espionné.
function makeFakeNode() {
  const animCalls: any[] = []
  const node: any = { style: {}, animCalls }
  node.animate = (keyframes: any, opts: any) => {
    let doResolve: () => void = () => {}
    let doReject: (e: any) => void = () => {}
    const finished = new Promise<void>((res, rej) => { doResolve = res; doReject = rej })
    const anim: any = {
      cancelled: false,
      keyframes,
      opts,
      finished,
      effect: { getComputedTiming: () => ({ progress: 0 }) },
      cancel() {
        this.cancelled = true
        doReject(Object.assign(new Error('cancelled'), { name: 'AbortError' }))
      },
      _finish: () => doResolve(),
    }
    animCalls.push(anim)
    return anim
  }
  return node
}

function makeCfg(duration = 200) {
  return { css: (t: number, _u: number) => ({ opacity: String(t) }), duration }
}

describe('µ._mjs_runTransition (mode css) — outro de groupe : le fill reste épinglé jusqu\'à consommation explicite', function () {
  it("direction 'out' : ne cancel PAS immédiatement au finish — pose node._mjs_pendingFillRelease à la place", async function () {
    const node = makeFakeNode()
    const p = µ._mjs_runTransition(node, makeCfg(), 'out')

    // animCalls[0] = anim "bidon" (anti-flash, duration=delay=0) → la termine.
    assert.equal(node.animCalls.length, 1, 'anim bidon créée en 1er')
    node.animCalls[0]._finish()
    await Promise.resolve().then(() => Promise.resolve()) // laisse le .then(startMain) s'exécuter

    // animCalls[1] = la VRAIE animation (keyframes réels).
    assert.equal(node.animCalls.length, 2, 'vraie animation créée après la bidon')
    const realAnim = node.animCalls[1]
    assert.equal(realAnim.cancelled, false)

    // La vraie animation finit naturellement.
    realAnim._finish()
    await p // la Promise de _mjs_runTransition résout dès le finish (out) — pas besoin d'attendre pendingFillRelease

    assert.equal(realAnim.cancelled, false, "AVANT le fix : cancel() était appelé ICI (immédiatement) → flash-zombie si un sibling du groupe est encore en vol")
    assert.equal(typeof node._mjs_pendingFillRelease, 'function', 'le hook de libération différée doit être posé, prêt à être consommé par le groupe')

    // Consommation du hook (ce que fait _mjs_destroyNodeAndChildren après Promise.all du GROUPE ENTIER).
    node._mjs_pendingFillRelease()
    assert.equal(realAnim.cancelled, true, 'le cancel() a bien fini par arriver, une fois le hook consommé')
    assert.equal(node._mjs_pendingFillRelease, null, 'le hook se nettoie lui-même après appel')
  })

  it("direction 'in' : continue de cancel IMMÉDIATEMENT au finish (pas de groupe de destruction concerné)", async function () {
    const node = makeFakeNode()
    const p = µ._mjs_runTransition(node, makeCfg(), 'in')

    node.animCalls[0]._finish() // bidon
    await Promise.resolve().then(() => Promise.resolve())
    const realAnim = node.animCalls[1]

    realAnim._finish() // vraie anim
    await p

    assert.equal(realAnim.cancelled, true, "une intro doit toujours libérer son fill immédiatement (pas de notion de groupe)")
    assert.equal(node._mjs_pendingFillRelease, undefined, "pas de hook différé posé pour une intro")
  })
})
