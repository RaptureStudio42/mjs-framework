// Tests neufs — capacités UJS « désactivation pendant soumission », « µnav »,
// « abandon réel des requêtes (AbortController) » et « focus après swap »
// (six capacités de navigation ajax). Même motif que les tests
// ujs-submit-*/ujs-preloadcache-unbounded existants : extraction du corps/des
// statements SOURCE (regex + comptage d'accolades), exécutés via `new Function`
// — mjs_ujs.ts attache des listeners PERMANENTS dès l'import, jamais
// d'exécution réelle du fichier dans un test (convention établie).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

function extractSubmitBody(): string {
  // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
  // — renommage, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}
function extractAbortStaleNavStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navController') + '\n' + extractMarked(UJS_SRC, '_mjs_abortStaleNav')
}
function extractFocusHelpersStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_deepFind') + '\n' + extractMarked(UJS_SRC, '_mjs_focusAfterSwap')
}

function makeSubmitHandler() {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody())
}
// bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend désormais (le
// chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout
// donc toujours <body> ; µ.ajax.xxx remplacé par le canal interne
// µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce
// fichier continue de tourner (ses INTENTIONS — désactivation pendant
// soumission/µnav/abort/focus — sont inchangées).
function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}
function installNavDispatch(µ: any, win: any = {}, doc: any = {}, DOMParser: any = class {}) {
  // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ; ce
  // fichier vérifie le dispatch µ.ajax.* EXISTANT, jamais l'en-tête X-MJS-Nav
  // (hors périmètre ici) : on redirige simplement vers le µ.ajax mocké par CE
  // test, arguments dans le MÊME ORDRE qu'avant. `µ.ajax` peut être absent
  // (tests qui ne le fournissent pas) — repli silencieux comme avant.
  if (typeof µ._mjs_ajaxRequest !== 'function') {
    µ._mjs_ajaxRequest = function (opts: any) {
      if (!µ.ajax) return
      const m = opts.method.toLowerCase()
      if (m === 'get' || m === 'delete') return µ.ajax[m] && µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
      return µ.ajax[m] && µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    }
  }
  new Function('µ', 'document', 'window', extractHelpersBlock())(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, class {}, DOMParser)
}

// ── Fakes DOM MINIATURES (mêmes sélecteurs que ceux réellement émis par
// mjs_ujs.ts : tag nu, [attr], le trio de boutons de soumission) ───────────
function matchesSingle(el: any, sel: string): boolean {
  sel = sel.trim()
  const attrMatch = sel.match(/^\[([a-zA-Z-]+)\]$/)
  if (attrMatch) { return el.hasAttribute(attrMatch[1]) }
  const typeMatch = sel.match(/^([a-zA-Z]+)\[type='([a-zA-Z]+)'\]$/)
  if (typeMatch) { return el.tagName === typeMatch[1].toUpperCase() && el.getAttribute('type') === typeMatch[2] }
  const notTypeMatch = sel.match(/^([a-zA-Z]+):not\(\[type\]\)$/)
  if (notTypeMatch) { return el.tagName === notTypeMatch[1].toUpperCase() && !el.hasAttribute('type') }
  return el.tagName === sel.toUpperCase()
}
function matchesSelector(el: any, sel: string): boolean {
  return sel.split(',').some((s) => matchesSingle(el, s))
}
function makeFakeEl(tag: string, attrs: Record<string, string> = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  const el: any = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [] as any[],
    _shadow: null,
    focusCalls: [] as any[],
    disabled: false,
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
    setAttribute(name: string, val: string) { attributes[name] = String(val) },
    removeAttribute(name: string) { delete attributes[name] },
    matches(sel: string) { return matchesSelector(el, sel) },
    closest(sel: string) {
      let n: any = el
      while (n) { if (matchesSelector(n, sel)) { return n } n = n.parentElement }
      return null
    },
    querySelectorAll(sel: string) {
      const out: any[] = []
      const walk = (node: any) => { for (const c of node.children) { if (matchesSelector(c, sel)) { out.push(c) } walk(c) } }
      walk(el)
      return out
    },
    appendChild(child: any) { child.parentElement = el; el.children.push(child); return child },
    focus(opts: any) { this.focusCalls.push(opts) },
  }
  return el
}
function makeForm(attrs: Record<string, string> = {}) {
  const el = makeFakeEl('form', attrs)
  el.target = ''
  el.action = 'http://x/posts'
  el._method = 'POST'   // défaut réaliste (mutation) — la résolution GET est testée ailleurs (preload/prg)
  const baseGetAttribute = el.getAttribute.bind(el)
  el.getAttribute = (name: string) => {
    if (name === 'action') { return el.action }
    if (name === 'method') { return el._method || null }
    return baseGetAttribute(name)
  }
  return el
}
function makeSubmitEvent(form: any, submitter: any = null) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter, composedPath: () => [form], target: form }
}
class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
  *[Symbol.iterator]() { yield* this.map }
}
function baseMu(overrides: any = {}) {
  return Object.assign({
    realTarget: (e: any) => e.target,
    warn() {}, error() {}, log() {},
    _mjs_navSeq: 0,   // _mjs_navDispatch lit ++µ._mjs_navSeq (jeton anti-course) — doit partir d'un nombre, pas undefined (NaN casserait le garde-fou stale)
    pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
  }, overrides)
}

describe('mjs_ujs — désactivation pendant soumission (disabled + aria-busy)', function () {
  it('boutons de soumission (button[submit]/button sans type/input[submit]) disabled + form aria-busy PENDANT la requête, restaurés sur échec réseau', function () {
    const form = makeForm()
    const submitBtn = makeFakeEl('button', { type: 'submit' })
    const implicitBtn = makeFakeEl('button')                    // sans type = bouton de soumission par défaut HTML
    const resetBtn = makeFakeEl('button', { type: 'reset' })    // PAS un bouton de soumission
    const inputSubmit = makeFakeEl('input', { type: 'submit' })
    const textInput = makeFakeEl('input', { type: 'text' })
    form.appendChild(submitBtn); form.appendChild(implicitBtn); form.appendChild(resetBtn)
    form.appendChild(inputSubmit); form.appendChild(textInput)

    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    let capturedError: any
    const µ = baseMu({ ajax: { post: (_u: string, _p: any, _s: any, error: any) => { capturedError = error } } })
    installNavDispatch(µ, win)
    const handler = makeSubmitHandler()
    handler(makeSubmitEvent(form), µ, win, {}, FakeFormData, URL, class {})

    assert.equal(submitBtn.disabled, true, 'button[type=submit] désactivé')
    assert.equal(implicitBtn.disabled, true, 'button SANS type = bouton de soumission par défaut HTML, désactivé aussi')
    assert.equal(resetBtn.disabled, false, 'button[type=reset] : PAS un bouton de soumission, jamais touché')
    assert.equal(inputSubmit.disabled, true, "input[type=submit] désactivé")
    assert.equal(textInput.disabled, false, 'input[type=text] jamais touché')
    assert.equal(form.getAttribute('aria-busy'), 'true')

    assert.ok(typeof capturedError === 'function', 'µ.ajax.post doit avoir été appelé avec un callback error')
    capturedError({ status: 500, body: 'Internal Server Error' }) // échec réseau/HTTP, pas de corps HTML de repli

    assert.equal(submitBtn.disabled, false, 'restauré après échec réseau (chemin explicite)')
    assert.equal(implicitBtn.disabled, false)
    assert.equal(inputSubmit.disabled, false)
    assert.equal(form.hasAttribute('aria-busy'), false, 'aria-busy retiré après échec')
  })

  it('opt-out mjs-no-disable : les boutons ne sont JAMAIS désactivés, aria-busy jamais posé', function () {
    const form = makeForm({ 'mjs-no-disable': '' })
    const btn = makeFakeEl('button', { type: 'submit' })
    form.appendChild(btn)
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu({ ajax: { post: () => {} } })
    installNavDispatch(µ, win)
    const handler = makeSubmitHandler()
    handler(makeSubmitEvent(form), µ, win, {}, FakeFormData, URL, class {})

    assert.equal(btn.disabled, false, 'mjs-no-disable : opt-out respecté')
    assert.equal(form.hasAttribute('aria-busy'), false)
  })

  it('succès + swap : restoreBusy est quand même appelé (idempotent — rien à restaurer, le <form> a été remplacé par le swap)', function () {
    const form = makeForm()
    const btn = makeFakeEl('button', { type: 'submit' })
    form.appendChild(btn)
    const liveRoot: any = { replaceChildren(...nodes: any[]) { this.by = nodes[0] } }
    const newRoot = { tag: 'ok' }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const doc = { body: liveRoot }
    let capturedSuccess: any
    const µ = baseMu({ ajax: { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } } })
    class ParserWithRoot { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    installNavDispatch(µ, win, doc, ParserWithRoot)
    const handler = makeSubmitHandler()
    handler(makeSubmitEvent(form), µ, win, doc, FakeFormData, URL, class {})

    assert.equal(btn.disabled, true, 'désactivé pendant la requête')
    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts')
    assert.equal(liveRoot.by, newRoot, 'le swap a bien eu lieu (contenu de <body> remplacé)')
    // opts.restoreBusy tourne SANS CONDITION dans `done` (même sur succès+swap) —
    // le bouton D'ORIGINE (détaché par le swap) est donc bien ré-activé, mais
    // c'est SANS CONSÉQUENCE visible : il n'est plus dans le DOM affiché
    // (remplacé par newRoot). C'est le sens du "rien à restaurer" de la spec —
    // pas "restoreBusy est sauté", mais "son effet ne se voit plus".
    assert.equal(btn.disabled, false, "restoreBusy s'exécute même après un swap réussi (idempotent/inoffensif sur un nœud détaché)")
  })
})

describe('mjs_ujs — µnav (état de navigation réactif)', function () {
  it('actif (avec href) au DÉBUT de la requête, inactif (href=null) après succès + swap', function () {
    const liveRoot: any = { replaceChildren(...nodes: any[]) { this.by = nodes[0] } }
    const newRoot = { tag: 'ok' }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const doc = { body: liveRoot }
    let capturedSuccess: any
    const µ: any = baseMu({ nav: { active: false, href: null }, ajax: { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } } })
    class ParserWithRoot { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    installNavDispatch(µ, win, doc, ParserWithRoot)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData())
    assert.equal(µ.nav.active, true, 'µnav.active posé AU DÉBUT de la requête')
    assert.equal(µ.nav.href, 'http://x/posts')

    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts')
    assert.equal(µ.nav.active, false, 'retombe après le swap')
    assert.equal(µ.nav.href, null)
  })

  it('inactif après un échec réseau (pas de corps HTML de repli)', function () {
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    let capturedError: any
    const µ: any = baseMu({ nav: { active: false, href: null }, ajax: { post: (_u: string, _p: any, _s: any, error: any) => { capturedError = error } } })
    installNavDispatch(µ, win)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData())
    assert.equal(µ.nav.active, true)
    capturedError({ status: 500 })
    assert.equal(µ.nav.active, false, 'retombe même sur échec réseau')
    assert.equal(µ.nav.href, null)
  })

  it("une navigation PÉRIMÉE (résolution tardive) ne doit PAS effacer le µnav de la navigation plus récente", function () {
    const win: any = { location: { href: 'http://x/a', origin: 'http://x' }, history: { pushState() {} } }
    const successFns: any[] = []
    const µ: any = baseMu({ nav: { active: false, href: null }, ajax: { post: (_u: string, _p: any, success: any) => { successFns.push(success) } } })
    installNavDispatch(µ, win, {}, class { parseFromString() { return { body: null } } })

    µ._mjs_navDispatch('http://x/a', 'POST', new FakeFormData())   // navigation A
    µ._mjs_navDispatch('http://x/b', 'POST', new FakeFormData())   // navigation B, plus récente — A devient périmée
    assert.equal(µ.nav.href, 'http://x/b', 'B est la navigation courante')

    successFns[0]('<html><body id="app-root">a</body></html>', 'http://x/a') // A résout TARD, périmée
    assert.equal(µ.nav.active, true, "A périmée ne doit PAS effacer l'état actif de B")
    assert.equal(µ.nav.href, 'http://x/b', 'µnav doit toujours refléter B, pas être remis à null par A')
  })
})

describe('mjs_ujs — abandon réel des requêtes de navigation (AbortController)', function () {
  it('_mjs_abortStaleNav : la 2e navigation abandonne le controller de la 1re, en fournit un NOUVEAU non aborted', function () {
    const µ: any = {}
    new Function('µ', extractAbortStaleNavStatement())(µ)

    const c1 = µ._mjs_abortStaleNav()
    assert.equal(c1.signal.aborted, false)
    const c2 = µ._mjs_abortStaleNav()
    assert.equal(c1.signal.aborted, true, 'la 1re navigation doit être abandonnée par la 2e')
    assert.equal(c2.signal.aborted, false, 'la 2e navigation reçoit un signal FRAIS')
    assert.notEqual(c1, c2)
  })

  it("_mjs_navDispatch : le signal est transmis à µ.ajax.*, 2e navigation abandonne le fetch de la 1re (delete PUIS put — vérifie le décalage positionnel data/timeout/signal)", function () {
    const win: any = { location: { href: 'http://x/a', origin: 'http://x' }, history: { pushState() {} } }
    const captured: any[] = []
    const µ = baseMu({
      ajax: {
        delete: (_url: string, _s: any, _e: any, _a: any, _t: any, signal: any) => { captured.push(signal) },
        put: (_url: string, _d: any, _s: any, _e: any, _a: any, _t: any, signal: any) => { captured.push(signal) },
      },
    })
    // _mjs_navDispatch délègue l'abandon à µ._mjs_abortStaleNav — l'installer d'abord
    // (sans lui, `typeof µ._mjs_abortStaleNav === 'function'` est faux → signal
    // toujours undefined, cf. garde défensive de _mjs_navDispatch).
    new Function('µ', extractAbortStaleNavStatement())(µ)
    installNavDispatch(µ, win)

    µ._mjs_navDispatch('http://x/a', 'DELETE', new FakeFormData(), {})
    µ._mjs_navDispatch('http://x/b', 'PUT', new FakeFormData(), {})

    assert.equal(captured.length, 2)
    assert.ok(captured[0], 'un AbortSignal doit avoir été transmis à µ.ajax.delete')
    assert.ok(captured[1], 'un AbortSignal doit avoir été transmis à µ.ajax.put (position signal, pas timeout)')
    assert.equal(captured[0].aborted, true, 'le fetch DELETE (1re navigation) doit être abandonné par le PUT (2e)')
    assert.equal(captured[1].aborted, false, 'le fetch PUT lui-même reçoit un signal frais, pas déjà aborted')
  })
})

describe('mjs_ajax — _request : abandon par signal externe = chemin SILENCIEUX (capacité 5)', function () {
  it("AbortError issu d'un signal FOURNI PAR L'APPELANT : ni options.error ni options.success, aucune exception", async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const controller = new AbortController()
    const fakeFetch = (_url: string, opts: any) => new Promise((_mjs_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err: any = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
    })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let errorCalled = false, successCalled = false
    const pending = µ.ajax.get('http://x/nav', () => { successCalled = true }, () => { errorCalled = true }, undefined, undefined, controller.signal)
    controller.abort()
    await pending

    assert.equal(errorCalled, false, "chemin SILENCIEUX voulu : pas de callback error (donc pas de console.error via µ.ajax.error par défaut)")
    assert.equal(successCalled, false)
  })

  it('AbortError issu du TIMEOUT interne (aucun signal externe fourni) : reste signalé normalement (comportement inchangé)', async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = (_url: string, opts: any) => new Promise((_mjs_resolve, reject) => {
      opts.signal.addEventListener('abort', () => { const err: any = new Error('aborted'); err.name = 'AbortError'; reject(err) })
    })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let capturedErr: any
    await new Promise<void>((resolve) => {
      µ.ajax.get('http://x/lent', () => {}, (e: any) => { capturedErr = e; resolve() }, undefined, 5)
    })
    assert.match(capturedErr.message, /expirée après 5ms/, 'timeout INTERNE (pas un signal externe) : toujours un message explicite + options.error')
  })
})

describe('mjs_ujs — focus après swap (accessibilité)', function () {
  function installFocusHelpers(µ: any) {
    new Function('µ', extractFocusHelpersStatement())(µ)
  }

  it('[autofocus] présent : reçoit le focus avec preventScroll:true', function () {
    const µ: any = {}
    installFocusHelpers(µ)
    const root = makeFakeEl('div')
    const target = makeFakeEl('input', { autofocus: '' })
    root.appendChild(target)

    µ._mjs_focusAfterSwap(root)
    assert.equal(target.focusCalls.length, 1)
    assert.deepEqual(target.focusCalls[0], { preventScroll: true })
  })

  it('[autofocus] niché dans un shadow (_shadow) : trouvé quand même (le contenu MJS vit en shadow)', function () {
    const µ: any = {}
    installFocusHelpers(µ)
    const root = makeFakeEl('div')
    const host = makeFakeEl('mjs-foo')
    root.appendChild(host)
    const shadow = makeFakeEl('div')
    const target = makeFakeEl('button', { autofocus: '' })
    shadow.appendChild(target)
    host._shadow = shadow

    µ._mjs_focusAfterSwap(root)
    assert.equal(target.focusCalls.length, 1, 'le walk doit descendre dans _shadow, invisible à un simple .children natif')
  })

  it("pas d'autofocus, un <h1> SANS tabindex : tabindex=-1 posé puis focus", function () {
    const µ: any = {}
    installFocusHelpers(µ)
    const root = makeFakeEl('div')
    const h1 = makeFakeEl('h1')
    root.appendChild(h1)

    µ._mjs_focusAfterSwap(root)
    assert.equal(h1.getAttribute('tabindex'), '-1')
    assert.equal(h1.focusCalls.length, 1)
    assert.deepEqual(h1.focusCalls[0], { preventScroll: true })
  })

  it('<h1> avec un tabindex EXISTANT : pas écrasé, mais toujours focus', function () {
    const µ: any = {}
    installFocusHelpers(µ)
    const root = makeFakeEl('div')
    const h1 = makeFakeEl('h1', { tabindex: '3' })
    root.appendChild(h1)

    µ._mjs_focusAfterSwap(root)
    assert.equal(h1.getAttribute('tabindex'), '3', 'tabindex explicite du développeur préservé')
    assert.equal(h1.focusCalls.length, 1)
  })

  it('ni autofocus ni h1 : le conteneur lui-même reçoit tabindex=-1 puis le focus', function () {
    const µ: any = {}
    installFocusHelpers(µ)
    const root = makeFakeEl('div')
    root.appendChild(makeFakeEl('p'))

    µ._mjs_focusAfterSwap(root)
    assert.equal(root.getAttribute('tabindex'), '-1')
    assert.equal(root.focusCalls.length, 1)
    assert.deepEqual(root.focusCalls[0], { preventScroll: true })
  })

  it('root null/absent : aucun crash (no-op silencieux)', function () {
    const µ: any = {}
    installFocusHelpers(µ)
    assert.doesNotThrow(() => µ._mjs_focusAfterSwap(null))
  })
})
