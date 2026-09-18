// µ._mjs_fixPosition(node) SANS rect (cas {if}/{key}) : épingle sur la boîte de
// MISE EN PAGE (offsetLeft/offsetTop), jamais sur le rectangle transformé. Mesuré Chromium :
// la sortie de cube pose dès sa 1re image clé un `transform:
// perspective(...)` avec `transformOrigin` en profondeur — le rectangle rendu
// (getBoundingClientRect) gonfle et se décale, `_mjs_fixPosition` épinglait l'ancien 4px trop à
// gauche et 2px trop haut pour toute la durée de l'effet. Même chargement que
// easing-bezier.test.ts : source lue, `new Function('µ', ...)` (le fichier est une suite
// d'assignations top-level, pas un module ES), `window` simulé. `µ` reste quasi vide :
// `_mjs_fixPosition` ne touche à aucun `µ.*`.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(__dirname, '..', 'src', 'runtime')
const EASING_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_easing.ts'), 'utf-8')

function load(computedStyle: any) {
  const g: any = globalThis
  g.window = { getComputedStyle: function () { return computedStyle } }
  const µ: any = {}
  new Function('µ', EASING_SRC)(µ)
  return µ
}

describe('µ._mjs_fixPosition sans rect : boîte de mise en page, pas le rectangle transformé', function () {
  afterEach(function () {
    delete (globalThis as any).window
  })

  it('sans rect, offsetParent sans bordure : left/top = offsetLeft/offsetTop, PAS le rectangle gonflé par la perspective de cube', function () {
    const µ = load({ position: 'static', width: '150px', height: '100px' })
    const op = { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
    const node: any = { nodeType: 1, style: {}, offsetLeft: 20, offsetTop: 53, offsetParent: op, getBoundingClientRect: () => ({ left: 16.3115, top: 50.541, width: 157, height: 105 }) }
    µ._mjs_fixPosition(node)
    assert.equal(node.style.position, 'absolute')
    assert.equal(node.style.margin, '0')
    assert.equal(node.style.width, '150px')
    assert.equal(node.style.height, '100px')
    assert.equal(node.style.left, '20px', 'boîte de mise en page (offsetLeft) : avant le fix, épinglait à 16.3115px (rect gonflé par la perspective)')
    assert.equal(node.style.top, '53px', 'boîte de mise en page (offsetTop) : avant le fix, épinglait à 50.541px (rect gonflé par la perspective)')
    assert.equal(node._mjs_posFixed, true)
  })

  it('sans rect, offsetParent BORDÉ (clientLeft/clientTop non nuls) : offsetLeft/offsetTop déjà nets de la bordure, pas de double soustraction', function () {
    const µ = load({ position: 'static', width: '150px', height: '100px' })
    const op = { clientLeft: 2, clientTop: 3, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
    const node: any = { nodeType: 1, style: {}, offsetLeft: 20, offsetTop: 53, offsetParent: op, getBoundingClientRect: () => ({ left: 16.3115, top: 50.541, width: 157, height: 105 }) }
    µ._mjs_fixPosition(node)
    assert.equal(node.style.left, '20px')
    assert.equal(node.style.top, '53px')
  })

  it('AVEC targetRect (chemin liste _mjs_reconcileList) : formule par rectangle inchangée', function () {
    const µ = load({ position: 'static', width: '150px', height: '100px' })
    const op = { clientLeft: 2, clientTop: 0, getBoundingClientRect: () => ({ left: 100, top: 0 }) }
    const node: any = { nodeType: 1, style: {}, offsetLeft: 999, offsetTop: 999, offsetParent: op, getBoundingClientRect: () => ({ left: 999, top: 999 }) }
    µ._mjs_fixPosition(node, { left: 130, top: 40 })
    assert.equal(node.style.left, '28px', '130 - 100 - 2 : le chemin targetRect ne bouge pas')
    assert.equal(node.style.top, '40px')
  })

  it('nœud déjà position:absolute (computed) : aucun style posé, pas d\'épinglage', function () {
    const µ = load({ position: 'absolute', width: '150px', height: '100px' })
    const op = { clientLeft: 0, clientTop: 0, getBoundingClientRect: () => ({ left: 0, top: 0 }) }
    const node: any = { nodeType: 1, style: {}, offsetLeft: 20, offsetTop: 53, offsetParent: op, getBoundingClientRect: () => ({ left: 16.3115, top: 50.541, width: 157, height: 105 }) }
    µ._mjs_fixPosition(node)
    assert.equal(node.style.position, undefined)
    assert.equal(node._mjs_posFixed, undefined)
  })

  it('offsetParent null et sans rect (hors flux) : repli sur l\'ancienne formule par rectangle, pas de régression', function () {
    const µ = load({ position: 'static', width: '150px', height: '100px' })
    const node: any = { nodeType: 1, style: {}, offsetLeft: 20, offsetTop: 53, offsetParent: null, getBoundingClientRect: () => ({ left: 16.3115, top: 50.541, width: 157, height: 105 }) }
    µ._mjs_fixPosition(node)
    assert.equal(node.style.left, '16.3115px')
    assert.equal(node.style.top, '50.541px')
  })
})
