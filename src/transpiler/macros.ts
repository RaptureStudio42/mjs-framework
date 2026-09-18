// transpiler/macros — port de <@include name> et <@window/document/body/head>
// (features V1 manquantes en V2 standard).
//
// <@include name>            → inline un partial `_<name>.mjs`. Résolution :
//                              1. local : `<baseDir>/_<name>.mjs`
//                              2. fallback : `<sourceDir>/shared/_<name>.mjs`
// <@include ../path/name>    → chemin relatif STRICT (pas de fallback). Permet
//                              de pointer un partial dans un autre dossier sans
//                              ambiguïté ; si introuvable → erreur explicite.
// Slash final (`<@include name/>`) interdit : erreur de compilation —
// voir processIncludes.
// <@window @event={...}>     → bind global event sur window/document/body/head
//                              (attache au réveil, teardown auto chaîné sur le
//                              hook sleep via l'API interne _mjs_hook)

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { join, dirname, resolve, basename, isAbsolute, sep } from 'node:path'
import { extractSections, type SectionsResult } from './sections.js'
import { dedent } from '../generator/state.js'
import { t } from '../messages/index.js'
import { findMacroTagEnd } from './macro-tag.js'
import { lintSplitRune } from './split-rune.js'

export interface IncludeAccumulator {
  /** CSS partials inlinés (concaténé au <style> du parent). */
  css: string[]
  /** Sections <script> partials (concaténées au <script> du parent). */
  script: string[]
  /** Sections <script module> partials. */
  module: string[]
  /** Cache : nom de partial → résolu (évite double-include). */
  resolved: Set<string>
  /** Clés en cours d'expansion (garde anti-<@include> circulaire). */
  expanding?: Set<string>
  /** partial introuvable / <@include>
   * circulaire : jusqu'ici seulement un `console.error` DANS LE WORKER
   * (transpile() tourne dans un worker_threads séparé, cf. bundler/worker.ts)
   * — le message atteint bien le terminal (stdout/stderr hérité), mais
   * jamais `stats.errors`/`stats.warnings` du bundler : `mjs build` continue
   * de rapporter un succès (exit 0), un pipeline CI qui ne grep pas les logs
   * bruts (juste le code de sortie) ne voit JAMAIS le problème — alors qu'un
   * `<@include>` manquant laisse le composant réellement INCOMPLET. Accumulé
   * ici et propagé via `TranspileData.macroErrors` jusqu'au bundler. */
  errors: string[]
  /** un partial avec un 2e
   * `<script>`/`<style>` voyait ce contenu silencieusement jeté par
   * `extractSections` (seul le 1er de chaque catégorie était gardé). Non
   * fatal (contrairement à `errors`) : propagé via `TranspileData.sectionWarnings`. */
  warnings: string[]
  /** PERF — cache readFileSync+extractSections par path résolu (durée de
   * vie = un transpile) : un même partial inclus N fois n'est lu/parsé qu'UNE
   * fois (avant : N lectures disque + N re-parses + N warnings dupliqués). */
  htmlCache: Map<string, SectionsResult>
}

export function newIncludeAccumulator(): IncludeAccumulator {
  return { css: [], script: [], module: [], resolved: new Set(), errors: [], warnings: [], htmlCache: new Map() }
}

// ----------------------------------------------------------------------------
// processIncludes : remplace <@include name> dans le HTML par le template
// du partial, et accumule css/script/module dans `acc`.
// ----------------------------------------------------------------------------
// Le pattern accepte soit un nom simple (`header`, `nav-bar`), soit un chemin
// relatif (`../shared/header`, `./sub/foo`). Les deux formes restent
// distinguables : présence de `/` ou `.` au début → chemin relatif strict.
// La forme documentée est SANS slash final (`<@include header>`) : groupe 1
// (nom/chemin) capturé en PARESSEUX, groupe 2 capture À PART un éventuel `/`
// final — ce slash traînant est désormais rejeté par
// processIncludes (erreur de compilation) au lieu d'être avalé dans le nom.
// Exportée (avec resolvePartial ci-dessous) : réutilisée telle quelle par
// bundler/index.ts (preResolveAssets) pour descendre dans les <@include>
// AVANT l'envoi au worker — même résolution que l'inlining réel, aucune
// divergence possible entre les deux passages.
export const INCLUDE_RE = /<@include\s+([\.\/\w\-]+?)\s*(\/?)>/gi

// assertPartialUnder — confinement <@include> : un `../` répété dans un
// chemin relatif STRICT résolvait n'importe où sur le disque, sans garde — `<@include
// ../../../etc/passwd>` inlinait tel quel le contenu d'un fichier hors sourceDir dans le
// composant compilé (prouvé : SECRET-CONTENT-HORS retrouvé dans le bundle émis). Même
// confinement à double étage que `assertRealUnder` côté bundler (bundler/index.ts) : LEXICAL
// d'abord (le `..` peut sortir sans qu'aucun symlink n'existe), puis RÉEL par realpathSync si
// le fichier existe (un lien posé DANS sourceDir peut pointer dehors).
function assertPartialUnder(abs: string, sourceDir: string, rawTarget: string): void {
  const root = resolve(sourceDir)
  if (abs !== root && !abs.startsWith(root + sep)) {
    throw new Error(t('transpiler.include-hors-racine', { target: rawTarget, chemin: abs }))
  }
  if (existsSync(abs)) {
    const realAbs = realpathSync(abs)
    const realRoot = realpathSync(root)
    if (realAbs !== realRoot && !realAbs.startsWith(realRoot + sep)) {
      throw new Error(t('transpiler.include-hors-racine', { target: rawTarget, chemin: realAbs }))
    }
  }
}

export function resolvePartial(
  rawTarget: string,
  baseDir: string,
  sourceDir: string | undefined
): { path: string; key: string } | null {
  const isRelative = rawTarget.includes('/') || rawTarget.startsWith('.')
  if (isRelative) {
    // Chemin relatif STRICT : pas de fallback. Le `_` du préfixe est ajouté
    // au dernier segment seulement (`shared/header` → `shared/_header.mjs`).
    const dir = dirname(rawTarget)
    const name = basename(rawTarget)
    const rel = dir === '.' ? `_${name}.mjs` : `${dir}/_${name}.mjs`
    const abs = isAbsolute(rel) ? rel : resolve(baseDir, rel)
    // confinement à sourceDir (EB) : seulement si connu — un appelant sans sourceDir
    // (transpile() isolé, hors bundler) garde l'ancien comportement, non exposé au disque public.
    if (sourceDir) assertPartialUnder(abs, sourceDir, rawTarget)
    if (!existsSync(abs)) return null
    return { path: abs, key: abs }
  }
  // Nom simple : local d'abord, puis fallback `<sourceDir>/shared/`.
  const local = join(baseDir, `_${rawTarget}.mjs`)
  if (existsSync(local)) return { path: local, key: local }
  if (sourceDir) {
    const shared = join(sourceDir, 'shared', `_${rawTarget}.mjs`)
    if (existsSync(shared)) return { path: shared, key: shared }
  }
  return null
}

export function processIncludes(
  html: string,
  baseDir: string | undefined,
  acc: IncludeAccumulator,
  sourceDir?: string,
  lint: { sigil?: string, scriptLang?: string, moduleLang?: string } = {}
): string {
  if (!baseDir) {
    // Sans baseDir on ne peut pas trouver les fichiers partials → retiré, mais SIGNALÉ
    // (avant : strip totalement silencieux, cf. plus haut).
    const out = html.replace(INCLUDE_RE, (_match, target: string) => {
      acc.warnings.push(t('transpiler.include-sans-basedir', { target }))
      return ''
    })
    reportMalformedIncludes(out, acc.errors)
    return out
  }
  // PERF — lit+parse un partial UNE seule fois par transpile (cache par
  // path résolu). Un partial inclus N fois ne refait pas N readFileSync +
  // N extractSections. `acc.htmlCache` est fourni par newIncludeAccumulator ;
  // fallback défensif pour un accumulateur construit à la main.
  const cache = acc.htmlCache ?? (acc.htmlCache = new Map())
  // DURCI — un doublon de section (2e <script>/<script module>/<style>)
  // lève désormais une ERREUR depuis extractSections (avant : simple warning, qui
  // gagnait son contexte via le `acc.warnings.push(...)` préfixé plus bas). Un
  // throw brut, lui, ne nommerait que le composant PARENT (celui que le bundler
  // compile), jamais le partial fautif — re-throw préfixé du `<@include ${target}>`
  // pour restaurer la même précision (couvre aussi un readFileSync qui échoue).
  const getSections = (partialPath: string, target: string): SectionsResult => {
    let s = cache.get(partialPath)
    if (!s) {
      try {
        s = extractSections(readFileSync(partialPath, 'utf-8'))
      } catch (e: any) {
        throw new Error(`<@include ${target}> : ${e?.message ?? e}`)
      }
      cache.set(partialPath, s)
    }
    return s
  }
  const out = html.replace(INCLUDE_RE, (_match, target: string, selfClose: string) => {
    // slash final interdit, même canal d'erreur que partial introuvable
    if (selfClose === '/' || target.endsWith('/')) {
      const clean = target.replace(/\/+$/, '')
      const msg = t('transpiler.include-slash-final-interdit', { target, selfClose, clean })
      // eslint-disable-next-line no-console
      console.error(`[ModularJS] ❌ ${msg}`)
      acc.errors.push(msg)
      return ''
    }
    const resolved = resolvePartial(target, baseDir, sourceDir)
    if (!resolved) {
      const msg = t('transpiler.include-partial-introuvable', { target, baseDir })
      // eslint-disable-next-line no-console
      console.error(`[ModularJS] ❌ ${msg}`)
      acc.errors.push(msg)
      return ''
    }
    const { path: partialPath, key } = resolved
    const label = basename(target)

    if (acc.resolved.has(key)) {
      // Déjà inliné ailleurs — on ré-inclut le HTML (pas les assets), MAIS en
      // résolvant aussi SES <@include> imbriqués : avant, ils restaient BRUTS
      // dans le DOM final (tag <@include> inconnu, silencieux). Garde
      // anti-cycle : A→B→A s'arrête avec une erreur claire au lieu de boucler.
      if (acc.expanding?.has(key)) {
        const msg = t('transpiler.include-circulaire', { target })
        // eslint-disable-next-line no-console
        console.error(`[ModularJS] ❌ ${msg}`)
        acc.errors.push(msg)
        return ''
      }
      // Sections en cache ; on ne re-pousse PAS les warnings du partial (déjà
      // signalés à sa 1ʳᵉ inclusion — évite les doublons).
      const sections = getSections(partialPath, target)
      acc.expanding = acc.expanding ?? new Set()
      acc.expanding.add(key)
      try {
        return processIncludes(sections.html, dirname(partialPath), acc, sourceDir, lint)
      } finally {
        acc.expanding.delete(key)
      }
    }
    acc.resolved.add(key)

    const sections = getSections(partialPath, target)
    for (const w of sections.warnings) acc.warnings.push(`<@include ${target}> : ${w}`)
    // rune séparée de son symbole dans le script du partiel : même refus que dans le composant hôte (cf.
    // split-rune.ts), situé sur la ligne du fichier partiel ; lu dans la langue du script hôte, qui le reçoit et
    // le compile, pas dans celle que le partiel déclare ou hérite par défaut
    lintSplitRune(sections.script.raw, `${basename(partialPath)} <script>`, { sigil: lint.sigil, firstLine: sections.script.startLine, lang: lint.scriptLang ?? sections.script.lang })
    lintSplitRune(sections.module.raw, `${basename(partialPath)} <script module>`, { sigil: lint.sigil, firstLine: sections.module.startLine, lang: lint.moduleLang ?? sections.module.lang })

    if (sections.style.raw.trim() !== '') {
      // balise le bloc avec le lang RÉEL du
      // partial (sections.style.lang, déjà résolu par extractSections : son
      // lang= propre, ou le défaut projet si absent — même résolution qu'un
      // composant normal, rien de réinventé ici). AVANT : texte brut nu,
      // fusionné plus loin (transpiler/index.ts) avec le SEUL lang de l'hôte
      // → un partiel `lang="css"` dans un hôte SASS indenté (le défaut)
      // faisait échouer TOUT le build (« Expected newline »). compileCss
      // (transpiler/css.ts) déballe ce balisage et compile CE bloc avec CE
      // lang si le lang de l'hôte diffère — fusion consciente au lieu d'une
      // concaténation de sources hétérogènes compilées avec un lang unique.
      // `\x00…\x00` : NUL pré-existants neutralisés À
      // L'ENTRÉE (ici côté partial, transpiler/index.ts côté hôte) → par
      // construction les SEULS `\x00` du texte fusionné sont NOS marqueurs.
      // Jamais un caractère utile en CSS/SASS (la tokenisation CSS remplace
      // U+0000 par U+FFFD) : le strip est sémantiquement sans perte.
      // `acc.css` reste un `string[]` ordinaire, aucun contrat à changer
      // côté transpileur.
      const cleanStyle = sections.style.raw.includes('\x00') ? sections.style.raw.replace(/\x00/g, '') : sections.style.raw
      acc.css.push(`\x00MJSSTYLE:${sections.style.lang}\x00/* --- Partial: ${label} --- */\n${cleanStyle}\x00MJSENDSTYLE\x00`)
    }
    if (sections.module.raw.trim() !== '') {
      acc.module.push(`# --- Partial Module: ${label} ---\n${dedent(sections.module.raw)}`)
    }
    if (sections.script.raw.trim() !== '') {
      acc.script.push(`# --- Partial: ${label} ---\n${dedent(sections.script.raw)}`)
    }

    // Récursion : un partial peut lui-même <@include …>
    return processIncludes(sections.html, dirname(partialPath), acc, sourceDir, lint)
  })
  reportMalformedIncludes(out, acc.errors)
  return out
}

// reportMalformedInclude/reportMalformedIncludes — un <@include qui ne correspond pas à la forme stricte
// <@include chemin> (attributs, chemin absent, chevrons manquants) restait
// jusqu'ici du texte INERTE dans la page, sans un mot (AVANT : `<@include foo
// titre="a">` traversait tel quel jusqu'au HTML rendu, silence total).
// Appelées APRÈS la passe INCLUDE_RE de processIncludes (les deux branches
// ci-dessus) : tout `<@include` restant à ce stade est par construction une
// forme non reconnue (INCLUDE_RE, elle, a déjà consommé toutes les formes
// valides — y compris le slash final interdit, traité par son propre canal
// d'erreur). Même dédoublonnage par texte EXACT que reportUnclosedMacroTag
// (macros.ts) : processIncludes se rappelle récursivement sur le html
// de chaque partial inclus, la MÊME occurrence non consommée remonte donc
// IDENTIQUE à travers plusieurs niveaux d'appel — sans ce garde-fou, elle
// serait signalée une fois par niveau traversé.
function reportMalformedInclude(errors: string[], html: string, idx: number): void {
  const extrait = Array.from(html.slice(idx, idx + 120)).slice(0, 60).join('').replace(/\n/g, ' ')
  const msg = t('transpiler.include-malforme', { extrait })
  if (errors.includes(msg)) return
  // eslint-disable-next-line no-console
  console.error(`[ModularJS] ❌ ${msg}`)
  errors.push(msg)
}

function reportMalformedIncludes(html: string, errors: string[]): void {
  const re = /<@include\b/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(html)) !== null) reportMalformedInclude(errors, html, m.index)
}

// ----------------------------------------------------------------------------
// processGlobalMacros : strip <@window @event={...}> etc. du HTML et retourne
// le code Coffee à appender au <script> pour bind/unbind les listeners.
// ----------------------------------------------------------------------------
export interface GlobalMacrosResult {
  /** HTML nettoyé des macros. */
  html: string
  /** Code Coffee de setup (à appender au <script>). */
  setup: string
  /** Code Coffee de teardown (chaîné sur le hook sleep via _mjs_hook). */
  teardown: string
  /** Erreurs de compile des liaisons class/style (@class{…}/@style.prop/--var/
   * class=/style= hors <@body>/<@html>, style inline statique, interpolation
   * dans class= …) — même canal que les erreurs de <@include>, fusionné dans
   * `TranspileData.macroErrors` ; le bundler fait déjà échouer le build si
   * non vide (bundler/index.ts). */
  errors: string[]
}

const TARGETS: Record<string, string> = {
  window:   'window',
  document: 'document',
  body:     'document.body',
  html:     'document.documentElement',
  head:     'document.head',
}

// Propriétés de `window` LIABLES en deux-sens via `prop=!{$var}` sur <@window>
// (équivalent des `bind:scrollY` / `bind:innerWidth` / … de <svelte:window>).
//   read   : expression de lecture (valeur initiale + à chaque event)
//   events : événements window qui rafraîchissent la liaison
//   write  : (scroll seulement) statement Civet qui POUSSE la var vers window
//            quand elle change (liaison réellement two-way). Gardé par un test
//            d'égalité → scroll programmatique OK, pas de boucle sur le scroll
//            utilisateur (scrollTo à la position courante = no-op).
const WINDOW_BINDABLE: Record<string, { read: string; events: string[]; write?: (v: string) => string }> = {
  scrollX:          { read: 'window.scrollX', events: ['scroll'], write: v => `if window.scrollX != (${v}) then window.scrollTo(${v}, window.scrollY)` },
  scrollY:          { read: 'window.scrollY', events: ['scroll'], write: v => `if window.scrollY != (${v}) then window.scrollTo(window.scrollX, ${v})` },
  innerWidth:       { read: 'window.innerWidth', events: ['resize'] },
  innerHeight:      { read: 'window.innerHeight', events: ['resize'] },
  outerWidth:       { read: 'window.outerWidth', events: ['resize'] },
  outerHeight:      { read: 'window.outerHeight', events: ['resize'] },
  devicePixelRatio: { read: 'window.devicePixelRatio', events: ['resize'] },
  online:           { read: 'navigator.onLine', events: ['online', 'offline'] },
}

// Échappe une portion HTML LITTÉRALE pour l'émettre en chaîne Civet simple-quote.
// On utilise des simple-quotes pour que les guillemets HTML (`href="…"`) ne
// nécessitent AUCUN échappement, et on concatène les expressions à part.
function quoteHeadLiteral(str: string): string {
  // sauts de ligne RÉELS → séquence d'échappement `\n` (littéral Civet à guillemets simples :
  // `'a\nb'` reste un VRAI saut de ligne une fois ÉVALUÉ) — AVANT, `\s+` → ' ' les écrasait, et
  // un commentaire `//` juste avant avalait la ligne suivante (silencieux). Tabulations et
  // espaces multiples restent réduits à un seul espace (comportement conservé pour le reste).
  const esc = str.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\r\n|\r|\n/g, '\\n').replace(/[ \t]+/g, ' ')
  return `'${esc}'`
}

// États rendus par tagPositions. ST_TAG, ST_BARE et ST_TAG_NAME sont les trois positions où une
// interpolation est REFUSÉE ; ST_AUTOQUOTE est la seule que le compilateur enveloppe de guillemets
// (cf. buildHeadInjection).
const ST_TEXT      = 0   // hors balise
const ST_TAG       = 1   // structure d'une balise : nom, nom d'attribut, blancs, `=`, guillemets, `>`
const ST_QUOTED    = 2   // intérieur d'une valeur d'attribut entre guillemets
const ST_COMMENT   = 3   // commentaire `<!-- -->`
const ST_TAG_NAME  = 4   // expression en position de NOM DE BALISE (`<{$tag}>`)
const ST_BARE      = 5   // intérieur d'une valeur d'attribut NUE (sans guillemets)
const ST_AUTOQUOTE = 6   // expression qui EST la valeur (premier caractère non blanc après le `=`)

// Blanc au sens HTML5 (espace, tabulation, saut de ligne, saut de page, retour chariot) — et RIEN
// d'autre : `\s` en JavaScript y ajoute l'espace insécable, le BOM et U+2028, que le tokeniseur d'un
// navigateur traite comme des caractères ORDINAIRES. Les confondre faisait lire `a=\u00a0"{$x}"` comme
// une valeur quotée là où le navigateur commence une valeur NUE à l'insécable.
function isHtmlSpace(c: string): boolean {
  return c === ' ' || c === '\t' || c === '\n' || c === '\f' || c === '\r'
}

// tagPositions : suit les états du tokeniseur HTML5 dans une balise — nom (de balise ou
// d'attribut) → après `=` (espaces admis) → valeur QUOTÉE (seulement si le premier caractère non
// blanc après le `=` est un guillemet) ou valeur NUE. Dans une valeur nue, TOUT caractère reste
// LITTÉRAL jusqu'au premier espace ou `>` — `"`, `'`, `=` et `<` compris (HTML5,
// unexpected-character-in-unquoted-attribute-value) : c'est ce qui fait que `a=b=" {$x}"` donne au
// navigateur la valeur `b="` puis un ATTRIBUT de plus par mot suivant, et non la valeur protégée
// qu'on croit lire. Un `<` suivi d'une interpolation ouvre une balise à nom calculé (ST_TAG_NAME,
// refusée) ; suivi d'autre chose qu'une lettre, `/` ou `!`, il reste du texte. Un commentaire
// s'ouvre sur `<!--` et se ferme sur `-->` ou `--!>`, ou AUSSITÔT sur `<!-->`/`<!--->` (HTML5) : ne
// connaître que `-->` classait tout le reste du bloc en commentaire, balises fautives comprises.
//
// Les expressions `{…}`/`{{…}}` sont sautées d'un bloc et prennent l'état courant, sauf celle qui est
// le PREMIER caractère non blanc après le `=` d'un attribut : elle EST la valeur, le compilateur
// l'enveloppe de guillemets à l'émission (ST_AUTOQUOTE) — ce qui la suit dans la même valeur nue,
// lui, reste ST_BARE. Dans une valeur DÉJÀ quotée, une expression reste ST_QUOTED : `µ._esc` y
// neutralise le guillemet, aucun guillemet n'est ajouté (en ajouter derrière le premier `=` venu —
// un paramètre d'URL, un `k=v` — FERMAIT la valeur au navigateur et rendait la donnée maîtresse de
// la balise).
//
// `attr` : pour chaque caractère d'une valeur d'attribut, l'index où commence le token de
// l'attribut (son nom) — de quoi citer `attr=valeur` en entier dans un message, sans le redeviner.
function tagPositions(str: string): { state: Uint8Array; attr: Int32Array } {
  const state = new Uint8Array(str.length)
  const attr  = new Int32Array(str.length).fill(-1)
  const expr  = /\{\{[^{}]+\}\}|\{[^{}]+\}/y
  const exprAt = (at: number): RegExpExecArray | null => {
    expr.lastIndex = at
    return expr.exec(str)
  }
  let tag   = false
  // 'elname' (nom de l'élément) | 'tagname' (nom de l'élément CALCULÉ) | 'name' (avant/dans/après un
  // nom d'attribut) | 'value' (après le `=`) | 'bare' | 'quoted'
  let mode     = 'name'
  let quote    = ''
  let token    = -1      // début du nom d'attribut courant, -1 si aucun n'est en cours
  let apresNom = false   // un nom d'attribut a été lu PUIS clos par un blanc (son `=` reste ouvreur)
  let i        = 0
  while (i < str.length) {
    const c = str[i]
    if (c === '{') {
      const m = exprAt(i)
      if (m) {
        const stop = i + m[0].length
        if (tag) {
          if (mode === 'quoted') state.fill(ST_QUOTED, i, stop)
          else if (mode === 'tagname' || mode === 'elname') {
            // `<{$tag}>` comme `<meta={$x}>` : la donnée fabriquerait le nom de l'élément
            state.fill(ST_TAG_NAME, i, stop)
            if (mode === 'tagname') mode = 'name'
          }
          else if (mode === 'value' || mode === 'bare') {
            // en mode 'value', aucun caractère de valeur n'est encore passé : l'expression EST la
            // valeur, le compilateur la met entre guillemets
            state.fill(mode === 'value' ? ST_AUTOQUOTE : ST_BARE, i, stop)
            attr.fill(token, i, stop)
            mode = 'bare'
          }
          else state.fill(ST_TAG, i, stop)
        }
        i = stop
        continue
      }
    }
    if (!tag) {
      if (str.startsWith('<!--', i)) {
        // `<!-->` et `<!--->` se ferment aussitôt ; sinon la fin est `-->` ou `--!>`
        let stop: number
        if (str.startsWith('<!-->', i)) stop = i + 5
        else if (str.startsWith('<!--->', i)) stop = i + 6
        else {
          const fin = /--!?>/g
          fin.lastIndex = i + 4
          const m = fin.exec(str)
          stop = m ? m.index + m[0].length : str.length
        }
        state.fill(ST_COMMENT, i, stop)
        i = stop
        continue
      }
      // `<{expr}` : la donnée fabriquerait le nom de la balise et tout ce qui le suit
      if (c === '<' && str[i + 1] === '{' && exprAt(i + 1)) {
        tag      = true
        mode     = 'tagname'
        state[i] = ST_TAG
        i++
        continue
      }
      if (c === '<' && /[A-Za-z!/]/.test(str[i + 1] ?? '')) {
        tag      = true
        // une lettre ouvre le NOM de l'élément (où un `=` n'a aucun sens spécial, HTML5 tag-name
        // state) ; `<!`/`</` gardent le traitement historique
        mode     = /[A-Za-z]/.test(str[i + 1]) ? 'elname' : 'name'
        token    = -1
        apresNom = false
        state[i] = ST_TAG
      }
      i++
      continue
    }
    if (mode === 'quoted') {
      // le guillemet FERMANT appartient à la structure, le contenu de la valeur vaut ST_QUOTED
      if (c === quote) {
        state[i] = ST_TAG
        quote    = ''
        mode     = 'name'
        token    = -1        // l'attribut est complet : le `=` suivant n'aurait plus de nom devant lui
        apresNom = false
      }
      else {
        state[i] = ST_QUOTED
        attr[i]  = token
      }
      i++
      continue
    }
    if (mode === 'bare') {
      if (isHtmlSpace(c)) {
        state[i] = ST_TAG
        mode     = 'name'
        token    = -1
        apresNom = false
      }
      else if (c === '>') {
        state[i] = ST_TAG
        tag      = false
        mode     = 'name'
        token    = -1
        apresNom = false
      }
      else {
        state[i] = ST_BARE
        attr[i]  = token
      }
      i++
      continue
    }
    if (mode === 'elname') {
      state[i] = ST_TAG
      if (c === '>') {
        tag      = false
        mode     = 'name'
        token    = -1
        apresNom = false
      }
      else if (isHtmlSpace(c) || c === '/') {
        mode     = 'name'
        token    = -1
        apresNom = false
      }
      i++
      continue
    }
    if (mode === 'value') {
      state[i] = ST_TAG
      if (isHtmlSpace(c)) { i++; continue }
      if (c === '"' || c === "'") {
        quote = c
        mode  = 'quoted'
      }
      else if (c === '>') {
        tag      = false
        mode     = 'name'
        token    = -1
        apresNom = false
      }
      else {
        state[i] = ST_BARE
        attr[i]  = token
        mode     = 'bare'
      }
      i++
      continue
    }
    state[i] = ST_TAG
    if (c === '>') {
      tag      = false
      mode     = 'name'
      token    = -1
      apresNom = false
    }
    else if (isHtmlSpace(c)) {
      if (token >= 0) apresNom = true       // `a = "x"` : le nom reste l'attribut de ce `=`
    }
    else if (c === '=' && token >= 0) {
      mode     = 'value'
      apresNom = false
    }
    else if (c === '/') {                   // HTML5 self-closing-start-tag : aucun nom ne court plus
      token    = -1
      apresNom = false
    }
    else if (token === -1 || apresNom) {    // début d'un NOUVEAU nom — un `=` sans nom devant lui en fait partie
      token    = i
      apresNom = false
    }
    i++
  }
  return { state, attr }
}

// countNewlines — nombre de `\n` dans une chaîne, pour situer une faute à la ligne du .mjs
function countNewlines(str: string): number {
  let n = 0
  for (let i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) n++
  return n
}

// faultyTag — la balise ENTIÈRE qui porte la faute (`<meta {$x}>`) : du `<` de tête (structure,
// donc jamais un `<` littéral niché dans une valeur) au `>` qui la referme, interpolations sautées
// d'un bloc (un `>` dans une accolade ne ferme rien). Un second `<` de structure arrête la citation
// avant lui : sans `>` à elle (`<{$b}</title>`), la « balise » s'arrêterait sinon à celui de la
// balise SUIVANTE, et le message montrerait un morceau qui n'existe pas.
function faultyTag(s: string, state: Uint8Array, start: number, end: number): string {
  let open = start
  while (open > 0 && !(s[open] === '<' && state[open] === ST_TAG)) open--
  const expr = /\{\{[^{}]+\}\}|\{[^{}]+\}/y
  let close  = end
  while (close < s.length) {
    if (s[close] === '{') {
      expr.lastIndex = close
      const m = expr.exec(s)
      if (m) { close += m[0].length; continue }
    }
    if (s[close] === '>' && state[close] === ST_TAG) { close++; break }
    if (s[close] === '<' && (state[close] === ST_TAG || state[close] === ST_TEXT)) break
    close++
  }
  return s.slice(open, close)
}

// unaliasSigil — remet dans le message le symbole que l'AUTEUR a tapé : le HTML arrive ici déjà
// normalisé (`mjs.` / `mjs$` → `µ.` / `µ$`, cf. normalizeSigilAlias), et citer `{µ$slug}` à qui a
// écrit `{mjs$slug}` envoie chercher une faute qui n'est pas dans son fichier. Inverse EXACT de
// l'alias : seul un `µ` suivi de `.` ou `$` est réécrit.
function unaliasSigil(txt: string, sigil?: string): string {
  return sigil && sigil !== 'µ' ? txt.replace(/µ(?=[.$])/g, sigil) : txt
}

// reportBareInterpolation — relève UNE interpolation écrite dans une balise, ailleurs que dans une
// valeur entre guillemets. Trois fautes, trois messages : (a) intérieur d'une valeur NUE
// (`href=https://x/{$slug}`) → la forme correcte est la valeur entière entre guillemets ; (b)
// position de nom d'attribut (`<meta {$x}>`) → il faut nommer l'attribut ; (c) position de nom de
// balise (`<{$tag}>`) → la balise s'écrit en clair. Forme et correction sont reconstruites sur le
// texte D'ORIGINE (avant la réécriture `={…}` → `="{…}"`), avec le symbole de l'auteur : un message
// ne montre jamais un état intermédiaire du compilateur.
//
// La ligne citée est celle du .mjs : `firstLine` plus les `\n` qui précèdent la faute dans le
// contenu RESTAURÉ (un <style>/<script> masqué tient sur une ligne, ses sauts de ligne
// manqueraient). Dans un `<@include>`, le partial est déjà inliné quand ce contrôle tourne : la
// ligne est alors celle du composant qui inclut, pas celle du partial.
function reportBareInterpolation(s: string, state: Uint8Array, attr: Int32Array, start: number, end: number, restore: (str: string) => string, macro: 'head' | 'failed', errors: string[], firstLine: number, sigil?: string): void {
  const ligne = firstLine + countNewlines(restore(s.slice(0, start)))
  const texte = (brut: string): string => unaliasSigil(restore(brut), sigil)
  if (state[start] === ST_TAG_NAME) {
    errors.push(t('transpiler.head-interpolation-position-balise', { macro, ligne, forme: texte(faultyTag(s, state, start, end)) }))
    return
  }
  const token = state[start] === ST_BARE ? attr[start] : -1
  if (token >= 0) {
    // valeur NUE : elle court jusqu'au premier espace ou `>`, interpolations comprises
    let stop = end
    while (stop < s.length && (state[stop] === ST_BARE || state[stop] === ST_AUTOQUOTE)) stop++
    const eq  = s.indexOf('=', token)
    let debut = eq + 1
    while (debut < stop && /\s/.test(s[debut])) debut++
    const nom = s.slice(token, eq)
    // guillemets de la valeur échappés : la correction proposée doit être du HTML valide
    const valeur = texte(s.slice(debut, stop)).replace(/"/g, '&quot;')
    errors.push(t('transpiler.head-attr-interpolation-sans-guillemets', { macro, ligne, forme: texte(s.slice(token, stop)), correction: `${texte(nom)}="${valeur}"` }))
    return
  }
  errors.push(t('transpiler.head-interpolation-position-attribut', { macro, ligne, forme: texte(faultyTag(s, state, start, end)) }))
}

// buildHeadInjection : transforme le HTML enfant d'un <@head> en EXPRESSION
// Civet qui produit la chaîne HTML à injecter, avec interpolations réactives.
//   <link rel="stylesheet" href={themeCss[$selected]}>
//   → '<link rel="stylesheet" href="' + (themeCss[$selected]) + '">'
// Les `{expr}` (texte) et `attr={expr}` (binding) deviennent des `(expr)`
// concaténés ; lus dans un µeffect, leurs `$x` rendent l'injection réactive.
// Limite assumée : pas d'accolades imbriquées dans une expr (utiliser `+` plutôt
// que l'interpolation `#{…}` côté binding).
//
// Une interpolation écrite dans une balise, ailleurs que dans une valeur entre guillemets, est une
// FAUTE relevée dans `errors` : `µ._esc` échappe `<`, `>`, `"`, `'` et `&`, jamais l'espace ni le
// `=`, donc une valeur NUE (`href=https://x/{$slug}`), une expression à la place d'un attribut
// (`<meta {$x}>`) ou un nom de balise calculé (`<{$tag}>`) laissent une donnée d'ailleurs AJOUTER un
// attribut, voire fabriquer l'élément entier (`x onload=alert(1)`). Les positions sont celles du
// tokeniseur HTML5 (cf. tagPositions) : un `"` dans une valeur nue est un caractère littéral, il ne
// protège rien. Une faute par interpolation, toutes relevées (jamais de throw : le scan du fichier
// continue, le bundler fait échouer la construction) ; l'expression rendue reste valide, elle n'a
// plus d'importance dès que `errors` a grossi.
//
// Reste licite : `attr={expr}` / `attr={{expr}}` en valeur d'attribut (le compilateur met CETTE
// valeur entre guillemets), toute valeur entre guillemets simples ou doubles, et l'interpolation en
// texte, dans un commentaire ou dans un `<style>`/`<script>` (masqués, jamais interpolés).
//
// REFUS et ÉMISSION lisent le MÊME texte, aux positions d'UNE SEULE passe du tokeniseur : les
// guillemets d'une valeur auto-quotée sont posés à l'émission, jamais par une réécriture du source.
// Une réécriture globale `={…}` → `="{…}"` ne voyait pas l'état : le `=` d'un paramètre d'URL DANS
// une valeur déjà quotée (`href="…?p={$x}"`) déclenchait l'ajout, le guillemet injecté FERMAIT la
// valeur au navigateur, et la donnée reprenait la main sur la balise ; en texte (`<title>a={$x}`),
// elle inventait des guillemets et faisait perdre le HTML brut de `{{…}}`.
// `firstLine` = ligne du .mjs où commence `content` ; `sigil` = symbole du projet (message seul).
function buildHeadInjection(content: string, macro: 'head' | 'failed', errors: string[], firstLine: number, sigil?: string): string {
  // `<style>`/`<script>` ont leur PROPRE syntaxe à accolades (règles CSS, JS) :
  // les masquer AVANT le scan d'interpolation ci-dessous, sinon un `@font-face
  // { … }` est pris pour UNE SEULE expression réactive géante (`{([^{}]+)}`
  // avale tout le corps de la règle) → Civet invalide (`µ._esc(font-family: …)`,
  // syntaxe cassée, ParseError). Restauré tel quel dans les morceaux littéraux :
  // figé, cohérent avec µasset('…') (résolu au BUILD, jamais réactif) —
  // <style>/<script> n'ont jamais supporté l'interpolation `{$x}` dans <@head>,
  // aucune régression de feature.
  const blocks: string[] = []
  const premasked = content.replace(/<(style|script)\b[^>]*>[\s\S]*?<\/\1>/gi, (m) => {
    blocks.push(m)
    return `\x00MJSHEADLIT${blocks.length - 1}\x00`
  })
  const restore = (str: string): string =>
    blocks.length ? str.replace(/\x00MJSHEADLIT(\d+)\x00/g, (_m, i) => blocks[Number(i)]) : str

  const { state, attr } = tagPositions(premasked)
  const parts: string[] = []
  let last    = 0
  let prefixe = ''   // guillemet fermant d'une valeur auto-quotée, à coller en tête du prochain littéral
  // `{{expr}}` essayé AVANT `{expr}` à chaque position : sinon le `{expr}` intérieur était pris
  // seul, échappé, et les deux accolades extérieures restaient en texte
  const re = /\{\{([^{}]+)\}\}|\{([^{}]+)\}/g
  let m: RegExpExecArray | null
  while ((m = re.exec(premasked)) !== null) {
    const etat = state[m.index]
    if (etat === ST_TAG || etat === ST_BARE || etat === ST_TAG_NAME) {
      reportBareInterpolation(premasked, state, attr, m.index, m.index + m[0].length, restore, macro, errors, firstLine, sigil)
    }
    const litteral = prefixe + premasked.slice(last, m.index)
    prefixe = ''
    // µ._esc : ces valeurs partent en innerHTML (head vivant / fallback de
    // boundary). Sans échappement, `<@head><title>{$titre}</title></@head>`
    // avec un titre venu du serveur contenant `</title><img onerror=…>`
    // exécutait du code (XSS). Svelte échappe <svelte:head> ; nous aussi.
    // `{{expr}}` HORS balise est la demande EXPLICITE de HTML brut : jamais échappé, comme
    // partout ailleurs ; DANS une balise (valeur d'attribut) il reste échappé comme `{expr}`
    if (etat === ST_AUTOQUOTE) {
      // l'expression EST la valeur : on l'entoure de guillemets ICI, à l'émission
      parts.push(quoteHeadLiteral(restore(litteral + '"')))
      parts.push(`µ._esc(${(m[1] ?? m[2]).trim()})`)
      prefixe = '"'
    }
    else {
      if (litteral) parts.push(quoteHeadLiteral(restore(litteral)))
      if (m[1] !== undefined && etat === ST_TEXT) parts.push(`String(${m[1].trim()})`)
      else parts.push(`µ._esc(${(m[1] ?? m[2]).trim()})`)
    }
    last = m.index + m[0].length
  }
  const queue = prefixe + premasked.slice(last)
  if (queue) parts.push(quoteHeadLiteral(restore(queue)))
  return parts.length ? parts.join(' + ') : "''"
}

// compileFailedBlock : compile le contenu d'un <@failed args>…</@failed> en une
// fonction-builder DOM. Le fallback d'une error boundary est rendu APRÈS le
// crash (le pipeline réactif est éteint), donc on produit du DOM STATIQUE avec
// les `@event=…` câblés en listeners DIRECTS (pas de délégation, pas de
// réactivité — inutile ici). Les `{expr}` (texte/attrs) sont évalués une fois,
// avec les args (`err`, `reset`) en portée. Retourne les lignes de SETUP
// (constantes de réessai, posées une fois par construction) + le head de
// fonction + les lignes de corps (Civet).
//
// `retry="N"` (défaut 1) borne
// le nombre de réessais automatiques : sans limite, `reset()` (µ._mjs_resetComponent,
// mjs_runes.ts, appelé depuis _mjs_catchError, mjs_element.ts) remonte une instance
// FRAÎCHE du même composant — sur une erreur DÉTERMINISTE, construction → erreur
// → reset → construction tournait sans fin. `retry` est un attribut key=value,
// PAS un nom de callback (`err`/`reset` restent des tokens NUS) : on l'isole
// AVANT de construire la liste d'arguments, sinon `paramsRaw.split(/\s+/)`
// l'aurait pris pour un 3ᵉ paramètre positionnel de la fonction fallback.
//
// `errors`/`firstLine`/`sigil` : transmis à buildHeadInjection pour le refus de l'interpolation
// hors guillemets (cf. son bandeau). `firstLine` = ligne du .mjs où commence le contenu TRIMMÉ.
function compileFailedBlock(paramsRaw: string, content: string, errors: string[], firstLine: number, sigil?: string): { setup: string[]; head: string; body: string[] } {
  const tokens = paramsRaw.trim().split(/\s+/).filter(Boolean)
  const args: string[] = []
  let retryLimit = 1
  for (const tok of tokens) {
    const retryMatch = tok.match(/^retry=(["']?)(-?\d+)\1$/)
    if (retryMatch) {
      retryLimit = parseInt(retryMatch[2], 10)
      if (!Number.isInteger(retryLimit) || retryLimit < 0) throw new Error(t('transpiler.failed-retry-invalide', { valeur: tok }))
      continue
    }
    args.push(tok)
  }
  const argStr = args.length ? args.join(', ') : 'err, reset'
  const wires: string[] = []
  let evN = 0
  // Extrait `@event={body}` (accolades ÉQUILIBRÉES) ou `@event=ref` → marqueur
  // + listener direct. L'ancien regex `\{([^{}]*)\}` interdisait toute
  // accolade dans le corps : `@click={reset({hard:true})}` produisait
  // `addEventListener('click', {reset: reset({hard:true})})` (2ᵉ arg = OBJET
  // littéral, pas de handleEvent → bouton du fallback d'error-boundary MORT,
  // sans erreur de compilation). On scanne à profondeur équilibrée (jumeau exact
  // du comptage à accolades équilibrées de parseListeners). Markup malformé (`{` non fermé, ou `@x=` sans
  // valeur) → laissé tel quel, comme l'ancien regex.
  const src = content.trim()
  let marked = ''
  let last = 0
  const startRe = /@([\w-]+)=/g
  let fm: RegExpExecArray | null
  while ((fm = startRe.exec(src)) !== null) {
    const ev = fm[1]
    const valPos = fm.index + fm[0].length      // juste après le `=`
    let handler: string
    let consumedEnd: number
    if (src[valPos] === '{') {
      let k = valPos + 1, depth = 1, body = ''
      while (k < src.length && depth > 0) {
        const c = src[k]
        if (c === '{') depth++
        else if (c === '}') { depth--; if (depth === 0) break }
        body += c
        k++
      }
      if (depth !== 0) { startRe.lastIndex = valPos; continue }   // `{` non fermé : ignoré
      handler = `(event) => (${body.trim()})`
      consumedEnd = k + 1                          // après la `}`
    } else {
      let k = valPos
      while (k < src.length && !/[\s>]/.test(src[k])) k++
      if (k === valPos) { startRe.lastIndex = valPos; continue }  // pas de valeur : ignoré
      handler = src.slice(valPos, k)
      consumedEnd = k
    }
    const marker = `data-mjsfe-${evN}`
    wires.push(`_mjs_e${evN} = _mjs_d.querySelector('[${marker}]')`)
    wires.push(`_mjs_e${evN}?.removeAttribute('${marker}')`)
    wires.push(`_mjs_e${evN}?.addEventListener('${ev}', ${handler})`)
    evN++
    marked += src.slice(last, fm.index) + marker
    last = consumedEnd
    startRe.lastIndex = consumedEnd
  }
  marked += src.slice(last)
  const htmlExpr = buildHeadInjection(marked, 'failed', errors, firstLine, sigil)
  // `_mjs_failedRetry`/`_mjs_failedRetryMsg` : posés en SETUP (constructeur, une
  // fois par instance) — PAS dans `body` (le corps du fallback, qui ne tourne
  // qu'AU CRASH) : `_mjs_catchError` doit lire la limite AVANT même d'appeler
  // `_mjs_fallback`, pour construire (ou pas) un `reset` qui fonctionne.
  return {
    setup: [
      `@_mjs_failedRetry = ${retryLimit}`,
      `@_mjs_failedRetryMsg = ${JSON.stringify(t('transpiler.failed-boundary-retry-epuise', { limit: retryLimit }))}`,
    ],
    head: `@_mjs_fallback = (${argStr}) =>`,
    body: [`_mjs_d = document.createElement('div')`, `_mjs_d.innerHTML = ${htmlExpr}`, ...wires, `_mjs_d`],
  }
}

// findMacroTagEnd — déplacée dans
// macro-tag.ts (bandeau complet là-bas) — sections.ts en a besoin pour son
// propre masquage <@head>/<@failed>, sans créer de cycle d'import (macros.ts
// importe déjà sections.ts pour `extractSections`). Ré-exportée ici pour
// compatibilité : imports existants (`from '../src/transpiler/macros.js'`
// dans les tests) et usage interne (replaceOpenTag/replacePairedTag,
// plus bas) inchangés.
export { findMacroTagEnd } from './macro-tag.js'

// reportUnclosedMacroTag — SEUL point où `findMacroTagEnd`
// rend -1 sur une balise macro RECONNUE (boundaryOk vrai) → accolade jamais
// refermée (un guillemet seul jamais refermé ne déclenche PAS -1, tolérance
// documentée plus haut). AVANT : la balise fautive restait telle quelle dans
// le HTML, build VERT, silence total. `extrait` = 60 premiers caractères de
// la balise (depuis `<@`), sauts de ligne aplatis en espace — une erreur par
// balise fautive (appelé une seule fois par `idx`, jamais rejoué).
//
// deux défauts trouvés dans
// CE correctif : (1) <@head> passe par `replacePairedTag` (forme contenu)
// PUIS par la boucle TARGETS (§ 1 plus bas, forme écouteur) — quand
// `findMacroTagEnd` rend -1 dans les DEUX passes sur la MÊME occurrence
// (html inchangé entre les deux), le message était poussé deux fois,
// identique ; `bundler/index.ts` joint `macroErrors` dans un seul throw →
// phrase dupliquée pour l'utilisateur. Fix : dédoublonnage par texte EXACT
// (`errors.includes(msg)`), robuste aux deux passes sans dépendre du nom de
// macro ni de l'appelant. (2) `html.slice(idx, idx + 60)` compte en unités
// UTF-16 : une paire de substituts (émoji) à cheval sur la coupe produisait
// un substitut isolé dans le message. Fix : découpe par POINTS DE CODE
// (`Array.from`) — tranche de 120 unités avant le `slice(0, 60)`, pour
// garantir au moins 60 points de code (sauf fin de texte).
function reportUnclosedMacroTag(errors: string[], macro: string, html: string, idx: number): void {
  const extrait = Array.from(html.slice(idx, idx + 120)).slice(0, 60).join('').replace(/\n/g, ' ')
  const msg = t('transpiler.macro-balise-non-fermee', { macro, extrait })
  if (errors.includes(msg)) return    // déjà signalée (2e passe replacePairedTag/TARGETS sur <@head>)
  // eslint-disable-next-line no-console
  console.error(`[ModularJS] ❌ ${msg}`)
  errors.push(msg)
}

// replaceOpenTag — remplace chaque balise ouvrante `<@name …>` (insensible à
// la casse) par `cb(attrs, wholeTag)`. `attrs` = tout ce qui suit le nom
// jusqu'au `>` réel (via findMacroTagEnd) — BYTE-IDENTIQUE à ce que
// capturaient les anciennes regex `([^>]*)`/`([^>]+?)` pour tout cas SANS `>`
// niché dans une accolade/chaîne. `wholeTag` = balise entière (pour un
// éventuel retour « inchangé », ex. attrs vide sur <@element>/<@module>).
// `requireLeadingSpace` reproduit le `\s+` obligatoire de <@element>/
// <@module> (contenu requis) ; sinon la frontière de nom est celle des
// anciennes regex `\b`/bare, RENFORCÉE ici (demande explicite) : le caractère
// qui suit le nom doit être un blanc, `/`, `>` ou la fin de chaîne — sinon ce
// n'est pas la macro visée (`<@windowx>` reste intact). `errors` reçoit
// `macro-balise-non-fermee` si `findMacroTagEnd` ne trouve jamais son
// `>` sur une balise reconnue — le HTML est laissé tel quel, comme avant.
// Exception AJOUTÉE à `requireLeadingSpace` : un `>` IMMÉDIAT
// (`<@element>` bare, zéro caractère entre le nom et la fermeture) compte aussi comme
// frontière valide, pour que le corps de la macro reçoive `attrs` VIDE et rapporte
// `element-variable-attendue` au lieu de laisser la balise littérale intacte face à sa
// fermante convertie en `</div>` (dépareillée, aucune erreur). Fin de chaîne reste HORS de
// cette exception (inchangée).
// `/` COLLÉ (`<@element/>`, zéro espace avant le
// slash) rejoint aussi les frontières valides : SANS cette entrée, `boundaryOk` valait faux
// pour cette forme précise (seul `<@element $tag/>`, espacé, passait), la balise entière
// traversait en silence, jamais vue par `cb` ni par la garde « auto-fermeture interdite »
// (`reportSelfCloseForbidden`, plus bas) — celle-ci s'applique désormais aux deux formes.
function replaceOpenTag(
  html: string,
  name: string,
  requireLeadingSpace: boolean,
  errors: string[],
  cb: (attrs: string, wholeTag: string) => string
): string {
  const needle = `<@${name}`.toLowerCase()
  const lower = html.toLowerCase()
  let out = ''
  let pos = 0
  for (;;) {
    const idx = lower.indexOf(needle, pos)
    if (idx === -1) { out += html.slice(pos); return out }
    const nameEnd = idx + needle.length
    const boundary = html[nameEnd]
    const boundaryOk = requireLeadingSpace ? (boundary !== undefined && (/\s/.test(boundary) || boundary === '>' || boundary === '/')) : (boundary === undefined || /[\s/>]/.test(boundary))
    const tagEnd = boundaryOk ? findMacroTagEnd(html, nameEnd) : -1
    if (tagEnd === -1) { if (boundaryOk) reportUnclosedMacroTag(errors, name, html, idx); out += html.slice(pos, idx + 1); pos = idx + 1; continue }
    out += html.slice(pos, idx) + cb(html.slice(nameEnd, tagEnd), html.slice(idx, tagEnd + 1))
    pos = tagEnd + 1
  }
}

// replacePairedTag — remplace chaque `<@name attrs>…contenu…</@name>` par
// `cb(attrs, content)`. `onSelfClose(attrs)`, si fourni, capte une forme
// `<@name …/>` (attrs se terminant par `/`, adjacent au `>` réel — même
// exigence que l'ancienne regex `\/>`) SANS chercher de contenu ni de
// fermeture. Aucune fermeture `</@name>` trouvée → balise + reste laissés
// intacts (comme une regex qui ne matche pas). `errors` : cf. replaceOpenTag
// ci-dessus (même garde `macro-balise-non-fermee`) — seulement sur le
// `>` de la balise OUVRANTE, pas sur une fermeture `</@name>` absente
// (comportement inchangé, hors périmètre de cette garde).
function replacePairedTag(
  html: string,
  name: string,
  errors: string[],
  cb: (attrs: string, content: string) => string,
  onSelfClose?: (attrs: string) => string
): string {
  const openNeedle = `<@${name}`.toLowerCase()
  const closeNeedle = `</@${name}>`.toLowerCase()
  const lower = html.toLowerCase()
  let out = ''
  let pos = 0
  for (;;) {
    const idx = lower.indexOf(openNeedle, pos)
    if (idx === -1) { out += html.slice(pos); return out }
    const nameEnd = idx + openNeedle.length
    const boundary = html[nameEnd]
    const boundaryOk = boundary === undefined || /[\s/>]/.test(boundary)
    const tagEnd = boundaryOk ? findMacroTagEnd(html, nameEnd) : -1
    if (tagEnd === -1) { if (boundaryOk) reportUnclosedMacroTag(errors, name, html, idx); out += html.slice(pos, idx + 1); pos = idx + 1; continue }
    const attrs = html.slice(nameEnd, tagEnd)
    if (onSelfClose && attrs.endsWith('/')) {
      out += html.slice(pos, idx) + onSelfClose(attrs.slice(0, -1))
      pos = tagEnd + 1
      continue
    }
    const closeIdx = lower.indexOf(closeNeedle, tagEnd + 1)
    if (closeIdx === -1) { out += html.slice(pos, idx + 1); pos = idx + 1; continue }
    out += html.slice(pos, idx) + cb(attrs, html.slice(tagEnd + 1, closeIdx))
    pos = closeIdx + closeNeedle.length
  }
}

export function processGlobalMacros(html: string, opts: { firstLine?: number; sigil?: 'µ' | 'mjs' } = {}): GlobalMacrosResult {
  // ligne du .mjs où commence CE html (section HTML, cf. extractSections().htmlStartLine) : sert à
  // citer un numéro de ligne juste dans les erreurs de <@head>/<@failed>. 1 par défaut. `sigil` =
  // symbole du projet, pour rendre dans ces mêmes messages le `mjs.`/`mjs$` tapé par l'auteur (le
  // HTML arrive ici normalisé en `µ`).
  const firstLine = opts.firstLine ?? 1
  const sigil     = opts.sigil
  const setupLines: string[] = []
  // Lignes d'ATTACHE (addEventListener) — rejouées à CHAQUE @awake, et
  // détachées à CHAQUE sleep (teardownLines) : cycle symétrique qui survit
  // aux hibernations (pageCache, déplacement DOM) sans fuir. Les DÉFINITIONS
  // de handlers (@_gl_x = …), elles, restent dans setupLines (init, une fois).
  const attachLines: string[] = []
  const teardownLines: string[] = []
  // Erreurs de compile des liaisons class/style (cf. parseStyling plus bas).
  const errors: string[] = []

  // Ligne du .mjs où commence le contenu (TRIMMÉ) d'un bloc <@head>/<@failed>. `cleaned` a pu être
  // réécrit avant que le bloc soit atteint (commentaire à pseudo-directive retiré, <@failed> déjà
  // compilé) : ses sauts de ligne ne sont plus ceux du source, on recompte donc sur le `html`
  // d'ORIGINE, un curseur par macro pour suivre les occurrences dans l'ordre. Contenu introuvable
  // (réécrit en amont) → première ligne de la section, jamais un numéro inventé.
  const lineCursor: Record<string, number> = {}
  const contentFirstLine = (macro: string, content: string): number => {
    const trimmed = content.trim()
    if (!trimmed) return firstLine
    const at = html.indexOf(trimmed, lineCursor[macro] ?? 0)
    if (at === -1) return firstLine
    lineCursor[macro] = at + trimmed.length
    return firstLine + countNewlines(html.slice(0, at))
  }

  // Généralisation de la règle <@include nom/> (slash
  // final interdit, cf. processIncludes ci-dessus) à
  // <@element>/<@module>/<@failed> : ces 3 macros à CONTENU n'ont jamais eu de
  // forme auto-fermée valide (contrairement à <@window>/<@document>/<@body>/
  // <@html>, 100% auto-fermées en usage réel, ou à <@slot/> — idiome légitime
  // — NI touchées ici). <@head> ÉCARTÉ malgré la demande initiale :
  // il est AUSSI une cible d'écouteur global (clé de TARGETS, plus bas) et
  // <@head @event={...} /> auto-fermé y est un DEUXIÈME usage 100% légitime
  // et déjà testé — cf. le commentaire dédié au site § 1 ci-dessous. Même
  // diagnostic « soft » que <@include> : console.error + accumulation dans
  // `errors` (PAS de throw synchrone, pour laisser le scan du reste du
  // fichier continuer) — le caller (transpiler/index.ts → data.macroErrors →
  // bundler/index.ts) fait échouer le build.
  const reportSelfCloseForbidden = (macro: string): string => {
    const msg = t('transpiler.macro-auto-fermeture-interdite', { macro })
    // eslint-disable-next-line no-console
    console.error(`[ModularJS] ❌ ${msg}`)
    errors.push(msg)
    return ''
  }

  let cleaned = html
  let counter = 0

  // Neutralise les commentaires HTML qui contiennent une pseudo-directive
  // `<@…>` (ex. un commentaire explicatif citant `<@failed>`), sinon les regex
  // de macros ci-dessous matcheraient À L'INTÉRIEUR du commentaire. Les
  // commentaires normaux (sans `<@`) sont préservés.
  cleaned = cleaned.replace(/<!--[\s\S]*?-->/g, c => (/<@\w/.test(c) ? '' : c))

  // Parse les @event={handler} d'un tag macro → addEventListener/removeEventListener.
  const parseListeners = (attrs: string, targetJs: string) => {
    // `/@([\w-]+)(?!\.)/`
    // (1er essai) visait à rejeter un éventuel `@scroll.passive` (modificateurs
    // non supportés sur les macros — la forme abrégée générerait un appel vers
    // une méthode inexistante), mais un lookahead négatif APRÈS un quantifieur
    // GLOUTON ne bloque pas tout le match : si `scroll` (7 lettres) échoue le
    // `(?!\.)` (suivi d'un point), le moteur regex BACKTRACK et essaie des
    // préfixes plus courts — `scrol` (6 lettres) est suivi de `l`, PAS d'un
    // point, donc `(?!\.)` réussit sur CE préfixe tronqué. Résultat observé :
    // un handler fantôme `scrol(e)` posé via `addEventListener('scrol', …)` —
    // un event qui n'existe pas, silencieusement mort, ET la vraie forme
    // `@scroll.passive={…}` toujours ignorée. Fix : émule un groupe ATOMIQUE
    // (non natif en JS) via lookahead + rétro-référence — `(?=([\w-]+))\1` capture
    // le préfixe MAXIMAL puis le consomme tel quel (rien à raccourcir, `\1`
    // n'est pas quantifié) ; si `(?!\.)` échoue ENSUITE, tout le match à cette
    // position échoue pour de bon (pas de repli sur un préfixe plus court).
    //
    // Le `:` ENTRE dans la classe de caractères
    // (`[\w-]` → `[\w:-]`, `-` en fin de classe = littéral) : les événements du
    // framework sont NAMESPACÉS (`mjs:load`, `mjs:visit`, `mjs:before-visit`,
    // `mjs:before-cache` — cf. µ._mjs_navEmit, mjs_ujs.ts), et sans le deux-points
    // le lecteur s'arrêtait à `@mjs`, ne trouvait pas le `=` attendu juste
    // après (il y a un `:`), concluait « forme abrégée » → écouteur fantôme
    // `mjs` — PUIS repartait scanner la suite, où le `@relancer` DU HANDLER de
    // l'utilisateur devenait un SECOND écouteur fantôme, sur un événement
    // `relancer` qui n'existe nulle part. Deux écouteurs posés, aucun bon, zéro
    // avertissement : la seule forme documentée pour écouter un événement de
    // cycle sur `<@document>` était injoignable. Le chemin des ÉLÉMENTS
    // (generator/attributes/index.ts) n'avait, lui, jamais eu ce défaut.
    const evRe = /@(?=([\w:-]+))\1(?!\.)/g
    // Forme ABRÉGÉE (`@nom` seul, sans `={…}`) sur un nom à deux-points :
    // REFUSÉE. Elle synthétise un appel à la méthode HOMONYME de l'événement
    // (`mjs:load(e)`), que Civet compile sans broncher en bare-hash
    // (`{mjs: load(e)}`) — un objet jeté, un appel vers une fonction globale
    // `load` inexistante, et surtout AUCUNE erreur : le silence exact qu'on
    // refuse. Diagnostic « soft » (console.error + accumulation dans `errors`,
    // le build échoue plus haut) comme les autres erreurs de ce fichier.
    const refuseShorthandColon = (ev: string): boolean => {
      if (!ev.includes(':')) return false
      const msg = t('generator.event-deux-points-abrege', { evt: ev })
      // eslint-disable-next-line no-console
      console.error(`[ModularJS] ❌ ${msg}`)
      errors.push(msg)
      return true
    }
    // GARDE MODIFICATEUR SUR MACRO — `evRe` refuse par construction
    // tout `@evt.suffixe` (le `(?!\.)` atomique ci-dessus) : l'attribut était
    // donc IGNORÉ, en silence. Tolérable tant que les modificateurs n'existaient
    // que sur les éléments ; devenu un piège depuis que `@click.emit.NOM` est
    // une écriture enseignée — `<@window @resize.emit.sized={…}>` compilait vert
    // et n'émettait jamais rien. Même diagnostic « soft » que le reste du
    // fichier (console.error + `errors`, le build échoue plus haut). Appelé
    // APRÈS `parseStyling`, qui a déjà retiré `@class{…}`/`@style.x`/`--var`.
    {
      // FAUX POSITIF (même jour, trouvé en re-testant la garde) — scanner la chaîne
      // d'attributs ENTIÈRE prenait les `@prop.x` Civet du CORPS d'un handler pour des
      // modificateurs : `<@window @resize={@sizes.push window.innerWidth}>` (parfaitement
      // légitime, `@sizes` = `this.sizes`) était REFUSÉ à la compilation. On masque donc
      // les valeurs d'attributs avant de chercher : seuls les NOMS sont scannés.
      let masked = ''
      for (let i = 0; i < attrs.length; ) {
        // `={…}` (handler/expression) et `=!{…}` (liaison two-way) : accolades équilibrées.
        const bind = attrs[i] === '=' && (attrs[i + 1] === '{' || (attrs[i + 1] === '!' && attrs[i + 2] === '{'))
        if (bind) {
          const start = attrs[i + 1] === '{' ? i + 2 : i + 3
          masked += attrs.slice(i, start)
          let k = start, depth = 1
          while (k < attrs.length && depth > 0) {
            if (attrs[k] === '{') depth++
            else if (attrs[k] === '}') { depth--; if (depth === 0) break }
            masked += ' '
            k++
          }
          masked += attrs.slice(k, k + 1)
          i = k + 1
          continue
        }
        // `="…"` / `='…'` : valeur littérale, un `@x.y` dedans n'est pas un modificateur.
        if (attrs[i] === '=' && (attrs[i + 1] === '"' || attrs[i + 1] === "'")) {
          const quote = attrs[i + 1]
          let k = i + 2
          while (k < attrs.length && attrs[k] !== quote) k++
          // GUILLEMET NON FERMÉ — on ne masque RIEN : sinon un `@evt.suffixe` réel situé plus loin
          // sur la même balise disparaissait du scan, et la garde redevenait muette (exactement le
          // silence qu'elle existe pour supprimer). On avance d'un caractère et on continue.
          if (k >= attrs.length) { masked += attrs[i]; i++; continue }
          masked += attrs.slice(i, i + 2) + ' '.repeat(k - (i + 2)) + attrs.slice(k, k + 1)
          i = k + 1
          continue
        }
        masked += attrs[i]
        i++
      }
      const modRe = /@([\w:-]+)\.([\w:.-]*)/g
      let mm: RegExpExecArray | null
      while ((mm = modRe.exec(masked)) !== null) {
        const msg = t('generator.macro-modificateur-non-gere', { evt: mm[1], suffixe: mm[2] || '' })
        // eslint-disable-next-line no-console
        console.error(`[ModularJS] ❌ ${msg}`)
        errors.push(msg)
      }
    }

    let m: RegExpExecArray | null
    while ((m = evRe.exec(attrs)) !== null) {
      const ev = m[1]
      const after = m.index + m[0].length
      // Forme abrégée : pas de `={...}` → handler = fonction du nom de l'event.
      let handler: string
      // Corps BRUT (avant tout trim) — conservé pour l'émission multi-lignes
      // ci-dessous ; `null` pour la forme abrégée (pas de corps littéral).
      let rawBody: string | null = null
      if (attrs[after] === '=' && attrs[after + 1] === '{') {
        // Extraire le corps par comptage d'accolades équilibré : un handler
        // valide peut contenir des `}` (`@keydown={handle({key:1})}`), que
        // l'ancien `[^}]+` tronquait au premier `}` (Civet "Failed to parse").
        let k = after + 2, depth = 1, body = ''
        while (k < attrs.length && depth > 0) {
          const c = attrs[k]
          if (c === '{') depth++
          else if (c === '}') { depth--; if (depth === 0) break }
          body += c
          k++
        }
        rawBody = body
        handler = body.trim()
        evRe.lastIndex = k + 1
      } else if (attrs[after] === '=' && attrs[after + 1] !== '!') {
        // `@event=ref` SANS accolades (`@resize=onResize`) : référence de
        // fonction. Avant, cette forme tombait dans le `else` « abrégée » →
        // `resize(e)` (appel d'une fonction du NOM DE L'EVENT, ≠ onResize →
        // ReferenceError au premier resize, et `onResize` jamais câblé). On lit
        // la ref jusqu'au prochain espace/`>`/`/` (auto-fermeture `/>`) ;
        // l'auto-appel des identifiants nus (test plus bas) la rend `onResize(e)`.
        // Exclut `=!{…}` (liaison two-way `prop=!{$var}`, gérée par parseBindings).
        let k = after + 1
        while (k < attrs.length && !/[\s>/]/.test(attrs[k])) k++
        const ref = attrs.slice(after + 1, k)
        if (ref) { handler = ref; evRe.lastIndex = k }
        else { if (refuseShorthandColon(ev)) continue; handler = `${ev}(e)` }
      } else {
        if (refuseShorthandColon(ev)) continue
        handler = `${ev}(e)`
      }
      // Source à émettre : par défaut le corps BRUT multi-lignes (préserve le
      // nesting) ; retombe sur `handler` (single-line) pour la forme abrégée
      // sans accolades.
      let emitSource = rawBody ?? handler
      // Auto-appel si le handler est une RÉFÉRENCE de fonction nue (cf. élément).
      // (`handler` = version whole-string-trim : une référence nue tient
      // toujours sur une seule ligne, donc ce test ne peut JAMAIS matcher un
      // corps multi-lignes structuré — seul le cas bare-reference single-line
      // est concerné.) Si le test matche, la réécriture doit devenir la
      // source d'émission : `rawBody` (non modifié) serait sinon émis SANS
      // le `(e)` ajouté ici → référence nue jamais appelée (régression vécue
      // en écrivant le fix ci-dessous, verrouillée par le test dédié).
      if (/^@{0,2}[a-zA-Z_][\w$.]*$/.test(handler)) {
        handler = `${handler}(e)`
        emitSource = handler
      }
      const fnId = `gl_${(counter++).toString(36)}`
      setupLines.push(`@_${fnId} = (e, _) =>`)
      // Émission avec `dedent` + réindentation UNIFORME — PAS un `.trim()`
      // PAR LIGNE (bug d'origine) — pour préserver la structure d'un handler
      // multi-lignes (`if…\n  $x = …`). Un `.trim()` par ligne ramenait
      // TOUTES les lignes au même niveau : en Civet/Coffee (sensible à
      // l'indentation), le `if` se retrouvait avec un corps VIDE et la ligne
      // suivante s'exécutait INCONDITIONNELLEMENT juste après, sans la
      // moindre erreur de compilation (corruption silencieuse de la logique
      // utilisateur). Même algorithme que le chemin inline des éléments
      // (generator/attributes/index.ts, `dedent(...).split('\n')`).
      //
      // On dédente `emitSource` (le corps BRUT quand il existe, AVANT le
      // `.trim()` whole-string qui a produit `handler`), puis on ne retire
      // que les lignes VIDES en tête/fin — sans jamais toucher à
      // l'indentation relative des lignes gardées. Nécessaire : `.trim()` sur
      // toute la chaîne ampute SEULEMENT la 1ʳᵉ ligne de son indentation (elle
      // colle au début du body) ; si on dédentait APRÈS ce trim, deux lignes
      // sœurs à indentation ÉGALE dans la source (`$a = 1\n  $b = 2`, toutes
      // deux à 2 espaces à l'origine) ressortiraient à des niveaux DIFFÉRENTS
      // (0 puis 2) — nouvelle corruption, cette fois sur des instructions qui
      // n'ont pas de lien de nesting. Dédenter le corps brut évite ce piège
      // dans les deux sens.
      const dedentedBody = dedent(emitSource).split('\n')
      while (dedentedBody.length > 0 && dedentedBody[0].trim() === '') dedentedBody.shift()
      while (dedentedBody.length > 0 && dedentedBody[dedentedBody.length - 1].trim() === '') dedentedBody.pop()
      const bodyLines = dedentedBody.length > 0 ? dedentedBody : [handler]
      for (const line of bodyLines) setupLines.push(`  ${line}`)
      attachLines.push(`${targetJs}.addEventListener('${ev}', @_${fnId})`)
      teardownLines.push(`${targetJs}.removeEventListener('${ev}', @_${fnId})`)
    }
  }

  // Parse les LIAISONS `prop=!{$var}` d'un <@window> → liaison réactive auto sur
  // une propriété de window (scrollY, innerWidth…). Équivalent des bind:* de
  // <svelte:window>. Réservé à <@window> (comme Svelte).
  //   <@window scrollY=!{$y} innerWidth=!{$w} />
  const parseBindings = (attrs: string, macro: string) => {
    if (macro !== 'window') return
    const bindRe = /\b([a-zA-Z]\w*)=!\{([^}]+)\}/g
    let m: RegExpExecArray | null
    while ((m = bindRe.exec(attrs)) !== null) {
      const prop = m[1]
      const varExpr = m[2].trim()           // ex. `$y`
      // lookup par hasOwnProperty : `WINDOW_BINDABLE[prop]` nu rendait une
      // fonction TRUTHY pour un nom hérité de Object.prototype (`constructor`, `toString`,
      // `hasOwnProperty`…), contournant le garde `!def` ci-dessous — `def.events` (undefined sur
      // cette fonction native) faisait alors planter le `for…of` plus bas avec un TypeError NON
      // rattrapé au lieu du message propre.
      const def = Object.prototype.hasOwnProperty.call(WINDOW_BINDABLE, prop) ? WINDOW_BINDABLE[prop] : undefined
      if (!def) {
        // eslint-disable-next-line no-console
        console.error(t('transpiler.window-propriete-non-liable', { prop, liables: Object.keys(WINDOW_BINDABLE).join(', ') }))
        continue
      }
      // 1. valeur initiale (au setup, une fois)
      setupLines.push(`${varExpr} = ${def.read}`)
      // 2. handler de rafraîchissement + attache/détache symétrique (awake/sleep)
      const fnId = `glb_${(counter++).toString(36)}`
      setupLines.push(`@_${fnId} = (e, _) =>`)
      setupLines.push(`  ${varExpr} = ${def.read}`)
      for (const ev of def.events) {
        attachLines.push(`window.addEventListener('${ev}', @_${fnId})`)
        teardownLines.push(`window.removeEventListener('${ev}', @_${fnId})`)
      }
      // 3. two-way (scroll seulement) : un µeffect pousse la var vers window.
      if (def.write) {
        setupLines.push('µeffect =>')
        setupLines.push(`  ${def.write(varExpr)}`)
      }
    }
  }

  // Scanne un bloc { … } à profondeur ÉQUILIBRÉE à partir de l'indice JUSTE
  // APRÈS l'accolade ouvrante (même technique que dans parseListeners, pour
  // capter des accolades/parenthèses imbriquées dans une condition/expression).
  // Retourne le corps et l'indice JUSTE APRÈS la '}' fermante.
  const scanBraces = (s: string, start: number): { body: string; end: number } => {
    let k = start, depth = 1, body = ''
    while (k < s.length && depth > 0) {
      const c = s[k]
      if (c === '{') depth++
      else if (c === '}') { depth--; if (depth === 0) break }
      body += c
      k++
    }
    return { body, end: k + 1 }
  }

  // Parse + retire les liaisons class/style d'une macro globale :
  //   @class{cond}="a b" | @style.prop={expr} | --var={expr} | class="a b" | style="…"
  // RÉSERVÉES à <@body>/<@html> (macro === 'body' || 'html') : sur les autres
  // cibles (window/document/head), toute forme détectée devient une ERREUR de
  // compile — jamais un codegen silencieux, et SURTOUT jamais laissée filer
  // vers `parseListeners` : `@class{…}` y serait pris pour un écouteur fantôme
  // de l'événement « class » (@class contient littéralement la
  // sous-chaîne `class`, et `(?!\.)` dans evRe ne le bloque pas puisqu'un `{`
  // suit, pas un `.`). D'où l'appel à cette fonction AVANT `parseListeners`,
  // quelle que soit la cible, et le retour des attrs NETTOYÉS (les formes
  // reconnues sont toujours retirées de la chaîne, même quand c'est une erreur).
  //
  // Ordre de parsing CRITIQUE (d'abord les formes à sigil, puis les statiques) :
  // en retirant `@class{…}`/`@style.`/`--var` de la chaîne AVANT de chercher
  // `class="…"`/`style="…"`, on élimine par construction tout risque qu'une
  // regex statique volontairement simple morde dans une forme dynamique (ou
  // dans une expression `{…}` qui contiendrait elle-même un bout de texte
  // ressemblant à `class="…"`).
  const parseStyling = (attrs: string, macro: string, targetJs: string): string => {
    const allowed = macro === 'body' || macro === 'html'
    let s = attrs
    let found = false

    // 1. @class{cond}="a b" — condition à accolades équilibrées (même principe).
    {
      let out = '', last = 0, m: RegExpExecArray | null
      const re = /@class\{/g
      while ((m = re.exec(s)) !== null) {
        const { body: cond, end } = scanBraces(s, m.index + m[0].length)
        if (s[end] !== '=' || s[end + 1] !== '"') { re.lastIndex = end; continue }   // forme malformée : laissée telle quelle
        const qEnd = s.indexOf('"', end + 2)
        if (qEnd === -1) { re.lastIndex = end; continue }
        found = true
        out += s.slice(last, m.index)
        last = qEnd + 1
        re.lastIndex = qEnd + 1
        if (allowed) {
          const classes = s.slice(end + 2, qEnd).split(/\s+/).filter(Boolean)
          setupLines.push('µeffect =>')
          for (const cls of classes) setupLines.push(`  µ._glCl(@, ${targetJs}, '${cls}', !!(${cond.trim()}))`)
          for (const cls of classes) teardownLines.push(`µ._glCl(@, ${targetJs}, '${cls}', false)`)
        }
      }
      out += s.slice(last)
      s = out
    }

    // 2. @style.<prop>={expr} — prop kebab-case, expr à accolades équilibrées.
    {
      let out = '', last = 0, m: RegExpExecArray | null
      const re = /@style\.([\w-]+)=\{/g
      while ((m = re.exec(s)) !== null) {
        const prop = m[1]
        const { body: expr, end } = scanBraces(s, m.index + m[0].length)
        found = true
        out += s.slice(last, m.index)
        last = end
        re.lastIndex = end
        if (allowed) {
          setupLines.push('µeffect =>')
          setupLines.push(`  µ._glSt(@, ${targetJs}, '${prop}', (${expr.trim()}))`)
          teardownLines.push(`µ._glSt(@, ${targetJs}, '${prop}', null)`)
        }
      }
      out += s.slice(last)
      s = out
    }

    // 3. --<var>={expr} — même mécanique que 2, prop émise = '--<var>'.
    {
      let out = '', last = 0, m: RegExpExecArray | null
      const re = /--([a-zA-Z_][\w-]*)=\{/g
      while ((m = re.exec(s)) !== null) {
        const varName = m[1]
        const { body: expr, end } = scanBraces(s, m.index + m[0].length)
        found = true
        out += s.slice(last, m.index)
        last = end
        re.lastIndex = end
        if (allowed) {
          setupLines.push('µeffect =>')
          setupLines.push(`  µ._glSt(@, ${targetJs}, '--${varName}', (${expr.trim()}))`)
          teardownLines.push(`µ._glSt(@, ${targetJs}, '--${varName}', null)`)
        }
      }
      out += s.slice(last)
      s = out
    }

    // 4. class="a b" statique (formes à sigil déjà retirées ci-dessus : plus
    //    aucun risque qu'elles interfèrent avec cette regex volontairement simple).
    {
      let out = '', last = 0, m: RegExpExecArray | null
      const re = /\bclass="([^"]*)"/g
      while ((m = re.exec(s)) !== null) {
        found = true
        out += s.slice(last, m.index)
        last = m.index + m[0].length
        re.lastIndex = last
        if (allowed) {
          const raw = m[1]
          if (raw.includes('{')) {
            errors.push(t('transpiler.macro-class-interpolation-non-supportee', { macro }))
          } else {
            const classes = raw.split(/\s+/).filter(Boolean)
            for (const cls of classes) attachLines.push(`µ._glCl(@, ${targetJs}, '${cls}', true)`)
            for (const cls of classes) teardownLines.push(`µ._glCl(@, ${targetJs}, '${cls}', false)`)
          }
        }
      }
      out += s.slice(last)
      s = out
    }

    // 5. style="…" statique → TOUJOURS une erreur (règle MJS zéro-CSS-inline),
    //    y compris sur <@body>/<@html> où les 4 formes précédentes sont valides.
    {
      let out = '', last = 0, m: RegExpExecArray | null
      const re = /\bstyle="([^"]*)"/g
      while ((m = re.exec(s)) !== null) {
        found = true
        out += s.slice(last, m.index)
        last = m.index + m[0].length
        re.lastIndex = last
        if (allowed) {
          errors.push(t('transpiler.macro-style-inline-interdit', { macro }))
        }
      }
      out += s.slice(last)
      s = out
    }

    if (!allowed && found) {
      errors.push(t('transpiler.macro-class-non-supportee-cible', { macro }))
    }

    return s
  }

  // Attribut `accept="a b"` de <@element>/<@module> :
  // liste LITTÉRALE de noms de balises (statique, insensible à la casse du NOM `accept` comme
  // des valeurs), TOUJOURS retirée des attributs rendus (jamais un vrai attribut DOM). Émise en
  // 4ᵉ argument de µ._updDynEl/µ._updModule (runtime déjà en place, cf. mjs_runes.ts
  // µ._mjs_dynTagsRefuses) : PRÉSENT, ce 4ᵉ argument devient côté runtime une liste FERMÉE —
  // seuls les noms qu'il contient sont créés, pool ou pas.
  // Absente → { accept: null } (appel runtime à 3 arguments, byte-identique à l'ancien).
  // Invalide (vide, dynamique `accept={…}`, nom hors `[a-zA-Z][\w-]*`) → erreur de compile ET
  // quand même retirée (jamais laissée fuiter sur l'élément) ; `accept: null` en retour, comme
  // absente. Doublons tolérés (dédoublonnés, insensible à la casse).
  const TAG_NAME_RE = /^[a-zA-Z][\w-]*$/
  // stripOneAccept — extrait UNE occurrence d'`accept=…` (guillemets ou accolades), sans juger
  // de sa validité ; extractAcceptAttr ci-dessous l'appelle EN BOUCLE pour purger un doublon
  // (`.exec()` seul ne prenait que la 1ʳᵉ occurrence, la 2ᵉ fuyait telle quelle dans le HTML rendu).
  const stripOneAccept = (s: string): { rest: string; valeur: string | null; dynamic: boolean } => {
    const m = /(?<=^|\s)accept\s*=\s*/i.exec(s)
    if (!m) return { rest: s, valeur: null, dynamic: false }
    let wsStart = m.index
    while (wsStart > 0 && /\s/.test(s[wsStart - 1])) wsStart--
    const eqEnd = m.index + m[0].length
    const delim = s[eqEnd]
    let valeur: string | null = null, spanEnd = eqEnd, dynamic = false
    if (delim === '"' || delim === '\'') {
      const close = s.indexOf(delim, eqEnd + 1)
      if (close !== -1) { valeur = s.slice(eqEnd + 1, close); spanEnd = close + 1 }
    } else if (delim === '{') {
      const { body, end } = scanBraces(s, eqEnd + 1)
      valeur = body.trim()
      spanEnd = end
      dynamic = true
    }
    if (valeur === null) return { rest: s, valeur: null, dynamic: false }    // délimiteur absent/non reconnu : pas notre affaire
    const rest = (s.slice(0, wsStart) + s.slice(spanEnd)).trim()
    return { rest, valeur, dynamic }
  }
  const extractAcceptAttr = (attrs: string): { rest: string; accept: string[] | null } => {
    const first = stripOneAccept(attrs)
    if (first.valeur === null) return { rest: attrs, accept: null }
    const valeur = first.valeur, dynamic = first.dynamic, rest1 = first.rest
    // `accept` DUPLIQUÉ (`accept="a" accept="b"`) :
    // purge TOUTES les occurrences restantes (au cas où il y en aurait plus de deux) ; deux ou
    // plus = erreur, valeur citée = la 2ᵉ occurrence.
    const second = stripOneAccept(rest1)
    if (second.valeur !== null) {
      let rest = second.rest
      let extra = stripOneAccept(rest)
      while (extra.valeur !== null) { rest = extra.rest; extra = stripOneAccept(rest) }
      errors.push(t('transpiler.element-accept-invalide', { valeur: second.valeur }))
      return { rest, accept: null }
    }
    const names = valeur.split(/\s+/).filter(Boolean)
    if (dynamic || names.length === 0 || !names.every(n => TAG_NAME_RE.test(n))) {
      errors.push(t('transpiler.element-accept-invalide', { valeur }))
      return { rest: rest1, accept: null }
    }
    return { rest: rest1, accept: [...new Set(names.map(n => n.toLowerCase()))] }
  }

  // La variable de balise (1ʳᵉ valeur après le nom
  // de macro) doit venir AVANT les attributs : `<@element accept="iframe" $tag>` faisait avaler
  // `accept="iframe"` comme EXPRESSION de balise (compile en `µ._updDynEl(@, '0', (accept="iframe"))`)
  // et laissait `$tag` fuir tel quel dans le HTML rendu, SANS erreur — même défaut avec n'importe
  // quel attribut en tête (`title="x"`). `nom=valeur`/`nom={…}` en 1ʳᵉ position = un attribut,
  // jamais une expression de balise valide (qui commence par `$`, un identifiant seul, une
  // parenthèse…) : erreur de build, rien émis en setup.
  const ATTR_LIKE_RE = /^[A-Za-z_][\w-]*=/
  // Un attribut BOOLÉEN sans `=` en tête (`<@element hidden $tag>`)
  // échappait à ATTR_LIKE_RE (qui exige un `=`) : `hidden` ressemble à un identifiant nu ORDINAIRE
  // (aucun `$`/`{`/guillemet/µ/@ devant), avalé tel quel comme expression de balise, `$tag` fuyait
  // en HTML sans erreur. `<@element tag>` seul (rien après) reste licite (variable de module
  // possible) : la détection ne regarde le token nu qu'EN PRÉSENCE d'un token plus loin qui, lui,
  // ressemble bien à une variable — cf. site d'appel.
  const BARE_IDENT_RE = /^[A-Za-z_][\w-]*$/
  const reportVariableAttendue = (macro: string, wholeTag: string): string => {
    const extrait = Array.from(wholeTag).slice(0, 60).join('').replace(/\n/g, ' ')
    const msg = t('transpiler.element-variable-attendue', { macro, extrait })
    // eslint-disable-next-line no-console
    console.error(`[ModularJS] ❌ ${msg}`)
    errors.push(msg)
    return ''
  }
  // 1ʳᵉ valeur COMMENÇANT par `{` (`<@element {a || 'div'}>`) :
  // aucune forme entre accolades n'est documentée (docs/15 : « le tag EST la variable », calcul dans
  // une dérivée `$tag = …`). `extrait` = le token `{…}` COMPLET via scanBraces (jamais tronqué au 1er
  // espace interne, contrairement à l'ancien découpage `raw.search(/\s/)` qui laissait le reste fuir
  // en HTML sans erreur — cf. site d'appel).
  const reportExpressionInterdite = (macro: string, extrait: string): string => {
    const msg = t('transpiler.element-expression-interdite', { macro, extrait })
    // eslint-disable-next-line no-console
    console.error(`[ModularJS] ❌ ${msg}`)
    errors.push(msg)
    return ''
  }

  // 0. <@element $var …attrs…>enfants</@element> → BALISE DYNAMIQUE
  //    (équivalent de <svelte:element>). Le tag est la VARIABLE/expression (1ʳᵉ
  //    valeur après `@element`) : `<@element $tag>`. Pas d'attribut `tag=` à
  //    apprendre, et pas de tag en string en dur (autant écrire la balise
  //    directement). On rend un placeholder <div mjs-el="N"> avec les enfants
  //    (rendus normalement, réactifs) ; un µeffect appelle µ._updDynEl(@, 'N',
  //    (EXPR)) qui swappe le vrai tag au mount + à chaque changement (déplace
  //    les enfants, copie les attrs). `</@element>` → `</div>`. Attributs HTML
  //    statiques optionnels après le tag ; attrs et événements réactifs suivis à travers le remplacement de nœud (resync `_mjs_nodes`/`_mjs_ids`, cf. mjs_runes.ts).
  let elCounter = 0
  cleaned = replaceOpenTag(cleaned, 'element', true, errors, (attrs, wholeTag) => {
    // `attrs` vient de findMacroTagEnd : équivaut au `\s+([^>]+?)\s*`
    // de l'ancienne regex UNE FOIS trimé (le `\s+` obligatoire et le `\s*` final
    // n'apportaient jamais de caractère hors espace, cf. header de replaceOpenTag).
    const rawBody = attrs.trim()
    // Auto-fermeture interdite (rejet explicite, à la
    // place du STRIP SILENCIEUX d'origine `.replace(/\/+$/, '')`, cf. header
    // de fonction).
    if (/\/+$/.test(rawBody)) return reportSelfCloseForbidden('element')
    const raw = rawBody
    // `raw` VIDE (`<@element>` seul) laissait l'ouvrante littérale face à la
    // fermante `</div>` (dépareillées, cf. remplacement global juste après cette fonction).
    if (!raw) return reportVariableAttendue('element', wholeTag)
    // 1ʳᵉ valeur À ACCOLADES (`<@element {a || 'div'}>`) : erreur explicite, extrait
    // = le token `{…}` complet (scanBraces), AVANT le découpage au 1er espace ci-dessous (qui
    // tronquait sinon l'expression et laissait son reste fuir en HTML).
    if (raw[0] === '{') { const { end } = scanBraces(raw, 1); return reportExpressionInterdite('element', raw.slice(0, end)) }
    // tag = la variable/expression (1ʳᵉ valeur, sans espace) ; le reste = attrs.
    const i = raw.search(/\s/)
    const tagExpr = i < 0 ? raw : raw.slice(0, i)
    const apresTag = i < 0 ? '' : raw.slice(i + 1).trim()
    if (ATTR_LIKE_RE.test(tagExpr) || (BARE_IDENT_RE.test(tagExpr) && /(^|\s)[$\{]/.test(apresTag))) return reportVariableAttendue('element', wholeTag)
    const { rest, accept } = extractAcceptAttr(apresTag)
    const key = String(elCounter++)    // `=>` (fat arrow) pour que `@` = le composant (l'IIFE est .call(this) ;
    // les effets du générateur capturent `this` pareil). Un `->` aurait `this`
    // = l'objet effet → `@._shadow` undefined.
    setupLines.push('µeffect =>')
    // `accept` en 4ᵉ argument SEULEMENT s'il est présent et valide ;
    // sinon appel à 3 arguments, inchangé (byte-identique aux composants sans `accept`).
    setupLines.push(`  µ._updDynEl(@, '${key}', (${tagExpr})${accept ? `, [${accept.map(a => `'${a}'`).join(', ')}]` : ''})`)
    return `<div mjs-el="${key}"${rest ? ' ' + rest : ''}>`
  })
  cleaned = cleaned.replace(/<\/@element>/gi, '</div>')

  // 0a. <@module $comp …attrs…>enfants</@module> → COMPOSANT DYNAMIQUE
  //     (équivalent de <svelte:component this={X}>). `$comp` (1ʳᵉ valeur) désigne
  //     le composant à monter : soit un NOM de tag (chaîne kebab d'un custom
  //     element MJS défini, le cas idiomatique), soit une CLASSE/constructeur.
  //     Même mécanique que <@element> mais via µ._updModule, qui instancie le
  //     COMPOSANT (createElement pour un tag, `new` best-effort pour une classe),
  //     déplace les enfants (light DOM → slots), copie les attrs (= props), et
  //     re-monte si $comp change. `</@module>` → `</div>`.
  let modCounter = 0
  cleaned = replaceOpenTag(cleaned, 'module', true, errors, (attrs, wholeTag) => {
    // cf. commentaire jumeau sur <@element> ci-dessus.
    const rawBody = attrs.trim()
    // Même rejet explicite que <@element> ci-dessus.
    if (/\/+$/.test(rawBody)) return reportSelfCloseForbidden('module')
    const raw = rawBody
    // cf. commentaire jumeau sur <@element> ci-dessus.
    if (!raw) return reportVariableAttendue('module', wholeTag)
    // cf. commentaire jumeau sur <@element> ci-dessus.
    if (raw[0] === '{') { const { end } = scanBraces(raw, 1); return reportExpressionInterdite('module', raw.slice(0, end)) }
    // comp = la variable/expression (1ʳᵉ valeur, sans espace) ; le reste = attrs.
    const i = raw.search(/\s/)
    const compExpr = i < 0 ? raw : raw.slice(0, i)
    const apresComp = i < 0 ? '' : raw.slice(i + 1).trim()
    if (ATTR_LIKE_RE.test(compExpr) || (BARE_IDENT_RE.test(compExpr) && /(^|\s)[$\{]/.test(apresComp))) return reportVariableAttendue('module', wholeTag)
    const { rest, accept } = extractAcceptAttr(apresComp)
    const key = String(modCounter++)    // `=>` (fat arrow) pour que `@` = le composant (cf. <@element> ci-dessus).
    setupLines.push('µeffect =>')
    // cf. commentaire jumeau sur <@element> ci-dessus.
    setupLines.push(`  µ._updModule(@, '${key}', (${compExpr})${accept ? `, [${accept.map(a => `'${a}'`).join(', ')}]` : ''})`)
    return `<div mjs-mod="${key}"${rest ? ' ' + rest : ''}>`
  })
  cleaned = cleaned.replace(/<\/@module>/gi, '</div>')

  // 0b. <@failed args>…</@failed> → FALLBACK d'error boundary (équivalent du
  //     snippet `failed` de svelte:boundary). Compilé en builder DOM statique
  //     (`@_mjs_fallback`), rendu par `_mjs_catchError` au crash. Les `@click=reset`
  //     y sont de vrais listeners ; pas de marqueur `mjs-reset`.
  //
  // Auto-fermeture interdite. La regex PRINCIPALE
  // ci-dessous exige déjà une fermeture explicite `</@failed>` : un
  // `<@failed/>` (ou `<@failed err reset/>`) ne la matche JAMAIS et
  // retomberait NON TRAITÉ sur le parser générique (tag custom `@failed`
  // inconnu) sans ce pré-scan dédié, en amont.
  cleaned = replacePairedTag(
    cleaned,
    'failed',
    errors,
    (params, content) => {
      const { setup, head, body } = compileFailedBlock(params, content, errors, contentFirstLine('failed', content), sigil)
      for (const l of setup) setupLines.push(l)
      setupLines.push(head)
      for (const l of body) setupLines.push(`  ${l}`)
      return ''
    },
    () => reportSelfCloseForbidden('failed')
  )

  // 1. <@head>…contenu…</@head> → INJECTION de contenu dans document.head,
  //    réactive (équivalent de <svelte:head>). Le contenu est rendu dans un
  //    µeffect : ses `$x` re-déclenchent l'injection (µ._setHead réconcilie).
  //
  // ÉCART vs la demande initiale — <@head> N'EST PAS ajouté au
  // garde-fou auto-fermeture ci-dessous (contrairement à <@element>/<@module>/
  // <@failed>) : DÉCOUVERTE en écrivant les tests — `head` est AUSSI une clé de
  // TARGETS (juste plus bas, boucle "2. Macros « écouteurs »"), donc
  // <@head @event={...} /> est un DEUXIÈME usage 100% légitime et déjà testé
  // (`processGlobalMacros` — même famille que <@window>/<@document>/<@body>/
  // <@html>, PAS celle d'<@include>/<@failed>). `<@head/>` bare NE tombe donc
  // JAMAIS non traité sur le parser générique (contrairement à ce qu'on
  // pensait) : la boucle TARGETS l'absorbe déjà comme un écouteur (vide =
  // no-op silencieux, exactement comme `<@window/>` bare) — rejeter cette
  // forme casserait un mécanisme qui marche. Un rejet CIBLÉ (uniquement pour
  // l'usage « injection de contenu », qu'aucun texte ne permet de distinguer
  // syntaxiquement d'un « listener vide ») a été jugé trop fragile pour la
  // valeur qu'il apporte.
  cleaned = replacePairedTag(cleaned, 'head', errors, (attrs, content) => {
    // parseStyling AVANT parseListeners (même raison que la boucle TARGETS
    // ci-dessous) : <@head> ne supporte pas les liaisons class/style → erreur.
    const styled = parseStyling(attrs, 'head', 'document.head')
    parseListeners(styled, 'document.head')
    const inner = content.trim()
    if (inner) {      // `=>` pour que `@` = le composant (réconciliation + teardown corrects).
      setupLines.push('µeffect =>')
      setupLines.push(`  µ._setHead(@, ${buildHeadInjection(inner, 'head', errors, contentFirstLine('head', content), sigil)})`)
      teardownLines.push('µ._clearHead(@)')
    }
    return ''
  })

  // 2. Macros « écouteurs » (window/document/body/html + <@head/> résiduels sans contenu).
  for (const macro of Object.keys(TARGETS)) {
    const targetJs = TARGETS[macro]
    // Open tag avec attributs : <@window @click={...}>
    cleaned = replaceOpenTag(cleaned, macro, false, errors, (attrs) => {
      parseBindings(attrs, macro)
      // parseStyling AVANT parseListeners : le strip des formes @class{…}/
      // @style.prop/--var DOIT arriver avant, sinon @class{…} reste matché par
      // parseListeners comme un écouteur fantôme de l'événement « class ».
      const styled = parseStyling(attrs, macro, targetJs)
      parseListeners(styled, targetJs)
      return ''
    })
    // Close tag : </@window>
    const closeRe = new RegExp(`</@${macro}>`, 'gi')
    cleaned = cleaned.replace(closeRe, '')
  }

  let setup = ''
  let teardown = ''
  if (setupLines.length > 0 || attachLines.length > 0) {
    setup = '\n' + setupLines.join('\n')
    if (attachLines.length > 0) {
      // Attache à CHAQUE réveil (hook awake, toute connexion au DOM).
      // addEventListener déduplique un même (cible, type, handler) →
      // ré-attache idempotente. IIFE Civet `((p = …) => …)()` — PAS `do (p) =>`,
      // qui compile en un do-block `{ (p) => {…} }` (flèche JAMAIS appelée) →
      // le hook n'était jamais réassigné → AUCUN listener <@window>/<@document>/
      // <@body> ne s'attachait (keydown/scroll/resize inertes). Le `)()` final
      // l'invoque. Chaînage via l'API interne `_mjs_hook` (map `_mjs_hooks`).
      setup += '\n' +
        '((_mjs_prevAwake = @_mjs_hooks?.awake) =>\n' +
        '  @_mjs_hook \'awake\', =>\n' +
        attachLines.map(l => `    ${l}`).join('\n') + '\n' +
        '    _mjs_prevAwake?()\n' +
        ')()\n'
    }
  }
  if (teardownLines.length > 0) {
    // Détache à CHAQUE mise en sommeil (hook sleep) — avant, le teardown était
    // chaîné sur le hook destroy… que le runtime n'invoquait JAMAIS : chaque
    // <@window> laissait son listener sur window à vie (fuite + handler tirant
    // sur un composant démonté). Le couple awake/sleep est symétrique et survit
    // aux hibernations (pageCache) ; les nœuds <@head> sont retirés au sleep et
    // ré-injectés au réveil par leur µeffect (re-run au mount). Chaînage via
    // l'API interne `_mjs_hook` (map `_mjs_hooks`).
    teardown = '\n' +
      '((_mjs_prevSleep = @_mjs_hooks?.sleep) =>\n' +
      '  @_mjs_hook \'sleep\', =>\n' +
      teardownLines.map(l => `    ${l}`).join('\n') + '\n' +
      '    _mjs_prevSleep?()\n' +
      ')()\n'
  }

  return { html: cleaned, setup, teardown, errors }
}
