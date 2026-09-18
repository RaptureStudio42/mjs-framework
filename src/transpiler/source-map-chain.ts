// ----------------------------------------------------------------------------
// source-map-chain — cartes de source.
//
// La carte du compilateur de langage (Civet/Coffee/TS → JS) ne disait la vérité
// que jusqu'à la sortie du compilateur : quatre passes de réécriture et
// l'assemblage dans le squelette de classe passaient ensuite dessus sans que
// personne ne recompose quoi que ce soit. Ce fichier fait ce recollage :
//
//   .mjs  ──carte du langage──▶  JS du <script>
//         ──cartes des 4 passes──▶  jsInitBase
//         ──décalage d'assemblage──▶  fichier du composant
//
// `remapping` compose la chaîne (forme TABLEAU : chaque élément est la carte
// du source de l'élément précédent) ; le décalage d'assemblage, lui, joue sur
// les lignes GÉNÉRÉES — pas sur les lignes source — d'où son propre outil.
// ----------------------------------------------------------------------------
import remapping from '@jridgewell/remapping'
import { decode, encode } from '@jridgewell/sourcemap-codec'

/**
 * Compose la carte du compilateur avec celles des passes de réécriture.
 * `base` = carte `.mjs` → JS compilé (déjà décalée sur la ligne du bloc) ;
 * `passes` = cartes des passes, DANS L'ORDRE D'APPLICATION. Les entrées vides
 * (passe qui n'a rien touché) sont sautées : sans édition, l'identité suffit.
 * Rend `undefined` si rien n'est chaînable — un `undefined` honnête vaut mieux
 * qu'une carte qui pointerait à côté.
 */
export function chainSourceMaps(base: string | undefined, passes: (string | undefined)[]): string | undefined {
  const kept = passes.filter((m): m is string => !!m)
  if (!base) return undefined
  if (kept.length === 0) return base
  // ordre inverse : remapping part de la DERNIÈRE sortie et remonte la chaîne.
  const chain = [...kept].reverse().map(m => JSON.parse(m))
  chain.push(JSON.parse(base))
  return JSON.stringify(remapping(chain, () => null))
}

/**
 * Décale une carte sur les lignes GÉNÉRÉES : le code cartographié n'est plus en
 * tête de fichier mais inséré à `line`/`col` dans un squelette. Les lignes en
 * amont n'ont aucune correspondance (tableaux vides) ; seule la PREMIÈRE ligne
 * insérée est aussi décalée en colonne — les suivantes commencent bien en
 * colonne 0 dans le fichier final.
 */
export function shiftGeneratedPosition(mapJson: string, line: number, col: number): string {
  if (line === 0 && col === 0) return mapJson
  const raw = JSON.parse(mapJson)
  const decoded = decode(raw.mappings ?? '')
  if (col !== 0 && decoded.length > 0) {
    decoded[0] = decoded[0].map(seg => [seg[0] + col, ...seg.slice(1)] as typeof seg)
  }
  raw.mappings = encode([...Array.from({ length: line }, () => [] as never[]), ...decoded])
  return JSON.stringify(raw)
}

/**
 * Nomme la source et le fichier produit, et embarque le source du `.mjs` :
 * une carte sans `sourcesContent` oblige le navigateur à retrouver le fichier
 * d'origine — impossible quand il n'est pas servi (le `.mjs` ne l'est jamais).
 */
export function finalizeSourceMap(mapJson: string, sourceName: string, fileName: string, sourceContent?: string): string {
  const raw = JSON.parse(mapJson)
  raw.sources = [sourceName]
  raw.file    = fileName
  raw.sourcesContent = [sourceContent ?? null]
  return JSON.stringify(raw)
}

/**
 * Recompose une carte AVAL (celle d'un outil qui a retransformé le texte : esbuild)
 * par-dessus une carte AMONT (la nôtre). Sans ça, la carte d'esbuild pointerait le
 * texte que le bundler lui a passé — un fichier qui n'existe nulle part.
 */
export function chainOverMap(downstream: string, upstream: string): string {
  const out = remapping([JSON.parse(downstream), JSON.parse(upstream)], () => null)
  return JSON.stringify(out)
}
