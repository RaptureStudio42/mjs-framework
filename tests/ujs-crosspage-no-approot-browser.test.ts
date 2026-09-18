// Régression NAVIGATEUR : clic cross-page depuis une page SANS
// #app-root (cas réel : accueils prérendus SSR) vers une page portant
// un hash de route (`/b#/lecon`) — avant le fix, l'URL changeait mais le
// document restait celui de départ (interception UJS + repli location.href
// muet, cf. ujs-click-crosspage-no-approot.test.ts). Attendu À L'ÉPOQUE :
// navigation COMPLÈTE native (nouveau document). Contre-épreuve : entre deux
// pages À #app-root, le swap SPA reste un swap (même document conservé).
//
// SUPERSÉDÉ (cf.
// ujs-click-crosspage-no-approot.test.ts) : la cascade de montage a d'abord été introduite
// (#app-root → 1er enfant mjs-* → <body>), qui trouve désormais TOUJOURS une
// zone. Une évolution ultérieure va plus loin : la cascade elle-même DISPARAÎT — le chemin HTML
// (réponse d'un serveur qui ne parle pas le protocole de navigation JSON) n'a
// par nature aucun `target` (pas de fiche), le contenant est donc TOUJOURS
// `<body>`, sans recherche d'aucune sorte. La page `/` de ce banc n'a NI
// #app-root NI enfant mjs- (juste un <a> et un <script>) : le clic est
// intercepté et swappé (contenu de <body> remplacé) COMME une page SPA, il n'y
// a plus de repli vers une navigation native pour ce cas. Le 1er test
// ci-dessous, qui figeait l'ANCIEN comportement (nouveau document, contexte JS
// jeté), est réécrit pour figer le NOUVEAU (même document, contexte JS
// conservé) — la page `/c` (dont le seul enfant de <body> porte un id
// `app-root`, sans plus aucun effet sur le mécanisme lui-même désormais)
// continue de prouver un swap SPA classique, avec un résultat OBSERVABLE
// identique (un seul enfant dans <body> des deux côtés).

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { chromium, type Browser } from 'playwright'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
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
    .filter(f => f !== coreFile && f !== 'bundle.js')
    .map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8')))
    .join('\n')
  return `${coreCode}\nglobalThis.µ = µ;\n${comps}`
}

describe('UJS cross-page sans #app-root — le contenant est toujours <body> côté HTML (Playwright)', () => {
  let browser: Browser | null = null
  let server: Server | null = null
  let base = ''

  before(async function () {
    this.timeout(120000)
    browser = await chromium.launch()
    // composant minimal : sert uniquement à produire le bundle core (runtime UJS inclus)
    const root = mjsTmp('ujs-nav')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dummy.mjs'), `
<script lang="coffee">
$n = 0
</script>
<div>ok {$n}</div>
`)
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    await renderer.renderToString('mjs-dummy')
    await renderer.close()
    const bundleScript = readBundleScript(outDir)
    const pages: Record<string, string> = {
      '/': `<!doctype html><html><head><meta charset="utf-8"></head><body><a id="l" href="/b#/lecon">Tutoriel</a><script>${bundleScript}</script></body></html>`,
      '/b': `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="ok">PAGE B</div><script>${bundleScript}</script></body></html>`,
      '/c': `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app-root"><a id="l" href="/d">vers D</a></div><script>${bundleScript}</script></body></html>`,
      '/d': `<!doctype html><html><head><meta charset="utf-8"></head><body><div id="app-root"><div id="ok2">PAGE D</div></div><script>${bundleScript}</script></body></html>`,
    }
    server = createServer((req, res) => {
      const path = (req.url || '/').split('#')[0].split('?')[0]
      const html = pages[path]
      if (!html) { res.writeHead(404); res.end('404'); return }
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

  it("page SANS #app-root ni enfant mjs- → lien /b#/lecon : <body> reçoit le nouveau contenu, swap SPA", async function () {
    this.timeout(60000)
    const page = await browser!.newPage()
    await page.goto(base + '/', { waitUntil: 'networkidle' })
    // marqueur de contexte JS : survit à un swap SPA, jeté par une navigation document
    await page.evaluate(() => { (window as any).__spaMarker = true })
    await page.click('#l')
    // AVANT le fix : timeout ici — l'URL changeait mais le document restait celui de départ.
    // DÉSORMAIS : le contenant est <body> (toujours, sans recherche) → contenu remplacé, #ok apparaît quand même.
    await page.waitForSelector('#ok', { timeout: 10000 })
    const u = new URL(page.url())
    assert.equal(u.pathname + u.hash, '/b#/lecon', "l'URL finale porte bien le chemin ET le hash du lien")
    const marker = await page.evaluate(() => (window as any).__spaMarker === true)
    assert.equal(marker, true, 'la navigation ujs intercepte même sans #app-root — même document, contexte JS CONSERVÉ (plus de navigation native pour ce cas)')
    await page.close()
  })

  it('page AVEC #app-root (sans effet sur le mécanisme, id purement cosmétique ici) → lien /d : interception SPA inchangée (swap, même document)', async function () {
    this.timeout(60000)
    const page = await browser!.newPage()
    await page.goto(base + '/c', { waitUntil: 'networkidle' })
    await page.evaluate(() => { (window as any).__spaMarker = true })
    await page.click('#l')
    await page.waitForSelector('#ok2', { timeout: 10000 })
    assert.equal(new URL(page.url()).pathname, '/d')
    const marker = await page.evaluate(() => (window as any).__spaMarker === true)
    assert.equal(marker, true, 'swap SPA : même document, contexte JS conservé')
    await page.close()
  })
})
