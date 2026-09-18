// `window.open()` déclenché par un composant pendant `@mount` ouvre une Page
// Playwright jamais suivie ni fermée par `render-browser.ts` (aucun `context.on('page', …)` posé
// nulle part avant ce correctif). Le contexte est POOLED (réutilisé entre
// plusieurs rendus, `keepAlive:true` par défaut) : la popup y reste vivante jusqu'à `maxAgeMs`
// (5 min) — DoS mémoire progressif pour un composant qui ouvre une popup à chaque rendu.
//
// Même garde de disponibilité que tests/render-browser.test.ts (skip propre si Chromium absent).
// Capture du CONTEXTE réel du slot via un espion posé sur `BrowserContext.prototype.route`
// (méthode appelée UNE fois par `bootSlot()`, cf. render-browser.ts) — le prototype est PARTAGÉ
// entre toute instance Playwright de CE process (même module `playwright`, un seul node_modules),
// donc entre notre navigateur-sonde et celui lancé EN INTERNE par `createBrowserRenderer` : prouvé
// par sonde avant écriture (Object.getPrototypeOf identique entre 2 contextes/2 navigateurs).
//
//   xvfb-run -a npx mocha tests/browser-popup-leak.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { chromium } from 'playwright'
import { mjsTmp } from './helpers/tmp.js'
import { createBrowserRenderer } from '../src/server/render-browser.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

async function isChromiumAvailable(): Promise<boolean> {
  try {
    return existsSync(chromium.executablePath())
  } catch {
    return false
  }
}

function project(): string {
  const root = mjsTmp('popup')
  mkdirSync(join(root, 'src'), { recursive: true })
  return root
}

describe('render-browser — window.open() pendant @mount ne doit pas fuir de Page Playwright', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test browser-popup-leak skippé. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('après le rendu d\'un composant qui ouvre une popup, le contexte du slot ne contient plus qu\'une seule page (popup refermée)', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project()
    writeFileSync(join(root, 'src', 'popup.mjs'), `
<script lang="coffee">
µmount ->
  window.open('about:blank', '_blank')
</script>
<p>popup</p>
`)

    // sonde jetable : navigateur/contexte lancés puis IMMÉDIATEMENT refermés, uniquement pour
    // récupérer le PROTOTYPE partagé de BrowserContext (même singleton module que
    // render-browser.ts, cf. son resolveBrowserEngine).
    const probeBrowser = await chromium.launch({ headless: true })
    const probeCtx = await probeBrowser.newContext()
    const ContextProto = Object.getPrototypeOf(probeCtx)
    await probeCtx.close()
    await probeBrowser.close()

    const originalRoute = ContextProto.route
    let captured: any = null
    // espion : n'altère RIEN (délègue toujours à l'original), capture juste le PREMIER contexte
    // dont `route('**/*', …)` est appelé — exactement l'appel unique posé par bootSlot().
    ContextProto.route = function (...args: any[]) {
      if (!captured) captured = this
      return originalRoute.apply(this, args)
    }

    try {
      const renderer = await createBrowserRenderer({ sourceDir: 'src', outputDir: 'out' }, { configDir: root })
      try {
        await renderer.renderPage('mjs-popup', { settleMs: 1000 })
        assert.ok(captured, 'le contexte du slot doit avoir été capturé via route()')
        // marge pour laisser le temps à l'écouteur 'page' (asynchrone, jamais attendu par
        // bootSlot()) de refermer la popup (300ms).
        await new Promise((r) => setTimeout(r, 300))
        assert.equal(captured.pages().length, 1, 'une seule page doit subsister dans le contexte : la popup ouverte par window.open() doit avoir été refermée')
      } finally {
        await renderer.close()
      }
    } finally {
      ContextProto.route = originalRoute
    }
  })
})
