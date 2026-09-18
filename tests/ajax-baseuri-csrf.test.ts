// `_mjajaxMemeOrigine` (mjs_ajax.ts) résolvait
// une URL relative contre `location.href`, alors que `fetch()` la résout RÉELLEMENT contre
// `document.baseURI` (spec WHATWG « API base URL »). Avec un `<base href>` vers un tiers, la
// fonction répondait « même origine » alors que la requête partait ailleurs — fuite du jeton CSRF.
// Logique pure ici (happy-dom simule fidèlement document.baseURI, sondé avant d'écrire ce test) ;
// la preuve navigateur réel (fetch() intercepté par Playwright) est dans le fichier -browser voisin.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC  = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

/** Fenêtre happy-dom avec un <meta csrf-token> et, si fourni, un <base href> — runtime PAS encore évalué. */
function mount(pageUrl: string, baseHref: string | null) {
  const window: any = new Window({ url: pageUrl })
  const document = window.document
  document.head.innerHTML = (baseHref ? `<base href="${baseHref}">` : '') + '<meta name="csrf-token" content="SECRET123">'
  window.µ = { log() {}, error() {}, warn() {} }
  return window
}

/** Évalue le runtime ajax réel, stubbe fetch, déclenche un POST relatif et rend l'URL + en-têtes vus. */
async function postAndCapture(window: any, requestUrl: string) {
  let seenUrl: string | null = null
  let seenHeaders: any = null
  window.fetch = async (u: string, opts: any) => {
    // un vrai fetch() résout `u` contre document.baseURI AVANT d'émettre la requête (spec « API
    // base URL ») : le stub reproduit CETTE résolution pour observer la destination réelle
    seenUrl = new URL(u, window.document.baseURI).href
    seenHeaders = opts.headers
    return { status: 200, ok: true, url: u, headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null }, json: async () => ({}), text: async () => '{}' }
  }
  window.eval(AJAX_SRC)
  await new Promise<void>((resolve) => { window.µ.ajax.post(requestUrl, {}, () => resolve(), () => resolve()) })
  return { url: seenUrl, headers: seenHeaders }
}

describe('mjs_ajax — _mjajaxMemeOrigine résout comme fetch() (document.baseURI, pas location.href)', function () {

  it('<base href> cross-origin posé : _mjajaxMemeOrigine juge FAUX une URL relative (AVANT le fix : VRAI)', function () {
    const window = mount('http://app.example/page', 'http://tiers.example.invalid/')
    window.eval(AJAX_SRC)
    assert.equal(window.document.baseURI, 'http://tiers.example.invalid/', 'happy-dom simule bien document.baseURI sous <base href>')
    assert.equal(window._mjajaxMemeOrigine('/api/data'), false, 'AVANT le fix : résolue via location.href, jugée « même origine » à tort')
    window.close()
  })

  it('sans <base> : _mjajaxMemeOrigine inchangée, VRAI sur une URL relative (repli sur location.href)', function () {
    const window = mount('http://app.example/page', null)
    window.eval(AJAX_SRC)
    assert.equal(window._mjajaxMemeOrigine('/api/data'), true)
    window.close()
  })

  it('<base href> cross-origin : le jeton CSRF ne part PAS avec la requête (µ.ajax.post complet)', async function () {
    const window = mount('http://app.example/page', 'http://tiers.example.invalid/')
    const { url, headers } = await postAndCapture(window, '/api/data')
    assert.equal(url, 'http://tiers.example.invalid/api/data', 'URL relative résolue contre baseURI, exactement comme fetch() la résoudra')
    assert.equal(headers['X-CSRF-Token'], undefined, 'AVANT le fix : le jeton partait chez le tiers du <base href>')
    window.close()
  })

  it('sans <base> : le jeton CSRF part sur une URL relative même origine (non-régression)', async function () {
    const window = mount('http://app.example/page', null)
    const { url, headers } = await postAndCapture(window, '/api/data')
    assert.equal(url, 'http://app.example/api/data')
    assert.equal(headers['X-CSRF-Token'], 'SECRET123')
    window.close()
  })

})
