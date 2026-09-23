// lexer — port de la V1 Ruby, lexer_coffee.rb
//
// Tokenise le sucre ModularJS dans une source post-langage (CoffeeScript pré-compile,
// ou JS issu de Civet/TS/JS direct). Port à l'identique (output strictement
// égal à V1). Une prochaine étape ajoutera l'émission `__mjs_get/__mjs_set` à la place de `$.x`.
//
// externalVars : noms `$foo` à préserver tels quels (imports cross-module)
// moduleMode   : si true, tous les `$foo` restent littéraux (modules .coffee externes)

import { RAW_ACCESS_BODY, RAW_ACCESS_PAREN_BODY, RAW_ACCESS_MALFORME_BODY, rawAccessFormeError, RAW_WRITE_BODY, RAW_WRITE_PAREN_BODY, RAW_WRITE_PAREN_OUT_OPEN, RAW_WRITE_OLD_FORME_BODY, RAW_WRITE_OLD_FORME_PAREN_BODY, rawWriteAncienneFormeError, BARE_SECTION_BODY, bareSectionError, RAW_ACCESS_OUT, RAW_ACCESS_STORE_OUT, MU_PASCAL_BODY, MU_SHORT_BODY, MU_LANG_BODY, MU_LANG_OUT, MU_THEME_BODY, MU_THEME_OUT, MU_HOOKS, MU_HOOKS_BODY, MU_DERIVED_BODY, rewriteMuToggle, vaultRemovedError, importedSingletonError, ouvreUneRegex, scanRegexLiteral } from '../sigils.js'
import { t } from '../messages/index.js'

// regex ancrées du scanner — bâties UNE fois sur les corps partagés (sigils.ts,
// source unique lexer↔cleanJs) ; l'ancre `^` reste locale à ce moteur
const RE_RAW_ACCESS = new RegExp(`^${RAW_ACCESS_BODY}`)
const RE_RAW_ACCESS_PAREN = new RegExp(`^${RAW_ACCESS_PAREN_BODY}`)
const RE_RAW_ACCESS_MALFORME = new RegExp(`^${RAW_ACCESS_MALFORME_BODY}`)
const RE_RAW_WRITE = new RegExp(`^${RAW_WRITE_BODY}`)
const RE_RAW_WRITE_PAREN = new RegExp(`^${RAW_WRITE_PAREN_BODY}`)
const RE_RAW_WRITE_OLD_FORME = new RegExp(`^${RAW_WRITE_OLD_FORME_BODY}`)
const RE_RAW_WRITE_OLD_FORME_PAREN = new RegExp(`^${RAW_WRITE_OLD_FORME_PAREN_BODY}`)
const RE_BARE_SECTION = new RegExp(`^${BARE_SECTION_BODY}`)
const RE_MU_PASCAL  = new RegExp(`^${MU_PASCAL_BODY}`)
const RE_MU_SHORT   = new RegExp(`^${MU_SHORT_BODY}`)
const RE_MU_LANG    = new RegExp(`^${MU_LANG_BODY}`)
const RE_MU_THEME   = new RegExp(`^${MU_THEME_BODY}`)
const RE_MU_HOOKS   = new RegExp(`^${MU_HOOKS_BODY}`)

// µderived $var = expr, $a, $b — PRÉ-PASSE (pas un branchement scanner : pas
// d'ancre `^`, consommée par un `code.replace` global comme les pré-passes §/§§)
const RE_MU_DERIVED_STMT = new RegExp(
  `${MU_DERIVED_BODY}[ \\t]+\\$([a-zA-Z_][a-zA-Z0-9_]*)[ \\t]*=(?!=|>)[ \\t]*(.+?)(?=\\n|;|$)`,
  'g'
)

// garde-fou : ancienne forme hook `@mount ->` / `@urlChange (p, a) ->` RETIRÉE.
// Ne matche QUE la silhouette hook (flèche directe, ou (args) puis flèche) —
// `@mount = ->` (méthode utilisateur, noms désormais LIBRES) et `@mount(x)`
// (appel parenthésé) ne sont PAS concernés.
const RE_OLD_HOOK = new RegExp(`^@(${MU_HOOKS})(?=[ \\t]*(?:->|=>|\\([^)\\n]*\\)[ \\t]*(?:->|=>)))`)

export interface TokenizeOpts {
  externalVars?: string[]
  moduleMode?: boolean
}

// masque strings/heredocs/commentaires (MÊMES formes que la règle 3.1
// du scanner) par des jetons inertes `NUL+N+NUL` (ni `;`, ni `\n`, ni `§`),
// le temps des PRÉ-PASSES § / §§ (4 replace globaux, exécutés AVANT le scanner).
// Sans ce masquage : (a) un `§ident` dans le TEXTE d'une chaîne était réécrit en
// code (texte faux à l'écran) ; (b) un `;` DANS une chaîne du RHS d'un setter
// coupait la capture `(.+?)(?=\n|;|$)` au milieu de la chaîne. Le `§` d'une
// INTERPOLATION `#{…}` reste géré : le scanner rappelle `tokenize` sur l'inner.
// LECTEUR À NIVEAUX — remplace l'ancienne regex INERT_RE, dont
// l'alternative backtick (non récursive) fermait au PREMIER backtick rencontré :
// sur un backtick imbriqué dans une interpolation, elle fermait au 2e backtick au
// lieu du 4e, décalait tout le masquage, et laissait fuir dans le HTML résiduel un
// `</script>` pourtant situé DANS une chaîne (cf. garde-fou reliquats de
// transpiler/sections.ts). Le scanner ci-dessous parcourt la source une fois, dans
// le MÊME ordre de priorité que l'ancienne alternance, et compte les niveaux
// d'imbrication backtick / interpolation.
// Repli identique à la regex : un littéral NON TERMINÉ n'est pas masqué du tout (on
// repart au caractère suivant) — c'est ce repli qui laisse le garde-fou de
// sections.ts détecter la chaîne non fermée au lieu de la masquer en silence.
const IDENT_START_RE = /[a-zA-Z_]/

// scanInertAt — un littéral/commentaire commence-t-il en `i` ? rend l'offset de FIN
// (exclu), ou -1 (rien ici, ou littéral non terminé)
function scanInertAt(src: string, i: number): number {
  const c = src[i]
  if (c === '#') {
    if (src.startsWith('###', i)) { const e = src.indexOf('###', i + 3); return e < 0 ? -1 : e + 3 }
    if (IDENT_START_RE.test(src[i + 1] ?? '')) return -1   //`#nom` = symbole, pas un commentaire
    const e = src.indexOf('\n', i)
    return e < 0 ? src.length : e
  }
  if (c === '/') {
    if (src[i + 1] === '/') { const e = src.indexOf('\n', i); return e < 0 ? src.length : e }
    if (src[i + 1] === '*') { const e = src.indexOf('*/', i + 2); return e < 0 ? -1 : e + 2 }
    // littéral regex `/…/` : ZONE INERTE au même titre qu'une chaîne. Sans ce
    // garde-fou, un `§`/`§§` À L'INTÉRIEUR d'un regex (`/§theme/`) survivait à CE masquage et se
    // faisait manger par les pré-passes §/§§ juste en dessous (AVANT même que la règle 3.1a du
    // scanner, plus bas dans ce fichier, ne voie le littéral en entier). Même heuristique
    // PARTAGÉE (sigils.ts) que la règle 3.1a et le parser.
    if (ouvreUneRegex(src.slice(0, i))) return scanRegexLiteral(src, i)
    return -1
  }
  if (c === '"' || c === "'") {
    const triple = c + c + c
    if (src.startsWith(triple, i)) { const e = src.indexOf(triple, i + 3); return e < 0 ? -1 : e + 3 }   //heredocs
    let j = i + 1
    while (j < src.length) {
      const d = src[j]
      if (d === '\\') { j += 2; continue }
      if (d === '\n') return -1                            //chaîne simple : jamais multi-ligne
      if (d === c) return j + 1
      j++
    }
    return -1
  }
  if (c === '`') return scanTemplateAt(src, i)
  return -1
}

// scanTemplateAt — backtick ouvrant en `i` : avance jusqu'au backtick fermant du MÊME
// niveau, en traversant les interpolations (elles-mêmes porteuses de backticks, de
// chaînes et d'accolades imbriquées)
function scanTemplateAt(src: string, i: number): number {
  let j = i + 1
  while (j < src.length) {
    const c = src[j]
    if (c === '\\') { j += 2; continue }
    if (c === '`') return j + 1
    if (c === '$' && src[j + 1] === '{') {
      const e = scanInterpAt(src, j + 2)
      if (e < 0) return -1
      j = e
      continue
    }
    j++
  }
  return -1
}

// scanInterpAt — intérieur d'une interpolation (offset du 1er caractère après
// l'accolade) : rend l'offset APRÈS l'accolade fermante de profondeur 0, ou -1 si
// jamais refermée
function scanInterpAt(src: string, i: number): number {
  let depth = 1
  let j     = i
  while (j < src.length) {
    const c = src[j]
    if (c === '{') { depth++; j++; continue }
    if (c === '}') { depth--; j++; if (depth === 0) return j; continue }
    // AVANT : un `/` n'était sauté en bloc que pour `//`/`/* */` — un littéral regex générique
    // (`/…/`) tombait dans le `j++` du bas, caractère par caractère. Un backtick DANS ce regex
    // (`/`/`) était alors vu, à l'itération suivante, comme un VRAI début de gabarit imbriqué
    // (branche `c === '`'` juste en dessous) : le scan partait chercher un backtick fermant
    // n'importe où plus loin, décalait la position, et corrompait le texte littéral du gabarit
    // voisin — trouvé en revue le 23/09/2026, prouvé par exécution. scanInertAt sait déjà
    // distinguer regex/division (ouvreUneRegex, cf. scanInertAt ci-dessus et sigils.ts) : lui
    // déléguer TOUT `/` laisse la division retomber sur le même repli `j++` qu'avant (aucun
    // littéral détecté), sans rien changer pour elle.
    if (c === '`' || c === '"' || c === "'" || c === '/') {
      const e = scanInertAt(src, j)                        //chaîne/commentaire/regex imbriqué : sauté d'un bloc
      j = e < 0 ? j + 1 : e
      continue
    }
    j++
  }
  return -1
}

// inertRanges — toutes les plages inertes de `src`, dans l'ordre, sans recouvrement
function inertRanges(src: string): Array<[number, number]> {
  const out: Array<[number, number]> = []
  let i = 0
  while (i < src.length) {
    const c = src[i]
    if (c === '#' || c === '/' || c === '"' || c === "'" || c === '`') {
      const e = scanInertAt(src, i)
      if (e > i) { out.push([i, e]); i = e; continue }
    }
    i++
  }
  return out
}

// replaceInert — réécrit chaque plage inerte par `fn(texte)`, laisse le reste intact
function replaceInert(src: string, fn: (tok: string) => string): string {
  const ranges = inertRanges(src)
  if (ranges.length === 0) return src
  let out    = ''
  let cursor = 0
  for (const [start, end] of ranges) {
    out   += src.slice(cursor, start) + fn(src.slice(start, end))
    cursor = end
  }
  return out + src.slice(cursor)
}

// delimiteur de masque : NUL, absent de toute source .mjs (garde le fichier en
// ASCII pur -- pas d'octet NUL litteral qui le classerait binaire pour grep)
const NUL = String.fromCharCode(0)
const UNMASK_RE = new RegExp(NUL + '(\\d+)' + NUL, 'g')

function maskInert(src: string): { masked: string; slots: string[] } {
  const slots: string[] = []
  const masked = replaceInert(src, (tok) => NUL + (slots.push(tok) - 1) + NUL)
  return { masked, slots }
}

function unmaskInert(src: string, slots: string[]): string {
  return slots.length === 0 ? src : src.replace(UNMASK_RE, (_m, id) => slots[+id])
}

// splitTrailingMaskedComment — un commentaire masqué en TOUTE FIN de capture (§/§§, règles 1
// et 2-bis ci-dessous) doit sortir de l'argument AVANT que le générateur y pose sa `)` : sinon,
// au démasquage, le `#`/`//` restauré avale tout le reste de la ligne, `)` comprise
// (exemple exact docs/13-contexte.md:75, `§canvas = { addItem }   # le service…`).
// Une chaîne/regex/heredoc masqué EN FIN d'expression (`§msg = 'texte'`) N'EST PAS concerné :
// seul le CONTENU du slot (`#`/`//`/`/*`) tranche — une simple adjacence d'espaces ne suffit pas
// à distinguer les deux cas (une chaîne finale légitime peut aussi être précédée d'un espace,
// `$x + '  '`).
function splitTrailingMaskedComment(expr: string, slots: string[]): { code: string; tail: string } {
  const m = expr.match(new RegExp('^([\\s\\S]*?)(\\s*' + NUL + '(\\d+)' + NUL + ')$'))
  if (!m) return { code: expr, tail: '' }
  const slot = slots[+m[3]] ?? ''
  if (!(slot.startsWith('#') || slot.startsWith('//') || slot.startsWith('/*'))) return { code: expr, tail: '' }
  return { code: m[1], tail: m[2] }
}

// scinde `tail` par les virgules de PROFONDEUR 0 (hors parenthèses/crochets/
// accolades) — texte déjà masqué (maskInert), pas de quotes à gérer ici
function splitTopLevelCommas(tail: string): string[] {
  const parts: string[] = []
  let depth = 0
  let cur = ''
  for (const ch of tail) {
    if (ch === '(' || ch === '[' || ch === '{') depth++
    else if (ch === ')' || ch === ']' || ch === '}') depth--
    if (ch === ',' && depth === 0) { parts.push(cur); cur = '' }
    else cur += ch
  }
  parts.push(cur)
  return parts
}

// maskInertSameLength — variante MÊME LONGUEUR de maskInert : chaque littéral/
// commentaire (lecteur à niveaux) est remplacé par des espaces, `\n` préservés → les
// offsets restent alignés avec la source d'origine (utile pour re-matcher sur
// la vue masquée puis relire le texte réel via `m.indices`, cf. transpiler/sections.ts).
export function maskInertSameLength(src: string): string {
  return replaceInert(src, (tok) => tok.replace(/[^\n]/g, ' '))
}

// interpolateSigils — dans une chaîne, tokenise le contenu des interpolations
// `<marker>{ ... }` (`#{...}` pour Coffee/Civet, `${...}` pour les template
// literals). Les parties littérales restent intactes ; seul le code des
// interpolations passe par `tokenize` (récursif). Gère les `{}` imbriqués.
function interpolateSigils(str: string, marker: string, opts: TokenizeOpts): string {
  let out = ''
  let j = 0
  while (j < str.length) {
    if (str[j] === marker && str[j + 1] === '{' && str[j - 1] !== '\\') {
      let depth = 1
      let k = j + 2
      // comptage des `{}` CONSCIENT des chaînes : sans ça, un `}`
      // littéral dans une chaîne de l'interpolation (`#{ fn('}') + $y }`)
      // décrémentait `depth` et fermait trop tôt → la fin réelle (`+ $y }`)
      // copiée VERBATIM hors zone tokenisée → `$y` restait littéral.
      let inStr = false
      let strCh = ''
      while (k < str.length && depth > 0) {
        const ch = str[k]
        if (inStr) {
          if (ch === '\\') { k += 2; continue }
          if (ch === strCh) inStr = false
        } else if (ch === '"' || ch === "'" || ch === '`') { inStr = true; strCh = ch }
        else if (ch === '{') depth++
        else if (ch === '}') { depth--; if (depth === 0) break }
        k++
      }
      const inner = str.slice(j + 2, k)
      out += marker + '{' + tokenize(inner, opts) + '}'
      j = k + 1
    } else {
      out += str[j]
      j++
    }
  }
  return out
}

export function tokenize(codeRaw: string, opts: TokenizeOpts = {}): string {
  const externalVars = opts.externalVars ?? []
  const moduleMode = opts.moduleMode ?? false

  let code = codeRaw

  // 0. µtoggle($x, 'a', 'b') → `$x = (…)` — PRÉ-PASSE de tête, AVANT le masquage :
  // les valeurs du cycle SONT des chaînes littérales, un masquage fait ici les
  // rendrait invisibles (rewriteMuToggle masque elle-même).
  // Corps PARTAGÉ avec cleanJs (sigils.ts) ; la cible `$x`/`$$x` ressort VERBATIM,
  // c'est le scanner ci-dessous qui pose le setter réactif — comme µderived.
  code = rewriteMuToggle(code, '<script>')

  // on MASQUE chaînes/heredocs/commentaires le temps des 4 pré-passes
  // § / §§ ci-dessous (replace globaux aveugles au contexte), puis on restaure.
  const inert = maskInert(code)
  code = inert.masked

  // 1. setContext : `§foo = expr` → `this._mjs_setContext('foo', expr)`
  // Le lookbehind exclut AUSSI `§` : sans ça, `§§foo` (contexte réactif) était
  // mangé ici (le 2e § est précédé d'un non-word) et le cas 3.3 (fallback §§
  // contexte réactif) du scanner était du code mort (bug V1 porté,
  // test skippé historique).
  // Un commentaire masqué en fin de ligne (`§foo = expr   # note`) sortait
  // de l'expression APRÈS la `)` : au démasquage le `#`/`//` avalait cette `)`, Civet partait en
  // erreur sur la ligne suivante. splitTrailingMaskedComment isole ce commentaire AVANT la `)`.
  code = code.replace(
    /(?<![\w.§])§([a-zA-Z_]\w*)\s*=(?!=|>)\s*(.+?)(?=\n|;|$)/g,
    (_m, name, expr) => {
      const { code: realExpr, tail } = splitTrailingMaskedComment(expr, inert.slots)
      return `this._mjs_setContext('${name}', ${realExpr})${tail}`
    }
  )

  // 2. getContext : `§foo` → `this._mjs_getContext('foo')`
  code = code.replace(
    /(?<![\w.§])§([a-zA-Z_]\w*)/g,
    (_m, name) => `this._mjs_getContext('${name}')`
  )

  // 2-bis. §§ CONTEXTE RÉACTIF de sous-arbre — TOUJOURS (plus aucune résolution
  //   vers un singleton importé : celui-ci se consomme désormais en `µ$$x`,
  //   jamais en `§§x` — cf. lintSingletonConsume). Setter `§§foo = expr` →
  //   `this._mjs_setRCtx('foo', expr)` (déclaration sur l'ancêtre) ; getter
  //   `§§foo` → `this._mjs_getRCtx('foo')` (remonte l'arbre + abonne).
  //   Ces `§§` échappent aux règles § (1/2) : leur lookbehind exclut un `§` devant.
  // Même correctif que la règle 1 ci-dessus (commentaire de fin de ligne isolé
  // AVANT la `)`, jamais capturé DANS l'expression).
  code = code.replace(
    /(?<![\w.§])§§([a-zA-Z_]\w*)\s*=(?!=|>)\s*(.+?)(?=\n|;|$)/g,
    (_m, name, expr) => {
      const { code: realExpr, tail } = splitTrailingMaskedComment(expr, inert.slots)
      return `this._mjs_setRCtx('${name}', ${realExpr})${tail}`
    }
  )
  code = code.replace(
    /(?<![\w.§])§§([a-zA-Z_]\w*)/g,
    (_m, name) => `this._mjs_getRCtx('${name}')`
  )

  // 2-ter. µderived $var = expr, $a, $b, … → dérivé à DÉPENDANCES FORCÉES. Réduit à
  // `$var = µ._mjs_forceDeps(expr, $a, $b, …)` — marqueur reconnu et EFFACÉ par
  // l'analyzer pour un JS final sans artefact. `expr` et les `$a`/`$b` restent
  // verbatim : le scanner du dessous les convertira normalement.
  code = code.replace(RE_MU_DERIVED_STMT, (_m, varName, tail) => {
    const segments = splitTopLevelCommas(tail).map((s) => s.trim())
    const realExpr = segments[0] ?? ''
    if (!realExpr) throw new Error(t('lexer.derived-expr-vide', { varName }))
    // `realExpr` sort de la vue MASQUÉE (maskInert, tout en haut de
    // tokenize) : un `await` DANS une chaîne/un commentaire a déjà été remplacé par un jeton
    // NUL, il ne peut plus matcher ici — seul un VRAI mot-clé await déclenche ce refus.
    if (/\bawait\b/.test(realExpr)) throw new Error(t('transpiler.derived-await-interdit', { varName }))
    const forcedDeps = segments.slice(1)
    for (const dep of forcedDeps) {
      if (!/^\$[a-zA-Z_][a-zA-Z0-9_]*$/.test(dep)) {
        throw new Error(t('lexer.derived-dep-invalide', { varName, dep }))
      }
    }
    const depsArg = forcedDeps.length > 0 ? `, ${forcedDeps.join(', ')}` : ''
    return `$${varName} = µ._mjs_forceDeps(${realExpr}${depsArg})`
  })

  // restaure les chaînes/commentaires masqués avant le scanner (qui
  // ré-isole lui-même les chaînes, et re-tokenise le code des interpolations).
  code = unmaskInert(code, inert.slots)

  // 3. Scanner caractère par caractère — gère strings/comments comme contextes inertes
  let result = ''
  let i = 0
  const n = code.length

  while (i < n) {
    const rest = code.slice(i)

    // 3.1 Comments / heredocs / strings — passe inchangé
    // - `###...###` / `# ...`  Coffee comments
    // - `//...`     line JS/Civet/TS (essentiel : sans ça, une apostrophe dans
    //                un `// L'éditeur` ouvre une string qui consume plusieurs
    //                lignes et casse la tokenisation des `$var` qui suivent)
    // - `/* ... */` block JS/Civet/TS
    // - `#identifier` PRÉSERVÉ : c'est un champ privé JS (Civet le supporte)
    // - `"""..."""` / `'''...'''` heredocs
    // - Strings ` " ' : limitées à une ligne (sinon une apostrophe non-fermée
    //                   mange jusqu'à la prochaine, souvent plusieurs lignes plus loin)
    //
    // Note : la conversion `#` Coffee → `//` Civet (Civet parse `#` comme
    // `this.length(...)`) se fait dans `applyMjsSugarToScript` (lang-aware),
    // pas ici — le lexer doit rester langage-agnostique.
    // NB sécurité : `\\` est EXCLU des classes négatives ([^\\`] etc.) pour que
    // les branches `\\.` et `[^...]` soient disjointes — sinon une chaîne non
    // fermée pleine de backslashes déclenche un backtracking exponentiel
    // (ReDoS build-time : ~40 backslashes ≈ 10 s de gel du watcher).
    // Gabarit à backtick : lu au NIVEAU (scanTemplateAt, MÊME lecteur que scanInertAt/
    // maskInert, partage l'imbrication backtick/interpolation) plutôt que par l'ancienne
    // alternative de la grande regex ci-dessous, qui se refermait au 1er backtick INTERNE
    // rencontré : sur un gabarit imbriqué dans une interpolation
    // (`` `a${ `inner${1}inner` }b` ``), elle tronquait le token au 2e backtick au lieu du
    // 6e, et `interpolateSigils` complétait alors avec une `}` FANTÔME (absente de la
    // source) — JS généré corrompu. Un littéral NON TERMINÉ (`scanTemplateAt` rend -1) n'est
    // PAS pris ici : repli sur la suite du scanner, comme avant (aucun cas ne le matchait).
    if (code[i] === '`') {
      const e = scanTemplateAt(code, i)
      if (e !== -1) {
        result += interpolateSigils(code.slice(i, e), '$', opts)
        i = e
        continue
      }
    }

    let m = rest.match(
      /^(###[\s\S]*?###|#(?![a-zA-Z_])[^\n]*|\/\/[^\n]*|\/\*[\s\S]*?\*\/|"""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^\\"\n])*"|'(?:\\.|[^\\'\n])*')/
    )
    if (m) {
      const tok = m[0]
      const c0 = tok[0]
      // Chaînes INTERPOLABLES : le contenu des `#{...}` (Coffee/Civet, dans
      // `"..."` et heredocs `"""..."""`) est du CODE → il faut y tokeniser les
      // sigils `$x`. Sans ça, un `"texte #{$x}"` laisse `$x` littéral →
      // ReferenceError au runtime. Les chaînes simples (`'...'`, `'''...'''`)
      // et les commentaires passent inertes (pas d'interpolation).
      if (c0 === '"') {
        result += interpolateSigils(tok, '#', opts)
      } else {
        result += tok
      }
      i += tok.length
      continue
    }

    // 3.1a — littéral regex `/…/` : ZONE INERTE au même titre qu'une chaîne — sans ce garde-fou,
    // `x = /§/` levait la garde « § nu » et `re = /µTotal/` sortait réécrit `/µ.Total/` EN PLEIN
    // MILIEU du littéral. Heuristique PARTAGÉE avec le parser (sigils.ts,
    // ouvreUneRegex sur le texte déjà émis `result`) : un `/` en position d'EXPRESSION ouvre une
    // regex, en position de VALEUR il divise — `scanRegexLiteral` rend -1 si aucun `/` fermant
    // n'apparaît avant la fin de ligne (une division ne se referme jamais), et ce `/` retombe
    // alors sur les règles suivantes (code normal, division comprise).
    if (code[i] === '/' && ouvreUneRegex(result)) {
      const fin = scanRegexLiteral(code, i)
      if (fin !== -1) { result += code.slice(i, fin); i = fin; continue }
    }

    // 3.1b &$xxx RETIRÉ : le « vault » a fusionné dans le store global `$$`.
    //      Erreur explicite plutôt que laisser `&` + `$x` produire `&$.x`.
    m = rest.match(/^&\$([a-zA-Z0-9_]+)/)
    if (m) throw vaultRemovedError(m[1])

    // 3.1c &xxx → µ.url.params.xxx : PARAM DE ROUTE, lecture réactive. `µ.url`
    //      est maintenu par le routeur, donc `&id` ≡ `µ.url.params.id` — SANS
    //      injection d'attribut DOM (fini la collision `:id` ↔ attribut natif
    //      `id`/`class`/…). Désambiguïsation robuste au caractère, à la compil :
    //        • param : `&` suivi IMMÉDIATEMENT d'un identifiant ET en position
    //          « préfixe » — le caractère juste AVANT `&` est le début du flux,
    //          un espace, ou un OUVRANT/séparateur `( [ { , = : ; ?`. Jamais
    //          après un opérande : lettre/chiffre/_/guillemet NI un FERMANT
    //          `) ] }` (résultat d'appel/index/bloc) NI un autre `&`.
    //        • ET-binaire `a & b` / `a&b` / `a&&b` : opérande (ou 2ᵉ `&`) avant,
    //          ou espace juste APRÈS le `&` (`& b`) → non-match, `&` laissé tel quel.
    //        • entité HTML `&amp;` (suivie de `;`) / `&#123;` (`#`, pas un ident)
    //          → non-match.
    m = rest.match(/^&([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m) {
      const before = i > 0 ? code[i - 1] : ''       // char juste AVANT le '&'
      const after = rest.charAt(m[0].length)         // char juste APRÈS l'identifiant
      const prefixOk = before === '' || /[\s(\[{,=:;?]/.test(before)
      // en CONTEXTE SCRIPT le `;` est un terminateur d'instruction
      // (idiome js/ts), pas un marqueur d'entité : `const p = &id;` ne doit PAS
      // être pris pour une entité. On restreint la garde aux entités NOMMÉES
      // réelles (les numériques `&#123;` ne matchent déjà pas `[a-zA-Z_]`).
      const isEntity = after === ';' && /^(?:amp|lt|gt|quot|apos|nbsp)$/i.test(m[1])
      if (prefixOk && !isEntity) {
        result += `µ.url.params.${m[1]}`
        i += m[0].length
        continue
      }
      // sinon : ET-binaire ou entité → le `&` retombe sur le fallthrough caractère.
    }

    // 3.2 $$xxx → µ.store.xxx : STORE GLOBAL réactif, zéro import (µ.store =
    //     µ.state({}) au runtime, cf. mjs_store_globals.ts). Aligné avec le generator
    //     (cleanJs émet déjà `µ.store.x`). Le store global se lit `$$X` partout ;
    //     il se déclare via `export µ$$X` (module). Le singleton importé, lui,
    //     se CONSOMME via `µ$$X` (pas `$$X`) — cf. modèle des sigils.
    // 1er caractère restreint à `[a-zA-Z_]` (pas de chiffre en tête) :
    // `$$9lives` produisait `µ.store.9lives` (accès membre illégal → SyntaxError
    // lointaine). Le token non conforme reste littéral (identifiant JS valide).
    m = rest.match(/^\$\$([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m) {
      // Garde : un singleton importé (`@import µ$$X` → `$X` ∈ externalVars) se
      // consomme en `µ$$X`, PAS en `$$X` (qui est le store GLOBAL). Sinon lecture
      // silencieuse du mauvais store → erreur de compilation explicite.
      if (externalVars.includes(`$${m[1]}`)) throw importedSingletonError(m[1])
      result += `µ.store.${m[1]}`; i += m[0].length; continue
    }

    // 3.3 §§xxx → CONTEXTE réactif de sous-arbre, TOUJOURS (plus aucune
    //     résolution vers un singleton importé — cf. pré-passe 2-bis, même
    //     bascule). Ce fallback n'est qu'un filet défensif si un `§§` de
    //     lecture atteignait quand même le scanner (2-bis couvre déjà la
    //     quasi-totalité des cas réels).
    // Charset uniformisé `[a-zA-Z_]\w*` (comme les pré-passes 2-bis) :
    // avant, ce fallback acceptait un chiffre en tête et divergeait de cleanJs.
    m = rest.match(/^§§([a-zA-Z_]\w*)/)
    if (m) {
      result += `this._mjs_getRCtx('${m[1]}')`
      i += m[0].length
      continue
    }

    // 3.3-bis §/§§ NU (non suivi d'un nom) : survécu aux pré-passes 1/2/2-bis (aucune ne
    //         consomme un §/§§ sans identifiant collé derrière) — refus explicite plutôt
    //         qu'un caractère qui atteint Civet tel quel (message cryptique). Corps
    //         PARTAGÉ (sigils.ts), même garde que RE_RAW_ACCESS_MALFORME (règle 3.5).
    m = rest.match(RE_BARE_SECTION)
    if (m) throw bareSectionError(m[0])

    // 3.4 @@xxx → _mjsThis.xxx  (pas de chiffre en tête → `@@2fa` reste littéral)
    m = rest.match(/^@@([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m) { result += `_mjsThis.${m[1]}`; i += m[0].length; continue }

    // 3.5 µread $x / µwrite $x, v → _mjsThis._state.x — accès NON réactif explicite
    //      (remplace l'ancien sigil $__x, RETIRÉ). `µread $x` lit le slot sans
    //      poser de dépendance ; `µwrite $x, v` écrit le slot sans notifier
    //      (la valeur après la virgule suit telle quelle, cf. RAW_WRITE_BODY,
    //      sigils.ts). On consomme la rune + le `$x` d'un bloc AVANT que la
    //      règle 3.8 ne transforme `$x` en `$.x` (proxy tracké).
    // (même piège qu'analyzer.ts
    // autoDeclareFromTemplate) — 1er caractère après `$` restreint à `[a-zA-Z]` :
    // `µread $_secret` (underscore juste après le sigil) ne matchait PAS cette
    // règle. **Vérifié empiriquement** : `µread`/`µwrite` restaient alors des
    // identifiants LITTÉRAUX non définis dans le JS généré (`µread $._secret`,
    // le `$_secret` séparément retombé sur la règle générique du Proxy tracké)
    // → `ReferenceError: µread is not defined` à l'exécution. `_` est un 1er
    // caractère d'identifiant JS valide, aucune raison de l'exclure ici.
    // Depuis, le CORPS du motif vit en source UNIQUE (sigils.ts), consommé
    // aussi par cleanJs — la dérive lexer↔generator est morte par
    // construction.
    // Parenthèses OPTIONNELLES : `µread($x)` d'abord (le corps NU exige un
    // espace puis `$`, il ne peut pas matcher une forme parenthésée — l'ordre n'est
    // donc qu'une convention de lecture), puis la forme nue.
    // Accès MEMBRE (`obj.µread`, `a.µwrite = 1`) : ce n'est PAS la rune, c'est une
    // propriété qui porte ce nom — cleanJs l'exclut depuis toujours par son lookbehind
    // `(?<![\w.])`, le lexer ne le faisait pas. Divergence :
    // `a.µread $x` compilait en `a._mjsThis._state.x`
    // (non-sens, en silence) et, le garde élargi, `obj.µwrite = 1` levait à tort.
    const avant = i > 0 ? code[i - 1] : ''
    if (!(avant === '.' || /[a-zA-Z0-9_$]/.test(avant))) {
      m = rest.match(RE_RAW_ACCESS_PAREN) || rest.match(RE_RAW_ACCESS)
      if (m) {
        // Statisation $$ : `µread $$x` → accès BRUT au store (m[1] = '$'),
        // `µread $x` → slot local inchangé.
        result += (m[1] ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + m[2]
        i += m[0].length
        continue
      }

      // µwrite $x, v / µwrite($x, v) — le corps s'arrête à la virgule, `v` continue
      // tel quel dans le flux (sigils.ts, RAW_WRITE_BODY). Forme parenthésée : une
      // parenthèse ouvrante FRAÎCHE remplace `µwrite(`, la fermante d'origine (jamais
      // consommée ici) referme celle-là.
      m = rest.match(RE_RAW_WRITE_PAREN)
      if (m) {
        result += RAW_WRITE_PAREN_OUT_OPEN + (m[1] ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + m[2] + ' = '
        i += m[0].length
        continue
      }
      m = rest.match(RE_RAW_WRITE)
      if (m) {
        result += (m[1] ? RAW_ACCESS_STORE_OUT : RAW_ACCESS_OUT) + m[2] + ' = '
        i += m[0].length
        continue
      }

      // Ancienne forme `µwrite $x = v` / `µwrite($x) = v` (RETIRÉE) :
      // message dédié plutôt que la garde générique plus bas.
      if (RE_RAW_WRITE_OLD_FORME_PAREN.test(rest) || RE_RAW_WRITE_OLD_FORME.test(rest)) throw rawWriteAncienneFormeError()

      // …et ce qui reste est une faute de forme : refus BRUYANT plutôt qu'un
      // identifiant littéral qui casse au navigateur avec un build vert.
      if (RE_RAW_ACCESS_MALFORME.test(rest)) throw rawAccessFormeError()
    }

    // 3.6-pré Garde-fou hooks : l'ancienne forme `@mount ->` (appel de la
    //      méthode d'enregistrement, retirée du runtime) casserait en silence
    //      → erreur de compilation explicite orientant vers la rune µ. Les
    //      noms restent LIBRES pour de vraies méthodes (`@mount = ->`, appels
    //      `@mount(x)`) : seule la silhouette hook est bloquée.
    m = rest.match(RE_OLD_HOOK)
    if (m) {
      throw new Error(t('lexer.hook-arobase-retire', { hook: m[1] }))
    }

    // 3.6 @xxx → this.xxx  (pas de chiffre en tête → `@2fa` reste littéral)
    m = rest.match(/^@([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m) { result += `this.${m[1]}`; i += m[0].length; continue }

    // 3.7 Snapshot — désactiver la dérivation : $xxx =: expr → $.xxx = µ.snap expr
    // Note : on n'utilise PAS `:=` (qui est réservé `const` côté Civet) pour
    // éviter toute collision avec le langage source. La syntaxe MJS est `=:`.
    // Pas de chiffre en tête (aligné sur les autres sigils).
    m = rest.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*=:[ \t]*/)
    if (m) {
      const varName = `$${m[1]}`
      const prefix = (moduleMode || externalVars.includes(varName)) ? varName : `$.${m[1]}`
      result += `${prefix} = µ.snap `
      i += m[0].length
      continue
    }

    // 3.8-pré Garde-fou `$xxx := expr` : `:=` est l'opérateur de DÉCLARATION
    //      Civet (cf. note 3.7 ci-dessus — même collision, jamais utilisée côté
    //      MJS pour cette raison). Un `$xxx` bare, une fois réécrit `$.xxx` par
    //      la règle 3.8 juste en dessous, donnerait `$.xxx := expr` — Civet ne
    //      s'y oppose PAS (compile tel quel en `const $.xxx = expr`, cible
    //      non-identifiant d'un `const` : JS invalide) : le vrai crash n'arrivait
    //      QU'ENSUITE, loin de la vraie faute, au parse acorn de l'Analyzer MJS
    //      (« [analyzer] parse error: Unexpected token », découvert par test réel).
    //      On intercepte ICI, avant que la réécriture `$.xxx` ne
    //      rende le motif méconnaissable en aval. Même garde que 3.8 pour savoir
    //      si CE `$xxx` serait réellement réécrit : en moduleMode/externalVars,
    //      `$xxx` reste un identifiant Civet ordinaire (`$xxx := expr` y compile
    //      en `const $xxx = expr`, JS parfaitement valide) — aucun risque, on
    //      laisse filer sans throw (retombe sur 3.8 juste en dessous).
    m = rest.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)[ \t]*:=/)
    if (m) {
      const varName = `$${m[1]}`
      if (!(moduleMode || externalVars.includes(varName))) {
        const preview = rest.slice(m[0].length).match(/^[ \t]*([^\n;]*)/)?.[1]?.trim() || '...'
        throw new Error(t('lexer.symbole-declare-civet', { varName, preview }))
      }
    }

    // 3.8 $xxx → $.xxx (sauf moduleMode ou externalVars). Un `$xxx` ∈ externalVars
    //     est un singleton importé : on garde `$xxx` (sa forme compilée). La FAUTE
    //     de le consommer en `$xxx` (au lieu de `µ$$xxx`) est détectée par le lint
    //     singleton sur le SOURCE du dev (pas ici : le lexer tourne aussi sur du
    //     code déjà routé `µ$$`→`$xxx`).
    // 1er caractère `[a-zA-Z_]` (pas de chiffre) — `$9` reste littéral.
    m = rest.match(/^\$([a-zA-Z_][a-zA-Z0-9_]*)/)
    if (m) {
      const varName = `$${m[1]}`
      result += (moduleMode || externalVars.includes(varName)) ? varName : `$.${m[1]}`
      i += m[0].length
      continue
    }

    // 3.8b µXxx (PascalCase) → µ.Xxx : accès namespacé aux classes/objets du
    //      framework sans le point (µRouter → µ.Router, µStore → µ.Store,
    //      µElement → µ.Element). Symétrique du sucre `µinspect`. Ne matche QUE
    //      si une MAJUSCULE suit `µ` : les runes minuscules (µeffect, µeasing…)
    //      et la forme déjà pointée (`µ.Router` : après `µ` vient `.`) ne sont
    //      pas touchées.
    m = rest.match(RE_MU_PASCAL)
    if (m) { result += `µ.${m[1]}`; i += m[0].length; continue }

    // 3.8c-pré Hooks de cycle de vie : µmount/µawake/µsleep/µdestroy/
    //      µurlChange/µfailed + callback → enregistrement via l'API interne
    //      unique. `µmount ->` devient `this._mjs_hook 'mount', ->` (appel
    //      implicite Coffee — la sortie du lexer repasse par Civet). DOIT
    //      précéder 3.8c : `µurlChange` contient `µurl` (le lookahead de
    //      MU_SHORT_BODY protège déjà, l'ordre rend l'intention lisible).
    m = rest.match(RE_MU_HOOKS)
    if (m) { result += `this._mjs_hook '${m[1]}',`; i += m[0].length; continue }

    // 3.8c µxxx (minuscules, allowlist) → µ.xxx : GLOBALES du framework en
    //      forme courte — µurl (URL réactive maintenue par le routeur),
    //      µonline/µvisible/µready (environnement, mjs_store_globals),
    //      µserver (contexte SSR/client, valeur simple NON réactive — seule
    //      nuance avec le trio précédent, cf. mjs_store_globals.ts), et les
    //      fabriques temps réel µsocket(url)/µsmooth(src) (mjs_socket, mjs_smooth).
    //      Allowlist STRICTE (définie dans sigils.ts, partagée avec cleanJs) :
    //      les runes minuscules à compilation dédiée (µeffect, µspring,
    //      µeasing…) et tout autre identifiant restent intacts ; la forme
    //      pointée (`µ.url`) ne matche pas (`.` après `µ`).
    m = rest.match(RE_MU_SHORT)
    if (m) { result += `µ.${m[1]}`; i += m[0].length; continue }

    // 3.8d µlang → µ.store.__mjsLang : langue courante (clé store INTERNE
    //      cachée, cf. sigils.ts) — lecture/écriture héritent ensuite de
    //      toute la plomberie $$ existante (analyzer, réactivité, µ._storeSet).
    m = rest.match(RE_MU_LANG)
    if (m) { result += MU_LANG_OUT; i += m[0].length; continue }

    // 3.8e µtheme → µ.store.__mjsTheme : thème courant, CALQUE EXACT de 3.8d.
    m = rest.match(RE_MU_THEME)
    if (m) { result += MU_THEME_OUT; i += m[0].length; continue }

    // 3.9 Identifier classique (préservé tel quel)
    m = rest.match(/^[a-zA-Z_$][a-zA-Z0-9_$]*/)
    if (m) { result += m[0]; i += m[0].length; continue }

    // 3.10 Tout autre caractère
    result += code[i]
    i += 1
  }

  return result
}
