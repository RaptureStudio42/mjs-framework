// `method="dialog"`/`formmethod="dialog"` doit fermer un
// <dialog> NATIVEMENT (spec HTML : la méthode dialog n'envoie rien au réseau, elle ferme la boîte),
// jamais être interceptée par l'UJS. Avant ce correctif : `_mjs_ujsOnSubmit` posait `e.preventDefault()` AVANT
// de résoudre la méthode effective (`_method` champ > `formmethod` soumissionnaire > `method` du
// <form>) — un formulaire dialog voyait donc son event annulé PUIS `µ._mjs_navDispatch(url, 'DIALOG', …)`
// tomber dans `µ.error('[µ.UJS] Unsupported HTTP verb: DIALOG')` : fermeture native bloquée, sans repli.
//
// Correctif : la résolution de `method` est DÉPLACÉE avant `e.preventDefault()` ; dès que la méthode
// EFFECTIVE (casse indifférente) vaut DIALOG, sortie IMMÉDIATE — pas de preventDefault, pas de dispatch.
//
// Méthode : EXACTEMENT le harnais tests/ujs-404-json-get-query.test.ts (`runSubmitDispatch`) — VRAIE
// `_mjs_navDispatch` installée (extraction par marqueurs, tests/helpers/extract-marked.ts), spy posé au
// point le plus profond (`µ._mjs_ajaxRequest`) ET sur `_mjs_navDispatch` lui-même (compte d'appels) ET sur
// `µ.error` : les 3 preuves attendues (defaultPrevented, _mjs_navDispatch non appelé, aucune
// µ.error) sont donc TOUTES vérifiées sur le VRAI chemin, jamais sur un stub qui les rendrait triviales.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ────────────────────────────────────────────────────────────────────────────
// EXTRACTION + FIXTURES — patron tests/ujs-404-json-get-query.test.ts, inchangé.
// ────────────────────────────────────────────────────────────────────────────
function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock())(µ, document, window)
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

// runSubmit — soumission complète, VRAIE _mjs_navDispatch installée par-dessus le µ minimal (comme
// runSubmitDispatch de tests/ujs-404-json-get-query.test.ts) ; 3 espions : `ajaxRequest` (µ._mjs_ajaxRequest, le point de non-retour
// réseau), `dispatchCalls` (µ._mjs_navDispatch lui-même enveloppé, compte d'appels), `errors` (µ.error).
function runSubmit(opts: { formAttrs?: Record<string, string>, submitterAttrs?: Record<string, string> | null, hasSubmitter?: boolean, docHref: string, fields?: Array<[string, any]>, confirm?: (msg: string, el: any) => any }) {
  const ajaxRequest: any[] = []
  const errors: any[] = []
  const µ: any = { warn() {}, error(...a: any[]) { errors.push(a) }, log() {}, realTarget: (e: any) => e.target }
  if (opts.confirm) { µ.confirm = opts.confirm }
  µ._mjs_ajaxRequest = (o: any) => { ajaxRequest.push(o) }
  const win: any = { location: { href: opts.docHref, origin: 'http://x' }, history: { pushState() {} } }
  const doc: any = { URL: opts.docHref, body: {}, querySelector: () => null, dispatchEvent: () => true }
  installHelpers(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})
  const realNavDispatch = µ._mjs_navDispatch
  let dispatchCalls = 0
  µ._mjs_navDispatch = function (...a: any[]) { dispatchCalls++; return realNavDispatch.apply(µ, a) }
  const handler = makeSubmitHandler()
  const form = makeSubForm(opts.formAttrs || {})
  const submitter = opts.hasSubmitter === false ? null : makeSubButton(opts.submitterAttrs || {})
  const e = makeSubEvent(form, submitter)
  handler(e, µ, win, doc, seededFormData(opts.fields || []), URL, class {})
  return { e, ajaxRequest, errors, get dispatchCalls() { return dispatchCalls } }
}

describe('method="dialog"/formmethod="dialog" : jamais intercepté, fermeture native du <dialog>', function () {
  it('<dialog><form method="dialog"><button>OK</button></form></dialog> : defaultPrevented=false, _mjs_navDispatch jamais appelé, aucune µ.error', function () {
    const r = runSubmit({ formAttrs: { method: 'dialog' }, submitterAttrs: {}, docHref: 'http://x/whatever' })
    assert.equal(r.e.defaultPrevented, false, 'la fermeture native du <dialog> ne doit pas être annulée')
    assert.equal(r.dispatchCalls, 0, 'µ._mjs_navDispatch ne doit jamais être appelé pour une méthode dialog')
    assert.equal(r.ajaxRequest.length, 0, 'aucune requête réseau ne doit partir')
    assert.equal(r.errors.length, 0, 'plus de "[µ.UJS] Unsupported HTTP verb: DIALOG"')
  })

  it('formmethod="dialog" sur le bouton d\'un <form method="post"> : idem', function () {
    const r = runSubmit({ formAttrs: { method: 'post', action: '/posts' }, submitterAttrs: { formmethod: 'dialog' }, docHref: 'http://x/whatever' })
    assert.equal(r.e.defaultPrevented, false)
    assert.equal(r.dispatchCalls, 0)
    assert.equal(r.ajaxRequest.length, 0)
    assert.equal(r.errors.length, 0)
  })

  it('formmethod="DIALOG" (casse) : idem', function () {
    const r = runSubmit({ formAttrs: { method: 'post', action: '/posts' }, submitterAttrs: { formmethod: 'DIALOG' }, docHref: 'http://x/whatever' })
    assert.equal(r.e.defaultPrevented, false)
    assert.equal(r.dispatchCalls, 0)
    assert.equal(r.ajaxRequest.length, 0)
    assert.equal(r.errors.length, 0)
  })

  it('non-régression : method="post" reste intercepté (defaultPrevented=true, _mjs_navDispatch appelé, requête réseau POST partie)', function () {
    const r = runSubmit({ formAttrs: { method: 'post', action: '/posts' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['title', 'Bonjour']] })
    assert.equal(r.e.defaultPrevented, true)
    assert.equal(r.dispatchCalls, 1)
    assert.equal(r.ajaxRequest.length, 1, 'la requête POST doit réellement partir (non-régression)')
    assert.equal(r.ajaxRequest[0].method, 'POST')
    assert.equal(r.ajaxRequest[0].data.get('title'), 'Bonjour')
    assert.equal(r.errors.length, 0)
  })

  describe('@confirm sur un formulaire method="dialog" : la confirmation continue de jouer (docs/06-evenements.md l.310, « acceptation -> l\'action repart d\'elle-même, comme si la question n\'avait pas existé »)', function () {
    it('refus : STOP total, comme une soumission ordinaire — preventDefault posé, aucun _mjs_navDispatch', function () {
      let confirmCalls = 0
      const r = runSubmit({ formAttrs: { method: 'dialog', 'mjs-confirm': 'Fermer sans enregistrer ?' }, hasSubmitter: false, docHref: 'http://x/whatever', confirm: () => { confirmCalls++; return false } })
      assert.equal(confirmCalls, 1, 'la confirmation doit être demandée même pour une méthode dialog')
      assert.equal(r.e.defaultPrevented, true, 'refus : la fermeture du <dialog> est bloquée, comme une soumission ordinaire')
      assert.equal(r.dispatchCalls, 0)
    })

    it("acceptation synchrone : confirmée PUIS traitée comme si la question n'avait pas existé — defaultPrevented=false, aucun _mjs_navDispatch, fermeture native laissée au navigateur", function () {
      let confirmCalls = 0
      const r = runSubmit({ formAttrs: { method: 'dialog', 'mjs-confirm': 'Fermer sans enregistrer ?' }, hasSubmitter: false, docHref: 'http://x/whatever', confirm: () => { confirmCalls++; return true } })
      assert.equal(confirmCalls, 1)
      assert.equal(r.e.defaultPrevented, false, 'accepté : la méthode dialog reprend son cours, fermeture native laissée au navigateur')
      assert.equal(r.dispatchCalls, 0)
      assert.equal(r.errors.length, 0)
    })
  })

  it('(INVERSÉ : un champ `_method` n\'est PAS un attribut HTML method/formmethod, le défaut natif DIALOG ne s\'applique qu\'à ces deux-là) — champ caché _method=dialog sur un <form method="post"> : REFUSÉ, pas laissé filer vers le method="post" réel du <form>', function () {
    const r = runSubmit({ formAttrs: { method: 'post', action: '/posts' }, hasSubmitter: false, docHref: 'http://x/whatever', fields: [['_method', 'dialog']] })
    assert.equal(r.e.defaultPrevented, true, '_method=dialog doit être bloqué (sinon le <form> repart avec SON method="post" réel, cf. tests/ujs-method-dialog-field.test.ts pour la preuve DOM réel)')
    assert.equal(r.dispatchCalls, 0, 'dialog n\'est pas un verbe HTTP : jamais envoyé à _mjs_navDispatch')
    assert.equal(r.ajaxRequest.length, 0)
    assert.equal(r.errors.length, 1, 'refus explicite loggé (µ.error), comme avant le correctif pour ce cas précis')
  })
})
