// Tests µschema-HTTP — AJAX BINAIRE opt-in (µ.ajax.binary, mjs_ajax.ts).
// MÊME patron que tests/ajax-timeout-and-success-isolation.test.ts (new Function('µ','fetch','document',
// AJAX_SRC)) et tests/socket-schema.test.ts (concaténation de deux fichiers runtime, ordre CANONIQUE
// du bundler : mjs_ajax.ts PUIS mjs_schema.ts, cf. src/bundler/index.ts resolveRuntimeFiles) — le
// registre « côté test » (construit via src/schema/core.ts, VRAI import ESM) et le registre CLIENT
// (µ.schema(...) à travers le sandbox) sont deux implémentations INDÉPENDANTES du même algorithme :
// un test qui passe prouve l'interopérabilité réelle, jamais une relecture d'état interne partagé.
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { creerRegistre, defSchema, encode as coreEncode, hashRegistre, serialiserDefinitions, list, bits } from '../src/schema/core.js'
import type { MjschemaFields } from '../src/schema/core.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AJAX_SRC   = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ajax.ts'), 'utf-8')
const SCHEMA_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_schema.ts'), 'utf-8')
const CLIENT_SRC = AJAX_SRC + '\n' + SCHEMA_SRC

function makeMu(): any {
  return { log() {}, warn() {}, error() {} }
}
const fakeDocument = { querySelector: () => null }

// µ.ajax.binary SEUL (mjs_ajax.ts sans mjs_schema.ts) — sert le test 6, module 'schema' absent.
function makeAjaxOnly(fetchImpl: any): any {
  const µ = makeMu()
  new Function('µ', 'fetch', 'document', AJAX_SRC)(µ, fetchImpl, fakeDocument)
  return µ
}

// µ.ajax.binary + µ.schema (concaténation CANONIQUE) — tous les autres tests.
function makeClient(fetchImpl: any): any {
  const µ = makeMu()
  new Function('µ', 'fetch', 'document', CLIENT_SRC)(µ, fetchImpl, fakeDocument)
  return µ
}

function versionBytes(hash: string): Uint8Array {
  const out = new Uint8Array(8)
  for (let i = 0; i < 8; i++) out[i] = hash.charCodeAt(i)
  return out
}

function trameSchema(hash: string, charge: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + charge.byteLength)
  out.set(versionBytes(hash), 0)
  out.set(charge, 8)
  return out
}

function arrayBufferResponse(bytes: Uint8Array, opts: { status?: number, url?: string } = {}) {
  const status = opts.status ?? 200
  return {
    status,
    ok: status >= 200 && status < 300,
    url: opts.url ?? 'https://x/api',
    headers: { get: () => null },
    arrayBuffer: async () => bytes.slice().buffer,
  }
}

describe('µ.ajax.binary — µschema-HTTP', function () {
  it('1. POST avec schema : corps envoyé en binaire, 8 premiers octets = hash du registre client, reste = trame µschema valide', async function () {
    const registre = creerRegistre()
    defSchema(registre, 'pos', { x: 'i16', y: 'i16' })

    let capturedBody: Uint8Array | undefined
    let capturedContentType: string | undefined
    const fakeFetch = async (_url: string, opts: any) => {
      capturedBody = opts.body
      capturedContentType = opts.headers['Content-Type']
      return arrayBufferResponse(new Uint8Array(0), { status: 204 })
    }
    const µ = makeClient(fakeFetch)
    µ.schema('pos', { x: 'i16', y: 'i16' })

    await new Promise<void>((resolve) => {
      µ.ajax.binary('https://x/pos', { schema: 'pos', data: { x: 12, y: -7 }, success: () => resolve() })
    })

    assert.ok(capturedBody instanceof Uint8Array, 'le corps doit être un Uint8Array, jamais une string JSON')
    assert.equal(capturedContentType, 'application/octet-stream')
    const versionRecue = Buffer.from(capturedBody!.slice(0, 8)).toString('ascii')
    assert.equal(versionRecue, hashRegistre(registre), 'les 8 premiers octets = hash FNV-1a du registre client, en ASCII')
    assert.equal(capturedBody![8], 0, "l'octet 9 = id du schéma 'pos' (0, premier déclaré)")
  })

  it("2. GET avec schema : réponse binaire valide → success reçoit l'objet décodé, UN SEUL appel fetch (pas de rafraîchissement)", async function () {
    const registre = creerRegistre()
    defSchema(registre, 'etat', { hp: 'u8', pseudo: 'str8' })
    const hash   = hashRegistre(registre)
    const charge = coreEncode(registre, 'etat', { hp: 42, pseudo: 'Zora' })
    const trame  = trameSchema(hash, charge)

    let fetchCount = 0
    const fakeFetch = async () => { fetchCount++; return arrayBufferResponse(trame) }
    const µ = makeClient(fakeFetch)
    µ.schema('etat', { hp: 'u8', pseudo: 'str8' })

    const resultat: any = await new Promise((resolve) => {
      µ.ajax.binary('https://x/etat', { schema: 'etat', success: (body: any) => resolve(body) })
    })

    assert.deepEqual(resultat, { hp: 42, pseudo: 'Zora' })
    assert.equal(fetchCount, 1)
  })

  it('3. désaccord de version : un GET du schéma est déclenché en arrière-plan, PUIS la réponse déjà reçue est re-décodée avec succès', async function () {
    const registreV2 = creerRegistre()
    defSchema(registreV2, 'pos', { x: 'i16', y: 'i16' })
    defSchema(registreV2, 'etat', { hp: 'u8' })   // schéma AJOUTÉ côté serveur — hash différent, id 'pos' inchangé
    const hashV2 = hashRegistre(registreV2)
    const trame  = trameSchema(hashV2, coreEncode(registreV2, 'pos', { x: 3, y: 9 }))

    const appels: string[] = []
    const fakeFetch = async (url: string) => {
      appels.push(url)
      if (url.indexOf('schema=1') !== -1) {
        return { status: 200, ok: true, url, headers: { get: () => 'application/json' }, json: async () => serialiserDefinitions(registreV2) }
      }
      return arrayBufferResponse(trame, { url })
    }
    const µ = makeClient(fakeFetch)
    µ.schema('pos', { x: 'i16', y: 'i16' })   // registre CLIENT en retard sur le serveur (ne connaît pas 'etat')

    const resultat: any = await new Promise((resolve) => {
      µ.ajax.binary('https://x/pos', { schema: 'pos', success: (body: any) => resolve(body) })
    })

    assert.deepEqual(resultat, { x: 3, y: 9 })
    assert.equal(appels.length, 2, 'main + rafraîchissement schéma')
    assert.ok(appels[0].indexOf('schema=') === -1, 'le 1er appel est la requête ORIGINALE')
    assert.ok(appels[1].indexOf('schema=1') !== -1, 'le 2e appel est le GET schéma (convention par défaut : ?schema=1)')
  })

  it('4. après rafraîchissement, µ._mjs_mjschemaRegistre est mis à jour EN PLACE : un appel SUIVANT à la même version ne redéclenche pas de GET schéma', async function () {
    const registreV2 = creerRegistre()
    defSchema(registreV2, 'pos', { x: 'i16', y: 'i16' })
    defSchema(registreV2, 'etat', { hp: 'u8' })
    const hashV2 = hashRegistre(registreV2)
    const trame  = trameSchema(hashV2, coreEncode(registreV2, 'pos', { x: 1, y: 2 }))

    let appelsSchema = 0
    const fakeFetch = async (url: string) => {
      if (url.indexOf('schema=1') !== -1) {
        appelsSchema++
        return { status: 200, ok: true, url, headers: { get: () => 'application/json' }, json: async () => serialiserDefinitions(registreV2) }
      }
      return arrayBufferResponse(trame, { url })
    }
    const µ = makeClient(fakeFetch)
    µ.schema('pos', { x: 'i16', y: 'i16' })

    await new Promise<void>((resolve) => { µ.ajax.binary('https://x/pos', { schema: 'pos', success: () => resolve() }) })
    assert.equal(appelsSchema, 1, 'premier appel : désaccord → un rafraîchissement')

    await new Promise<void>((resolve) => { µ.ajax.binary('https://x/pos', { schema: 'pos', success: () => resolve() }) })
    assert.equal(appelsSchema, 1, 'second appel : registre déjà à jour → AUCUN rafraîchissement supplémentaire')
  })

  it('5. sans option schema : µ.ajax.post envoie toujours du JSON (non-régression, byte-identique)', async function () {
    let capturedBody: any, capturedContentType: any
    const fakeFetch = async (_url: string, opts: any) => {
      capturedBody = opts.body
      capturedContentType = opts.headers['Content-Type']
      return { status: 200, ok: true, url: 'https://x/api', headers: { get: (n: string) => n === 'content-type' ? 'application/json' : null }, json: async () => ({ ok: true }) }
    }
    const µ = makeClient(fakeFetch)
    await new Promise<void>((resolve) => { µ.ajax.post('https://x/api', { a: 1 }, () => resolve()) })

    assert.equal(capturedContentType, 'application/json')
    assert.equal(capturedBody, JSON.stringify({ a: 1 }))
  })

  it("6. module 'schema' absent : µ.ajax.binary route une erreur claire vers options.error, ZÉRO appel réseau (fail fast)", async function () {
    let fetchCalled = false
    const fakeFetch = async () => { fetchCalled = true; return arrayBufferResponse(new Uint8Array(0)) }
    const µ = makeAjaxOnly(fakeFetch)   // mjs_ajax.ts SEUL, mjs_schema.ts non chargé

    let capturedError: any
    await new Promise<void>((resolve) => {
      µ.ajax.binary('https://x/pos', { schema: 'pos', data: { x: 1 }, error: (err: any) => { capturedError = err; resolve() } })
    })

    assert.ok(capturedError)
    assert.match(capturedError.message, /module runtime 'schema'/)
    assert.equal(fetchCalled, false, "fail fast : aucune requête réseau n'a dû partir")
  })

  it("7. options.codec : un registre EXPLICITE (construit via src/schema/core.ts) est utilisé, sans toucher au singleton global µ._mjs_mjschemaRegistre", async function () {
    const registre = creerRegistre()
    defSchema(registre, 'prive', { n: 'u16' })
    const hash  = hashRegistre(registre)
    const trame = trameSchema(hash, coreEncode(registre, 'prive', { n: 777 }))

    const fakeFetch = async () => arrayBufferResponse(trame)
    const µ = makeClient(fakeFetch)
    µ.schema('autreChose', { z: 'u8' })   // registre GLOBAL volontairement DIFFÉRENT (ne connaît pas 'prive')

    const resultat: any = await new Promise((resolve) => {
      µ.ajax.binary('https://x/prive', { schema: 'prive', codec: registre, success: (body: any) => resolve(body) })
    })

    assert.deepEqual(resultat, { n: 777 })
    assert.ok(!µ._mjs_mjschemaRegistre.parNom.has('prive'), 'le singleton global ne doit pas avoir été modifié par options.codec')
  })

  it('8. aller-retour de plusieurs types de champs (u8, i16, str8, bool, list, bits)', async function () {
    const champs: MjschemaFields = { id: 'u8', score: 'i16', pseudo: 'str8', actif: 'bool', tags: list('u8'), drapeaux: bits(['vip', 'banni']) }
    const registre = creerRegistre()
    defSchema(registre, 'fiche', champs)
    const hash   = hashRegistre(registre)
    const valeur = { id: 9, score: -321, pseudo: 'Rin', actif: true, tags: [1, 2, 3], drapeaux: { vip: true, banni: false } }
    const trame  = trameSchema(hash, coreEncode(registre, 'fiche', valeur))

    const fakeFetch = async () => arrayBufferResponse(trame)
    const µ = makeClient(fakeFetch)
    µ.schema('fiche', champs)

    const resultat: any = await new Promise((resolve) => {
      µ.ajax.binary('https://x/fiche', { schema: 'fiche', success: (body: any) => resolve(body) })
    })

    assert.deepEqual(resultat, valeur)
  })
})
