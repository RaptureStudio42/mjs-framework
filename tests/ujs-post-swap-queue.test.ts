// Sur les 6 sites de navigation (µ._mjs_navApplyJson nominal ;
// popstate cache-hit/réseau ; clic cache-hit/réseau ; soumission via µ._mjs_navDispatch/done), la QUEUE
// post-swap (µ.Router.navigate + µ._mjs_navEmit('load', { …, zone }), et pour la soumission le bloc PRG
// window.history.pushState(finalUrl)) s'exécutait juste APRÈS le RETOUR de µ._mjs_vtWrapSwap(link, swap) —
// or quand une transition de vue est active, µ._mjs_vtWrapSwap DIFFÈRE `swap` (rappel de
// document.startViewTransition, asynchrone) et rend SANS ATTENDRE : `mjs:load` partait AVANT
// l'installation réelle, avec `zone: undefined` (la variable qui la porte n'était pas encore
// affectée), et le routeur se resynchronisait sur l'ANCIEN DOM. Ce défaut était déjà pré-existant,
// byte-identique — rien de spécifique à ce correctif ne l'a introduit.
//
// Remède : la queue vit désormais DANS chaque fermeture `swap`/`_swapXxx`, appelée en
// DERNIÈRE ligne (nom local `_apresSwap`/`_finPopCache`/`_finPopNet`/`_finClickCache`/`_finClickNet`/
// `_finSubmit` selon le site) — sans transition de vue (`_mjs_vtWrapSwap` absent, ou son gate
// `Router._mjs_vtEnabled()` faux, ou sa résolution `_mjs_vtResolvePage` fausse) `_mjs_vtWrapSwap` appelle `swap()`
// SYNCHRONEMENT (cf. ses 2 `return swap()` précoces) : l'ordre observable reste IDENTIQUE à avant ce
// correctif. La valeur de retour de `Router.navigate(...)`, autrefois parfois propagée jusqu'à l'appelant du
// handler (popstate/clic), ne l'est plus (aucun appelant ne la consommait — un event listener DOM
// ignore la valeur de retour de son callback).
//
// Méthode : EXACTEMENT la même que tests/ujs-submit-idl-shadowing.test.ts et tests/vt-presets-ujs.test.ts —
// extraction par marqueurs EXPLICITES (tests/helpers/extract-marked.ts, AUCUN comptage d'accolades :
// son propre bandeau documente le remplacement du comptage naïf, périmé) ; `new Function` sur les
// fonctions RÉELLES extraites de la source (`helpers-navigation`, `_mjs_ujsOnClick`, `popstate-listener`,
// `_mjs_navDispatch`, `_mjs_vtResolvePage`+`_mjs_vtWrapSwap`), jamais de réimplémentation à la main. Pas de happy-dom
// ici : les 30+ fichiers ujs-*.test.ts existants (dont
// le modèle explicitement cité, tests/ujs-submit-idl-shadowing.test.ts, dont l'en-tête dit texto « pas de happy-dom ») utilisent tous ce
// même harnais à base de stubs plats ; suivi ici pour rester cohérent avec la famille de tests et pour
// ne jamais passer un NŒUD à `assert.equal`/`deepEqual` (piège connu) — seules des
// comparaisons booléennes/chaînes/nombres sont assertionnées, l'identité d'un nœud est convertie en
// `a === b` (booléen) avant assertion. Transition DIFFÉRÉE simulée par `setTimeout(swap, 0)` (littéral)
// DANS un mock de `document.startViewTransition` ; le test `await` un court délai pour
// laisser ce timer tourner puis vérifie l'état des DEUX côtés (avant/après).

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
// EXTRACTION — mêmes cibles que tests/ujs-submit-idl-shadowing.test.ts / tests/vt-presets-ujs.test.ts.
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
  return new Function('e', 'µ', 'window', 'document', extractPopstateBody())
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}
function installNavDispatch(µ: any, win: any, doc: any, DOMParserCtor: any = class {}) {
  // Adaptateur µ._mjs_ajaxRequest → µ.ajax[method] — même patron que tests/vt-presets-ujs.test.ts,
  // sauf `URL` : le vrai global Node (pas un stub vide) — ce fichier vérifie le PRG (new URL(...).href).
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

// ────────────────────────────────────────────────────────────────────────────
// FIXTURES — mêmes formes que tests/ujs-nav-lifecycle-events.test.ts / tests/vt-presets-ujs.test.ts.
// ────────────────────────────────────────────────────────────────────────────
function makeNode(tag: string): any {
  const node: any = {
    tag, nodeType: 1, isConnected: true, children: [] as any[], parentNode: null as any,
    get childNodes() { return node.children.slice() },
    replaceChildren(...nodes: any[]) { node.children = nodes.slice() },
  }
  return node
}
// document AVEC addEventListener/dispatchEvent — CustomEvent RÉEL (global Node, cf. µ._mjs_navEmit).
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
// conteneur MINIATURE (childNodes lecture seule, replaceChildren) — sert de <body> pour les
// scénarios cache-hit/soumission (`c.by` = ce que le dernier replaceChildren a posé).
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
// µ._mjs_navApplyJson, branche nominale (swap = createElement + resSet + install).
// ────────────────────────────────────────────────────────────────────────────
describe('µ._mjs_navApplyJson : queue post-swap déplacée DANS swap()', function () {
  it('transition de vue DIFFÉRÉE : mjs:load ne part PAS avant le swap réel ; une fois le swap fait, émis UNE fois avec detail.zone DÉFINI', async function () {
    const doc = makeEventDoc(makeNode('body'))
    doc.startViewTransition = (cb: any) => { setTimeout(cb, 0); return {} }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { history: { pushState() {} } }
    const µ: any = {
      warn() {}, error() {}, log() {},
      paths: { x: 'xxx.js' },
      _mjs_resSet() {},
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => true },
      viewTransition: true,
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    µ._mjs_navApplyJson({ module: 'mjs-x', props: {}, url: '/x', title: null }, undefined, { push: false, via: 'link' })

    // ROUGE avant ce correctif : émis ICI, tout de suite, detail.zone === undefined.
    assert.equal(events.length, 0, "mjs:load ne doit PAS être émis avant l'installation réelle (swap différé)")
    assert.equal(navigateCalls.length, 0, 'µ.Router.navigate ne doit pas être appelé avant le swap réel')

    await wait(20) // laisse tourner le setTimeout(swap, 0) posé par le mock de startViewTransition

    assert.equal(events.length, 1, 'mjs:load doit désormais avoir été émis, une seule fois')
    assert.equal(navigateCalls.length, 1)
    assert.equal(events[0].detail.zone !== undefined, true, 'detail.zone doit être défini (plus le undefined du défaut)')
    assert.equal(events[0].detail.zone === doc.body, true, 'le contenant EFFECTIF est bien celui installé')
    assert.equal(doc.body.children.length, 1, "l'élément mjs-x doit avoir été réellement installé")
    assert.equal(doc.body.children[0].tag, 'mjs-x')
  })

  it('ordre interne du swap : install → onSwapped → callback → navigate → load', function () {
    const order: string[] = []
    const doc: any = { body: {}, createElement: () => ({}) }
    const win: any = { history: { pushState() {} } }
    const µ: any = {
      warn() {}, error() {}, log() {},
      paths: { y: 'yyy.js' },
      _mjs_resSet() {},
      Router: { navigate: () => order.push('navigate') },
    }
    installHelpers(µ, doc, win)
    // Overrides d'observation POSÉS APRÈS installHelpers (µ._mjs_navApplyJson les appelle par accès de
    // propriété µ.xxx(...), jamais par référence capturée — l'override est donc bien vu à l'exécution).
    µ._mjs_navInstallInZone = function () { order.push('install'); return {} }
    µ._mjs_navRunCallback = function () { order.push('callback') }
    µ._mjs_navEmit = function (name: string) { if (name === 'load') { order.push('load') } return true }

    µ._mjs_navApplyJson(
      { module: 'mjs-y', props: {}, url: '/y', title: null },
      undefined,
      { push: false, via: 'link', onSwapped: () => order.push('onSwapped') }
    )

    assert.deepEqual(order, ['install', 'onSwapped', 'callback', 'navigate', 'load'])
  })

  it('SANS transition de vue (gate OFF) : navigate puis load restent SYNCHRONES, zone définie (non-régression)', function () {
    const doc = makeEventDoc(makeNode('body'))
    let vtStarted = false
    doc.startViewTransition = () => { vtStarted = true; return {} }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const navigateCalls: any[] = []
    const win: any = { history: { pushState() {} } }
    const µ: any = {
      warn() {}, error() {}, log() {},
      paths: { z: 'zzz.js' },
      _mjs_resSet() {},
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_vtEnabled: () => false },
      viewTransition: true,
    }
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    µ._mjs_navApplyJson({ module: 'mjs-z', props: {}, url: '/z', title: null }, undefined, { push: false, via: 'link' })

    assert.equal(vtStarted, false, 'gate OFF : document.startViewTransition ne doit pas être appelé')
    assert.equal(navigateCalls.length, 1, 'navigate doit être synchrone : déjà appelé au retour de µ._mjs_navApplyJson')
    assert.equal(events.length, 1, 'load doit être synchrone : déjà émis au retour de µ._mjs_navApplyJson')
    assert.equal(events[0].detail.zone === doc.body, true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// clic cache-hit et popstate cache-hit.
// ────────────────────────────────────────────────────────────────────────────
describe('clic cache-hit et popstate cache-hit : queue post-swap déplacée DANS le swap', function () {
  it("clic cache-hit, transition DIFFÉRÉE : navigate et mjs:load APRÈS le swap réel, detail.zone === le contenant du cache", async function () {
    const cachedNode = { tag: 'cached' }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    doc.startViewTransition = (cb: any) => { setTimeout(cb, 0); return {} }
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
    installHelpers(µ, doc, win)
    installVt(µ, doc)
    const link = makeLink({}, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData)

    assert.equal(events.length, 0, 'mjs:load ne doit pas partir avant le swap réel')
    assert.equal(navigateCalls.length, 0, 'navigate ne doit pas partir avant le swap réel')
    assert.equal(currentRoot.by === cachedNode, false, 'le swap ne doit pas avoir eu lieu par anticipation')

    await wait(20)

    assert.equal(currentRoot.by === cachedNode, true, 'le swap cache-hit doit avoir eu lieu')
    assert.equal(navigateCalls.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].detail.zone === currentRoot, true, 'detail.zone doit être le contenant du cache (_cacheZone)')
  })

  it("popstate cache-hit, transition DIFFÉRÉE : navigate et mjs:load APRÈS le swap réel, detail.zone === le contenant du cache", async function () {
    const cachedNode = { tag: 'cached-pop' }
    const currentRoot = makeContainer()
    const doc: any = makeEventDoc(currentRoot)
    doc.startViewTransition = (cb: any) => { setTimeout(cb, 0); return {} }
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
    installHelpers(µ, doc, win)
    installVt(µ, doc)

    const handler = makePopstateHandler()
    handler({}, µ, win, doc)

    assert.equal(events.length, 0, 'mjs:load ne doit pas partir avant le swap réel')
    assert.equal(navigateCalls.length, 0, 'navigate ne doit pas partir avant le swap réel')

    await wait(20)

    assert.equal(navigateCalls.length, 1)
    assert.equal(events.length, 1)
    assert.equal(events[0].detail.zone === currentRoot, true)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// soumission HTML via µ._mjs_navDispatch/done/_swapSubmit.
// ────────────────────────────────────────────────────────────────────────────
describe('soumission HTML (µ._mjs_navDispatch/done/_swapSubmit) : _restoreNav/purge/PRG/load APRÈS le swap réel', function () {
  it('transition DIFFÉRÉE : µ.nav.active retombe, le PRG (pushState) et mjs:load partent APRÈS le swap réel', async function () {
    const newNode = { tag: 'submitted' }
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    doc.startViewTransition = (cb: any) => { setTimeout(cb, 0); return {} }
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
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    installNavDispatch(µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } })
    installVt(µ, doc)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function', 'µ.ajax.post doit avoir été appelé avec un callback success')
    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts/42') // finalUrl DIFFÉRENT → PRG attendu

    // ROUGE avant ce correctif : _restoreNav/PRG/load partaient ICI, tout de suite (avant le swap réel).
    assert.equal(µ.nav.active, true, "µ.nav.active doit RESTER true tant que le swap réel n'a pas eu lieu")
    assert.equal(pushStateCalls.length, 0, 'le PRG (pushState) ne doit pas partir avant le swap réel')
    assert.equal(events.length, 0, 'mjs:load ne doit pas partir avant le swap réel')

    await wait(20)

    assert.equal(liveRoot.by === newNode, true, 'le contenu doit avoir été installé')
    assert.equal(µ.nav.active, false, 'µ.nav.active doit être retombé APRÈS le swap réel')
    assert.equal(pushStateCalls.length, 1, 'le PRG doit être parti UNE fois, APRÈS le swap')
    assert.deepEqual(pushStateCalls[0], [{}, '', 'http://x/posts/42'])
    assert.equal(events.length, 1, 'mjs:load doit être parti UNE fois, APRÈS le swap')
  })

  it('SANS transition de vue : ordre inchangé, tout synchrone (non-régression)', function () {
    const newNode = { tag: 'submitted-sync' }
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const pushStateCalls: any[] = []
    const µ: any = {
      warn() {}, error() {}, log() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      Router: { navigate() {} }, // pas de _mjs_vtEnabled → µ._mjs_vtWrapSwap reste absent (chemin historique)
      nav: { active: false, href: null },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    installNavDispatch(µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } })

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts/42')

    assert.equal(liveRoot.by === newNode, true)
    assert.equal(µ.nav.active, false, "sans transition, tout doit avoir tourné SYNCHRONE au retour du success")
    assert.equal(pushStateCalls.length, 1)
    assert.deepEqual(pushStateCalls[0], [{}, '', 'http://x/posts/42'])
    assert.equal(events.length, 1)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Non-régression : branche `done` SANS swap (queue partagée, jamais déplacée).
// ────────────────────────────────────────────────────────────────────────────
describe('non-régression : done sans body exploitable (branche SANS swap, queue partagée inchangée)', function () {
  it('réponse non reconnue comme une page HTML : la queue partagée tourne une seule fois, aucun mjs:load, µ.nav.active retombe', function () {
    const liveRoot = makeContainer()
    const doc: any = makeEventDoc(liveRoot)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const µ: any = {
      warn() {}, error() {}, log() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      Router: { navigate() {} },
      nav: { active: false, href: null },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState() { throw new Error('ne doit pas être appelé : pas de redirection sur ce chemin') } },
    }
    installNavDispatch(µ, win, doc)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('ceci n\'est pas une page HTML', 'http://x/posts')

    assert.equal(events.length, 0, 'aucun swap : aucun mjs:load')
    assert.equal(µ.nav.active, false, 'µ.nav.active doit être retombé (queue partagée toujours exécutée, une fois)')
  })
})
