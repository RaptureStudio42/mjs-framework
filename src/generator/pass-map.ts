// ----------------------------------------------------------------------------
// pass-map — carte de source des passes de RÉÉCRITURE du générateur.
// Les quatre passes (`transformReactiveWrites`,
// `applyPathTracking`, `annotateEffectDeps`, `rebindDetachedThis`) éditent déjà
// par positions avec MagicString : la carte existe donc gratuitement, il
// suffisait de la DEMANDER (`generateMap`) au lieu de ne garder que le texte.
// Chacune expose désormais une variante `…Mapped()` qui rend `{ code, map }` ;
// l'export historique reste une enveloppe qui ne rend que le texte, pour ne
// casser aucun appelant.
// ----------------------------------------------------------------------------
import type MagicString from 'magic-string'

export interface PassResult {
  code: string
  /** carte v3 (JSON stringifié) de CETTE passe seule ; absente si la passe n'a rien touché */
  map?: string
}

// `hires` : indispensable ici — sans lui, une passe qui déplace du code À
// L'INTÉRIEUR d'une ligne (le cas le plus fréquent : `$.x = v` → `µ._set(...)`)
// ne pose qu'un segment en tête de ligne, et le chaînage retombe sur la
// mauvaise colonne. `includeContent: false` : le source du .mjs est recollé une
// seule fois, tout en bout de chaîne.
export function passResult(ms: MagicString, original: string, changed: boolean, sourceName: string): PassResult {
  if (!changed) return { code: original }
  return {
    code: ms.toString(),
    map:  ms.generateMap({ source: sourceName, hires: true, includeContent: false }).toString(),
  }
}
