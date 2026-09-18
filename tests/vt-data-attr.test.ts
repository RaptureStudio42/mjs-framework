// docs/17-router.md:420 promet : « MJS pose l'attribut html[data-mjs-vt="<nom>"]
// pendant une transition de vue, votre CSS prend le relais si le nom n'est pas dans la bibliothèque ».
// Le runtime ne le posait jamais (grep vide avant ce correctif). Couvre les DEUX points d'application du
// pseudo-VT (API native document.startViewTransition) : mjs_router.ts (navigate(), permutation de
// <@view>, modèle tests/view-transition.test.ts) et mjs_ujs.ts (_mjs_vtWrapSwap, swap du contenant de
// navigation hors routeur, modèle tests/vt-presets-ujs.test.ts). Rideau (µ._mjs_vtCurtainRun, iris/swipe/
// bars/blocks) HORS PÉRIMÈTRE de ces deux fichiers : son cycle de vie complet (cover → swap → reveal →
// retrait du calque) vit ENTIÈREMENT dans mjs_vt_presets.ts, jamais atteignable en dehors — non testé
// ici.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')
const VT_PRESETS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_vt_presets.ts'), 'utf-8')
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ════════════════════════════════════════════════════════════════════════════
// mjs_router.ts — navigate() sous pseudo-VT (modèle : tests/view-transition.test.ts)
// ════════════════════════════════════════════════════════════════════════════
describe('html[data-mjs-vt] posé/retiré par mjs_router.ts (navigate)', function () {
  // globals posés/restaurés PAR TEST : même précaution que view-transition.test.ts (Node fournit un
  // CustomEvent natif incompatible avec happy-dom, un autre fichier du même process Mocha peut avoir
  // déjà posé sa propre Window).
  let prevWindow: any, prevDocument: any, prevCustomEvent: any, prevCustomElements: any
  beforeEach(() => {
    prevWindow = (globalThis as any).window
    prevDocument = (globalThis as any).document
    prevCustomEvent = (globalThis as any).CustomEvent
    prevCustomElements = (globalThis as any).customElements
  })
  afterEach(() => {
    ;(globalThis as any).window = prevWindow
    ;(globalThis as any).document = prevDocument
    ;(globalThis as any).CustomEvent = prevCustomEvent
    ;(globalThis as any).customElements = prevCustomElements
  })

  function loadRouter(win: any) {
    const µ: any = { log() {}, warn() {}, error() {} }
    const g: any = globalThis
    g.window = win
    g.document = win.document
    g.CustomEvent = win.CustomEvent
    g.customElements = win.customElements
    new Function('µ', ROUTER_SRC)(µ)
    new Function('µ', VT_PRESETS_SRC)(µ) // µ._mjs_vtParse/_mjs_vtApplyPreset réels, utilisés par le correctif
    return µ
  }

  function makeRoutedComponent(win: any, dataMjsVt: string) {
    const document = win.document
    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'main'
    view.setAttribute('data-mjs-vt', dataMjsVt)
    comp._shadow = comp // simplifie : querySelector direct sur comp
    comp.appendChild(view)
    comp.routes = { main: { '/x': 'page-x', '/y': 'page-y' } } // deux modules : une vue déjà sur son module ne vote plus, le chevauchement exige un vrai changement
    return comp
  }

  it('préréglage nommé : attribut posé AVANT startViewTransition (déjà là au moment de l\'appel), retiré à finished (résolue)', async () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let seenDuring: string | undefined
    let finishedResolve: any
    const finished = new Promise((res) => { finishedResolve = res })
    win.document.startViewTransition = function (cb: any) {
      seenDuring = win.document.documentElement.dataset.mjsVt
      cb()
      return { ready: Promise.resolve(), finished }
    }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'cube'))

    µ.Router.navigate('#/x', false)

    assert.equal(seenDuring, 'cube', 'attribut déjà posé au moment où startViewTransition est appelé')
    assert.equal(win.document.documentElement.dataset.mjsVt, 'cube', 'toujours présent juste après (transition en cours)')
    finishedResolve()
    await finished
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(win.document.documentElement.dataset.mjsVt, undefined, 'retiré une fois finished résolue')
  })

  it('finished REJETÉE (transition annulée) → l\'attribut est quand même retiré', async () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let finishedReject: any
    const finished = new Promise((_res, rej) => { finishedReject = rej })
    win.document.startViewTransition = function (cb: any) { cb(); return { ready: Promise.resolve(), finished } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'zoom'))

    µ.Router.navigate('#/x', false)

    assert.equal(win.document.documentElement.dataset.mjsVt, 'zoom')
    finishedReject(new Error('annulée'))
    await finished.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(win.document.documentElement.dataset.mjsVt, undefined, 'retiré même si finished rejette')
  })

  it('résolution booléenne "on" (pas un nom de préréglage) → attribut posé à \'on\'', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    win.document.startViewTransition = function (cb: any) { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'on'))

    µ.Router.navigate('#/x', false)

    assert.equal(win.document.documentElement.dataset.mjsVt, 'on')
  })

  it('préréglage avec options (`cube={ dir: left }`) → seule la BASE est posée, jamais la chaîne brute', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    win.document.startViewTransition = function (cb: any) { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'cube={ dir: left }'))

    µ.Router.navigate('#/x', false)

    assert.equal(win.document.documentElement.dataset.mjsVt, 'cube', 'µ._mjs_vtParse(...).base, pas la chaîne avec options')
  })

  it('aucune vue active ("off") → document.startViewTransition jamais appelé, attribut jamais posé', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let started = false
    win.document.startViewTransition = function (cb: any) { started = true; cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'off'))

    µ.Router.navigate('#/x', false)

    assert.equal(started, false)
    assert.equal(win.document.documentElement.dataset.mjsVt, undefined)
  })

  it('startViewTransition lève (état invalide) → l\'attribut ne reste pas collé, l\'exception remonte', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    win.document.startViewTransition = function () { throw new Error('InvalidStateError') }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'cube'))

    assert.throws(() => µ.Router.navigate('#/x', false), /InvalidStateError/)
    assert.equal(win.document.documentElement.dataset.mjsVt, undefined, 'l\'attribut ne doit pas rester collé après l\'échec')
  })

  // Jeton de séquence : deux transitions
  // chevauchées (B posée AVANT que A.finished ne résolve) — le nettoyage de A ne doit PAS effacer
  // l'attribut de B, encore active (confirmé sur Chromium réel).
  it('deux transitions CHEVAUCHÉES (A puis B avant A.finished) : A.finished ne retire PAS l\'attribut de B (encore actif), B.finished le retire', async () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let finishedAResolve: any, finishedBResolve: any
    const finishedA = new Promise((res) => { finishedAResolve = res })
    const finishedB = new Promise((res) => { finishedBResolve = res })
    let call = 0
    win.document.startViewTransition = function (cb: any) { call++; cb(); return { ready: Promise.resolve(), finished: call === 1 ? finishedA : finishedB } }
    const µ = loadRouter(win)
    const comp = makeRoutedComponent(win, 'presetA')
    const view = comp.querySelector('metamjs-view')
    µ.Router._mjs_awareComponents.add(comp)

    µ.Router.navigate('#/x', false) // A
    assert.equal(win.document.documentElement.dataset.mjsVt, 'presetA')

    view.setAttribute('data-mjs-vt', 'presetB')
    µ.Router.navigate('#/y', false) // B (autre module, sinon la vue ne vote plus), AVANT que A.finished résolve
    assert.equal(win.document.documentElement.dataset.mjsVt, 'presetB')

    finishedAResolve()
    await finishedA
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(win.document.documentElement.dataset.mjsVt, 'presetB', 'A.finished résolue mais B encore actif : attribut PAS retiré')

    finishedBResolve()
    await finishedB
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(win.document.documentElement.dataset.mjsVt, undefined, 'B.finished résolue : retiré')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// mjs_ujs.ts — µ._mjs_vtWrapSwap (modèle : tests/vt-presets-ujs.test.ts, extraction par marqueurs)
// ════════════════════════════════════════════════════════════════════════════
describe('html[data-mjs-vt] posé/retiré par mjs_ujs.ts (_mjs_vtWrapSwap)', function () {
  function extractVtResolvePageStatement(): string {
    return extractMarked(UJS_SRC, '_mjs_vtResolvePage')
  }
  function extractVtWrapSwapStatement(): string {
    return extractMarked(UJS_SRC, '_mjs_vtWrapSwap')
  }
  function installVt(µ: any, doc: any) {
    new Function('µ', 'document', extractVtResolvePageStatement() + '\n' + extractVtWrapSwapStatement())(µ, doc)
  }
  function makeDoc(startViewTransition: any) {
    return { documentElement: { dataset: {} as any }, startViewTransition }
  }
  // µ._mjs_vtParse (mjs_vt_presets.ts) N'EST PAS chargé ici (modèle vt-presets-ujs.test.ts : extraction
  // isolée, pas le fichier entier) — stub minimal fidèle à la vraie forme { base, dir, … }.
  function fakeVtParse(name: string) {
    return { base: name.split('=')[0].trim(), dir: null, durationMs: null, priority: null }
  }

  it('préréglage nommé (résolu par lien) : attribut posé AVANT startViewTransition, retiré à finished (résolue)', async () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: false, _mjs_vtParse: fakeVtParse }
    let seenDuring: string | undefined
    let finishedResolve: any
    const finished = new Promise((res) => { finishedResolve = res })
    const doc = makeDoc((cb: any) => { seenDuring = doc.documentElement.dataset.mjsVt; cb(); return { ready: Promise.resolve(), finished } })
    installVt(µ, doc)
    const link = { getAttribute: (n: string) => (n === 'mjs-vt' ? 'reveal' : null) }

    µ._mjs_vtWrapSwap(link, () => {})

    assert.equal(seenDuring, 'reveal')
    assert.equal(doc.documentElement.dataset.mjsVt, 'reveal')
    finishedResolve()
    await finished
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(doc.documentElement.dataset.mjsVt, undefined, 'retiré une fois finished résolue')
  })

  it('finished REJETÉE → attribut retiré quand même', async () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'zoom', _mjs_vtParse: fakeVtParse }
    let finishedReject: any
    const finished = new Promise((_res, rej) => { finishedReject = rej })
    const doc = makeDoc((cb: any) => { cb(); return { ready: Promise.resolve(), finished } })
    installVt(µ, doc)

    µ._mjs_vtWrapSwap(null, () => {})

    assert.equal(doc.documentElement.dataset.mjsVt, 'zoom')
    finishedReject(new Error('annulée'))
    await finished.catch(() => {})
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(doc.documentElement.dataset.mjsVt, undefined)
  })

  it('résolution booléenne "on" → attribut posé à \'on\'', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: true, _mjs_vtParse: fakeVtParse }
    const doc = makeDoc((cb: any) => { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } })
    installVt(µ, doc)

    µ._mjs_vtWrapSwap(null, () => {})

    assert.equal(doc.documentElement.dataset.mjsVt, 'on')
  })

  it('gate ON mais résolution "off" → startViewTransition jamais appelé, attribut jamais posé', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: false, _mjs_vtParse: fakeVtParse }
    let started = false
    const doc = makeDoc((cb: any) => { started = true; cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } })
    installVt(µ, doc)

    µ._mjs_vtWrapSwap(null, () => {})

    assert.equal(started, false)
    assert.equal(doc.documentElement.dataset.mjsVt, undefined)
  })

  it('startViewTransition lève → attribut retiré, exception remonte', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'cube', _mjs_vtParse: fakeVtParse }
    const doc = makeDoc(() => { throw new Error('InvalidStateError') })
    installVt(µ, doc)

    assert.throws(() => µ._mjs_vtWrapSwap(null, () => {}), /InvalidStateError/)
    assert.equal(doc.documentElement.dataset.mjsVt, undefined)
  })

  it('µ._mjs_vtParse ABSENT (runtime tree-shaké sans vt_presets) → repli sur \'on\', jamais un crash', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'zoom' } // pas de _mjs_vtParse
    const doc = makeDoc((cb: any) => { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } })
    installVt(µ, doc)

    assert.doesNotThrow(() => µ._mjs_vtWrapSwap(null, () => {}))
    assert.equal(doc.documentElement.dataset.mjsVt, 'on', 'repli sûr, même avec un nom de préréglage résolu')
  })

  it('document SANS documentElement (fixture minimale, comme tests/vt-presets-ujs.test.ts et tests/ujs-deferred-swap-confirm-wrapper.test.ts) → jamais un crash, le swap a quand même lieu', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'zoom', _mjs_vtParse: fakeVtParse }
    const calls: string[] = []
    const doc: any = { startViewTransition: (cb: any) => { cb() } } // pas de documentElement, forme des tests existants

    installVt(µ, doc)

    assert.doesNotThrow(() => µ._mjs_vtWrapSwap(null, () => calls.push('swap')))
    assert.deepEqual(calls, ['swap'], 'le swap doit avoir eu lieu malgré l\'absence de documentElement')
  })

  // Même jeton de séquence que mjs_router.ts,
  // mêmes deux transitions chevauchées, modèle EXACT d'une vérification Chromium réelle.
  it('deux transitions CHEVAUCHÉES (A puis B avant A.finished) : A.finished ne retire PAS l\'attribut de B (encore actif), B.finished le retire', async () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: false, _mjs_vtParse: fakeVtParse }
    let finishedAResolve: any, finishedBResolve: any
    const finishedA = new Promise((res) => { finishedAResolve = res })
    const finishedB = new Promise((res) => { finishedBResolve = res })
    let call = 0
    const doc = makeDoc((cb: any) => { call++; cb(); return { ready: Promise.resolve(), finished: call === 1 ? finishedA : finishedB } })
    installVt(µ, doc)
    const linkA = { getAttribute: (n: string) => (n === 'mjs-vt' ? 'presetA' : null) }
    const linkB = { getAttribute: (n: string) => (n === 'mjs-vt' ? 'presetB' : null) }

    µ._mjs_vtWrapSwap(linkA, () => {})
    assert.equal(doc.documentElement.dataset.mjsVt, 'presetA')

    µ._mjs_vtWrapSwap(linkB, () => {}) // B, AVANT que A.finished résolve
    assert.equal(doc.documentElement.dataset.mjsVt, 'presetB')

    finishedAResolve()
    await finishedA
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(doc.documentElement.dataset.mjsVt, 'presetB', 'A.finished résolue mais B encore actif : attribut PAS retiré')

    finishedBResolve()
    await finishedB
    await new Promise((r) => setTimeout(r, 0))
    assert.equal(doc.documentElement.dataset.mjsVt, undefined, 'B.finished résolue : retiré')
  })
})
