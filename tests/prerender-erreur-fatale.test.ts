// Un composant qui LÈVE pendant le prérendu
// ne faisait pas échouer le build : la page partait quand même en « generated » (succès), sur les
// DEUX moteurs — contraire au contrat (« prérendu en échec = code ≠ 0 + fichier périmé
// supprimé »). Un `<@failed>` qui absorbe l'erreur d'un descendant, lui, doit rester un succès.
//
// Moteur `browser` — une `pageerror` (exception non interceptée PAR LA PAGE, ex. le montage
// natif d'un custom element qui lève : `µmount`, throw au niveau racine du <script>) était
// rangée dans `warnings` sans jamais faire rejeter `renderPage()` (render-browser.ts, ancien
// `onPageError`) : corrigé ici, toute `pageerror` fait désormais échouer CE rendu.
//
// Moteur `happy-dom` — un throw au niveau racine du <script> était DÉJÀ correctement fatal
// (exception synchrone non rattrapée, propage hors de `renderToString`) : test de non-régression
// ci-dessous. `µmount`, en revanche, ne s'exécute JAMAIS côté SSR happy-dom — `µ._isServer`
// court-circuite `_mjs_fireMount` (mjs_element.ts:784), contrat déjà documenté et testé ailleurs
// (tests/render-browser.test.ts : « @mount s'exécute POUR DE VRAI, contrairement au SSR happy-dom,
// court-circuité par µ._isServer » ; tests/this-ref-ssr.test.ts) — un throw DANS `µmount` y est
// donc inatteignable, prouvé (transpile direct : `µmount ->` compile en
// `this._mjs_hook('mount', fn)`, jamais invoqué tant que `µ._isServer`). Le cas « crash SANS
// frontière <@failed> » reste néanmoins bien réel et corrigé côté happy-dom : substitué ici par un
// throw dans `µeffect` (qui, lui, tourne bien pendant le SSR, cf. tests/ssr-timer-leak.test.ts)
// — même mécanisme de détection (`_mjs_catchError` sans boundary → overlay `.mjs-fatal-error` dans le
// HTML sérialisé, jamais présent sinon : la classe ne vit que dans `µ._mjs_systemSheet`, jamais
// sérialisée, cf. mjs_init.ts).
//
//   npx mocha tests/prerender-erreur-fatale.test.ts --extension ts --require tsx/esm --exit
//   xvfb-run -a npx mocha tests/prerender-erreur-fatale.test.ts --extension ts --require tsx/esm --exit

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

describe('prerender — un composant qui lève pendant le rendu fait échouer le build', () => {
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, cas « moteur browser » de prerender-erreur-fatale skippés. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('happy-dom : throw au niveau racine du <script> → fatal (non-régression, déjà correct)', async function () {
    this.timeout(30000)
    const root = project('e16-happydom-toplevel')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
throw new Error('boom top-level')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, engine: { prerender: 'happy-dom' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.generated.length, 0, 'rien ne doit être généré')
    assert.equal(report.skipped.length, 1)
    assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
    assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
  })

  it("happy-dom : throw dans µeffect (crash SANS frontière <@failed>) → fatal (substitue µmount, inatteignable en SSR happy-dom)", async function () {
    this.timeout(30000)
    const root = project('e16-happydom-effect')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom effect')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, engine: { prerender: 'happy-dom' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.generated.length, 0, 'AVANT le fix : la page partait quand même en « generated », <mjs-home> réduit au panneau .mjs-fatal-error')
    assert.equal(report.skipped.length, 1)
    assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
    assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
  })

  it("happy-dom : un <@failed> qui absorbe l'erreur d'un descendant reste un succès (non-régression)", async function () {
    this.timeout(30000)
    const root = project('e16-happydom-failed')
    writeFileSync(join(root, 'src', 'child.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom enfant absorbe')
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
      render: { default: 'prerender' as const, engine: { prerender: 'happy-dom' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.skipped.length, 0, 'aucun skip : l\'erreur est absorbée par la frontière')
    assert.equal(report.generated.length, 1, 'la page doit être générée')
    assert.match(readFileSync(report.generated[0].file, 'utf-8'), /Oups !/)
  })

  it('browser : throw dans µmount → fatal', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project('e16-browser-mount')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µmount ->
  throw new Error('boom mount')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, engine: { prerender: 'browser' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.generated.length, 0, 'AVANT le fix : la page partait quand même en « generated » (pageerror rangée dans warnings, jamais fatale)')
    assert.equal(report.skipped.length, 1)
    assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
    assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
  })

  it('browser : throw au niveau racine du <script> → fatal', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project('e16-browser-toplevel')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
throw new Error('boom top-level')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, engine: { prerender: 'browser' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.generated.length, 0, 'AVANT le fix : la page partait quand même en « generated » (pageerror rangée dans warnings, jamais fatale)')
    assert.equal(report.skipped.length, 1)
    assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
    assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
  })

  it('browser : throw dans µeffect (crash SANS frontière <@failed>, sans pageerror) → fatal', async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project('e16-browser-effect')
    writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom effect')
</script>
<h1>ne doit jamais s'afficher intact</h1>
`)
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, engine: { prerender: 'browser' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.generated.length, 0, 'AVANT le fix : <mjs-home> réduit au panneau .mjs-fatal-error écrit quand même comme succès')
    assert.equal(report.skipped.length, 1)
    assert.ok(report.skipped[0].fatal, 'le skip doit être marqué fatal')
    assert.ok(!existsSync(join(report.outDir, 'index.html')), 'aucun fichier ne doit rester')
  })

  it("browser : un <@failed> qui absorbe l'erreur d'un descendant reste un succès (non-régression)", async function () {
    if (!chromiumReady) { this.skip(); return }
    this.timeout(60000)
    const root = project('e16-browser-failed')
    writeFileSync(join(root, 'src', 'child.mjs'), `
<script lang="coffee">
µeffect ->
  throw new Error('boom enfant absorbe')
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
      render: { default: 'prerender' as const, engine: { prerender: 'browser' as const }, routes: { '/': { component: 'mjs-home' } } },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.skipped.length, 0, 'aucun skip : l\'erreur est absorbée par la frontière')
    assert.equal(report.generated.length, 1, 'la page doit être générée')
  })
})
