// garde permanent : UNE navigation crée UNE SEULE entrée d'historique,
// même quand le composant routeur déclare PLUSIEURS jeux de routes (plusieurs
// <@view> ciblées par @routes, ex. `app-content` ET `app-code`). Hypothèse
// infirmée sur pièce : `window.history.pushState` (mjs_router.ts, `navigate`)
// est appelé UNE fois par appel de `navigate()`, AVANT la boucle qui injecte
// les vues — `_mjs_injectViewsForComponent` itère ensuite chaque clé de
// `comp.routes` (chaque jeu de routes) mais ne touche jamais `history` : le
// nombre de jeux de routes n'a donc AUCUN effet sur le nombre d'entrées.
// Ce test verrouille ce comportement pour l'avenir (régression si un futur
// refactor déplaçait le pushState DANS la boucle d'injection).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')

// Globals posés/restaurés PAR TEST (jamais un `??=` qui suppose être seul à
// les poser) — même précaution que router-navigate-reentrance.test.ts.
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

describe('routeur — navigate() : 1 navigation = 1 entrée d\'historique, même avec 2 jeux de routes', function () {
  it('composant avec 2 @routes (app-content, app-code) : chaque navigate() ajoute UNE SEULE entrée, pas une par jeu de routes', function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const Router = makeRouter(win)

    const comp: any = {
      tagName: 'MJS-SHELL',
      routes: {
        'app-content': { '/a': 'x', '/b': 'y' },
        'app-code': { '/a': 'x-code', '/b': 'y-code' },
      },
      // Pas de vraie <metamjs-view> dans le DOM : _mjs_injectView loggue une
      // erreur (µ.error no-op) et sort sans crasher — seul `history.length`
      // nous intéresse ici, pas l'injection elle-même.
      _shadow: { querySelector: () => null },
      querySelector: () => null,
    }
    Router._mjs_awareComponents.add(comp)

    assert.equal(win.history.length, 1, 'état initial : 1 entrée (la page de départ)')

    Router.navigate('#/b', true)
    assert.equal(win.history.length, 2,
      "AVANT la garantie : un pushState PAR jeu de routes aurait donné 3 (1 initiale + 2), pas 2")

    Router.navigate('#/a', true)
    assert.equal(win.history.length, 3, 'une 2e navigation ajoute exactement une 2e entrée (3 au total)')
  })
})
