// transpiler/img-tag — `<@img src="hero.jpg">`
// résolu au build par la MÊME mécanique que `µimage('hero.jpg')` (cf. bundler/index.ts,
// preResolveAssets). Ce module ne fait QUE le repérage/la réécriture TEXTE de la balise —
// aucun accès disque ici (seul le bundler l'a, via resolveOneImage) et aucun import de
// bundler (le bundler importe CE module ; un retour créerait un cycle).

import { findMacroTagEnd } from './macro-tag.js'

export interface ImgTagAttr {
  name: string
  raw: string
}

export interface ImgTag {
  text: string
  tagOpen: string
  start: number
  end: number
  src: string | null
  srcQuote: string
  widthsRaw: string | null
  widthsDynamique: string | null
  attrs: ImgTagAttr[]
}

export interface ResolvedImage {
  src: string
  srcset: string
  sizes: string
  width: number | null
  height: number | null
}

// extractQuotedValue — `attrRaw` est le texte COMPLET d'un attribut tel que rendu par
// parseAttrs (`nom="valeur"`, `nom='valeur'`) : rend la valeur ET le guillemet utilisé,
// ou null si l'attribut n'est pas sous forme guillemetée (accolade, nu, ou autre nom).
function extractQuotedValue(attrRaw: string, name: string): { value: string; quote: string } | null {
  const m = attrRaw.match(new RegExp(`^${name}\\s*=\\s*(["'])([\\s\\S]*)\\1$`))
  if (!m) return null
  return { quote: m[1], value: m[2] }
}

// parseAttrs — découpe le texte ENTRE `<@img` et le `>`/`/>` fermant en attributs.
// Profondeur `{`/`}` suivie pour les valeurs accolades (`name={ {a:1} }`), guillemet
// respecté pour les valeurs `"…"`/`'…'` — même esprit que `findMacroTagEnd`, à l'échelle
// d'un seul attribut plutôt que de la balise entière.
function parseAttrs(raw: string): ImgTagAttr[] {
  const attrs: ImgTagAttr[] = []
  const n = raw.length
  let i = 0
  while (i < n) {
    while (i < n && /\s/.test(raw[i])) i++
    if (i >= n) break
    const nameStart = i
    while (i < n && !/[\s=/]/.test(raw[i])) i++
    const name = raw.slice(nameStart, i)
    if (!name) { i++; continue }   // caractère isolé imprévu (`/` déjà retiré par l'appelant) : on avance sans planter
    while (i < n && /\s/.test(raw[i])) i++
    if (raw[i] === '=') {
      i++
      while (i < n && /\s/.test(raw[i])) i++
      if (raw[i] === '"' || raw[i] === '\'') {
        const quote = raw[i]
        i++
        while (i < n && raw[i] !== quote) i++
        if (i < n) i++   // consomme le guillemet fermant
      } else if (raw[i] === '{') {
        let depth = 0
        while (i < n) {
          const c = raw[i]
          if (c === '{') depth++
          else if (c === '}') depth--
          i++
          if (depth === 0) break
        }
      } else {
        while (i < n && !/\s/.test(raw[i])) i++
      }
    }
    attrs.push({ name, raw: raw.slice(nameStart, i) })
  }
  return attrs
}

// scanImgTags — repère chaque `<@img …>` littéral d'un texte (déjà masqué par
// maskCodeBlocks côté bundler, pour qu'un exemple affiché dans <pre>/<code> ne matche
// jamais). Limite de mot (`<@imgx` n'est pas une balise), fin réelle via findMacroTagEnd
// (accolades/guillemets suivis) — jamais le premier `>` textuel. `src` n'est candidat que
// s'il est entre guillemets et sans `{` dans la valeur (une valeur à accolade est une
// interpolation pour le pipeline d'attributs, jamais un chemin littéral).
// CASSE IGNORÉE : la résolution de module (resolveTagShortcuts) et le
// lint a11y sont insensibles à la casse — un scan sensible laissait `<@IMG src="absent.png">`
// traverser tout le build sans un mot. Le nom écrit est conservé (`tagOpen`) : la balise
// ressort telle que l'auteur l'a tapée, sa fermeture `</@IMG>` reste appariée.
export function scanImgTags(text: string): ImgTag[] {
  const tags: ImgTag[] = []
  for (const m of text.matchAll(/<@img\b/gi)) {
    const afterName = m.index! + m[0].length
    const tagEnd = findMacroTagEnd(text, afterName)
    if (tagEnd === -1) continue   // jamais refermée : hors périmètre de ce scan, signalé ailleurs
    const selfClosing = text[tagEnd - 1] === '/'
    const attrsRaw = text.slice(afterName, selfClosing ? tagEnd - 1 : tagEnd)
    const attrs = parseAttrs(attrsRaw)

    let src: string | null = null
    let srcQuote = '"'
    const srcAttr = attrs.find(a => a.name === 'src')
    if (srcAttr) {
      const q = extractQuotedValue(srcAttr.raw, 'src')
      if (q && !q.value.includes('{')) { src = q.value; srcQuote = q.quote }
    }

    let widthsRaw: string | null       = null
    let widthsDynamique: string | null = null
    const widthsAttr = attrs.find(a => a.name === 'widths')
    if (widthsAttr) {
      const q = extractQuotedValue(widthsAttr.raw, 'widths')
      // forme non littérale (`widths={$w}`, `widths=320`) : jamais consommée au build, et
      // jamais retirée en silence non plus — l'appelant lève
      if (q) widthsRaw = q.value
      else widthsDynamique = widthsAttr.raw.slice('widths'.length).replace(/^\s*=\s*/, '') || widthsAttr.raw
    }

    tags.push({ text: text.slice(m.index!, tagEnd + 1), tagOpen: m[0], start: m.index!, end: tagEnd + 1, src, srcQuote, widthsRaw, widthsDynamique, attrs })
  }
  return tags
}

// isResolvableSrc — chemin RELATIF seulement : un `src` vide, absolu (`/…`), une ancre
// (`#…`) ou une URL à schéma (`http:`, `data:`, `blob:`…) n'est jamais résolu — passe-plat,
// exactement comme un `src={…}` dynamique.
export function isResolvableSrc(src: string | null): src is string {
  if (!src) return false
  if (src.startsWith('/') || src.startsWith('#')) return false
  if (/^[a-z][a-z0-9+.-]*:/i.test(src)) return false
  return true
}

// parseWidths — entiers ≥ 1 séparés par espaces ou virgules (`"320 640"`, `"320, 640"`) ;
// toute autre forme (vide, décimal, négatif, texte) rend null — l'appelant décide de lever.
export function parseWidths(raw: string): number[] | null {
  const parts = raw.split(/[\s,]+/).map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) return null
  const widths: number[] = []
  for (const part of parts) {
    if (!/^\d+$/.test(part)) return null
    const n = Number(part)
    if (n < 1) return null
    widths.push(n)
  }
  return widths
}

// rewriteImgTag — attributs de l'auteur conservés VERBATIM et dans l'ORDRE, `widths`
// retiré (n'a de sens qu'au build), `src` remplacé par le chemin résolu (mêmes guillemets
// que l'original), puis ajout des SEULS attributs absents chez l'auteur — jamais de
// duplication ni d'écrasement d'un attribut déjà posé à la main.
export function rewriteImgTag(tag: ImgTag, resolved: ResolvedImage): string {
  const selfClosing = tag.text.endsWith('/>')
  const present = new Set(tag.attrs.map(a => a.name))
  const kept: string[] = []
  for (const attr of tag.attrs) {
    if (attr.name === 'widths') continue
    if (attr.name === 'src') { kept.push(`src=${tag.srcQuote}${resolved.src}${tag.srcQuote}`); continue }
    kept.push(attr.raw)
  }
  if (!present.has('srcset') && resolved.srcset) kept.push(`srcset="${resolved.srcset}"`)
  if (!present.has('sizes') && resolved.sizes) kept.push(`sizes="${resolved.sizes}"`)
  if (!present.has('width') && resolved.width !== null) kept.push(`width="${resolved.width}"`)
  if (!present.has('height') && resolved.height !== null) kept.push(`height="${resolved.height}"`)
  return `${tag.tagOpen} ${kept.join(' ')}${selfClosing ? ' /' : ''}>`
}
