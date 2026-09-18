// transpiler/sections — extraction des sections <script module>, <script>, <style>, HTML.
// Port de la section "extraction" de la V1 Ruby, transpiler.rb.

import type { SupportedLang } from '../languages/index.js'
import { dedent } from '../generator/state.js'
import { maskInertSameLength } from '../lexer/index.js'
import { t } from '../messages/index.js'
import { parseVtValue, suggestKey } from '../bundler/config.js'
import { findMacroTagEnd } from './macro-tag.js'

export interface ScriptSection {
  raw: string
  lang: SupportedLang
  /** ligne 1-based du `.mjs` où DÉBUTE le contenu du bloc (après la balise ouvrante) —
   * `dedent()` conserve le nombre de lignes, donc ce numéro reste l'offset constant à
   * appliquer à une carte de source produite sur `raw`. `1` par défaut (section absente). */
  startLine: number
}

export interface StyleSection {
  raw: string
  lang: 'css' | 'sass' | 'scss'
  /** Noms des CSS partagés (`<style @css="base typo">`, relogé racine → attribut). */
  sharedCssNames: string[]
  /** Override du `:host{display:X}` (`<style @display="inline-block">`). */
  moduleDisplay: string
  /** Transitions de page par défaut du module (`<style @viewTransition.<nom>={…}>`) —
   *  chaîne VERBATIM (`<nom>` ou `<nom>={ direction: …, duration: …, priority: … }`),
   *  relue au runtime par µ._mjs_vtParse (mjs_vt_presets.ts) ; null si absente. */
  moduleViewTransition: string | null
  /** Priorité (façon z-index) de `@viewTransition`/`@vt` — cf. directives.ts
   *  (ancien porteur du champ), EXTRAITE de l'option `priority:`. Défaut 1. */
  moduleViewTransitionPriority: number
}

/** Un bloc `<style name="bandeau">` : un VARIANT de forme du composant, sorti
 * par le build dans un fichier à part et chargée seulement quand un `layout="bandeau"`
 * apparaît. Le `<style>` sans nom reste le style de base, embarqué dans le composant. */
export interface LayoutSection {
  raw: string
  lang: 'css' | 'sass' | 'scss'
  name: string
}

/** Un bloc `<theme>` du composant : déclaration de variables de thème.
 * `name` vide = le thème de base du composant (posé sur :host) ; `name` renseigné
 * = une variante, activée par l'attribut `theme="<name>"` sur l'instance. */
export interface ThemeSection {
  raw: string
  lang: 'css' | 'sass' | 'scss'
  name: string
}

/** Un bloc `<routes target="…">` du composant : table de routes FIXES pour
 * l'outlet `<@view id="target">` visé — alternative déclarative à `@routes`
 * (réservé, lui, aux tables calculées en boucle). `entries` : chemin → nom
 * de composant kebab-case, dans l'ordre d'écriture. */
export interface RoutesSection {
  raw: string
  target: string
  entries: [string, string][]
}

export interface SectionsResult {
  module: ScriptSection
  script: ScriptSection
  style: StyleSection
  layouts: LayoutSection[]
  themes: ThemeSection[]
  routes: RoutesSection[]
  html: string
  /** ligne 1-based du `.mjs` où DÉBUTE le HTML rendu ci-dessus : les blocs retirés laissent un
   * commentaire de MÊME hauteur (cf. boucle de découpe), seul le `.trim()` final décale. Sert à
   * citer une ligne juste dans les erreurs posées sur cette section (processGlobalMacros). */
  htmlStartLine: number
  /** un 2e `<script module>`,
   * `<script>` (hors module), ou `<style>` était SILENCIEUSEMENT jeté (seul le
   * PREMIER de chaque catégorie était gardé) — perte de code sans le moindre
   * signal. Un simple warning a d'abord comblé ce trou (non vide dès qu'une
   * catégorie a plus d'UNE occurrence) ; un doublon lève
   * désormais `throw new Error(...)` (ERREUR DE COMPILATION), donc plus AUCUN
   * producteur ne remplit ce champ depuis `extractSections` elle-même. Conservé
   * (jamais rempli, toujours `[]`) car d'autres maillons de la chaîne le lisent
   * encore (`TranspileData.sectionWarnings`, `IncludeAccumulator.warnings`). */
  warnings: string[]
}

const DEFAULT_SCRIPT_LANG: SupportedLang = 'civet'
const DEFAULT_STYLE_LANG: 'css' | 'sass' | 'scss' = 'sass'

// ----------------------------------------------------------------------------
// extractLang — repère `lang="…"` dans une chaîne d'attributs
// ----------------------------------------------------------------------------
function extractLang(attrs: string): string | null {
  const m = attrs.match(/lang=['"]([^'"]+)['"]/)
  return m ? m[1] : null
}

// extractAttr — même principe que extractLang, pour le `name=` d'un <theme>
function extractAttr(attrs: string, nom: string): string {
  const m = attrs.match(new RegExp(`${nom}=['"]([^'"]*)['"]`))
  return m ? m[1] : ''
}

// extractAttrValue — variante d'extractAttr pour un nom d'attribut portant un `@`
// (littéral en regex, aucun échappement nécessaire) ; null si absent.
function extractAttrValue(attrs: string, nom: string): string | null {
  const m = attrs.match(new RegExp(`${nom}=(['"])([^'"]*)\\1`))
  return m ? m[2] : null
}

// noms d'attributs d'une balise de section, base avant le 1er `.` (`@viewTransition.zoom` → `@viewTransition`)
const SECTION_ATTR_RE = /(@?[a-zA-Z][a-zA-Z0-9:_.-]*)(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]+))?/g

// attribut inconnu sur <style>/<script>/<theme>/<routes> = ERREUR : ces balises n'atteignent jamais le DOM, rien d'autre que la liste attendue n'y a de sens — suggestion à ≤2 lettres quand il y en a une
function checkSectionAttrs(tag: string, attrs: string, allowed: string[]): void {
  for (const m of attrs.matchAll(SECTION_ATTR_RE)) {
    const base = m[1].split('.')[0]
    if (allowed.includes(base)) continue
    const attendus   = allowed.join(', ')
    const suggestion = suggestKey(base, allowed)
    if (suggestion) throw new Error(t('transpiler.section-attribut-inconnu-suggestion', { tag, attribut: m[1], suggestion, attendus }))
    throw new Error(t('transpiler.section-attribut-inconnu', { tag, attribut: m[1], attendus }))
  }
}

// extractStyleViewTransition — repère `@viewTransition` sur `<style …>` et rend son RESTE BRUT,
// tel quel : c'est l'APPELANT qui juge, exactement comme le fait déjà `<@view @viewTransition…>`
// (transpiler/index.ts, même grammaire). `rest: undefined` = forme NUE, sentinel 'on' posé par
// l'appelant. `aliasVt` = écrit `@vt` — ALIAS RETIRÉ sur `<style>` (reste vivant à la racine du
// fichier pour le message, directives.ts, et sur `<a @vt="…">`, mécanisme UJS distinct).
//
// ⚠ FAMILLE « GARDE MUETTE » — la version d'avant rendait `null` sur
// `.cube:left` et sur `={expr}` : EXACTEMENT ce que rend « pas d'attribut du tout ». Les deux
// écritures partaient à la poubelle sans un mot — ni transition, ni erreur — alors que la doc les
// annonçait comme des erreurs de compilation. D'où les deux changements ici : le nom accepte
// `:` et `_` EXPRÈS (pour que la forme fautive ARRIVE jusqu'au juge, qui la refuse avec le message
// dédié), et le second filet rattrape tout ce qui échapperait encore à la grammaire.
function extractStyleViewTransition(attrs: string): { rest: string | undefined, aliasVt: boolean, label: string, malformed: boolean } | null {
  const m = attrs.match(/@(viewTransition|vt)(\.[a-zA-Z][a-zA-Z0-9:_-]*(?:[ \t]*=[ \t]*\{[^}]*\})?|=(?:"[^"]*"|'[^']*'|\{[^}]*\}|[^\s>]*))?(?=[ \t]|$)/)
  if (m) return { rest: m[2], aliasVt: m[1] === 'vt', label: `@${m[1]}`, malformed: false }
  const brut = attrs.match(/@(viewTransition|vt)\b([^\s>]*)/)
  if (!brut) return null
  return { rest: brut[2], aliasVt: brut[1] === 'vt', label: `@${brut[1]}`, malformed: true }
}

// findRelocatedStyleAttrToken — un des attributs `@css`/`@display`/`@viewTransition`/`@vt`
// posé sur ce `<style>` (peu importe valué ou nu) — sert à interdire ces attributs
// sur un `<style name="…">` (variant/layout).
function findRelocatedStyleAttrToken(attrs: string): string | null {
  const m = attrs.match(/@(css|display|viewTransition|vt)\b/)
  return m ? `@${m[1]}` : null
}

// nom de variante : minuscules/chiffres/tirets — il finit en sélecteur d'attribut
const THEME_NAME_RE = /^[a-z][a-z0-9-]*$/

// nom de composant kebab-case, SANS le préfixe `mjs-` — même contrainte que les valeurs
// de l'objet `@routes` calculé (transpiler/index.ts).
const ROUTE_COMPONENT_RE = /^[a-z][a-z0-9-]*$/
const ROUTE_PARAM_RE          = /^:[a-zA-Z_][a-zA-Z0-9_]*$/
const ROUTE_OPTIONAL_PARAM_RE = /^\(:[a-zA-Z_][a-zA-Z0-9_]*\)$/
const ROUTE_OPTIONAL_LITERAL_RE = /^\([^():*\s]+\)$/

// validateRoutePath — un chemin de `<routes>` doit matcher exactement ce que le routeur
// runtime sait traiter (`src/runtime/mjs_router.ts`, `_matchSegs`) : segments littéraux,
// `:param`, `*` catch-all (dernier segment SEULEMENT — capture le reste), `(:param)`
// optionnel À N'IMPORTE QUELLE POSITION. L'optionnel MÉDIAN était refusé ici au motif que
// le routeur ne saurait pas revenir en arrière — c'est faux depuis le retour arrière de
// `_matchSegs` (`tests/router-optional-mid-segment.test.ts` prouve `/a/(:x)/b` et même deux
// optionnels médians consécutifs). Le validateur était donc PLUS STRICT que le moteur qu'il
// alimente : `@routes` acceptait un motif que le bloc rejetait, et migrer d'une forme à
// l'autre cassait la compilation (parité).
function validateRoutePath(path: string): boolean {
  const segs = path.slice(1).split('/').filter(s => s.length > 0)
  for (let i = 0; i < segs.length; i++) {
    const seg    = segs[i]
    const isLast = i === segs.length - 1
    if (seg === '*') { if (!isLast) return false; continue }
    // `(…)` = segment facultatif : `(:param)` capture, `(littéral)` ne capture rien (préfixe
    // d'URL optionnel). Le routeur traite les deux (`_matchSegs`, mjs_router.ts) — le bloc les
    // refusait, `@routes` les acceptait : même écart de parité que l'optionnel médian
    if (seg[0] === '(') { if (!ROUTE_OPTIONAL_PARAM_RE.test(seg) && !ROUTE_OPTIONAL_LITERAL_RE.test(seg)) return false; continue }
    if (seg[0] === ':') { if (!ROUTE_PARAM_RE.test(seg)) return false; continue }
    // segment littéral : tout sauf espace (déjà exclu par le découpage \S+ de parseRoutesLines)
  }
  return true
}

// parseRoutesLines — mini-parseur du CORPS d'un bloc `<routes target="…">` : une route
// par ligne (`<chemin>` puis espaces/tabulations puis `<nom-de-composant>`), lignes vides
// ignorées, ligne commençant par `#` = commentaire. Exportée pour être testée seule.
export function parseRoutesLines(raw: string, target: string): [string, string][] {
  const entries: [string, string][] = []
  const seenPaths = new Set<string>()
  const lines = raw.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim()
    if (trimmed === '' || trimmed.startsWith('#')) continue
    const ligne = i + 1
    const m = trimmed.match(/^(\S+)[ \t]+(\S+)$/)
    if (!m) throw new Error(t('transpiler.routes-ligne-invalide', { target, ligne, texte: trimmed }))
    const [, path, component] = m
    if (path[0] !== '/') throw new Error(t('transpiler.routes-chemin-sans-slash', { target, ligne, chemin: path }))
    if (!validateRoutePath(path)) throw new Error(t('transpiler.routes-chemin-mal-forme', { target, ligne, chemin: path }))
    if (!ROUTE_COMPONENT_RE.test(component)) throw new Error(t('transpiler.routes-composant-invalide', { target, ligne, composant: component }))
    if (seenPaths.has(path)) throw new Error(t('transpiler.routes-chemin-double', { target, chemin: path }))
    seenPaths.add(path)
    entries.push([path, component])
  }
  return entries
}

// lineOfOffset — numéro de ligne 1-based d'un offset dans `src` (compte les `\n` avant)
function lineOfOffset(src: string, offset: number): number {
  let n = 1
  for (let i = 0; i < offset; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

// countNewlines — nombre de `\n` dans une plage, sert à choisir un
// remplacement de MÊME hauteur pour un bloc retiré (cf. bandeau sur la boucle de découpe HTML).
function countNewlines(src: string): number {
  let n = 0
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++
  return n
}

// FIX faille lexer de sections — un `</script>`/`</style>` DANS
// un littéral (chaîne, heredoc, commentaire) du CODE tronquait l'extraction
// (les 4 regex de section matchaient à plat sur `scan`, aveugles au contexte).
// Parade : chercher sur une VUE MASQUÉE même-longueur (littéraux → espaces,
// `\n` préservés → offsets alignés sur l'original), puis relire le texte réel
// via `m.indices` (drapeau `d`) — jamais de 2e passe regex sur la tranche
// extraite, qui retomberait dans le même piège.

// masqueur CSS/SASS local — chaînes '…'/"…" + commentaires /*…*/ et //…
// UNIQUEMENT. PAS de règle `#…` (SASS `#123` = couleur hex, pas un commentaire ;
// une règle `#` avalerait `}</style>` sur la même ligne).
const STYLE_INERT_RE = /'(?:\\.|[^\\'\n])*'|"(?:\\.|[^\\"\n])*"|\/\*[\s\S]*?\*\/|\/\/[^\n]*/g

function maskStyleInertSameLength(src: string): string {
  return src.replace(STYLE_INERT_RE, (tok) => tok.replace(/[^\n]/g, ' '))
}

// blankRange — neutralise [start,end) en espaces même-longueur (préserve les `\n`)
function blankRange(src: string, start: number, end: number): string {
  return src.slice(0, start) + src.slice(start, end).replace(/[^\n]/g, ' ') + src.slice(end)
}

// maskHeadFailedBlocks — masque chaque
// `<@head …>…</@head>`/`<@failed …>…</@failed>` de `src`, `>` de la balise
// OUVRANTE retrouvé via `findMacroTagEnd` (macro-tag.ts — même fonction que
// macros.ts) et non plus le premier `>` textuel. AVANT (regex
// `<@(head|failed)\b[^>]*>[\s\S]*?<\/@\1>`) : un `>` niché dans une accolade
// d'attribut coupait la balise au mauvais endroit (`<@head @click={$y > 100}>`
// → coupée à ce `>`-là, un résidu `100}>` fuyait dans le HTML rendu). Frontière
// de nom : le caractère qui suit `head`/`failed` ne doit être ni un caractère
// de mot ni un tiret (`<@headx>`, `<@head-foo>` ignorés, laissés en texte).
// Balise jamais refermée (aucun `>` réel trouvé) ou fermeture
// `</@head>`/`</@failed>` absente → bloc laissé TEL QUEL, comportement
// identique à l'ancienne regex qui ne matchait pas dans ces deux cas (la
// balise jamais refermée sera signalée par `macro-balise-non-fermee`, plus
// tard, quand macros.ts la retraite sous sa forme écouteur/contenu).
function maskHeadFailedBlocks(src: string, masks: string[]): string {
  const lower = src.toLowerCase()
  let out = ''
  let pos = 0
  for (;;) {
    const headIdx = lower.indexOf('<@head', pos)
    const failedIdx = lower.indexOf('<@failed', pos)
    const idx = headIdx === -1 ? failedIdx : (failedIdx === -1 ? headIdx : Math.min(headIdx, failedIdx))
    if (idx === -1) { out += src.slice(pos); return out }
    const name = idx === headIdx ? 'head' : 'failed'
    const nameEnd = idx + `<@${name}`.length
    const boundary = src[nameEnd]
    if (boundary !== undefined && /[\w-]/.test(boundary)) { out += src.slice(pos, idx + 1); pos = idx + 1; continue }
    const tagEnd = findMacroTagEnd(src, nameEnd)
    if (tagEnd === -1) { out += src.slice(pos, idx + 1); pos = idx + 1; continue }
    const closeIdx = lower.indexOf(`</@${name}>`, tagEnd + 1)
    if (closeIdx === -1) { out += src.slice(pos, idx + 1); pos = idx + 1; continue }
    const wholeEnd = closeIdx + `</@${name}>`.length
    masks.push(src.slice(idx, wholeEnd))
    out += src.slice(pos, idx) + `\x00MJSHF${masks.length - 1}\x00`
    pos = wholeEnd
  }
}

// ----------------------------------------------------------------------------
// extractSections — sépare les blocs <script module>, <script>, <style>, HTML
// ----------------------------------------------------------------------------
export function extractSections(content: string, opts: {
  defaultScriptLang?: SupportedLang
  defaultStyleLang?: 'css' | 'sass' | 'scss'
} = {}): SectionsResult {
  const defaultScriptLang = opts.defaultScriptLang ?? DEFAULT_SCRIPT_LANG
  const defaultStyleLang = opts.defaultStyleLang ?? DEFAULT_STYLE_LANG
  const warnings: string[] = []

  // un BOM (U+FEFF) en tête de
  // fichier (PowerShell `Out-File`/Notepad sous Windows) n'est ni un espace ni
  // un tab : les 3 regex d'ouverture ancrées sur `^[ \t]*<script…` ne le
  // sautent pas, AUCUNE section n'est trouvée, tout part en HTML, et l'orphan-
  // guard plus bas throw avec un message qui ne parle que de backtick/chaîne
  // non fermée. `readFileSync(...,'utf-8')` ne strip pas le BOM (Node standard).
  // Strippé ICI, choke point unique par lequel transite tout contenu de
  // composant (`transpile` → `extractSections`, et `<@include>` qui appelle
  // `extractSections` direct) — pas besoin de dupliquer aux points de lecture.
  content = content.replace(/^\uFEFF/, '')

  // MASQUE les blocs <@head>/<@failed> AVANT toute extraction de section.
  // Un `<script src>` (SDK/analytics) ou un `<style>` DANS un <@head> (usage
  // naturel) ne doit PAS être volé comme LA section <script>/<style> du composant
  // (extractSections matche à plat ; ces macros sont traitées bien plus tard par
  // processGlobalMacros). Sans ce masque, le `<script src>` vide du <@head>
  // devenait la section <script>, le vrai script du composant était compté
  // « doublon » et JETÉ → logique perdue + injection head vide. On extrait sur le
  // texte MASQUÉ, puis on restaure les blocs dans le HTML de sortie.
  // Masquage aligné sur `findMacroTagEnd`
  // (voir bandeau de `maskHeadFailedBlocks` ci-dessus) : l'ancienne regex
  // `[^>]*` s'arrêtait au premier `>` textuel, y compris niché dans une
  // accolade d'attribut.
  const macroMasks: string[] = []
  const scan = maskHeadFailedBlocks(content, macroMasks)
  const restoreMacros = (s: string): string =>
    macroMasks.length ? s.replace(/\x00MJSHF(\d+)\x00/g, (_m, i) => macroMasks[Number(i)]) : s

  // vue masquée pour <script module> et <script> : littéraux/commentaires Civet
  // (chaînes, heredocs, `#…`/`###…###`/`//…`/`/*…*/`) → espaces même-longueur.
  const maskedCivet = maskInertSameLength(scan)

  // 1. <script module>
  // `\bmodule\b` (pas la sous-chaîne `module`) : `<script data-modulex>`
  // ne doit pas être classé « module ». Group 1 non-gourmand pour ne pas avaler
  // un `module` situé plus loin. Recherche sur `maskedCivet` (offsets alignés
  // sur `scan`), relecture du texte réel via `m.indices` (drapeau `d`).
  const allModuleScripts = [...maskedCivet.matchAll(/^[ \t]*<script([^>]*?)\bmodule\b([^>]*)>([\s\S]*?)<\/script>/gmd)]
  const moduleMatch = allModuleScripts[0]
  const moduleSection: ScriptSection = { raw: '', lang: defaultScriptLang, startLine: 1 }
  if (moduleMatch) {
    const idx = moduleMatch.indices!
    const attrs = `${scan.slice(...idx[1])} ${scan.slice(...idx[2])}`
    checkSectionAttrs('script', attrs, ['module', 'lang'])
    const explicitLang = extractLang(attrs) as SupportedLang | null
    moduleSection.raw = dedent(scan.slice(...idx[3]))
    moduleSection.lang = explicitLang ?? defaultScriptLang
    moduleSection.startLine = lineOfOffset(scan, idx[3][0])
  }
  if (allModuleScripts.length > 1) {
    throw new Error(t('transpiler.script-module-double', { n: allModuleScripts.length, nAutres: allModuleScripts.length - 1 }))
  }

  // 2. <script> (sans `module`)
  const allScripts = [...maskedCivet.matchAll(/^[ \t]*<script([^>]*)>([\s\S]*?)<\/script>/gmd)]
    .filter(m => !/\bmodule\b/.test(m[1]))
  const standardScript = allScripts[0]
  const script: ScriptSection = { raw: '', lang: defaultScriptLang, startLine: 1 }
  if (standardScript) {
    const idx = standardScript.indices!
    const attrs = scan.slice(...idx[1])
    checkSectionAttrs('script', attrs, ['module', 'lang'])
    const explicitLang = extractLang(scan.slice(...idx[1])) as SupportedLang | null
    script.raw = dedent(scan.slice(...idx[2]))
    script.lang = explicitLang ?? defaultScriptLang
    script.startLine = lineOfOffset(scan, idx[2][0])
  }
  if (allScripts.length > 1) {
    throw new Error(t('transpiler.script-double', { n: allScripts.length, nAutres: allScripts.length - 1 }))
  }

  // vue masquée pour <style> : chaînes/commentaires CSS/SASS (masqueur LOCAL,
  // pas INERT_RE) + plages des <script module>/<script> déjà trouvés neutralisées
  // (un `<style>`/`</style>` littéral DANS un script ne doit pas polluer la
  // recherche du bloc <style> réel).
  let maskedStyle = maskStyleInertSameLength(scan)
  for (const m of [...allModuleScripts, ...allScripts]) {
    const [start, end] = m.indices![0]
    maskedStyle = blankRange(maskedStyle, start, end)
  }
  // Et les COMMENTAIRES HTML : un bloc mis en commentaire (ancienne version gardée en
  // référence, exemple documenté) doit rester INERTE. Ce masquage n'existait qu'au niveau de
  // <routes>, plus bas ; <style name="…"> et <theme>, tous deux NEUFS, ne l'avaient pas — un
  // `<theme name="dark">` commenté ressortait dans `themes`, et avec la version active à côté le
  // build échouait sur « deux blocs <theme name="dark"> » ; seul, le commenté REMPLAÇAIT l'actif.
  // Posé ICI, en amont des trois extractions, pour qu'aucune ne puisse encore l'oublier. Les
  // scripts sont déjà neutralisés au-dessus : un `<!--` dans du code ne peut pas ouvrir de plage.
  // Motif LAZY exigeant `-->` : un `<!--` jamais refermé ne masque rien (pas d'emballement).
  for (const m of [...maskedStyle.matchAll(/<!--[\s\S]*?-->/g)]) {
    maskedStyle = blankRange(maskedStyle, m.index!, m.index! + m[0].length)
  }

  // 3. <style> — le bloc SANS nom est le style de base du composant (embarqué) ; chaque
  // `<style name="bandeau">` est un VARIANT, sorti dans son propre fichier et chargé
  // seulement quand elle sert. Un seul bloc sans nom, un seul par nom.
  const allStyles = [...maskedStyle.matchAll(/^[ \t]*<style([^>]*)>([\s\S]*?)<\/style>/gmd)]
  const style: StyleSection = { raw: '', lang: defaultStyleLang, sharedCssNames: [], moduleDisplay: 'block', moduleViewTransition: null, moduleViewTransitionPriority: 1 }
  const layouts: LayoutSection[] = []
  let styleVus = 0
  for (const m of allStyles) {
    const idx = m.indices!
    const attrs = scan.slice(...idx[1])
    checkSectionAttrs('style', attrs, ['lang', 'name', '@css', '@display', '@viewTransition', '@vt'])
    const nom = extractAttr(attrs, 'name')
    const lang = (extractLang(attrs) as 'css' | 'sass' | 'scss') ?? defaultStyleLang
    const raw = dedent(scan.slice(...idx[2]))
    if (nom === '') {
      styleVus++
      if (styleVus > 1) throw new Error(t('transpiler.style-double', { n: styleVus, nAutres: styleVus - 1 }))
      style.lang = lang
      style.raw  = raw

      // @css/@display/@viewTransition — RELOGÉS : attributs
      // du `<style>` de base, plus des directives racine (cf. directives.ts).
      // `@viewTransition` sans alias `@vt` ici (RETIRÉ, cf. extractStyleViewTransition).
      const cssAttr = extractAttrValue(attrs, '@css')
      if (cssAttr !== null) {
        style.sharedCssNames = cssAttr.split(/[ \t]+/).map(s => s.trim()).filter(s => s.length > 0)
      }
      const displayAttr = extractAttrValue(attrs, '@display')
      if (displayAttr !== null) style.moduleDisplay = displayAttr
      const vt = extractStyleViewTransition(attrs)
      if (vt) {
        // MÊME ORDRE DE JUGEMENT QUE `<@view>` (transpiler/index.ts) : c'est ce qui rend les deux
        // niveaux de navigation interchangeables — une écriture refusée ici l'est aussi là-bas,
        // avec le MÊME message. Le durcissement a fermé les trois écarts.
        const rest: string | undefined = vt.rest
        if (vt.aliasVt) throw new Error(t('transpiler.vt-alias-sur-style-interdit'))
        if (vt.malformed) throw new Error(t('transpiler.viewtransition-forme-invalide-sur-style', { label: vt.label, rest }))
        if (rest === undefined) {
          style.moduleViewTransition = 'on'
        } else if (rest[0] === '.') {
          const dm = rest.match(/^\.([a-zA-Z][a-zA-Z0-9-]*(?::(?:left|right|up|down))?)(?:[ \t]*=[ \t]*\{([^}]*)\})?$/)
          if (!dm) throw new Error(t('transpiler.viewtransition-forme-invalide-sur-style', { label: vt.label, rest }))
          const nameAndDir: string = dm[1]
          const optsRaw: string | undefined = dm[2]
          const base = nameAndDir.split(':')[0]
          if (base === 'off') throw new Error(t('transpiler.vt-off-nexiste-pas', { label: vt.label }))
          if (base === 'on') throw new Error(t('transpiler.vt-on-implicite', { label: vt.label }))
          // Le suffixe `:direction` n'existe plus, la SEULE façon d'orienter est la
          // clé d'option ; le nom le CAPTURE tout de même pour pouvoir le refuser (cf. l'extracteur).
          if (nameAndDir.includes(':')) throw new Error(t('transpiler.vt-direction-plus-dans-nom', { label: vt.label, example: `${vt.label}.cube={ dir: left }` }))
          const verbatim = optsRaw !== undefined ? `${nameAndDir}={${optsRaw}}` : nameAndDir
          const parsed = parseVtValue(verbatim)
          // cast explicite : strictNullChecks:false désactive le narrowing natif des unions
          // discriminées (même piège que directives.ts/bundler/config.ts, cf. leurs commentaires).
          if (!parsed.ok) throw new Error(t('transpiler.vt-nom-erreur-parsing', { label: vt.label, nameAndDir: verbatim, erreur: (parsed as { ok: false, error: string }).error }))
          // AUCUN CONTRÔLE DE LA BASE ICI (revenant sur le durcissement
          // du matin) : `µ._vtPresets` reste garnissable par l'appli, et un nom qu'on ne connaît pas
          // au build peut très bien exister au runtime. Le nom mal tapé retombe sur le `µ.warn` de
          // `µ._mjs_vtApplyPreset`. Seuls les deux refus de FORME restent — le suffixe `:direction`
          // ci-dessus et l'étiquette calculée plus bas : eux ne dépendent d'aucun dictionnaire.
          const okParsed = parsed as { ok: true, value: { priority: number | null } }
          style.moduleViewTransition = verbatim
          if (okParsed.value.priority != null) style.moduleViewTransitionPriority = okParsed.value.priority
        } else if (rest[1] === '"' || rest[1] === "'") {
          throw new Error(t('transpiler.viewtransition-guillemets-sur-style', { label: vt.label }))
        } else if (rest[1] === '{') {
          throw new Error(t('transpiler.viewtransition-etiquette-calculee-interdite', { expr: rest.slice(2, -1) }))
        } else {
          throw new Error(t('transpiler.viewtransition-forme-invalide-sur-style', { label: vt.label, rest }))
        }
      }
    } else {
      const forbidden = findRelocatedStyleAttrToken(attrs)
      if (forbidden) throw new Error(t('transpiler.style-attr-sur-layout', { attribut: forbidden, nom }))
      if (!THEME_NAME_RE.test(nom))                 throw new Error(t('transpiler.layout-name-invalide', { nom }))
      if (layouts.some(ly => ly.name === nom))      throw new Error(t('transpiler.layout-double', { nom }))
      layouts.push({ raw, lang, name: nom })
    }
  }

  // 3-bis. <theme> — mêmes règles de masquage que <style> (c'est du SASS), plus les
  // plages du <style> déjà trouvé neutralisées : un `<theme>` cité DANS le style (ou
  // dans un script) ne doit pas être pris pour une section. Contrairement à <style>,
  // PLUSIEURS blocs sont permis — un seul sans nom, un seul par nom.
  let maskedTheme = maskedStyle
  for (const m of allStyles) {
    const [start, end] = m.indices![0]
    maskedTheme = blankRange(maskedTheme, start, end)
  }
  const allThemes = [...maskedTheme.matchAll(/^[ \t]*<theme\b([^>]*)>([\s\S]*?)<\/theme>/gmd)]
  const themes: ThemeSection[] = []
  for (const m of allThemes) {
    const idx = m.indices!
    const attrs = scan.slice(...idx[1])
    checkSectionAttrs('theme', attrs, ['name', 'lang'])
    const name = extractAttr(attrs, 'name')
    if (name !== '' && !THEME_NAME_RE.test(name)) throw new Error(t('transpiler.theme-name-invalide', { nom: name }))
    if (themes.some(th => th.name === name)) throw new Error(t('transpiler.theme-double', { nom: name }))
    themes.push({
      raw:     dedent(scan.slice(...idx[2])),
      lang:    (extractLang(attrs) as 'css' | 'sass' | 'scss') ?? defaultStyleLang,
      name,
    })
  }

  // 3-ter. <routes target="…"> — bloc racine, RÉPÉTABLE (un par outlet), table de routes
  // FIXES. Même masquage que <theme> plus les plages des <theme> déjà trouvés neutralisées.
  let maskedRoutes = maskedTheme
  for (const m of allThemes) {
    const [start, end] = m.indices![0]
    maskedRoutes = blankRange(maskedRoutes, start, end)
  }
  // (les commentaires HTML sont masqués une seule fois, en amont de `maskedStyle` — ce masquage
  // vivait ici, il couvre désormais <style>, <style name>, <theme> ET <routes>)
  const allRoutesBlocks = [...maskedRoutes.matchAll(/^[ \t]*<routes\b([^>]*)>([\s\S]*?)<\/routes>/gmd)]
  const routes: RoutesSection[] = []
  for (const m of allRoutesBlocks) {
    const idx = m.indices!
    const attrs  = scan.slice(...idx[1])
    checkSectionAttrs('routes', attrs, ['target'])
    const target = extractAttr(attrs, 'target')
    if (target === '') throw new Error(t('transpiler.routes-target-manquant'))
    if (routes.some(r => r.target === target)) throw new Error(t('transpiler.routes-target-double', { target }))
    const raw = dedent(scan.slice(...idx[2]))
    routes.push({ raw, target, entries: parseRoutesLines(raw, target) })
  }

  // 4. HTML : tout sauf les <script>/<style>/<theme>/<routes> déjà repérés (au plus
  //    1 script et les doublons ont déjà levé throw ci-dessus). Retrait par PLAGES d'offsets
  //    (jamais une regex ré-exécutée sur `scan` — même piège que le bug corrigé),
  //    puis restauration des blocs <@head>/<@failed> masqués en tête de fonction.
  // Un bloc retiré SANS rien à sa place décale vers le HAUT
  // toutes les lignes qui le suivent : le parseur et le générateur (`node.line`/`currentLine`
  // posés sur CE `html`) citent alors un numéro FAUX pour toute erreur après un <script>/
  // <style>/<theme>/<routes> (`{await}` en ligne 6 du .mjs cité « ligne 2 »). Remplacé par un
  // commentaire HTML inerte de MÊME hauteur (mêmes `\n` que le bloc retiré) : `parseComment`
  // (parser/index.ts) ne produit NI texte NI nœud pour un commentaire — zéro trace dans l'AST,
  // dans `surgicalHtml` ou dans la sortie compilée, seuls les OFFSETS DE LIGNE du reste du
  // gabarit restent justes.
  // SEUIL `> 0` retour à la ligne, volontaire : un bloc qui tient sur UNE SEULE ligne (aucun
  // `\n` interne) laisse `extractSections(...).html` byte-identique à avant (padding omis) —
  // tests/sections-macro-tag.test.ts (s1-s4, `<script>real=1</script>` etc.) compare CE champ
  // au caractère près. Limite CONNUE, non corrigée ici : un bloc
  // top-level à une seule ligne laisse un décalage résiduel d'1 ligne pour ce qui le suit (le
  // séparateur `\n` d'origine, lui, est mangé par le `.trim()` final, cf. plus bas) — seuls les
  // blocs MULTI-LIGNES (le cas réel de la quasi-totalité des `<script>`/`<style>`) sont couverts.
  const cuts = [...allModuleScripts, ...allScripts, ...allStyles, ...allThemes, ...allRoutesBlocks].map(m => m.indices![0]).sort((a, b) => a[0] - b[0])
  let html = ''
  let cursor = 0
  for (const [start, end] of cuts) {
    html += scan.slice(cursor, start)
    const nl = countNewlines(scan.slice(start, end))
    if (nl > 0) html += `<!--${'\n'.repeat(nl)}-->`
    cursor = end
  }
  html += scan.slice(cursor)

  // GARDE-FOU reliquats lexer — un `</script>`/`</style>` ORPHELIN
  // encore présent dans le HTML résiduel est le symptôme certain d'une extraction
  // partie en vrille : (a) backtick imbriqué dans une interpolation, ex.
  // `` `…${`</script>`}…` `` — CORRIGÉ À LA SOURCE : le masquage
  // des littéraux repose depuis sur un LECTEUR À NIVEAUX (lexer/index.ts), qui
  // referme le backtick extérieur au bon endroit ; ce cas ne parvient donc plus
  // jusqu'ici (cf. tests/lexer-backtick-imbrique.test.ts) ;
  // (b) chaîne non terminée (typo) contenant `</script>`/`</style>` : le lecteur
  // n'a rien à masquer (pas de guillemet fermant), fuite silencieuse ;
  // (c) une balise d'OUVERTURE en
  // majuscules (`<SCRIPT>`/`<Script>`/`<STYLE>`) : les 3 regex d'extraction
  // sont sensibles à la casse (`<script…`/`<style…`), donc jamais reconnues —
  // le contenu entier (avec sa fermeture, elle bien matchée par le `/i` du
  // check ci-dessous) fuit dans le HTML. Choix CONSERVATEUR (vs. rendre les 3
  // regex d'extraction elles-mêmes insensibles à la casse) : un `i` là-bas
  // toucherait aussi le filtre `\bmodule\b` de la section 2 et pourrait
  // classer un même `<SCRIPT MODULE>` dans les DEUX listes (double comptage) —
  // risque de régression pour un cas 0-occurrence sur le corpus réel. Ici on
  // se contente d'un message qui NOMME la vraie cause, jamais silencieux.
  // Testé sur `html` AVANT `restoreMacros` : le contenu des blocs <@head>/
  // <@failed> (qui peut légitimement contenir `<script src>…</script>`) est
  // encore un placeholder `\x00MJSHF…\x00` à ce stade, donc hors-jeu (0 faux
  // positif sur les 572 composants réels du corpus).
  // Un masquage <pre>/
  // <code> avait été ajouté ici pour couvrir l'hypothèse d'un `</script>`/
  // `</style>` LITTÉRAL affiché en texte dans un bloc de doc/tuto. RETIRÉ :
  // ce masquage (regex LAZY, sans
  // vérification d'appariement) masquait à travers un `<pre>` NON FERMÉ —
  // une vraie fuite d'extraction (chaîne non fermée contenant `</script>`)
  // située entre ce `<pre>` orphelin et un `</pre>` distant SANS RAPPORT
  // devenait invisible : FAUX NÉGATIF, `script.raw` silencieusement tronqué,
  // exactement le trou que ce garde-fou existe pour combattre. Le faux
  // positif que le masquage protégeait est un cas à ZÉRO occurrence réelle
  // (572 .mjs du corpus réel : aucun composant n'affiche un `</script>`/
  // `</style>` LITTÉRAL non échappé — tous échappent en `&lt;/script&gt;`,
  // qui ne matche pas cette regex et ne déclenche jamais le check). Le garde
  // redevient donc STRICT : tout `</script>`/`</style>` orphelin dans le HTML
  // résiduel throw, y compris à l'intérieur d'un `<pre>`/`<code>`.
  // NUANCE COMMENTAIRE : un bloc mis en COMMENTAIRE HTML est volontairement inerte — l'extraction
  // l'ignore (masquage posé en amont de `maskedStyle`, cf. §3) — donc sa balise fermante n'est pas
  // un orphelin. Vaut pour `</style>`, `</theme>` et `</routes>`. Le garde reste STRICT pour
  // `</script>` : l'extraction des scripts, elle, tourne AVANT le masquage des commentaires (elle
  // ne peut pas tourner après — un `<!--` dans une chaîne de code masquerait à travers le
  // `</script>` réel), donc un `</script>` commenté ne peut PAS venir d'un bloc rendu inerte : il
  // signale toujours la vraie fuite d'extraction que ce garde-fou existe pour attraper.
  const htmlHorsCommentaires = html.replace(/<!--[\s\S]*?-->/g, m => m.replace(/[^\n]/g, ' '))
  const orphanTag = html.match(/<\/script>/i) ?? htmlHorsCommentaires.match(/<\/(?:style|theme|routes)>/i)
  if (orphanTag) {
    throw new Error(t('transpiler.balise-orpheline-html', { balise: orphanTag[0] }))
  }

  const htmlRestored = restoreMacros(html)
  // ce que le `.trim()` mange en tête donne la ligne de départ du HTML (les blocs retirés, eux,
  // gardent leur hauteur)
  const htmlStartLine = lineOfOffset(htmlRestored, htmlRestored.length - htmlRestored.trimStart().length)
  html = htmlRestored.trim()

  return { module: moduleSection, script, style, layouts, themes, routes, html, htmlStartLine, warnings }
}
