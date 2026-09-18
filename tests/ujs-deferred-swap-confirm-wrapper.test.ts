// 3 défauts corrigés sur
// mjs_ujs.ts :
//   1) swap PÉRIMÉ sous transition de vue : `µ._mjs_vtWrapSwap` peut DIFFÉRER le swap (rappel de
//      document.startViewTransition, asynchrone) — une navigation plus récente peut avoir rebumpé
//      `µ._mjs_navSeq` PENDANT ce délai. Garde `if (seq !== µ._mjs_navSeq) { return; }` en TÊTE des 6
//      fermetures swap (popstate cache/réseau, clic cache/réseau, soumission, chemin JSON de
//      µ._mjs_navApplyJson). 3 sites étaient déjà posés par le prédécesseur (popstate cache/réseau, JSON) —
//      confirmés GREEN sans correctif ici ; 3 manquants complétés ici (clic
//      cache/réseau, soumission). Reproduction d'un cas concret de concurrence : 2 navigations
//      concurrentes, transitions de durées différentes.
//   2) `@confirm` posé sur un WRAPPER (le `<form>` ou un ancêtre, pas sur le bouton) : au rejeu
//      après confirmation, `µ._mjs_ujsConfirmRefire` appelait `requestSubmit()` SANS soumissionnaire —
//      formaction/formtarget/formmethod du bouton perdus. 4e paramètre `submitter` (mémorisé côté
//      gate SUBMIT depuis `e.submitter`, transmis au rejeu).
//   3) formaction/formtarget/formmethod du soumissionnaire lus par troncature `||` : une valeur
//      VIDE (HTML valide) était traitée comme absente. Lecture par PRÉSENCE désormais.
//
// Méthode : EXACTEMENT le même harnais que tests/ujs-post-swap-queue.test.ts / tests/ujs-preload-submitter.test.ts /
// tests/vt-presets-ujs.test.ts — extraction par marqueurs EXPLICITES (tests/helpers/extract-marked.ts,
// aucun comptage d'accolades), stubs plats, PAS de happy-dom. Transition DIFFÉRÉE simulée par
// setTimeout DANS un mock de document.startViewTransition (comme dans tests/ujs-post-swap-queue.test.ts) ; le défaut 1 y ajoute un
// rebump de µ._mjs_navSeq PENDANT le délai (simule une navigation plus récente démarrée entre-temps).
// Défauts 2 et 3 : même patron que tests/ujs-preload-submitter.test.ts (µ._mjs_ujsOnSubmit extrait, µ._mjs_navDispatch STUBBÉ —
// seule la lecture formaction/formtarget/formmethod/submitter est sous contrôle, pas le réseau).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ────────────────────────────────────────────────────────────────────────────
// EXTRACTION + FIXTURES — défaut 1 : mêmes cibles que tests/ujs-post-swap-queue.test.ts/vt-presets-ujs.
// ────────────────────────────────────────────────────────────────────────────
function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock())(µ, document, window)
}
function extractClickBody(): string {
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick')
}
function makeClickHandler() {
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', 'FormData', extractClickBody())
}
function extractPopstateBody(): string {
  return extractMarkedBody(UJS_SRC, 'popstate-listener')
}
function makePopstateHandler() {
  // `DOMParser` en paramètre supplémentaire (absent du patron de tests/ujs-post-swap-queue.test.ts, qui ne testait que le
  // cache-hit) : requis ici pour exercer la branche RÉSEAU HTML (`_swapPopNet`).
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody())
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}
function installNavDispatch(µ: any, win: any, doc: any, DOMParserCtor: any = class {}) {
  if (typeof µ._mjs_ajaxRequest !== 'function') {
    µ._mjs_ajaxRequest = function (opts: any) {
      if (!µ.ajax) { return }
      const m = opts.method.toLowerCase()
      if (m === 'get' || m === 'delete') { return µ.ajax[m] && µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal) }
      return µ.ajax[m] && µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    }
  }
  installHelpers(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, DOMParserCtor)
}
function extractVtResolvePageStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_vtResolvePage')
}
function extractVtWrapSwapStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_vtWrapSwap')
}
function installVt(µ: any, doc: any) {
  new Function('µ', 'document', extractVtResolvePageStatement() + '\n' + extractVtWrapSwapStatement())(µ, doc)
}
function extractFinalPathForStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_finalPathFor')
}

function makeNode(tag: string): any {
  const node: any = {
    tag, nodeType: 1, isConnected: true, children: [] as any[], parentNode: null as any,
    get childNodes() { return node.children.slice() },
    replaceChildren(...nodes: any[]) { node.children = nodes.slice() },
  }
  return node
}
function makeEventDoc(body: any): any {
  const listeners: Array<{ type: string, fn: (e: any) => void }> = []
  return {
    body,
    querySelector: () => null,
    createElement: (tag: string) => makeNode(tag),
    addEventListener(type: string, fn: (e: any) => void) { listeners.push({ type, fn }) },
    dispatchEvent(e: any) { listeners.filter((l) => l.type === e.type).forEach((l) => l.fn(e)); return !e.defaultPrevented },
  }
}
function makeContainer(): any {
  const c: any = { children: [] as any[] }
  Object.defineProperty(c, 'childNodes', { get: () => c.children.slice() })
  c.replaceChildren = (...nodes: any[]) => { c.by = nodes[0]; c.children = nodes.slice() }
  return c
}
function makeLink(attrs: Record<string, string> = {}, urlBits: Record<string, string> = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  return Object.assign({
    tagName: 'A',
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
    closest(_sel: string) { return this },
    origin: 'http://x', target: '', protocol: 'http:',
    pathname: '/', search: '', hash: '', href: 'http://x/',
  }, urlBits)
}
function makeClickEvent(target: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [target],
    target,
  }
}
class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
  *[Symbol.iterator]() { yield* this.map }
}

// ────────────────────────────────────────────────────────────────────────────
// Défaut 1 — les 6 sites, seq rebumpé PENDANT la transition différée.
// ────────────────────────────────────────────────────────────────────────────
describe('swap PÉRIMÉ sous transition différée (6 sites)', function () {
  it('popstate cache-hit (_swapPopCache, DÉJÀ posé par le prédécesseur) : aucun swap, aucun navigate, aucun mjs:load', async function () {
    const cachedNode = { tag: 'cached-pop' }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/dest', search: '', hash: '', origin: 'http://x' }, history: {} }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/leaving',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      _mjs_scrollPos: { get: () => null },
      pageCache: { has: (p: string) => p === '/dest', get: () => [cachedNode], set() {} },
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    const handler = makePopstateHandler()
    handler({}, µ, win, doc)

    await wait(20)

    assert.equal(currentRoot.by === cachedNode, false, 'un swap périmé ne doit PAS avoir installé le contenu du cache')
    assert.equal(navigateCalls.length, 0, 'aucun navigate pour un swap périmé')
    assert.equal(events.length, 0, 'aucun mjs:load pour un swap périmé')
  })

  it('popstate réseau (_swapPopNet, DÉJÀ posé par le prédécesseur) : aucun swap, aucun navigate, aucun mjs:load', async function () {
    const newNode = { tag: 'fresh-pop' }
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/dest', search: '', hash: '', origin: 'http://x' }, history: {} }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/leaving',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      _mjs_scrollPos: { get: () => null },
      pageCache: { has: () => false, get() { return undefined }, set() {} },
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    // `_mjs_navRequest` fait partie du bloc `helpers-navigation` (définition RÉELLE) : le stub doit
    // être posé APRÈS installHelpers, sinon celui-ci l'écrase.
    let capturedSuccess: any
    µ._mjs_navRequest = (_method: string, _url: string, _data: any, success: any) => { capturedSuccess = success }

    const handler = makePopstateHandler()
    handler({}, µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } })

    assert.ok(typeof capturedSuccess === 'function', 'le fetch réseau doit avoir été déclenché (cache-miss)')
    capturedSuccess('<html><body>contenu</body></html>', 'http://x/dest')

    await wait(20)

    assert.equal(liveRoot.by === newNode, false, 'un swap périmé ne doit PAS avoir installé le contenu reçu')
    assert.equal(navigateCalls.length, 0)
    assert.equal(events.length, 0)
  })

  it('clic cache-hit (_swapClickCache, complété ici) : aucun swap, aucun navigate, aucun mjs:load', async function () {
    const cachedNode = { tag: 'cached' }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      pageCache: { has: (p: string) => p === '/other', get: () => [cachedNode], set() {} },
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    const link = makeLink({}, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData)

    await wait(20)

    assert.equal(currentRoot.by === cachedNode, false, 'un swap périmé ne doit PAS avoir installé le contenu du cache')
    assert.equal(navigateCalls.length, 0)
    assert.equal(events.length, 0)
  })

  it('clic réseau (_swapClickNet, complété ici) : aucun swap, aucun navigate, aucun mjs:load', async function () {
    const newNode = { tag: 'fresh' }
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      pageCache: { has: () => false, get() { return undefined }, set() {} },
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
    const link = makeLink({}, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } }, FakeFormData)

    assert.ok(typeof capturedSuccess === 'function', 'le fetch réseau doit avoir été déclenché (cache-miss)')
    capturedSuccess('<html><body>contenu</body></html>', 'http://x/other')

    await wait(20)

    assert.equal(liveRoot.by === newNode, false, 'un swap périmé ne doit PAS avoir installé le contenu reçu')
    assert.equal(navigateCalls.length, 0)
    assert.equal(events.length, 0)
  })

  it('soumission (_mjs_navDispatch/done/_swapSubmit, complété ici) : aucun swap, µ.nav.active reste true, aucun PRG, aucun mjs:load', async function () {
    const newNode = { tag: 'submitted' }
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const pushStateCalls: any[] = []
    const µ: any = {
      warn() {}, error() {}, log() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      Router: { navigate() {}, _mjs_vtEnabled: () => true },
      viewTransition: true,
      nav: { active: false, href: null },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    installNavDispatch(µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } })
    installVt(µ, doc)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts/42')

    await wait(20)

    assert.equal(liveRoot.by === newNode, false, 'un swap périmé ne doit PAS avoir installé le contenu soumis')
    assert.equal(µ.nav.active, true, "µ.nav.active ne doit PAS retomber pour un swap périmé (la navigation gagnante gère son propre indicateur)")
    assert.equal(pushStateCalls.length, 0, 'aucun PRG pour un swap périmé')
    assert.equal(events.length, 0, 'aucun mjs:load pour un swap périmé')
  })

  it('chemin JSON (µ._mjs_navApplyJson, DÉJÀ posé par le prédécesseur) : aucun montage, aucun navigate, aucun mjs:load', async function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { history: { pushState() {} } }
    const µ: any = {
      warn() {}, error() {}, log() {},
      paths: { x: 'xxx.js' },
      _mjs_resSet() {},
      _mjs_navSeq: 0,
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
    }
    doc.startViewTransition = (cb: any) => { setTimeout(() => { µ._mjs_navSeq++; cb() }, 0); return {} }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    µ._mjs_navApplyJson({ module: 'mjs-x', props: {}, url: '/x', title: null }, undefined, { push: false, via: 'link', seq: 0 })

    await wait(20)

    assert.equal(doc.body.children.length, 0, 'un swap périmé ne doit PAS avoir installé le composant')
    assert.equal(navigateCalls.length, 0)
    assert.equal(events.length, 0)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// reproduction d'un cas concret de concurrence — 2 navigations concurrentes,
// transitions de durées différentes.
// ────────────────────────────────────────────────────────────────────────────
describe('reproduction d\'un cas de concurrence : 2 navigations concurrentes, transitions de durées différentes', function () {
  it("nav A (transition LENTE, démarrée 1re) puis nav B (transition RAPIDE, démarrée juste après) : seul le load de B part, JAMAIS le DOM de A par-dessus B, ordre des load = ordre des navigations", async function () {
    const nodeA = { tag: 'page-a' }
    const nodeB = { tag: 'page-b' }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      pageCache: {
        has: (p: string) => p === '/a' || p === '/b',
        get: (p: string) => [p === '/a' ? nodeA : nodeB],
        set() {},
      },
    }
    let vtCalls = 0
    doc.startViewTransition = (cb: any) => {
      vtCalls++
      const delay = vtCalls === 1 ? 50 : 10 // A (1re transition démarrée) LENTE, B (2e) RAPIDE
      setTimeout(cb, delay)
      return {}
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    const handler = makeClickHandler()
    handler(makeClickEvent(makeLink({}, { pathname: '/a', href: 'http://x/a' })), µ, win, doc, class {}, FakeFormData)
    handler(makeClickEvent(makeLink({}, { pathname: '/b', href: 'http://x/b' })), µ, win, doc, class {}, FakeFormData)

    await wait(15) // au-delà de la transition RAPIDE (B, 10ms), en-deçà de la LENTE (A, 50ms)

    assert.equal(currentRoot.by === nodeB, true, 'B (plus récente) doit être affichée dès que SA transition (rapide) se résout')
    assert.equal(events.length, 1, 'un seul mjs:load à ce stade (celui de B)')
    assert.equal(navigateCalls.length, 1)

    await wait(60) // laisse la transition LENTE (A, périmée) se résoudre aussi

    assert.equal(currentRoot.by === nodeB, true, 'A (périmée) ne doit PAS avoir écrasé B en arrivant après')
    assert.equal(events.length, 1, 'TOUJOURS un seul mjs:load : celui de A (périmé) ne doit jamais partir')
    assert.equal(navigateCalls.length, 1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Défauts 2 et 3 — même patron que tests/ujs-preload-submitter.test.ts (µ._mjs_ujsOnSubmit extrait, µ._mjs_navDispatch STUBBÉ).
// ────────────────────────────────────────────────────────────────────────────
class SubFormData {
  private entries: Array<[string, any]>
  constructor(seed: Array<[string, any]> = []) { this.entries = seed.slice() }
  append(k: string, v: any) { this.entries.push([k, v]) }
  get(k: string) { const e = this.entries.find(([key]) => key === k); return e ? e[1] : null }
}
function seededSubFormData(fields: Array<[string, any]>) {
  return class extends SubFormData {
    constructor() { super(fields) }
  }
}
function extractSubmitBody(): string {
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
}
function makeSubmitHandler(): Function {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody())
}
function extractConfirmRefireStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire')
}
function withConfirmRefire(µ: any) {
  new Function('µ', extractConfirmRefireStatement())(µ)
  return µ
}
function makeSubForm(attrs: Record<string, string> = {}): any {
  const store: Record<string, string> = Object.assign({}, attrs)
  return {
    // relance @confirm (µ._mjs_ujsConfirmRefire) : gate `ok && _confirmEl.isConnected` (seul le rejeu de confirmation l'utilise).
    isConnected: true,
    hasAttribute: (k: string) => Object.prototype.hasOwnProperty.call(store, k),
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setAttribute: (k: string, v: string) => { store[k] = v },
    removeAttribute: (k: string) => { delete store[k] },
    querySelectorAll: () => [],
    closest: function (this: any) { return this },
  }
}
function makeSubButton(attrs: Record<string, string> = {}, extra: Record<string, any> = {}) {
  return Object.assign({
    tagName: 'BUTTON',
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  }, extra)
}
function makeSubEvent(form: any, submitter: any = null) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagationCalled: false,
    stopImmediatePropagation() { this.stopImmediatePropagationCalled = true },
    submitter,
    target: form,
  }
}
function makeSubMu(dispatchCalls: any[], overrides: any = {}) {
  return Object.assign({
    log() {}, warn() {}, error() {},
    realTarget: (e: any) => e.target,
    _mjs_navDispatch: (url: string, method: string, payload: any, opts: any) => { dispatchCalls.push({ url, method, payload, opts }); return 'ok' },
  }, overrides)
}
function setupSub(dispatchCalls: any[]) {
  const µ: any = makeSubMu(dispatchCalls)
  const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
  const doc: any = { URL: 'http://x/posts' } // document.URL — formaction=""
  installHelpers(µ, doc, win) // µ._mjs_navNoUjs
  const handler = makeSubmitHandler()
  return { µ, win, doc, handler }
}

describe('@confirm posé sur un WRAPPER (le <form>, pas le bouton) — le rejeu retrouve le vrai soumissionnaire', function () {
  it('mjs-confirm sur le <form>, bouton soumissionnaire formaction="/autre" : après confirmation, µ._mjs_navDispatch reçoit /autre (ROUGE avant correctif : action du FORMULAIRE)', async function () {
    const dispatchCalls: any[] = []
    let resolveConfirm: (v: boolean) => void = null as any
    const confirmPromise = new Promise<boolean>((res) => { resolveConfirm = res })
    const µ = withConfirmRefire(makeSubMu(dispatchCalls, { confirm: () => confirmPromise }))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
    const doc: any = { URL: 'http://x/posts' }
    installHelpers(µ, doc, win)
    const handler = makeSubmitHandler()

    const form = makeSubForm({ action: '/form-action', 'mjs-confirm': 'Confirmer ?' })
    const submitter = makeSubButton({ formaction: '/autre' })
    form.requestSubmit = function (sub: any) {
      handler(makeSubEvent(form, sub || null), µ, win, doc, seededSubFormData([]), URL, class {})
    }
    const e = makeSubEvent(form, submitter)
    handler(e, µ, win, doc, seededSubFormData([]), URL, class {})

    assert.equal(dispatchCalls.length, 0, '1er passage : bloqué en attente de confirmation')
    assert.equal(e.defaultPrevented, true)

    resolveConfirm(true)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    assert.equal(dispatchCalls.length, 1, 'la relance doit avoir resoumis, via requestSubmit(submitter)')
    assert.equal(dispatchCalls[0].url, '/autre', "l'action du BOUTON (formaction) doit l'emporter, PAS celle du <form>")
    assert.equal(form.getAttribute('mjs-confirm'), 'Confirmer ?', 'attribut restauré après la relance')
  })
})

describe('lecture par PRÉSENCE de formaction/formmethod/formtarget (valeur vide = valeur HTML valide, pas une absence)', function () {
  it('formaction="" sur le bouton soumissionnaire : la requête part vers l\'URL du DOCUMENT (document.URL), jamais l\'action du <form> (ROUGE avant correctif)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSub(dispatchCalls)
    const form = makeSubForm({ action: '/form-action' })
    const submitter = makeSubButton({ formaction: '' })
    const e = makeSubEvent(form, submitter)

    handler(e, µ, win, doc, seededSubFormData([]), URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].url, doc.URL, 'formaction="" doit résoudre vers document.URL, PAS l\'action du formulaire')
    assert.equal(e.defaultPrevented, true)
  })

  it('formmethod="" sur le bouton soumissionnaire : méthode GET (défaut d\'un attribut énuméré présent), <form method="post"> ignoré (ROUGE avant correctif)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSub(dispatchCalls)
    const form = makeSubForm({ action: '/x', method: 'post' })
    const submitter = makeSubButton({ formmethod: '' })
    const e = makeSubEvent(form, submitter)

    handler(e, µ, win, doc, seededSubFormData([]), URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].method, 'GET')
  })

  it('formtarget="" sur le bouton soumissionnaire : équivalent "_self", soumission INTERCEPTÉE (repli erroné vers le target="_blank" du <form> avant correctif)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSub(dispatchCalls)
    const form = makeSubForm({ action: '/x', target: '_blank' }) // le <form> vise un AUTRE cadre
    const submitter = makeSubButton({ formtarget: '' }) // le bouton dit explicitement "_self"
    const e = makeSubEvent(form, submitter)

    handler(e, µ, win, doc, seededSubFormData([]), URL, class {})

    assert.equal(dispatchCalls.length, 1, 'formtarget="" doit l\'emporter sur le target="_blank" du <form>')
    assert.equal(e.defaultPrevented, true)
  })
})
