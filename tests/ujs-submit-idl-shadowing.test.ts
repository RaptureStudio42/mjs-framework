// 3 correctifs SÛRS trouvés à la relecture complète de mjs_ujs.ts :
//   1) µ._mjs_ujsOnSubmit (l. 2296/2299/2308) — form.target/form.action sont les PROPRIÉTÉS IDL de
//      HTMLFormElement : un <input name="target">/<input name="action"> dans le formulaire les
//      MASQUE par l'ÉLÉMENT (règle HTML des propriétés nommées) — `new URL(form.action)` lève, et
//      l'élément truthy fait sortir la fonction en silence. Lire les ATTRIBUTS, jamais les
//      propriétés IDL ; `payload.get('_method')` peut aussi rendre un File.
//   2) µ._mjs_navApplyJson (l. 1413-1430) — `window.scrollTo(0,0)`/`µ._mjs_restoreScroll` posés HORS du
//      swap (clic l. 2138-2139, popstate l. 1651-1652) ramenaient la page QUITTÉE en haut AVANT la
//      permutation quand µ._mjs_vtWrapSwap DIFFÈRE le swap (transition de page async, rappel de
//      `document.startViewTransition`) — `opts.onSwapped`, appelée DANS `swap()`, corrige l'ordre.
//   3) µ._mjs_navApplyJson (l. 1397) — `json.module` non-chaîne (réponse serveur malformée, nombre/
//      objet) faisait lever `.replace()` DANS le rappel de succès — même issue que le module
//      inconnu juste en dessous : rechargement complet, jamais un throw.
//
// Méthode : mêmes techniques que tests/ujs-nav-json.test.ts et tests/ujs-submit-urlencoded.test.ts —
// extraction par marqueurs EXPLICITES (tests/helpers/extract-marked.ts, plus de comptage
// d'accolades), `new Function` sur des fakes minimaux (pas de happy-dom : aucun des 3 correctifs
// n'a besoin d'un vrai DOM, la propriété IDL masquée du 1er correctif est simulée par assignation directe
// sur un objet plat — même résultat qu'un `Object.defineProperty` sur un vrai <form>). Le bloc
// 'helpers-navigation' (µ._mjs_navMountZone → µ._mjs_navApplyJson, contigus) est installé sur un `µ`
// minimal AVANT d'extraire le handler submit (fournit µ._mjs_navNoUjs, requis par _mjs_ujsOnSubmit).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}

function extractSubmitBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}

function makeSubmitHandler(): Function {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody(UJS_SRC))
}

// ── ITEM 1 — µ._mjs_ujsOnSubmit : form.target/form.action masqués par un champ homonyme ────────────────

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

// simule l'élément qui MASQUE la propriété IDL homonyme (même effet qu'un vrai
// Object.defineProperty(form, 'action', { value: inputEl }) posé par un navigateur réel).
function makeMaskEl(name: string, value: string) {
  return { tagName: 'INPUT', nodeType: 1, name: name, value: value }
}

function makeForm(attrs: Record<string, string>, mask: { action?: boolean, target?: boolean } = {}) {
  const form: any = {
    hasAttribute: (k: string) => Object.prototype.hasOwnProperty.call(attrs, k),
    getAttribute: (k: string) => (Object.prototype.hasOwnProperty.call(attrs, k) ? attrs[k] : null),
    setAttribute: () => {},
    querySelectorAll: () => [],
    closest: function (this: any) { return this },
  }
  // IDL form.action, NON masquée : un vrai navigateur la rend TOUJOURS ABSOLUE (résolue contre la
  // page) — jamais l'attribut brut tel quel, contrairement à form.target (chaîne telle quelle).
  const resolvedAction = attrs.action ? new URL(attrs.action, 'http://x/posts').href : ''
  form.action = mask.action ? makeMaskEl('action', attrs.action || '') : resolvedAction
  form.target = mask.target ? makeMaskEl('target', attrs.target || '') : (attrs.target || '')
  return form
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

describe('mjs_ujs — µ._mjs_ujsOnSubmit : propriétés IDL form.target/form.action masquées par un champ homonyme', function () {
  it('(1a) <input name="action">/<input name="target"> masquant les propriétés IDL, action attribut relative "/cible" : soumission INTERCEPTÉE, aucune exception', function () {
    const dispatchCalls: any[] = []
    const µ: any = makeSubmitMu(dispatchCalls)
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
    const doc: any = {}
    installHelpers(µ, doc, win) // fournit µ._mjs_navNoUjs (reste du bloc inerte ici)
    const handler = makeSubmitHandler()
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/cible' }, { action: true, target: true })
    const e = makeEvent(form)

    assert.doesNotThrow(() => { handler(e, µ, win, doc, FD, URL, class {}) },
      'AVANT le fix : new URL(élément masquant) lève un TypeError')

    assert.equal(dispatchCalls.length, 1, 'µ._mjs_navDispatch doit être appelé UNE fois — AVANT le fix : form.target masqué (truthy, !== \'_self\') faisait sortir la fonction en silence')
    assert.equal(dispatchCalls[0].url, '/cible')
    assert.equal(dispatchCalls[0].method, 'GET')
    assert.equal(e.defaultPrevented, true, 'e.preventDefault() doit avoir été posé (soumission prise en charge par UJS)')
  })

  it('(1b) action="https://autre-origine.example/x" (cross-origin, PAS de masquage) : non intercepté (non-régression)', function () {
    const dispatchCalls: any[] = []
    const µ: any = makeSubmitMu(dispatchCalls)
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
    const doc: any = {}
    installHelpers(µ, doc, win)
    const handler = makeSubmitHandler()
    const FD = seededFormDataClass([])
    const form = makeForm({ action: 'https://autre-origine.example/x' })
    const e = makeEvent(form)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 0, 'action cross-origin : la soumission NATIVE doit avoir lieu, jamais interceptée')
    assert.equal(e.defaultPrevented, false)
  })

  it("(1c) target=\"_blank\" (attribut réel, PAS de masquage) : non intercepté (non-régression)", function () {
    const dispatchCalls: any[] = []
    const µ: any = makeSubmitMu(dispatchCalls)
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
    const doc: any = {}
    installHelpers(µ, doc, win)
    const handler = makeSubmitHandler()
    const FD = seededFormDataClass([])
    const form = makeForm({ action: '/x', target: '_blank' })
    const e = makeEvent(form)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 0, "target=\"_blank\" : soumission native, jamais interceptée")
    assert.equal(e.defaultPrevented, false)
  })

  it('(1d) champ texte _method="patch" (PAS un File) : méthode PATCH (non-régression)', function () {
    const dispatchCalls: any[] = []
    const µ: any = makeSubmitMu(dispatchCalls)
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' } }
    const doc: any = {}
    installHelpers(µ, doc, win)
    const handler = makeSubmitHandler()
    const FD = seededFormDataClass([['_method', 'patch']])
    const form = makeForm({ action: '/posts/42' })
    const e = makeEvent(form)

    handler(e, µ, win, doc, FD, URL, class {})

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].method, 'PATCH', "'patch' (chaîne) doit toujours l'emporter, converti en MAJUSCULES")
  })
})

// ── ITEM 2 — µ._mjs_navApplyJson : opts.onSwapped, appelé DANS le swap (jamais hors, même différé) ─────

function makeJsonNavMu(extra: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {}, _mjs_resSet() {}, Router: { navigate() {} } }, extra)
}

describe("mjs_ujs — µ._mjs_navApplyJson : opts.onSwapped — scroll posé APRÈS l'installation réelle, jamais hors du swap", function () {
  it('(2a) µ._mjs_vtWrapSwap DIFFÈRE le swap (transition de page async) : onSwapped pas appelée au retour synchrone, appelée une fois APRÈS, une fois le module installé', function (done) {
    const scrollCalls: Array<[number, number]> = []
    const domAtScrollTime: any[] = []
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const doc: any = { body: bodyZone, createElement: (tag: string) => ({ tag }) }
    const win: any = { history: { pushState() {} }, location: { href: 'http://x/produits' } }
    const µ: any = makeJsonNavMu({ paths: { produit: 'xxx.js' } })
    installHelpers(µ, doc, win)
    // transition async : swap DIFFÉRÉ (même patron qu'un vrai document.startViewTransition)
    µ._mjs_vtWrapSwap = function (_link: any, swap: any) { setTimeout(swap, 0) }

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null }, '/produits/42', {
      push: false,
      onSwapped: function () { scrollCalls.push([0, 0]); domAtScrollTime.push(bodyZone.filled ? bodyZone.filled[0].tag : null) },
    })

    assert.equal(scrollCalls.length, 0,
      'AVANT le timer (swap différé) : onSwapped ne doit PAS encore avoir été appelée — AVANT le fix, le scroll posé après le retour synchrone partait ICI, trop tôt (page quittée ramenée en haut avant la permutation)')

    setTimeout(function () {
      assert.equal(scrollCalls.length, 1, 'APRÈS le swap différé : onSwapped doit avoir été appelée UNE fois')
      assert.deepEqual(scrollCalls[0], [0, 0])
      assert.equal(domAtScrollTime[0], 'mjs-produit', "au moment de l'appel, le composant doit déjà être installé DANS le contenant")
      done()
    }, 10)
  })

  it('(2b) sans µ._mjs_vtWrapSwap (fonction absente) : onSwapped appelée une fois, SYNCHRONE (non-régression)', function () {
    const scrollCalls: any[] = []
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const doc: any = { body: bodyZone, createElement: (tag: string) => ({ tag }) }
    const win: any = { history: { pushState() {} }, location: { href: 'http://x/produits' } }
    const µ: any = makeJsonNavMu({ paths: { produit: 'xxx.js' } })
    installHelpers(µ, doc, win)
    // AUCUN µ._mjs_vtWrapSwap défini : le repli synchrone (else { swap(); }) doit s'exécuter

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null }, '/produits/42', {
      push: false,
      onSwapped: function () { scrollCalls.push([0, 0]) },
    })

    assert.equal(scrollCalls.length, 1, 'onSwapped doit avoir été appelée une fois, SYNCHRONE (retour immédiat de µ._mjs_navApplyJson)')
  })

  it("(2c) method:'none' : onSwapped n'est JAMAIS appelée (rien n'est permuté)", function () {
    const scrollCalls: any[] = []
    const doc: any = {}
    const win: any = { history: { pushState() { throw new Error('ne doit pas pousser') } } }
    const µ: any = makeJsonNavMu({ _mjs_resMerge() {} })
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-post', method: 'none', props: {}, url: '/posts/1/like', title: null }, '/posts/1/like', {
      push: true,
      onSwapped: function () { scrollCalls.push(1) },
    })

    assert.equal(scrollCalls.length, 0, "method:'none' : rien n'est permuté, onSwapped ne doit jamais être appelée")
  })
})

// ── ITEM 3 — µ._mjs_navApplyJson : json.module non-chaîne (réponse serveur malformée) ──────────────────

describe('mjs_ujs — µ._mjs_navApplyJson : json.module non-chaîne', function () {
  it('(3) module:42 (nombre) : rechargement complet vers dest, AUCUNE exception', function () {
    const assignCalls: string[] = []
    const doc: any = {}
    const win: any = {
      location: { href: 'http://x/posts', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() { throw new Error('ne doit pas pousser') } },
    }
    const µ: any = makeJsonNavMu()
    installHelpers(µ, doc, win)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: 42, url: '/x' }, undefined, {})
    }, "AVANT le fix : json.module.replace('mjs-', '') lève un TypeError (42 n'a pas de méthode replace)")

    assert.deepEqual(assignCalls, ['/x'], 'rechargement complet vers dest (finalUrl absent → json.url)')
  })
})
