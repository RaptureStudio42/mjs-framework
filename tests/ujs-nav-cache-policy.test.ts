// Politique de cache par page (`cache-first`/`revalidate`/`no-cache`) et événement
// `mjs:before-cache`. Couvre :
//   1. µ._mjs_navCachePolicyOf — normalisation partagée (même patron que µ._mjs_navMethodOf).
//   2. µ._mjs_navCacheOf — précédence en-tête > balise <meta name="mjs-cache"> > défaut, balise lue
//      dans le document REÇU (jamais document.head).
//   3. µ._mjs_navHibernate — 'no-cache' n'archive rien (mais sauvegarde quand même le scroll) ;
//      'revalidate' marque l'entrée (propriété portée par le tableau de nœuds).
//   4. Événement before-cache — émis une fois par hibernation, jamais en 'no-cache', enveloppé.
//   5. µ._mjs_navRevalidate — fetch SANS X-MJS-Nav, comparaison version puis innerHTML, stale ignoré.
//   6. Bout-en-bout (clic) : wiring JSON cache:'no-cache' et cache-hit → µ._mjs_navRevalidate.
//
// Méthode : mêmes techniques d'extraction que les fichiers voisins (tests/ujs-nav-cache-zone.test.ts,
// tests/ujs-nav-target-method-html.test.ts, tests/ujs-nav-method-append.test.ts, tests/ujs-noujs-optout.test.ts)
// — lecture de la SOURCE réelle, `new Function`, jamais de compilation ni de happy-dom. µ._mjs_navRevalidate
// utilise `new DOMParser()` (comme les 3 sites de swap HTML) : DÉFINI dans le bloc helpers contigu
// (extractHelpersBlock, sans DOMParser), donc RE-extrait seul avec DOMParser injecté avant tout appel
// direct (cf. installRevalidate) — même besoin que µ._mjs_navDispatch dans les fichiers voisins.

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
// µ._mjs_navRevalidate vit DANS le bloc helpers ci-dessus (donc déjà défini par installHelpers), mais SANS
// DOMParser en portée (installHelpers ne le fournit pas, comme le bloc réel côté navigateur — DOMParser
// y est un global). Réassignation CIBLÉE : même fonction, DOMParser injecté, pour les tests qui
// l'invoquent réellement (les autres helpers du même `µ` ne bougent pas).
// µ._mjs_navRevalidate compare l'URL RÉELLEMENT servie (redirection suivie) à celle demandée :
// il lui faut donc une base pour résoudre les URL relatives, comme tout code navigateur.
const WIN_REVAL: any = { location: { href: 'http://x/' } }
function installRevalidate(µ: any, window: any, document: any, DOMParserCtor: any) {
  new Function('µ', 'window', 'document', 'DOMParser', extractMarked(UJS_SRC, '_mjs_navRevalidate'))(µ, window, document, DOMParserCtor)
}
function extractAjaxGetStatement(src: string): string {
  return extractMarked(src, '_mjs_ajaxGet')
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}

// Nœud FAKE réaliste (même forme que tests/ujs-nav-method-append.test.ts) + `innerHTML` réglable à la
// main (µ._mjs_navRevalidate le compare tel quel, jamais un arbre DOM).
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
    replaceWith(...nodes: any[]) { node.replacedBy = nodes },
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
// document AVEC addEventListener/dispatchEvent (avant-cache) — CustomEvent réel (global Node ≥ 19).
function makeEventDoc(body: any) {
  const listeners: Array<(e: any) => void> = []
  return {
    body,
    querySelector: (sel: string) => body.querySelector(sel),
    createElement: (tag: string) => makeNode(tag),
    addEventListener(_type: string, fn: (e: any) => void) { listeners.push(fn) },
    dispatchEvent(e: any) { listeners.forEach((fn) => fn(e)); return true },
  }
}
function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}

describe('mjs_ujs — µ._mjs_navCachePolicyOf : normalisation de la politique de cache', function () {
  it("'cache-first'/'revalidate'/'no-cache' inchangés ; absent/vide → 'cache-first'", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navCachePolicyOf('cache-first'), 'cache-first')
    assert.equal(µ._mjs_navCachePolicyOf('revalidate'), 'revalidate')
    assert.equal(µ._mjs_navCachePolicyOf('no-cache'), 'no-cache')
    assert.equal(µ._mjs_navCachePolicyOf(null), 'cache-first')
    assert.equal(µ._mjs_navCachePolicyOf(undefined), 'cache-first')
    assert.equal(µ._mjs_navCachePolicyOf(''), 'cache-first')
  })

  it("valeur inconnue → 'cache-first' + avertissement UNE FOIS PAR VALEUR distincte (pas par appel)", function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(makeNode('body')), {})

    assert.equal(µ._mjs_navCachePolicyOf('osef'), 'cache-first')
    assert.equal(µ._mjs_navCachePolicyOf('osef'), 'cache-first')
    assert.equal(µ._mjs_navCachePolicyOf('autre'), 'cache-first')

    assert.equal(warnCalls.length, 2, 'une fois par VALEUR distincte : osef puis autre — 3 appels, 2 avertissements')
    assert.match(warnCalls[0][0], /osef/)
    assert.match(warnCalls[0][0], /inconnu/)
    assert.match(warnCalls[0][0], /cache-first/)
    assert.match(warnCalls[1][0], /autre/)
  })
})

describe('mjs_ujs — µ._mjs_navCacheOf : précédence en-tête > balise > défaut', function () {
  it("en-tête présent : prime sur la balise, même si elle dit autre chose", function () {
    const meta = { getAttribute: (k: string) => (k === 'content' ? 'no-cache' : null) }
    const respDoc: any = { querySelector: (sel: string) => (sel.indexOf('mjs-cache') !== -1 ? meta : null) }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navCacheOf(respDoc, 'revalidate'), 'revalidate')
  })

  it("en-tête absent (ou vide), balise <meta name=\"mjs-cache\"> présente dans le document REÇU : la balise gagne", function () {
    const meta = { getAttribute: (k: string) => (k === 'content' ? 'no-cache' : null) }
    const respDoc: any = { querySelector: (sel: string) => (sel.indexOf('mjs-cache') !== -1 ? meta : null) }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navCacheOf(respDoc, null), 'no-cache')
    assert.equal(µ._mjs_navCacheOf(respDoc, ''), 'no-cache', "en-tête VIDE compte comme absent")
  })

  it("balise présente SEULEMENT dans le document.head de la page COURANTE (jamais le document reçu) : AUCUN effet", function () {
    const metaDansLaPageCourante = { getAttribute: (k: string) => (k === 'content' ? 'no-cache' : null) }
    // `document` = la page COURANTE : si µ._mjs_navCacheOf le lisait par erreur (au lieu de son paramètre
    // `doc`, le document REÇU), il trouverait cette balise et retournerait 'no-cache' — bogue silencieux
    // écarté par conception (MJS ne fusionne pas les <head> au swap).
    const liveDocument: any = { body: makeNode('body'), querySelector: (sel: string) => (sel.indexOf('mjs-cache') !== -1 ? metaDansLaPageCourante : null) }
    const µ: any = baseMu()
    installHelpers(µ, liveDocument, {})
    // le document REÇU (une vraie réponse parsée) n'a PAS la balise.
    const respDoc: any = { querySelector: () => null }
    assert.equal(µ._mjs_navCacheOf(respDoc, null), 'cache-first', "seul le document REÇU est consulté — la balise de la page courante n'a aucun effet")
  })

  it("en-tête et balise absents des deux côtés : 'cache-first'", function () {
    const respDoc: any = { querySelector: () => null }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navCacheOf(respDoc, null), 'cache-first')
  })

  it("doc sans querySelector (harnais minimal) : repli sûr sur l'en-tête, ou 'cache-first' à défaut", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navCacheOf({ body: null }, 'revalidate'), 'revalidate')
    assert.equal(µ._mjs_navCacheOf({ body: null }, null), 'cache-first')
  })
})

describe("mjs_ujs — µ._mjs_navHibernate : policy 'no-cache'", function () {
  it("aucune entrée pageCache, aucun flag _mjs_page_cached, µ._mjs_navHibernated reste null — le scroll est SAUVEGARDÉ quand même", function () {
    const zone = makeNode('body')
    const child = makeNode('page-a-content')
    zone.appendChild(child)
    const savedScrolls: string[] = []
    const µ: any = baseMu({ pageCache: new Map(), _mjs_saveScroll: (p: string) => savedScrolls.push(p) })
    installHelpers(µ, makeEventDoc(makeNode('body')), {})
    µ._mjs_navCachePolicy = 'no-cache'

    µ._mjs_navHibernate(zone, '/a')

    assert.equal(µ.pageCache.size, 0, 'aucune entrée pageCache créée')
    assert.equal(child._mjs_page_cached, undefined, 'aucun flag posé sur le nœud')
    assert.equal(µ._mjs_navHibernated, null, 'µ._mjs_navHibernated reste null')
    assert.deepEqual(savedScrolls, ['/a'], "_mjs_saveScroll tourne quand même (Map indépendante du LRU pageCache)")
  })
})

describe("mjs_ujs — µ._mjs_navHibernate : policy 'revalidate' marque l'entrée", function () {
  it("l'entrée pageCache est créée normalement ET le tableau de nœuds porte _mjs_mjsCachePolicy", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('page-a-content'))
    const µ: any = baseMu({ pageCache: new Map() })
    installHelpers(µ, makeEventDoc(makeNode('body')), {})
    µ._mjs_navCachePolicy = 'revalidate'

    µ._mjs_navHibernate(zone, '/a')

    assert.equal(µ.pageCache.has('/a'), true)
    const stored = µ.pageCache.get('/a')
    assert.equal(stored._mjs_mjsCachePolicy, 'revalidate', 'la politique voyage AVEC le tableau de nœuds, jamais une structure séparée')
    assert.ok(µ._mjs_navHibernated && µ._mjs_navHibernated.path === '/a')
  })

  it("'cache-first' (défaut) : l'entrée ne porte AUCUNE marque _mjs_mjsCachePolicy — comportement historique", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('page-a-content'))
    const µ: any = baseMu({ pageCache: new Map() })
    installHelpers(µ, makeEventDoc(makeNode('body')), {})
    // µ._mjs_navCachePolicy reste null (posé par installHelpers) ⇒ repli 'cache-first'

    µ._mjs_navHibernate(zone, '/a')

    assert.equal(µ.pageCache.has('/a'), true)
    assert.equal(µ.pageCache.get('/a')._mjs_mjsCachePolicy, undefined)
  })
})

describe('mjs_ujs — événement mjs:before-cache', function () {
  it('émis UNE FOIS par hibernation, avec path et zone justes, bubbles/cancelable corrects', function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('x'))
    const events: any[] = []
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:before-cache', (e: any) => events.push(e))
    const µ: any = baseMu({ pageCache: new Map() })
    installHelpers(µ, doc, {})

    µ._mjs_navHibernate(zone, '/a')

    assert.equal(events.length, 1)
    assert.equal(events[0].type, 'mjs:before-cache')
    assert.equal(events[0].detail.path, '/a')
    assert.equal(events[0].detail.zone, zone)
    assert.equal(events[0].bubbles, true)
    assert.equal(events[0].cancelable, false)
  })

  it("PAS émis quand la politique est 'no-cache' (rien n'est archivé, rien à nettoyer)", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('x'))
    const events: any[] = []
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:before-cache', (e: any) => events.push(e))
    const µ: any = baseMu({ pageCache: new Map() })
    installHelpers(µ, doc, {})
    µ._mjs_navCachePolicy = 'no-cache'

    µ._mjs_navHibernate(zone, '/a')

    assert.equal(events.length, 0)
  })

  it("un écouteur qui JETTE n'empêche pas la mise en cache", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('x'))
    const doc = makeEventDoc(makeNode('body'))
    doc.addEventListener('mjs:before-cache', () => { throw new Error('boom') })
    const µ: any = baseMu({ pageCache: new Map() })
    installHelpers(µ, doc, {})

    assert.doesNotThrow(() => µ._mjs_navHibernate(zone, '/a'))
    assert.equal(µ.pageCache.has('/a'), true, "pageCache.set a bien eu lieu malgré l'écouteur qui jette")
  })
})

describe('mjs_ujs — µ._mjs_navRevalidate : rafraîchissement en fond', function () {
  it("fetch SANS en-tête X-MJS-Nav — la comparaison porte sur du HTML, pas le protocole JSON de mjs serve", function () {
    const zone = makeNode('body')
    const captured: any[] = []
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { captured.push(opts); return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    installRevalidate(µ, WIN_REVAL, makeDoc(makeNode('body')), class {})

    µ._mjs_navRevalidate(zone, '/a')

    assert.equal(captured.length, 1)
    assert.equal(captured[0].method, 'GET')
    assert.equal(captured[0].url, '/a')
    assert.ok(!captured[0].headers, "aucun en-tête posé ici — µ._mjs_navRequest (qui poserait X-MJS-Nav) N'EST PAS utilisé")
  })

  it("réponse IDENTIQUE (même innerHTML du contenant) : le DOM affiché n'est PAS touché", function () {
    const zone = makeNode('body')
    const original = makeNode('original-content')
    zone.appendChild(original)
    zone.innerHTML = '<p>contenu</p>'
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    const respBody = makeNode('body')
    respBody.innerHTML = '<p>contenu</p>' // IDENTIQUE au contenant affiché
    respBody.appendChild(makeNode('jamais-installe')) // si un swap avait lieu, ceci apparaîtrait dans zone
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, WIN_REVAL, makeDoc(makeNode('body')), DP)

    µ._mjs_navRevalidate(zone, '/a')
    assert.ok(typeof success === 'function', 'la requête de fond doit être partie')
    success('<html>ignoré</html>', '/a', undefined, { version: null, target: null, method: null, cache: null })

    assert.deepEqual(zone.children, [original], "innerHTML identique ⇒ aucun remplacement, l'enfant d'origine reste seul")
  })

  it("réponse DIFFÉRENTE : le contenu affiché est remplacé par celui de la réponse", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('original-content'))
    zone.innerHTML = '<p>ancien</p>'
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    const respBody = makeNode('body')
    respBody.innerHTML = '<p>nouveau</p>' // DIFFÉRENT
    const fresh = makeNode('fresh-content')
    respBody.appendChild(fresh)
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, WIN_REVAL, makeDoc(makeNode('body')), DP)

    µ._mjs_navRevalidate(zone, '/a')
    success('<html>ignoré</html>', '/a', undefined, { version: null, target: null, method: null, cache: null })

    assert.deepEqual(zone.children, [fresh], 'contenu remplacé par celui de la réponse')
  })

  it("X-MJS-Version différent : remplacé même si innerHTML identique (signature PRIORITAIRE, pas de comparaison HTML)", function () {
    const zone = makeNode('body')
    zone.appendChild(makeNode('original'))
    zone.innerHTML = '<p>contenu</p>'
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, version: 'aaaa1111', _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    const respBody = makeNode('body')
    respBody.innerHTML = '<p>contenu</p>' // identique en apparence
    const fresh = makeNode('fresh')
    respBody.appendChild(fresh)
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, WIN_REVAL, makeDoc(makeNode('body')), DP)

    µ._mjs_navRevalidate(zone, '/a')
    success('<html>ignoré</html>', '/a', undefined, { version: 'bbbb2222', target: null, method: null, cache: null })

    assert.deepEqual(zone.children, [fresh], "version différente ⇒ remplacé sans même comparer le HTML")
  })

  it("navigation ailleurs pendant le vol (µ._mjs_navSeq bumpé) : la réponse tardive est IGNORÉE", function () {
    const zone = makeNode('body')
    const original = makeNode('original')
    zone.appendChild(original)
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    const respBody = makeNode('body')
    respBody.appendChild(makeNode('fresh'))
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, WIN_REVAL, makeDoc(makeNode('body')), DP)

    µ._mjs_navRevalidate(zone, '/a')
    µ._mjs_navSeq++ // une navigation a eu lieu entre-temps (clic/popstate/submit, réutilise le jeton existant)
    success('<html>ignoré</html>', '/a', undefined, { version: null, target: null, method: null, cache: null })

    assert.deepEqual(zone.children, [original], 'réponse tardive jetée : le contenant garde son enfant, jamais touché')
  })
})

describe('mjs_ujs — bout-en-bout (clic, protocole JSON) : wiring cache:"no-cache"', function () {
  it("json.cache:'no-cache' → µ._mjs_navCachePolicy suit la page installée → au départ suivant, RIEN n'est archivé", function () {
    const body = makeNode('body')
    body.appendChild(makeNode('page-a-content'))
    const doc = makeDoc(body)
    const win: any = {
      location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' },
      history: { pushState() {} },
      scrollTo() {},
    }
    const capturedAjax: any[] = []
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: new Map(),
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {},
      _mjs_ajaxRequest: (opts: any) => { capturedAjax.push(opts); return Promise.resolve() },
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      Router: { navigate() {} },
      paths: { b: 'yyy.js' },
    })
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    function makeLink(dest: string) {
      return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: dest, search: '', hash: '', href: 'http://x' + dest, closest: function (this: any) { return this } }
    }
    function makeClickEvent(link: any) {
      return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }
    }

    // 1er clic : A → B, la fiche déclare cache:'no-cache' pour B.
    clickHandler(makeClickEvent(makeLink('/b')), µ, win, doc, class {})
    assert.equal(capturedAjax.length, 1)
    capturedAjax[0].success({ module: 'mjs-b', props: {}, method: 'update', cache: 'no-cache', url: '/b', title: null, version: undefined }, '/b')

    assert.equal(µ._mjs_navCachePolicy, 'no-cache', "la politique de B (page qui vient de s'installer) est mémorisée")
    assert.equal(µ.pageCache.has('/a'), true, 'A, qui ne déclarait rien, a bien été archivée à son départ (comportement inchangé)')

    // 2e clic : B → C — B est la page qu'on QUITTE, elle ne doit RIEN archiver.
    win.location = { pathname: '/b', search: '', origin: 'http://x', href: 'http://x/b', hash: '' }
    clickHandler(makeClickEvent(makeLink('/c')), µ, win, doc, class {})

    assert.equal(µ.pageCache.has('/b'), false, "B (installée avec cache:'no-cache') n'a créé AUCUNE entrée en la quittant")
    assert.equal(body.children.some((c: any) => c._mjs_page_cached === true), false, 'aucun nœud ne porte _mjs_page_cached')
  })
})

describe('mjs_ujs — bout-en-bout (clic, cache-hit) : wiring revalidate → µ._mjs_navRevalidate', function () {
  it("cache-hit sur une entrée 'revalidate' : affichage IMMÉDIAT (synchrone) + requête de fond partie", function () {
    const body = makeNode('body')
    const doc = makeDoc(body)
    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' }, history: { pushState() {} } }
    const cachedNode = makeNode('page-b-cached')
    const cachedNodes: any = [cachedNode]
    cachedNodes._mjs_mjsCachePolicy = 'revalidate'
    const µ: any = baseMu({
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: new Map([['/b', cachedNodes]]),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
    })
    installHelpers(µ, doc, win)
    // µ._mjs_navRevalidate espionné : SA mécanique interne (identique/différent/stale) est déjà couverte
    // par le describe dédié plus haut — ce test-ci prouve seulement le CÂBLAGE (cache-hit → appel).
    const revalidated: any[] = []
    µ._mjs_navRevalidate = (zone: any, path: any) => revalidated.push([zone, path])
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }

    clickHandler(e, µ, win, doc, class {})

    assert.deepEqual(body.children, [cachedNode], 'affichage IMMÉDIAT depuis le cache (synchrone, aucune attente réseau)')
    assert.equal(µ._mjs_navCachePolicy, 'revalidate', "la politique de l'entrée cache-hit revit avec elle")
    assert.equal(revalidated.length, 1, 'la vérification de fond est bien partie')
    assert.equal(revalidated[0][0], body)
    assert.equal(revalidated[0][1], '/b')
  })
})
