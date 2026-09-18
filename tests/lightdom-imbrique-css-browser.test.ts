// render-browser (Chromium réel) : le <style> du sous-composant `mjs-light`
// IMBRIQUÉ doit s'appliquer VRAIMENT (getComputedStyle) une fois monté DANS le vrai shadow de
// son ancêtre — un <style> injecté dans `document.head` (repli historique de la RACINE light) ne
// traverse JAMAIS cette frontière (encapsulation Shadow DOM), cf. mjs_element.ts (`_mjs_applyLayout`).
// Deux scénarios : (A) SSR + hydratation (bundle chargé par-dessus le HTML serveur, modèle
// probeC) ; (B) montage CLIENT PUR, sans aucun SSR (bundle seul, balise vide dans la page).
//
// Garde de disponibilité — même motif que tests/render-browser.test.ts : Chromium absent →
// skip propre.
//
//   xvfb-run -a npx mocha tests/lightdom-imbrique-css-browser.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

function readBundleScript(outputDir: string): string {
  const files = readdirSync(outputDir).filter(f => f.endsWith('.js'))
  const coreFile = files.find(f => /^mjs_core-/.test(f))!
  const coreCode = stripEsm(readFileSync(join(outputDir, coreFile), 'utf-8'))
  const comps = files
    .filter(f => f !== coreFile && f !== 'bundle.js')
    .map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8')))
    .join('\n')
  return `${coreCode}\nglobalThis.µ = µ;\n${comps}`
}

// fixture PARTAGÉE : leaf (shadow normal, seagreen) sous midlight (mjs-light, fond gold) sous
// outer (shadow normal, racine).
function writeFixture(srcDir: string): void {
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'leaf.mjs'), `
<p class="leaf">LEAF-SOUS-LIGHTDOM</p>
<style>
  .leaf
    color: seagreen
</style>
`)
  writeFileSync(join(srcDir, 'midlight.mjs'), `
<div class="mid-wrap">
  <p class="mid-marker">MID-LIGHTDOM-TEXTE</p>
  <@leaf>
</div>
<style>
  .mid-wrap
    background: gold
</style>
`)
  writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="outer-wrap">
  <p class="outer-marker">OUTER-TEXTE</p>
  <@midlight mjs-light>
</div>
`)
}

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

describe('render-browser (Chromium réel) — CSS du sous-composant mjs-light imbriqué', function () {
  this.timeout(60000)
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, tests lightdom-imbrique-css navigateur skippés. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('SSR + hydratation : après montage, la règle du sous-composant light imbriqué EST APPLIQUÉE (fond gold), sans doublon', async function () {
    if (!chromiumReady) { this.skip(); return }
    const { chromium } = await import('playwright')
    const root = mjsTmp('lightdom-browser-hydrate')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    writeFixture(srcDir)

    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html } = await renderer.renderToString('mjs-outer')
    await renderer.close()

    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>${html}<script>${bundleScript}</script></body></html>`

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(pageHtml, { waitUntil: 'networkidle' })
      await page.waitForTimeout(200)
      const result = await page.evaluate(() => {
        const outerEl: any = document.querySelector('mjs-outer')
        const outerSR = outerEl && outerEl.shadowRoot
        const midEl: any = outerSR ? outerSR.querySelector('mjs-midlight') : null
        const midWrap: any = midEl ? midEl.querySelector('.mid-wrap') : null
        return {
          midFound: !!midEl,
          midHasShadowRoot: !!(midEl && midEl.shadowRoot),
          midBg: midWrap ? getComputedStyle(midWrap).backgroundColor : null,
          nbLeaf: outerSR ? outerSR.querySelectorAll('mjs-leaf').length : 0,
          nbMidWrap: outerSR ? outerSR.querySelectorAll('.mid-wrap').length : 0,
        }
      })
      assert.ok(result.midFound, 'le sous-composant midlight doit être trouvé dans le shadow réel de outer')
      assert.equal(result.midHasShadowRoot, false, 'midlight reste light DOM (aucun shadowRoot exposé)')
      assert.equal(result.midBg, 'rgb(255, 215, 0)', `.mid-wrap{background:gold} doit être APPLIQUÉE (getComputedStyle) — reçu : ${result.midBg}`)
      assert.equal(result.nbLeaf, 1, 'un seul mjs-leaf (pas de doublon de contenu après hydratation)')
      assert.equal(result.nbMidWrap, 1, 'un seul .mid-wrap (pas de doublon de contenu après hydratation)')
    } finally {
      await browser.close().catch(() => {})
    }
  })

  it('montage CLIENT PUR (sans SSR) : le sous-composant light imbriqué reçoit aussi sa feuille (fond gold)', async function () {
    if (!chromiumReady) { this.skip(); return }
    const { chromium } = await import('playwright')
    const root = mjsTmp('lightdom-browser-csr')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    writeFixture(srcDir)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><mjs-outer></mjs-outer><script>${bundleScript}</script></body></html>`

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(pageHtml, { waitUntil: 'networkidle' })
      await page.waitForTimeout(200)
      const result = await page.evaluate(() => {
        const outerEl: any = document.querySelector('mjs-outer')
        // montage client pur (sans SSR/DSD préexistant) : le repli constructeur attache un shadow
        // FERMÉ (`attachShadow({mode:'closed'})`) — `.shadowRoot` (public) rend TOUJOURS null par
        // spec pour un shadow closed ; `._shadow` (interne) reste la seule voie, ici pour le TEST.
        const outerSR = outerEl && outerEl._shadow
        const midEl: any = outerSR ? outerSR.querySelector('mjs-midlight') : null
        const midWrap: any = midEl ? midEl.querySelector('.mid-wrap') : null
        return {
          midFound: !!midEl,
          midHasShadowRoot: !!(midEl && midEl.shadowRoot),
          midBg: midWrap ? getComputedStyle(midWrap).backgroundColor : null,
        }
      })
      assert.ok(result.midFound, 'le sous-composant midlight doit être trouvé (montage client pur, sans SSR)')
      assert.equal(result.midHasShadowRoot, false, 'midlight reste light DOM (aucun shadowRoot exposé)')
      assert.equal(result.midBg, 'rgb(255, 215, 0)', `montage client pur : la règle doit être APPLIQUÉE — reçu : ${result.midBg}`)
    } finally {
      await browser.close().catch(() => {})
    }
  })
})
