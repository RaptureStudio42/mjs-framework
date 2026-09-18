// 2 défauts sur mjs_ujs.ts :
//   Premier défaut — la branche 404 (`json.module === null`) de µ._mjs_navApplyJson installe
//      RÉELLEMENT le panneau « Page introuvable » (µ._mjs_navInstallInZone, le DOM change) mais n'appelle
//      jamais `opts.onSwapped` — avant ce correctif, `µ._mjs_lastUjsPath` était écrit INCONDITIONNELLEMENT au
//      site d'appel (couvrait donc aussi le 404) ; ce correctif a déplacé cette écriture DANS onSwapped sans
//      l'appeler ici. Poison : la navigation suivante hiberne le panneau affiché sous la clé de
//      l'ANCIENNE page (pageCache empoisonné, retour arrière montre le panneau).
//   Second défaut — query GET : la spec HTML (form GET, « mutate action URL ») REMPLACE la query de l'action
//      par celle du formulaire, jamais ne s'y AJOUTE — `_mjs_navDispatch` (branche GET) concatène
//      aujourd'hui `sep + qs` APRÈS la query déjà présente (`/x?existing=1&q=hello` au lieu de
//      `/x?q=hello` ; `action="?"` -> `?&q=hello`, `&` orphelin). Pré-existant (déjà présent
//      avant ce correctif).
//
// Méthode : EXACTEMENT le harnais tests/ujs-get-query-last-path.test.ts — extraction
// par marqueurs EXPLICITES (tests/helpers/extract-marked.ts), stubs plats, PAS de happy-dom.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ────────────────────────────────────────────────────────────────────────────
// EXTRACTION + FIXTURES — inchangé.
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
    appendChild(n: any) { node.children.push(n) },
    setAttribute() {}, get className() { return '' }, set className(_v: any) {},
  }
  return node
}
function makeEventDoc(body: any): any {
  const listeners: Array<{ type: string, fn: (e: any) => void }> = []
  return {
    body,
    querySelector: () => null,
    createElement: (tag: string) => makeNode(tag),
    adoptedStyleSheets: [],
    addEventListener(type: string, fn: (e: any) => void) { listeners.push({ type, fn }) },
    dispatchEvent(e: any) { listeners.filter((l) => l.type === e.type).forEach((l) => l.fn(e)); return !e.defaultPrevented },
  }
}
function makeContainer(seed: any[] = []): any {
  const c: any = { children: seed.slice() as any[] }
  Object.defineProperty(c, 'childNodes', { get: () => c.children.slice() })
  c.replaceChildren = (...nodes: any[]) => { c.by = nodes[0]; c.children = nodes.slice() }
  c.appendChild = (n: any) => { c.children.push(n) }
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
// µ minimal PARTAGÉ : pageCache RÉEL (Map), routeNotFound par défaut ('error'), aucune transition de vue (_mjs_vtEnabled false).
function setupMu(doc: any, win: any, realPageCache: Map<string, any>) {
  const µ: any = {
    realTarget: (e: any) => e.target,
    warn() {}, error() {}, log() {},
    _mjs_navSeq: 0, _mjs_lastUjsPath: '/origine',
    Router: { navigate() {}, _mjs_vtEnabled: () => false },
    config: {}, // routeNotFound par défaut ('error')
    _mjs_saveScroll() {}, _mjs_restoreScroll() {},
    paths: {},
    pageCache: realPageCache,
  }
  installHelpers(µ, doc, win)
  installVt(µ, doc)
  new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
  return µ
}

// ────────────────────────────────────────────────────────────────────────────
// 404 JSON n'écrivait plus µ._mjs_lastUjsPath.
// ────────────────────────────────────────────────────────────────────────────
describe('404 JSON (module:null) doit écrire µ._mjs_lastUjsPath comme un swap réel', function () {
  it('clic JSON -> {module:null} (404) : µ._mjs_lastUjsPath = destination 404 ; clic suivant hiberne l\'origine sous SA clé et le panneau 404 sous SA clé', function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const realPageCache = new Map<string, any>()
    const µ = setupMu(doc, win, realPageCache)
    const handler = makeClickHandler()

    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/notfound', href: 'http://x/notfound' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss, réseau attendu')
    assert.equal(realPageCache.get('/origine')[0], nodeOrig, "hibernation au CLIC : origine archivée sous SA clé, avant tout swap")

    capturedSuccess({ module: null, url: '/notfound' }, 'http://x/notfound')
    assert.notDeepEqual(currentRoot.children, [nodeOrig], 'le panneau "introuvable" doit avoir REMPLACÉ le DOM')
    assert.equal(µ._mjs_lastUjsPath, '/notfound', 'µ._mjs_lastUjsPath doit SUIVRE le panneau affiché (régression fermée)')

    const notFoundSnapshot = currentRoot.children.slice()
    let capturedSuccess2: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess2 = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/page-c', href: 'http://x/page-c' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess2 === 'function')

    assert.equal(realPageCache.has('/origine'), true)
    // Array.from : dépouille les décorations d'ARRAY posées par µ._mjs_navHibernate (_mjs_mjsHead, _mjs_mjsCachePolicy)
    // pour ne comparer QUE le contenu — non-sujet ici, cf. son propre bandeau.
    assert.deepEqual(Array.from(realPageCache.get('/origine')), [nodeOrig], "pageCache['/origine'] doit rester le nœud ORIGINE, jamais écrasé par le panneau 404")
    assert.equal(realPageCache.has('/notfound'), true, 'le panneau 404 doit être hiberné sous SA PROPRE clé')
    assert.deepEqual(Array.from(realPageCache.get('/notfound')), notFoundSnapshot)
  })

  it('popstate JSON -> {module:null} (404) : µ._mjs_lastUjsPath = destination 404 ; popstate suivant hiberne correctement', function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/notfound', search: '', hash: '', origin: 'http://x' }, history: {}, scrollTo() {} }
    const realPageCache = new Map<string, any>()
    const µ = setupMu(doc, win, realPageCache) // _mjs_lastUjsPath initial '/origine'
    const handler = makePopstateHandler()

    let capturedSuccess: any
    µ._mjs_navRequest = (_m: string, _u: string, _d: any, success: any) => { capturedSuccess = success }
    handler({}, µ, win, doc, class {})
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss, réseau attendu')
    assert.equal(realPageCache.has('/origine'), true, "hibernation au popstate : origine archivée sous SA clé")

    capturedSuccess({ module: null, url: '/notfound' }, 'http://x/notfound')
    assert.notDeepEqual(currentRoot.children, [nodeOrig])
    assert.equal(µ._mjs_lastUjsPath, '/notfound', 'µ._mjs_lastUjsPath doit SUIVRE le panneau affiché')

    const notFoundSnapshot = currentRoot.children.slice()
    win.location.pathname = '/page-e'
    let capturedSuccess2: any
    µ._mjs_navRequest = (_m: string, _u: string, _d: any, success: any) => { capturedSuccess2 = success }
    handler({}, µ, win, doc, class {})
    assert.ok(typeof capturedSuccess2 === 'function')

    assert.equal(realPageCache.has('/notfound'), true, 'le panneau 404 doit être hiberné sous SA PROPRE clé')
    // Array.from : dépouille les décorations d'ARRAY posées par µ._mjs_navHibernate (_mjs_mjsHead), cf. plus haut.
    assert.deepEqual(Array.from(realPageCache.get('/notfound')), notFoundSnapshot)
  })

  it('_mjs_navDispatch (soumission GET) -> {module:null} (404) : µ._mjs_lastUjsPath = destination 404 ; clic suivant hiberne correctement', function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { href: 'http://x/origine', pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const realPageCache = new Map<string, any>()
    const µ = setupMu(doc, win, realPageCache)
    let captured: any
    µ._mjs_ajaxRequest = (o: any) => { captured = o }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('/search', 'GET', new FakeFormData([['q', 'zzz']]), {})
    assert.ok(captured && typeof captured.success === 'function', 'cache-miss, réseau attendu')
    assert.equal(realPageCache.has('/origine'), true, "hibernation au dispatch : origine archivée sous SA clé")

    captured.success({ module: null, url: '/search?q=zzz' }, 'http://x/search?q=zzz')
    assert.notDeepEqual(currentRoot.children, [nodeOrig])
    assert.equal(µ._mjs_lastUjsPath, '/search?q=zzz', 'µ._mjs_lastUjsPath doit SUIVRE la destination 404 (query comprise)')

    const notFoundSnapshot = currentRoot.children.slice()
    const handler = makeClickHandler()
    let capturedSuccess2: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess2 = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/page-f', href: 'http://x/page-f' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess2 === 'function')

    assert.equal(realPageCache.has('/search?q=zzz'), true, "le panneau 404 doit être hiberné sous SA PROPRE clé (celle de la recherche), pas celle de l'origine")
    // Array.from : dépouille les décorations d'ARRAY posées par µ._mjs_navHibernate (_mjs_mjsHead), cf. plus haut.
    assert.deepEqual(Array.from(realPageCache.get('/search?q=zzz')), notFoundSnapshot)
  })

  it("method:'none' : µ._mjs_lastUjsPath INCHANGÉ (non-régression de l'effet de bord, docs/21-navigation.md l.371)", function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState(_s: any, _t: any, u: string) { win.location.pathname = u.split('?')[0].split('#')[0] } }, scrollTo() {} }
    const realPageCache = new Map<string, any>()
    const µ = setupMu(doc, win, realPageCache)
    const handler = makeClickHandler()

    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/rest-action', href: 'http://x/rest-action' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess === 'function')

    capturedSuccess({ method: 'none', props: {}, url: '/rest-action' }, 'http://x/rest-action')
    assert.deepEqual(currentRoot.children, [nodeOrig], "method:'none' ne monte rien, le DOM origine reste en place")
    assert.equal(µ._mjs_lastUjsPath, '/origine', "µ._mjs_lastUjsPath doit rester cohérent avec le DOM réellement affiché")
  })

  it('404 périmé (opts.seq ≠ µ._mjs_navSeq, appel DIRECT de µ._mjs_navApplyJson) : onSwapped ne tourne pas, µ._mjs_lastUjsPath inchangé', function () {
    const currentRoot = makeContainer([{ tag: 'origine', nodeType: 1 }])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const µ = setupMu(doc, win, new Map<string, any>())
    µ._mjs_navSeq = 7

    let onSwappedCalls = 0
    µ._mjs_navApplyJson({ module: null, url: '/late-404' }, 'http://x/late-404', { seq: 3, via: 'link', onSwapped: function () { onSwappedCalls++; µ._mjs_lastUjsPath = '/late-404' } })

    assert.equal(onSwappedCalls, 0, 'opts.seq (3) périmé face à µ._mjs_navSeq (7) : onSwapped ne doit PAS tourner')
    assert.equal(µ._mjs_lastUjsPath, '/origine', "404 périmé : µ._mjs_lastUjsPath n'écrit rien")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// query GET REMPLACE la query de l'action (spec HTML), pas AJOUTE.
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

describe('query GET REMPLACE la query de l\'action (spec HTML), jamais ne s\'y AJOUTE', function () {
  it('action="/x?existing=1" + GET + q=hello : /x?q=hello (REMPLACE, jamais /x?existing=1&q=hello)', function () {
    const r = runSubmitDispatch({ formAttrs: { action: '/x?existing=1' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['q', 'hello']] })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, '/x?q=hello')
  })

  it("action=\"?\" (nu) + GET + q=hello : ?q=hello (jamais ?&q=hello), aligné sur new URL('?q=hello', document.URL)", function () {
    const r = runSubmitDispatch({ formAttrs: { action: '?' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['q', 'hello']] })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, '?q=hello')
    assert.equal(new URL(r.url, 'http://x/whatever').href, new URL('?q=hello', 'http://x/whatever').href, 'même résolution relative que le comportement natif du navigateur')
  })

  it('action="/x?a=1#frag" + GET + q=hello : /x?q=hello#frag (ancre préservée APRÈS la query REMPLACÉE)', function () {
    const r = runSubmitDispatch({ formAttrs: { action: '/x?a=1#frag' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['q', 'hello']] })
    assert.equal(r.method, 'GET')
    assert.equal(r.url, '/x?q=hello#frag')
  })

  it("POST action=\"/create?ref=abc\" : query de l'action CONSERVÉE (la spec ne la touche pas en POST), corps intact", function () {
    const r = runSubmitDispatch({ formAttrs: { action: '/create?ref=abc', method: 'post' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['title', 'Bonjour']] })
    assert.equal(r.method, 'POST')
    assert.equal(r.url, '/create?ref=abc')
    assert.equal(r.data.get('title'), 'Bonjour')
  })
})
