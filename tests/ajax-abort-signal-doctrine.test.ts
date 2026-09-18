// doctrine d'abandon (AbortController) de
// `_request` (mjs_ajax.ts, bloc `.catch()` du fetch) : lue mais jamais testée avant ce fichier. Un
// abandon PILOTÉ PAR L'APPELANT (options.signal fourni, ex. navigation ujs qui remplace un fetch
// périmé) résout SILENCIEUSEMENT ({body:null, url, aborted:true}) — ni options.error, ni µ.warn,
// ni µ.error ne sont touchés ; seul options.always() tourne quand même. Un abandon par NOTRE
// timeout INTERNE (options.timeout, sans options.signal) normalise l'erreur et la route vers
// options.error — par défaut µ.ajax.error, qui appelle µ.error. Lecture de code confirmée avant
// d'écrire ce test (commentaire du fichier source à ce sujet) : ce test FIGE la doctrine
// existante, il ne corrige rien.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC  = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')

const fakeDocument = { querySelector: () => null }

/** fetch qui ne résout/rejette JAMAIS tout seul : seul l'abandon du signal le fait rejeter (AbortError). */
function fakeFetchAbandonnableSeulement() {
  return (_url: string, opts: any) => new Promise((_mjs_resolve, reject) => {
    opts.signal.addEventListener('abort', () => {
      const err: any = new Error('The operation was aborted')
      err.name = 'AbortError'
      reject(err)
    })
  })
}

function makeMu() {
  const calls: { log: any[][], warn: any[][], error: any[][] } = { log: [], warn: [], error: [] }
  const µ: any = {
    log: (...a: any[]) => calls.log.push(a),
    warn: (...a: any[]) => calls.warn.push(a),
    error: (...a: any[]) => calls.error.push(a),
  }
  return { µ, calls }
}

describe("mjs_ajax — doctrine d'abandon (AbortController) : silencieux SEULEMENT sur signal fourni par l'appelant", function () {

  it("signal FOURNI PAR L'APPELANT : résolution silencieuse, ni options.error ni µ.warn/µ.error, options.always tourne quand même", async function () {
    const { µ, calls } = makeMu()
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetchAbandonnableSeulement(), fakeDocument)

    const controller = new AbortController()
    let alwaysCalled = false
    const promise = µ.ajax.post('/x', {}, undefined, undefined, () => { alwaysCalled = true }, undefined, controller.signal)
    controller.abort()
    const result = await promise

    assert.deepEqual(result, { body: null, url: '/x', aborted: true }, 'résolution silencieuse attendue, pas un rejet')
    assert.equal(alwaysCalled, true, 'options.always() doit tourner MÊME sur ce chemin silencieux')
    assert.deepEqual(calls.log, [], 'µ.log jamais touché : options.success (donc µ.ajax.success) jamais appelé')
    assert.deepEqual(calls.warn, [], 'µ.warn jamais touché sur ce chemin voulu silencieux')
    assert.deepEqual(calls.error, [], "µ.error jamais touché : options.error (donc µ.ajax.error) jamais appelé — c'est la distinction-clé avec le timeout interne ci-dessous")
  })

  it('abandon par NOTRE timeout INTERNE (pas de signal fourni) : erreur normalisée routée vers µ.error (options.error par défaut)', async function () {
    const { µ, calls } = makeMu()
    new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fakeFetchAbandonnableSeulement(), fakeDocument)

    let alwaysCalled = false
    await new Promise<void>((resolve) => {
      µ.ajax.get('/lent', undefined, undefined, () => { alwaysCalled = true; resolve() }, 20)
    })

    assert.equal(alwaysCalled, true)
    assert.equal(calls.error.length, 1, 'µ.error doit être touché exactement une fois (options.error par défaut = µ.ajax.error)')
    assert.match(String(calls.error[0][0]), /expirée après 20ms/, 'message normalisé, pas la AbortError brute du navigateur')
    assert.deepEqual(calls.warn, [], 'la voie timeout passe par µ.error (options.error), jamais par µ.warn — distinct du silence signal-appelant ci-dessus')
  })

})
