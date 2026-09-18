// abort d'une transition
// TICK (`cfg.tick`, mode JS custom — PAS le mode `css` WAAPI) survenant ENTRE
// deux frames laissait la Promise de `_runTickTransition` (via
// `µ._mjs_runTransition`) JAMAIS résolue.
//
// Cause : `state.abort()` appelle `cancelAnimationFrame(state.rafId)` → la
// frame planifiée ne va donc JAMAIS firer — or le SEUL `resolve()` de cette
// Promise vivait DANS le callback `step` (branche `if (state.aborted)`),
// jamais atteinte puisque `step` ne sera plus jamais rappelé après le cancel.
// Tout code faisant `await` sur cette transition (ex.
// `_mjs_destroyNodeAndChildren` → `await Promise.all(transitions)`) restait
// bloqué À VIE dès qu'un abort survient en cours de route — exactement
// l'usage réel de l'abort (toggle d'un {if}/{for} pendant l'outro, cf.
// `µ._mjs_runTransition` qui appelle `prev.abort()` quand une 2e transition
// démarre sur un node qui en a déjà une en cours).
//
// Fix : `resolve` est capturé dans `state._mjs_resolve` dès l'exécuteur de la
// Promise, et `abort()` l'appelle directement avec la même valeur
// (`direction`) qu'une complétion normale.
//
// Contrôle total du temps : `requestAnimationFrame`/`cancelAnimationFrame`/
// `performance.now` sont remplacés par une queue manuelle + horloge fake —
// aucune vraie temporisation, et on observe précisément qu'un abort ENTRE
// deux frames (rafId annulé avant d'avoir pu firer) ne bloque plus la Promise.

import assert from 'node:assert/strict'

let rafQueue: Array<{ id: number, cb: (t: number) => void }> = []
let rafIdCounter = 0
let fakeNow = 0
// repéré en corrigeant un défaut séparé — ces overrides
// vivaient à vie sur globalThis (jamais restaurés) : un AUTRE fichier de
// test, chargé PLUS TARD dans le même process Mocha, qui vérifie le repli
// "requestAnimationFrame absent" d'un tout autre module voyait cette fausse
// implémentation FUITÉE ici, alors qu'elle est censée n'exister QUE pendant
// les tests de CE fichier. Valeurs ORIGINALES capturées avant écrasement,
// restaurées dans un after() — même idiome que crossfade-sampleandrun-rejection.test.ts
// (fixé pour la même raison), qui partage le même mjs_easing.js importé une
// seule fois pour tout le process.
const __origRaf = (globalThis as any).requestAnimationFrame
const __origCancelRaf = (globalThis as any).cancelAnimationFrame
const __origPerf = (globalThis as any).performance
const __origPerfNow = __origPerf ? __origPerf.now : void 0
;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
  const id = ++rafIdCounter
  rafQueue.push({ id, cb })
  return id
}
;(globalThis as any).cancelAnimationFrame = (id: number) => {
  rafQueue = rafQueue.filter(f => f.id !== id)
}
if (!(globalThis as any).performance) (globalThis as any).performance = {}
;(globalThis as any).performance.now = () => fakeNow

function flushOneFrame(time: number) {
  fakeNow = time
  const batch = rafQueue
  rafQueue = []
  for (const { cb } of batch) cb(time)
}

// Fusion (PAS remplacement) sur le `µ` global partagé entre TOUS les fichiers
// de test du process Mocha : un `= X || {...}` wholesale, s'il gagne la course
// au chargement, prive les AUTRES fichiers (ex. spring-object.test.ts, qui
// attend `µ.Ticker`) des champs qu'ils posent eux-mêmes via le même idiome —
// vécu en régression croisée lors de l'ajout de ce fichier. On ne pose que ce qui manque, champ par champ.
;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.debug = µ.debug ?? false
µ.warn = µ.warn || (() => {})
µ.log = µ.log || (() => {})
µ.error = µ.error || (() => {})
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
await import('../src/runtime/mjs_easing.js')

describe('µ._mjs_runTransition (mode tick) — abort entre 2 frames résout la Promise', function () {
  after(() => {
    ;(globalThis as any).requestAnimationFrame = __origRaf
    ;(globalThis as any).cancelAnimationFrame = __origCancelRaf
    if (__origPerf && __origPerfNow) { __origPerf.now = __origPerfNow }
  })

  beforeEach(() => {
    rafQueue = []
    rafIdCounter = 0
    fakeNow = 0
  })

  it('abort() ENTRE deux frames (rafId annulé avant de firer) résout quand même la Promise', async function () {
    const node: any = {}
    const cfg = { duration: 1000, tick: () => {} }

    const p = µ._mjs_runTransition(node, cfg, 'in')
    assert.equal(rafQueue.length, 1, 'une frame doit être planifiée dès le démarrage')

    flushOneFrame(0) // 1ère frame : progress=0, re-planifie la suivante
    assert.ok(node._mjs_transition_state, 'la transition doit être trackée sur le node')
    assert.equal(rafQueue.length, 1, 'la frame suivante est re-planifiée après le tick')

    // Abort ICI, ENTRE deux frames — la frame planifiée ne va JAMAIS firer.
    node._mjs_transition_state.abort()
    assert.equal(rafQueue.length, 0, 'cancelAnimationFrame a bien retiré la frame planifiée')

    // AVANT le fix : deadlock (jamais résolu). Timeout court pour détecter le
    // hang sans bloquer la suite indéfiniment si la régression revient.
    const result = await Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — la Promise ne résout jamais après abort')), 500)),
    ])
    assert.equal(result, 'in', 'résout avec la direction, comme une complétion normale')
  })

  it('un 2e abort() après résolution ne jette pas (idempotent)', async function () {
    const node: any = {}
    const cfg = { duration: 1000, tick: () => {} }
    const p = µ._mjs_runTransition(node, cfg, 'out')
    flushOneFrame(0)
    const state = node._mjs_transition_state
    state.abort()
    await p
    assert.doesNotThrow(() => state.abort(), 'un 2e abort après résolution ne doit pas planter')
  })

  it('démarrer une 2e transition sur le MÊME node aborte la 1ère et SA Promise résout (pas de deadlock en usage réel)', async function () {
    const node: any = {}
    const cfg1 = { duration: 1000, tick: () => {} }
    const cfg2 = { duration: 1000, tick: () => {} }

    const p1 = µ._mjs_runTransition(node, cfg1, 'in')
    flushOneFrame(300) // p1 avance à progress=0.3, son rafId est planifié pour la suite

    // 2e transition sur le MÊME node AVANT que p1 ne se termine naturellement :
    // `µ._mjs_runTransition` appelle `prev.abort()` en interne (cf. ligne ~657).
    const p2 = µ._mjs_runTransition(node, cfg2, 'out')

    const r1 = await Promise.race([
      p1,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — p1 jamais résolue après avoir été abortée par la 2e transition')), 500)),
    ])
    assert.equal(r1, 'in', "p1 résout malgré l'abort (même contrat que la complétion normale)")

    // Termine p2 normalement pour ne laisser aucun rAF en attente.
    let guard = 0
    while (rafQueue.length > 0 && guard++ < 100) flushOneFrame(fakeNow + 2000)
    await p2
  })
})
