// preuve navigateur réel : sur une page qui pose
// un <base href> vers un tiers, fetch() résout une URL relative contre CE <base>, pas contre
// location.href. AVANT le fix, _mjajaxMemeOrigine jugeait « même origine » (résolution via
// location.href) et posait le jeton CSRF — qui partait alors RÉELLEMENT vers le tiers.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

function pageHtml(baseHref: string | null): string {
  const base = baseHref ? `<base href="${baseHref}">` : ''
  return `<!doctype html><html><head><meta charset="utf-8">${base}
<meta name="csrf-token" content="SECRET123">
</head><body>
<script>window.__warn = []; window.µ = { log:function(){}, error:function(){}, warn:function(m){ window.__warn.push(m) } };</script>
<script>${AJAX_SRC}</script>
</body></html>`
}

describe('mjs_ajax navigateur réel — <base href> cross-origin : le jeton CSRF ne suit PAS fetch()', () => {
  let browser: Browser | null = null
  let server: Server | null = null
  let origin = ''

  before(async function () {
    this.timeout(60000)
    browser = await chromium.launch()
    server = createServer((req, res) => {
      const baseHref = req.url === '/avec-base' ? 'http://tiers.example.invalid/' : null
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(pageHtml(baseHref))
    })
    await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
    origin = 'http://127.0.0.1:' + (server!.address() as any).port
  })

  after(async () => {
    if (browser) await browser.close()
    if (server) await new Promise(resolve => server!.close(() => resolve(null)))
  })

  it('<base href="http://tiers.example.invalid/"> : fetch() part bien chez le tiers, sans en-tête X-CSRF-Token', async function () {
    this.timeout(30000)
    const page: Page = await browser!.newPage()
    await page.goto(origin + '/avec-base')

    let capturedUrl: string | null = null
    let capturedCsrf: string | null = null
    let routeHit = false
    await page.route(/tiers\.example\.invalid/, async route => {
      routeHit = true
      capturedUrl = route.request().url()
      capturedCsrf = (await route.request().allHeaders())['x-csrf-token'] ?? null
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })

    await page.evaluate(() => new Promise(resolve => { (window as any).µ.ajax.post('/api/data', { x: 1 }, () => resolve(null), () => resolve(null)) }))

    assert.equal(routeHit, true, 'fetch() doit avoir RÉELLEMENT visé tiers.example.invalid (baseURI, pas location.href)')
    assert.equal(capturedUrl, 'http://tiers.example.invalid/api/data')
    assert.equal(capturedCsrf, null, 'AVANT le fix : X-CSRF-Token partait chez le tiers du <base href>')

    // APRÈS le fix, memeOrigine vaut désormais correctement FAUX : la branche d'avertissement déjà
    // existante (cf. mjs_ajax.ts) se déclenche — AVANT le fix, elle restait
    // muette (memeOrigine valait à tort VRAI), le silence faisait alors PARTIE du symptôme.
    const warnings = await page.evaluate(() => (window as any).__warn)
    assert.equal(warnings.length, 1, 'le jeton omis doit désormais être expliqué par un avertissement')
    assert.match(warnings[0], /jeton CSRF de la page n'est PAS envoyé/)

    await page.close()
  })

  it('contre-épreuve SANS <base> : en-tête X-CSRF-Token présent sur un POST même origine', async function () {
    this.timeout(30000)
    const page: Page = await browser!.newPage()
    await page.goto(origin + '/sans-base')

    let capturedCsrf: string | null = null
    await page.route('**/api/data', async route => {
      capturedCsrf = (await route.request().allHeaders())['x-csrf-token'] ?? null
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' })
    })

    await page.evaluate(() => new Promise(resolve => { (window as any).µ.ajax.post('/api/data', { x: 1 }, () => resolve(null), () => resolve(null)) }))

    assert.equal(capturedCsrf, 'SECRET123', 'sans <base>, le POST relatif vise bien la page elle-même : le jeton doit être présent')
    await page.close()
  })
})
