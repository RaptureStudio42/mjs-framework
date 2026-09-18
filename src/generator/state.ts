// État du compilateur — classe `CompilerState` + isolation par flux async
// pour permettre des `compileMjs` concurrents sans race condition.
//
// Architecture :
//   - `CompilerState` : classe avec toutes les ivars + méthodes (reset,
//     genId, getEffectVars). Instantiable pour usages isolés.
//   - `state` : Proxy exporté pour compat avec les ~110 sites existants
//     qui font `state.counter`, `state.events`, etc. Le Proxy redirige
//     dynamiquement vers le store async courant.
//   - `withState(fn)` : exécute `fn` avec un nouveau `CompilerState` isolé.
//     Tous les `await` à l'intérieur de `fn` propagent automatiquement le
//     contexte via Node's `AsyncLocalStorage`. Le bundler appelle ça par
//     fichier pour permettre `Promise.all([compile(f1), compile(f2), ...])`
//     sans corruption mutuelle.
//
// Le Proxy ajoute ~5-10ns par accès ; pour ~100k accès par compile, c'est
// négligeable (1ms cumulé). V8 inline les Proxy quand le handler est stable.
//
// V2 — dispatch direct sans bitmask :
//   - `effectsByVar: Map<varName, code[]>` accumule le code de chaque update
//     indexé par la liste des vars dont il dépend.
//   - Plus de `useBigInt`/`n`/`m1` (suffixes BigInt) : ces champs ont disparu
//     avec le bitmask.

import { tokenize } from '../lexer/index.js'
import { cleanJs, cleanJsExpr, convertCoffeeInterpolations } from './utils.js'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as acorn from 'acorn'
import { analyzeSnippetOrNull } from '../analyzer/index.js'
import { t } from '../messages/index.js'

export interface ResetOpts {
  analyzer?: any
  externalVars?: string[]
  templateLang?: 'civet' | 'js'
  /** Nom du module compilé — best-effort, utilisé UNIQUEMENT pour enrichir les
   * messages d'erreur (ex. échec de compilation Civet d'une expression de
   * template, cf. generator/utils.ts:cleanJsExpr). Absent en dehors du
   * transpiler complet (ex. appels directs à `compile()` dans les tests). */
  moduleName?: string
}

/** Route d'événement telle qu'émise vers le runtime (`_mjs_bindEvents`) — 3 formes :
 *  `idx`               un seul handler, aucun modificateur (le cas courant) ;
 *  `[idx, flags]`      un seul handler + bitmask (bit 0 `.propagate`, bit 1 `.once`) ;
 *  `[[idx, flags], …]` PLUSIEURS handlers sur le même couple (événement, nœud) —
 *                      liaisons two-way d'abord, directives `@événement` ensuite.
 *  Les deux formes tableau se distinguent par `Array.isArray(slot[0])`. */
export type EventRoute = number | [number, number] | [number, number][]

/** Essai RÉEL (tokenize + cleanJs + acorn), même recette que la tentative
 * « whole » de `getEffectVars` juste en dessous — sert à trancher si un
 * candidat (bloc de décomposition, avec ou sans ses accolades) est un
 * élément de tableau JS valide une fois isolé dans `[${candidate}]`.
 * Aucun effet de bord ; catch muet volontaire (même contrat que le reste
 * du moteur d'analyse : un candidat invalide n'est qu'une hypothèse rejetée). */
function canParseAsArrayElement(candidate: string, externalVars: string[]): boolean {
  try {
    const clean = cleanJs(tokenize(`[${candidate}]`, { externalVars }), externalVars)
    acorn.parse(clean.replace(/===/g, '==').replace(/!==/g, '!='), { ecmaVersion: 'latest', sourceType: 'module' })
    return true
  } catch {
    return false
  }
}

export class CompilerState {
  counter: number = 0
  events: Record<string, Record<string, EventRoute>> = {}
  /** Combien de LIAISONS occupent déjà un couple (événement, nœud) — clé
   * `evt\0id`. Sert au seul point d'insertion des routes : une liaison
   * s'insère derrière la dernière liaison, une directive s'ajoute à la fin.
   * Interne au compilateur, jamais sérialisé. */
  eventBindCount: Record<string, number> = {}
  /** Types d'événements (parmi touchstart/touchmove/wheel) dont AU MOINS un
   * handler appelle preventDefault (modifier `.prevent` ou appel direct).
   * Sert à décider si le listener délégué de ce type peut être `passive`. */
  eventsWithPrevent: Set<string> = new Set()
  inlines: string[] = []
  analyzer: any | null = null
  externalVars: string[] = []
  isPrePass: boolean = false
  snippetRegistry: string[] = []
  hasFlip: boolean = false
  hasDynamicSlots: boolean = false
  /** Dispatch direct V2 : map varName → liste de codes JS d'effects.
   * Chaque update text/attr/binding s'enregistre ici pour CHAQUE var dont
   * il dépend. Le runtime expose ça via `_mjs_effectsByVar[k]` et n'invoque que
   * les effects abonnés à la var muée. */
  effectsByVar: Map<string, string[]> = new Map()
  /** Effects sans dépendance réactive (ex: `{name}` où `name` est une const
   * locale `:=` non-réactive). Exécutés UNE FOIS au mount initial via
   * `_mjs_effectsAll`, jamais re-fired. */
  mountOnlyEffects: string[] = []
  /** miroir Set de `mountOnlyEffects` pour la dédup O(1) dans
   * `registerEffect` (l'`Array.includes` devenait quadratique sur un gros
   * composant). Le tableau reste la source de vérité (ordre sérialisé) ; ce Set
   * ne sert QU'au test d'appartenance. Reset partout où le tableau l'est. */
  mountOnlyEffectsSet: Set<string> = new Set()
  /** liaisons two-way vers un composant ENFANT (`<@x value=!{$y}>`),
   * root uniquement : le MÊME code que l'effect correspondant (`node._set(...)`),
   * mais rejoué SYNCHRONEMENT juste après sa définition (`init()`, avant que le
   * constructeur ne rende la main) — un enfant fraîchement créé peut recevoir
   * SON PROPRE connectedCallback avant celui du parent (ordre non garanti par le
   * moteur, constaté DOM natif ET happy-dom (`<@color value=!{$panel} editable>`,
   * garde `µmount` "value requis")).
   * Poser la prop AVANT tout connectedCallback (donc avant TOUT rendu de
   * n'importe quel composant du sous-arbre) supprime la course, quel que soit
   * l'ordre réel des callbacks. */
  initialPropBinds: string[] = []
  /** Vars qui pilotent les blocs structurels (`{if}`, `{for}`,
   * `{await}`, `{key}`). Si une mutation NE concerne PAS une de ces vars,
   * `_mjs_renderStruct` peut être skip au runtime (gain massif sur select1k :
   * `selected` ne pilote PAS l'iterable du for → skip _mjs_updFor × 1000).
   *
   * Si une var « globale » non-trackable mute (ex: `µ.state.X`), on ne sait
   * pas si elle pilote la struct → `_mjs_renderStruct` doit tourner par défaut.
   * Le runtime gère ça via un flag `_renderStructAlwaysRun`. */
  structVars: Set<string> = new Set()
  /** Noms que le TEMPLATE introduit lui-même : variable et index de chaque `{for}`,
   * nom d'un `{const}`, argument d'un `{then}`/`{catch}`. Sert à filtrer les vars du
   * `<script>` passées en `predeclared` au batch inline — elles DOIVENT y rester locales.
   * Deux raisons distinctes, même remède : la variable de boucle est réassignée en tête de
   * handler par le squelette de reconstruction (`item = __arr_0[__idx_0]`) ; le `{const}` et
   * l'argument d'un `{then}`, eux, n'existent PAS DU TOUT dans le corps du handler. Sans ce
   * filtre, un `<script>` portant un homonyme se ferait ÉCRASER à chaque clic — muet. */
  templateLocals: Set<string> = new Set()
  /** Pile des gardes de branche `{if}` actives — empilée/dépilée par
   * `compileIf` (branche root) autour du walk de CHAQUE branche. Entrées de
   * la forme `this._mjs_old?.ifN === i`. `registerEffect` enveloppe le code
   * enregistré avec ces gardes : la copie qui finit dans `_mjs_effectsAll`
   * (mount) ET dans `_mjs_effectsByVar` (dispatch ciblé sur mutation) ne
   * s'exécute plus que si la branche est RÉELLEMENT active — jusqu'ici seule
   * la copie de `_mjs_renderStruct` (branchExecBlock) portait la condition,
   * l'autre tournait NUE. `this._mjs_old.ifN` est déjà à jour au moment où ces
   * copies tirent : struct tourne TOUJOURS avant les effects (mount et
   * update, cf. invalidate-struct-before-effects.test.ts). */
  effectGuardStack: string[] = []
  usedAnimations: Set<string> = new Set()
  transitionsProcessed: Set<string> = new Set()
  /** Refs DOM `@this=!{nom}` au top-level avec une variable NUE (sans `$`,
   * donc non réactive). Le compilateur AUTO-DÉCLARE ces variables (`let nom`)
   * en tête de `init` si le script ne les déclare pas — sinon `nom = node`
   * (binding) et `nom.getContext(…)` (script) référencent une var inexistante
   * → ReferenceError. Dédupliqué contre les vars déjà déclarées par le script. */
  refVars: Set<string> = new Set()
  /** Signal compile-time : le composant déclare-t-il AU MOINS un
   * `@transition/@in/@out/@intro/@outro/@attach/@this=!/@flip` ?
   * Si false, le destroy peut bypass le walk DFS et faire `node.remove()`
   * direct (gain replace1k / clear1k massif sur listes pures). */
  hasDestroyHooks: boolean = false
  /** Grammaire des handlers inline (`@click={…}`).
   * 'civet' (défaut) : le generator émet l'existentiel `??` (Civet) ;
   * 'js' : repli historique, existentiel `?` (Coffee). Seul point de
   * divergence d'émission entre les deux grammaires — le reste du squelette
   * (postfix if, if/then/else, and/or/not/is…) compile identiquement aux deux. */
  templateLang: 'civet' | 'js' = 'civet'
  /** Best-effort, cf. ResetOpts.moduleName. */
  moduleName: string | undefined = undefined

  reset(opts: ResetOpts = {}): void {
    this.counter = 0
    this.events = {}
    this.eventBindCount = {}
    this.eventsWithPrevent = new Set()
    this.inlines = []
    this.analyzer = opts.analyzer ?? null
    this.externalVars = opts.externalVars ?? []
    this.templateLang = opts.templateLang ?? 'civet'
    this.moduleName = opts.moduleName
    this.isPrePass = false
    this.snippetRegistry = []
    this.hasFlip = false
    this.hasDynamicSlots = false
    this.effectsByVar = new Map()
    this.mountOnlyEffects = []
    this.mountOnlyEffectsSet = new Set()
    this.initialPropBinds = []
    this.structVars = new Set()
    this.templateLocals = new Set()
    this.effectGuardStack = []
    this.usedAnimations = new Set()
    this.transitionsProcessed = new Set()
    this.refVars = new Set()
    this.hasDestroyHooks = false
  }

  genId(prefix: string): string {
    this.counter += 1
    return `${prefix}${this.counter}`
  }

  /** Récupère la closure transitive des state vars dont dépend une expression.
   * Utilise le cache `batchVarsCache` de l'analyzer (rempli durant la pre-pass).
   * Retourne [] si l'expression ne dépend d'aucune state var (constante pure). */
  getEffectVars(expr: string | null | undefined): string[] {
    const raw = (expr ?? '').toString().trim()
    if (raw === '') return []
    // même conversion Coffee `"...#{X}..."` →
    // gabarit `` `...${X}...` `` que cleanJsExpr (generator/utils.ts) : sans elle, un `$x`
    // textuellement présent DANS une interpolation `#{}` reste un caractère INERTE d'un
    // Literal JS pour `acorn` (jamais un vrai nœud `$.x`) — la tentative « whole » plus bas
    // PARSE quand même (une chaîne contenant `#{$.x}` est un JS parfaitement valide), donc
    // `analyzeSnippetOrNull` rend `[]` (pas `null`) : le repli Civet (plus bas) n'est JAMAIS
    // tenté, la dépendance est perdue EN SILENCE. `raw` (non converti) reste la référence
    // pour les messages d'erreur/le repli Civet (cleanJsExpr fait sa propre conversion,
    // idempotente sur un texte déjà converti).
    const str = convertCoffeeInterpolations(raw)

    let codeToAnalyze: string
    // le clean de la tentative « expression entière » (whole-parse)
    // est réutilisé plus bas quand elle réussit (sinon `cleanJs(tokenize())` était
    // refait à l'identique sur la MÊME chaîne, ×2 pre/real pass).
    let wholeCleanCached: string | null = null
    const pureMatch = str.match(/^!?\{(.+)\}$/)
    // GARDE (tooltip breadcrumb doc/tuto figé après nav client,
    // seul F5 rafraîchit) — un template MULTI-BLOCS type "{$a} — {$b}" matche AUSSI
    // cette regex (gourmande : du PREMIER `{` au DERNIER `}`), produisant un
    // `codeToAnalyze` invalide (accolades internes non refermées dans le tableau,
    // ex. `[$a} — {$b]`) → acorn.parse échoue plus bas → catch silencieux →
    // deps = [] → effet classé mountOnly à tort, JAMAIS re-déclenché. Le chemin
    // `else if` juste en dessous gère DÉJÀ correctement le cas multi-blocs (scan
    // équilibré) — n'emprunter ce fast-path que si la chaîne est un bloc UNIQUE
    // sans ambiguïté (exactement un `{` et un `}` dans toute la chaîne) ; sinon
    // repli sur le scan équilibré, qui gère aussi bien les accolades imbriquées
    // (`{foo({a:1})}`) que les blocs multiples.
    const isUnambiguousSingleBlock = pureMatch
      && (str.match(/\{/g) ?? []).length === 1
      && (str.match(/\}/g) ?? []).length === 1
    if (isUnambiguousSingleBlock) {
      codeToAnalyze = `[${pureMatch![1]}]`
    } else if (str.includes('{')) {
      // AVANT de décomposer en blocs
      // `{...}` séparés (pensé pour un TEMPLATE mixte `"préfixe {$a} suffixe
      // {$b}"`, où chaque `{...}` est syntaxiquement autonome une fois isolé),
      // on tente d'abord l'expression ENTIÈRE comme UN SEUL bloc cohérent.
      // Cas manqué par la décomposition : `fmt($price, {currency:'EUR'})` — un
      // OBJET LITTÉRAL en argument d'appel, pas un marqueur de template. La
      // décomposition en extrayait `{currency:'EUR'}` comme bloc À PART,
      // donnant `[currency:'EUR', $price]` — INVALIDE en JS (un « label »
      // ne peut pas être élément de tableau) → `acorn.parse` échoue →
      // `analyzeSnippet` retourne `[]` (catch silencieux) → `$price` jamais
      // détecté comme dépendance → effet classé "mountOnly" à tort (ne se
      // re-déclenche JAMAIS quand `$price` mute). Un objet/tableau littéral
      // AU NIVEAU RACINE d'une interpolation vivait ce bug ; À L'INTÉRIEUR
      // d'un `{for}` c'était masqué (le corps de boucle re-tourne
      // structurellement de toute façon).
      let whole: string | null = null
      try {
        const wholeCandidate = `[${str}]`
        const wholeClean = cleanJs(tokenize(wholeCandidate, { externalVars: this.externalVars }), this.externalVars)
        acorn.parse(wholeClean.replace(/===/g, '==').replace(/!==/g, '!='), { ecmaVersion: 'latest', sourceType: 'module' })
        whole = wholeCandidate
        wholeCleanCached = wholeClean
      } catch {
        whole = null
      }

      if (whole !== null) {
        codeToAnalyze = whole
      } else {
        // Scan ÉQUILIBRÉ (accolades imbriquées + quotes) : l'ancienne regex
        // `{[^}]+}` s'arrêtait au PREMIER `}` — un effet `doX({k: $b})` perdait
        // `$b` de ses deps → classé mountOnly à tort (updates manqués, muets).
        const blocks: string[] = []
        let leftover = ''
        let ci = 0
        const cn = str.length
        while (ci < cn) {
          if (str[ci] === '{') {
            let depth = 1
            let cj = ci + 1
            let inStr: string | null = null
            while (cj < cn && depth > 0) {
              const c = str[cj]
              if (inStr) {
                if (c === '\\') cj++
                else if (c === inStr) inStr = null
              } else if (c === '"' || c === "'" || c === '`') inStr = c
              else if (c === '{') depth++
              else if (c === '}') depth--
              cj++
            }
            if (depth === 0) {
              // réactivité `µt` sans parenthèses —
              // ce bloc a DEUX lectures possibles : marqueur de template (`{$a}` →
              // expression NUE `$a`, comportement historique ci-dessous) ou OBJET
              // LITTÉRAL (`{ x: $v }`, argument d'un appel Civet SANS parenthèses qui
              // a fait échouer la tentative « whole » ci-dessus — `µt 'clé', { x: $v }`
              // n'est compris QUE par une vraie compilation Civet, jamais par l'acorn
              // nu utilisé ici). La lecture NUE, ici, PERDAIT les accolades : `x: $v`
              // (LABEL, invalide comme élément de tableau) → `acorn.parse` échouait →
              // `analyzeSnippet` rendait `[]` (catch silencieux) → `$v` jamais détecté
              // comme dépendance, effet classé "mountOnly" à tort — SEULEMENT quand ce
              // bloc suit un appel sans parenthèses (avec parenthèses, la tentative
              // « whole » réussit déjà plus haut, cette décomposition n'est jamais
              // atteinte). Tranché par ESSAI RÉEL (acorn), pas par heuristique de
              // forme : si la lecture nue ne parse pas comme élément de tableau, on
              // retente EN GARDANT les accolades ; objet littéral valide → gardées.
              const interior = str.slice(ci + 1, cj - 1)
              if (canParseAsArrayElement(interior, this.externalVars)) {
                blocks.push(interior)
              } else {
                const fullBraced = str.slice(ci, cj)
                blocks.push(canParseAsArrayElement(fullBraced, this.externalVars) ? fullBraced : interior)
              }
            } else {
              blocks.push(str.slice(ci + 1, cj))
            }
            ci = cj
          } else {
            leftover += str[ci]
            ci++
          }
        }
        const matches = leftover.match(/(?<![\w.\$])\$[a-zA-Z0-9_$]+/g)
        if (matches) blocks.push(...matches)
        codeToAnalyze = `[${blocks.join(', ')}]`
      }
    } else if (str.includes('#') && str.match(/(?<![\w.\$])\$[a-zA-Z0-9_$]+/)) {
      const matches = str.match(/(?<![\w.\$])\$[a-zA-Z0-9_$]+/g) ?? []
      codeToAnalyze = `[${matches.join(', ')}]`
    } else {
      codeToAnalyze = `[${str}]`
    }

    // `tokenize` seul ne couvre que les sigils ($x → $.x). Pour que `acorn.parse`
    // ne plante pas silencieusement sur les snippets Coffee/Civet (`or`, `and`,
    // `not`, `is`...) — auquel cas analyzeSnippet retourne `[]` et l'effect
    // finit en `mountOnly` au lieu d'être re-fired sur mutation de sa dep —
    // on passe par `cleanJs` qui mappe ces idiomes en JS standard.
    // réutilise le clean du whole-parse quand il a réussi
    // (`codeToAnalyze === wholeCandidate` → clean strictement identique).
    const cleanCode = wholeCleanCached ?? cleanJs(tokenize(codeToAnalyze, { externalVars: this.externalVars }), this.externalVars)
    let cleanCodeForAst = cleanCode.replace(/===/g, '==').replace(/!==/g, '!=')

    // REPLI CIVET — `cleanJs` (regex historique,
    // ligne au-dessus) ne connaît pas toute la grammaire Civet (appel implicite
    // `f $x`, tube `|>`, `unless`…) : la tentative JS nue peut échouer à parser
    // alors que le CODE ÉMIS, lui, compile très bien (cleanJsExpr passe par le
    // VRAI compilateur Civet, generator/utils.ts). Sans repli, `analyzeSnippetOrNull`
    // rendait `null` avalé en `[]` par `analyzeSnippet` (avant ce correctif) —
    // dépendance perdue en SILENCE, effet classé « mountOnly » à tort. Ici, sur
    // ÉCHEC SEULEMENT (perf — la compilation Civet reste la branche rare, jamais
    // sur le chemin déjà vert) : on recompile `str` (l'expression BRUTE, pas
    // `codeToAnalyze` déjà mutilé par l'heuristique JS ci-dessus) via le MÊME
    // pipeline que l'émission — même normalisation `isnt`, même `coffeeEq`, même
    // cache (civetExprCache, utils.ts) — puis on retente le parse sur son
    // résultat. Si ÇA échoue aussi, l'expression est réellement incompilable :
    // le candidat d'origine est gardé tel quel (comportement identique à avant
    // ce correctif, `[]` in fine) et on avertit — une fois, au real pass — si un
    // `$xxx` textuel laisse deviner une dépendance qu'on ne pourra jamais suivre.
    if (analyzeSnippetOrNull(cleanCodeForAst) === null) {
      let civetOk = false
      try {
        const civetCandidate = `[${cleanJsExpr(raw, this.externalVars, this.templateLang, this.moduleName)}]`
        if (analyzeSnippetOrNull(civetCandidate) !== null) {
          cleanCodeForAst = civetCandidate
          civetOk = true
        }
      } catch {
        // expression réellement incompilable (même par le vrai Civet) — repli conservé tel quel, cf. avertissement plus bas
      }
      if (!civetOk && !this.isPrePass && /\$[A-Za-z_]\w*/.test(raw)) {
        const moduleHint = this.moduleName ? t('generator.hint-dans-module', { moduleName: this.moduleName }) : ''
        console.warn(t('generator.deps-non-analysables', { expr: raw, moduleHint }))
      }
    }

    if (this.isPrePass) {
      this.snippetRegistry.push(cleanCodeForAst)
      return []
    }

    return this.analyzer?.getEffectVars?.(cleanCodeForAst) ?? []
  }

  /** Enregistre un code d'update pour chaque var de la liste `vars`.
   * Utilisé par le generator + attributes pour le dispatch direct V2.
   * Si `vars` est vide, le code n'est associé à aucune var → il ne sera
   * exécuté qu'au mount initial (via `_mjs_effectsAll`).
   *
   * BUG : `code` est enregistré ICI tel
   * quel, alors que la MÊME expression, capturée par `compileIf` dans
   * `ctx.updates`, finit par ailleurs GARDÉE par la condition de branche
   * (`_mjs_renderStruct`/branchExecBlock). Sans `effectGuardStack`, ce 2e
   * enregistrement (celui-ci) était NU : `{if @x?.y} … {@x.y.z} … {end}`
   * enregistrait `this._mjs_updText('t', x.y.z)` SANS garde → exécuté par
   * `_mjs_effectsAll` au montage (et par le dispatch ciblé `_mjs_effectsByVar` sur
   * mutation ultérieure) même quand `x` est `null`, malgré le `?.` de la
   * condition qui protège pourtant `_mjs_renderStruct`. Fix : enveloppe `code`
   * avec la même garde que le bloc AVANT de le stocker — les deux copies
   * (celle de struct, celle-ci) partagent désormais la même condition. */
  registerEffect(code: string, vars: string[]): void {
    const guarded = this.effectGuardStack.length === 0
      ? code
      : this.effectGuardStack.reduceRight((acc, g) => `if (${g}) { ${acc} }`, code)
    if (vars.length === 0) {
      // Aucune var réactive → effect "mount only" (rendu une fois à l'init).
      // dédup via Set (l'ancien `Array.includes` était quadratique).
      if (!this.mountOnlyEffectsSet.has(guarded)) { this.mountOnlyEffectsSet.add(guarded); this.mountOnlyEffects.push(guarded) }
      return
    }
    for (const v of vars) {
      let list = this.effectsByVar.get(v)
      if (!list) { list = []; this.effectsByVar.set(v, list) }
      if (!list.includes(guarded)) list.push(guarded)
    }
  }
}

// AsyncLocalStorage qui isole le `CompilerState` par flux async. Le bundler
// fait `withState(() => compileMjs(file))` par fichier — tous les `await`
// dedans propagent leur store automatiquement.
const stateStorage = new AsyncLocalStorage<CompilerState>()

// Singleton de repli quand aucun `withState` n'est actif (mode séquentiel
// historique, tests directs sans wrapper, etc.).
const fallbackState = new CompilerState()

/**
 * Exécute `fn` avec un `CompilerState` isolé. Tout code transitivement appelé
 * (sync ou async) verra `state.X` rediriger vers cette instance.
 *
 * Permet `Promise.all([withState(() => f1()), withState(() => f2())])` avec
 * zéro contamination entre les flux concurrents.
 */
export function withState<T>(fn: () => T | Promise<T>): T | Promise<T> {
  return stateStorage.run(new CompilerState(), fn)
}

/** Récupère l'instance courante (store async ou fallback singleton). */
function currentState(): CompilerState {
  return stateStorage.getStore() ?? fallbackState
}

/**
 * `state` : Proxy backward-compatible. Tous les sites historiques qui font
 * `state.counter`, `state.events.X`, `state.inlines.push(...)` continuent à
 * fonctionner. La lecture/écriture est redirigée vers le store courant.
 */
export const state: CompilerState = new Proxy(fallbackState, {
  get(_target, prop) {
    return (currentState() as any)[prop]
  },
  set(_target, prop, value) {
    ;(currentState() as any)[prop] = value
    return true
  },
  has(_target, prop) {
    return prop in currentState()
  },
}) as CompilerState

// Helpers libres backward-compatibles — délèguent au store courant.
export function reset(opts: ResetOpts = {}): void {
  currentState().reset(opts)
}

export function genId(prefix: string): string {
  return currentState().genId(prefix)
}

/** Récupère la closure des state vars dont dépend une expression (V2). */
export function getEffectVars(expr: string | null | undefined): string[] {
  return currentState().getEffectVars(expr)
}

/** Enregistre un code dans le dispatch direct (V2). */
export function registerEffect(code: string, vars: string[]): void {
  currentState().registerEffect(code, vars)
}

// dedent : utilitaire sans état (laissé hors classe).
export function dedent(str: string | null | undefined): string {
  if (str == null) return ''
  const lines = str.split('\n')
  const margins = lines
    .filter((l) => l.trim() !== '')
    .map((l) => {
      const m = l.match(/[^\s]/)
      return m ? m.index! : null
    })
    .filter((m): m is number => m !== null)
  const margin = margins.length > 0 ? Math.min(...margins) : 0
  return lines.map((l) => (l.length > margin ? l.slice(margin) : '')).join('\n')
}
