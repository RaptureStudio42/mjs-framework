// bundler/minify — minification via esbuild (remplace le terser daemon V1).
//
// esbuild est ~10-100× plus rapide que terser et toujours en process (pas de socket).
// Pour des perfs encore meilleures on pourrait utiliser le mode "minify only"
// d'esbuild qui skip parsing complet, mais on a besoin du parse pour DCE.
//
// Sans avis de l'appelant (`force` absent) : minification si NODE_ENV === 'production',
// sinon passthrough. Le Bundler, lui, passe TOUJOURS un booléen explicite (cf. shouldMinify).
// En prod : drop console + DCE + mangle des identifiers locaux + mangle des
// propriétés internes `_mjs_*` (via mangleCache partagé entre fichiers).
//
// Le mangle de prop `_mjs_*` repose sur un INVARIANT : aucun accès via string
// (`obj['_mjs_intro']`) dans le runtime ou les bindings générés. L'invariant
// est vérifié automatiquement par `assertNoStringIndexedMjsAccess()` avant
// chaque minify avec mangleCache (cf. infra). Tout violation throw au build
// avec un message clair pointant le fichier et la ligne fautive.

import { transform } from 'esbuild'
import { t } from '../messages/index.js'
import type { LogLevelName } from './config.js'

export interface MinifyResult {
  code: string
  map?: string
}

/** Liste `pure` au niveau `'warn'` — défaut de production, comportement historique inchangé :
 *  retire les traces (log/info/debug) et `µ.log`, garde avertissements et erreurs. */
export const LOG_LEVEL_PURE_BASE = ['console.log', 'console.info', 'console.debug', 'µ.log']

/**
 * Liste `pure` (retrait du bundle, cf. `minifyJs`) pour un niveau de PROD donné (clé `logLevel`
 * de mjs.config.json, cf. bundler/config.ts) :
 *   - `'log'`    : liste VIDE — rien n'est retiré.
 *   - `'warn'`   : `LOG_LEVEL_PURE_BASE` (défaut, aucun changement observable).
 *   - `'error'`  : + `console.warn`/`µ.warn`.
 *   - `'silent'` : + `console.error`/`µ.error`.
 */
export function buildPureList(level: LogLevelName): string[] {
  if (level === 'log') return []
  const list = [...LOG_LEVEL_PURE_BASE]
  if (level === 'error' || level === 'silent') list.push('console.warn', 'µ.warn')
  if (level === 'silent') list.push('console.error', 'µ.error')
  return list
}

// ============================================================================
// minifications PARALLÈLES sur un
// mangleCache PARTAGÉ MUTABLE. `Bundler.compile()` traite les .mjs (et les
// modules .civet/.coffee) via `parallelMap` (jusqu'à PARALLEL_LIMIT fichiers
// EN VOL), et CHAQUE `minifyJs()` de ce lot reçoit le MÊME `this.mangleCache`.
// esbuild ne mute PAS le mangleCache passé en argument PENDANT le transform :
// il le lit en entrée, puis renvoie un `result.mangleCache` fusionné APRÈS
// coup (cf. plus bas). Deux transform() EN VOL SIMULTANÉMENT lisent donc tous
// les deux le MÊME état (encore incomplet) du cache, décident CHACUN DE LEUR
// CÔTÉ un nom court pour LEURS propriétés `_mjs_*` respectives sans se voir
// l'un l'autre, et peuvent assigner LE MÊME nom court à DEUX propriétés
// DIFFÉRENTES (ex. `_mjs_foo` → `a` dans le fichier A, `_mjs_bar` → `a` dans
// le fichier B) — un mapping incohérent, PERSISTÉ sur disque
// (`.mangle-cache.json`) et réutilisé dans TOUS les builds suivants. Si ces
// deux propriétés distinctes finissent lues/écrites sur le MÊME objet vivant
// à runtime, l'une écrase l'autre silencieusement — corruption difficile à
// diagnostiquer (le symptôme observé : re-rendu `{if}`/`{key}` cassé).
//
// Fix : mutex PAR mangleCache (WeakMap — pas de fuite si un mangleCache est
// abandonné) qui sérialise uniquement la fenêtre transform()+merge ci-dessous,
// pas tout le pipeline de compilation (parsing/transpilation restent
// parallèles, seule la minification avec mangleCache partagé est mise en
// file). Deux minifyJs() avec des mangleCache DIFFÉRENTS (ou sans mangleCache
// du tout) restent totalement indépendants.
const mangleCacheQueues = new WeakMap<object, Promise<unknown>>()

// exportée pour bundler/index.ts (emitSingleFile, js: 'bundle') : son propre esbuild
// build() final partage le MÊME `this.mangleCache` que les minifyJs() de phase A — le
// sérialiser sous le même verrou évite la même course que celle documentée ci-dessus,
// si jamais un watch() enchaîne un nouveau compile() avant que le précédent n'ait fini
// d'assembler (cf. bundler/index.ts, bandeau d'emitSingleFile).
export function withMangleCacheLock<T>(cache: object | undefined, fn: () => Promise<T>): Promise<T> {
  if (!cache) return fn()
  const prev = mangleCacheQueues.get(cache) ?? Promise.resolve()
  const next = prev.then(fn, fn)
  // `.catch(() => {})` : une erreur dans fn() ne doit PAS casser la file pour
  // les appels suivants sur ce même cache (sinon chaque `.then()` chaîné après
  // une Promise rejetée sauterait directement en erreur sans jamais exécuter
  // son propre fn()).
  mangleCacheQueues.set(cache, next.catch(() => {}))
  return next
}

// ============================================================================
// NOMS RÉSERVÉS DU CACHE : les noms qu'une instance de composant porte PAR NOM
//
// Le runtime lit des propriétés d'instance par leur nom, sans qu'aucun accès pointé ne le dise au
// minifieur : la reprise des valeurs posées avant la mise à niveau (connectedCallback, `this[k]`
// pour chaque clé de `_mjs_var_bits`), les props écrites par un parent sur un enfant pas encore défini
// (`node[k] = v`), les méthodes et gestionnaires posés sur l'instance (`this.inc = function…`),
// qui masquent une méthode interne homonyme du prototype. Or esbuild ne réserve un nom de
// propriété que DANS la transformation qui le voit écrit, et n'inscrit jamais cette réserve dans
// le cache partagé : le cœur, minifié après les composants, pouvait donner à `_mjs_dead` le nom
// `g` d'un état `$g` — `connectedCallback` posait `this.g = false`, la reprise le prenait pour
// l'état, le composant affichait `false`.
//
// Remède côté construction : relever ces noms dans le code compilé NON minifié de chaque unité,
// puis les réserver dans le cache avant la première minification du tour (`nom: false`, qu'esbuild
// ne donne jamais à une propriété). Mesuré sur esbuild : une correspondance déjà en cache
// (`_mjs_dead: 'g'`) est gardée même quand `g: false` est ajouté — elle est donc retirée d'abord.
//
// Le relevé est textuel et large (commentaires et chaînes compris) : un nom réservé à tort coûte
// quelques octets, un nom manqué rouvre le bogue. Seuls comptent les noms que le raccourcisseur
// peut produire : 54 noms d'un caractère puis 3 456 de deux, bien plus que les propriétés
// `_mjs_*` d'un gros projet (une centaine de correspondances, 2 caractères au plus) — 3 garde
// de la marge.
// ============================================================================
export const RESERVED_NAME_MAX_LENGTH = 3

const SHORT_NAME = `[A-Za-z_$][\\w$]{0,${RESERVED_NAME_MAX_LENGTH - 1}}`

const INSTANCE_NAME_PATTERNS: RegExp[] = [
  new RegExp(`(?<!\\.)\\.(?<nom>${SHORT_NAME})(?![\\w$])`, 'g'),          // x.nom, x?.nom — jamais le ... d'un étalement
  new RegExp(`(?<![\\w$.])(?<nom>${SHORT_NAME})\\s*:`, 'g'),              // clé d'objet nom:
  new RegExp(`(['"\`])(?<nom>${SHORT_NAME})\\1`, 'g'),                    // littéral 'nom', "nom" ou entre accents graves
  new RegExp(`[{,]\\s*(?<nom>${SHORT_NAME})\\s*(?=[,}(=])`, 'g'),         // { nom }, { a, nom }, { nom() {…} }, { nom = défaut }
]

/** Noms courts (au plus `RESERVED_NAME_MAX_LENGTH` caractères) qu'une instance peut porter par
 *  nom, relevés dans du code compilé NON minifié — triés, sans doublon. */
export function collectInstanceNames(code: string): string[] {
  const names = new Set<string>()
  for (const re of INSTANCE_NAME_PATTERNS) {
    for (const m of code.matchAll(re)) names.add(m.groups!.nom)
  }
  return [...names].sort()
}

/** Réserve des noms dans le cache de raccourcissement : retire toute correspondance
 *  `_mjs_x → nom`, pose `nom: false`. Rend les propriétés dont la correspondance a été retirée,
 *  triées — tout code déjà minifié avec elles est désaccordé et doit être re-minifié. */
export function reserveMangleNames(cache: Record<string, string | false>, names: Iterable<string>): string[] {
  const reserved            = new Set(names)
  const withdrawn: string[] = []
  for (const [prop, short] of Object.entries(cache)) {
    if (typeof short === 'string' && reserved.has(short)) {
      delete cache[prop]
      withdrawn.push(prop)
    }
  }
  for (const name of reserved) cache[name] = false
  return withdrawn.sort()
}

// ============================================================================
// MARQUEURS LUS SUR UNE DONNÉE : nom long, toujours
//
// Une propriété `_mjs_*` lue ou écrite sur une VALEUR (état, prop, item de liste, JSON reçu) — et
// non sur un nœud ou une instance de composant — ne peut pas être raccourcie : son nom court tombe
// alors dans l'espace des clés que la donnée elle-même peut porter, et aucune réservation ne peut
// l'éviter (ces clés n'existent qu'à l'exécution, rien ne les écrit dans le code).
//
// `_mjs_c` marque l'enveloppe d'une valeur dérivée (`{ _mjs_c: true, f }`) et se lit sur la valeur
// d'un état à chaque assignation : raccourci en `u`, un JSON `{"x": "un", "u": 1}` passait pour une
// valeur dérivée et l'état ne se remplaçait plus jamais, sans la moindre erreur. Le nom long coûte
// quelques dizaines d'octets par construction.
// ============================================================================
export const DATA_MARKER_NAMES = ['_mjs_c']

/** Réserve les marqueurs lus sur une donnée dans le cache de raccourcissement : pose
 *  `marqueur: false` (jamais raccourci) et retire la correspondance héritée d'un cache plus ancien.
 *  Rend les marqueurs dont la correspondance a été retirée, triés — tout code déjà minifié avec
 *  elle est désaccordé et doit être re-minifié. */
export function reserveDataMarkers(cache: Record<string, string | false>): string[] {
  const withdrawn: string[] = []
  for (const name of DATA_MARKER_NAMES) {
    if (typeof cache[name] === 'string') withdrawn.push(name)
    cache[name] = false
  }
  return withdrawn.sort()
}

// ============================================================================
// AIDES DU CŒUR POSÉES SUR µ : leur nom ne peut pas devenir un nom court
//
// Le code que le compilateur ÉMET appelle des aides posées sur `µ` par le cœur : `µ._p` (i-ème
// enfant, de proche en proche) et `µ._tm` (marqueur texte) de mjs_dom.ts, `µ._def` (enregistrement de
// la balise d'un composant), `µ._al` (enregistrement de l'alias COURT, mjs_alias.ts, joint aux seuls
// projets qui en écrivent un — réservé même quand le module n'est pas du bundle), `µ._esc`
// (échappement des interpolations qui partent en innerHTML, mjs_esc.ts), `µ._set` (assignation depuis
// le code transformé du composant, mjs_init.ts), `µ._storeSet`/`µ._storeDeclare` (écriture notifiante
// et déclaration des clés du store), `µ._glCl`/`µ._glSt` (classe et propriété de style posées sur une
// cible GLOBALE par `@class{…}`/`@style.` de `<@body>`/`<@html>`, mjs_body.ts),
// `µ._updDynEl`/`µ._updModule` (balise et composant dynamiques de `<@element>`/`<@module>`,
// mjs_dynamic.ts), `µ._setHead`/`µ._clearHead` (injection et retrait du `<head>` vivant de `<@head>`,
// mjs_head.ts), `µ._vtPresets` (table des préréglages de `@viewTransition`, mjs_vt_presets.ts — que
// l'application garnit elle-même) et `µ._isServer` (le code émis pour un attribut réactif sérialise
// sa valeur dans le HTML au rendu serveur).
//
// Leur nom ne commence pas par `_mjs_` : elles ne sont jamais raccourcies — mais RIEN n'empêche le
// raccourcisseur de donner `_p`, `_set` ou `_setHead` à une propriété interne, et une propriété
// interne portée par µ lui-même (`µ._mjs_pending`, le registre des props en attente) écraserait
// alors l'aide : toute construction de composant crèverait, sans le moindre avertissement.
//
// La liste EST le relevé des aides que le compilateur cite, les noms internes `_mjs_*` mis à part :
// `rg -a -o "µ\._[A-Za-z]+" src/transpiler src/generator` rend 17 jetons distincts — ces 16 aides,
// plus `_mjs`, préfixe des propriétés internes que le raccourcisseur doit justement pouvoir
// raccourcir (le seul jeton écarté). Un relevé borné aux minuscules (`µ\._[a-z]+\(`) laissait
// dehors les dix aides à majuscule ; un relevé borné à la forme d'APPEL laisserait dehors
// `µ._vtPresets`, qui est une table. Le test de réservation re-relève cette liste sur les sources :
// une aide neuve fait rougir tant qu'elle n'est pas réservée.
//
// Le relevé des noms d'instance ne suffit pas : il ne voit que le code des composants, et un
// projet dont tous les gabarits sont plats (ou sans aucun alias) n'en cite aucune.
// ============================================================================
export const CORE_HELPER_NAMES = ['_p', '_tm', '_al', '_def', '_esc', '_set', '_storeSet', '_storeDeclare', '_glCl', '_glSt', '_updDynEl', '_updModule', '_setHead', '_clearHead', '_vtPresets', '_isServer']

// ============================================================================
// assertNoStringIndexedMjsAccess() : check au build qui fail si on détecte
// un accès string-indexé sur une prop `_mjs_*`. Garde-fou pour le mangleCache.
//
// Pourquoi : esbuild mangle les props `/^_mjs_/` via DOTTED access uniquement
// (`obj._mjs_intro` → `obj.a`). Un accès via string (`obj['_mjs_intro']`) ne
// participe PAS au mangle → après minification, la string `'_mjs_intro'` ne
// matche plus la clé manglée `'a'` → crash silencieux à runtime.
//
// Patterns détectés :
//   1. `obj['_mjs_X']` ou `obj["_mjs_X"]`  : accès indexé direct
//   2. `_mjs_${...}` dans template literal : interpolation de prop dynamique
//   3. `'_mjs_' + X`                       : concat string runtime
//   4. `Object.defineProperty(*, '_mjs_X', …)` / `Reflect.X(*, '_mjs_X', …)`
//   5. `'_mjs_X' in obj`                   : test d'existence par string
//
// Faux positifs minimisés : le source est lu par `blankNonCode()` (infra), qui
// blanchit commentaires, chaînes de données et littéraux regex. Un de ces
// patterns écrit en commentaire de doc (cf. cet en-tête), en prose d'un
// composant ou dans la regex qui sert à le détecter est donc ignoré.
//
// Pas de Proxy runtime pour intercepter ces accès : ça défait un gain clé
// de V2 (suppression du Proxy). Le check build-time couvre 100%
// du code généré et minifié.
// ============================================================================

/** Chaîne qui EST un nom interne (`'_mjs_'` seule = base d'une concaténation, ou `'_mjs_foo'`) :
 *  gardée où qu'elle soit dans le source, c'est elle que les motifs cherchent. */
const MJS_NAME_STRING = /^_mjs_(?:[a-zA-Z_$][\w$]*)?$/

/** Mots-clés derrière lesquels un `/` ouvre un littéral regex (`return /x/`) et non une division
 *  (`total / n`) : hors de cette liste, un `/` qui suit un identifiant, un nombre, `)`, `]`, `}` ou
 *  une chaîne close divise. */
const REGEX_AFTER_WORD = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])

/** Fin d'une chaîne `'…'`/`"…"` ouverte en `start` : index APRÈS le guillemet fermant, `-1` si elle
 *  ne se ferme pas avant la fin de ligne (ce n'était pas une chaîne — un guillemet isolé ne doit
 *  alors rien décaler). */
function scanQuoted(source: string, start: number, quote: string): number {
  let i = start + 1
  while(i < source.length) {
    const c = source[i]
    if(c === '\\') { i += 2; continue }
    if(c === '\n') return -1
    if(c === quote) return i + 1
    i++
  }
  return -1
}

/** Fin d'un littéral regex ouvert en `start` : index APRÈS le `/` fermant, `-1` si le motif franchit
 *  une fin de ligne (un littéral regex ne la franchit jamais → c'était une division). Les classes
 *  `[…]` peuvent contenir un `/` nu, les échappements sautent deux caractères. */
function scanRegexLiteral(source: string, start: number): number {
  let i       = start + 1
  let inClass = false
  while(i < source.length) {
    const c = source[i]
    if(c === '\\') { i += 2; continue }
    if(c === '\n') return -1
    if(inClass) {
      if(c === ']') inClass = false
      i++
      continue
    }
    if(c === '[') { inClass = true; i++; continue }
    if(c === '/') return i + 1
    i++
  }
  return -1
}

// ============================================================================
// blankNonCode() : neutralise tout ce qui n'est pas du code, SANS bouger une
// seule position (même longueur, `\n` gardés) — les motifs scannent donc du
// code, et la ligne citée par l'erreur reste celle du source.
//
// Une suite de `String.replace` ne peut pas rendre ce service : une regex ne
// sait pas dans quel contexte elle tombe, et chaque contexte manqué rend à la
// garde un silence indistinguable d'un fichier sain.
//   • `/*` cité dans un commentaire de LIGNE (`// repli '/*'`, mjs_init.ts)
//     ouvre un faux bloc avalé jusqu'au premier `*/` du fichier — des dizaines
//     de milliers de caractères de cœur jamais vérifiés.
//   • `//` dans une chaîne (`"a // b"`) blanchit la fin de la ligne.
//   • apostrophe dans un gabarit (`` `l'état` ``) ou guillemet dans une classe
//     regex (`/['"]/`) : toutes les chaînes suivantes décalées d'un cran.
//
// Ce que la lecture garde VOLONTAIREMENT :
//   • le texte des gabarits `` `…` `` — le motif nº2 a besoin de lire
//     `` [`_mjs_${…}`] `` ; les expressions `${…}`, elles, sont relues comme du
//     code (chaînes et commentaires dedans blanchis).
//   • une chaîne en position de CLÉ (précédée de `[` ou `,`) : motifs nº1 et nº4.
//   • une chaîne qui EST un nom interne, où qu'elle soit : motifs nº3 et nº5.
// Le reste des chaînes est de la DONNÉE (prose d'un composant, message citant
// un exemple) et part au blanc : un exemple en prose ne casse pas un build.
// ============================================================================
export function blankNonCode(source: string): string {
  const n   = source.length
  const out = source.split('')
  const blank = (from: number, to: number): void => {
    for(let k = from; k < to; k++) {
      if(out[k] !== '\n') out[k] = ' '
    }
  }
  // contextes traversés : un `` ` `` empile le code qui l'ouvre (avec ses accolades à rétablir), un
  // `${` empile le gabarit qui l'ouvre
  const stack: { tpl: boolean; depth: number }[] = []
  let inTpl  = false
  let depth  = 0
  let prev   = ''    // dernier caractère de CODE significatif (décide regex vs division)
  let prevAt = -1    // sa position, pour relire le mot-clé qui précède un `/`
  let i      = 0
  while(i < n) {
    const c = source[i]
    if(inTpl) {
      if(c === '\\') { i += 2; continue }
      if(c === '`') {
        const frame = stack.pop()
        inTpl  = frame ? frame.tpl : false
        depth  = frame ? frame.depth : 0
        prev   = '`'
        prevAt = i
        i++
        continue
      }
      if(c === '$' && source[i + 1] === '{') {
        stack.push({ tpl: true, depth })
        inTpl  = false
        depth  = 0
        prev   = '{'
        prevAt = i + 1
        i += 2
        continue
      }
      i++
      continue
    }
    if(c === '/' && source[i + 1] === '/') {
      let j = i + 2
      while(j < n && source[j] !== '\n') j++
      blank(i, j)
      i = j
      continue
    }
    if(c === '/' && source[i + 1] === '*') {
      let j = i + 2
      while(j < n && !(source[j] === '*' && source[j + 1] === '/')) j++
      j = Math.min(n, j + 2)
      blank(i, j)
      i = j
      continue
    }
    if(c === '/' && regexLiteralStarts(source, prev, prevAt)) {
      const end = scanRegexLiteral(source, i)
      if(end > 0) {
        blank(i + 1, end - 1)    // les deux `/` restent, le motif part au blanc
        prev   = '/'
        prevAt = end - 1
        i      = end
        continue
      }
    }
    if(c === '\'' || c === '"') {
      const end = scanQuoted(source, i, c)
      if(end > 0) {
        const body  = source.slice(i + 1, end - 1)
        const isKey = prev === '[' || prev === ','
        if(!isKey && !MJS_NAME_STRING.test(body)) blank(i, end)
        prev   = c
        prevAt = end - 1
        i      = end
        continue
      }
    }
    if(c === '`') {
      stack.push({ tpl: false, depth })
      inTpl = true
      i++
      continue
    }
    if(c === '{') depth++
    if(c === '}') {
      const frame = stack[stack.length - 1]
      if(depth === 0 && frame && frame.tpl) {
        stack.pop()
        inTpl = true
        depth = frame.depth
        i++
        continue
      }
      if(depth > 0) depth--
    }
    if(!/\s/.test(c)) { prev = c; prevAt = i }
    i++
  }
  return out.join('')
}

/** Vrai si le `/` rencontré ouvre un littéral regex, faux s'il divise — décidé sur le dernier
 *  caractère de code. Au moindre doute on tranche pour la DIVISION : prendre une division pour une
 *  regex blanchirait du vrai code, et une garde qui blanchit du code ne garde plus rien. */
function regexLiteralStarts(source: string, prev: string, prevAt: number): boolean {
  if(prev === '') return true
  if(/[\w$]/.test(prev)) {
    const word = source.slice(0, prevAt + 1).match(/[A-Za-z_$][\w$]*$/)
    return word !== null && REGEX_AFTER_WORD.has(word[0])
  }
  return !')]}\'"`'.includes(prev)
}

export function assertNoStringIndexedMjsAccess(source: string, filename: string): void {
  // le source original sert à citer la ligne fautive ; le blanchi, de même longueur, à scanner
  const stripped = blankNonCode(source)

  // Patterns ciblés : uniquement les VRAIS accès string-indexés. On ne matche
  // PAS les valeurs string assignées (`el.id = '_mjs_X'`) car elles n'accèdent
  // pas à une prop _mjs_*.
  const patterns: { re: RegExp; label: string }[] = [
    {
      // `obj['_mjs_X']` ou `obj["_mjs_X"]` : accès indexé direct sur prop
      re: /\[\s*(['"])_mjs_[a-zA-Z_$][\w$]*\1\s*\]/,
      label: t('bundler.minify.label-acces-indexe'),
    },
    {
      // `obj[`_mjs_${...}`]` : interpolation dynamique de prop _mjs_*
      re: /\[\s*`_mjs_\$\{[^`]*`\s*\]/,
      label: t('bundler.minify.label-acces-template'),
    },
    {
      // `Object.defineProperty(*, '_mjs_X', ...)` : définit une prop par
      // string → la déclaration ne participe pas au mangle, le mangle des
      // accès dotted aboutit à un nom différent → la prop "déclarée" et la
      // prop "lue" sont DEUX entités distinctes après minify.
      re: /Object\.defineProperty\s*\([^,]+,\s*(['"])_mjs_[a-zA-Z_$][\w$]*\1/,
      label: t('bundler.minify.label-define-property'),
    },
    {
      // `Reflect.get/set/has/deleteProperty(obj, '_mjs_X', ...)`
      re: /Reflect\.(get|set|has|deleteProperty|defineProperty)\s*\([^,]+,\s*(['"])_mjs_[a-zA-Z_$][\w$]*\2/,
      label: t('bundler.minify.label-reflect'),
    },
    {
      // `'_mjs_' + X` : le nom est fabriqué à l'exécution, la base littérale ne participe pas au
      // mangle → la prop lue n'est jamais celle qu'un accès pointé a raccourcie
      re: /(['"])_mjs_[\w$]*\1\s*\+/,
      label: t('bundler.minify.label-concat'),
    },
    {
      // `'_mjs_X' in obj` : esbuild ne mangle pas la string d'un `in` (vérifié sur esbuild) alors
      // qu'il mangle l'écriture pointée voisine → le test ne trouve JAMAIS la prop
      re: /(['"])_mjs_[\w$]*\1\s*in\s/,
      label: t('bundler.minify.label-in'),
    },
  ]

  for (const { re, label } of patterns) {
    const m = stripped.match(re)
    if (m) {
      const idx = m.index ?? stripped.indexOf(m[0])
      const line = idx >= 0 ? stripped.slice(0, idx).split('\n').length : 0
      const lineContent = source.split('\n')[line - 1] ?? ''
      throw new Error(t('bundler.minify.mjs-prop-access-invalide', { fichier: filename, ligne: line, label, contenu: lineContent.trim() }))
    }
  }
}

export interface MinifyOpts {
  /** Veto explicite : `true` = minifie, `false` = ne minifie PAS (même si NODE_ENV=production),
   *  `undefined` = pas d'avis, on retombe sur `NODE_ENV === 'production'`. */
  force?: boolean
  /** Génère une source map. */
  sourceMap?: boolean
  /** Filename pour les erreurs et la map. */
  filename?: string
  /**
   * Cache partagé pour le mangle de propriétés `_mjs_*`. Mutateur : esbuild
   * ajoute les nouvelles entrées au cache fourni → la même prop est manglée
   * vers le même nom court à travers tous les fichiers du bundle.
   * Si undefined : pas de mangle de props (mangle seulement des identifiers locaux).
   */
  mangleCache?: Record<string, string | false>
  /**
   * Niveau de PROD (clé `logLevel` de mjs.config.json) qui détermine la liste `pure` ci-dessous
   * (cf. `buildPureList`) — TOUJOURS le niveau de prod, jamais celui de l'environnement en cours
   * de build (deux minifications d'un même projet, l'une dev forcée, l'autre prod, retirent donc
   * exactement les mêmes appels). Absent : `'warn'`, comportement historique inchangé.
   */
  logLevel?: LogLevelName
  /**
   * Définitions supplémentaires (esbuild `define`), FUSIONNÉES à celles posées ci-dessous
   * (`'µ.debug'`) — jamais un remplacement. Sert `MJS_DEBUG` (identifiant LIBRE, contrairement à
   * `µ.debug` qui est une propriété derrière un `µ` local, cf. bandeau de `transform()` plus bas) :
   * l'appelant (bundler/index.ts, bundleRuntime) y passe `{ MJS_DEBUG: 'false' }` en prod.
   */
  define?: Record<string, string>
}

export async function minifyJs(
  source: string,
  opts: MinifyOpts = {}
): Promise<MinifyResult> {
  // `force` est un VETO explicite dans les deux sens : `false` n'était
  // jusque-là qu'un « je ne demande rien » que `NODE_ENV=production` écrasait, si bien
  // qu'un projet en `env: 'dev'` bâti sur une machine où NODE_ENV traîne à 'production'
  // se retrouvait minifié malgré sa config. `undefined` (aucun avis) retombe sur NODE_ENV,
  // comportement historique des appelants qui ne passent pas l'option.
  const shouldMinify = opts.force ?? (process.env.NODE_ENV === 'production')

  if (!shouldMinify) {
    return { code: source }
  }

  const useMangleCache = opts.mangleCache !== undefined

  // Garde-fou mangleCache : si un accès string-indexé `obj['_mjs_X']` traîne
  // dans le source, il ne participe pas au mangle et casse à runtime. On
  // throw IMMÉDIATEMENT avec un message clair pointant la ligne fautive.
  if (useMangleCache) {
    assertNoStringIndexedMjsAccess(source, opts.filename ?? '<unknown>')
  }

  // Strip de µ.debug en prod (cf. V1) : tout `if (µ.debug) {…}` est éliminé
  // par DCE, la déclaration/assignation ISOLÉE `µ.debug = …` retirée à part.
  //
  // les DEUX anciennes
  // substitutions regex étaient dangereuses en prod :
  //   • `[^;]+` acceptait les `\n` — un `µ.debug = true` SANS `;`
  //     final (Civet n'en émet pas) étendait le motif jusqu'au premier `;`
  //     trouvé PLUS BAS, AVALANT tout le code intermédiaire (suppression
  //     silencieuse d'instructions en prod, ou build cassé avec une erreur
  //     esbuild cryptique). Fix : `[^;\n]+` interdit le franchissement de
  //     ligne ; `[ \t]*$` (au lieu de `[\s]*$`) n'absorbe plus les lignes
  //     blanches suivantes (décalage de sourcemaps).
  //   • la 2e regex (`µ.debug` bare → `false`) opérait sur le
  //     texte brut, sans conscience des chaînes/templates (une chaîne
  //     contenant « µ.debug » était corrompue en `false`) NI des assignations
  //     composées (`µ.debug ||= …` → `false ||= …`, LHS invalide →
  //     transform() jette). REMPLACÉE par `define: { 'µ.debug': 'false' }`
  //     d'esbuild ci-dessous : substitution AST (JAMAIS dans une chaîne /
  //     template / commentaire) qui laisse une CIBLE d'assignation TELLE
  //     QUELLE (esbuild ne remplace pas un LHS) — plus aucun crash sur
  //     `µ.debug = x` inline ou composé, et les `if (µ.debug)` partent en DCE.
  //
  // On garde donc UNIQUEMENT le retrait de la ligne isolée ci-dessous ; les
  // LECTURES (→ false → DCE) sont déléguées au `define`. `pure:` (plus bas)
  // remplace par ailleurs l'ancienne regex `µ.log(...) → void 0` (qui
  // cassait les appels imbriqués `µ.log(fn(g(y)))`).
  const cleaned = source
    .replace(/^[ \t;]*µ\.debug\s*=\s*[^;\n]+;?[ \t]*$/gm, '')

  // le transform() + merge ci-dessous
  // touche `opts.mangleCache`, un objet PARTAGÉ MUTABLE entre tous les appels
  // de compilation en vol (cf. le commentaire détaillé en tête de fichier) —
  // sérialisé PAR mangleCache pour empêcher deux fichiers compilés en
  // parallèle de s'assigner le MÊME nom court à deux propriétés `_mjs_*`
  // DIFFÉRENTES. Sans mangleCache (dev, ou minify sans mangle de props), pas
  // de verrou : `withMangleCacheLock` exécute alors directement, sans file.
  return withMangleCacheLock(useMangleCache ? opts.mangleCache : undefined, async () => {
    const result = await transform(cleaned, {
      minify: true,
      target: 'es2022',
      format: 'esm',
      sourcemap: opts.sourceMap ? 'external' : false,
      sourcefile: opts.filename,
      treeShaking: true,
      // µ.debug → false en
      // prod via define AST : jamais dans une chaîne/template, jamais sur un
      // LHS (cf. le commentaire de `cleaned` plus haut). La clé non-ASCII
      // `µ.debug` est acceptée par esbuild et les chaînes littérales restent intactes.
      //
      // CE `define`-ci ne substitue RIEN dans le cœur : `µ` y est déclaré localement
      // (`var MetaViewStub, µ;`, mjs_init.ts), et esbuild n'applique pas `define`
      // derrière une déclaration locale — un cœur de prod garde donc `if (µ.debug)` partout où
      // cette FORME LITTÉRALE est encore écrite. Sans conséquence observable pour cette clé-là :
      // la ligne d'initialisation `µ.debug = false` est retirée par le strip ci-dessus, le
      // drapeau vaut `undefined` (faux), et `window.µ` n'étant pas exposé en prod, il n'y a de
      // toute façon aucun moyen de le rallumer. Laissé en place pour une éventuelle chaîne/
      // propriété littérale résiduelle, et pour redevenir utile si `µ` passait un jour en global.
      //
      // C'est `MJS_DEBUG` (`opts.define`, posé par l'appelant), un IDENTIFIANT LIBRE et non une
      // propriété d'objet, qui porte réellement l'élimination : aucune déclaration locale ne le
      // masque, `define` le remplace donc PARTOUT dans le cœur où les sources du runtime lisent
      // `µ.debug` (converties à `MJS_DEBUG` — cf. mjs_easing/mjs_for/mjs_if/mjs_init/mjs_router/
      // mjs_destroy_hooks/mjs_debug/mjs_devinspect/mjs_devpanel.ts), et chaque `if (MJS_DEBUG)`
      // part en DCE avec `opts.define = { MJS_DEBUG: 'false' }`.
      define: { 'µ.debug': 'false', ...opts.define },
      // `pure` plutôt que `drop: ['console']` : `drop` vide TOUJOURS les corps de µ.error/µ.warn,
      // sans distinction de niveau — contrat trahi (« les erreurs ne doivent JAMAIS être
      // silencieuses », mjs_init) si le projet n'a rien demandé de tel. `pure` retire au
      // contraire EXACTEMENT ce que la clé `logLevel` (mjs.config.json) autorise pour le niveau
      // de PROD (cf. `buildPureList`) : au défaut `'warn'`, seuls les niveaux de TRACE
      // (log/info/debug) et `µ.log` partent — `console.warn`/`µ.warn`/`console.error`/`µ.error`
      // ne rejoignent la liste QUE si le projet a explicitement demandé un niveau `'error'`/
      // `'silent'` plus strict.
      //
      // MESURÉ (sonde esbuild isolée) — marquer `console.warn`/`console.error`
      // pur (niveaux `'error'`/`'silent'`) vide aussi l'appel INTERNE `console.warn(...)`/
      // `console.error(...)` dans le CORPS de `µ.warn`/`µ.error` eux-mêmes (mjs_init.ts, concaténé
      // dans ce même mjs_core.js) — exactement comme `console.log` vide déjà celui de `µ.log` au
      // défaut `'warn'` (cf. le commentaire `define`/µ.debug ci-dessus, même famille de problème).
      // Les CALL SITES `µ.warn(...)`/`µ.error(...)` ailleurs dans le bundle (composants : `µ` y
      // est une liaison IMPORTÉE, pas une globale) ne sont eux JAMAIS retirés par `pure` — sondé
      // séparément, aucune régression de flux applicatif possible. Conséquence assumée, pas un
      // bogue : à ces niveaux le projet a explicitement demandé que warn/error se taisent, et
      // `pure` le fait au niveau JS exactement comme `'warn'` (le défaut) le fait déjà pour `log`.
      pure: buildPureList(opts.logLevel ?? 'warn'),
      // Mangle des propriétés internes `_mjs_*` cohérent inter-fichiers
      // via mangleCache. L'API publique (`µ.X`, `$.X`) reste préservée par
      // le regex (qui matche uniquement le préfixe `_mjs_`).
      mangleProps: useMangleCache ? /^_mjs_/ : undefined,
      mangleCache: useMangleCache ? opts.mangleCache : undefined,
      keepNames: false,
      legalComments: 'none',
    })

    // Merge les nouvelles entrées du cache (esbuild en ajoute) dans l'objet
    // partagé pour que les compilations suivantes voient les mêmes mappings.
    if (useMangleCache && result.mangleCache) {
      Object.assign(opts.mangleCache!, result.mangleCache)
    }

    return {
      code: result.code,
      map: opts.sourceMap ? result.map : undefined,
    }
  })
}
