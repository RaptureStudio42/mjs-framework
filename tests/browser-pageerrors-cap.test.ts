// `pageErrors` (render-browser.ts, écouteur `page.on('pageerror', …)`) est
// accumulé SANS plafond ni troncature avant ce correctif — contraste direct avec journal.ts
// (MAX_MESSAGE_CHARS=2048, DEFAULT_MAX_ENTRIES=200). Un composant dont `@mount` lève massivement
// pendant `settleMs` gonfle `warnings` sans borne (mémoire + verbosité de logs, cf.
// render-request.ts qui les `console.warn` une à une). Correctif attendu : au plus 50 entrées,
// chaque message tronqué à 1000 caractères.
//
// MIS À JOUR — une `pageerror` fait désormais ÉCHOUER le rendu (`renderPage()` rejette),
// plutôt que de s'accumuler en simple avertissement dans un rendu qui réussit quand même (cf.
// tests/prerender-erreur-fatale.test.ts) : le plafond reste entier, mais se vérifie
// maintenant sur le message de l'erreur REJETÉE (`pageErrorMsgs.join(' | ')`, render-browser.ts)
// plutôt que sur `res.warnings` d'un rendu qui aurait réussi.
//
// Même garde de disponibilité que tests/render-browser.test.ts (skip propre si Chromium absent).
//
//   xvfb-run -a npx mocha tests/browser-pageerrors-cap.test.ts --extension ts --require tsx/esm --exit

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

function project(): string {
  const root = mjsTmp('pageerrors')
  mkdirSync(join(root, 'src'), { recursive: true })
  return root
}

describe('render-browser — pageErrors plafonnées en nombre ET en taille', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test browser-pageerrors-cap skippé. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it("500 erreurs de page (messages de 2000 caractères) : le rendu échoue, au plus 50 entrées dans l'erreur fatale, chacune bornée", async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    // N exceptions
    // asynchrones (setTimeout 0) pendant @mount, chacune avec un message hostile de taille excessive.
    writeFileSync(join(root, 'src', 'errcap.mjs'), `
<script lang="coffee">
µmount ->
  i = 0
  while i < 500
    setTimeout((-> throw new Error('boom-' + 'x'.repeat(2000))), 0)
    i += 1
</script>
<p>errcap</p>
`)
    const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
    try {
      let caught: Error | null = null
      try {
        await renderer.renderPage('mjs-errcap', { settleMs: 1500 })
      } catch (e: any) {
        caught = e
      }
      // une pageerror non gérée fait désormais rejeter renderPage() (cf.
      // tests/prerender-erreur-fatale.test.ts) : plus un succès avec des warnings.
      assert.ok(caught, 'une pageerror non gérée doit désormais faire échouer CE rendu')
      const errEntries = caught!.message.split(' | ').filter(m => /erreur non interceptée dans la page/.test(m))
      assert.ok(errEntries.length > 0, 'au moins une erreur de page doit avoir été capturée (le composant lève bien)')
      assert.ok(errEntries.length <= 50, `au plus 50 entrées pageerror attendues dans l'erreur fatale, trouvé ${errEntries.length}`)
      for (const m of errEntries) {
        assert.ok(m.length < 1200, `chaque entrée doit rester bornée (message source tronqué à ~1000 caractères), trouvé ${m.length} caractères`)
      }
    } finally {
      await renderer.close()
    }
  })
})
