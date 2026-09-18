// schema/core — « µschema » : registre de schémas binaires PUR, ZÉRO API node/navigateur (bundlé
// tel quel côté serveur ET côté client) — defSchema/encode/decode + hash stable
// du registre + (dé)sérialisation JSON des définitions pour le voyage en trame µ:schema. Consommé
// par src/mjs-ws/schema.ts (intégration serveur), jamais l'inverse : ce fichier ne connaît NI
// MjsWsClient NI le protocole µ:, juste des octets.
//
// Enveloppe fil (cf. src/mjs-ws/transport.ts) : [u8 idSchéma][charge] — l'id est
// attribué à CHAQUE schéma dans l'ORDRE de déclaration (0, 1, 2…), jamais choisi à la main : deux
// process qui déclarent leurs schémas dans le MÊME ordre obtiennent les MÊMES ids (condition du
// hash stable ci-dessous). DataView partout, little-endian, offsets calculés en DEUX passes
// (mesure puis écriture) — jamais de réallocation de buffer en cours de route.
//
// Types de champ : 8 numériques (u8/i8/u16/i16/u32/i32/f32/f64), bool (1 octet, 0/1), str8/str16
// (préfixe de longueur EN OCTETS UTF-8, pas en caractères — u8 ou u16 — puis les octets), list(of)
// (compteur u16 puis `of` répété — v1 : `of` scalaire ou str UNIQUEMENT, jamais list(list(...)) ni
// un sous-schéma imbriqué, cf. validerType), bits([noms]) (jusqu'à 8 booléens tassés dans 1 octet,
// bit i = noms[i] — la valeur du champ est un SOUS-OBJET { nom: bool, ... }, cf. lireChamp).
//
// UTF-8 : TextEncoder/TextDecoder globaux (DÉCISION) plutôt qu'un
// codec maison : disponibles SANS import ni polyfill dans tout navigateur évergreen ET Node ≥ 11
// (ce n'est ni une API node ni une API DOM, juste un standard WHATWG des deux côtés) — un codec
// maison n'aurait fait gagner qu'une compatibilité IE11 hors de portée de ce framework (cible
// ES2022/Node18, cf. tsconfig.json/package.json). Si un jour un des deux côtés en manque, tranchée
// ici en UN seul endroit (utf8Encoder/utf8Decoder ci-dessous).
//
// Garde d'évolution AJOUT-SEUL : un schéma déjà déclaré est IMMUABLE (même champs, même ordre) —
// re-déclarer le MÊME nom avec une forme DIFFÉRENTE (champ ajouté/retiré/retypé/réordonné) lève
// clair (cf. defSchema) ; re-déclarer à l'IDENTIQUE est un no-op silencieux (idempotent — un
// fichier serveur rechargé à chaud, cf. cli/ws.ts, ré-exécute son `app.schema(...)` sans planter).

import { t } from '../messages/index.js'

export type MjschemaScalar = 'u8' | 'i8' | 'u16' | 'i16' | 'u32' | 'i32' | 'f32' | 'f64' | 'bool' | 'str8' | 'str16'

export interface MjschemaListType { kind: 'list'; of: MjschemaScalar }
export interface MjschemaBitsType { kind: 'bits'; noms: string[] }
export type MjschemaFieldType = MjschemaScalar | MjschemaListType | MjschemaBitsType
/** objet ORDONNÉ { nomChamp: type, ... } — l'ordre des clés (Object.keys) EST l'ordre fil, cf. tête de fichier */
export type MjschemaFields = Record<string, MjschemaFieldType>

/** tableau homogène à compteur u16 — v1 : `of` scalaire/str SEULEMENT (pas list(list(...)), pas de sous-schéma, cf. validerType) */
export function list(of: MjschemaScalar): MjschemaListType { return { kind: 'list', of } }
/** jusqu'à 8 booléens tassés dans 1 octet (u8) — décodés en sous-objet { nom: bool, ... }, cf. lireChamp */
export function bits(noms: string[]): MjschemaBitsType { return { kind: 'bits', noms } }

export interface MjschemaDef {
  /** id u8 — attribué à la déclaration, dans l'ORDRE d'arrivée (0, 1, 2…), JAMAIS choisi à la main */
  readonly id: number
  readonly nom: string
  readonly champs: MjschemaFields
  /** Object.keys(champs) figé AU MOMENT de la déclaration — c'est CET ordre qui fait foi sur le fil, jamais recalculé */
  readonly ordre: string[]
}

export interface MjschemaRegistre {
  readonly parNom: Map<string, MjschemaDef>
  /** index = id — accès direct au décodage (cf. decode), jamais une recherche linéaire */
  readonly parId: MjschemaDef[]
}

export function creerRegistre(): MjschemaRegistre { return { parNom: new Map(), parId: [] } }

export function aSchema(registre: MjschemaRegistre, nom: string): boolean { return registre.parNom.has(nom) }

// --- validation à la déclaration — type inconnu (avec suggestion) / forme de list()/bits() -----

const SCALAIRES: MjschemaScalar[] = ['u8', 'i8', 'u16', 'i16', 'u32', 'i32', 'f32', 'f64', 'bool', 'str8', 'str16']

// distance de Levenshtein — MAISON (pas de dépendance pour une suggestion de 11 candidats au plus,
// jamais appelée sur un chemin chaud : uniquement au boot, quand une déclaration est déjà en tort)
function distanceLevenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  const d: number[][] = Array.from({ length: m + 1 }, () => new Array<number>(n + 1).fill(0))
  for (let i = 0; i <= m; i++) d[i][0] = i
  for (let j = 0; j <= n; j++) d[0][j] = j
  for (let i = 1; i <= m; i++) for (let j = 1; j <= n; j++) d[i][j] = a[i - 1] === b[j - 1] ? d[i - 1][j - 1] : 1 + Math.min(d[i - 1][j - 1], d[i - 1][j], d[i][j - 1])
  return d[m][n]
}

// plus proche type valide à distance ≤ 2, sinon aucune suggestion (mieux vaut se taire qu'une
// suggestion absurde — 'xyz' ne doit rien évoquer)
function suggererType(saisie: string): string | null {
  let meilleur: string | null = null
  let distanceMin = Infinity
  for (const candidat of SCALAIRES) {
    const d = distanceLevenshtein(saisie, candidat)
    if (d < distanceMin) { distanceMin = d; meilleur = candidat }
  }
  return distanceMin <= 2 ? meilleur : null
}

function validerType(nomSchema: string, nomChamp: string, type: MjschemaFieldType): void {
  if (typeof type === 'string') {
    if ((SCALAIRES as string[]).includes(type)) return
    const suggestion = suggererType(type)
    throw new Error(t('schema.type-inconnu', {
      schema: nomSchema,
      champ: nomChamp,
      type,
      indice: suggestion ? t('schema.suggestion-type', { suggestion }) : '',
      valides: SCALAIRES.join(', '),
    }))
  }
  if (type.kind === 'list') {
    if (!(SCALAIRES as string[]).includes(type.of)) {
      throw new Error(t('schema.list-type-scalaire', { schema: nomSchema, champ: nomChamp, valides: SCALAIRES.join(', '), typeDe: type.of }))
    }
    return
  }
  if (type.kind === 'bits') {
    if (!Array.isArray(type.noms) || type.noms.length === 0) throw new Error(t('schema.bits-noms-vides', { schema: nomSchema, champ: nomChamp }))
    if (type.noms.length > 8) throw new Error(t('schema.bits-trop-de-noms', { schema: nomSchema, champ: nomChamp, nb: type.noms.length }))
    if (new Set(type.noms).size !== type.noms.length) throw new Error(t('schema.bits-noms-double', { schema: nomSchema, champ: nomChamp }))
    return
  }
  throw new Error(t('schema.type-champ-invalide', { schema: nomSchema, champ: nomChamp }))
}

// --- garde AJOUT-SEUL — forme = noms + types + ORDRE, comparaison stricte ----------------------

function memeType(a: MjschemaFieldType, b: MjschemaFieldType): boolean {
  if (typeof a === 'string' || typeof b === 'string') return a === b
  if (a.kind !== b.kind) return false
  if (a.kind === 'list') return a.of === (b as MjschemaListType).of
  const bn = (b as MjschemaBitsType).noms
  return a.noms.length === bn.length && a.noms.every((n, i) => n === bn[i])
}

function memeForme(a: MjschemaFields, b: MjschemaFields): boolean {
  const ka = Object.keys(a), kb = Object.keys(b)
  if (ka.length !== kb.length) return false
  for (let i = 0; i < ka.length; i++) { if (ka[i] !== kb[i] || !memeType(a[ka[i]], b[kb[i]])) return false }
  return true
}

function decrireType(t: MjschemaFieldType): string {
  if (typeof t === 'string') return t
  return t.kind === 'list' ? `list(${t.of})` : `bits(${t.noms.join('+')})`
}

function decrireChamps(champs: MjschemaFields): string {
  return '{ ' + Object.keys(champs).map(c => c + ': ' + decrireType(champs[c])).join(', ') + ' }'
}

/**
 * Déclare (ou ré-affirme à l'identique) un schéma nommé — champs ORDONNÉ, cf. tête de fichier.
 * Ré-affirmation IDENTIQUE (même champs, même types, même ordre) = no-op silencieux, id inchangé
 * (idempotent — un entry rechargé à chaud ré-exécute ses `app.schema(...)` sans planter, cf.
 * cli/ws.ts). Ré-affirmation DIFFÉRENTE = throw clair (garde AJOUT-SEUL, cf. tête de fichier) :
 * fais évoluer le protocole en déclarant un NOUVEAU nom, jamais en mutant un schéma existant.
 */
export function defSchema(registre: MjschemaRegistre, nom: string, champs: MjschemaFields): MjschemaDef {
  const ordre = Object.keys(champs)
  for (const c of ordre) validerType(nom, c, champs[c])

  const existant = registre.parNom.get(nom)
  if (existant) {
    if (!memeForme(existant.champs, champs)) {
      throw new Error(t('schema.forme-differente', { nom, ancien: decrireChamps(existant.champs), nouveau: decrireChamps(champs) }))
    }
    return existant
  }

  if (registre.parId.length >= 256) throw new Error(t('schema.registre-plein', { nom }))
  const def: MjschemaDef = { id: registre.parId.length, nom, champs, ordre }
  registre.parNom.set(nom, def)
  registre.parId.push(def)
  return def
}

// --- encodage/décodage bas niveau — DataView little-endian, deux passes (mesure puis écriture) --

const utf8Encoder = new TextEncoder()
const utf8Decoder = new TextDecoder('utf-8')

/** taille FIXE en octets d'un scalaire, ou `null` pour str8/str16 (taille variable, dépend de la valeur) */
function tailleScalaireFixe(t: MjschemaScalar): number | null {
  switch (t) {
    case 'u8': case 'i8': case 'bool': return 1
    case 'u16': case 'i16': return 2
    case 'u32': case 'i32': case 'f32': return 4
    case 'f64': return 8
    default: return null
  }
}

// param renommé t → scalarType (E2b4) : `t` collisionnait avec l'import du traducteur de messages
function mesurerScalaire(scalarType: MjschemaScalar, valeur: unknown): number {
  const fixe = tailleScalaireFixe(scalarType)
  if (fixe != null) return fixe
  const octets = utf8Encoder.encode(String(valeur ?? ''))
  const max = scalarType === 'str8' ? 255 : 65535
  if (octets.byteLength > max) throw new Error(t('schema.chaine-trop-longue', { type: scalarType, octets: octets.byteLength, max }))
  return (scalarType === 'str8' ? 1 : 2) + octets.byteLength
}

function mesurerChamp(type: MjschemaFieldType, valeur: unknown): number {
  if (typeof type === 'string') return mesurerScalaire(type, valeur)
  if (type.kind === 'bits') return 1
  // list — 2 (compteur u16) + chaque élément mesuré comme le scalaire `of`
  const arr = Array.isArray(valeur) ? valeur : []
  if (arr.length > 65535) throw new Error(t('schema.list-trop-longue', { of: type.of, n: arr.length }))
  let total = 2
  for (const v of arr) total += mesurerScalaire(type.of, v)
  return total
}

// nombre fini par défaut — une valeur absente/non numérique s'encode en 0 plutôt que de faire
// planter l'envoi (même politique de tolérance que le reste de MJS-WS, cf. core.ts sendRaw : un
// bug de FORME de la charge applicative n'est jamais laissé faire tomber le process)
function numOr0(v: unknown): number { const n = Number(v); return Number.isFinite(n) ? n : 0 }

function ecrireScalaire(vue: DataView, offset: number, t: MjschemaScalar, valeur: unknown): number {
  switch (t) {
    case 'u8':   vue.setUint8(offset, numOr0(valeur) & 0xFF); return offset + 1
    case 'i8':   vue.setInt8(offset, numOr0(valeur)); return offset + 1
    case 'bool': vue.setUint8(offset, valeur ? 1 : 0); return offset + 1
    case 'u16':  vue.setUint16(offset, numOr0(valeur), true); return offset + 2
    case 'i16':  vue.setInt16(offset, numOr0(valeur), true); return offset + 2
    case 'u32':  vue.setUint32(offset, numOr0(valeur), true); return offset + 4
    case 'i32':  vue.setInt32(offset, numOr0(valeur), true); return offset + 4
    case 'f32':  vue.setFloat32(offset, numOr0(valeur), true); return offset + 4
    case 'f64':  vue.setFloat64(offset, numOr0(valeur), true); return offset + 8
    case 'str8': case 'str16': {
      const octets = utf8Encoder.encode(String(valeur ?? ''))
      if (t === 'str8') { vue.setUint8(offset, octets.byteLength); offset += 1 }
      else { vue.setUint16(offset, octets.byteLength, true); offset += 2 }
      new Uint8Array(vue.buffer, vue.byteOffset + offset, octets.byteLength).set(octets)
      return offset + octets.byteLength
    }
  }
}

function ecrireChamp(vue: DataView, offset: number, type: MjschemaFieldType, valeur: unknown): number {
  if (typeof type === 'string') return ecrireScalaire(vue, offset, type, valeur)
  if (type.kind === 'bits') {
    let octet = 0
    for (let i = 0; i < type.noms.length; i++) if ((valeur as Record<string, unknown> | null | undefined)?.[type.noms[i]]) octet |= (1 << i)
    vue.setUint8(offset, octet)
    return offset + 1
  }
  const arr = Array.isArray(valeur) ? valeur : []
  vue.setUint16(offset, arr.length, true)
  offset += 2
  for (const v of arr) offset = ecrireScalaire(vue, offset, type.of, v)
  return offset
}

/** garde de bornes EXPLICITE — la lecture ne doit JAMAIS dépasser la fenêtre LOGIQUE de la trame
 *  (`vue.byteLength`, cf. decode() : DataView construite avec byteOffset/byteLength EXPLICITES),
 *  jamais le buffer sous-jacent qui peut être plus grand si `bytes` est une VUE d'un buffer partagé
 *  — sinon `new Uint8Array(vue.buffer, ...)` (str8/str16, ci-dessous) lirait des octets VOISINS hors
 *  trame (fuite heap : son propre contrôle de borne porte sur le buffer ENTIER, pas sur la fenêtre).
 *  Appelée avant TOUTE lecture qui avance offset (scalaire à taille fixe, préfixe + octets str8/
 *  str16, élément de list) — trame VALIDE : jamais déclenchée, un comparateur de plus sur le chemin
 *  nominal, byte-identique par ailleurs. */
function bornerLecture(offset: number, taille: number, vue: DataView): void {
  if (offset + taille > vue.byteLength) throw new RangeError(t('schema.decode-hors-bornes'))
}

function lireScalaire(vue: DataView, offset: number, t: MjschemaScalar): [unknown, number] {
  switch (t) {
    case 'u8':   bornerLecture(offset, 1, vue); return [vue.getUint8(offset), offset + 1]
    case 'i8':   bornerLecture(offset, 1, vue); return [vue.getInt8(offset), offset + 1]
    case 'bool': bornerLecture(offset, 1, vue); return [vue.getUint8(offset) !== 0, offset + 1]
    case 'u16':  bornerLecture(offset, 2, vue); return [vue.getUint16(offset, true), offset + 2]
    case 'i16':  bornerLecture(offset, 2, vue); return [vue.getInt16(offset, true), offset + 2]
    case 'u32':  bornerLecture(offset, 4, vue); return [vue.getUint32(offset, true), offset + 4]
    case 'i32':  bornerLecture(offset, 4, vue); return [vue.getInt32(offset, true), offset + 4]
    case 'f32':  bornerLecture(offset, 4, vue); return [vue.getFloat32(offset, true), offset + 4]
    case 'f64':  bornerLecture(offset, 8, vue); return [vue.getFloat64(offset, true), offset + 8]
    case 'str8': case 'str16': {
      let len: number
      if (t === 'str8') { bornerLecture(offset, 1, vue); len = vue.getUint8(offset); offset += 1 }
      else { bornerLecture(offset, 2, vue); len = vue.getUint16(offset, true); offset += 2 }
      bornerLecture(offset, len, vue)
      const octets = new Uint8Array(vue.buffer, vue.byteOffset + offset, len)
      return [utf8Decoder.decode(octets), offset + len]
    }
  }
}

function lireChamp(vue: DataView, offset: number, type: MjschemaFieldType): [unknown, number] {
  if (typeof type === 'string') return lireScalaire(vue, offset, type)
  if (type.kind === 'bits') {
    bornerLecture(offset, 1, vue)
    const octet = vue.getUint8(offset)
    const out: Record<string, boolean> = {}
    for (let i = 0; i < type.noms.length; i++) out[type.noms[i]] = !!(octet & (1 << i))
    return [out, offset + 1]
  }
  bornerLecture(offset, 2, vue)
  const n = vue.getUint16(offset, true)
  offset += 2
  const out: unknown[] = []
  for (let i = 0; i < n; i++) { const [v, suivant] = lireScalaire(vue, offset, type.of); out.push(v); offset = suivant }
  return [out, offset]
}

// --- API haut niveau — encode(nom, objet) / decode(bytes), enveloppe [u8 id][charge] -----------

/** `objet` est lu champ par champ selon l'ORDRE déclaré (def.ordre) — un champ absent/mal typé
 *  s'encode en valeur zéro plutôt que de lever (cf. numOr0) : SEULES les erreurs STRUCTURELLES
 *  (schéma inconnu, chaîne/list trop longue pour son préfixe) font throw. */
export function encode(registre: MjschemaRegistre, nom: string, objet: Record<string, unknown> | null | undefined): Uint8Array {
  const def = registre.parNom.get(nom)
  if (!def) throw new Error(t('schema.encode-schema-inconnu', { nom }))
  const o = objet ?? {}
  let taille = 1   // octet id
  for (const c of def.ordre) taille += mesurerChamp(def.champs[c], o[c])
  const tampon = new ArrayBuffer(taille)
  const vue = new DataView(tampon)
  vue.setUint8(0, def.id)
  let offset = 1
  for (const c of def.ordre) offset = ecrireChamp(vue, offset, def.champs[c], o[c])
  return new Uint8Array(tampon)
}

/** `bytes` peut être une VUE (sous-tableau) d'un buffer plus grand — DataView construite avec
 *  byteOffset/byteLength explicites, jamais `bytes.buffer` seul (piège : verrait tout le buffer
 *  sous-jacent, pas la seule tranche reçue). */
export function decode(registre: MjschemaRegistre, bytes: Uint8Array): { nom: string; objet: Record<string, unknown> } {
  if (bytes.byteLength < 1) throw new Error(t('schema.decode-trame-vide'))
  const id = bytes[0]
  const def = registre.parId[id]
  if (!def) throw new Error(t('schema.decode-id-inconnu', { id }))
  const vue = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  let offset = 1
  const objet: Record<string, unknown> = {}
  for (const c of def.ordre) { const [v, suivant] = lireChamp(vue, offset, def.champs[c]); objet[c] = v; offset = suivant }
  return { nom: def.nom, objet }
}

// --- hash stable du registre — FNV-1a 32 bits, hex (PAS de crypto : juste un désaccord détectable,
// pas une preuve d'intégrité) — dépend des noms + types + ORDRE de déclaration, cf. tête de fichier --

function fnv1a(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) }
  return (h >>> 0).toString(16).padStart(8, '0')
}

export function hashRegistre(registre: MjschemaRegistre): string {
  const parts = registre.parId.map(def => def.nom + ':' + def.ordre.map(c => c + '=' + decrireType(def.champs[c])).join(','))
  return fnv1a(parts.join('|'))
}

// --- voyage en trame µ:schema — définitions JSON-safe (list()/bits() sont déjà des objets inertes,
// jamais des fonctions embarquées) + rechargement côté récepteur (chargerDefinitions RE-décrit un
// registre via defSchema — mêmes gardes, mêmes ids dans le MÊME ordre puisque `schemas` est déjà
// dans l'ordre d'origine, cf. serialiserDefinitions) ------------------------------------------

export interface MjschemaDefinitionsJSON {
  hash: string
  schemas: Array<{ nom: string; champs: Array<[string, MjschemaFieldType]> }>
}

export function serialiserDefinitions(registre: MjschemaRegistre): MjschemaDefinitionsJSON {
  return {
    hash: hashRegistre(registre),
    schemas: registre.parId.map(def => ({ nom: def.nom, champs: def.ordre.map((c): [string, MjschemaFieldType] => [c, def.champs[c]]) })),
  }
}

export function chargerDefinitions(json: MjschemaDefinitionsJSON): MjschemaRegistre {
  const registre = creerRegistre()
  for (const s of json.schemas) {
    const champs: MjschemaFields = {}
    for (const [c, t] of s.champs) champs[c] = t
    defSchema(registre, s.nom, champs)
  }
  return registre
}
