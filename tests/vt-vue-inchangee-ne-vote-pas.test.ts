// Routeur — une <@view> dont le module ne change pas ne vote
// plus pour une transition de vue. Prouvé sur Chromium réel : deux
// composants routés sur une page ; un clic dans l'un change le hash, le routeur résout l'autre sur
// `/*` vers le MÊME module déjà affiché, et `_mjs_vtResolveNavigation` (mjs_router.ts ~l.712-740)
// faisait quand même voter cette vue — alors que son propre commentaire dit « pour CHAQUE <@view>
// qui va changer », que `_mjs_injectView` (~l.1011-1018) saute l'injection dans ce cas exact (même
// dérivation de tag `mjs-${moduleName}`), et que docs/17-router.md § « Bon à savoir » promet
// « pas une permutation de vue → pas de transition de page ». Résultat avant correctif : une
// transition de document entière (fade du site) déclenchée pour rien. Modèle repris :
// tests/view-transition.test.ts (describe '_mjs_vtResolveNavigation / navigate() — bout-en-bout') et
// tests/vt-data-attr.test.ts (loadRouter minimal, sans mjs_vt_presets.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')

describe('_mjs_vtResolveNavigation — une vue dont le module ne change pas ne vote pas', function () {
  // globals posés/restaurés PAR TEST — même précaution que view-transition.test.ts et
  // vt-data-attr.test.ts (CustomEvent natif de Node incompatible avec happy-dom, un autre
  // fichier du même process Mocha peut avoir déjà posé sa propre Window).
  let prevWindow: any, prevDocument: any, prevCustomEvent: any, prevCustomElements: any
  beforeEach(() => {
    prevWindow = (globalThis as any).window
    prevDocument = (globalThis as any).document
    prevCustomEvent = (globalThis as any).CustomEvent
    prevCustomElements = (globalThis as any).customElements
  })
  afterEach(() => {
    ;(globalThis as any).window = prevWindow
    ;(globalThis as any).document = prevDocument
    ;(globalThis as any).CustomEvent = prevCustomEvent
    ;(globalThis as any).customElements = prevCustomElements
  })

  function loadRouter(win: any) {
    const µ: any = { log() {}, warn() {}, error() {} }
    const g: any = globalThis
    g.window = win
    g.document = win.document
    g.CustomEvent = win.CustomEvent
    g.customElements = win.customElements
    new Function('µ', ROUTER_SRC)(µ)
    return µ
  }

  // vue déjà montée sur <mjs-page-a>, résolution 'on' posée sur l'attribut data-mjs-vt de la
  // <@view> — gagnerait le vote si la vue participait encore (bogue avant correctif).
  function makeComponentSameModule(win: any) {
    const document = win.document
    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'main'
    view.setAttribute('data-mjs-vt', 'on')
    view.appendChild(document.createElement('mjs-page-a'))
    comp._shadow = comp
    comp.appendChild(view)
    comp.routes = { main: { '/': 'page-a', '/b': 'page-b', '/*': 'page-a' } }
    return comp
  }

  it('(a) navigation vers un chemin qui résout ENCORE le module déjà affiché (/autre → /* → page-a) : _mjs_vtResolveNavigation rend null, startViewTransition n\'est pas appelé', () => {
    const win: any = new Window({ url: 'http://localhost/#/autre' })
    let started = false
    win.document.startViewTransition = function (cb: any) { started = true; cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeComponentSameModule(win))

    const winner = µ.Router._mjs_vtResolveNavigation('/autre')
    assert.equal(winner, null, "'/autre' résout encore page-a (règle '/*'), déjà affiché → la vue ne doit plus voter")

    µ.Router.navigate('#/autre', false)
    assert.equal(started, false, 'aucune vue ne change de module → startViewTransition ne doit pas démarrer')
  })

  it('(b) contre-cas : navigation vers un module DIFFÉRENT (/b → page-b) : la vue vote normalement, startViewTransition est appelé', () => {
    const win: any = new Window({ url: 'http://localhost/#/b' })
    let started = false
    win.document.startViewTransition = function (cb: any) { started = true; cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeComponentSameModule(win))

    const winner = µ.Router._mjs_vtResolveNavigation('/b')
    assert.deepEqual(winner, { value: true, priority: 1 }, 'module différent (page-b) → la vue participe toujours au vote')

    µ.Router.navigate('#/b', false)
    assert.equal(started, true, 'un module différent doit démarrer la transition')
  })

  it('(c) deux composants routés, une seule vue change : le gagnant vient d\'elle, même si la vue inchangée porte une priorité plus grande', () => {
    const win: any = new Window({ url: 'http://localhost/#/autre' })
    win.document.startViewTransition = function (cb: any) { cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
    const µ = loadRouter(win)
    const document = win.document

    // composant 1 : sa vue CHANGE (page-a → page-b), préréglage 'zoom', priorité par défaut (1)
    const changing: any = document.createElement('div')
    const changingView: any = document.createElement('metamjs-view')
    changingView.id = 'main'
    changingView.setAttribute('data-mjs-vt', 'zoom')
    changingView.appendChild(document.createElement('mjs-page-a'))
    changing._shadow = changing
    changing.appendChild(changingView)
    changing.routes = { main: { '/': 'page-a', '/autre': 'page-b' } }

    // composant 2 : sa vue NE CHANGE PAS (page-a → page-a via '/autre'), préréglage 'cube',
    // priorité 5 — gagnerait l'ancien départage si elle votait encore (bogue), ne doit plus
    // rien proposer une fois corrigé.
    const unchanged: any = document.createElement('div')
    const unchangedView: any = document.createElement('metamjs-view')
    unchangedView.id = 'main'
    unchangedView.setAttribute('data-mjs-vt', 'cube')
    unchangedView.setAttribute('data-mjs-vt-p', '5')
    unchangedView.appendChild(document.createElement('mjs-page-a'))
    unchanged._shadow = unchanged
    unchanged.appendChild(unchangedView)
    unchanged.routes = { main: { '/': 'page-a', '/autre': 'page-a' } }

    µ.Router._mjs_awareComponents.add(changing)
    µ.Router._mjs_awareComponents.add(unchanged)

    const winner = µ.Router._mjs_vtResolveNavigation('/autre')
    assert.deepEqual(winner, { value: 'zoom', priority: 1 }, 'la vue qui reste sur page-a (priorité 5) ne doit pas participer : le gagnant vient de celle qui change')

    const applied: string[] = []
    µ._mjs_vtApplyPreset = (name: string) => applied.push(name)
    µ.Router.navigate('#/autre', false)
    assert.deepEqual(applied, ['zoom'], 'la transition appliquée est bien celle de la vue qui change, jamais "cube"')
  })
})
