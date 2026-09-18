// le rendu serveur (renderToString.ts) et le rendu navigateur (render-browser.ts)
// FORCENT `js: 'split'` sur leur Bundler INTERNE, quoi que dise `js` dans la config/les
// bundlerOpts du PROJET rendu : ces deux moteurs rechargent le cœur et les composants FICHIER
// PAR FICHIER (mjs_core-*.js, un basename par composant, cf. leurs propres commentaires), un
// contrat que `js: 'bundle'` (tout fusionné dans le manifeste) casserait.
//
// OÙ cette compilation forcée écrit dépend du mode du PROJET (cf. server/render-compile-dir.ts) :
//   · projet en `js: 'split'` — dans le VRAI dossier de sortie, comme le build lui-même (mêmes
//     options, mêmes empreintes de contenu : les fichiers réécrits sont les mêmes octets) ;
//   · projet en `js: 'bundle'` — dans un dossier TEMPORAIRE, retiré à la fermeture : le dossier de
//     sortie n'émet qu'UN fichier, qu'un manifeste éclaté écraserait.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { createBrowserRenderer } from '../src/server/render-browser.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
$name = "Monde"
</script>
<p class="hello">Bonjour {$name}</p>
`

function makeProject(prefix: string): { root: string; srcDir: string } {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'greet.mjs'), COMPONENT)
  return { root, srcDir }
}

function assertSplitLayout(outputDir: string): void {
  const files = existsSync(outputDir) ? readdirSync(outputDir) : []
  assert.ok(files.some(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f)), `le cœur doit être un fichier SÉPARÉ (mode split), trouvé : ${files.join(', ')}`)
  assert.ok(files.some(f => /^greet-[a-f0-9]{8}\.js$/.test(f)), `le composant doit être un fichier SÉPARÉ (mode split), trouvé : ${files.join(', ')}`)
}

/** Dossiers de travail du rendu encore présents sous `$TMPDIR` (aucun ne doit survivre à `close`). */
function ateliers(): string[] {
  return readdirSync(tmpdir()).filter(f => f.startsWith('mjs-render-'))
}

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

describe('renderToString/render-browser forcent js: \'split\' en interne', function () {
  this.timeout(30000)

  after(async () => { await terminateSharedWorkerPool() })

  it('renderToString : projet en split → le Bundler interne compile en place (mjs_core-*.js séparé), rendu OK', async function () {
    const { srcDir, root } = makeProject('ssr-force-split')
    const outputDir = join(root, 'out')
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir, bundlerOpts: { js: 'split' } as any })
    try {
      const res = await renderer.renderToString('mjs-greet')
      assert.match(res.html, /Bonjour Monde/, 'le rendu doit fonctionner normalement')
      assertSplitLayout(outputDir)
    } finally {
      await renderer.close()
    }
  })

  it('renderToString : projet en `js: \'bundle\'` → compilation dans un dossier de travail à lui, dossier de sortie INTACT, rendu OK', async function () {
    const { srcDir, root } = makeProject('ssr-force-split-bundle')
    const outputDir = join(root, 'out')
    const avant = ateliers()
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir, bundlerOpts: { js: 'bundle' } as any })
    try {
      const res = await renderer.renderToString('mjs-greet')
      assert.match(res.html, /Bonjour Monde/, 'le rendu doit fonctionner normalement — donc bien en split, fichier par fichier, ailleurs')
      const files = existsSync(outputDir) ? readdirSync(outputDir) : []
      assert.deepEqual(files, [], `le dossier de sortie du projet doit rester intact, trouvé : ${files.join(', ')}`)
    } finally {
      await renderer.close()
    }
    assert.deepEqual(ateliers().filter(d => !avant.includes(d)), [], 'le dossier de travail temporaire doit être retiré à la fermeture')
  })

  it('render-browser : projet en split → le Bundler interne (créé par createBrowserRenderer) compile en place', async function () {
    if (!(await isChromiumAvailable())) { this.skip(); return }
    const { root } = makeProject('browser-force-split')
    const outputDir = join(root, 'dist')
    const renderer = await createBrowserRenderer(
      { sourceDir: 'src', js: 'split' } as any,
      { configDir: root, outputDir },
    )
    try {
      assertSplitLayout(outputDir)
    } finally {
      await renderer.close()
    }
  })

  it('render-browser : projet en `js: \'bundle\'` → compilation dans un dossier de travail à lui, dossier de sortie INTACT', async function () {
    if (!(await isChromiumAvailable())) { this.skip(); return }
    const { root } = makeProject('browser-force-split-bundle')
    const outputDir = join(root, 'dist')
    const avant = ateliers()
    const renderer = await createBrowserRenderer(
      { sourceDir: 'src', js: 'bundle' } as any,
      { configDir: root, outputDir },
    )
    try {
      const res = await renderer.renderPage('mjs-greet')
      assert.match(res.html, /Bonjour Monde/, 'le rendu doit fonctionner normalement — donc bien en split, fichier par fichier, ailleurs')
      const files = existsSync(outputDir) ? readdirSync(outputDir) : []
      assert.deepEqual(files, [], `le dossier de sortie du projet doit rester intact, trouvé : ${files.join(', ')}`)
    } finally {
      await renderer.close()
    }
    assert.deepEqual(ateliers().filter(d => !avant.includes(d)), [], 'le dossier de travail temporaire doit être retiré à la fermeture')
  })
})
