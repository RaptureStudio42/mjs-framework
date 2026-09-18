// render-browser (Chromium réel) :
// `isProjectStack` (render-browser.ts:1010) juge une `pageerror` fatale seulement si sa pile
// référence une ressource du projet — un `throw 'chaîne'` (valeur sans `.stack`, donc pile VIDE)
// ne référence RIEN, la pile vide n'était donc jamais reconnue fatale : page écrite intacte, simple
// avertissement. Correctif : une pile SANS ligne « at … » exploitable ne peut pas être attribuée à
// un tiers → comptée PAR PRUDENCE comme venant du projet (fatale), comme un crash structurel MJS.
//
// Garde de disponibilité — même motif que tests/render-browser.test.ts.
//
//   xvfb-run -a npx mocha tests/pageerror-sans-pile.test.ts --extension ts --require tsx/esm --exit

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

describe('render-browser — pageerror sans pile exploitable : fatale par prudence', function () {
  this.timeout(60000)
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, tests pageerror-sans-pile skippés. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it("throw d'une CHAÎNE (pas d'Error, pas de .stack) dans µmount → fatal", async function () {
    if (!chromiumReady) { this.skip(); return }
    const root = project('e23-pageerror-throw-string')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µmount ->
  throw 'chaine-brute-sans-stack'
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      await assert.rejects(
        () => renderer.renderPage('mjs-home', {}),
        /chaine-brute-sans-stack/,
        'un throw de chaîne (pile vide) doit faire échouer le rendu, par prudence',
      )
    } finally {
      await renderer.close()
    }
  })

  it('script TIERS avec pile ÉTRANGÈRE (frames hors projet) → avertissement, PAS fatal (non-régression pageerror-tiers)', async function () {
    if (!chromiumReady) { this.skip(); return }
    const root = project('e23-pageerror-tiers-non-regression')
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
      assert.ok(res.warnings.some(w => /crash script tiers/.test(w)), `l'erreur du script tiers doit rester journalisée en avertissement — warnings : ${JSON.stringify(res.warnings)}`)
    } finally {
      await renderer.close()
    }
  })
})
