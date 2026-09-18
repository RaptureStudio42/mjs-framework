// config-render-queue — `render.renderQueue`
// (concurrency/maxQueue, plafond de rendus SSR simultanés) est LU en souple par render-request.ts
// (`as any`, défauts 4/32) mais absent de KNOWN_RENDER_KEYS/validateRenderConfig : l'écrire au
// mjs.config.json faisait échouer TOUT le build sur « clé inconnue 'render.renderQueue' », et une
// valeur mal typée (concurrency: 0, maxQueue: 'x') passait sans le moindre signal — même famille
// que render.browserPool (déjà déclaré), pris ici comme patron.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig } from '../src/bundler/config.js'

function fixture(renderQueue: unknown): string {
  const root = mjsTmp('config-render-queue')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src',
    render: { routes: { '/': { component: 'mjs-home' } }, renderQueue },
  }))
  return root
}

describe('config — render.renderQueue déclaré et validé', () => {
  it('{ concurrency: 4, maxQueue: 32 } (défauts de render-request.ts) : accepté', () => {
    const root = fixture({ concurrency: 4, maxQueue: 32 })
    assert.doesNotThrow(() => findConfig(root), "AVANT le fix : « clé inconnue 'render.renderQueue' » malgré la lecture souple côté render-request.ts")
  })

  it('objet vide {} (les deux sous-clés sont optionnelles) : accepté', () => {
    const root = fixture({})
    assert.doesNotThrow(() => findConfig(root))
  })

  it('concurrency: 0 (doit être ≥ 1) : refusé, message nommé', () => {
    const root = fixture({ concurrency: 0 })
    assert.throws(() => findConfig(root), /render\.renderQueue\.concurrency/)
  })

  it("maxQueue: 'x' (doit être un entier) : refusé, message nommé", () => {
    const root = fixture({ maxQueue: 'x' })
    assert.throws(() => findConfig(root), /render\.renderQueue\.maxQueue/)
  })

  it('maxQueue: 0 (borne ≥ 0, file vide autorisée) : accepté', () => {
    const root = fixture({ maxQueue: 0 })
    assert.doesNotThrow(() => findConfig(root))
  })

  it('maxQueue: -1 (sous la borne ≥ 0) : refusé', () => {
    const root = fixture({ maxQueue: -1 })
    assert.throws(() => findConfig(root), /render\.renderQueue\.maxQueue/)
  })

  it('clé inconnue render.renderQueue.foo : refusée', () => {
    const root = fixture({ foo: 1 })
    assert.throws(() => findConfig(root), /render\.renderQueue\.foo/)
  })

  it('render.renderQueue pas un objet (tableau) : refusé', () => {
    const root = fixture([1, 2])
    assert.throws(() => findConfig(root), /render\.renderQueue/)
  })
})
