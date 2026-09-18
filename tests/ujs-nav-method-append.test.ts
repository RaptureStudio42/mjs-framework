// Trois valeurs de `method` : `'update'` (défaut, ex-`'append'` : le
// contenant est VIDÉ puis reçoit le module, le contenant survit), `'replace'` (déjà couvert par
// tests/ujs-nav-cache-zone.test.ts et tests/ujs-nav-json.test.ts) et un VRAI `'append'` qui AJOUTE
// à la suite sans rien retirer. Ce fichier couvre les items neufs qui manquaient de
// couverture DIRECTE :
//   1. `method: 'update'` (et absent) sur un contenant qui a DÉJÀ du contenu — µ._mjs_navInstallInZone
//      ne l'avait jamais testé qu'à partir d'un contenant VIDE (tests/ujs-nav-cache-zone.test.ts).
//   2. `method: 'append'` — contenu existant CONSERVÉ, module ajouté à la fin.
//   3. `method: 'append'` et le cache de pages — la page quittée (photographiée AVANT le fetch, cf.
//      µ.pageCache.set + µ._mjs_navHibernated) doit être DÉ-hibernée par un append (µ._mjs_navDropHibernation) :
//      son flag `_mjs_page_cached` retombe, et son entrée pageCache disparaît (elle pointerait sinon
//      des nœuds encore VIVANTS, ré-affichés au mauvais moment par un retour arrière).
//   4. `method` inconnu → 'update' + avertissement une seule fois PAR VALEUR (µ._mjs_navMethodOf, unitaire).
//
// Méthode : extraction du bloc helpers (µ._mjs_navMountZone → µ._mjs_navRequest, contigu, même
// bandeau d'en-tête) par texte, exécutée via `new Function` — même technique que
// tests/ujs-nav-json.test.ts. Le point 3 ajoute un scénario bout-en-bout (vrai clic intercepté) en
// plus du test unitaire de µ._mjs_zoneAppend/µ._mjs_navDropHibernation, pour prouver le CÂBLAGE réel (les 3
// sites qui hibernent posent bien µ._mjs_navHibernated, cf. mjs_ujs.ts).

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
// µ._mjs_ajaxGet (préchargement des liens) est HORS du bloc helpers ci-dessus (section
// « PRÉCHARGEMENT DES LIENS », bien plus bas dans le fichier) mais le handler click l'appelle pour
// tout clic cross-page — extrait à part, même technique que tests/ujs-nav-json.test.ts test (a).
function extractAjaxGetStatement(src: string): string {
  return extractMarked(src, '_mjs_ajaxGet')
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}

// Nœud FAKE réaliste : ce que µ._mjs_zoneFill/µ._mjs_zoneAppend/µ._mjs_navInstallNodes/µ._mjs_navMountZone touchent
// réellement (même forme que tests/ujs-nav-cache-zone.test.ts). `nodeType: 1` REQUIS — µ._mjs_navFirstEl
// filtre dessus (1er nœud ÉLÉMENT, cf. la branche 'replace' de µ._mjs_navInstallNodes).
function makeNode(tag: string, id = ''): any {
  const node: any = {
    tag, id, nodeType: 1, isConnected: true, children: [] as any[], parentNode: null as any,
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
function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}

describe('mjs_ujs — µ._mjs_navMethodOf : normalisation partagée des 3 valeurs de method', function () {
  it("'replace'/'append' inchangés ; absent/vide/'update' → 'update'", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navMethodOf('replace'), 'replace')
    assert.equal(µ._mjs_navMethodOf('append'), 'append')
    assert.equal(µ._mjs_navMethodOf('update'), 'update')
    assert.equal(µ._mjs_navMethodOf(null), 'update')
    assert.equal(µ._mjs_navMethodOf(undefined), 'update')
    assert.equal(µ._mjs_navMethodOf(''), 'update')
  })

  it("valeur inconnue → 'update' + avertissement UNE FOIS PAR VALEUR distincte (pas par appel)", function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(makeNode('body')), {})

    assert.equal(µ._mjs_navMethodOf('osef'), 'update')
    assert.equal(µ._mjs_navMethodOf('osef'), 'update')
    assert.equal(µ._mjs_navMethodOf('autre'), 'update')

    assert.equal(warnCalls.length, 2, 'une fois par VALEUR distincte : osef puis autre — 3 appels, 2 avertissements')
    assert.match(warnCalls[0][0], /osef/)
    assert.match(warnCalls[0][0], /inconnu/)
    assert.match(warnCalls[0][0], /update/)
    assert.match(warnCalls[1][0], /autre/)
  })
})

describe('mjs_ujs — µ._mjs_navInstallNodes : sémantique update/append à contenu PRÉEXISTANT', function () {
  it("method 'update' (et absent) → contenant VIDÉ puis rempli, le contenant SURVIT", function () {
    const main = makeNode('main', 'main')
    const oldChild = makeNode('old-content')
    main.appendChild(oldChild)
    const body = makeNode('body')
    body.appendChild(main)
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(body), {})

    const fresh = makeNode('mjs-page')
    µ._mjs_navInstallNodes({ zone: main, mode: 'target', target: '#main' }, [fresh], 'update')
    assert.deepEqual(main.children, [fresh], 'ancien contenu RETIRÉ, nouveau contenu seul')
    assert.equal(body.children[0], main, 'le contenant lui-même survit (toujours le même objet)')
    assert.equal(µ._mjs_navZone, null, "aucun suivi de zone en 'update' (le contenant n'a pas cédé sa place)")

    // absent (undefined) : même comportement que 'update' explicite (défaut)
    const fresh2 = makeNode('mjs-page-2')
    µ._mjs_navInstallNodes({ zone: main, mode: 'target', target: '#main' }, [fresh2], undefined)
    assert.deepEqual(main.children, [fresh2], "method absent ⇒ 'update' implicite, même vidage")
  })

  it("method 'append' → contenu EXISTANT conservé, le nouveau module ajouté à la SUITE", function () {
    const main = makeNode('main', 'main')
    const oldChild = makeNode('old-content')
    main.appendChild(oldChild)
    const body = makeNode('body')
    body.appendChild(main)
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(body), {})

    const fresh = makeNode('mjs-page')
    µ._mjs_navInstallNodes({ zone: main, mode: 'target', target: '#main' }, [fresh], 'append')

    assert.deepEqual(main.children, [oldChild, fresh], 'ancien contenu CONSERVÉ, nouveau AJOUTÉ à la fin, dans cet ordre')
    assert.equal(µ._mjs_navZone, null, "aucun suivi de zone en 'append' (le contenant n'a pas cédé sa place)")
    assert.equal(µ._mjs_navContainer, main, 'le contenant courant du cache de pages reste #main')

    // un 2e append s'accumule ENCORE, sans jamais retirer les précédents.
    const fresh2 = makeNode('mjs-page-2')
    µ._mjs_navInstallNodes({ zone: main, mode: 'target', target: '#main' }, [fresh2], 'append')
    assert.deepEqual(main.children, [oldChild, fresh, fresh2], "l'accumulation continue à chaque append")
  })
})

describe("mjs_ujs — method 'append' et le cache de pages : dé-hibernation", function () {
  it('µ._mjs_zoneAppend consomme µ._mjs_navHibernated : flag _mjs_page_cached retombé, entrée pageCache retirée', function () {
    const main = makeNode('main', 'main')
    const hibernatedChild = makeNode('page-a-content')
    hibernatedChild._mjs_page_cached = true
    main.appendChild(hibernatedChild) // TOUJOURS présent : un append ne retire jamais rien
    const µ: any = baseMu({ pageCache: new Map([['/a', [hibernatedChild]]]) })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    µ._mjs_navHibernated = { path: '/a', nodes: [hibernatedChild] }

    const fresh = makeNode('mjs-page-b')
    µ._mjs_zoneAppend(main, [fresh])

    assert.equal(hibernatedChild._mjs_page_cached, false, 'flag retombé : ce nœud reste vivant, plus exempté de destruction')
    assert.equal(µ.pageCache.has('/a'), false, "l'entrée pointait des nœuds encore vivants ailleurs : retirée")
    assert.equal(µ._mjs_navHibernated, null, 'hibernation consommée')
    assert.deepEqual(main.children, [hibernatedChild, fresh], "append : rien retiré, le nouveau vient à la suite")
  })

  it("µ._mjs_zoneFill (method 'update') consomme aussi µ._mjs_navHibernated (fill normal : rien à dé-hiberner, ce fill a réellement vidé)", function () {
    const main = makeNode('main', 'main')
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    µ._mjs_navHibernated = { path: '/a', nodes: [makeNode('x')] }

    µ._mjs_zoneFill(main, [makeNode('mjs-page')])
    assert.equal(µ._mjs_navHibernated, null, "un fill normal consomme l'hibernation sans passer par µ._mjs_navDropHibernation (rien à dé-hiberner)")
  })

  it("bout-en-bout (clic intercepté, protocole JSON) : method:'append' dé-hiberne la page QUITTÉE — _mjs_page_cached retombé, entrée pageCache disparue, contenu quitté toujours affiché", function () {
    const body = makeNode('body')
    const oldContent = makeNode('page-a-content')
    body.appendChild(oldContent)
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
    const link = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }

    clickHandler(e, µ, win, doc, class {})

    // Hibernation posée AU CLIC (photographie de <body> avant le fetch) — le contenu quitté reste
    // PHYSIQUEMENT présent (rien n'a encore été retiré, la réponse n'est pas encore arrivée).
    assert.equal(oldContent._mjs_page_cached, true, "hibernation posée au clic : contenu quitté flaggé")
    assert.equal(µ.pageCache.has('/a'), true, 'entrée de cache posée pour le chemin quitté')
    assert.ok(µ._mjs_navHibernated && µ._mjs_navHibernated.path === '/a', 'µ._mjs_navHibernated reflète le départ')

    assert.equal(capturedAjax.length, 1, 'le fetch réseau doit être parti (µ._mjs_ajaxRequest, canal interne)')
    // Réponse JSON du protocole de navigation : method 'append', aucun target (contenant = <body>).
    capturedAjax[0].success({ module: 'mjs-b', props: {}, method: 'append', url: '/b', title: null, version: undefined }, '/b')

    assert.equal(oldContent._mjs_page_cached, false, "dé-hibernation : le contenu quitté n'est plus exempté de destruction")
    assert.equal(µ.pageCache.has('/a'), false, "l'entrée pointait un contenu resté VIVANT sous <body> : retirée par l'append")
    assert.equal(µ._mjs_navHibernated, null, 'hibernation consommée')
    assert.deepEqual(body.children.map((c: any) => c.tag), ['page-a-content', 'mjs-b'], "append : le contenu quitté RESTE affiché, le nouveau module vient à la suite")
  })

  // Le vrai `µ.pageCache` est une LRUCache dont `delete()` déclenche `onEvict` →
  // `µ._mjs_destroyEvictedTree` (mjs_init.ts), qui DÉTRUIT les composants du sous-arbre évincé. La
  // dé-hibernation d'un `append` retire une entrée dont les nœuds sont restés VIVANTS et CONNECTÉS :
  // seul le garde `!isConnected` de `_mjs_destroyEvictedTree` empêche de détruire des composants encore
  // à l'écran. Ce test fige le contrat côté navigation (ne jamais détacher avant de supprimer) avec
  // un onEvict qui reproduit ce garde — sans lui, une future refonte détruirait du visible en silence.
  it("dé-hibernation : l'entrée retirée porte des nœuds CONNECTÉS — un onEvict à la _mjs_destroyEvictedTree ne détruit rien", function () {
    const zone = makeNode('body')
    const vivant = makeNode('page-a-content')
    zone.appendChild(vivant)
    const detruits: any[] = []
    const store = new Map<string, any>()
    const pageCache = {
      has: (k: string) => store.has(k),
      get: (k: string) => store.get(k),
      set: (k: string, v: any) => { store.set(k, v) },
      delete: (k: string) => {
        const nodes = store.get(k) || []
        store.delete(k)
        // miroir de µ._mjs_destroyEvictedTree : ne détruit QUE ce qui n'est plus dans le document
        for (const n of nodes) { if (n.nodeType === 1 && !n.isConnected) { detruits.push(n) } }
      },
    }
    const µ = baseMu({ pageCache })
    installHelpers(µ, { body: zone }, {})
    µ._mjs_navHibernated = { path: '/a', nodes: [vivant] }
    pageCache.set('/a', [vivant])
    vivant._mjs_page_cached = true

    µ._mjs_zoneAppend(zone, [makeNode('mjs-b')])

    assert.deepEqual(detruits, [], 'aucun composant détruit : les nœuds de l’entrée retirée sont restés connectés')
    assert.equal(vivant.isConnected, true, "le contenu quitté est toujours dans le document (un append ne détache jamais)")
    assert.equal(pageCache.has('/a'), false, "l'entrée périmée a bien été retirée")
  })
})
