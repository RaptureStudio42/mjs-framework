// Test NEUF — pont UJS @confirm SAUTÉ dans un composant IMBRIQUÉ à
// 2 niveaux de Shadow DOM fermé : <mjs-outer> (shadow fermé) contient <mjs-inner>
// (shadow fermé lui aussi), qui porte le bouton @confirm. Symptôme prouvé au
// navigateur (Chromium ET Firefox, page /accueil réelle : <mjs-landing-next> contient
// <mjs-showcase-dialog>) : le clic supprime SANS AUCUNE confirmation, µ.confirm n'est
// jamais appelé (0 appel mesuré).
//
// Cause (mjs_ujs.ts, µ._mjs_ujsOnClick, gate @confirm) : le pont posé en CAPTURE sur
// CHAQUE shadow root (µ._mjs_ujsShadowAttach) fait tourner celui du composant EXTERNE
// AVANT celui de l'INTERNE. Depuis l'externe, `e.composedPath()[0]` est TRONQUÉ par
// le navigateur à l'hôte <mjs-inner> (nœuds d'un shadow fermé invisibles depuis
// l'extérieur) : `closest('[mjs-confirm]')` ne trouve rien — MAIS (AVANT le fix)
// `e._mjs_mjsConfirmGated = true` était posé quand même. Quand le pont INTERNE (seul à
// voir le vrai bouton) s'exécute ensuite, la garde est déjà (à tort) fermée : le
// handler @click tourne SANS confirmation.
//
// happy-dom NE reproduit PAS ce bogue : son composedPath() n'est pas tronqué depuis
// un shadow externe (vérifié) — vrai navigateur requis (Playwright Chromium). Aucun
// opt-in : même politique d'activation que le modèle
// tests/ujs-crosspage-no-approot-browser.test.ts (tourne sans MJS_PLAYWRIGHT).

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

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
    .filter(f => f !== coreFile)
    .map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8')))
    .join('\n')
  return `${coreCode}\nglobalThis.µ = µ;\n${comps}`
}

describe('mjs_ujs — pont shadow fermé IMBRIQUÉ (2 niveaux) : @confirm ne doit pas être sauté', () => {
  let browser: Browser | null = null
  let server: Server | null = null
  let base = ''

  before(async function () {
    this.timeout(120000)
    browser = await chromium.launch()

    const root = mjsTmp('ujs-shadow-confirm-nested')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // composant EXTERNE : sans script, contient juste le composant interne
    writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="wrap"><mjs-inner></mjs-inner></div>
`)
    // composant INTERNE : porte le bouton @confirm (le compilateur pose mjs-confirm)
    writeFileSync(join(srcDir, 'inner.mjs'), `
<script>
$n = 3
remove = -> $n--
</script>
<p id="cnt">{$n}</p>
<button @confirm="Vraiment ?" @click={remove()}>x</button>
`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const bundleScript = readBundleScript(outDir)
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body><mjs-outer></mjs-outer><script>${bundleScript}</script></body></html>`
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    base = 'http://127.0.0.1:' + (server!.address() as any).port
  })

  after(async () => {
    if (browser) await browser.close()
    if (server) await new Promise(resolve => server!.close(() => resolve(null)))
    await terminateSharedWorkerPool()
  })

  // navigue + attend que les DEUX niveaux de shadow (outer puis inner) soient montés
  async function readyPage(): Promise<Page> {
    const page = await browser!.newPage()
    await page.goto(base + '/', { waitUntil: 'networkidle' })
    await page.waitForFunction(() => {
      const outer: any = document.querySelector('mjs-outer')
      const inner = outer?._shadow?.querySelector('mjs-inner')
      return !!inner?._shadow?.querySelector('button')
    }, { timeout: 10000 })
    return page
  }

  it('refus depuis le bouton du composant IMBRIQUÉ : confirm demandé UNE fois, remove() jamais appelé', async function () {
    this.timeout(60000)
    const page = await readyPage()
    await page.evaluate(() => {
      const mu: any = (window as any).µ
      mu.config.confirm = false
      ;(window as any).__confirmCalls = 0
      window.confirm = () => { (window as any).__confirmCalls = (window as any).__confirmCalls + 1; return false }
    })
    await page.evaluate(() => {
      const outer: any = document.querySelector('mjs-outer')
      outer._shadow.querySelector('mjs-inner')._shadow.querySelector('button').click()
    })
    await page.waitForTimeout(150)
    const calls = await page.evaluate(() => (window as any).__confirmCalls)
    const cnt = await page.evaluate(() => {
      const outer: any = document.querySelector('mjs-outer')
      return outer._shadow.querySelector('mjs-inner')._shadow.querySelector('#cnt').textContent
    })
    assert.equal(calls, 1, `window.confirm doit être demandé EXACTEMENT 1 fois (obtenu ${calls}) — AVANT le fix : 0 (garde sautée par le pont externe)`)
    assert.equal(cnt, '3', "refus : remove() ne doit PAS avoir tourné — AVANT le fix : passait à '2' SANS aucune popup")
    await page.close()
  })

  it('accord depuis le bouton du composant IMBRIQUÉ : confirm demandé UNE fois, remove() exécuté UNE seule fois', async function () {
    this.timeout(60000)
    const page = await readyPage()
    await page.evaluate(() => {
      const mu: any = (window as any).µ
      mu.config.confirm = false
      ;(window as any).__confirmCalls = 0
      window.confirm = () => { (window as any).__confirmCalls = (window as any).__confirmCalls + 1; return true }
    })
    await page.evaluate(() => {
      const outer: any = document.querySelector('mjs-outer')
      outer._shadow.querySelector('mjs-inner')._shadow.querySelector('button').click()
    })
    await page.waitForTimeout(150)
    const calls = await page.evaluate(() => (window as any).__confirmCalls)
    const cnt = await page.evaluate(() => {
      const outer: any = document.querySelector('mjs-outer')
      return outer._shadow.querySelector('mjs-inner')._shadow.querySelector('#cnt').textContent
    })
    assert.equal(calls, 1, `window.confirm doit être demandé EXACTEMENT 1 fois (obtenu ${calls})`)
    assert.equal(cnt, '2', "accord : remove() doit avoir tourné UNE SEULE fois : 3 → 2")
    await page.close()
  })
})
