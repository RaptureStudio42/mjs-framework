// Le <head> suit la navigation : titre d'onglet, une poignée de <meta> et
// <link rel="canonical"> échangés au fil d'un swap UJS (jusqu'ici seul le CONTENU du contenant
// bougeait, cf. tests/ujs-nav-target-method-html.test.ts). Couvre :
//   1-12. µ._mjs_navApplyHead (+ µ._mjs_navHeadKeyOf/µ._mjs_navHeadReconcile) en isolation : titre présent/
//         absent/vide, <head> reçu VIDE, réconciliation PAR CLÉ (nœud existant conservé/retiré/
//         ajouté), périmètre FERMÉ (hors périmètre jamais touché, mjs-cache non-régression),
//         opt-out µ.config.navHead, try/catch (appendChild qui jette).
//   13-15. protocole JSON (µ._mjs_navApplyJson/µ._mjs_navDispatch) : clé `title` enfin lue (nominale/404/
//          null), ORDRE composant vs serveur (posé SYNCHRONE, un <@head><title> ultérieur gagne),
//          422 intouché.
//   16. cache de pages : hibernation photographie la tête (µ._mjs_navSnapshotHead, posé sur
//       `nodes._mjs_mjsHead`), un cache-hit la restaure (µ._mjs_navRestoreHead) — titre ET métadonnée de la
//       page reviennent avec elle.
//   + wiring : les 3 sites de swap HTML (clic/popstate/submit) et µ._mjs_navRevalidate appellent
//     bien µ._mjs_navApplyHead — non vérifié par les cas 1-12 (isolés), donc testé séparément ici.
//
// Méthode : extraction RÉELLE depuis la source (readFileSync + new Function), même convention que
// tests/ujs-nav-json.test.ts et tests/ujs-nav-target-method-html.test.ts (lus avant d'écrire ce
// fichier). SEULE différence délibérée : happy-dom (un VRAI `document`/`DOMParser`) plutôt que des
// nœuds fabriqués à la main — la réconciliation testée ici (attributs recopiés en place, identité de
// nœud préservée, `document.importNode`) a besoin d'éléments <head> réels ; happy-dom convient
// (« happy-dom implémente importNode, mais un harnais minimal peut ne
// pas l'avoir »). La technique d'extraction (regex + comptage d'accolades, `new Function`, jamais de
// stub du code testé) reste identique aux fichiers voisins.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'
import { assertAbsent } from './helpers/dom-assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}
function extractSubmitBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
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

// FakeFormData — même forme que tests/ujs-nav-json.test.ts : le vrai FormData (Node/happy-dom) exige
// un <form> réel (introspecte .elements), hors sujet ici (on ne teste QUE la tête, pas les champs).
class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}

// Environnement RÉEL (happy-dom) + `µ` minimal portant les collaborateurs muets habituels des
// fichiers voisins (warn/error/log/Router.navigate no-op, pageCache en Map). `installHelpers` (re)pose
// TOUS les helpers sur ce `µ`, y compris les 6 fonctions neuves de gestion du <head> —
// elles vivent dans le MÊME bloc (bandeau GESTION DU <HEAD>, entre µ._mjs_navCachePolicy et HIBERNATION).
function setup(url = 'http://x/a') {
  const win: any = new Window({ url })
  const document: any = win.document
  const µ: any = {
    realTarget: (e: any) => e.target,
    _mjs_navSeq: 0,
    _mjs_lastUjsPath: new win.URL(url).pathname,
    pageCache: new Map(),
    _mjs_preloadCache: new Map(),
    _mjs_preloaded: new Set(),
    _mjs_saveScroll() {}, _mjs_restoreScroll() {},
    _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
    warn() {}, error() {}, log() {},
    Router: { navigate() {} },
  }
  installHelpers(µ, document, win)
  return { win, document, µ }
}
function parse(win: any, html: string) {
  return new win.DOMParser().parseFromString(html, 'text/html')
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
function doClick(µ: any, win: any, document: any, link: any) {
  const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
  return handler(makeClickEvent(link), µ, win, document, win.DOMParser)
}

// ────────────────────────────────────────────────────────────────────────────
// µ._mjs_navHeadKeyOf — clés du périmètre FERMÉ (unité, en complément du cas 9 plus bas)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navHeadKeyOf : clés du périmètre fermé', function () {
  it('meta name description/keywords/robots/author → meta:name:X', function () {
    const { document, µ } = setup()
    for (const name of ['description', 'keywords', 'robots', 'author']) {
      const el = document.createElement('meta')
      el.setAttribute('name', name)
      assert.equal(µ._mjs_navHeadKeyOf(el), 'meta:name:' + name)
    }
  })
  it("meta name og:*/twitter:* → meta:name:X ; meta property og:*/twitter:*/article:* → meta:prop:X", function () {
    const { document, µ } = setup()
    const a = document.createElement('meta'); a.setAttribute('name', 'og:title')
    assert.equal(µ._mjs_navHeadKeyOf(a), 'meta:name:og:title')
    const b = document.createElement('meta'); b.setAttribute('property', 'twitter:card')
    assert.equal(µ._mjs_navHeadKeyOf(b), 'meta:prop:twitter:card')
    const c = document.createElement('meta'); c.setAttribute('property', 'article:published_time')
    assert.equal(µ._mjs_navHeadKeyOf(c), 'meta:prop:article:published_time')
  })
  it('link rel="canonical" (casse/espaces rognés) → link:canonical ; hors périmètre → null', function () {
    const { document, µ } = setup()
    const l = document.createElement('link'); l.setAttribute('rel', '  Canonical  ')
    assert.equal(µ._mjs_navHeadKeyOf(l), 'link:canonical')
    const notMeta = document.createElement('div')
    assert.equal(µ._mjs_navHeadKeyOf(notMeta), null)
    assert.equal(µ._mjs_navHeadKeyOf(null), null)
    assert.equal(µ._mjs_navHeadKeyOf({ nodeType: 3, getAttribute: () => null }), null, 'nodeType≠1 → null')
    assert.equal(µ._mjs_navHeadKeyOf({ nodeType: 1 }), null, 'sans getAttribute → null')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// µ._mjs_navApplyHead — cas 1 à 12 (obligatoires)
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navApplyHead : titre + métadonnées, cas 1 à 12', function () {
  it('cas 1 — <title> présent dans la réponse → document.title mis à jour', function () {
    const { win, document, µ } = setup()
    document.title = 'Ancien titre'
    const doc = parse(win, '<html><head><title>Nouveau titre</title></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assert.equal(document.title, 'Nouveau titre')
  })

  it('cas 2 — <title> ABSENT de la réponse → document.title INCHANGÉ (jamais effacé)', function () {
    const { win, document, µ } = setup()
    document.title = 'Titre affiché'
    const doc = parse(win, '<html><head><meta name="description" content="d"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assert.equal(document.title, 'Titre affiché')
  })

  it('cas 3 — <title> présent mais vide/espaces → document.title INCHANGÉ', function () {
    const { win, document, µ } = setup()
    document.title = 'Titre affiché'
    const doc = parse(win, '<html><head><title>   </title></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assert.equal(document.title, 'Titre affiché')
  })

  it('cas 4 — <head> reçu VIDE (fixture historique) → ni titre ni métadonnée touchés', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<meta name="description" content="avant">'
    document.title = 'Titre affiché'
    const doc = parse(win, '<html><body>ok</body></html>')
    assert.equal(doc.head.children.length, 0, 'contrôle fixture : DOMParser synthétise un <head> VIDE')
    µ._mjs_navApplyHead(doc)
    assert.equal(document.title, 'Titre affiché')
    assert.equal(document.head.querySelector('meta[name="description"]').getAttribute('content'), 'avant')
  })

  it('cas 5 — meta[name=description] des deux côtés → le NŒUD EXISTANT est conservé, seul son content change', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title><meta name="description" content="avant">'
    const before = document.head.querySelector('meta[name="description"]')
    const doc = parse(win, '<html><head><title>T</title><meta name="description" content="après"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    const after = document.head.querySelector('meta[name="description"]')
    assert.equal(after, before, 'même nœud DOM, jamais retiré/recréé')
    assert.equal(after.getAttribute('content'), 'après')
  })

  it('cas 6 — meta[property=og:image] présent seulement côté réponse → ajouté', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title>'
    const doc = parse(win, '<html><head><title>T</title><meta property="og:image" content="/img.png"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    const meta = document.head.querySelector('meta[property="og:image"]')
    assert.ok(meta, 'ajouté')
    assert.equal(meta.getAttribute('content'), '/img.png')
  })

  it('cas 7 — meta[name=robots] présent seulement côté page → RETIRÉ', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title><meta name="robots" content="noindex">'
    const doc = parse(win, '<html><head><title>T</title></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assertAbsent(document.head.querySelector('meta[name="robots"]'))
  })

  it('cas 8 — link[rel=canonical] : href mis à jour SUR PLACE (même nœud)', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title><link rel="canonical" href="/a">'
    const before = document.head.querySelector('link[rel="canonical"]')
    const doc = parse(win, '<html><head><title>T</title><link rel="canonical" href="/b"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    const after = document.head.querySelector('link[rel="canonical"]')
    assert.equal(after, before)
    assert.equal(after.getAttribute('href'), '/b')
  })

  it('cas 9 — HORS PÉRIMÈTRE (charset/viewport/csrf-token/http-equiv/style/script/stylesheet) : tous encore là, absents côté réponse', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML =
      '<meta charset="utf-8">' +
      '<meta name="viewport" content="width=device-width">' +
      '<meta name="csrf-token" content="abc123">' +
      '<meta http-equiv="X-UA-Compatible" content="IE=edge">' +
      '<style>body{color:red}</style>' +
      '<script src="/app.js"></script>' +
      '<link rel="stylesheet" href="/app.css">' +
      '<link rel="icon" href="/f.ico">' +
      '<title>T</title>'
    const doc = parse(win, '<html><head><title>T2</title></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assert.ok(document.head.querySelector('meta[charset]'), 'charset toujours là')
    assert.ok(document.head.querySelector('meta[name="viewport"]'), 'viewport toujours là')
    assert.ok(document.head.querySelector('meta[name="csrf-token"]'), 'csrf-token toujours là')
    assert.ok(document.head.querySelector('meta[http-equiv="X-UA-Compatible"]'), 'http-equiv toujours là')
    assert.ok(document.head.querySelector('style'), 'style toujours là')
    assert.ok(document.head.querySelector('script[src="/app.js"]'), 'script toujours là')
    assert.ok(document.head.querySelector('link[rel="stylesheet"]'), 'stylesheet toujours là')
    assert.ok(document.head.querySelector('link[rel="icon"]'), 'icon toujours là')
  })

  it('cas 10 — meta[name=mjs-cache] hors périmètre lui aussi + µ._mjs_navCacheOf lit toujours la balise dans le doc PARSÉ (non-régression)', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title><meta name="mjs-cache" content="cache-first">'
    const doc = parse(win, '<html><head><title>T2</title><meta name="mjs-cache" content="revalidate"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    // la balise CÔTÉ PAGE n'a pas bougé : hors périmètre, ni retirée ni recopiée
    assert.equal(document.head.querySelector('meta[name="mjs-cache"]').getAttribute('content'), 'cache-first')
    // non-régression : µ._mjs_navCacheOf lit celle du document REÇU, jamais document.head
    assert.equal(µ._mjs_navCacheOf(doc, null), 'revalidate')
  })

  it("cas 11 — µ.config.navHead === false → aucun changement, ni titre ni métadonnée", function () {
    const { win, document, µ } = setup()
    µ.config = { navHead: false }
    document.head.innerHTML = '<meta name="description" content="avant">'
    document.title = 'Titre affiché'
    const doc = parse(win, '<html><head><title>Nouveau</title><meta name="description" content="après"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assert.equal(document.title, 'Titre affiché')
    assert.equal(document.head.querySelector('meta[name="description"]').getAttribute('content'), 'avant')
  })

  it('cas 12 — document.head.appendChild qui JETTE → la navigation aboutit quand même, le contenu est installé (preuve du try/catch)', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>Départ</title>'
    document.body.innerHTML = '<a id="toB" href="/b">go</a><p id="marqueur-ancien">ancien</p>'
    const link = document.body.querySelector('#toB')
    document.head.appendChild = function () { throw new Error('boom') }
    let capturedCb: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb = cb }
    assert.doesNotThrow(() => { doClick(µ, win, document, link) }, 'le clic lui-même ne doit rien lever')
    assert.ok(typeof capturedCb === 'function')
    assert.doesNotThrow(() => {
      capturedCb('<html><head><title>Arrivée</title><meta name="description" content="d"></head><body><p id="marqueur-neuf">neuf</p></body></html>', 'http://x/b')
    }, 'un appendChild qui jette PENDANT la réconciliation de tête ne doit jamais faire tomber la navigation')
    // le titre (écriture directe document.title=, pas d'appendChild) a quand même changé AVANT l'échec
    assert.equal(document.title, 'Arrivée')
    // le CONTENU, lui, s'installe normalement malgré l'échec du appendChild sur la tête
    assert.ok(document.body.querySelector('#marqueur-neuf'), 'contenu neuf installé')
    assertAbsent(document.body.querySelector('#marqueur-ancien'), 'ancien contenu bien remplacé')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Wiring — les 3 sites de swap HTML + µ._mjs_navRevalidate appellent bien µ._mjs_navApplyHead. Les cas 1-12
// ci-dessus appellent µ._mjs_navApplyHead EN ISOLATION (jamais via une vraie navigation) : sans ce bloc,
// une régression « le branchement disparaît d'un site » (ex. click) passerait inaperçue.
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navApplyHead : câblage réel sur les 3 sites HTML + µ._mjs_navRevalidate', function () {
  it('clic cross-page (réseau) : le titre suit la réponse HTML', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>Départ</title>'
    document.body.innerHTML = '<a id="go" href="/b">go</a><p>ancien</p>'
    const link = document.body.querySelector('#go')
    let capturedCb: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb = cb }
    doClick(µ, win, document, link)
    assert.ok(typeof capturedCb === 'function')
    capturedCb('<html><head><title>Arrivée clic</title></head><body><p>neuf</p></body></html>', 'http://x/b')
    assert.equal(document.title, 'Arrivée clic')
  })

  it('popstate (cache miss réseau) : le titre suit la réponse HTML', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>Page A</title>'
    document.body.innerHTML = '<p>contenu A</p>'
    win.history.pushState({}, '', '/b') // le navigateur a déjà bougé, comme au vrai popstate
    let capturedSuccess: any
    µ._mjs_ajaxRequest = (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() }
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))
    popHandler({}, µ, win, document, win.DOMParser)
    assert.ok(typeof capturedSuccess === 'function', 'cache miss → fetch réseau attendu')
    capturedSuccess('<html><head><title>Page B (retour)</title></head><body><p>contenu B</p></body></html>', 'http://x/b')
    assert.equal(document.title, 'Page B (retour)')
  })

  it('submit (formulaire) : le titre suit la réponse HTML', function () {
    const { win, document, µ } = setup('http://x/search')
    document.head.innerHTML = '<title>Recherche</title>'
    document.body.innerHTML = '<p>anciens résultats</p>'
    let capturedSuccess: any
    µ._mjs_ajaxRequest = (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, document, FakeFormData, URL, win.DOMParser)
    const submitHandler = new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody(UJS_SRC))
    const form: any = { hasAttribute: () => false, getAttribute: (k: string) => (k === 'action' ? '/search' : k === 'method' ? 'POST' : null), target: '', action: 'http://x/search', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter: null, composedPath: () => [form], target: form }
    submitHandler(e, µ, win, document, FakeFormData, URL, win.DOMParser)
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><head><title>Résultats</title></head><body><p>nouveaux résultats</p></body></html>', 'http://x/search')
    assert.equal(document.title, 'Résultats')
  })

  it('µ._mjs_navRevalidate (rafraîchissement de fond, policy revalidate) : la tête suit AUSSI quand le contenu diffère', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>Ancien titre</title>'
    document.body.innerHTML = '<p>ancien</p>'
    const zone = document.body
    let capturedSuccess: any
    µ._mjs_ajaxRequest = (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() }
    // µ._mjs_navRevalidate vit dans le bloc helpers mais SANS DOMParser en portée (comme le vrai fichier
    // navigateur, où DOMParser est global) — réinstallation CIBLÉE avec DOMParser injecté, même
    // technique que tests/ujs-nav-cache-policy.test.ts (installRevalidate).
    new Function('µ', 'window', 'document', 'DOMParser', extractNavRevalidateStatement(UJS_SRC))(µ, win, document, win.DOMParser)
    µ._mjs_navRevalidate(zone, '/a')
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><head><title>Titre rafraîchi</title></head><body><p>nouveau</p></body></html>', 'http://x/a')
    assert.equal(document.title, 'Titre rafraîchi')
  })

  it("µ._mjs_navRevalidate : contenu IDENTIQUE (differs===false) → la tête ne bouge pas non plus (même court-circuit)", function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>Titre stable</title>'
    document.body.innerHTML = '<p>identique</p>'
    const zone = document.body
    let capturedSuccess: any
    µ._mjs_ajaxRequest = (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() }
    new Function('µ', 'window', 'document', 'DOMParser', extractNavRevalidateStatement(UJS_SRC))(µ, win, document, win.DOMParser)
    µ._mjs_navRevalidate(zone, '/a')
    capturedSuccess('<html><head><title>Titre différent (ignoré)</title></head><body><p>identique</p></body></html>', 'http://x/a')
    assert.equal(document.title, 'Titre stable', "rien ne bouge : le HTML comparé (innerHTML) est identique, aucun clignotement")
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Protocole JSON — cas 13, 14, 15
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navApplyJson : la clé `title` de la fiche, enfin lue — cas 13, 14', function () {
  it("cas 13a — fiche nominale title:'Fiche produit' → document.title posé", function () {
    const { document, µ } = setup()
    µ.paths = { produit: 'xxx.js' }
    µ.version = 'v1'
    µ._mjs_resSet = () => {}
    document.title = 'Avant'
    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: 'Fiche produit', version: 'v1' }, '/produits/42', { push: false })
    assert.equal(document.title, 'Fiche produit')
  })

  it('cas 13b — fiche nominale title:null → document.title INCHANGÉ', function () {
    const { document, µ } = setup()
    µ.paths = { produit: 'xxx.js' }
    µ.version = 'v1'
    µ._mjs_resSet = () => {}
    document.title = 'Avant'
    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, '/produits/42', { push: false })
    assert.equal(document.title, 'Avant')
  })

  it('cas 13c — 404 (module:null) avec title → posé (un panneau « Page introuvable » a droit à son titre)', function () {
    const { document, µ } = setup()
    document.title = 'Avant'
    µ._mjs_navApplyJson({ module: null, props: {}, url: '/inconnu', title: 'Page manquante', version: 'v1' }, '/inconnu', { push: false })
    assert.equal(document.title, 'Page manquante')
  })

  it('cas 14 — ORDRE composant vs serveur : titre serveur posé SYNCHRONE (avant tout microtask), un <@head><title> ultérieur (microtâche) gagne toujours', async function () {
    const { document, µ } = setup()
    µ.paths = { produit: 'xxx.js' }
    µ.version = 'v1'
    µ._mjs_resSet = () => {}
    document.title = 'Avant'
    µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: 'Titre serveur', version: 'v1' }, '/produits/42', { push: false })
    // PREUVE de synchronicité : déjà là au RETOUR de l'appel, avant qu'aucune microtâche n'ait pu tourner.
    assert.equal(document.title, 'Titre serveur', 'le titre serveur doit être posé de façon SYNCHRONE, dans le swap')
    // simulation de µ._mjs_setTitle (mjs_runes.ts) : tourne dans un µ.effect(), donc dans la 1re microtâche
    // après le montage — ici simulée explicitement par une continuation .then().
    Promise.resolve().then(function () { document.title = 'Titre du composant' })
    await Promise.resolve()
    await Promise.resolve()
    assert.equal(document.title, 'Titre du composant', "le <@head><title> du composant gagne : ordre naturel, aucune priorité codée en dur")
  })
})

describe('mjs_ujs — µ._mjs_navDispatch : cas 15 — 422 JSON, document.title INTOUCHÉ', function () {
  it('422 (formulaire re-affiché avec ses erreurs) : aucun contact avec document.title', function () {
    const { win, document, µ } = setup('http://x/posts')
    document.title = 'Avant soumission'
    µ._mjs_resSet = () => {}
    let capturedError: any
    µ._mjs_ajaxRequest = (opts: any) => { capturedError = opts.error; return Promise.resolve() }
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, document, FakeFormData, URL, win.DOMParser)
    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => {} })
    assert.ok(typeof capturedError === 'function')
    capturedError({ status: 422, body: { module: 'mjs-new-post', props: { title: '', errors: { title: 'requis' } }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })
    assert.equal(document.title, 'Avant soumission')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// Cache de pages — cas 16
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — cache de pages : cas 16 — hibernation photographie la tête, un cache-hit la restaure', function () {
  it('hiberne A (titre A + meta description A), navigue vers B (réseau), revient vers A (cache-hit) → titre A ET sa métadonnée reviennent, le contenu aussi', function () {
    const { win, document, µ } = setup('http://x/a')
    document.head.innerHTML = '<title>Page A</title><meta name="description" content="Description A">'
    document.body.innerHTML = '<a id="toB" href="/b">vers B</a><p id="contenu-a">contenu A</p>'

    let capturedCb: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb = cb }
    doClick(µ, win, document, document.body.querySelector('#toB'))
    assert.ok(typeof capturedCb === 'function', 'clic A→B : cache MISS, fetch réseau attendu')
    capturedCb('<html><head><title>Page B</title></head><body><a id="toA" href="/a">vers A</a><p id="contenu-b">contenu B</p></body></html>', 'http://x/b')
    assert.equal(document.title, 'Page B')
    assert.ok(µ.pageCache.has('/a'), 'la page A doit être hibernée au départ')

    capturedCb = undefined
    doClick(µ, win, document, document.body.querySelector('#toA'))
    assert.equal(capturedCb, undefined, 'cache-hit : AUCUN fetch réseau pour revenir vers A')
    assert.equal(document.title, 'Page A', 'le titre A revient')
    const meta = document.head.querySelector('meta[name="description"]')
    assert.ok(meta, 'la métadonnée de A revient')
    assert.equal(meta.getAttribute('content'), 'Description A')
    assert.ok(document.body.querySelector('#contenu-a'), 'le contenu de A revient aussi')
  })

  it('même round-trip via popstate (cache-hit) : titre A et sa métadonnée reviennent', function () {
    const { win, document, µ } = setup('http://x/a')
    document.head.innerHTML = '<title>Page A</title><meta name="description" content="Description A">'
    document.body.innerHTML = '<p id="contenu-a">contenu A</p>'

    let capturedCb: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb = cb }
    const linkToB: any = { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this } }
    doClick(µ, win, document, linkToB)
    capturedCb('<html><head><title>Page B</title></head><body><p id="contenu-b">contenu B</p></body></html>', 'http://x/b')
    assert.equal(document.title, 'Page B')
    assert.ok(µ.pageCache.has('/a'))

    // retour arrière : le navigateur bouge D'ABORD window.location, PUIS popstate tire.
    win.history.pushState({}, '', '/a')
    const popHandler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))
    popHandler({}, µ, win, document, win.DOMParser)

    assert.equal(document.title, 'Page A', 'le titre A revient (popstate, cache-hit)')
    const meta = document.head.querySelector('meta[name="description"]')
    assert.ok(meta, 'la métadonnée de A revient (popstate, cache-hit)')
    assert.equal(meta.getAttribute('content'), 'Description A')
    assert.ok(document.body.querySelector('#contenu-a'))
  })

  // A n'a NI titre NI métadonnée pilotée : AVANT le fix,
  // la photo n'était posée que « si elle dit quelque chose » — une page sans titre ni métadonnée
  // n'était donc JAMAIS photographiée. Au retour cache-hit vers elle, rien n'existait pour écraser le
  // titre/l'og:title de B : ils restaient COLLÉS sur A. Une photo est le portrait COMPLET d'une page
  // réellement affichée — même « vide », elle doit primer au retour.
  it("page SANS titre ni métadonnée pilotée hibernée ; B a un <title> ET un <meta property=\"og:title\"> ; retour cache-hit vers A → le titre de B a disparu ET son og:title a été retiré du <head>", function () {
    const { win, document, µ } = setup('http://x/a')
    document.head.innerHTML = '' // A : ni <title>, ni métadonnée du périmètre piloté
    document.body.innerHTML = '<a id="toB" href="/b">vers B</a><p id="contenu-a">contenu A</p>'
    assert.equal(document.title, '', 'contrôle fixture : A n\'a AUCUN titre — un portrait VIDE, pas une absence de portrait')

    let capturedCb: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb = cb }
    doClick(µ, win, document, document.body.querySelector('#toB'))
    assert.ok(typeof capturedCb === 'function', 'clic A→B : cache MISS, fetch réseau attendu')
    capturedCb('<html><head><title>Page B</title><meta property="og:title" content="titre open graph B"></head><body><a id="toA" href="/a">vers A</a><p id="contenu-b">contenu B</p></body></html>', 'http://x/b')
    assert.equal(document.title, 'Page B')
    assert.ok(document.head.querySelector('meta[property="og:title"]'), 'og:title de B bien posé (contrôle avant retour)')

    capturedCb = undefined
    doClick(µ, win, document, document.body.querySelector('#toA'))
    assert.equal(capturedCb, undefined, 'cache-hit : AUCUN fetch réseau pour revenir vers A')
    assert.equal(document.title, '', "AVANT le fix : A (sans titre) n'était jamais photographiée → le titre de B restait collé ; désormais le portrait VIDE de A prime")
    assertAbsent(document.head.querySelector('meta[property="og:title"]'), "AVANT le fix : idem pour l'og:title de B, jamais retiré faute de photo de A à restaurer")
    assert.ok(document.body.querySelector('#contenu-a'), 'le contenu de A revient aussi')
  })
})

// ────────────────────────────────────────────────────────────────────────────
// <link rel="canonical alternate"> : `rel` est une LISTE
// DE TOKENS (spécification HTML), jamais une égalité stricte
// ────────────────────────────────────────────────────────────────────────────
describe('mjs_ujs — µ._mjs_navHeadKeyOf / µ._mjs_navApplyHead : rel multi-tokens', function () {
  it('µ._mjs_navHeadKeyOf : rel="canonical alternate" → link:canonical (token PARMI d\'autres, pas une égalité stricte)', function () {
    const { document, µ } = setup()
    const l = document.createElement('link')
    l.setAttribute('rel', 'canonical alternate')
    assert.equal(µ._mjs_navHeadKeyOf(l), 'link:canonical')
  })

  it('rel="canonical alternate" côté page REÇUE : reconnu et appliqué (ajouté, comme un canonical simple)', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title>'
    const doc = parse(win, '<html><head><title>T</title><link rel="canonical alternate" href="/b"></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    const link = document.head.querySelector('link[rel="canonical alternate"]')
    assert.ok(link, 'le <link rel="canonical alternate"> reçu est ajouté au <head> courant')
    assert.equal(link.getAttribute('href'), '/b')
  })

  it('rel="canonical alternate" côté page AFFICHÉE, absent de la réponse : RETIRÉ (comme un canonical simple)', function () {
    const { win, document, µ } = setup()
    document.head.innerHTML = '<title>T</title><link rel="canonical alternate" href="/a">'
    const doc = parse(win, '<html><head><title>T</title></head><body>ok</body></html>')
    µ._mjs_navApplyHead(doc)
    assertAbsent(document.head.querySelector('link[rel="canonical alternate"]'), "AVANT le fix : l'égalité stricte rel==='canonical' ne reconnaissait jamais ce nœud (hors périmètre) → jamais retiré, planté à vie")
  })
})
