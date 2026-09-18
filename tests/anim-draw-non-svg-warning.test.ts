// animations/draw.ts sur un nœud NON-SVG : no-op total et
// silencieux (aucun `getTotalLength`, `len` reste à 0, rien ne se voit, aucune
// erreur ni avertissement). Correctif : µ.warn explicite UNE fois (« @transition.
// draw ne s'applique qu'à un tracé SVG »), nœud laissé visible (le no-op en
// lui-même est inoffensif et reste inchangé — seul le silence est corrigé).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', 'draw.ts'), 'utf-8')

function loadFactory(µMock: any) {
  return new Function('µ', 'return (' + SRC.trim().replace(/;\s*$/, '') + ')')(µMock)
}

describe('animations/draw.ts — nœud non-SVG', function () {
  let win: any
  let µMock: any
  let warned: any[]
  beforeEach(() => {
    win = new Window({ url: 'http://localhost/' })
    ;(globalThis as any).window = win
    ;(globalThis as any).document = win.document
    warned = []
    µMock = {
      warn: (...a: any[]) => warned.push(a),
      easing: { resolve: (e: any) => e || ((x: number) => x), cubicInOut: (x: number) => x },
    }
  })

  it('<div> (non-SVG, pas de getTotalLength) : µ.warn explicite UNE fois, le message exact', function () {
    const node = win.document.createElement('div')
    const factory = loadFactory(µMock)
    const { intro } = factory({})
    const cfg = intro(node)
    assert.equal(warned.length, 1, 'un seul warn')
    assert.match(warned[0][0], /@transition\.draw ne s'applique qu'à un tracé SVG/, 'le message exact attendu')
    assert.equal(cfg.duration, 800, 'no-op inchangé par ailleurs : durée par défaut, len=0')
    assert.deepEqual(cfg.css(0.5, 0.5), { strokeDasharray: '0', strokeDashoffset: '0' }, 'css() reste un no-op inoffensif (aucun effet visuel sur un non-SVG)')
  })

  it('<path> SVG (getTotalLength présent) : AUCUN warn, comportement inchangé', function () {
    const path = win.document.createElementNS('http://www.w3.org/2000/svg', 'path')
    // happy-dom expose getTotalLength mais ne calcule pas de vraie géométrie —
    // seule sa PRÉSENCE (typeof === 'function') doit lever la garde.
    const factory = loadFactory(µMock)
    const { intro } = factory({})
    assert.doesNotThrow(() => intro(path))
    assert.equal(warned.length, 0, 'aucun warn sur un vrai tracé SVG')
  })

  it('appelé 2 fois (intro PUIS outro) sur le même nœud non-SVG : 2 warns (une fois PAR appel de setup, pas de dédoublonnage global)', function () {
    const node = win.document.createElement('div')
    const factory = loadFactory(µMock)
    const { intro, outro } = factory({})
    intro(node)
    outro(node)
    assert.equal(warned.length, 2, 'setup() tourne 2 fois (intro et outro), chaque appel avertit — pas de warn PAR FRAME')
  })
})
