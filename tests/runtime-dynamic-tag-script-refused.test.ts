// 3 gardes runtime, chacune dans SON fichier source :
//   <@element $tag> / <@module $comp> : refus de la balise `script` choisie par l'ÉTAT
//        (mjs_dynamic.ts, µ._updDynEl/µ._updModule) — sinon le texte des enfants déplacés
//        (souvent une interpolation de donnée) s'exécuterait comme du JS à l'insertion.
//   µ.Store : garde __proto__/constructor/prototype sur les traps `set`/`deleteProperty`
//        (mjs_store.ts) — parité avec µ._storeSet (mjs_store_globals.ts).
//   µschema client : bornes de lecture EXPLICITES dans decode() (mjs_schema.ts) — sinon
//        une trame reçue comme VUE d'un buffer plus grand peut faire lire des octets voisins
//        (str8/str16) ou lever un RangeError brut du DataView (compteur de list).
// Chaque bloc charge SON fichier runtime brut via `new Function` — mêmes patrons que
// tests/socket-game.test.ts (concaténation + `new Function('µ', src)(µ)`, stub µ minimal) et
// tests/runtime-journal.test.ts (happy-dom pour les cas qui touchent le DOM) — aucune résolution
// de module, comme en production (bundler/index.ts::bundleRuntime concatène ces fichiers tels
// quels et les évalue).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
// _updDynEl/_updModule vivent désormais dans mjs_dynamic.ts (DÉTACHÉ de mjs_runes.ts,
// cf. bundler/index.ts scanRuntimeFeatures) — les deux sources sont concaténées, même
// ordre que bundleRuntime() (mjs_runes.ts précède mjs_dynamic.ts en production, sans
// dépendance d'ordre réelle entre elles ici).
const runesSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_runes.ts'), 'utf8')
const dynamicSrc = readFileSync(join(__dirname, '../src/runtime/mjs_dynamic.ts'), 'utf8')
const storeSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_store.ts'), 'utf8')
const schemaSrc  = readFileSync(join(__dirname, '../src/runtime/mjs_schema.ts'), 'utf8')

// ============================================================================
// <@element $tag> / <@module $comp> refusent la balise `script` (mjs_dynamic.ts)
// ============================================================================

function makeRunes(): { µ: any; window: any; document: any; warnCalls: any[][] } {
  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const warnCalls: any[][] = []
  const µ: any = { log() {}, error() {}, warn(...args: any[]) { warnCalls.push(args) } }
  new Function('µ', 'document', runesSrc)(µ, document)
  new Function('µ', 'document', dynamicSrc)(µ, document)
  return { µ, window, document, warnCalls }
}

// `_shadow` factice : un simple conteneur connecté au document (pas un vrai ShadowRoot de
// composant) — `_updDynEl`/`_updModule` n'utilisent que `querySelector`/`replaceWith`, un
// conteneur ordinaire suffit à reproduire le contrat.
function makeShadow(document: any, html: string): any {
  const shadow = document.createElement('div')
  shadow.innerHTML = html
  document.body.appendChild(shadow)
  return shadow
}

describe('<@element>/<@module> refusent la balise script (mjs_runes.ts)', () => {
  describe('µ._updDynEl (<@element $tag>)', () => {
    it("tag 'script' : aucun <script> créé, warn émis", () => {
      const { µ, window, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">window.__pwned = 1</div>')
      const comp: any = { _shadow: shadow }
      window.__pwned = undefined
      µ._updDynEl(comp, '0', 'script')
      assert.equal(!!shadow.querySelector('script'), false, 'aucune balise <script> ne doit apparaître')
      assert.equal(window.__pwned, undefined, 'le texte des enfants ne doit jamais avoir été exécuté')
      assert.equal(warnCalls.length, 1, 'la garde doit avertir une fois')
    })

    it("tag 'SCRIPT ' (casse + espace) : refusé pareil", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">window.__pwned = 1</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'SCRIPT ')
      assert.equal(!!shadow.querySelector('script'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("non-régression : un tag ordinaire ('p') remplace bien le nœud, enfants préservés", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-el="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updDynEl(comp, '0', 'p')
      const p = shadow.querySelector('p')
      assert.equal(!!p, true, 'le <p> doit avoir été créé')
      assert.equal(p.textContent, 'bonjour')
      assert.equal(!!shadow.querySelector('div'), false, "l'ancien <div> a été remplacé")
    })
  })

  describe('µ._updModule (<@module $comp>)', () => {
    it("Comp = 'script' (chaîne) : aucun <script> créé, warn émis", () => {
      const { µ, window, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">window.__pwned = 1</div>')
      const comp: any = { _shadow: shadow }
      window.__pwned = undefined
      µ._updModule(comp, '0', 'script')
      assert.equal(!!shadow.querySelector('script'), false)
      assert.equal(window.__pwned, undefined)
      assert.equal(warnCalls.length, 1)
    })

    it("Comp = 'SCRIPT ' (casse + espace) : refusé pareil", () => {
      const { µ, document, warnCalls } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">window.__pwned = 1</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'SCRIPT ')
      assert.equal(!!shadow.querySelector('script'), false)
      assert.equal(warnCalls.length, 1)
    })

    it("non-régression : un nom de tag ordinaire ('x-widget') monte bien le composant", () => {
      const { µ, document } = makeRunes()
      const shadow = makeShadow(document, '<div mjs-mod="0">bonjour</div>')
      const comp: any = { _shadow: shadow }
      µ._updModule(comp, '0', 'x-widget')
      const widget = shadow.querySelector('x-widget')
      assert.equal(!!widget, true)
      assert.equal(widget.textContent, 'bonjour')
    })
  })
})

// ============================================================================
// µ.Store refuse __proto__/constructor/prototype sur set/deleteProperty (mjs_store.ts)
// ============================================================================

// Dépendances de mjs_store.ts posées ici en stub FIDÈLE (mêmes corps que mjs_init.ts/mjs_runes.ts,
// copiés — pas de DOM requis pour cette classe) plutôt que de charger tout mjs_init.ts (qui, lui,
// touche document/CSSStyleSheet dès son top-level).
function makeStore(): { µ: any; warnCalls: any[][] } {
  const warnCalls: any[][] = []
  const µ: any = {
    log() {}, error() {}, warn(...args: any[]) { warnCalls.push(args) },
    _mjs_rawSet: new Set(),
    _mjs_RAW: Symbol('mjs_raw'),
    _mjs_STRUCT: Symbol('mjs:struct'),
    _mjs_epochs: new WeakMap(),
    activeComponent: null,
  }
  µ._mjs_toRaw = function(o: any) { while (o != null && typeof o === 'object' && o[µ._mjs_RAW]) o = o[µ._mjs_RAW]; return o }
  µ._mjs_bumpEpoch = function(raw: any) { const e = (µ._mjs_epochs.get(raw) || 0) + 1; µ._mjs_epochs.set(raw, e); return e }
  µ._mjs_safeKey = function(k: any) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype' }
  new Function('µ', storeSrc)(µ)
  return { µ, warnCalls }
}

describe('µ.Store refuse __proto__/constructor/prototype (mjs_store.ts)', () => {
  it("s.data.__proto__ = {...} : le PROTOTYPE de l'état ne bouge jamais, warn émis", () => {
    const { µ, warnCalls } = makeStore()
    const s = new µ.Store({ a: 1 })
    ;(s.data as any).__proto__ = { admin: true }
    const raw = µ._mjs_toRaw(s.data)
    assert.equal(Object.getPrototypeOf(raw) === Object.prototype, true, 'le prototype brut doit rester Object.prototype')
    assert.equal((s.data as any).admin, undefined, 'aucune clé polluée ne doit apparaître')
    assert.equal(warnCalls.length, 1, 'la garde doit avertir une fois')
  })

  it('delete s.data.constructor : no-op, warn émis', () => {
    const { µ, warnCalls } = makeStore()
    const s = new µ.Store({ a: 1 })
    delete (s.data as any).constructor
    const raw = µ._mjs_toRaw(s.data)
    assert.equal(raw.constructor === Object, true, 'constructor doit rester intact')
    assert.equal(warnCalls.length, 1)
  })

  it('non-régression : s.data.a = 2 notifie un abonné réactif après une microtâche', async () => {
    const { µ } = makeStore()
    const s = new µ.Store({ a: 1 })
    const comp: any = { calls: [] as string[], _mjs_invalidate(k: string) { comp.calls.push(k) } }
    µ.activeComponent = comp
    void s.data.a   // lecture pendant qu'un composant actif est posé → abonnement
    µ.activeComponent = null
    s.data.a = 2
    await new Promise(r => setTimeout(r, 0))
    assert.equal(comp.calls.length > 0, true, "l'abonné doit avoir été invalidé")
  })

  it('non-régression : delete s.data.a notifie aussi', async () => {
    const { µ } = makeStore()
    const s = new µ.Store({ a: 1 })
    const comp: any = { calls: [] as string[], _mjs_invalidate(k: string) { comp.calls.push(k) } }
    µ.activeComponent = comp
    void s.data.a
    µ.activeComponent = null
    delete (s.data as any).a
    await new Promise(r => setTimeout(r, 0))
    assert.equal(comp.calls.length > 0, true)
  })
})

// ============================================================================
// µschema client borne ses lectures dans decode() (mjs_schema.ts)
// ============================================================================

// `mjschemaDecode`/`mjschemaHashRegistre` etc. sont des fonctions top-level du fichier (pas
// attachées à µ) — on les récupère via un `return` ajouté APRÈS la source (déclarations de
// fonction hissées, résolues quel que soit l'ordre).
function makeSchemaApi(): any {
  const µ: any = { log() {}, error() {}, warn() {} }
  const body = schemaSrc + '\nreturn { mjschemaCreerRegistre: mjschemaCreerRegistre, mjschemaDefSchema: mjschemaDefSchema, mjschemaEncode: mjschemaEncode, mjschemaDecode: mjschemaDecode, mjschemaHashRegistre: mjschemaHashRegistre };'
  return new Function('µ', body)(µ)
}

describe('µschema client borne ses lectures dans decode() (mjs_schema.ts)', () => {
  it('str8 dont la longueur annoncée dépasse la fenêtre : RangeError NOMMÉ, jamais de fuite des octets voisins', () => {
    const api = makeSchemaApi()
    const registre = api.mjschemaCreerRegistre()
    api.mjschemaDefSchema(registre, 'nom', { nom: 'str8' })
    const buf = new ArrayBuffer(32)
    new Uint8Array(buf).fill(0x41)   // 'A' partout — les octets VOISINS d'une fuite
    const dv = new DataView(buf)
    dv.setUint8(4, 0)    // octet id de schéma
    dv.setUint8(5, 20)   // longueur ANNONCÉE 20, bien plus que la fenêtre
    dv.setUint8(6, 'x'.charCodeAt(0))
    dv.setUint8(7, 'y'.charCodeAt(0))
    dv.setUint8(8, 'z'.charCodeAt(0))
    const fenetre = new Uint8Array(buf, 4, 5)   // fenêtre logique de 5 octets seulement
    let err: any = null
    try { api.mjschemaDecode(registre, fenetre) } catch (e) { err = e }
    assert.equal(err instanceof RangeError, true, 'doit lever un RangeError')
    assert.match(String(err && err.message), /^\[µ\.schema\] decode\(\)/)
  })

  it('list(u8) annonçant 300 éléments dans une fenêtre de 4 octets : RangeError NOMMÉ', () => {
    const api = makeSchemaApi()
    const registre = api.mjschemaCreerRegistre()
    api.mjschemaDefSchema(registre, 'liste', { items: { kind: 'list', of: 'u8' } })
    const buf = new ArrayBuffer(4)
    const dv = new DataView(buf)
    dv.setUint8(0, 0)          // octet id de schéma
    dv.setUint16(1, 300, true) // compteur ANNONCÉ 300
    const fenetre = new Uint8Array(buf, 0, 4)
    let err: any = null
    try { api.mjschemaDecode(registre, fenetre) } catch (e) { err = e }
    assert.equal(err instanceof RangeError, true, 'doit lever un RangeError')
    assert.match(String(err && err.message), /^\[µ\.schema\] decode\(\)/)
  })

  it('non-régression : trame correcte décodée à l\'identique, hash de registre stable', () => {
    const api = makeSchemaApi()
    const registreA = api.mjschemaCreerRegistre()
    api.mjschemaDefSchema(registreA, 'nom', { nom: 'str8' })
    const encoded = api.mjschemaEncode(registreA, 'nom', { nom: 'abc' })
    const decoded = api.mjschemaDecode(registreA, encoded)
    assert.equal(decoded.objet.nom, 'abc')

    const registreB = api.mjschemaCreerRegistre()
    api.mjschemaDefSchema(registreB, 'nom', { nom: 'str8' })
    assert.equal(api.mjschemaHashRegistre(registreA), api.mjschemaHashRegistre(registreB), 'même déclaration → même hash')
    assert.match(api.mjschemaHashRegistre(registreA), /^[0-9a-f]{8}$/, 'hash FNV-1a hexadécimal 8 caractères')
  })
})
