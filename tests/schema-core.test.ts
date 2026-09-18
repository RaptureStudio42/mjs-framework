// Tests unitaires PURS de src/schema/core.ts (µschema) — aucun réseau, aucun MJS-WS :
// aller-retour encode/decode par type, limites, UTF-8 accentué, list/bits, hash stable/désaccord,
// garde AJOUT-SEUL, type inconnu + suggestion, voyage sérialiser/charger.
import assert from 'node:assert/strict'
import {
  creerRegistre, defSchema, encode, decode, hashRegistre, serialiserDefinitions, chargerDefinitions, list, bits, aSchema,
} from '../src/schema/core.js'
import type { MjschemaRegistre } from '../src/schema/core.js'

describe('schema/core — µschema (registre pur, aucune API node/navigateur)', () => {
  it('1. aller-retour de chaque type scalaire (u8/i8/u16/i16/u32/i32/f32/f64/bool/str8/str16)', () => {
    const r = creerRegistre()
    defSchema(r, 'tout', { a: 'u8', b: 'i8', c: 'u16', d: 'i16', e: 'u32', f: 'i32', g: 'f32', h: 'f64', i: 'bool', j: 'str8', k: 'str16' })
    const objet = { a: 200, b: -100, c: 60000, d: -30000, e: 4000000000, f: -2000000000, g: 3.5, h: 3.14159265358979, i: true, j: 'salut', k: 'monde' }
    const bytes = encode(r, 'tout', objet)
    assert.ok(bytes instanceof Uint8Array)
    const { nom, objet: out } = decode(r, bytes)
    assert.equal(nom, 'tout')
    assert.equal(out.a, 200)
    assert.equal(out.b, -100)
    assert.equal(out.c, 60000)
    assert.equal(out.d, -30000)
    assert.equal(out.e, 4000000000)
    assert.equal(out.f, -2000000000)
    assert.ok(Math.abs((out.g as number) - 3.5) < 1e-6)
    assert.ok(Math.abs((out.h as number) - 3.14159265358979) < 1e-12)
    assert.equal(out.i, true)
    assert.equal(out.j, 'salut')
    assert.equal(out.k, 'monde')
  })

  it('2. limites u8/i16/u16 — bornes min/max exactes préservées', () => {
    const r = creerRegistre()
    defSchema(r, 'bornes', { u8min: 'u8', u8max: 'u8', i16min: 'i16', i16max: 'i16', u16max: 'u16' })
    const { objet: out } = decode(r, encode(r, 'bornes', { u8min: 0, u8max: 255, i16min: -32768, i16max: 32767, u16max: 65535 }))
    assert.equal(out.u8min, 0)
    assert.equal(out.u8max, 255)
    assert.equal(out.i16min, -32768)
    assert.equal(out.i16max, 32767)
    assert.equal(out.u16max, 65535)
  })

  it('3. chaînes UTF-8 accentuées (str8 ET str16) — octets ≠ longueur JS, round-trip exact', () => {
    const r = creerRegistre()
    defSchema(r, 'texte', { court: 'str8', long: 'str16' })
    const accents = 'éàçùî€ — testé ô combien'
    const { objet: out } = decode(r, encode(r, 'texte', { court: accents, long: accents.repeat(5) }))
    assert.equal(out.court, accents)
    assert.equal(out.long, accents.repeat(5))
  })

  it('4. list(u16) et list(str8) — tableaux homogènes, compteur u16, vide ET peuplé', () => {
    const r = creerRegistre()
    defSchema(r, 'listes', { nombres: list('u16'), noms: list('str8') })
    const { objet: outVide } = decode(r, encode(r, 'listes', { nombres: [], noms: [] }))
    assert.deepEqual(outVide.nombres, [])
    assert.deepEqual(outVide.noms, [])
    const { objet: out } = decode(r, encode(r, 'listes', { nombres: [1, 2, 3, 65535], noms: ['Zora', 'Elfe', 'Nain'] }))
    assert.deepEqual(out.nombres, [1, 2, 3, 65535])
    assert.deepEqual(out.noms, ['Zora', 'Elfe', 'Nain'])
  })

  it('5. bits([noms]) — jusqu\'à 8 booléens tassés dans 1 octet, sous-objet en sortie', () => {
    const r = creerRegistre()
    defSchema(r, 'drapeaux', { f: bits(['vivant', 'arme', 'vip', 'furtif']) })
    const bytes = encode(r, 'drapeaux', { f: { vivant: true, arme: false, vip: true, furtif: false } })
    assert.equal(bytes.byteLength, 2)   // 1 octet id + 1 octet bits
    const { objet: out } = decode(r, bytes)
    assert.deepEqual(out.f, { vivant: true, arme: false, vip: true, furtif: false })
  })

  it('6. ids u8 attribués dans l\'ordre de déclaration (0, 1, 2…)', () => {
    const r = creerRegistre()
    const a = defSchema(r, 'a', { x: 'u8' })
    const b = defSchema(r, 'b', { x: 'u8' })
    const c = defSchema(r, 'c', { x: 'u8' })
    assert.equal(a.id, 0)
    assert.equal(b.id, 1)
    assert.equal(c.id, 2)
    assert.equal(encode(r, 'b', { x: 1 })[0], 1)
  })

  it('7. hashRegistre STABLE (même déclarations, même hash) et change sur tout désaccord (nom/type/ordre)', () => {
    const build = (): MjschemaRegistre => {
      const r = creerRegistre()
      defSchema(r, 'pos', { x: 'i16', y: 'i16' })
      defSchema(r, 'chat', { texte: 'str16' })
      return r
    }
    const h1 = hashRegistre(build())
    const h2 = hashRegistre(build())
    assert.equal(h1, h2, 'deux registres construits pareil → même hash')

    const rTypeDiffere = creerRegistre()
    defSchema(rTypeDiffere, 'pos', { x: 'i32', y: 'i16' })
    defSchema(rTypeDiffere, 'chat', { texte: 'str16' })
    assert.notEqual(hashRegistre(rTypeDiffere), h1, 'un type de champ différent change le hash')

    const rOrdreDiffere = creerRegistre()
    defSchema(rOrdreDiffere, 'pos', { y: 'i16', x: 'i16' })
    defSchema(rOrdreDiffere, 'chat', { texte: 'str16' })
    assert.notEqual(hashRegistre(rOrdreDiffere), h1, 'un ordre de champ différent change le hash')
  })

  it('8. garde AJOUT-SEUL — re-déclarer à l\'identique = no-op (même id) ; forme différente = throw clair', () => {
    const r = creerRegistre()
    const premiere = defSchema(r, 'joueur', { x: 'i16', y: 'i16' })
    const seconde = defSchema(r, 'joueur', { x: 'i16', y: 'i16' })
    assert.equal(seconde.id, premiere.id, 'ré-affirmation identique — id inchangé, no-op')

    assert.throws(() => defSchema(r, 'joueur', { x: 'i16', y: 'i16', z: 'i16' }), /forme différente/)
    assert.throws(() => defSchema(r, 'joueur', { x: 'i32', y: 'i16' }), /forme différente/)
    assert.throws(() => defSchema(r, 'joueur', { y: 'i16', x: 'i16' }), /forme différente/, 'changer l\'ORDRE compte comme une forme différente')
  })

  it('9. champ de type inconnu → throw AVEC suggestion (faute de frappe proche)', () => {
    const r = creerRegistre()
    assert.throws(() => defSchema(r, 'x', { n: 'u9' as any }), /tu voulais dire 'u8'/)
    assert.throws(() => defSchema(r, 'y', { s: 'sttr8' as any }), /tu voulais dire 'str8'/)
    assert.throws(() => defSchema(r, 'z', { q: 'zzzzzzzzzz' as any }), /type inconnu/)
  })

  it('10. serialiserDefinitions/chargerDefinitions — voyage JSON-safe, registre RECHARGÉ décode ce que l\'original a encodé', () => {
    const origine = creerRegistre()
    defSchema(origine, 'pos', { x: 'i16', y: 'i16' })
    defSchema(origine, 'chat', { texte: 'str16', tags: list('str8') })
    const json = serialiserDefinitions(origine)
    assert.equal(json.hash, hashRegistre(origine))
    // JSON-safe — aucune fonction embarquée (list()/bits() sont déjà des objets inertes)
    assert.doesNotThrow(() => JSON.parse(JSON.stringify(json)))

    const recharge = chargerDefinitions(JSON.parse(JSON.stringify(json)))
    assert.equal(hashRegistre(recharge), hashRegistre(origine))
    const bytes = encode(origine, 'chat', { texte: 'yo', tags: ['a', 'b'] })
    const { nom, objet } = decode(recharge, bytes)
    assert.equal(nom, 'chat')
    assert.deepEqual(objet, { texte: 'yo', tags: ['a', 'b'] })
  })

  it('11. encode() vers un schéma inconnu / decode() d\'un id inconnu → throw clair', () => {
    const r = creerRegistre()
    defSchema(r, 'connu', { x: 'u8' })
    assert.throws(() => encode(r, 'inconnu', { x: 1 }), /schéma inconnu/)
    const bytesConnu = encode(r, 'connu', { x: 1 })
    const bytesIdInconnu = new Uint8Array([bytesConnu[0] + 1, ...bytesConnu.slice(1)])
    assert.throws(() => decode(r, bytesIdInconnu), /id de schéma inconnu/)
    assert.throws(() => decode(r, new Uint8Array(0)), /trame vide/)
  })

  it('12. champ absent/mal typé s\'encode en valeur zéro (tolérant) ; chaîne/list trop longue → throw structurel', () => {
    const r = creerRegistre()
    defSchema(r, 'partiel', { x: 'i16', nom: 'str8', actif: 'bool' })
    const { objet: out } = decode(r, encode(r, 'partiel', {}))
    assert.equal(out.x, 0)
    assert.equal(out.nom, '')
    assert.equal(out.actif, false)

    defSchema(r, 'strict8', { s: 'str8' })
    assert.throws(() => encode(r, 'strict8', { s: 'x'.repeat(256) }), /trop longue/)

    defSchema(r, 'listeCourte', { l: list('u8') })
    assert.equal(aSchema(r, 'listeCourte'), true)
    assert.equal(aSchema(r, 'jamais-déclaré'), false)
  })

  it('13. byte-identique — deux encodages du même objet produisent la MÊME séquence d\'octets', () => {
    const r = creerRegistre()
    defSchema(r, 'stable', { x: 'i16', pseudo: 'str8' })
    const a = encode(r, 'stable', { x: -5, pseudo: 'Zora' })
    const b = encode(r, 'stable', { x: -5, pseudo: 'Zora' })
    assert.deepEqual(Array.from(a), Array.from(b))
  })

  it('14. décodage d\'une VUE d\'un buffer plus grand : longueur str16 attaquant qui déborde la trame (mais reste dans le buffer) → RangeError, jamais une lecture des octets voisins (fuite heap)', () => {
    const r = creerRegistre()
    defSchema(r, 'msg', { texte: 'str16' })

    // trame LÉGITIME : id(1) + str16 « ok » → 1 + 2 + 2 = 5 octets
    const legit = encode(r, 'msg', { texte: 'ok' })
    assert.equal(legit.byteLength, 5)

    // buffer PARTAGÉ bien plus grand (200 octets, ex. tampon de réception réutilisé par un
    // transport) — la trame logique n'occupe qu'une SOUS-VUE de 5 octets en son milieu ; le
    // reste du buffer contient des octets « voisins » (ici 0xEE, marqueur pour repérer une
    // éventuelle fuite s'ils fuitaient dans la valeur décodée).
    const gros = new ArrayBuffer(200)
    new Uint8Array(gros).fill(0xEE)
    new Uint8Array(gros, 50, 5).set(legit)

    // ATTAQUANT — même trame, mais le préfixe de longueur str16 (octets 3-4, little-endian)
    // est réécrit à 100 : la chaîne prétend faire 100 octets alors que la fenêtre logique de
    // la trame (bytes.byteLength = 5) ne contient que 0 octet utile après le préfixe. 100
    // DÉBORDE la trame de 95 octets mais reste largement À L'INTÉRIEUR du buffer de 200 →
    // AVANT le fix, `new Uint8Array(vue.buffer, vue.byteOffset+offset, 100)` passait (contrôle
    // de borne du CONSTRUCTEUR portant sur gros.byteLength=200, pas sur les 5 octets de la
    // trame) et lisait 95 octets voisins (0xEE) au-delà de la trame reçue — fuite heap.
    const vueAttaque = new DataView(gros, 50, 5)
    vueAttaque.setUint16(1, 100, true)   // offset 1 = juste après l'octet id, préfixe str16

    const bytes = new Uint8Array(gros, 50, 5)   // VUE de 5 octets d'un buffer de 200
    assert.throws(
      () => decode(r, bytes),
      (err: unknown) => err instanceof RangeError && /hors bornes/.test((err as Error).message),
      'longueur str16 débordant la fenêtre de la trame (mais pas le buffer) → RangeError attendue, jamais un décodage silencieux des octets voisins'
    )
  })

  it('15. non-régression : aller-retour encode→decode sur une VUE d\'un buffer plus grand reste correct pour une trame VALIDE (le garde ne se déclenche que sur trame malformée)', () => {
    const r = creerRegistre()
    defSchema(r, 'msg', { n: 'u16', texte: 'str16', vals: list('u8') })
    const legit = encode(r, 'msg', { n: 4242, texte: 'éàçùî€ test', vals: [1, 2, 3, 250] })

    const gros = new ArrayBuffer(300)
    new Uint8Array(gros).fill(0xAA)
    new Uint8Array(gros, 111, legit.byteLength).set(legit)
    const vue = new Uint8Array(gros, 111, legit.byteLength)   // VUE de la trame dans le buffer plus grand

    const { nom, objet } = decode(r, vue)
    assert.equal(nom, 'msg')
    assert.equal(objet.n, 4242)
    assert.equal(objet.texte, 'éàçùî€ test')
    assert.deepEqual(objet.vals, [1, 2, 3, 250])
  })
})
