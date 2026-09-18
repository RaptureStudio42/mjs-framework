// 2 défauts fermés sur mjs_ujs.ts :
//   1) fragment absorbe la query (GET) — `_mjs_ujsOnSubmit` : `formaction=""` ou repli sans
//      action bascule sur `document.URL`/`window.location.href` AVEC leur fragment ; `_mjs_navDispatch`
//      (branche GET) concatène `sep + qs` APRÈS ce fragment → query syntaxiquement dans le fragment,
//      perdue au fetch réel.
//   2) `µ._mjs_lastUjsPath` écrit AVANT un swap DIFFÉRÉ par `µ._mjs_vtWrapSwap` (transition de vue) —
//      3 sites (popstate JSON réseau, clic JSON réseau, `_mjs_navDispatch`/`done`/branche JSON) écrivent
//      SYNCHRONEMENT alors que le swap réel peut être différé : une 2e navigation démarrée pendant ce
//      délai hiberne le DOM ENCORE AFFICHÉ sous la clé de la 1re destination (pageCache empoisonné).
//
// Méthode : EXACTEMENT le même harnais que tests/ujs-deferred-swap-confirm-wrapper.test.ts — extraction par marqueurs
// EXPLICITES (tests/helpers/extract-marked.ts), stubs plats, PAS de happy-dom. Transition DIFFÉRÉE
// simulée par un rappel `document.startViewTransition` contrôlé À LA MAIN (jamais auto-résolu tant
// que le test ne l'appelle pas), comme tests/ujs-deferred-swap-confirm-wrapper.test.ts.

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
// EXTRACTION + FIXTURES — même patron que tests/ujs-deferred-swap-confirm-wrapper.test.ts, inchangé.
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
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody())
}
function extractSubmitBody(): string {
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
}
function makeSubmitHandler(): Function {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody())
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
function makeSubForm(attrs: Record<string, string> = {}): any {
  const store: Record<string, string> = Object.assign({}, attrs)
  return {
    isConnected: true,
    hasAttribute: (k: string) => Object.prototype.hasOwnProperty.call(store, k),
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(store, k) ? store[k] : null),
    setAttribute: (k: string, v: string) => { store[k] = v },
    removeAttribute: (k: string) => { delete store[k] },
    querySelectorAll: () => [],
    closest: function (this: any) { return this },
  }
}
function makeSubButton(attrs: Record<string, string> = {}) {
  return { tagName: 'BUTTON', getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null) }
}
function makeSubEvent(form: any, submitter: any = null) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, stopImmediatePropagation() {}, submitter, target: form }
}
class FakeFormData {
  private entries: Array<[string, any]>
  constructor(seed: Array<[string, any]> = []) { this.entries = seed.slice() }
  append(k: string, v: any) { this.entries.push([k, v]) }
  get(k: string) { const e = this.entries.find(([key]) => key === k); return e ? e[1] : null }
  *[Symbol.iterator]() { yield* this.entries }
}
function seededFormData(fields: Array<[string, any]>) {
  return class extends FakeFormData { constructor() { super(fields) } }
}

// ────────────────────────────────────────────────────────────────────────────
// Défaut 1 — `_mjs_ujsOnSubmit` → `_mjs_navDispatch` RÉELS (jamais stubbés), URL réellement
// transmise à `µ._mjs_ajaxRequest` capturée en sortie.
// ────────────────────────────────────────────────────────────────────────────
function runSubmitDispatch(opts: { formAttrs?: Record<string, string>, submitterAttrs?: Record<string, string> | null, hasSubmitter?: boolean, docHref: string, fields: Array<[string, any]> }) {
  const captured: any[] = []
  const µ: any = { warn() {}, error() {}, log() {}, realTarget: (e: any) => e.target }
  µ._mjs_ajaxRequest = (o: any) => { captured.push(o) }
  const win: any = { location: { href: opts.docHref, origin: 'http://x' }, history: { pushState() {} } }
  const doc: any = { URL: opts.docHref, body: {}, querySelector: () => null, dispatchEvent: () => true }
  installHelpers(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})
  const handler = makeSubmitHandler()
  const form = makeSubForm(opts.formAttrs || {})
  const submitter = opts.hasSubmitter === false ? null : makeSubButton(opts.submitterAttrs || {})
  const e = makeSubEvent(form, submitter)
  handler(e, µ, win, doc, seededFormData(opts.fields), URL, class {})
  return captured[0]
}

describe('fragment absorbe la query (GET), formaction="" / repli window.location.href / action à ancre explicite', function () {
  it('formaction="" + document.URL À FRAGMENT + GET + q=hello : url réellement transmise = http://x/search?q=hello (jamais après #)', function () {
    const r = runSubmitDispatch({
      formAttrs: { action: '/search-action' },
      submitterAttrs: { formaction: '' },
      docHref: 'http://x/search#results',
      fields: [['q', 'hello']],
    })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, 'http://x/search?q=hello')
  })

  it("formulaire SANS action, SANS submitter (repli window.location.href À FRAGMENT), GET : même défaut, url = http://x/search?q=hello", function () {
    const r = runSubmitDispatch({
      formAttrs: {},
      hasSubmitter: false,
      docHref: 'http://x/search#results',
      fields: [['q', 'hello']],
    })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, 'http://x/search?q=hello')
  })

  it('action="/x#anchor" EXPLICITE + GET + champs : /x?q=hello#anchor (ancre PRÉSERVÉE, query insérée AVANT le #, jamais dedans)', function () {
    const r = runSubmitDispatch({
      formAttrs: { action: '/x#anchor' },
      hasSubmitter: false,
      docHref: 'http://x/whatever',
      fields: [['q', 'hello']],
    })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, '/x?q=hello#anchor')
  })

  it('POST, formaction="" + document.URL À FRAGMENT : URL d\'action transmise SANS fragment, corps intact', function () {
    const r = runSubmitDispatch({
      formAttrs: { action: '/create', method: 'post' },
      submitterAttrs: { formaction: '' },
      docHref: 'http://x/search#results',
      fields: [['title', 'Bonjour']],
    })
    assert.equal(r.method, 'POST')
    assert.equal(r.url, 'http://x/search')
    assert.equal(r.data.get('title'), 'Bonjour')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Défaut 2 — `µ._mjs_lastUjsPath` écrit AVANT un swap différé par `µ._mjs_vtWrapSwap`.
// ────────────────────────────────────────────────────────────────────────────
describe('µ._mjs_lastUjsPath écrit AVANT un swap différé (clic/popstate/soumission JSON)', function () {
  it("2 navigations concurrentes par CLIC (JSON), la 1re DIFFÉRÉE par transition : avant SON swap µ._mjs_lastUjsPath reste la page affichée ; la 2e hiberne SOUS CETTE clé (pas la 1re destination, pageCache non empoisonné) ; à la fin µ._mjs_lastUjsPath = destination finale", async function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer()
    currentRoot.children = [nodeOrig]
    const doc: any = makeEventDoc(currentRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const realPageCache = new Map<string, any>()
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/origine',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
      paths: { a: 'a.js', b: 'b.js' },
      pageCache: realPageCache,
    }
    let vtCalls = 0
    let resolveFirst: (() => void) | null = null
    doc.startViewTransition = (cb: any) => {
      vtCalls++
      if (vtCalls === 1) { resolveFirst = cb } else { cb() } // 1re transition (A) : jamais auto-résolue ; suivantes : synchrones
      return {}
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
    const handler = makeClickHandler()

    let capturedSuccessA: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccessA = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/a', href: 'http://x/a' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccessA === 'function', 'A : cache-miss, réseau attendu')
    capturedSuccessA({ module: 'mjs-a', props: {}, url: '/a' }, 'http://x/a')

    assert.equal(currentRoot.by, undefined, 'A ne doit PAS encore avoir swappé (transition différée, jamais résolue à ce stade)')
    assert.equal(µ._mjs_lastUjsPath, '/origine', "µ._mjs_lastUjsPath ne doit PAS bouger avant le swap RÉEL de A (c'est le défaut B)")

    let capturedSuccessB: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccessB = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/b', href: 'http://x/b' })), µ, win, doc, class {}, FakeFormData)

    assert.ok(µ._mjs_navHibernated, 'la 2e navigation doit avoir posé une hibernation')
    assert.equal(µ._mjs_navHibernated.path, '/origine', "la 2e navigation doit hiberner sous la clé de la page RÉELLEMENT affichée ('/origine'), jamais '/a' (destination de A, jamais swappée)")

    assert.ok(typeof capturedSuccessB === 'function', 'B : cache-miss, réseau attendu')
    capturedSuccessB({ module: 'mjs-b', props: {}, url: '/b' }, 'http://x/b')
    await wait(5)

    assert.equal(µ._mjs_lastUjsPath, '/b', 'à la fin, µ._mjs_lastUjsPath doit être la destination FINALE (B, navigation gagnante)')
    assert.equal(realPageCache.has('/origine'), true, "l'entrée pageCache '/origine' (posée par les 2 clics) doit exister")
    assert.equal(realPageCache.has('/a'), false, "aucune entrée pageCache '/a' ne doit avoir été créée (poison évité)")

    if (resolveFirst) { (resolveFirst as () => void)() }
    await wait(5)
    assert.equal(µ._mjs_lastUjsPath, '/b', "A périmée (résolue en retard) ne doit PAS écraser µ._mjs_lastUjsPath")
    assert.equal(events.length, 1, 'un seul mjs:load (celui de B) : celui de A, périmé, ne part jamais')
  })

  it("popstate, réponse JSON RÉSEAU, SANS transition : ordre observable inchangé — µ._mjs_lastUjsPath = destination finale, DÉJÀ correct au moment de mjs:load", function () {
    const doc: any = makeEventDoc(makeNode('body'))
    let lastPathAtLoad: string | undefined
    doc.addEventListener('mjs:load', () => { lastPathAtLoad = µ._mjs_lastUjsPath })
    const win: any = { location: { pathname: '/b', search: '', hash: '', origin: 'http://x' }, history: {} }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      Router: { navigate() {}, _mjs_vtEnabled: () => false },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      pageCache: { has: () => false, get() { return undefined }, set() {} },
      paths: { b: 'b.js' },
      _mjs_resSet() {},
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
    let capturedSuccess: any
    µ._mjs_navRequest = (_m: string, _u: string, _d: any, success: any) => { capturedSuccess = success }

    const handler = makePopstateHandler()
    handler({}, µ, win, doc, class {})

    assert.ok(typeof capturedSuccess === 'function', 'cache-miss : réseau attendu')
    capturedSuccess({ module: 'mjs-b', props: {}, url: '/b' }, 'http://x/b')

    assert.equal(µ._mjs_lastUjsPath, '/b', 'µ._mjs_lastUjsPath doit refléter la destination finale')
    assert.equal(lastPathAtLoad, '/b', 'au moment de mjs:load, µ._mjs_lastUjsPath doit DÉJÀ valoir la destination (ordre inchangé)')
  })

  it("popstate cache-hit (_swapPopCache, site DÉJÀ correct, non-régression) : µ._mjs_lastUjsPath = destination, déjà correct au moment de mjs:load", function () {
    const cachedNode = { tag: 'cached', nodeType: 1 }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    let lastPathAtLoad: string | undefined
    doc.addEventListener('mjs:load', () => { lastPathAtLoad = µ._mjs_lastUjsPath })
    const win: any = { location: { pathname: '/b', search: '', hash: '', origin: 'http://x' }, history: {} }
    const µ: any = {
      realTarget: (e: any) => e.target,
      warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      Router: { navigate() {}, _mjs_vtEnabled: () => false },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      pageCache: { has: (p: string) => p === '/b', get: () => [cachedNode], set() {} },
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    const handler = makePopstateHandler()
    handler({}, µ, win, doc)

    assert.equal(µ._mjs_lastUjsPath, '/b')
    assert.equal(lastPathAtLoad, '/b')
  })

  it("soumission POST->JSON avec redirection serveur (finalUrl), transition DIFFÉRÉE : µ._mjs_lastUjsPath reste la page affichée PENDANT le différé, devient finalUrl APRÈS le swap RÉEL", async function () {
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const µ: any = {
      warn() {}, error() {}, log() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_lastUjsPath: '/posts',
      Router: { navigate() {}, _mjs_vtEnabled: () => true },
      viewTransition: true,
      nav: { active: false, href: null },
      paths: { x: 'xxx.js' },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    let vtResolve: (() => void) | null = null
    doc.startViewTransition = (cb: any) => { vtResolve = cb; return {} }
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    installNavDispatch(µ, win, doc, class {})
    installVt(µ, doc)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess({ module: 'mjs-x', props: {}, url: '/x' }, 'http://x/posts/42')

    assert.equal(µ._mjs_lastUjsPath, '/posts', "PENDANT le différé (swap pas encore résolu), µ._mjs_lastUjsPath doit rester la page AFFICHÉE — pas encore '/posts/42'")
    assert.equal(events.length, 0, 'aucun mjs:load avant la résolution du swap')

    if (vtResolve) { (vtResolve as () => void)() }
    await wait(5)

    assert.equal(µ._mjs_lastUjsPath, '/posts/42', 'APRÈS le swap réel, µ._mjs_lastUjsPath doit refléter finalUrl (redirection serveur)')
    assert.equal(events.length, 1)
  })
})
