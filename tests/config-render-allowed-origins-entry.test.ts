// render.allowedOrigins et render.entry : clés CONNUES (KNOWN_RENDER_KEYS)
// mais jamais validées (contrairement à render.forwardOrigin/ws.entry, même famille). Une valeur
// mal typée passait findConfig()/validateConfig() sans la moindre erreur ni avertissement.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig } from '../src/bundler/config.js'

function fixture(render: Record<string, unknown>): string {
  const root = mjsTmp('config-render-allowed-entry')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src',
    render: { routes: { '/': { component: 'mjs-home' } }, ...render },
  }))
  return root
}

describe('config — render.allowedOrigins / render.entry validés strictement', () => {
  it('allowedOrigins EN CHAÎNE (pas un tableau) : refusé', () => {
    const root = fixture({ allowedOrigins: 'https://evil.example' })
    assert.throws(() => findConfig(root), /allowedOrigins/, 'AVANT le fix : accepté sans erreur, silencieux (repli runtime sûr mais aucun signal au dev)')
  })

  it('allowedOrigins tableau avec un élément NON-CHAÎNE : refusé', () => {
    const root = fixture({ allowedOrigins: ['https://ok.example', 42] })
    assert.throws(() => findConfig(root), /allowedOrigins/)
  })

  it('allowedOrigins tableau de chaînes non vides : accepté', () => {
    const root = fixture({ allowedOrigins: ['https://ok.example'] })
    assert.doesNotThrow(() => findConfig(root))
  })

  it('allowedOrigins: false : accepté (coupe le contrôle, valeur documentée)', () => {
    const root = fixture({ allowedOrigins: false })
    assert.doesNotThrow(() => findConfig(root))
  })

  it('entry EN NOMBRE (pas une chaîne) : refusé, MÊME patron que ws.entry/serveur.entry', () => {
    const root = fixture({ entry: 42 })
    assert.throws(() => findConfig(root), /render\.entry/, 'AVANT le fix : accepté sans erreur, contrairement à ws.entry')
  })

  it('entry en chaîne non vide : accepté', () => {
    const root = fixture({ entry: 'server/serve.server.mjs' })
    assert.doesNotThrow(() => findConfig(root))
  })
})
