// Régression : après une mutation
// (POST/PUT/PATCH/DELETE) réussie, µ.pageCache et µ._mjs_preloadCache restaient
// figés au contenu lu AVANT la mutation. Exemple concret : DELETE d'un post
// depuis sa page de détail, puis retour vers `/posts` — si `/posts` est
// encore en cache (visitée juste avant), le post supprimé y restait listé
// indéfiniment (contenu obsolète resservi depuis le cache, aucun nouveau
// fetch déclenché).
//
// Fix en 2 parties :
//   1. mjs_ujs.ts : le `done` du handler `submit` vide pageCache/
//      preloadCache/preloaded pour toute méthode MUTANTE (pas GET/HEAD),
//      sur succès uniquement (jamais appelé en cas d'erreur réseau/HTTP —
//      `done` EST le callback success, jamais error).
//   2. mjs_page_cache.ts : LRUCache.delete()/clear() bypassaient onEvict (appel
//      direct à this._map.delete/clear) — prérequis du fix ci-dessus : sans
//      lui, vider pageCache aurait abandonné ses arbres DOM hibernés SANS
//      lancer leur teardown, fuite de timers identique à celle que onEvict
//      existe déjà pour empêcher lors d'une éviction LRU naturelle (set()).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')

function extractLRUCacheStatement(src: string): string {
  return extractMarked(src, 'LRUCache')
}

function makeLRUCache(): any {
  const µ: any = { warn() {} }
  new Function('µ', extractLRUCacheStatement(PAGE_CACHE_SRC))(µ)
  return µ.LRUCache
}

const LRUCache = makeLRUCache()

describe("mjs_page_cache — LRUCache.delete()/clear() déclenchent onEvict", function () {
  it("delete() déclenche onEvict avec (clé, valeur) et retourne true", function () {
    const cache = new LRUCache(10)
    const evicted: any[] = []
    cache.onEvict = (k: any, v: any) => evicted.push([k, v])
    cache.set('a', 1)
    const had = cache.delete('a')
    assert.equal(had, true)
    assert.equal(evicted.length, 1, "AVANT le fix : delete() appelait this._map.delete() direct, jamais onEvict")
    assert.deepEqual(evicted[0], ['a', 1])
    assert.equal(cache.has('a'), false)
  })

  it("delete() sur une clé absente : pas d'onEvict, retourne false", function () {
    const cache = new LRUCache(10)
    const evicted: any[] = []
    cache.onEvict = (k: any, v: any) => evicted.push([k, v])
    const had = cache.delete('absente')
    assert.equal(had, false)
    assert.equal(evicted.length, 0)
  })

  it("clear() déclenche onEvict pour CHAQUE entrée puis vide le cache", function () {
    const cache = new LRUCache(10)
    const evicted: any[] = []
    cache.onEvict = (k: any, v: any) => evicted.push([k, v])
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    cache.clear()
    assert.equal(evicted.length, 3, "AVANT le fix : clear() appelait this._map.clear() direct, aucun onEvict")
    assert.deepEqual(evicted.map((e) => e[0]).sort(), ['a', 'b', 'c'])
    assert.equal(cache.size, 0)
  })

  it("onEvict absent : clear()/delete() restent silencieux (pas de crash)", function () {
    const cache = new LRUCache(10)
    cache.set('a', 1)
    assert.doesNotThrow(() => cache.clear())
    assert.equal(cache.size, 0)
  })
})

// µ.pageCache mémorise désormais un TABLEAU de nœuds (les enfants pris au contenant via
// photographie de childNodes), pas un élément unique : son onEvict (mjs_ujs.ts) doit itérer ce tableau et
// appeler µ._mjs_destroyEvictedTree sur CHAQUE nœud ÉLÉMENT (texte/commentaire ignorés), tout en
// restant tolérant si la valeur est un élément seul (défense, ancien format).
function extractPageCacheOnEvictStatements(src: string): string {
  return extractMarked(src, 'pageCache-init') + '\n' + extractMarked(src, 'pageCache-onEvict')
}

describe("mjs_ujs — µ.pageCache.onEvict : itère un TABLEAU de nœuds", function () {
  it('éviction LRU en mode contenant : µ._mjs_destroyEvictedTree appelé sur CHAQUE nœud ÉLÉMENT du tableau évincé (texte ignoré)', function () {
    const destroyed: any[] = []
    const µ: any = { LRUCache, _mjs_destroyEvictedTree: (n: any) => destroyed.push(n) }
    new Function('µ', extractPageCacheOnEvictStatements(UJS_SRC))(µ)
    // borne à 10 (défaut, cf. source) : 11 entrées → la plus ancienne (/page0) est évincée.
    for (let i = 0; i < 11; i++) {
      const el1: any = { nodeType: 1, tag: 'el1-' + i }
      const txt: any = { nodeType: 3, data: 'texte' }
      µ.pageCache.set('/page' + i, [el1, txt])
    }
    assert.equal(destroyed.length, 1, 'un seul nœud détruit (un seul nœud ÉLÉMENT dans l\'entrée évincée, le texte est ignoré)')
    assert.equal(destroyed[0].tag, 'el1-0', "l'entrée la plus ancienne (/page0) est celle évincée")
  })

  it('défense : valeur ancien format (élément SEUL, pas un tableau) reste tolérée', function () {
    const destroyed: any[] = []
    const µ: any = { LRUCache, _mjs_destroyEvictedTree: (n: any) => destroyed.push(n) }
    new Function('µ', extractPageCacheOnEvictStatements(UJS_SRC))(µ)
    const soleEl: any = { nodeType: 1, tag: 'seul' }
    µ.pageCache.set('/p0', soleEl)
    for (let i = 1; i < 11; i++) { µ.pageCache.set('/p' + i, [{ nodeType: 1, tag: 'x' + i }]) }
    assert.equal(destroyed.length, 1)
    assert.equal(destroyed[0], soleEl)
  })
})

describe("mjs_ujs — submit ajax : invalidation pageCache/preloadCache après mutation", function () {
  function extractSubmitBody(src: string): string {
    // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
    // — renommé, pont shadow fermé) : même corps, autre marqueur.
    return extractMarkedBody(src, '_mjs_ujsOnSubmit')
  }

  // FormData/DOMParser FAKES : mêmes raisons que ujs-submit-prg-redirect.test.ts
  // (le vrai FormData Node exige un <form> réel ; ces tests portent sur
  // l'invalidation de cache après résolution ajax, pas sur la sérialisation
  // des champs ni le swap DOM).
  class FakeFormData {
    private map = new Map<string, any>()
    append(k: string, v: any) { this.map.set(k, v) }
    get(k: string) { return this.map.get(k) }
  }
  class FakeDOMParser {
    parseFromString() { return { body: null } }
  }
  // µ._mjs_navDispatch (capacités @method/désactivation/µnav/abort/focus) :
  // le handler submit délègue désormais sa fin (dispatch ajax + invalidation
  // cache — ce que CE fichier vérifie) à cette fonction PARTAGÉE avec le lien
  // mjs-method. Extraite + installée sur le MÊME µ, mêmes window/document/
  // FormData/URL/DOMParser que le handler lui-même.
  function extractNavDispatchStatement(src: string): string {
    return extractMarked(src, '_mjs_navDispatch')
  }
  // Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
  // contigus, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend désormais (le
  // chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout
  // donc toujours <body> ; µ.ajax.xxx remplacé par le canal interne
  // µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce
  // fichier continue de tourner (son INTENTION — l'invalidation pageCache/
  // _mjs_preloadCache après mutation — est inchangée).
  function extractHelpersBlock(src: string): string {
    return extractMarked(src, 'helpers-navigation')
  }
  function makeSubmitHandler(µ: any, win: any, doc: any, FormDataCtor: any, URLCtor: any, DOMParserCtor: any) {
    // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ;
    // ce fichier vérifie l'invalidation de cache EXISTANTE, jamais l'en-tête
    // X-MJS-Nav (hors périmètre ici) : on redirige simplement vers le µ.ajax
    // mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
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
  function makeEvent(form: any) {
    return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter: null, composedPath: () => [form], target: form }
  }
  // form.action (propriété DOM) est TOUJOURS absolue, contrairement à
  // getAttribute('action') — cf. tests/ujs-submit-prg-redirect.test.ts.
  function makeForm(method: string, action: string) {
    return {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? action : k === 'method' ? method : null),
      target: '',
      action,
      closest: function (this: any) { return this },
    }
  }
  const win: any = { location: { href: 'http://x/posts/42', origin: 'http://x' }, history: { pushState() {} } }
  const fakeDoc: any = { getElementById: () => null }

  it("DELETE réussi (204, body null) : vide pageCache, _mjs_preloadCache et _mjs_preloaded", function () {
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { delete: (_url: string, success: any) => { capturedSuccess = success } },
      pageCache: new Map([['a', {}], ['b', {}]]),
      _mjs_preloadCache: new Map([['http://x/other', '<html></html>']]),
      _mjs_preloaded: new Set(['page:http://x/other']),
    }
    const form = makeForm('DELETE', 'http://x/posts/42')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)

    assert.ok(typeof capturedSuccess === 'function', 'µ.ajax.delete doit avoir été appelé avec un callback success')
    capturedSuccess(null, 'http://x/posts/42') // 204 No Content : mjs_ajax.ts passe `null`, pas ''

    assert.equal(µ.pageCache.size, 0, "AVANT le fix : pageCache n'était JAMAIS invalidé après une mutation")
    assert.equal(µ._mjs_preloadCache.size, 0, "AVANT le fix : _mjs_preloadCache n'était JAMAIS invalidé après une mutation")
    assert.equal(µ._mjs_preloaded.size, 0, "AVANT le fix : _mjs_preloaded n'était JAMAIS invalidé après une mutation")
  })

  it("POST réussi SANS redirect : invalide aussi le cache (pas seulement le chemin PRG)", function () {
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      pageCache: new Map([['/posts', {}]]),
      _mjs_preloadCache: new Map([['http://x/other', 'html']]),
      _mjs_preloaded: new Set(['x']),
    }
    const form = makeForm('POST', 'http://x/comments')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    capturedSuccess('<html><body id="app-root">ok</body></html>', 'http://x/comments')

    assert.equal(µ.pageCache.size, 0)
    assert.equal(µ._mjs_preloadCache.size, 0)
    assert.equal(µ._mjs_preloaded.size, 0)
  })

  it("formulaire GET : ne touche PAS aux caches (hors périmètre — rien n'a muté côté serveur)", function () {
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { get: (_url: string, success: any) => { capturedSuccess = success } },
      pageCache: new Map([['/posts', {}]]),
      _mjs_preloadCache: new Map([['http://x/other', 'html']]),
      _mjs_preloaded: new Set(['x']),
    }
    const form = makeForm('GET', 'http://x/search')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    capturedSuccess('<html><body id="app-root">résultats</body></html>', 'http://x/search?q=x')

    assert.equal(µ.pageCache.size, 1, "un formulaire GET ne doit jamais invalider le cache (pas une mutation)")
    assert.equal(µ._mjs_preloadCache.size, 1)
    assert.equal(µ._mjs_preloaded.size, 1)
  })

  it("bout-en-bout : invalider un VRAI LRUCache pageCache lance le teardown des arbres hibernés (pas de fuite)", function () {
    const pageCache = new LRUCache(10)
    const destroyed: any[] = []
    pageCache.onEvict = function (_path: any, root: any) { destroyed.push(root); root._mjs_runDestroyCallbacks() }
    const hibernatedRoot = { isConnected: false, _mjs_runDestroyCallbacks() { this._destroyed = true } }
    pageCache.set('/posts', hibernatedRoot)

    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      ajax: { delete: (_url: string, success: any) => { capturedSuccess = success } },
      pageCache, _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const form = makeForm('DELETE', 'http://x/posts/42')
    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    handler(makeEvent(form), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParser)
    capturedSuccess(null, 'http://x/posts/42')

    assert.equal(destroyed.length, 1, "le pageCache doit être vidé via un chemin qui déclenche onEvict (pas this._map.clear() direct)")
    assert.equal(hibernatedRoot._destroyed, true, "sans le fix LRUCache.clear()→onEvict, l'arbre hiberné évincé fuirait ses timers")
  })
})
