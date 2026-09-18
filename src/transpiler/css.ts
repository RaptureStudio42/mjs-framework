// transpiler/css — compilation des sections <style> selon `lang=`.
// Port de la V1 Ruby, transpiler/css_engine.rb (sans daemon).

import * as sass from 'sass'

export type StyleLang = 'css' | 'sass' | 'scss'

/**
 * Compile une section CSS/Sass/Scss en CSS minifié.
 * - `css` : passthrough (juste compaction whitespace)
 * - `sass` : Sass indenté (2 spaces)
 * - `scss` : Sass syntaxe accolades
 *
 * Retourne une string vide si le source est vide / blanc.
 */
// motif dominant de tout
// ce risque (« erreur avalée → build vert ») : une erreur de syntaxe SASS/SCSS
// était catchée ICI et transformée en simple `console.error` + CSS VIDE
// retourné — le composant compile avec SUCCÈS (aucune entrée dans
// stats.errors) mais rend SANS AUCUN STYLE en prod, découvert seulement en
// regardant la page. Fix : ne catch plus — l'erreur SASS remonte telle
// quelle à l'appelant. Les deux call sites existants ont DÉJÀ l'infra pour
// la capturer proprement (worker → postMessage(ok:false) → stats.errors
// pour un composant ; try/catch dans bundleSharedStyles pour un stylesheet
// partagé) — aucun changement nécessaire côté appelants pour le cas
// composant ; `bundleSharedStyles` isole désormais chaque fichier (cf. son
// propre commentaire) pour qu'UN stylesheet cassé ne bloque pas les autres.
//
// fusion consciente du lang <@include>.
// processIncludes (transpiler/macros.ts) balise le style d'un partial avec
// SON PROPRE lang (`\x00MJSSTYLE:<lang>\x00 … \x00MJSENDSTYLE\x00` — NUL
// pré-existants neutralisés À L'ENTRÉE, macros.ts côté partial et
// transpiler/index.ts côté hôte, donc par construction les seuls `\x00` qui
// atteignent compileCss sont nos marqueurs ; jamais un caractère utile en
// CSS/SASS, la tokenisation CSS remplace U+0000 par U+FFFD) au lieu de
// pousser du texte brut nu. AVANT : ce texte était concaténé tel quel au
// `style.raw` de l'hôte puis compilé UNE
// SEULE FOIS avec le SEUL `style.lang` de l'hôte (transpiler/index.ts:2366,
// point d'appel INCHANGÉ ici) — un partiel `lang="css"` (accolades) fusionné
// dans un hôte SASS indenté (le défaut) faisait échouer TOUT le build
// (« Expected newline »). Ici : si tous les blocs balisés partagent le lang
// reçu en paramètre, déballage PUR (aucune recompilation scindée) → sortie
// identique à l'octet près (non-régression du cas ultra-majoritaire, même
// lang partout). Sinon, chaque bloc compile avec SON lang, le texte hors-bloc
// (l'hôte) avec le lang reçu, concaténation des CSS dans l'ordre source.
const STYLE_BLOCK_RE = /\x00MJSSTYLE:(css|sass|scss)\x00([\s\S]*?)\x00MJSENDSTYLE\x00/g

export function compileCss(source: string, lang: StyleLang = 'css'): string {
  if (source.includes('\x00MJSSTYLE:')) {
    const blocks = [...source.matchAll(STYLE_BLOCK_RE)]
    const sameLang = blocks.every(b => b[1] === lang)
    if (sameLang) {
      // déballage pur, aucun bloc à isoler : reconstruit le texte d'origine à
      // l'identique (le sentinel n'entourait rien d'autre que la même sous-
      // chaîne déjà poussée par acc.css) → compile UNE fois comme avant.
      source = source.replace(STYLE_BLOCK_RE, (_m, _lang, raw) => raw)
    } else {
      let out = ''
      let cursor = 0
      for (const b of blocks) {
        out += compileCssBlock(source.slice(cursor, b.index!), lang)
        out += compileCssBlock(b[2], b[1] as StyleLang)
        cursor = b.index! + b[0].length
      }
      out += compileCssBlock(source.slice(cursor), lang)
      return out
    }
  }
  return compileCssBlock(source, lang)
}

function compileCssBlock(source: string, lang: StyleLang): string {
  const trimmed = source.trim()
  if (trimmed === '') return ''

  if (lang === 'sass' || lang === 'scss') {
    const result = sass.compileString(source, {
      syntax: lang === 'sass' ? 'indented' : 'scss',
      style: 'compressed',
    })
    // sass pose une marque d'ordre d'octets (U+FEFF) en tête dès que la feuille contient un
    // caractère non-ASCII ; le navigateur la lit comme un sélecteur et JETTE la première règle
    return result.css.replace(/\uFEFF/g, '')
  }
  // CSS pur : compaction whitespace
  return compactCss(source)
}

// compileCssBlock compactait les blancs avec /\s+/g SUR TOUTE LA SOURCE, traversant
// les chaînes : content: "a   b" devenait "a b", [data-tag="hello   world"] ne matchait plus
// jamais l'élément. sass/scss délèguent au paquet sass (compileString), non concernés.
//
// compactCss ignorait les commentaires CSS /* … */ : une apostrophe DE
// COMMENTAIRE ("it's", "l'élément" — norme des commentaires français maison) ouvrait une chaîne
// fantôme qui avalait tout jusqu'au prochain guillemet, sans erreur — plus rien de compacté
// derrière, et pire, la vraie chaîne suivante perdait sa protection (son guillemet ouvrant
// servant de fermeture à la fantôme). Fix : /* … */ recopié VERBATIM avant le test des
// guillemets ; jamais refermé → recopié jusqu'à la fin.
function compactCss(source: string): string {
  let out = ''
  let i = 0
  while (i < source.length) {
    const c = source[i]
    if (c === '/' && source[i + 1] === '*') {
      const end = source.indexOf('*/', i + 2)
      const stop = end === -1 ? source.length : end + 2
      out += source.slice(i, stop)
      i = stop
    } else if (c === '"' || c === '\'') {
      const quote = c
      out += c
      i++
      while (i < source.length && source[i] !== quote) {
        if (source[i] === '\\') {
          out += source[i] + (source[i + 1] ?? '')
          i += 2
        } else {
          out += source[i]
          i++
        }
      }
      if (i < source.length) {
        out += source[i]
        i++
      }
    } else if (/\s/.test(c)) {
      out += ' '
      while (i < source.length && /\s/.test(source[i])) i++
    } else {
      out += c
      i++
    }
  }
  return out.trim()
}
