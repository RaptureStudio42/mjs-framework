// viewer-page.ts (getViewerScript) : un manifeste 'bundle' n'a plus de ligne
// `const µCore = '…';` (le cœur n'est plus une unité séparée, tout est fusionné) — repli sur
// l'URL publique FIXE du manifeste lui-même (`/__mjs/bundle.js`, route servant `manifestPath`
// tel quel, cf. render-server.ts), puisque ce fichier réexporte `µ` (`export { µ };`).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { getViewerScript, JOURNAL_VIEWER } from '../src/server/viewer-page.js'
import { mjsTmp } from './helpers/tmp.js'

function manifestAt(content: string): string {
  const root = mjsTmp('viewer-js-bundle')
  const outDir = join(root, 'out')
  mkdirSync(outDir, { recursive: true })
  const manifestPath = join(outDir, 'bundle.js')
  writeFileSync(manifestPath, content)
  return manifestPath
}

describe('viewer-page.getViewerScript — repli mode \'bundle\' (pas de const µCore)', function () {
  it('manifeste SPLIT (const µCore présent) : comportement inchangé, importe le cœur RÉEL', async function () {
    const manifestPath = manifestAt("const µCore = '/modularjs/mjs_core-abcd1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const js = await getViewerScript(manifestPath, JOURNAL_VIEWER)
    assert.ok(js.includes('"/modularjs/mjs_core-abcd1234.js"'), 'doit importer le chemin RÉEL du cœur trouvé dans le manifeste')
  })

  it("manifeste BUNDLE (pas de const µCore, mais un export) : repli sur l'URL fixe /__mjs/bundle.js", async function () {
    const manifestPath = manifestAt('µ.paths = { "greet": import.meta.url };\nµ.version = "abcd1234";\nexport { µ };\n')
    const js = await getViewerScript(manifestPath, JOURNAL_VIEWER)
    assert.ok(js.includes('"/__mjs/bundle.js"'), 'doit importer le manifeste à sa propre URL publique fixe')
  })

  it('manifeste BUNDLE minifié (export{i as µ}) : repli identique — aucune dépendance à la forme non minifiée', async function () {
    const manifestPath = manifestAt('var i={};i.version="abcd1234";export{i as µ};')
    const js = await getViewerScript(manifestPath, JOURNAL_VIEWER)
    assert.ok(js.includes('"/__mjs/bundle.js"'), 'le repli ne doit pas dépendre du style d\'export (minifié ou non)')
  })

  it('manifeste NI split NI export (illisible/corrompu) : erreur inchangée (pas de repli hasardeux)', async function () {
    const manifestPath = manifestAt('// manifeste vide ou corrompu, ni µCore ni export\n')
    await assert.rejects(() => getViewerScript(manifestPath, JOURNAL_VIEWER), /introuvable/i)
  })
})
