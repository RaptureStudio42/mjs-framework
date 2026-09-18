// Slash final : `µ.url` gardait la forme SALE (barre du faux
// navigateur figée sur `#/about/`).
//
// Diagnostic prouvé (trace instrumentée) : poser un hash SALE à la main
// (`location.hash = '#/contact/'`) déclenche D'ABORD le listener popstate de
// mjs_ujs → branche « Navigation hash pure » → `navigate(fullDest)` AVANT toute
// canonicalisation → `_mjs_updateUrlStore` mémorise `µ.url.hash` SALE. Le listener
// hashchange canonicalise ENSUITE l'URL réelle (replaceState) mais SAUTE son
// navigate (même matchPath+query que `_mjs_lastNavPath`) → `µ.url` reste sale à vie.
// Au CHARGEMENT direct d'une page avec hash sale (sans composant routé), rien ne
// canonicalisait jamais non plus (le snapshot boot écrivait aussi la forme sale).
//
// Ce fichier couvre les retouches b et c (les 4 scénarios demandés portent sur
// le couple `_mjs_canonicalizeUrl`/`_mjs_updateUrlStore` et le garde-fou hashchange) :
//   c) le boot canonicalise AVANT le snapshot initial.
//   b) le garde-fou anti-double du listener hashchange resynchronise `µ.url`
//      quand la route n'a pas changé mais que le hash a été nettoyé entre-temps.
// La retouche a (branche « Navigation hash pure » du listener popstate) n'a PAS
// de test comportemental dédié dans ce fichier ni ailleurs — seuls typecheck +
// lecture du code la couvrent ; à signaler si une régression y touche.
//
// Harnais : `µ`/`Router` RÉELS (source mjs_router.ts/mjs_ujs.ts exécutée telle
// quelle via `new Function`, calqué sur router-navigate-reentrance.test.ts) sur
// une fenêtre happy-dom fraîche par test — `µ.state` mocké en passthrough (pas
// de réactivité testée ici, seulement les données lues/écrites). Pour le
// scénario #3, le VRAI listener hashchange de mjs_ujs.ts est attaché sur la
// fenêtre et déclenché par un VRAI `window.dispatchEvent` (sondé au préalable :
// happy-dom propage bien un event dispatché manuellement à un listener attaché,
// même si `location.hash = …` seul n'émet pas hashchange automatiquement).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// Globals posés/restaurés PAR TEST (même garde que router-navigate-reentrance.
// test.ts) : Node fournit un CustomEvent NATIF incompatible avec les instances
// happy-dom (dispatchEvent d'un autre realm rejeté).
let __prevWindow: any, __prevDocument: any, __prevCustomEvent: any
beforeEach(() => {
  __prevWindow = (globalThis as any).window
  __prevDocument = (globalThis as any).document
  __prevCustomEvent = (globalThis as any).CustomEvent
})
afterEach(() => {
  ;(globalThis as any).window = __prevWindow
  ;(globalThis as any).document = __prevDocument
  ;(globalThis as any).CustomEvent = __prevCustomEvent
})

// µ.Router RÉEL (mjs_router.ts exécuté tel quel) sur une fenêtre happy-dom
// fraîche à l'URL donnée. L'IIFE de boot (bas de mjs_router.ts) s'exécute donc
// ICI aussi, `µ.state` étant défini — comme au chargement réel du runtime.
function makeRouter(url: string) {
  const win: any = new Window({ url })
  const µ: any = { log() {}, warn() {}, error() {}, state: (o: any) => ({ ...o }) }
  const g: any = globalThis
  g.window = win
  g.document = win.document
  g.CustomEvent = win.CustomEvent
  new Function('µ', ROUTER_SRC)(µ)
  return { win, µ, Router: µ.Router }
}

// Idem + le VRAI listener hashchange de mjs_ujs.ts, attaché sur `win` (pour le
// scénario #3, déclenché via un VRAI window.dispatchEvent).
function makeRouterWithUjs(url: string) {
  const win: any = new Window({ url })
  const µ: any = { log() {}, warn() {}, error() {}, state: (o: any) => ({ ...o }) }
  const g: any = globalThis
  g.window = win
  g.document = win.document
  g.CustomEvent = win.CustomEvent
  new Function('µ', ROUTER_SRC + '\n' + UJS_SRC)(µ)
  return { win, µ, Router: µ.Router }
}

describe('routeur — µ.url ne reste plus sale après un slash final', function () {
  it('#1 — "#/x/" : _mjs_canonicalizeUrl() puis _mjs_updateUrlStore() nettoient µ.url.hash ET location.hash', function () {
    const { win, Router, µ } = makeRouter('http://localhost/#/x/')

    Router._mjs_canonicalizeUrl()
    Router._mjs_updateUrlStore()

    assert.equal(µ.url.hash, '#/x')
    assert.equal(win.location.hash, '#/x')
  })

  it('#2 — cas query : "#/liste/?tri=nom" → µ.url.hash et µ.url.query.tri nettoyés', function () {
    const { win, Router, µ } = makeRouter('http://localhost/#/liste/?tri=nom')

    Router._mjs_canonicalizeUrl()
    Router._mjs_updateUrlStore()

    assert.equal(µ.url.hash, '#/liste?tri=nom')
    assert.equal(µ.url.query.tri, 'nom')
    assert.equal(win.location.hash, '#/liste?tri=nom')
  })

  it('#3 — skip-resync du hashchange : même route (_mjs_lastNavPath/_mjs_lastNavQuery identiques) mais µ.url.hash sale → resync SANS re-navigate', function () {
    const { win, Router, µ } = makeRouterWithUjs('http://localhost/#/x')

    // État décrit par le diagnostic : la route n'a PAS changé depuis la
    // dernière navigation réelle (garde anti-double-fire active), mais µ.url.hash
    // porte encore la forme SALE mémorisée par un popstate antérieur (branche a,
    // couverte ailleurs) — c'est CETTE resynchro (fix b) qui est testée ici.
    Router._mjs_lastNavPath = '/x'
    Router._mjs_lastNavQuery = ''
    µ.url.hash = '#/x/' // sale, ≠ window.location.hash (propre)
    let navigateCalls = 0
    const origNavigate = Router.navigate.bind(Router)
    Router.navigate = (...a: any[]) => { navigateCalls++; return origNavigate(...a) }

    win.dispatchEvent(new win.Event('hashchange'))

    assert.equal(navigateCalls, 0, 'garde anti-double-fire intacte : navigate() ne doit PAS être rappelé (même route)')
    assert.equal(µ.url.hash, '#/x', 'AVANT le fix : µ.url.hash restait sale à vie faute de resync sur ce chemin')
  })

  it('#4 — racine préservée : "#/" reste "#/"', function () {
    const { win, Router, µ } = makeRouter('http://localhost/#/')

    Router._mjs_canonicalizeUrl()
    Router._mjs_updateUrlStore()

    assert.equal(µ.url.hash, '#/')
    assert.equal(win.location.hash, '#/')
  })
})
