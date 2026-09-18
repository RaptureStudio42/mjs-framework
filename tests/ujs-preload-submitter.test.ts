// 2 correctifs sur mjs_ujs.ts :
//   1) préchargement des liens (µ._mjs_preloadLink/µ._mjs_ajaxGet) — le canal PUBLIC `µ.ajax.get`
//      (sans en-tête `X-MJS-Nav`) est remplacé par le canal INTERNE `µ._mjs_navRequest` (même
//      garde que lui : `typeof µ._mjs_ajaxRequest === 'function'`), et les en-têtes de navigation
//      `nav` (version/reload/target/method/cache) sont désormais mémorisés DANS l'entrée du
//      cache de préchargement, ressortis au clic (`µ._mjs_ajaxGet`, 4e argument) — sans ça, une
//      page préchargée ignorait ces en-têtes, la garde « bundle périmé » ne jouait pas dessus.
//      Marquage anti-doublon (`µ._mjs_preloaded.add`) déplacé DANS la branche qui tente réellement
//      le préchargement (même raisonnement que le fix onEvict voisin) : un module runtime
//      'ajax' absent ne doit pas bloquer un essai futur.
//   2) bouton soumissionnaire (µ._mjs_ujsOnSubmit) — `e.submitter` (le bouton qui a réellement
//      déclenché la soumission) est désormais lu AVANT les tests target/action ; ses attributs
//      `formaction`/`formtarget`/`formmethod` priment sur ceux du `<form>` pour CETTE
//      soumission (repli sur le formulaire en leur absence, ou pour une soumission par la
//      touche Entrée où `e.submitter` vaut `null`). Ordre de méthode inchangé pour le reste :
//      le champ `_method` reste l'override explicite du verbe.
//
// Méthode : EXACTEMENT le même harnais que tests/ujs-submit-idl-shadowing.test.ts et
// tests/ujs-post-swap-queue.test.ts — extraction par marqueurs EXPLICITES
// (tests/helpers/extract-marked.ts, aucun comptage d'accolades), stubs plats, PAS de
// happy-dom. Les marqueurs `_mjs_ajaxGet`/`_mjs_preloadLink`/`_mjs_ujsOnSubmit`/`helpers-navigation`
// existaient déjà dans la source — aucun marqueur ajouté ni déplacé ici. `µ._mjs_preloaded =
// new Set()` vit HORS marqueur dans la source (ligne juste avant `_mjs_preloadCache-init`) : posé
// à la main dans `installPreload`, comme `installHelpers`/les tests voisins posent l'état
// initial que la source suppose déjà établi par le fichier entier au chargement.

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

function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock())(µ, document, window)
}

// ────────────────────────────────────────────────────────────────────────────
// µ._mjs_preloadLink / µ._mjs_ajaxGet : canal interne (X-MJS-Nav) + nav mémorisé/ressorti
// ────────────────────────────────────────────────────────────────────────────

function extractPreloadChain(): string {
  return [
    extractMarked(UJS_SRC, '_mjs_preloadCache-init'),
    extractMarked(UJS_SRC, '_mjs_normPreload'),
    extractMarked(UJS_SRC, '_mjs_ajaxGet'),
    extractMarked(UJS_SRC, '_mjs_isPreloadableLink'),
    extractMarked(UJS_SRC, '_mjs_effectivePreload'),
    extractMarked(UJS_SRC, '_mjs_preloadLink'),
  ].join('\n')
}
function installPreload(µ: any, window: any) {
  µ._mjs_preloaded = new Set() // hors marqueur dans la source (déclaration brute juste avant _mjs_preloadCache-init)
  new Function('µ', 'window', extractPreloadChain())(µ, window)
}

function makeLink(overrides: Record<string, any> = {}) {
  return Object.assign({
    tagName: 'A',
    hasAttribute: (_k: string) => false,
    getAttribute: (k: string) => (k === 'data-mjs-preload' ? 'eager' : null),
    origin: 'http://x',
    target: '',
    protocol: 'http:',
    hash: '',
    pathname: '/page2',
    search: '',
    href: 'http://x/page2',
    getRootNode: () => null,
  }, overrides)
}

function makeWindow() {
  return { location: { origin: 'http://x', pathname: '/page1', search: '' } }
}

function makePreloadMu(extra: Record<string, any> = {}) {
  return Object.assign({ log() {}, warn() {}, error() {} }, extra)
}

function setupPreload(extraMu: Record<string, any> = {}) {
  const µ: any = makePreloadMu(extraMu)
  const win = makeWindow()
  installHelpers(µ, {}, win) // fournit µ._mjs_navRequest (et µ._mjs_navNoUjs, requis par _mjs_isPreloadableLink)
  installPreload(µ, win)
  return { µ, win }
}

describe('mjs_ujs — µ._mjs_preloadLink/µ._mjs_ajaxGet : canal interne + nav mémorisé/ressorti', function () {
  it('(p1) préchargement — µ._mjs_ajaxRequest porte X-MJS-Nav, µ.ajax.get jamais appelé (ROUGE avant correctif : µ.ajax.get appelé, pas µ._mjs_ajaxRequest)', function () {
    const { µ } = setupPreload()
    const ajaxRequestCalls: any[] = []
    const ajaxGetCalls: any[] = []
    µ._mjs_ajaxRequest = function (opts: any) { ajaxRequestCalls.push(opts) }
    µ.ajax = { get: function (...args: any[]) { ajaxGetCalls.push(args) } }
    const link = makeLink()

    µ._mjs_preloadLink(link, 'eager')

    assert.equal(ajaxGetCalls.length, 0, 'µ.ajax.get (canal PUBLIC) ne doit jamais être appelé par le préchargement')
    assert.equal(ajaxRequestCalls.length, 1, 'µ._mjs_ajaxRequest (canal interne, via µ._mjs_navRequest) doit être appelé UNE fois')
    assert.equal(ajaxRequestCalls[0].headers && ajaxRequestCalls[0].headers['X-MJS-Nav'], '1', "l'en-tête de navigation doit être posé — parité avec un clic")
    assert.equal(ajaxRequestCalls[0].method, 'GET')
    assert.equal(ajaxRequestCalls[0].url, link.href)
  })

  it("(p2) réponse avec en-têtes de navigation (nav) — mémorisés dans l'entrée du cache, ressortis au clic en 4e argument (ROUGE avant correctif)", async function () {
    const { µ } = setupPreload()
    const navPayload = { version: 'v2', target: '#zone' }
    µ._mjs_ajaxRequest = function (opts: any) { opts.success('<p>html</p>', 'http://x/page2', undefined, navPayload) }
    const link = makeLink()

    µ._mjs_preloadLink(link, 'eager')

    const entry = µ._mjs_preloadCache.get(link.href)
    assert.ok(entry && typeof entry === 'object', "l'entrée de cache doit être un objet {html,url,nav}")
    assert.deepEqual(entry.nav, navPayload, "nav doit être mémorisé avec l'entrée")

    const cbCalls: any[] = []
    µ._mjs_ajaxGet(link.href, function (...args: any[]) { cbCalls.push(args) })
    await wait(0)

    assert.equal(cbCalls.length, 1)
    assert.deepEqual(cbCalls[0], ['<p>html</p>', 'http://x/page2', void 0, navPayload], 'cb doit recevoir (html, finalUrl, undefined, nav)')
  })

  it('(p3) réponse JSON (objet, protocole X-MJS-Nav) — mémorisée telle quelle (par référence), rendue telle quelle au clic', async function () {
    const { µ } = setupPreload()
    const jsonBody = { module: 'mjs-produit', props: {}, url: '/page2' }
    const navPayload = { version: 'v2' }
    µ._mjs_ajaxRequest = function (opts: any) { opts.success(jsonBody, 'http://x/page2', undefined, navPayload) }
    const link = makeLink()

    µ._mjs_preloadLink(link, 'eager')

    const entry = µ._mjs_preloadCache.get(link.href)
    assert.equal(entry.html, jsonBody, 'le JSON doit être mémorisé par référence, jamais sérialisé')

    const cbCalls: any[] = []
    µ._mjs_ajaxGet(link.href, function (...args: any[]) { cbCalls.push(args) })
    await wait(0)

    assert.equal(cbCalls[0][0], jsonBody, 'rendu tel quel (objet), pas converti en chaîne')
    assert.equal(typeof cbCalls[0][0], 'object')
  })

  it("(p4) µ._mjs_ajaxRequest absent — aucun préchargement, aucune exception, µ._mjs_preloaded n'est pas marqué (nouvel essai possible)", function () {
    const { µ } = setupPreload()
    // AUCUN µ._mjs_ajaxRequest défini
    const link = makeLink()

    assert.doesNotThrow(() => { µ._mjs_preloadLink(link, 'eager') })

    assert.equal(µ._mjs_preloadCache.has(link.href), false, 'aucune entrée de cache ne doit avoir été posée')
    assert.equal(µ._mjs_preloaded.has('page:' + link.href), false, 'la clé ne doit pas être marquée — un module ajax absent ne bloque pas un essai futur')
  })

  it('(p5) échec réseau — µ._mjs_preloaded.delete(key) (non-régression)', function () {
    const { µ } = setupPreload()
    µ._mjs_ajaxRequest = function (opts: any) { opts.error() }
    const link = makeLink()

    µ._mjs_preloadLink(link, 'eager')

    assert.equal(µ._mjs_preloaded.has('page:' + link.href), false, 'un échec réseau doit libérer la clé pour une nouvelle tentative')
  })

  it('(p6) entrée ancienne « chaîne brute » dans le cache — cb(html, undefined, undefined, undefined), aucune exception', async function () {
    const { µ } = setupPreload()
    µ._mjs_preloadCache.set('http://x/vieux', 'html-brut')

    const cbCalls: any[] = []
    assert.doesNotThrow(() => { µ._mjs_ajaxGet('http://x/vieux', function (...args: any[]) { cbCalls.push(args) }) })
    await wait(0)

    assert.equal(cbCalls.length, 1)
    assert.deepEqual(cbCalls[0], ['html-brut', void 0, void 0, void 0])
  })
})

// ────────────────────────────────────────────────────────────────────────────
// µ._mjs_ujsOnSubmit : bouton soumissionnaire (e.submitter) — formaction/formtarget/formmethod
// ────────────────────────────────────────────────────────────────────────────

class FakeFormData {
  private entries: Array<[string, any]>
  constructor(seed: Array<[string, any]> = []) { this.entries = seed.slice() }
  append(k: string, v: any) { this.entries.push([k, v]) }
  get(k: string) { const e = this.entries.find(([key]) => key === k); return e ? e[1] : null }
}

function seededFormDataClass(fields: Array<[string, any]>) {
  return class extends FakeFormData {
    constructor() { super(fields) }
  }
}

function extractSubmitBody(): string {
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
}
function makeSubmitHandler(): Function {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody())
}

function makeForm(attrs: Record<string, string> = {}) {
  return {
    hasAttribute: (k: string) => Object.prototype.hasOwnProperty.call(attrs, k),
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    setAttribute: () => {},
    querySelectorAll: () => [],
    closest: function (this: any) { return this },
  }
}

function makeButton(attrs: Record<string, string> = {}, extra: Record<string, any> = {}) {
  return Object.assign({
    tagName: 'BUTTON',
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
  }, extra)
}

function makeEvent(form: any, submitter: any = null) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter, target: form }
}

function makeSubmitMu(dispatchCalls: any[]) {
  return {
    log() {}, warn() {}, error() {},
    realTarget: (e: any) => e.target,
    _mjs_navDispatch: (url: string, method: string, payload: any, opts: any) => { dispatchCalls.push({ url, method, payload, opts }); return 'ok' },
  }
}

function setupSubmit(dispatchCalls: any[]) {
  const µ: any = makeSubmitMu(dispatchCalls)
  const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
  const doc: any = {}
  installHelpers(µ, doc, win) // fournit µ._mjs_navNoUjs
  const handler = makeSubmitHandler()
  return { µ, win, doc, handler }
}

describe("mjs_ujs — µ._mjs_ujsOnSubmit : bouton soumissionnaire (e.submitter) prioritaire sur le <form>", function () {
  it('(f1) <button formaction="/autre"> soumissionnaire : µ._mjs_navDispatch appelé avec /autre (ROUGE avant correctif : action du FORMULAIRE utilisée)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/form-action' })
    const submitter = makeButton({ formaction: '/autre' })
    const e = makeEvent(form, submitter)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].url, '/autre', "l'action du BOUTON doit l'emporter sur celle du formulaire")
    assert.equal(e.defaultPrevented, true)
  })

  it('(f2) formmethod="post" sur le bouton, <form method="get"> : méthode POST (ROUGE avant correctif : GET du formulaire)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/x', method: 'get' })
    const submitter = makeButton({ formmethod: 'post' })
    const e = makeEvent(form, submitter)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].method, 'POST')
  })

  it('(f3) champ _method="patch" + formmethod="post" sur le bouton : le CHAMP explicite l\'emporte (PATCH)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([['_method', 'patch']])
    const form = makeForm({ action: '/x', method: 'get' })
    const submitter = makeButton({ formmethod: 'post' })
    const e = makeEvent(form, submitter)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].method, 'PATCH')
  })

  it('(f4) formtarget="_blank" sur le bouton : non intercepté (ROUGE avant correctif) ; formtarget="_self" : intercepté normalement', function () {
    const dispatchCallsBlank: any[] = []
    const blank = setupSubmit(dispatchCallsBlank)
    const FDblank = seededFormDataClass([])
    const formBlank = makeForm({ action: '/x' })
    const submitterBlank = makeButton({ formtarget: '_blank' })
    const eBlank = makeEvent(formBlank, submitterBlank)
    blank.handler(eBlank, blank.µ, blank.win, blank.doc, FDblank, URL, class {})
    assert.equal(dispatchCallsBlank.length, 0, 'formtarget="_blank" : soumission native, jamais interceptée')
    assert.equal(eBlank.defaultPrevented, false)

    const dispatchCallsSelf: any[] = []
    const self_ = setupSubmit(dispatchCallsSelf)
    const FDself = seededFormDataClass([])
    const formSelf = makeForm({ action: '/x' })
    const submitterSelf = makeButton({ formtarget: '_self' })
    const eSelf = makeEvent(formSelf, submitterSelf)
    self_.handler(eSelf, self_.µ, self_.win, self_.doc, FDself, URL, class {})
    assert.equal(dispatchCallsSelf.length, 1, 'formtarget="_self" : intercepté normalement')
    assert.equal(eSelf.defaultPrevented, true)
  })

  it('(f5) formaction cross-origin sur le bouton : non intercepté (garde-fou same-origin étendu au bouton)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/x' })
    const submitter = makeButton({ formaction: 'https://autre-origine.example/x' })
    const e = makeEvent(form, submitter)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 0)
    assert.equal(e.defaultPrevented, false)
  })

  it('(f6) soumission par Entrée (e.submitter === null) : attributs du FORMULAIRE utilisés, comportement inchangé (non-régression)', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/form-action', method: 'post' })
    const e = makeEvent(form, null)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].url, '/form-action')
    assert.equal(dispatchCalls[0].method, 'POST')
  })

  it('(f7) formaction="http://" (inanalysable) sur le bouton : non intercepté, aucune exception', function () {
    const dispatchCalls: any[] = []
    const { µ, win, doc, handler } = setupSubmit(dispatchCalls)
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/x' })
    const submitter = makeButton({ formaction: 'http://' })
    const e = makeEvent(form, submitter)

    assert.doesNotThrow(() => { handler(e, µ, win, doc, FD, URL, class {}) })

    assert.equal(dispatchCalls.length, 0)
    assert.equal(e.defaultPrevented, false)
  })
})
