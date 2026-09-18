// µ._mjs_ujsConfirmRefire(confirmEl, form, clickTarget, submitter) : quand le porteur
// `mjs-confirm` est un ancêtre form-associated NON-bouton (`<fieldset mjs-confirm>` englobant le
// bouton d'envoi), l'ancien code appelait `target.requestSubmit(confirmEl)` sans validation —
// `confirmEl.form === target` est vrai pour un <fieldset> (form-associated), mais ce n'est PAS un
// bouton de soumission valide : `requestSubmit(fieldset)` lève une TypeError NATIVE, AVANT tout
// dispatch d'événement (comportement spec HTML, PAS un artefact happy-dom — confirmé sur Chromium réel).
// Cette TypeError fuyait hors du
// `.then()` de `µ.confirm()` (pas de `.catch` après `_res.then(fn1, fn2)`) → unhandledrejection
// silencieuse, LE FORMULAIRE N'ÉTAIT JAMAIS SOUMIS malgré l'acceptation utilisateur. Viole le
// contrat documenté docs/06-evenements.md:315 (« le framework rejoue l'action lui-même, à
// l'identique »).
//
// happy-dom NE VALIDE PAS l'argument de requestSubmit (angle mort) :
// Playwright Chromium requis (VRAI code extrait de mjs_ujs.ts, jamais un fake maison).
//
// Serveur HTTP réel (comme tests/ujs-crosspage-no-approot-browser.test.ts) plutôt que
// page.setContent() nu : la page reste sinon sur `about:blank`, dont `new URL('/y', 'about:blank')`
// LÈVE (origine opaque, aucune résolution relative possible) — artefact du harnais, jamais atteint
// avant le fix (le code plantait plus tôt) mais bien réel une fois le fix posé.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { createServer, type Server } from 'node:http'
import { chromium, type Browser } from 'playwright'
import { extractMarkedBody, extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

describe('mjs_ujs — µ._mjs_ujsConfirmRefire (Playwright Chromium) : <fieldset mjs-confirm> englobant le bouton d\'envoi', function () {
  let browser: Browser | null = null
  let server: Server | null = null
  let base = ''

  before(async function () {
    this.timeout(120000)
    browser = await chromium.launch()
    const html = `<!doctype html><html><head><meta charset="utf-8"></head><body>
      <form id="f" action="/x" method="post">
        <fieldset id="fs" mjs-confirm="Sûr ?">
          <button type="submit" id="btn" formaction="/y">go</button>
        </fieldset>
      </form>
    </body></html>`
    server = createServer((req, res) => {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
    })
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', () => resolve()))
    base = 'http://127.0.0.1:' + (server!.address() as any).port
  })

  after(async () => {
    if (browser) { await browser.close() }
    if (server) { await new Promise((resolve) => server!.close(() => resolve(null))) }
  })

  it('acceptation de la confirmation asynchrone : le formulaire est RÉELLEMENT soumis (via le vrai bouton), une seule fois, aucune unhandledrejection', async function () {
    this.timeout(60000)
    const page = await browser!.newPage()
    const pageErrors: string[] = []
    page.on('pageerror', (err) => { pageErrors.push('pageerror: ' + err.message) })
    await page.goto(base + '/', { waitUntil: 'networkidle' })

    const submitBody = extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
    const refireStatement = extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire')

    const result: any = await page.evaluate(({ submitBody, refireStatement }) => {
      return new Promise((resolve) => {
        window.addEventListener('unhandledrejection', (e: any) => {
          (window as any).__unhandled = ((window as any).__unhandled || []).concat([String(e.reason)])
        })
        const warnCalls: string[] = []
        const µ: any = {
          realTarget(e: any) { return e.target },
          warn(...a: any[]) { warnCalls.push(a.join(' ')) },
          error() {},
          log() {},
          confirm() { return Promise.resolve(true) }, // ASYNCHRONE — passe par µ._mjs_ujsConfirmRefire
          _mjs_navNoUjs() { return false },
          _mjs_navDispatch(url: string, method: string) { (window as any).__dispatchCalls = ((window as any).__dispatchCalls || []).concat([method + ' ' + url]) },
        }
        new Function('µ', refireStatement)(µ)
        const handler = new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', submitBody)
        const form = document.getElementById('f') as HTMLFormElement
        const witnessEvents: string[] = []
        form.addEventListener('submit', (e: any) => handler(e, µ, window, document, FormData, URL, DOMParser))
        form.addEventListener('submit', (e: any) => { witnessEvents.push('defaultPrevented=' + e.defaultPrevented + ' submitter=' + (e.submitter && e.submitter.id)) })
        const btn = document.getElementById('btn') as HTMLButtonElement
        btn.click()
        setTimeout(() => {
          resolve({
            dispatchCalls: (window as any).__dispatchCalls || [],
            witnessEvents,
            unhandled: (window as any).__unhandled || [],
            warnCalls,
            fieldsetConfirmAttrAtEnd: document.getElementById('fs')!.getAttribute('mjs-confirm'),
          })
        }, 200)
      })
    }, { submitBody, refireStatement })

    assert.deepEqual(result.unhandled, [], "AVANT le fix : ['TypeError: Failed to execute requestSubmit ... not a submit button'] — jamais une promesse orpheline")
    assert.deepEqual(pageErrors, [], 'aucune pageerror Playwright')
    assert.deepEqual(result.dispatchCalls, ['POST /y'], "AVANT le fix : [] — µ._mjs_navDispatch (donc la soumission, avec le VRAI formaction du bouton) n'était JAMAIS atteint")
    assert.equal(result.witnessEvents.length, 1, "AVANT le fix : 0 — le 2e submit natif (relance) n'avait jamais lieu (exception AVANT tout dispatch, cf. probe2 Chromium)")
    assert.match(result.witnessEvents[0], /submitter=btn/, 'la relance doit utiliser le VRAI bouton (submitter mémorisé), pas le fieldset')
    assert.equal(result.fieldsetConfirmAttrAtEnd, 'Sûr ?', 'mjs-confirm restauré par le finally, comme avant')

    await page.close()
  })
})
