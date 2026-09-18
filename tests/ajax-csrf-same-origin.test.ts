// Régression — `_request` (mjs_ajax.ts) posait l'en-tête
// `X-CSRF-Token` sur TOUTE requête mutante, sans le moindre contrôle de l'origine visée.
// Le chemin ujs (clic de lien, soumission de formulaire, préchargement) filtre bien le
// cross-origin en amont, mais l'API directe — `µ.ajax.post({url: 'https://tiers.example/…'})`
// — ne passait par aucun filtre : le jeton de session de la page partait chez le tiers, qui
// n'a qu'à l'autoriser dans son `Access-Control-Allow-Headers` pour le lire.
//
// Fix : le jeton n'est posé que si l'URL résolue vise l'origine de la page. Sinon il est omis
// et `µ.warn` explique pourquoi : un jeton CSRF n'a de sens que pour l'origine qui l'a émis.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC  = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

const fakeDocument = { querySelector: (sel: string) => sel === 'meta[name="csrf-token"]' ? { getAttribute: () => 'JETON-SECRET' } : null }
const fakeLocation = { origin: 'https://app.example', href: 'https://app.example/panier' }

/** Monte le runtime ajax sur un faux fetch et rend les en-têtes vus par ce fetch. */
async function headersFor(url: string) {
  const warnings: string[] = []
  const µ: any = { log() {}, error() {}, warn: (...a: any[]) => warnings.push(a.join(' ')) }
  let seen: any = null
  const fakeFetch = async (_u: string, opts: any) => {
    seen = opts.headers
    return { status: 200, ok: true, url: _u, headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null }, json: async () => ({}), text: async () => '{}' }
  }
  new Function('µ', 'fetch', 'document', 'location', AJAX_SRC)(µ, fakeFetch, fakeDocument, fakeLocation)
  await new Promise<void>((resolve) => { µ.ajax.post(url, {}, () => resolve(), () => resolve()) })
  return { headers: seen, warnings }
}

describe('mjs_ajax — le jeton CSRF ne sort jamais de son origine', function () {
  it('URL relative : jeton posé (cas courant, inchangé)', async function () {
    const { headers, warnings } = await headersFor('/panier/valider')
    assert.equal(headers['X-CSRF-Token'], 'JETON-SECRET')
    assert.deepEqual(warnings, [], 'aucun avertissement sur le cas normal')
  })

  it('URL absolue de la MÊME origine : jeton posé', async function () {
    const { headers } = await headersFor('https://app.example/panier/valider')
    assert.equal(headers['X-CSRF-Token'], 'JETON-SECRET')
  })

  it('URL cross-origin : jeton OMIS et avertissement explicite', async function () {
    const { headers, warnings } = await headersFor('https://tiers.example/collecte')
    assert.equal(headers['X-CSRF-Token'], undefined, 'AVANT le fix : le jeton partait chez le tiers')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /jeton CSRF de la page n'est PAS envoyé/)
    assert.match(warnings[0], /tiers\.example/, "l'avertissement nomme l'origine visée")
  })

  it('même hôte mais AUTRE port ou AUTRE protocole : origine différente, jeton omis', async function () {
    assert.equal((await headersFor('https://app.example:8443/x')).headers['X-CSRF-Token'], undefined)
    assert.equal((await headersFor('http://app.example/x')).headers['X-CSRF-Token'], undefined)
  })

  it('URL illisible : traitée comme étrangère (en cas de doute, on ne divulgue pas)', async function () {
    const { headers } = await headersFor('http://[pas une url]')
    assert.equal(headers['X-CSRF-Token'], undefined)
  })

})
