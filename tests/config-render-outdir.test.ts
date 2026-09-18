// `render.outDir` est le dossier que le prérendu ÉCRIT et dont il RETIRE ses fragments périmés
// (server/prerender.ts) : il doit rester DANS le projet, et la garde qui le vérifie compare des
// chemins RÉELS. Une comparaison de chaînes laissait passer un lien symbolique posé dans le projet
// et pointant ailleurs — les deux gestes partaient alors hors de l'arbre que le développeur a sous
// les yeux, exactement ce que cette garde existe pour empêcher.

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { findConfig } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

function projet(outDir: string, prepare?: (root: string) => void): string {
  const root = mjsTmp('cfg-outdir')
  prepare?.(root)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ render: { outDir, routes: { '/': { component: 'mjs-home' } } } }))
  return root
}

describe('mjs.config.json — render.outDir reste dans le projet, chemins RÉELS', () => {
  it('un sous-dossier du projet est accepté', () => {
    const found = findConfig(projet('public/mjs_pages'))
    assert.ok(found)
    assert.equal(found!.config.render!.outDir, 'public/mjs_pages')
  })

  it('la racine du projet elle-même est acceptée', () => {
    assert.ok(findConfig(projet('.')))
  })

  it('un `..` est refusé', () => {
    assert.throws(() => findConfig(projet('../ailleurs')), /render\.outDir/)
  })

  it('un chemin absolu hors du projet est refusé', () => {
    assert.throws(() => findConfig(projet('/tmp/ailleurs')), /render\.outDir/)
  })

  it('un LIEN SYMBOLIQUE du projet qui pointe dehors est refusé', () => {
    const dehors = mjsTmp('cfg-outdir-dehors')
    const root = projet('pages', (r) => { symlinkSync(dehors, join(r, 'pages'), 'dir') })
    assert.throws(() => findConfig(root), /render\.outDir/, 'le lien mène hors du projet : la garde doit le voir')
  })

  it('un lien symbolique qui reste DANS le projet est accepté', () => {
    const root = projet('pages', (r) => {
      mkdirSync(join(r, 'public', 'mjs_pages'), { recursive: true })
      symlinkSync(join(r, 'public', 'mjs_pages'), join(r, 'pages'), 'dir')
    })
    assert.ok(findConfig(root))
  })
})
