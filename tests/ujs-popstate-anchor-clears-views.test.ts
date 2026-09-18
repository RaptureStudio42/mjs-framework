// Régression : le handler `popstate`
// traitait AVEUGLÉMENT tout ce qui suit `#` dans l'URL de destination comme
// une ROUTE — contrairement au handler de clic, qui distingue explicitement
// une ancre non-route (`#footnote`, SANS le `/` de route) d'une vraie route
// (`#/xxx`) via `isHashRoute`.
//
// `popstate` tire AUSSI pour un retour PAR-DESSUS un simple ancrage en page :
// cliquer `<a href="#footnote">` est une navigation NATIVE (jamais interceptée
// par notre code — le handler de clic l'exclut explicitement), qui empile
// quand même une entrée d'historique. Un retour arrière dessus déclenche
// `popstate` avec `window.location.hash === '#footnote'`. Sans distinction,
// `_mjs_getMatchPath` prend `footnote` (tout ce qui suit `#`) et le route comme
// `/footnote` — qui ne matche AUCUNE route déclarée → `_mjs_injectViewsForComponent`
// VIDE TOUTES les `<@view>` (aucune route ne correspond), alors qu'aucune
// navigation de page n'a réellement eu lieu (juste un scroll en page, déjà
// géré nativement par le navigateur).
//
// Fix : même garde que le handler de clic (`hash && !hash.startsWith('#/')`)
// ajoutée en tête du handler popstate — sort immédiatement, ne touche à RIEN.
//
// mjs_ujs.ts attache des listeners PERMANENTS à document/window dès l'import
// — convention déjà établie (cf. ujs-pagecache-race-poisoning.test.ts) :
// jamais d'exécution réelle du fichier. Ici, on extrait le CORPS RÉEL de la
// fonction popstate depuis le code source (pas une réimplémentation à la
// main, qui risquerait de diverger du vrai fichier) et on l'exécute isolément
// via `new Function`, avec un `window`/`document`/`µ` entièrement contrôlés.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// Extrait le corps de `window.addEventListener('popstate', function(e) { ... });`
// par marqueurs (cf. tests/helpers/extract-marked.ts).
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}

// Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : le handler popstate en dépend désormais
// (le chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null)
// résout donc toujours <body>, appelé dès le TOUT DÉBUT du handler, avant même
// la garde ancre non-route) — extraction MÉCANIQUE requise pour que ce fichier
// continue de tourner (son INTENTION — la garde ancre non-route — est
// inchangée).
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function makeHandler(µ: any, win: any, doc: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
  const body = extractPopstateBody(UJS_SRC)
  // `window`/`document` référencés en BARE dans le corps extrait → paramètres
  // de la Function plutôt que des globals, isolation totale, zéro listener
  // permanent posé nulle part.
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', body)
}

const fakeDoc: any = { getElementById: () => null }

function makeMu() {
  const navigateCalls: any[] = []
  const pageCacheSets: any[] = []
  return {
    // `fakeDoc` n'a pas de `.body` : µ._mjs_navMountZone(document, null) résout
    // directement `document.body` (jamais de recherche/avertissement pour un
    // `target` absent) → `currentRoot` vaut simplement `undefined` ici, sans
    // conséquence pour ce fichier (aucune de ces routes ne touche au DOM).
    warn() {}, error() {}, log() {},
    _mjs_lastUjsPath: '/app',
    _mjs_navSeq: 0,
    pageCache: {
      has: () => false,
      get: () => null,
      set: (k: any, _v: any) => pageCacheSets.push(k),
    },
    _mjs_saveScroll() {},
    Router: { navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }) },
    navigateCalls,
    pageCacheSets,
  }
}

describe("mjs_ujs — popstate sur une ancre non-route (#footnote) ne vide plus les vues", function () {
  it("hash de destination = ancre non-route (#footnote) : le handler sort IMMÉDIATEMENT, aucune navigation déclenchée", function () {
    const µ = makeMu()
    const win: any = { location: { pathname: '/app', search: '', hash: '#footnote' } }
    const handler = makeHandler(µ, win, fakeDoc)

    handler({}, µ, win, fakeDoc, undefined)

    assert.equal(
      µ.navigateCalls.length, 0,
      "AVANT le fix : µ.Router.navigate était appelé avec un chemin bidon ('/footnote'), qui ne matche aucune route → _mjs_injectViewsForComponent vidait TOUTES les <@view>",
    )
    assert.equal(µ.pageCacheSets.length, 0, "aucune manipulation du pageCache pour un simple ancrage en page")
  })

  it("hash de destination = route (#/products) : le comportement normal est inchangé, navigate() est bien appelé", function () {
    const µ = makeMu()
    const win: any = { location: { pathname: '/app', search: '', hash: '#/products' } }
    const handler = makeHandler(µ, win, fakeDoc)

    handler({}, µ, win, fakeDoc, undefined)

    assert.equal(µ.navigateCalls.length, 1, "une vraie route doit toujours déclencher la navigation")
    assert.equal(µ.navigateCalls[0].dest, '/app#/products')
  })

  it("hash de destination VIDE ('') : traité comme la racine, navigate() est appelé (comportement inchangé)", function () {
    const µ = makeMu()
    const win: any = { location: { pathname: '/app', search: '', hash: '' } }
    const handler = makeHandler(µ, win, fakeDoc)

    handler({}, µ, win, fakeDoc, undefined)

    assert.equal(µ.navigateCalls.length, 1, "un hash vide doit continuer à router (vers la racine), comme avant ce fix")
  })

  // conteneur MINIATURE avec de VRAIES sémantiques childNodes (lecture, PAS retrait — cf.
  // mjs_ujs.ts : le retrait réel n'a lieu qu'au µ._mjs_zoneFill suivant) ET replaceChildren
  // (µ._mjs_zoneFill) — sert de `document.body` dans ce fichier (le chemin HTML n'a
  // jamais de `target`, le contenant EST toujours <body>).
  function makeContainer(initialChildren: any[] = []): any {
    const c: any = { children: initialChildren.slice() }
    Object.defineProperty(c, 'childNodes', { get: () => c.children.slice() })
    c.replaceChildren = (...nodes: any[]) => { c.children = nodes.slice() }
    return c
  }

  // Le garde ancre ne doit PLUS avaler un retour INTER-PAGES.
  it("retour INTER-PAGES vers une URL à ancre non-route (/b#footnote depuis /c) : swappe bien la page", function () {
    const rootDeC: any = { name: 'root-de-C', nodeType: 1 }
    const currentRoot = makeContainer([rootDeC])
    const rootDeB: any = { name: 'root-de-B', nodeType: 1 }
    const navigateCalls: any[] = []
    const µ: any = {
      _mjs_lastUjsPath: '/c',
      _mjs_navSeq: 0,
      pageCache: {
        _m: new Map<string, any>([['/b', [rootDeB]]]),
        has(k: string) { return this._m.has(k) },
        get(k: string) { return this._m.get(k) },
        set(k: string, v: any) { this._m.set(k, v) },
      },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }) },
    }
    // L'utilisateur était sur /c, il revient en arrière vers /b#footnote (page /b,
    // ancre en page posée nativement par un <a href="#footnote"> sur /b).
    const win: any = { location: { pathname: '/b', search: '', hash: '#footnote' } }
    const doc: any = { body: currentRoot }
    const handler = makeHandler(µ, win, doc)

    handler({}, µ, win, doc, undefined)

    assert.deepEqual(currentRoot.children, [rootDeB],
      "AVANT le fix : la garde ancre avalait le retour inter-pages → aucun swap (contenu de /c sous l'URL /b#footnote, chaîne pageCache corrompue) ; désormais : le contenu HIBERNÉ de /b (tableau de nœuds) remplace celui de /c")
    // Array.from : on compare les NŒUDS hibernés, pas les métadonnées que l'hibernation pose sur
    // le tableau lui-même (_mjs_mjsCachePolicy en 'revalidate', _mjs_mjsHead pour la tête de page, désormais posé
    // INCONDITIONNELLEMENT) — deepEqual de Node compare aussi les propriétés propres au-delà
    // des index, et échouerait sur une métadonnée interne sans rapport avec ce que ce test vérifie (la
    // page quittée est bien archivée sous son ANCIENNE clé). Même remède que tests/ujs-submit-prg-redirect.test.ts.
    assert.deepEqual(Array.from(µ.pageCache.get('/c')), [rootDeC], 'la page quittée (/c) est hibernée à son tour, sous SA PROPRE clé (possible même en mode <body>)')
    assert.equal(µ._mjs_lastUjsPath, '/b', '_mjs_lastUjsPath suit la page réellement affichée (/b)')
    assert.equal(µ._mjs_navSeq, 1, 'les fetchs en vol sont invalidés (navSeq bumpé)')
    assert.equal(navigateCalls.length, 1, 'le routeur est bien notifié')
    assert.equal(navigateCalls[0].dest, '/b', "l'ancre non-route est EXCLUE du chemin routé (/b, pas /b#footnote)")
  })

  // pageCache DÉSORMAIS possible en mode <body> (avant ce correctif, <body>
  // en était exclu, cf. historique git : trois gardes `mode !== 'body'` supprimées).
  it("pageCache en mode <body> : navigation vers une page jamais vue PUIS retour restaure l'arbre HIBERNÉ (pas un refetch)", function () {
    const rootA: any = { name: 'root-A', nodeType: 1 }
    const currentRoot = makeContainer([rootA])
    const navigateCalls: any[] = []
    let fetchCalled = false
    const µ: any = {
      _mjs_lastUjsPath: '/a',
      _mjs_navSeq: 0,
      warn() {}, error() {}, log() {},
      pageCache: {
        _m: new Map<string, any>(),
        has(k: string) { return this._m.has(k) },
        get(k: string) { return this._m.get(k) },
        set(k: string, v: any) { this._m.set(k, v) },
      },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      _mjs_ajaxRequest: () => { fetchCalled = true; return Promise.resolve() },
      Router: { navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }) },
    }
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const doc: any = { body: currentRoot }
    const handler = makeHandler(µ, win, doc)

    // 1er popstate : A → B, jamais visitée → cache miss, refetch réseau attendu ; A (quittée)
    // hibernée dans pageCache.
    handler({}, µ, win, doc, undefined)
    assert.equal(fetchCalled, true, 'B jamais visitée : cache miss, refetch réseau')
    // Array.from : même remède que plus haut (métadonnées internes _mjs_mjsHead/_mjs_mjsCachePolicy hors
    // sujet de cette assertion, cf. commentaire ci-dessus).
    assert.deepEqual(Array.from(µ.pageCache.get('/a')), [rootA], 'A (quittée) est hibernée dans pageCache sous sa propre clé')

    // Le contenu de B est installé (hors périmètre du refetch lui-même, simulé à la main) ;
    // navigation suivante B → A, désormais en cache.
    const rootB: any = { name: 'root-B', nodeType: 1 }
    currentRoot.replaceChildren(rootB)
    µ._mjs_lastUjsPath = '/b'
    fetchCalled = false
    win.location.pathname = '/a'
    handler({}, µ, win, doc, undefined)

    assert.equal(fetchCalled, false,
      "AVANT ce correctif : <body> n'était JAMAIS mis en cache (garde mode !== 'body') → toujours un refetch, même en repassant sur une page déjà visitée")
    assert.deepEqual(currentRoot.children, [rootA], "l'arbre hiberné de A est restauré tel quel (identité de nœud préservée), pas un refetch")
  })

  it("même-page + ancre non-route (#footnote sur la page courante) : toujours court-circuité (cas nominal préservé)", function () {
    const µ = makeMu() // _mjs_lastUjsPath = '/app'
    const win: any = { location: { pathname: '/app', search: '', hash: '#footnote' } }
    const handler = makeHandler(µ, win, fakeDoc)
    handler({}, µ, win, fakeDoc, undefined)
    assert.equal(µ.navigateCalls.length, 0, 'un vrai ancrage en page (page identique) laisse le scroll natif, aucune navigation')
    assert.equal(µ.pageCacheSets.length, 0)
  })
})
