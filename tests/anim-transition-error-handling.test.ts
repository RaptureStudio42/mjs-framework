// symétrie tick vs css dans µ._mjs_runTransition sur exception
// utilisateur. AVANT : cfg.tick() qui lève est avalée en silence (µ.warn
// seulement si µ.debug — faux par défaut en prod) ; cfg.css() qui lève sort
// NON capturée et casse l'appelant. APRÈS : les deux chemins sont traités
// pareil — µ.warn TOUJOURS, transition close proprement (jamais de node.animate
// appelé avec un frame partiel → jamais de node figé à mi-keyframe).
//
// Horloge/rAF fake INSTALLÉE/RESTAURÉE PAR TEST (pas au chargement du module) :
// Mocha charge TOUS les fichiers de test AVANT d'exécuter le moindre test — un
// override au top-level serait écrasé par un AUTRE fichier qui fait la même
// chose au SIEN (vécu : transition-tick-abort-resolves.test.ts, cf. son propre
// commentaire ; parade identique à crossfade-sampleandrun-rejection.test.ts).
// Portée par test + restauration = robuste à l'ordre de chargement.

import assert from 'node:assert/strict'

let rafQueue: Array<{ id: number, cb: (t: number) => void }> = []
let rafIdCounter = 0
let fakeNow = 0
let __prevRaf: any
let __prevCancelRaf: any
let __prevPerfNow: any

function flushOneFrame(time: number) {
  fakeNow = time
  const batch = rafQueue
  rafQueue = []
  for (const { cb } of batch) cb(time)
}

// µ COMPLET posé par CE fichier — l'ancien `globalThis.µ =
// globalThis.µ || {...}` SEUL, sans garde à l'exécution, adoptait en silence un
// µ étranger et incomplet posé par un AUTRE fichier de test : le CONTENU
// (Ticker/_mjs_interpolatorSet/anim/warn) se règle bien ICI, au chargement, mais
// un fichier exécuté AVANT nous (ex. ujs-hashchange-query-refresh.test.ts, qui
// écrase `globalThis.µ = {Router}` EN COURS DE TEST, pas au chargement) laisse
// `globalThis.µ` pollué bien après. Le runtime importé juste en dessous relit
// `µ` en GLOBAL À CHAQUE APPEL (identifiant libre jamais capturé) : notre
// propre `const µ` local ne protège RIEN pour ce qui se passe À L'INTÉRIEUR du
// module. Seul un before()/after() qui réaffirme `globalThis.µ` juste avant nos
// tests (et le restaure après, pour ne pas polluer les fichiers suivants) protège
// vraiment — cf. describe() plus bas.
;(globalThis as any).µ = (globalThis as any).µ || {}
const µ: any = (globalThis as any).µ
µ.Ticker = µ.Ticker || { add() {} }
µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
µ.anim = µ.anim || {}
await import('../src/runtime/mjs_easing.js')

describe('µ._mjs_runTransition — symétrie tick/css sur exception utilisateur', function () {
  let __muBackup: any
  before(() => { __muBackup = (globalThis as any).µ; (globalThis as any).µ = µ })
  after(() => { (globalThis as any).µ = __muBackup })

  beforeEach(() => {
    rafQueue = []
    rafIdCounter = 0
    fakeNow = 0
    __prevRaf = (globalThis as any).requestAnimationFrame
    __prevCancelRaf = (globalThis as any).cancelAnimationFrame
    if (!(globalThis as any).performance) (globalThis as any).performance = {}
    __prevPerfNow = (globalThis as any).performance.now
    ;(globalThis as any).requestAnimationFrame = (cb: (t: number) => void) => {
      const id = ++rafIdCounter
      rafQueue.push({ id, cb })
      return id
    }
    ;(globalThis as any).cancelAnimationFrame = (id: number) => {
      rafQueue = rafQueue.filter(f => f.id !== id)
    }
    ;(globalThis as any).performance.now = () => fakeNow
    // valeur PAR DÉFAUT en prod — c'est le cas qui compte (µ.debug=false)
    µ.debug = false
  })

  afterEach(() => {
    ;(globalThis as any).requestAnimationFrame = __prevRaf
    ;(globalThis as any).cancelAnimationFrame = __prevCancelRaf
    ;(globalThis as any).performance.now = __prevPerfNow
  })

  it('cfg.tick() qui lève : µ.warn TOUJOURS (pas seulement µ.debug), transition close proprement (node visible, pas de retry infini)', async function () {
    const warned: any[] = []
    µ.warn = (...a: any[]) => warned.push(a)
    const node: any = {}
    let tickCalls = 0
    const cfg = { duration: 1000, tick: () => { tickCalls++; throw new Error('boom-tick') } }

    const p = µ._mjs_runTransition(node, cfg, 'in')
    assert.equal(rafQueue.length, 1, 'une frame doit être planifiée dès le démarrage')
    flushOneFrame(0) // 1er tick lève

    assert.equal(tickCalls, 1, 'un seul appel à cfg.tick() — pas de retry frame après frame jusqu\'à épuisement de la durée')
    assert.equal(rafQueue.length, 0, 'aucune nouvelle frame planifiée après l\'échec : la transition est close, pas relancée')
    assert.equal(warned.length, 1, 'µ.warn appelé exactement 1 fois (µ.debug=false, avant : 0 fois)')
    assert.match(warned[0][0], /cfg\.tick\(\)/, 'le message identifie le callback fautif')
    assert.match(warned[0][0], /in/, 'le message identifie la direction (nom de la transition)')

    const result = await Promise.race([
      p,
      new Promise((_, reject) => setTimeout(() => reject(new Error('TIMEOUT — la Promise ne résout jamais après une erreur tick()')), 500)),
    ])
    assert.equal(result, 'in', 'résout avec la direction, comme une complétion normale — le node reste visible (introend peut se déclencher)')
    assert.equal(node._mjs_transition_state, null, 'aucune transition fantôme accrochée au node')
  })

  it('cfg.css() qui lève : µ.warn TOUJOURS, ne casse plus l\'appelant, node.animate JAMAIS appelé (pas de node figé à opacity:0)', async function () {
    const warned: any[] = []
    µ.warn = (...a: any[]) => warned.push(a)
    let animateCalled = false
    const node: any = { style: {}, animate: () => { animateCalled = true; return { finished: Promise.resolve(), cancel() {} } } }
    const cfg = { duration: 30, css: () => { throw new Error('boom-css') } }

    let threw = false
    let p: any
    try {
      p = µ._mjs_runTransition(node, cfg, 'in')
    } catch (e) {
      threw = true
    }
    assert.equal(threw, false, 'AVANT le fix : cfg.css() qui lève sortait NON capturée hors de µ._mjs_runTransition')

    const result = await p
    assert.equal(result, 'in', 'résout avec la direction — le node reste dans son état visible naturel, jamais figé')
    assert.equal(animateCalled, false, 'node.animate() ne doit JAMAIS être appelé sur un jeu de keyframes incomplet (sinon fill:forwards fige le node à mi-anim)')
    assert.equal(warned.length, 1, 'µ.warn appelé exactement 1 fois')
    assert.match(warned[0][0], /cfg\.css\(\)/, 'le message identifie le callback fautif')
  })

  it('cfg.css() qui lève en mode .shared : µ.warn TOUJOURS, ne casse pas l\'appelant, rien n\'est appliqué au node', async function () {
    const warned: any[] = []
    µ.warn = (...a: any[]) => warned.push(a)
    let animateCalled = false
    // `_mjs_anim_mode = 'shared'` : c'est EXACTEMENT ce que pose le générateur
    // (src/generator/attributes/index.ts, `sharedLine`) avant d'appeler _mjs_runTransition.
    const node: any = { style: {}, _mjs_anim_mode: 'shared', animate: () => { animateCalled = true; return { finished: Promise.resolve(), cancel() {} } } }
    const cfg = { duration: 30, css: () => { throw new Error('boom-css-shared') } }

    let threw = false
    let p: any
    try {
      p = µ._mjs_runTransition(node, cfg, 'in')
    } catch (e) {
      threw = true
    }
    assert.equal(threw, false, 'AVANT le fix : cfg.css() qui lève en mode .shared sortait NON capturée hors de µ._mjs_runTransition')

    const result = await p
    assert.equal(result, 'in', 'résout avec la direction — le node reste dans son état visible naturel, jamais figé')
    assert.equal(animateCalled, false, 'aucune anim WAAPI posée (mode .shared ne les utilise de toute façon pas)')
    assert.equal(node.style.animation, undefined, 'node.style.animation jamais posé — rien n\'a été appliqué avant le throw')
    assert.equal(node._mjs_transition_state, undefined, 'aucune transition fantôme accrochée au node')
    assert.equal(warned.length, 1, 'µ.warn appelé exactement 1 fois')
    assert.match(warned[0][0], /cfg\.css\(\)/, 'le message identifie le callback fautif')
  })
})
