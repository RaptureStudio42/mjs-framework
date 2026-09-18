// Deux issues de plus au protocole de navigation, reprises d'un
// AjaxController Rails antérieur (ajax_complete: :redirect/:replace/:reload) :
//   - X-MJS-Reload / json.reload — RECHARGE TOUT : rechargement dur (µ._mjs_navHardReload — assign si la
//     destination diffère de l'adresse courante, reload() sinon, une URL identique à un fragment près
//     ne repart pas au serveur via assign), sur TOUS les chemins de navigation (JSON et les 3 sites
//     HTML : clic/popstate/submit), AVANT toute garde de version — SAUF µ._mjs_navRevalidate (refetch
//     SILENCIEUX de fond, ignoré à dessein : l'utilisateur n'a rien demandé).
//   - X-MJS-Method: none / json.method:'none' — NE BOUGE PAS : rien n'est installé
//     (µ._mjs_navInstallNodes court-circuite en tête, rend null), l'hibernation posée AVANT la réponse est
//     annulée (µ._mjs_navDropHibernation), les props sont FUSIONNÉES dans µres (µ._mjs_resMerge,
//     mjs_store_globals.ts — jamais µ._mjs_resSet, qui remplacerait tout le sac entier).
//
// Méthode : mêmes techniques que les fichiers voisins déjà lus (ujs-nav-json/ujs-nav-target-method-html/
// ujs-nav-version-html/ujs-nav-cache-policy/ujs-nav-method-append/ujs-nav-head/ujs-busy-nav-focus) —
// lecture de la SOURCE réelle (readFileSync), extraction par regex + comptage d'accolades, exécution
// via `new Function`, jamais de mock du code testé lui-même (seuls les collaborateurs DOM/réseau le
// sont). Deux remarques d'observation (pas des bogues à corriger) sont documentées en
// assertions : le pushState au clic et le déplacement natif de window.location au popstate ont TOUS
// LES DEUX lieu AVANT que la réponse `method:'none'` n'arrive — trop tard pour l'empêcher.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const STORE_GLOBALS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

// ── Extraction par marqueurs explicites (tests/helpers/extract-marked.ts) ──────────────────────────
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}
function extractNavRevalidateStatement(src: string): string {
  return extractMarked(src, '_mjs_navRevalidate')
}
function extractAjaxGetStatement(src: string): string {
  return extractMarked(src, '_mjs_ajaxGet')
}
function installRevalidate(µ: any, window: any, document: any, DOMParserCtor: any) {
  new Function('µ', 'window', 'document', 'DOMParser', extractNavRevalidateStatement(UJS_SRC))(µ, window, document, DOMParserCtor)
}
function extractResMergeStatement(): string {
  return extractMarked(STORE_GLOBALS_SRC, '_mjs_resMerge')
}
function installResMerge(µ: any) {
  new Function('µ', extractResMergeStatement())(µ)
}

// DOMParser factice qui JETTE (même technique que tests/ujs-nav-version-html.test.ts) : preuve qu'on
// est sorti AVANT tout parsing de la réponse.
class DPInterdit {
  parseFromString(): any { throw new Error('ne doit jamais parser : sortie avant tout swap (reload/none)') }
}

// ── Fakes DOM / event / formulaire (mêmes formes que les fichiers voisins) ────────────────────────
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
function makeZone(children: any[] = []) {
  return {
    tag: 'body', nodeType: 1, isConnected: true, children,
    get childNodes() { return this.children },
    replaceChildren(...nodes: any[]) { this.children = nodes },
  }
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
function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}
class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}
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

// ════════════════════════════════════════════════════════════════════════════════════════════════
// µ._mjs_navReloadAsked — normalisation (cas 1 à 4)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_ujs — µ._mjs_navReloadAsked : normalisation « recharge tout » (cas 1 à 4)', function () {
  it("valeurs VRAIES : '1' (chaîne), true (booléen), 'yes' (chaîne quelconque non '0'/'false')", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navReloadAsked('1'), true)
    assert.equal(µ._mjs_navReloadAsked(true), true)
    assert.equal(µ._mjs_navReloadAsked('yes'), true)
  })

  it("valeurs FAUSSES : null/undefined/''/'0'/'false'/'FALSE ' (espaces+casse rognés)/false/0 — AUCUN avertissement", function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navReloadAsked(null), false)
    assert.equal(µ._mjs_navReloadAsked(undefined), false)
    assert.equal(µ._mjs_navReloadAsked(''), false)
    assert.equal(µ._mjs_navReloadAsked('0'), false)
    assert.equal(µ._mjs_navReloadAsked('false'), false)
    assert.equal(µ._mjs_navReloadAsked('FALSE '), false, "rognée + minuscules : 'FALSE ' devient 'false'")
    assert.equal(µ._mjs_navReloadAsked(false), false)
    assert.equal(µ._mjs_navReloadAsked(0), false, 'un nombre — même 0 — ne vaut jamais vrai : seuls true===true ou une chaîne comptent')
    assert.equal(warnCalls.length, 0, "contrairement à method, aucun vocabulaire fermé à défendre ici : zéro avertissement")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// µ._mjs_navHardReload — exécution (cas 5 à 7)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_ujs — µ._mjs_navHardReload : exécution du rechargement dur (cas 5 à 7)', function () {
  it('5. destination DIFFÉRENTE de l’adresse courante → assign appelé avec l’URL ABSOLUE, reload JAMAIS appelé', function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    const win: any = { location: { href: 'http://x/a', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) } }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), win)

    µ._mjs_navHardReload('/b')

    assert.deepEqual(assignCalls, ['http://x/b'], 'résolue en absolu contre window.location.href')
    assert.equal(reloadCalls.length, 0)
  })

  it("6. destination == l'adresse COURANTE (résolue) → reload() appelé, assign JAMAIS appelé", function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    // origin/pathname/search/hash désormais nécessaires (comparaison PARTIE DOCUMENT) :
    // un `window.location` réel les porte TOUJOURS ensemble, cohérents avec `href` — mock complété à
    // l'identique.
    const win: any = { location: { href: 'http://x/a', origin: 'http://x', pathname: '/a', search: '', hash: '', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) } }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), win)

    µ._mjs_navHardReload('/a')

    assert.equal(assignCalls.length, 0)
    assert.equal(reloadCalls.length, 1)
  })

  it('7. entrée qui fait JETER `new URL` → repli direct sur reload(), aucune exception ne remonte', function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    // `href` lui-même invalide comme BASE (pas de schéma) : `new URL(dest, href)` jette pour toute
    // destination relative — repli attendu.
    const win: any = { location: { href: 'not-a-valid-url', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) } }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), win)

    assert.doesNotThrow(() => { µ._mjs_navHardReload('/b') })

    assert.equal(assignCalls.length, 0)
    assert.equal(reloadCalls.length, 1, 'repli reload() : aucune exception ne doit remonter à l’appelant')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Garde `window` nue + comparaison PARTIE DOCUMENT
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — µ._mjs_navHardReload : garde `typeof window` NUE", function () {
  it("window absent (harnais minimal) : aucun throw, aucun assign, aucun reload", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), undefined)

    assert.doesNotThrow(() => { µ._mjs_navHardReload('/b') })
  })

  it("window SANS .location : aucun throw, aucun assign, aucun reload", function () {
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), {})

    assert.doesNotThrow(() => { µ._mjs_navHardReload('/b') })
  })
})

describe("mjs_ujs — µ._mjs_navHardReload : destination qui ne diffère QUE par le fragment", function () {
  it("même origin+pathname+search, hash différent → le fragment est posé PUIS reload() est appelé, assign() JAMAIS", function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    const win: any = {
      location: { href: 'http://x/checkout', origin: 'http://x', pathname: '/checkout', search: '', hash: '', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) },
    }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), win)

    µ._mjs_navHardReload('/checkout#confirmation')

    assert.equal(assignCalls.length, 0, "même document (origin+pathname+search identiques) : assign() ne doit JAMAIS partir — same-document par spécification HTML, aucune requête réseau")
    assert.equal(win.location.hash, '#confirmation', "le fragment demandé est posé AVANT le reload (mise à jour synchrone de window.location.href, en réalité)")
    assert.equal(reloadCalls.length, 1, "reload() force le vrai aller-retour serveur — ce que le fragment seul ne déclenche jamais")
  })

  it("même origin+pathname+search+hash (rien ne diffère) : reload() seul, comportement inchangé (non-régression)", function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    const win: any = {
      location: { href: 'http://x/checkout#confirmation', origin: 'http://x', pathname: '/checkout', search: '', hash: '#confirmation', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) },
    }
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), win)

    µ._mjs_navHardReload('/checkout#confirmation')

    assert.equal(assignCalls.length, 0)
    assert.equal(win.location.hash, '#confirmation', 'le fragment ne bouge pas : déjà identique')
    assert.equal(reloadCalls.length, 1)
  })

  // Garde NUE révélée par sabotage : permuter les deux lignes laissait la
  // suite ENTIÈREMENT verte, alors qu'en Chromium réel l'ordre inversé PERD le fragment (le reload part sur
  // l'ancienne adresse). Les deux tests ci-dessus prouvent que les DEUX effets ont lieu, jamais dans quel
  // ordre : ce cas-ci journalise les deux appels et n'assied que ça.
  it("ORDRE : le fragment est posé AVANT reload() — l'inverse rechargerait l'ANCIENNE adresse et perdrait le fragment", function () {
    const journal: string[] = []
    const loc: any = { href: 'http://x/checkout', origin: 'http://x', pathname: '/checkout', search: '', assign: () => journal.push('assign'), reload: () => journal.push('reload') }
    Object.defineProperty(loc, 'hash', { get() { return this._hash || '' }, set(v: string) { this._hash = v; journal.push('hash=' + v) }, enumerable: true, configurable: true })
    const µ: any = baseMu()
    installHelpers(µ, makeDoc(makeNode('body')), { location: loc })

    µ._mjs_navHardReload('/checkout#confirmation')

    assert.deepEqual(journal, ['hash=#confirmation', 'reload'], "le fragment doit être posé d'abord : window.location.reload() recharge l'adresse COURANTE, donc celle qui vient d'être mise à jour")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Ordre reload → version → none IDENTIQUE sur les 4 chemins
// (CLIC déjà correct ; SOUMISSION/@method régressée — les deux variantes côte à côte pour
// que l'asymétrie ne puisse pas revenir en silence)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — version PÉRIMÉE + method:'none' simultanés — clic et submit côte à côte", function () {
  it("clic cross-page : version différente + method:'none' ensemble → rechargement dur (la version prime sur 'none')", function () {
    const assignCalls: string[] = []
    const zone = makeZone([{ tag: 'ancien', nodeType: 1 }])
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() {} },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', version: 'v2', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, doc, DPInterdit)

    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html>ignoré</html>', 'http://x/b', undefined, { version: 'v1-different', target: null, method: 'none', reload: null })

    assert.deepEqual(assignCalls, ['http://x/b'], "un CLIC recharge déjà (la version est testée avant 'none' sur ce chemin) — préservé")
  })

  it("submit : version différente + method:'none' ensemble → rechargement dur, EXACTEMENT comme le clic (AVANT ce correctif : régression — aucune action)", function () {
    const assignCalls: string[] = []
    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() { throw new Error('ne doit pas pousser : rechargement complet attendu') } },
    }
    const doc: any = { getElementById: () => null }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0, version: 'v2',
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DPInterdit)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => {} })
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html>ignoré</html>', 'http://x/posts', undefined, { version: 'v1-different', target: null, method: 'none', reload: null })

    assert.deepEqual(assignCalls, ['http://x/posts'], "AVANT ce correctif : la garde de version était nichée dans html.includes('<html'), jamais atteinte avant le court-circuit 'none' — un CLIC rechargeait, une SOUMISSION ne faisait RIEN")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Chemin JSON — X-MJS-Reload / json.reload (cas 8, 10)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_ujs — µ._mjs_navApplyJson : reload — chemin JSON (cas 8, 10)', function () {
  it('8. reload:true → rechargement dur, AUCUN montage, AUCUN pushState, AUCUN mjs:load', function () {
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    const createCalls: string[] = []
    const pushCalls: any[] = []
    const navigateCalls: any[] = []
    const loadEvents: any[] = []
    const listeners: Array<(e: any) => void> = []
    const doc: any = {
      createElement: (tag: string) => { createCalls.push(tag); return { tag } },
      addEventListener: (_t: string, fn: any) => listeners.push(fn),
      dispatchEvent: (e: any) => { listeners.forEach((fn) => fn(e)); return true },
    }
    doc.addEventListener('mjs:load', (e: any) => loadEvents.push(e))
    const win: any = {
      location: { href: 'http://x/current', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) },
      history: { pushState: (...a: any[]) => pushCalls.push(a) },
    }
    const µ: any = {
      paths: { produit: 'xxx.js' }, version: 'v1',
      Router: { navigate: (...a: any[]) => navigateCalls.push(a) },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    µ._mjs_navApplyJson({ module: 'mjs-produit', props: { id: '42' }, url: '/produits/42', title: null, version: 'v1', reload: true }, '/produits/42', { push: true })

    assert.deepEqual(assignCalls, ['http://x/produits/42'], 'rechargement dur vers la destination résolue en absolu')
    assert.equal(reloadCalls.length, 0)
    assert.equal(createCalls.length, 0, 'AUCUN montage : document.createElement jamais appelé')
    assert.equal(pushCalls.length, 0, 'AUCUN pushState')
    assert.equal(navigateCalls.length, 0, 'AUCUN µ.Router.navigate')
    assert.equal(loadEvents.length, 0, 'AUCUN mjs:load')
  })

  it('10. reload PRIME sur une version différente présente en même temps : une seule action (assign), jamais deux', function () {
    const assignCalls: string[] = []
    const doc: any = { createElement: () => { throw new Error('ne doit jamais monter') } }
    const win: any = {
      location: { href: 'http://x/current', assign: (u: string) => assignCalls.push(u), reload: () => { throw new Error('ne doit pas appeler reload : assign attendu ici') } },
      history: { pushState: () => { throw new Error('ne doit pas pousser') } },
    }
    const µ: any = {
      paths: { produit: 'xxx.js' }, version: 'v1-client',
      Router: { navigate: () => { throw new Error('ne doit pas naviguer') } },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)

    // reload:true ET version différente (v1-client ≠ v2-serveur) PRÉSENTS SIMULTANÉMENT.
    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v2-serveur', reload: true }, '/produits/42', { push: true })

    assert.deepEqual(assignCalls, ['http://x/produits/42'], "une SEULE action : reload a primé, la garde de version n'a jamais tourné")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Chemin HTML — X-MJS-Reload, les 3 sites (cas 9), + variante HTML du cas 10
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_ujs — X-MJS-Reload : chemin HTML, les 3 sites (cas 9)', function () {
  it('9a. clic cross-page : rechargement, AUCUN parse DOMParser', function () {
    const assignCalls: string[] = []
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() {} },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, doc, DPInterdit)

    assert.ok(typeof capturedSuccess === 'function', 'le clic doit avoir lancé un fetch')
    capturedSuccess('<html><body>page servie par un back</body></html>', 'http://x/b', undefined, { version: null, target: null, method: null, reload: '1' })

    assert.deepEqual(assignCalls, ['http://x/b'], 'rechargement vers la destination finale')
    assert.deepEqual(zone.children, [oldContent], 'AUCUN swap : le contenu affiché reste celui de la page de départ')
  })

  it('9b. popstate (cache miss réseau) : rechargement, AUCUN parse DOMParser', function () {
    const assignCalls: string[] = []
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const win: any = { location: { pathname: '/b', search: '', hash: '', assign: (u: string) => assignCalls.push(u) } }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0, _mjs_navContainer: null,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))
    handler({}, µ, win, doc, DPInterdit)

    assert.ok(typeof capturedSuccess === 'function', 'cache miss ⇒ fetch réseau attendu')
    capturedSuccess('<html><body>page servie par un back</body></html>', 'http://x/b', undefined, { version: null, target: null, method: null, reload: 'yes' })

    assert.deepEqual(assignCalls, ['http://x/b'])
    assert.deepEqual(zone.children, [oldContent], 'AUCUN swap')
  })

  it('9c. submit : rechargement, AUCUN parse DOMParser — même sur un corps non-HTML', function () {
    const assignCalls: string[] = []
    const win: any = { location: { href: 'http://x/before', assign: (u: string) => assignCalls.push(u) }, history: { pushState() { throw new Error('ne doit pas pousser') } } }
    const doc: any = { getElementById: () => null }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DPInterdit)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => {} })
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('{"ok":true}', 'http://x/after', undefined, { version: null, target: null, method: null, reload: '1' })

    assert.deepEqual(assignCalls, ['http://x/after'], 'rechargement dur — le corps JSON-like n’a jamais été parsé comme une page')
  })

  it('10 (variante HTML). clic : reload PRIME sur une version différente — une seule action', function () {
    const assignCalls: string[] = []
    const zone = makeZone([{ tag: 'ancien', nodeType: 1 }])
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() {} },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', version: 'v2', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, doc, DPInterdit)

    capturedSuccess('<html>ignoré</html>', 'http://x/b', undefined, { version: 'v1-different', target: null, method: null, reload: '1' })

    assert.deepEqual(assignCalls, ['http://x/b'], 'une seule action : reload a primé sur la garde de version')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// µ._mjs_navRevalidate — X-MJS-Reload IGNORÉ (cas 11)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_ujs — µ._mjs_navRevalidate : X-MJS-Reload IGNORÉ sur un refetch silencieux de fond (cas 11)', function () {
  it("réponse identique + X-MJS-Reload présent dans l'en-tête : RIEN ne se passe (pas de rechargement, pas de swap)", function () {
    const zone = makeNode('body')
    const original = makeNode('original-content')
    zone.appendChild(original)
    zone.innerHTML = '<p>contenu</p>'
    const assignCalls: string[] = []
    const reloadCalls: number[] = []
    let success: any
    const µ: any = baseMu({ _mjs_navSeq: 0, _mjs_ajaxRequest: (opts: any) => { success = opts.success; return Promise.resolve() } })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    const win: any = { location: { href: 'http://x/a', assign: (u: string) => assignCalls.push(u), reload: () => reloadCalls.push(1) } }
    const respBody = makeNode('body')
    respBody.innerHTML = '<p>contenu</p>' // IDENTIQUE au contenant affiché
    class DP { parseFromString() { return makeDoc(respBody) } }
    installRevalidate(µ, win, makeDoc(makeNode('body')), DP)

    µ._mjs_navRevalidate(zone, '/a')
    assert.ok(typeof success === 'function')
    success('<html>ignoré</html>', '/a', undefined, { version: null, target: null, method: null, cache: null, reload: '1' })

    assert.deepEqual(zone.children, [original], 'aucun swap : contenu identique, comportement historique inchangé')
    assert.equal(assignCalls.length, 0, "X-MJS-Reload jamais lu sur ce chemin : aucun rechargement forcé sur un refetch silencieux")
    assert.equal(reloadCalls.length, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// µ._mjs_navMethodOf — 4e valeur 'none' (cas 12)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — µ._mjs_navMethodOf : 4e valeur 'none' (cas 12)", function () {
  it("'none' reconnu tel quel, SANS avertissement", function () {
    const warnCalls: any[] = []
    const µ: any = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
    installHelpers(µ, makeDoc(makeNode('body')), {})
    assert.equal(µ._mjs_navMethodOf('none'), 'none')
    assert.equal(warnCalls.length, 0)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// µ._mjs_navInstallNodes — method 'none' (cas 13)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — µ._mjs_navInstallNodes : method 'none' (cas 13)", function () {
  it('rien installé, rend null, µ._mjs_navContainer/µ._mjs_navZone/µ._mjs_navCachePolicy INCHANGÉS, hibernation en cours annulée', function () {
    const main = makeNode('main', 'main')
    const existingChild = makeNode('existing')
    main.appendChild(existingChild)
    const body = makeNode('body')
    body.appendChild(main)
    const hibernatedNode = makeNode('hibernated')
    hibernatedNode._mjs_page_cached = true
    const µ: any = baseMu({ pageCache: new Map([['/prev', [hibernatedNode]]]) })
    installHelpers(µ, makeDoc(body), {})
    // état de zone PRÉEXISTANT, posé par une navigation antérieure — doit survivre INTACT.
    µ._mjs_navContainer = main
    µ._mjs_navZone = main
    µ._mjs_navZoneMode = 'replaced'
    µ._mjs_navCachePolicy = 'revalidate'
    µ._mjs_navHibernated = { path: '/prev', nodes: [hibernatedNode] }

    const fresh = makeNode('mjs-should-not-appear')
    const result = µ._mjs_navInstallNodes({ zone: main, mode: 'target', target: '#main' }, [fresh], 'none', 'no-cache')

    assert.equal(result, null, 'aucun contenant effectif rendu')
    assert.deepEqual(main.children, [existingChild], "rien installé : le contenu affiché n'a pas bougé")
    assert.equal(µ._mjs_navContainer, main, 'µ._mjs_navContainer inchangé')
    assert.equal(µ._mjs_navZone, main, 'µ._mjs_navZone inchangé')
    assert.equal(µ._mjs_navZoneMode, 'replaced', 'µ._mjs_navZoneMode inchangé')
    assert.equal(µ._mjs_navCachePolicy, 'revalidate', "µ._mjs_navCachePolicy inchangé (le 'no-cache' passé en argument est IGNORÉ en method:'none')")
    assert.equal(µ._mjs_navHibernated, null, "l'hibernation en cours est annulée (µ._mjs_navDropHibernation)")
    assert.equal(hibernatedNode._mjs_page_cached, false)
    assert.equal(µ.pageCache.has('/prev'), false)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Chemin JSON — method:'none' (cas 14, 15)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — µ._mjs_navApplyJson : method:'none' — chemin JSON (cas 14, 15)", function () {
  it("14. props FUSIONNÉS dans µres (une clé préexistante absente de la réponse SURVIT), aucun montage, aucun pushState, aucun mjs:load, µ.Router.navigate pas appelé", function () {
    const createCalls: string[] = []
    const pushCalls: any[] = []
    const navigateCalls: any[] = []
    const loadEvents: any[] = []
    const listeners: Array<(e: any) => void> = []
    const doc: any = {
      createElement: (tag: string) => { createCalls.push(tag); return { tag } },
      addEventListener: (_t: string, fn: any) => listeners.push(fn),
      dispatchEvent: (e: any) => { listeners.forEach((fn) => fn(e)); return true },
    }
    doc.addEventListener('mjs:load', (e: any) => loadEvents.push(e))
    const win: any = { history: { pushState: (...a: any[]) => pushCalls.push(a) }, location: { href: 'http://x/posts/1' } }
    const µ: any = {
      Router: { navigate: (...a: any[]) => navigateCalls.push(a) },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    installResMerge(µ)
    µ.res = { keep_this: 'x', favorites_count: 1 }

    µ._mjs_navApplyJson({ module: 'mjs-post', method: 'none', props: { favorites_count: 3 }, url: '/posts/1/like', title: null, version: undefined }, '/posts/1/like', { push: true })

    assert.deepEqual(µ.res, { keep_this: 'x', favorites_count: 3 }, "fusion : 'keep_this' (absente de la réponse) SURVIT, 'favorites_count' est corrigée")
    assert.equal(createCalls.length, 0, 'aucun montage')
    assert.equal(pushCalls.length, 0, 'aucun pushState (même avec opts.push:true)')
    assert.equal(navigateCalls.length, 0, 'µ.Router.navigate pas appelé')
    assert.equal(loadEvents.length, 0, 'aucun mjs:load')
  })

  it("15. module:null ET method:'none' : PAS de panneau « Page introuvable » (les props sont quand même fusionnées)", function () {
    const createCalls: string[] = []
    const errorCalls: any[] = []
    const doc: any = { createElement: (tag: string) => { createCalls.push(tag); return { tag, setAttribute() {}, appendChild() {} } } }
    const win: any = { history: { pushState() { throw new Error('ne doit pas pousser') } } }
    const µ: any = {
      config: { routeNotFound: 'error' },
      warn() {}, error: (...a: any[]) => errorCalls.push(a), log() {},
      Router: { navigate: () => { throw new Error('ne doit pas naviguer') }, _mjs_updateUrlStore: () => { throw new Error('ne doit pas resynchroniser') } },
    }
    installHelpers(µ, doc, win)
    installResMerge(µ)
    µ.res = { keep: 1 }

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: null, method: 'none', props: { fresh: 2 }, url: '/posts/1/like', title: null, version: undefined }, '/posts/1/like', { push: true })
    }, "method:'none' avec module:null ne doit JAMAIS partir dans la branche panneau « Page introuvable »")

    assert.equal(createCalls.length, 0, 'AUCUN panneau créé (document.createElement jamais appelé)')
    assert.equal(errorCalls.length, 0, 'AUCUN µ.error : le message « Aucune page ne correspond » ne doit jamais sortir')
    assert.deepEqual(µ.res, { keep: 1, fresh: 2 }, 'les props sont quand même fusionnées')
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// Chemin HTML — X-MJS-Method: none, corps qui n'est PAS une page (cas 16) + remarques d'observation
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — X-MJS-Method: none : chemin HTML, corps qui N'EST PAS une page (cas 16)", function () {
  it('16a. submit, corps \'{"ok":true}\' : aucun avertissement, rien installé', function () {
    const warnCalls: any[] = []
    const installCalls: any[] = []
    const liveRoot: any = { replaceChildren(...nodes: any[]) { installCalls.push(nodes) } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() { throw new Error('ne doit pas pousser') } } }
    const doc: any = { body: liveRoot, getElementById: () => null }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn: (...a: any[]) => warnCalls.push(a), error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DPInterdit)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => {} })
    assert.ok(typeof capturedSuccess === 'function')
    assert.doesNotThrow(() => {
      capturedSuccess('{"ok":true}', 'http://x/posts', undefined, { version: null, target: null, method: 'none', reload: null })
    })

    assert.equal(warnCalls.length, 0, 'AUCUN avertissement « réponse non reconnue » — un back peut répondre un 200 vide sans être grondé')
    assert.equal(installCalls.length, 0, 'rien installé')
  })

  it('16b. submit, corps VIDE : aucun avertissement, rien installé', function () {
    const warnCalls: any[] = []
    const installCalls: any[] = []
    const liveRoot: any = { replaceChildren(...nodes: any[]) { installCalls.push(nodes) } }
    const win: any = { location: { href: 'http://x/posts/1', origin: 'http://x' }, history: { pushState() { throw new Error('ne doit pas pousser') } } }
    const doc: any = { body: liveRoot, getElementById: () => null }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn: (...a: any[]) => warnCalls.push(a), error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    installHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DPInterdit)

    µ._mjs_navDispatch('http://x/posts/1', 'DELETE', new FakeFormData(), { restoreBusy: () => {} })
    assert.ok(typeof capturedSuccess === 'function')
    assert.doesNotThrow(() => {
      capturedSuccess('', 'http://x/posts/1', undefined, { version: null, target: null, method: 'none', reload: null })
    })

    assert.equal(warnCalls.length, 0)
    assert.equal(installCalls.length, 0)
  })

  it("16c. clic cross-page : AUCUN parse DOMParser, rien installé — pushState a DÉJÀ eu lieu AU CLIC, 'none' arrive trop tard pour l'empêcher", function () {
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const pushCalls: any[] = []
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a' },
      history: { pushState: (...a: any[]) => pushCalls.push(a) },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, doc, DPInterdit)

    // pushState est déjà SYNCHRONE au clic (avant même le départ du fetch) : la fiche
    // 'none' arrivera nécessairement APRÈS, trop tard pour l'empêcher.
    assert.equal(pushCalls.length, 1, 'pushState a lieu SYNCHRONE au clic, AVANT toute réponse réseau')
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html>ignoré</html>', 'http://x/b', undefined, { version: null, target: null, method: 'none', reload: null })

    assert.equal(pushCalls.length, 1, "'none' n'ajoute PAS de 2e pushState — mais ne peut pas non plus annuler le 1er (déjà survenu)")
    assert.deepEqual(zone.children, [oldContent], 'AUCUN swap : le contenu affiché reste celui de la page de départ')
  })

  it("16d. popstate (cache miss réseau) : AUCUN parse DOMParser, rien installé — le navigateur a DÉJÀ déplacé window.location avant que ce handler ne tourne (nature même de popstate), 'none' arrive trop tard", function () {
    const oldContent: any = { tag: 'contenu-a', nodeType: 1 }
    const zone = makeZone([oldContent])
    // le navigateur a DÉJÀ changé l'URL : popstate tire APRÈS coup, jamais avant — aucun code de ce
    // fichier ne « pousse » ici, c'est la navigation native (back/forward) qui a déjà eu lieu.
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0, _mjs_navContainer: null,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
    }
    installHelpers(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))
    handler({}, µ, win, doc, DPInterdit)

    assert.ok(typeof capturedSuccess === 'function', 'cache miss ⇒ fetch réseau attendu')
    capturedSuccess('<html>ignoré</html>', 'http://x/b', undefined, { version: null, target: null, method: 'none', reload: null })

    assert.deepEqual(zone.children, [oldContent], 'le contenu affiché ne bouge pas')
    // Ce code ne tente PAS un history.back() compensatoire (écarté par conception) : l'adresse
    // affichée reste celle vers laquelle le navigateur a DÉJÀ navigué, alors que le CONTENU affiché est
    // toujours celui de la page quittée. Divergence adresse/contenu assumée.
    assert.equal(win.location.pathname, '/b', "l'adresse affichée reste celle du popstate — aucun rembobinage tenté")
    assert.equal(µ._mjs_lastUjsPath, '/a', "le framework sait que le contenu AFFICHÉ est toujours celui de /a (rien n'a été installé)")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// method:'none' — dé-hibernation bout-en-bout (cas 17)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — method:'none' : dé-hibernation bout-en-bout (cas 17)", function () {
  it("clic (protocole JSON) : l'hibernation posée AVANT la réponse est annulée — _mjs_page_cached repassé à false, entrée µ.pageCache retirée, page quittée toujours affichée telle quelle", function () {
    const body = makeNode('body')
    const oldContent = makeNode('page-a-content')
    body.appendChild(oldContent)
    const doc = makeDoc(body)
    const pushCalls: any[] = []
    const win: any = {
      location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' },
      // pushState a lieu SYNCHRONE AU CLIC (avant toute réponse, cf. cas 16c/16d) — spy, pas un throw :
      // on vérifie que 'none' n'en ajoute PAS un second, pas qu'il n'y en a aucun.
      history: { pushState: (...a: any[]) => pushCalls.push(a) },
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
      Router: { navigate: () => { throw new Error("ne doit pas naviguer en method:'none'") } },
    })
    installHelpers(µ, doc, win)
    installResMerge(µ)
    µ.res = {} // amorçage : évite le repli µ.state({}) de µ._mjs_resMerge (hors sujet ici)
    new Function('µ', extractAjaxGetStatement(UJS_SRC))(µ)
    const clickHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    const link = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }

    clickHandler(e, µ, win, doc, class {})

    assert.equal(pushCalls.length, 1, 'pushState au clic (déjà établi au test 16c) : une entrée, avant toute réponse')
    assert.equal(oldContent._mjs_page_cached, true, 'hibernation posée au clic : contenu quitté flaggé')
    assert.equal(µ.pageCache.has('/a'), true, 'entrée de cache posée pour le chemin quitté')
    assert.ok(µ._mjs_navHibernated && µ._mjs_navHibernated.path === '/a')

    assert.equal(capturedAjax.length, 1, 'le fetch réseau doit être parti (µ._mjs_ajaxRequest, canal interne)')
    capturedAjax[0].success({ module: null, method: 'none', props: {}, url: '/b', title: null, version: undefined }, '/b')

    assert.equal(pushCalls.length, 1, "'none' n'ajoute PAS de 2e pushState")
    assert.equal(oldContent._mjs_page_cached, false, "dé-hibernation : le contenu quitté n'est plus exempté de destruction")
    assert.equal(µ.pageCache.has('/a'), false, "l'entrée pointait un contenu resté VIVANT sous <body> : retirée par 'none'")
    assert.equal(µ._mjs_navHibernated, null, 'hibernation consommée')
    assert.deepEqual(body.children, [oldContent], "'none' : la page quittée reste affichée TELLE QUELLE, rien d'autre installé")
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// method:'none' — µ.nav.active et la barre de progression (cas 18)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ujs — method:'none' : µ.nav.active et la barre de progression (cas 18)", function () {
  it("_mjs_navDispatch (submit) : µ.nav.active retombe à false et µ._mjs_navProgressStop est appelé, même en method:'none'", function () {
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const doc: any = { getElementById: () => null }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      nav: { active: false, href: null },
    }
    installHelpers(µ, doc, win)
    const progressStopCalls: number[] = []
    const realStop = µ._mjs_navProgressStop
    µ._mjs_navProgressStop = function (...args: any[]) { progressStopCalls.push(1); return realStop.apply(this, args) }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FakeFormData, URL, DPInterdit)

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => {} })
    assert.equal(µ.nav.active, true, 'actif pendant la requête')
    assert.ok(typeof capturedSuccess === 'function')

    capturedSuccess('{"ok":true}', 'http://x/posts', undefined, { version: null, target: null, method: 'none', reload: null })

    assert.equal(µ.nav.active, false, "retombe même en method:'none'")
    assert.equal(µ.nav.href, null)
    assert.equal(progressStopCalls.length, 1, 'µ._mjs_navProgressStop appelé (barre de progression retirée)')
  })

  it("clic cross-page (protocole JSON) : µ.nav.active retombe à false également", function () {
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a' },
      history: { pushState() {} },
      scrollTo() {},
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
      nav: { active: false, href: null },
    }
    installHelpers(µ, doc, win)
    installResMerge(µ)
    µ.res = {} // amorçage : évite le repli µ.state({}) de µ._mjs_resMerge (hors sujet ici)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, doc, class {})

    assert.equal(µ.nav.active, true, 'actif pendant la requête')
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess({ module: null, method: 'none', props: {}, url: '/b', title: null, version: undefined }, '/b')

    assert.equal(µ.nav.active, false, "retombe même en method:'none'")
    assert.equal(µ.nav.href, null)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// mjs_store_globals — µ._mjs_resMerge : fusion plutôt que remplacement (cas 19)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe('mjs_store_globals — µ._mjs_resMerge : fusion plutôt que remplacement', function () {
  it('clé préexistante ABSENTE de la réponse SURVIT, clé envoyée est corrigée, nouvelle clé ajoutée', function () {
    const µ: any = { warn() {} }
    µ.res = { a: 1, b: 2 }
    installResMerge(µ)

    µ._mjs_resMerge({ b: 99, c: 3 })

    assert.deepEqual(µ.res, { a: 1, b: 99, c: 3 })
  })

  it('amorçage : µ.res absent → µ.state({}) via le même repli lazy que µ._mjs_resSet', function () {
    let stateCalls = 0
    const µ: any = { warn() {}, state: (o: any) => { stateCalls++; return o } }
    installResMerge(µ)

    µ._mjs_resMerge({ x: 1 })

    assert.equal(stateCalls, 1)
    assert.deepEqual(µ.res, { x: 1 })
  })

  it("EFFACER une clé sur ce chemin exige de l'envoyer EXPLICITEMENT à null — l'OMETTRE ne l'efface JAMAIS", function () {
    const µ: any = { warn() {} }
    µ.res = { a: 1, b: 2 }
    installResMerge(µ)

    µ._mjs_resMerge({ b: null })

    assert.deepEqual(µ.res, { a: 1, b: null }, 'b vaut EXPLICITEMENT null (posé), jamais supprimé')
    assert.ok(Object.prototype.hasOwnProperty.call(µ.res, 'a'), "'a', omise de cet appel, survit intacte")
  })

  it("19. __proto__ (via JSON.parse) REFUSÉ, avec le MÊME avertissement que µ._mjs_resSet — le [[Prototype]] de µ.res n'est jamais touché", function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    µ.res = { safe: 'avant' }
    installResMerge(µ)

    const evil = JSON.parse('{"__proto__":{"pollue":1},"safe":"apres"}')
    µ._mjs_resMerge(evil)

    assert.equal((µ.res as any).pollue, undefined, 'µ.res.pollue doit rester undefined')
    assert.equal(Object.getPrototypeOf(µ.res), Object.prototype, 'le [[Prototype]] de µ.res reste Object.prototype, jamais pollué')
    assert.equal(µ.res.safe, 'apres', "la clé légitime 'safe' est quand même écrite")
    assert.equal(warnCalls.length, 1, 'un avertissement doit signaler la clé refusée')
    assert.match(warnCalls[0][0], /__proto__/)
  })
})

// ════════════════════════════════════════════════════════════════════════════════════════════════
// mjs_ajax — X-MJS-Reload propagé dans l'objet nav (validation du câblage mjs_ajax.ts)
// ════════════════════════════════════════════════════════════════════════════════════════════════
describe("mjs_ajax — X-MJS-Reload propagé dans l'objet nav", function () {
  it("en-tête 'X-MJS-Reload' présent → nav.reload le porte ; absent → null (jamais undefined)", async function () {
    const fakeDocument = { querySelector: () => null }

    const µ1: any = { log() {}, warn() {}, error() {} }
    const fetch1 = async () => makeFakeResponse({ url: 'https://x/a', body: '<html><body>ok</body></html>', headers: { 'X-MJS-Reload': '1' } })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ1, fetch1, fakeDocument)
    const nav1: any = await new Promise((resolve) => {
      µ1.ajax.get('https://x/a', (_b: any, _u: any, _s: any, nav: any) => resolve(nav))
    })
    assert.equal(nav1.reload, '1')

    const µ2: any = { log() {}, warn() {}, error() {} }
    const fetch2 = async () => makeFakeResponse({ url: 'https://x/a', body: '<html><body>ok</body></html>' })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ2, fetch2, fakeDocument)
    const nav2: any = await new Promise((resolve) => {
      µ2.ajax.get('https://x/a', (_b: any, _u: any, _s: any, nav: any) => resolve(nav))
    })
    assert.equal(nav2.reload, null, 'absent → null, jamais undefined')
  })
})
