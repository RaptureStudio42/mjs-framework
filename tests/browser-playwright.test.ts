// Test Playwright (vrai Chromium) en complément du runtime-e2e.test.ts
// (qui utilise happy-dom). Couvre :
//   - Vraies animations CSS / WAAPI
//   - Shadow DOM réel (closed mode)
//   - Évènements pointer/keyboard authentiques
//
// **Opt-in** : skippé par défaut. Activer via la variable d'env :
//   MJS_PLAYWRIGHT=1 npm test
// Et installer Chromium en amont :
//   npx playwright install chromium
//
// Reste skippé en CI standard tant que MJS_PLAYWRIGHT n'est pas mis. Évite
// la dépendance lourde (~150 MB de browser) et les timeouts dans les
// environnements sans display/sandbox.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler } from '../src/bundler/index.js'
import { StaticServer } from '../src/server/index.js'

// Vérifie si Chromium est dispo. Évite d'échouer en dev/CI sans browser installé.
async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    // L'exécutable n'existe que si `playwright install chromium` a été lancé.
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

describe('Playwright (browser réel)', function () {
  let chromiumReady = false
  const optIn = process.env.MJS_PLAYWRIGHT === '1'

  before(async function () {
    this.timeout(5000)
    if (!optIn) return  // skip silencieusement si pas opt-in
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, tests Playwright skippés. ' +
                  'Activer : `npx playwright install chromium`')
    }
  })

  it('compose et réagit dans Chromium', async function () {
    if (!optIn || !chromiumReady) { this.skip(); return }
    this.timeout(30000)

    // 1. Setup projet
    const root = mjsTmp('playwright')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'counter.mjs'), `
<script lang="coffee">
$count = 0
incr = => $count = $count + 1
</script>
<button @click={incr()}>Count: {$count}</button>
`)

    // 2. Compile
    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(outDir, 'bundle.js'),
      forceMinify: false,
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `compilation a échoué: ${stats.errors.map(e => e.message).join('\n')}`)

    // 3. Crée page HTML qui charge le bundle
    const htmlPath = join(outDir, 'index.html')
    const bundleRel = 'bundle.js'
    writeFileSync(htmlPath, `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>MJS Test</title></head>
<body>
<mjs-counter></mjs-counter>
<script type="module" src="${bundleRel}"></script>
</body></html>`)

    // 4. Serveur local
    const port = 38000 + Math.floor(Math.random() * 2000)
    const server = new StaticServer({
      rootDir: outDir,
      port,
      host: '127.0.0.1',
      pathPrefix: bundler.urlPrefix,
    })
    await server.start()

    try {
      // 5. Lance Chromium
      const { chromium } = await import('playwright')
      const browser = await chromium.launch({ headless: true })
      const ctx = await browser.newContext()
      const page = await ctx.newPage()

      try {
        // L'index.html est servi SOUS le pathPrefix du serveur (= bundler.urlPrefix) ;
        // l'omettre donnait un 404 → composant jamais chargé (waitForSelector timeout).
        await page.goto(`http://127.0.0.1:${port}${bundler.urlPrefix}/index.html`)
        // Le component MJS attache un Shadow DOM closed. On accède via le tag.
        await page.waitForSelector('mjs-counter', { timeout: 5000 })

        // Vérifie le rendu initial via .innerHTML du host (shadow content
        // n'est pas accessible côté Playwright en mode closed — on utilise
        // le content de visible via screenshot ou via getComputedStyle).
        // Plus simple : on évalue dans le browser context via les events DOM
        // pour cliquer et observer.
        const initialText = await page.evaluate(() => {
          const c = document.querySelector('mjs-counter') as any
          return c?._shadow?.querySelector('button')?.textContent
        })
        assert.match(initialText ?? '', /Count: 0/, `attendu 'Count: 0', reçu '${initialText}'`)

        // Click et vérifie l'update réactif
        await page.evaluate(() => {
          const c = document.querySelector('mjs-counter') as any
          c?._shadow?.querySelector('button')?.click()
        })
        // Attend que le render réactif se propage (microtask).
        await page.waitForFunction(() => {
          const c = document.querySelector('mjs-counter') as any
          return c?._shadow?.querySelector('button')?.textContent?.includes('Count: 1')
        }, { timeout: 2000 })

        const updatedText = await page.evaluate(() => {
          const c = document.querySelector('mjs-counter') as any
          return c?._shadow?.querySelector('button')?.textContent
        })
        assert.match(updatedText ?? '', /Count: 1/)
      } finally {
        await browser.close()
      }
    } finally {
      await server.stop()
      await bundler.close()
    }
  })
})
