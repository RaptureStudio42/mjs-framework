// Régression — 2 défauts sur `_request`
// (mjs_ajax.ts) :
//
//   1. Aucun timeout/AbortController : un serveur qui ne répond jamais
//      laissait le fetch EN VOL À VIE — `options.always()` (souvent un
//      spinner) ne retombait jamais. Fix : `options.timeout` (ms, optionnel)
//      arme un AbortController ; exposé sur les 5 fonctions publiques
//      (get/delete/post/put/patch) en dernier paramètre positionnel,
//      rétrocompatible (omis → comportement inchangé).
//
//   2. Le `.catch()` de la chaîne fetch attrapait aussi les exceptions LEVÉES
//      PAR LE CALLBACK `success` lui-même (bug de rendu du développeur, sans
//      rapport réseau) et les redirigeait À TORT vers `options.error` — un
//      crash de rendu se maquillait en "échec réseau". Fix : `options.success`
//      est désormais appelé dans un maillon `.then()` SÉPARÉ, chaîné APRÈS le
//      `.catch()` réseau (donc hors de sa portée) — si `success` jette,
//      l'erreur se propage normalement (rejet de la promesse retournée).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

function makeMu() {
  return { log() {}, warn() {}, error() {} }
}
const fakeDocument = { querySelector: () => null }

function makeResponse(opts: { status?: number, url: string, body: any, contentType?: string }) {
  const status = opts.status ?? 200
  return {
    status,
    url: opts.url,
    ok: status >= 200 && status < 300,
    headers: {
      get: (name: string) => {
        if (name === 'content-type') return opts.contentType ?? 'application/json'
        if (name === 'content-length') return typeof opts.body === 'string' ? String(opts.body.length) : '2'
        return null
      },
    },
    json: async () => opts.body,
    text: async () => (typeof opts.body === 'string' ? opts.body : JSON.stringify(opts.body)),
  }
}

describe('mjs_ajax — options.timeout (AbortController)', function () {
  it('aborte une requête qui ne répond jamais et route vers options.error avec un message explicite', async function () {
    const µ: any = makeMu()
    const fakeFetch = (_url: string, opts: any) => new Promise((_mjs_resolve, reject) => {
      opts.signal.addEventListener('abort', () => {
        const err: any = new Error('The operation was aborted')
        err.name = 'AbortError'
        reject(err)
      })
      // sinon ne résout/rejette JAMAIS (simule un serveur muet)
    })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let capturedError: any
    await new Promise<void>((resolve) => {
      µ.ajax.get('https://x/slow', () => {}, (err: any) => { capturedError = err; resolve() }, undefined, 20)
    })

    assert.ok(capturedError, "AVANT le fix : aucun timeout n'existait, la requête pendait à vie")
    assert.match(capturedError.message, /expirée après 20ms/, 'message normalisé, pas la AbortError brute du navigateur')
  })

  it('sans timeout précisé : aucun AbortController armé (comportement par défaut inchangé)', async function () {
    const µ: any = makeMu()
    let sawSignal = false
    const fakeFetch = async (_url: string, opts: any) => {
      sawSignal = opts.signal != null
      return makeResponse({ url: 'https://x/ok', body: { ok: true } })
    }
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    await new Promise<void>((resolve) => { µ.ajax.get('https://x/ok', () => resolve()) })
    assert.equal(sawSignal, false, 'timeout omis : pas de fetchOptions.signal du tout')
  })
})

describe("mjs_ajax — une exception du callback success n'est plus attribuée à une erreur réseau", function () {
  it('success qui lève : la promesse retournée REJETTE avec CETTE erreur, options.error jamais appelé', async function () {
    const µ: any = makeMu()
    const fakeFetch = async () => makeResponse({ url: 'https://x/ok', body: 'body-ok', contentType: 'text/plain' })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let errorCalled = false
    const successThatThrows = () => { throw new Error('bug de rendu du développeur') }
    const promise = µ.ajax.get('https://x/ok', successThatThrows, () => { errorCalled = true })

    await assert.rejects(promise, /bug de rendu du développeur/, "AVANT le fix : cette exception était avalée par le .catch() réseau")
    assert.equal(errorCalled, false, "AVANT le fix : options.error était appelé à tort pour un crash de RENDU, pas réseau")
  })

  it('une erreur HTTP légitime (500) continue de router vers options.error (comportement réseau inchangé)', async function () {
    const µ: any = makeMu()
    const fakeFetch = async () => makeResponse({ status: 500, url: 'https://x/boom', body: { message: 'server exploded' } })
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetch, fakeDocument)

    let capturedError: any
    await new Promise<void>((resolve) => {
      µ.ajax.get('https://x/boom', () => { throw new Error('success ne doit JAMAIS être appelé sur un 500') }, (err: any) => { capturedError = err; resolve() })
    })
    assert.match(capturedError.message, /server exploded/)
  })
})
