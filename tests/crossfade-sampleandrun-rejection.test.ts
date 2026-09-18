// Régression : `sampleAndRun` (fallback
// `css(t,u)` du crossfade, animations/crossfade.ts) ne gérait QUE le succès de
// `anim.finished` (`.then(onFulfilled)`, PAS de 2ᵉ argument `onRejected`) —
// contrairement à `buildAnim` juste au-dessus dans le MÊME fichier, qui a
// `.then(onFulfilled, onRejected)`.
//
// `anim.finished` (WAAPI) REJETTE si l'Animation est annulée (node retiré du
// DOM, ou une autre transition qui la supplante). Sans handler de rejet, cette
// rejection se PROPAGE non rattrapée jusqu'à l'appelant (`sampleAndRun(...)
// .then(resolve, reject)`, qui la répercute sur la Promise du handler
// `@in`/`@out`). Si ce handler fait partie du tableau `transitions` d'un
// groupe d'outro (`_mjs_destroyNodeAndChildren`, `await Promise.all(transitions)`),
// UNE SEULE transition annulée fait REJETER TOUT LE GROUPE → le reste de la
// séquence destroy (marquage `_mjs_dead`, callbacks `outroend`, `node.remove()`)
// n'est JAMAIS exécuté → node(s) zombie bloqué(s) en `_mjs_dying` À VIE.
//
// Fix : même contrat que `buildAnim`/`µ._mjs_runTransition` (mode css) — une
// annulation RÉSOUT gracieusement (pas de re-throw), après avoir quand même
// libéré le fill via `anim.cancel()`.
//
// WAAPI (`element.animate()`) n'existe pas sous happy-dom (confirmé
// empiriquement, cf. transition-css-no-flash.test.ts) : `node.animate` est
// FAKE et entièrement contrôlable (comme pour transition-outro-group-fill-
// deferred.test.ts). `crossfade.ts` n'est pas un module ESM autonome (son
// contenu EST la valeur assignée à `µ.anim.crossfade` par le bundler,
// cf. `compileUsedAnimations` dans src/bundler/index.ts : `µ.anim.crossfade =
// <src>;`) — on reproduit ce même branchement ici avec `new Function` plutôt
// que de deviner une syntaxe `@out.NOM` (qui référence `µ.anim.NOM`, hors
// sujet ici).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
await import('../src/runtime/mjs_easing.js') // µ.easing réel (µ.easing.resolve)

// Même branchement que le bundler (compileUsedAnimations) : `µ.anim.crossfade
// = <contenu du fichier>;` — le fichier n'est PAS un module qui s'auto-exporte.
const crossfadeSrc = readFileSync(join(process.cwd(), 'src/runtime/animations/crossfade.ts'), 'utf-8')
new Function('µ', `µ.anim = µ.anim || {}; µ.anim.crossfade = ${crossfadeSrc.trim()};`)(µ)

function makeFakeNode() {
  const calls: any[] = []
  const node: any = { style: {} }
  node.animate = (_keyframes: any, _opts: any) => {
    let doResolve: () => void = () => {}
    let doReject: (e: any) => void = () => {}
    const finished = new Promise<void>((res, rej) => { doResolve = res; doReject = rej })
    const anim: any = {
      cancelled: false,
      finished,
      cancel() { this.cancelled = true },
      _finish: () => doResolve(),
      _reject: () => doReject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
    }
    calls.push(anim)
    return anim
  }
  return { node, calls }
}

let uid = 0
function registerFallbackCrossfade() {
  const name = `xf${++uid}`
  µ.anim.crossfade(name, {
    fallback: (_node: any, _params: any, _isIntro: boolean) => ({
      css: (t: number) => ({ opacity: String(t) }),
      duration: 100,
    }),
  })
  return name
}

describe('crossfade — sampleAndRun (fallback css) : gestion du rejet de anim.finished', function () {
  // Installé/restauré PAR TEST (pas au chargement du module) : `crossfade.ts`
  // (`__defer`, 2 rAF) lit `requestAnimationFrame` sur `globalThis` au moment
  // de l'APPEL, pas de l'import. Un `= ...` unique au top-level du fichier
  // serait écrasé par un AUTRE fichier de test qui fait la même chose à SON
  // top-level (Mocha charge TOUS les fichiers avant d'exécuter le moindre
  // test — le dernier chargé "gagne" pour toute la phase d'exécution qui
  // suit) — vécu en régression croisée avec transition-tick-abort-resolves.test.ts
  // (rAF en file d'attente manuelle, jamais auto-exécutée) lors du 1er passage
  // en suite complète. Portée par test + restauration = robuste à l'ordre.
  let __prevRaf: any
  beforeEach(() => {
    __prevRaf = (globalThis as any).requestAnimationFrame
    ;(globalThis as any).requestAnimationFrame = (cb: any) => { Promise.resolve().then(() => cb(0)); return 1 }
  })
  afterEach(() => {
    ;(globalThis as any).requestAnimationFrame = __prevRaf
  })

  it('anim.finished RÉSOUT normalement → cancel() + résolution, comportement inchangé', async function () {
    const name = registerFallbackCrossfade()
    // Clé JAMAIS reçue par XReceive → pas de counterpart → chemin fallback → sampleAndRun.
    const { outro } = µ.anim[`${name}Send`]({ key: `k${uid}` })

    const { node, calls } = makeFakeNode()
    const p = outro(node)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(calls.length, 1, 'sampleAndRun a bien créé une Animation (chemin fallback atteint)')

    calls[0]._finish()
    await assert.doesNotReject(p)
    assert.equal(calls[0].cancelled, true, 'le fill est libéré après succès')
  })

  it("anim.finished REJETTE (animation annulée) → résout quand même gracieusement (pas de rejet propagé)", async function () {
    const name = registerFallbackCrossfade()
    const { outro } = µ.anim[`${name}Send`]({ key: `k${uid}` })

    const { node, calls } = makeFakeNode()
    const p = outro(node)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(calls.length, 1)

    calls[0]._reject()

    await assert.doesNotReject(
      p,
      "AVANT le fix : ce rejet remontait tel quel jusqu'à Promise.all(transitions) dans _mjs_destroyNodeAndChildren, " +
      "faisant échouer TOUT le groupe d'outro (node(s) jamais marqués _mjs_dead, jamais retirés du DOM)",
    )
    assert.equal(calls[0].cancelled, true, 'le fill est quand même libéré (cancel) même en cas de rejet')
  })
})
