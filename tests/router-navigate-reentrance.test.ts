// Régression : `navigate()` n'avait AUCUNE
// garde de RÉ-ENTRANCE. Un `@urlChange` qui redirige — le cas classique d'une
// garde d'authentification ("si pas connecté → µ.Router.to('/login')") —
// ré-entre dans `navigate()` PENDANT que la boucle sur `_mjs_awareComponents` de
// l'appel EXTÉRIEUR est encore en cours.
//
// L'appel imbriqué tourne à son terme : il pushState vers '/login' et met à
// jour TOUS les composants (sa PROPRE boucle couvre l'intégralité de
// `_mjs_awareComponents`) avec le VRAI chemin final. Il rend ensuite la main à la
// boucle EXTÉRIEURE, qui — avant ce fix — continuait d'itérer ses composants
// RESTANTS avec SON `matchPath` à elle (le chemin PROTÉGÉ d'origine, PÉRIMÉ
// depuis la redirection) → ces composants recevaient et injectaient la
// MAUVAISE vue, malgré l'URL affichée déjà correcte.
//
// Fix : un compteur de génération (`_mjs_navGen`), bumpé à CHAQUE appel de
// `navigate()`. La boucle vérifie, avant CHAQUE composant, que sa propre
// génération est toujours la plus récente ; sinon elle s'arrête (le travail a
// déjà été refait, correctement, par l'appel imbriqué plus récent).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')

// Globals posés/restaurés PAR TEST (jamais un `??=` qui suppose être seul à
// les poser) : Node fournit un `CustomEvent` NATIF (incompatible avec les
// instances happy-dom — `win.dispatchEvent` rejette un event construit par
// un AUTRE realm), donc un simple `??=` ne le remplacerait jamais ; et un
// autre fichier de test du même process Mocha peut avoir déjà posé SA propre
// Window avant celui-ci (même piège que documenté dans les fichiers socket/
// crossfade de ce tour).
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

function makeRouter(win: any) {
  const µ: any = { log() {}, warn() {}, error() {} }
  const g: any = globalThis
  g.window = win
  g.document = win.document
  g.CustomEvent = win.CustomEvent
  new Function('µ', ROUTER)(µ)
  return µ.Router
}

describe("routeur — navigate() : garde de ré-entrance (redirect dans @urlChange)", function () {
  it("un @urlChange qui redirige (garde d'authentification) ne fait PAS recevoir aux composants suivants un chemin PÉRIMÉ", function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const Router = makeRouter(win)

    const receivedByB: string[] = []
    // compA : simule une garde d'authentification — sur la route protégée,
    // redirige IMMÉDIATEMENT vers /login (ré-entrance synchrone).
    const compA = {
      tagName: 'MJS-GUARD',
      _mjs_hooks: {
        urlChange(path: string) {
          if (path === '/protected') {
            Router.navigate('#/login', true)
          }
        },
      },
    }
    // compB : enregistré APRÈS compA (un Set itère dans l'ordre d'insertion)
    // — sans le fix, il reçoit le matchPath PÉRIMÉ de la boucle extérieure.
    const compB = {
      tagName: 'MJS-CONTENT',
      _mjs_hooks: { urlChange(path: string) { receivedByB.push(path) } },
    }
    Router._mjs_awareComponents.add(compA)
    Router._mjs_awareComponents.add(compB)

    Router.navigate('#/protected', true)

    assert.deepEqual(
      receivedByB, ['/login'],
      "AVANT le fix : compB recevait ['/protected', '/login'] (ou juste '/protected' périmé en dernier) — " +
      "la boucle extérieure continuait avec son matchPath périmé APRÈS le retour de l'appel imbriqué",
    )
  })

  it("navigation NORMALE (sans ré-entrance) : tous les composants reçoivent bien le même chemin, comportement inchangé", function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const Router = makeRouter(win)

    const received: string[] = []
    const compA = { tagName: 'MJS-A', _mjs_hooks: { urlChange(path: string) { received.push('A:' + path) } } }
    const compB = { tagName: 'MJS-B', _mjs_hooks: { urlChange(path: string) { received.push('B:' + path) } } }
    Router._mjs_awareComponents.add(compA)
    Router._mjs_awareComponents.add(compB)

    Router.navigate('#/home', true)

    assert.deepEqual(received, ['A:/home', 'B:/home'], 'sans ré-entrance, les 2 composants reçoivent le même chemin, dans l\'ordre')
  })

  it("2 navigations successives (PAS imbriquées, l'une après l'autre) fonctionnent normalement", function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const Router = makeRouter(win)
    const received: string[] = []
    const comp = { tagName: 'MJS-X', _mjs_hooks: { urlChange(path: string) { received.push(path) } } }
    Router._mjs_awareComponents.add(comp)

    Router.navigate('#/a', true)
    Router.navigate('#/b', true)

    assert.deepEqual(received, ['/a', '/b'], 'deux navigations séquentielles (pas de ré-entrance) : chacune complète normalement')
  })
})

// ── la garde de ré-entrance manquait à initComponent (montage) ──
function makeRouterMu(win: any) {
  const µ: any = { log() {}, warn() {}, error() {}, state: (o: any) => ({ ...o }) }
  const g: any = globalThis
  g.window = win
  g.document = win.document
  g.CustomEvent = win.CustomEvent
  new Function('µ', ROUTER)(µ)
  return µ
}

describe("routeur — initComponent() : garde de ré-entrance (redirect dans @urlChange AU MONTAGE)", function () {
  it("un redirect au montage (garde d'auth) n'est PAS écrasé par le matchPath périmé d'initComponent", function () {
    const win: any = new Window({ url: 'http://localhost/#/admin' })
    const µ = makeRouterMu(win)
    const Router = µ.Router
    // On espionne l'ORDRE des chemins injectés (le redirect imbriqué doit gagner).
    const injections: { mp: string }[] = []
    Router._mjs_injectViewsForComponent = function (_c: any, mp: string) { injections.push({ mp }) }
    const comp: any = {
      tagName: 'MJS-SHELL',
      routes: { main: { '/admin': 'admin-page', '/login': 'login-page' } },
      _mjs_hooks: { urlChange(path: string) { if (path === '/admin') Router.to('/login') } },
      _shadow: { querySelector: () => null },
      querySelector: () => null,
    }
    Router.register(comp)

    assert.equal(µ.url.path, '/login',
      "AVANT le fix : initComponent rappelait _mjs_updateUrlStore('/admin') APRÈS le redirect → µ.url.path retombait sur /admin")
    assert.ok(injections.length >= 1, 'au moins une injection a eu lieu (celle du redirect)')
    assert.equal(injections[injections.length - 1].mp, '/login',
      "AVANT le fix : initComponent ré-injectait /admin PAR-DESSUS la vue /login posée par le redirect")
    assert.ok(!injections.some((i) => i.mp === '/admin'),
      "la route interdite /admin ne doit jamais être injectée")
  })

  it("sans redirect au montage : initComponent injecte normalement la route courante (inchangé)", function () {
    const win: any = new Window({ url: 'http://localhost/#/home' })
    const µ = makeRouterMu(win)
    const Router = µ.Router
    const injections: { mp: string }[] = []
    Router._mjs_injectViewsForComponent = function (_c: any, mp: string) { injections.push({ mp }) }
    const comp: any = {
      tagName: 'MJS-SHELL',
      routes: { main: { '/home': 'home-page' } },
      _mjs_hooks: { urlChange() {} },
      _shadow: { querySelector: () => null },
      querySelector: () => null,
    }
    Router.register(comp)
    assert.equal(µ.url.path, '/home')
    assert.deepEqual(injections, [{ mp: '/home' }], 'une seule injection, la route courante')
  })
})

// ── navigation en REMPLACEMENT (to(route, {replace:true})) ──
function makeSpyWin(url: string) {
  const u = new URL(url)
  const calls: string[] = []
  const win: any = {
    location: {
      get href() { return u.href }, get hash() { return u.hash },
      get pathname() { return u.pathname }, get search() { return u.search },
    },
    history: {
      state: null,
      pushState(_s: any, _t: any, d: string) { calls.push('push:' + d); u.href = new URL(d, u.href).href },
      replaceState(_s: any, _t: any, d: string) { calls.push('replace:' + d); u.href = new URL(d, u.href).href },
    },
    dispatchEvent() {},
    document: { getElementById: () => null, querySelector: () => null },
    CustomEvent: class { type: string; constructor(t: string) { this.type = t } },
  }
  return { win, calls }
}

describe("routeur — to(route, {replace:true}) : redirect sans piéger le Précédent (DURCISSEMENT)", function () {
  it("replace:true → replaceState (pas pushState)", function () {
    const { win, calls } = makeSpyWin('http://localhost/#/admin')
    const Router = makeRouter(win)
    Router.to('/login', { replace: true } as any)
    assert.deepEqual(calls, ['replace:#/login'],
      "un redirect de garde remplace l'entrée courante — sinon chaque « Précédent » repasse par la route redirigée")
  })

  it("to(route) (défaut) → pushState (comportement inchangé)", function () {
    const { win, calls } = makeSpyWin('http://localhost/#/a')
    const Router = makeRouter(win)
    Router.to('/b')
    assert.deepEqual(calls, ['push:#/b'])
  })

  it("to(route, false) → ni push ni replace (comportement inchangé)", function () {
    const { win, calls } = makeSpyWin('http://localhost/#/a')
    const Router = makeRouter(win)
    Router.to('/b', false)
    assert.deepEqual(calls, [])
  })
})
