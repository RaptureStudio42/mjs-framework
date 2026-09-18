// re-cliquer un lien qui
// pointe déjà vers la page ET le hash ACTUELLEMENT affichés (ex. un lien de
// nav vers l'onglet déjà actif, ou un logo vers la page courante) empilait
// quand même une 2e entrée d'historique STRICTEMENT IDENTIQUE à la courante.
// Un seul retour arrière ne faisait alors RIEN de visible (on retombe sur le
// même contenu déjà affiché) — il en fallait DEUX pour vraiment quitter la
// page.
//
// Fix : dans la branche "même page" du handler `click`, si la destination
// calculée (pathname+search+hash) est IDENTIQUE à `window.location` au
// complet, on sort sans pushState ni navigate (mais après `preventDefault` —
// on ne laisse pas le navigateur gérer nativement un lien qu'on a décidé de
// prendre en charge).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractClickBody(src: string): string {
  // µ._mjs_ujsOnClick (nommé, ex-handler anonyme document.addEventListener('click', …)
  // — renommage, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}

function makeClickHandler() {
  const body = extractClickBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', body)
}

// bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : le handler click en dépend désormais (le
// chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null) résout
// donc toujours <body>) — extraction MÉCANIQUE requise pour que la seule
// describe ci-dessous qui simule un fetch réseau continue de tourner (son
// INTENTION — la réconciliation de redirection — est inchangée).
// `_mjs_ajaxGet` reste MOCKÉ tel quel : µ._mjs_navRequest/µ._mjs_ajaxRequest ne sont
// jamais exercés par ce fichier.
function installHelpers(µ: any, doc: any, win: any) {
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, doc, win)
}

function makeLink(opts: { pathname: string, search?: string, hash?: string }) {
  return {
    hasAttribute: () => false,
    origin: 'http://x',
    target: '',
    protocol: 'http:',
    pathname: opts.pathname,
    search: opts.search || '',
    hash: opts.hash || '',
    closest: function (this: any) { return this },
  }
}

function makeEvent(link: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [link],
    target: link,
  }
}

describe("mjs_ujs — clic sur un lien vers la page+hash déjà affichés : pas de pushState dupliqué", function () {
  function makeCtx(currentHash: string) {
    const pushStateCalls: any[] = []
    const navigateCalls: any[] = []
    const win: any = {
      location: { pathname: '/dash', search: '', origin: 'http://x', hash: currentHash },
      history: { pushState: (...args: any[]) => pushStateCalls.push(args) },
    }
    const µ: any = {
      realTarget: (e: any) => e.target,
      Router: { navigate: (...args: any[]) => navigateCalls.push(args) },
      // µ._mjs_navNoUjs (opt-out @noUJS) : hors du bloc helpers extrait par ce
      // fichier (ne teste QUE le corps du handler click) — mock fidèle plutôt qu'une extraction
      // supplémentaire, comme µ.realTarget juste au-dessus.
      _mjs_navNoUjs: (el: any) => !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('mjs-no-ujs'),
      _mjs_navWarnNoUjsMethod: () => {},
    }
    const fakeDoc: any = { getElementById: () => null }
    return { win, µ, fakeDoc, pushStateCalls, navigateCalls }
  }

  it("même pathname, même search, MÊME hash : aucun pushState ni navigate (juste preventDefault)", function () {
    const { win, µ, fakeDoc, pushStateCalls, navigateCalls } = makeCtx('#/tab2')
    const link = makeLink({ pathname: '/dash', hash: '#/tab2' })
    const e = makeEvent(link)
    const handler = makeClickHandler()
    handler(e, µ, win, fakeDoc, class {})

    assert.equal(e.defaultPrevented, true, 'le clic reste pris en charge (pas de navigation native)')
    assert.equal(pushStateCalls.length, 0, "AVANT le fix : pushState empilait une 2e entrée identique à la courante")
    assert.equal(navigateCalls.length, 0, 'rien à re-router : la destination EST déjà ce qui est affiché')
  })

  it('même pathname, AUCUN hash des deux côtés (ex. logo vers la page courante) : pas de doublon non plus', function () {
    const { win, µ, fakeDoc, pushStateCalls, navigateCalls } = makeCtx('')
    const link = makeLink({ pathname: '/dash' })
    const e = makeEvent(link)
    const handler = makeClickHandler()
    handler(e, µ, win, fakeDoc, class {})

    assert.equal(pushStateCalls.length, 0)
    assert.equal(navigateCalls.length, 0)
  })

  it('même page mais hash DIFFÉRENT : pushState + navigate partent normalement (comportement legitime inchangé)', function () {
    const { win, µ, fakeDoc, pushStateCalls, navigateCalls } = makeCtx('#/tab2')
    const link = makeLink({ pathname: '/dash', hash: '#/tab3' })
    const e = makeEvent(link)
    const handler = makeClickHandler()
    handler(e, µ, win, fakeDoc, class {})

    assert.equal(pushStateCalls.length, 1, 'une VRAIE navigation vers un hash différent doit toujours pousser une entrée')
    assert.equal(pushStateCalls[0][2], '/dash#/tab3')
    assert.equal(navigateCalls.length, 1)
  })
})

// _mjs_canonHash fidèle (extrait de mjs_router : strip du slash final de la partie
// route, query et racine préservées) — pour tester la canonicalisation same-page.
function canonHash(hash: string): string {
  if (!hash || hash[0] !== '#') { return hash }
  const body = hash.slice(1)
  const qi = body.indexOf('?')
  let pathPart = qi === -1 ? body : body.slice(0, qi)
  const queryPart = qi === -1 ? '' : body.slice(qi)
  if (pathPart.length > 1 && pathPart.endsWith('/')) { pathPart = pathPart.replace(/\/+$/, '') || '/' }
  return '#' + pathPart + queryPart
}

describe("mjs_ujs — clic same-page : slash final canonicalisé AVANT dédoublonnage/pushState", function () {
  function makeCtx(currentHash: string) {
    const pushStateCalls: any[] = []
    const navigateCalls: any[] = []
    const win: any = {
      location: { pathname: '/dash', search: '', origin: 'http://x', hash: currentHash },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const µ: any = {
      realTarget: (e: any) => e.target,
      Router: { navigate: (...a: any[]) => navigateCalls.push(a), _mjs_canonHash: canonHash },
      // cf. commentaire de l'autre makeCtx plus haut (même fichier, mock fidèle hors bloc helpers).
      _mjs_navNoUjs: (el: any) => !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('mjs-no-ujs'),
      _mjs_navWarnNoUjsMethod: () => {},
    }
    return { win, µ, fakeDoc: { getElementById: () => null }, pushStateCalls, navigateCalls }
  }

  it("lien '#/about/' quand '#/about' est déjà affiché : canonicalisé → dédoublonné (aucune 2e entrée)", function () {
    const { win, µ, fakeDoc, pushStateCalls, navigateCalls } = makeCtx('#/about')
    const handler = makeClickHandler()
    handler(makeEvent(makeLink({ pathname: '/dash', hash: '#/about/' })), µ, win, fakeDoc, class {})
    assert.equal(pushStateCalls.length, 0, "AVANT le fix : '#/about/' ≠ '#/about' → une 2e entrée d'historique en double pour la même page")
    assert.equal(navigateCalls.length, 0)
  })

  it("lien '#/about/' depuis une AUTRE route : pushState de la forme CANONIQUE (#/about, pas #/about/)", function () {
    const { win, µ, fakeDoc, pushStateCalls, navigateCalls } = makeCtx('#/home')
    const handler = makeClickHandler()
    handler(makeEvent(makeLink({ pathname: '/dash', hash: '#/about/' })), µ, win, fakeDoc, class {})
    assert.equal(pushStateCalls.length, 1)
    assert.equal(pushStateCalls[0][2], '/dash#/about', "AVANT le fix : l'URL sale '#/about/' était poussée telle quelle")
    assert.equal(navigateCalls[0][0], '/dash#/about', 'navigate reçoit aussi la forme canonique')
  })
})

describe("mjs_ujs — clic cross-page : redirection serveur réconciliée", function () {
  function makeCrossLink(pathname: string, href: string) {
    return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname, search: '', hash: '', href, closest: function (this: any) { return this } }
  }
  function finalPathFor(win: any) {
    return (finalUrl: string, fallback: string) => {
      if (!finalUrl) { return fallback }
      try { const u = new URL(finalUrl, win.location.href); if (u.origin !== win.location.origin) { return fallback }; return u.pathname + u.search } catch { return fallback }
    }
  }

  it("lien /admin redirigé (finalUrl=/login) : replaceState + _mjs_lastUjsPath=/login (pas de pageCache empoisonné)", function () {
    const pushStateCalls: any[] = [], replaceStateCalls: any[] = [], navigateCalls: any[] = []
    let capturedCb: any
    const liveRoot: any = { childNodes: [], replaceChildren(...nodes: any[]) { this.by = nodes[0] } }
    const win: any = {
      location: { pathname: '/dash', search: '', origin: 'http://x', href: 'http://x/dash', hash: '' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a), replaceState: (...a: any[]) => replaceStateCalls.push(a) },
      scrollTo() {},
    }
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/dash',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_url: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: finalPathFor(win),
      Router: { navigate: (...a: any[]) => navigateCalls.push(a) },
    }
    const newRoot = { tag: 'login-page' }
    class DP { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    const doc: any = { body: liveRoot }
    installHelpers(µ, doc, win)
    const handler = makeClickHandler()
    handler(makeEvent(makeCrossLink('/admin', 'http://x/admin')), µ, win, doc, DP)

    assert.ok(typeof capturedCb === 'function', '_mjs_ajaxGet a bien été appelé')
    assert.equal(pushStateCalls[0][2], '/admin', 'pushState au geste vers le clic (/admin)')
    // le fetch résout : la destination FINALE (302 serveur) est /login
    capturedCb('<html>login</html>', 'http://x/login')

    assert.equal(liveRoot.by, newRoot, 'la page login est swappée (contenu de <body> remplacé)')
    assert.equal(replaceStateCalls.length, 1, 'AVANT le fix : aucune correction d\'URL → /login affiché sous /admin')
    assert.equal(replaceStateCalls[0][2], '/login', 'replaceState corrige l\'entrée du clic vers la destination FINALE')
    assert.equal(µ._mjs_lastUjsPath, '/login', "AVANT le fix : _mjs_lastUjsPath='/admin' → pageCache empoisonné (login archivé sous /admin)")
    assert.equal(navigateCalls[0][0], '/login', 'le routeur reçoit la destination finale')
  })

  it("lien SANS redirection (finalUrl === chemin du clic) : PAS de replaceState (comportement inchangé)", function () {
    const replaceStateCalls: any[] = []
    let capturedCb: any
    const liveRoot: any = { childNodes: [], replaceChildren() {} }
    const win: any = {
      location: { pathname: '/dash', search: '', origin: 'http://x', href: 'http://x/dash', hash: '' },
      history: { pushState() {}, replaceState: (...a: any[]) => replaceStateCalls.push(a) },
      scrollTo() {},
    }
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/dash',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_url: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: finalPathFor(win),
      Router: { navigate() {} },
    }
    class DP { parseFromString() { return { body: { childNodes: [{ tag: 'products' }] } } } }
    const doc: any = { body: liveRoot }
    installHelpers(µ, doc, win)
    const handler = makeClickHandler()
    handler(makeEvent(makeCrossLink('/products', 'http://x/products')), µ, win, doc, DP)
    capturedCb('<html>products</html>', 'http://x/products') // pas de redirect
    assert.equal(replaceStateCalls.length, 0, 'sans redirect, aucune correction d\'URL')
    assert.equal(µ._mjs_lastUjsPath, '/products', '_mjs_lastUjsPath = chemin du clic (inchangé)')
  })
})
