// render-browser (Chromium réel) — `onPageError` (render-browser.ts) rangeait
// TOUTE `pageerror`, sans filtre d'origine, dans une liste qui faisait ÉCHOUER le rendu — un
// composant SAIN dont le montage injecte un script TIERS (widget, analytics…) qui lève de SON
// côté, sans rapport avec le rendu MJS, partait quand même en échec. Correctif : n'est fatale
// qu'une `pageerror` dont la pile référence une ressource DU PROJET (bundle/chunks servis sous
// `bundler.urlPrefix`, ou `BUNDLE_PATH`) OU qui coïncide avec le crash structurel
// (`µ._fatalErrors`, cf. fatal-signal.test.ts) ; les autres restent des `warnings`.
//
// Garde de disponibilité — même motif que tests/render-browser.test.ts.
//
//   xvfb-run -a npx mocha tests/pageerror-tiers.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createBrowserRenderer } from '../src/server/render-browser.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

function project(prefix: string): string {
  const root = mjsTmp(prefix)
  mkdirSync(join(root, 'src'), { recursive: true })
  return root
}

describe('render-browser — pageerror : filtre d\'origine', function () {
  this.timeout(60000)
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, tests pageerror-tiers skippés. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it("script TIERS injecté par le montage (sans rapport avec le rendu) qui lève : page écrite, warnings non vide, PAS fatal", async function () {
    if (!chromiumReady) { this.skip(); return }
    const root = project('e20-pageerror-tiers-sain')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µmount ->
  s = document.createElement('script')
  s.textContent = "window.setTimeout(function(){ throw new Error('crash script tiers, analytics fictif') }, 0)"
  document.head.appendChild(s)
</script>
<h1>page saine, MJS ne lève rien</h1>
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      const res = await renderer.renderPage('mjs-home', {})
      assert.match(res.html, /page saine, MJS ne lève rien/, 'la page saine doit être servie telle quelle')
      assert.doesNotMatch(res.html, /mjs-fatal-error/, 'aucun panneau fatal (MJS lui-même n\'a jamais crashé)')
      assert.ok(res.warnings.some(w => /crash script tiers/.test(w)), `l'erreur du script tiers doit rester journalisée en avertissement — warnings : ${JSON.stringify(res.warnings)}`)
    } finally {
      await renderer.close()
    }
  })

  it('throw DANS le composant (µmount, ressource du projet) → toujours fatal (non-régression)', async function () {
    if (!chromiumReady) { this.skip(); return }
    const root = project('e20-pageerror-tiers-projet')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µmount ->
  throw new Error('boom mount e20')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      await assert.rejects(
        () => renderer.renderPage('mjs-home', {}),
        /boom mount e20/,
        'un crash DANS le composant (pile sous bundler.urlPrefix) doit toujours faire échouer le rendu',
      )
    } finally {
      await renderer.close()
    }
  })
})
