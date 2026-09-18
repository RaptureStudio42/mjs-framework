// rune séparée de son symbole : `µ` puis `.setContext(…)` à la ligne suivante, `µ .emit`, `µ.` puis `toast` à la
// ligne suivante — écriture valide en Civet, Coffee et JS, mais invisible aux réécritures d'applyMjsSugarToScript
// (transpiler/index.ts) comme aux motifs de détection des modules du cœur (bundler/index.ts, scanRuntimeFeatures) :
// le code compilait puis plantait à l'exécution (`µ.setContext is not a function`, module du cœur jamais joint)
// refus à la compilation, toutes runes confondues, sur le source brut du dev lu comme le lit la réécriture
// alias `mjs` reconnu seulement s'il est configuré : sans lui, `mjs` reste un nom libre
// `firstLine` recale le numéro sur la ligne du fichier (startLine d'une section, cf. sections.ts)

import { t } from '../messages/index.js'
import { ouvreUneRegex, scanRegexLiteral } from '../sigils.js'

const SPLIT_RUNE_RE: Record<string, RegExp> = {
  'µ': /(?<![\w$.])(µ)(?:\s+\.\s*|\.\s+)([A-Za-z_$][\w$]*)/,
  mjs: /(?<![\w$.])(µ|mjs)(?:\s+\.\s*|\.\s+)([A-Za-z_$][\w$]*)/
}

// source → même longueur, retours à la ligne gardés, tout ce qui n'est pas du code remplacé par des espaces ; mêmes
// zones inertes que la passe 1 d'applyCivetDialectSugar puis transformCodeOnly : commentaires `//` `/* */` `###…###`
// et `#` (champ privé `#nom` gardé hors Coffee), chaînes et heredocs, littéraux regex, heregex `///…///` en
// Coffee/Civet ; le code des interpolations `${…}` (gabarit) et `#{…}` (guillemets doubles Coffee/Civet) reste lu
export function maskNonCode(src: string, lang = 'civet'): string {
  const coffee    = lang === 'coffee'
  const heredocs  = coffee || lang === 'civet'
  const chars     = src.split('')
  const n         = src.length
  const blank     = (from: number, to: number): void => { for(let k = from; k < to && k < n; k++) if(chars[k] !== '\n') chars[k] = ' ' }
  const lineEnd   = (j: number): number => { const e = src.indexOf('\n', j); return e < 0 ? n : e }
  const closeAt   = (j: number, close: string): number => { const e = src.indexOf(close, j); return e < 0 ? n : e + close.length }

  // chaîne ouverte en `open`, texte à partir de `j` : masquée jusqu'au délimiteur, interpolations gardées comme code
  const text = (open: number, j: number, close: string, interp: string | null): number => {
    let from = open
    while(j < n) {
      if(src[j] === '\\') { j += 2; continue }
      if(src.startsWith(close, j)) { blank(from, j + close.length); return j + close.length }
      if(interp && src.startsWith(interp, j)) {
        blank(from, j + interp.length)
        const end = code(j + interp.length, true)
        from = end
        j    = end + 1
        continue
      }
      j++
    }
    blank(from, n)
    return n
  }

  // code à partir de `i` ; dans une interpolation, s'arrête sur l'accolade fermante appariée et rend son index
  const code = (i: number, inside: boolean): number => {
    let depth = 0
    while(i < n) {
      const c = src[i], c1 = src[i + 1], c2 = src[i + 2]
      if(inside && c === '{') depth++
      if(inside && c === '}') {
        if(depth === 0) return i
        depth--
      }
      if(c === '#' && c1 === '#' && c2 === '#') { const s = closeAt(i + 3, '###'); blank(i, s); i = s; continue }
      if(heredocs && c === '/' && c1 === '/' && c2 === '/') { const s = closeAt(i + 3, '///'); blank(i, s); i = s; continue }
      if(c === '/' && c1 === '/') { const s = lineEnd(i); blank(i, s); i = s; continue }
      if(c === '/' && c1 === '*') { const s = closeAt(i + 2, '*/'); blank(i, s); i = s; continue }
      if(c === '#' && (coffee || !(c1 !== undefined && /[a-zA-Z_!]/.test(c1)))) { const s = lineEnd(i); blank(i, s); i = s; continue }
      if(c === '/' && ouvreUneRegex(src.slice(0, i))) {
        const fin = scanRegexLiteral(src, i)
        if(fin !== -1) { blank(i, fin); i = fin; continue }
      }
      if(heredocs && (c === '"' || c === "'") && c1 === c && c2 === c) { i = text(i, i + 3, c + c + c, c === '"' ? '#{' : null); continue }
      if(c === '`') { i = text(i, i + 1, '`', '${'); continue }
      if(c === '"' || c === "'") { i = text(i, i + 1, c, heredocs && c === '"' ? '#{' : null); continue }
      i++
    }
    return i
  }

  code(0, false)
  return chars.join('')
}

export function lintSplitRune(source: string, place: string, opts: { sigil?: string, firstLine?: number, lang?: string } = {}): void {
  if(!source) return
  const masked = maskNonCode(source, opts.lang)
  const m      = SPLIT_RUNE_RE[opts.sigil === 'mjs' ? 'mjs' : 'µ'].exec(masked)
  if(!m) return
  const line = (opts.firstLine ?? 1) + (masked.slice(0, m.index).match(/\n/g)?.length ?? 0)
  throw new Error(t('transpiler.rune-separee-du-symbole', { symbole: m[1], rune: m[2], lieu: place, ligne: line }))
}
