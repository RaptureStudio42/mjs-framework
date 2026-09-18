// Chemin JSON du protocole de navigation (docs/21-navigation.md « Le
// protocole serveur ») : en-tête `X-MJS-Nav` sur les requêtes ujs, dispatch
// selon le Content-Type de la réponse, `µ._mjs_navApplyJson` (version/404/module
// inconnu/nominal), 422 JSON en submit. Clés
// `target`/`method` de la fiche : le contenant de la navigation devient
// `target` (sélecteur CSS) s'il est présent et résolu, sinon `<body>` ; la
// cascade #app-root/mjs-child DISPARAÎT (cf. tests/ujs-mount-cascade.test.ts).
//
// Méthode : extraction du corps SOURCE par regex (même technique que
// tests/ujs-submit-navseq-race.test.ts) — le bloc des helpers
// (µ._mjs_navMountZone → µ._mjs_navRequest, contigus dans le fichier, cf. leur
// bandeau commun) est extrait EN UNE FOIS, puis évalué sur le même `µ` que
// `_mjs_ujsOnClick`/`_mjs_navDispatch` selon le scénario. `new Function`, pas de
// compilation, pas de happy-dom.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
// µ._mjs_resSet / µ._mjs_resMerge vivent LÀ (pas dans mjs_ujs.ts) — le cas (f2) évalue la
// VRAIE fusion plutôt qu'un espion, pour prouver la survie des clés non renvoyées.
const GLOBALS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')

// Bloc des helpers — µ._mjs_navMountZone, µ._mjs_navInstallInZone,
// µ._mjs_navShowNotFound, µ._mjs_navApplyJson, µ._mjs_navRequest : contigus dans le
// fichier (même bandeau d'en-tête « ZONE DE NAVIGATION »), extraits EN UNE
// FOIS jusqu'au bandeau TRANSITIONS DE PAGE qui les suit immédiatement.
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function extractAjaxGetStatement(src: string): string {
  return extractMarked(src, '_mjs_ajaxGet')
}

function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}

function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}

function extractSubmitBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}

// Installe les helpers sur `µ` — nécessite `document`/`window` (fermeture
// via `new Function`, cf. µ._mjs_navMountZone/µ._mjs_navApplyJson qui les référencent
// bare, jamais un global implicite dans ce harnais).
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}

class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}

function makeCrossLink(pathname: string, href: string, hash = '') {
  return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname, search: '', hash, href, closest: function (this: any) { return this } }
}

function makeClickEvent(link: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [link],
    target: link,
  }
}

describe('mjs_ujs — protocole de navigation JSON', function () {
  it("(a) clic lien intercepté (cross-page) : l'en-tête X-MJS-Nav part sur la requête", function () {
    const capturedOptions: any[] = []
    const liveRoot: any = { replaceWith() {} }
    const win: any = { location: { pathname: '/', search: '', origin: 'http://x', href: 'http://x/' }, history: { pushState() {} } }
    const doc: any = { getElementById: () => liveRoot, body: { children: [], childNodes: [] } }
    const µ: any = {
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_preloadCache: { has: () => false },
      _mjs_saveScroll() {}, warn() {}, error() {}, log() {},
      _mjs_ajaxRequest: (opts: any) => { capturedOptions.push(opts); return Promise.resolve() },
    }
    installHelpers(µ, doc, win)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickBody = extractClickBody(UJS_SRC)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', clickBody)

    const link = makeCrossLink('/produits', 'http://x/produits')
    handler(makeClickEvent(link), µ, win, doc, class {})

    assert.equal(capturedOptions.length, 1, 'la requête doit être partie via le canal interne µ._mjs_ajaxRequest')
    assert.equal(capturedOptions[0].headers['X-MJS-Nav'], '1', "l'en-tête X-MJS-Nav doit valoir '1'")
    assert.equal(capturedOptions[0].method, 'GET')
  })

  it("(b) réponse JSON nominale, PAS de target : createElement(module) + µ._mjs_resSet(props) + pushState, contenu de <body> remplacé", function () {
    const resSetCalls: any[] = []
    const created: string[] = []
    const pushCalls: any[] = []
    const navigateCalls: any[] = []
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const doc: any = { body: bodyZone, createElement: (tag: string) => { created.push(tag); return { tag } } }
    const win: any = { history: { pushState: (...a: any[]) => pushCalls.push(a) }, location: { assign() { throw new Error('ne doit pas recharger') } } }
    const µ: any = {
      paths: { 'produit': 'xxx-hash.js' },
      version: 'v1',
      _mjs_resSet: (p: any) => resSetCalls.push(p),
      Router: { navigate: (...a: any[]) => navigateCalls.push(a) },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: { id: '42', name: 'Chaise' }, url: '/produits/42', title: null, version: 'v1' }, '/produits/42', { push: true })

    assert.deepEqual(created, ['mjs-produit'], 'document.createElement(json.module) doit être appelé')
    assert.deepEqual(resSetCalls, [{ id: '42', name: 'Chaise' }], 'µ._mjs_resSet(json.props) doit être appelé')
    assert.equal(pushCalls.length, 1, 'pushState doit avoir lieu (opts.push=true)')
    assert.equal(pushCalls[0][2], '/produits/42')
    assert.equal(bodyZone.filled[0].tag, 'mjs-produit', 'le composant créé doit être installé DANS <body> (aucun target)')
    assert.equal(navigateCalls.length, 1, 'µ.Router.navigate doit resynchroniser µ.url/<@view> (miroir du chemin HTML)')
  })

  it("(c) version différente (json.version ≠ µ.version) : rechargement complet, aucun montage", function () {
    const created: string[] = []
    const resSetCalls: any[] = []
    const assignCalls: string[] = []
    const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: (tag: string) => { created.push(tag); return {} } }
    const win: any = { history: { pushState() { throw new Error('ne doit pas pousser : rechargement complet attendu') } }, location: { assign: (u: string) => assignCalls.push(u) } }
    const µ: any = {
      paths: { produit: 'xxx.js' }, version: 'v1-ancien',
      _mjs_resSet: (p: any) => resSetCalls.push(p),
      Router: { navigate: () => { throw new Error('ne doit pas naviguer : rechargement complet attendu') } },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v2-nouveau' }, '/produits/42', { push: true })

    assert.deepEqual(assignCalls, ['/produits/42'], 'version différente → window.location.assign, un rechargement complet')
    assert.equal(created.length, 0, 'AUCUN montage : createElement ne doit jamais être appelé')
    assert.equal(resSetCalls.length, 0, 'AUCUN _mjs_resSet non plus')
  })

  it('(d) module:null (404 serveur), PAS de target : panneau installé DANS <body>, pas de crash', function () {
    const navigateCalls: any[] = []
    const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const doc: any = {
      body: bodyZone,
      createElement: (tag: string) => ({ tag, attrs: {} as any, children: [] as any[], setAttribute(k: string, v: string) { this.attrs[k] = v }, appendChild(c: any) { this.children.push(c) } }),
    }
    const win: any = { history: { pushState() {} } }
    const µ: any = {
      config: { routeNotFound: 'error' },
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_updateUrlStore: () => {}, _mjs_routerLabel: (k: string) => ({ notFound: 'Page introuvable', noRoute: 'Aucune route ne correspond à cette adresse.' } as any)[k] },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: null, props: {}, url: '/inconnu', title: null, version: 'v1' }, '/inconnu', { push: true })
    }, 'module:null ne doit jamais faire crasher le client')
    assert.equal(navigateCalls.length, 0, "le panneau 404 n'utilise PAS µ.Router.navigate (pas de vue routée à resynchroniser)")
    assert.equal(bodyZone.filled[0].tag, 'div', 'le panneau (mjs-route-error) est installé DANS <body> (aucun target)')
  })

  it('(e) module hors µ.paths ET non défini comme custom element : rechargement complet', function () {
    const assignCalls: string[] = []
    const resSetCalls: any[] = []
    const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => { throw new Error('ne doit pas créer : bundle périmé') } }
    const win: any = { history: { pushState() {} }, location: { assign: (u: string) => assignCalls.push(u) } }
    const µ: any = {
      paths: { autrepage: 'yyy.js' }, // 'produit' ABSENT
      version: 'v1',
      _mjs_resSet: (p: any) => resSetCalls.push(p),
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, '/produits/42', { push: true })

    assert.deepEqual(assignCalls, ['/produits/42'], 'module inconnu du manifeste ET pas déjà défini → rechargement complet')
    assert.equal(resSetCalls.length, 0)
  })

  // Le 422 FUSIONNE (µ._mjs_resMerge) au lieu de
  // remplacer le sac (µ._mjs_resSet) : la page affichée ne bouge pas, ses props
  // n'ont aucune raison de partir. Cf. le test (f2) juste après pour la preuve
  // bout en bout avec la VRAIE fonction de fusion.
  it('(f) 422 JSON en submit : µ._mjs_resMerge SEUL — ni pushState ni remontage', function () {
    const mergeCalls: any[] = []
    const resSetCalls: any[] = []
    const pushCalls: any[] = []
    const createCalls: string[] = []
    const restoreBusyCalls: number[] = []
    let capturedError: any
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushCalls.push(a) } }
    const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: (tag: string) => { createCalls.push(tag); return {} } }
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
      _mjs_resSet: (p: any) => resSetCalls.push(p),
      _mjs_resMerge: (p: any) => mergeCalls.push(p),
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => restoreBusyCalls.push(1) })
    assert.ok(typeof capturedError === 'function', 'µ._mjs_ajaxRequest doit avoir été appelé avec un callback error')

    capturedError({ status: 422, body: { module: 'mjs-new-post', props: { title: '', errors: { title: 'requis' } }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })

    assert.deepEqual(mergeCalls, [{ title: '', errors: { title: 'requis' } }], 'µ._mjs_resMerge(props) doit recevoir EXACTEMENT le corps 422 (errors compris)')
    assert.equal(resSetCalls.length, 0, 'µ._mjs_resSet (remplacement du sac ENTIER) ne doit JAMAIS être appelé sur un 422')
    assert.equal(pushCalls.length, 0, 'AUCUN pushState sur un 422')
    assert.equal(createCalls.length, 0, 'AUCUN remontage (document.createElement jamais appelé)')
    assert.equal(restoreBusyCalls.length, 1, 'opts.restoreBusy doit quand même être rappelé (réactiver le bouton submit)')
  })

  it('(f2) 422 : les clés du sac NON renvoyées par le back survivent (vraie µ._mjs_resMerge)', function () {
    const restoreBusyCalls: number[] = []
    let capturedError: any
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
      // état de la page AFFICHÉE au moment de la soumission — rien à voir avec le formulaire refusé
      res: { panier: 3, favoris: 12, page: 2 },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    // la VRAIE fusion, extraite de mjs_store_globals.ts (pas un espion)
    new Function('µ', extractMarked(GLOBALS_SRC, '_mjs_resMerge'))(µ)
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, class {})

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => restoreBusyCalls.push(1) })
    // le back Rails idiomatique ne renvoie QUE de quoi ré-afficher le formulaire fautif
    capturedError({ status: 422, body: { module: 'mjs-new-post', props: { errors: { title: 'requis' } }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })

    assert.deepEqual(µ.res, { panier: 3, favoris: 12, page: 2, errors: { title: 'requis' } }, 'une faute de saisie ne doit vider ni le panier, ni les compteurs, ni la pagination')
  })

  it('(g) réponse HTML (repli, pas de X-MJS-Nav reconnu côté back) : chemin legacy pris, µ._mjs_resSet jamais appelé', function () {
    const resSetCalls: any[] = []
    let capturedSuccess: any
    const liveRoot: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
    const newRoot = { tag: 'new-root' }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const doc: any = { body: liveRoot }
    class DP { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      _mjs_resSet: (p: any) => resSetCalls.push(p),
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DP)
    const submitHandler = new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody(UJS_SRC))

    const form: any = {
      hasAttribute: () => false,
      getAttribute: (k: string) => (k === 'action' ? '/posts' : k === 'method' ? 'POST' : null),
      target: '', action: 'http://x/posts', closest: () => form,
    }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter: null, composedPath: () => [form], target: form }
    submitHandler(e, µ, win, doc, FakeFormData, URL, DP)

    assert.ok(typeof capturedSuccess === 'function', 'µ._mjs_ajaxRequest doit avoir été appelé avec un callback success')
    capturedSuccess('<html><body>créé</body></html>', 'http://x/posts')

    assert.equal(liveRoot.filled[0], newRoot, 'le chemin HTML legacy (DOMParser + swap dans <body>) doit avoir tourné')
    assert.equal(resSetCalls.length, 0, 'µ._mjs_resSet ne doit JAMAIS être appelé sur une réponse HTML')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Popstate, branche JSON : restauration de scroll manquante. La
// branche HTML miroir appelle µ._mjs_restoreScroll(destination) juste après le
// swap (cf. mjs_ujs.ts) ; la branche JSON en était dépourvue.
// ════════════════════════════════════════════════════════════════════════════
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}

describe('mjs_ujs — scroll manquant après montage JSON au popstate', function () {
  it('popstate, cache miss réseau, réponse JSON : µ._mjs_restoreScroll(destination) appelé — parité avec la branche HTML', function () {
    const restoreScrollCalls: string[] = []
    const zone: any = { replaceWith() {} }
    const doc: any = { getElementById: () => zone, body: { replaceChildren() {}, childNodes: [] }, createElement: (tag: string) => ({ tag }) }
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    let capturedSuccess: any
    const µ: any = {
      paths: { produit: 'xxx.js' },
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll: (p: string) => restoreScrollCalls.push(p),
      warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      Router: { navigate() {} },
    }
    installHelpers(µ, doc, win)
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))

    popHandler({}, µ, win, doc, class {})
    assert.ok(typeof capturedSuccess === 'function', 'cache miss (aucune entrée pageCache) → fetch réseau attendu')

    capturedSuccess({ module: 'mjs-produit', props: {}, url: '/b', title: null, version: undefined }, 'http://x/b')

    assert.deepEqual(restoreScrollCalls, ['/b'], 'µ._mjs_restoreScroll doit être appelé pour la destination, comme la branche HTML (AVANT ce correctif : jamais appelé sur ce chemin)')
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Continuité de zone en method 'replace' :
// µ._mjs_navApplyJson remplace le CONTENANT (`target`) par `replaceWith(el)` quand
// `method:'replace'` — la cible (sélecteur CSS) disparaît alors du DOM. Sans
// suivi, la navigation JSON suivante (même target, désormais introuvable) ne
// la retrouve plus et retombe à tort sur <body> entier (rase l'habillage
// statique autour si le contenant était niché, pas enfant direct de body).
// Fixture DOM minimale mais avec de VRAIES sémantiques replaceWith/
// replaceChildren/isConnected/querySelector (contrairement aux mocks
// `{replaceWith(){}}` du reste de ce fichier) : nécessaire pour prouver la
// continuité sur plusieurs navigations. Remplace l'ancienne fixture
// #app-root (retirée avec la cascade) — même INTENTION (continuité
// de zone), réexprimée avec target/method.
// ════════════════════════════════════════════════════════════════════════════
function makeTrackedEl(tag: string): any {
  const el: any = {
    // nodeType: 1 (ELEMENT_NODE) — µ._mjs_navInstallNodes suit désormais la zone via
    // µ._mjs_navFirstEl(nodes) (le 1er ÉLÉMENT, texte/commentaire ignorés), qui filtre sur nodeType.
    tag, nodeType: 1, isConnected: false, parentNode: null as any, children: [] as any[], id: '',
    replaceWith(fresh: any) {
      if (el.parentNode) {
        const i = el.parentNode.children.indexOf(el)
        if (i !== -1) { el.parentNode.children[i] = fresh }
        fresh.parentNode = el.parentNode
      }
      fresh.isConnected = true
      el.isConnected = false
      el.parentNode = null
    },
    replaceChildren(...nodes: any[]) {
      el.children.forEach((c: any) => { c.parentNode = null; c.isConnected = false })
      el.children = nodes.slice()
      el.children.forEach((c: any) => { c.parentNode = el; c.isConnected = el.isConnected })
    },
    querySelector(sel: string): any {
      const id = sel.replace(/^#/, '')
      const walk = (node: any): any => {
        if (node.id === id) { return node }
        for (const c of node.children) { const found = walk(c); if (found) { return found } }
        return null
      }
      return walk(el)
    },
    appendChild(child: any) { el.children.push(child); child.parentNode = el; return child },
    setAttribute() {},
  }
  return el
}
function makeTargetFixture() {
  // body → wrapper (habillage statique, JAMAIS remplacé) → #panel (niché, PAS enfant direct de body)
  const body = makeTrackedEl('body'); body.isConnected = true
  const wrapper = makeTrackedEl('div'); wrapper.isConnected = true
  wrapper.parentNode = body; body.children.push(wrapper)
  const panel = makeTrackedEl('div'); panel.isConnected = true; panel.id = 'panel'
  panel.parentNode = wrapper; wrapper.children.push(panel)
  const doc: any = {
    body,
    querySelector: (sel: string) => body.querySelector(sel),
    createElement: (tag: string) => makeTrackedEl(tag),
  }
  return { doc, body, wrapper, panel }
}
function makeContinuityMu(): any {
  return { paths: { produit: 'xxx.js', panier: 'yyy.js' }, warn() {}, error() {}, log() {}, Router: { navigate() {} } }
}

describe("mjs_ujs — method 'replace' — continuité de zone (le module installé reste la cible)", function () {
  it("deux navigations JSON successives, method:'replace' sur #panel (niché, pas enfant direct de body) : la 2e remplace le composant monté par la 1re — JAMAIS un repli <body>, aucun avertissement, l'habillage (wrapper) survit", function () {
    const { doc, body, wrapper } = makeTargetFixture()
    const win: any = { history: { pushState() {} } }
    const warnCalls: any[] = []
    const µ = makeContinuityMu()
    µ.warn = (...a: any[]) => warnCalls.push(a)
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, target: '#panel', method: 'replace', url: '/produits/1', title: null, version: undefined }, '/produits/1', { push: false })
    assert.equal(wrapper.children.length, 1)
    assert.equal(wrapper.children[0].tag, 'mjs-produit', "1re navigation : #panel a cédé sa place au module")
    assert.deepEqual(body.children, [wrapper], "l'habillage (wrapper) n'a pas bougé")

    µ._mjs_navApplyJson({ module: 'mjs-panier', props: {}, target: '#panel', method: 'replace', url: '/panier', title: null, version: undefined }, '/panier', { push: false })
    assert.equal(wrapper.children.length, 1)
    assert.equal(wrapper.children[0].tag, 'mjs-panier', "2e navigation : #panel introuvable (remplacé au 1er tour) → remplace le module installé (zone suivie), jamais un repli <body>")
    assert.deepEqual(body.children, [wrapper], "l'habillage (wrapper) survit aussi à la 2e navigation")
    assert.equal(warnCalls.length, 0, "jamais l'avertissement « cible introuvable » : la zone suivie a pris le relais silencieusement")
  })

  it("panneau introuvable (module:null, method:'replace') PUIS navigation JSON nominale (même target) : montage au même endroit (remplace le panneau), habillage intact", function () {
    const { doc, body, wrapper } = makeTargetFixture()
    const win: any = { history: { pushState() {} } }
    const µ = makeContinuityMu()
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: null, props: {}, target: '#panel', method: 'replace', url: '/inconnu', title: null, version: undefined }, '/inconnu', { push: false })
    assert.equal(wrapper.children.length, 1, 'le panneau 404 doit avoir remplacé #panel')
    assert.equal(wrapper.children[0].tag, 'div', 'le panneau est un <div> (mjs-route-error)')
    assert.equal(wrapper.children[0].children.length, 4, 'strong+p+code+style, le style est un FRÈRE dans box, pas un fragment séparé')

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, target: '#panel', method: 'replace', url: '/produits/1', title: null, version: undefined }, '/produits/1', { push: false })
    assert.equal(wrapper.children.length, 1)
    assert.equal(wrapper.children[0].tag, 'mjs-produit', 'la navigation nominale remplace le panneau, au même endroit')
    assert.deepEqual(body.children, [wrapper], "l'habillage (wrapper) intact tout du long")
  })

  it("target trouvé, method 'update' implicite (défaut) : le CONTENANT (#panel) survit, son contenu devient le module", function () {
    const { doc, panel, wrapper } = makeTargetFixture()
    const win: any = { history: { pushState() {} } }
    const µ = makeContinuityMu()
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, target: '#panel', url: '/produits/1', title: null, version: undefined }, '/produits/1', { push: false })

    assert.equal(wrapper.children.indexOf(panel) !== -1, true, "#panel existe TOUJOURS dans le DOM (jamais remplacé, method='update' implicite)")
    assert.equal(panel.children.length, 1)
    assert.equal(panel.children[0].tag, 'mjs-produit', 'le CONTENU de #panel est le module')
  })
})

describe('mjs_ujs — method/target — cas de repli', function () {
  it("method:'replace' SANS target → <body> intact (jamais remplacé lui-même), contenu remplacé, avertissement une fois", function () {
    const warnCalls: any[] = []
    const filled: any[] = []
    const body: any = { replaceChildren(...nodes: any[]) { filled.push(nodes) } }
    const doc: any = { body, createElement: (tag: string) => ({ tag }) }
    const win: any = { history: { pushState() {} } }
    const µ: any = { paths: { produit: 'xxx.js' }, warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {}, Router: { navigate() {} } }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, method: 'replace', url: '/produits/1', title: null, version: undefined }, '/produits/1', { push: false })

    assert.equal(doc.body, body, '<body> lui-même : toujours le même objet, jamais remplacé')
    assert.equal(filled.length, 1)
    assert.equal(filled[0][0].tag, 'mjs-produit', 'contenu de <body> remplacé par le module')
    assert.equal(warnCalls.length, 1, "avertissement 'replace sans target'")
    assert.match(warnCalls[0][0], /replace/)
    assert.match(warnCalls[0][0], /body/i)
  })

  it("method inconnu (fiche mal formée) → traité comme 'update', avertissement UNE FOIS PAR VALEUR", function () {
    const warnCalls: any[] = []
    const filled: any[] = []
    const body: any = { replaceChildren(...nodes: any[]) { filled.push(nodes) } }
    const doc: any = { body, createElement: (tag: string) => ({ tag }) }
    const win: any = { history: { pushState() {} } }
    const µ: any = { paths: { produit: 'xxx.js' }, warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {}, Router: { navigate() {} } }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, method: 'osef', url: '/produits/1', title: null, version: undefined }, '/produits/1', { push: false })
    assert.equal(filled.length, 1, "traité comme 'update' : contenu quand même installé")
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /osef/)
    assert.match(warnCalls[0][0], /inconnu/)

    // 2e appel, MÊME valeur 'osef' : pas de 2e avertissement (une fois par VALEUR, pas par appel)
    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, method: 'osef', url: '/produits/2', title: null, version: undefined }, '/produits/2', { push: false })
    assert.equal(warnCalls.length, 1, "avertissement 'method inconnu' : une fois par VALEUR")
  })
})
