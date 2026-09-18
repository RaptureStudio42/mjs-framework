// Régression, volet ORCHESTRATION du
// fix "flash-zombie" (cf. transition-outro-group-fill-deferred.test.ts pour le
// volet DIFFÉRÉ côté mjs_easing.ts). `_mjs_destroyNodeAndChildren` (mjs_element.ts)
// orchestre un GROUPE d'outros (`node` + descendants avec `_mjs_outro`,
// `Promise.all(transitions)`) — chaque membre qui utilise le mode css/WAAPI
// pose un hook `_mjs_pendingFillRelease` au lieu de libérer son `fill`
// immédiatement (pour ne pas "rebondir" visuellement pendant qu'un sibling
// plus lent anime encore). CE hook doit être consommé pour CHAQUE membre du
// groupe, une fois `Promise.all` résolu — sinon le fix côté mjs_easing.ts ne
// sert à rien (le fill resterait épinglé À VIE, jamais libéré).
//
// On ne peut pas déclencher `_mjs_pendingFillRelease` via une VRAIE transition
// WAAPI ici (happy-dom ne l'implémente pas) : on isole la responsabilité
// D'ORCHESTRATION en posant le hook À LA MAIN sur `parent`/`child` (comme si
// leur transition CSS venait de finir) et on vérifie que `_mjs_destroyNodeAndChildren`
// les consomme bien tous les deux — indépendamment de l'implémentation de
// CHAQUE transition (mode `_mjs_outro` legacy ici, pour piloter `Promise.all`
// sans dépendre de WAAPI non plus).

import assert from 'node:assert/strict'
import { Window } from 'happy-dom'

const win: any = new Window({ url: 'http://localhost/' })
// Globals DOM : ne posent que ce qui manque encore (`||=`) — un autre fichier
// de test du même process Mocha a pu déjà installer SA propre Window/document
// avant celui-ci ; ne pas l'écraser sous le pied. Idem pour `µ` juste en
// dessous : fusion champ-par-champ, PAS remplacement wholesale (cf.
// transition-tick-abort-resolves.test.ts pour la régression croisée vécue).
const g: any = globalThis
g.window ??= win
g.document ??= win.document
g.HTMLElement ??= win.HTMLElement
g.customElements ??= win.customElements
g.Node ??= win.Node
g.CSSStyleSheet ??= win.CSSStyleSheet
g.Event ??= win.Event
g.CustomEvent ??= win.CustomEvent
g.µ ??= {}
const µ: any = g.µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()

await import('../src/runtime/mjs_easing.js')
await import('../src/runtime/mjs_init.js')
await import('../src/runtime/mjs_element.js')
// `_mjs_destroyNodeAndChildren` délègue désormais son chemin LENT (orchestration des
// outros/teardowns, exactement ce que ce test exerce) à mjs_destroy_hooks.ts, DÉTACHÉ du
// cœur — même précédent que les 3 imports ci-dessus (chacun peuple globalThis.µ par effet
// de bord, sans le redéclarer).
await import('../src/runtime/mjs_destroy_hooks.js')

describe('_mjs_destroyNodeAndChildren — consomme _mjs_pendingFillRelease de CHAQUE membre du groupe après Promise.all', function () {
  it("appelle le hook sur le node racine ET sur un descendant, seulement APRÈS résolution du groupe entier", async function () {
    const parent: any = win.document.createElement('div')
    const child: any = win.document.createElement('span')
    parent.appendChild(child)

    let resolveParent: () => void = () => {}
    let resolveChild: () => void = () => {}
    // Mode legacy de µ._mjs_playTransition (function → Promise), pilotable à la
    // main — évite toute dépendance à WAAPI pour orchestrer `Promise.all`.
    parent._mjs_outro = () => new Promise<void>(res => { resolveParent = res })
    child._mjs_outro = () => new Promise<void>(res => { resolveChild = res })

    let parentReleaseCalls = 0
    let childReleaseCalls = 0
    parent._mjs_pendingFillRelease = () => { parentReleaseCalls++ }
    child._mjs_pendingFillRelease = () => { childReleaseCalls++ }

    // _mjs_mjsPurgeSubtreeState : helper ajouté par un correctif (purge des caches de
    // sous-arbre à la mort définitive) — no-op ici, le test cible _mjs_pendingFillRelease
    const fakeThis = { constructor: {}, _mjs_mjsPurgeSubtreeState() {} }
    // `_mjs_destroyNodeAndChildren` ne fait plus qu'un dispatch (fast-path no-destroy-hooks vs
    // délégation) — l'orchestration testée ici (transitions/Promise.all/pendingFillRelease)
    // vit désormais dans `_mjs_destroyWithHooks` (mjs_destroy_hooks.ts), qu'on cible DIRECTEMENT.
    const destroyPromise = µ.Element.prototype._mjs_destroyWithHooks.call(fakeThis, parent, true)

    // Laisse le temps aux 2 `µ._mjs_playTransition` synchrones de s'enregistrer
    // dans `transitions` avant de vérifier qu'AUCUN release n'a encore eu lieu
    // (le groupe n'est pas encore résolu).
    await Promise.resolve()
    assert.equal(parentReleaseCalls, 0, "pas de release tant que le groupe entier n'a pas fini")
    assert.equal(childReleaseCalls, 0, "idem pour le descendant")

    // Le PARENT finit (mais pas encore l'enfant) : toujours rien.
    resolveParent()
    await Promise.resolve().then(() => Promise.resolve())
    assert.equal(parentReleaseCalls, 0, "AVANT le fix, on consommerait trop tôt / pas du tout — ici : groupe pas fini, toujours rien")
    assert.equal(childReleaseCalls, 0)

    // L'ENFANT finit à son tour → le groupe ENTIER est résolu.
    resolveChild()
    await destroyPromise

    assert.equal(parentReleaseCalls, 1, "le hook du node racine doit être consommé exactement une fois, une fois le groupe résolu")
    assert.equal(childReleaseCalls, 1, "le hook du descendant doit AUSSI être consommé — sinon son fill resterait épinglé à vie")
  })

  it("un membre SANS _mjs_pendingFillRelease (mode tick/legacy, pas de fill à libérer) ne fait pas planter l'orchestration", async function () {
    const node: any = win.document.createElement('div')
    node._mjs_outro = () => Promise.resolve()
    // _mjs_mjsPurgeSubtreeState : helper ajouté par un correctif (purge des caches de
    // sous-arbre à la mort définitive) — no-op ici, le test cible _mjs_pendingFillRelease
    const fakeThis = { constructor: {}, _mjs_mjsPurgeSubtreeState() {} }
    // même raison que ci-dessus : cible directement _mjs_destroyWithHooks (mjs_destroy_hooks.ts)
    await assert.doesNotReject(µ.Element.prototype._mjs_destroyWithHooks.call(fakeThis, node, true))
  })
})
