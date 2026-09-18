// Régression : PRG (Post/Redirect/Get)
// cassé — `fetch` suit les redirections NATIVEMENT (`response.url` reflète la
// destination FINALE), mais ni `mjs_ajax.ts` ni `mjs_ujs.ts` n'exploitaient
// cette information. Un submit POST/PUT/PATCH/DELETE qui redirige côté
// serveur (cas standard : POST crée une ressource → redirige vers sa page)
// laissait la barre d'adresse bloquée sur l'endpoint de MUTATION d'origine —
// un F5 RE-SOUMETTRAIT alors le formulaire (boîte navigateur "confirmer la
// resoumission"), exactement ce que PRG existe pour éviter.
//
// Fix en 2 parties :
//   1. mjs_ajax.ts : `response.url` est désormais passé en 2e argument à
//      `success` (en plus du body) — rétrocompatible, les callbacks qui ne
//      lisent que le 1er argument sont inchangés.
//   2. mjs_ujs.ts : le `done` du handler `submit` met à jour `window.history`
//      (pushState) si `finalUrl` diffère de l'URL soumise — UNIQUEMENT pour
//      les méthodes MUTANTES (pas GET/HEAD, dont l'URL est déjà la requête).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function makeFakeResponse(opts: { status?: number, url: string, body: string, contentType?: string, headers?: Record<string, string> }) {
  const status = opts.status ?? 200
  return {
    status,
    url: opts.url,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return opts.contentType ?? 'text/html'
        if (name === 'content-length') return String(opts.body.length)
        if (opts.headers && Object.prototype.hasOwnProperty.call(opts.headers, name)) { return opts.headers[name] }
        return null
      },
    },
    text: async () => opts.body,
    json: async () => JSON.parse(opts.body),
  }
}

// conteneur MINIATURE avec de VRAIES sémantiques firstChild/removeChild (µ._mjs_zoneFill) ET
// replaceChildren (µ._mjs_zoneFill) — sert de `document.body` dans ce fichier (le
// chemin HTML n'a jamais de `target`, le contenant EST toujours <body>).
function makeContainer(initialChildren: any[] = []): any {
  const c: any = { children: initialChildren.slice() }
  Object.defineProperty(c, 'firstChild', { get: () => (c.children.length ? c.children[0] : null) })
  Object.defineProperty(c, 'childNodes', { get: () => c.children.slice() })
  c.removeChild = (node: any) => { const i = c.children.indexOf(node); if (i !== -1) { c.children.splice(i, 1) } return node }
  c.replaceChildren = (...nodes: any[]) => { c.children = nodes.slice() }
  return c
}

describe("mjs_ajax — response.url transmis au callback success (2e argument)", function () {
  it("µ.ajax.post : le callback reçoit (body, response.url)", async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = async (_url: string, _opts: any) =>
      makeFakeResponse({ url: 'https://x/posts/42', body: '<html><body id="app-root">ok</body></html>' })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let receivedUrl: any
    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', new FormData(), (_body: any, url: any) => { receivedUrl = url; resolve() })
    })

    assert.equal(
      receivedUrl, 'https://x/posts/42',
      "AVANT le fix : response.url n'était JAMAIS transmis au callback — impossible de détecter un redirect serveur",
    )
  })

  it("réponse non-2xx non-JSON (422 HTML) : options.error reçoit err.status/err.body/err.url (corps NON jeté)", async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = async () =>
      makeFakeResponse({ status: 422, url: 'https://x/posts', body: '<html>form + erreurs</html>', contentType: 'text/html' })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let err: any
    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', new FormData(), () => {}, (e: any) => { err = e; resolve() })
    })
    assert.equal(err.status, 422, 'AVANT le fix : le status et le corps étaient JETÉS (throw sans les lire)')
    assert.equal(err.body, '<html>form + erreurs</html>', 'le corps HTML du 422 est désormais attaché à l\'erreur')
    assert.equal(err.url, 'https://x/posts')
  })

  // La version de build voyage aussi sur le chemin d'ÉCHEC : une page d'erreur
  // HTML complète servie par un build plus récent doit pouvoir déclencher le rechargement
  // (l'en-tête n'était attaché qu'aux retours OK).
  it("réponse non-2xx : l'en-tête X-MJS-Version est attaché à l'erreur (chemin d'échec, JSON comme non-JSON)", async function () {
    for (const cas of [
      { contentType: 'text/html', body: '<html>form + erreurs</html>' },
      { contentType: 'application/json', body: '{"errors":{"email":"invalide"}}' },
    ]) {
      const µ: any = { log() {}, warn() {}, error() {} }
      const fakeDocument = { querySelector: () => null }
      const fakeFetch = async () =>
        makeFakeResponse({ status: 422, url: 'https://x/posts', body: cas.body, contentType: cas.contentType, headers: { 'X-MJS-Version': 'v9' } })
      new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

      let err: any
      await new Promise<void>((resolve) => {
        µ.ajax.post('https://x/posts', new FormData(), () => {}, (e: any) => { err = e; resolve() })
      })
      assert.equal(err.nav.version, 'v9', `chemin d'échec ${cas.contentType} : la version doit voyager comme sur le chemin de succès`)
    }
  })

  it("l'en-tête de réponse X-MJS-Version est transmis au callback success en 4e argument, objet { version, target, method, cache }", async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = async (_url: string, _opts: any) =>
      makeFakeResponse({ url: 'https://x/posts/42', body: '<html><body>ok</body></html>', headers: { 'X-MJS-Version': 'v7' } })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let receivedNav: any
    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', new FormData(), (_body: any, _url: any, _schemaNom: any, nav: any) => { receivedNav = nav; resolve() })
    })
    assert.deepEqual(receivedNav, { version: 'v7', target: null, method: null, cache: null, reload: null }, 'target/method/cache/reload à null : aucun en-tête X-MJS-Target/X-MJS-Method/X-MJS-Cache/X-MJS-Reload sur cette réponse')
  })

  it('en-têtes absents (serveur tiers muet) : le callback reçoit TOUJOURS un objet, chaque champ à null (jamais `null` lui-même), rétrocompatible', async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = async () => makeFakeResponse({ url: 'https://x/posts', body: '<html></html>' })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let receivedNav: any = 'INITIAL'
    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', new FormData(), (_body: any, _url: any, _schemaNom: any, nav: any) => { receivedNav = nav; resolve() })
    })
    assert.deepEqual(receivedNav, { version: null, target: null, method: null, cache: null, reload: null })
  })

  it('appelant à 2 paramètres (body, url) : aucune différence, rétrocompatible', async function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const fakeDocument = { querySelector: () => null }
    const fakeFetch = async () => makeFakeResponse({ url: 'https://x/posts', body: '<html></html>', headers: { 'X-MJS-Version': 'v7' } })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let receivedBody: any, receivedUrl: any
    await new Promise<void>((resolve) => {
      µ.ajax.post('https://x/posts', new FormData(), (body: any, url: any) => { receivedBody = body; receivedUrl = url; resolve() })
    })
    assert.equal(receivedBody, '<html></html>')
    assert.equal(receivedUrl, 'https://x/posts')
  })
})

describe("mjs_ujs — submit ajax : PRG (redirect POST→GET reflété dans l'URL)", function () {
  function extractSubmitBody(src: string): string {
    // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
    // — renommé, pont shadow fermé) : même corps, autre marqueur.
    return extractMarkedBody(src, '_mjs_ujsOnSubmit')
  }

  // µ._mjs_navDispatch (capacités @method/désactivation/µnav/abort/focus) :
  // le handler submit délègue désormais sa fin (dispatch ajax, PRG, 422,
  // invalidation cache — tout ce que CE fichier vérifie) à cette fonction
  // PARTAGÉE avec le lien mjs-method. Extraite + installée sur le MÊME µ,
  // avec les MÊMES window/document/FormData/URL/DOMParser que le handler lui
  // -même, pour que son `done`/`fail` y résolvent cohéremment.
  function extractNavDispatchStatement(src: string): string {
    return extractMarked(src, '_mjs_navDispatch')
  }

  // FormData FAKE : le vrai constructeur Node (undici) exige un <form> RÉEL
  // (introspecte .elements) — notre form est un simple objet, sans rapport
  // avec ce que ce test vérifie (le comportement PRG après résolution ajax,
  // pas la sérialisation des champs).
  class FakeFormData {
    private map = new Map<string, any>()
    append(k: string, v: any) { this.map.set(k, v) }
    get(k: string) { return this.map.get(k) }
    // itérable → `new URLSearchParams(fakeFormData)` sérialise proprement.
    *[Symbol.iterator]() { yield* this.map }
  }
  // DOMParser FAKE : ce test vérifie le comportement PRG (pushState) APRÈS
  // résolution ajax, pas le swap DOM du contenu — un doc sans body exploitable
  // suffit, la branche `if (newRoot && currentRoot)` sera simplement sautée
  // sans erreur.
  class FakeDOMParser {
    parseFromString() { return { body: null } }
  }
  // Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
  // contigus, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend désormais (le
  // chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout
  // donc toujours <body> ; µ.ajax.xxx remplacé par le canal interne
  // µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce
  // fichier continue de tourner (son INTENTION — le PRG post-redirect — est
  // inchangée).
  function extractHelpersBlock(src: string): string {
    return extractMarked(src, 'helpers-navigation')
  }
  function makeSubmitHandler(µ: any, win: any, doc: any, FormDataCtor: any, URLCtor: any, DOMParserCtor: any) {
    // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ;
    // ce fichier vérifie le PRG (pushState/_mjs_lastUjsPath) EXISTANT, jamais
    // l'en-tête X-MJS-Nav (hors périmètre ici) : on redirige simplement vers
    // le µ.ajax mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
    µ._mjs_ajaxRequest = function (opts: any) {
      const m = opts.method.toLowerCase()
      if (m === 'get' || m === 'delete') return µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
      return µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    }
    new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FormDataCtor, URLCtor, DOMParserCtor)
    const body = extractSubmitBody(UJS_SRC)
    return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', body)
  }

  function makeEvent(form: any, opts: { defaultPrevented?: boolean } = {}) {
    return {
      defaultPrevented: !!opts.defaultPrevented,
      preventDefault() { this.defaultPrevented = true },
      submitter: null,
      composedPath: () => [form],
      target: form,
    }
  }

  it("POST qui redirige (response.url différent) : window.history.pushState est appelé vers la destination FINALE", function () {
    const pushStateCalls: any[] = []
    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState: (...args: any[]) => pushStateCalls.push(args) },
    }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: {
        post: (_url: string, _payload: any, success: any) => { capturedSuccess = success },
      },
      _mjs_lastUjsPath: '/posts',
      // Requis par le fix voisin (invalidation cache après mutation, cf.
      // ujs-submit-cache-invalidation.test.ts) : le handler POST appelle
      // ces .clear() inconditionnellement, hors du périmètre de CE test.
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
      target: '',
      action: 'http://x/posts', // form.action (propriété DOM) est TOUJOURS absolue, contrairement à getAttribute('action')
      closest: () => form,
    }
    const fakeDoc: any = { getElementById: () => null }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)

    assert.ok(typeof capturedSuccess === 'function', 'µ.ajax.post doit avoir été appelé avec un callback success')
    // Simule la résolution du fetch : response.url = destination FINALE
    // (le serveur a redirigé POST /posts → GET /posts/42).
    capturedSuccess('<html><body id="app-root">créé</body></html>', 'http://x/posts/42')

    assert.equal(pushStateCalls.length, 1, "AVANT le fix : aucun pushState — la barre d'adresse restait bloquée sur /posts (endpoint POST)")
    assert.equal(pushStateCalls[0][2], 'http://x/posts/42')
    assert.equal(µ._mjs_lastUjsPath, '/posts/42', '_mjs_lastUjsPath doit aussi refléter la destination finale (cohérence avec pageCache/popstate)')
  })

  it("POST SANS redirect (response.url identique à l'URL soumise) : pas de pushState superflu", function () {
    const pushStateCalls: any[] = []
    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState: (...args: any[]) => pushStateCalls.push(args) },
    }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,   // le handler submit lit désormais µ._mjs_navSeq (jeton anti-course)
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      // Requis par le fix voisin (invalidation cache après mutation) : le
      // handler POST appelle ces .clear() inconditionnellement.
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
      target: '', action: 'http://x/posts', // form.action (propriété DOM) est TOUJOURS absolue, contrairement à getAttribute('action')
      closest: () => form,
    }
    const fakeDoc: any = { getElementById: () => null }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)

    // `response.url` est TOUJOURS absolue ; action='/posts' (relative).
    // Sans redirection, finalUrl absolu === URL(action) normalisée → PAS de pushState.
    capturedSuccess('<html><body id="app-root">validation échouée, ré-affiche le form</body></html>', 'http://x/posts')

    assert.equal(pushStateCalls.length, 0,
      "AVANT le fix : finalUrl ('http://x/posts') !== url ('/posts') était vrai à CHAQUE submit à action relative → pushState PARASITE même sans redirect")
  })

  it("formulaire GET : pousse l'URL AU GESTE, et le done ne rajoute PAS de pushState PRG", function () {
    const pushStateCalls: any[] = []
    const win: any = { location: { href: 'http://x/search', origin: 'http://x' }, history: { pushState: (...args: any[]) => pushStateCalls.push(args) } }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { get: (_url: string, success: any) => { capturedSuccess = success } },
      // getElementById → null (fakeDoc) : hibernation sautée, mais pageCache/_mjs_saveScroll
      // doivent exister au cas où (le handler les consulte).
      _mjs_lastUjsPath: '/search', pageCache: new Map(), _mjs_saveScroll() {},
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/search' : k === 'method' ? 'GET' : null),
      target: '', action: 'http://x/search',
      closest: () => form,
    }
    const fakeDoc: any = { getElementById: () => null }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)

    assert.equal(pushStateCalls.length, 1, "AVANT ce correctif : un form GET n'était JAMAIS bookmarkable (aucun pushState) — la barre restait figée sur l'URL d'avant la recherche")
    assert.equal(pushStateCalls[0][2], '/search', "l'URL GET sérialisée est poussée au geste (query incluse le cas échéant)")

    // Le done ne doit PAS rajouter un 2e pushState (le PRG done-pushState reste GET-exclu).
    capturedSuccess('<html><body id="app-root">résultats</body></html>', 'http://x/search?q=x')
    assert.equal(pushStateCalls.length, 1, "le done ne rajoute pas de pushState pour GET (l'URL a déjà été posée au geste)")
  })

  it("formulaire GET : après swap, _mjs_lastUjsPath reflète l'URL GET + page quittée hibernée (pageCache non empoisonné, tableau de nœuds)", function () {
    const pushStateCalls: any[] = []
    const win: any = { location: { href: 'http://x/list', origin: 'http://x' }, history: { pushState: (...args: any[]) => pushStateCalls.push(args) } }
    let capturedSuccess: any
    const oldContent: any = { tag: 'old-content', nodeType: 1 }
    const liveRoot = makeContainer([oldContent])
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { get: (_url: string, success: any) => { capturedSuccess = success } },
      _mjs_lastUjsPath: '/list', pageCache: new Map(), _mjs_saveScroll() {},
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/list' : k === 'method' ? 'GET' : null),
      target: '', action: 'http://x/list', closest: () => form,
    }
    // FakeFormData PRÉ-REMPLIE (un champ de filtre) : la sérialisation part dans l'URL GET.
    class FDField {
      private m = new Map<string, any>([['tri', 'prix']])
      append(k: string, v: any) { this.m.set(k, v) }
      get(k: string) { return this.m.get(k) }
      *[Symbol.iterator]() { yield* this.m }
    }
    const newRoot: any = { tag: 'new', nodeType: 1 }
    class DP { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    const fakeDoc: any = { body: liveRoot }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FDField, URL, DP)
    handler(makeEvent(form), µ, win, fakeDoc, FDField, URL, DP)

    assert.equal(pushStateCalls[0][2], '/list?tri=prix', 'URL GET sérialisée (query incluse) poussée au geste')
    // Array.from : on compare les NŒUDS hibernés, pas les métadonnées que l'hibernation pose sur le tableau
    // lui-même (_mjs_mjsCachePolicy en 'revalidate', _mjs_mjsHead pour la tête de page) — deepEqual de Node compare
    // aussi les propriétés propres au-delà des index, et échouerait sur une métadonnée interne sans rapport
    // avec ce que ce cas vérifie (la page quittée est bien archivée sous son ANCIENNE clé).
    assert.deepEqual(Array.from(µ.pageCache.get('/list')), [oldContent], "la page quittée (le TABLEAU de ses nœuds) est hibernée dans pageCache sous son ANCIENNE clé")
    assert.equal(oldContent._mjs_page_cached, true, 'hibernation : le nœud caché porte le flag _mjs_page_cached')

    capturedSuccess('<html>results</html>', 'http://x/list?tri=prix')
    assert.deepEqual(liveRoot.children, [newRoot], 'le contenu a bien été swappé (contenant <body> intact, contenu remplacé)')
    assert.equal(µ._mjs_lastUjsPath, '/list?tri=prix',
      "AVANT ce correctif : _mjs_lastUjsPath restait '/list' → le prochain clic archivait les résultats sous /list (pageCache empoisonné)")
  })

  it("submit POST échoue en 422 avec corps HTML : le formulaire ré-affiché est swappé + caches invalidés", function () {
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: () => {} } }
    let capturedError: any
    const liveRoot = makeContainer([{ tag: 'ancien-form', nodeType: 1 }])
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, _p: any, _success: any, error: any) => { capturedError = error } },
      _mjs_lastUjsPath: '/posts',
      pageCache: new Map([['/x', 1]]), _mjs_preloadCache: new Map([['/y', 1]]), _mjs_preloaded: new Set(['z']),
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
      target: '', action: 'http://x/posts', closest: () => form,
    }
    const newRoot: any = { tag: 'form-avec-erreurs', nodeType: 1 }
    class DP { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    const fakeDoc: any = { body: liveRoot }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, DP)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, DP)
    assert.ok(typeof capturedError === 'function', 'AVANT ce correctif : aucun callback error n\'était passé au POST')

    capturedError({ status: 422, body: '<html><body>form + erreurs</body></html>', url: 'http://x/posts' })
    assert.deepEqual(liveRoot.children, [newRoot], 'AVANT ce correctif : le 422 était avalé par mjs_ajax → submit muet (rien affiché)')
    assert.equal(µ.pageCache.size, 0, 'la mutation a pu aboutir avant le 422 → caches invalidés')
  })

  it("submit POST échoue en 500 sans corps HTML : caches invalidés + warn, pas de swap", function () {
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: () => {} } }
    let capturedError: any, warned = false
    const µ: any = {
      log() {}, warn() { warned = true }, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, _p: any, _success: any, error: any) => { capturedError = error } },
      _mjs_lastUjsPath: '/posts',
      pageCache: new Map([['/x', 1]]), _mjs_preloadCache: new Map([['/y', 1]]), _mjs_preloaded: new Set(['z']),
    }
    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
      target: '', action: 'http://x/posts', closest: () => form,
    }
    const fakeDoc: any = { getElementById: () => null }
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)

    capturedError({ status: 500, body: 'Internal Server Error' })
    assert.equal(warned, true, 'un échec non-HTML est tracé (warn) au lieu du silence')
    assert.equal(µ.pageCache.size, 0, "AVANT ce correctif : l'invalidation vivait dans `done` (jamais atteint sur échec) → caches périmés")
    assert.equal(µ._mjs_preloadCache.size, 0)
  })

  // ══════════════════════════════════════════════════════════════════════════
  // La garde de version n'existait QUE sur le
  // chemin JSON (json.version) : même règle désormais sur le chemin HTML, via
  // l'en-tête de réponse X-MJS-Version (4e argument success, cf. mjs_ajax.ts).
  // ══════════════════════════════════════════════════════════════════════════
  describe('mjs_ujs — submit ajax : version de build détectée sur les réponses HTML', function () {
    it("réponse HTML portant X-MJS-Version DIFFÉRENT de µ.version : window.location.assign, AUCUN swap de DOM", function () {
      const assignCalls: string[] = []
      const win: any = {
        location: { href: 'http://x/posts', origin: 'http://x', assign: (u: string) => assignCalls.push(u) },
        history: { pushState: () => { throw new Error('ne doit pas pousser : rechargement complet attendu') } },
      }
      let capturedSuccess: any
      const oldContent: any = { tag: 'old', nodeType: 1 }
      const liveRoot = makeContainer([oldContent])
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0, version: 'v2',
        ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      const form: any = {
        hasAttribute: () => false,
        getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
        target: '', action: 'http://x/posts', closest: () => form,
      }
      class DP { parseFromString() { throw new Error('ne doit jamais parser : version différente, sorti avant tout swap') } }
      const fakeDoc: any = { body: liveRoot }
      const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, DP)
      handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, DP)

      assert.ok(typeof capturedSuccess === 'function')
      capturedSuccess('<html><body>neuf</body></html>', 'http://x/posts', undefined, { version: 'v1-different', target: null, method: null })

      assert.deepEqual(assignCalls, ['http://x/posts'], 'version différente → rechargement complet vers la destination finale')
      assert.deepEqual(liveRoot.children, [oldContent], "AUCUN swap : le contenu affiché reste celui d'AVANT")
    })

    it("réponse HTML SANS en-tête de version (serveur tiers muet) : navigation normale, AUCUNE régression", function () {
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      let capturedSuccess: any
      const liveRoot = makeContainer([{ tag: 'old', nodeType: 1 }])
      const newRoot: any = { tag: 'neuf', nodeType: 1 }
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0, version: 'v2',
        ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      const form: any = {
        hasAttribute: () => false,
        getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
        target: '', action: 'http://x/posts', closest: () => form,
      }
      class DP { parseFromString() { return { body: { childNodes: [newRoot] } } } }
      const fakeDoc: any = { body: liveRoot }
      const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, DP)
      handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, DP)

      assert.ok(typeof capturedSuccess === 'function')
      capturedSuccess('<html><body>neuf</body></html>', 'http://x/posts') // pas de 4e argument : en-tête absent

      assert.deepEqual(liveRoot.children, [newRoot], "en-tête absent : swap normal, comme un serveur tiers qui ne connaît pas le protocole")
    })

    // Le chemin d'ÉCHEC (4xx dont le corps
    // est une page HTML complète, ré-affichée par `done`) perdait la version : mjs_ajax
    // n'attachait pas l'en-tête à l'objet Error, et `fail` rappelait `done(body, url)` sans
    // 4e argument. Un client à bundle périmé recevant une page d'erreur complète n'était donc
    // jamais rechargé, contrairement au chemin de succès.
    it('4xx dont le corps est une page HTML complète : la version portée par l\'erreur déclenche le rechargement', function () {
      const assignCalls: string[] = []
      const win: any = {
        location: { href: 'http://x/posts', origin: 'http://x', assign: (u: string) => assignCalls.push(u) },
        history: { pushState() {} },
      }
      let capturedError: any
      const oldContent: any = { tag: 'ancien-form', nodeType: 1 }
      const liveRoot = makeContainer([oldContent])
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0, version: 'v2',
        ajax: { post: (_url: string, _p: any, _success: any, error: any) => { capturedError = error } },
        _mjs_lastUjsPath: '/posts',
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      const form: any = {
        hasAttribute: () => false,
        getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
        target: '', action: 'http://x/posts', closest: () => form,
      }
      class DP { parseFromString() { throw new Error('ne doit jamais parser : version différente, sortie avant tout swap') } }
      const fakeDoc: any = { body: liveRoot }
      const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, DP)
      handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, DP)

      assert.ok(typeof capturedError === 'function')
      capturedError({ status: 422, body: '<html><body>formulaire re-affiche par un build plus recent</body></html>', url: 'http://x/posts', nav: { version: 'v1-different', target: null, method: null } })

      assert.deepEqual(assignCalls, ['http://x/posts'], 'version différente ⇒ rechargement complet, même sur le chemin d\'échec')
      assert.deepEqual(liveRoot.children, [oldContent], 'AUCUN swap du formulaire ré-affiché')
    })
  })
})
