// Un submit SANS fichier réellement joint part en
// application/x-www-form-urlencoded (seul format que le serveur mjs serve
// accepte pour POST/PUT/PATCH sans multipart — le serveur répond 415 sur tout
// multipart/form-data). AVEC un fichier réellement joint, le FormData part
// inchangé (multipart ; le serveur apprend ce format séparément,
// hors périmètre ici).
//
// 1) mjs_ujs.ts, µ._mjs_navDispatch, branche POST/PUT/PATCH : détection
// d'un fichier réellement joint (valeur `instanceof File` avec un nom ou un
// poids — un <input type=file> laissé vide vaut File{name:'',size:0}, PAS un
// fichier joint) ; sans fichier, reconstruction du corps en URLSearchParams
// (fichier vide omis, ordre préservé). GET/HEAD/DELETE : chemin inchangé.
//
// 2) mjs_ajax.ts, _request : nouvelle branche `options.data instanceof
// URLSearchParams` AVANT le else générique JSON — sans elle, une
// URLSearchParams se serait fait détruire par JSON.stringify (→ '{}').
//
// Méthode : même technique que ujs-submit-navseq-race.test.ts — extraction du
// corps SOURCE de µ._mjs_navDispatch/µ._mjs_ujsOnSubmit par regex, exécutée via `new
// Function` avec des fakes injectés (pas de compilation, pas de happy-dom).
// Un FakeFile est injecté sous le nom `File` : Node ≥20 a DÉJÀ un `File`
// global (vérifié — `typeof File === 'function'`), l'injection explicite
// est donc ce qui rend `instanceof File` déterministe face à CE FakeFile-ci,
// plutôt que face au global réel du runtime de test.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

function extractSubmitBody(src: string): string {
  // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
  // — renommé, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}

// µ._mjs_navDispatch (capacités @method/désactivation/µnav/abort/focus/
// urlencoded) : le handler submit délègue désormais sa fin (dispatch
// ajax — ce que CE fichier vérifie) à cette fonction PARTAGÉE avec le lien
// mjs-method. Extraite + installée sur le MÊME µ, avec les MÊMES
// window/document/FormData/URL/DOMParser/File que le handler lui-même.
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}

// FakeFile : injecté à la place du `File` global (cf. tête de fichier —
// Node ≥20 EN A un, l'injection le masque pour un `instanceof` déterministe).
class FakeFile {
  name: string
  size: number
  constructor(name: string, size: number) { this.name = name; this.size = size }
}

// FakeFormData : mêmes `append`/`get` que les FakeFormData des autres tests
// ujs-submit-*, PLUS `forEach` — absent des LEURS, ce qui est justement ce
// que la détection de fichier de la Modif A exploite (garde
// `typeof payload.forEach === 'function'`) : les 4 fichiers de tests
// existants restent inertes face à la Modif A, aucune régression possible
// côté leur FakeFormData sans `forEach`. Entrées pré-remplies au
// constructeur (le vrai `new FormData(form)` introspecte le <form> réel —
// ici un simple objet, `form` est ignoré, cf. même choix dans
// ujs-submit-prg-redirect.test.ts).
class FakeFormData {
  private entries: Array<[string, any]>
  constructor(seed: Array<[string, any]> = []) { this.entries = seed.slice() }
  append(k: string, v: any) { this.entries.push([k, v]) }
  get(k: string) { const e = this.entries.find(([key]) => key === k); return e ? e[1] : null }
  forEach(cb: (value: any, key: string) => void) { this.entries.slice().forEach(([k, v]) => cb(v, k)) }
}

function seededFormDataClass(fields: Array<[string, any]>) {
  return class extends FakeFormData {
    constructor() { super(fields) }
  }
}

class FakeDOMParserInerte {
  parseFromString() { return { body: null } }
}

// Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend désormais (le
// chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout
// donc toujours <body> ; µ.ajax.xxx remplacé par le canal interne
// µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce
// fichier continue de tourner (son INTENTION — la conversion urlencoded —
// est inchangée, cf. tête de fichier).
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function makeSubmitHandler(µ: any, win: any, doc: any, FormDataCtor: any, URLCtor: any, DOMParserCtor: any, FileCtor: any) {
  // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ; ce
  // fichier vérifie le payload transmis à µ.ajax.post/put/delete EXISTANT,
  // jamais l'en-tête X-MJS-Nav (hors périmètre ici) : on redirige simplement
  // vers le µ.ajax mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
  µ._mjs_ajaxRequest = function (opts: any) {
    const m = opts.method.toLowerCase()
    if (m === 'get' || m === 'delete') return µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    return µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
  }
  // Le chemin HTML n'a jamais de `target` : µ._mjs_navMountZone(document, null)
  // résout directement `document.body`, sans jamais consulter de sélecteur ni
  // avertir. Rien à neutraliser (hors périmètre de ce fichier de toute façon).
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', 'File', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FormDataCtor, URLCtor, DOMParserCtor, FileCtor)
  const body = extractSubmitBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', body)
}

function makeEvent(form: any, submitter: any = null) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    submitter,
    target: form,
  }
}

function makeForm(action: string, method: string) {
  return {
    hasAttribute: () => false,
    getAttribute: (k: string) => (k === 'action' ? action : k === 'method' ? method : null),
    target: '',
    action: `http://x${action}`,
    closest: () => makeForm(action, method),
  }
}

const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
const fakeDoc: any = { getElementById: () => null }

describe('mjs_ujs — submit SANS fichier joint part en urlencoded', function () {
  it('formulaire sans fichier : µ.ajax.post reçoit une URLSearchParams avec les champs + submitter, zéro File', function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['titre', 'bonjour'], ['bio', 'salut']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts', 'POST')
    handler(makeEvent(form, { name: 'submit', value: 'ok' }), µ, win, fakeDoc, FD, URL)

    assert.ok(capturedPayload instanceof URLSearchParams,
      'AVANT le fix : µ.ajax.post recevait le FormData multipart brut — le serveur y répond 415')
    assert.equal(capturedPayload.get('titre'), 'bonjour')
    assert.equal(capturedPayload.get('bio'), 'salut')
    assert.equal(capturedPayload.get('submit'), 'ok', 'le champ du submitter doit être inclus')
    assert.equal(Array.from(capturedPayload.keys()).length, 3, 'aucune entrée en trop ni manquante')
  })

  it('formulaire AVEC fichier réellement joint (name non vide) : µ.ajax.post reçoit le FormData INCHANGÉ', function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['avatar', new FakeFile('a.png', 12345)], ['titre', 'bonjour']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts', 'POST')
    handler(makeEvent(form, { name: 'submit', value: 'ok' }), µ, win, fakeDoc, FD, URL)

    assert.ok(!(capturedPayload instanceof URLSearchParams),
      'un fichier réellement joint ne doit JAMAIS repartir en urlencoded')
    assert.ok(capturedPayload.get('avatar') instanceof FakeFile, 'le fichier doit rester porté par le FormData, inchangé')
    assert.equal(capturedPayload.get('avatar').name, 'a.png')
    assert.equal(capturedPayload.get('titre'), 'bonjour')
    assert.equal(capturedPayload.get('submit'), 'ok')
  })

  it("formulaire avec un <input type=file> laissé VIDE (name:'', size:0) : urlencoded, champ fichier OMIS", function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['avatar', new FakeFile('', 0)], ['titre', 'bonjour']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts', 'POST')
    handler(makeEvent(form), µ, win, fakeDoc, FD, URL)

    assert.ok(capturedPayload instanceof URLSearchParams,
      "AVANT le fix : un input file VIDE aurait quand même forcé du multipart (415 pour rien)")
    assert.equal(capturedPayload.get('avatar'), null, "le champ fichier vide doit être OMIS, pas sérialisé en '[object File]'")
    assert.equal(capturedPayload.get('titre'), 'bonjour')
    assert.equal(Array.from(capturedPayload.keys()).length, 1)
  })

  it('PUT sans fichier : même conversion urlencoded que POST', function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { put: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['titre', 'modifié']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts/42', 'PUT')
    handler(makeEvent(form), µ, win, fakeDoc, FD, URL)

    assert.ok(capturedPayload instanceof URLSearchParams, 'PUT sans fichier doit lui aussi repartir en urlencoded')
    assert.equal(capturedPayload.get('titre'), 'modifié')
  })

  it('PATCH sans fichier : même conversion urlencoded que POST', function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { patch: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['titre', 'rectifié']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts/42', 'PATCH')
    handler(makeEvent(form), µ, win, fakeDoc, FD, URL)

    assert.ok(capturedPayload instanceof URLSearchParams, 'PATCH sans fichier doit lui aussi repartir en urlencoded')
    assert.equal(capturedPayload.get('titre'), 'rectifié')
  })

  it('PUT AVEC fichier réellement joint : FormData INCHANGÉ (pas de conversion)', function () {
    let capturedPayload: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { put: (_url: string, payload: any, _success: any) => { capturedPayload = payload } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['avatar', new FakeFile('photo.jpg', 999)]])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts/42', 'PUT')
    handler(makeEvent(form), µ, win, fakeDoc, FD, URL)

    assert.ok(!(capturedPayload instanceof URLSearchParams), 'PUT avec fichier réel ne doit pas devenir urlencoded')
    assert.ok(capturedPayload.get('avatar') instanceof FakeFile)
  })

  it('DELETE : aucun corps transmis — chemin DELETE inchangé par la Modif A', function () {
    let deleteArgs: any[] = []
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { delete: (...args: any[]) => { deleteArgs = args } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const FD = seededFormDataClass([['titre', 'bonjour']])
    const handler = makeSubmitHandler(µ, win, fakeDoc, FD, URL, FakeDOMParserInerte, FakeFile)
    const form = makeForm('/posts/42', 'DELETE')
    handler(makeEvent(form), µ, win, fakeDoc, FD, URL)

    assert.equal(typeof deleteArgs[0], 'string', 'premier argument = url')
    assert.equal(typeof deleteArgs[1], 'function',
      "2e argument doit être le callback 'done' — jamais un payload/FormData/URLSearchParams")
  })
})

describe('mjs_ajax — _request : URLSearchParams transmise telle quelle', function () {
  function makeFakeResponse(opts: { status?: number, url: string, body: string, contentType?: string }) {
    const status = opts.status ?? 200
    return {
      status,
      url: opts.url,
      ok: status >= 200 && status < 300,
      headers: {
        get: (name: string) => {
          if (name === 'content-type') return opts.contentType ?? 'application/json'
          if (name === 'content-length') return String(opts.body.length)
          return null
        },
      },
      text: async () => opts.body,
      json: async () => JSON.parse(opts.body),
    }
  }

  it('options.data instanceof URLSearchParams : body transmis BRUT, Content-Type PAS forcé en application/json', async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    let capturedOpts: any
    const fakeFetch = async (_url: string, opts: any) => {
      capturedOpts = opts
      return makeFakeResponse({ url: 'https://x/posts', body: '{}' })
    }
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    const params = new URLSearchParams()
    params.append('titre', 'bonjour')

    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', params, () => resolve())
    })

    assert.equal(capturedOpts.body, params,
      "AVANT le fix : le else générique aurait forcé JSON.stringify(params) → corps '{}' (piège identifié)")
    assert.equal(capturedOpts.headers['Content-Type'], undefined,
      'fetch doit poser SEUL le Content-Type urlencoded — aucun forçage json ici')
  })
})
