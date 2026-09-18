// Test du runtime µ.store (le store global) : µ.store
// n'est PLUS un Proxy `µ.state`, c'est un objet d'accesseurs PAR CLÉ adossé à
// `µ._mjs_storeRaw` (aliasing NON réactif assumé, dispatch fin par clé, cf.
// mjs_store_globals.ts en-tête). La réactivité fine via le sigil $$ est testée
// séparément (composant compilé) dans vault-sigil.test.ts et
// store-static-dispatch.test.ts. (Fichier source : mjs_store_globals.ts,
// renommé — le « vault »/`&$` a fusionné dans µ.store depuis longtemps.)
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/runtime/mjs_store_globals.ts'), 'utf8')

function makeMu(): any {
  // µ.state minimal — sert encore à µ.nav/µ._mjs_env (INTACTS), pas à µ.store.
  return { state: (i: any) => Object.assign({ _mjs_state: true }, i), warn: () => {} }
}

describe('µ.store — store global', () => {
  it('est un objet d\'accesseurs PAR CLÉ adossé à µ._mjs_storeRaw (statisation, plus de Proxy µ.state)', () => {
    const µ = makeMu()
    new Function('µ', src)(µ)
    assert.ok(µ.store)
    assert.equal(µ.store._mjs_state, undefined) // PAS construit via µ.state
    assert.ok(µ._mjs_storeRaw)
    µ._storeSet('session', { token: 'abc' })    // écriture notifiante (auto-déclare l'accesseur)
    assert.equal(µ.store.session.token, 'abc')
    assert.equal(µ._mjs_storeRaw.session.token, 'abc') // même valeur, cible brute
  })
  it('est un singleton idempotent (un 2e chargement ne le remplace pas)', () => {
    const µ = makeMu()
    new Function('µ', src)(µ)
    µ._storeSet('x', 42)
    const ref = µ.store
    new Function('µ', src)(µ)                  // re-charge le module
    assert.equal(µ.store, ref)                 // même instance
    assert.equal(µ.store.x, 42)                // contenu préservé
  })
  it('n\'expose plus µ.vault (vault retiré, fondu dans µ.store)', () => {
    const µ = makeMu()
    new Function('µ', src)(µ)
    assert.equal(µ.vault, undefined)
  })
})
