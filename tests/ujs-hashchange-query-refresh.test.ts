// Régression : le garde-fou anti-double-fire
// du handler `hashchange` (mjs_ujs.ts) comparait UNIQUEMENT `matchPath` (le
// chemin de route, SANS la query) contre `µ.Router._mjs_lastNavPath` pour décider
// si `navigate()` doit être sauté (cas nominal : popstate a déjà navigué, la
// même navigation ré-émet aussi hashchange — redondant, à ignorer).
//
// Un changement de QUERY SEUL (même route : `#/liste?tri=nom` →
// `#/liste?tri=prix`, posé programmatiquement ou tapé dans la barre d'adresse)
// laisse `matchPath` INCHANGÉ → le garde-fou sautait `navigate()` EN ENTIER →
// `_mjs_updateUrlStore` (qui rafraîchit `µ.url.query`) n'était JAMAIS rappelé →
// `µ.url.query` restait figé sur l'ANCIENNE query À VIE, malgré une barre
// d'adresse déjà à jour.
//
// Fix : `µ.Router.navigate()` mémorise désormais AUSSI `_mjs_lastNavQuery` (en
// plus de `_mjs_lastNavPath`) ; le garde-fou hashchange compare LES DEUX — il ne
// saute QUE si route ET query sont identiques à la dernière navigation.
//
// mjs_ujs.ts attache des listeners PERMANENTS dès l'import — convention déjà
// établie (cf. ujs-pagecache-race-poisoning.test.ts, ujs-popstate-anchor-
// clears-views.test.ts) : le corps RÉEL de la fonction hashchange est extrait
// du code source (comptage d'accolades) et exécuté isolément via `new
// Function`, sans jamais importer le fichier.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')

function extractListenerBody(src: string, eventName: string): string {
  return extractMarkedBody(src, eventName + '-listener')
}

function makeHashchangeHandler() {
  const body = extractListenerBody(UJS_SRC, 'hashchange')
  return new Function('window', body)
}

describe("mjs_ujs — hashchange même route : µ.url.query se rafraîchit (via navigate)", function () {
  // `;(globalThis as any).µ = { Router }` posé par chaque
  // `it` SANS restauration polluait tout le PROCESS Mocha (fichiers suivants, ex. tests/anim-*)
  // avec ce stub minimal { Router } : leur propre repli `globalThis.µ || {...}` ne se déclenchait
  // alors JAMAIS (déjà « défini », mais incomplet — `µ._mjs_interpolatorSet`/`µ.Ticker` absents).
  // Sauvegarde/restauration systématique, même schéma que le describe voisin plus bas
  // (try/finally, l.108-131).
  let prevMu: any
  beforeEach(function () { prevMu = (globalThis as any).µ })
  afterEach(function () { (globalThis as any).µ = prevMu })

  it("route IDENTIQUE, query DIFFÉRENTE : navigate() est appelé (pas sauté par le garde anti-double-fire)", function () {
    const navigateCalls: any[] = []
    const win: any = { location: { hash: '#/liste?tri=prix', href: 'http://x/#/liste?tri=prix' } }
    const Router: any = {
      _mjs_getMatchPath: (_href: string) => '/liste', // simplifié : même route peu importe href ici
      _mjs_lastNavPath: '/liste',
      _mjs_lastNavQuery: 'tri=nom', // dernière navigation : query DIFFÉRENTE
      navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }),
    }
    // `µ` référencé en BARE dans le corps extrait → résolu via la portée
    // globale de `new Function` (mjs_ujs.ts le suppose déjà chargé en global).
    ;(globalThis as any).µ = { Router }
    const handler = makeHashchangeHandler()
    handler(win)

    assert.equal(
      navigateCalls.length, 1,
      "AVANT le fix : le garde-fou comparait seulement matchPath (identique) → navigate() sauté → µ.url.query jamais rafraîchie",
    )
  })

  it("route IDENTIQUE, query IDENTIQUE : navigate() est sauté (garde anti-double-fire préservé)", function () {
    const navigateCalls: any[] = []
    const win: any = { location: { hash: '#/liste?tri=nom', href: 'http://x/#/liste?tri=nom' } }
    const Router: any = {
      _mjs_getMatchPath: () => '/liste',
      _mjs_lastNavPath: '/liste',
      _mjs_lastNavQuery: 'tri=nom', // IDENTIQUE à la navigation courante
      navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }),
    }
    ;(globalThis as any).µ = { Router }
    const handler = makeHashchangeHandler()
    handler(win)

    assert.equal(navigateCalls.length, 0, "double-fire popstate+hashchange sur la MÊME navigation : toujours ignoré")
  })

  it("route DIFFÉRENTE : navigate() est appelé (comportement de base inchangé)", function () {
    const navigateCalls: any[] = []
    const win: any = { location: { hash: '#/autre', href: 'http://x/#/autre' } }
    const Router: any = {
      _mjs_getMatchPath: () => '/autre',
      _mjs_lastNavPath: '/liste',
      _mjs_lastNavQuery: '',
      navigate: (dest: string, push: boolean) => navigateCalls.push({ dest, push }),
    }
    ;(globalThis as any).µ = { Router }
    const handler = makeHashchangeHandler()
    handler(win)

    assert.equal(navigateCalls.length, 1)
  })
})

describe("µ.Router.navigate() — mémorise _mjs_lastNavQuery en plus de _mjs_lastNavPath", function () {
  it("navigate('#/liste?tri=prix') pose _mjs_lastNavPath='/liste' ET _mjs_lastNavQuery='tri=prix'", function () {
    const µ: any = { log() {}, warn() {}, error() {} }
    const g: any = globalThis
    const prevWindow = g.window, prevDocument = g.document, prevCustomEvent = g.CustomEvent
    const fakeWin: any = {
      location: { href: 'http://x/#/old' },
      history: { pushState() {} },
      dispatchEvent() {},
    }
    g.window = fakeWin
    g.document = { createElement: () => ({}) }
    g.CustomEvent = function (this: any, type: string) { this.type = type }
    try {
      new Function('µ', ROUTER_SRC)(µ)
      µ.Router.navigate('#/liste?tri=prix', false)
      assert.equal(µ.Router._mjs_lastNavPath, '/liste')
      assert.equal(µ.Router._mjs_lastNavQuery, 'tri=prix', "AVANT le fix : _mjs_lastNavQuery n'existait pas du tout")

      µ.Router.navigate('#/liste', false) // même route, SANS query cette fois
      assert.equal(µ.Router._mjs_lastNavQuery, '', 'une navigation sans query doit remettre _mjs_lastNavQuery à vide')
    } finally {
      g.window = prevWindow; g.document = prevDocument; g.CustomEvent = prevCustomEvent
    }
  })
})
