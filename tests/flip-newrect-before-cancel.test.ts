// Régression : dans le wrapper `@flip`
// (mjs_flip.ts, patch de `µ.Element.prototype._mjs_reconcileList`), la phase
// "3. MICRO-TICK & PLAY" mesurait `newRect = n.getBoundingClientRect()`
// AVANT d'annuler une animation `mjs-flip` PRÉCÉDENTE encore en vol sur le
// même node (toggle rapide qui interrompt un FLIP en cours). Comme
// `getBoundingClientRect()` reflète le `transform` CSS actif,`newRect` était
// contaminé par le décalage RÉSIDUEL de l'ancienne animation — le nouveau
// `deltaX/deltaY` (calculé à partir de cette mesure fausse) démarrait le
// keyframe `translate(deltaX, deltaY)` depuis une position INCORRECTE →
// saut visuel au moment où l'animation interrompue redémarre.
//
// Fix : le `getAnimations().forEach(a => a.id==='mjs-flip' && a.cancel())`
// est déplacé AVANT `newRect = n.getBoundingClientRect()` (au lieu d'être
// nesté dans le `if (deltaX !== 0 ...)` qui dépendait déjà de cette mesure
// contaminée). `newRect` reflète alors la position RÉELLE (transform-free).
//
// WAAPI (`getAnimations`, `animate`, `Animation.cancel()`) n'existe pas sous
// happy-dom : `getBoundingClientRect` est un FAKE qui modélise fidèlement le
// mécanisme réel — retourne `positionVraie + décalageDeTransformSiAnimationActive`
// tant que `cancel()` n'a pas été appelé, `positionVraie` seule ensuite. Le
// wrapper `_mjs_reconcileList` de mjs_flip.ts est exercé RÉELLEMENT (pas une
// inspection de source) via `Object.create` sur une SOUS-CLASSE de
// `µ.Element` (`_mjs_hasFlip` posé UNIQUEMENT dessus, pas sur `µ.Element`
// lui-même — évite de polluer les autres fichiers de test qui importent
// aussi mjs_element.js dans le même process Mocha).

import assert from 'node:assert/strict'

;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()

// µ.Element extends HTMLElement + mjs_init.ts pose un CSSStyleSheet réel
// (`replaceSync`) — des stubs maison sous-implémentent vite l'API DOM utile.
// happy-dom fournit tout ça correctement (comme les autres tests qui
// importent mjs_element.js directement). `??=` : ne pose que ce qui manque,
// un autre fichier de test du même process Mocha a pu déjà installer le sien.
const { Window } = await import('happy-dom')
const win: any = new Window({ url: 'http://localhost/' })
const g: any = globalThis
g.window ??= win
g.document ??= win.document
g.HTMLElement ??= win.HTMLElement
g.CSSStyleSheet ??= win.CSSStyleSheet
g.customElements ??= win.customElements
g.Node ??= win.Node
g.Event ??= win.Event
g.CustomEvent ??= win.CustomEvent
await import('../src/runtime/mjs_easing.js')
await import('../src/runtime/mjs_init.js')
await import('../src/runtime/mjs_element.js')
await import('../src/runtime/mjs_for.js') // _mjs_reconcileList, détaché de mjs_element.ts — DOIT précéder mjs_flip.js, qui le capture à son propre chargement
await import('../src/runtime/mjs_flip.js') // patch µ.Element.prototype._mjs_reconcileList

// Sous-classe DÉDIÉE : `_mjs_hasFlip` reste scopé ICI, jamais posé sur
// `µ.Element` lui-même (partagé par tout le process Mocha).
class FlipTestComponent extends µ.Element {}
;(FlipTestComponent as any)._mjs_hasFlip = true

function makeFlipNode(trueRect: any, staleOffset: { x: number, y: number }) {
  let animating = true
  const fakeAnim: any = { id: 'mjs-flip', cancel() { animating = false } }
  const attrs: Record<string, string> = { 'mjs-flip': '200' }
  const animateCalls: any[] = []
  const node: any = {
    getAttribute: (k: string) => (k in attrs ? attrs[k] : null),
    hasAttribute: (k: string) => k in attrs,
    setAttribute: (k: string, v: string) => { attrs[k] = v },
    querySelectorAll: () => [],
    nodeType: 1,
    parentNode: {},
    getAnimations: () => (animating ? [fakeAnim] : []),
    getBoundingClientRect: () => animating
      ? { left: trueRect.left + staleOffset.x, top: trueRect.top + staleOffset.y }
      : { left: trueRect.left, top: trueRect.top },
    animate: (keyframes: any, opts: any) => { animateCalls.push({ keyframes, opts }); return { id: opts.id } },
  }
  return { node, animateCalls, isAnimating: () => animating }
}

describe('mjs_flip — newRect mesuré APRÈS cancel() du FLIP précédent (pas avant)', function () {
  it("un FLIP précédent encore en vol est annulé AVANT la mesure de newRect — le delta reflète la position RÉELLE, pas la position contaminée par le transform résiduel", async function () {
    // Position layout RÉELLE : passe de (100,100) à (200,100) suite au reorder
    // (simulé par `originalReconcileList`, qui ici ne fait rien de plus —
    // seule la fonction `getBoundingClientRect` du node fake modélise le
    // changement de position layout au fil du temps).
    const trueRect = { left: 100, top: 100 }
    const staleOffset = { x: -50, y: 0 } // décalage résiduel du FLIP précédent, encore actif

    const { node, animateCalls, isAnimating } = makeFlipNode(trueRect, staleOffset)

    const fakeThis: any = Object.assign(Object.create(FlipTestComponent.prototype), {
      _mjs_list_cache: { cid1: new Map([['k', { nodes: [node] }]]) },
    })

    // `originalReconcileList` (la VRAIE _mjs_reconcileList, non-flip) tourne EN
    // PREMIER dans le wrapper — on la remplace par un no-op qui, à la place,
    // simule le reorder en faisant AVANCER `trueRect` (comme le ferait un
    // vrai déplacement DOM) : le node existe TOUJOURS dans `_mjs_list_cache`
    // après coup (même Map, non touchée), seule sa position layout change.
    const originalReconcileList = µ.Element.prototype._mjs_reconcileList
    // Le wrapper a déjà capturé `originalReconcileList` à l'import de
        // mjs_flip.ts (closure) — on ne peut pas le remplacer après coup pour CE
    // wrapper précis ; à la place, on fait avancer `trueRect` PENDANT l'appel
    // de la vraie _mjs_reconcileList d'origine (elle ne touche pas nos fakes,
    // donc on peut la laisser tourner puis avancer trueRect nous-même juste
    // après son retour synchrone, avant le micro-tick).
    void originalReconcileList

    // `col=null` → `originalReconcileList` (la VRAIE, non-flip) fait un
    // early-return immédiat (`if (!col) return;`) — no-op sûr qui n'exige
    // aucun vrai startNode/endNode. Le wrapper `@flip` autour, lui, tourne
    // pour de vrai (mesure/cancel/mesure/anime) à partir de `_mjs_list_cache`.
    const result = fakeThis._mjs_reconcileList('cid1', null, null, null, null, () => {}, () => 'k', () => {}, null)
    // Le vrai `_mjs_reconcileList` avec `col=null` suit désormais une autre branche
    // (mjs_element.ts, hors périmètre de ce volet) qui RÉINITIALISE
    // `_mjs_list_cache[cacheId]` à une Map vide — l'ancien comportement (early-return
    // no-op) n'existe plus. Le micro-tick PLAY du wrapper relit ce cache pour
    // reconstruire `newFlipNodes` ; on le repeuple donc comme le laisserait un
    // VRAI reconcile (l'entrée du node réordonné y subsiste après coup). Sans ça,
    // `newFlipNodes` serait vide → aucune animation FLIP jouée (faux négatif).
    fakeThis._mjs_list_cache.cid1 = new Map([['k', { nodes: [node] }]])
    // Avance la position RÉELLE (layout) du node — simule le reorder qui
    // vient de se produire pendant l'appel ci-dessus.
    trueRect.left = 200

    // Laisse le micro-tick (Promise.resolve().then) de mjs_flip.ts s'exécuter.
    await Promise.resolve()
    await Promise.resolve()
    await Promise.resolve()

    assert.equal(animateCalls.length, 1, 'une animation FLIP doit avoir été (re)lancée')
    assert.equal(isAnimating(), false, "l'ancien mjs-flip DOIT avoir été cancel() (notre fake ne remet jamais animating=true tout seul)")

    const startKeyframe = animateCalls[0].keyframes[0]
    // oldRect (mesuré en phase "1. FIRST", AVANT tout cancel) = trueRect(100) + staleOffset(-50) = 50.
    // newRect FIXÉ (mesuré APRÈS cancel, donc SANS staleOffset) = trueRect(200) = 200.
    // deltaX = oldRect.left - newRect.left = 50 - 200 = -150.
    assert.equal(
      startKeyframe.transform, 'translate(-150px, 0px)',
      "AVANT le fix : newRect mesuré AVANT le cancel restait contaminé par le décalage résiduel " +
      "(trueRect(200)+staleOffset(-50)=150) → delta = 50-150 = -100 (translate(-100px, 0px)) — FAUX, " +
      "ne correspond pas au VRAI déplacement layout à combler",
    )
    void result
  })
})
