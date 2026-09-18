// store — clés CACHÉES (mjs_store_globals.ts `_storeDeclare(keys, hidden)`).
// Sert à `µlang` (mjs_i18n.ts, clé `__mjsLang`) : la langue est de la CONFIG
// framework, pas de l'état applicatif — l'espace `$$` énumérable reste 100% à
// l'app. Ce fichier verrouille le contrat GÉNÉRIQUE (indépendant de l'i18n) :
// une clé déclarée cachée reste réactive (get/set fonctionnels) mais absente
// de toute énumération (`Object.keys`, spread, `JSON.stringify`, structure
// '*'). Chargement du fichier SOURCE brut (mêmes patron que tests/i18n-
// runtime.test.ts — `src/runtime/**/*.ts` est HORS tsconfig).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STORE = join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts')
const storeSrc = readFileSync(STORE, 'utf-8')

function makeMu() {
  const µ: any = { log() {}, warn() {}, error() {}, state(o: any) { return o } }
  new Function('µ', storeSrc)(µ)
  return µ
}

describe('store — clé CACHÉE (_storeDeclare(keys, hidden))', function () {
  it('accesseur posé, get/set fonctionnels (réactivité intacte)', () => {
    const µ = makeMu()
    µ._storeDeclare(['secret'], true)
    µ.store.secret = 'x'
    assert.equal(µ.store.secret, 'x')
    assert.equal(µ._mjs_storeRaw.secret, 'x')
  })

  it("absente de l'énumération : Object.keys/for…in/spread", () => {
    const µ = makeMu()
    µ._storeDeclare(['visible'])
    µ._storeDeclare(['secret'], true)
    µ.store.visible = 1
    µ.store.secret = 2
    assert.deepEqual(Object.keys(µ.store), ['visible'])
    const spread = { ...µ.store }
    assert.deepEqual(spread, { visible: 1 })
    const forIn: string[] = []
    for (const k in µ.store) { forIn.push(k) }
    assert.deepEqual(forIn, ['visible'])
  })

  it('absente de JSON.stringify(µ.store)', () => {
    const µ = makeMu()
    µ._storeDeclare(['visible'])
    µ._storeDeclare(['secret'], true)
    µ.store.visible = 1
    µ.store.secret = 2
    assert.equal(JSON.stringify(µ.store), '{"visible":1}')
  })

  it("_storeSet sur une clé cachée : notifie la clé (abonnés directs) mais PAS la structure ('*')", () => {
    const µ = makeMu()
    µ._storeDeclare(['secret'], true)
    const compKey: any = { _mjs_invalidate(k: string) { compKey.calls.push(k) }, calls: [] as string[] }
    const compStruct: any = { _mjs_invalidate(k: string) { compStruct.calls.push(k) }, calls: [] as string[] }
    µ._mjs_storeSubscribe(compKey, ['secret'])
    µ._mjs_storeSubscribe(compStruct, ['*'])
    µ._storeSet('secret', 'v1')
    assert.deepEqual(compKey.calls, ['$$secret'], "l'abonné direct à la clé cachée est bien notifié")
    assert.deepEqual(compStruct.calls, [], "l'abonné structurel ('*') n'est PAS notifié pour une clé cachée")
  })

  it('une clé NON cachée continue de notifier la structure (non-régression)', () => {
    const µ = makeMu()
    µ._storeDeclare(['visible'])
    const compStruct: any = { _mjs_invalidate(k: string) { compStruct.calls.push(k) }, calls: [] as string[] }
    µ._mjs_storeSubscribe(compStruct, ['*'])
    µ._storeSet('visible', 'v1')
    assert.deepEqual(compStruct.calls, ['$$*'])
  })

  it("_storeSet auto-déclare une clé ABSENTE en ÉNUMÉRABLE (comportement par défaut, non-régression) — la déclaration cachée doit précéder toute écriture", () => {
    const µ = makeMu()
    µ._storeSet('x', 1) // pas de déclaration préalable → accesseur énumérable par défaut
    assert.deepEqual(Object.keys(µ.store), ['x'])
  })

  it('idempotent : redéclarer une clé déjà cachée ne la rend pas énumérable', () => {
    const µ = makeMu()
    µ._storeDeclare(['secret'], true)
    µ._storeDeclare(['secret'], true)
    assert.deepEqual(Object.keys(µ.store), [])
  })
})
