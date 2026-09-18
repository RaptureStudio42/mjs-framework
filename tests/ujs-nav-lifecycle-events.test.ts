// 3 événements de cycle de navigation : `mjs:before-visit` (annulable), `mjs:visit`,
// `mjs:load` (émis une fois par navigation réussie, TOUS chemins d'installation, + le premier
// chargement). Modèle : `mjs:before-cache` (tests/ujs-nav-cache-policy.test.ts) — même helper
// mutualisé µ._mjs_navEmit désormais, cf. mjs_ujs.ts.
//
// Couvre :
//   1. before-visit émis au clic cross-page (path/url/via).
//   2. preventDefault() dessus → aucun pushState/fetch/hibernation.
//   3. before-visit NON émis au popstate.
//   4. before-visit via µ._mjs_navDispatch (via==='form' par défaut) ; annulé → restoreBusy() + aucun fetch.
//   5. visit au clic : cached true/false.
//   6. visit au popstate (via==='popstate').
//   7. Ordre before-visit → visit → before-cache → load (clic cross-page, cache-hit).
//   8. load après cache-hit clic : detail.zone = le contenant réel, initial===false.
//   9. load après swap HTML réseau (clic).
//   10. load sur le chemin JSON (µ._mjs_navApplyJson, cas nominal + 404 module:null), via transmis.
//   11. load NON émis : 422, échec réseau, version différente.
//   12. load initial (premier chargement) : microtask / DOMContentLoaded, exactement une fois.
//   13. Un écouteur qui jette n'empêche jamais la navigation, pour les 3 événements.
//   14. µ._mjs_navRevalidate n'émet aucun des 3.
//
// Défauts et trous de couverture corrigés au fil des relectures :
//   - correctif chemins sans origine : detail.path/url ne portent JAMAIS l'origine (µ._mjs_navEmitPaths).
//   - correctif zone plus jamais menteuse : detail.zone n'est plus menteur (null/false) en
//     method:'replace'.
//   - correctif flush microtask : test 12b corrigé pour flusher les microtasks comme son jumeau 12a
//     (double émission initiale).
//   - correctif garde GET/HEAD : garde GET/HEAD du calcul de `getUrl` couverte (POST + File réel).
//   - correctif redirection serveur : detail.path périmé après une redirection SERVEUR (clic réseau
//     HTML : evPaths recalculé APRÈS _computeNavDest ; µ._mjs_navDispatch branche HTML : load déplacé en
//     fin de `done`, APRÈS le bloc PRG, drapeau `_swapped`) — popstate, LUI, garde délibérément l'URL
//     de l'historique (inchangé).
//   - correctif zone détachée : detail.zone détaché en method:'replace' (µ._mjs_navInstallNodes/
//     µ._mjs_navInstallInZone RENVOIENT désormais le contenant EFFECTIF après installation, propagé aux
//     4 sites concernés). Le test « method:'replace' » du correctif zone plus jamais menteuse a été
//     corrigé en conséquence (son assertion pointait le contenant détaché — exactement ce défaut) ;
//     `makeNode.replaceWith` simule désormais un DÉTACHEMENT RÉEL (isConnected/parentNode), pas un
//     stub muet.
//   - correctif host vs origin : normaliseur µ._mjs_navEmitPaths — compare `host` (hôte+port), plus
//     `origin` (qui inclut le schéma) — http→https même hôte reste rabotable.
//   - trou zone 404 / trou nav retombé / trou zone popstate : 3 trous de couverture comblés (zone 404,
//     µ.nav retombé avant `load` en branche JSON, zone popstate cache-hit).
//   - défaut zone détachée du panneau 404 : µ._mjs_navApplyJson, branche 404 (module:null) — même défaut
//     que le correctif zone détachée mais sur le panneau 404 lui-même : µ._mjs_navShowNotFound RENVOIE
//     désormais le contenant EFFECTIF (celui que rend µ._mjs_navInstallInZone), utilisé pour detail.zone
//     au lieu du contenant capturé AVANT l'installation (détaché en method:'replace').
//   - trou garde _swapped : le drapeau `_swapped` de µ._mjs_navDispatch n'était protégé par aucun test :
//     3 `it()` neufs ferment les 3 chemins de `done` qui n'installent RIEN (texte brut non-HTML, HTML
//     sans zone exploitable, navigation périmée) — aucun `mjs:load` sur aucun des trois.
//   - trou method append : method:'append' n'était testé nulle part : `it()` neuf, detail.zone =
//     le contenant lui-même (identité), connecté, contenu précédent toujours là.
//   Nouveaux tests regroupés en fin de fichier, sous des describe() dédiés à chaque correctif/trou.
//
// Méthode : extraction RÉELLE depuis la source (readFileSync + new Function), jamais de stub du code
// testé — même convention que tests/ujs-nav-cache-policy.test.ts et les 30 autres fichiers ujs-*.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ────────────────────────────────────────────────────────────────────────────
// EXTRACTION — marqueurs explicites dans la source (tests/helpers/extract-marked.ts), remplace
// l'ancien comptage d'accolades (mêmes cibles que les fichiers voisins ujs-nav-cache-policy/json).
// ────────────────────────────────────────────────────────────────────────────
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}
function extractAjaxGetStatement(src: string): string {
  return extractMarked(src, '_mjs_ajaxGet')
}
function extractRevalidateStatement(src: string): string {
  return extractMarked(src, '_mjs_navRevalidate')
}
// premier chargement — dernier bloc du fichier (µ._mjs_navEmitInitial + son enregistrement),
// marqueur unique jusqu'à la fin réelle du fichier (cf. tests/helpers/extract-marked.ts).
function extractInitialLoadBlock(src: string): string {
  return extractMarked(src, '_mjs_navEmitInitial')
}
// correctif redirection serveur (test 1) — µ._mjs_finalPathFor N'EST PAS dans le bloc helpers (défini AVANT
// µ._mjs_navMountZone, cf. mjs_ujs.ts) : extrait à part, RÉEL (pas neutralisé comme le fait le test 9
// existant) pour prouver la redirection serveur RÉELLE sur le clic réseau HTML.
function extractFinalPathForStatement(src: string): string {
  return extractMarked(src, '_mjs_finalPathFor')
}

// ────────────────────────────────────────────────────────────────────────────
// FIXTURES — mêmes formes que tests/ujs-nav-cache-policy.test.ts / ujs-nav-json.test.ts.
// ────────────────────────────────────────────────────────────────────────────
function makeNode(tag: string, id = ''): any {
  const node: any = {
    tag, id, nodeType: 1, isConnected: true, children: [] as any[], parentNode: null as any, innerHTML: '',
    get firstChild() { return node.children.length ? node.children[0] : null },
    get childNodes() { return node.children.slice() },
    removeChild(n: any) { node.children = node.children.filter((c: any) => c !== n); n.parentNode = null; return n },
    appendChild(n: any) { node.children.push(n); n.parentNode = node; return n },
    replaceChildren(...nodes: any[]) {
      node.children.forEach((c: any) => { c.parentNode = null })
      node.children = nodes.slice()
      node.children.forEach((c: any) => { c.parentNode = node })
    },
    // correctif zone détachée — simulation FIDÈLE (pas un simple stub) : `node` se DÉTACHE réellement (isConnected
    // false, parentNode null) et `nodes` prend sa place dans les enfants du parent — nécessaire pour
    // distinguer le contenant EFFECTIF (retourné par µ._mjs_navInstallNodes) de l'ancien contenant détaché.
    replaceWith(...nodes: any[]) {
      node.replacedBy = nodes
      const parent = node.parentNode
      if (parent) {
        const i = parent.children.indexOf(node)
        if (i !== -1) { parent.children.splice(i, 1, ...nodes) }
        nodes.forEach((n: any) => { if (n && typeof n === 'object') { n.parentNode = parent } })
      }
      node.parentNode = null
      node.isConnected = false
    },
    querySelector(sel: string): any {
      const wantId = sel.replace(/^#/, '')
      const walk = (n: any): any => {
        if (n.id === wantId) { return n }
        for (const c of n.children) { const found = walk(c); if (found) { return found } }
        return null
      }
      return walk(node)
    },
  }
  return node
}
function makeDoc(body: any) {
  return { body, querySelector: (sel: string) => body.querySelector(sel), createElement: (tag: string) => makeNode(tag) }
}
// document AVEC addEventListener/dispatchEvent — CustomEvent RÉEL (global Node ≥ 19, cf. µ._mjs_navEmit) :
// forEach synchrone (pas de retargeting/once) — un écouteur qui jette propage SYNCHRONE dans
// dispatchEvent, exactement ce qu'il faut pour prouver le try/catch de µ._mjs_navEmit (test 13).
function makeEventDoc(body: any) {
  const listeners: Array<{ type: string, fn: (e: any) => void }> = []
  return {
    body,
    querySelector: (sel: string) => body.querySelector(sel),
    createElement: (tag: string) => makeNode(tag),
    addEventListener(type: string, fn: (e: any) => void) { listeners.push({ type, fn }) },
    dispatchEvent(e: any) { listeners.filter((l) => l.type === e.type).forEach((l) => l.fn(e)); return !e.defaultPrevented },
  }
}
// document du premier chargement — readyState + registre de listeners PAR TYPE (le boot pose lui-même
// un DOMContentLoaded, cf. test 12b, à côté des écouteurs `mjs:load` posés par le test).
function makeLifecycleDoc(body: any, readyState: string) {
  const listeners: Record<string, Array<(e: any) => void>> = {}
  return {
    body, readyState,
    querySelector: (sel: string) => body.querySelector(sel),
    createElement: (tag: string) => makeNode(tag),
    addEventListener(type: string, fn: (e: any) => void) { (listeners[type] = listeners[type] || []).push(fn) },
    dispatchEvent(e: any) { (listeners[e.type] || []).forEach((fn) => fn(e)); return !e.defaultPrevented },
    _listeners: listeners,
  }
}
function flushMicrotasks(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}
function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}
function makeCrossLink(pathname: string, href: string, hash = '') {
  return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname, search: '', hash, href, closest: function (this: any) { return this } }
}
function makeClickEvent(link: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [link],
    target: link,
  }
}
class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}

// ────────────────────────────────────────────────────────────────────────────
// 1-2. mjs:before-visit — clic cross-page
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:before-visit, clic cross-page', function () {
  it('1. émis, detail.path/url/via==="link" corrects (hash présent dans url, absent de path)', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: () => Promise.resolve(),
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b#/section', '#/section')

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'mjs:before-visit')
    assert.equal(events[0].detail.path, '/b', 'path : pathname+search, SANS le hash')
    assert.equal(events[0].detail.url, '/b#/section', 'url : la destination complète, hash compris')
    assert.equal(events[0].detail.via, 'link')
    assert.equal(events[0].cancelable, true)
    assert.equal(events[0].bubbles, true)
  })

  it("2. preventDefault() → AUCUN pushState, AUCUN fetch, AUCUNE hibernation, _mjs_navSeq intact", function () {
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:before-visit', (e: any) => e.preventDefault())
    const pushCalls: any[] = []
    const fetchCalls: any[] = []
    const hibernateCalls: any[] = []
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState: (...a: any[]) => pushCalls.push(a) } }
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: (opts: any) => { fetchCalls.push(opts); return Promise.resolve() },
    })
    installHelpers(µ, doc, win)
    µ._mjs_navHibernate = (...a: any[]) => hibernateCalls.push(a) // espion posé APRÈS installHelpers
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.deepEqual(pushCalls, [], 'aucun pushState')
    assert.deepEqual(hibernateCalls, [], 'aucune hibernation')
    assert.deepEqual(fetchCalls, [], 'aucun fetch')
    assert.equal(µ._mjs_navSeq, 0, '_mjs_navSeq jamais bumpé')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 3. mjs:before-visit — PAS émis au popstate
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:before-visit, popstate', function () {
  it('3. NON émis (URL déjà bougée, annuler serait un mensonge — même choix que Turbo)', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const µ: any = baseMu({
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      _mjs_ajaxRequest: () => Promise.resolve(),
    })
    installHelpers(µ, doc, win)
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))

    popHandler({}, µ, win, doc, class {})

    assert.deepEqual(events, [])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 4. mjs:before-visit — µ._mjs_navDispatch (@method / submit)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:before-visit, µ._mjs_navDispatch', function () {
  it('4. via==="form" par défaut ; annulé → restoreBusy() appelé, aucun fetch, _mjs_navSeq intact', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => { events.push(e); e.preventDefault() })
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    const fetchCalls: any[] = []
    const restoreBusyCalls: number[] = []
    const µ: any = baseMu({
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { fetchCalls.push(opts); return Promise.resolve() },
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => restoreBusyCalls.push(1) })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'form')
    assert.deepEqual(fetchCalls, [], 'annulé avant µ._mjs_navRequest : aucun fetch')
    assert.equal(restoreBusyCalls.length, 1, 'restoreBusy() rappelé')
    assert.equal(µ._mjs_navSeq, 0, '_mjs_navSeq jamais bumpé')
  })

  it('via==="method" transmis par le lien @method', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/x', search: '', origin: 'http://x', host: 'x', href: 'http://x/x' } }
    const µ: any = baseMu({ realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_ajaxRequest: () => Promise.resolve() })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link: any = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/posts/1', search: '', hash: '', href: 'http://x/posts/1', getAttribute: (k: string) => (k === 'mjs-method' ? 'delete' : null), setAttribute() {}, removeAttribute() {}, closest: function (this: any) { return this } }

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'method')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 5-6. mjs:visit
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:visit', function () {
  it('5. au clic : cached===true sur cache-hit, cached===false sur cache-miss', function () {
    function run(hasCache: boolean) {
      const doc = makeEventDoc(makeNode('body'))
      const events: any[] = []
      doc.addEventListener('mjs:visit', (e: any) => events.push(e))
      const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
      const cachedNodes: any = [makeNode('page-b')]
      const µ: any = baseMu({
        realTarget: (e: any) => e.target,
        _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
        pageCache: { has: (p: string) => hasCache && p === '/b', get: () => cachedNodes, set() {} },
        _mjs_preloadCache: { has: () => false },
        _mjs_saveScroll() {}, _mjs_restoreScroll() {},
        _mjs_ajaxRequest: () => Promise.resolve(),
        Router: { navigate() {} },
      })
      installHelpers(µ, doc, win)
      new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
      const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
      const link = makeCrossLink('/b', 'http://x/b')

      clickHandler(makeClickEvent(link), µ, win, doc, class {})

      assert.equal(events.length, 1)
      return events[0].detail.cached
    }

    assert.equal(run(true), true, 'cache-hit : cached===true')
    assert.equal(run(false), false, 'cache-miss : cached===false')
  })

  it('6. au popstate : via==="popstate", cached corrects', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:visit', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const µ: any = baseMu({
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      _mjs_ajaxRequest: () => Promise.resolve(),
    })
    installHelpers(µ, doc, win)
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))

    popHandler({}, µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'popstate')
    assert.equal(events[0].detail.cached, false)
    assert.equal(events[0].detail.path, '/b')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 7. Ordre garanti before-visit → visit → before-cache → load
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — ordre before-visit → visit → before-cache → load', function () {
  it('7. clic cross-page, cache-hit : les 4 événements sortent dans cet ordre exact', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const order: string[] = []
    ;['mjs:before-visit', 'mjs:visit', 'mjs:before-cache', 'mjs:load'].forEach((type) => {
      doc.addEventListener(type, () => order.push(type))
    })
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const cachedNodes: any = [makeNode('page-b')]
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: (p: string) => p === '/b', get: () => cachedNodes, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate() {} },
    })
    installHelpers(µ, doc, win)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.deepEqual(order, ['mjs:before-visit', 'mjs:visit', 'mjs:before-cache', 'mjs:load'])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 8-9. mjs:load — clic (cache-hit / réseau HTML)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, clic', function () {
  it('8. après cache-hit : detail.zone = le contenant réel, initial===false, via==="link"', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const cachedNodes: any = [makeNode('page-b')]
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: (p: string) => p === '/b', get: () => cachedNodes, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate() {} },
    })
    installHelpers(µ, doc, win)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.zone, body, 'le contenant réel (body, seul contenant suivi ici)')
    assert.equal(events[0].detail.initial, false)
    assert.equal(events[0].detail.via, 'link')
    assert.equal(events[0].detail.path, '/b')
  })

  it('9. après swap HTML réseau : émis une fois, via==="link", initial===false', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const freshNode: any = { tag: 'fresh' }
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} }, scrollTo() {} }
    let capturedSuccess: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      Router: { navigate() {} },
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')
    class DP { parseFromString() { return { body: { childNodes: [freshNode] } } } }

    clickHandler(makeClickEvent(link), µ, win, doc, DP)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss → fetch réseau attendu')
    capturedSuccess('<html><body>contenu B</body></html>', 'http://x/b', undefined, { version: null, target: null, method: null, cache: null })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'link')
    assert.equal(events[0].detail.initial, false)
    assert.equal(events[0].detail.path, '/b')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 10. mjs:load — chemin JSON (µ._mjs_navApplyJson)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, µ._mjs_navApplyJson', function () {
  it('10a. cas nominal : émis après installation + Router.navigate, via transmis', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const navigateCalls: any[] = []
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, '/produits/42', { push: true, via: 'popstate' })

    assert.equal(navigateCalls.length, 1, "émis APRÈS la resynchronisation du routeur")
    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'popstate')
    assert.equal(events[0].detail.path, '/produits/42')
    assert.equal(events[0].detail.url, '/produits/42')
    assert.equal(events[0].detail.initial, false)
  })

  it("10b. défaut via==='link' quand opts.via absent", function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, '/produits/42', { push: true })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'link')
  })

  it('10c. 404 (module:null) : un panneau installé est une navigation réussie', function () {
    // createElement minimal (attrs/textContent réglables, mêmes besoins que µ._mjs_navShowNotFound :
    // setAttribute/className/textContent/appendChild — cf. tests/ujs-nav-json.test.ts, test (d)),
    // combiné à addEventListener/dispatchEvent pour capter mjs:load.
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const listeners: Array<{ type: string, fn: (e: any) => void }> = []
    const doc: any = {
      body: bodyZone,
      createElement: (_tag: string) => ({ attrs: {} as any, children: [] as any[], setAttribute(k: string, v: string) { this.attrs[k] = v }, appendChild(c: any) { this.children.push(c) } }),
      addEventListener(type: string, fn: (e: any) => void) { listeners.push({ type, fn }) },
      dispatchEvent(e: any) { listeners.filter((l) => l.type === e.type).forEach((l) => l.fn(e)); return !e.defaultPrevented },
    }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({
      config: { routeNotFound: 'error' },
      Router: { navigate() {}, _mjs_updateUrlStore() {}, _mjs_routerLabel: (k: string) => ({ notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.' } as any)[k] },
    })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: null, props: {}, url: '/inconnu', title: null, version: 'v1' }, '/inconnu', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'link')
    assert.equal(events[0].detail.path, '/inconnu')
    assert.equal(events[0].detail.initial, false)
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 11. mjs:load — PAS émis
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load — PAS émis', function () {
  it('11a. 422 (µ._mjs_navDispatch) : aucune installation, aucun load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    let capturedError: any
    const µ: any = baseMu({
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
      _mjs_resSet() {},
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedError === 'function')
    capturedError({ status: 422, body: { module: 'mjs-new-post', props: { title: '' }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })

    assert.deepEqual(events, [])
  })

  it('11b. échec réseau (clic) : repli dur, aucun load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    let capturedError: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    µ._mjs_hardNav = () => {} // repli dur réel non pertinent ici (window.location) : neutralisé
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    clickHandler(makeClickEvent(link), µ, win, doc, class {})
    assert.ok(typeof capturedError === 'function')
    capturedError()

    assert.deepEqual(events, [])
  })

  it('11c. version différente (chemin JSON) : rechargement dur, aucun load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() { throw new Error('ne doit pas pousser : rechargement complet attendu') } }, location: { assign() {} } }
    const µ: any = baseMu({
      paths: { produit: 'xxx.js' }, version: 'v1-ancien', _mjs_resSet() {},
      Router: { navigate() { throw new Error('ne doit pas naviguer : rechargement complet attendu') } },
    })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v2-nouveau' }, '/produits/42', { push: true, via: 'link' })

    assert.deepEqual(events, [])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 12. mjs:load — premier chargement
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, premier chargement', function () {
  it('12a. readyState≠"loading" : rien de synchrone, émission en microtask, exactement une fois, initial===true', async function () {
    const doc: any = makeLifecycleDoc(makeNode('body'), 'complete')
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/', search: '', href: 'http://x/', origin: 'http://x', host: 'x' } }
    const µ: any = baseMu()
    installHelpers(µ, doc, win)

    new Function('µ', 'document', 'window', extractInitialLoadBlock(UJS_SRC))(µ, doc, win)

    assert.deepEqual(events, [], "jamais synchrone à l'import")
    assert.equal(doc._listeners.DOMContentLoaded, undefined, "readyState pas 'loading' : aucun listener DOMContentLoaded posé")

    await flushMicrotasks()

    assert.equal(events.length, 1, 'exactement une fois')
    assert.equal(events[0].detail.initial, true)
    assert.equal(events[0].detail.via, 'initial')
    assert.equal(events[0].detail.path, '/')
    assert.equal(events[0].detail.url, '/', "SANS origine, comme les 12 autres sites d'émission")
    assert.equal(events[0].detail.zone, doc.body)
  })

  it("12b. readyState==='loading' : rien avant DOMContentLoaded, EXACTEMENT une émission ensuite (microtasks flushées), initial===true", async function () {
    const doc: any = makeLifecycleDoc(makeNode('body'), 'loading')
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/', search: '', href: 'http://x/', origin: 'http://x', host: 'x' } }
    const µ: any = baseMu()
    installHelpers(µ, doc, win)

    new Function('µ', 'document', 'window', extractInitialLoadBlock(UJS_SRC))(µ, doc, win)

    assert.deepEqual(events, [], 'rien avant DOMContentLoaded')
    assert.equal(doc._listeners.DOMContentLoaded.length, 1, 'un seul listener DOMContentLoaded posé')

    doc._listeners.DOMContentLoaded[0]({ type: 'DOMContentLoaded' })
    // flush comme son jumeau 12a : sans lui, une 2e émission partie en microtask
    // (exclusivité if/else de l'émission initiale cassée) passerait inaperçue — le trou de couverture visé.
    await flushMicrotasks()

    assert.equal(events.length, 1, 'exactement une émission — pas une 2e via une microtask parasite')
    assert.equal(events[0].detail.initial, true)
    assert.equal(events[0].detail.via, 'initial')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 13. Un écouteur qui jette n'empêche jamais la navigation
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — un écouteur qui jette n'empêche jamais la navigation", function () {
  it('13a. before-visit : la navigation continue (pushState a bien lieu)', function () {
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:before-visit', () => { throw new Error('boom') })
    const pushCalls: any[] = []
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState: (...a: any[]) => pushCalls.push(a) } }
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: () => Promise.resolve(),
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    assert.doesNotThrow(() => clickHandler(makeClickEvent(link), µ, win, doc, class {}))
    assert.equal(pushCalls.length, 1, "la navigation continue malgré l'écouteur qui jette")
  })

  it("13b. visit : la navigation continue (l'hibernation qui suit a bien lieu)", function () {
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:visit', () => { throw new Error('boom') })
    const setCalls: any[] = []
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set: (...a: any[]) => setCalls.push(a) },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: () => Promise.resolve(),
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    assert.doesNotThrow(() => clickHandler(makeClickEvent(link), µ, win, doc, class {}))
    assert.equal(setCalls.length, 1, "l'hibernation (juste après visit) a bien eu lieu")
  })

  it('13c. load : la navigation continue (le swap + Router.navigate ont bien tourné)', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    doc.addEventListener('mjs:load', () => { throw new Error('boom') })
    const navigateCalls: any[] = []
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', host: 'x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const cachedNodes: any = [makeNode('page-b')]
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: (p: string) => p === '/b', get: () => cachedNodes, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate: (...a: any[]) => navigateCalls.push(a) },
    })
    installHelpers(µ, doc, win)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/b', 'http://x/b')

    assert.doesNotThrow(() => clickHandler(makeClickEvent(link), µ, win, doc, class {}))
    assert.equal(navigateCalls.length, 1, "µ.Router.navigate a bien tourné malgré l'écouteur qui jette sur load")
    assert.deepEqual(body.children, [cachedNodes[0]], 'le swap cache-hit a bien eu lieu')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// 14. µ._mjs_navRevalidate n'émet aucun des 3
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — µ._mjs_navRevalidate n'émet aucun des 3 événements de cycle", function () {
  const WIN_REVAL: any = { location: { href: 'http://x/' } }
  function installRevalidate(µ: any, window: any, document: any, DOMParserCtor: any) {
    new Function('µ', 'window', 'document', 'DOMParser', extractRevalidateStatement(UJS_SRC))(µ, window, document, DOMParserCtor)
  }

  it('rafraîchissement de fond (contenu différent, swap réel) : silence total sur before-visit/visit/load', function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('original'))
    zone.innerHTML = '<p>ancien</p>'
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    ;['mjs:before-visit', 'mjs:visit', 'mjs:load'].forEach((t) => doc.addEventListener(t, (e: any) => events.push(e)))
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, doc, {})
    const respBody = makeNode('body')
    respBody.innerHTML = '<p>nouveau</p>'
    respBody.appendChild(makeNode('fresh'))
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, WIN_REVAL, doc, DP)

    µ._mjs_navRevalidate(zone, '/a')
    assert.ok(typeof success === 'function', 'la requête de fond doit être partie')
    success('<html>ignoré</html>', '/a', undefined, { version: null, target: null, method: null, cache: null })

    assert.deepEqual(events, [], "aucun des 3 événements de cycle sur ce chemin (avant/pendant/après le swap silencieux)")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// detail.path/url ne portent JAMAIS l'origine (µ._mjs_navEmitPaths)
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — detail.path/url SANS l'origine", function () {
  it("µ._mjs_navApplyJson : finalUrl ABSOLUE réaliste → detail.path/url sans l'origine", function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://mon-site.example/', origin: 'http://mon-site.example', host: 'mon-site.example' }, history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, 'http://mon-site.example/produits/42', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.path, '/produits/42', 'AVANT le fix : path === finalUrl brut, origine comprise')
    assert.equal(events[0].detail.url, '/produits/42')
  })

  it("µ._mjs_navDispatch, lien @method (href ABSOLU) : detail.path/url sans l'origine", function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/x', search: '', origin: 'http://mon-site.example', host: 'mon-site.example', href: 'http://mon-site.example/x' } }
    const µ: any = baseMu({ realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_ajaxRequest: () => Promise.resolve() })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link: any = { hasAttribute: () => false, origin: 'http://mon-site.example', target: '', protocol: 'http:', pathname: '/produits/42', search: '', hash: '', href: 'http://mon-site.example/produits/42', getAttribute: (k: string) => (k === 'mjs-method' ? 'delete' : null), setAttribute() {}, removeAttribute() {}, closest: function (this: any) { return this } }

    clickHandler(makeClickEvent(link), µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.path, '/produits/42', 'AVANT le fix : link.href est TOUJOURS absolu (origine du site)')
    assert.equal(events[0].detail.url, '/produits/42')
  })

  it("µ._mjs_navDispatch, formulaire SANS action (repli window.location.href, absolu) : detail.path/url sans l'origine", function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:visit', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://mon-site.example/produits/42', origin: 'http://mon-site.example', host: 'mon-site.example' }, history: { pushState() {} } }
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: () => Promise.resolve() })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    // µ._mjs_ujsOnSubmit calcule `url = form.getAttribute('action') || window.location.href` — un
    // formulaire SANS action reçoit donc TOUJOURS une URL absolue (le repli).
    µ._mjs_navDispatch(win.location.href, 'POST', new FakeFormData(), {})

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.path, '/produits/42')
    assert.equal(events[0].detail.url, '/produits/42')
  })

  it("origine DIFFÉRENTE : la chaîne est gardée TELLE QUELLE, jamais rabotée (µ._mjs_navApplyJson)", function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://x/', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, 'https://autre.example/x', { push: false, via: 'popstate' })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.path, 'https://autre.example/x', 'origine DIFFÉRENTE : jamais rabotée, chaîne brute gardée')
    assert.equal(events[0].detail.url, 'https://autre.example/x')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// detail.zone n'est plus menteur (null/false) en method:'replace'
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — detail.zone NON NUL en method:'replace' (corrigé plus loin, cf. describe dédié plus bas)", function () {
  it("µ._mjs_navApplyJson, method:'replace' : detail.zone = le contenant EFFECTIF ayant reçu le module (pas µ._mjs_navCacheZone(), menteur ici ; pas le sélecteur visé non plus, qui a cédé sa place et s'est détaché)", function () {
    const body = makeNode('body')
    const slot = makeNode('slot-page', 'slot')
    body.appendChild(slot)
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1', target: '#slot', method: 'replace' }, '/produits/42', { push: true, via: 'link' })

    assert.equal(µ._mjs_navCacheZone(), null, "µ._mjs_navCacheZone() (bookkeeping du cache) est bien null ici — précisément CE que detail.zone ne doit plus utiliser")
    assert.equal(events.length, 1)
    assert.equal(events[0].detail.zone, body, "detail.zone NON NUL, égal au contenant EFFECTIF (le parent, qui a accueilli le module) — PAS `slot` (le contenant visé par le sélecteur, désormais détaché)")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// trou de couverture, garde GET/HEAD du calcul de getUrl
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navDispatch : garde GET/HEAD du calcul de getUrl', function () {
  it('POST avec un vrai File dans le FormData : detail.url de before-visit/visit SANS query string, payload non sérialisé', function () {
    const doc = makeEventDoc(makeNode('body'))
    const beforeVisitEvents: any[] = []
    const visitEvents: any[] = []
    doc.addEventListener('mjs:before-visit', (e: any) => beforeVisitEvents.push(e))
    doc.addEventListener('mjs:visit', (e: any) => visitEvents.push(e))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    let capturedPayload: any
    const µ: any = baseMu({
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedPayload = opts.data; return Promise.resolve() },
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', 'File', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FormData, URL, class {}, File)
    const payload = new FormData()
    payload.append('titre', 'bonjour')
    payload.append('avatar', new File(['contenu'], 'photo.png', { type: 'image/png' }))

    µ._mjs_navDispatch('http://x/posts', 'POST', payload, {})

    assert.equal(beforeVisitEvents.length, 1)
    assert.equal(beforeVisitEvents[0].detail.url.indexOf('?'), -1, 'AVANT le fix : la garde neutralisée sérialise le FormData (File compris) en query string')
    assert.equal(visitEvents.length, 1)
    assert.equal(visitEvents[0].detail.url.indexOf('?'), -1)
    assert.ok(capturedPayload === payload, 'le payload transmis au réseau reste le FormData original, jamais sérialisé')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// detail.path périmé après une redirection SERVEUR RÉELLE
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, clic réseau HTML : detail.path après une redirection SERVEUR RÉELLE', function () {
  it('1. µ._mjs_finalPathFor RÉEL (pas neutralisé, contrairement au test 9) : /panier/ajouter redirigé /panier → detail.path = destination FINALE', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const freshNode: any = { tag: 'panier' }
    const win: any = { location: { pathname: '/produits/1', search: '', origin: 'http://x', host: 'x', href: 'http://x/produits/1', hash: '' }, history: { pushState() {}, replaceState() {} }, scrollTo() {} }
    let capturedSuccess: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/produits/1',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      Router: { navigate() {} },
    })
    installHelpers(µ, doc, win)
    // µ._mjs_finalPathFor RÉEL : n'annule PAS la détection de redirection (contrairement au test 9,
    // qui neutralise cette fonction — c'est précisément l'angle mort visé par ce test-ci).
    new Function('µ', 'window', extractFinalPathForStatement(UJS_SRC))(µ, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = makeCrossLink('/panier/ajouter', 'http://x/panier/ajouter')
    class DP { parseFromString() { return { body: { childNodes: [freshNode] } } } }

    clickHandler(makeClickEvent(link), µ, win, doc, DP)
    assert.ok(typeof capturedSuccess === 'function', 'cache-miss → fetch réseau attendu')
    // redirection SERVEUR RÉELLE : le serveur répond depuis /panier (finalUrl), pas /panier/ajouter (cliqué)
    capturedSuccess('<html><body>panier</body></html>', 'http://x/panier', undefined, { version: null, target: null, method: null, cache: null })

    assert.equal(events.length, 1)
    assert.equal(events[0].detail.path, '/panier', "AVANT le fix : detail.path === '/panier/ajouter' (URL CLIQUÉE, jamais rafraîchie après la redirection)")
  })
})

describe('mjs_ujs — mjs:load, µ._mjs_navDispatch : PRG (POST → redirection → réponse HTML)', function () {
  it("2. detail.path = destination FINALE (pas l'URL soumise, calculée AVANT le PRG)", function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const freshNode: any = { tag: 'confirmation' }
    const pushCalls: any[] = []
    const win: any = { location: { href: 'http://x/commandes', origin: 'http://x', host: 'x' }, history: { pushState: (...a: any[]) => pushCalls.push(a) } }
    let capturedSuccess: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: { clear() {} },
      _mjs_preloadCache: { clear() {} },
      _mjs_preloaded: { clear() {} },
    })
    installHelpers(µ, doc, win)
    class DP { parseFromString() { return { body: { childNodes: [freshNode] } } } }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DP)

    µ._mjs_navDispatch('http://x/commandes', 'POST', new FakeFormData(), {})

    assert.ok(typeof capturedSuccess === 'function', 'le fetch de mutation doit être parti')
    // PRG réel : POST /commandes redirigé par le serveur vers /commandes/42, réponse HTML
    capturedSuccess('<html><body>commande confirmée</body></html>', 'http://x/commandes/42', undefined, { version: null, target: null, method: null, cache: null })

    assert.equal(pushCalls.length, 1, 'le pushState du PRG a bien eu lieu')
    assert.equal(events.length, 1)
    assert.equal(events[0].detail.via, 'form')
    assert.equal(events[0].detail.path, '/commandes/42', "AVANT le fix : detail.path === '/commandes' (URL soumise, calculée avant le PRG)")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// detail.zone DÉTACHÉ en method:'replace'
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — mjs:load, method:'replace' : detail.zone ATTACHÉ, pas un nœud DÉTACHÉ", function () {
  it('3. detail.zone.isConnected===true ET contient réellement le module installé (pas seulement une égalité de référence)', function () {
    const body = makeNode('body')
    const slot = makeNode('slot-page', 'slot')
    body.appendChild(slot)
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1', target: '#slot', method: 'replace' }, '/produits/42', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    const zone = events[0].detail.zone
    assert.equal(zone, body, 'le contenant EFFECTIF : le parent, qui a accueilli le module')
    assert.equal(zone.isConnected, true, 'detail.zone doit être un nœud ATTACHÉ')
    assert.equal(slot.isConnected, false, 'AVANT le fix : detail.zone === slot, un nœud DÉTACHÉ (isConnected===false) — le sélecteur visé a cédé sa place')
    assert.ok(zone.children.some((c: any) => c.tag === 'mjs-produit'), 'detail.zone contient RÉELLEMENT le module installé (pas seulement une égalité de référence)')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// normaliseur µ._mjs_navEmitPaths, host vs origin
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load : normaliseur µ._mjs_navEmitPaths, host vs origin', function () {
  it('4. http → https MÊME hôte : detail.path raboté ; hôte VRAIMENT différent : jamais raboté', function () {
    // page en http, hôte 'mon-site.example' — le SERVEUR répond en https (upgrade HSTS/force_ssl, dev→prod)
    const doc1 = makeEventDoc(makeNode('body'))
    const events1: any[] = []
    doc1.addEventListener('mjs:load', (e: any) => events1.push(e))
    const win1: any = { location: { href: 'http://mon-site.example/', origin: 'http://mon-site.example', host: 'mon-site.example' }, history: { pushState() {} } }
    const µ1: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ1, doc1, win1)

    µ1._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/x', title: null, version: 'v1' }, 'https://mon-site.example/x', { push: false, via: 'popstate' })

    assert.equal(events1.length, 1)
    assert.equal(events1[0].detail.path, '/x', 'AVANT le fix : traité comme une origine différente (comparaison sur .origin, qui inclut le schéma) → chaîne brute gardée')
    assert.equal(events1[0].detail.url, '/x')

    // hôte VRAIMENT différent : reste PAS raboté
    const doc2 = makeEventDoc(makeNode('body'))
    const events2: any[] = []
    doc2.addEventListener('mjs:load', (e: any) => events2.push(e))
    const win2: any = { location: { href: 'http://mon-site.example/', origin: 'http://mon-site.example', host: 'mon-site.example' }, history: { pushState() {} } }
    const µ2: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ2, doc2, win2)

    µ2._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, 'https://autre.example/x', { push: false, via: 'popstate' })

    assert.equal(events2.length, 1)
    assert.equal(events2[0].detail.path, 'https://autre.example/x', 'hôte VRAIMENT différent : jamais rabotée, chaîne brute gardée')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// trous de couverture (3 sabotages restés VERTS sur 285 tests)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, µ._mjs_navApplyJson 404 (module:null) : detail.zone correct', function () {
  it('5. detail.zone = le contenant réel du panneau 404, PAS µ._mjs_navCacheZone()', function () {
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const listeners: Array<{ type: string, fn: (e: any) => void }> = []
    const doc: any = {
      body: bodyZone,
      createElement: (_tag: string) => ({ attrs: {} as any, children: [] as any[], setAttribute(k: string, v: string) { this.attrs[k] = v }, appendChild(c: any) { this.children.push(c) } }),
      addEventListener(type: string, fn: (e: any) => void) { listeners.push({ type, fn }) },
      dispatchEvent(e: any) { listeners.filter((l) => l.type === e.type).forEach((l) => l.fn(e)); return !e.defaultPrevented },
    }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({
      config: { routeNotFound: 'error' },
      Router: { navigate() {}, _mjs_updateUrlStore() {}, _mjs_routerLabel: (k: string) => ({ notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.' } as any)[k] },
    })
    installHelpers(µ, doc, win)
    // espion posé APRÈS installHelpers (même patron que le test 2, ligne ~230) : une sentinelle
    // reconnaissable si le sabotage (zone remis à µ._mjs_navCacheZone()) revient — le code CORRECT
    // n'appelle JAMAIS µ._mjs_navCacheZone() sur ce chemin (il utilise µ._mjs_navMountZone directement).
    const WRONG_SENTINEL = { wrong: 'µ._mjs_navCacheZone() ne doit plus alimenter detail.zone ici' }
    µ._mjs_navCacheZone = () => WRONG_SENTINEL

    µ._mjs_navApplyJson({ module: null, props: {}, url: '/inconnu', title: null, version: 'v1' }, '/inconnu', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    assert.notEqual(events[0].detail.zone, WRONG_SENTINEL, 'AVANT le fix : detail.zone === µ._mjs_navCacheZone()')
    assert.equal(events[0].detail.zone, bodyZone, 'detail.zone = le contenant réel du panneau 404')
  })
})

describe("mjs_ujs — mjs:load, µ._mjs_navDispatch branche JSON : µ.nav retombé AVANT l'émission", function () {
  it("6. µ.nav.active===false ET la barre de progression arrêtée (timer purgé) PENDANT l'écouteur mjs:load", function () {
    const doc = makeEventDoc(makeNode('body'))
    let navActiveDuringLoad: any = 'jamais observé'
    let progressTimerDuringLoad: any = 'jamais observé'
    doc.addEventListener('mjs:load', () => {
      navActiveDuringLoad = µ.nav.active
      progressTimerDuringLoad = µ._mjs_navProgressTimer
    })
    const win: any = { location: { href: 'http://x/produits', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    let capturedSuccess: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      _mjs_resSet() {},
      paths: { produit: 'xxx.js' }, version: 'v1',
      Router: { navigate() {} },
      nav: { active: false, href: null },
      config: { navProgress: true },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/produits', 'POST', new FakeFormData(), {})

    assert.ok(typeof capturedSuccess === 'function')
    assert.equal(µ.nav.active, true, 'précondition : la requête est bien EN VOL')
    assert.ok(µ._mjs_navProgressTimer, 'précondition : la barre de progression est bien ARMÉE')

    capturedSuccess({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, 'http://x/produits/42', undefined, undefined)

    assert.equal(navActiveDuringLoad, false, "AVANT le fix : µ.nav.active===true PENDANT l'écouteur mjs:load (branche JSON de µ._mjs_navDispatch)")
    assert.equal(progressTimerDuringLoad, null, "la barre de progression est bien arrêtée avant l'émission")
  })
})

describe('mjs_ujs — mjs:load, popstate cache-hit : detail.zone correct', function () {
  it('7. detail.zone = _cacheZone (capturé au 1er appel), pas un second appel à µ._mjs_navCacheZone()', function () {
    const body = makeNode('body')
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const cachedNodes: any = [makeNode('page-b')]
    const µ: any = baseMu({
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0,
      pageCache: { has: (p: string) => p === '/b', get: () => cachedNodes, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate() {} },
    })
    installHelpers(µ, doc, win)
    // espion posé APRÈS installHelpers : le 1er appel (capture EARLY de `_cacheZone`, nécessaire au
    // swap lui-même) reste RÉEL ; tout appel SUPPLÉMENTAIRE (le sabotage : `zone: µ._mjs_navCacheZone()`
    // rappelé au moment de l'émission) renvoie une sentinelle reconnaissable — le code CORRECT
    // réutilise la variable locale `_cacheZone`, il ne rappelle JAMAIS µ._mjs_navCacheZone() une 2e fois.
    const realNavCacheZone = µ._mjs_navCacheZone
    const WRONG_SENTINEL = { wrong: 'µ._mjs_navCacheZone() ne doit plus alimenter detail.zone ici' }
    let cacheZoneCalls = 0
    µ._mjs_navCacheZone = function () {
      cacheZoneCalls++
      return cacheZoneCalls === 1 ? realNavCacheZone() : WRONG_SENTINEL
    }
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))

    popHandler({}, µ, win, doc, class {})

    assert.equal(events.length, 1)
    assert.notEqual(events[0].detail.zone, WRONG_SENTINEL, 'AVANT le fix : detail.zone rappelait µ._mjs_navCacheZone() au lieu de réutiliser _cacheZone')
    assert.equal(events[0].detail.zone, body, 'detail.zone = le contenant réellement rempli (body, ici seul contenant suivi)')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// panneau 404 + method:'replace', detail.zone détaché
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — mjs:load, µ._mjs_navApplyJson 404 (module:null) + method:'replace' : detail.zone ATTACHÉ", function () {
  it('1. panneau installé dans le contenant EFFECTIF (celui qui a accueilli le panneau, pas le sélecteur visé, détaché par le replace) : isConnected===true, contient réellement le panneau', function () {
    const body = makeNode('body')
    const slot = makeNode('slot-page', 'slot')
    body.appendChild(slot)
    const doc: any = makeEventDoc(body)
    // createElement enrichi (setAttribute) : µ._mjs_navShowNotFound construit son panneau avec
    // setAttribute/className/textContent/appendChild — makeNode seul (querySelector/replaceWith/
    // children) ne les porte pas, nécessaires ici en plus (méthode 'replace' fait vraiment jouer
    // µ._mjs_navInstallNodes, pas un doc minimal comme le test voisin).
    doc.createElement = (tag: string) => { const n = makeNode(tag); n.attrs = {}; n.setAttribute = (k: string, v: string) => { n.attrs[k] = v }; return n }
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({
      config: { routeNotFound: 'error' },
      Router: { navigate() {}, _mjs_updateUrlStore() {}, _mjs_routerLabel: (k: string) => ({ notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.' } as any)[k] },
    })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: null, props: {}, url: '/inconnu', title: null, version: 'v1', target: '#slot', method: 'replace' }, '/inconnu', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    const zone = events[0].detail.zone
    assert.equal(zone, body, 'le contenant EFFECTIF : le parent qui a accueilli le panneau 404')
    assert.equal(zone.isConnected, true, 'detail.zone doit être un nœud ATTACHÉ')
    assert.equal(slot.isConnected, false, "AVANT le fix : detail.zone === slot (résolu par µ._mjs_navMountZone AVANT l'installation, cf. l'ancien µ._mjs_navApplyJson), un nœud DÉTACHÉ — le sélecteur visé a cédé sa place")
    assert.ok(zone.children.some((c: any) => c.attrs && c.attrs['data-mjs-route-error'] === ''), 'detail.zone contient RÉELLEMENT le panneau installé (pas seulement une égalité de référence)')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// le drapeau `_swapped` de µ._mjs_navDispatch, sans AUCUN test
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — mjs:load, µ._mjs_navDispatch : `_swapped` protégé — AUCUNE installation ⇒ AUCUN load', function () {
  it('2a. réponse texte brut non-HTML (le µ.warn « non reconnue comme une page HTML complète ») → AUCUN mjs:load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = baseMu({
      warn: (...a: any[]) => warnCalls.push(a),
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function', 'le fetch de mutation doit être parti')
    capturedSuccess('texte brut, pas de HTML', 'http://x/posts', undefined, undefined)

    assert.equal(warnCalls.length, 1, 'précondition : la branche « réponse non reconnue » a bien tourné')
    assert.match(warnCalls[0][0], /non reconnue comme une page HTML complète/)
    assert.deepEqual(events, [], "AVANT le sabotage « _swapped forcé à true » : AUCUNE installation sur ce chemin, `_swapped` doit rester false — sinon mjs:load fantôme avec detail.zone===undefined")
  })

  it('2b. réponse HTML complète mais sans zone exploitable (le µ.warn « aucun <body> exploitable ») → AUCUN mjs:load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = baseMu({
      warn: (...a: any[]) => warnCalls.push(a),
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    })
    installHelpers(µ, doc, win)
    // parseFromString SANS <body> exploitable (même patron que NoBodyParser, tests/ujs-submit-non-html-response-warns.test.ts).
    class NoBodyParser { parseFromString() { return { body: null } } }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, NoBodyParser)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function', 'le fetch de mutation doit être parti')
    capturedSuccess('<html><body></body></html>', 'http://x/posts', undefined, { version: null, target: null, method: null, cache: null })

    assert.equal(warnCalls.length, 1, 'précondition : la branche « aucune zone exploitable » a bien tourné')
    assert.match(warnCalls[0][0], /aucun <body> exploitable/)
    assert.deepEqual(events, [], "AVANT le sabotage « _swapped forcé à true » : AUCUNE installation sur ce chemin, `_swapped` doit rester false — sinon mjs:load fantôme avec detail.zone===undefined")
  })

  it('2c. navigation périmée (µ._mjs_navSeq bumpé pendant le vol) → AUCUN mjs:load', function () {
    const doc = makeEventDoc(makeNode('body'))
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x', host: 'x' }, history: { pushState() {} } }
    let capturedSuccess: any
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    })
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function', 'le fetch de mutation doit être parti')
    µ._mjs_navSeq++ // une navigation PLUS RÉCENTE a démarré pendant que celle-ci était en vol

    // réponse HTML PARFAITEMENT VALIDE (contrairement à 2a/2b) : même un swap qui AURAIT réussi ne
    // doit RIEN émettre une fois périmé — c'est `stale`, pas le contenu, qui ferme cette porte.
    capturedSuccess('<html><body>confirmation</body></html>', 'http://x/posts/42', undefined, { version: null, target: null, method: null, cache: null })

    assert.deepEqual(events, [], "navigation périmée : aucune installation, `_swapped` doit rester false")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// method:'append' jamais testé (correctif zone détachée)
// ────────────────────────────────────────────────────────────────────────────
describe("mjs_ujs — mjs:load, µ._mjs_navApplyJson method:'append' : detail.zone = le contenant (identité), contenu précédent conservé", function () {
  it('3. detail.zone === le contenant visé (identité), isConnected===true, le contenu précédent est TOUJOURS là, module ajouté à la SUITE', function () {
    const body = makeNode('body')
    const slot = makeNode('slot-page', 'slot')
    const existing = makeNode('existing-child')
    slot.appendChild(existing)
    body.appendChild(slot)
    const doc = makeEventDoc(body)
    const events: any[] = []
    doc.addEventListener('mjs:load', (e: any) => events.push(e))
    const win: any = { history: { pushState() {} } }
    const µ: any = baseMu({ paths: { produit: 'xxx.js' }, version: 'v1', _mjs_resSet() {}, Router: { navigate() {} } })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1', target: '#slot', method: 'append' }, '/produits/42', { push: true, via: 'link' })

    assert.equal(events.length, 1)
    const zone = events[0].detail.zone
    assert.equal(zone, slot, "method:'append' : le contenant SURVIT, detail.zone = le contenant lui-même (identité)")
    assert.equal(zone.isConnected, true, 'detail.zone doit être un nœud ATTACHÉ (jamais détaché par un append)')
    assert.ok(zone.children.indexOf(existing) !== -1, "le contenu précédent est TOUJOURS là (append ne retire rien)")
    assert.equal(zone.children[zone.children.length - 1].tag, 'mjs-produit', 'le module est ajouté à la SUITE du contenu existant (pas au début, pas à sa place)')
  })
})
