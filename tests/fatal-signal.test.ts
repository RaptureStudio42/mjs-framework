// `html.includes('mjs-fatal-error')` (renderToString.ts,
// render-browser.ts) est un test de SOUS-CHAÎNE sur le HTML sérialisé : une page dont la PROSE
// cite littéralement cette classe (documentation du mécanisme lui-même, par exemple) contient la
// sous-chaîne SANS AUCUN crash — faux positif, la page échoue/le prérendu la saute pour rien.
// Correctif : signal STRUCTUREL — `_mjs_catchError` (mjs_element.ts) pose `µ._fatalErrors` SEULEMENT
// quand l'overlay fatal est réellement construit (crash SANS frontière <@failed> pour l'absorber) ;
// `renderToString`/`render-browser` relisent ce compteur, avec un repli `querySelector('.mjs-fatal-
// error')` (élément réel, jamais un test de texte) si le compteur est indisponible.
//
//   npx mocha tests/fatal-signal.test.ts --extension ts --require tsx/esm --exit
//   xvfb-run -a npx mocha tests/fatal-signal.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { prerenderPages } from '../src/server/prerender.js'
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

const ENGINES = ['happy-dom', 'browser'] as const

describe('renderToString/render-browser — signal de crash STRUCTUREL, pas un test de sous-chaîne', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, cas « moteur browser » de fatal-signal skippés. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  for (const engine of ENGINES) {
    it(`${engine} : une PROSE qui cite littéralement « mjs-fatal-error » (aucun crash) → succès`, async function () {
      if (engine === 'browser' && !chromiumReady) { this.skip(); return }
      this.timeout(60000)
      const root = project(`e20-${engine}-prose`)
      writeFileSync(join(root, 'src', 'home.mjs'), `
<h1>documentation</h1>
<p>En cas de crash sans frontière, le panneau porte la classe mjs-fatal-error.</p>
`)
      const config = {
        sourceDir: 'src', outputDir: 'public/out',
        render: { default: 'prerender' as const, engine: { prerender: engine }, routes: { '/': { component: 'mjs-home' } } },
      }
      const report = await prerenderPages(config, root)
      assert.equal(report.skipped.length, 0, `AVANT le fix : sous-chaîne trouvée dans la PROSE → faux skip fatal — ${JSON.stringify(report.skipped)}`)
      assert.equal(report.generated.length, 1, 'la page doit être générée')
      assert.match(readFileSync(report.generated[0].file, 'utf-8'), /mjs-fatal-error/, 'la prose doit survivre telle quelle dans le HTML servi')
    })

    it(`${engine} : un vrai crash SANS frontière <@failed> (µeffect) → échec`, async function () {
      if (engine === 'browser' && !chromiumReady) { this.skip(); return }
      this.timeout(60000)
      const root = project(`e20-${engine}-crash`)
      writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom e20')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
      const config = {
        sourceDir: 'src', outputDir: 'public/out',
        render: { default: 'prerender' as const, engine: { prerender: engine }, routes: { '/': { component: 'mjs-home' } } },
      }
      const report = await prerenderPages(config, root)
      assert.equal(report.generated.length, 0, 'un vrai crash ne doit jamais être généré')
      assert.equal(report.skipped.length, 1)
      assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
      assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
    })

    it(`${engine} : un <@failed> qui absorbe l'erreur d'un descendant reste un succès`, async function () {
      if (engine === 'browser' && !chromiumReady) { this.skip(); return }
      this.timeout(60000)
      const root = project(`e20-${engine}-failed`)
      writeFileSync(join(root, 'src', 'child.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom enfant absorbe e20')
</script>
<p>enfant</p>
`)
      writeFileSync(join(root, 'src', 'home.mjs'), `
<@child>

<@failed err reset>
  <p class="boom">Oups ! {err.message}</p>
</@failed>
`)
      const config = {
        sourceDir: 'src', outputDir: 'public/out',
        render: { default: 'prerender' as const, engine: { prerender: engine }, routes: { '/': { component: 'mjs-home' } } },
      }
      const report = await prerenderPages(config, root)
      assert.equal(report.skipped.length, 0, "aucun skip : l'erreur est absorbée par la frontière")
      assert.equal(report.generated.length, 1, 'la page doit être générée')
      assert.match(readFileSync(report.generated[0].file, 'utf-8'), /Oups !/)
    })
  }
})
