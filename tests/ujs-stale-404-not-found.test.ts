// 2 résidus de la branche 404
// (`json.module === null`) de µ._mjs_navApplyJson, mjs_ujs.ts ~l.1381-1409 :
//   1) 404 PÉRIMÉ NON GARDÉ — la branche installe le panneau (µ._mjs_navShowNotFound), pousse
//      l'historique et émet mjs:load SANS AUCUNE garde de fraîcheur ; seul l'appel `opts.onSwapped()`
//      posé par le correctif précédent vérifiait `opts.seq`. Un 404 périmé (une navigation plus récente a rebumpé
//      `µ._mjs_navSeq` pendant la requête) installait donc son panneau PAR-DESSUS le DOM de la navigation
//      gagnante. Correctif : garde `if (opts.seq != null && opts.seq !== µ._mjs_navSeq) return;` EN TÊTE
//      de la branche — rien d'installé, rien de poussé, aucun événement (même raisonnement que la
//      garde du swap nominal). Appel DIRECT de µ._mjs_navApplyJson (comme tests/ujs-404-json-get-query.test.ts) : les 3
//      sites d'appel réels (clic/popstate/_mjs_navDispatch) filtrent déjà `seq !== µ._mjs_navSeq` de façon
//      SYNCHRONE, AVANT tout appel à cette fonction (cf. leurs 3 bandeaux, « les 3
//      sites d'appel normaux ont déjà écarté un opts.seq périmé ») — cette branche (aucun
//      µ._mjs_vtWrapSwap, toujours synchrone) n'est donc atteignable avec un `opts.seq` périmé que par un
//      appelant DIRECT ; défense en profondeur, symétrique de la garde du swap nominal.
//   2) `routeNotFound: 'silent'|'warn'` — µ._mjs_navShowNotFound sort AVANT toute installation (rien
//      n'est affiché) ; `opts.onSwapped()` (posé par le correctif précédent) tournait quand même, écrivant
//      `µ._mjs_lastUjsPath` vers la destination 404 et défilant — incohérence DOM/chemin, poison
//      symétrique à l'ancien `method:'none'`. Correctif : µ._mjs_navShowNotFound rend une valeur FALSY
//      (`false`) si rien n'a été installé (modes 'silent'/'warn'), la valeur RÉELLE du contenant sinon
//      (mode 'error', TOUJOURS truthy — INCHANGÉ, cf. tests verrouillés sur `detail.zone`,
//      tests/ujs-nav-lifecycle-events.test.ts) ; `opts.onSwapped()` n'est appelé QUE si cette valeur
//      est truthy. `mjs:load` reste émis dans TOUS les cas (signal terminal). Couvert respectivement par
//      les modes 'silent', 'warn' et 'error' (ce dernier en non-régression).
//
// Méthode : EXACTEMENT le harnais tests/ujs-404-json-get-query.test.ts — extraction par marqueurs EXPLICITES
// (tests/helpers/extract-marked.ts), stubs plats, PAS de happy-dom. Sous-ensemble des helpers : seul le
// chemin CLIC est exercé ici (ni popstate ni soumission de formulaire, hors périmètre des 2 items).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ────────────────────────────────────────────────────────────────────────────
// EXTRACTION + FIXTURES — sous-ensemble du patron de tests/ujs-404-json-get-query.test.ts (chemin CLIC seul).
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
class FakeFormData {
  private entries: Array<[string, any]>
  constructor(seed: Array<[string, any]> = []) { this.entries = seed.slice() }
  append(k: string, v: any) { this.entries.push([k, v]) }
  get(k: string) { const e = this.entries.find(([key]) => key === k); return e ? e[1] : null }
  *[Symbol.iterator]() { yield* this.entries }
}
// µ minimal PARTAGÉ — même patron que tests/ujs-404-json-get-query.test.ts (setupMu) : pageCache RÉEL (Map), routeNotFound par
// défaut ('error'), aucune transition de vue (_mjs_vtEnabled false).
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
// 404 PÉRIMÉ (opts.seq) doit tout court-circuiter EN TÊTE de branche.
// ────────────────────────────────────────────────────────────────────────────
describe('404 périmé (opts.seq ≠ µ._mjs_navSeq) — garde en TÊTE de branche', function () {
  it('2e navigation déjà gagnante (µ._mjs_navSeq bumpé, DOM et µ._mjs_lastUjsPath déjà les siens) quand la réponse 404 en retard de la 1re arrive : rien installé/poussé/émis, µ._mjs_lastUjsPath inchangé', function () {
    // État simulé : la 2e navigation (plus récente) a déjà démarré ET gagné — µ._mjs_navSeq bumpé (7), DOM
    // = son contenu, µ._mjs_lastUjsPath = sa destination — QUAND la réponse 404 en retard de la 1re
    // (seq capturée à l'époque : 3, désormais périmée) arrive enfin. Appel DIRECT de µ._mjs_navApplyJson
    // (cf. bandeau de fichier ci-dessus) : seul point d'entrée qui atteint réellement cette branche
    // avec un `opts.seq` périmé.
    const nodeGagnant = { tag: 'gagnant', nodeType: 1 }
    const currentRoot = makeContainer([nodeGagnant])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/page-gagnante', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const µ = setupMu(doc, win, new Map<string, any>())
    µ._mjs_navSeq = 7 // la 2e navigation (gagnante) a bumpé la seq
    µ._mjs_lastUjsPath = '/page-gagnante' // et déjà écrit son propre chemin

    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    let onSwappedCalls = 0

    µ._mjs_navApplyJson({ module: null, url: '/late-404' }, 'http://x/late-404', { seq: 3, via: 'link', onSwapped: function () { onSwappedCalls++; µ._mjs_lastUjsPath = '/late-404' } })

    assert.deepEqual(currentRoot.children, [nodeGagnant], 'le 404 périmé ne doit RIEN installer par-dessus le DOM de la navigation gagnante')
    assert.equal(events.length, 0, 'le 404 périmé ne doit émettre AUCUN mjs:load')
    assert.equal(onSwappedCalls, 0, 'opts.seq (3) périmé face à µ._mjs_navSeq (7) : onSwapped ne doit pas tourner')
    assert.equal(µ._mjs_lastUjsPath, '/page-gagnante', "µ._mjs_lastUjsPath reste celui de la navigation gagnante, jamais touché par le 404 périmé")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// routeNotFound 'silent'/'warn' n'installent rien -> onSwapped ne doit PAS tourner ;
// 'error' (défaut) inchangé.
// ────────────────────────────────────────────────────────────────────────────
describe("µ._mjs_navShowNotFound falsy si rien installé ('silent'/'warn') -> opts.onSwapped() non appelé", function () {
  it("mode 'silent' : rien installé, µ._mjs_lastUjsPath INCHANGÉ, aucun défilement, mjs:load ÉMIS (signal terminal)", function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    let scrollCalls = 0
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() { scrollCalls++ } }
    const µ = setupMu(doc, win, new Map<string, any>())
    µ.config = { routeNotFound: 'silent' }
    const handler = makeClickHandler()

    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/notfound', href: 'http://x/notfound' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss, réseau attendu')

    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    capturedSuccess({ module: null, url: '/notfound' }, 'http://x/notfound')

    assert.deepEqual(currentRoot.children, [nodeOrig], "mode 'silent' : rien d'installé, le DOM origine reste en place")
    assert.equal(µ._mjs_lastUjsPath, '/origine', "µ._mjs_lastUjsPath ne doit pas suivre un 404 qui n'a rien installé")
    assert.equal(scrollCalls, 0, 'aucun défilement : rien n\'a été swappé')
    assert.equal(events.length, 1, 'mjs:load reste émis (signal terminal, même sans installation)')
  })

  it("mode 'warn' : rien installé, µ._mjs_lastUjsPath INCHANGÉ, 1 warn, mjs:load ÉMIS", function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const µ = setupMu(doc, win, new Map<string, any>())
    µ.config = { routeNotFound: 'warn' }
    const handler = makeClickHandler()

    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/notfound', href: 'http://x/notfound' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss, réseau attendu')

    let warnCalls = 0
    µ.warn = () => { warnCalls++ }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    capturedSuccess({ module: null, url: '/notfound' }, 'http://x/notfound')

    assert.deepEqual(currentRoot.children, [nodeOrig], "mode 'warn' : rien d'installé, le DOM origine reste en place")
    assert.equal(µ._mjs_lastUjsPath, '/origine', "µ._mjs_lastUjsPath ne doit pas suivre un 404 qui n'a rien installé")
    assert.equal(warnCalls, 1, 'un seul avertissement (µ._mjs_navShowNotFound, mode warn)')
    assert.equal(events.length, 1, 'mjs:load reste émis (signal terminal, même sans installation)')
  })

  it("mode 'error' (défaut) : panneau installé, µ._mjs_lastUjsPath = destination (non-régression)", function () {
    const nodeOrig = { tag: 'origine', nodeType: 1 }
    const currentRoot = makeContainer([nodeOrig])
    const doc: any = makeEventDoc(currentRoot)
    const win: any = { location: { pathname: '/origine', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    const µ = setupMu(doc, win, new Map<string, any>()) // config: {} -> mode 'error' par défaut
    const handler = makeClickHandler()

    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    handler(makeClickEvent(makeLink({}, { pathname: '/notfound', href: 'http://x/notfound' })), µ, win, doc, class {}, FakeFormData)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss, réseau attendu')

    capturedSuccess({ module: null, url: '/notfound' }, 'http://x/notfound')

    assert.notDeepEqual(currentRoot.children, [nodeOrig], 'le panneau "introuvable" doit avoir REMPLACÉ le DOM')
    assert.equal(µ._mjs_lastUjsPath, '/notfound', 'µ._mjs_lastUjsPath doit SUIVRE le panneau affiché (non-régression)')
  })
})
