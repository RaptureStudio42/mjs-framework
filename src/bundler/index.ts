// bundler — orchestrateur du cycle de compilation V2.
// Port simplifié d'un outillage de synchronisation interne antérieur (Ruby).
//
// Responsabilités :
//   1. Compile le runtime mjs_*.coffee → mjs_core.js
//   2. Compile les .mjs (composants) via transpiler → fichiers .js
//   3. Compile les .coffee (modules ES) via language adapter
//   4. Hash MD5 dans les filenames pour cache busting
//   5. Génère un manifest `µ.paths = {...}`
//   6. Watch mode via chokidar (re-compile au changement)
//   7. Résolution µasset() inline
//
// Pas encore : partial deps (extract_partial_deps).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, existsSync, unlinkSync, renameSync, realpathSync } from 'node:fs'
import { resolve, basename, extname, dirname, relative, join, sep } from 'node:path'
import { createHash } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { AsyncLocalStorage } from 'node:async_hooks'
import * as acorn from 'acorn'
import * as walk from 'acorn-walk'
import { transpile, cssTrapWarnings } from '../transpiler/index.js'
import { INCLUDE_RE, resolvePartial } from '../transpiler/macros.js'
import { scanImgTags, isResolvableSrc, parseWidths, rewriteImgTag, type ImgTag } from '../transpiler/img-tag.js'
import { getAdapter } from '../languages/index.js'
import { build as esbuildBuild } from 'esbuild'
import { minifyJs, withMangleCacheLock, buildPureList, collectInstanceNames, reserveMangleNames, reserveDataMarkers, CORE_HELPER_NAMES } from './minify.js'
import { readImageSize, generateVariants } from './image.js'
import { compileCss } from '../transpiler/css.js'
import { shiftGeneratedPosition, chainOverMap } from '../transpiler/source-map-chain.js'
import { compileThemeFile, assembleThemes, isThemeFile } from './themes.js'
import { withState } from '../generator/state.js'
import { cpus } from 'node:os'
import { WorkerPool, resolveWorkerScript } from './worker-pool.js'
import { transpileFromMsg, type TranspileMsg } from './transpile-msg.js'
import { normalizePreload, OPTIONAL_RUNTIME_MODULES, DETECTED_CORE_MODULES, levenshtein, resolveLogLevel, logLevelAllows } from './config.js'
import type { PreloadConfig, RuntimeConfig, VtValue, I18nConfig, CssConfig, JsConfig, LogLevelConfig, RenderConfig, RenderMode } from './config.js'
import { normalizeMode } from '../server/render-routes.js'
import { t, getMessagesLang } from '../messages/index.js'
import { MU_IMPORT_BODY, rewriteMuImportAst } from '../sigils.js'
import { RUNTIME_LABELS } from '../runtime-labels.js'
import { AT_RESERVED_NAMES, type TagRef, type TagRefKind } from '../parser/index.js'
import { scanCompiledFeatures } from './features.js'
import { collectCoreCalls, missingCoreSymbols } from './core-contract.js'

// Pool global partagé entre tous les Bundlers du process (process-wide).
// Évite de créer/terminer un pool par instance — coût d'init non négligeable
// (esbuild compile + démarrage workers ~200ms). Le pool est lazy, créé au 1er
// usage, et `bundler.close()` le termine seulement si plus aucun Bundler ne
// l'utilise (refcount).
let _sharedWorkerPool: WorkerPool | null = null
// mémoïse la PROMESSE de création (pas
// seulement la valeur résolue `_sharedWorkerPool`) : cf. le commentaire détaillé
// dans ensureWorkerPool() plus bas, qui explique le TOCTOU que cette variable
// referme.
let _sharedWorkerPoolPromise: Promise<WorkerPool> | null = null
let _sharedWorkerPoolRefCount = 0

/** Force la fermeture du pool partagé. Utile pour les tests qui créent
 * plusieurs Bundlers et veulent un cleanup propre à la fin de la suite. */
export async function terminateSharedWorkerPool(): Promise<void> {
  if (_sharedWorkerPool) {
    await _sharedWorkerPool.terminate()
    _sharedWorkerPool = null
    _sharedWorkerPoolPromise = null
    _sharedWorkerPoolRefCount = 0
  }
}

/** Un pool de threads est-il VIVANT dans ce processus ? Sonde de test : « ce projet
 * a-t-il seulement démarré des threads ? » ne se lit nulle part ailleurs — un pool
 * jamais créé est indiscernable d'un pool créé puis inutilisé. */
export function isSharedWorkerPoolAlive(): boolean {
  return _sharedWorkerPool !== null
}

/**
 * Map parallèle avec limite de concurrence. Lance au plus `concurrency`
 * promesses simultanément ; les autres attendent qu'un slot se libère.
 *
 * Sans cette limite, `Promise.all(474 items)` lance 474 compilations en même
 * temps → sature l'I/O fichier, pression mémoire, V8 thrashing → BIEN plus
 * lent que séquentiel. Avec un cap raisonnable (~CPU count × 2), on garde
 * le throughput optimal.
 */
async function parallelMap<T, R>(
  items: T[],
  fn: (item: T) => Promise<R>,
  concurrency: number,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length)
  let cursor = 0
  const worker = async () => {
    while (cursor < items.length) {
      const idx = cursor++
      try {
        results[idx] = { status: 'fulfilled', value: await fn(items[idx]) }
      } catch (reason) {
        results[idx] = { status: 'rejected', reason }
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, items.length) }, worker)
  )
  return results
}

// Concurrency cap : aligné sur le nombre de workers du pool.
//
// **Mémoire** : chaque worker_threads spawned charge le bundle worker (~700 MB
// quand bundle:true esbuild). Avec 8 workers, ça fait 5-6 GB de RAM rien que
// pour les workers. Sur un système 8 GB, ça déclenche OOM-kill et fait crasher
// le shell / l'éditeur. On dimensionne donc en fonction de la RAM dispo :
//   - système <= 8 GB : 2-4 workers
//   - système <= 16 GB : 4-6 workers
//   - système >= 16 GB : up to cpus().length, plafonné à 8.
import { totalmem } from 'node:os'
const _totalGb = totalmem() / 1024 / 1024 / 1024
const _maxWorkers = _totalGb < 8 ? 2 : _totalGb < 16 ? 4 : Math.min(8, cpus().length)
const PARALLEL_LIMIT = Math.max(2, _maxWorkers)

// Seuil en DESSOUS duquel la transpilation se fait dans le processus principal, sans
// aucun thread : un thread coûte ~570 ms de chargement (paquet worker, sass, civet) et le
// maître attend le pool ~190 ms, pour un travail qui dure quelques dizaines de ms par
// composant. Sous le seuil, le pool coûte donc plus cher que ce qu'il abat.
// Mesuré le 16/09/2026, 8 cœurs / 30 Go, construction `--prod` d'un projet dupliqué à
// partir d'une appli réelle — médiane de 5 constructions, en ms, direct vs threads :
//   8 comp. : 703 / 1292    16 : 790 / 1466    24 : 947 / 1649    40 : 1140 / 1892
// Le direct gagne partout dans la plage mesurée ; poussé plus loin (80/160/320 composants, mêmes
// 5 constructions), il gagne encore (1705/2778, 3002/4205, 4735/7214) — aucun point de
// croisement observé sur ces petits composants (styles vides, HTML court).
// Sur un site réel à composants lourds (SASS, HTML volumineux), 742 composants + 13 modules et des
// sous-ensembles fermés sur leurs dépendances, médianes de 3 à 5 constructions froides alternées,
// même machine, le croisement tombe entre 37 et 56 fichiers — direct / threads, en ms :
//   21 fichiers : 941 / 1216    29 : 1036 / 1396    37 : 1152 / 1419
//   56 : 3230 / 2751    101 : 3704 / 3069    213 : 5343 / 4124    755 : 12383 / 7728
// Le seuil de 40 tombe dans ce croisement : il est gardé. Le nombre de fichiers reste un indicateur
// grossier du travail (les petits composants croisent bien plus haut, au-delà de 320).
const INLINE_LIMIT = 40

export interface BundlerOpts {
  /** Répertoire racine des sources (.mjs/.coffee). */
  sourceDir?: string
  /** Répertoire racine du runtime CoffeeScript (mjs_*.coffee). */
  runtimeDir?: string
  /** Répertoire de sortie des fichiers compilés et hashés. */
  outputDir?: string
  /** Path du manifest entrypoint généré. */
  manifestPath?: string
  /** Path du manifest externe (format require/require_dir/require_tree). */
  manifestExternal?: string
  /** Lang par défaut pour `<script>` sans `lang=`. */
  defaultScriptLang?: 'civet' | 'coffee' | 'ts' | 'js'
  /**
   * Grammaire des interpolations `{…}` du template ET des handlers inline
   * (`@click={…}`). Défaut `'civet'`
   * (appliqué côté transpiler, pas ici) ; `'js'` = repli comportement
   * historique. ENCORE INUTILISÉ : l'option existe et circule, mais rien ne la
   * consomme — les briques handlers/interpolations n'existent pas encore.
   */
  templateLang?: 'civet' | 'js'
  /** Sigil tapé par le dev : `'µ'` (défaut) ou `'mjs'` (fallback ASCII). */
  sigil?: 'µ' | 'mjs'
  /** Alias ASCII contexte/partagé `__context.X`/`__shared.X` (opt-in, off déf.). */
  contextAlias?: boolean
  /** Mode strict « politique de sécurité de contenu » : zéro `<style>`/`<script>` en ligne (opt-in, off déf.). */
  csp?: boolean
  /** Émission des cartes de source : `'prod'` (défaut, historique), `'dev'`, `'always'`, `'never'`. */
  sourceMap?: 'never' | 'dev' | 'prod' | 'always'
  /** Seuil du lint « trop de variables d'état » (entier ≥ 0, 0 = désactivé ; défaut 40 côté transpiler). */
  maxStateVars?: number
  /** politique des variantes d'image produites par `µimage` (clé `image`
   *  de mjs.config.json). Défauts résolus au constructeur : `[480, 960, 1920]`,
   *  `['webp']`, qualité 78. */
  image?: { widths?: number[]; formats?: string[]; quality?: number }
  /** Lint d'accessibilité (a11y) au build — cf. transpiler/a11y.ts. Défaut `true`
   *  (activé) appliqué côté transpiler, pas ici ; `false` désactive tout le contrôle. */
  a11y?: boolean
  /** Un composant qui échoue à compiler garde-t-il son ANCIENNE sortie référencée au manifeste ?
   *  `true` (défaut) en dev/serve : le site reste utilisable pendant qu'on corrige. `false` en
   *  build : la version repêchée peut importer un `mjs_core-<hash>` supprimé depuis — page morte
   *  au navigateur alors que rien ne le dit. */
  keepFailedComponents?: boolean
  /**
   * LEGACY (interne, tests/CI) — « build de prod minifié » d'un bloc : équivaut à
   * `env: 'prod'` + `minify: true`, et cède devant l'un ou l'autre s'il est posé.
   * La clé PUBLIQUE `minify` de mjs.config.json ne passe PLUS par ici :
   * elle ne décide que de la minification (cf. `minify` ci-dessous).
   */
  forceMinify?: boolean
  /**
   * ENVIRONNEMENT du build — SEULE source de vérité de `isProd()`. Défaut `'dev'`.
   * En CLI, c'est le DRAPEAU qui le pose : `mjs build` = dev, `mjs build --prod` = prod.
   * Décide du hachage i18n, du `dev:` du manifeste, de l'exposition de `window.µ`,
   * des cartes de source (via `sourceMap`) et de la présence des modules
   * d'inspection (`mjs_debug`/`mjs_devinspect`/`mjs_devpanel`).
   */
  env?: 'dev' | 'prod'
  /** `'auto'` (défaut) : on minifie là où `env` dit prod. `true`/`false` : imposé. */
  minify?: boolean | 'auto'
  /** Répertoire des styles partagés (référencés par `@css name` dans .mjs). */
  stylesheetsDir?: string
  /** Préfixe des variables de thème : `$$brand` → `var(--<varPrefix>-brand)`. Défaut `mjs`. */
  varPrefix?: string
  /** Thème qui vaut sans attribut (posé aussi sur `:root`). Défaut `light`. */
  defaultTheme?: string
  /**
   * Mode "runtime minimal" : exclut les modules optionnels du bundle
   * `mjs_core.js`. Désactivés par défaut (`false`) pour rétrocompat ; activer
   * pour gagner ~10-20KB sur des apps simples (benchs, widgets isolés) qui
   * n'utilisent pas Router/UJS/AJAX/animations/flip/spring.
   *
   * Modules retirés en mode minimal :
   *   - mjs_easing (transitions)
   *   - mjs_flip (FLIP layouts)
   *   - mjs_spring (interpolation physique)
   *   - mjs_ajax (helpers HTTP)
   *   - mjs_router (Router)
   *   - mjs_ujs (intercepts links/forms)
   *
   * Modules conservés (toujours requis) :
   *   - mjs_init, mjs_interpolate, mjs_store, mjs_runes, mjs_debug,
   *     mjs_autoloader, mjs_element
   */
  minimalRuntime?: boolean
  /**
   * Sélection fine des modules runtime (généralise `minimalRuntime`). `'all'`
   * (défaut) / `'core'` / tableau de modules optionnels à ajouter au cœur.
   * Exposé dans mjs.config.json (clé `runtime`). Si fourni, prime sur
   * `minimalRuntime`.
   */
  runtime?: RuntimeConfig
  /**
   * Mode d'émission des styles partagés — cf. le JSDoc complet de `MjsConfig.css`
   * (bundler/config.ts). `'bundle'` (défaut, inchangé) / `'split'` (un fichier par
   * feuille, importé par les seuls modules qui la déclarent) / `'lazy'` (pas encore
   * implémenté, échec de build explicite). Exposé dans mjs.config.json (clé `css`).
   */
  css?: CssConfig
  /**
   * Mode d'émission des composants/modules/cœur — cf. le JSDoc complet de `MjsConfig.js`
   * (bundler/config.ts). `'split'` (défaut, inchangé) / `'bundle'` (un seul fichier JS pour
   * toute l'appli, exige `css: 'bundle'`). Exposé dans mjs.config.json (clé `js`).
   */
  js?: JsConfig
  /**
   * Préfixe URL public des fichiers émis (utilisé dans `µ.paths`, dirInject,
   * etc.). Si non fourni, dérivé automatiquement de `outputDir` en retirant
   * le préfixe `public/` (convention universelle : la doc-root du serveur HTTP).
   *
   * Exemples :
   *   outputDir='public/modularjs'                  → urlPrefix='/modularjs'
   *   outputDir='public/assets/modularJS_compiled'  → urlPrefix='/assets/modularJS_compiled'
   *   outputDir='dist'                              → urlPrefix='/' (override conseillé)
   */
  urlPrefix?: string
  /** Préchargement des liens : émis dans le manifeste (`µ.preload`) pour le client. */
  preload?: PreloadConfig
  /** Transitions de page : émis dans le manifeste (µ.viewTransition) pour le client —
   *  "none" (défaut, désactivé) ou nom de préréglage (cf. VT_PRESET_NAMES, config.ts) —
   *  aucun booléen, cf. `VtValue`. */
  viewTransition?: VtValue
  /**
   * Niveau de la console (navigateur ET build) — cf. le JSDoc de `MjsConfig.logLevel`
   * (config.ts) pour la sémantique complète. Défauts résolus au point de consommation
   * (`Bundler.currentLogLevel`/`prodLogLevel`), comme `preload`/`viewTransition` ci-dessus.
   */
  logLevel?: LogLevelConfig
  /**
   * i18n façon Rails — cf. le JSDoc de `MjsConfig.i18n` (config.ts) pour la
   * sémantique complète. Scanné dans `sourceDir/i18n/` au build, émis dans le
   * manifeste (`µ._i18nData`) pour le runtime optionnel `mjs_i18n.ts`.
   */
  i18n?: I18nConfig
  /**
   * Bloc `render` du projet (pages → composant + mode) — cf. le JSDoc de `RenderConfig`
   * (config.ts). Le bundler n'en lit QUE les modes, et pour une seule décision : embarquer ou
   * non le module d'hydratation `mjs_hydrate.ts` (`ssr:markers`/`ssr:positional`/`ssr:diff` —
   * cf. `resolveRuntimeFiles`). Le prérendu et le serveur de rendu, eux, le lisent entier de
   * leur côté.
   */
  render?: RenderConfig
  /**
   * Filet de sécurité anti-interblocage pour la dédup de compiles concurrents
   * (cf. `compileWithDedup`) : délai max (ms) d'attente d'une compilation
   * DÉJÀ en vol avant d'abandonner avec une erreur explicite. Option interne
   * (pas dans `MjsConfig`/mjs.config.json — même statut que `minimalRuntime`),
   * exposée surtout pour les tests (permet un délai court plutôt que
   * d'attendre la vraie valeur de prod). Défaut : 12000ms.
   */
  dedupWaitTimeoutMs?: number
  /**
   * Répertoire du catalogue de modules cœur (invoqués via `<@mjs-nom>`),
   * résolu par défaut relativement au PAQUET ModularJS (`src/core-modules/`),
   * jamais au projet compilé. Option interne (pas dans `MjsConfig`/
   * mjs.config.json — même statut que `dedupWaitTimeoutMs`), exposée surtout
   * pour les tests (catalogue de test isolé, sans toucher au vrai dossier).
   */
  coreModulesDir?: string
  /**
   * Seuil de bascule « transpilation dans le processus principal » (cf. INLINE_LIMIT) :
   * un projet d'au plus N fichiers compilés ne démarre aucun thread. Option interne
   * (pas dans `MjsConfig`/mjs.config.json — même statut que `dedupWaitTimeoutMs`),
   * exposée pour les tests et les mesures : 0 force le chemin par threads, une valeur
   * très grande force le direct. Défaut : INLINE_LIMIT.
   */
  inlineTranspileLimit?: number
}

/**
 * Données i18n d'un build (contrat FIGÉ avec le runtime `mjs_i18n.ts`) — objet EN
 * MÉMOIRE, dont le manifeste ne publie qu'une PARTIE (`i18nPublicData()`) :
 * `root`/`sections` partent, eux, dans un fichier PAR LANGUE
 * (`mjs_i18n-<langue>-<hash>.js`, cf. `scanI18n`), téléchargé pour la seule langue
 * affichée — le manifeste est servi sur CHAQUE page et ne doit plus porter la
 * prose des langues qu'on ne voit pas. Le rendu serveur, lui, garde tout sous la
 * main (renderToString.ts sème chaque langue par `µ._i18nLang`).
 *   `root`     = dictionnaires racine (`sourceDir/i18n/<langue>.yml|.json`) ;
 *   `sections` = nom COMPACT du fragment de chaque section (hash en prod, nom
 *                clair en dév) — l'URL se reconstitue `prefix/<langue>/<nom>.json`,
 *                formule unique côté runtime (`__i18nSectionUrl`) ;
 *   `prefix`   = préfixe public des fragments (`<urlPrefix>/i18n`) ;
 *   `langs`    = langues SÉLECTIONNABLES (dictionnaire racine présent) ;
 *   `files`    = URL publique du fichier de chaque langue.
 * `dev: !isProd()` — jamais varié par `hash` (toujours faux hors prod).
 */
export interface I18nManifestData {
  dev: boolean
  default: string
  placeholder: 'auto' | 'key' | 'wait'
  persist: boolean
  detect: boolean
  urlParam: boolean
  prefix: string
  langs: string[]
  files: Record<string, string>
  root: Record<string, Record<string, any>>
  sections: Record<string, Record<string, string>>
}

/** Sous-ensemble RÉELLEMENT émis dans le manifeste (`µ._i18nData`) : tout sauf
 *  `root`/`sections`, partis dans les fichiers de langue. */
export type I18nPublicData = Omit<I18nManifestData, 'root' | 'sections'>

export interface CompileStats {
  written: number
  errors: Error[]
  /** Avertissements non-bloquants : collisions de noms de fichiers (deux `.mjs`
   * avec le même basename → conflit autoloader), assets ratés, etc. */
  warnings: string[]
  manifest: Record<string, string>
  sizes: SizeReport[]
  durationMs: number
  /**
   * Rechargement CSS à chaud (mode watch seulement — cf. `cssOnlyTracking`) :
   * `undefined` hors watch (`build`/`check`/`serve`, jamais calculé) ; `null` en watch
   * quand ce recompile n'est PAS qualifiable "css-only" (repli reload complet, au
   * moindre doute) ; un objet non vide quand CHAQUE fichier recompilé ce tour-ci est
   * soit un composant dont seul le CSS a changé, soit une feuille partagée de
   * `stylesheetsDir` — cf. `watch()`/`_compileMjsInner`/`bundleSharedStyles`.
   */
  cssOnly?: CssOnlyPayload | null
}

export interface SizeReport {
  /** Nom logique (basename sans hash). */
  name: string
  /** Path web complet. */
  path: string
  /** Taille en octets. */
  bytes: number
}

/** Subset de TranspileData utilisé par le bundler après le retour worker.
 * Pas besoin d'importer le type complet — worker_threads structuredClone
 * retourne un plain object. */
type TranspileDataLike = {
  usedAnimations: string[]
  // jumeau de usedAnimations côté anims DÉFINIES
  // dynamiquement (µanim.create/crossfade) ; cf. Bundler.definedAnimations.
  definedAnimations: string[]
  /** Noms de feuilles partagées `@css nom1 nom2…` référencées par ce composant
   * (crash-si-absent) — projeté par le worker (worker.ts) au même
   * titre que usedAnimations ; alimente `Bundler.requestedSharedSheets`
   * (cf. validateSharedSheets()). Optionnel (`?? []` partout où il est consommé)
   * par prudence — même style défensif que usedAnimations/definedAnimations
   * sur un CacheEntry, même si `this.cache` est un Map en mémoire pur (jamais
   * persisté sur disque, donc pas de vieux cache d'avant cette politique à redouter ici). */
  sharedCssNames?: string[]
  includedPartials: string[]
  /** Diagnostics de processIncludes
   * (partial introuvable, <@include> circulaire) remontés depuis le worker. */
  macroErrors: string[]
  /** 2e <script>/<style>
   * silencieusement jeté par extractSections (composant OU partial inclus),
   * remonté depuis le worker. Non fatal (contrairement à macroErrors) →
   * stats.warnings, pas stats.errors. */
  sectionWarnings: string[]
  /** Références `<@nom>`/`<mjs-nom>`/`<mjs-core-nom>` (notation
   * unique, `<@mjs-nom>` est une erreur de migration) collectées par le
   * parseur pour ce fichier, remontées depuis le worker (cf. worker.ts) —
   * résolues par `resolveTagShortcuts` en fin de compile(). */
  tagRefs?: TagRef[]
  /** Dépendances DIRECTES de balises du gabarit (cf. collectDirectComponentDeps,
   * generator/compile.ts), remontées depuis le worker — table de préchargement
   * du manifeste (cf. Bundler.pendingComponentDeps/buildManifestDeps). */
  componentDeps?: string[]
  /** Tag custom element (`mjs-xxx`) — clé du payload `cssOnly.components`
   * (rechargement CSS à chaud, cf. dataEqualExceptBaseCss/computeScopedCss). */
  tagName: string
  /** Tag alias additionnel éventuel (même CSS que tagName) — cf. injectTemplate. */
  aliasTag?: string
  /** CSS brut compilé du `<style>` du composant (AVANT le préfixe `:host{display}`)
   * — le SEUL champ de `data` qui peut différer pour qu'un recompile soit
   * qualifié "css-only" (cf. dataEqualExceptBaseCss). */
  baseCss: string
  /** `@display` du composant — entre dans le CSS scopé final (computeScopedCss)
   * mais fait partie de l'empreinte "hors-baseCss" (restHash) : un changement
   * de @display n'est PAS un css-only (repli full, sans risque). */
  moduleDisplay: string
  /** CSS de chaque `<style name="…">`, par nom — écrit en fichier frère du module. */
  layoutCss?: Record<string, string>
  /** Variables de thème `$$` DÉCLARÉES par les blocs `<theme>` du composant — alimente le registre. */
  themeVars?: { name: string; variant: string; line: number; doc: string }[]
  /** Variables de thème `$$` LUES par le composant — sert à repérer un nom que personne ne déclare. */
  varsRead?: string[]
  /** Noms des variantes `<theme name="…">` déclarées. */
  themeVariants?: string[]
  /** EMPREINTE (SHA-256, 16 hex) de TOUT le TranspileData privé de baseCss,
   * calculée DANS LE WORKER (cf. worker.ts) : préserve l'optimisation (les gros
   * champs — surgicalHtml, createFnBody… — ne repassent jamais au master)
   * tout en permettant le test « hors-baseCss strictement identique ». */
  restHash: string
  // ... le reste passe via structuredClone mais on n'y accède pas dans le bundler
  [key: string]: any
}

/** Payload « rechargement CSS à chaud » — un recompile où SEUL le CSS a
 * changé (composants et/ou feuilles partagées de `stylesheetsDir`). Consommé par
 * `server/hmr.ts` (notifyCssUpdate) puis le runtime (`µ._hotCss`, mjs_element.ts). */
export interface CssOnlyPayload {
  /** tag custom element (`mjs-xxx`) → CSS scopé complet (déjà préfixé `:host{display}`). */
  components: Record<string, string>
  /** nom de feuille partagée (`@css nom`) → CSS compilé. */
  sheets: Record<string, string>
  /** CSS de `mjs_root.{sass,scss}` (adopté globalement), si présent ET changé. */
  root?: string
}

// dataEqualExceptBaseCss — compare deux TranspileData en ignorant `baseCss` (seul
// champ pouvant différer pour un recompile "css-only"), via
// l'empreinte `restHash` calculée dans le worker (SHA-256 du data privé de
// baseCss — cf. worker.ts : évite de ré-expédier les gros champs au master).
// Empreinte absente d'un côté (data hors pipeline worker) → jamais égal,
// repli reload complet (fail-safe).
function dataEqualExceptBaseCss(a: TranspileDataLike, b: TranspileDataLike): boolean {
  return typeof a.restHash === 'string' && a.restHash.length > 0 && a.restHash === b.restHash
}

// computeScopedCss — MÊME formule que injectTemplate() (transpiler/index.ts,
// `displayPrefix + data.baseCss`, ce qui alimente `this._mjs_baseCss` côté runtime)
// dupliquée ICI plutôt qu'importée de src/transpiler/**.
// DOIT rester en phase si cette formule change un jour côté transpiler.
function computeScopedCss(data: TranspileDataLike): string {
  return `:host{display:${data.moduleDisplay}}` + (data.baseCss ?? '')
}

// escapeRegex — échappe les métacaractères regex d'un fragment interpolé dans un `new
// RegExp(...)` (même besoin que `cleanupOldHashes` plus bas, trop loin dans ce fichier
// pour partager l'inline sans y perdre en lisibilité).
function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

// scanDeclaredVars — registre des variables de thème, source 4 : toute déclaration
// `--<prefix>-<nom>: valeur` d'un texte CSS DÉJÀ COMPILÉ, `$$` ou CSS brut confondus (les
// deux sortent identiques une fois compilés). Une déclaration = le nom suivi de `:` ;
// `var(--mjs-x)` est une LECTURE, jamais capturée ici (aucun `:` ne suit le nom).
function scanDeclaredVars(css: string, prefix: string): { name: string; value: string }[] {
  const re = new RegExp(`--${escapeRegex(prefix)}-([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*([^;{}]+)`, 'g')
  const out: { name: string; value: string }[] = []
  let m: RegExpExecArray | null
  while ((m = re.exec(css)) !== null) out.push({ name: m[1], value: m[2].trim() })
  return out
}

// buildVarDeclarations — jumelle chaque déclaration trouvée par scanDeclaredVars() avec
// sa ligne/son commentaire/sa VARIANTE quand elle vient d'un `$$nom` tracé par le transpiler
// (`themeMeta`, même ORDRE d'apparition des deux côtés : le compilateur CSS ne réordonne pas
// les déclarations d'une règle). Une déclaration en CSS brut, jamais passée par `$$`, reçoit
// ligne 0, doc vide et variant vide — toujours légitime, juste sans provenance $$ à documenter.
function buildVarDeclarations(css: string, prefix: string, themeMeta: { name: string; variant: string; line: number; doc: string }[]): { name: string; value: string; variant: string; line: number; doc: string }[] {
  const queues = new Map<string, { variant: string; line: number; doc: string }[]>()
  for (const meta of themeMeta) {
    const q = queues.get(meta.name) ?? []
    q.push({ variant: meta.variant, line: meta.line, doc: meta.doc })
    queues.set(meta.name, q)
  }
  return scanDeclaredVars(css, prefix).map(({ name, value }) => {
    const q = queues.get(name)
    const { variant, line, doc } = q && q.length > 0 ? q.shift()! : { variant: '', line: 0, doc: '' }
    return { name, value, variant, line, doc }
  })
}

// isMuIdentifier / isAnimNode — sorties de la méthode
// extractAnimationsFromAst (où elles vivaient en closures locales) pour être
// PARTAGÉES avec la nouvelle extractDefinedAnimationsFromAst (anims
// µanim.create/crossfade). Fonctions pures (pas de `this`), même
// convention que dataEqualExceptBaseCss/computeScopedCss ci-dessus.
// Reconnaît `µ` ou `µ?.` (Identifier sur `µ`).
function isMuIdentifier(n: any): boolean {
  return n?.type === 'Identifier' && n.name === 'µ'
}

// Reconnaît `µ.anim` ou `window.µ.anim` (MemberExpression, optionnel ou pas).
function isAnimNode(n: any): boolean {
  if (!n || (n.type !== 'MemberExpression' && n.type !== 'ChainExpression')) return false
  const me = n.type === 'ChainExpression' ? n.expression : n
  if (me.type !== 'MemberExpression') return false
  if (me.property?.type !== 'Identifier' || me.property.name !== 'anim') return false
  if (isMuIdentifier(me.object)) return true
  // `window.µ.anim`
  if (me.object?.type === 'MemberExpression' &&
      me.object.object?.type === 'Identifier' && me.object.object.name === 'window' &&
      isMuIdentifier(me.object.property)) {
    return true
  }
  return false
}

// repère (placeholder) : chemin provisoire de LONGUEUR ÉGALE au chemin final, écrit
// tant que le cœur (ou une feuille split) n'est pas encore connu (phase A) — `writeHashed()`
// pose un hash md5 de 8 hex, `Z` n'en fait jamais partie : aucun vrai hash ne peut ressembler
// à un repère, la longueur égale préserve les cartes de source colonne par colonne (cf.
// `Bundler.placeholderPath()`).
const HASH_PLACEHOLDER = 'ZZZZZZZZ'

// variant de mise en page déposé À LA MAIN dans outputDir (`<module>.<nom>.css`) — seul
// signal de `collectUsedFeatures()` qui ne vienne pas d'une unité compilée par CE build (cf.
// bandeau de la méthode).
const REGEX_VARIANT_FILE = /^[^.]+\.[^.]+\.css$/

// modes de rendu qui ADOPTENT le DOM du serveur (mjs_hydrate.ts) — formes CANONIQUES, cf.
// `normalizeMode` (src/server/render-routes.ts) : `ssr` seul y devient `ssr:replace`, qui n'adopte
// rien (il jette la photo serveur et reconstruit la vue), comme `csr` et `prerender`.
const HYDRATING_MODES = new Set<string>(['ssr:markers', 'ssr:positional', 'ssr:diff'])

// unité en attente d'émission (phase A → phase C, cf. compile()). 'cold' : code
// fraîchement compilé (repères non résolus dans `code`), prêt à écrire dès que ses `deps`
// (stems) ont tous un chemin final. 'cached' : cache-hit CANDIDAT (contenu source inchangé
// depuis le tour précédent) — sa validité réelle ne se décide qu'en phase C, une fois le
// cœur/les feuilles split connus (cf. `CacheEntry.embeds`) ; si périmée, elle est recompilée
// au chemin froid et rejoint le pool 'cold'.
type PendingUnit =
  | { kind: 'cold'; file: string; stem: string; ext: string; code: string; map?: string; deps: string[]; features: string[]; cacheFields?: Omit<CacheEntry, 'hashedPath' | 'gen' | 'embeds' | 'features'> }
  | { kind: 'cached'; file: string; stem: string; cached: CacheEntry }

interface CacheEntry {
  hash: string
  /** Génération du compile() qui a écrit cette entrée (cf. `Bundler.compileGeneration`
   * et `cacheHitsThisCompile`) — distingue un cache-hit INTRA-compile (entrée posée PENDANT ce même
   * compile(), assets annexes déjà émis ce tour-ci, inoffensif) d'un hit INTER-compile (entrée d'un
   * compile() antérieur, assets annexes hors de `emittedThisCompile`). */
  gen: number
  // (champ `output` supprimé : jamais relu — il retenait en RAM le bundle
  // minifié de CHAQUE fichier pendant toute la vie d'un process watch.)
  hashedPath: string
  usedAnimations?: string[]
  definedAnimations?: string[]
  /** Jumeau CSS de usedAnimations (cf. TranspileDataLike.sharedCssNames) —
   * réinjecté dans `this.requestedSharedSheets` sur un cache-hit, sinon un
   * composant inchangé disparaîtrait de la validation au rebuild incrémental. */
  sharedCssNames?: string[]
  includedPartials?: string[]
  /** Modules `.civet` / `.coffee` importés via `@import name 'path'`. Tracked
   * pour que le watcher invalide les .mjs parents quand un module change. */
  importedModules?: string[]
  /** Variables de thème $$ (registre du build) — jumeau de sharedCssNames
   * ci-dessus : réinjectés dans `this.pendingVarData` sur un cache-hit, sinon
   * un composant inchangé disparaîtrait du registre au rebuild incrémental. */
  baseCss?: string
  layoutCss?: Record<string, string>
  themeVars?: { name: string; variant: string; line: number; doc: string }[]
  varsRead?: string[]
  /** Références de tags `<@nom>` du fichier — jumeau de sharedCssNames/themeVars
   * ci-dessus, même raison, mais la conséquence est plus grave : sans réinjection
   * dans `this.pendingTagRefs` sur un cache-hit, les MODULES CŒUR réclamés par un
   * composant inchangé ne sont plus recompilés au rebuild incrémental et
   * DISPARAISSENT de `µ.paths` (resolveTagShortcuts ne voit plus la demande) — leur
   * balise 404 en silence jusqu'au prochain redémarrage. Invisible en `mjs build`
   * (cache froid à chaque process), fatal en `mjs dev` (Bundler.watch() garde la
   * MÊME instance toute la session). */
  tagRefs?: { name: string; kind: TagRefKind; layoutLiteral?: string }[]
  /** Jumeau de tagRefs ci-dessus, même raison : dépendances directes de balises
   * (cf. collectDirectComponentDeps, generator/compile.ts) — sans réinjection dans
   * `this.pendingComponentDeps` sur un cache-hit, un composant inchangé disparaît de
   * la table de préchargement au rebuild incrémental (writeManifest, µ_DEPS). */
  componentDeps?: string[]
  /** chemins RÉELS embarqués par CE fichier à sa dernière émission (cœur + feuilles
   * split déclarées, triés) : un cache-hit n'est valide EN PHASE C que si cette liste est
   * ÉGALE à la liste courante (sinon périmé, recompilé au chemin froid, cf. compile()).
   * Remplace le sel de hash (cssSalt/coreHashedPath dans le hash lui-même, retiré). */
  embeds?: string[]
  /** signaux compilés (scanCompiledFeatures) de CE fichier, hydratés dans
   * `this.pendingFeatures` sur un cache-hit — jumeau de usedAnimations : sans réinjection, un
   * composant inchangé disparaîtrait de `collectUsedFeatures()` au rebuild incrémental. */
  features?: string[]
  /** symboles du CONTRAT appelés par CE fichier (collectCoreCalls, core-contract.ts), hydratés
   * dans `this.pendingCoreCalls` sur un cache-hit — jumeau exact de features ci-dessus. Sans
   * réinjection, un composant inchangé cesserait de réclamer ce qu'il appelle : la garde de
   * bundleRuntime() ne verrait plus son besoin, et laisserait passer le cœur amputé qui le tue. */
  coreCalls?: string[]
  /** mode 'bundle' SEULEMENT (jamais rempli en mode 'split', où l'unité vit sur disque et
   * `hashedPath` suffit à la relire) : code JS minifié final de CE fichier (repères déjà
   * résolus en spécificateurs virtuels 'mjs:...') et sa carte de source, gardés en RAM —
   * aucune unité n'étant écrite sur disque en mode bundle, un cache-hit ne peut rien relire
   * du filesystem. `embeds` reste `[]` pour ces entrées (cf. emitSingleFile()) : la validité
   * d'un cache-hit ne dépend plus du cœur/des styles, seulement de `hash` (contenu+deps). */
  code?: string
  map?: string
  /** noms courts que CE fichier peut porter par nom sur une instance (cf. collectInstanceNames,
   * minify.ts), relevés à sa dernière compilation froide — réinjectés dans la réservation du tour
   * sur un cache-hit, jumeau de usedAnimations. Vide hors minification. */
  reservedNames?: string[]
  /** génération du cache de raccourcissement (`Bundler.mangleGeneration`) au moment où CE code a
   * été minifié : un cache-hit n'est confirmé en phase C que si elle est encore la génération
   * courante — sinon une correspondance qu'il utilise a été retirée entre-temps, il est
   * recompilé au chemin froid comme une entrée périmée. */
  mangleGen?: number
}

// Civet préserve les assignations top-level bares (`foo = 1`) telles quelles.
// En module ESM (strict mode), c'est illégal — CoffeeScript en mode `bare`
// les déclare automatiquement avec `var`. On reproduit ce comportement.
//
// Heuristique : repère les lignes `^<indent?>IDENT = ...` au top-level du
// fichier (pas dans une fonction), où IDENT n'est pas déjà précédé d'un
// `var`/`let`/`const`/`export`/`function`/etc. Préfixe `var ` au premier
// usage de chaque identifier ; les ré-assignations restent intactes.
//
// Exportée (pas seulement pour usage interne) pour permettre un test direct
// de cette fonction pure sans dépendre du compilateur Civet réel — cf. son
// test de régression pour le pourquoi (reproduire empiriquement, via du VRAI
// code Civet, le scénario précis ci-dessous s'est avéré peu fiable : le
// compilateur Civet infère très bien la portée dans la plupart des cas
// simples, le bug ne se manifeste que sur un agencement précis de son
// SORTIE déjà compilée).
export function autoDeclareTopLevelBareAssignments(js: string): string {
  const lines = js.split('\n')
  const declared = new Set<string>()
  // Patterns prouvant qu'un identifiant a déjà une déclaration côté Civet :
  // `var x`, `let x`, `const x`, `export var x`, `export let x`, `export const x`,
  // `export function x`, `function x()`, `for (let|var|const x ...`, etc.
  const declRe = /\b(?:var|let|const|function)\s+([a-zA-Z_$µ][\w$]*)/g
  // ce scan portait sur TOUTES les
  // lignes, y compris celles INDENTÉES (corps de fonction/bloc). Une
  // déclaration LOCALE à une fonction imbriquée (`let count = 5` dans
  // `tick`) peuplait `declared` au même titre qu'une déclaration RÉELLEMENT
  // top-level — si le fichier contient PAR AILLEURS une assignation bare
  // top-level HOMONYME (`count = 0` en tête de fichier, sur une ligne que
  // Civet a laissée sans déclaration), `declared.has('count')` répondait à
  // tort `true` : aucun `var` n'était préfixé, l'assignation top-level
  // restait bare → `ReferenceError: count is not defined` en strict mode
  // ESM au chargement, alors que le build ne signalait RIEN (silencieux,
  // vert). Fix : n'alimente `declared` qu'à partir des lignes NON indentées
  // — même heuristique que celle déjà utilisée juste en dessous pour repérer
  // les assignations bare elles-mêmes ; une déclaration DANS une fonction ne
  // peut de toute façon jamais satisfaire le besoin d'un `var` top-level
  // (portées distinctes).
  for (const line of lines) {
    if (/^\s/.test(line)) continue
    let m: RegExpExecArray | null
    while ((m = declRe.exec(line)) !== null) declared.add(m[1])
  }
  // Heuristique simple : on ne préfixe que les lignes top-level (indentation 0).
  // Une ligne `IDENT = expr` (sans var/let/const/return/throw/await/etc devant)
  // est une assignation bare → ajout de `var `.
  const bareAssignRe = /^([a-zA-Z_$µ][\w$]*)\s*=(?!=|>)/
  return lines.map(line => {
    // Ignore les lignes indentées (intérieur de fonction/bloc) : elles ne
    // posent pas le problème ESM strict (la fonction englobante crée son
    // scope ; bare assignment dedans est `implicit global` mais ne crashe
    // pas tant que le module ne tourne pas en strict — en pratique, Civet
    // émet des `var` automatiquement à l'intérieur des fonctions).
    if (/^\s/.test(line)) return line
    const m = line.match(bareAssignRe)
    if (!m) return line
    const ident = m[1]
    if (declared.has(ident)) return line
    declared.add(ident)
    return 'var ' + line
  }).join('\n')
}

// Extraction des directives `@import` :
// 2 défauts liés, mêmes 2 sites d'appel (preResolveAssets + suivi des
// dépendances .civet/.coffee dans _compileMjsInner), donc factorisés ici en
// UN SEUL endroit pour ne fixer/maintenir qu'une fois.
//
//   1. Même classe de bug qu'un correctif précédent (`preprocessHtml` du
//      transpiler, `@preload`/`@noUJS`) : la regex opère sur le CONTENU
//      BRUT du fichier, sans masquer les blocs `<pre>`/`<code>` — une
//      leçon/doc de tuto qui AFFICHE `@import foo 'bar.civet'` comme
//      EXEMPLE DE CODE (pas une vraie directive) se faisait quand même
//      extraire et tenter de résoudre comme un import réel.
//   2. La classe de caractères de l'identifiant contenait `\s` (PAS `[ \t]`)
//      — `\s` matche AUSSI le saut de ligne. Combiné à la quantification
//      paresseuse (`+?`) et au flag `m` (où `^`/`$` matchent à CHAQUE
//      frontière de ligne, pas seulement début/fin de fichier), un
//      `@import` mal formé (guillemet fermant manquant sur sa ligne) pouvait
//      voir son « nom d'identifiant » enjamber le saut de ligne et continuer
//      la recherche du guillemet fermant sur une ligne ULTÉRIEURE totalement
//      sans rapport, extrayant un chemin fantaisiste.
//
// Fix : (a) masque `<pre>`/`<code>` (mêmes octets non-`@`/non-guillemets,
// mais NEWLINES préservés — la fonction ne fait qu'extraire des paths, pas
// de restauration nécessaire, mais préserver les sauts de ligne reste plus
// sûr si une future logique s'appuyait sur les numéros de ligne) ; (b) `\s`
// → `[ \t]` dans la classe de caractères — un `@import` ne peut plus jamais
// s'étendre au-delà de SA PROPRE ligne, quelle que soit sa forme.
const IMPORT_DIRECTIVE_RE =
  /^[ \t]*@import[ \t]+(?:default[ \t]+)?[a-zA-Z0-9_$, \tµ§]+?[ \t]+['"](.+?)['"][ \t]*$/gm

// µimport('chemin.js')/mjsimport('chemin.js') LITTÉRAL, forme NUE (appel
// direct, sans passer par un `@import name 'chemin'` nommé) : regex SŒUR de
// IMPORT_CALL_RE (preResolveAssets), extraite ICI en constante de module pour être
// réutilisée par `collectTransitiveImportClosure` — sinon un module .civet/.coffee
// @import-é qui appelle lui-même µimport() sur un asset voit ce dernier absent de la
// fermeture transitive (hash + reverse-map watch), staleness silencieuse en mjs dev.
const MU_IMPORT_CALL_RE = new RegExp(`${MU_IMPORT_BODY}\\s*\\(\\s*['"]([^'"]+)['"]\\s*\\)`, 'g')

// µimport 'chemin.js' / mjsimport 'chemin.js' LITTÉRAL, forme NUE SANS
// PARENTHÈSES (appel Civet/CoffeeScript sans parenthèses, légal côté compilation,
// cf. sigils.ts) : invisible à MU_IMPORT_CALL_RE ci-dessus, qui exige la
// parenthèse ouvrante — même staleness silencieuse que la forme avec parenthèses ci-dessus, côté forme nue.
// Garde de tête `(?<![\w.µ])` (cf. sigils.ts ~131) : évite un faux positif sur un
// identifiant plus long se terminant par le motif (ex. `xmjsimport 'a'`).
const MU_IMPORT_BARE_RE = new RegExp(`(?<![\\w.µ])${MU_IMPORT_BODY}[ \\t]+['"]([^'"]+)['"]`, 'g')

function maskCodeBlocks(html: string): string {
  const blank = (m: string) => m.replace(/[^\n]/g, ' ')
  return html
    .replace(/<pre\b[^>]*>[\s\S]*?<\/pre>/gi, blank)
    .replace(/<code\b[^>]*>[\s\S]*?<\/code>/gi, blank)
}

/** Extrait les paths cités par `@import name 'path'`, en ignorant ceux
 * affichés comme simple exemple de code dans un bloc `<pre>`/`<code>`.
 * Exportée pour un test direct (fonction pure, sans dépendance à `this`). */
export function extractImportMatches(content: string): RegExpMatchArray[] {
  return [...maskCodeBlocks(content).matchAll(IMPORT_DIRECTIVE_RE)]
}

// ----------------------------------------------------------------------------
// VIEW_TAG_RE/VIEW_CSS_ATTR_RE : reconnaît `css="a b"` / `css='a b'`
// LITTÉRAL sur un `<@view …>`, dans le contenu BRUT d'un composant (avant transpile).
// Même forme que le groupe css du preprocess (generator/compile.ts, `<@view name
// [css="..."]…> → <metamjs-view id="name" css="..."…>`) — dupliquée à dessein plutôt que
// partagée entre les deux fichiers (même raison que emitSplitStyles()/bundleSharedStyles()
// plus bas : ce contrat est figé, un refactor inter-fichiers ferait courir un risque de
// régression pour un gain de factorisation mineur).
//
// Sert le filet de sécurité du mode css='split' (cf. Bundler.viewRequestedSheets,
// finalizeSplitStyles) : une feuille réclamée par cette voie SEULEMENT (jamais par `@css`)
// doit rester chargée d'office, exactement comme le runtime la charge (mjs_element.ts,
// `_mjs_applyLayout`, héritage `<metamjs-view css="…">`).
// ----------------------------------------------------------------------------
const VIEW_TAG_RE = /<@view\s+[\w-]+((?:\s+(?:css|data-mjs-vt|data-mjs-vt-p)=["'][^"']*["'])*)\s*\/?>/gi
const VIEW_CSS_ATTR_RE = /\bcss=(["'])([^"']*)\1/i

/** Noms de feuilles nommés par un `css="a b"` LITTÉRAL d'un `<@view>`, dans le contenu brut
 * d'un composant — masque `<pre>`/`<code>` (même garde qu'extractImportMatches ci-dessus :
 * une leçon de tuto qui AFFICHE `<@view x css="y">` en exemple ne doit rien réclamer).
 *
 * LIMITES ASSUMÉES (cf. finalizeSplitStyles, pas résolues ici) :
 *   - un `css={expression}` calculé (jamais entre guillemets) est invisible ICI par
 *     construction — seule la forme littérale se voit au build. Ce cas garde le
 *     comportement runtime actuel (avertissement à l'exécution si la feuille manque,
 *     cf. mjs_element.ts « Orphelin CSS hérité »), jamais forcé eager.
 *   - un `<@view>` posé dans un `<@include>` (partial, pas le composant lui-même) est
 *     également invisible ICI : cette fonction ne voit que le fichier .mjs tel qu'écrit,
 *     AVANT résolution des partials (même contenu que `_compileMjsInner` reçoit de
 *     `readFileSync`) — cas jugé marginal (`<@view>` cible un point de montage propre à
 *     UN composant, rarement partagé via partial).
 *
 * Exportée pour un test direct (fonction pure, sans dépendance à `this`), même esprit
 * qu'extractImportMatches. */
export function extractViewCssNames(content: string): string[] {
  const names: string[] = []
  for (const tagMatch of maskCodeBlocks(content).matchAll(VIEW_TAG_RE)) {
    const cssMatch = VIEW_CSS_ATTR_RE.exec(tagMatch[1])
    if (cssMatch) names.push(...cssMatch[2].split(/\s+/).filter(Boolean))
  }
  return names
}

// ----------------------------------------------------------------------------
// ASSET_RE — reconnaît `µasset(...)` / `µ.asset(...)` / `mjsasset(...)` /
// `mjs.asset(...)` dans un texte déjà compilé (composant, module, mjs_core).
// Utilisée par `resolveMagicAssets` (méthode d'instance, cf. plus bas) ;
// exportée à plat (constante pure, aucune dépendance à `this`) pour un test
// direct — verrou µasset-dans-<@head> (cf. son test dédié).
//
// `buildHeadInjection`
// (transpiler/macros.ts) émet le contenu d'un <@head> en chaîne Civet
// SIMPLE-QUOTE avec échappement `\'` : un `<@head><style>@font-face {
// src: url(µasset('fonts/x.woff2')) }</style></@head>` compile donc en
// `µasset(\'fonts/x.woff2\')` (guillemets ÉCHAPPÉS), pas `µasset('…')`.
// Une version antérieure de cette regex exigeait un guillemet NU juste après
// `(`/avant `)` — le `\` intercalé faisait échouer tout le match : substitution
// ratée SILENCIEUSEMENT, l'appel `µasset(...)` littéral partait tel quel dans
// le fichier écrit, la police jamais chargée.
// Fix : tolère un backslash optionnel de chaque côté du guillemet interne —
// CAPTURÉ (groupes 2 et 3, pas juste consommé) pour être RÉINJECTÉ à
// l'identique côté remplacement (sinon le remplacement, ignorant l'échappement
// d'origine, referme PRÉMATURÉMENT la chaîne Civet/JS ENGLOBANTE sur le
// premier guillemet nu injecté — cf. le replacer de `resolveMagicAssets`).
// Backreference `\2\3` en fermeture (même présence de backslash + même
// guillemet) : apparie symétriquement ouverture/fermeture, le groupe
// paresseux `(.+?)` s'arrête pile au bon endroit (un chemin d'asset ne
// contient lui-même ni guillemet ni backslash). Groupe 1 (guillemet
// EXTÉRIEUR, cf. `"µasset('…')"` généré par la directive @import) inchangé.
// ----------------------------------------------------------------------------
export const ASSET_RE = /(['"]?)(?:µasset|µ\.asset|mjsasset|mjs\.asset)\((\\?)(['"])(.+?)\2\3\)\1/g
/** `µimage('chemin')` ou `µimage('chemin', 480, 960)` : chemin littéral, largeurs entières facultatives. */
export const IMAGE_CALL_RE = /(?:µimage|µ\.image|mjsimage|mjs\.image)\s*\(\s*['"]([^'"]+)['"]((?:\s*,\s*\d+)*)\s*\)/g
/** pruneOrphans() — la famille des noms que LE BUNDLER LUI-MÊME
 * émet : `<base>-<empreinte8>.<ext>` et son `.map` (writeHashed, copies brutes), ou une variante
 * d'image `<base>-<largeur>-<empreinte8>.<format>` (image.ts, variantName). Un nom STABLE
 * (bundle.js, mjs-precache.json, card.wide.css…) ne la matche jamais. */
const HASHED_OUTPUT_RE = /-[a-f0-9]{8}\.[a-z0-9]+(?:\.map)?$/

/** pruneOrphans() — les assets que le RENDU SERVEUR écrit lui-même dans le dossier de sortie
 * (`writeHashedAsset`, server/ssr-head.ts) : feuille scopée d'un composant sous le mode strict
 * `csp` (`mjs_ssr_style…`), feuille de `<@head>` (`mjs_ssr_head…`), module de la visionneuse
 * (`mjs_viewer_…`). Ils portent la même forme de nom hachée que les sorties du bundler mais ne
 * sortent d'AUCUN `compile()` — un `mjs build` les prendrait donc pour des orphelins et les
 * retirerait juste après que le prérendu les a écrits, laissant les `<link>` des fragments pointer
 * dans le vide. Protégés PAR LEUR NOM, comme le manifeste.
 *
 * Trois familles NOMMÉES, jamais un préfixe large : `mjs_style_…` est le stem des unités que CE
 * bundler émet pour les feuilles PARTAGÉES (`css: 'split'` → un `.js` par feuille, `css: 'lazy'` →
 * un `.css`). L'exempter aurait rendu ces unités-là impurgeables — une feuille retirée du projet
 * laissant son fichier compilé à vie. D'où la famille propre au rendu, `mjs_ssr_style…` : aucune
 * sortie du bundler ne commence par `mjs_ssr`. */
// `mjs_ssr_head` est un nom FIXE (server/ssr-head.ts) — ancré au tiret du suffixe haché
// (`mjs_ssr_head-<empreinte8>.ext`) depuis le 23/09/2026 : un asset PROJET nommé par ex.
// `mjs_ssr_headline-<empreinte8>.png` matchait à tort le préfixe non ancré (trouvé en revue),
// impurgeable pour toujours même orphelin réel. `mjs_ssr_style_`/`mjs_viewer_` gardent, eux, un
// suffixe LIBRE (nom de composant/module choisi par le projet) : un ancrage au tiret ne
// fermerait rien pour eux (le nom réel a lui aussi un tiret avant son empreinte) — la même
// collision résiduelle existe pour ces deux familles, non fermée, faute d'un marqueur qui les
// distinguerait d'un nom de projet coïncidant.
const SERVER_WRITTEN_RE = /^mjs_(?:ssr_style|viewer_)|^mjs_ssr_head-/

// --------------------------------------------------------------------------
// deriveUrlPrefix : convertit un outputDir système en path URL public.
//
// Convention : la majorité des hébergements servent leur doc-root depuis un
// dossier `public/` (Rails, Express, Vite, plain nginx avec root=public/...).
// Donc :
//   outputDir='public/modularjs'   → urlPrefix='/modularjs'
//   outputDir='public/assets/X'    → urlPrefix='/assets/X'
//   outputDir='dist'               → urlPrefix='/dist' (avec warning implicite)
//
// Override possible via `BundlerOpts.urlPrefix` quand la convention ne tient
// pas (ex : path mounted ailleurs, basePath custom).
//
// EXPORTÉE : le rendu serveur compile dans un dossier de travail À LUI quand le projet émet un
// fichier unique (cf. server/render-compile-dir.ts) et doit alors imposer au Bundler interne le
// préfixe public du VRAI build — mêmes URLs d'assets dans le HTML rendu que celles que sert le
// back. Une seconde copie de cette convention dériverait de celle-ci sans prévenir.
// --------------------------------------------------------------------------
export function deriveUrlPrefix(outputDirRel: string): string {
  // Normalise les séparateurs et retire le slash final
  const normalized = outputDirRel.replace(/\\/g, '/').replace(/\/$/, '')
  // Convention 1 : si le path contient `/public/`, prendre ce qui suit.
  // Couvre les paths absolus `/var/www/myapp/public/modularjs` → `/modularjs`.
  const publicIdx = normalized.lastIndexOf('/public/')
  if (publicIdx >= 0) {
    return normalized.slice(publicIdx + '/public'.length)
  }
  // Convention 2 : path absolu sans `public/` (typique des tmpdir de tests,
  // hébergement custom) → prendre le basename seulement.
  if (normalized.startsWith('/')) {
    return '/' + basename(normalized)
  }
  // Convention 3 : path relatif. Strip `public/` du début s'il y est.
  const stripped = normalized.replace(/^public\//, '')
  return '/' + stripped
}

// --------------------------------------------------------------------------
// convention `.page.mjs` — même principe que
// `.theme.mjs` (cf. bundler/themes.ts, isThemeFile/themeNameOf) : le marqueur est un
// SUFFIXE du nom de fichier, retiré AVANT toute dérivation d'identité (tag, classe,
// alias court, clé de manifeste, sortie hachée). Un `.page.mjs` reste un composant
// ORDINAIRE par ailleurs (pas de liste à part comme les thèmes) — seule sa capacité à
// porter un bloc <routes>/une directive @routes/une balise <@view> en dépend, cf. la
// garde TranspileOpts.isPageModule (transpiler/index.ts).
// `isPageFile` sert cette garde ; `pageAwareBaseName` centralise le retrait du
// marqueur pour CE fichier (grep `basename(` : shortModuleName, registerLayoutNames,
// _compileMjsInner ×2, recoverFailedComponentManifest, la boucle de collision du
// manifeste, compileSingle) — un fichier sans le marqueur traverse inchangé.
// --------------------------------------------------------------------------
export function isPageFile(filePath: string): boolean {
  return basename(filePath, '.mjs').endsWith('.page')
}

// Pour PROPOSER un nom de
// fichier, jamais pour DÉCIDER si un fichier en est un (cf. isPageFile, strictement sensible à la
// casse et à un seul marqueur, INCHANGÉ) : replie tout suffixe `.page` traînant, n'importe quelle
// casse, un ou plusieurs à la suite (`x.PAGE` → `x`, `x.page.PAGE` → `x`). Sert la suggestion de
// renommage ICI (marqueur en double) et dans transpiler/index.ts (marqueur manquant/mal casé) —
// dupliqué à l'identique là-bas plutôt qu'importé : bundler/index.ts importe déjà transpiler/
// index.ts (transpile()), un import dans l'autre sens bouclerait le cycle.
function canonicalPageBaseName(name: string): string {
  let base = name
  while (/\.page$/i.test(base)) base = base.replace(/\.page$/i, '')
  return base
}

// Même contrainte que .theme.mjs (THEME_FILE_NAME_RE, bundler/themes.ts) :
// un nom de composant hors kebab-case compile aujourd'hui SANS UN MOT (majuscule : clé de
// manifeste en casse d'origine, autoloader toujours en minuscules → composant injoignable à vie ;
// espace/caractère invalide : customElements.define() lève seulement au CHARGEMENT). Aligné sur
// docs/02-composant.md (lettres minuscules/chiffres/tirets).
const COMPONENT_FILE_NAME_RE = /^[a-z][a-z0-9-]*$/

// suggestKebabCase() : 'MonComp' → 'mon-comp', 'mon comp' → 'mon-comp', 'café' → 'cafe' — sert
// UNIQUEMENT à proposer un nom dans le message d'erreur, jamais à corriger en silence.
function suggestKebabCase(name: string): string {
  return name
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')  // café -> cafe
    .replace(/([a-z0-9])([A-Z])/g, '$1-$2')             // MonComp -> Mon-Comp
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')                        // espaces/points/etc -> tiret
    .replace(/^-+|-+$/g, '')                            // tirets de bord retirés
}

function pageAwareBaseName(filePath: string): string {
  const base = basename(filePath, '.mjs').replace(/\.page$/, '')
  if (isPageFile(filePath)) {
    // Un fichier nommé JUSTE `.page.mjs`
    // (rien avant le marqueur) rendait une chaîne VIDE : `customElements.define("mjs-", …)` et une
    // clé de manifeste vide, sans un mot. Même garde que `bundler.theme-nom-fichier`
    // (bundler/themes.ts) pour `.theme.mjs` seul : refusé par une erreur de build qui nomme le
    // fichier, plutôt qu'un silence. Le `isPageFile(filePath)` ci-dessus (pas `base === ''` tout
    // court) borne la garde aux SEULS fichiers reconnus `.page.mjs` — un composant ordinaire, jamais
    // concerné par ce marqueur, garde son comportement inchangé quel que soit son nom.
    if (base === '') throw new Error(t('bundler.page-nom-fichier-vide', { fichier: basename(filePath) }))
    // Marqueur en DOUBLE (`x.page.page.mjs`, voire mélangé `x.PAGE.page.mjs`) :
    // un seul `.page` est retiré ci-dessus (le marqueur ACTUEL, sensible à la casse, cf. isPageFile) ;
    // si le reste finit ENCORE par `.page` (n'importe quelle casse), c'est un second marqueur oublié,
    // pas un nom voulu. DÉCISION : refusé plutôt que de retirer tous les marqueurs en boucle — un
    // point résiduel dans `base` n'est JAMAIS un nom de fichier légitime (kebab-case obligatoire,
    // docs/02-composant.md : lettres minuscules/chiffres/tirets, jamais de point), exactement la
    // même raison qui fait déjà échouer ce cas côté thèmes (THEME_FILE_NAME_RE, bundler/themes.ts,
    // n'accepte aucun point). Un retrait silencieux en boucle ferait en outre courir DEUX fichiers
    // distincts (`x.page.mjs` et `x.page.page.mjs`) vers la MÊME clé de manifeste 'x' sans que
    // l'auteur l'ait demandé — un doublon de plus à détecter, pas un problème en moins.
    if (/\.page$/i.test(base)) throw new Error(t('bundler.page-marqueur-double', { fichier: basename(filePath), reste: base, suggestion: `${canonicalPageBaseName(base)}.page.mjs` }))
  }
  // Un marqueur `.page` résiduel MINUSCULE reste du ressort de la garde ci-dessus
  // (isPageFile, même casse exacte) / du transpiler (opts.isPageModule) : jamais doublement
  // refusé ici, sous peine d'un message générique à la place du message précis (suggestion
  // x.page.mjs, cf. transpiler/index.ts:3957). Un PARTIAL (préfixe `_`, jamais un composant :
  // exclu du scan top-level par convention, cf. `mjsFiles`) n'est pas non plus concerné — atteint
  // SEULEMENT via µasset()/@import, jamais par un tag <mjs-…> à trouver (régression débusquée par
  // bundler-compile-dedup-cycle.test.ts : `_helper.mjs` cyclique).
  // L'exemption ci-dessous DOIT rester à la MÊME casse qu'isPageFile
  // (`.page` minuscule) : avec `/i`, un marqueur mal casé (`Truc.PAGE.mjs`) échappait aux DEUX
  // gardes (isPageFile refusait la casse, celle-ci l'exemptait quand même) — 0 erreur, clé de
  // manifeste 'Truc.PAGE' publiée, introuvable par l'autoloader (toujours en minuscules).
  if (!/\.page$/.test(base) && !base.startsWith('_') && !COMPONENT_FILE_NAME_RE.test(base)) {
    // le marqueur .page (reconnu ci-dessus, ou résiduel mal casé) est RÉINTÉGRÉ à la suggestion —
    // sinon elle proposait 'truc.mjs' pour 'Truc.page.mjs' et faisait perdre la capacité
    // <routes>/@routes du fichier d'origine (bogue annexe, même cause).
    const cleanBase = canonicalPageBaseName(base)
    const hadMarker = isPageFile(filePath) || cleanBase !== base
    throw new Error(t('bundler.composant-nom-fichier', { nom: base, fichier: basename(filePath), suggestion: `${suggestKebabCase(cleanBase)}${hadMarker ? '.page' : ''}.mjs` }))
  }
  return base
}

// assertSafeSvg() teste des motifs LITTÉRAUX
// (<script>/on*=/javascript:) : une entité HTML (`&#106;` = 'j') reconstitue `javascript:` sans
// jamais écrire le mot en clair. Décode AVANT de tester — décimal, hexadécimal, une poignée de
// nommées usuelles (assez pour reconstituer un schéma d'URL/nom d'attribut). UNE seule passe (pas
// de décodage récursif/imbriqué — hors périmètre de ce correctif).
const SVG_NAMED_ENTITIES: Record<string, string> = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: '\'',
  colon: ':', sol: '/', semi: ';', comma: ',', lpar: '(', rpar: ')', Tab: '\t', NewLine: '\n',
}
function decodeSvgEntities(s: string): string {
  return s
    .replace(/&#x([0-9a-f]+);/gi, (_m, hex: string) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m: string, name: string) => SVG_NAMED_ENTITIES[name] ?? m)
}

export class Bundler {
  /** registre des variables de thème — racine du projet, capturée UNE FOIS à la construction (le
   * dossier de `mjs.config.json` en usage CLI normal : `--root` fait un `process.chdir` AVANT
   * cette construction, cf. cli.ts) : sert à PUBLIER des chemins relatifs dans `.mjs-theme-vars.json`,
   * jamais l'arborescence absolue de la machine de build. */
  private root: string
  sourceDir: string
  runtimeDir: string
  /** Catalogue de modules cœur (`<@mjs-nom>`), cf. BundlerOpts.coreModulesDir. */
  coreModulesDir: string
  outputDir: string
  manifestPath: string
  manifestExternal: string
  stylesheetsDir: string
  varPrefix: string
  defaultTheme: string
  /** CSS agrégé des fichiers `*.theme.mjs` — écrit dans le manifeste, adopté au boot. */
  themeCss: string
  /** Noms des thèmes déclarés — la rune `µtheme` n'accepte qu'eux (plus light/dark). */
  themeNames: string[]
  urlPrefix: string
  preload: PreloadConfig | undefined
  viewTransition: VtValue | undefined
  /** Clé `logLevel` brute (mjs.config.json) — résolue par environnement via
   *  `currentLogLevel()`/`prodLogLevel()`, jamais lue directement ailleurs. */
  logLevel: LogLevelConfig | undefined
  i18n: I18nConfig | undefined
  /** Bloc `render` du projet (cf. BundlerOpts.render) — lu SEULEMENT par `resolveRuntimeFiles`,
   *  pour les modes d'hydratation. */
  render: RenderConfig | undefined
  /** Bloc `µ._i18nData` calculé par `scanI18n()` (appelé dans `compile()`,
   *  AVANT `writeManifest()`) — `undefined` si `sourceDir/i18n/` est absent
   *  (aucune clé i18n émise dans le manifeste, zéro octet pour les apps sans i18n). */
  i18nManifestData: I18nManifestData | undefined
  /** Cache du parseur YAML chargé paresseusement (paquet `yaml`, optionnel —
   *  cf. peerDependencies) — tenté une SEULE fois, au premier fichier
   *  `.yml`/`.yaml` rencontré. Un projet 100% `.json` ne le charge jamais. */
  private _yamlParser: ((raw: string) => any) | undefined
  defaultScriptLang: BundlerOpts['defaultScriptLang']
  templateLang: BundlerOpts['templateLang']
  sigil: BundlerOpts['sigil']
  contextAlias: BundlerOpts['contextAlias']
  csp: boolean
  sourceMapMode: NonNullable<BundlerOpts['sourceMap']>
  maxStateVars: BundlerOpts['maxStateVars']
  a11y: BundlerOpts['a11y']
  keepFailedComponents: boolean
  /** Environnement RÉSOLU du build — cf. isProd() */
  envMode: NonNullable<BundlerOpts['env']>
  /** Politique de minification RÉSOLUE — cf. shouldMinify() */
  minifyMode: NonNullable<BundlerOpts['minify']>
  minimalRuntime: boolean
  runtime: RuntimeConfig | undefined
  /** Mode d'émission des styles partagés (cf. BundlerOpts.css). `'bundle'` (défaut) =
   *  comportement historique, jamais retouché ci-dessous. `'split'`/`'lazy'` : cf.
   *  emitSplitStyles()/finalizeSplitStyles() et le garde-fou dans compile(). */
  cssMode: CssConfig
  /** Mode d'émission JS (cf. BundlerOpts.js). `'split'` (défaut) : comportement historique,
   *  intact plus bas (writeManifest()/emitPendingUnits(), jamais retouchés). `'bundle'` :
   *  cf. emitSingleFile() — remplace ces deux méthodes en phase C de compile(). */
  jsMode: JsConfig
  /** Mode split — chemin haché PAR feuille partagée nommée (hors mjs_root), connu
   *  AVANT la compilation des composants (cf. emitSplitStyles(), step précédent —
   *  même principe que coreHashedPath pour mjs_core) : c'est ce qui permet à
   *  _compileMjsInner d'injecter `import '<chemin>';` en tête du JS d'un module
   *  PENDANT sa propre compilation. Jamais lu hors mode split. */
  splitStyleHashedPaths: Record<string, string> = {}
  /** Mode split — chemin haché de mjs_root (adopté sur le document, jamais déclaré
   *  par un module) : toujours eager, importé par le manifeste. */
  splitRootHashedPath: string | undefined
  /** Mode split — chemins hachés des feuilles forcées eager, POUR DEUX RAISONS distinctes
   *  (cf. finalizeSplitStyles()) : (1) qu'AUCUN module ne déclare (`@css`) — le filet
   *  historique ; (2) qu'un `<@view css="nom">` LITTÉRAL réclame quelque part,
   *  MÊME si un module la déclare déjà ailleurs — une page qui charge la vue sans charger ce
   *  module en hériterait sinon vide (cf. runtime/mjs_element.ts, `_mjs_applyLayout`). Restent
   *  importées par le manifeste, comme en mode bundle. Calculé par finalizeSplitStyles(), APRÈS
   *  les composants (le seul point où `requestedSharedSheets`/`viewRequestedSheets` sont complets). */
  splitEagerHashedPaths: string[] = []
  /** nom de feuille partagée → URL publique de son `.css` haché (mode
   *  'lazy' SEULEMENT ; vide partout ailleurs). Écrite au manifeste sous `µ._cssLazy` :
   *  le runtime y résout un nom au montage du premier composant qui le déclare, va
   *  chercher le fichier une fois, et le garde en cache par URL. */
  lazyStyleUrls: Record<string, string> = {}
  /** politique de traitement des images (clé `image` de mjs.config.json), défauts résolus ICI. */
  imageConfig: { widths: number[]; formats: string[]; quality: number }
  /** L'avertissement « sharp absent » ne se dit qu'UNE fois par build, pas une fois par image. */
  private sharpWarned = false
  dedupWaitTimeoutMs: number
  /** Seuil de bascule vers la transpilation en direct (cf. INLINE_LIMIT). */
  private inlineTranspileLimit: number
  /** Le compte de fichiers de CE compile tient-il sous le seuil ? Décidé à chaque
   *  `compile()` (phase A), watch compris : un projet qui grandit au-delà du seuil
   *  repasse aux threads au tour suivant. */
  private inlineTranspile = false
  cache: Map<string, CacheEntry>
  manifest: Record<string, string>
  /** Pour chaque clé du manifest, le chemin du source qui l'a écrite. Sert à
   * détecter les collisions de basename (deux .mjs au même nom). */
  manifestSources: Map<string, string> = new Map()
  // Kind par clé de manifest ('basename' autoritaire /
  // 'shortName' alias de confort / 'poisoned' alias court ambigu retiré).
  // Compagnon de manifestSources : distingue une VRAIE collision (basename vs
  // basename → warning) d'un simple recouvrement d'alias court (silencieux, sûr).
  manifestKinds: Map<string, 'basename' | 'shortName' | 'poisoned'> = new Map()
  /** Composants qui se disputent un alias court EMPOISONNÉ (clé → basenames, ordre de
   * compilation, sans doublon). La clé n'est publiée par personne et la balise courte n'est
   * jamais enregistrée : un gabarit qui l'écrit quand même doit s'entendre dire QUI se la
   * dispute (cf. resolveTagShortcuts, kind 'litteral-dev'). Réinitialisé à chaque compile(). */
  poisonedAliasSources: Map<string, string[]> = new Map()
  /** 2e <script>/<style>
   * silencieusement jeté (composant OU partial inclus). `_compileMjsInner`
   * n'a pas accès direct à `stats.warnings` (retourne juste le hashedPath,
   * consommé via parallelMap) — accumulé ici, fusionné dans `stats.warnings`
   * en fin de `compile()`. Réinitialisé à chaque compile() (comme manifest). */
  pendingSectionWarnings: string[] = []
  /** Références de balises accumulées PAR FICHIER pendant le
   * parallelMap de compile() (dev ET modules cœur, ces derniers compilés
   * après coup par resolveTagShortcuts) — consommées puis remises à zéro par
   * resolveTagShortcuts() à chaque compile(). */
  pendingTagRefs: { file: string; name: string; kind: TagRefKind; layoutLiteral?: string }[] = []
  /** Dépendances DIRECTES brutes accumulées PAR COMPOSANT (balises du gabarit +
   * modules `@import`-és), jumeau de pendingTagRefs ci-dessus — consommée par
   * buildManifestDeps() APRÈS resolveTagShortcuts() (seul point où l'union des
   * composants ET des modules cœur transitifs est connue), remise à zéro à
   * chaque compile(). Noms bruts, PAS encore résolus contre le manifeste. */
  pendingComponentDeps: { moduleName: string; deps: string[] }[] = []
  /** Table des dépendances DIRECTES du manifeste (clé de manifest → clés de
   * manifest dont elle dépend), écrite par buildManifestDeps() en fin de
   * compile() — consommée par writeManifest() (µ_DEPS, préchargement). */
  manifestDeps: Record<string, string[]> = {}
  /** Variants de style — nom de module (basename ET alias court, même clé que manifestNames
   * plus bas) → noms de variants `<style name="…">` connus, alimentée par les DEUX
   * chemins de _compileMjsInner (froid ET cache-hit, même hygiène que pendingVarData
   * ci-dessous) — un module SANS variant n'y figure pas (repli historique du fichier CSS
   * déposé à la main). Consommée par resolveTagShortcuts() pour le croisement `layout="x"`
   * littéral, remise à zéro à chaque compile(), à l'image de pendingTagRefs. */
  private pendingLayoutNames: Map<string, Set<string>> = new Map()
  /** Registre des variables de thème — variables $$ par composant (fresh ET cache-hit,
   * même hygiène que pendingTagRefs ci-dessus), consommés par computeVarRegistry() en fin
   * de compile(). Réinitialisé à chaque compile(). */
  private pendingVarData: { file: string; moduleName: string; baseCss: string; layoutCss: Record<string, string>; themeVars: { name: string; variant: string; line: number; doc: string }[]; varsRead: string[] }[] = []
  /** Variables de thème $$ des fichiers `*.theme.mjs` — recalculé À CHAQUE compile()
   * par compileThemeFiles() (pas de cache : ces fichiers sont peu nombreux et minuscules). */
  private themeVarData: { file: string; name: string; css: string; vars: { name: string; variant: string; line: number; doc: string }[]; read: string[] }[] = []
  /** Variables de thème $$ déclarées par le RUNTIME lui-même (`--mjs-surface:`, etc.) —
   * recalculé à chaque bundleRuntime() : rend `$$surface`/`$$fg`/… légitimes sans qu'aucun
   * thème projet n'ait besoin de les redéclarer. */
  private frameworkVarData: { file: string; line: number; name: string; value: string; doc: string }[] = []
  coreHashedPath: string
  /** unités compilées en mémoire en phase A (composant .mjs, module .civet/.coffee,
   * manifeste externe), en attente d'émission topologique en phase C (une fois le cœur
   * connu). Clé = stem (nom de module/basename/'mjs_external'). Remis à zéro à chaque
   * compile() — jamais lu pendant la phase A elle-même (cf. compile()). */
  private pendingUnits: Map<string, PendingUnit> = new Map()
  /** mode 'bundle' seulement : nom virtuel ('mjs_core', 'mjs_styles', 'mjs_anims', un stem
   * d'unité, 'mjs_setup', 'mjs_entry') → code JS déjà résolu (repères remplacés par des
   * spécificateurs 'mjs:...', jamais un chemin réel) — consommé par le plugin esbuild
   * d'emitSingleFile() (onLoad, jamais le disque). Remis à zéro à chaque compile(), au même
   * rythme que pendingUnits ; jamais peuplé en mode 'split'. */
  private bundleVirtualSources: Map<string, string> = new Map()
  /** union des signaux compilés (scanCompiledFeatures) de toutes les unités de CE
   * tour, fraîches ET cache-hit (jumeau de usedAnimations) — alimente collectUsedFeatures().
   * Remis à zéro à chaque compile(). */
  private pendingFeatures: Set<string> = new Set()
  /** union des symboles du CONTRAT (collectCoreCalls, core-contract.ts) appelés par toutes les
   * unités de CE tour, fraîches ET cache-hit — jumeau EXACT de pendingFeatures ci-dessus, même
   * rythme de remise à zéro, mêmes points d'alimentation. Consommé par bundleRuntime(), qui
   * REFUSE de finir un cœur auquel il manque un de ces symboles (cf. son bandeau). */
  private pendingCoreCalls: Set<string> = new Set()
  /** Minifications DIFFÉRÉES : `compileMjsCold`/`compileScriptModuleCold`/
   * `prepareExternalManifest` transpilent et résolvent en PARALLÈLE (workers), mais
   * n'appellent PAS `minifyJs` tout de suite — ils pousseraient sinon plusieurs
   * minifications CONCURRENTES sur `this.mangleCache` (état PARTAGÉ), dont l'ordre
   * d'achèvement réel (parallélisme, non déterministe) déciderait quelle unité réserve en
   * premier le nom court d'une propriété `_mjs_*` — deux builds identiques en source
   * produiraient alors des composants (et un cœur minifié après eux) byte-DIFFÉRENTS.
   * Chaque tâche ici garde tout ce qu'il faut pour minifier et compléter l'unité ; vidée et
   * exécutée par `flushPendingMinifyTasks()`, dans un ORDRE TRIÉ stable, SÉQUENTIELLEMENT.
   * `names` : noms courts que l'unité peut porter par nom sur une instance, relevés sur son code
   * NON minifié (vide hors minification) — réservés AVANT la première minification du tour
   * (cf. reserveInstanceNames()). */
  private pendingMinifyTasks: { stem: string; names: string[]; run: () => Promise<void> }[] = []
  usedAnimations: Set<string>
  // jumeau de usedAnimations : noms d'anim DÉFINIS
  // dynamiquement par le script user (µanim.create/crossfade, nom en
  // littéral). compileUsedAnimations() les exclut de `missing` — aucun
  // fichier runtime statique ne les décrit, c'est un faux positif sinon.
  definedAnimations: Set<string>
  /** (crash-si-feuille-absente) — noms de feuilles partagées
   * `@css` référencées par TOUS les composants compilés ce tour-ci (fresh ET
   * cache-hit, même hygiène que usedAnimations) ; validé en fin de compile()
   * par validateSharedSheets(), qui THROW (pas un warning) si l'une d'elles n'a
   * aucun fichier .sass/.scss/.css correspondant dans stylesheetsDir. */
  requestedSharedSheets: Set<string>
  /** jumeau de `requestedSharedSheets` ci-dessus, mais pour l'AUTRE voie
   * de réclamation d'une feuille : l'attribut `css="nom"` LITTÉRAL d'un `<@view>` (lu par le
   * runtime au montage, cf. runtime/mjs_element.ts `_mjs_applyLayout`), plutôt que la directive
   * `@css` d'un module. Alimenté en scannant le contenu BRUT de chaque composant (mode split
   * SEULEMENT, cf. extractViewCssNames) — jamais consultée hors split, coût nul en mode
   * 'bundle'. Consommée par finalizeSplitStyles() pour forcer eager une feuille réclamée
   * ainsi, MÊME si un module la déclare déjà par ailleurs (cf. splitEagerHashedPaths). */
  viewRequestedSheets: Set<string>
  /** Reverse-map "chemin absolu d'un partial" → "set de chemins absolus
   * des fichiers .mjs qui l'incluent via <@include>". Mis à jour à chaque
   * compileMjs pour permettre au watcher d'invalider les parents quand un
   * partial change. */
  partialDependents: Map<string, Set<string>>
  /** Chemins absolus de TOUS les
   * fichiers visités par `bundleExternalManifest` (le manifest externe
   * lui-même + chaque fichier `#= require`/`require_dir`/`require_tree`,
   * récursivement). `watch()` les ajoute au watcher : avant, ces fichiers
   * (souvent HORS sourceDir) n'étaient jamais surveillés — les éditer ne
   * déclenchait AUCUNE recompilation. */
  externalManifestDeps: Set<string>
  /** Mangle cache partagé entre tous les minifyJs() d'un compile, pour
   * mangler `_mjs_*` de manière cohérente inter-fichiers (cf. minify.ts). */
  mangleCache: Record<string, string | false>
  /** génération du cache de raccourcissement : avancée chaque fois qu'une réservation de noms
   * d'instance RETIRE une correspondance `_mjs_x → nom` (cf. reserveInstanceNames()). Une unité
   * en cache minifiée à une génération antérieure porte des noms désaccordés du cœur à venir :
   * elle est re-minifiée au même tour (cf. `CacheEntry.mangleGen`, emitPendingUnits()/
   * emitSingleFile()). Vit le temps de l'instance, comme `this.cache`. */
  private mangleGeneration = 0

  // ----------------------------------------------------------------------------
  // rechargement CSS à chaud (mode watch seulement). `watch()` arme
  // `cssOnlyTracking` ; `compile()`/`_compileMjsInner`/`bundleSharedStyles` y lisent
  // et écrivent. Jamais consulté par `build`/`check`/`serve` (compile() one-shot,
  // aucune continuité entre deux appels → resterait toujours "full" de toute façon).
  // ----------------------------------------------------------------------------
  private cssOnlyTracking = false
  /** Dernier TranspileData COMPLET par fichier .mjs (recompilé ce tour-ci, cache
   * miss) — sert à comparer "hors-baseCss identique ?" au recompile SUIVANT. */
  private lastComponentData: Map<string, TranspileDataLike> = new Map()
  /** Dernier CSS compilé par feuille partagée nommée (stylesheetsDir, hors mjs_root). */
  private lastSharedCss: Map<string, string> = new Map()
  /** Dernier CSS de mjs_root.{sass,scss} (adopté globalement), undefined si absent. */
  private lastRootCss: string | undefined = undefined
  /** Filet CENTRAL : hashedPath par nom logique de TOUT fichier émis via writeHashed
   * au compile PRÉCÉDENT — tout hash qui change sans être une émission ATTENDUE d'un
   * lot css-only (composant qualifié, mjs_styles) disqualifie : couvre mjs_core
   * (runtime édité), modules .civet/.coffee, mjs_anims, mjs_external, assets copiés. */
  private lastWrittenHashes: Map<string, string> = new Map()
  /** (protocole de navigation) — id de build GLOBAL du dernier manifest
   * écrit par writeManifest() (dérivé du CONTENU assemblé, jamais d'une horloge :
   * même build → même id, un seul asset qui change → id différent). Version de
   * build exposée au client (µ.version) ET au protocole de navigation — un
   * décalage entre l'id en mémoire du client et celui du serveur signale une
   * nouvelle version disponible. `null` avant le premier writeManifest(). */
  lastBuildId: string | null = null
  // Accumulateurs RÉINITIALISÉS en tête de chaque compile() (comme manifestSources) :
  private cssOnlyComponents: Record<string, string> = {}
  private cssOnlySheets: Record<string, string> = {}
  private cssOnlyRoot: string | undefined = undefined
  /** true dès qu'UN fichier recompilé ce tour-ci n'est pas qualifiable "css-only"
   * (script/template changé, fichier nouveau, fichier/feuille supprimé…). */
  private cssOnlyDisqualified = false
  /** Émissions writeHashed de CE compile (nom logique → hashedPath). */
  private cssOnlyWrites: Map<string, string> = new Map()
  /** Noms logiques dont un CHANGEMENT de hash est attendu dans un lot css-only. */
  private cssOnlyAllowedWrites: Set<string> = new Set()
  /** Noms de fichiers (avec hash, ex. 'comp-a1b2c3d4.js') faisant partie
   * de la sortie VALIDE de CE compile() : soit fraîchement écrits par
   * writeHashed()/resolveOneAsset() (copie raw), soit réutilisés tels quels sur
   * un cache hit de `this.cache` (_compileMjsInner/_compileScriptModuleInner —
   * contenu inchangé, écriture disque légitimement sautée). Réinitialisé en
   * tête de compile() (comme manifest) : filtre collectSizes() pour qu'un résidu
   * d'un tour précédent (composant en échec ce tour, jamais recompilé NI en
   * cache hit) ne soit plus jamais réaffiché comme s'il venait d'être produit. */
  private emittedThisCompile: Set<string> = new Set()
  /** Chemins ABSOLUS des anciens fichiers hachés mis en attente par
   *  cleanupOldHashes() : purgés pour de bon SEULEMENT après que writeManifest() ait réussi (cf.
   *  flushPendingHashCleanup), jamais avant — sinon le manifeste ENCORE PUBLIÉ sur disque peut
   *  nommer un fichier déjà supprimé, le temps du reste du build. */
  private pendingHashCleanup: string[] = []
  /** pruneOrphans() — nombre d'erreurs du DERNIER compile(), `-1`
   * tant qu'aucun n'a encore tourné. Sert de garde : un build qui n'a jamais tourné, ou qui a
   * échoué (build partiel, cf. `recoverFailedComponentManifest`), ne doit jamais purger — sur un
   * ensemble d'émissions incomplet, la purge effacerait des fichiers ENCORE valides. */
  private lastCompileErrors = -1
  /** pruneOrphans() — numéro de génération du compile() EN COURS, incrémenté en
   * tête de chaque compile() (cf. son incrément ~1358) et JAMAIS remis à 0 (contrairement aux
   * accumulateurs voisins) : il doit rester distinct d'un compile() au suivant, sur toute la vie de
   * l'instance (watcher, API). Tague chaque entrée fraîche de `this.cache` (cf. les 2
   * `this.cache.set`) — cf. `cacheHitsThisCompile` pour l'usage. */
  private compileGeneration = 0
  /** pruneOrphans() — nombre de CACHE HITS INTER-compile
   * composant de CE compile() (cf. les 2 sites `_compileMjsInner`/`_compileScriptModuleInner`, qui
   * l'incrémentent à côté de leur `emittedThisCompile.add`, SEULEMENT quand `cached.gen !==
   * this.compileGeneration`) : un composant resservi depuis `this.cache` réinjecte son `.js` dans
   * `emittedThisCompile`, jamais ses assets annexes (`µasset`, variantes d'image — `resolveOneAsset`
   * non rappelé) — l'ensemble d'émissions de ce tour est donc PARTIEL, MAIS SEULEMENT si l'entrée
   * resservie vient d'un compile() ANTÉRIEUR : un hit sur une entrée posée PENDANT ce même compile()
   * (composant redemandé 2 fois dans le même tour — resolveTagShortcuts, une inclusion…) a déjà vu
   * ses assets annexes émis ce tour-ci, hit inoffensif. Sans ce filtre, un build FROID
   * d'un vrai projet (685 fichiers) comptait déjà 11 hits INTRA-compile de ce genre et bloquait la
   * garde en permanence (`skipped: 'cache'` systématique) : la purge ne tournait donc JAMAIS sur un
   * vrai projet. Sert de garde dans pruneOrphans() (cf. son commentaire). Remis à 0 en tête de
   * chaque compile(), comme `emittedThisCompile`. */
  private cacheHitsThisCompile = 0

  constructor(opts: BundlerOpts = {}) {
    // Defaults universels — marche sur n'importe quel hébergement (Rails,
    // Express, nginx, Caddy, hébergement statique). Aucune dépendance à
    // l'asset pipeline d'un framework spécifique. Override via mjs.config.json.
    this.root = resolve('.')
    this.sourceDir = resolve(opts.sourceDir ?? 'app/modularjs')
    this.runtimeDir = resolve(opts.runtimeDir ?? this.locateRuntimeDir())
    this.coreModulesDir = resolve(opts.coreModulesDir ?? this.locateCoreModulesDir())
    this.outputDir = resolve(opts.outputDir ?? 'public/modularjs')
    this.manifestPath = resolve(opts.manifestPath ?? 'public/modularjs/bundle.js')
    this.manifestExternal = resolve(opts.manifestExternal ?? this.resolveDefaultManifestExternal())
    this.stylesheetsDir = resolve(opts.stylesheetsDir ?? 'app/modularjs/styles')
    this.varPrefix      = opts.varPrefix ?? 'mjs'
    this.defaultTheme   = opts.defaultTheme ?? 'light'
    this.themeCss       = ''
    this.themeNames     = []
    this.urlPrefix = opts.urlPrefix ?? deriveUrlPrefix(opts.outputDir ?? 'public/modularjs')
    this.defaultScriptLang = opts.defaultScriptLang ?? 'civet'
    this.templateLang = opts.templateLang  // défaut 'civet' appliqué dans transpile() — source unique
    this.sigil = opts.sigil ?? 'µ'
    this.contextAlias = opts.contextAlias ?? false
    this.csp = opts.csp ?? false           // mode strict OPT-IN : rien ne change tant qu'il n'est pas demandé
    this.sourceMapMode = opts.sourceMap ?? 'dev'    // défaut : la carte sert au développement, pas en prod où elle publie le source
    this.maxStateVars = opts.maxStateVars  // défaut (40) appliqué dans transpile() — source unique
    this.a11y = opts.a11y  // défaut (true) appliqué dans transpile() — source unique
    this.keepFailedComponents = opts.keepFailedComponents ?? true
    this.preload = opts.preload
    this.viewTransition = opts.viewTransition
    this.logLevel = opts.logLevel
    this.i18n = opts.i18n
    this.render = opts.render
    this.i18nManifestData = undefined
    // Deux axes désormais SÉPARÉS : `env` dit dev ou prod, `minify` dit
    // si on compacte. `forceMinify` (legacy, interne) reste le raccourci « les deux »,
    // et cède devant un `env`/`minify` explicite.
    this.envMode    = opts.env    ?? (opts.forceMinify ? 'prod' : 'dev')
    this.minifyMode = opts.minify ?? (opts.forceMinify ? true   : 'auto')
    this.minimalRuntime = opts.minimalRuntime ?? false
    this.runtime = opts.runtime
    this.cssMode = opts.css ?? 'bundle'
    this.jsMode = opts.js ?? 'split'
    // défauts résolus ICI, au point de consommation, comme le reste des politiques
    this.imageConfig = {
      widths:  opts.image?.widths  ?? [480, 960, 1920],
      formats: opts.image?.formats ?? ['webp'],
      quality: opts.image?.quality ?? 78,
    }
    this.dedupWaitTimeoutMs = opts.dedupWaitTimeoutMs ?? 12000
    this.inlineTranspileLimit = opts.inlineTranspileLimit ?? INLINE_LIMIT
    this.cache = new Map()
    this.manifest = {}
    this.coreHashedPath = ''
    this.usedAnimations = new Set()
    this.definedAnimations = new Set()
    this.requestedSharedSheets = new Set()
    this.viewRequestedSheets = new Set()
    this.partialDependents = new Map()
    this.externalManifestDeps = new Set()
    this.mangleCache = this.loadMangleCache()
    // marqueurs lus sur une donnée (cf. minify.ts) : réservés dès l'existence du cache — qu'il
    // vienne d'être créé ou d'être relu du disque. Une correspondance héritée d'un cache plus
    // ancien est retirée, et la génération avance comme pour les noms d'instance : tout code
    // minifié avec elle est désaccordé et sera recompilé. Sans minification, le cache reste vide
    // comme avant (rien n'est raccourci, et un build de dév n'écrit aucun `.mangle-cache.json`).
    const withdrawnMarkers = this.shouldMinify() ? reserveDataMarkers(this.mangleCache) : []
    // aides du cœur posées sur µ (`µ._p`, `µ._tm`, cf. minify.ts) : leur nom ne doit jamais
    // devenir le nom court d'une propriété interne, sans quoi le raccourcisseur écrase l'aide
    // elle-même. Le relevé des noms d'instance ne les couvre que si un gabarit les cite.
    const withdrawnHelpers = this.shouldMinify() ? reserveMangleNames(this.mangleCache, CORE_HELPER_NAMES) : []
    if (withdrawnMarkers.length > 0 || withdrawnHelpers.length > 0) this.mangleGeneration++
  }

  // --------------------------------------------------------------------------
  // resolveDefaultManifestExternal : défaut de `manifestExternal` QUAND il
  // n'est pas configuré explicitement (mjs.config.json ou BundlerOpts — un
  // chemin explicite est toujours respecté tel quel, cette résolution n'entre
  // jamais en jeu dans ce cas). Priorité 'app/modularjs/manifest.civet' s'il existe ; sinon repli
  // 'app/modularjs/manifest.coffee' (dépréciée — cf. coffeeAdapter, avertit à
  // sa propre compilation) QUE ce fichier existe ou non — si aucun des deux
  // n'existe, bundleExternalManifest() no-op déjà sur un manifest absent
  // (comportement historique inchangé).
  // --------------------------------------------------------------------------
  private resolveDefaultManifestExternal(): string {
    const civetDefault = 'app/modularjs/manifest.civet'
    return existsSync(resolve(civetDefault)) ? civetDefault : 'app/modularjs/manifest.coffee'
  }


  // --------------------------------------------------------------------------
  // Worker pool — partagé global au process (refcounted).
  //
  // Le pool de workers est coûteux à initialiser (esbuild compile worker.ts en
  // dev + N spawns de threads). Le réutiliser entre Bundlers évite N×200ms
  // d'overhead — important pour les tests qui créent un Bundler par test.
  // --------------------------------------------------------------------------
  private async ensureWorkerPool(): Promise<WorkerPool> {
    // TOCTOU async : l'ancien garde-fou
    // testait `_sharedWorkerPool` (la VALEUR déjà résolue). Entre ce test et
    // l'assignation `_sharedWorkerPool = new WorkerPool(...)` se trouve un
    // `await resolveWorkerScript()` — N appels concurrents (compilation en
    // parallelMap de N fichiers .mjs) voyaient TOUS `!_sharedWorkerPool`
    // AVANT que le premier n'ait fini : jusqu'à PARALLEL_LIMIT pools créés,
    // tous sauf le DERNIER à assigner `_sharedWorkerPool` orphelins (threads
    // jamais terminate(), fuite documentée jusqu'à l'OOM), et
    // `resolveWorkerScript()` (écrit worker-<hash>.mjs sur disque) appelé en
    // concurrence sur le MÊME fichier (troncature possible).
    //
    // Fix : mémoïse la PROMESSE de création (`_sharedWorkerPoolPromise`), pas
    // juste la valeur — tout appel concurrent qui arrive AVANT la résolution
    // attend la MÊME promesse en vol plutôt que d'en lancer une nouvelle.
    // Le nouveau pool n'est éligible au réemploi QUE si le pool RÉSOLU
    // (`_sharedWorkerPool`) n'est pas mort ; `_sharedWorkerPool` est remis à
    // `null` de façon SYNCHRONE (avant tout `await`) dès qu'une recréation
    // démarre, pour qu'un appelant concurrent qui arrive juste après voie
    // bien "recréation déjà en cours" plutôt que de retester l'ancien pool
    // (encore marqué mort) et en déclencher une DEUXIÈME.
    let pool: WorkerPool
    if (_sharedWorkerPoolPromise && (!_sharedWorkerPool || !_sharedWorkerPool.isDead())) {
      pool = await _sharedWorkerPoolPromise
    } else {
      const stalePool = _sharedWorkerPool
      _sharedWorkerPool = null
      const creating = (async () => {
        if (stalePool) {
          // Pool précédent mort : on le remplace (terminate best-effort).
          await stalePool.terminate().catch(() => {})
        }
        const spec = await resolveWorkerScript()
        // Taille du pool = PARALLEL_LIMIT (dérivé de RAM disponible cf. supra).
        // Chaque worker_threads consomme ~700 MB à cause du bundle esbuild,
        // donc 8 workers = 5-6 GB de RAM → OOM-kill sur système 8 GB. On
        // dimensionne donc en fonction de la RAM (cf. PARALLEL_LIMIT).
        const p = new WorkerPool(PARALLEL_LIMIT, spec)
        _sharedWorkerPool = p
        return p
      })()
      _sharedWorkerPoolPromise = creating
      // Une création qui échoue (ex. resolveWorkerScript() jette) ne doit PAS
      // "bricker" tous les appels futurs avec la même promesse rejetée à
      // vie — on libère la mémoïsation pour permettre une nouvelle tentative.
      creating.catch(() => { if (_sharedWorkerPoolPromise === creating) _sharedWorkerPoolPromise = null })
      pool = await creating
    }
    if (!this._poolUserRegistered) {
      _sharedWorkerPoolRefCount++
      this._poolUserRegistered = true
    }
    return pool
  }

  /** Marque ce Bundler comme utilisateur du pool partagé (incr refcount au 1er ensure). */
  private _poolUserRegistered = false

  /** Termine le pool de workers s'il n'a plus d'utilisateurs.
   *
   * À appeler quand le Bundler n'est plus utilisé (sinon Node ne sort pas
   * tant que les workers sont actifs).
   */
  async close(): Promise<void> {
    if (this._poolUserRegistered) {
      _sharedWorkerPoolRefCount--
      this._poolUserRegistered = false
      if (_sharedWorkerPoolRefCount <= 0 && _sharedWorkerPool) {
        await _sharedWorkerPool.terminate()
        _sharedWorkerPool = null
        _sharedWorkerPoolPromise = null
        _sharedWorkerPoolRefCount = 0
      }
    }
  }

  // --------------------------------------------------------------------------
  // preResolveAssets — extrait tous les `µasset('X')` / `µ.asset('X')`
  // littéraux du contenu source et les résout via `resolveOneAsset`. Le dict
  // résultant est envoyé au worker qui n'a pas accès au disque.
  //
  // CORRECTIF DE DOC — le commentaire affirmait
  // qu'un `µasset(varExpr())` DYNAMIQUE produirait un placeholder
  // `MISSING_MJS_ASSET:xxx` rattrapé plus tard par `resolveMagicAssets` :
  // FAUX, vérifié dans `replaceMagicAssets` (transpiler/index.ts) — sa regex
  // n'accepte QU'un argument entre guillemets littéraux ; un appel dynamique
  // ne matche jamais et traverse tel quel, résolu à l'exécution par
  // l'implémentation runtime de `µ.asset`. Le placeholder n'apparaît QUE pour
  // un chemin LITTÉRAL (donc statiquement résolvable en théorie) qui a
  // échoué — fichier absent du disque, ou (bug corrigé ci-dessous) sigil
  // alternatif non reconnu par CETTE regex. `resolveMagicAssets` reste utile
  // pour les patterns `µasset(...)` GÉNÉRÉS après ce point (templates,
  // mjs_core) et sert désormais aussi de garde-fou : un placeholder qui
  // survit jusqu'à son retour devient une ERREUR de build (cf. son propre
  // commentaire), plus un warning silencieux.
  // --------------------------------------------------------------------------
  private async preResolveAssets(content: string, baseDir?: string): Promise<{ dict: Record<string, string>; assetSources: string[]; images: Record<string, string> }> {
    // 1. `µasset('X')` / `µ.asset('X')` / `mjsasset('X')` / `mjs.asset('X')`
    // littéraux dans le code user. Cette
    // regex ne reconnaissait QUE la forme `µ` : un projet configuré en sigil
    // 'mjs' (`mjs.asset('X')`) ne voyait JAMAIS son asset pré-résolu ICI (le
    // dict envoyé au worker n'avait pas d'entrée pour ce logicalPath) — le
    // TRANSPILER (qui, lui, connaît le sigil configuré) reconnaît pourtant
    // bien `mjs.asset(...)` comme un appel d'asset valide, mais
    // `resolveAsset()` ne trouve rien dans le dict et retombe sur le
    // placeholder `/MISSING_MJS_ASSET:X` — qui SURVIT alors jusqu'au fichier
    // écrit sur disque, SANS AUCUNE erreur ni warning (build vert, asset
    // cassé en prod). Les deux formes sont reconnues INCONDITIONNELLEMENT
    // (pas seulement celle du sigil configuré) : un projet peut légitimement
    // mélanger les deux graphies (copié-collé de doc, migration en cours).
    // Masque `<pre>`/`<code>` AVANT
    // l'extraction : un `µasset('…')` AFFICHÉ en EXEMPLE de doc/tuto (pas une
    // vraie référence) n'est plus résolu ni copié comme un asset réel (même
    // masquage que `extractImportMatches` juste en dessous pour les `@import`).
    const ASSET_CALL_RE = /(?:µasset|µ\.asset|mjsasset|mjs\.asset)\s*\(\s*['"]([^'"]+)['"]\s*\)/g
    const masked = maskCodeBlocks(content)
    const muMatches = [...masked.matchAll(ASSET_CALL_RE)]
    // `µimport('X')`/`mjsimport('X')` LITTÉRAL : réécrit PLUS TARD, DANS
    // le worker, en `µ._mjs_import(µasset('X'))` (rewriteMuImport, sigils.ts) — le
    // µasset('X') qui en naît doit donc être pré-résolu ICI, côté master, comme
    // n'importe quel µasset(...) direct (sinon le worker, sans accès disque,
    // reçoit un dict sans entrée pour 'X' → MISSING_MJS_ASSET). Regex SŒUR
    // (pas fusionnée à ASSET_CALL_RE, qui reste focalisée sur µasset) sur le
    // corps PARTAGÉ sigils.ts ; même dict/même traitement en aval (m[1] = chemin).
    muMatches.push(...masked.matchAll(MU_IMPORT_CALL_RE))
    // Même chose pour la forme nue sans parenthèses
    muMatches.push(...masked.matchAll(MU_IMPORT_BARE_RE))
    // 2. Paths référencés par les directives `@import` (générés en `µasset(...)`
    //    par la directive, mais avant que le worker ne les voie). Sans cette
    //    pré-résolution, le worker écrit `/MISSING_MJS_ASSET:xxx` et le master
    //    ne rattrape plus (le pattern `µasset(...)` a déjà été substitué).
    //    Régression V2 — les tutos avec `@import` cassent silencieusement.
    //
    //    Le nom de var peut contenir `µ`, `$` et `§` (store `$$X`, var `µ$X`,
    //    singleton importé `@import µ$$X`). Sans ça, `@import µ$$count …` n'est
    //    pas reconnu et le path n'est jamais pré-résolu.
    //    Cf. `extractImportMatches` :
    //    masque `<pre>`/`<code>` (démo de tuto affichant `@import` comme
    //    exemple de code, pas une vraie directive) + la regex ne peut plus
    //    enjamber les lignes.
    const importMatches = extractImportMatches(content)

    // 3. Descend récursivement dans les `<@include>` : un `µasset(...)`/`@import`
    // qui ne vit QUE dans un partial (jamais dans le fichier top-level lui-même —
    // cas réel : le logo <img src="µasset('tuto/MModularJS.webp')"> de
    // tuto/_header.mjs et doc/_header.mjs) n'était JAMAIS vu ICI : cette
    // fonction tourne côté MASTER, AVANT l'inlining réel des partials (celui-ci
    // se fait DANS le worker, par le transpiler) — le dict transmis au worker
    // n'avait donc pas d'entrée pour ce logicalPath, et `resolveAsset()` (qui,
    // dans le worker, n'est qu'un lookup dans ce dict — aucun accès disque)
    // retombait sur `/MISSING_MJS_ASSET:X`, qui survivait jusqu'à
    // `resolveMagicAssets` (post-compile, cf. son commentaire) : ERREUR DE
    // BUILD. Le fix d'ordre des passes 4a-4d du transpiler (<@include> avant
    // µasset) règle le cas `transpile()` appelé DIRECT avec un `resolveAsset`
    // à accès disque immédiat (cf. tests/macros.test.ts) mais PAS le pipeline
    // réel de `mjs build` (worker pool) — d'où ce 2e correctif, complémentaire.
    // Réutilise `resolvePartial`/`INCLUDE_RE` du transpiler TELS QUELS (jamais
    // de logique de résolution dupliquée qui pourrait diverger) ; garde
    // anti-boucle par chemin absolu déjà visité (partial circulaire ou inclus
    // depuis plusieurs points).
    const partialMuMatches = [...muMatches]
    const partialImportMatches = [...importMatches]
    if (baseDir) {
      const visited = new Set<string>()
      const queue: Array<{ text: string; dir: string }> = [{ text: content, dir: baseDir }]
      while (queue.length > 0) {
        const { text, dir } = queue.shift()!
        for (const m of maskCodeBlocks(text).matchAll(INCLUDE_RE)) {
          const resolved = resolvePartial(m[1], dir, this.sourceDir)
          if (!resolved || visited.has(resolved.key)) continue
          visited.add(resolved.key)
          let partialContent: string
          try {
            partialContent = readFileSync(resolved.path, 'utf-8')
          } catch {
            continue
          }
          const maskedPartial = maskCodeBlocks(partialContent)
          for (const pm of maskedPartial.matchAll(ASSET_CALL_RE)) partialMuMatches.push(pm)
          // µimport('X')/mjsimport('X') LITTÉRAL DANS un partial
          // manquait ici (seul ASSET_CALL_RE était scanné) : le build à froid restait
          // vert (filet resolveMagicAssets, master, post-compile, accès disque réel),
          // mais `assetSources`/le dict restaient sans cette entrée → cache de host.mjs
          // JAMAIS invalidé quand la cible du µimport change (mjs dev/watch), staleness
          // silencieuse constatée en conditions réelles. Même regex SŒUR qu'en tête de
          // fonction (ligne ~827), appliquée ici au texte du partial.
          for (const pm of maskedPartial.matchAll(MU_IMPORT_CALL_RE)) partialMuMatches.push(pm)
          // Même chose pour la forme nue sans parenthèses
          for (const pm of maskedPartial.matchAll(MU_IMPORT_BARE_RE)) partialMuMatches.push(pm)
          for (const pm of extractImportMatches(partialContent)) partialImportMatches.push(pm)
          queue.push({ text: partialContent, dir: dirname(resolved.path) })
        }
      }
    }

    // Filtre les URLs externes (https://...) qui ne sont pas des assets locaux.
    const localPaths: string[] = []
    for (const m of partialMuMatches) localPaths.push(m[1])
    for (const m of partialImportMatches) {
      const p = m[1]
      if (!/^https?:\/\//.test(p)) localPaths.push(p)
    }

    const dict: Record<string, string> = {}
    const unique = new Set(localPaths)
    await Promise.all(
      [...unique].map(async (logicalPath) => {
        dict[logicalPath] = await this.resolveOneAsset(logicalPath)
      })
    )
    // Chemins SOURCE des `µasset('…')`
    // LITTÉRAUX, remontés au parent pour être suivis comme DÉPENDANCES (hash de
    // cache + partialDependents), au même titre que les `@import` (ces derniers
    // déjà suivis séparément par _compileMjsInner). Sans ça, éditer un asset
    // (logo.png, ou un .civet référencé par µasset) en watch ne ré-invalidait
    // JAMAIS le .mjs parent → cache hit → ancien asset servi (voire un hashedPath
    // disparu après cleanupOldHashes → 404 silencieux). `resolve(sourceDir, …)`
    // pour matcher la clé du watcher (`resolve(changed)`) et des @import.
    // `partialMuMatches` (et non `muMatches` seul) : un asset référencé
    // UNIQUEMENT depuis un partial doit, lui aussi, invalider ses parents
    // quand il change (même raisonnement que le fix ci-dessus).
    const assetSources = [...new Set(partialMuMatches.map((m) => resolve(this.sourceDir, m[1])))]

    // `µimage('chemin'[, largeur…])` : même mécanique de pré-résolution côté
    // MASTER (le worker n'a pas le disque, et il faut lire l'en-tête du fichier pour en
    // sortir les dimensions), mais la valeur résolue n'est pas une URL : c'est un OBJET
    // (`src`, `srcset`, `width`, `height`…). On indexe par le TEXTE EXACT de l'appel —
    // deux appels au même fichier avec des largeurs différentes sont deux entrées.
    const imageMatches = [...maskCodeBlocks(content).matchAll(IMAGE_CALL_RE)]
    // `<@img src="…">` littéral : MÊME file que
    // les µimage(...) ci-dessus (contenu + partials <@include>), texte masqué par
    // maskCodeBlocks pour ignorer un exemple affiché dans <pre>/<code> (scanImgTags,
    // transpiler/img-tag.ts — pas d'accès disque là-bas, tout ici).
    const imgTagMatches: ImgTag[] = scanImgTags(maskCodeBlocks(content))
    if (baseDir) {
      const visited = new Set<string>()
      const queue: Array<{ text: string; dir: string }> = [{ text: content, dir: baseDir }]
      while (queue.length > 0) {
        const { text, dir } = queue.shift()!
        for (const m of maskCodeBlocks(text).matchAll(INCLUDE_RE)) {
          const resolved = resolvePartial(m[1], dir, this.sourceDir)
          if (!resolved || visited.has(resolved.key)) continue
          visited.add(resolved.key)
          let partialContent: string
          try { partialContent = readFileSync(resolved.path, 'utf-8') } catch { continue }
          for (const pm of maskCodeBlocks(partialContent).matchAll(IMAGE_CALL_RE)) imageMatches.push(pm)
          imgTagMatches.push(...scanImgTags(maskCodeBlocks(partialContent)))
          queue.push({ text: partialContent, dir: dirname(resolved.path) })
        }
      }
    }
    const images: Record<string, string> = {}
    for (const m of imageMatches) {
      if (images[m[0]] !== undefined) continue
      const widths = (m[2] ?? '').split(',').map(s => s.trim()).filter(Boolean).map(Number)
      images[m[0]] = JSON.stringify(await this.resolveOneImage(m[1], widths))
      assetSources.push(resolve(this.sourceDir, m[1]))
    }
    // même mécanique que la boucle µimage ci-dessus, mais la valeur résolue
    // est la BALISE RÉÉCRITE (texte), pas un objet JSON : `<@img>` reste `<@img>`, seuls
    // ses attributs se remplissent (cf. replaceMagicImages, transpiler/index.ts, qui fait
    // un split/join texte→texte générique — aucune modification n'y était nécessaire).
    for (const tag of imgTagMatches) {
      if (images[tag.text] !== undefined) continue
      if (!isResolvableSrc(tag.src)) continue   // dynamique/absolu/URL/absent : passe-plat
      const src     = tag.src
      const extrait = Array.from(tag.text).slice(0, 80).join('').replace(/\n/g, ' ')
      // attribut écrit DEUX FOIS : la réécriture recopiait chaque
      // occurrence → deux `src` dans le HTML émis. Refus net, comme `accept` dupliqué
      // sur <@element> — jamais une sortie invalide en silence.
      for (const nom of ['src', 'widths']) {
        if (tag.attrs.filter(a => a.name === nom).length > 1) throw new Error(t('bundler.index.img-attribut-duplique', { attribut: nom, extrait }))
      }
      let widths: number[] = []
      if (tag.widthsDynamique !== null) throw new Error(t('bundler.index.img-widths-invalide', { valeur: tag.widthsDynamique, extrait }))
      if (tag.widthsRaw !== null) {
        const parsed = parseWidths(tag.widthsRaw)
        if (parsed === null) throw new Error(t('bundler.index.img-widths-invalide', { valeur: tag.widthsRaw, extrait }))
        widths = parsed
      }
      // confinement SOUS sourceDir, le même que resolveOneAsset : sans
      // lui, un `../hors/x.png` qui EXISTE passait cette garde et n'était refusé qu'en
      // aval, par le filet générique dont le message ne nomme jamais la balise
      const srcRoot = resolve(this.sourceDir)
      const abs     = resolve(join(this.sourceDir, src))
      if ((abs !== srcRoot && !abs.startsWith(srcRoot + sep)) || !existsSync(abs)) {
        throw new Error(t('bundler.index.img-src-introuvable', { chemin: src, extrait }))
      }
      // Même confinement RÉEL que resolveOneAsset (le check LEXICAL
      // ci-dessus ne résout jamais un symlink) : un lien posé DANS sourceDir et pointant HORS
      // de sourceDir passait ce test (chemin textuel valide) puis sa cible réelle était copiée.
      const realAbs     = realpathSync(abs)
      const realSrcRoot = realpathSync(this.sourceDir)
      if (realAbs !== realSrcRoot && !realAbs.startsWith(realSrcRoot + sep)) {
        throw new Error(t('bundler.index.img-src-symlink-hors-racine', { chemin: src, cible: realAbs, extrait }))
      }
      const resolvedRaw = await this.resolveOneImage(src, widths)
      const resolved    = {
        src:    String(resolvedRaw.src ?? ''),
        srcset: String(resolvedRaw.srcset ?? ''),
        sizes:  String(resolvedRaw.sizes ?? ''),
        width:  (resolvedRaw.width as number | null)  ?? null,
        height: (resolvedRaw.height as number | null) ?? null,
      }
      images[tag.text] = rewriteImgTag(tag, resolved)
      assetSources.push(resolve(this.sourceDir, src))
    }

    return { dict, assetSources: [...new Set(assetSources)], images }
  }

  // --------------------------------------------------------------------------
  // mangleCache persistance.
  //
  // Sans persistance, chaque `new Bundler()` repart d'un cache vide → l'ordre
  // de mangle des `_mjs_*` peut différer entre 2 builds prod du même code
  // (selon l'ordre de découverte). Conséquence : 2 builds prod du MÊME source
  // produisent 2 bundles à hash MD5 différents → cache navigateur invalidé
  // gratuitement à chaque déploiement.
  //
  // Solution : sérialiser le mangleCache dans `<outputDir>/.mangle-cache.json`
  // après chaque compile et le recharger au start du suivant. Garantit des
  // builds reproductibles → bundles binairement identiques pour un code
  // identique → cache navigateur stable.
  //
  // Format simple : `{ "_mjs_intro": "a", "_mjs_outro": "b", ... }`.
  // --------------------------------------------------------------------------
  private get mangleCachePath(): string {
    return join(this.outputDir, '.mangle-cache.json')
  }

  private loadMangleCache(): Record<string, string | false> {
    try {
      if (!existsSync(this.mangleCachePath)) return {}
      const raw = readFileSync(this.mangleCachePath, 'utf-8')
      const parsed = JSON.parse(raw)
      // Validation minimale : doit être un objet plat string → string|false
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed
      }
    } catch {
      // Cache corrompu / mal formé → on repart à zéro (perte de stabilité
      // sur ce build, mais le suivant écrira un nouveau cache propre).
    }
    return {}
  }

  private saveMangleCache(): void {
    if (Object.keys(this.mangleCache).length === 0) return
    try {
      if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true })
      // Trie les clés pour stabilité du fichier (diff git lisible).
      const sorted: Record<string, string | false> = {}
      for (const k of Object.keys(this.mangleCache).sort()) {
        sorted[k] = this.mangleCache[k]
      }
      // FAILLE — `writeFileSync` DIRECT
      // sur le chemin final pouvait être DÉCHIRÉ par 2 builds concurrents (build
      // pendant dev, CI parallèle) : fichier partiel → `JSON.parse` raté au
      // prochain load → cache vidé → mangle instable. Écriture ATOMIQUE
      // (temp + rename). `writeFileAtomic` ne convient PAS ici (il skippe si la
      // cible existe — or le cache CHANGE à chaque build) : temp+rename inline.
      const tmp = `${this.mangleCachePath}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
      writeFileSync(tmp, JSON.stringify(sorted, null, 2), 'utf-8')
      try {
        renameSync(tmp, this.mangleCachePath)
      } catch (e) {
        try { unlinkSync(tmp) } catch {}
        throw e
      }
    } catch {
      // Échec d'écriture (disque plein, permissions) → silencieux. Le build
      // a réussi, on perd juste la stabilité pour le prochain run.
    }
  }

  // --------------------------------------------------------------------------
  // compile() : cycle complet
  // --------------------------------------------------------------------------
  async compile(): Promise<CompileStats> {
    const errors: Error[] = []
    const warnings: string[] = []
    let written = 0
    const start = Date.now()
    // Reset à chaque compile pour détecter les collisions sur ce run, sans
    // garder l'état d'un build précédent (cas du watcher).
    this.manifestSources = new Map()
    this.manifestKinds = new Map()
    this.poisonedAliasSources = new Map()
    // depDigest — la mémoïsation ne vit QUE le temps d'un tour de compilation : un partial
    // partagé par 30 composants est relu 1 fois au lieu de 30, mais AUCUNE décision de
    // fraîcheur ne franchit la frontière du tour. Sans ce reset, un fichier réécrit avec
    // la même taille ET la même mtime nanoseconde (rsync --times, restauration d'archive,
    // touch reposé) resservirait un contenu périmé — même bug déjà rencontré une fois,
    // reproduit pour de vrai.
    this.depDigestCache = new Map()
    // Reset AVANT l'étape 1 (runtime), pas au rythme de
    // `this.manifest` (repartait plus bas, ligne ~1040, APRÈS l'appel à
    // bundleRuntime()) : writeHashed('mjs_core', …) appelé PAR bundleRuntime
    // marquait déjà `mjs_core-<hash>.js` dans emittedThisCompile AVANT que ce
    // reset tardif ne l'efface aussitôt — le runtime disparaissait donc du
    // tableau des tailles sur CHAQUE build (pas seulement en cas d'échec),
    // repéré (build sain à 2 composants : mjs_core absent du
    // tableau malgré 752 916 octets écrits sur disque, written=4 vs sizes
    // n'en comptant que 2).
    this.emittedThisCompile = new Set()
    // NE PLUS reset ici (contrairement à
    // emittedThisCompile ci-dessus) : un compile() précédent dont writeManifest() a ÉCHOUÉ laisse
    // des suppressions EN ATTENTE, jamais flushées (par construction, cf. flushPendingHashCleanup) —
    // les oublier ici les rendait orphelines POUR TOUJOURS si le compile() SUIVANT réussit mais fait
    // un cache-hit total (le composant fautif n'a pas changé, aucun nouveau cleanupOldHashes() ne le
    // requalifie). La file doit donc SURVIVRE d'un compile() à l'autre : elle n'est vidée que par
    // flushPendingHashCleanup() (writeManifest() réussi, cache-hit ou non), jamais par un simple
    // redémarrage de tour.
    // pruneOrphans() — reset au même rythme que emittedThisCompile ci-dessus.
    this.cacheHitsThisCompile = 0
    // pruneOrphans() — JAMAIS remis à 0 (contrairement à la ligne ci-dessus) :
    // incrémentée à CHAQUE compile(), elle doit rester distincte d'un tour au suivant sur toute la
    // vie de l'instance, pour que les 2 sites de cache-hit distinguent un hit posé CE tour-ci
    // (inoffensif) d'un hit posé par un compile() antérieur (cf. `cacheHitsThisCompile`).
    this.compileGeneration++
    // reset des accumulateurs "css-only" (comme manifestSources
    // ci-dessus). Pas de coût hors watch : cssOnlyTracking reste false.
    if (this.cssOnlyTracking) {
      this.cssOnlyComponents = {}
      this.cssOnlySheets = {}
      this.cssOnlyRoot = undefined
      this.cssOnlyDisqualified = false
      this.cssOnlyWrites = new Map()
      this.cssOnlyAllowedWrites = new Set()
      // mode css='split' — un module qui déclare une feuille embarque désormais son
      // chemin haché EN DUR (import en tête du JS émis, cf. _compileMjsInner) : éditer
      // cette feuille recompile donc CE module (cache salé, cf. splitStyleHashedPaths
      // dans le hash), un changement structurel que le payload replaceSync existant
      // (pensé pour mjs_styles.js unique) ne sait pas décrire fidèlement. Plutôt que de
      // le laisser mentir, on désarme proprement : tout tour de
      // watch en mode split retombe sur un reload complet.
      if (this.cssMode === 'split') this.cssOnlyDisqualified = true
    }

    if (!existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true })

    // PHASE A : compiler TOUTES les unités en mémoire, le cœur est encore INCONNU
    // (`this.coreHashedPath = ''`, jamais lu pendant cette phase — cf. placeholderPath()
    // partout où un chemin définitif manque). Reset des accumulateurs ci-dessous, au
    // même rythme que emittedThisCompile ci-dessus (jamais d'état d'un tour à l'autre).
    this.pendingUnits = new Map()
    this.bundleVirtualSources = new Map()
    this.pendingFeatures = new Set()
    this.pendingCoreCalls = new Set()
    this.pendingMinifyTasks = []
    this.coreHashedPath = ''

    // 2. Composants .mjs — parallélisation via `parallelMap` AVEC limite stricte.
    //
    // **Pourquoi parallelMap, pas Promise.allSettled** : sans limite, on lance
    // 474 promesses en // qui retiennent toutes leurs payloads (file content,
    // preResolved assets, closures async). Sur 474 × ~100 KB par closure
    // ouverte → multi-GB de pression mémoire master → OOM-kill.
    //
    // `parallelMap(PARALLEL_LIMIT)` traite N à la fois ; les autres attendent
    // sans payload en mémoire. Mémoire bornée par ~N × taille fichier.
    this.manifest = {}
    this.usedAnimations.clear()
    this.definedAnimations.clear()
    this.requestedSharedSheets.clear()
    this.viewRequestedSheets.clear()
    this.pendingSectionWarnings = []
    this.pendingTagRefs = []
    this.pendingComponentDeps = []
    this.manifestDeps = {}
    this.pendingLayoutNames = new Map()
    this.pendingVarData = []
    // `*.theme.mjs` : ce ne sont PAS des composants (aucun custom element, aucun tag),
    // juste des paquets de variables posés sur un sélecteur d'attribut. Compilés à part,
    // dans le master : ils sont peu nombreux et minuscules, un aller-retour worker
    // coûterait plus cher que le travail lui-même.
    // findFiles() peut désormais lever (symlink évadé de sourceDir) :
    // capturé ici comme les autres étapes, tousMjs reste vide plutôt qu'un rejet non attrapé
    // de compile() entier — le build échoue quand même (errors non vide), jamais un silence.
    let tousMjs: string[] = []
    try {
      tousMjs = this.findFiles(this.sourceDir, ['.mjs'])
        .filter(f => !basename(f, '.mjs').startsWith('_'))
    } catch (e: any) {
      errors.push(e)
    }
    const themeFiles = tousMjs.filter(isThemeFile)
    const mjsFiles   = tousMjs.filter(f => !isThemeFile(f))
    this.compileThemeFiles(themeFiles)
    // un composant SUPPRIMÉ depuis le dernier compile (son tag disparaît
    // du manifest) est un changement structurel, jamais "css-only" : au moindre
    // doute, on disqualifie le lot entier (repli reload complet).
    if (this.cssOnlyTracking) {
      const currentSet = new Set(mjsFiles)
      for (const prevFile of this.lastComponentData.keys()) {
        if (!currentSet.has(prevFile)) {
          this.cssOnlyDisqualified = true
          this.lastComponentData.delete(prevFile)
        }
      }
    }
    // découverte des modules autonomes REMONTÉE ici (leur compilation, elle, reste en
    // section 3 plus bas) : le compte de fichiers du projet doit être connu AVANT de
    // compiler le premier composant, pour savoir si ce compile démarre des threads ou non.
    // findFiles() peut lever (symlink évadé de sourceDir) : capturé comme tousMjs ci-dessus.
    let scriptFiles: string[] = []
    try {
      scriptFiles = this.findFiles(this.sourceDir, ['.civet', '.coffee'])
    } catch (e: any) {
      errors.push(e)
    }
    // Petit projet = transpilation dans le processus principal, aucun thread (cf. INLINE_LIMIT).
    // Décidé à CHAQUE compile, watch compris : un projet qui grandit bascule au tour suivant.
    this.inlineTranspile = (mjsFiles.length + scriptFiles.length) <= this.inlineTranspileLimit

    const mjsResults = await parallelMap(
      mjsFiles,
      async (file) => ({ file, hashedPath: await this.compileMjs(file) }),
      PARALLEL_LIMIT,
    )
    for (let i = 0; i < mjsResults.length; i++) {
      const r = mjsResults[i]
      const file = mjsFiles[i]
      if (r.status === 'fulfilled') {
        const { hashedPath } = r.value
        // `x.page.mjs` et `x.mjs` publient donc la MÊME clé 'x' : la collision
        // ci-dessous (claimBasename) les traite exactement comme deux basenames identiques.
        const baseName = pageAwareBaseName(file)
        const shortName = this.shortModuleName(file)
        // Détection de collision : deux .mjs qui publient la MÊME clé de
        // manifest (basename OU shortName) se disputent `µ.paths[clé]`.
        // L'autoloader ne pourra résoudre qu'UN des deux (le dernier écrit)
        // → l'autre composant ne s'upgradera jamais, silencieusement. Cas
        // typique basename : `tuto-canvas.mjs` dupliqué dans deux dossiers.
        //
        // Cette détection ne portait
        // QUE sur `baseName` : la clé `shortName` (préfixe de dossier ancêtre
        // strippé, cf. shortModuleName) était écrite dans `this.manifest`
        // SANS AUCUNE vérification. Exemple réel : `doc/doc-intro.mjs`
        // publie le shortName `intro` (préfixe `doc-` strippé) — si le projet
        // a AUSSI un `intro.mjs` authentique ailleurs (basename `intro` lui
        // aussi), les deux se disputent `manifest['intro']` SANS AUCUN
        // WARNING, celui compilé en dernier écrasant silencieusement l'autre.
        // Fix : un SEUL registre de "qui a publié quelle clé" (`manifestSources`,
        // déjà existant) est maintenant consulté pour LES DEUX clés — basename
        // ET shortName — peu importe laquelle des deux entre en collision
        // avec laquelle.
        // Basename AUTORITAIRE (collision réelle =
        // warning dur, inchangé) vs shortName = alias de confort qui CÈDE ou
        // s'AUTO-ANNULE (empoisonne) sur contention, jamais d'écrasement muet,
        // jamais de warning bloquant. Remplace l'ancien checkAndClaim qui
        // traitait les 2 clés à l'identique et criait sur un simple
        // recouvrement d'alias court (cas doc-search / tuto-search, latent).
        const claimBasename = (key: string) => {
          const prev     = this.manifestSources.get(key)
          const prevKind = this.manifestKinds.get(key)
          if (prev && prev !== file && prevKind === 'basename') {
            warnings.push(t('bundler.index.collision-basename-tag', { cle: key, prev, fichier: file }))
          }
          // un vrai composant reprend toujours la clé, même sur un alias cédé/empoisonné
          this.manifestSources.set(key, file)
          this.manifestKinds.set(key, 'basename')
          this.manifest[key] = hashedPath
        }
        const claimShortName = (key: string) => {
          const prevKind = this.manifestKinds.get(key)
          // déjà tenu par un vrai composant, ou déjà empoisonné → l'alias cède en silence
          // (un 3e prétendant sur une clé déjà empoisonnée rejoint quand même la liste des rivaux)
          if (prevKind === 'basename') return
          if (prevKind === 'poisoned') { this.notePoisonedAlias(key, file); return }
          const prev = this.manifestSources.get(key)
          if (!prev || prev === file) {
            this.manifestSources.set(key, file)
            this.manifestKinds.set(key, 'shortName')
            this.manifest[key] = hashedPath
            return
          }
          // 2 alias courts se disputent la clé → AMBIGU : on n'en publie AUCUN.
          // Les 2 composants restent joignables par leur tag qualifié mjs-<basename>.
          // Sûr par construction → PAS de warning ICI (seul un gabarit qui écrit VRAIMENT la
          // balise courte en reçoit un, cf. resolveTagShortcuts).
          delete this.manifest[key]
          this.notePoisonedAlias(key, prev)
          this.notePoisonedAlias(key, file)
          this.manifestSources.set(key, file)
          this.manifestKinds.set(key, 'poisoned')
        }
        claimBasename(baseName)
        if (shortName !== baseName) claimShortName(shortName)
        // PLUS de written++ ICI : `compileMjs` ne rend qu'un REPÈRE en phase A (rien
        // n'est encore RÉELLEMENT émis) — le compteur est désormais tenu par
        // emitPendingUnits() (phase C), au moment où l'unité obtient son chemin final
        // (cache-hit confirmé ou écriture réussie). Compter ici EN PLUS aurait doublé
        // `written` pour chaque composant du projet.
      } else {
        errors.push(new Error(t('bundler.index.erreur-fichier', { fichier: file, raison: r.reason?.message ?? r.reason })))
        // Composant en échec ce tour : tente de repêcher son entrée de
        // l'ancien manifeste (cf. commentaire détaillé de la méthode) plutôt
        // que de laisser le tag <mjs-baseName> pointer dans le vide.
        this.recoverFailedComponentManifest(file, warnings)
      }
    }
    // Fusion des warnings de section accumulés pendant
    // le parallelMap ci-dessus (composants ET partials <@include> inclus).
    warnings.push(...this.pendingSectionWarnings)

    // 2a-bis. Résolution du raccourci UNIQUE <@nom> (projet PUIS
    // cœur) : garde-fous sur le manifeste (noms réservés/core-), balises
    // littérales mjs-*/mjs-core-*, raccourcis inconnus et <@mjs-nom> (erreur
    // de migration), compilation transitive des modules cœur référencés.
    // APRÈS le manifeste complet (seul point où l'union de TOUS les
    // composants du projet est connue) — AVANT les modules (qui peuvent en
    // référencer transitivement, cf. étape suivante).
    try {
      // valeur de retour (nombre de modules cœur transitifs COMPILÉS) plus additionnée
      // à `written` : ces modules compilent désormais via compileMjs() → REPÈRE (rien de RÉEL
      // n'est encore émis en phase A) — ils rejoignent this.pendingUnits comme un composant
      // ordinaire et sont comptés par emitPendingUnits() en phase C. Les additionner ICI EN
      // PLUS aurait doublé `written` pour chaque module cœur transitif.
      await this.resolveTagShortcuts(errors, warnings)
    } catch (e: any) {
      errors.push(e)
    }

    // 3. Modules autonomes (.civet par défaut, .coffee accepté pour rétrocompat) —
    // DÉPLACÉE ici, AVANT le cœur (ancienne étape « 3 », après animations/styles/
    // computeVarRegistry) : les modules rendent désormais un REPÈRE, comme les composants
    // .mjs — leur compilation ne dépend d'aucune connaissance du cœur. Même protection
    // mémoire que pour les .mjs (cf. parallelMap supra). Même capture que tousMjs ci-dessus
    // (findFiles peut lever).
    const scriptResults = await parallelMap(
      scriptFiles,
      async (file) => {
        const ext = (file.endsWith('.civet') ? '.civet' : '.coffee') as '.civet' | '.coffee'
        return { file, ext, hashedPath: await this.compileScriptModule(file, ext) }
      },
      PARALLEL_LIMIT,
    )
    for (let i = 0; i < scriptResults.length; i++) {
      const r = scriptResults[i]
      const file = scriptFiles[i]
      if (r.status === 'fulfilled') {
        const { ext, hashedPath } = r.value
        const baseName = basename(file, ext)
        // Détection de collision (mêmes règles que pour les .mjs en section 2).
        // Cas vécu : `attachments.module.civet` présent dans deux tutos → les
        // deux compiles concurrents partagent le mangleCache → 2 hashes
        // différents → écrasement disque + le .mjs qui @import-e via le
        // manifest référence un fichier supprimé → import 404 silencieux.
        const previousSource = this.manifestSources.get(baseName)
        if (previousSource && previousSource !== file) {
          warnings.push(t('bundler.index.collision-basename-module', { nom: `${baseName}${ext}`, precedent: previousSource, fichier: file }))
        }
        this.manifestSources.set(baseName, file)
        this.manifest[baseName] = hashedPath
        // PLUS de written++ ICI, même raison que pour les composants .mjs ci-dessus
        // (compileScriptModule ne rend qu'un REPÈRE en phase A ; emitPendingUnits compte en
        // phase C, au moment de l'émission réelle).
      } else {
        errors.push(new Error(t('bundler.index.erreur-fichier', { fichier: file, raison: r.reason?.message ?? r.reason })))
      }
    }

    // 3b. Manifest externe (require / require_dir / require_tree) : lecture des
    // directives + compilation coffee/civet en phase A (prepareExternalManifest, ex-
    // bundleExternalManifest) ; son émission rejoint l'unique boucle topologique de la
    // phase C (cf. plus bas), comme les composants et modules.
    try {
      await this.prepareExternalManifest()
    } catch (e: any) {
      errors.push(e)
    }

    // 3e. Feuilles partagées demandées : crash-si-feuille-absente, indépendant du
    // cœur (reste en phase A, comme avant) — une feuille manquante doit faire échouer le
    // build AVANT même de savoir quelles briques du cœur sont nécessaires.
    try {
      this.validateSharedSheets()
    } catch (e: any) {
      errors.push(e)
    }

    // Minification DIFFÉRÉE de toutes les unités de la phase A (composants, modules cœur
    // transitifs, modules .civet/.coffee, manifeste externe) — SÉQUENTIELLE, triée par
    // stem (cf. flushPendingMinifyTasks()) : le cœur (juste après) doit trouver le
    // mangleCache dans un état TOUJOURS identique d'un build à l'autre, peu importe l'ordre
    // réel d'achèvement des transpilations parallèles qui précèdent. Juste avant : les noms que
    // les unités portent par nom sur une instance sont réservés dans ce cache (première
    // minification du tour, cf. reserveInstanceNames()).
    try {
      if (this.shouldMinify()) this.reserveInstanceNames()
      await this.flushPendingMinifyTasks()
    } catch (e: any) {
      errors.push(e)
    }

    // PHASE B : le cœur, D'APRÈS LES SIGNAUX COMPILÉS de toutes les unités déjà en
    // mémoire (composants, modules, manifeste externe, cache-hits candidats) — PLUS le
    // signal fichier variant déposé à la main (cf. collectUsedFeatures(), qui remplace
    // l'ancien balayage textuel de sourceDir) : un motif dans un commentaire HTML ou une
    // chaîne ne peut plus faire illusion, et aucune forme compilée ne peut plus être ratée.
    try {
      const used = this.collectUsedFeatures()
      this.coreHashedPath = await this.bundleRuntime(used)
      written++
    } catch (e: any) {
      errors.push(e)
    }

    // PHASE C : émettre, dans l'ordre des dépendances. Le cœur est désormais CONNU
    // (`this.coreHashedPath`) — styles et animations gardent leur chemin réel EN DUR
    // (cf. leurs propres méthodes), ils n'embarquent jamais qu'un import
    // du cœur, jamais d'une autre unité. Composants/modules/manifeste externe, eux,
    // embarquent potentiellement le chemin d'une AUTRE unité (module @import-é) : ils
    // rejoignent l'émission topologique plus bas (cf. emitPendingUnits()).

    // 10. Styles partagés (référencés via @css name) — mode 'bundle' : bundleSharedStyles()
    // écrit directement mjs_styles-<hash>.js ; mode 'split'/'lazy' : emitSplitStyles()/
    // emitLazyStyles() (déplacées ici depuis l'ancienne étape « 1.5 », AVANT les
    // composants) PUIS finalizeSplitStyles()/finalizeLazyStyles() (ancienne étape « 2c »,
    // APRÈS les composants) — les deux moitiés tournent désormais l'une après l'autre,
    // `requestedSharedSheets` étant déjà complet depuis la phase A.
    try {
      if (this.cssMode === 'split' || this.cssMode === 'lazy') {
        const { warnings: emitWarnings } = this.cssMode === 'split' ? await this.emitSplitStyles() : await this.emitLazyStyles()
        warnings.push(...emitWarnings)
      }
      const { count: sharedCount, warnings: sharedCssWarnings } =
        this.cssMode === 'split' ? this.finalizeSplitStyles() :
        this.cssMode === 'lazy'  ? this.finalizeLazyStyles()  :
        await this.bundleSharedStyles()
      if (sharedCount > 0) written++
      warnings.push(...sharedCssWarnings)
    } catch (e: any) {
      errors.push(e)
    }

    // 11. Compile uniquement les animations utilisées — `this.usedAnimations` est complet
    // depuis la fin de la phase A (chaque composant/module l'a alimenté).
    try {
      const { written: animWritten, missing } = await this.compileUsedAnimations()
      written += animWritten
      // Cf. le commentaire détaillé de
      // compileUsedAnimations() : une anim référencée mais absente (typo)
      // était sautée en silence ; désormais signalée explicitement.
      for (const name of missing) {
        warnings.push(t('bundler.index.animation-inconnue', { nom: name, dossier: join(this.runtimeDir, 'animations') }))
      }
    } catch (e: any) {
      errors.push(e)
    }

    // 12. Registre des variables de thème $$ — APRÈS composants, thèmes ET
    // feuilles partagées (bundleSharedStyles vient de rafraîchir this.lastSharedCss/
    // lastRootCss juste au-dessus) : c'est le premier point où la vue est COMPLÈTE.
    try {
      this.computeVarRegistry(warnings)
    } catch (e: any) {
      errors.push(e)
    }

    // 13-15. Émission topologique des unités en attente (composants, modules, manifeste
    // externe) : chaque unité s'émet dès que ses dépendances (cœur, feuilles split,
    // AUTRES unités @import/µasset-ées) ont un chemin final connu ; les cache-hits
    // CANDIDATS de la phase A sont confirmés (mêmes chemins embarqués qu'à leur dernière
    // émission) ou recompilés au chemin froid s'ils sont périmés. Garde-fou intégré :
    // aucun repère ne doit survivre à l'émission (cf. emitPendingUnits()). Mode 'bundle' :
    // emitSingleFile() (miroir en mémoire, jamais le disque, cf. son bandeau).
    try {
      const { written: unitsWritten } = this.jsMode === 'bundle'
        ? await this.emitSingleFile(errors, warnings)
        : await this.emitPendingUnits(errors, warnings)
      written += unitsWritten
    } catch (e: any) {
      errors.push(e)
    }

    // 15b. Garde-fou : après résolution des repères, toute valeur de `this.manifest` (hors
    // `__styles`/`__animations`, jamais un repère — bundleSharedStyles()/
    // compileUsedAnimations() gardent le chemin réel du cœur EN DUR, cf. leurs propres
    // méthodes) qui contient encore `-ZZZZZZZZ.` est une unité dont l'émission a échoué
    // (dep jamais résolu, cf. emitPendingUnits()) — `__external` INCLUS dans cette
    // vérification (son repère, lui, PASSE par l'émission topologique) : un repère ne doit
    // JAMAIS atteindre `bundle.js`. La clé est retirée, jamais publiée.
    for (const [key, value] of Object.entries(this.manifest)) {
      if (key === '__styles' || key === '__animations') continue
      if (value.includes('-ZZZZZZZZ.')) {
        errors.push(new Error(t('bundler.index.repere-jamais-resolu-manifeste', { cle: key })))
        delete this.manifest[key]
      }
    }

    // 3c. i18n façon Rails — rien fait si `sourceDir/i18n/`
    // est absent (`this.i18nManifestData` reste `undefined`, cf. writeManifest()).
    try {
      const { warnings: i18nWarnings } = this.scanI18n()
      warnings.push(...i18nWarnings)
    } catch (e: any) {
      errors.push(e)
    }

    // 3d. Table des dépendances DIRECTES du manifeste (préchargement, cf.
    // writeManifest/µDeps) — APRÈS la section 3 (modules .civet/.coffee, `@import`-és
    // par les composants) ET resolveTagShortcuts (modules cœur transitifs) : c'est ICI
    // le premier point où `this.manifestSources` contient VRAIMENT tout ce qu'un
    // composant peut nommer (balise OU cible `@import`), jamais avant.
    try {
      this.manifestDeps = this.buildManifestDeps()
    } catch (e: any) {
      errors.push(e)
    }

    // 4. Manifest entrypoint — mode 'bundle' : writeBundleManifest() (esbuild.build() en
    // mémoire, cf. son bandeau) remplace writeManifest() ; jamais les deux.
    try {
      if (this.jsMode === 'bundle') {
        await this.writeBundleManifest()
      } else {
        this.writeManifest()
      }
      // Purge différée des anciens hashes : SEULEMENT maintenant que le
      // nouveau manifeste est sur disque, jamais avant (cf. cleanupOldHashes/flushPendingHashCleanup).
      this.flushPendingHashCleanup()
      // Registre des extensions connues, consommé par pruneOrphans().
      this.writeOutputsRegistry()
      written++
    } catch (e: any) {
      errors.push(e)
    }

    // Persiste le mangleCache pour stabilité inter-builds (cache navigateur).
    this.saveMangleCache()

    // la liste des fichiers émis, avec leurs empreintes, écrite à côté
    // d'eux. Elle ne sert à RIEN au framework : elle sert à l'auteur qui veut rendre son
    // application installable. Un service worker doit savoir quoi mettre en cache, et
    // c'est le SEUL à ne pas pouvoir le deviner — les noms portent une empreinte qui
    // change à chaque build. Nous, on la connaît : autant la lui donner.
    //
    // On ne fournit AUCUN service worker : les stratégies de cache (réseau d'abord,
    // cache d'abord, péremption) sont des choix d'application, pas de framework. Cf. le
    // chapitre de doc, qui donne la recette.
    if (errors.length === 0) {
      try {
        this.writePrecacheManifest()
      } catch (e: any) {
        warnings.push(t('bundler.index.precache-echec', { raison: e?.message ?? String(e) }))
      }
    }

    const durationMs = Date.now() - start
    const sizes = this.collectSizes()
    // verdict "css-only" : jamais hors watch (undefined) ; en watch,
    // un objet non vide UNIQUEMENT si (a) zéro erreur, (b) rien n'a disqualifié
    // le lot (script/template changé, fichier/feuille ajouté-retiré…) et (c) au
    // moins un composant ou une feuille a effectivement changé ce tour-ci — un
    // lot "vide" (rien recompilé, ex. événement fs sans changement de contenu)
    // retombe sur `null` → reload complet, jamais un no-op silencieux.
    let cssOnly: CssOnlyPayload | null | undefined
    if (this.cssOnlyTracking) {
      // Filet CENTRAL (cf. lastWrittenHashes) : toute émission writeHashed dont le
      // hash a changé ce tour-ci et qui n'est PAS attendue dans un lot css-only
      // (composant qualifié, mjs_styles) disqualifie — mjs_core (runtime édité),
      // module .civet/.coffee, mjs_anims, mjs_external, asset copié… Un fichier
      // réémis à hash IDENTIQUE (contenu inchangé) n'est jamais un changement.
      for (const [name, hp] of this.cssOnlyWrites) {
        if (this.lastWrittenHashes.get(name) !== hp && !this.cssOnlyAllowedWrites.has(name)) {
          this.cssOnlyDisqualified = true
        }
        this.lastWrittenHashes.set(name, hp)
      }
      const nonEmpty = Object.keys(this.cssOnlyComponents).length > 0 ||
        Object.keys(this.cssOnlySheets).length > 0 ||
        this.cssOnlyRoot !== undefined
      cssOnly = (errors.length === 0 && !this.cssOnlyDisqualified && nonEmpty)
        ? { components: this.cssOnlyComponents, sheets: this.cssOnlySheets, ...(this.cssOnlyRoot !== undefined ? { root: this.cssOnlyRoot } : {}) }
        : null
    }
    // pruneOrphans() — posé au tout dernier moment, une fois
    // `errors` définitivement figé pour ce tour : c'est CETTE valeur que la garde de pruneOrphans()
    // relit, jamais un `errors.length === 0` recalculé ailleurs qui pourrait diverger.
    this.lastCompileErrors = errors.length
    return { written, errors, warnings, manifest: this.manifest, sizes, durationMs, cssOnly }
  }

  // --------------------------------------------------------------------------
  // flushPendingMinifyTasks() : exécute les minifications DIFFÉRÉES de `this.
  // pendingMinifyTasks` — triées par `stem` (JAMAIS l'ordre d'insertion, qui suit l'ordre
  // d'achèvement ALÉATOIRE des workers de transpilation), SÉQUENTIELLEMENT (jamais
  // `Promise.all` : le `mangleCache` esbuild est un état PARTAGÉ entre tous ces appels, un
  // même déterminisme d'ORDRE D'APPEL est ce qui rend le nom court d'une propriété `_mjs_*`
  // reproductible d'un build à l'autre). Appelée une fois à la fin de la phase A (avant que
  // le cœur ne soit minifié à son tour, phase B) et une fois pour chaque vague d'unités
  // périmées recompilées en phase C (cf. emitPendingUnits()).
  // --------------------------------------------------------------------------
  private async flushPendingMinifyTasks(): Promise<void> {
    const tasks = [...this.pendingMinifyTasks].sort((a, b) => a.stem < b.stem ? -1 : a.stem > b.stem ? 1 : 0)
    this.pendingMinifyTasks = []
    for (const task of tasks) await task.run()
  }

  // --------------------------------------------------------------------------
  // reserveInstanceNames() : réserve dans `this.mangleCache` les noms courts que les unités de CE
  // tour portent par nom sur une instance (clés d'état, props, méthodes — cf. le bandeau « noms
  // réservés » de minify.ts) : ceux des unités fraîches (tâches de minification en attente) ET
  // ceux des cache-hits candidats (`CacheEntry.reservedNames`) — un composant inchangé compte
  // autant qu'un composant retouché. Appelée une seule fois par compile(), en fin de phase A,
  // AVANT la première minification (unités, puis cœur, styles, animations, assemblage 'bundle',
  // qui trouvent tous le cache déjà réservé). Les unités périmées recompilées en phase C y sont
  // déjà : leur source n'a pas changé depuis leur passage en cache-hit candidat.
  //
  // Une correspondance retirée (cache pollué sur disque, ou nom apparu depuis le tour précédent en
  // surveillance) désaccorde tout code minifié AVANT avec elle : la génération avance, et chaque
  // cache-hit d'une génération antérieure est recompilé en phase C (emitPendingUnits()/
  // emitSingleFile()). Le cœur, les styles et les animations sont re-minifiés à chaque tour.
  // --------------------------------------------------------------------------
  private reserveInstanceNames(): void {
    const names = new Set<string>()
    for (const task of this.pendingMinifyTasks) {
      for (const name of task.names) names.add(name)
    }
    for (const unit of this.pendingUnits.values()) {
      if (unit.kind === 'cached') for (const name of unit.cached.reservedNames ?? []) names.add(name)
    }
    const withdrawn = reserveMangleNames(this.mangleCache, [...names].sort())
    if (withdrawn.length > 0) this.mangleGeneration++
  }

  // --------------------------------------------------------------------------
  // emitPendingUnits() : phase C, étapes § 3.13-3.14 de la conception. `this.
  // pendingUnits` contient TOUTES les unités de ce tour (composants .mjs, modules .civet/
  // .coffee, manifeste externe), chacune 'cold' (code prêt, repères non résolus) ou
  // 'cached' (cache-hit CANDIDAT posé en phase A, pas encore confirmé).
  //
  // 1. Chaque 'cached' est confirmée SI `cached.embeds` (chemins réels embarqués à sa
  //    dernière émission : cœur + feuilles split déclarées) est ÉGAL à la liste COURANTE
  //    (`embedsNow`, déjà connue — cœur et feuilles split viennent d'être émis avant
  //    l'appel) → rien à écrire, chemin final = `cached.hashedPath`. Sinon → PÉRIMÉE :
  //    recompilée ICI par le chemin froid (`compileMjsCold`/`compileScriptModuleCold`,
  //    `silent: true` — ne repousse pas les métadonnées déjà hydratées en phase A),
  //    rejoint le pool 'cold'.
  // 2. Boucle de Kahn : une unité 'cold' s'émet (`writeHashed`) dès que tous ses `deps`
  //    (stems dont son code contient le repère) ont un chemin final connu. Une unité dont
  //    un dep n'est JAMAIS résolu (dep en échec, cycle qui aurait échappé à
  //    `compileWithDedup`) → erreur nommant l'unité et le dep manquant, et
  //    `recoverFailedComponentManifest` pour un composant — même sort qu'un échec de
  //    compilation classique.
  // --------------------------------------------------------------------------
  private async emitPendingUnits(errors: Error[], warnings: string[]): Promise<{ written: number }> {
    let written = 0
    const finalPaths = new Map<string, string>()
    finalPaths.set('mjs_core', this.coreHashedPath)
    if (this.cssMode === 'split') {
      for (const [name, path] of Object.entries(this.splitStyleHashedPaths)) finalPaths.set(this.splitStyleStem(name), path)
      if (this.splitRootHashedPath) finalPaths.set('mjs_style_root', this.splitRootHashedPath)
    }
    // liste triée des chemins réels EMBARQUABLES ce tour-ci — comparée à `cached.embeds`
    // pour décider si un cache-hit CANDIDAT reste valide.
    const embedsNow = [...finalPaths.values()].sort()

    const coldQueue = new Map<string, Extract<PendingUnit, { kind: 'cold' }>>()
    // tri par stem — jamais l'ordre d'insertion (qui suivrait l'ordre d'achèvement
    // ALÉATOIRE des transpilations de la phase A) : par cohérence avec
    // flushPendingMinifyTasks(), qui est le VRAI point où le déterminisme du mangling se
    // joue, mais aussi pour que la RECOMPILATION d'unités périmées ci-dessous (qui pousse
    // elle aussi des tâches dans pendingMinifyTasks) parte d'un ordre prévisible.
    const sortedPending = [...this.pendingUnits].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const staleStems: string[] = []
    for (const [stem, unit] of sortedPending) {
      if (unit.kind === 'cold') { coldQueue.set(stem, unit); continue }
      const cachedEmbeds = [...(unit.cached.embeds ?? [])].sort()
      const same = cachedEmbeds.length === embedsNow.length && cachedEmbeds.every((v, i) => v === embedsNow[i])
      // noms courts accordés au cache de CE tour : une correspondance retirée depuis sa
      // minification (cf. reserveInstanceNames()) le rend périmé, même si le cœur, lui, garde
      // son chemin (propriété absente du cœur, partagée entre unités)
      const sameNames = unit.cached.mangleGen === this.mangleGeneration
      if (same && sameNames) {
        finalPaths.set(stem, unit.cached.hashedPath)
        this.emittedThisCompile.add(basename(unit.cached.hashedPath))
        if (unit.cached.gen !== this.compileGeneration) this.cacheHitsThisCompile++ // pruneOrphans() — seul un hit INTER-compile compte
        written++
        continue
      }
      // PÉRIMÉE (cœur ou feuille split changé depuis sa dernière émission, ou correspondance de
      // nom court retirée) : recompilée au chemin froid, silent (métadonnées déjà hydratées en
      // phase A) — pousse une minification DIFFÉRÉE (cf. compileMjsCold/compileScriptModuleCold),
      // relue après le flush groupé ci-dessous, jamais avant.
      try {
        if (unit.file.endsWith('.mjs')) {
          await this.compileMjsCold(unit.file, stem, undefined, { silent: true })
        } else {
          const ext = (unit.file.endsWith('.civet') ? '.civet' : '.coffee') as '.civet' | '.coffee'
          const src = readFileSync(unit.file, 'utf-8')
          const importedModules: string[] = []
          for (const im of extractImportMatches(src)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_CALL_RE)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_BARE_RE)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          await this.compileScriptModuleCold(unit.file, ext, stem, importedModules, src)
        }
        staleStems.push(stem)
      } catch (e: any) {
        errors.push(e)
        if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
      }
    }
    // Minification DIFFÉRÉE des unités PÉRIMÉES recompilées ci-dessus — même flush
    // séquentiel trié par stem que la phase A (cf. flushPendingMinifyTasks()), AVANT de
    // relire `this.pendingUnits` : sans ce flush, `fresh` resterait encore l'ANCIENNE
    // entrée 'cached' (kind jamais mis à jour tant que la tâche différée n'a pas tourné).
    if (staleStems.length > 0) {
      await this.flushPendingMinifyTasks()
      for (const stem of staleStems) {
        const fresh = this.pendingUnits.get(stem)
        if (fresh && fresh.kind === 'cold') coldQueue.set(stem, fresh)
      }
    }

    // Boucle de Kahn : émet chaque unité 'cold' dès que TOUS ses deps ont un chemin final.
    let progress = true
    while (coldQueue.size > 0 && progress) {
      progress = false
      for (const [stem, unit] of [...coldQueue]) {
        if (!unit.deps.every(d => finalPaths.has(d))) continue
        const finalCode = this.resolvePlaceholders(unit.code, finalPaths)
        // garde-fou : un repère qui survivrait au remplacement (dep résolu mais mal formé,
        // défaut de cette méthode elle-même) ne doit JAMAIS partir sur disque.
        if (finalCode.includes('-ZZZZZZZZ.')) {
          errors.push(new Error(t('bundler.index.repere-non-resolu-emission', { unite: stem })))
          coldQueue.delete(stem)
          progress = true
          if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
          continue
        }
        const hashedPath = this.writeHashed(unit.stem, unit.ext, finalCode, unit.map)
        finalPaths.set(stem, hashedPath)
        if (unit.cacheFields) {
          this.cache.set(unit.file, { ...unit.cacheFields, hashedPath, embeds: embedsNow, features: unit.features, gen: this.compileGeneration })
        }
        written++
        coldQueue.delete(stem)
        progress = true
      }
    }
    // dep jamais résolu (cycle échappé, unité dont la dépendance a échoué ailleurs) —
    // erreur nommant l'unité ET le dep manquant, jamais un composant silencieusement omis.
    for (const [stem, unit] of coldQueue) {
      const missing = unit.deps.filter(d => !finalPaths.has(d))
      errors.push(new Error(t('bundler.index.dep-jamais-resolue', { unite: stem, deps: missing.join(', ') })))
      if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
    }

    // Remplacement des repères dans this.manifest (valeurs) par leur chemin final — les
    // clés qui restent avec un repère non résolu sont retirées par le garde-fou de
    // compile(), juste après cet appel.
    for (const key of Object.keys(this.manifest)) {
      this.manifest[key] = this.resolvePlaceholders(this.manifest[key], finalPaths)
    }

    return { written }
  }

  // --------------------------------------------------------------------------
  // emitSingleFile() : mode js='bundle', même point d'appel qu'emitPendingUnits() (phase C,
  // que ce dernier remplace dans ce mode) — miroir de sa boucle de Kahn (mêmes repères, même
  // pool 'cold'/'cache'), mais la SORTIE d'une unité n'est JAMAIS un fichier écrit sur disque :
  // son code final rejoint `this.bundleVirtualSources` sous le spécificateur virtuel STABLE
  // 'mjs:unit/<stem>', que le plugin esbuild de writeBundleManifest() sert ensuite EN MÉMOIRE
  // (jamais le disque). « Stable » change la donne face à emitPendingUnits() : un cache-hit
  // (CacheEntry.code, cf. son bandeau) reste TOUJOURS valide, quel que soit le cœur/les styles
  // de CE tour — aucun hash d'aucune autre unité n'est jamais embarqué dans le texte d'une
  // unité, l'indirection ne se résout qu'à l'assemblage final. `CacheEntry.embeds` reste donc
  // toujours `[]` en mode bundle (rien à comparer, contrairement à son rôle en mode 'split') ;
  // la seule question est « ce cache-hit porte-t-il un `code` ? » — sinon (entrée posée par un
  // compile ANTÉRIEUR en mode 'split', ou par une instance qui vient de changer de mode),
  // recompilé au chemin froid comme une entrée périmée. Une seule exception à « TOUJOURS
  // valide » : les noms courts des propriétés `_mjs_*` SONT dans le texte de l'unité — un code
  // minifié avant qu'une réservation ne retire une de ses correspondances (`CacheEntry.mangleGen`
  // antérieur, cf. reserveInstanceNames()) appellerait le cœur de CE tour par d'anciens noms :
  // recompilé lui aussi.
  // --------------------------------------------------------------------------
  private async emitSingleFile(errors: Error[], warnings: string[]): Promise<{ written: number }> {
    let written = 0
    const finalPaths = new Map<string, string>()
    finalPaths.set('mjs_core', 'mjs:core')

    const coldQueue = new Map<string, Extract<PendingUnit, { kind: 'cold' }>>()
    // même tri par stem qu'emitPendingUnits() (jamais l'ordre d'insertion), même raison
    // (déterminisme du mangling, cf. flushPendingMinifyTasks()).
    const sortedPending = [...this.pendingUnits].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
    const staleStems: string[] = []
    for (const [stem, unit] of sortedPending) {
      if (unit.kind === 'cold') { coldQueue.set(stem, unit); continue }
      if (unit.cached.code !== undefined && unit.cached.mangleGen === this.mangleGeneration) {
        this.bundleVirtualSources.set(stem, this.withInlineSourceMap(unit.cached.code, unit.cached.map))
        finalPaths.set(stem, `mjs:unit/${stem}`)
        if (unit.cached.gen !== this.compileGeneration) this.cacheHitsThisCompile++ // pruneOrphans() — cf. son propre bandeau (toujours no-op en bundle, cf. bundleRuntime())
        written++
        continue
      }
      try {
        if (unit.file.endsWith('.mjs')) {
          await this.compileMjsCold(unit.file, stem, undefined, { silent: true })
        } else {
          const ext = (unit.file.endsWith('.civet') ? '.civet' : '.coffee') as '.civet' | '.coffee'
          const src = readFileSync(unit.file, 'utf-8')
          const importedModules: string[] = []
          for (const im of extractImportMatches(src)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_CALL_RE)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_BARE_RE)) {
            const p = im[1]
            if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
          }
          await this.compileScriptModuleCold(unit.file, ext, stem, importedModules, src)
        }
        staleStems.push(stem)
      } catch (e: any) {
        errors.push(e)
        if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
      }
    }
    if (staleStems.length > 0) {
      await this.flushPendingMinifyTasks()
      for (const stem of staleStems) {
        const fresh = this.pendingUnits.get(stem)
        if (fresh && fresh.kind === 'cold') coldQueue.set(stem, fresh)
      }
    }

    // Boucle de Kahn : identique à emitPendingUnits() dans son principe (émet dès que tous les
    // deps ont un chemin final), la SORTIE seule diffère (spécificateur virtuel en mémoire,
    // jamais writeHashed).
    let progress = true
    while (coldQueue.size > 0 && progress) {
      progress = false
      for (const [stem, unit] of [...coldQueue]) {
        if (!unit.deps.every(d => finalPaths.has(d))) continue
        let finalCode = this.resolvePlaceholders(unit.code, finalPaths)
        if (finalCode.includes('-ZZZZZZZZ.')) {
          errors.push(new Error(t('bundler.index.repere-non-resolu-emission', { unite: stem })))
          coldQueue.delete(stem)
          progress = true
          if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
          continue
        }
        // `_dir_<Classe>` (cf. bandeau de replaceDirLiteral) : seuls les composants .mjs
        // émettent cette forme — un module .civet/.coffee/le manifeste externe n'est jamais concerné.
        if (unit.file.endsWith('.mjs')) finalCode = this.replaceDirLiteral(finalCode)
        this.bundleVirtualSources.set(stem, this.withInlineSourceMap(finalCode, unit.map))
        finalPaths.set(stem, `mjs:unit/${stem}`)
        if (unit.cacheFields) {
          this.cache.set(unit.file, { ...unit.cacheFields, hashedPath: `mjs:unit/${stem}`, embeds: [], features: unit.features, gen: this.compileGeneration, code: finalCode, map: unit.map })
        }
        written++
        coldQueue.delete(stem)
        progress = true
      }
    }
    for (const [stem, unit] of coldQueue) {
      const missing = unit.deps.filter(d => !finalPaths.has(d))
      errors.push(new Error(t('bundler.index.dep-jamais-resolue', { unite: stem, deps: missing.join(', ') })))
      if (unit.file.endsWith('.mjs')) this.recoverFailedComponentManifest(unit.file, warnings)
    }

    // Résolution des repères dans this.manifest (valeurs) — même geste qu'emitPendingUnits(),
    // pour que le garde-fou générique de compile() (§15b) ne trouve plus rien à retirer : SEUL
    // l'ENSEMBLE des CLÉS sert en mode bundle (µ.paths, cf. buildBundleSetupBody()), la valeur
    // elle-même (un spécificateur virtuel) n'est plus jamais lue nulle part.
    for (const key of Object.keys(this.manifest)) {
      this.manifest[key] = this.resolvePlaceholders(this.manifest[key], finalPaths)
    }

    return { written }
  }

  // --------------------------------------------------------------------------
  // recoverFailedComponentManifest(file) : un composant .mjs qui échoue
  // à compiler CE tour n'obtient JAMAIS de nouvelle entrée this.manifest[baseName]
  // (reparti à `{}` en tête de compile()) — sans repli, µ.paths perd la clé alors
  // que le fichier hashé du build PRÉCÉDENT survit tel quel dans outputDir
  // (cleanupOldHashes ne se déclenche que sur un writeHashed RÉUSSI du même
  // baseName, jamais sur un composant en échec). Résultat AVANT ce fix : le tag
  // <mjs-baseName> reste dans le HTML, son import 404, écran blanc silencieux.
  //
  // Repêche l'entrée depuis l'ANCIEN bundle_modular.js écrit sur disque (même
  // mécanique d'extraction que le `pathsLineIdx` de writeManifest() : la ligne
  // `const µPaths = {...};` est TOUJOURS sur une seule ligne, JSON.stringify ne
  // produit aucun `\n`). `µ.paths = µPaths;` (plus loin dans le manifeste)
  // référence ce même objet — plus de JSON à CETTE ligne-là depuis la cascade de
  // modules (bundle.js n'importe plus le cœur statiquement, µPaths sert aussi au
  // préchargement AVANT que µ n'existe, cf. writeManifest). Réinjectée dans this.manifest AVANT que writeManifest()
  // ne génère publicManifest (section "4. Manifest entrypoint", plus loin dans
  // compile()) → survit naturellement à l'écriture.
  //
  // Recovery IMPOSSIBLE (pas d'ancien bundle, clé absente, fichier disparu du
  // disque, JSON illisible) → silencieux, comportement historique (entrée
  // absente), AUCUN crash, AUCUN message trompeur. Le composant récupéré n'est
  // volontairement PAS ajouté à `emittedThisCompile` : il n'apparaît donc pas
  // dans le tableau des tailles puisqu'il n'a rien produit ce tour (ni
  // écriture fraîche, ni cache hit — juste une lecture de l'ancien manifeste).
  // --------------------------------------------------------------------------
  private recoverFailedComponentManifest(file: string, warnings: string[]): void {
    // `pageAwareBaseName` peut
    // désormais REFUSER un nom de page vide (throw) : si c'est PRÉCISÉMENT pour cette raison que
    // `file` a échoué ce tour, cet appel planterait ICI, hors de tout try/catch (cf. l'appelant,
    // synchrone, dans la boucle principale de compile()) — le build ENTIER rejetterait au lieu de
    // rendre `stats.errors` proprement. Aucun repêchage n'a de sens sur un nom invalide de toute
    // façon (aucune ancienne entrée saine n'a jamais existé sous CE nom) : repli sur le basename
    // brut, pour le seul message qui suit.
    let baseName: string
    try { baseName = pageAwareBaseName(file) } catch { baseName = basename(file, '.mjs') }  // même clé que le compile réussi précédent
    // En build, aucun repêchage : l'ancienne sortie survit sur disque mais n'est plus
    // référencée, et l'erreur de compilation fait sortir le CLI en code non nul
    if (!this.keepFailedComponents) {
      warnings.push(t('bundler.index.composant-echec-non-repeche', { nom: baseName }))
      return
    }
    try {
      if (!existsSync(this.manifestPath)) return
      const raw = readFileSync(this.manifestPath, 'utf-8')
      const pathsLine = raw.split('\n').find(l => l.startsWith('const µPaths = '))
      if (!pathsLine) return
      const jsonText = pathsLine.slice('const µPaths = '.length).replace(/;$/, '')
      const oldManifest = JSON.parse(jsonText) as Record<string, string>
      const oldValue = oldManifest[baseName]
      if (!oldValue) return
      // Valeur attendue : `<baseName>-<hash hexa 8>.js`, préfixée de `<urlPrefix>/` ou
      // non — la table publie des valeurs COMPACTES (préfixe factorisé une seule fois,
      // cf. writeManifest), mais un manifeste écrit AVANT cette factorisation porte
      // encore l'URL entière : les deux formes sont acceptées, `this.manifest` reçoit
      // toujours, lui, le chemin ENTIER (c'est writeManifest qui recompacte).
      const compact = oldValue.startsWith(`${this.urlPrefix}/`) ? oldValue.slice(this.urlPrefix.length + 1) : oldValue
      const prefix = `${baseName}-`
      if (!compact.startsWith(prefix) || !compact.endsWith('.js')) return
      const hashPart = compact.slice(prefix.length, -'.js'.length)
      if (!/^[a-f0-9]{8}$/.test(hashPart)) return
      const oldFilename = `${baseName}-${hashPart}.js`
      if (!existsSync(join(this.outputDir, oldFilename))) return
      this.manifest[baseName] = `${this.urlPrefix}/${oldFilename}`
      warnings.push(t('bundler.index.composant-echec-ancienne-version', { nom: baseName, fichier: oldFilename }))
    } catch {
      // ancien manifeste/JSON corrompu ou illisible → aucun repli, silencieux
    }
  }

  // --------------------------------------------------------------------------
  // writePrecacheManifest() : `<outputDir>/mjs-precache.json`, la liste
  // des URLs publiques de TOUT ce que ce build a émis, plus l'identifiant de build.
  //
  //   { "version": "a1b2c3d4", "assets": ["/modularjs/mjs_core-….js", …] }
  //
  // Écrit à chaque build réussi, et seulement s'il change (writeIfChanged) — un build
  // sans modification ne salit pas l'arbre de travail. La `version` est celle de
  // `µ.version` : un service worker qui la compare à la sienne sait exactement quand
  // vider son cache, sans deviner.
  // PUBLIC : bundler/startup.ts émet ses fichiers de page APRÈS compile() et republie cette liste
  // pour les y faire entrer (une sortie du build absente du précache serait la seule que le service
  // worker ne mettrait pas en cache).
  // --------------------------------------------------------------------------
  writePrecacheManifest(): void {
    const assets = [...this.emittedThisCompile].sort((a, b) => a < b ? -1 : a > b ? 1 : 0).map(f => `${this.urlPrefix}/${f}`)
    const contenu = JSON.stringify({ version: this.lastBuildId ?? '', assets }, null, 2) + '\n'
    this.writeIfChanged(join(this.outputDir, 'mjs-precache.json'), contenu)
  }

  // --------------------------------------------------------------------------
  // collectSizes() : scan outputDir et retourne les tailles de chaque .js émis
  // --------------------------------------------------------------------------
  private collectSizes(): SizeReport[] {
    // mode 'bundle' — le manifeste EST la seule sortie JS (aucune unité n'est écrite à part,
    // cf. emitSingleFile()) : jamais dans emittedThisCompile (ni en mode 'split' d'ailleurs,
    // cf. writeManifest() — ce filet ne couvre que writeHashed()/resolveOneAsset()), donc jamais
    // vu par la boucle générique ci-dessous. Sans ce cas à part, `mjs build` en bundle annonçait
    // « N fichiers écrits » avec un tableau de tailles TOUJOURS VIDE — la seule sortie JS existante
    // ne méritait alors aucune ligne, quand elle est justement celle qui compte le plus ici.
    const out: SizeReport[] = []
    if (this.jsMode === 'bundle' && existsSync(this.manifestPath)) {
      const stat = statSync(this.manifestPath)
      if (stat.isFile()) {
        const sameDir = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b) } catch { return a === b } }
        const name = basename(this.manifestPath).replace(/\.js$/, '')
        const path = sameDir(dirname(this.manifestPath), this.outputDir) ? `${this.urlPrefix}/${basename(this.manifestPath)}` : basename(this.manifestPath)
        out.push({ name, path, bytes: stat.size })
      }
    }
    if (!existsSync(this.outputDir)) return out
    for (const f of readdirSync(this.outputDir)) {
      if (!f.endsWith('.js')) continue
      // Seulement les fichiers ÉMIS PENDANT ce compile() : sinon un
      // composant en échec ce tour (jamais réécrit) réapparaît dans le tableau
      // via son ANCIEN fichier hashé, toujours présent sur disque (survivant,
      // cf. recoverFailedComponentManifest) mais pas une émission de ce tour.
      if (!this.emittedThisCompile.has(f)) continue
      const full = join(this.outputDir, f)
      const stat = statSync(full)
      if (!stat.isFile()) continue
      const name = f.replace(/-[a-f0-9]{8}\.js$/, '').replace(/\.js$/, '')
      out.push({
        name,
        path: `${this.urlPrefix}/${f}`,
        bytes: stat.size,
      })
    }
    out.sort((a, b) => b.bytes - a.bytes)
    return out
  }

  // --------------------------------------------------------------------------
  // locateRuntimeDir() : cherche `runtime/` à plusieurs emplacements possibles.
  // Couvre :
  //  - dev (tsx) : src/bundler/index.ts → ../runtime/ = src/runtime/
  //  - prod (dist bundlé) : dist/cli.js → ../src/runtime/ = src/runtime/
  //  - install npm : node_modules/<pkg>/dist/cli.js → ../src/runtime/
  // --------------------------------------------------------------------------
  private locateRuntimeDir(): string {
    // `URL.pathname` renvoie le chemin
    // PERCENT-ENCODÉ (un espace devient `%20`, un accent `é` devient
    // `%C3%A9`) — PAS le chemin filesystem décodé. Si ModularJS (ou le
    // projet qui l'installe, ex. `node_modules`) vit sous un chemin avec
    // espace/accent (courant : profil utilisateur "José Martínez", "Program
    // Files"), `existsSync(candidate)` ci-dessous testait une string bidon
    // qui ne correspond à AUCUN dossier réel → échouait TOUJOURS, même quand
    // le dossier existe vraiment. `fileURLToPath` décode correctement
    // (et gère aussi les differences de plateforme, ex. lettre de lecteur
    // Windows).
    const candidates = [
      fileURLToPath(new URL('../runtime/', import.meta.url)),
      fileURLToPath(new URL('../src/runtime/', import.meta.url)),
      fileURLToPath(new URL('../../src/runtime/', import.meta.url)),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    // Fallback : retourne le premier (cohérent avec l'ancien comportement,
    // l'erreur sera plus claire au moment de bundleRuntime quand on listera 0 fichier)
    return candidates[0]
  }

  // --------------------------------------------------------------------------
  // locateCoreModulesDir() : cherche `core-modules/` (catalogue des
  // modules cœur `<@mjs-nom>`) — jumeau exact de locateRuntimeDir() (mêmes
  // 3 emplacements dev/prod/npm, même raison fileURLToPath), résolu
  // relativement au PAQUET ModularJS, jamais au projet compilé.
  // --------------------------------------------------------------------------
  private locateCoreModulesDir(): string {
    const candidates = [
      fileURLToPath(new URL('../core-modules/', import.meta.url)),
      fileURLToPath(new URL('../src/core-modules/', import.meta.url)),
      fileURLToPath(new URL('../../src/core-modules/', import.meta.url)),
    ]
    for (const c of candidates) {
      if (existsSync(c)) return c
    }
    return candidates[0]
  }

  // --------------------------------------------------------------------------
  // directImportDepKeys(content) : clés de manifest CANDIDATES pour les cibles
  // `@import nom 'chemin'` DIRECTES de ce fichier (jamais la fermeture transitive —
  // cf. collectTransitiveImportClosure, réservée au hash de cache) — basename du
  // chemin, extension `.civet`/`.coffee`/`.mjs` retirée (seules extensions qui
  // publient une clé `this.manifest[basename]`, cf. section 3 de compile() et
  // resolveOneAsset). Une clé qui ne correspond à AUCUNE entrée du manifeste
  // (extension différente, asset binaire, cible introuvable) est filtrée PLUS
  // TARD par buildManifestDeps() — jamais ici, qui reste un simple candidat.
  // Réutilise `extractImportMatches` (déjà masqué <pre>/<code>, même garde que
  // preResolveAssets) : aucune nouvelle logique de scan, une seule source de vérité.
  // --------------------------------------------------------------------------
  private directImportDepKeys(content: string): string[] {
    const keys: string[] = []
    for (const im of extractImportMatches(content)) {
      const target = im[1]
      if (/^https?:\/\//.test(target)) continue
      keys.push(basename(target).replace(/\.(civet|coffee|mjs)$/, ''))
    }
    return keys
  }

  // --------------------------------------------------------------------------
  // resolveTagShortcuts(errors, warnings) : post-passe de validation du
  // raccourci UNIQUE <@nom> (résolution PROJET PUIS CŒUR, l'ancienne
  // notation dédiée <@mjs-nom> est une erreur de migration) et des balises
  // littérales mjs-*/mjs-core-*, appelée APRÈS que `this.manifestSources`
  // contient tout le projet (seul point où l'union des composants est connue —
  // un fichier isolé ne la connaît pas, cf. `pendingTagRefs`). Compile
  // TRANSITIVEMENT les modules cœur référencés (catalogue coreModulesDir), sous
  // leur nom PLAT (plus de préfixe `core-`) — par construction un module cœur
  // n'est compilé que si le projet n'a PAS de composant homonyme (résolution
  // ci-dessus), aucune collision de manifeste possible. Erreurs ACCUMULÉES puis
  // un seul throw agrégé (poussé dans `errors`, jamais un throw direct — même
  // politique que le reste de compile()) ; avertissements poussés un par un
  // dans `warnings` (patron animation-inconnue).
  // --------------------------------------------------------------------------
  private async resolveTagShortcuts(errors: Error[], warnings: string[]): Promise<number> {
    const problems: string[] = []
    let compiledCount = 0

    // a/b — garde-fous sur les fichiers du PROJET (basename OU alias court) :
    // AUCUNE balise réservée, AUCUN préfixe 'core-' (réservé aux modules cœur
    // ajoutés à this.manifestSources PLUS BAS, donc jamais vus par CETTE boucle).
    // Le BASENAME (manifestKinds === 'basename', nom de fichier réel,
    // non négociable) reste une ERREUR DURE, inchangé. Un ALIAS COURT (kind
    // 'shortName' ou 'poisoned', cf. claimShortName) n'est qu'un confort : il
    // CÈDE en silence (retiré du manifeste ET du pool de résolution
    // `manifestNames` construit juste plus bas) + un simple avertissement —
    // jamais une erreur qui bloquerait tout le projet pour un raccourci.
    // Le composant reste joignable par son basename complet (claimBasename,
    // jamais touché ici) ; côté aliasTag/customElements.define, le même repli
    // est déjà appliqué en amont (_compileMjsInner, isReservedShortcutName).
    for (const [key, file] of this.manifestSources) {
      if (!this.isReservedShortcutName(key)) continue
      const lower = key.toLowerCase()
      if (this.manifestKinds.get(key) === 'basename') {
        if (AT_RESERVED_NAMES.includes(lower)) {
          problems.push(t('bundler.index.tag-nom-reserve', { fichier: file, nom: key }))
        } else if (lower.startsWith('mjs-')) {
          problems.push(t('bundler.index.tag-nom-mjs-prefixe', { fichier: file, nom: key, propre: key.slice(4) }))
        } else {
          problems.push(t('bundler.index.tag-nom-core-prefixe', { fichier: file, nom: key }))
        }
      } else {
        delete this.manifest[key]
        this.manifestSources.delete(key)
        this.manifestKinds.delete(key)
        // préfixe `mjs-` : l'alias part SANS un mot. Il était de toute façon injoignable
        // (`<@mjs-x>` est une erreur de migration), et un fichier
        // légitimement nommé `tuto-mjs-window.mjs` en fabrique un à chaque fois : mesuré sur
        // le site de doc, 20 alias × 7 passes = 140 lignes d'avertissement sur lesquelles
        // l'auteur n'a rien à faire. Les autres cas (nom réservé, `core-`) parlent toujours.
        if (!lower.startsWith('mjs-')) warnings.push(t('bundler.index.tag-alias-reserve-ignore', { fichier: file, nom: key }))
      }
    }

    // Union manifeste (basenames + alias courts), comparaison en minuscules.
    const manifestNames = new Set(Array.from(this.manifestSources.keys(), (k) => k.toLowerCase()))

    // Alias courts EMPOISONNÉS (deux composants se les disputent, claimShortName) : ils sont
    // dans `manifestSources` — donc dans `manifestNames` ci-dessus — mais PUBLIÉS PAR PERSONNE,
    // et le transpileur n'enregistre plus la balise courte quand le manifeste ne porte pas sa
    // clé. Une balise littérale qui l'écrit est donc aussi inerte qu'une faute de frappe : elle
    // mérite le même avertissement, en nommant les rivaux. Relevé APRÈS la boucle ci-dessus (un
    // alias au nom réservé y perd son kind, il parle déjà par sa propre voie).
    const aliasAmbigus = new Map<string, string[]>()
    for (const [key, noms] of this.poisonedAliasSources) {
      if (this.manifestKinds.get(key) === 'poisoned') aliasAmbigus.set(key.toLowerCase(), noms)
    }

    // Catalogue cœur — scan à plat de coreModulesDir (même filtre `_partial` que mjsFiles).
    const coreCatalogFiles = this.findFiles(this.coreModulesDir, ['.mjs'])
      .filter((f) => !basename(f, '.mjs').startsWith('_'))
    const coreCatalog = new Map<string, string>()  // nom (minuscule) → filePath
    for (const f of coreCatalogFiles) coreCatalog.set(basename(f, '.mjs').toLowerCase(), f)

    // Union de suggestion (règle d) : réservées + cœur + projet, avec leur nature
    // (codes internes consommés par la clé 'bundler.index.tag-suggestion').
    type Candidate = { compareName: string; displayName: string; nature: 'reservee' | 'coeur' | 'projet' }
    // Départage à distance ÉGALE : projet d'abord (cas le plus probable), puis réservée, puis cœur
    const suggestionPool: Candidate[] = [
      ...Array.from(manifestNames, (n): Candidate => ({ compareName: n, displayName: n, nature: 'projet' })),
      ...AT_RESERVED_NAMES.map((n): Candidate => ({ compareName: n, displayName: n, nature: 'reservee' })),
      ...Array.from(coreCatalog.keys(), (n): Candidate => ({ compareName: n, displayName: n, nature: 'coeur' })),
    ]
    const suggestTagCandidate = (name: string): Candidate | null => {
      let best: Candidate | null = null
      let bestDist = Infinity
      for (const c of suggestionPool) {
        const d = levenshtein(name, c.compareName)
        if (d < bestDist) { bestDist = d; best = c }
      }
      return best !== null && bestDist <= 2 ? best : null
    }

    // Modules cœur déjà compilés/en attente — la transitivité boucle jusqu'au
    // point fixe (un module cœur peut référencer <@autre>).
    const neededCore = new Set<string>()
    const compiledCore = new Set<string>()

    // processRefs — résout un lot de références (dev initial, puis chaque
    // module cœur nouvellement compilé) — MÊME résolution projet-puis-cœur
    // qu'elle vienne d'un fichier projet ou d'un module cœur (la règle
    // « un module cœur ne référence que du cœur » disparaît — c'est le
    // mécanisme d'override, un module projet homonyme prime toujours, même
    // consommé depuis un module cœur).
    const processRefs = (refs: { file: string; name: string; kind: TagRefKind }[]): void => {
      for (const ref of refs) {
        const lname = ref.name.toLowerCase()
        switch (ref.kind) {
          case 'raccourci-mjs-retire':
            problems.push(t('bundler.index.tag-raccourci-mjs-retire', { fichier: ref.file, nom: ref.name }))
            break
          case 'litteral-coeur':
            problems.push(t('bundler.index.tag-coeur-litterale-interdite', { fichier: ref.file, tag: `mjs-core-${ref.name}`, nom: ref.name }))
            break
          case 'raccourci-dev':
            if (manifestNames.has(lname)) {
              // résolu par le projet — rien à faire
            } else if (coreCatalog.has(lname)) {
              if (!compiledCore.has(lname)) neededCore.add(lname)
            } else {
              const suggestion = suggestTagCandidate(lname)
              const hint = suggestion ? t('bundler.index.tag-suggestion', { nom: suggestion.displayName, nature: suggestion.nature }) : ''
              problems.push(t('bundler.index.tag-dev-inconnu', { fichier: ref.file, nom: ref.name }) + hint)
            }
            break
          case 'litteral-dev':
            if (aliasAmbigus.has(lname)) {
              const rivaux = aliasAmbigus.get(lname) as string[]
              warnings.push(t('bundler.index.tag-alias-ambigu', { fichier: ref.file, tag: `mjs-${ref.name}`, sources: rivaux.join(', '), premier: rivaux[0] }))
            } else if (manifestNames.has(lname)) {
              // résolu par le projet — rien à faire
            } else if (coreCatalog.has(lname)) {
              if (!compiledCore.has(lname)) neededCore.add(lname)
            } else {
              warnings.push(t('bundler.index.tag-litteral-dev-inconnue', { fichier: ref.file, tag: `mjs-${ref.name}` }))
            }
            break
        }
      }
    }

    processRefs(this.pendingTagRefs)

    // Transitivité — compile chaque module cœur nouvellement requis (résolution
    // projet-puis-cœur : jamais atteint si le projet a déjà ce nom, donc aucune
    // collision possible sur la clé PLATE écrite plus bas), scanne SES propres
    // références (poussées dans this.pendingTagRefs par _compileMjsInner
    // pendant l'await juste en dessous), boucle jusqu'à ce qu'aucun nouveau nom
    // n'apparaisse (point fixe).
    while (neededCore.size > 0) {
      const batch = Array.from(neededCore)
      neededCore.clear()
      for (const name of batch) {
        if (compiledCore.has(name)) continue
        compiledCore.add(name)
        const coreFilePath = coreCatalog.get(name)!
        const beforeLen = this.pendingTagRefs.length
        try {
          // Nom PLAT (plus de préfixe `core-`) : tag mjs-<nom>, comme un composant projet.
          const hashedPath = await this.compileMjs(coreFilePath, name)
          this.manifest[name] = hashedPath
          this.manifestSources.set(name, coreFilePath)
          this.manifestKinds.set(name, 'basename')
          compiledCount++
        } catch (e: any) {
          problems.push(t('bundler.index.erreur-fichier', { fichier: coreFilePath, raison: e?.message ?? e }))
          continue
        }
        processRefs(this.pendingTagRefs.slice(beforeLen))
      }
    }

    // variants — layout="x"/template="x" LITTÉRAL (jamais une valeur dynamique,
    // cf. TagRef.layoutLiteral posé par parser/index.ts) dont le nom n'est pas une
    // variant connu du module ciblé. Volontairement APRÈS le point fixe cœur
    // ci-dessus : this.pendingLayoutNames est ENTIER (modules cœur transitifs compris),
    // l'ordre des fichiers n'a donc aucune importance. Restreint aux DEUX kinds qui
    // désignent un composant (raccourci-dev/litteral-dev) et dont la balise résout
    // réellement (manifestNames OU coreCatalog) — sinon la validation de balise ci-dessus
    // s'en charge déjà, jamais de message en double. Silencieux aussi si le module cible
    // ne déclare AUCUN variant (repli historique du fichier CSS déposé à la main).
    for (const ref of this.pendingTagRefs) {
      if (ref.layoutLiteral === undefined) continue
      if (ref.kind !== 'raccourci-dev' && ref.kind !== 'litteral-dev') continue
      const lname = ref.name.toLowerCase()
      if (!manifestNames.has(lname) && !coreCatalog.has(lname)) continue
      const known = this.pendingLayoutNames.get(lname)
      if (!known || known.has(ref.layoutLiteral)) continue
      const tagDisplay = ref.kind === 'raccourci-dev' ? `@${ref.name}` : `mjs-${ref.name}`
      problems.push(t('bundler.index.tag-layout-litteral-inconnue', {
        fichier: ref.file,
        tag:     tagDisplay,
        nom:     ref.layoutLiteral,
        connus:  Array.from(known).join(', '),
      }))
    }

    // dédup — une même faute de frappe référencée plusieurs fois (ou depuis
    // plusieurs fichiers avec exactement le même message) ne doit pas répéter
    // la ligne (même hygiène que `uniqueUpdates`, generator/compile.ts).
    const uniqueProblems = Array.from(new Set(problems))
    if (uniqueProblems.length > 0) {
      errors.push(new Error(uniqueProblems.join('\n')))
    }
    return compiledCount
  }

  // --------------------------------------------------------------------------
  // buildManifestDeps() : résout `this.pendingComponentDeps` (noms bruts, un
  // par composant) contre `this.manifestSources` (union PROJET + modules cœur
  // transitifs, complète seulement APRÈS resolveTagShortcuts) — mêmes règles de
  // résolution que processRefs ci-dessus (comparaison en minuscules, clé RÉELLE
  // du manifeste conservée). Un nom candidat absent du manifeste (raccourci
  // inconnu, cible @import qui ne compile pas, faute de frappe dans un exemple
  // de doc non filtré) est silencieusement écarté ICI — resolveTagShortcuts()
  // (déjà passé à ce stade) a son propre avertissement/erreur pour ces cas, ce
  // n'est pas le rôle de la table de préchargement de les re-signaler.
  //
  // Entrées TRIÉES (clés ET valeurs, par point de code, même raison que
  // publicManifest en writeManifest()) : deux builds du même code doivent
  // produire la MÊME table, à l'octet près. Un composant SANS dépendance
  // n'entre pas dans la table (repli implicite = tableau vide côté runtime).
  // --------------------------------------------------------------------------
  private buildManifestDeps(): Record<string, string[]> {
    const lowerToKey = new Map<string, string>()
    for (const key of this.manifestSources.keys()) lowerToKey.set(key.toLowerCase(), key)
    const table: Record<string, string[]> = {}
    for (const entry of this.pendingComponentDeps) {
      const resolved = new Set<string>()
      for (const raw of entry.deps) {
        const real = lowerToKey.get(raw.toLowerCase())
        if (real && real !== entry.moduleName) resolved.add(real)
      }
      if (resolved.size === 0) continue
      table[entry.moduleName] = Array.from(resolved).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    }
    return Object.fromEntries(Object.entries(table).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
  }

  // hasI18nConfigured() : MÊMES signaux que scanI18n() (`config.i18n` renseigné
  // OU `sourceDir/i18n/` présent) — vérif bon marché (pas de parsing), utilisée
  // par resolveRuntimeFiles() pour décider si mjs_i18n.ts entre dans 'all'.
  // Appelée AVANT scanI18n() dans compile() (bundleRuntime précède scanI18n) :
  // ne dépend PAS de `this.i18nManifestData`, relit le disque directement.
  private hasI18nConfigured(): boolean {
    if (this.i18n !== undefined) return true
    const i18nDir = join(this.sourceDir, 'i18n')
    return existsSync(i18nDir) && statSync(i18nDir).isDirectory()
  }

  // --------------------------------------------------------------------------
  // resolveRuntimeFiles() : sélection des modules du bundle `mjs_core.js`
  // (tree-shake EXPLICITE, opt-in). Le CŒUR (4 modules, jamais retirables) est
  // toujours inclus ; les optionnels selon `runtime` (défaut 'all'), avec
  // rétrocompat `minimalRuntime` (≡ 'core'). Pure et testable : retourne la
  // liste ORDONNÉE de fichiers (hors mjs_debug, inséré à part par bundleRuntime)
  // + avertissements ergonomiques non-bloquants + `coreOnly` (aucun optionnel →
  // bundle taille-critique, pas de mjs_debug — ne regarde QUE les optionnels
  // classiques, cf. le calcul de `coreOnly` en fin de méthode).
  //
  // `mjs_vt_presets.ts`, `mjs_title.ts`, `mjs_store.ts` et `mjs_interpolate.ts`,
  // longtemps rattachés au CŒUR d'office, ne le sont PLUS : « on met tout,
  // c'est au build qu'on ne met que ce qu'on détecte ». Deux logiques
  // distinctes : `mjs_vt_presets.ts` suit une règle de CONFIGURATION pure,
  // AUCUN scan — inclus si `router` OU `ujs` est sélectionné (ses deux seuls
  // consommateurs, `µ._mjs_vtApplyPreset`), ou demandé explicitement (`runtime:
  // [..., 'vt_presets']`). `mjs_title.ts`, `mjs_store.ts` (classe `µStore`/
  // `µ.Store`) et `mjs_interpolate.ts` (`µinterpolate`/`µ.interpolate`) sont
  // DÉTECTÉS à l'usage : `used` (le Set rendu par
  // `collectUsedFeatures()`, union des signaux compilés de toutes les unités du tour) doit contenir
  // `'title'`/`'store'`/`'interpolate'` respectivement, ou le module est
  // demandé explicitement (`runtime: [..., 'title'|'store'|'interpolate']`) —
  // SANS argument (API directe, tests existants inclus), faits inconnus = on
  // GARDE. La doctrine « config-driven, pas d'auto-détection par scan de
  // code » (cf. `hasI18nConfigured()` plus bas, pour `mjs_i18n.ts`) reste
  // vraie pour i18n — ces trois-là en sont l'exception assumée, pas un
  // relâchement général de la règle. Aucun autre module (optionnel ou cœur)
  // n'appelle `µ.Store`/`µ.interpolate` en interne aujourd'hui (vérifié,
  // `µspring`/`µsmooth` partagent juste le registre `µ._mjs_interpolatorSet` de
  // mjs_init.ts, sans dépendre du FICHIER mjs_interpolate.ts) : le jour où
  // l'un en dépendrait, sa sélection devrait forcer la présence du dépendant,
  // même principe que `wantsVt` pour `router`/`ujs`.
  //
  // L'entrée utilisateur réelle (mjs.config.json → clé `runtime`) est validée
  // STRICTEMENT en amont (config.ts). Ici on reste défensif pour l'API directe
  // (tests, intégrations) : un nom inconnu est ignoré AVEC avertissement — jamais
  // un crash, jamais un module fantôme (fail-safe).
  // --------------------------------------------------------------------------
  resolveRuntimeFiles(used?: ReadonlySet<string>): { files: string[]; warnings: string[]; coreOnly: boolean } {
    const warnings: string[] = []
    // Ordre CANONIQUE de concaténation — porte aussi les gardes de patch
    // prototype : mjs_flip DOIT rester APRÈS mjs_element (qui définit µ.Element).
    // mjs_vt_presets (bibliothèque de préréglages @viewTransition) DOIT précéder
    // mjs_router ET mjs_ujs — ses deux consommateurs (routeur = <@view>, UJS =
    // permutation de PAGE) appellent tous deux `µ._mjs_vtApplyPreset` (plus
    // dans CORE, mais reste dans CANONICAL à cette position — sa présence
    // dépend de `wantsVt`, calculé après la sélection, en fin de méthode).
    // mjs_title (@title) reste à sa position historique juste APRÈS
    // mjs_element, comme mjs_flip : le hook d'attache par racine
    // (µ._mjs_titleAttach) est appelé par mjs_element.ts au constructor, mais la
    // garde `typeof µ._mjs_titleAttach === 'function'` le rend robuste à l'ordre —
    // sa présence dépend de `wantsTitle` (même fin de méthode). En 'all'
    // (avec router+ujs, i18n configuré) le résultat reste BYTE-identique à
    // l'historique.
    // mjs_dom.ts (µ._p/µ._tm/µ._def, navigation DOM et enregistrement de balise du code compilé)
    // juste après mjs_init.ts : le code émis pour la racine, pour les branches {if}/{await}/{key} et
    // pour la définition de N'IMPORTE quel composant peut les citer, aucun scan ne saurait donc le
    // rendre optionnel — toujours joint, comme le cœur.
    // mjs_alias.ts (µ._al, alias COURT d'un composant) juste derrière, à la position d'origine de
    // l'aide (elle vivait en fin de mjs_dom.ts) : elle n'est appelée que par le code émis d'un
    // composant qui porte un nom court, jamais par un autre module — seule sa présence compte.
    // mjs_deep.ts/mjs_textpool.ts/mjs_esc.ts (familles de fonctions `µ._x` détachées de
    // mjs_init.ts) juste après lui, à leur position d'origine : chacune est appelée par du code
    // ÉMIS (mutation profonde, placeholder impératif, interpolation de `<@head>`/`<@failed>`),
    // jamais par un autre module du runtime — l'ordre n'a donc aucune importance, seule leur
    // présence compte.
    // mjs_autoloader.ts (µ.Autoloader — découverte des balises `mjs-*` du document, import à la
    // demande du fichier haché de chaque composant) : du cœur en 'split', OÙ CHAQUE COMPOSANT EST
    // UN FICHIER À ALLER CHERCHER. En 'bundle' il n'a plus rien à charger — le fichier unique
    // exécute lui-même le `customElements.define` de CHAQUE composant du projet avant de rendre la
    // main, et `µ.paths` n'y pointe que ce même fichier. Retiré du cœur DANS CE SEUL MODE ;
    // `runtime: ['autoloader']` le remet (cf. `wantsByFile` en fin de méthode). La balise `mjs-*`
    // inconnue qu'il rejetait est signalée par le point d'entrée du fichier unique
    // (cf. buildBundleEntry()).
    const CORE = this.jsMode === 'bundle'
      ? ['mjs_init.ts', 'mjs_dom.ts', 'mjs_runes.ts', 'mjs_element.ts']
      : ['mjs_init.ts', 'mjs_dom.ts', 'mjs_runes.ts', 'mjs_autoloader.ts', 'mjs_element.ts']
    // Balises globales/dynamiques et runes détachées du cœur, chacune dans son propre
    // fichier : `mjs_ticker.ts` (µ.Ticker) tôt, avant ses 3 consommateurs possibles
    // (interpolate/spring/smooth) ; `mjs_rare_runes.ts`/`mjs_head.ts`/`mjs_body.ts`/
    // `mjs_dynamic.ts`/`mjs_effect.ts`/`mjs_every.ts` à la position historique de
    // mjs_runes.ts (dont ils viennent) ; `mjs_hydrate.ts`/`mjs_html.ts`/`mjs_slots.ts`/`mjs_on.ts` (patchs `µ.Element.prototype`,
    // même technique que mjs_flip) et `mjs_failed.ts` APRÈS mjs_element.ts. Les 4 blocs
    // structurels du gabarit (`mjs_for.ts`/`mjs_if.ts`/`mjs_key.ts`/`mjs_await.ts`, eux
    // aussi issus de mjs_element.ts) suivent, dans CET ordre : `if` d'abord (base commune
    // à `key`/`await`), puis `key`, puis `for` (indépendant), puis `await` — et TOUS AVANT
    // mjs_flip.ts, qui capture `_mjs_reconcileList` (mjs_for.ts) à son propre chargement.
    const CANONICAL = [
      // mjs_theme.ts juste après mjs_init.ts : sa position d'origine, avant que le bloc
      // n'en soit détaché (le thème embarqué vivait en fin de mjs_init.ts).
      // mjs_page_cache.ts DOIT précéder mjs_router.ts ET mjs_ujs.ts : mjs_ujs.ts construit
      // `µ.pageCache = new µ.LRUCache(10)` à SON PROPRE CHARGEMENT (top-level, pas dans une
      // fonction) — LRUCache doit déjà exister à cet instant.
      'mjs_init.ts', 'mjs_dom.ts', 'mjs_alias.ts', 'mjs_deep.ts', 'mjs_textpool.ts', 'mjs_esc.ts', 'mjs_theme.ts', 'mjs_lazy_css.ts', 'mjs_page_cache.ts', 'mjs_ticker.ts', 'mjs_vt_presets.ts', 'mjs_easing.ts', 'mjs_interpolate.ts', 'mjs_spring.ts', 'mjs_smooth.ts',
      'mjs_store.ts', 'mjs_runes.ts', 'mjs_rare_runes.ts', 'mjs_head.ts', 'mjs_body.ts', 'mjs_dynamic.ts', 'mjs_effect.ts', 'mjs_every.ts', 'mjs_store_globals.ts', 'mjs_i18n.ts', 'mjs_journal.ts', 'mjs_ajax.ts', 'mjs_socket.ts', 'mjs_schema.ts', 'mjs_optimistic.ts', 'mjs_game.ts', 'mjs_chat.ts', 'mjs_accounts.ts', 'mjs_lobby.ts',
      'mjs_interp.ts', 'mjs_predict.ts', 'mjs_det.ts', 'mjs_lockstep.ts', 'mjs_router.ts',
      'mjs_modal.ts', 'mjs_ujs.ts', 'mjs_autoloader.ts', 'mjs_element.ts', 'mjs_hydrate.ts', 'mjs_html.ts', 'mjs_slots.ts', 'mjs_title.ts', 'mjs_on.ts', 'mjs_emit.ts', 'mjs_context.ts', 'mjs_lifecycle.ts', 'mjs_layout_variant.ts', 'mjs_destroy_hooks.ts', 'mjs_failed.ts',
      'mjs_if.ts', 'mjs_key.ts', 'mjs_for.ts', 'mjs_for_nested.ts', 'mjs_await.ts', 'mjs_flip.ts',
    ]
    // Exception de nommage : la clé de config PUBLIQUE `runtime: ['vault']` reste
    // inchangée (rétrocompat mjs.config.json), mais le fichier qu'elle sélectionne
    // a été renommé mjs_vault.ts → mjs_store_globals.ts (contenu qui n'a plus rien
    // d'un « vault » depuis longtemps). Sans cette exception, la dérivation
    // générique `mjs_<clé>.ts` chercherait un fichier qui n'existe plus.
    const moduleFile = (m: string) => m === 'vault' ? 'mjs_store_globals.ts' : 'mjs_' + m + '.ts'
    const allOptional = () => new Set(OPTIONAL_RUNTIME_MODULES.map(moduleFile))
    // Fichiers de TOUS les modules DÉTECTÉS (title/vt_presets/store/interpolate et les
    // balises/runes détachées plus récemment) — DÉRIVÉ de DETECTED_CORE_MODULES (config.ts),
    // jamais une 2e liste à maintenir à la main.
    const DETECTED_FILES = new Set(DETECTED_CORE_MODULES.map(moduleFile))

    let selected: Set<string>
    // Noms DÉTECTÉS demandés EXPLICITEMENT (`runtime: [..., 'title'|'vt_presets']`) :
    // jamais dans `selected` (ni CŒUR ni optionnel classique), mais forcent `wantsTitle`/
    // `wantsVt` (et tous les équivalents des autres modules détectés) en fin de méthode
    // quelle que soit la sélection par ailleurs.
    const forced = new Set<string>()
    const rt = this.runtime
    if (rt === undefined) {
      // pas de `runtime` explicite → dérivé de `minimalRuntime` (rétrocompat).
      selected = this.minimalRuntime ? new Set() : allOptional()
      if (!this.minimalRuntime && !this.hasI18nConfigured()) { selected.delete('mjs_i18n.ts') }
    } else if (rt === 'all') {
      selected = allOptional()
      // mjs_i18n.ts est dans CANONICAL donc dans le cœur de
      // TOUT projet en 'all' par défaut, même sans i18n (+22 Ko constatés) : ça
      // casse l'invariant « all = byte-identique » pour les projets sans i18n.
      // Config-driven, PAS d'auto-détection par scan de code (doctrine du
      // projet) : exclu de 'all' seulement si NI config.i18n NI sourceDir/i18n/
      // n'existent (mêmes signaux que scanI18n()). Sélection EXPLICITE
      // (`runtime: ['i18n', …]`) plus haut/bas ignore ce filtre : l'explicite
      // gagne toujours, même sans dossier i18n/ (fallback runtime déjà inerte).
      if (!this.hasI18nConfigured()) { selected.delete('mjs_i18n.ts') }
    } else if (rt === 'core') {
      selected = new Set()
    } else {
      selected = new Set()
      for (const m of rt) {
        const file = moduleFile(m)
        // Modules DÉTECTÉS explicites (title/vt_presets/store/interpolate et les balises/
        // runes détachées plus récemment) : traités À PART, AVANT le test CORE.includes
        // (ils n'y sont plus) — voir wantsVt/wantsTitle/wantsStore/wantsInterpolate (et tous
        // les autres) en fin de méthode.
        if (DETECTED_FILES.has(file)) { forced.add(file); continue }
        if (CORE.includes(file)) continue  // déjà dans le cœur, no-op
        if (CANONICAL.includes(file)) { selected.add(file); continue }
        warnings.push(t('bundler.index.runtime-module-inconnu-ignore', { module: m, modules: OPTIONAL_RUNTIME_MODULES.join(', ') }))
      }
      // Ergonomie : `ujs` pilote la nav via µ.Router/µ.ajax (refs GARDÉES → pas
      // de crash sans eux, mais interception inerte). On informe, on ne force rien.
      if (selected.has('mjs_ujs.ts') && !selected.has('mjs_router.ts')) {
        warnings.push(t('bundler.index.runtime-hint-ujs'))
      }
      // Ergonomie : `game` patche MjsSocket.prototype (mjs_game.ts, garde `typeof
      // MjsSocket !== 'undefined'` — jamais un crash sans lui) : sans 'socket', sock.game
      // reste indéfini pour de bon, aucun message ne peut jamais arriver côté client.
      if (selected.has('mjs_game.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-game'))
      }
      // Ergonomie (mjs-ws/chat.ts) — MÊME esprit que 'game' ci-dessus : mjs_chat.ts
      // patche MjsSocket.prototype (garde `typeof MjsSocket !== 'undefined'` — jamais un crash sans
      // lui) : sans 'socket', sock.chat reste indéfini pour de bon, aucune trame chat:* ne peut
      // jamais arriver côté client.
      if (selected.has('mjs_chat.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-chat'))
      }
      // Ergonomie (mjs-ws/accounts.ts) — MÊME esprit que 'chat'/'game'
      // ci-dessus : mjs_accounts.ts patche MjsSocket.prototype (garde `typeof MjsSocket !== 'undefined'`
      // — jamais un crash sans lui) : sans 'socket', sock.account reste indéfini pour de bon.
      if (selected.has('mjs_accounts.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-accounts'))
      }
      // Ergonomie (mjs-ws/lobby.ts) — MÊME esprit que 'chat'/
      // 'accounts' ci-dessus : mjs_lobby.ts patche MjsSocket.prototype (garde `typeof MjsSocket !==
      // 'undefined'` — jamais un crash sans lui) : sans 'socket', sock.lobby reste indéfini pour de
      // bon, aucune trame lobby:* ne peut jamais arriver côté client.
      if (selected.has('mjs_lobby.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-lobby'))
      }
      // Ergonomie — MÊME esprit que 'game' ci-dessus : mjs_schema.ts patche
      // MjsSocket.prototype ET quelques points d'extension de mjs_socket.ts (hello, binaire) pour
      // brancher µschema au réseau. Contrairement à mjs_game.ts, mjs_schema.ts n'est PAS gardé par
      // `typeof MjsSocket !== 'undefined'` — µ.schema()/µ.list()/µ.bits() (registre pur) restent
      // utilisables SEULS, cf. son en-tête — seul le branchement réseau reste inerte sans 'socket'.
      if (selected.has('mjs_schema.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-schema'))
      }
      // Ergonomie — MÊME esprit que 'schema' ci-dessus : mjs_optimistic.ts
      // n'a AUCUNE dépendance dure à MjsSocket (`via` accepte n'importe quelle fonction -> Promise,
      // cf. sa tête de fichier) — reste utilisable SEUL (ex. via: -> fetch(...)) — mais son usage
      // TYPIQUE documenté est sock.request() : sans 'socket', µ.optimistic() reste utilisable mais
      // jamais branché au réseau MJS.
      if (selected.has('mjs_optimistic.ts') && !selected.has('mjs_socket.ts')) {
        warnings.push(t('bundler.index.runtime-hint-optimistic'))
      }
      // Ergonomie — MÊME esprit que 'game'/'schema' ci-dessus :
      // mjs_interp.ts/mjs_predict.ts n'ont AUCUNE dépendance dure (pas de patch prototype, cf. leurs
      // têtes de fichier), mais n'ont RIEN à observer sans une poignée sock.game() — 'game' absent
      // rend µ.interp()/µ.predict() inertes en pratique (aucun `partie` à leur passer).
      if (selected.has('mjs_interp.ts') && !selected.has('mjs_game.ts')) {
        warnings.push(t('bundler.index.runtime-hint-interp'))
      }
      if (selected.has('mjs_predict.ts') && !selected.has('mjs_game.ts')) {
        warnings.push(t('bundler.index.runtime-hint-predict'))
      }
      // Ergonomie — MÊME esprit que 'interp'/'predict' ci-
      // dessus : mjs_lockstep.ts n'a AUCUNE dépendance dure (patron 'schema'), mais n'a RIEN à piloter
      // sans une poignée sock.game() ('game' absent = µ.lockstep() inerte en pratique), NI de graine
      // déterministe sans µ.random (mjs_det.ts, module 'det' — garde `typeof µ.random === 'function'`
      // à l'exécution, cf. mjs_lockstep.ts tête de fichier : jamais un crash au CHARGEMENT, mais
      // µ.lockstep resterait indéfini pour de bon).
      if (selected.has('mjs_lockstep.ts') && !selected.has('mjs_game.ts')) {
        warnings.push(t('bundler.index.runtime-hint-lockstep-game'))
      }
      if (selected.has('mjs_lockstep.ts') && !selected.has('mjs_det.ts')) {
        warnings.push(t('bundler.index.runtime-hint-lockstep-det'))
      }
    }
    // Conditions AJOUTÉES au filtre, indépendantes de `selected` (donc de
    // `coreOnly`, qui ne regarde QUE les optionnels classiques — cf. commentaire en tête de
    // méthode) : wantsVt = forcé explicitement, OU 'router'/'ujs' sélectionné (config pure) ;
    // le reste = forcé explicitement, OU faits INCONNUS (`used === undefined`, API directe
    // sans scan), OU le scan (`collectUsedFeatures()`, appelé par `bundleRuntime()`) a trouvé
    // le nom correspondant.
    const wantsVt          = forced.has('mjs_vt_presets.ts') || selected.has('mjs_router.ts') || selected.has('mjs_ujs.ts')
    const wantsTitle       = forced.has('mjs_title.ts') || used === undefined || used.has('title')
    // wantsTheme : DÉTECTÉ (used.has('theme'), cf. collectUsedFeatures/scanCompiledFeatures
    // pour le CSS/JS compilé + le signal fichier `*.theme.mjs`), OU FORCÉ, OU consommateur
    // sélectionné — VÉRIFIÉ par grep `var\(--mjs-` dans src/runtime/*.ts (mjs_modal.ts/
    // mjs_title.ts lisent RÉELLEMENT une des 8 variables canoniques ; mjs_page_cache.ts/
    // mjs_vt_presets.ts/mjs_devpanel.ts ont chacun leur propre espace `--mjs-<module>-*`, aucun
    // des trois n'en lit une — écartés de cette liste, cf. bandeau de mjs_theme.ts). `wantsTitle`
    // déjà calculé juste au-dessus le couvre pour 'title' (forcé ou détecté, mêmes règles).
    const wantsTheme       = forced.has('mjs_theme.ts') || used === undefined || used.has('theme') || selected.has('mjs_modal.ts') || wantsTitle
    const wantsStore       = forced.has('mjs_store.ts') || used === undefined || used.has('store')
    const wantsInterpolate = forced.has('mjs_interpolate.ts') || used === undefined || used.has('interpolate')
    // Balises globales/dynamiques : chacune détectée par son propre nom (voir
    // collectUsedFeatures). `wantsHead`/`wantsBody`/`wantsDynamic` alimentent EN
    // PLUS `wantsEffect` juste plus bas : les 3 macros émettent elles-mêmes un `µeffect =>`
    // autour de leur appel runtime, aucun scan séparé n'est nécessaire pour cette dépendance.
    const wantsHead      = forced.has('mjs_head.ts') || used === undefined || used.has('head')
    const wantsBody      = forced.has('mjs_body.ts') || used === undefined || used.has('body')
    const wantsDynamic   = forced.has('mjs_dynamic.ts') || used === undefined || used.has('dynamic')
    const wantsRareRunes = forced.has('mjs_rare_runes.ts') || used === undefined || used.has('rare_runes')
    const wantsOn        = forced.has('mjs_on.ts') || used === undefined || used.has('on')
    // Mutations PROFONDES (`µ._mjs_deepSet`/`_mjs_deepCall`/`_mjs_deepDelete`/`_mjs_makeDeepProxy`,
    // mjs_deep.ts) : appelées par le seul code émis au niveau du composant (suiveur de chemins,
    // rune `µproxy`), jamais par un autre module du runtime — détectées DIRECTEMENT.
    const wantsDeep      = forced.has('mjs_deep.ts') || used === undefined || used.has('deep')
    // Pool de nœuds texte (mjs_textpool.ts) : `µ._mjs_getTextNode(` n'est émis que par le mode
    // IMPÉRATIF du générateur. La LIBÉRATION part avec (`µ._mjs_recycleTextLeaves`, appelée sous
    // garde par `_mjs_destroyNodeAndChildren`) : remplir un pool où personne ne puise ne ferait que
    // retenir des nœuds morts.
    const wantsTextPool  = forced.has('mjs_textpool.ts') || used === undefined || used.has('textpool')
    // `_mjs_updHtml` (interpolation brute `{{…}}`) : appelée par le seul code émis au niveau du
    // composant, jamais par un autre module du runtime — détectée DIRECTEMENT, aucun forçage.
    const wantsHtml      = forced.has('mjs_html.ts') || used === undefined || used.has('html')
    // `_mjs_injectSlots` (slots indexés) : appelée par le seul constructeur compilé d'un composant qui
    // écrit `<@slot` — détectée DIRECTEMENT, aucun forçage.
    const wantsSlots     = forced.has('mjs_slots.ts') || used === undefined || used.has('slots')
    const wantsEvery     = forced.has('mjs_every.ts') || used === undefined || used.has('every')
    const wantsFailed    = forced.has('mjs_failed.ts') || used === undefined || used.has('failed')
    // wantsEffect : détecté DIRECTEMENT (µeffect/@persist/µdebug $x/<@window scrollX|scrollY>,
    // cf. collectUsedFeatures) OU FORCÉ par <@head>/<@body>/<@html>/<@element>/<@module>, qui
    // s'appuient tous sur `µ.effect` en silence (aucun des deux ne laisse le mot « effect »
    // dans le source du projet).
    const wantsEffect = forced.has('mjs_effect.ts') || used === undefined || used.has('effect') || wantsHead || wantsBody || wantsDynamic
    // wantsTicker : détecté DIRECTEMENT, OU FORCÉ dès que spring/smooth/interpolate est du
    // bundle — les trois appellent `µ.Ticker.add(...)` sans aucune garde (cf. mjs_ticker.ts).
    const wantsTicker = forced.has('mjs_ticker.ts') || used === undefined || used.has('ticker') || wantsInterpolate || selected.has('mjs_spring.ts') || selected.has('mjs_smooth.ts')
    // Les 4 blocs structurels (`{for}`/`{if}`/`{key}`/`{await}`) — briques les plus
    // élémentaires du gabarit, mêmes garanties fail-safe que le reste : jamais un faux négatif
    // (used === undefined OU la forme SOURCE trouvée par le scan). `wantsKey`/`wantsAwait`
    // FORCENT wantsIf EN PLUS : `_mjs_updKey` (mjs_key.ts) appelle `_mjs_tryReviveDying`/
    // `_mjs_resetNestedMemos`, `_mjs_updAwait` (mjs_await.ts) appelle `_mjs_updIf` — les deux vivent
    // dans mjs_if.ts. `wantsFor` est EN PLUS forcé dès que `flip` est du bundle (`selected`,
    // optionnel classique) : `mjs_flip.ts` capture `_mjs_reconcileList` (mjs_for.ts) à son PROPRE
    // chargement, même raison que `wantsTicker` forcé par spring/smooth ci-dessus.
    // `_mjs_updList` (mjs_for_nested.ts) : la variante d'un `{for}` dans une autre liste ou dans une
    // branche `{await}` — détectée DIRECTEMENT sur l'appel émis. Elle appelle
    // `_mjs_reconcileList` (mjs_for.ts) sans garde : elle FORCE donc `wantsFor` juste en dessous,
    // pour le cas d'une demande explicite `runtime: ['for_nested']` (un projet qui écrit un
    // `{for}` imbriqué écrit forcément `{for `, déjà détecté).
    const wantsForNested = forced.has('mjs_for_nested.ts') || used === undefined || used.has('for_nested')
    const wantsFor   = forced.has('mjs_for.ts') || used === undefined || used.has('for') || selected.has('mjs_flip.ts') || wantsForNested
    const wantsKey   = forced.has('mjs_key.ts') || used === undefined || used.has('key')
    const wantsAwait = forced.has('mjs_await.ts') || used === undefined || used.has('await')
    const wantsIf    = forced.has('mjs_if.ts') || used === undefined || used.has('if') || wantsKey || wantsAwait
    // `_mjs_emit` : self-contained (aucune méthode du cœur ne l'appelle elle-même), détecté
    // DIRECTEMENT (µemit/@emit.NOM/@click.emit.NOM, cf. collectUsedFeatures) — aucun forçage.
    const wantsEmit  = forced.has('mjs_emit.ts') || used === undefined || used.has('emit')
    // `µ._mjs_fetchLazyCss` : AUCUN scan — signal de CONFIG pure (comme `wantsVt` pour
    // router/ujs), `this.cssMode` connu dès l'appel (pas besoin d'attendre
    // `this.lazyStyleUrls`, rempli PLUS TARD dans le pipeline, étape 2 — cf.
    // `finalizeLazyStyles`). `css: 'lazy'` sans aucune feuille partagée réellement
    // paresseuse au final n'écrirait pas `µ._cssLazy` : embarquer quand même est le seul
    // sens sûr (faux positif accepté, jamais l'inverse).
    const wantsLazyCss = forced.has('mjs_lazy_css.ts') || this.cssMode === 'lazy'
    // Échappement HTML (`µ._esc`, mjs_esc.ts) : détecté DIRECTEMENT (une interpolation dans un
    // `<@head>` ou dans le repli d'un `<@failed>` émet l'appel), OU joint D'OFFICE dans un build
    // de DÉVELOPPEMENT non nu — mjs_devinspect.ts/mjs_devpanel.ts l'appellent sans garde pour
    // leur propre affichage, et ces trois-là ne sont insérés qu'aux MÊMES conditions
    // (`!coreOnly && !isProd()`, cf. bundleRuntime). `selected.size > 0` ≡ `!coreOnly`, calculé
    // ici comme en fin de méthode.
    const wantsEsc = forced.has('mjs_esc.ts') || used === undefined || used.has('esc') || (!this.isProd() && selected.size > 0)
    // Hydratation SSR par adoption (`_mjs_hydrate` + les 3 approches, mjs_hydrate.ts) : AUCUN
    // scan — signal de CONFIG pure, comme `wantsLazyCss` juste au-dessus. Le bloc `render` dit
    // le mode de chaque page ; seuls `ssr:markers`/`ssr:positional`/`ssr:diff` adoptent le DOM
    // du serveur. `csr`/`prerender` n'ont rien à adopter, `ssr`/`ssr:replace` (défaut) jette la
    // photo serveur et reconstruit la vue : aucun des trois n'appelle ces méthodes. Un serveur
    // qui rend par l'API SANS bloc `render` (ou une page qui demande un mode d'hydratation par
    // en-tête HTTP sur une route configurée `ssr`) le réclame par `runtime: ['hydrate']` — sans
    // lui, le cœur avertit une fois et reconstruit la vue (cf. `_mjs_mount`, mjs_element.ts).
    const wantsHydrate = forced.has('mjs_hydrate.ts') || this.renderUsesHydration()
    // `µ.Autoloader` : AUCUN scan — signal de MODE pur (cf. le bandeau de `CORE` en tête de
    // méthode). En 'split' il est DANS le cœur, cette valeur n'y est jamais consultée ; en
    // 'bundle' il n'entre que sur demande EXPLICITE (`runtime: ['autoloader']`).
    const wantsAutoloader = forced.has('mjs_autoloader.ts')
    // Cache de pages (LRUCache/_mjs_isPageCached/_mjs_destroyEvictedTree/_mjs_routeErrorCss) + libellés
    // (_mjs_label/_mjs_labelLang) : AUCUN scan — signal de config pure, comme `wantsVt`. `router`/`ujs`
    // en dépendent tous les deux (mjs_ujs.ts construit `new µ.LRUCache(10)` À SON CHARGEMENT,
    // sans garde) ; `modal` lit SEULEMENT `_mjs_label`/`_mjs_labelLang` (garde `typeof` déjà en place,
    // repli sur un libellé fixe) — inclus quand même pour ne jamais perdre la traduction projet
    // des toasts/modales (faux positif accepté sur LRUCache si 'modal' est seul).
    const wantsPageCache = forced.has('mjs_page_cache.ts') || selected.has('mjs_router.ts') || selected.has('mjs_ujs.ts') || selected.has('mjs_modal.ts')
    // Crochets de cycle de vie (runes µmount/µawake/µsleep/µdestroy/µurlChange/µfailed nu, balises
    // globales qui s'attachent par `@_mjs_hook`) : détecté DIRECTEMENT, OU FORCÉ par un appelant
    // de l'API de destruction — `every` (µ.every appelle `_mjs_onDestroy`/`_mjs_onSleep`/`_mjs_onAwake` SANS
    // garde `typeof`), `interpolate` (le composant qui reçoit un interpolateur en devient le
    // propriétaire, `_mjs_attachInvalidator`), `smooth`/`socket` (option `owner`) et le cache de pages
    // (l'éviction appelle `_mjs_runDestroyCallbacks`). Chez ces quatre-là la garde `typeof` évite le
    // crash, pas la fuite : sans ce fichier, rien n'est plus défait à la destruction.
    const wantsLifecycle = forced.has('mjs_lifecycle.ts') || used === undefined || used.has('lifecycle') || wantsEvery || wantsInterpolate || selected.has('mjs_smooth.ts') || selected.has('mjs_socket.ts') || wantsPageCache
    // Contexte §/§§ : self-contained (jamais appelé par le cœur lui-même — les deux
    // compteurs qu'il touche, `_mjs_rctx_cache`/`µ._mjs_rctxEpoch`, restent lus/écrits par
    // connectedCallback/disconnectedCallback SANS passer par ce fichier), détecté DIRECTEMENT.
    const wantsContext = forced.has('mjs_context.ts') || used === undefined || used.has('context')
    // Variants de mise en page nommés (tail de _mjs_applyLayout) : détecté par la DÉCLARATION
    // (`<style name="…">` dans une source, fichier `<module>.<nom>.css` déposé dans le dossier de
    // sortie) ou par les mots `layout=`/`template=` — la demande seule peut venir d'une page que
    // le build ne lit pas, cf. collectUsedFeatures.
    const wantsLayoutVariant = forced.has('mjs_layout_variant.ts') || used === undefined || used.has('layout_variant')
    // Chemin LENT de destruction (transitions/@attach/@this=!/@flip) : détecté par les 5 SEULS
    // émetteurs compilateur de `hasDestroyHooks = true` — jamais de forçage nécessaire (aucun
    // autre module optionnel ne pose de transitions/teardowns lui-même ; `mjs_flip.ts`, seul
    // suspect, ne référence ni `_mjs_dying` ni `_mjs_destroyWithHooks`, vérifié).
    const wantsDestroyHooks = forced.has('mjs_destroy_hooks.ts') || used === undefined || used.has('destroy_hooks')
    // `µ._al` (alias COURT d'une balise) : appelée par le seul code émis d'un composant qui porte un
    // nom court, jamais par un autre module du runtime — détectée DIRECTEMENT, aucun forçage. Le nom
    // reste RÉSERVÉ au raccourcisseur même quand le module n'est pas du bundle (cf. CORE_HELPER_NAMES,
    // bundler/minify.ts) : rien ne doit pouvoir le donner à une propriété interne portée par µ.
    const wantsAlias = forced.has('mjs_alias.ts') || used === undefined || used.has('alias')
    const wantsByFile: Record<string, boolean> = {
      'mjs_autoloader.ts':  wantsAutoloader,
      'mjs_vt_presets.ts':  wantsVt,
      'mjs_title.ts':       wantsTitle,
      'mjs_theme.ts':       wantsTheme,
      'mjs_store.ts':       wantsStore,
      'mjs_interpolate.ts': wantsInterpolate,
      'mjs_head.ts':        wantsHead,
      'mjs_body.ts':        wantsBody,
      'mjs_dynamic.ts':     wantsDynamic,
      'mjs_rare_runes.ts':  wantsRareRunes,
      'mjs_on.ts':          wantsOn,
      'mjs_alias.ts':       wantsAlias,
      'mjs_deep.ts':        wantsDeep,
      'mjs_textpool.ts':    wantsTextPool,
      'mjs_esc.ts':         wantsEsc,
      'mjs_html.ts':        wantsHtml,
      'mjs_slots.ts':       wantsSlots,
      'mjs_effect.ts':      wantsEffect,
      'mjs_every.ts':       wantsEvery,
      'mjs_ticker.ts':      wantsTicker,
      'mjs_failed.ts':      wantsFailed,
      'mjs_for.ts':         wantsFor,
      'mjs_for_nested.ts':  wantsForNested,
      'mjs_if.ts':          wantsIf,
      'mjs_key.ts':         wantsKey,
      'mjs_await.ts':       wantsAwait,
      'mjs_emit.ts':        wantsEmit,
      'mjs_lazy_css.ts':    wantsLazyCss,
      'mjs_hydrate.ts':     wantsHydrate,
      'mjs_page_cache.ts':  wantsPageCache,
      'mjs_context.ts':     wantsContext,
      'mjs_lifecycle.ts':   wantsLifecycle,
      'mjs_layout_variant.ts': wantsLayoutVariant,
      'mjs_destroy_hooks.ts': wantsDestroyHooks,
    }
    const files = CANONICAL.filter(f => CORE.includes(f) || selected.has(f) || wantsByFile[f])
    return { files, warnings, coreOnly: selected.size === 0 }
  }

  // --------------------------------------------------------------------------
  // renderUsesHydration() : le projet déclare-t-il une PAGE rendue dans un mode qui ADOPTE le
  // DOM du serveur (cf. HYDRATING_MODES) ? Lit les modes du bloc `render` — `render.default` et
  // le `mode` de chaque route — sous leur forme CANONIQUE (`normalizeMode`, seule source de
  // vérité : `ssr` ≡ `ssr:replace`). Une route sans `mode` hérite de `render.default`, testé à
  // part : rien à dériver ici. Aucune lecture de disque, aucun scan de code — cette réponse ne
  // dépend que de la configuration, connue dès la construction du Bundler.
  // --------------------------------------------------------------------------
  private renderUsesHydration(): boolean {
    const render = this.render
    if (!render) return false
    const adopte = (mode: RenderMode | undefined): boolean => mode !== undefined && HYDRATING_MODES.has(normalizeMode(mode))
    if (adopte(render.default)) return true
    for (const route of Object.values(render.routes ?? {})) {
      if (adopte(route?.mode)) return true
    }
    return false
  }

  // --------------------------------------------------------------------------
  // collectUsedFeatures() (remplace l'ancien balayage TEXTUEL de sourceDir, supprimé) :
  // union des signaux compilés de TOUTES les unités du tour —
  // `this.pendingFeatures`, alimenté par CHAQUE unité fraîchement compilée (compileMjsCold/
  // compileScriptModuleCold/prepareExternalManifest, sur la sortie NON MINIFIÉE, cf.
  // src/bundler/features.ts) ET par chaque cache-hit CANDIDAT (`cached.features`
  // réinjecté par _compileMjsInner/_compileScriptModuleInner, jumeau de usedAnimations) —
  // PLUS le signal fichier variant déposé À LA MAIN dans outputDir (`<module>.<nom>.css`),
  // seule demande qui vienne d'un endroit que la construction ne compile JAMAIS.
  //
  // Le compilateur GÈNE ces symboles de façon stable (appel littéral, attribut posé, champ
  // de données) : les lire dans le CODE ÉMIS élimine tout faux positif de commentaire/chaîne
  // (`<!-- {for x in xs} -->`, `'µ.Store'`) SANS jamais risquer de faux négatif — un vrai
  // usage produit TOUJOURS la même forme compilée, quelle que soit l'écriture source (sigil
  // `µ`/`mjs`, {if}/{key} niché ou racine…). Appelée en PHASE B de compile(), une fois
  // TOUTES les unités compilées en mémoire (phase A) — jamais avant.
  // --------------------------------------------------------------------------
  private collectUsedFeatures(): Set<string> {
    const used = new Set(this.pendingFeatures)
    // variant déposé à la main (`<module>.<nom>.css`) : le runtime le réclame à l'URL du
    // dossier de sortie — noms seulement, aucun lien suivi, dossier absent = rien.
    if (!used.has('layout_variant') && existsSync(this.outputDir)) {
      const names = readdirSync(this.outputDir, { recursive: true }) as string[]
      if (names.some((name) => REGEX_VARIANT_FILE.test(basename(String(name))))) used.add('layout_variant')
    }
    // signal fichier `*.theme.mjs` : posé par compileThemeFiles() (phase A, AVANT cet
    // appel, cf. compile()) dans this.themeNames — aucun composant n'a besoin de LIRE le thème
    // pour que le projet en ait un à servir (µtheme doit pouvoir l'accepter, la feuille
    // d'application doit exister pour le recevoir).
    if (this.themeNames.length > 0) used.add('theme')
    return used
  }

  // --------------------------------------------------------------------------
  // bundleRuntime(used) : concatène les mjs_*.ts → mjs_core.js
  // --------------------------------------------------------------------------
  // `used` prend désormais la place du scan textuel : appelé par compile() en PHASE
  // B avec `this.collectUsedFeatures()` (union des signaux compilés de toutes les unités déjà
  // en mémoire, cf. son bandeau). Paramètre par défaut `new Set()` (jamais `undefined`, cf.
  // resolveRuntimeFiles où `undefined` a un sens DIFFÉRENT — « tout inclus », API directe) :
  // préserve le comportement historique d'un appel HORS pipeline complet (tests qui
  // construisent un cœur sans composant, cf. bundler-runtime-selection.test.ts/bundler-
  // compile-dedup-cycle.test.ts) — `collectUsedFeatures()` sur un `sourceDir` sans aucune
  // unité compilée rendait déjà un Set VIDE, jamais « tout ».
  // --------------------------------------------------------------------------
  async bundleRuntime(used: ReadonlySet<string> = new Set()): Promise<string> {
    // V2 — mjs_element_int / mjs_element_bigint retirés : µ.Element gère tout
    // via le dispatch direct `_mjs_effectsByVar` (plus de bitmask Int/BigInt).
    //
    // Sélection des modules (cœur + optionnels selon `runtime`, défaut 'all' ;
    // rétrocompat `minimalRuntime` ≡ 'core'). mjs_flip reste en fin (patch
    // `µ.Element.prototype`, doit suivre mjs_element) ; mjs_debug est inséré
    // juste après, hors prod et hors cœur nu (splice ci-dessous).
    //
    // mjs_title.ts n'est plus BYTE-identique à l'historique en 'all'/'core' pour un projet SANS
    // aucun `@title`/`mjs-title` (il en sort désormais) — c'est le but recherché,
    // pas une régression. Un projet qui EN a au moins un reste identique à l'historique.
    const { files: orderedFiles, warnings: runtimeWarnings, coreOnly } = this.resolveRuntimeFiles(used)
    for (const w of runtimeWarnings) this.buildWarn(w)

    // mjs_debug est un module d'INSPECTION dev-only : il wrappe
    // connect/disconnect (registre `µ.instances`), la télémétrie `µ.debugMode`
    // et pousse `devtoolsFormatters`. En prod il n'apporte QUE du poids
    // (~0,8 Ko gzip) + ~200 ns par connect/disconnect, pour un outillage jamais
    // sollicité (aucun symbole cœur ne le référence : les `if (µ.debug)` du
    // cœur visent le BOOLÉEN de mjs_init, strippé par DCE). On ne l'inclut donc
    // qu'en build NON-prod (en cœur nu il est déjà absent). Insertion juste
    // avant mjs_flip pour rester APRÈS mjs_element (patch prototype).
    // mjs_devinspect (inspecteur d'objets générique) et mjs_devpanel (le panneau, qui s'en sert
    // pour ses onglets État/Contexte et pour `µ.devObject`) suivent la MÊME règle et se suivent
    // immédiatement dans cet ordre : mjs_devpanel s'appuie sur le registre `µ.instances` de
    // mjs_debug ET sur `µ._mjs_diRender` de mjs_devinspect — il doit donc venir APRÈS les deux, et
    // jamais en prod. mjs_hotcss (rechargement CSS à chaud, `µ._hotCss` — appelé SEULEMENT par
    // le snippet HMR de `mjs dev`, server/hmr.ts) suit la MÊME règle : rien à échanger à chaud
    // dans un bundle qui ne sera jamais servi par `mjs dev`.
    if (!coreOnly && !this.isProd()) {
      const debugIdx = orderedFiles.indexOf('mjs_flip.ts')
      orderedFiles.splice(debugIdx >= 0 ? debugIdx : orderedFiles.length, 0, 'mjs_debug.ts', 'mjs_devinspect.ts', 'mjs_devpanel.ts', 'mjs_hotcss.ts')
    }

    // Les fichiers runtime sont du TS sans syntaxe TS (issu de la migration
    // Coffee → TS) — du JS pur. On peut concaténer directement, esbuild
    // les passerait en mode ESM avec wrapping qui collisionne lors de la
    // concaténation. Le minifier en aval (esbuild minify) les avalera.
    const parts: string[] = []
    const missing: string[] = []
    // registre des variables de thème — recalculé à CHAQUE bundleRuntime() : ces fichiers sont
    // de toute façon lus en entier pour la concaténation ci-dessous, le scan ne coûte rien
    // de plus. C'est ce qui rend `$$surface`/`$$fg`/… légitimes sans redéclaration projet.
    this.frameworkVarData = []
    for (const f of orderedFiles) {
      const path = join(this.runtimeDir, f)
      if (!existsSync(path)) { missing.push(f); continue }
      const src = readFileSync(path, 'utf-8')
      parts.push(`// === ${f} ===\n${src}`)
      this.scanFrameworkVars(f, src)
    }
    // Motif dominant de ce genre de bogue :
    // « erreur avalée → build vert ». Un `runtimeDir` introuvable/mal résolu
    // (ex. le bug URL.pathname corrigé dans locateRuntimeDir ci-dessus, ou
    // une config `runtimeDir` explicite fausse) faisait sauter CHAQUE fichier
    // via le `continue` ci-dessus, SANS qu'aucune erreur ne remonte :
    // `mjs_core.js` s'écrivait VIDE (ou partiel si un SEUL module manque),
    // le build se terminait « avec succès », et l'app entière était
    // mort-née au premier chargement (`µ` undefined pour TOUT composant, ou
    // `µ.Router`/`µ.ajax`/etc. manquants selon le module sauté). On ne
    // tolère plus le moindre fichier runtime absent.
    if (missing.length > 0) {
      throw new Error(t('bundler.index.runtime-introuvable', { manquants: missing.length, total: orderedFiles.length, dossier: this.runtimeDir, liste: missing.join(', ') }))
    }
    // lectures `µ.debug` mortes en prod : `define: { 'µ.debug': 'false' }` ne peut rien (µ est une
    // variable LOCALE du cœur, esbuild n'applique pas un define derrière une déclaration locale, cf.
    // minify.ts) ; en prod, chaque LECTURE `µ.debug` (jamais une écriture `µ.debug = …`, exclue par
    // le lookahead) devient l'identifiant libre `MJS_DEBUG`, que `minifyJs` reçoit en
    // `define: { MJS_DEBUG: 'false' }` → chaque `if (µ.debug)` part en DCE réel. Hors prod, rien ne
    // change : les sources gardent `µ.debug`, la bascule console `µ.debug = true` reste vivante,
    // et les tests qui évaluent ces fichiers bruts n'ont rien à connaître
    const concatenated = this.shouldMinify()
      ? parts.join('\n').replace(/(?<![\w$.])µ\.debug(?![\w$])(?!\s*=[^=])/g, 'MJS_DEBUG')
      : parts.join('\n')
    // GARDE DU CONTRAT — dernier mot avant que ce cœur parte sur disque : chaque symbole interne
    // que les unités de ce build APPELLENT doit exister dans le texte qu'on vient d'assembler.
    // Sur `concatenated`, donc AVANT minification, pour la raison de toujours : le minifieur
    // raccourcit les `_mjs_*`/`_upd*` et les rendrait invisibles des deux côtés.
    //
    // Ce que ça rattrape : la sélection ci-dessus repose sur `scanCompiledFeatures`, qui reconnaît
    // un module à un marqueur DANS le code compilé. Un marqueur qui cesse de correspondre (un
    // renommage interne, comme `._updList(` → `._mjs_updList(` en septembre 2026) rend « personne
    // n'en a besoin » — mot pour mot ce que rend « rien à embarquer ». Le module sort du cœur, le
    // build reste vert, et l'application meurt au premier clic. Neuf vues y sont restées deux
    // jours. On ne détecte pas l'erreur de scan (impossible depuis le scan lui-même) : on
    // vérifie le RÉSULTAT, et on refuse de finir.
    //
    // `pendingCoreCalls` est vide hors pipeline complet (bundleRuntime appelée seule, API directe
    // ou tests) : rien de réclamé, rien à vérifier, comportement historique intact.
    const manquants = missingCoreSymbols(concatenated, this.pendingCoreCalls)
    if (manquants.length > 0) {
      throw new Error(t('bundler.index.contrat-coeur-rompu', { manquants: manquants.join(', '), nb: manquants.length, modules: orderedFiles.length }))
    }
    const minified = await minifyJs(concatenated, {
      force: this.shouldMinify(),
      filename: 'mjs_core.js',
      sourceMap: this.shouldEmitSourceMap(),
      mangleCache: this.mangleCache,
      logLevel: this.prodLogLevel(),
      define: this.shouldMinify() ? { MJS_DEBUG: 'false' } : undefined,
    })
    // mode 'bundle' : le cœur ne devient JAMAIS un fichier sur disque — gardé en mémoire
    // (bundleVirtualSources), résolu par le plugin esbuild d'emitSingleFile() sous le
    // spécificateur virtuel STABLE 'mjs:core'. Stable = un cache-hit d'unité (CacheEntry.code)
    // reste valide quel que soit le CONTENU du cœur (plus de hash embarqué dans le texte des
    // unités, cf. bandeau de CacheEntry.embeds) — la carte de source suit en inline (cf.
    // emitSingleFile()) plutôt qu'en fichier `.map` séparé, ce cœur n'en ayant plus.
    if (this.jsMode === 'bundle') {
      this.bundleVirtualSources.set('mjs_core', this.withInlineSourceMap(minified.code, minified.map))
      return 'mjs:core'
    }
    const hashed = this.writeHashed('mjs_core', '.js', minified.code, minified.map)
    return hashed
  }

  // --------------------------------------------------------------------------
  // scanFrameworkVars(f, src) : registre des variables de thème, source 3 — une DÉCLARATION
  // `--<varPrefix>-<nom>:` dans le SOURCE du runtime (mjs_init.ts pose --mjs-surface,
  // --mjs-fg… pour les thèmes clair/sombre embarqués, mjs_modal.ts/mjs_title.ts posent
  // les points de personnalisation de leurs propres composants). `var(--mjs-x)` est une
  // LECTURE, jamais capturée ici (aucun `:` ne suit jamais le nom dans cette forme). Scan
  // sur le SOURCE (pas le bundle minifié) : lignes réelles, doc = commentaire précédent
  // s'il y en a un, exploitables telles quelles par le registre.
  //
  // Un commentaire ne documente que la déclaration qui le suit IMMÉDIATEMENT, et RIEN
  // d'autre — ex. mjs_init.ts pose 8 variables sur une SEULE ligne de template literal
  // (`--mjs-surface:…;--mjs-fg:…;…`) ; sans ce garde, les 8 héritaient TOUTES du même
  // commentaire, situé au-dessus de la feuille entière et sans rapport avec 7 d'entre
  // elles. `doc` n'est donc jamais rempli pour la 2e déclaration d'une même ligne (ou
  // plus loin) — mieux vaut vide que faux.
  // --------------------------------------------------------------------------
  private scanFrameworkVars(f: string, src: string): void {
    const lines = src.split('\n')
    for (let li = 0; li < lines.length; li++) {
      const re = new RegExp(`--${escapeRegex(this.varPrefix)}-([A-Za-z_][A-Za-z0-9_-]*)\\s*:\\s*([^;{}]+)`, 'g')
      const prevLine = li > 0 ? lines[li - 1].trim() : ''
      let doc = prevLine.startsWith('//') ? prevLine.replace(/^\/+\s*/, '') : ''
      let m: RegExpExecArray | null
      while ((m = re.exec(lines[li])) !== null) {
        this.frameworkVarData.push({ file: f, line: li + 1, name: m[1], value: m[2].trim(), doc })
        doc = ''   // consommé par la 1re déclaration — la suivante (même ligne) n'hérite pas
      }
    }
  }

  // --------------------------------------------------------------------------
  // isProd() : définition CANONIQUE et UNIQUE de "build de prod" — utilisée
  // partout où ce choix compte (source maps, exposition window.µ, etc.).
  //
  // Résolution : `env` vaut 'prod' ou 'dev', et rien d'autre. En CLI c'est le DRAPEAU
  // qui le pose — `mjs build` construit en développement, `mjs build --prod` en production.
  // Aucune variable d'ambiance n'entre ici : un `NODE_ENV` qui traîne dans un shell ne doit
  // pas changer ce que produit un build (avant, `'auto'` le consultait).
  //
  // AVANT ce fix, 2 définitions DIVERGENTES
  // coexistaient : `shouldEmitSourceMap()` considérait `forceMinify || NODE_ENV`,
  // l'exposition de `window.µ` ne regardait QUE `NODE_ENV`. Unifiées ici.
  //
  // `minify` NE DÉCIDE PLUS de l'environnement. L'ancienne règle
  // (`minify: true` ⇒ prod) faisait qu'un projet local avec un simple `"minify": true`
  // dans mjs.config.json construisait un build de PRODUCTION sans le savoir : pas de
  // `window.µ`, pas de carte de source, et surtout aucun module d'inspection — le
  // panneau `Ctrl+Shift+Espace` n'existait pas dans le bundle, sans le moindre message.
  // C'est `env` qui porte ce choix maintenant, et `minify` ne fait que minifier.
  // --------------------------------------------------------------------------
  private isProd(): boolean {
    return this.envMode === 'prod'
  }

  // shouldMinify() : politique de minification, INDÉPENDANTE de l'environnement.
  // `'auto'` (défaut) suit `isProd()` — un build de dév n'est donc PLUS
  // minifié, et un `minify: true` posé pour alléger un bundle local ne fait plus passer
  // tout le projet en prod (ce qui retirait le panneau d'inspection sans rien demander).
  // PUBLIC : bundler/startup.ts assemble le fichier de page d'une route prérendue APRÈS ce
  // compile, et doit le minifier selon la MÊME politique (une seule définition).
  shouldMinify(): boolean {
    return this.minifyMode === 'auto' ? this.isProd() : this.minifyMode
  }

  // currentLogLevel()/prodLogLevel() : niveau EFFECTIF de la console (clé `logLevel` de
  // mjs.config.json, cf. resolveLogLevel/config.ts — défauts dev 'log', prod 'warn').
  // currentLogLevel() suit l'environnement RÉEL de CE build (émis au manifeste pour le
  // navigateur — cf. writeManifest — et gouverne buildWarn() ci-dessous). prodLogLevel()
  // vaut TOUJOURS le niveau de PROD, quel que soit l'environnement en cours : c'est lui qui
  // pilote la liste `pure` du minifieur (cf. tous les appels à minifyJs()), pour qu'un bundle
  // minifié en dev (minify forcé) retire exactement ce qu'un build de prod retirerait.
  private currentLogLevel() {
    return resolveLogLevel(this.logLevel, this.isProd() ? 'prod' : 'dev')
  }

  private prodLogLevel() {
    return resolveLogLevel(this.logLevel, 'prod')
  }

  // buildWarn() : point de sortie UNIQUE des avertissements du bundler vers le terminal —
  // respecte currentLogLevel() (rien en dessous de 'warn'). Remplace un `console.warn` direct
  // partout où le contexte a accès à `this` (compile-time — PAS la validation de
  // mjs.config.json elle-même, qui tourne avant que l'environnement dev/prod ne soit connu).
  // PUBLIC : cli.ts l'appelle aussi pour ses propres échos d'avertissements de build
  // (`stats.warnings`, purge d'orphelins) — même bundler, même niveau, un seul filtre.
  buildWarn(message: string): void {
    if (logLevelAllows(this.currentLogLevel(), 'warn')) console.warn(message)
  }

  // shouldEmitSourceMap() : gouverné par la clé `sourceMap` de mjs.config.json.
  // Défaut `'dev'` : la carte est émise là où elle sert — poser un point d'arrêt sur SA
  // ligne de `.mjs` pendant qu'on développe — et absente de la prod, où elle publierait
  // la forme lisible du source. `'prod'` pour l'ancien comportement, `'always'` les deux,
  // `'never'` aucune. PUBLIC pour la même raison que shouldMinify() ci-dessus.
  shouldEmitSourceMap(): boolean {
    const m = this.sourceMapMode
    return m === 'always' || (m === 'prod' && this.isProd()) || (m === 'dev' && !this.isProd())
  }

  // --------------------------------------------------------------------------
  // shortModuleName(filePath) : basename sans le préfixe du dossier ancêtre
  // s'il y est. Convention V1 :
  //   `<sourceDir>/tuto/11/11-1/tuto-snippets-card.mjs`  → `snippets-card`
  //   `<sourceDir>/tuto/tuto.mjs`                       → `tuto`  (cas root)
  //   `<sourceDir>/doc/doc-architecture.mjs`            → `architecture`
  //   `<sourceDir>/foo/bar.mjs`                         → `bar` (pas de préfixe)
  //
  // Le tag custom element devient `mjs-<shortName>`, et l'entrée manifest
  // utilise le shortName comme clé. L'autoloader (qui fait
  // `µ.paths[tag.replace('mjs-', '')]`) trouve donc le composant.
  // --------------------------------------------------------------------------
  private shortModuleName(filePath: string): string {
    const base = pageAwareBaseName(filePath)
    // Dossier parent direct (premier segment au-dessous de sourceDir)
    const rel = filePath.replace(this.sourceDir + '/', '')
    const topDir = rel.split('/')[0]
    // Cas root : le fichier est `<topDir>.mjs` lui-même → on garde tel quel
    if (base === topDir) return base
    // Si le basename commence par `<topDir>-`, strip ce préfixe
    if (base.startsWith(topDir + '-')) return base.slice(topDir.length + 1)
    return base
  }

  // variants — alimente pendingLayoutNames pour UN module tout juste compilé
  // (froid OU cache-hit, cf. les deux appels dans _compileMjsInner) : basename ET alias
  // court (mêmes clés que manifestSources/manifestNames), en minuscules. Aucune entrée si
  // le module ne déclare AUCUN variant — c'est ce vide qui, plus tard, dit à
  // resolveTagShortcuts de ne rien vérifier (repli historique du fichier CSS à la main).
  private registerLayoutNames(filePath: string, moduleNameOverride: string | undefined, layoutCss: Record<string, string> | undefined): void {
    const names = Object.keys(layoutCss ?? {})
    if (names.length === 0) return
    const moduleName = moduleNameOverride ?? pageAwareBaseName(filePath)
    const shortName  = moduleNameOverride ?? this.shortModuleName(filePath)
    for (const key of new Set([moduleName.toLowerCase(), shortName.toLowerCase()])) {
      const set = this.pendingLayoutNames.get(key) ?? new Set<string>()
      for (const n of names) set.add(n)
      this.pendingLayoutNames.set(key, set)
    }
  }

  // --------------------------------------------------------------------------
  // Un ALIAS COURT (shortModuleName, ci-dessus) qui retombe sur une des
  // 12 réservées ou le préfixe `core-` n'est JAMAIS publiable — même règle que
  // pour un basename (resolveTagShortcuts), mais un basename est le nom de
  // fichier réel (non négociable, erreur dure) alors qu'un alias n'est qu'un
  // confort (cède en silence + avertissement). Utilisée ICI (aliasTag,
  // _compileMjsInner juste plus bas — pour ne jamais émettre
  // `customElements.define('mjs-<réservé>', …)`) ET dans resolveTagShortcuts
  // (manifeste + pool de résolution manifestNames) — SEULE source de vérité.
  // --------------------------------------------------------------------------
  // `mjs-` — le préfixe appartient au framework, et il l'est
  // DÉJÀ à deux endroits : le tag d'un composant est toujours `mjs-<basename>`, et tout
  // attribut `mjs-*` est ignoré comme prop. Un fichier `mjs-carte.mjs` produirait le tag
  // `<mjs-mjs-carte>` et pourrait entrer en collision avec une variable du framework. La
  // règle bouche ce trou plutôt que d'ajouter une comparaison de listes.
  private isReservedShortcutName(name: string): boolean {
    const lower = name.toLowerCase()
    return AT_RESERVED_NAMES.includes(lower) || lower.startsWith('core-') || lower.startsWith('mjs-')
  }

  // --------------------------------------------------------------------------
  // notePoisonedAlias() : un prétendant de plus sur un alias court AMBIGU (claimShortName,
  // kind 'poisoned'). On garde le BASENAME de chaque rival — c'est ce que l'auteur devra
  // écrire (`<mjs-doc-carte>`), pas le chemin du fichier. Sans doublon, ordre de compilation.
  // --------------------------------------------------------------------------
  private notePoisonedAlias(key: string, file: string): void {
    const noms = this.poisonedAliasSources.get(key) ?? []
    const nom  = pageAwareBaseName(file)
    if (!noms.includes(nom)) noms.push(nom)
    this.poisonedAliasSources.set(key, noms)
  }

  // --------------------------------------------------------------------------
  // compileMjs() : .mjs → JS via transpiler V2.
  //
  // Wrappé dans `withState()` pour isoler le `CompilerState` par fichier →
  // permet `Promise.all([compileMjs(f1), compileMjs(f2), ...])` sans race
  // condition sur le state du generator.
  // --------------------------------------------------------------------------
  // `moduleNameOverride` : réservé aux modules cœur (resolveTagShortcuts),
  // compilés depuis `coreModulesDir` sous le nom PLAT `<nom>` (tag mjs-<nom>,
  // plus de préfixe `core-`) plutôt que le basename réel du fichier
  // catalogue. `undefined` en usage normal (composant projet) → comportement
  // inchangé (basename du fichier).
  async compileMjs(filePath: string, moduleNameOverride?: string): Promise<string> {
    return this.compileWithDedup(filePath, () => withState(() => this._compileMjsInner(filePath, moduleNameOverride)) as Promise<string>)
  }

  // Dédup des compiles concurrents +
  // détection de cycle, PARTAGÉES entre `.mjs` (compileMjs) et `.civet`/
  // `.coffee` (compileScriptModule) : un `.mjs` peut `@import`/`µasset()` un
  // `.civet`, qui peut lui-même référencer un `.mjs`, donc un cycle peut
  // traverser les deux — une dédup séparée par type ne le détecterait pas.
  //
  // Deux problèmes distincts, avant ce fix :
  //   1. COURSE : `compileMjs` n'avait AUCUNE dédup (contrairement à
  //      compileScriptModule, qui en avait déjà une) — le parallelMap
  //      principal ET une résolution `µasset()`/`@import` imbriquée pouvaient
  //      compiler le MÊME fichier CHACUN DE LEUR CÔTÉ → deux hashes pour le
  //      même fichier → le second écrase le premier sur disque → le `.mjs`
  //      qui avait la 1ʳᵉ résolution garde une référence à un fichier
  //      supprimé → import 404 au chargement, build vert.
  //   2. CYCLE : `@import`/`µasset()` circulaire (A → B → A). Sans dédup,
  //      chaque appel relance un compile INDÉPENDANT → récursion infinie
  //      (stack overflow). Avec seulement une dédup NAÏVE (l'ancienne
  //      approche de compileScriptModule) : la 2ᵉ demande pour A retourne la
  //      promesse DÉJÀ EN VOL de la 1ʳᵉ — qui ne peut JAMAIS résoudre
  //      puisqu'elle attend elle-même cette même chaîne → interblocage
  //      SILENCIEUX, build qui ne se termine jamais, sans aucun message.
  //
  // Fix : `AsyncLocalStorage` (même outil déjà utilisé par
  // generator/state.ts `withState`, pour la même famille de besoin — isoler
  // un contexte à travers une chaîne d'`await` imbriqués) trace la CHAÎNE de
  // résolution en cours. Si le fichier demandé y figure déjà, c'est un
  // cycle : throw immédiat et explicite (nommant la chaîne complète) plutôt
  // que récursion ou interblocage. Sinon, dédup normale via Map d'in-flight.
  private compileChainStorage = new AsyncLocalStorage<string[]>()
  private compileInFlight: Map<string, Promise<string>> = new Map()

  private compileWithDedup(filePath: string, run: () => Promise<string>): Promise<string> {
    const chain = this.compileChainStorage.getStore() ?? []
    if (chain.includes(filePath)) {
      throw new Error(t('bundler.index.cycle-import-detecte', { chaine: [...chain, filePath].join(' → ') }))
    }
    const existing = this.compileInFlight.get(filePath)
    if (existing) {
      // Cas résiduel NON couvert par la détection de cycle ci-dessus : deux
      // fichiers CHACUN indépendamment top-level (donc chacun avec sa PROPRE
      // chaîne racine, invisible l'une à l'autre) qui se référencent
      // mutuellement via @import/µasset. Ex. `a.civet` et `b.civet` sont
      // TOUS DEUX découverts par le scan principal ET s'importent l'un
      // l'autre : la promesse "en vol" de `a` finit par attendre celle de
      // `b` (via CETTE dédup), qui elle-même attend celle de `a` — aucune
      // des deux ne peut jamais résoudre en premier. Sans limite de temps,
      // cet interblocage serait SILENCIEUX et ÉTERNEL (exactement le
      // symptôme originel qu'on corrige). Un timeout transforme le hang
      // muet en échec explicite et borné, nommant la chaîne en cause.
      const timeoutMs = this.dedupWaitTimeoutMs
      let timer: ReturnType<typeof setTimeout> | undefined
      const timeout = new Promise<string>((_, reject) => {
        timer = setTimeout(() => reject(new Error(t('bundler.index.compilation-bloquee', {
          fichier: filePath, timeout: timeoutMs, chaine: [...chain, filePath].join(' → '),
        }))), timeoutMs)
        timer.unref?.()
      })
      return Promise.race([existing, timeout]).finally(() => { if (timer) clearTimeout(timer) })
    }
    const promise = this.compileChainStorage.run([...chain, filePath], run)
      .finally(() => this.compileInFlight.delete(filePath))
    this.compileInFlight.set(filePath, promise)
    return promise
  }

  // --------------------------------------------------------------------------
  // cachedUnitStillOnDisk(cached) : ceinture + bretelles d'un cache-hit CANDIDAT (hash déjà
  // vérifié par l'appelant, cf. _compileMjsInner/_compileScriptModuleInner) — le SUPPORT du
  // contenu mis en cache doit encore exister. Mode 'split' (historique) : un vrai FICHIER sur
  // disque (cleanup concurrent, suppression manuelle — cachedDiskPath). Mode 'bundle' : RIEN
  // n'est jamais écrit sur disque pour une unité (cf. emitSingleFile()) — c'est `cached.code`,
  // en RAM, qui fait foi ; son absence (entrée posée par un compile ANTÉRIEUR en mode 'split',
  // ou par une instance qui vient de changer de mode) est le seul signe de péremption possible.
  // --------------------------------------------------------------------------
  private cachedUnitStillOnDisk(cached: CacheEntry): boolean {
    if (this.jsMode === 'bundle') return cached.code !== undefined
    return existsSync(join(this.outputDir, basename(cached.hashedPath)))
  }

  private async _compileMjsInner(filePath: string, moduleNameOverride?: string): Promise<string> {
    const cacheKey = filePath
    const cached = this.cache.get(cacheKey)
    const content = readFileSync(filePath, 'utf-8')

    // mode split SEULEMENT (coût nul en mode 'bundle', gate ICI plutôt
    // que dans extractViewCssNames). Scanne la source BRUTE (juste lue ci-dessus), AVANT
    // transpile — donc valable aussi bien en cache-hit qu'en fresh-compile SANS plomberie
    // de cache supplémentaire (contrairement à sharedCssNames/usedAnimations : `content`
    // est relu à chaque appel, cache hit ou pas, ce scan l'est donc aussi).
    if (this.cssMode === 'split') {
      for (const name of extractViewCssNames(content)) this.viewRequestedSheets.add(name)
    }

    // Override : moduleName ET shortName IDENTIQUES (jamais d'aliasTag
    // parasite pour un module cœur, cf. `aliasTag: shortName !== moduleName`
    // plus bas — un alias court 'tst' concurrencerait un composant projet homonyme).
    const moduleName = moduleNameOverride ?? pageAwareBaseName(filePath)  // tag enregistré = full basename, marqueur .page retiré

    // Cache key : SHA-256 du contenu + hash concaténé des partials inclus.
    // Plus robuste que `mtime` (insensible à `touch`, aux copies préservant
    // mtime, aux checkouts git, aux rebuilds cross-machine). Invalide
    // automatiquement quand un partial change.
    //
    // PLUS de sel du cœur/CSS split dans ce hash (la sortie compilée en mémoire
    // n'embarque plus qu'un REPÈRE, identique d'un tour à l'autre tant que le SOURCE ne
    // change pas) : un cache-hit ICI n'est donc qu'un CANDIDAT — sa validité réelle (cœur/
    // feuilles split ACTUELS) ne se décide qu'en phase C (cf. compile(), `CacheEntry.embeds`).
    // Sans ce sel, un composant en cache hit garderait une sortie disque référençant un cœur
    // supprimé → 404 : c'est désormais `embeds` (comparé en phase C), pas le hash, qui l'évite.
    //
    // Stratégie : si on a un cache hit, on connaît les partials précédents
    // → on peut calculer le hash sans transpile. Si pas de cache, on calcule
    // après le transpile (qui découvre les partials).
    if (cached) {
      const expectedHash = this.hashWithDeps(content, [
        ...(cached.includedPartials ?? []),
        ...(cached.importedModules ?? []),
      ])
      // Ceinture + bretelles : le hit exige aussi que le fichier de sortie
      // existe encore sur disque (cleanup concurrent, suppression manuelle) — cf.
      // cachedUnitStillOnDisk() pour la contrepartie mode 'bundle' (rien sur disque,
      // c'est `cached.code` en RAM qui fait foi).
      if (cached.hash === expectedHash && this.cachedUnitStillOnDisk(cached)) {
        // Cache hit CANDIDAT : il faut quand même réinjecter les animations détectées
        // pour ce fichier, sinon `compileUsedAnimations` (qui s'appuie sur le
        // Set partagé `this.usedAnimations`) ne verra que les fichiers
        // recompilés ce tour-ci → bundle anim manquant après une rebuild
        // incrémentale (HMR du watcher).
        for (const a of cached.usedAnimations ?? []) this.usedAnimations.add(a)
        // Même hygiène pour les anims DÉFINIES
        // dynamiquement, sinon un cache hit fait réapparaître
        // le faux "manquant" spin/todoSend/todoReceive au build incrémental.
        for (const a of cached.definedAnimations ?? []) this.definedAnimations.add(a)
        // (crash-si-feuille-absente) — même hygiène : un
        // composant en cache hit doit rester compté dans validateSharedSheets(),
        // sinon une feuille @css qui disparaît du disque APRÈS le 1ᵉʳ compile
        // (mais que ce composant précis n'a pas été retouché, donc jamais
        // recompilé) échapperait à la détection au build incrémental.
        for (const c of cached.sharedCssNames ?? []) this.requestedSharedSheets.add(c)
        // signaux compilés : même hygiène que usedAnimations, jumeau côté
        // collectUsedFeatures() — sinon un composant inchangé disparaîtrait des briques du
        // cœur détectées au rebuild incrémental.
        for (const f of cached.features ?? []) this.pendingFeatures.add(f)
        // symboles du CONTRAT : même hygiène, même raison (cf. CacheEntry.coreCalls).
        for (const c of cached.coreCalls ?? []) this.pendingCoreCalls.add(c)
        // registre des variables de thème — même hygiène : un composant en cache hit doit
        // rester compté dans computeVarRegistry(), sinon ses variables $$ (déclarées OU
        // lus) disparaîtraient du registre à chaque fichier NON touché par ce compile.
        // variants — même hygiène que ci-dessus, pour les satellites de variant :
        // un cache hit doit les RÉÉCRIRE lui aussi (writeIfChanged, jumeau exact du chemin froid
        // plus bas), sinon un ménage manuel du dossier de sortie pendant `mjs dev`
        // (Bundler.watch() réutilise la MÊME instance toute la session, contrairement à
        // `mjs build` qui repart d'un cache froid à chaque process) laisse le variant
        // manquante jusqu'à ce que ce composant précis soit retouché.
        for (const layoutName of Object.keys(cached.layoutCss ?? {})) {
          this.writeIfChanged(join(this.outputDir, `${moduleName}.${layoutName}.css`), cached.layoutCss![layoutName])
        }
        // variants — jumeau exact du chemin froid plus bas, même raison que
        // pendingVarData juste en dessous : le croisement layout="x" a besoin des
        // variants de CE module même s'il n'a pas été recompilé ce tour-ci.
        this.registerLayoutNames(filePath, moduleNameOverride, cached.layoutCss)
        // Même hygiène, et c'est la plus coûteuse à rater : resolveTagShortcuts()
        // ne compile un module cœur que si QUELQU'UN le réclame CE tour-ci. Un composant
        // en cache hit ne repassait pas par _compileMjsInner, donc ne redéposait aucune
        // référence : au premier rebuild incrémental de `mjs dev`, <@switch>/<@checkbox>/
        // <@radio>… quittaient `µ.paths` et leur balise 404ait en silence (écran blanc)
        // jusqu'au redémarrage. Invisible en `mjs build` (cache froid par process)
        for (const ref of cached.tagRefs ?? []) {
          this.pendingTagRefs.push({ file: filePath, name: ref.name, kind: ref.kind, layoutLiteral: ref.layoutLiteral })
        }
        // jumeau exact du bloc tagRefs ci-dessus, même raison (cache-hit qui ne
        // repasse pas par _compileMjsInner) — `content` est déjà lu inconditionnellement
        // en tête de méthode, le scan @import (masqué <pre>/<code>) reste donc bon marché
        // même sur un cache-hit (aucun besoin de le mettre lui aussi en cache).
        this.pendingComponentDeps.push({ moduleName, deps: [...(cached.componentDeps ?? []), ...this.directImportDepKeys(content)] })
        this.pendingVarData.push({
          file: filePath,
          moduleName,
          baseCss: cached.baseCss ?? '',
          layoutCss: cached.layoutCss ?? {},
          themeVars: cached.themeVars ?? [],
          varsRead: cached.varsRead ?? [],
        })
        // PLUS de `emittedThisCompile.add`/`cacheHitsThisCompile++` ICI : ce cache-hit
        // n'est encore qu'un CANDIDAT (phase A) — sa confirmation (embeds identiques) ou son
        // invalidation (embeds différents, recompilation au chemin froid) se décide en phase
        // C (cf. compile()), seul endroit où ces deux compteurs sont mis à jour pour cette
        // unité désormais. Rend le REPÈRE, jamais le chemin final (pas encore sûr, cf. § 4 de
        // la conception : un composant froid qui embarquerait le chemin RÉEL d'un module en
        // cache-hit se retrouverait faux si ce module se révèle périmé en phase C).
        this.pendingUnits.set(moduleName, { kind: 'cached', file: filePath, stem: moduleName, cached })
        return this.placeholderPath(moduleName, '.js')
      }
    }

    return this.compileMjsCold(filePath, moduleName, moduleNameOverride, { silent: false })
  }

  // --------------------------------------------------------------------------
  // compileMjsCold() : chemin FROID de compilation d'un composant .mjs — extrait de
  // _compileMjsInner pour être réutilisé par la phase C de compile() quand un cache-hit
  // CANDIDAT se révèle PÉRIMÉ (cœur/feuilles split changés) et doit être recompilé APRÈS la
  // phase A. `opts.silent = true` = ne PAS re-pousser les métadonnées déjà hydratées en phase
  // A (tagRefs, componentDeps, varData, fichiers variants, warnings de section, reverse-map
  // des deps) — un composant périmé a DÉJÀ été vu une fois (cache-hit candidat), les
  // redéposer doublonnerait `this.pending*`. Rend le REPÈRE de l'unité (jamais le chemin
  // final, inconnu à ce stade) et l'enregistre en attente d'émission topologique (cf.
  // compile()) — plus aucun `writeHashed()`/`this.cache.set()` ici.
  // --------------------------------------------------------------------------
  private async compileMjsCold(filePath: string, moduleName: string, moduleNameOverride: string | undefined, opts: { silent: boolean }): Promise<string> {
    const content = readFileSync(filePath, 'utf-8')
    const shortName = moduleNameOverride ?? this.shortModuleName(filePath)
    // Un alias réservé/core- (isReservedShortcutName) ne doit JAMAIS être
    // enregistré comme custom element : voir aussi le repli côté manifeste dans
    // resolveTagShortcuts (le composant reste joignable par son nom complet SEULEMENT).
    const aliasReserved = shortName !== moduleName && this.isReservedShortcutName(shortName)

    // Pre-résolution des µasset() littéraux côté master (le worker n'a pas
    // accès au disque). Les références dynamiques `µasset(expr)` ne sont
    // pas couvertes ici — le worker recevra MISSING_MJS_ASSET et le master
    // les rattrape via `resolveMagicAssets` en post-compile.
    const { dict: preResolvedAssets, assetSources, images: preResolvedImages } = await this.preResolveAssets(content, dirname(filePath))

    // Le message de transpilation, identique quel que soit le chemin : le corps exécuté
    // est le même (transpile-msg.ts), dans un thread ou ici même.
    const msg: TranspileMsg = {
      type: 'transpile',
      id: 0,
      content,
      moduleName,
      // déduit du VRAI nom de fichier (moduleName ci-dessus l'a déjà perdu, cf.
      // pageAwareBaseName) : seul point où la garde de compilation (transpiler/index.ts,
      // TranspileOpts.isPageModule) sait si CE fichier a le droit de porter <routes>/@routes/<@view>.
      isPageModule: isPageFile(filePath),
      defaultScriptLang: this.defaultScriptLang,
      templateLang: this.templateLang,
      sigil: this.sigil,
      contextAlias: this.contextAlias,
      varPrefix: this.varPrefix,
      maxStateVars: this.maxStateVars,
      a11y: this.a11y,
      baseDir: dirname(filePath),
      sourceDir: this.sourceDir,
      aliasTag: shortName !== moduleName && !aliasReserved ? `mjs-${shortName}` : undefined,
      dirInject: `${this.urlPrefix}/`,
      preResolvedAssets,
      preResolvedImages,
    }
    // Sous le seuil (`inlineTranspile`), on appelle transpile() ICI : `ensureWorkerPool` n'est
    // même pas touché, donc aucun thread n'est démarré pour un petit projet. Au-dessus, submit
    // au pool : transpile() en parallèle dans un thread séparé → 66% du temps de compilation
    // hors du thread principal. Un `throw` remonte pareil des deux côtés (stats.errors).
    const { output, data, sourceMap: transpileMap } = this.inlineTranspile
      ? await transpileFromMsg(msg) as { output: string; data: TranspileDataLike; sourceMap?: string }
      : await (await this.ensureWorkerPool()).submit<{ output: string; data: TranspileDataLike; sourceMap?: string }>(msg)
    // Motif dominant de ce genre de bogue (« erreur
    // avalée → build vert ») : `processIncludes` (macros.ts, `<@include>`)
    // ne faisait qu'un `console.error` DANS LE WORKER pour un partial
    // introuvable / une inclusion circulaire — jamais remonté dans
    // `stats.errors`, `mjs build` continuait de rapporter un succès (exit 0)
    // alors que le composant est réellement INCOMPLET. Un pipeline CI qui ne
    // grep pas les logs bruts (juste le code de sortie) ne voyait JAMAIS le
    // problème. Fix : throw ici — remonté par le caller (parallelMap) dans
    // `stats.errors`, même sévérité que les autres cas « asset introuvable »
    // de ce volet.
    if (data.macroErrors.length > 0) {
      throw new Error(t('bundler.index.erreur-fichier-detail', { fichier: filePath, detail: data.macroErrors.join(' ; ') }))
    }
    // `opts.silent` (recompilation d'un cache-hit périmé en phase C) : toutes les
    // métadonnées ci-dessous ont DÉJÀ été poussées dans this.pending* au premier passage
    // (cache-hit CANDIDAT, phase A) — les repousser doublonnerait tagRefs/componentDeps/
    // varData/warnings, et réécrirait pour rien les satellites de variant.
    if (!opts.silent) {
      // Non fatal (contrairement
      // à macroErrors) : accumulé pour fusion dans stats.warnings en fin de compile().
      for (const w of data.sectionWarnings) {
        this.pendingSectionWarnings.push(t('bundler.index.erreur-fichier-detail', { fichier: filePath, detail: w }))
      }
      // Accumulé pour résolution en post-passe (resolveTagShortcuts,
      // APRÈS le manifeste complet) : un seul fichier ne connaît pas les autres.
      for (const ref of data.tagRefs ?? []) {
        this.pendingTagRefs.push({ file: filePath, name: ref.name, kind: ref.kind, layoutLiteral: ref.layoutLiteral })
      }
      // jumeau exact du bloc tagRefs ci-dessus — dépendances directes de CE composant
      // (balises du gabarit + modules `@import`-és), résolues contre le manifeste
      // APRÈS resolveTagShortcuts() par buildManifestDeps() (writeManifest, µ_DEPS).
      this.pendingComponentDeps.push({ moduleName, deps: [...(data.componentDeps ?? []), ...this.directImportDepKeys(content)] })
      // variants (`<style name="…">`) : chaque bloc part dans un
      // fichier satellite STABLE `<mod>.<nom>.css`, exactement le chemin que le runtime
      // construit lui-même (`${this._mjs_dir}${this._mjs_modName}.${name}.css`, cf.
      // template.ts + mjs_element.ts) — `moduleName` est ICI la MÊME valeur EXACTE que
      // `[[MOD_NAME]]`/`_mjs_modName` (basename complet, pas shortName). AUCUNE suppression
      // d'un satellite : le mécanisme historique autorise un fichier déposé À LA MAIN, et
      // un `.css` orphelin ne fait de mal à personne (un `layout=` qui ne le nomme plus ne
      // le charge simplement plus jamais) — supprimer romprait ce contrat en silence.
      for (const layoutName of Object.keys(data.layoutCss ?? {})) {
        this.writeIfChanged(join(this.outputDir, `${moduleName}.${layoutName}.css`), data.layoutCss![layoutName])
      }
      // variants — jumeau exact du chemin cache-hit plus haut.
      this.registerLayoutNames(filePath, moduleNameOverride, data.layoutCss)
      // registre des variables de thème — accumulé pour computeVarRegistry() en fin de
      // compile() (jumeau exact de pendingTagRefs ci-dessus, même raison : un seul
      // fichier ne connaît pas les autres composants du projet).
      this.pendingVarData.push({
        file: filePath,
        moduleName,
        baseCss: data.baseCss,
        layoutCss: data.layoutCss ?? {},
        themeVars: data.themeVars ?? [],
        varsRead: data.varsRead ?? [],
      })
    }
    // Accumule les animations utilisées via @transition.X / @in.X / @out.X
    const fileAnims = new Set<string>(data.usedAnimations)
    // ET via appels directs `µ.anim.X` / `window.µ.anim.X` dans le script user.
    // L'ancienne détection regex matchait dans les strings/commentaires et
    // ratait `let a = µ.anim; a.X` → on passe par un walk AST acorn ciblé sur
    // les MemberExpression réelles. Insensible aux strings, commentaires,
    // template literals.
    for (const name of this.extractAnimationsFromAst(output)) {
      fileAnims.add(name)
    }
    for (const a of fileAnims) this.usedAnimations.add(a)
    // (crash-si-feuille-absente) — accumule les feuilles @css
    // référencées par CE fichier (jumeau de fileAnims/usedAnimations juste
    // au-dessus) ; validateSharedSheets() (appelée en fin de compile(), étape 2c)
    // fait échouer le build si l'une d'elles n'a aucun fichier sur disque.
    const fileSharedCssNames = data.sharedCssNames ?? []
    for (const c of fileSharedCssNames) this.requestedSharedSheets.add(c)
    // Extraction des modules `.civet`/`.coffee` importés via `@import` —
    // ils ne sont PAS détectés par le worker (qui ne voit que les partials
    // `<@include>`) mais doivent être tracked pour que le watcher invalide
    // les .mjs parents quand le module change. Bug type : éditer le .civet
    // change son hash → le .mjs garde une référence figée à l'ancien hash
    // → import 404 au prochain chargement.
    // Même fix que preResolveAssets,
    // cf. `extractImportMatches` : masquage `<pre>`/`<code>` + regex qui ne
    // peut plus enjamber les lignes.
    const importedModules: string[] = []
    for (const im of extractImportMatches(content)) {
      const p = im[1]
      if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
    }
    // ÉCART SOLDÉ : ferme la TRANSITIVE des @import (pas seulement les
    // imports DIRECTS de ce fichier) — cf. `collectTransitiveImportClosure`,
    // mécanisme partagé avec `_compileScriptModuleInner`. Un import direct qui
    // lui-même @import-e un 3e fichier doit propager le sel jusqu'ici.
    const transitiveImportedModules = this.collectTransitiveImportClosure(importedModules)
    // Fusionne les SOURCES des µasset()
    // littéraux (remontées par preResolveAssets) avec les @import (fermeture
    // transitive), dédupliquées : toutes ces deps alimentent le hash de cache
    // ET le reverse-map, pour que le watcher invalide le parent quand N'IMPORTE
    // laquelle change, à N'IMPORTE quelle profondeur de la chaîne @import.
    const trackedDeps = [...new Set([...transitiveImportedModules, ...assetSources])]
    // Mise à jour du reverse-map "dep → parents" : chaque partial inclus, module
    // @import-é OU asset µasset() de ce fichier voit son entrée enrichie avec ce
    // parent. Permet au watcher d'invalider et recompiler les parents à tout changement.
    if (!opts.silent) this.updatePartialDependents(filePath, [...data.includedPartials, ...trackedDeps])
    const resolved = await this.resolveMagicAssets(output)
    // Jumeau du bloc extractAnimationsFromAst
    // plus haut, mais côté DÉFINITION (µanim.create/crossfade, nom en littéral) :
    // exclues du faux "manquant" par compileUsedAnimations(), cf.
    // extractDefinedAnimationsFromAst. Sur `resolved`, PAS `output` : `output`
    // brut contient encore le marqueur non résolu `µ.asset('mjs_core.js')` en
    // tête d'import (résolu par resolveMagicAssets juste au-dessus) — un JS
    // syntaxiquement INVALIDE (`from <expr>` au lieu de `from <string>`), qui
    // fait échouer acorn.parse à coup sûr, pour CHAQUE fichier compilé.
    // `extractAnimationsFromAst` encaisse ça via son fallback regex
    // (silencieux) ; cette méthode-ci n'en a délibérément PAS (cf. son propre
    // commentaire) — sur `output`, elle ne détecterait donc JAMAIS rien.
    const fileDefinedAnims = new Set<string>(this.extractDefinedAnimationsFromAst(resolved))
    for (const a of fileDefinedAnims) this.definedAnimations.add(a)
    // mode split : les feuilles DÉCLARÉES par ce module (fileSharedCssNames, cf. plus
    // haut) reçoivent ICI le REPÈRE de leur propre stem (emitSplitStyles() tourne désormais en
    // phase C, APRÈS les composants — cf. prependSplitCssImports()). `resolved` en mode
    // 'bundle' : AUCUN changement, chemin historique intact.
    const withSplitCss = this.cssMode === 'split' ? this.prependSplitCssImports(resolved, fileSharedCssNames) : resolved
    // signaux compilés (SCAN_KEYS) : sur la sortie NON MINIFIÉE (le minifieur mangle
    // les propriétés _mjs_*/_upd* via mangleCache, les marqueurs y deviennent invisibles),
    // APRÈS résolution des assets/imports split (repères compris — aucun marqueur recherché
    // ne s'y trouve). Alimente collectUsedFeatures() en phase B de compile().
    const features = [...scanCompiledFeatures(withSplitCss, data)]
    for (const f of features) this.pendingFeatures.add(f)
    // symboles du CONTRAT appelés par cette unité (core-contract.ts) — même texte, même moment,
    // mêmes raisons que les signaux ci-dessus : non minifié, après résolution des assets.
    const coreCalls = [...collectCoreCalls(withSplitCss)]
    for (const c of coreCalls) this.pendingCoreCalls.add(c)
    // `deps` = stems dont ce code contient le repère (cœur, feuilles split, AUTRES unités
    // @import/µasset-ées) — calculé sur le code NON MINIFIÉ : un repère est un CHEMIN
    // LITTÉRAL dans un import, jamais touché par le mangling (qui ne renomme que des
    // propriétés `_mjs_*`/`_upd*') — pas besoin d'attendre la minification (différée
    // plus bas) pour le connaître, l'émission topologique de compile() les résout dans
    // l'ordre de leurs dépendances.
    const deps = this.extractPlaceholderDeps(withSplitCss)
    // même sel qu'avant, mais SANS coreHashedPath/cssSalt (retirés du hash lui-même,
    // cf. bandeau de _compileMjsInner) : hash = contenu SOURCE + deps, un point c'est tout.
    const hash = this.hashWithDeps(content, [...data.includedPartials, ...trackedDeps])
    // ce fichier vient d'être RECOMPILÉ (cache miss/périmé) : il fait donc partie du "lot" de
    // changements de ce compile(). S'il n'a QUE son CSS de différent vs la dernière fois →
    // éligible "css-only" ; sinon (ou 1ʳᵉ apparition, rien à comparer) → disqualifie tout le
    // lot. Comportement inchangé (indépendant du cœur/des chemins finaux) — et indépendant
    // de la minification, donc calculé ICI, pas dans la tâche différée plus bas.
    if (!opts.silent && this.cssOnlyTracking) {
      const prevData = this.lastComponentData.get(filePath)
      if (prevData && dataEqualExceptBaseCss(prevData, data)) {
        const scopedCss = computeScopedCss(data)
        this.cssOnlyComponents[data.tagName] = scopedCss
        if (data.aliasTag && data.aliasTag !== data.tagName) this.cssOnlyComponents[data.aliasTag] = scopedCss
        // Réémission attendue d'un lot css-only (baseCss entre dans le hash du
        // fichier) — exemptée du filet central de writeHashed (cf. compile()).
        this.cssOnlyAllowedWrites.add(`${moduleName}.js`)
      } else {
        this.cssOnlyDisqualified = true
      }
      this.lastComponentData.set(filePath, data)
    }
    // noms portés par nom sur une instance (état, props écrites sur un enfant, méthodes) : sur la
    // sortie NON MINIFIÉE, comme les signaux compilés ci-dessus — réservés avant toute
    // minification du tour (cf. reserveInstanceNames()), inutiles sans minification
    const reservedNames = this.shouldMinify() ? collectInstanceNames(withSplitCss) : []
    // Minification DIFFÉRÉE (cf. bandeau de `pendingMinifyTasks`) : `minifyJs` ne tourne
    // plus ICI, en parallèle avec les autres unités de la phase A — seul
    // `flushPendingMinifyTasks()` l'appelle, séquentiellement, triée par stem.
    this.pendingMinifyTasks.push({
      stem: moduleName,
      names: reservedNames,
      run: async () => {
        const minified = await minifyJs(withSplitCss, {
          force: this.shouldMinify(),
          filename: basename(filePath),
          sourceMap: this.shouldEmitSourceMap(),
          mangleCache: this.mangleCache,
          logLevel: this.prodLogLevel(),
        })
        // carte de source ÉCRITE. Deux cas, une seule règle : ce qui est écrit
        // doit pointer le `.mjs`, jamais un état intermédiaire.
        //   • sans minification (le cas du développement) : la carte du transpileur EST
        //     celle du fichier écrit, au décalage près des imports de feuilles ajoutés
        //     en tête par le mode `css: 'split'` ;
        //   • avec esbuild : sa carte parle du texte que NOUS lui avons donné — on la
        //     recompose par-dessus la nôtre pour retomber sur le `.mjs`.
        const emitMap = this.shouldEmitSourceMap()
        let writtenMap = minified.map
        if (emitMap && transpileMap) {
          const prefixLines = withSplitCss.length - resolved.length > 0
            ? withSplitCss.slice(0, withSplitCss.length - resolved.length).split('\n').length - 1
            : 0
          const aligned = shiftGeneratedPosition(transpileMap, prefixLines, 0)
          writtenMap = minified.map ? chainOverMap(minified.map, aligned) : aligned
        }
        // PLUS de writeHashed()/this.cache.set() ICI : le chemin final n'existe pas
        // encore (le cœur/les feuilles split ne sont connus qu'en phase C). L'unité part
        // en attente d'émission topologique.
        this.pendingUnits.set(moduleName, {
          kind: 'cold',
          file: filePath,
          stem: moduleName,
          ext: '.js',
          code: minified.code,
          map: writtenMap,
          deps,
          features,
          cacheFields: {
            hash,
            usedAnimations: [...fileAnims],
            definedAnimations: [...fileDefinedAnims],
            sharedCssNames: [...fileSharedCssNames],
            includedPartials: [...data.includedPartials],
            importedModules: [...trackedDeps],
            baseCss: data.baseCss,
            layoutCss: data.layoutCss ?? {},
            themeVars: data.themeVars ?? [],
            varsRead: data.varsRead ?? [],
            tagRefs: (data.tagRefs ?? []).map(r => ({ name: r.name, kind: r.kind, layoutLiteral: r.layoutLiteral })),
            componentDeps: [...(data.componentDeps ?? [])],
            reservedNames,
            coreCalls,
            // lue ICI, au moment où ce code vient d'être minifié (cf. CacheEntry.mangleGen)
            mangleGen: this.mangleGeneration,
          },
        })
      },
    })
    return this.placeholderPath(moduleName, '.js')
  }

  // --------------------------------------------------------------------------
  // hashWithDeps : SHA-256 contenu source + concat des contenus des deps
  // (partials inclus). 16 chars suffisent pour la collision en pratique (la
  // clé n'est pas utilisée comme identifiant cryptographique, juste pour
  // détecter un changement de contenu).
  // --------------------------------------------------------------------------
  private hashWithDeps(content: string, deps: string[]): string {
    const h = createHash('sha256')
    h.update(content)
    // Tri pour stabilité — l'ordre de découverte des partials peut varier
    // entre exécutions, mais le hash doit être déterministe.
    for (const dep of [...deps].sort()) {
      try {
        h.update('\0')  // séparateur pour éviter collision content||dep
        h.update(this.depDigest(dep))
      } catch {
        // Dep introuvable (renommée/supprimée) : on inclut le path lui-même
        // pour invalider quand même.
        h.update(dep)
      }
    }
    return h.digest('hex').slice(0, 16)
  }

  // --------------------------------------------------------------------------
  // depDigest : SHA-256 du CONTENU d'une dépendance, mémoïsé par chemin et
  // validé par (mtimeNs, size). La fraîcheur reste décidée par le CONTENU — le
  // mtime ne tranche JAMAIS seul : au moindre écart de date ou de taille on
  // relit le fichier et on re-hache, exactement comme avant. Ce qui disparaît,
  // c'est la relecture redondante : un partial partagé par 30 composants était
  // relu 30 fois par tour, et re-relu à chaque tick du watcher même immobile.
  // Précision nanoseconde (stat bigint) — deux écritures dans la même
  // milliseconde restent distinguées.
  // --------------------------------------------------------------------------
  private depDigestCache = new Map<string, { mtimeNs: bigint; size: bigint; digest: Buffer }>()

  private depDigest(dep: string): Buffer {
    const st     = statSync(dep, { bigint: true })
    const cached = this.depDigestCache.get(dep)
    if(cached && cached.mtimeNs === st.mtimeNs && cached.size === st.size) return cached.digest
    const digest = createHash('sha256').update(readFileSync(dep)).digest()
    this.depDigestCache.set(dep, { mtimeNs: st.mtimeNs, size: st.size, digest })
    return digest
  }

  // --------------------------------------------------------------------------
  // collectTransitiveImportClosure : ferme récursivement l'ensemble des
  // modules `@import`-és — PAS seulement profondeur 1 (bogue réel vérifié :
  // A @import B, B @import C ; seul C change → B recompile et change de hash,
  // mais A ne relisait jusqu'ici QUE le contenu ACTUEL de B au moment du
  // hash — s'il faisait un cache-hit périmé sur SON PROPRE stamp stocké, la
  // propagation s'arrêtait à B et A rendait une valeur figée, silencieusement).
  //
  // Factorisée ICI (mécanisme PARTAGÉ, un seul point de vérité) : appelée par
  // `_compileMjsInner` (composants .mjs, `trackedDeps`) ET par
  // `_compileScriptModuleInner` (modules autonomes .civet/.coffee,
  // `importedModules`) — même extraction (`extractImportMatches`), même
  // résolution de chemin (`resolve(this.sourceDir, p)`) que l'existant en
  // profondeur 1, juste itérée sur le contenu de CHAQUE dépendance à son tour.
  //
  // `visited` coupe les cycles : un cycle A↔B via @import est déjà REJETÉ
  // ailleurs (compileWithDedup, détection dédiée) — ici on doit juste ne
  // jamais boucler ni jeter, `visited` (BFS) suffit.
  //
  // Pas de mémoïsation inter-appels : les fichiers changent PENDANT un build
  // incrémental (watcher) — un cache basé sur le path seul rouvrirait
  // exactement le bug qu'on corrige (contenu périmé). Le seul motif déjà en
  // place ici est le dédoublonnage par `visited` À L'INTÉRIEUR d'un même
  // appel, ce qui suffit à ne jamais relire deux fois le même fichier pour
  // une closure donnée.
  // --------------------------------------------------------------------------
  // confineImportedPath() — même garde que <@include>/les liens : un
  // `@import`/`µimport` relatif (`../dehors/x.civet`) résolvait n'importe où hors sourceDir,
  // SANS garde — content lu (hashWithDeps/depDigest) pour un fichier hors du projet, avant même
  // que resolveOneAsset (préresolution des assets, confinement déjà en place) ne refuse la
  // référence pour de bon. Confinement LEXICAL seul ici : ce chemin ne sert JAMAIS à publier du
  // contenu (juste au hash de cache et au reverse-map du watcher) — hors racine → ignoré.
  private confineImportedPath(p: string): string | null {
    const root = resolve(this.sourceDir)
    const abs = resolve(this.sourceDir, p)
    if (abs !== root && !abs.startsWith(root + sep)) return null
    return abs
  }

  private collectTransitiveImportClosure(seedPaths: string[]): string[] {
    const visited = new Set<string>()
    const queue = [...seedPaths]
    while (queue.length > 0) {
      const depPath = queue.shift()!
      if (visited.has(depPath)) continue
      visited.add(depPath)
      let depSrc: string
      try {
        depSrc = readFileSync(depPath, 'utf-8')
      } catch {
        continue  // dep introuvable : hashWithDeps gère déjà ce cas (hash du path lui-même)
      }
      for (const im of extractImportMatches(depSrc)) {
        const p = im[1]
        if (/^https?:\/\//.test(p)) continue
        const resolved = this.confineImportedPath(p)
        if (resolved && !visited.has(resolved)) queue.push(resolved)
      }
      // Même fermeture pour la forme NUE `µimport('X')`/`mjsimport('X')`
      // (appel direct, sans `@import name 'chemin'`) : sans ce volet, un module
      // .civet/.coffee @import-é qui appelle lui-même µimport() sur un asset
      // voit sa cible absente de `visited` — hash + reverse-map watch jamais
      // mis à jour quand cet asset change (cf. commentaire de MU_IMPORT_CALL_RE).
      for (const im of maskCodeBlocks(depSrc).matchAll(MU_IMPORT_CALL_RE)) {
        const p = im[1]
        if (/^https?:\/\//.test(p)) continue
        const resolved = this.confineImportedPath(p)
        if (resolved && !visited.has(resolved)) queue.push(resolved)
      }
      // Même fermeture pour la forme nue sans parenthèses
      for (const im of maskCodeBlocks(depSrc).matchAll(MU_IMPORT_BARE_RE)) {
        const p = im[1]
        if (/^https?:\/\//.test(p)) continue
        const resolved = this.confineImportedPath(p)
        if (resolved && !visited.has(resolved)) queue.push(resolved)
      }
    }
    return [...visited]
  }

  // --------------------------------------------------------------------------
  // extractAnimationsFromAst : parse le JS compilé et extrait les noms
  // d'animations référencées via `µ.anim.X` ou `window.µ.anim.X`.
  //
  // Remplace l'ancienne regex `µ\??\.anim\??\.([a-zA-Z0-9_]+)` qui matchait :
  //   - dans les strings : `µ.log('µ.anim.fade utilisé')` → faux positif
  //   - dans les commentaires : `// voir µ.anim.fade` → faux positif
  //   - dans les template literals : idem
  //
  // Et qui ratait :
  //   - les alias : `const a = µ.anim; a.fade(...)` (mais pas pris en charge ici
  //     non plus — l'alias casse aussi en V1, c'est une convention user)
  //
  // L'analyse AST est cleanly insensible au contexte string/comment et fournit
  // des résultats fiables. Si le code ne parse pas (esoteric Civet runtime
  // output), on retombe sur la regex en safety.
  // --------------------------------------------------------------------------
  private extractAnimationsFromAst(js: string): string[] {
    const anims = new Set<string>()
    let ast: acorn.Node
    try {
      ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch {
      // Fallback regex si parse échoue
      const matches = js.match(/(?:window\.)?µ\??\.anim\??\.([a-zA-Z0-9_]+)/g) ?? []
      for (const m of matches) {
        const name = m.match(/anim\??\.([a-zA-Z0-9_]+)/)?.[1]
        if (name) anims.add(name)
      }
      return [...anims]
    }

    // isMuIdentifier/isAnimNode : fonctions module-level ci-dessus (partagées
    // avec extractDefinedAnimationsFromAst, cf. leur commentaire).
    walk.simple(ast, {
      MemberExpression(node: any) {
        // node = `<anim>.X` → on veut node.object être `µ.anim`
        if (node.property?.type !== 'Identifier') return
        if (isAnimNode(node.object)) {
          anims.add(node.property.name)
        }
      },
    })

    return [...anims]
  }

  // --------------------------------------------------------------------------
  // extractDefinedAnimationsFromAst : jumeau AST de
  // extractAnimationsFromAst ci-dessus, mais côté DÉFINITION plutôt qu'usage.
  // Détecte les appels `µ.anim.create('nom', …)` / `µ.anim.crossfade('nom', …)`
  // (ou `window.µ.anim.…`) avec un 1er argument littéral string, et renvoie
  // les noms d'anim que CE fichier enregistre dynamiquement à l'exécution :
  //   - create('X')    → 'X'
  //   - crossfade('X') → 'XSend' + 'XReceive' (cf. runtime/animations/crossfade.ts)
  //
  // Sans ça, `compileUsedAnimations` (détecteur STATIQUE, ne voit que les
  // fichiers `<runtimeDir>/animations/*.ts`) traite ces noms comme manquants
  // — faux positif : ils existent bel et bien, juste enregistrés au runtime
  // par le `<script>` du composant, avant le rendu qui les utilise.
  //
  // Même garde-fou que extractAnimationsFromAst : parse échoué → `[]` (le
  // fallback regex de la méthode sœur reste la seule voie de secours utile
  // ici — resterait alors un faux "manquant" pour ce fichier précis, non
  // bloquant : au pire un warning bruyant, jamais un crash).
  // --------------------------------------------------------------------------
  private extractDefinedAnimationsFromAst(js: string): string[] {
    const defined = new Set<string>()
    let ast: acorn.Node
    try {
      ast = acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch {
      return []
    }

    walk.simple(ast, {
      CallExpression(node: any) {
        const callee = node.callee
        if (!callee || callee.type !== 'MemberExpression') return
        if (callee.property?.type !== 'Identifier') return
        const method = callee.property.name
        if (method !== 'create' && method !== 'crossfade') return
        if (!isAnimNode(callee.object)) return
        const arg = node.arguments?.[0]
        if (!arg || arg.type !== 'Literal' || typeof arg.value !== 'string') return
        if (method === 'create') {
          defined.add(arg.value)
        } else {
          defined.add(`${arg.value}Send`)
          defined.add(`${arg.value}Receive`)
        }
      },
    })

    return [...defined]
  }

  // --------------------------------------------------------------------------
  // updatePartialDependents : remplace les entrées du reverse-map pour ce
  // parent (on retire les vieilles deps puis on ajoute les nouvelles).
  // --------------------------------------------------------------------------
  private updatePartialDependents(parent: string, partials: string[]): void {
    // Retire `parent` de toutes les anciennes entrées (au cas où une @include
    // a été supprimée du fichier).
    for (const set of this.partialDependents.values()) set.delete(parent)
    // Ajoute `parent` aux entrées des partials actuellement inclus.
    for (const partial of partials) {
      let set = this.partialDependents.get(partial)
      if (!set) { set = new Set(); this.partialDependents.set(partial, set) }
      set.add(parent)
    }
  }

  // --------------------------------------------------------------------------
  // compileScriptModule() : .civet|.coffee → .js via adapter approprié.
  // Wrappé dans `withState()` comme compileMjs pour isolation parallèle.
  //
  // Dédup + détection de cycle : cf. le commentaire détaillé de
  // `compileWithDedup`/`compileMjs` — MÊME mécanisme partagé (un `.mjs` peut
  // référencer ce `.civet`, qui peut lui-même référencer un `.mjs`, donc un
  // cycle peut traverser les deux types de fichiers).
  // --------------------------------------------------------------------------
  async compileScriptModule(filePath: string, ext: '.civet' | '.coffee'): Promise<string> {
    return this.compileWithDedup(filePath, () => withState(() => this._compileScriptModuleInner(filePath, ext)) as Promise<string>)
  }

  private async _compileScriptModuleInner(filePath: string, ext: '.civet' | '.coffee'): Promise<string> {
    const cacheKey = filePath
    const cached = this.cache.get(cacheKey)
    const src = readFileSync(filePath, 'utf-8')
    const baseName = basename(filePath, ext)
    // PLUS de sel du cœur dans ce hash (cf. bandeau jumeau de _compileMjsInner) : la
    // sortie compilée en mémoire n'embarque plus qu'un REPÈRE, identique d'un tour à l'autre
    // tant que le SOURCE ne change pas. Un cache-hit ICI n'est qu'un CANDIDAT, confirmé ou
    // périmé en phase C (cf. compile(), `CacheEntry.embeds`). Historique du bug que ce sel
    // corrigeait avant ce mécanisme : le hash de cache n'était calculé QUE sur `src`, sans sel du
    // core — or `autoImportMu()` plus bas embarque en dur
    // `import { µ } from '<coreHashedPath>'` dans la sortie compilée. En watch,
    // rebuild du runtime → nouveau mjs_core-<hash>, ANCIEN supprimé ; un module
    // .civet/.coffee dont le SOURCE n'a pas changé faisait un cache hit (même
    // stamp) → renvoyait un hashedPath dont le fichier sur disque pointe encore
    // l'ANCIEN core, disparu → 404 généralisé au chargement, jusqu'à toucher
    // manuellement le fichier. Ceinture + bretelles (même garde que _compileMjsInner) :
    // exige AUSSI que le fichier de sortie existe encore sur disque.
    // ÉCART SOLDÉ : le stamp est salé AVEC la fermeture TRANSITIVE des
    // modules `@import`-és — pas seulement les imports DIRECTS de ce fichier
    // (limite corrigée : A @import B, B @import C, seul C change → sans la
    // fermeture, B recompile et change de hash, mais A cache-hit sur SON
    // PROPRE stamp figé référençait encore l'ANCIEN hash de B, silencieusement).
    // MIROIR exact de `_compileMjsInner`/`trackedDeps` — même ingrédient
    // (contenu brut de chaque dépendance, relu par `hashWithDeps`, pas un
    // mtime/taille) et même résolution de chemin (`resolve(this.sourceDir,
    // p)`, IDENTIQUE à celle de `resolveOneAsset` — `join(this.sourceDir,
    // logicalPath)` — donc aucun risque de diverger de ce que `resolveMagicAssets`
    // résout réellement plus bas), la fermeture elle-même factorisée dans
    // `collectTransitiveImportClosure` (mécanisme PARTAGÉ avec les composants
    // .mjs). Extraction directe via `extractImportMatches(src)`, la même
    // fonction que côté composants (regex + masquage `<pre>`/`<code>`),
    // appliquée ici sur le SOURCE brut du module (pas sur `dir.pendingAutoImports`,
    // pour ne pas dupliquer la logique de directives.ts) ; la fermeture
    // récursive relit ensuite chaque dépendance à son tour. Un chemin `@import`
    // introuvable n'est PAS re-throw ici : `hashWithDeps` retombe sur son propre
    // filet (hash du path lui-même si `readFileSync` échoue, cf. son commentaire)
    // — l'erreur claire existante reste celle levée plus bas par `resolveMagicAssets`
    // (MISSING_MJS_ASSET) au moment de la résolution réelle.
    //
    // Stratégie ceinture + bretelles identique à `_compileMjsInner` : sur un
    // cache hit potentiel, on réutilise `cached.importedModules` (la fermeture
    // TRANSITIVE CONNUE au tour précédent) plutôt que de re-scanner `src` — si
    // un NOUVEL `@import` a été ajouté, le texte de `src` a changé, donc le
    // hash change de toute façon via le contenu ; si SEUL un module de la
    // chaîne (direct OU transitif) a changé, son contenu relu par
    // `hashWithDeps` diffère → hash différent → cache miss, recompilation,
    // nouvelle fermeture (et nouveau hash) propagés.
    const importedModules: string[] = []
    for (const im of extractImportMatches(src)) {
      const p = im[1]
      if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
    }
    // Un `µimport('X')`/`mjsimport('X')` DIRECT dans CE module (forme
    // nue, sans passer par un `@import name 'chemin'`) est invisible à
    // `extractImportMatches` ci-dessus : sans ce volet, la cible n'entre ni
    // dans `importedModules` (seed de `collectTransitiveImportClosure` plus
    // bas) ni dans le cache hit de CE module — édition de l'asset jamais
    // répercutée, staleness silencieuse (même bug que côté composants .mjs,
    // cf. MU_IMPORT_CALL_RE/preResolveAssets, mais ce chemin-ci ne passait pas
    // par cette fonction).
    for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_CALL_RE)) {
      const p = im[1]
      if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
    }
    // Même chose pour la forme nue sans parenthèses
    for (const im of maskCodeBlocks(src).matchAll(MU_IMPORT_BARE_RE)) {
      const p = im[1]
      if (!/^https?:\/\//.test(p)) { const abs = this.confineImportedPath(p); if (abs) importedModules.push(abs) }
    }
    if (cached) {
      const expectedHash = this.hashWithDeps(src, cached.importedModules ?? [])
      if (cached.hash === expectedHash && this.cachedUnitStillOnDisk(cached)) {
        // Cache hit CANDIDAT : réinjecte les animations détectées pour ce module — même
        // hygiène que _compileMjsInner (cf. son commentaire ci-dessus) : sinon
        // un module autonome inchangé disparaît du Set partagé `usedAnimations`
        // au prochain rebuild incrémental (watcher) qui ne le recompile pas.
        for (const a of cached.usedAnimations ?? []) this.usedAnimations.add(a)
        // Même hygiène pour les anims DÉFINIES
        // dynamiquement, cf. le commentaire jumeau de _compileMjsInner.
        for (const a of cached.definedAnimations ?? []) this.definedAnimations.add(a)
        // signaux compilés : même hygiène que usedAnimations (cf. _compileMjsInner).
        for (const f of cached.features ?? []) this.pendingFeatures.add(f)
        // symboles du CONTRAT : même hygiène (cf. CacheEntry.coreCalls).
        for (const c of cached.coreCalls ?? []) this.pendingCoreCalls.add(c)
        // PLUS de `emittedThisCompile.add`/`cacheHitsThisCompile++` ICI : confirmé ou
        // invalidé seulement en phase C (cf. _compileMjsInner, même raisonnement). Rend le
        // REPÈRE, jamais le chemin final.
        this.pendingUnits.set(baseName, { kind: 'cached', file: filePath, stem: baseName, cached })
        return this.placeholderPath(baseName, '.js')
      }
    }
    return this.compileScriptModuleCold(filePath, ext, baseName, importedModules, src)
  }

  // --------------------------------------------------------------------------
  // compileScriptModuleCold() : chemin FROID de compilation d'un module .civet/
  // .coffee autonome — extrait de _compileScriptModuleInner pour être réutilisé par la phase
  // C de compile() quand un cache-hit CANDIDAT se révèle PÉRIMÉ. Contrairement à
  // compileMjsCold() (composants .mjs), aucune métadonnée n'est poussée dans `this.pending*`
  // pour un module autonome (pas de tagRefs/componentDeps/varData/layoutCss) : rien à
  // distinguer entre 1er passage et recompilation périmée, pas de paramètre `silent`.
  // --------------------------------------------------------------------------
  private async compileScriptModuleCold(filePath: string, ext: '.civet' | '.coffee', baseName: string, importedModules: string[], src: string): Promise<string> {
    // Apply MJS sugar (µ. routing, runes µ$X, µ.minmax) AVANT compile langage.
    // Permet aux modules user d'utiliser µ$X = ... etc.
    const { applyMjsSugarToScript, lintNoRawImport, lintSplitRune, normalizeSigilAlias } = await import('../transpiler/index.js')
    const { extractDirectives } = await import('../transpiler/directives.js')
    const { tokenize } = await import('../lexer/index.js')
    // Passer le lang au sucre : sans lui, un module .coffee autonome
    // était civet-isé (for-in→of, etc.) puis rejeté par le compilateur Coffee
    const langName = ext === '.civet' ? 'civet' : 'coffee'
    // Lève limite 1 (cf. ssr-topo-sort-cycle-detection.test.ts, commentaire
    // en tête) : `@import` À L'INTÉRIEUR d'un module autonome n'était pas
    // reconnu (Civet le parsait comme `this.import(...)`, absurde). Même
    // canal que les composants .mjs (extractDirectives → pendingAutoImports,
    // cf. transpiler/index.ts "3. Auto-imports") — `resolveMagicAssets`
    // ci-dessous réécrit ensuite le `µasset('chemin')` injecté vers le nom
    // HACHÉ, sans autre changement de pipeline. Un module autonome n'a pas de
    // <style>/<@include>/persist/i18n/viewTransition : seul `pendingAutoImports`
    // a un sens ici — les autres champs de `DirectivesResult` (sharedCssNames,
    // moduleDisplay, persist*, i18n*, viewTransition*) sont silencieusement
    // ignorés (aucune section HTML/style à laquelle les appliquer dans un module).
    //
    // `@import µ$$X` (singleton réactif EXPORTÉ, forme courante — ou son
    // ancienne écriture `§§X`) reste interdit dans un module : c'est un
    // mécanisme de COMPOSANT (rendu réactif), pas de module autonome. Ni `§`
    // ni `µ` ne sont dans le charset de la regex `@import` de directives.ts
    // (contrairement à `$`) — sans ce garde-fou dédié, la ligne resterait donc
    // non reconnue et repartirait telle quelle vers Civet/Coffee (retour à la
    // limite 1, erreur de parse cryptique). Détecté ICI sur le source brut,
    // avant extractDirectives, pour un message explicite.
    const singletonImportLine = src.match(/^[ \t]*@import[ \t]+(?:default[ \t]+)?[^\n]*(?:§§|µ\$\$)[a-zA-Z0-9_]+[^\n]*$/m)
    if (singletonImportLine) {
      throw new Error(t('bundler.index.singleton-import-module-ligne', { fichier: basename(filePath), ligne: singletonImportLine[0].trim() }))
    }
    // rune séparée de son symbole (`µ` puis `.toast(…)` à la ligne suivante) : même refus qu'un composant, situé
    // sur la ligne du fichier
    lintSplitRune(src, basename(filePath), { sigil: this.sigil, lang: langName })
    const dir = extractDirectives(src)
    // Ceinture + bretelles : capte aussi la forme `@import $nomLitéral 'chemin'`
    // (dollar en clair, charset autorisé par la regex de directives.ts) —
    // même verdict que la forme `µ$$X`/`§§X` ci-dessus.
    if (dir.externalReactives.size > 0) {
      throw new Error(t('bundler.index.singleton-import-module-dollar', { fichier: basename(filePath), noms: [...dir.externalReactives].join(', ') }))
    }
    // alias ASCII du symbole (`sigil: 'mjs'`) : `mjs.x`/`mjs$x` → `µ.x`/`µ$x`, comme pour le script d'un composant
    // (transpiler/index.ts, étape 4b) — sans lui, un module importé émettait `mjs.log(…)` tel quel, `mjs` inconnu à
    // l'exécution
    const aliased   = normalizeSigilAlias(dir.cleaned, this.sigil)
    const moduleSrc = dir.pendingAutoImports.length > 0
      ? dir.pendingAutoImports.join('\n') + '\n' + aliased
      : aliased
    const preProcessed = tokenize(applyMjsSugarToScript(moduleSrc, langName), { moduleMode: true })
    const adapter = getAdapter(langName)
    // l'adaptateur retourne `{ code, map }` ; ce chemin-ci
    // (module `@import`-é autonome) ne se sert que du code — sa carte n'a personne à qui parler,
    // le fichier n'ayant ni gabarit ni bloc `<script>` à décaler
    let js = (await adapter.compileToJs(preProcessed, { fileName: basename(filePath), bare: true })).code
    // Civet préserve les assignations top-level bares (`foo = 1`) telles
    // quelles. En ESM strict mode c'est illégal. CoffeeScript en mode `bare`
    // injecte des `var` automatiquement ; on reproduit ce comportement pour
    // Civet en post-process.
    if (langName === 'civet') js = autoDeclareTopLevelBareAssignments(js)
    // Lève limite 2 (cf. ssr-topo-sort-cycle-detection.test.ts, commentaire en
    // tête) : un `import {x} from './y.module.civet'` NATIF compilait tel quel
    // SANS réécriture vers le nom haché → `x` undefined en prod, silencieusement,
    // même sans aucune circularité. Décision de design : pas de réécriture des
    // imports natifs — REJET explicite (même garde que les composants .mjs,
    // cf. lintNoRawImport et son appel sur `<script module>`), un seul canal
    // d'import partout. `allowedLeadingImports` exempte les N imports RÉELS
    // injectés juste au-dessus par `dir.pendingAutoImports` (résolution @import).
    lintNoRawImport(js, `<script module> (${basename(filePath)})`, dir.pendingAutoImports.length)
    // Voie AST (post-Civet) : ferme le trou du gabarit (µimport niché
    // dans une interpolation ${…}/#{…}) pour ce module .civet/.coffee
    // autonome — remplace l'ancienne réécriture par scanner (rewriteMuImport,
    // retirée d'applyMjsSugarToScript, transpiler/index.ts). AVANT
    // `resolveMagicAssets` (plus bas) : le `µasset(...)` qui en naît doit
    // encore lui être soumis pour se résoudre en chemin haché réel.
    js = rewriteMuImportAst(js, `<script module> (${basename(filePath)})`)
    // Scanne aussi ce module autonome pour `µ.anim.X` (même détection que les
    // composants .mjs, cf. extractAnimationsFromAst plus bas et son appel
    // dans _compileMjsInner) : un helper `@import`-é qui enregistre une anim
    // par appel direct (ex. `µanim.crossfade('todo', ...)`, sans aucun
    // `@transition/@in/@out` DANS ce fichier) n'était jusqu'ici JAMAIS ajouté
    // à `usedAnimations` — cette détection ne portait que sur la sortie
    // compilée des .mjs. `compileUsedAnimations` n'émettait donc jamais
    // `µ.anim.crossfade`, laissé `undefined` → `µ.anim.crossfade is not a
    // function` au premier appel côté composant.
    const fileAnims = this.extractAnimationsFromAst(js)
    for (const a of fileAnims) this.usedAnimations.add(a)
    // Jumeau du bloc ci-dessus pour les
    // anims DÉFINIES dynamiquement (µanim.create/crossfade, nom en littéral),
    // même raisonnement que dans _compileMjsInner.
    const fileDefinedAnims = this.extractDefinedAnimationsFromAst(js)
    for (const a of fileDefinedAnims) this.definedAnimations.add(a)
    // ORDRE CRITIQUE (bug trouvé en écrivant les tests de la levée limite 1) :
    // `resolveMagicAssets` DOIT tourner AVANT `autoImportMu`. Un `@import`
    // résolu ci-dessus injecte encore un placeholder LITTÉRAL
    // `"µasset('chemin')"` à ce stade (non résolu) — sa détection naïve
    // `code.includes('µ')` matchait ce placeholder (le caractère µ du MOT
    // "µasset", rien à voir avec le rune `µ` réel) et injectait un faux
    // `import { µ } from '<core>'` MÊME dans un module qui n'utilise jamais
    // µ → `mjs_core.js` chargé hors navigateur (Node/SSR) plante
    // (`CSSStyleSheet is not defined`, API DOM absente). Résoudre D'ABORD les
    // µasset() fait disparaître le placeholder ; `autoImportMu` ne voit alors
    // plus que les VRAIS usages de `µ` dans le code utilisateur.
    const resolved = await this.resolveMagicAssets(js)
    const withImport = this.autoImportMu(resolved)
    // signaux compilés : aucun TranspileData ici (module autonome, jamais de
    // `<style name>`) — `layout_variant` retombe sur le seul texte compilé (cf.
    // scanCompiledFeatures). Sur `withImport`, AVANT minify (mêmes raisons que
    // compileMjsCold : le minifieur mangle les symboles `_mjs_*`/`_upd*`).
    const features = [...scanCompiledFeatures(withImport)]
    for (const f of features) this.pendingFeatures.add(f)
    // symboles du CONTRAT — jumeau de compileMjsCold (cf. core-contract.ts).
    const coreCalls = [...collectCoreCalls(withImport)]
    for (const c of coreCalls) this.pendingCoreCalls.add(c)
    // `deps` sur le code NON MINIFIÉ (cf. bandeau jumeau de compileMjsCold : un repère est
    // un chemin littéral, jamais touché par le mangling) — pas besoin d'attendre la
    // minification différée plus bas.
    const deps = this.extractPlaceholderDeps(withImport)
    // Fermeture TRANSITIVE calculée seulement ici (cache MISS/périmé confirmé, cf. le
    // commentaire en tête de méthode) — pas plus tôt, pour ne jamais relire
    // inutilement les dépendances sur un cache hit qui retourne avant ce point.
    const transitiveImportedModules = this.collectTransitiveImportClosure(importedModules)
    // même sel qu'avant, mais SANS coreHashedPath (retiré du hash lui-même).
    const hash = this.hashWithDeps(src, transitiveImportedModules)
    // noms portés par nom sur une instance : un module peut écrire sur un composant (cf.
    // compileMjsCold, même relevé sur le code NON MINIFIÉ)
    const reservedNames = this.shouldMinify() ? collectInstanceNames(withImport) : []
    // Minification DIFFÉRÉE (cf. bandeau de `pendingMinifyTasks` sur compileMjsCold, même
    // raisonnement — mangleCache PARTAGÉ, doit rester séquentiel et trié par stem).
    this.pendingMinifyTasks.push({
      stem: baseName,
      names: reservedNames,
      run: async () => {
        const minified = await minifyJs(withImport, {
          force: this.shouldMinify(),
          filename: basename(filePath),
          sourceMap: this.shouldEmitSourceMap(),
          mangleCache: this.mangleCache,
          logLevel: this.prodLogLevel(),
        })
        // PLUS de writeHashed()/this.cache.set() ICI (cf. compileMjsCold, même
        // raisonnement) : l'unité part en attente d'émission topologique.
        this.pendingUnits.set(baseName, {
          kind: 'cold',
          file: filePath,
          stem: baseName,
          ext: '.js',
          code: minified.code,
          map: minified.map,
          deps,
          features,
          cacheFields: {
            hash,
            usedAnimations: fileAnims,
            definedAnimations: fileDefinedAnims,
            importedModules: transitiveImportedModules,
            reservedNames,
            coreCalls,
            mangleGen: this.mangleGeneration,
          },
        })
      },
    })
    return this.placeholderPath(baseName, '.js')
  }

  // --------------------------------------------------------------------------
  // autoImportMu() : si le code source utilise µ (mais ne l'importe pas déjà),
  // préfixe `import { µ } from '<core hashed path>';`. Utilisé pour tous les
  // modules ES qui pourraient référencer µ : mjs_anims, mjs_styles, .coffee,
  // composants .mjs, etc.
  //
  // Détection conservative : `\bµ` matche la lettre µ comme identifiant.
  // Idempotent : si l'import existe déjà, no-op.
  // --------------------------------------------------------------------------
  private autoImportMu(code: string): string {
    // µ (U+00B5) n'est pas un word-char en regex JS, on évite \b
    if (!code.includes('µ')) return code
    // Déjà importé ?
    if (/import\s+\{[^}]*µ[^}]*\}\s+from\s+/m.test(code)) return code
    // la garde `if (!this.coreHashedPath) return code` a disparu : elle rendait un
    // module qui utilise µ SANS import, silencieusement cassé. En phase A, le cœur est
    // encore inconnu → REPÈRE, résolu en phase C (cf. compile()).
    return `import { µ } from '${this.coreHashedPath || this.placeholderPath('mjs_core', '.js')}';\n${code}`
  }

  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // compileThemeFiles() : les `*.theme.mjs` → une feuille de document unique.
  //
  // Un thème est un paquet de variables, pas un composant : rien à enregistrer comme
  // custom element, rien à hacher, rien à charger à la demande. Le CSS agrégé part dans
  // le manifeste (`µ._themeCss`) et la liste des noms avec lui (`µ._themes`) — c'est
  // elle qui autorise la rune `µtheme` à accepter autre chose que clair/sombre.
  // Une erreur ici FAIT ÉCHOUER le build : un thème qui ne compile pas donnerait une
  // page sans couleurs, exactement le genre de panne qu'on découvre en regardant.
  // --------------------------------------------------------------------------
  compileThemeFiles(files: string[]): void {
    this.themeCss       = ''
    this.themeNames     = []
    this.themeVarData = []
    if (files.length === 0) return
    const compiles = files.map(f => compileThemeFile(readFileSync(f, 'utf-8'), f, { varPrefix: this.varPrefix, defaultTheme: this.defaultTheme }))
    this.themeCss   = assembleThemes(compiles, this.defaultTheme)
    this.themeNames = compiles.map(th => th.name)
    // registre des variables de thème — CompiledTheme.vars/.read étaient jetés ici : c'est
    // TOUT ce qu'il manquait pour que computeVarRegistry() sache ce qu'un fichier de
    // thème déclare et lit (jumeau exact de ce que le transpiler remonte déjà par composant).
    this.themeVarData = compiles.map((th, i) => ({ file: files[i], name: th.name, css: th.css, vars: th.vars, read: th.read }))
  }

  // bundleSharedStyles() : compile les .sass/.scss/.css de stylesheetsDir et
  // les expose via `µ.CSS[name] = sheet`. Le runtime les consomme à la demande
  // via `_mjs_sharedCss`. Un fichier `mjs_root.{sass,scss}` est traité à part
  // et adopté globalement (comme en V1).
  // Retourne le nombre de stylesheets émis (0 si aucun) + les warnings
  // `cssTrapWarnings` accumulés sur les feuilles NOMMÉES.
  // --------------------------------------------------------------------------
  async bundleSharedStyles(): Promise<{ count: number; warnings: string[] }> {
    // CSS de ce tour-ci par feuille (hors mjs_root) / de mjs_root, pour
    // le diff "css-only" (trackSharedCssDiff, appelé à CHAQUE sortie de fonction
    // ci-dessous, y compris les replis précoces — un stylesheetsDir qui disparaît
    // ou se vide doit aussi pouvoir disqualifier un lot en cours).
    const newSharedCss = new Map<string, string>()
    let newRootCss: string | undefined
    if (!existsSync(this.stylesheetsDir)) {
      this.manifest['__styles'] = ''
      this.trackSharedCssDiff(newSharedCss, newRootCss)
      return { count: 0, warnings: [] }
    }

    // `readdirSync` NE GARANTIT AUCUN
    // ORDRE (dépend du filesystem/OS, peut différer entre deux machines ou
    // deux builds du même repo). Sans tri : (1) l'ORDRE DE CASCADE CSS entre
    // stylesheets partagés dépend de cet ordre arbitraire — deux règles
    // conflictuelles de même spécificité dans 2 fichiers différents peuvent
    // "gagner" différemment selon la machine, pour un SOURCE IDENTIQUE ;
    // (2) le hash de `mjs_styles-<hash>.js` (dérivé du JS concaténé DANS cet
    // ordre) devient non déterministe d'un build à l'autre — casse les
    // builds reproductibles. Même correctif déjà en place pour les
    // animations (`compileUsedAnimations`, tri explicite du Set avant
    // concaténation, cf. son propre commentaire) — mimé ici.
    const files = readdirSync(this.stylesheetsDir)
      .filter(f => /\.(sass|scss|css)$/.test(f))
      .sort()

    if (files.length === 0) {
      this.manifest['__styles'] = ''
      this.trackSharedCssDiff(newSharedCss, newRootCss)
      return { count: 0, warnings: [] }
    }

    let js = `import { µ } from '${this.coreHashedPath}';\n`
    let rootCount = 0
    let sharedCount = 0
    // `compileCss` throw désormais
    // sur une erreur SASS/SCSS (cf. son propre commentaire) au lieu de
    // l'avaler. Isolé PAR FICHIER ici : un stylesheet partagé cassé ne doit
    // pas empêcher la compilation des AUTRES (contrairement au cas
    // composant, où laisser l'erreur du worker remonter telle quelle est le
    // comportement voulu) — les erreurs sont collectées et jetées ENSEMBLE
    // à la fin, remontées par le try/catch déjà en place chez le caller de
    // bundleSharedStyles() dans stats.errors.
    const cssErrors: string[] = []
    // une feuille NOMMÉE (`@css name`) atterrit, une fois
    // consommée, dans le SHADOW ROOT du composant consommateur (`_mjs_sharedCss`,
    // runtime/mjs_element.ts) : même piège @font-face/@import qu'un <style> de
    // composant (cf. cssTrapWarnings). `mjs_root.{sass,scss}` échappe au piège
    // (adopté en `document.adoptedStyleSheets`, HORS Shadow DOM) — volontairement
    // exclu du scan (branche `if baseName === 'mjs_root'` ci-dessous).
    const cssWarnings: string[] = []

    for (const file of files) {
      const path = join(this.stylesheetsDir, file)
      const baseName = file.replace(/\.(sass|scss|css)$/, '')
      const ext = file.match(/\.(sass|scss|css)$/)![1] as 'sass' | 'scss' | 'css'
      // Même garde que macros.ts/transpiler/index.ts :
      // ce chemin (feuille PARTAGÉE, mjs_root compris) ne passait JAMAIS par le
      // strip \x00 posé pour <@include> — un NUL réel + un mot-clé sentinel dans
      // CE fichier faisait passer STYLE_BLOCK_RE (transpiler/css.ts) pour un
      // découpage multi-lang légitime et INJECTAIT le texte encadré tel quel
      // dans le CSS livré (confirmé en conditions réelles). Un NUL n'est jamais un
      // caractère utile en CSS/SASS (même raisonnement, aucune perte).
      // Confinement RÉEL (cf. assertRealUnder) : un symlink DANS stylesheetsDir
      // pointant HORS de lui était lu tel quel, son contenu publié dans mjs_styles-<hash>.js.
      this.assertRealUnder(path, this.stylesheetsDir)
      const src = readFileSync(path, 'utf-8').replace(/\x00/g, '')
      let css: string
      try {
        css = compileCss(src, ext)
      } catch (e: any) {
        cssErrors.push(`${file} : ${e?.message ?? e}`)
        continue
      }
      if (css.trim() === '') continue

      // mjs_root.{sass,scss} → adopté globalement
      if (baseName === 'mjs_root') {
        js += `{\n` +
              `  const _root = new CSSStyleSheet();\n` +
              `  _root.replaceSync(${JSON.stringify(css)});\n` +
              `  document.adoptedStyleSheets = [...document.adoptedStyleSheets, _root];\n` +
              // handle sinon perdu (scope de bloc) : nécessaire à
              // µ._hotCss (dev) pour un replaceSync ultérieur en place.
              `  µ._mjs_rootStyleSheet = _root;\n` +
              `}\n`
        rootCount++
        newRootCss = css
      } else {
        for (const w of cssTrapWarnings(css)) cssWarnings.push(`[bundler] ${file} : ${w}`)
        const safeVar = baseName.replace(/[^a-zA-Z0-9]/g, '_')
        // FAILLE — la CLÉ était injectée
        // brute entre apostrophes (`µ.CSS['${baseName}']`) : un nom de fichier
        // stylesheet contenant une `'` (ou `\`) sortait de la chaîne et injectait
        // du JS arbitraire dans mjs_styles.js. `JSON.stringify` échappe la clé
        // (la VALEUR css l'était déjà). safeVar reste sûr (déjà assaini ci-dessus).
        const keyLit = JSON.stringify(baseName)
        js += `µ.CSS = µ.CSS || {};\n` +
              `if (!µ.CSS[${keyLit}]) {\n` +
              `  const s_${safeVar} = new CSSStyleSheet();\n` +
              `  s_${safeVar}.replaceSync(${JSON.stringify(css)});\n` +
              `  µ.CSS[${keyLit}] = s_${safeVar};\n` +
              `}\n`
        sharedCount++
        newSharedCss.set(baseName, css)
      }
    }

    if (rootCount + sharedCount === 0) {
      this.manifest['__styles'] = ''
      this.trackSharedCssDiff(newSharedCss, newRootCss)
      // Si TOUS les fichiers ont échoué (aucun succès), pas de quoi écrire —
      // mais surtout ne PAS avaler l'erreur silencieusement.
      if (cssErrors.length > 0) {
        throw new Error(t('bundler.index.css-sass-erreurs', { erreurs: cssErrors.join('\n') }))
      }
      return { count: 0, warnings: cssWarnings }
    }

    const minified = await minifyJs(js, {
      force: this.shouldMinify(),
      filename: 'mjs_styles.js',
      mangleCache: this.mangleCache,
      logLevel: this.prodLogLevel(),
    })
    // mode 'bundle' : jamais un fichier `mjs_styles-<hash>.js` — gardé en mémoire, résolu par
    // le plugin esbuild d'emitSingleFile() sous 'mjs:styles' (cf. bandeau de bundleRuntime()
    // pour la même logique côté cœur).
    let hashedPath: string
    if (this.jsMode === 'bundle') {
      this.bundleVirtualSources.set('mjs_styles', this.withInlineSourceMap(minified.code, minified.map))
      hashedPath = 'mjs:styles'
    } else {
      hashedPath = this.writeHashed('mjs_styles', '.js', minified.code)
    }
    this.manifest['__styles'] = hashedPath
    // diff sémantique feuille par feuille (avant le throw éventuel
    // ci-dessous : la baseline doit refléter ce qui vient d'être écrit, même
    // si un AUTRE fichier de stylesheetsDir a échoué — les erreurs, elles,
    // disqualifient déjà le verdict via stats.errors).
    this.trackSharedCssDiff(newSharedCss, newRootCss)
    // Écrit d'abord le sous-ensemble RÉUSSI (comme pour les composants .mjs,
    // un fichier cassé ne doit pas priver les autres de leur sortie), PUIS
    // signale l'échec — remonté par le try/catch déjà en place chez le
    // caller dans stats.errors (le build ENTIER n'est pas vert pour autant).
    if (cssErrors.length > 0) {
      throw new Error(t('bundler.index.css-sass-erreurs', { erreurs: cssErrors.join('\n') }))
    }
    return { count: rootCount + sharedCount, warnings: cssWarnings }
  }

  // --------------------------------------------------------------------------
  // trackSharedCssDiff : diff sémantique des feuilles partagées entre
  // le compile PRÉCÉDENT et celui-ci. Une feuille présente des deux côtés avec un
  // CSS différent est éligible au hot-swap (`µ.CSS[name].replaceSync` côté client) ;
  // une feuille qui APPARAÎT ou DISPARAÎT disqualifie le lot (µ.CSS[name] naît au
  // chargement de mjs_styles.js, un composant doit être recompilé pour la
  // référencer — repli reload complet, au moindre doute). Idem pour mjs_root.
  // Hors watch : simple mise à jour de baseline, aucun verdict.
  // --------------------------------------------------------------------------
  private trackSharedCssDiff(newSharedCss: Map<string, string>, newRootCss: string | undefined): void {
    if (this.cssOnlyTracking) {
      for (const [name, css] of newSharedCss) {
        const prev = this.lastSharedCss.get(name)
        if (prev === undefined) this.cssOnlyDisqualified = true
        else if (prev !== css) this.cssOnlySheets[name] = css
      }
      for (const name of this.lastSharedCss.keys()) {
        if (!newSharedCss.has(name)) this.cssOnlyDisqualified = true
      }
      if (newRootCss !== undefined && this.lastRootCss !== undefined) {
        if (newRootCss !== this.lastRootCss) this.cssOnlyRoot = newRootCss
      } else if (newRootCss !== this.lastRootCss) {
        this.cssOnlyDisqualified = true  // mjs_root apparu/disparu
      }
      // mjs_styles.js est RÉÉMIS dès qu'une feuille change : émission attendue
      // d'un lot css-only, exemptée du diff central de writeHashed (cf. compile()).
      this.cssOnlyAllowedWrites.add('mjs_styles.js')
    }
    this.lastSharedCss = newSharedCss
    this.lastRootCss = newRootCss
  }

  // --------------------------------------------------------------------------
  // emitSplitStyles() : mode css='split', étape « 1.5 » de compile()
  // (AVANT les composants, même précédent que mjs_core/coreHashedPath). Compile
  // CHAQUE feuille de stylesheetsDir dans SON PROPRE fichier `mjs_style_<nom>-<hash>.js`
  // (au lieu du `mjs_styles-<hash>.js` unique de bundleSharedStyles) — c'est ce qui
  // permet à un module de n'importer QUE les feuilles qu'il déclare (`@css`), plutôt
  // que de faire voyager tout stylesheetsDir avec chaque page.
  //
  // Duplique VOLONTAIREMENT la boucle de compilation par fichier de bundleSharedStyles()
  // (même lecture, même compileCss, même cssTrapWarnings, même gabarit `µ.CSS[nom] = …`)
  // plutôt que de factoriser : bundleSharedStyles() reste la seule responsable du mode
  // 'bundle' (défaut), et doit rester une sortie BYTE-IDENTIQUE à ce qu'elle a toujours
  // produit — un refactor partagé ferait courir un risque de régression sur ce contrat.
  //
  // Ne fait AUCUNE hypothèse sur `requestedSharedSheets` (rempli PAR les composants,
  // compilés APRÈS cette étape) : compile toutes les feuilles PRÉSENTES sur disque, sans
  // savoir encore lesquelles seront déclarées — c'est finalizeSplitStyles() (étape 2c,
  // après les composants) qui décide lesquelles restent eager.
  // --------------------------------------------------------------------------
  async emitSplitStyles(): Promise<{ warnings: string[] }> {
    this.splitStyleHashedPaths = {}
    this.splitRootHashedPath = undefined
    if (!existsSync(this.stylesheetsDir)) return { warnings: [] }
    const files = readdirSync(this.stylesheetsDir)
      .filter(f => /\.(sass|scss|css)$/.test(f))
      .sort()
    if (files.length === 0) return { warnings: [] }
    const cssErrors: string[] = []
    const cssWarnings: string[] = []
    for (const file of files) {
      const path = join(this.stylesheetsDir, file)
      const baseName = file.replace(/\.(sass|scss|css)$/, '')
      const ext = file.match(/\.(sass|scss|css)$/)![1] as 'sass' | 'scss' | 'css'
      // même garde \x00 que bundleSharedStyles() — cf. son commentaire.
      // Même confinement RÉEL que bundleSharedStyles() (cf. assertRealUnder).
      this.assertRealUnder(path, this.stylesheetsDir)
      const src = readFileSync(path, 'utf-8').replace(/\x00/g, '')
      let css: string
      try {
        css = compileCss(src, ext)
      } catch (e: any) {
        cssErrors.push(`${file} : ${e?.message ?? e}`)
        continue
      }
      if (css.trim() === '') continue
      if (baseName === 'mjs_root') {
        // mjs_root : toujours eager (adopté sur le document, aucun composant ne le
        // déclare) — son propre fichier, importé par le manifeste dans TOUS les modes
        // qui splittent (jamais en mode 'bundle', où il reste dans mjs_styles.js).
        const js = `import { µ } from '${this.coreHashedPath}';\n` +
                   `{\n` +
                   `  const _root = new CSSStyleSheet();\n` +
                   `  _root.replaceSync(${JSON.stringify(css)});\n` +
                   `  document.adoptedStyleSheets = [...document.adoptedStyleSheets, _root];\n` +
                   `  µ._mjs_rootStyleSheet = _root;\n` +
                   `}\n`
        const minified = await minifyJs(js, { force: this.shouldMinify(), filename: 'mjs_style_root.js', mangleCache: this.mangleCache, logLevel: this.prodLogLevel() })
        this.splitRootHashedPath = this.writeHashed('mjs_style_root', '.js', minified.code)
      } else {
        for (const w of cssTrapWarnings(css)) cssWarnings.push(`[bundler] ${file} : ${w}`)
        // safeVar sert AUSSI de base de nom de fichier ici (contrairement à
        // bundleSharedStyles, où il ne sert qu'à l'identifiant JS local) : un nom de
        // feuille avec espace/accent produirait sinon un chemin fragile.
        // MÊME DÉSAMBIGUÏSATION QU'EN 'lazy' : `dark-theme` et `dark_theme` se
        // normalisent tous deux en `mjs_style_dark_theme`. Ici le CONTENU diffère bien (le
        // module embarque `µ.CSS['<nom>']`), donc les hachages diffèrent — mais `writeHashed`
        // passe par `cleanupOldHashes`, qui balaie le STEM : écrire la seconde SUPPRIMAIT le
        // fichier de la première, le composant importait une URL morte (404 → tout le graphe
        // de modules de la page tombe), et le build annonçait 0 erreur, 0 avertissement.
        // Dès que la normalisation a changé le nom, on suffixe une empreinte du nom D'ORIGINE :
        // deux noms distincts ne peuvent plus jamais partager un stem.
        const safeVar = baseName.replace(/[^a-zA-Z0-9]/g, '_')
        const stem    = this.splitStyleStem(baseName)
        const keyLit = JSON.stringify(baseName)
        const js = `import { µ } from '${this.coreHashedPath}';\n` +
                   `µ.CSS = µ.CSS || {};\n` +
                   `if (!µ.CSS[${keyLit}]) {\n` +
                   `  const s_${safeVar} = new CSSStyleSheet();\n` +
                   `  s_${safeVar}.replaceSync(${JSON.stringify(css)});\n` +
                   `  µ.CSS[${keyLit}] = s_${safeVar};\n` +
                   `}\n`
        const minified = await minifyJs(js, { force: this.shouldMinify(), filename: `mjs_style_${baseName}.js`, mangleCache: this.mangleCache, logLevel: this.prodLogLevel() })
        this.splitStyleHashedPaths[baseName] = this.writeHashed(stem, '.js', minified.code)
      }
    }
    if (cssErrors.length > 0) {
      throw new Error(t('bundler.index.css-sass-erreurs', { erreurs: cssErrors.join('\n') }))
    }
    return { warnings: cssWarnings }
  }

  // --------------------------------------------------------------------------
  // finalizeSplitStyles() : mode css='split', étape « 2c » (même
  // position que bundleSharedStyles() en mode 'bundle') — APRÈS les composants, donc
  // `requestedSharedSheets` (feuilles déclarées par au moins un `@css`) ET
  // `viewRequestedSheets` (feuilles réclamées par au moins un `<@view css="…">` littéral,
  // cf. extractViewCssNames) sont désormais complets. DEUX FILETS DE SÉCURITÉ distincts,
  // chacun forçant eager pour une raison différente :
  //   1. une feuille compilée par emitSplitStyles() qu'AUCUN module ne déclare resterait
  //      invisible de tout le monde si elle n'était importée par personne.
  //   2. une feuille DÉCLARÉE par un module (donc PAS orpheline) mais réclamée AUSSI par
  //      un `<@view css="…">` d'un AUTRE module — la page qui charge cette vue peut très
  //      bien ne jamais charger le module déclarant, et hériterait alors d'un `µ.CSS[nom]`
  //      vide (cf. runtime/mjs_element.ts, `_mjs_applyLayout`, avertissement « Orphelin CSS
  //      hérité »). Rien ne relie ces deux modules au build : seul le fait de forcer la
  //      feuille eager referme ce trou.
  // Les deux restent importées par le MANIFESTE, exactement comme en mode 'bundle'. Deux
  // avertissements DISTINCTS (un par raison) : l'auteur doit comprendre pourquoi son gain
  // n'est pas total, et pourquoi ajouter `@css` ne suffit pas toujours (raison 2).
  // --------------------------------------------------------------------------
  finalizeSplitStyles(): { count: number; warnings: string[] } {
    const known = Object.keys(this.splitStyleHashedPaths).sort()
    // raison 1 — personne ne la déclare (@css) : le filet historique.
    const undeclared = known.filter(name => !this.requestedSharedSheets.has(name))
    // raison 2 — déclarée par un module, mais un <@view css="…">
    // la réclame AUSSI (disjoint de `undeclared` par construction : un nom ne peut pas
    // être à la fois « personne ne le déclare » et « un module le déclare »).
    const viewOnly = known.filter(name => this.requestedSharedSheets.has(name) && this.viewRequestedSheets.has(name))
    this.splitEagerHashedPaths = [...undeclared, ...viewOnly].sort().map(name => this.splitStyleHashedPaths[name])
    const warnings: string[] = []
    if (undeclared.length > 0) {
      warnings.push(t('bundler.index.css-split-feuilles-eager', { feuilles: undeclared.join(', ') }))
    }
    if (viewOnly.length > 0) {
      warnings.push(t('bundler.index.css-split-feuilles-eager-view', { feuilles: viewOnly.join(', ') }))
    }
    const count = known.length + (this.splitRootHashedPath ? 1 : 0)
    return { count, warnings }
  }

  // --------------------------------------------------------------------------
  // emitLazyStyles() : mode css='lazy', étape « 1.5 » de compile(),
  // à la même place que emitSplitStyles(). Différence de fond avec 'split' : la
  // feuille n'est PAS emballée dans un module JS importé statiquement par le
  // composant — elle devient un VRAI fichier `.css` haché, que le runtime va
  // chercher au montage du PREMIER composant qui la déclare (`@css`), et garde en
  // cache PAR URL : dix composants qui déclarent la même feuille = UNE requête.
  //
  // Conséquence sur la compilation des composants : rien à injecter en tête de
  // leur JS (contrairement à prependSplitCssImports), donc AUCUN sel de cache à
  // ajouter — le composant ne connaît que le NOM de la feuille, la table des URLs
  // vit au manifeste (`µ._cssLazy`, cf. writeManifest).
  //
  // `mjs_root` reste EAGER, comme en 'split' : personne ne le déclare, il est
  // adopté sur le document, et il porte typiquement les variables de thème — le
  // charger en différé ferait clignoter TOUTE la page, pas un composant.
  // --------------------------------------------------------------------------
  async emitLazyStyles(): Promise<{ warnings: string[] }> {
    this.lazyStyleUrls = {}
    this.splitRootHashedPath = undefined
    if (!existsSync(this.stylesheetsDir)) return { warnings: [] }
    const files = readdirSync(this.stylesheetsDir).filter(f => /\.(sass|scss|css)$/.test(f)).sort()
    if (files.length === 0) return { warnings: [] }
    const cssErrors: string[]   = []
    const cssWarnings: string[] = []
    for (const file of files) {
      const path     = join(this.stylesheetsDir, file)
      const baseName = file.replace(/\.(sass|scss|css)$/, '')
      const ext      = file.match(/\.(sass|scss|css)$/)![1] as 'sass' | 'scss' | 'css'
      // même garde \x00 que bundleSharedStyles()/emitSplitStyles()
      // Même confinement RÉEL que bundleSharedStyles() (cf. assertRealUnder).
      this.assertRealUnder(path, this.stylesheetsDir)
      const src = readFileSync(path, 'utf-8').replace(/\x00/g, '')
      let css: string
      try {
        css = compileCss(src, ext)
      } catch (e: any) {
        cssErrors.push(`${file} : ${e?.message ?? e}`)
        continue
      }
      if (css.trim() === '') continue
      if (baseName === 'mjs_root') {
        const js = `import { µ } from '${this.coreHashedPath}';\n` +
                   `{\n` +
                   `  const _root = new CSSStyleSheet();\n` +
                   `  _root.replaceSync(${JSON.stringify(css)});\n` +
                   `  document.adoptedStyleSheets = [...document.adoptedStyleSheets, _root];\n` +
                   `  µ._mjs_rootStyleSheet = _root;\n` +
                   `}\n`
        const minified = await minifyJs(js, { force: this.shouldMinify(), filename: 'mjs_style_root.js', mangleCache: this.mangleCache, logLevel: this.prodLogLevel() })
        this.splitRootHashedPath = this.writeHashed('mjs_style_root', '.js', minified.code)
      } else {
        for (const w of cssTrapWarnings(css)) cssWarnings.push(`[bundler] ${file} : ${w}`)
        // même normalisation de nom qu'en 'split' : un nom de feuille avec espace ou
        // accent produirait un chemin fragile. MAIS ici le fichier écrit est le CSS NU,
        // sans le nom dedans (en 'split' le module JS embarque `µ.CSS['<nom>']`, ce qui
        // écarte les hachages tout seul) : `dark-theme.sass` et `dark_theme.sass` au
        // contenu identique se réduisaient au MÊME fichier, donc à la même URL pour deux
        // noms — et le second nom n'obtenait jamais sa feuille, en silence (défaut mesuré).
        // Dès que la normalisation a changé le nom,
        // on désambiguïse par une empreinte du nom D'ORIGINE : deux noms distincts ne
        // peuvent plus jamais tomber sur le même chemin
        const stem = this.splitStyleStem(baseName)
        this.lazyStyleUrls[baseName] = this.writeHashed(stem, '.css', css)
      }
    }
    if (cssErrors.length > 0) {
      throw new Error(t('bundler.index.css-sass-erreurs', { erreurs: cssErrors.join('\n') }))
    }
    return { warnings: cssWarnings }
  }

  // --------------------------------------------------------------------------
  // finalizeLazyStyles() : étape « 2c », APRÈS les composants (donc
  // `requestedSharedSheets` est complet). Contrairement à 'split', il n'y a AUCUN
  // filet à poser :
  //   1. une feuille que personne ne déclare n'est tout simplement JAMAIS chargée
  //      (décision explicite : c'est le sens même du mode). Le fichier est écrit et
  //      son URL reste au manifeste — un `<@view css="…">` peut la réclamer à
  //      l'exécution — mais aucune requête ne part tant que personne ne la demande.
  //      Une information de build la nomme, pour que ce ne soit pas une surprise.
  //   2. le trou « orphelin CSS hérité » de 'split' (une feuille déclarée par un
  //      module A et réclamée par un `<@view css>` d'un module B jamais chargé) se
  //      referme tout seul ici : le runtime résout par NOM dans `µ._cssLazy`, il n'a
  //      besoin d'aucun module déclarant pour trouver l'URL.
  // --------------------------------------------------------------------------
  finalizeLazyStyles(): { count: number; warnings: string[] } {
    const known      = Object.keys(this.lazyStyleUrls).sort()
    const undeclared = known.filter(name => !this.requestedSharedSheets.has(name) && !this.viewRequestedSheets.has(name))
    const warnings: string[] = []
    if (undeclared.length > 0) {
      warnings.push(t('bundler.index.css-lazy-feuilles-jamais-reclamees', { feuilles: undeclared.join(', ') }))
    }
    const count = known.length + (this.splitRootHashedPath ? 1 : 0)
    return { count, warnings }
  }

  // --------------------------------------------------------------------------
  // prependSplitCssImports() : mode css='split' — ajoute en tête du JS
  // d'un composant les `import '<chemin>';` des feuilles qu'il déclare (`@css`,
  // cf. sharedCssNames). `emitSplitStyles()` tourne désormais en PHASE C (après les
  // composants, le cœur connu) : `this.splitStyleHashedPaths` est encore VIDE ici (phase A).
  // Chaque nom demandé reçoit donc le REPÈRE de son propre stem (`splitStyleStem`, résolu en
  // chemin réel par l'émission topologique de la phase C) — jamais filtré sur une existence
  // qu'on ne peut pas encore connaître : une feuille demandée mais absente/en échec reste un
  // dep jamais résolu, détecté par le garde-fou de compile() (§ 3.13), même sort qu'avant
  // (validateSharedSheets()/erreurs SASS déjà couvertes par ailleurs). Tri alphabétique :
  // ordre déterministe, sans effet sur la cascade (l'ordre qui compte pour le navigateur est
  // celui de `_mjs_sharedCss`, posé par le transpiler — inchangé par cette méthode).
  // --------------------------------------------------------------------------
  private prependSplitCssImports(code: string, sharedCssNames: string[]): string {
    if (sharedCssNames.length === 0) return code
    const imports = [...sharedCssNames].sort()
      .map(name => `import '${this.placeholderPath(this.splitStyleStem(name), '.js')}';`)
      .join('\n')
    return imports === '' ? code : `${imports}\n${code}`
  }

  // --------------------------------------------------------------------------
  // compileUsedAnimations() : compile uniquement les anims utilisées dans
  // `µ.anim = µ.anim || {};\nµ.anim.fade = (...);\n...` puis émet en
  // mjs_anims-<hash>.js. Si aucune anim utilisée → pas de fichier émis.
  //
  // Une anim référencée mais
  // INEXISTANTE (typo : `@transition.fadde` au lieu de `@transition.fade`)
  // était sautée en SILENCE (`continue`) — le composant qui l'utilise génère
  // quand même du code appelant `µ.anim.fadde`, jamais défini → échec
  // SILENCIEUX à l'exécution (`µ.anim.fadde is not a function`), le build ne
  // signalant RIEN. En prime, le compteur `written` du caller (basé sur
  // `usedAnimations.size`, PAS sur le nombre réellement émis) comptait cette
  // anim fantôme comme "écrite". Fix : retourne désormais `{written,
  // missing}` — le caller pousse un warning explicite par nom manquant ET
  // n'incrémente `written` que du compte RÉEL.
  // --------------------------------------------------------------------------
  async compileUsedAnimations(): Promise<{ written: number; missing: string[] }> {
    if (this.usedAnimations.size === 0) {
      this.manifest['__animations'] = ''
      return { written: 0, missing: [] }
    }

    const animDir = join(this.runtimeDir, 'animations')
    if (!existsSync(animDir)) return { written: 0, missing: [...this.usedAnimations].sort() }

    // Animations runtime : également plain JS post-Coffee, lecture directe.
    // Tri du Set AVANT concaténation : son ordre d'itération dépend de l'ordre
    // de complétion concurrente des fichiers → sans tri, le hash de
    // `mjs_anims-<hash>.js` était non déterministe d'un build à l'autre.
    const parts: string[] = ['µ.anim = µ.anim || {};']
    const missing: string[] = []
    let emitted = 0
    for (const animName of [...this.usedAnimations].sort()) {
      const path = join(animDir, `${animName}.ts`)
      if (!existsSync(path)) {
        // Anim définie dynamiquement (µanim.create /
        // crossfade, nom en littéral) : pas de fichier runtime à émettre, et
        // ce n'est PAS un « manquant ». Sinon (vrai typo) on signale comme avant.
        if (!this.definedAnimations.has(animName)) missing.push(animName)
        continue
      }
      const src = readFileSync(path, 'utf-8')
      parts.push(`µ.anim.${animName} = ${src.trim()};`)
      emitted++
    }
    const concatenated = this.autoImportMu(parts.join('\n'))
    const minified = await minifyJs(concatenated, {
      force: this.shouldMinify(),
      filename: 'mjs_anims.js',
      mangleCache: this.mangleCache,
      logLevel: this.prodLogLevel(),
    })
    // mode 'bundle' : jamais un fichier `mjs_anims-<hash>.js` — mêmes raisons que
    // bundleSharedStyles()/bundleRuntime() ci-dessus, sous 'mjs:anims'.
    let hashedPath: string
    if (this.jsMode === 'bundle') {
      this.bundleVirtualSources.set('mjs_anims', this.withInlineSourceMap(minified.code, minified.map))
      hashedPath = 'mjs:anims'
    } else {
      hashedPath = this.writeHashed('mjs_anims', '.js', minified.code)
    }
    this.manifest['__animations'] = hashedPath
    return { written: emitted, missing }
  }

  // --------------------------------------------------------------------------
  // validateSharedSheets() : jumeau structurel de
  // compileUsedAnimations() ci-dessus (même boucle triée, même vérif
  // existsSync par nom), mais pour les feuilles partagées `@css nom1 nom2…` — et avec un
  // verdict DIFFÉRENT : une anim manquante n'est qu'un warning (le composant
  // fautif échoue silencieusement à l'exécution, cf. animation-inconnue),
  // alors qu'une feuille @css manquante DOIT faire échouer le build (throw), sur
  // décision explicite — avant cette validation, `bundleSharedStyles()`
  // se contentait d'énumérer les fichiers PRÉSENTS dans stylesheetsDir, sans
  // jamais savoir quelles feuilles avaient été DEMANDÉES par les composants : un
  // `@css nom-mal-orthographie` compilait avec succès, le composant demandeur
  // héritant silencieusement d'une feuille vide au runtime (cf. mjs_element.ts,
  // avertissement `Orphelin CSS local` — un simple µ.warn, jamais un échec).
  //
  // Cause racine du trou (cf. worker.ts + TranspileDataLike.sharedCssNames) :
  // `sharedCssNames` est calculé par composant DANS LE WORKER mais n'était
  // jusqu'ici JAMAIS renvoyé au process maître (projection postMessage) — sans
  // ce champ, `this.requestedSharedSheets` (alimenté en 3 points miroirs de
  // usedAnimations : cache-hit, fresh-compile, cache.set — cf. _compileMjsInner)
  // restait toujours vide, rendant cette validation structurellement impossible.
  // --------------------------------------------------------------------------
  validateSharedSheets(): void {
    if (this.requestedSharedSheets.size === 0) return
    const missing: string[] = []
    for (const sheetName of [...this.requestedSharedSheets].sort()) {
      const base = join(this.stylesheetsDir, sheetName)
      const found = existsSync(`${base}.sass`) || existsSync(`${base}.scss`) || existsSync(`${base}.css`)
      if (!found) missing.push(sheetName)
    }
    if (missing.length > 0) {
      throw new Error(t('bundler.index.feuille-partagee-manquante', { themes: missing.join(', '), dossier: this.stylesheetsDir }))
    }
  }

  // --------------------------------------------------------------------------
  // computeVarRegistry(warnings) : union des variables de thème $$ DÉCLARÉES
  // (blocs <theme> de chaque composant + leur CSS brut, fichiers *.theme.mjs, custom
  // properties du framework lui-même, CSS brut des feuilles partagées) contre les
  // variables LUES. Une variable lue que personne ne déclare ne casse RIEN à la compilation —
  // juste une valeur VIDE à l'écran, le pire des symptômes, muet : avertissement. Un
  // variable déclarée par au moins deux composants est un usage NORMAL (c'est l'esprit
  // CSS : ce qui est déclaré cascade) — simple information, jamais un reproche.
  //
  // SILENCE PAR DÉFAUT — un projet sans le moindre bloc <theme> (composant ou fichier
  // de thème) ni la moindre lecture $$ ressort avant même de consulter les variables du
  // framework ou des feuilles partagées : ceux-ci ne comptent QUE si le projet y
  // touche, jamais tout seuls (sinon `$$surface` du framework suffirait à faire
  // naître un `.mjs-theme-vars.json` dans un projet qui n'utilise pas les thèmes).
  // --------------------------------------------------------------------------
  private computeVarRegistry(warnings: string[]): void {
    type Kind = 'module' | 'theme' | 'framework' | 'stylesheet'
    type Decl = { value: string; declaredBy: string; kind: Kind; variant: string; file: string; line: number; doc: string }

    const declaredByModule = new Map<string, Set<string>>()   // nom → composants qui le déclarent
    const declarations     = new Map<string, Decl[]>()
    const readers          = new Map<string, Set<string>>()   // nom → qui le lit (composants/thèmes)
    // un artefact déposé dans public/ ne publie JAMAIS l'arborescence absolue de la machine de
    // build : tout chemin part relatif à `this.root` (le framework, source 3 plus bas, garde son
    // nom court tel quel — ex. 'mjs_init.ts', déjà hors de toute arborescence projet)
    const rel = (f: string) => relative(this.root, f)

    const addDecl = (name: string, decl: Decl) => {
      const arr = declarations.get(name) ?? []
      arr.push(decl)
      declarations.set(name, arr)
      if (decl.kind === 'module') {
        const mods = declaredByModule.get(name) ?? new Set<string>()
        mods.add(decl.declaredBy)
        declaredByModule.set(name, mods)
      }
    }
    const addRead = (name: string, who: string) => {
      const set = readers.get(name) ?? new Set<string>()
      set.add(who)
      readers.set(name, set)
    }

    // 1. composants — $$ des <theme> ET CSS brut (baseCss + chaque variant)
    for (const c of this.pendingVarData) {
      for (const d of buildVarDeclarations(c.baseCss, this.varPrefix, c.themeVars)) {
        addDecl(d.name, { value: d.value, declaredBy: c.moduleName, kind: 'module', variant: d.variant, file: rel(c.file), line: d.line, doc: d.doc })
      }
      for (const layoutName of Object.keys(c.layoutCss)) {
        for (const d of buildVarDeclarations(c.layoutCss[layoutName], this.varPrefix, [])) {
          addDecl(d.name, { value: d.value, declaredBy: c.moduleName, kind: 'module', variant: d.variant, file: rel(c.file), line: d.line, doc: d.doc })
        }
      }
      for (const name of c.varsRead) addRead(name, c.moduleName)
    }
    // 2. fichiers *.theme.mjs — mêmes deux volets (déclarations + lectures)
    for (const th of this.themeVarData) {
      for (const d of buildVarDeclarations(th.css, this.varPrefix, th.vars)) {
        addDecl(d.name, { value: d.value, declaredBy: th.name, kind: 'theme', variant: d.variant, file: rel(th.file), line: d.line, doc: d.doc })
      }
      for (const name of th.read) addRead(name, th.name)
    }

    if (declarations.size === 0 && readers.size === 0) return   // silence par défaut

    // 3. le framework lui-même (rend $$surface/$$fg/… légitimes sans redéclaration)
    for (const f of this.frameworkVarData) {
      addDecl(f.name, { value: f.value, declaredBy: 'framework', kind: 'framework', variant: '', file: f.file, line: f.line, doc: f.doc })
    }
    // 4. feuilles partagées de stylesheetsDir — CSS brut uniquement, jamais de $$
    // (allowDeclare n'existe même pas côté feuille partagée)
    for (const [sheetName, css] of this.lastSharedCss) {
      for (const d of scanDeclaredVars(css, this.varPrefix)) {
        addDecl(d.name, { value: d.value, declaredBy: sheetName, kind: 'stylesheet', variant: '', file: rel(join(this.stylesheetsDir, sheetName)), line: 0, doc: '' })
      }
    }
    if (this.lastRootCss !== undefined) {
      for (const d of scanDeclaredVars(this.lastRootCss, this.varPrefix)) {
        addDecl(d.name, { value: d.value, declaredBy: 'mjs_root', kind: 'stylesheet', variant: '', file: rel(join(this.stylesheetsDir, 'mjs_root')), line: 0, doc: '' })
      }
    }

    // avertissement — lu quelque part, déclaré nulle part : faute de frappe probable
    for (const name of [...readers.keys()].sort()) {
      if (declarations.has(name)) continue
      warnings.push(t('bundler.variable-inconnue', { nom: name, lus: [...readers.get(name)!].sort().join(', ') }))
    }
    // information — déclaré par au moins deux composants : rappel qu'il cascade.
    // Deux modules CŒUR qui partagent une variable (checkbox et radio ont le même habillage) ne
    // regardent pas l'auteur de l'application : il n'y peut rien, et ça lui ferait 7 lignes
    // à chaque build (mesuré sur le site de doc). L'information ne sort donc que si au moins
    // un composant du PROJET est dans le lot.
    const coeur = new Set(this.pendingVarData.filter(c => resolve(c.file).startsWith(this.coreModulesDir)).map(c => c.moduleName))
    for (const name of [...declaredByModule.keys()].sort()) {
      const mods = declaredByModule.get(name)!
      if (mods.size < 2) continue
      if ([...mods].every(m => coeur.has(m))) continue
      warnings.push(t('bundler.variable-partagee', { nom: name, modules: [...mods].sort().join(', ') }))
    }

    // registre pour l'atelier /__mjs/theme à venir — trié de façon STABLE (jamais de
    // rebuild fantôme d'un build à l'autre : l'ordre du parallelMap est arbitraire).
    const registry: Record<string, { declarations: Decl[]; readBy: string[] }> = {}
    for (const name of [...declarations.keys()].sort()) {
      // point de code, jamais `localeCompare` — même exigence que `publicManifest` plus bas :
      // un registre trié selon la locale de la machine n'est PAS reproductible
      const cp = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0)
      const decls = [...declarations.get(name)!].sort((a, b) =>
        a.kind !== b.kind ? cp(a.kind, b.kind) :
        a.declaredBy !== b.declaredBy ? cp(a.declaredBy, b.declaredBy) :
        a.file !== b.file ? cp(a.file, b.file) : a.line - b.line)
      registry[name] = { declarations: decls, readBy: [...(readers.get(name) ?? new Set<string>())].sort() }
    }
    this.writeIfChanged(join(this.outputDir, '.mjs-theme-vars.json'), JSON.stringify(registry, null, 2) + '\n')
  }

  // Écriture NON ATOMIQUE : un
  // `writeFileSync` direct sur le chemin FINAL peut être interrompu à
  // mi-chemin (crash process, OOM-kill, coupure d'alim) — le fichier reste
  // alors TRONQUÉ sur disque. Le nom étant dérivé du hash du CONTENU SOURCE
  // (jamais revérifié contre les octets RÉELLEMENT écrits), `existsSync
  // (target)` renvoie ensuite `true` pour ce fichier CORROMPU à CHAQUE build
  // suivant → l'écriture est skippée (« il existe déjà ») → le fichier
  // tronqué n'est JAMAIS réparé, à vie, jusqu'à suppression manuelle.
  // Fix : écriture dans un fichier temporaire PUIS `renameSync` — un rename
  // sur le même volume est ATOMIQUE au niveau filesystem (POSIX comme NTFS) :
  // soit l'ancien contenu reste intact, soit le nouveau le remplace
  // ENTIÈREMENT, jamais un état intermédiaire visible depuis `target`. Si
  // deux compilations concurrentes produisent par coïncidence le MÊME hash
  // (donc le même contenu, par construction), l'écriture atomique de l'une
  // ou l'autre suffit — inoffensif.
  private writeFileAtomic(target: string, content: string | Buffer): void {
    if (existsSync(target)) return // même hash = même contenu (collision négligeable)
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, content, 'utf-8')
    try {
      renameSync(tmp, target)
    } catch (e) {
      try { unlinkSync(tmp) } catch {}
      throw e
    }
  }

  // writeIfChanged() : jumeau de la garde déjà en place dans writeManifest() (même motif
  // exact), généralisé ici pour tout fichier à nom STABLE dont le CONTENU varie d'un build
  // à l'autre (variants `<style name="…">`, registre `.mjs-theme-vars.json`).
  // `writeFileAtomic` NE CONVIENT PAS : il skippe dès que `target` existe, quel
  // que soit son contenu (pensé pour un nom HASHÉ, jamais pour un nom stable). Un build qui
  // ne change rien ne doit pas non plus TOUCHER le fichier (nouveau mtime → le watcher se
  // redéclencherait pour rien).
  private writeIfChanged(target: string, content: string): void {
    if (existsSync(target)) {
      const current = readFileSync(target, 'utf-8')
      if (current === content) return
    }
    this.writeFileAtomicAlways(target, content)
  }

  // Cette logique de nettoyage était
  // DUPLIQUÉE (quasi identique) 2 fois DANS writeHashed() lui-même, et
  // ABSENTE d'un 3e site qui en aurait eu tout autant besoin (copie
  // d'assets binaires, cf. resolveOneAsset ci-dessous) : un binaire
  // (logo.png, etc.) réédité au fil du temps voyait CHAQUE ANCIENNE
  // version (`logo-<vieuxhash>.png`) s'accumuler indéfiniment dans
  // outputDir, jamais nettoyée — contrairement au JS compilé (writeHashed),
  // qui purge déjà ses anciennes versions. Factorisé ici pour les 3 sites.
  // La suppression n'est plus IMMÉDIATE : elle est mise EN ATTENTE
  // (pendingHashCleanup), purgée pour de bon seulement après que writeManifest() ait republié le
  // manifeste (cf. flushPendingHashCleanup, appelée en fin d'étape 4 de compile()). Sans ce
  // report, un composant qui recompile supprimait son ancien fichier haché DÈS cette étape 2 —
  // AVANT que writeManifest() (étape 4) ne republie la nouvelle URL — fenêtre où le manifeste
  // ENCORE PUBLIÉ (celui qu'un navigateur/CDN a déjà chargé) nommait un fichier déjà disparu.
  private cleanupOldHashes(baseName: string, ext: string, keepFilenames: string[]): void {
    const re = new RegExp(`^${baseName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}-[a-f0-9]{8}${ext.replace('.', '\\.')}(\\.map)?$`)
    for (const f of readdirSync(this.outputDir)) {
      if (re.test(f) && !keepFilenames.includes(f)) {
        this.pendingHashCleanup.push(join(this.outputDir, f))
      }
    }
  }

  // flushPendingHashCleanup() : supprime pour de bon les anciens fichiers hachés mis en attente
  // par cleanupOldHashes() ci-dessus. Appelée UNIQUEMENT après que writeManifest() ait réussi
  // (compile(), étape 4) : avant cet instant, l'ancien fichier peut encore être celui que le
  // manifeste PUBLIÉ sur disque promet à un visiteur/CDN.
  // PUBLIC : bundler/startup.ts écrit ses fichiers de page APRÈS compile() et suit la même
  // discipline — nouveau fichier écrit, fragment réécrit, ANCIEN supprimé seulement ensuite.
  flushPendingHashCleanup(): void {
    for (const f of this.pendingHashCleanup) {
      try { unlinkSync(f) } catch {}
    }
    this.pendingHashCleanup = []
  }

  // --------------------------------------------------------------------------
  // outputsRegistry — `.mjs-outputs.json`, à côté du manifeste, réécrit à
  // CHAQUE build réussi. Ne mémorise PAS les noms de fichiers (déjà couverts par
  // emittedThisCompile, qui ne survit pas d'un compile() à l'autre) mais les EXTENSIONS que ce
  // bundler sait produire : `.js`/`.css`/`.map` toujours, les formats image CONFIGURÉS
  // (imageConfig.formats, même si aucune image n'a encore été compilée), et toute extension
  // RÉELLEMENT vue dans emittedThisCompile (assets µasset() génériques : .png, .woff2, un .pdf
  // légitimement servi…) — le tout ACCUMULÉ avec ce qui était déjà dans le registre (une
  // extension vue un jour le reste, même si un rebuild n'y touche plus ou que la config change).
  //
  // Sert de garde-fou à pruneOrphans() (ci-dessous) : un fichier au nom hachage-compatible mais
  // dont l'extension n'y a JAMAIS figuré n'est pas un candidat, même s'il en a la forme — c'est
  // exactement le cas d'un fichier étranger déposé à la main (rapport-1a2b3c4d.pdf), que
  // docs/32-cli-et-configuration.md promet intact et que HASHED_OUTPUT_RE seul ne peut pas
  // distinguer d'une vraie sortie.
  // --------------------------------------------------------------------------
  private outputsRegistryPath(): string {
    return join(dirname(this.manifestPath), '.mjs-outputs.json')
  }

  private writeOutputsRegistry(): void {
    const known = new Set<string>(['.js', '.css', '.map'])
    for (const fmt of this.imageConfig.formats) known.add(`.${fmt}`)
    for (const f of this.emittedThisCompile) known.add(extname(f.endsWith('.map') ? f.slice(0, -4) : f))
    try {
      const prev = JSON.parse(readFileSync(this.outputsRegistryPath(), 'utf-8'))
      if (Array.isArray(prev?.extensions)) for (const e of prev.extensions) if (typeof e === 'string') known.add(e)
    } catch { /* registre absent ou périmé : repart d'une base saine, réécrite juste après */ }
    this.writeIfChanged(this.outputsRegistryPath(), JSON.stringify({ extensions: [...known].sort() }, null, 2) + '\n')
  }

  // --------------------------------------------------------------------------
  // pruneOrphans() : purge — le build remplace déjà l'empreinte
  // d'un fichier qui CHANGE (cleanupOldHashes ci-dessus), mais jamais un NOM qui DISPARAÎT
  // (composant renommé ou supprimé) : mesuré sur un vrai projet, 893 fichiers / 17 Mo dans
  // outputDir pour 330 écrits par le dernier build. Rien n'est SERVI (le manifeste ne les
  // référence plus), mais le dossier MENT sur ce que le site contient réellement.
  //
  // Retire d'outputDir tout fichier au nom de la famille émise par CE bundler (cf.
  // HASHED_OUTPUT_RE) qu'AUCUNE émission de ce compile() n'a produit (`emittedThisCompile`).
  //
  // JAMAIS touché : un SOUS-DOSSIER (i18n/, mjs_pages/… — readdirSync filtré à `isFile()`) ; un
  // DOTFILE (`.mangle-cache.json`, `.mjs-theme-vars.json`) ; un nom STABLE qui ne matche pas la
  // famille hachée (le manifeste, un CSS de layout `<module>.<layout>.css`, `mjs-precache.json`) ;
  // tout fichier ÉTRANGER au build ; ni sur un compile qui a resservi son cache. LE MANIFESTE, PAR
  // SON NOM, même s'il matche la famille hachée par collision de config
  // (`manifestPath`/`--manifest` en `<base>-<hex8>.<ext>`) : `writeManifest()` écrit hors de
  // `emittedThisCompile`, un nom qui matche s'auto-détruisait sinon au build qui vient de l'écrire.
  //
  // GARDES, sans exception (rendent `{ removed: [], failed: [], skipped: '…' }` sans rien lire ni
  // supprimer — `skipped` absent seulement quand la purge a tourné) :
  //  - aucun compile() n'a encore tourné, OU le dernier est EN ERREUR (`skipped: 'errors'`) : un
  //    build partiel garde tout (cf. recoverFailedComponentManifest) — purger sur un ensemble
  //    d'émissions incomplet effacerait des fichiers ENCORE valides.
  //  - `emittedThisCompile` est vide (`skipped: 'empty'`) : rien de fiable à quoi comparer.
  //  - AUCUNE entrée de `emittedThisCompile` n'est le runtime `mjs_core-<hex8>.js`
  //    (`skipped: 'no-core'`) — il est émis par TOUT build sain ; son absence signale un
  //    ensemble non fiable plutôt qu'un site sans runtime — une garde MUETTE ici effacerait TOUT
  //    outputDir.
  //  - outputDir n'existe pas (`skipped: 'no-dir'`).
  //  - CE compile() a resservi au moins un composant depuis un compile() PRÉCÉDENT (`skipped:
  //    'cache'`, cf. `cacheHitsThisCompile`/
  //    `compileGeneration`) : `_compileMjsInner`/`_compileScriptModuleInner` réinjectent le `.js` du
  //    cache hit dans `emittedThisCompile` mais jamais ses assets annexes (`µasset`, variantes
  //    d'image — `resolveOneAsset` n'est rappelé QUE sur recompilation) ; purger sur cet ensemble
  //    partiel retirerait un asset encore référencé en dur par le `.js` resservi. NE COMPTE PAS un
  //    hit sur une entrée posée PENDANT ce même compile() (composant redemandé 2 fois dans le même
  //    tour — resolveTagShortcuts, une inclusion…) : ses assets annexes ont déjà été émis ce
  //    tour-ci, hit inoffensif (11 hits de ce genre mesurés sur un build FROID d'un site réel,
  //    685 fichiers — la garde se déclenchait alors sur CHAQUE `mjs build` d'un vrai
  //    projet, la purge n'y tournait donc JAMAIS). Cette garde ne vise plus que l'instance réutilisée
  //    entre au moins 2 `compile()` (watcher, `mjs dev`, API).
  // --------------------------------------------------------------------------
  pruneOrphans(): { removed: string[], failed: string[], skipped?: 'errors' | 'empty' | 'no-core' | 'no-dir' | 'cache' | 'registry-unreadable' | 'registry-empty' } {
    if (this.lastCompileErrors !== 0) return { removed: [], failed: [], skipped: 'errors' } // aucun compile, ou un compile en erreur
    if (this.emittedThisCompile.size === 0) return { removed: [], failed: [], skipped: 'empty' } // rien à comparer
    if (![...this.emittedThisCompile].some(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f))) return { removed: [], failed: [], skipped: 'no-core' } // ensemble non fiable
    if (!existsSync(this.outputDir)) return { removed: [], failed: [], skipped: 'no-dir' }
    if (this.cacheHitsThisCompile > 0) return { removed: [], failed: [], skipped: 'cache' } // assets annexes non réinjectés par le(s) cache hit(s)

    // Extensions que CE bundler sait produire (cf. writeOutputsRegistry) :
    // garde-fou EN PLUS de emittedThisCompile, pas à sa place — un fichier qui matche
    // HASHED_OUTPUT_RE par pure coïncidence de nom (rapport-1a2b3c4d.pdf déposé à la main) mais
    // dont l'extension n'a JAMAIS figuré au registre n'est pas un candidat. Registre absent (jamais
    // écrit encore) : base sûre minimale, rien de perdu — PRÉSENT mais illisible : garde muette
    // interdite, la purge ENTIÈRE est bloquée plutôt que de deviner.
    let knownExt: Set<string>
    const registryPath = this.outputsRegistryPath()
    if (existsSync(registryPath)) {
      try {
        const parsed = JSON.parse(readFileSync(registryPath, 'utf-8'))
        if (!Array.isArray(parsed?.extensions) || !parsed.extensions.every((e: unknown) => typeof e === 'string')) throw new Error('forme inattendue')
        knownExt = new Set<string>(parsed.extensions)
      } catch {
        return { removed: [], failed: [], skipped: 'registry-unreadable' }
      }
      // `{"extensions":[]}` est un JSON PARFAITEMENT valide
      // (tableau, `.every()` vacuement vrai sur un tableau vide) : sans cette garde, `knownExt`
      // restait VIDE, chaque fichier échouait silencieusement le test d'extension connue plus bas,
      // removed:[] était rendu SANS jamais poser `skipped` — même silhouette qu'un run sain « rien
      // à purger ». Un zombie survivait indéfiniment, indiscernable d'un build propre.
      if (knownExt.size === 0) return { removed: [], failed: [], skipped: 'registry-empty' }
    } else {
      knownExt = new Set<string>(['.js', '.css', '.map'])
      for (const fmt of this.imageConfig.formats) knownExt.add(`.${fmt}`)
    }
    const hashedOutputExt = (name: string): string => extname(name.endsWith('.map') ? name.slice(0, -4) : name)

    // le manifeste ne passe jamais par emittedThisCompile (écrit par writeManifest(), hors filet) :
    // protégé PAR SON NOM quand il est logé DANS outputDir, sans condition de motif — sur les chemins
    // RÉELS : un lien symbolique vers outputDir faisait échouer l'égalité de chaînes, manifeste retiré
    const sameDir      = (a: string, b: string): boolean => { try { return realpathSync(a) === realpathSync(b) } catch { return a === b } }
    const manifestName = sameDir(dirname(this.manifestPath), this.outputDir) ? basename(this.manifestPath) : null

    const removed: string[] = []
    const failed: string[]  = []
    for (const entry of readdirSync(this.outputDir, { withFileTypes: true })) {
      if (!entry.isFile()) continue // jamais un sous-dossier (i18n/, mjs_pages/…)
      const name = entry.name
      if (name.startsWith('.')) continue // jamais un dotfile (.mangle-cache.json…, .mjs-outputs.json compris)
      if (manifestName !== null && name.replace(/\.map$/, '') === manifestName) continue // jamais le manifeste, ni son .map
      if (!HASHED_OUTPUT_RE.test(name)) continue // jamais un nom STABLE (bundle.js, mjs-precache.json, CSS de layout…)
      if (SERVER_WRITTEN_RE.test(name)) continue // jamais un asset écrit par le rendu serveur (cf. SERVER_WRITTEN_RE)
      if (this.emittedThisCompile.has(name)) continue // émis ce tour-ci
      if (name.endsWith('.map') && this.emittedThisCompile.has(name.slice(0, -4))) continue // .map d'un .js émis ce tour-ci
      if (!knownExt.has(hashedOutputExt(name))) continue // Extension jamais produite par CE bundler : jamais un candidat
      try {
        unlinkSync(join(this.outputDir, name))
        removed.push(name)
      } catch {
        failed.push(name)
      }
    }
    removed.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    failed.sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    return { removed, failed }
  }

  // --------------------------------------------------------------------------
  // assertValidEsm() : garde-fou « build vert qui ment » — une parenthèse orpheline compilée
  // (RHS entièrement parenthésé) passait le build et ne cassait qu'à l'import navigateur,
  // silencieusement. Chaque JS émis doit désormais être de l'ESM syntaxiquement
  // valide : parse via acorn (déjà en dépendance et déjà importé plus haut,
  // cf. extractAnimationsFromAst), throw au build avec fichier:ligne:colonne +
  // la ligne fautive — même esprit que [bundler/minify] (minify.ts:152).
  // --------------------------------------------------------------------------
  private assertValidEsm(content: string, filename: string): void {
    try {
      acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (err: any) {
      const line = err?.loc?.line
      const col  = err?.loc?.column
      const src  = line ? (content.split('\n')[line - 1] ?? '').slice(0, 200) : ''
      throw new Error(`[bundler/esm-check] ${filename}${line ? `:${line}:${col}` : ''} — ${err?.message ?? err}\n  ${src}`)
    }
  }

  // --------------------------------------------------------------------------
  // assertParsableJs() : garde-fou ESM pour les assets .js copiés RAW — resolveOneAsset() copiait tout .js hors
  // .civet/.coffee/.mjs SANS AUCUNE validation (branche « Binaires ») : un
  // vendor .js cassé référencé via µasset() passait tel quel, stats.errors
  // restait vide. Dual-parse (module PUIS script) : un asset brut n'est pas
  // forcément de l'ESM (vendor UMD, script classique avec `with`, etc.) —
  // exiger strict module-only casserait des vendors légitimes. On ne bloque
  // QUE ce qui est illisible dans LES DEUX grammaires (fichier tronqué/corrompu).
  // --------------------------------------------------------------------------
  private assertParsableJs(content: string, filename: string): void {
    try {
      acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'module' })
    } catch (moduleErr: any) {
      try {
        acorn.parse(content, { ecmaVersion: 'latest', sourceType: 'script' })
      } catch {
        const line = moduleErr?.loc?.line
        const col  = moduleErr?.loc?.column
        const src  = line ? (content.split('\n')[line - 1] ?? '').slice(0, 200) : ''
        throw new Error(t('bundler.index.esm-check-ni-esm-ni-script', { filename, line, col, erreur: String(moduleErr?.message ?? moduleErr), src }))
      }
    }
  }

  // --------------------------------------------------------------------------
  // assertSafeSvg() : un SVG copié tel quel (resolveOneAsset, branche
  // « Binaires ») est servi depuis la MÊME origine que le reste du site : un <script> embarqué,
  // un attribut on*= (onload, onclick…) ou un javascript: en valeur d'attribut s'exécute au
  // chargement direct de l'URL du SVG (document top-level ou <object>/<iframe>). Ni µasset() ni
  // µimage() n'inspectaient le contenu avant ce fix — refus nommant le fichier et le motif trouvé,
  // AVANT toute écriture sur disque.
  // 3 motifs contournables tels quels : une entité HTML
  // (`&#106;avascript:`, `&#x6A;avascript:`) reconstitue `javascript:` SANS jamais écrire le mot en
  // clair ; l'injection SMIL (`<set attributeName="onclick" to="…">`, `<animate
  // attributeName="onmouseover" …>`) ne pose ni <script>, ni on*=, ni javascript: littéral ;
  // `<foreignObject><iframe src="…">` embarque une autre origine sans aucun des 3 motifs non plus.
  // Renforcé ci-dessous — animations SMIL sur d/opacity/transform… restent PERMISES (légitimes).
  // --------------------------------------------------------------------------
  private assertSafeSvg(content: string, filename: string): void {
    const normalized = decodeSvgEntities(content)
    // schéma d'URL (javascript:/data:) — copie DÉDIÉE : un navigateur retire TAB/LF/CR d'une URL
    // avant d'en reconnaître le schéma (java\tscript: reste javascript: à ses yeux), mais faire ce
    // retrait sur TOUT le document collerait <rect\nonclick="x"> en <rectonclick="x"> et ferait
    // perdre la frontière que le test on*= ci-dessous exige.
    const urlNormalized = normalized.replace(/[\t\r\n]/g, '')
    if (/<script[\s>]/i.test(normalized)) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: '<script>' }))
    const onAttr = normalized.match(/\son[a-z]+\s*=/i)
    if (onAttr) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: onAttr[0].trim() }))
    if (/javascript:/i.test(urlNormalized)) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: 'javascript:' }))
    // data:text/html embarque un document HTML complet — data:image/* (icône encodée, usage
    // légitime courant) n'est JAMAIS concerné, seul le type MIME text/html est visé.
    if (/data:text\/html/i.test(urlNormalized)) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: 'data:text/html' }))
    if (/<foreignObject[\s>]/i.test(normalized)) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: '<foreignObject>' }))
    const embed = normalized.match(/<(iframe|embed|object)[\s>]/i)
    if (embed) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: `<${embed[1]}>` }))
    // SMIL — attributeName visant on…/href/xlink:href sur <set>/<animate>/<animateTransform>/
    // <animateMotion> : injection sans <script>/on*=/javascript: littéral. Non scopé au NOM de la
    // balise porteuse (attributeName n'existe que sur les tags SMIL en pratique) — plus simple,
    // au moins aussi sûr. d/opacity/transform/fill… ne matchent jamais, restent permis.
    const smil = normalized.match(/attributeName\s*=\s*["']\s*(on[a-z]+|xlink:href|href)\s*["']/i)
    if (smil) throw new Error(t('bundler.index.svg-script-refuse', { fichier: filename, motif: `attributeName="${smil[1]}"` }))
  }

  // --------------------------------------------------------------------------
  // placeholderPath(stem, ext) : chemin REPÈRE (cf. HASH_PLACEHOLDER, même longueur
  // qu'un vrai `writeHashed()`) — utilisé en phase A tant que le chemin final d'une unité
  // (cœur, feuille split, composant, module, manifeste externe) n'est pas encore connu.
  // --------------------------------------------------------------------------
  placeholderPath(stem: string, ext: string): string {
    return `${this.urlPrefix}/${stem}-${HASH_PLACEHOLDER}${ext}`
  }

  // --------------------------------------------------------------------------
  // splitStyleStem(baseName) : nom de fichier d'une feuille NOMMÉE en mode css=
  // 'split'/'lazy' (`mjs_style_<safeVar>` ou, en cas de collision de normalisation,
  // `mjs_style_<safeVar>_<empreinte du nom d'origine>`) — SEULE définition, partagée par
  // `emitSplitStyles()`/`emitLazyStyles()` (chemin réel, cœur déjà connu) et par
  // `prependSplitCssImports()` (repère, phase A, cœur pas encore connu). `mjs_root` (feuille
  // racine, jamais déclarée par un composant) garde son propre stem constant
  // `'mjs_style_root'`, HORS de cette fonction (cf. les deux appelants).
  // --------------------------------------------------------------------------
  private splitStyleStem(baseName: string): string {
    const safeVar = baseName.replace(/[^a-zA-Z0-9]/g, '_')
    return safeVar === baseName ? `mjs_style_${safeVar}` : `mjs_style_${safeVar}_${createHash('md5').update(baseName).digest('hex').slice(0, 4)}`
  }

  // --------------------------------------------------------------------------
  // withInlineSourceMap(code, map) : mode 'bundle' seulement — un fragment gardé en mémoire
  // (jamais écrit en `.js`+`.map` séparés, cf. bundleVirtualSources) porte sa carte de
  // source EN LIGNE (`data:` base64) pour qu'esbuild.build() la lise à l'assemblage final
  // (emitSingleFile()) et compose une carte UNIQUE `<manifeste>.map`. `map`/`shouldEmitSourceMap()`
  // absent → code inchangé (aucun octet de carte quand personne n'en a besoin).
  // --------------------------------------------------------------------------
  private withInlineSourceMap(code: string, map?: string): string {
    if (!map || !this.shouldEmitSourceMap()) return code
    const b64 = Buffer.from(map, 'utf-8').toString('base64')
    return `${code}\n//# sourceMappingURL=data:application/json;base64,${b64}\n`
  }

  // --------------------------------------------------------------------------
  // BUNDLE_DIR_URL_RE / replaceDirLiteral(code) : mode 'bundle' seulement — un composant
  // compilé embarque `const _dir_<Classe> = new URL('.', import.meta.url).href;`
  // (transpiler/template.ts:22, `this._mjs_dir` derive de cette variable) : le dossier de SES
  // satellites (`<mod>.<nom>.css`), déduit du fichier qui l'exécute. En mode 'bundle', TOUS les
  // composants s'exécutent depuis LE MÊME fichier (`this.manifestPath`, pas forcément dans
  // `outputDir` — un projet dont le manifeste vit hors du dossier de sortie, ex. sous un dossier
  // d'assets applicatif séparé du dossier de sortie compilé) : `import.meta.url` y désignerait le mauvais dossier.
  // Remplacé par le littéral EXACT que le runtime attend déjà ailleurs (writeHashed, resolveOneAsset) :
  // `<urlPrefix>/`. Forme tolérante aux quotes/espaces qu'esbuild.transform() choisit en
  // minifiant (mesuré : `new URL(".",import.meta.url).href`, sans espace, guillemets doubles).
  // Scope `.mjs` UNIQUEMENT (`unit.file.endsWith('.mjs')`, cf. appelant) : seul le gabarit de
  // composant émet cette forme, jamais un module `.civet`/`.coffee`/le manifeste externe — un
  // texte UTILISATEUR qui écrirait la même expression pour son propre compte (module/externe)
  // n'est jamais concerné.
  // --------------------------------------------------------------------------
  private static readonly BUNDLE_DIR_URL_RE = /new URL\(\s*(['"])\.\1\s*,\s*import\.meta\.url\s*\)\.href/g
  private replaceDirLiteral(code: string): string {
    return code.replace(Bundler.BUNDLE_DIR_URL_RE, JSON.stringify(`${this.urlPrefix}/`))
  }

  // --------------------------------------------------------------------------
  // extractPlaceholderDeps(code) : stems dont CE code contient le repère
  // (`<urlPrefix>/<stem>-ZZZZZZZZ.js|.css`) — calculé UNE FOIS par unité fraîchement compilée
  // (phase A), consommé par l'émission topologique de la phase C (compile()) : une unité ne
  // s'émet que lorsque TOUS ses deps ont un chemin final connu.
  // --------------------------------------------------------------------------
  private extractPlaceholderDeps(code: string): string[] {
    const re = new RegExp(`${escapeRegex(this.urlPrefix)}/([^'"\\s]+?)-${HASH_PLACEHOLDER}(?:\\.js|\\.css)`, 'g')
    const deps = new Set<string>()
    let m: RegExpExecArray | null
    while ((m = re.exec(code)) !== null) deps.add(m[1])
    return [...deps]
  }

  // --------------------------------------------------------------------------
  // resolvePlaceholders(code, finalPaths) : remplace CHAQUE repère de `code` par le
  // chemin final connu (`finalPaths`, indexé par stem) — remplacement TEXTUEL de longueur
  // ÉGALE (le hash réel fait, comme le repère, 8 caractères) : les cartes de source déjà
  // écrites restent justes colonne par colonne, aucune retouche. Un stem absent de
  // `finalPaths` (dep jamais résolu — cycle échappé, unité en échec) laisse le repère TEL
  // QUEL : le garde-fou de compile() (§ 3.15) le détecte et refuse l'écriture.
  // --------------------------------------------------------------------------
  private resolvePlaceholders(code: string, finalPaths: Map<string, string>): string {
    const re = new RegExp(`${escapeRegex(this.urlPrefix)}/([^'"\\s]+?)-${HASH_PLACEHOLDER}(\\.js|\\.css)`, 'g')
    return code.replace(re, (full, stem) => finalPaths.get(stem) ?? full)
  }

  // --------------------------------------------------------------------------
  // writeHashed() : écrit `<base>-<md5>.<ext>` dans outputDir, return path web.
  // Nettoie les anciennes versions du même base. Si `map` fourni, écrit aussi
  // le .map à côté et appende sourceMappingURL au .js.
  // --------------------------------------------------------------------------
  writeHashed(baseName: string, ext: string, content: string, map?: string): string {
    // ceinture + bretelles : garde-fou générique, en plus de celui d'emitPendingUnits
    // (qui vérifie AVANT d'appeler writeHashed pour les unités topologiques) — AUCUN appelant
    // de writeHashed() ne doit jamais écrire un repère non résolu sur disque, y compris un
    // futur appelant qui oublierait sa propre vérification.
    if (content.includes('-ZZZZZZZZ.')) {
      throw new Error(t('bundler.index.repere-non-resolu-ecriture', { fichier: `${baseName}${ext}` }))
    }
    // filet central : enregistre CHAQUE émission de ce compile (le hash
    // dérive du contenu → « hash identique » = contenu identique, jamais un
    // changement). Le verdict css-only compare à `lastWrittenHashes` en fin de
    // compile(). Aucun coût hors watch (cssOnlyTracking false).
    if (this.cssOnlyTracking) {
      const h = createHash('md5').update(content).digest('hex').slice(0, 8)
      this.cssOnlyWrites.set(`${baseName}${ext}`, h)
    }
    // garde-fou ESM (cf. assertValidEsm) — scope .js uniquement, avant tout
    // ajout de sourceMappingURL (les deux branches ci-dessous en profitent).
    if (ext === '.js') this.assertValidEsm(content, `${baseName}${ext}`)
    let finalContent = content
    if (map) {
      // Hash sur le contenu AVANT ajout du sourceMappingURL pour stabilité
      const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
      const filename = `${baseName}-${hash}${ext}`
      finalContent = `${content}\n//# sourceMappingURL=${filename}.map\n`
      const target = join(this.outputDir, filename)
      const mapTarget = `${target}.map`

      this.cleanupOldHashes(baseName, ext, [filename, `${filename}.map`])
      this.writeFileAtomic(target, finalContent)
      this.writeFileAtomic(mapTarget, map)
      this.emittedThisCompile.add(filename)
      return `${this.urlPrefix}/${filename}`
    }

    const hash = createHash('md5').update(content).digest('hex').slice(0, 8)
    const filename = `${baseName}-${hash}${ext}`
    const target = join(this.outputDir, filename)

    this.cleanupOldHashes(baseName, ext, [filename])
    this.writeFileAtomic(target, content)
    this.emittedThisCompile.add(filename)
    return `${this.urlPrefix}/${filename}`
  }

  // --------------------------------------------------------------------------
  // resolveOneAsset(logicalPath) : résout UN asset logique en chemin web hashé.
  // - .coffee → compile via coffee adapter, écrit en .js
  // - .mjs    → délègue à compileMjs (component complet)
  // - autres  → copie raw avec hash sur le contenu (webp, png, etc.)
  // - missing → /MISSING_MJS_ASSET:logicalPath
  // Exposable comme callback à transpile() pour résolution PRE-compilation.
  // --------------------------------------------------------------------------
  // --------------------------------------------------------------------------
  // resolveOneImage(chemin, largeurs) : rend l'objet que `µimage(…)`
  // devient dans le code compilé.
  //
  //   { src, srcset, sizes, width, height }
  //
  // DEUX NIVEAUX, séparés à dessein (cf. bundler/image.ts) :
  //   • les DIMENSIONS natives sont lues dans l'en-tête du fichier, sans aucune
  //     dépendance — c'est elles qui suppriment le saut de mise en page, et elles
  //     marchent partout ;
  //   • les VARIANTES (plusieurs largeurs, formats modernes) exigent `sharp`,
  //     dépendance OPTIONNELLE. Absent : l'image d'origine passe telle quelle, un
  //     avertissement UNIQUE le dit, et le build n'échoue jamais pour autant.
  // --------------------------------------------------------------------------
  async resolveOneImage(logicalPath: string, widths: number[] = []): Promise<Record<string, unknown>> {
    const src = await this.resolveOneAsset(logicalPath)
    const source = join(this.sourceDir, logicalPath)
    if (src.startsWith('/MISSING_MJS_ASSET') || !existsSync(source)) {
      return { src, srcset: '', sizes: '', width: null, height: null }
    }
    const bytes  = readFileSync(source)
    const taille = readImageSize(bytes)
    const base   = { src, srcset: '', sizes: '', width: taille?.width ?? null, height: taille?.height ?? null }

    // le SVG n'a rien à redimensionner : une seule ressource, qui s'adapte toute seule
    if (extname(source).toLowerCase() === '.svg') return base

    const voulues = (widths.length > 0 ? widths : this.imageConfig.widths)
      .filter(w => !taille || w <= taille.width)   // jamais d'agrandissement : une variante plus large que l'original n'apporte rien
      .sort((a, b) => a - b)
    if (voulues.length === 0) return base

    const variantes = await generateVariants({
      bytes,
      baseName: basename(source, extname(source)),
      widths:   voulues,
      formats:  this.imageConfig.formats,
      quality:  this.imageConfig.quality,
    })
    if (!variantes) {
      if (!this.sharpWarned) {
        this.sharpWarned = true
        this.buildWarn(t('bundler.index.image-sharp-absent'))
      }
      return base
    }
    for (const v of variantes) {
      this.writeFileAtomic(join(this.outputDir, v.filename), v.bytes)
      this.emittedThisCompile.add(v.filename)
    }
    // le `srcset` liste les largeurs ; le navigateur choisit. `src` reste l'image
    // d'origine : c'est le repli d'un navigateur qui ne comprendrait pas `srcset`
    const srcset = variantes.map(v => `${this.urlPrefix}/${v.filename} ${v.width}w`).join(', ')
    return { ...base, srcset, sizes: '100vw' }
  }

  async resolveOneAsset(logicalPath: string): Promise<string> {
    const source = join(this.sourceDir, logicalPath)
    // FAILLE — path traversal :
    // `µasset('../../etc/passwd')` (ou `#= require ../../…`) résolvait HORS
    // sourceDir puis COPIAIT le fichier ciblé dans outputDir (exfiltration si
    // les sources ne sont pas 100% de confiance). Confinement strict : le
    // chemin résolu doit rester SOUS sourceDir — sinon « asset introuvable ».
    const srcRoot = resolve(this.sourceDir)
    const abs = resolve(source)
    if (abs !== srcRoot && !abs.startsWith(srcRoot + sep)) {
      return `/MISSING_MJS_ASSET:${logicalPath}`
    }
    // Special-case `mjs_core.js` AVANT le check d'existence : le runtime
    // est hashé séparément dans outputDir, il n'a pas de fichier source dans
    // sourceDir → existsSync renverrait false et on émettrait MISSING_MJS_ASSET.
    // `this.coreHashedPath` est encore vide en phase A (le cœur se décide APRÈS les
    // composants) : rend le REPÈRE, résolu en chemin réel en phase C (cf. compile()).
    if (basename(source) === 'mjs_core.js') {
      return this.coreHashedPath || this.placeholderPath('mjs_core', '.js')
    }
    if (!existsSync(source)) return `/MISSING_MJS_ASSET:${logicalPath}`

    // Confinement RÉEL, en plus du contrôle LEXICAL ci-dessus :
    // celui-ci ne résout jamais un symlink — un lien posé DANS sourceDir et pointant HORS de
    // sourceDir passe le test textuel (le chemin écrit reste sous sourceDir) puis son contenu
    // RÉEL (hors projet) est lu/copié tel quel. realpathSync suit le lien jusqu'à sa cible ;
    // hors du realpath de sourceDir → build en échec, jamais une copie silencieuse.
    const realSource  = realpathSync(source)
    const realSrcRoot = realpathSync(this.sourceDir)
    if (realSource !== realSrcRoot && !realSource.startsWith(realSrcRoot + sep)) {
      throw new Error(t('bundler.index.symlink-hors-racine', { lien: source, cible: realSource }))
    }

    const ext = extname(source)
    if (ext === '.civet')  return await this.compileScriptModule(source, '.civet')
    if (ext === '.coffee') return await this.compileScriptModule(source, '.coffee')
    if (ext === '.mjs')    return await this.compileMjs(source)

    // Binaires (webp/png/etc.) : copie raw avec hash
    const baseName = basename(source, ext)
    const fileBytes = readFileSync(source)
    // garde-fou ESM sur les assets .js bruts (cf.
    // assertParsableJs) — AVANT toute écriture/cleanup, même placement que
    // assertValidEsm en tête de writeHashed(). Scope .js uniquement : les
    // autres binaires ne sont jamais décodés en texte.
    if (ext.toLowerCase() === '.js') this.assertParsableJs(fileBytes.toString('utf-8'), `${baseName}${ext}`)
    // Même hygiène, scope .svg : un SVG copié tel quel est servi depuis
    // la MÊME origine que le reste du site — un <script>/on*=/javascript: embarqué s'exécute au
    // chargement direct de l'URL (ou via <object>/<iframe>). AVANT toute écriture, refus nommé.
    if (ext.toLowerCase() === '.svg') this.assertSafeSvg(fileBytes.toString('utf-8'), `${baseName}${ext}`)
    const hash = createHash('md5').update(fileBytes).digest('hex').slice(0, 8)
    const filename = `${baseName}-${hash}${ext}`
    const target = join(this.outputDir, filename)
    // Même correctif que writeHashed()
    // (cf. son commentaire) : écriture atomique, sinon un crash à mi-écriture
    // laisserait un asset binaire TRONQUÉ jamais réparé par les builds
    // suivants (existsSync le trouve « déjà là »).
    //
    // Cf. le commentaire détaillé de
    // `cleanupOldHashes` : contrairement à `writeHashed` (JS compilé), cette
    // copie binaire ne nettoyait JAMAIS les anciennes versions du même
    // basename — un asset réédité au fil du temps (logo.png changé 50 fois)
    // laissait 50 fichiers `logo-<hash>.png` s'accumuler indéfiniment.
    this.cleanupOldHashes(baseName, ext, [filename])
    this.writeFileAtomic(target, fileBytes)
    this.emittedThisCompile.add(filename) // Équivalent raw de writeHashed() (peut émettre du .js, ex. vendor copié tel quel)
    return `${this.urlPrefix}/${filename}`
  }

  // resolveMagicAssets : applique resolveOneAsset sur tous les `µasset(...)` /
  // `µ.asset(...)` / `mjsasset(...)` / `mjs.asset(...)` d'un texte. Reste
  // utile en post-compilation pour les patterns générés (template, mjs_core).
  // Même élargissement que
  // preResolveAssets (cf. son commentaire) : reconnaît désormais aussi la
  // forme `mjs.asset(...)` (sigil alternatif), pas seulement `µ`.
  async resolveMagicAssets(content: string): Promise<string> {
    const matches = [...content.matchAll(ASSET_RE)]
    let result = content
    if (matches.length > 0) {
      // PERF — dédup par logicalPath :
      // resolveOneAsset (I/O disque + copie hashée) UNE seule fois par chemin,
      // pas une fois par occurrence. Puis UN SEUL passage `replace(RE, fn)` au
      // lieu de N × `result.replace(from,…)` — l'ancienne boucle était O(n²)
      // ET ré-écrivait la MÊME (première) occurrence quand 2 matches avaient un
      // texte identique (2e occurrence jamais remplacée).
      const uniquePaths = [...new Set(matches.map((m) => m[4]))]
      const webPaths = new Map<string, string>()
      await Promise.all(uniquePaths.map(async (lp) => {
        webPaths.set(lp, await this.resolveOneAsset(lp))
      }))
      // Replacer FONCTION : sa valeur de retour est utilisée TELLE QUELLE, sans
      // interprétation des patterns de remplacement (`$&`, `$1`, `` $` ``, `$'`,
      // `$$`) — un `webPath` contenant `$` (urlPrefix/outputDir inhabituel) ne
      // peut plus corrompre le texte injecté.
      result = content.replace(ASSET_RE, (_full, outerQuote, bs, innerQuote, logicalPath) => {
        const webPath = webPaths.get(logicalPath)!
        // Guillemet EXTÉRIEUR présent (`"µasset('…')"` entier) → remplace TOUT
        // (guillemets externes inclus), comme avant. Sinon → ré-échappe le
        // webPath avec le MÊME guillemet/backslash que la source (cf.
        // commentaire de ASSET_RE ci-dessus).
        return outerQuote ? `${outerQuote}${webPath}${outerQuote}` : `${bs}${innerQuote}${webPath}${bs}${innerQuote}`
      })
    }
    // Motif dominant de ce genre de bogue :
    // « erreur avalée → build vert ». Un placeholder `/MISSING_MJS_ASSET:xxx`
    // qui survit JUSQU'ICI (dernier point de passage avant minify+écriture,
    // pour les 2 call-sites de cette fonction) signifie qu'un asset référencé
    // dans le code n'a JAMAIS pu être résolu — jusqu'ici, ce placeholder
    // partait tel quel dans le fichier écrit sur disque, SANS AUCUNE erreur
    // ni warning : un lien/image cassé en prod, découvert seulement par un
    // utilisateur qui clique dessus. Une compilation ne doit JAMAIS réussir
    // avec un asset non résolu — on throw pour que l'appelant (_compileMjsInner
    // / _compileScriptModuleInner) le remonte dans stats.errors.
    // Un
    // `µasset('chemin')` AFFICHÉ en EXEMPLE dans un `<pre>`/`<code>` de doc/tuto
    // (pas une vraie référence) était résolu → placeholder → puis, au scan fatal
    // ci-dessous, cassait TOUT le build. On masque les blocs de code avant le
    // scan : un placeholder qui ne survit QUE dans un `<pre>`/`<code>` ne fait
    // plus échouer le build (il reste dans la sortie comme texte d'exemple, non
    // fatal). NB : afficher l'exemple VERBATIM (au lieu du placeholder) exigerait
    // aussi le masquage côté transpiler `replaceMagicAssets` — hors périmètre ici.
    // Un vrai asset manquant HORS `<pre>` reste, lui, fatal.
    const stillMissing = maskCodeBlocks(result).match(/\/MISSING_MJS_ASSET:([^\s'"]+)/)
    if (stillMissing) {
      throw new Error(t('bundler.index.asset-introuvable', { chemin: stillMissing[1] }))
    }
    return result
  }

  // --------------------------------------------------------------------------
  // prepareExternalManifest() (ex-bundleExternalManifest) : lit le manifest externe
  // (directives `#= require` / `#= require_dir` / `#= require_tree`, dédupe (require_once),
  // compile .coffee/.civet en JS, concatène) — PHASE A (cœur encore inconnu, en-tête `import
  // { µ } from '<REPÈRE du cœur>';`). No-op (aucune unité, `manifest['__external'] = ''`) si
  // le fichier manifest est absent ou ne contient que du contenu vide. Sinon, part en attente
  // d'émission topologique (phase C, cf. compile()) — jamais de cache pour cette unité
  // (comportement identique à avant : recompilée en entier à CHAQUE compile()).
  // --------------------------------------------------------------------------
  async prepareExternalManifest(): Promise<void> {
    this.manifest['__external'] = ''
    // Même si le manifest externe est
    // absent, `externalManifestDeps` doit refléter "plus aucune dep" (sinon
    // un `watch()` qui a déjà ajouté d'anciens chemins au watcher continue
    // de les surveiller pour rien après suppression du manifest externe).
    if (!existsSync(this.manifestExternal)) { this.externalManifestDeps = new Set(); return }

    const visited = new Set<string>()
    const buffer: string[] = []
    await this._processManifestNode(this.manifestExternal, visited, buffer, true)
    // Capturé AVANT le early-return "buffer vide" ci-dessous : `visited`
    // inclut déjà le manifest externe lui-même (et ses require transitifs)
    // même si son contenu ne produit finalement aucun code (tout commenté,
    // etc.) — `watch()` doit quand même le surveiller pour détecter un futur
    // ajout de contenu.
    this.externalManifestDeps = visited
    if (buffer.length === 0) return

    // Le bundle s'exécute en module ES → on importe `µ` explicitement
    // (sinon les imports ne sont pas hoistés et le code ne voit que globalThis.µ). 
    // repère du cœur (pas encore connu en phase A), résolu en phase C.
    const header = `import { µ } from '${this.placeholderPath('mjs_core', '.js')}';`
    const concatenated = [header, ...buffer].join('\n')
    const features = [...scanCompiledFeatures(concatenated)]
    for (const f of features) this.pendingFeatures.add(f)
    // symboles du CONTRAT — jumeau de compileMjsCold (cf. core-contract.ts). Le manifeste externe
    // n'a pas d'entrée de cache : rien à réinjecter ailleurs, il est reconstruit à chaque tour.
    for (const c of collectCoreCalls(concatenated)) this.pendingCoreCalls.add(c)
    // sur le code NON MINIFIÉ (cf. bandeau de compileMjsCold) — pas besoin d'attendre la
    // minification différée plus bas.
    const deps = this.extractPlaceholderDeps(concatenated)
    this.manifest['__external'] = this.placeholderPath('mjs_external', '.js')
    // Minification DIFFÉRÉE (cf. bandeau de `pendingMinifyTasks` sur compileMjsCold), noms
    // d'instance relevés sur le code NON MINIFIÉ comme pour toute unité — jamais en cache, ils
    // sont relevés à chaque tour.
    this.pendingMinifyTasks.push({
      stem: 'mjs_external',
      names: this.shouldMinify() ? collectInstanceNames(concatenated) : [],
      run: async () => {
        const minified = await minifyJs(concatenated, {
          force: this.shouldMinify(),
          filename: 'mjs_external.js',
          mangleCache: this.mangleCache,
          logLevel: this.prodLogLevel(),
        })
        this.pendingUnits.set('mjs_external', { kind: 'cold', file: this.manifestExternal, stem: 'mjs_external', ext: '.js', code: minified.code, deps, features })
      },
    })
  }

  private async _processManifestNode(
    filePath: string,
    visited: Set<string>,
    buffer: string[],
    isManifestRoot: boolean,
  ): Promise<void> {
    const real = resolve(filePath)
    if (visited.has(real) || !existsSync(real)) return
    visited.add(real)

    const ext = extname(real)
    const content = readFileSync(real, 'utf-8')
    const fromDir = dirname(real)

    const codeLines: string[] = []
    const deps: string[] = []

    for (const line of content.split('\n')) {
      let m: RegExpMatchArray | null
      if ((m = line.match(/^\s*#=\s*require\s+(.+?)\s*$/))) {
        deps.push(...this._resolveRequire(m[1], fromDir))
      } else if ((m = line.match(/^\s*#=\s*require_dir\s+(.+?)\s*$/))) {
        deps.push(...this._resolveRequireDir(m[1], fromDir, false))
      } else if ((m = line.match(/^\s*#=\s*require_tree\s+(.+?)\s*$/))) {
        deps.push(...this._resolveRequireDir(m[1], fromDir, true))
      } else {
        codeLines.push(line)
      }
    }

    // Dépendances d'abord (ordre topologique)
    for (const dep of deps) {
      await this._processManifestNode(dep, visited, buffer, false)
    }

    // Code restant de CE fichier (les directives ont été stripées)
    const code = codeLines.join('\n').trim()
    if (code === '') return

    // Si c'est le manifest racine et qu'il n'y a que des directives, le code
    // restant est typiquement vide → skip. Sinon on compile selon l'extension.
    // même remarque qu'au chemin des modules autonomes : seul `code` sert ici, ces fichiers étant
    // concaténés dans un buffer commun où aucune carte individuelle n'aurait de sens
    let js: string = code
    if (ext === '.coffee') {
      const adapter = getAdapter('coffee')
      js = (await adapter.compileToJs(code, { fileName: real })).code
    } else if (ext === '.civet') {
      const adapter = getAdapter('civet')
      js = (await adapter.compileToJs(code, { fileName: real })).code
    } else if (ext === '.ts') {
      const adapter = getAdapter('ts')
      js = (await adapter.compileToJs(code, { fileName: real })).code
    }
    // .js : tel quel
    const label = isManifestRoot ? '(manifest)' : real.split('/').slice(-3).join('/')
    buffer.push(`// === ${label} ===\n${js}`)
  }

  private _resolveRequire(spec: string, fromDir: string): string[] {
    const cleaned = spec.replace(/^['"]|['"]$/g, '').trim()
    const candidates: string[] = []
    if (extname(cleaned)) {
      candidates.push(resolve(fromDir, cleaned))
    } else {
      for (const e of ['.js', '.coffee', '.civet', '.ts']) {
        candidates.push(resolve(fromDir, cleaned + e))
      }
    }
    for (const c of candidates) {
      if (existsSync(c)) return [c]
    }
    this.buildWarn(t('bundler.index.require-introuvable', { spec, dossier: fromDir }))
    return []
  }

  private _resolveRequireDir(spec: string, fromDir: string, recursive: boolean): string[] {
    const cleaned = spec.replace(/^['"]|['"]$/g, '').trim()
    const dirPath = resolve(fromDir, cleaned)
    if (!existsSync(dirPath)) {
      this.buildWarn(t('bundler.index.require-dir-introuvable', { spec, dossier: fromDir }))
      return []
    }
    const exts = ['.js', '.coffee', '.civet', '.ts']
    return this._listFiles(dirPath, exts, recursive).sort()
  }

  private _listFiles(dir: string, exts: string[], recursive: boolean): string[] {
    if (!existsSync(dir)) return []
    const out: string[] = []
    const entries = readdirSync(dir)
    for (const entry of entries) {
      const p = join(dir, entry)
      const st = statSync(p)
      if (st.isDirectory()) {
        if (recursive) out.push(...this._listFiles(p, exts, true))
      } else if (exts.includes(extname(p))) {
        out.push(p)
      }
    }
    return out
  }

  // --------------------------------------------------------------------------
  // i18n façon Rails. Scanne `sourceDir/i18n/` :
  //   - fichiers racine <langue>.yml|.yaml|.json  → `root[langue]` (embarqué
  //     dans le manifeste, en clair) ;
  //   - sous-dossiers <langue>/<section>.yml|.yaml|.json → émis en JSON
  //     compact dans `outputDir/i18n/<langue>/<nom>.json` (fetchés par le
  //     runtime au 1er montage), `sections[langue][section]` = chemin public.
  // Contrat FIGÉ avec `mjs_i18n.ts` (runtime) : cf. `I18nManifestData`.
  // --------------------------------------------------------------------------

  /** Charge paresseusement le parseur YAML — le paquet `yaml` est une
   *  peerDependency OPTIONNELLE (cf. package.json) : un projet 100% `.json`
   *  ne le require jamais. Mémoïse le résultat (une seule tentative de
   *  require par process). Erreur de build explicite si le paquet est
   *  absent du node_modules de l'utilisateur. */
  private _loadYamlParser(path: string): (raw: string) => any {
    if (this._yamlParser) return this._yamlParser
    try {
      this._yamlParser = createRequire(import.meta.url)('yaml').parse
    } catch {
      const rel = relative(this.sourceDir, path)
      throw new Error(t('bundler.index.i18n-yaml-manquant', { fichier: rel }))
    }
    return this._yamlParser!
  }

  // --------------------------------------------------------------------------
  // assertRealUnder() : MÊME confinement RÉEL que
  // findFiles()/resolveOneAsset() (realpathSync, pas seulement lexical), factorisé ICI pour ses
  // deux nouveaux appelants (parseI18nFile, bundleSharedStyles/emitSplitStyles/emitLazyStyles) —
  // ceux-là énumèrent un dossier FIXE (i18nDir, stylesheetsDir) par readdirSync : le chemin
  // TEXTUEL de chaque entrée est déjà confiné par construction, seul un symlink posé DANS ce
  // dossier peut évader — au REALPATH. `root` est le dossier RÉELLEMENT scanné (i18nDir pour
  // l'i18n, stylesheetsDir pour les feuilles — jamais sourceDir en dur : stylesheetsDir peut être
  // configuré HORS de sourceDir, cf. BundlerOpts.stylesheetsDir, auquel cas c'est LUI la racine de
  // confinement légitime, comme findFiles(dir, …) confine à SON `dir`, jamais à sourceDir).
  // --------------------------------------------------------------------------
  private assertRealUnder(path: string, root: string): void {
    // Lien PENDANT (cible absente) :
    // realpathSync lève un ENOENT Node BRUT, jamais catalogué avant — le confinement ne se
    // prouve que si la cible EXISTE, sinon message nommant le lien fautif.
    let realPath: string
    try {
      realPath = realpathSync(path)
    } catch (e: any) {
      if (e && e.code === 'ENOENT') throw new Error(t('bundler.index.symlink-pendant', { lien: path }))
      throw e
    }
    const realRoot = realpathSync(root)
    if (realPath !== realRoot && !realPath.startsWith(realRoot + sep)) {
      throw new Error(t('bundler.index.symlink-hors-racine', { lien: path, cible: realPath }))
    }
  }

  /** Parse un fichier i18n (`.yml`/`.yaml` via le paquet `yaml`, `.json` via
   *  `JSON.parse`) — erreur claire (fichier + cause) si invalide. */
  private parseI18nFile(path: string): any {
    // sourceDir/i18n/<x> (racine ET fragments) est énuméré par readdirSync
    // (scanI18n), mais rien n'empêchait un symlink DANS ce dossier de pointer HORS de sourceDir —
    // son contenu réel était lu et publié en clair (bundle.js pour la racine, JSON émis dans
    // outputDir/i18n/<langue>/ pour un fragment de section).
    // Confinement à i18nDir (sourceDir/i18n), PAS sourceDir entier (le
    // commentaire d'assertRealUnder promet déjà i18nDir comme racine légitime pour cet appelant) :
    // un lien posé DANS i18n/ mais pointant vers un AUTRE fichier de sourceDir (hors i18n/)
    // passait ce garde à tort, accepté comme traduction légitime.
    this.assertRealUnder(path, join(this.sourceDir, 'i18n'))
    const raw = readFileSync(path, 'utf-8')
    const ext = extname(path)
    if (ext === '.json') {
      try {
        return JSON.parse(raw)
      } catch (e: any) {
        throw new Error(t('bundler.index.i18n-fichier-invalide', { chemin: path, erreur: e.message ?? e }))
      }
    }
    const parseYaml = this._loadYamlParser(path)
    try {
      return parseYaml(raw)
    } catch (e: any) {
      throw new Error(t('bundler.index.i18n-fichier-invalide', { chemin: path, erreur: e.message ?? e }))
    }
  }

  /** Sérialisation CANONIQUE d'une valeur i18n analysée — clés d'objet triées
   *  RÉCURSIVEMENT avant `JSON.stringify` : deux dictionnaires qui disent la même
   *  chose en YAML et en JSON, ou dans un ordre de clés différent, tombent sur la
   *  MÊME chaîne. Seul un changement de TEXTE la fait bouger. */
  private canonicalizeI18n(value: any): any {
    if (Array.isArray(value)) return value.map(v => this.canonicalizeI18n(v))
    if (value !== null && typeof value === 'object') {
      const out: Record<string, any> = {}
      for (const k of Object.keys(value).sort()) out[k] = this.canonicalizeI18n(value[k])
      return out
    }
    return value
  }

  /** Empreinte d'un dictionnaire i18n source : 12 hex du MD5 de sa sérialisation
   *  canonique (cf. `canonicalizeI18n`) — c'est la valeur attendue dans `__source`
   *  côté traduction (contrôle d'empreinte, `i18n.source`). */
  private fingerprintI18n(data: any): string {
    return createHash('md5').update(JSON.stringify(this.canonicalizeI18n(data))).digest('hex').slice(0, 12)
  }

  /**
   * scanI18n() : peuple `this.i18nManifestData` (undefined si `sourceDir/i18n/`
   * est absent — aucune clé i18n émise, zéro octet pour les apps sans i18n).
   * `sourceDir/i18n/` présent SANS `i18n.default` (mjs.config.json) → erreur de
   * build explicite. `i18n` configuré SANS `sourceDir/i18n/` → warning non
   * bloquant (retourné, pas lancé). Nom de section invalide ou YAML/JSON
   * invalide → erreur de build claire (fichier + cause).
   */
  scanI18n(): { warnings: string[] } {
    const warnings: string[] = []
    const i18nDir = join(this.sourceDir, 'i18n')
    const dirExists = existsSync(i18nDir) && statSync(i18nDir).isDirectory()

    if (!dirExists) {
      this.i18nManifestData = undefined
      if (this.i18n !== undefined) {
        warnings.push(t('bundler.index.i18n-dossier-absent', { dossier: i18nDir }))
      }
      return { warnings }
    }
    if (!this.i18n?.default) {
      throw new Error(t('bundler.index.i18n-default-manquant'))
    }

    const I18N_EXTS = ['.yml', '.yaml', '.json']
    const SECTION_NAME_RE = /^[a-z0-9_-]+$/
    // hash md5 DU CONTENU (pas aléatoire) — même contenu ⇒ même nom d'un build à l'autre
    // (cache navigateur préservé), contenu modifié ⇒ nom nouveau, orphelins purgés
    // (unlink des anciens .json avant écriture).
    // `i18n.hash` : `'auto'` (défaut) = en prod seulement, noms clairs en dév ; `true` = TOUJOURS,
    // y compris en dév — utile sur un site servi localement par un vrai serveur, où un nom clair
    // laisse le navigateur resservir une prose périmée ; `false` = jamais.
    const hashMode = this.i18n.hash ?? 'auto'
    const useHash = hashMode === 'auto' ? this.isProd() : hashMode

    const root: Record<string, Record<string, any>> = {}
    // chemin relatif RÉEL du fichier racine par langue (extension d'origine, pour les messages).
    const rootFile: Record<string, string> = {}
    // rawSections[langue][section] = { data, outDir, rel } — collectées AVANT écriture disque, le
    // contrôle d'empreinte (ci-dessous) doit pouvoir rejeter un fragment sans jamais l'émettre.
    const rawSections: Record<string, Record<string, { data: any, outDir: string, rel: string }>> = {}

    // `readdirSync` NE GARANTIT
    // AUCUN ORDRE (cf. commentaire jumeau ~2209 `bundleSharedStyles`) : sans
    // `.sort()`, l'ordre des langues/sections alimente `i18nManifestData` →
    // `JSON.stringify` dans `bundle_modular.js` (nom FIXE, pas haché) de façon
    // non déterministe, en conflit avec le skip-write byte-identique de
    // `writeManifest` (~2998). Même correctif, même raison, tri explicite.
    for (const entry of readdirSync(i18nDir).sort()) {
      const entryPath = join(i18nDir, entry)
      const st = statSync(entryPath)
      if (st.isFile()) {
        const ext = extname(entry)
        if (!I18N_EXTS.includes(ext)) continue
        const lang = basename(entry, ext)
        root[lang] = this.parseI18nFile(entryPath)
        rootFile[lang] = `i18n/${entry}`
        continue
      }
      if (!st.isDirectory()) continue
      const lang = entry
      const sectionFiles = readdirSync(entryPath).filter(f => I18N_EXTS.includes(extname(f))).sort()
      if (sectionFiles.length === 0) continue
      const outDir = join(this.outputDir, 'i18n', lang)
      if (!existsSync(outDir)) {
        mkdirSync(outDir, { recursive: true })
      } else {
        // Nettoyage — `sourceDir/i18n/<langue>/` reste la SOURCE DE VÉRITÉ, tout
        // fragment de ce dossier est ré-scanné puis ré-émis à CHAQUE build : les
        // anciens fragments (noms hachés de builds précédents en prod) peuvent
        // donc être purgés sans risque avant réémission.
        for (const old of readdirSync(outDir)) {
          if (extname(old) === '.json') { try { unlinkSync(join(outDir, old)) } catch {} }
        }
      }
      for (const sf of sectionFiles) {
        const sectionExt = extname(sf)
        const section = basename(sf, sectionExt)
        if (!SECTION_NAME_RE.test(section)) {
          throw new Error(t('bundler.index.i18n-section-invalide', { section, chemin: join(entryPath, sf) }))
        }
        const data = this.parseI18nFile(join(entryPath, sf))
        if (!rawSections[lang]) rawSections[lang] = {}
        rawSections[lang][section] = { data, outDir, rel: `i18n/${lang}/${sf}` }
      }
    }

    // Contrôle d'empreinte (opt-in, `i18n.source`) — le français (ou toute langue choisie comme
    // source) fait foi ; une traduction en retard sur elle n'est ni émise ni servie, cf.
    // docs/29-i18n.md § Contrôle d'empreinte.
    const sourceLang = this.i18n.source
    if (sourceLang !== undefined) {
      const hasRootSource = Object.prototype.hasOwnProperty.call(root, sourceLang)
      const hasSectionSource = Object.keys(rawSections).includes(sourceLang)
      if (!hasRootSource && !hasSectionSource) {
        throw new Error(t('bundler.index.i18n-source-langue-inconnue', { langue: sourceLang }))
      }
      // racine — la source elle-même ne se scelle jamais
      if (hasRootSource && Object.prototype.hasOwnProperty.call(root[sourceLang], '__source')) {
        warnings.push(t('bundler.index.i18n-source-scellee', { fichier: rootFile[sourceLang] }))
        delete root[sourceLang].__source
      }
      const rootSourceFingerprint = hasRootSource ? this.fingerprintI18n(root[sourceLang]) : null
      for (const lang of Object.keys(root)) {
        if (lang === sourceLang) continue
        const data = root[lang]
        const has = Object.prototype.hasOwnProperty.call(data, '__source')
        const seal = has ? data.__source : undefined
        delete data.__source
        if (rootSourceFingerprint === null) {
          warnings.push(t('bundler.index.i18n-source-introuvable', { fichier: rootFile[lang], langue: sourceLang }))
          delete root[lang]
        } else if (!has) {
          warnings.push(t('bundler.index.i18n-empreinte-absente', { fichier: rootFile[lang], attendu: rootSourceFingerprint }))
          delete root[lang]
        } else if (seal !== rootSourceFingerprint) {
          warnings.push(t('bundler.index.i18n-empreinte-perimee', { fichier: rootFile[lang], attendu: rootSourceFingerprint }))
          delete root[lang]
        }
      }
      // sections — même sceau, section par section
      const sourceSections = rawSections[sourceLang] ?? {}
      if (rawSections[sourceLang]) {
        for (const section of Object.keys(rawSections[sourceLang])) {
          const secEntry = rawSections[sourceLang][section]
          if (Object.prototype.hasOwnProperty.call(secEntry.data, '__source')) {
            warnings.push(t('bundler.index.i18n-source-scellee', { fichier: secEntry.rel }))
            delete secEntry.data.__source
          }
        }
      }
      for (const lang of Object.keys(rawSections)) {
        if (lang === sourceLang) continue
        for (const section of Object.keys(rawSections[lang])) {
          const entry = rawSections[lang][section]
          const data = entry.data
          const has = Object.prototype.hasOwnProperty.call(data, '__source')
          const seal = has ? data.__source : undefined
          delete data.__source
          const sourceEntry = sourceSections[section]
          const fichier = entry.rel
          if (!sourceEntry) {
            warnings.push(t('bundler.index.i18n-source-introuvable', { fichier, langue: sourceLang }))
            delete rawSections[lang][section]
            continue
          }
          const attendu = this.fingerprintI18n(sourceEntry.data)
          if (!has) {
            warnings.push(t('bundler.index.i18n-empreinte-absente', { fichier, attendu }))
            delete rawSections[lang][section]
          } else if (seal !== attendu) {
            warnings.push(t('bundler.index.i18n-empreinte-perimee', { fichier, attendu }))
            delete rawSections[lang][section]
          }
        }
      }
    }

    // Émission des fragments retenus (RIEN d'écrit pour un fragment rejeté ci-dessus).
    // `sections[langue][section]` garde le seul NOM du fragment (hash en prod, nom clair
    // en dév), jamais son URL entière : le préfixe (`<urlPrefix>/i18n`) est publié UNE
    // fois dans le manifeste et l'URL se reconstitue côté runtime (__i18nSectionUrl,
    // mjs_i18n.ts) — 356 sections par langue répétaient sinon le même préfixe 356 fois.
    const sections: Record<string, Record<string, string>> = {}
    for (const lang of Object.keys(rawSections)) {
      for (const section of Object.keys(rawSections[lang])) {
        const { data, outDir } = rawSections[lang][section]
        const serialized = JSON.stringify(data)
        // hash DU CONTENU (pas aléatoire) — même contenu ⇒ même nom d'un build à
        // l'autre (cache navigateur préservé), contenu modifié ⇒ nom nouveau.
        const stem = useHash ? createHash('md5').update(serialized).digest('hex') : section
        this.writeFileAtomic(join(outDir, `${stem}.json`), serialized)
        if (!sections[lang]) sections[lang] = {}
        sections[lang][section] = stem
      }
    }

    // UN FICHIER PAR LANGUE — `root` + table des sections de CETTE langue seulement,
    // dans `outputDir/mjs_i18n-<langue>-<hash>.js` (module ES à export par défaut, haché sur
    // son contenu comme un composant : même nom tant que la prose ne bouge pas). Le
    // runtime l'importe une fois la langue décidée (mjs_i18n.ts) ; la coquille de l'hôte,
    // qui connaît la langue avant tout JS, peut le précharger dans la première vague.
    // Langues : union racine + sections — une langue qui n'a que des fragments garde sa
    // table (repli de section), même si elle n'est pas SÉLECTIONNABLE (cf. `langs`).
    // PRÉFIXE `mjs_` OBLIGATOIRE — une unité de sortie nommée `i18n-<langue>` était celle
    // qu'un composant `i18n-fr.mjs` porte aussi (même base, même extension) : la purge des
    // anciennes empreintes d'une unité (cleanupOldHashes) supprimait alors le composant
    // compilé, sans erreur ni avertissement, manifeste pointant dans le vide. Le souligné
    // est hors d'atteinte d'un nom de composant (COMPONENT_FILE_NAME_RE : minuscules,
    // chiffres et tirets), comme pour `mjs_core`/`mjs_styles`/`mjs_anims`.
    const files: Record<string, string> = {}
    const toutesLangues = [...new Set([...Object.keys(root), ...Object.keys(sections)])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    if (toutesLangues.length > 0 && !existsSync(this.outputDir)) mkdirSync(this.outputDir, { recursive: true })
    for (const lang of toutesLangues) {
      const contenu = `export default ${JSON.stringify({ root: root[lang] ?? {}, sections: sections[lang] ?? {} })};\n`
      files[lang] = this.writeHashed(`mjs_i18n-${lang}`, '.js', contenu)
    }

    this.i18nManifestData = {
      dev: !this.isProd(),
      default: this.i18n.default,
      placeholder: this.i18n.placeholder ?? 'auto',
      persist: this.i18n.persist ?? false,
      detect: this.i18n.detect ?? false,
      urlParam: this.i18n.urlParam ?? false,
      prefix: `${this.urlPrefix}/i18n`,
      // SÉLECTIONNABLES : dictionnaire racine présent — même domaine de validation
      // qu'avant pour `?lang=`/localStorage/navigator (le runtime testait `root`).
      langs: Object.keys(root).sort((a, b) => a < b ? -1 : a > b ? 1 : 0),
      files,
      root,
      sections,
    }
    return { warnings }
  }

  /** Part du bloc i18n RÉELLEMENT publiée dans le manifeste : tout sauf `root` et
   *  `sections`, partis dans les fichiers de langue (cf. `I18nManifestData`). */
  i18nPublicData(): I18nPublicData | undefined {
    if (!this.i18nManifestData) return undefined
    const { root: _root, sections: _sections, ...publie } = this.i18nManifestData
    return publie
  }

  // --------------------------------------------------------------------------
  // manifestBodyLines(pathsLine) : lignes du CORPS partagées par writeManifest() (mode
  // 'split') ET emitSingleFile() (mode 'bundle', cf. buildBundleSetupBody()) — tout ce que
  // le manifeste pose AVANT que les composants ne s'exécutent, SAUF DEUX choses qui diffèrent
  // selon le mode et restent du ressort de chaque appelant : `µ.paths` lui-même (`pathsLine`,
  // JSON réel en split, `import.meta.url` partagé en bundle) et `µ.Autoloader.observe` (juste
  // après cette liste en split, après TOUS les composants en bundle — l'Autoloader ne doit
  // chercher des enfants qu'une fois leurs propres `customElements.define` exécutés).
  // EXTRAITE ici (refactor pur, sortie de writeManifest() INCHANGÉE à l'octet près, cf.
  // tests/bundler-js-bundle.test.ts « défaut split ») plutôt que dupliquée : ce corps est
  // long et déjà abondamment commenté ligne par ligne, une seule définition à tenir à jour.
  // --------------------------------------------------------------------------
  private manifestBodyLines(pathsLine: string): string[] {
    return [
      // Mode strict « politique de sécurité de contenu » (clé `csp`) — RIEN émis hors de ce
      // mode. Le runtime le lit pour choisir une feuille constructible là où il créait un
      // `<style>` : c'est une décision de BUILD, jamais un réglage à basculer à chaud, d'où
      // la propriété interne plutôt qu'une clé de `µ.config` (qui peut être forgé à la main).
      this.csp ? `µ._csp = true;` : '',
      pathsLine,
      // table nom de feuille → URL du `.css` haché. RIEN émis hors du mode
      // 'lazy' : le runtime ne teste `µ._cssLazy` que lorsque `µ.CSS[nom]` est absent,
      // ce qui n'arrive jamais dans les deux autres modes.
      this.cssMode === 'lazy' && Object.keys(this.lazyStyleUrls).length > 0 ? `µ._cssLazy = ${JSON.stringify(Object.fromEntries(Object.entries(this.lazyStyleUrls).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)))};` : '',
      `µ.preload = ${JSON.stringify(normalizePreload(this.preload))};`,
      // Niveau EFFECTIF de la console (clé `logLevel`, cf. resolveLogLevel/config.ts), CELUI de
      // CET environnement (dev ou prod selon la commande) — ÉMIS INCONDITIONNELLEMENT, comme
      // `µ.preload` juste au-dessus : la clé a toujours un défaut, jamais de bloc absent à gérer.
      // Consommé par `µ.log`/`µ.warn`/`µ.error` (mjs_init.ts).
      `µ._logLevel = ${JSON.stringify(this.currentLogLevel())};`,
      // Libellés par défaut (fr/en) des petits bouts d'UI runtime (mjs_modal.ts, mjs_router.ts,
      // mjs_ujs.ts) — contrairement à `µ._i18nData` juste en dessous, ÉMIS INCONDITIONNELLEMENT :
      // ces libellés doivent être dans TOUS les builds, y compris les apps qui n'utilisent jamais
      // le module i18n optionnel. TOUTES les langues sont émises, plus une
      // seule figée au build : c'est le runtime qui choisit celle AFFICHÉE (`µ._mjs_label`,
      // mjs_init.ts) — un site basculé en anglais montrait des toasts « Succès »/« Erreur ».
      // `µ._runtimeLabelsLang` = langue de repli : celle du projet (`i18n.default`), sinon la
      // clé `lang` de mjs.config.json (`getMessagesLang()`, posée par `setMessagesLang`).
      `µ._runtimeLabels = ${JSON.stringify(RUNTIME_LABELS)};`,
      `µ._runtimeLabelsLang = ${JSON.stringify(this.i18n?.default ?? getMessagesLang())};`,
      (this.viewTransition && this.viewTransition !== 'none') ? `µ.viewTransition = ${JSON.stringify(this.viewTransition)};` : '',
      // i18n — RIEN émis si `sourceDir/i18n/` est absent
      // (scanI18n() laisse `i18nManifestData` à `undefined`, cf. compile()).
      // `µ._i18nRecheck` (cascade de modules — mjs_i18n.ts ne peut plus compter sur un
      // timing de microtâche implicite pour redécouvrir `µ._i18nData`, cf. son bandeau
      // détaillé) : même patron que `µ._themeAdopt` juste en dessous pour `µ._themeCss`.
      // `i18nPublicData()` et pas `i18nManifestData` : les dictionnaires et la table des
      // sections vivent dans le fichier de LEUR langue (cf. scanI18n) — ne reste ici que
      // de quoi CHOISIR la langue (`langs`) et aller chercher son fichier (`files`).
      this.i18nManifestData ? `µ._i18nData = ${JSON.stringify(this.i18nPublicData())}; if (typeof µ._i18nRecheck === 'function') { µ._i18nRecheck(); }` : '',
      // Thèmes de l'application (`*.theme.mjs`) — RIEN émis quand il n'y en a aucun.
      // `µ._themes` autorise la rune `µtheme` à accepter ces noms ; `µ._themeCss` est
      // adopté par `µ._themeAdopt()` (mjs_init.ts), appelé ici ET au boot du runtime,
      // pour que l'ordre de chargement manifeste/runtime n'ait aucune importance.
      this.themeNames.length > 0 ? `µ._themes = ${JSON.stringify(this.themeNames)};` : '',
      this.themeCss !== '' ? `µ._themeCss = ${JSON.stringify(this.themeCss)}; if (typeof µ._themeAdopt === 'function') { µ._themeAdopt(); }` : '',
      // `µ._themeCssByName` : jumeau de `µ._themeCss` ci-dessus, mais PAR THÈME (nom →
      // son propre css, cf. `themeVarData`, rempli par compileThemeFiles() avec un
      // `css` par CompiledTheme, bundler/themes.ts) — le rendu serveur en a besoin pour
      // inliner UN SEUL thème dans le <head> d'une page rendue au serveur, sans le CSS
      // des thèmes non utilisés par cette page. N'écarte rien de `µ._themeCss`.
      this.themeNames.length > 0 ? `µ._themeCssByName = ${JSON.stringify(Object.fromEntries(this.themeVarData.map(td => [td.name, td.css])))};` : '',
    ].filter(l => l.length > 0)
  }

  // --------------------------------------------------------------------------
  // pathsCompaction() : forme des valeurs de `µ.paths` — préfixe commun factorisé (`compact:
  // true`, chaque valeur réduite à son basename) ou chemins entiers. Décision UNIQUE, partagée par
  // writeManifest() (qui l'applique) et par bundler/startup.ts (dont la fiche `__mjs_page` doit
  // poser des valeurs de la MÊME forme, sinon l'Autoloader recollerait le préfixe deux fois ou pas
  // du tout). Repli PRUDENT sur la forme entière : préfixe vide ou réduit à `/` (les suffixes
  // deviendraient des URLs RELATIVES à la page, plus du tout la même cible), ou une seule valeur
  // qui n'en relève pas — rien à factoriser sans risque, on n'y touche pas.
  // --------------------------------------------------------------------------
  pathsCompaction(): { prefix: string; compact: boolean } {
    const prefix = `${this.urlPrefix}/`
    const values = Object.entries(this.manifest).filter(([k]) => k !== '__animations' && k !== '__styles' && k !== '__external').map(([, v]) => v)
    return { prefix, compact: this.urlPrefix.length > 1 && values.every(v => v.startsWith(prefix)) }
  }

  // --------------------------------------------------------------------------
  // writeManifest() : écrit l'entrypoint `bundle_modular.js`
  // --------------------------------------------------------------------------
  writeManifest(): void {
    const animsPath = this.manifest['__animations']
    const stylesPath = this.manifest['__styles']
    const externalPath = this.manifest['__external']
    // mode 'bundle' (défaut) : chemin historique intact, `stylesPath`
    // (posé par bundleSharedStyles() dans this.manifest['__styles']) inchangé. Mode
    // 'split' : bundleSharedStyles() ne tourne jamais (cf. compile(), étape 2c) —
    // `stylesPath` reste undefined — le manifeste importe seulement mjs_root (toujours
    // eager) et les feuilles forcées eager par les DEUX filets de sécurité (aucun module
    // ne les déclare, OU un `<@view css="…">` les réclame — cf. finalizeSplitStyles) ;
    // chaque module qui déclare une feuille l'importe en plus lui-même (cf.
    // prependSplitCssImports, _compileMjsInner) — pour une feuille forcée eager PAR
    // AILLEURS DÉCLARÉE (raison 2 ci-dessus), les deux imports pointent le MÊME chemin
    // haché : l'ESM du navigateur ne l'exécute qu'une fois, `µ.CSS[nom]` posé une seule
    // fois (garde `if (!µ.CSS[nom])` en prime côté fichier émis).
    // en 'lazy', le manifeste n'importe QUE la feuille racine (adoptée sur
    // le document, personne ne la déclare) : les autres n'arrivent que quand un composant
    // les réclame, par leur URL publiée juste en dessous (`µ._cssLazy`).
    // TABLEAU (plus une seule chaîne `import '…';`) : chaque chemin sert AUSSI de
    // href de préchargement (cf. bloc `document` plus bas), en plus de son
    // `await import(…);` après le cœur.
    const stylesPaths: string[] = this.cssMode === 'split'
      ? [this.splitRootHashedPath, ...this.splitEagerHashedPaths].filter((p): p is string => !!p)
      : this.cssMode === 'lazy'
      ? (this.splitRootHashedPath ? [this.splitRootHashedPath] : [])
      : (stylesPath ? [stylesPath] : [])
    // On retire les clés internes du manifest exposé
    const rawPublicManifest = { ...this.manifest }
    delete rawPublicManifest['__animations']
    delete rawPublicManifest['__styles']
    delete rawPublicManifest['__external']
    // ORDRE STABLE — les modules cœur entrent au manifeste dans l'ordre d'ARRIVÉE des
    // compilations PARALLÈLES (chaque fichier terminé annonce ce qu'il réclame) : deux
    // builds du même code produisaient un `µ.paths` identique au contenu près mais
    // PERMUTÉ, d'où un diff git bruyant à chaque build sur une ligne de 90 000
    // caractères. On y cherche toujours par nom, jamais par rang — le tri n'a aucun
    // effet fonctionnel. Comparaison par point de code (pas `localeCompare`, dépendant
    // de la locale de la machine : le tri doit être le MÊME partout)
    const publicManifest = Object.fromEntries(Object.entries(rawPublicManifest).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0))
    // PRÉFIXE FACTORISÉ — toutes les valeurs commencent par le même `<urlPrefix>/`
    // (writeHashed), répété autant de fois qu'il y a de composants : 1 398 entrées sur un
    // vrai site, 37 Ko de préfixe recopié dans une ligne servie sur CHAQUE page. Publié une
    // seule fois (`µ.pathsPrefix`, posé juste avant `µ.paths`), les valeurs ne gardent que
    // leur suffixe ; qui lit un CHEMIN recolle les deux (Autoloader, bloc de préchargement
    // ci-dessous). Les CLÉS ne bougent pas — c'est tout ce que lit mjs_ujs.ts.
    // La décision elle-même (et son repli prudent) vit dans pathsCompaction() ci-dessus : le
    // fichier de page d'une route prérendue (bundler/startup.ts) doit poser la MÊME forme.
    const { prefix: pathsPrefix, compact: compactable } = this.pathsCompaction()
    const emittedPaths = compactable
      ? Object.fromEntries(Object.entries(publicManifest).map(([k, v]) => [k, v.slice(pathsPrefix.length)]))
      : publicManifest
    // même tri, même raison — `this.manifestDeps` (buildManifestDeps) est déjà trié
    // clé par clé, mais chaque VALEUR (tableau de noms) l'est aussi (cf. son commentaire) :
    // rien à refaire ici, JSON.stringify respecte l'ordre d'insertion des deux.
    const manifestDeps = this.manifestDeps

    // cascade de modules à 3 niveaux et plus (mesuré sur l'appli météo du banc : 8 niveaux,
    // le navigateur découvrait le cœur PUIS chaque composant un par un, à la file) —
    // `bundle.js` n'importe donc plus le cœur STATIQUEMENT : un import statique aurait
    // forcé le navigateur à résoudre TOUT le graphe ESM (cœur, feuilles, animations,
    // manifeste externe) avant d'exécuter la moindre ligne de ce fichier, la découverte des
    // composants de la page (Autoloader) ne démarrant qu'ENSUITE, en série avec chaque import
    // suivant. `µCore` reste un littéral de chaîne (le layout Rails du site le cherche par
    // regex, cf. tête de fichier) : le cœur est désormais `import()`é DYNAMIQUEMENT, APRÈS
    // avoir posé des `<link rel="modulepreload">` pour lui, les feuilles/animations/manifeste
    // externe (toujours eager, quelle que soit la page) ET les composants DÉJÀ présents dans
    // le document au moment de l'exécution + la FERMETURE de leurs dépendances directes
    // (`µDeps`, cf. buildManifestDeps) — le navigateur télécharge tout ça EN PARALLÈLE pendant
    // que le cœur s'exécute, au lieu de le découvrir un par un après coup. Sans `document`
    // (moteur de rendu serveur sans DOM, cf. renderToString.ts qui n'exécute d'ailleurs jamais
    // CE fichier tel quel) : aucun préchargement, seul l'import du cœur reste inconditionnel.
    const eagerHrefsLiteral = [this.coreHashedPath, ...stylesPaths, ...(animsPath ? [animsPath] : []), ...(externalPath ? [externalPath] : [])]
      .map(p => JSON.stringify(p)).join(', ')
    // Fiche du FICHIER DE PAGE (`render.startup: 'bundle'`, cf. bundler/startup.ts) : le fragment
    // prérendu porte, quand il en a un, un `<script type="application/json" id="__mjs_page">`
    // nommant le fichier qui assemble LES COMPOSANTS DE CETTE PAGE et les noms qu'il définit. Chaque
    // nom est repointé sur ce fichier AVANT le bloc de préchargement juste en dessous (qui ne
    // redemande donc aucun fichier séparé déjà assemblé) et avant `µ.paths` plus bas (l'Autoloader
    // importe alors le fichier de page, déjà en cache, qui définit tous ces composants d'un coup).
    // Fiche absente (autre mode, autre page, rendu sans DOM) ou JSON abîmé : rien de posé, la table
    // reste celle du manifeste — jamais d'exception, la page doit démarrer quoi qu'il arrive.
    const pageBlock = [
      `let _mjs_page = null;`,
      `if (typeof document !== 'undefined') {`,
      `  const _mjs_pageTag = document.getElementById('__mjs_page');`,
      `  try { _mjs_page = _mjs_pageTag ? JSON.parse(_mjs_pageTag.textContent) : null; } catch (e) { _mjs_page = null; }`,
      `}`,
      `if (_mjs_page && typeof _mjs_page.file === 'string' && Array.isArray(_mjs_page.names)) { _mjs_page.names.forEach((n) => { µPaths[n] = _mjs_page.file; }); }`,
    ].join('\n')
    const preloadBlock = [
      `if (typeof document !== 'undefined') {`,
      `  const µHrefs = new Set([${eagerHrefsLiteral}]);`,
      `  const µSeen = new Set();`,
      `  const µWalkDeps = (name) => {`,
      `    if (µSeen.has(name)) return;`,
      `    µSeen.add(name);`,
      // valeurs COMPACTES (préfixe factorisé, cf. `pathsPrefix` plus haut) : un href se
      // recolle ici, comme l'Autoloader le fait de son côté.
      `    const path = µPaths[name];`,
      `    if (path) µHrefs.add(µPathsPrefix + path);`,
      `    (µDeps[name] || []).forEach(µWalkDeps);`,
      `  };`,
      // même sélecteur/même critère que µ.Autoloader.observe (mjs_autoloader.ts) : les
      // tags CUSTOM ELEMENT `mjs-*` déjà présents dans le document (HTML statique ou
      // rendu serveur) au moment où ce script s'exécute — jamais ceux qu'un `{for}`/`{if}`
      // insérera PLUS TARD (l'Autoloader, plus bas, les rattrape normalement).
      `  document.body.querySelectorAll(':not(:defined)').forEach((node) => {`,
      `    if (node.tagName && node.tagName.startsWith('MJS-')) µWalkDeps(node.tagName.slice(4).toLowerCase());`,
      `  });`,
      `  µHrefs.forEach((href) => {`,
      `    const link = document.createElement('link');`,
      `    link.rel = 'modulepreload';`,
      `    link.href = href;`,
      `    document.head.appendChild(link);`,
      `  });`,
      `}`,
    ].join('\n')
    // `import '<chemin>';` STATIQUE → `import('<chemin>')` DYNAMIQUE : ces fichiers
    // importent eux-mêmes le cœur (déjà résolu à ce point, l'ESM du navigateur ne l'exécute
    // qu'une fois, cf. tête de fichier) — les laisser statiques aurait réintroduit l'attente
    // du cœur avant tout le reste. Styles + animations en `Promise.all` (PAS un `await`
    // par fichier, séquentiel) : régression mesurée (tests/render-browser.test.ts, rendu
    // Chromium réel) — un `await` par chemin sérialise leurs ALLERS-RETOURS réseau, quand
    // le graphe ESM statique d'avant les résolvait tous EN PARALLÈLE (déjà préchargés par
    // le bloc `modulepreload` plus haut de toute façon ; la sérialisation était donc un
    // pur coût ajouté par CE fichier, pas un besoin réel — aucune dépendance entre eux).
    const eagerAsyncPaths = [...stylesPaths, ...(animsPath ? [animsPath] : [])]
    const stylesImport = eagerAsyncPaths.length > 0
      ? `await Promise.all([${eagerAsyncPaths.map(p => `import(${JSON.stringify(p)})`).join(', ')}]);`
      : ''
    const externalImport = externalPath ? `await import(${JSON.stringify(externalPath)});` : ''

    const bodyLines = [
      stylesImport,
      // Préfixe commun des chemins (cf. `pathsPrefix` plus haut) — posé AVANT `µ.paths`,
      // donc avant que le moindre consommateur ne tourne : l'Autoloader recolle
      // `µ.pathsPrefix + µ.paths[nom]` (mjs_autoloader.ts). Rien d'émis quand la
      // factorisation n'est pas sûre : le runtime lit alors un préfixe absent (chaîne
      // vide) et les valeurs sont déjà des chemins entiers.
      compactable ? `µ.pathsPrefix = ${JSON.stringify(pathsPrefix)};` : '',
      // `µPaths` (déjà posé plus haut, réutilisé pour le préchargement) plutôt qu'un
      // 2e JSON.stringify — la ligne reste `µ.paths = …;`, cherchée par ce nom précis
      // ailleurs (recoverFailedComponentManifest ci-dessous, readBuildVersion,
      // extractJsonAfter côté ssr-head.ts, splice de µ.version juste plus bas).
      ...this.manifestBodyLines(`µ.paths = µPaths;`),
      externalImport,
      `if (µ.Autoloader) { µ.Autoloader.observe(document.body); }`,
    ].filter(l => l.length > 0)
    // Utilisait `NODE_ENV` directement
    // (2e définition de "prod", divergente de `isProd()`/`shouldEmitSourceMap()`
    // ci-dessus) : cf. le commentaire détaillé de `isProd()`.
    if (!this.isProd()) {
      bodyLines.push(`window.µ = µ;`)
    }
    // Le corps entier (styles/anims/csp/paths/…/Autoloader.observe) tourne APRÈS la
    // résolution du cœur, dans un `.then()` — JAMAIS un top-level `await` : `bundle.js`
    // resterait alors évaluable tel quel dans un script CLASSIQUE (`eval`, harnais de
    // test — stripEsm/renderToString.ts, tests qui `window.eval()` core+manifest en
    // happy-dom) — un top-level `await` y est une ERREUR DE SYNTAXE (grammaire réservée
    // aux vrais modules ES, `eval()` évalue toujours en grammaire "script"). Une fonction
    // ASYNC ordinaire passée à `.then()` reste, elle, valide PARTOUT.
    // `µReady` exposée sur `window` (SEULEMENT s'il existe) : un IMPORTEUR STATIQUE de ce
    // fichier (`import '/__mjs/bundle.js';`, cf. render-browser.ts) voit son évaluation
    // reprendre dès la fin du corps SYNCHRONE de bundle.js (l'appel `.then()` posé, pas la
    // promesse résolue) — sans ce signal explicite, un tel importeur ne peut pas savoir
    // quand le cœur + les composants de la page sont réellement prêts.
    const lines = [
      `const µCore = '${this.coreHashedPath}';`,
      `const µPathsPrefix = ${JSON.stringify(compactable ? pathsPrefix : '')};`,
      `const µPaths = ${JSON.stringify(emittedPaths)};`,
      `const µDeps = ${JSON.stringify(manifestDeps)};`,
      pageBlock,
      preloadBlock,
      `const µReady = import(µCore).then(async ({ µ }) => {`,
      ...bodyLines.map(l => `  ${l}`),
      `});`,
      `if (typeof window !== 'undefined') { window.__mjsBundleReady = µReady; }`,
    ]
    // (protocole de navigation) — id de build GLOBAL, dérivé du CONTENU
    // assemblé ci-dessus (SAUF la ligne de version elle-même) : même style que
    // writeHashed (md5 8 hex), jamais une horloge → même build = même id, un seul
    // asset qui change = id différent. La garde skip-si-identique juste plus bas
    // reste cohérente par construction (contenu identique ⇒ id identique ⇒ ligne
    // insérée identique). `lastBuildId` posé à CHAQUE writeManifest, y compris
    // quand l'écriture est skippée (id déjà correct, recalculé à l'identique).
    const buildId = createHash('md5').update(lines.join('\n')).digest('hex').slice(0, 8)
    this.lastBuildId = buildId
    // `.trim()` : la ligne vit maintenant DANS le corps indenté de 2 espaces (cf. bodyLines.map ci-dessus).
    const pathsLineIdx = lines.findIndex(l => l.trim().startsWith('µ.paths = '))
    lines.splice(pathsLineIdx + 1, 0, `  µ.version = "${buildId}";`)
    if (!existsSync(dirname(this.manifestPath))) {
      mkdirSync(dirname(this.manifestPath), { recursive: true })
    }
    // Écrivait INCONDITIONNELLEMENT, à
    // CHAQUE compile, même si le contenu généré est BYTE-POUR-BYTE identique
    // à ce qui est déjà sur disque. Cas concret : `manifestPath` configuré
    // (par erreur, ou par nécessité selon l'hébergement) SOUS `sourceDir` —
    // sous `watch()`, cette écriture-sans-changement touche quand même le
    // fichier (nouveau mtime/inode), le watcher la détecte comme une
    // modification, redéclenche un compile(), qui réécrit le manifest à
    // l'identique, qui redéclenche le watcher… boucle de recompilation
    // infinie. Fix : lit le contenu existant et skip l'écriture si identique
    // (comportement fonctionnel inchangé pour tout le reste — seul le
    // TOUCHER inutile du fichier est évité).
    const newContent = lines.join('\n')
    if (existsSync(this.manifestPath)) {
      const current = readFileSync(this.manifestPath, 'utf-8')
      if (current === newContent) return
    }
    // garde-fou ESM (cf. assertValidEsm) — bundle_modular.js est lui aussi du
    // JS émis, même exposé au risque « build vert qui ment ».
    this.assertValidEsm(newContent, basename(this.manifestPath))
    this.writeFileAtomicAlways(this.manifestPath, newContent)
  }

  // --------------------------------------------------------------------------
  // bundleUnitOrder() : mode 'bundle' — ordre d'import des unités dans `mjs:entry`, ENFANTS
  // AVANT PARENTS (tri topologique inverse de `this.manifestDeps`, cf. buildManifestDeps()) :
  // un parent se définit APRÈS ses enfants, l'upgrade d'un élément déjà présent dans la page
  // (rendu serveur, HTML statique) trouve alors ses enfants déjà définis. Post-ordre DFS,
  // départ trié par stem (déterministe) ; `mjs_external` EXCLU (importé séparément, à part,
  // juste après styles/animations — cf. buildBundleEntry()) ; une dep absente de
  // `this.pendingUnits` (échouée, ou résolue autrement) est simplement ignorée, jamais suivie.
  // --------------------------------------------------------------------------
  private bundleUnitOrder(): string[] {
    const stems = [...this.pendingUnits.keys()].filter(s => s !== 'mjs_external').sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const order: string[] = []
    const done = new Set<string>()
    const visiting = new Set<string>()
    const visit = (stem: string): void => {
      if (done.has(stem) || visiting.has(stem)) return  // déjà placé, ou cycle (rompu ailleurs) : jamais revisité
      visiting.add(stem)
      for (const dep of [...(this.manifestDeps[stem] ?? [])].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)) {
        if (this.pendingUnits.has(dep)) visit(dep)
      }
      visiting.delete(stem)
      done.add(stem)
      order.push(stem)
    }
    for (const stem of stems) visit(stem)
    return order
  }

  // --------------------------------------------------------------------------
  // buildBundleSetupBody() : mode 'bundle' — corps du module virtuel 'mjs:setup' (importe
  // 'mjs:core', pose tout ce que le manifeste éclaté pose AVANT ses composants), SAUF
  // `µ.Autoloader.observe` (déplacé dans `mjs:entry`, APRÈS l'import de tous les composants —
  // cf. buildBundleEntry()) ET sans la ligne `µ.version` (posée par l'appelant, cf.
  // writeBundleManifest() : dépend du hash de TOUT le contenu, elle-même comprise). `µ.paths` :
  // CHAQUE nom du projet pointe vers `import.meta.url` — le fichier lui-même (un fichier UNIQUE
  // sert tout le monde ; un `import()` d'une URL déjà chargée est un no-op pour le navigateur) —
  // SEUL l'ensemble des CLÉS compte, jamais les valeurs de `this.manifest` (repères résolus en
  // spécificateurs virtuels par emitSingleFile(), plus jamais lus après ce point).
  // --------------------------------------------------------------------------
  private buildBundleSetupBody(): string {
    const publicNames = Object.keys(this.manifest)
      .filter(k => k !== '__styles' && k !== '__animations' && k !== '__external')
      .sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    const pathsLine = `const µSelfUrl = import.meta.url;\nµ.paths = { ${publicNames.map(n => `${JSON.stringify(n)}: µSelfUrl`).join(', ')} };`
    const lines = this.manifestBodyLines(pathsLine)
    if (!this.isProd()) lines.push(`window.µ = µ;`)
    return lines.join('\n')
  }

  // --------------------------------------------------------------------------
  // buildBundleEntry(unitOrder) : mode 'bundle' — corps du module virtuel 'mjs:entry' (SEUL
  // point d'entrée réel du fichier assemblé, `entryPoints: ['mjs:entry']` d'esbuild.build(),
  // cf. runBundleEsbuild() — jamais un `stdin` qui l'IMPORTERAIT : esbuild ne garde les EXPORTS
  // d'un module que s'il est LUI-MÊME le point d'entrée, un simple `import 'mjs:entry';` depuis
  // un stdin wrapper les aurait fait passer pour un intermédiaire inutilisé et les aurait
  // supprimés au tree-shaking — `export { µ };` disparaissait entièrement, mesuré). Importe le
  // cœur (pour `µ.Autoloader`/l'export final), le setup,
  // styles/animations/manifeste externe s'ils existent, PUIS chaque unité du projet dans
  // `unitOrder` (enfants avant parents) — TOUT est statique et eager, contrairement au manifeste
  // éclaté (plus de cascade à découvrir : un seul fichier, déjà tout chargé). Le corps ne
  // s'exécute jamais dans un `.then()` : rien n'est plus async à attendre (le cœur n'est plus un
  // import DYNAMIQUE d'un AUTRE fichier, cf. bandeau de bundleRuntime()) — `__mjsBundleReady`
  // est donc directement une promesse déjà résolue (contrat lu par render-browser.ts).
  // --------------------------------------------------------------------------
  private buildBundleEntry(unitOrder: string[]): string {
    const lines: string[] = [`import { µ } from 'mjs:core';`, `import 'mjs:setup';`]
    if (this.manifest['__styles']) lines.push(`import 'mjs:styles';`)
    if (this.manifest['__animations']) lines.push(`import 'mjs:anims';`)
    if (this.pendingUnits.has('mjs_external')) lines.push(`import 'mjs:unit/mjs_external';`)
    for (const stem of unitOrder) lines.push(`import 'mjs:unit/${stem}';`)
    // µ.Autoloader n'est du cœur qu'en 'split' (cf. resolveRuntimeFiles) : ici il n'y est que
    // demandé explicitement (`runtime: ['autoloader']`), et on garde alors son observer. Sans lui,
    // un contrôle UNIQUE remplace son seul apport dans ce mode — signaler une balise `mjs-*` que
    // ce fichier ne définit pas (faute de frappe, composant oublié du projet) : tous les
    // `customElements.define` ont déjà tourné au-dessus, tout ce qui reste `:not(:defined)` avec
    // ce préfixe est inconnu pour de bon. Les balises insérées PLUS TARD ne sont pas suivies (pas
    // d'observer) : il n'y aurait rien à charger pour elles non plus.
    lines.push(`if (typeof document !== 'undefined') {`)
    lines.push(`  if (µ.Autoloader) { µ.Autoloader.observe(document.body); }`)
    lines.push(`  else { document.querySelectorAll(':not(:defined)').forEach((n) => { if (n.tagName.indexOf('MJS-') === 0) µ.warn('[ModularJS] <' + n.tagName.toLowerCase() + '> inconnue : aucun composant de ce nom dans le fichier unique'); }); }`)
    lines.push(`}`)
    lines.push(`if (typeof window !== 'undefined') { window.__mjsBundleReady = Promise.resolve(); }`)
    lines.push(`export { µ };`)
    return lines.join('\n')
  }

  // --------------------------------------------------------------------------
  // runBundleEsbuild() : mode 'bundle' — assemble `this.bundleVirtualSources` (cœur, styles,
  // animations, manifeste externe, setup, entry, chaque unité) en UN SEUL module ES, via
  // esbuild.build() EN MÉMOIRE (`write: false`, jamais le disque). Plugin `onResolve`/`onLoad` :
  // tout spécificateur `mjs:...` est résolu dans le namespace `mjsv` et servi depuis
  // `this.bundleVirtualSources` — un spécificateur SANS entrée est un bogue du bundler (aucun
  // ne devrait jamais atteindre ce point, `emitSingleFile()` en garantit l'existence pour
  // chaque unité), jamais une 404 silencieuse. Options MIROIR de `minifyJs()` (cf. minify.ts) :
  // même `define`/`pure`/`mangleProps`, `mangleCache` PARTAGÉ sous le MÊME verrou
  // (`withMangleCacheLock`) que les minifications de phase A — cohérence du mangle de props
  // `_mjs_*` garantie même si rien de neuf ne reste à mangler ici (déjà fait par unité).
  // --------------------------------------------------------------------------
  private async runBundleEsbuild(): Promise<{ code: string; map?: string }> {
    const sources = this.bundleVirtualSources
    const virtualPlugin = {
      name: 'mjs-virtual-bundle',
      setup: (b: any) => {
        b.onResolve({ filter: /^mjs:/ }, (args: any) => ({ path: args.path, namespace: 'mjsv' }))
        b.onLoad({ filter: /.*/, namespace: 'mjsv' }, (args: any) => {
          const key = args.path === 'mjs:core' ? 'mjs_core'
            : args.path === 'mjs:styles' ? 'mjs_styles'
            : args.path === 'mjs:anims' ? 'mjs_anims'
            : args.path === 'mjs:setup' ? 'mjs_setup'
            : args.path === 'mjs:entry' ? 'mjs_entry'
            : args.path.startsWith('mjs:unit/') ? args.path.slice('mjs:unit/'.length)
            : null
          const contents = key !== null ? sources.get(key) : undefined
          if (contents === undefined) {
            throw new Error(t('bundler.index.js-bundle-module-virtuel-introuvable', { specificateur: args.path }))
          }
          return { contents, loader: 'js' }
        })
      },
    }
    const shouldMinify = this.shouldMinify()
    const wantsMap = this.shouldEmitSourceMap()
    const runOnce = () => esbuildBuild({
      entryPoints: ['mjs:entry'],
      absWorkingDir: this.root,
      outfile: basename(this.manifestPath),
      bundle: true,
      write: false,
      format: 'esm',
      target: 'es2022',
      // Sans ceci, esbuild échappe TOUT non-ASCII en `\uXXXX` (y compris le sigil `µ` lui-même,
      // qu'il minifie ou non) — un manifeste 'bundle' ne contenait alors plus jamais le
      // caractère littéral `µ`, cassant tout lecteur regex du manifeste (readBuildVersion,
      // server/build-version.ts) et rendant la sortie visuellement méconnaissable face au
      // manifeste éclaté (jamais échappé, cf. writeManifest()). `charset: 'utf8'` aligne les deux.
      charset: 'utf8',
      treeShaking: true,
      minify: shouldMinify,
      define: { 'µ.debug': 'false' },
      pure: buildPureList(this.prodLogLevel()),
      mangleProps: shouldMinify ? /^_mjs_/ : undefined,
      mangleCache: shouldMinify ? this.mangleCache : undefined,
      keepNames: false,
      legalComments: 'none',
      // Filet pour server/build-version.ts (readBuildVersion) : en prod, esbuild MINIFIE aussi
      // les IDENTIFIANTS — le sigil `µ` porté par `mjs:setup` (`µ.version = "…";`) devient un nom
      // court QUELCONQUE (`n.version="…"`, cf. son bandeau), le texte littéral `µ.version` ne
      // survit alors nulle part. Un `footer` esbuild est ajouté APRÈS la passe de minification,
      // donc JAMAIS renommé/compacté : sert de repère STABLE, lisible sans exécuter le fichier,
      // quel que soit le nom que `µ` a fini par prendre à l'intérieur.
      footer: { js: `//# mjsVersion=${this.lastBuildId ?? ''}` },
      sourcemap: wantsMap ? 'external' : false,
      logLevel: 'silent',
      plugins: [virtualPlugin],
    })
    let result: Awaited<ReturnType<typeof esbuildBuild>>
    try {
      result = shouldMinify ? await withMangleCacheLock(this.mangleCache, runOnce) : await runOnce()
    } catch (e: any) {
      throw new Error(t('bundler.index.js-bundle-echec', { raison: e?.message ?? String(e) }))
    }
    // esbuild N'AJOUTE PAS ses nouvelles entrées AU mangleCache passé — il ne fait que les
    // RENDRE dans `result.mangleCache` (mesuré, même contrat que transform()/minifyJs()) :
    // sans ce merge, chaque compile() reparlerait de zéro, un `_mjs_*` pourrait recevoir un nom
    // court DIFFÉRENT d'un build à l'autre pour un projet pourtant inchangé.
    if (shouldMinify && result.mangleCache) Object.assign(this.mangleCache, result.mangleCache)
    const jsFile = result.outputFiles!.find(f => f.path.endsWith('.js')) ?? result.outputFiles![0]
    const mapFile = result.outputFiles!.find(f => f.path.endsWith('.map'))
    return { code: jsFile.text, map: mapFile?.text }
  }

  // --------------------------------------------------------------------------
  // writeBundleManifest() : mode 'bundle' — même point d'appel que writeManifest() (étape « 4.
  // Manifest entrypoint » de compile(), que cette méthode remplace dans ce mode). `µ.version` :
  // dérivé du md5 de TOUT le contenu AVANT assemblage (chaque source virtuelle triée par nom +
  // le corps du setup + le texte de l'entrée) plutôt que du texte assemblé lui-même (comme
  // writeManifest()) — deux constructions esbuild identiques en ENTRÉE produisent une sortie
  // identique (déterminisme déjà garanti par le mangleCache partagé/trié, cf. bandeau de
  // pendingMinifyTasks), la belle propriété recherchée (même build ⇒ même id) tient donc tout
  // autant, sans le coût d'un 2e passage esbuild pour connaître l'id AVANT de l'injecter dans le
  // texte qu'on hache. Écriture : skip-si-identique, comme writeManifest() (jamais de `touch`
  // inutile sous watch).
  // --------------------------------------------------------------------------
  private async writeBundleManifest(): Promise<void> {
    const unitOrder = this.bundleUnitOrder()
    const setupBody = this.buildBundleSetupBody()
    const entryText = this.buildBundleEntry(unitOrder)
    const hashInput = [...this.bundleVirtualSources.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0)
      .map(([k, v]) => `${k}\0${v}`).join('\0\0')
      + '\0\0setup\0' + setupBody
      + '\0\0entry\0' + entryText
    const buildId = createHash('md5').update(hashInput).digest('hex').slice(0, 8)
    this.lastBuildId = buildId
    this.bundleVirtualSources.set('mjs_setup', `import { µ } from 'mjs:core';\nµ.version = ${JSON.stringify(buildId)};\n${setupBody}`)
    this.bundleVirtualSources.set('mjs_entry', entryText)

    const { code, map } = await this.runBundleEsbuild()
    let newContent = code
    if (map) {
      const mapName = `${basename(this.manifestPath)}.map`
      newContent = `${code}\n//# sourceMappingURL=${mapName}\n`
      this.writeFileAtomicAlways(join(dirname(this.manifestPath), mapName), map)
    }
    if (!existsSync(dirname(this.manifestPath))) {
      mkdirSync(dirname(this.manifestPath), { recursive: true })
    }
    // même garde skip-si-identique que writeManifest() (cf. son commentaire détaillé) : un
    // `mjs dev` dont rien n'a changé ne doit pas toucher le fichier (mtime stable, jamais de
    // boucle de recompilation).
    if (existsSync(this.manifestPath)) {
      const current = readFileSync(this.manifestPath, 'utf-8')
      if (current === newContent) return
    }
    // garde-fou ESM (cf. assertValidEsm) — même exigence que writeManifest().
    this.assertValidEsm(newContent, basename(this.manifestPath))
    this.writeFileAtomicAlways(this.manifestPath, newContent)
  }

  // même motif que writeFileAtomic ci-dessus, non réutilisable ici : le
  // manifest change de contenu à chaque build, alors que writeFileAtomic
  // skippe si `target` existe déjà — inadapté à un chemin FIXE dont le
  // contenu varie. Extrait de writeManifest() pour rester testable isolément
  // (cf. tests/bundler-manifest-atomic.test.ts).
  private writeFileAtomicAlways(target: string, content: string | Buffer): void {
    const tmp = `${target}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`
    writeFileSync(tmp, content, 'utf-8')
    try {
      renameSync(tmp, target)
    } catch (e) {
      try { unlinkSync(tmp) } catch {}
      throw e
    }
  }

  // --------------------------------------------------------------------------
  // watch() : surveille sourceDir + runtimeDir (+ stylesheetsDir + deps du
  // manifest externe) et recompile au changement. Effectue aussi le BUILD
  // INITIAL (voir commentaire détaillé plus bas — avant, c'était au caller
  // de le faire séparément, AVANT d'appeler watch()).
  // Optionnel : `onRecompile` est appelé après chaque (re)compile, initiale
  // incluse (pour HMR) — 2e argument : les CompileStats du tour (dont
  // `cssOnly`, pour router reload complet vs hot-swap CSS).
  // --------------------------------------------------------------------------
  async watch(opts: { onRecompile?: (changedPath: string, stats?: CompileStats) => void } = {}): Promise<void> {
    const chokidar = await import('chokidar')
    // arme le suivi "css-only" (diff par fichier entre deux compiles
    // consécutifs). Uniquement en watch : hors watch, compile() est one-shot,
    // aucune continuité entre deux appels — le verdict resterait toujours null.
    this.cssOnlyTracking = true
    // `stylesheetsDir` n'était jamais
    // surveillé : éditer un style partagé (@css) ne déclenchait AUCUNE
    // recompilation, contrairement à un composant .mjs. Les deps du
    // manifest externe (souvent HORS sourceDir) sont ajoutées dynamiquement
    // plus bas, après le premier calcul de `externalManifestDeps`.
    const watchPaths = [this.sourceDir, this.runtimeDir, this.stylesheetsDir]
    const watcher = chokidar.watch(watchPaths, {
      ignoreInitial: true,
      ignored: [/(^|[\/\\])\../, /node_modules/, /\.git/],
      // Attendre la fin d'écriture : l'événement `change` part dès le truncate
      // (éditeurs non atomiques) → on lisait un fichier VIDE/partiel, compilé
      // et mis en cache ; si le 2e événement était coalescé, la sortie restait
      // figée jusqu'à un `touch` manuel (2e mécanisme du symptôme observé).
      awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 20 },
    })
    // ENOSPC inotify (limite de watches) et autres erreurs étaient avalés
    // sans signal : dossiers non surveillés en silence.
    watcher.on('error', (err: unknown) => {
      // eslint-disable-next-line no-console
      console.error(t('bundler.index.watch-erreur'), err instanceof Error ? err.message : err)
    })

    // Le watcher n'est pas fiable À LA MILLISECONDE où il démarre. Deux
    // temps distincts : chokidar balaie d'abord l'arborescence (`ready`, 2-12ms
    // ici), puis `awaitWriteFinish` compare des `stat` pour décider qu'une
    // écriture est TERMINÉE. Une modification qui tombe dans le premier
    // `stabilityThreshold` après ce balayage court dans les pattes de cette
    // comparaison et peut être AVALÉE — mesuré : événement jamais livré, alors
    // qu'un simple `touch` sur le même fichier une seconde plus tard passe, et
    // que le dossier est bien resté surveillé. Symptôme exact du commentaire
    // ci-dessous, une couche plus bas : « j'ai sauvegardé, rien ne s'est
    // passé ». On ne rend donc la main (ni n'annonce « Watching ») qu'une fois
    // le seuil écoulé. Garde-fou : jamais de blocage indéfini si `ready` se
    // perd (watcher en erreur, dossier disparu).
    const SETTLE_MS = 100
    const watcherReady = new Promise<void>((res) => {
      const done = (): void => { setTimeout(res, SETTLE_MS).unref?.() }
      watcher.once('ready', done)
      setTimeout(done, 5000).unref?.()
    })

    // Sentinelle distincte de tout chemin de fichier réel — désigne le build
    // INITIAL (pas déclenché par un changement précis).
    const INITIAL = Symbol('initial-build')
    const runCompile = async (changed: string | typeof INITIAL) => {
      if (changed !== INITIAL) {
        // Si le fichier modifié est un partial (`_xxx.mjs`), on invalide le
        // cache de tous les parents qui le référencent (via `<@include>` OU
        // `@import` d'un module .civet/.coffee) — sinon leur cache mtime reste
        // valide et leur output figé sur l'ancien hash de la dépendance.
        // La compile() qui suit recompilera l'ensemble.
        const dependents = this.partialDependents.get(resolve(changed))
        if (dependents) {
          for (const parent of dependents) this.cache.delete(parent)
        }
        // eslint-disable-next-line no-console
        console.log(t('bundler.index.watch-recompilation', { fichier: relative(process.cwd(), changed) }))
      } else {
        // eslint-disable-next-line no-console
        console.log(t('bundler.index.watch-build-initial'))
      }
      const start = Date.now()
      const stats = await this.compile()
      // eslint-disable-next-line no-console
      console.log(t('bundler.index.watch-build-termine', { ecrits: stats.written, duree: Date.now() - start, erreurs: stats.errors.length }))
      for (const e of stats.errors) console.error('  ', e.message)
      // Les deps de l'external manifest peuvent changer À CHAQUE compile
      // (nouveau `#= require` ajouté/retiré) — `watcher.add()` sur des
      // chemins déjà surveillés est un no-op sûr (chokidar dédoublonne).
      if (this.externalManifestDeps.size > 0) watcher.add([...this.externalManifestDeps])
      opts.onRecompile?.(changed === INITIAL ? '<initial>' : changed, stats)
    }
    // AVANT ce fix, le CALLER (cli.ts)
    // faisait `await bundler.compile()` (build initial) PUIS SEULEMENT
    // `await bundler.watch()` : fenêtre entre les deux où AUCUN watcher
    // n'existe encore. Un fichier modifié PENDANT le build initial (réaliste
    // — un dev commence à éditer dès que `mjs dev` démarre, avant que la 1ʳᵉ
    // compilation, potentiellement longue sur un gros projet, ne finisse) ne
    // déclenchait ALORS aucune recompilation, silencieusement, jusqu'à une
    // PROCHAINE édition — "j'ai sauvegardé mais rien ne s'est passé".
    // Fix : le watcher est créé et ARMÉ (listeners attachés) AVANT même de
    // lancer le build initial, qui passe désormais par LA MÊME file
    // `inFlight` que les recompiles — un changement survenant PENDANT le
    // build initial est mis en attente (pas perdu) et déclenche sa propre
    // recompile juste après, au lieu d'être silencieusement ignoré.
    let inFlight = runCompile(INITIAL)
    // `.catch` OBLIGATOIRE : sans lui, la première exception de recompile()
    // (statSync TOCTOU, symlink cassé…) laissait `inFlight` rejetée pour
    // toujours → plus aucune recompilation (watcher mort en silence) + crash
    // unhandledRejection sur Node ≥ 15.
    const enqueue = (p: string) => {
      inFlight = inFlight.then(() => runCompile(p)).catch((e) => {
        // eslint-disable-next-line no-console
        console.error(t('bundler.index.watch-recompilation-echouee'), e instanceof Error ? e.message : e)
      })
    }
    watcher.on('change', enqueue)
    watcher.on('add', enqueue)
    watcher.on('unlink', enqueue)

    await watcherReady
    // eslint-disable-next-line no-console
    console.log(t('bundler.index.watch-watching', { chemins: watchPaths.join(' + ') }))
    await inFlight
  }

  // --------------------------------------------------------------------------
  // compileSingle() : helper utilitaire pour compiler une source brute.
  // --------------------------------------------------------------------------
  async compileSingle(source: string, opts: { fileName: string }): Promise<string> {
    const { output } = await transpile(source, {
      moduleName: pageAwareBaseName(opts.fileName),
      isPageModule: isPageFile(opts.fileName),  // même garde que le chemin bundler
      defaultScriptLang: this.defaultScriptLang,
      templateLang: this.templateLang,
      sigil: this.sigil,
      contextAlias: this.contextAlias,
      varPrefix: this.varPrefix,
      maxStateVars: this.maxStateVars,
      a11y: this.a11y,
    })
    return output
  }

  // --------------------------------------------------------------------------
  // findFiles() : récursif, garde l'extension matching.
  //
  // 3 défauts liés, même fonction :
  //   1. Symlink CASSÉ (cible inexistante) : `statSync` (qui SUIT les
  //      symlinks) throw ENOENT — une SEULE entrée pourrie faisait planter
  //      TOUT le build, sans indiquer laquelle.
  //   2. Cycle de symlinks (dossier qui se référence lui-même, directement
  //      ou via une chaîne) : sans suivi des dossiers déjà visités, la
  //      boucle redescend indéfiniment dans le même sous-arbre → `stack`
  //      grossit sans borne, le build ne se termine JAMAIS.
  //   3. `node_modules` jamais exclu : si `sourceDir` contient (ou est
  //      positionné pour englober) un `node_modules`, la recherche
  //      descendait DEDANS — des milliers de fichiers non pertinents
  //      scannés, potentiellement des `.mjs`/`.civet` internes à une
  //      dépendance ramassés par erreur.
  //
  // Fix : (a) `realpathSync` résout la cible RÉELLE de chaque dossier avant
  // de le marquer visité — détecte un cycle même à travers des symlinks
  // syntaxiquement différents pointant vers le même dossier réel ; un
  // `realpathSync`/`statSync` qui échoue (lien cassé, race de suppression
  // concurrente) fait sauter SEULEMENT cette entrée, jamais tout le build ;
  // (b) `node_modules` exclu explicitement de la descente.
  // --------------------------------------------------------------------------
  private findFiles(dir: string, exts: string[]): string[] {
    if (!existsSync(dir)) return []
    const out: string[] = []
    const stack = [dir]
    const visitedRealDirs = new Set<string>()
    // Confinement RÉEL, pas seulement lexical : un symlink de dossier
    // posé DANS `dir` et pointant HORS de `dir` était suivi normalement (readdirSync/statSync
    // résolvent les liens) — tout .mjs qu'il contenait finissait compilé et publié dans
    // outputDir. `realRoot` est calculé une seule fois sur la racine du scan ; chaque dossier
    // visité doit y rester confiné, sinon build en échec (jamais un silence).
    let realRoot: string
    try {
      realRoot = realpathSync(dir)
    } catch {
      return []  // racine elle-même disparue/cassée — rien à scanner
    }
    while (stack.length > 0) {
      const cur = stack.pop()!
      let realCur: string
      try {
        realCur = realpathSync(cur)
      } catch {
        continue  // dossier disparu / symlink cassé — ignore cette branche
      }
      if (realCur !== realRoot && !realCur.startsWith(realRoot + sep)) {
        throw new Error(t('bundler.index.symlink-hors-racine', { lien: cur, cible: realCur }))
      }
      if (visitedRealDirs.has(realCur)) continue  // cycle détecté — déjà descendu ici
      visitedRealDirs.add(realCur)
      for (const entry of readdirSync(cur)) {
        if (entry === 'node_modules') continue
        const p = join(cur, entry)
        let st
        try {
          st = statSync(p)
        } catch {
          continue  // symlink cassé — ignore CETTE entrée, pas tout le build
        }
        if (st.isDirectory()) stack.push(p)
        else if (exts.includes(extname(p))) out.push(p)
      }
    }
    // `readdirSync` ne garantit
    // AUCUN ordre (varie entre machines/FS). Sans tri : ordre de compilation
    // et « dernier compilé gagne » des collisions non déterministes, et surtout
    // le PREMIER build (sans `.mangle-cache.json`) découvre les props `_mjs_*`
    // dans un ordre variable → hashes différents pour un source identique. Tri
    // final → build reproductible (cohérent avec les tris déjà posés sur les
    // styles/anims/require_dir).
    return out.sort()
  }
}
