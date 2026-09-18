// Régression : une réponse de submit qui
// n'est ni reconnue comme page HTML complète (pas de "<html") ni comme un
// swap réussi (HTML complet mais #app-root introuvable) était ignorée en
// TOTAL SILENCE — pas de warn, pas de hook, rien. Un submit qui semble
// « n'avoir rien fait » est un des pièges de debug les plus frustrants (le
// développeur ne sait même pas QUE le framework a vu passer une réponse).
//
// Fix : `µ.warn(...)` (toujours visible, cf. mjs_init.ts) dans les 2 cas
// silencieux du `done` du handler submit — réponse non-HTML, et HTML sans
// #app-root. Le cas `html === null` (204 No Content, succès légitime sans
// corps) reste silencieux : ce n'est PAS un cas d'échec.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractSubmitBody(src: string): string {
  // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
  // — renommé, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}

class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.get(k) }
}
class FakeDOMParser {
  private nextBody: any
  constructor(nextBody: any = null) { this.nextBody = nextBody }
  parseFromString() { return { body: this.nextBody } }
}
// µ._mjs_navDispatch (capacités @method/désactivation/µnav/abort/focus) :
// le handler submit délègue désormais sa fin (dispatch ajax + les warn que CE
// fichier vérifie) à cette fonction PARTAGÉE avec le lien mjs-method.
// Extraite + installée sur le MÊME µ, mêmes window/document/FormData/URL/
// DOMParser que le handler lui-même.
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}
// Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend désormais (le
// chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout donc
// toujours <body> ; µ.ajax.xxx remplacé par le canal interne µ._mjs_navRequest/
// µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce fichier continue de
// tourner (son INTENTION — les 2 avertissements « réponse non reconnue »/« aucun
// <body> exploitable » — est inchangée, cf. tête de fichier).
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function makeSubmitHandler(µ: any, win: any, doc: any, FormDataCtor: any, URLCtor: any, DOMParserCtor: any) {
  // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ; ce
  // fichier vérifie les avertissements µ.warn EXISTANTS, jamais l'en-tête
  // X-MJS-Nav (hors périmètre ici) : on redirige simplement vers le µ.ajax
  // mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
  µ._mjs_ajaxRequest = function (opts: any) {
    const m = opts.method.toLowerCase()
    if (m === 'get' || m === 'delete') return µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    return µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
  }
  // Le chemin HTML n'a jamais de `target` : µ._mjs_navMountZone(document, null)
  // résout directement `document.body`, sans jamais consulter de sélecteur ni
  // avertir (l'avertissement « cible introuvable » ne concerne QUE un `target`
  // fourni et non résolu — inatteignable ici). Rien à neutraliser.
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FormDataCtor, URLCtor, DOMParserCtor)
  const body = extractSubmitBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', body)
}
function makeEvent(form: any) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter: null, composedPath: () => [form], target: form }
}
function makeForm(method: string, action: string) {
  return {
    hasAttribute: () => false,
    getAttribute: (k: string) => (k === 'action' ? action : k === 'method' ? method : null),
    target: '', action, closest: function (this: any) { return this },
  }
}
const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
const fakeDoc: any = { getElementById: () => null }

describe("mjs_ujs — submit : réponse non reconnue avertit (µ.warn) au lieu de silence total", function () {
  it("réponse JSON (pas de '<html') : µ.warn appelé", function () {
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = {
      log() {}, error() {}, realTarget: (e: any) => e.target,
      warn: (...args: any[]) => warnCalls.push(args),
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form = makeForm('POST', 'http://x/api/posts')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    capturedSuccess('{"ok":true}', 'http://x/api/posts')

    assert.equal(warnCalls.length, 1, "AVANT le fix : une réponse JSON était ignorée en silence total")
    assert.match(warnCalls[0][0], /non reconnue comme une page HTML complète/)
  })

  it("HTML complet mais aucun <body> exploitable : µ.warn appelé (cas distinct)", function () {
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = {
      log() {}, error() {}, realTarget: (e: any) => e.target,
      warn: (...args: any[]) => warnCalls.push(args),
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form = makeForm('POST', 'http://x/api/posts')
    // FakeDOMParser configuré pour ne JAMAIS produire de <body> exploitable (body=null).
    const NoBodyParser = class extends FakeDOMParser { constructor() { super(null) } }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, NoBodyParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, NoBodyParser)
    capturedSuccess('<html></html>', 'http://x/api/posts')

    assert.equal(warnCalls.length, 1, 'AVANT le fix : HTML sans body exploitable ne prévenait de rien non plus')
    assert.match(warnCalls[0][0], /aucun <body> exploitable/)
  })

  it("html === null (204 No Content) : AUCUN warn — succès légitime sans corps", function () {
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = {
      log() {}, error() {}, realTarget: (e: any) => e.target,
      warn: (...args: any[]) => warnCalls.push(args),
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: { delete: (_url: string, success: any) => { capturedSuccess = success } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form = makeForm('DELETE', 'http://x/posts/42')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    capturedSuccess(null, 'http://x/posts/42')

    assert.equal(warnCalls.length, 0, 'un 204 No Content est un succès normal, pas un cas à signaler')
  })

  it('swap HTML réussi (cas nominal) : AUCUN warn', function () {
    const warnCalls: any[] = []
    let capturedSuccess: any
    const µ: any = {
      log() {}, error() {}, realTarget: (e: any) => e.target,
      warn: (...args: any[]) => warnCalls.push(args),
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form = makeForm('POST', 'http://x/api/posts')
    const BodyParser = class extends FakeDOMParser { constructor() { super({ childNodes: [] }) } }
    const fakeDocWithRoot: any = { body: { replaceChildren() {} } }
    const handler = makeSubmitHandler(µ, win, fakeDocWithRoot, FakeFormData, URL, BodyParser)
    handler(makeEvent(form), µ, win, fakeDocWithRoot, FakeFormData, URL, BodyParser)
    capturedSuccess('<html><body>ok</body></html>', 'http://x/api/posts')

    assert.equal(warnCalls.length, 0, 'un swap réussi ne doit déclencher aucun warn')
  })
})
