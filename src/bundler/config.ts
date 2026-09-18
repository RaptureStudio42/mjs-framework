// bundler/config — chargement de mjs.config.json depuis la racine du projet.
//
// Format minimal :
// {
//   "sourceDir": "app/modularjs",
//   "outputDir": "public/modularjs",
//   "manifestPath": "public/modularjs/bundle.js",
//   "defaultScriptLang": "civet",
//   "dev": {
//     "port": 3939,
//     "host": "127.0.0.1"
//   }
// }
//
// Toutes les clés sont optionnelles. Les chemins sont résolus relativement
// au répertoire qui contient le fichier de config (typiquement la racine
// du projet). MJS V2 est 100% standalone : ces paths peuvent pointer où tu
// veux selon ton hébergement (Rails, Express, nginx, hébergement statique).

import { readFileSync, existsSync, realpathSync } from 'node:fs'
import { resolve, dirname, join, basename, sep } from 'node:path'
import type { SupportedLang } from '../languages/index.js'
import { setMessagesLang, t } from '../messages/index.js'
import { isBlockedForwardTarget } from '../server/forward-origin.js'
import { FALLBACK_MODE, isBuildPrerenderable, normalizeMode, startupSlug } from '../server/render-routes.js'

export interface MjsConfig {
  sourceDir?: string
  outputDir?: string
  manifestPath?: string
  /**
   * Manifest externe : fichier qui liste des JS/Coffee/Civet à bundler dans
   * la sortie finale (en plus des composants `.mjs` auto-découverts). Utilise
   * un format de directives simple inspiré de Sprockets mais universel :
   *   #= require <path>           # un fichier (.js / .coffee / .civet)
   *   #= require_dir <dir>        # tous les fichiers du dossier (non-récursif)
   *   #= require_tree <dir>       # tous les fichiers récursivement
   * Sémantique require_once : un fichier déjà inclus n'est jamais ré-inclus.
   * Le code bundlé s'exécute dans un module ES avec `µ` importé du core.
   * Default (si absent) : 'app/modularjs/manifest.civet' s'il existe, sinon
   * repli 'app/modularjs/manifest.coffee' (dépréciée) s'il existe, sinon
   * aucun manifeste externe (résolution faite par le Bundler, pas ici).
   */
  manifestExternal?: string
  /** Préfixe URL public (cf. BundlerOpts.urlPrefix). */
  urlPrefix?: string
  /** Répertoire des styles partagés (référencés par `@css name` dans .mjs). */
  stylesheetsDir?: string
  /**
   * Répertoire du runtime MJS (mjs_*.coffee) si différent de l'emplacement
   * auto-détecté (cf. `Bundler.locateRuntimeDir`). Accepté par KNOWN_KEYS (validation) mais jamais déclaré ici
   * ni transmis par `resolveBundlerOpts` : un projet le renseignant voyait
   * son build passer la validation SANS ERREUR, mais l'option n'avait
   * STRICTEMENT AUCUN EFFET — le pire des deux mondes (ça a l'air d'avoir
   * marché, mais non).
   */
  runtimeDir?: string
  defaultScriptLang?: SupportedLang
  /**
   * Forme à deux axes, remplace
   * PROGRESSIVEMENT `defaultScriptLang`. `languages.script` = même rôle que
   * `defaultScriptLang` (lang par défaut des `<script>` sans `lang=`) ;
   * `languages.template` = grammaire des interpolations `{…}` du template ET
   * des handlers inline (`@click={…}`), défaut `'civet'`, `'js'` = repli
   * comportement historique. PERSONNE ne consomme encore `template` ici — la
   * valeur ne fait que circuler jusqu'au transpiler (briques handlers/
   * interpolations à venir). Rétrocompat : `defaultScriptLang`
   * reste accepté ; si les DEUX sont posées, `languages.script` prime — mais
   * des valeurs DIFFÉRENTES sont une erreur de config (garder une seule clé).
   */
  languages?: LanguagesConfig
  /**
   * Sigil d'API que le DEV tape dans la source. `'µ'` (défaut) ou `'mjs'`
   * (fallback ASCII pour claviers non-AZERTY). En mode `'mjs'`, le compilateur
   * réécrit `mjs.X` / `mjs$X` / `mjs$$X` en `µ.X` / `µ$X` / `µ$$X` AVANT tout le
   * reste — `µ` reste le sigil canonique interne (runtime, bundle). Le point
   * (ou `$`) est OBLIGATOIRE : pas de forme courte collée (`mjsfoo`),
   * sinon des mots comme `mjsonp` seraient corrompus.
   */
  sigil?: 'µ' | 'mjs'
  /**
   * Alias ASCII contexte/partagé (clavier sans `§`), opt-in, `false` par défaut.
   * `true` → `__context.X` = `§X` (contexte), `__shared.X` = `§§X` (partagé).
   * `§`/`§§` restent canoniques. (Le store s'écrit déjà ASCII : `$$`/`µ$$`.)
   */
  contextAlias?: boolean
  /**
   * Compatibilité avec une politique de sécurité de contenu STRICTE (`script-src 'self';
   * style-src 'self'`, sans `'unsafe-inline'`), opt-in, `false` par défaut. À `true`, MJS
   * n'écrit plus rien qu'une telle politique refuserait : aucun `<style>` ni `<script>` en
   * ligne, tout passe par des fichiers servis ou des feuilles constructibles. MJS n'émet
   * lui-même AUCUN en-tête `Content-Security-Policy` — la politique reste l'affaire de
   * l'application. Exige `css: 'split'` ou `css: 'lazy'` (le build refuse en `'bundle'`).
   */
  csp?: boolean
  /** Purge des orphelins d'outputDir après un `mjs build` sans erreur (défaut true) — `false` la
   * désactive. Cf. Bundler.pruneOrphans. */
  prune?: boolean
  /**
   * Émission des cartes de source (`.map`), qui font retomber un point d'arrêt sur la ligne
   * du `.mjs` au lieu du JavaScript compilé. `'dev'` (défaut) : en développement seulement,
   * là où la carte sert · `'prod'` : en build de production seulement · `'always'` : les
   * deux · `'never'` : jamais. En prod, la carte publie la forme lisible du source.
   */
  sourceMap?: 'never' | 'dev' | 'prod' | 'always'
  /**
   * Préfixe des variables de thème : `$$brand`, dans un `<style>` ou un `<theme>`,
   * compile en `var(--<varPrefix>-brand)`. Défaut `'mjs'`. UN SEUL préfixe pour
   * tout le monde, jamais dérivé du nom du module — ce qui est déclaré cascade
   * dans toute la descendance et reste surchargeable, comme en CSS.
   * ⚠ Le changer isole les variables de l'application de celles du framework, qui
   * restent en `--mjs-*` : le thème cesse alors d'être un canal de restylage du
   * framework. À laisser à `'mjs'` sauf raison précise.
   */
  varPrefix?: string
  /**
   * Nom du thème qui vaut SANS attribut, c'est-à-dire ce que voit une page nue.
   * Défaut `'light'`. Le fichier `<defaultTheme>.theme.mjs`, s'il existe, est le
   * seul dont les variables sont aussi posées sur `:root`.
   */
  defaultTheme?: string
  /**
   * `'auto'` (défaut) : on minifie là où la COMMANDE dit prod (`mjs build --prod`).
   * `true` : toujours, même en développement (bundle compact sans passer en prod).
   * `false` : jamais, même en production. Ne décide PAS de l'environnement.
   */
  minify?: boolean | 'auto'
  dev?: {
    port?: number
    host?: string
  }
  /** Rendu piloté par la config — les PAGES (niveau 1). La nav in-app `#/…` reste client. */
  render?: RenderConfig
  /** Préchargement des liens (défaut global ; surchargé par `@preload` module/HTML). */
  preload?: PreloadConfig
  /**
   * Transitions de page (View Transitions) : défaut global, surchargé par
   * @viewTransition module/vue (puis par le lien `mjs-vt`/`@pageTransition` niveau page).
   * CHAÎNE UNIQUEMENT — aucun booléen : `"none"` (ou absent) = désactivé
   * (défaut) ; un nom de préréglage (cf. `VT_PRESET_NAMES`) implique activé.
   * Ce défaut global n'a PAS de priorité propre (toujours 1, cf.
   * `@viewTransition <nom> [priorité]` côté module/vue — mjs_router.ts,
   * `_mjs_vtWinner`) : la config n'est consultée QUE si ni la page de départ ni
   * la page d'arrivée n'ont d'avis explicite.
   */
  viewTransition?: VtValue
  /** Seuils des lints de compilation (avertissements orientants, JAMAIS bloquants). */
  lint?: LintConfig
  /**
   * Niveau de la console — NAVIGATEUR (`µ.log`/`µ.warn`/`µ.error`, cf. runtime/mjs_init.ts) ET
   * sortie du BUILD (ce que le minifieur retire du bundle, cf. bundler/minify.ts ; avertissements
   * du terminal `mjs build`/`mjs dev`), réglés par la MÊME clé. Chaîne (ex. `"warn"`) : même
   * niveau dans les deux environnements. Objet `{ dev?, prod? }` : un niveau par environnement,
   * chaque sous-clé absente retombe sur le défaut de SON environnement. Niveaux, du plus bavard
   * au plus muet : `'log'` (tout) > `'warn'` (avertissements + erreurs) > `'error'` (erreurs
   * seules) > `'silent'` (rien). Défauts : `dev` → `'log'`, `prod` → `'warn'`.
   * `µ.debug = true`, posé à la main dans la console navigateur, FORCE `'log'` quel que soit ce
   * réglage — échappatoire de mise au point, cf. `resolveLogLevel`/`logLevelAllows` ci-dessous.
   */
  logLevel?: LogLevelConfig
  /**
   * Sélection des modules runtime du bundle `mjs_core.js`. Deux familles :
   * - les modules OPTIONNELS (easing, spring, smooth, vault, ajax, socket, game, router,
   *   ujs, flip…) : choix EXPLICITE, jamais d'auto-détection. `'all'` (défaut) les prend
   *   tous, `'core'` aucun, un tableau ceux qu'il nomme ; une faute de frappe LÈVE ;
   * - les éléments du cœur DÉTECTÉS (`DETECTED_CORE_MODULES` : title, store, interpolate,
   *   blocs {for}/{if}/{key}/{await}, balises globales et dynamiques, runes rares, cycle de
   *   vie, contexte §/§§, émission d'événement, variantes de mise en page, chemin lent de
   *   destruction, cache de pages, css différé…) : quelle que soit la valeur, ils ne sont
   *   joints que si une source du projet (ou un module du framework qu'il utilise) s'en
   *   sert, si la CONFIGURATION l'exige (css: 'lazy', router/ujs/modal sélectionné…), ou si
   *   le tableau les nomme.
   * Seuls init, runes, autoloader et element sont toujours là. Généralise l'ancien flag
   * interne `minimalRuntime` (≡ `'core'`).
   */
  runtime?: RuntimeConfig
  /**
   * Mode d'émission des styles partagés (`stylesheetsDir`, référencés par `@css nom`
   * dans un composant). `'bundle'` (défaut) : un seul fichier, importé par le
   * manifeste pour TOUTE page — comportement historique, inchangé. `'split'` : un
   * fichier PAR feuille, importé SEULEMENT par les modules qui la déclarent (`@css`).
   * DEUX filets de sécurité : une feuille qu'aucun module ne déclare, et une feuille
   * nommée dans un `css="…"` LITTÉRAL d'un `<@view>` (elle peut être réclamée là sans
   * passer par `@css`, cf. runtime/mjs_element.ts — et la page qui la réclame ne charge
   * pas forcément le module qui la déclare), restent importées par le manifeste. Un
   * `css={expression}` calculé, lui, reste invisible au build. `'lazy'` : acceptée ICI mais PAS ENCORE
   * IMPLÉMENTÉE — choisie, elle fait échouer le build avec un message dédié.
   */
  css?: CssConfig
  /**
   * Mode d'émission des composants/modules/cœur. `'split'` (défaut) = un fichier haché par
   * unité (comportement historique, inchangé). `'bundle'` = un seul fichier JS pour toute
   * l'appli (cœur + styles + animations + manifeste externe + modules + composants) —
   * pensé pour une petite appli/une page unique qui veut UNE requête JS plutôt qu'une
   * cascade. Exige `css: 'bundle'` (le défaut) : incompatible avec `css: 'split'`/`'lazy'`.
   * Le rendu serveur et le rendu navigateur (SSR, tests Chromium) restent en interne TOUJOURS
   * `'split'`, quel que soit ce réglage : ils rechargent le cœur et les composants fichier par
   * fichier, indépendamment de ce que l'appli sert à un visiteur.
   */
  js?: JsConfig
  /**
   * Traitement des images (`µimage`). `widths` : les largeurs à produire (défaut
   * `[480, 960, 1920]`, jamais d'agrandissement au-delà de la taille native).
   * `formats` : les formats à produire (défaut `['webp']`, parmi avif/webp/jpeg/png).
   * `quality` : 1 à 100, défaut 78. Les VARIANTES exigent `sharp`, dépendance
   * OPTIONNELLE : sans lui, l'image d'origine passe telle quelle et un avertissement
   * unique le dit. Les DIMENSIONS natives, elles, sont toujours lues (en-tête du
   * fichier, aucune dépendance) — c'est ce qui supprime le saut de mise en page.
   */
  image?: { widths?: number[]; formats?: string[]; quality?: number }
  /**
   * Démarrage du serveur temps réel (`mjs ws`, cf. cli/ws.ts + docs/23-mjs-ws.md
   * §7). `entry` : fichier serveur (`export default {...}`, résolution
   * --entry > ws.entry > défauts `ws.server.mjs`/`ws.js`/`ws.civet`/`server/*`,
   * cf. cli/ws.ts pour l'ordre complet). `port`/`host` bornent
   * le transport `ws` par défaut (`port` : priorité --port > ws.port > 4000).
   * `heartbeat`/`limits` sont les MÊMES options que `mjsWs()` (core.ts) —
   * définissables ICI ou dans l'entry ; en cas de doublon, l'ENTRY prime (le
   * code de l'app > la config), avec avertissement.
   */
  ws?: WsConfig
  /**
   * Démarrage du serveur de jeu (`mjs serveur`, cf. cli/server.ts + docs/24-mjs-server.md
   * §2). MÊME forme que `ws` ci-dessus (résolution d'entry propre —
   * --entry > serveur.entry > défauts `serveur.server.mjs`/`serveur.js`/`serveur.civet`/
   * `server/*`, AUCUNE collision avec les défauts `ws.*` : les deux commandes coexistent dans
   * un même projet) + `antiCheat.movesPerIdentity` (cf. `ServeurConfig`). `persist` reste
   * ENTRY-ONLY (adaptateurs à fonctions, non représentables en JSON).
   */
  serveur?: ServeurConfig
  /**
   * i18n façon Rails. Dictionnaires dans
   * `<sourceDir>/i18n/<langue>.yml|.yaml|.json` (RACINE, embarquée dans le
   * bundle) et `<sourceDir>/i18n/<langue>/<section>.yml|.yaml|.json`
   * (fragments émis en JSON statique, fetchés par le runtime au 1er montage).
   * `default` (code langue, requis DÈS que `i18n/` existe dans `sourceDir`) ;
   * `placeholder` : comportement le temps qu'un fragment charge (`'auto'`
   * défaut, `'key'` affiche la clé brute, `'wait'` n'affiche rien) ;
   * `hash` : obfuscation des noms de fragments (booléen, défaut `true`,
   * EFFECTIVE EN PROD SEULEMENT — cf. `Bundler.isProd()`). `persist`
   * (booléen, défaut `false`) : mémorise la langue choisie EXPLICITEMENT via
   * `localStorage`. `detect` (booléen, défaut `false`) : devine la langue
   * initiale via `Intl`/`navigator` au 1er chargement. `urlParam` (booléen,
   * défaut `false`) : reflète la langue dans `?lang=` (écrit à la bascule,
   * lu au boot en priorité) — recharger `?lang=en` repart en anglais.
   * `source` (code langue, FACULTATIF — absente = comportement d'aujourd'hui, opt-in) : active le
   * contrôle d'empreinte (cf. docs/29-i18n.md § Contrôle d'empreinte) — une traduction dont le
   * sceau `__source` ne correspond plus à l'empreinte de cette langue source n'est pas servie.
   * Consommé par le runtime optionnel `mjs_i18n.ts` via `µ._i18nData` (manifest).
   */
  i18n?: I18nConfig
  // langue des messages CLI/compilateur ('fr' défaut, 'en' ; autre → fr)
  lang?: string
  /**
   * Journal d'erreurs 3 étages — étage serveur ACTIF D'OFFICE, étage client OPT-IN,
   * visionneuse dev-open/prod-jeton. `server` (booléen, défaut `true`) : capture les erreurs
   * serveur (catch global, exceptions d'action `.server.mjs`, échecs de rendu SSR, chargeurs
   * de props/actions) dans `<configDir>/log/mjs-errors-server.ndjson`. `client` (booléen,
   * défaut `false`) : ouvre `POST /__mjs/errors` — un client n'envoie QUE si le runtime
   * optionnel `journal` est bundlé ET `µ.config.journal = true` (mjs_init.ts). `viewer`
   * (booléen OU chaîne, défaut `true`) : accès à `GET /__mjs/errors` (page), `GET
   * /__mjs/errors.json`, `DELETE /__mjs/errors` — `true` = servi SEULEMENT hors production
   * (`NODE_ENV !== 'production'`) ; une CHAÎNE = jeton qui protège ces 3 routes en TOUTE
   * circonstance (`?token=<jeton>`, comparaison à temps constant) ; `false` = jamais servi
   * (404 indistinct d'une route inconnue). `maxEntries` (entier > 0, défaut `200`) et
   * `maxBytes` (entier > 0, défaut `1048576`) bornent CHAQUE fichier NDJSON (purge FIFO du
   * plus vieux `dernier` au-delà).
   */
  journal?: JournalConfig
}

/**
 * Param `runtime` : `'all'` (tout), `'core'` (cœur seul), ou un tableau de
 * modules optionnels à ajouter au cœur (cf. `OPTIONAL_RUNTIME_MODULES`).
 */
export type RuntimeConfig = 'all' | 'core' | string[]

/**
 * Param `css` : mode d'émission des styles partagés (`stylesheetsDir`). `'bundle'`
 * (défaut) = un seul fichier pour toutes les feuilles ; `'split'` = un fichier par
 * feuille, importé seulement par les modules qui la déclarent (`@css`) ; `'lazy'` =
 * valeur légale mais PAS ENCORE IMPLÉMENTÉE (échec de build explicite si choisie).
 */
export type CssConfig = 'bundle' | 'split' | 'lazy'

/**
 * Param `js` : mode d'émission des composants/modules/cœur (fusionner les petits composants à
 * la construction). `'split'` (défaut) = comportement
 * historique, un fichier haché par unité + le manifeste qui les orchestre. `'bundle'` = TOUT
 * (cœur, styles partagés, animations, manifeste externe, modules, composants) fusionné dans
 * le SEUL fichier `manifestPath` — une appli à page unique/petite n'ouvre plus qu'une requête
 * JS. Exige `css: 'bundle'` (défaut) : un CSS découpé (`'split'`/`'lazy'`) contredirait « un
 * seul fichier », cf. `js-bundle-exige-css-bundle`.
 */
export type JsConfig = 'split' | 'bundle'

/**
 * Modules runtime OPTIONNELS (retirables). Le CŒUR — init, runes, autoloader, element — est
 * toujours inclus. `debug` est dev-only (géré à part par le bundler, jamais listable). Source
 * unique, partagée avec le bundler (ordre de concaténation) et les tests.
 */
export const OPTIONAL_RUNTIME_MODULES = [
  'easing', 'spring', 'smooth', 'vault', 'ajax', 'socket', 'schema', 'optimistic', 'game', 'chat', 'accounts', 'lobby', 'interp', 'predict', 'det', 'lockstep', 'router', 'modal', 'ujs', 'flip', 'i18n', 'journal',
] as const

/**
 * Modules du cœur qui ne sont PLUS embarqués d'office :
 * `title` (bulles `@title`, mjs_title.ts) — embarqué seulement si une source du projet en pose
 * un usage (scan textuel, `bundler/index.ts` → `scanRuntimeFeatures`) ; `vt_presets`
 * (préréglages `@viewTransition`, mjs_vt_presets.ts) — embarqué seulement si `router` OU `ujs`
 * est sélectionné (règle de config pure, aucun scan) ; `store` (classe `µStore`/`µ.Store`,
 * mjs_store.ts) et `interpolate` (`µinterpolate`/`µ.interpolate`, mjs_interpolate.ts) — MÊME
 * règle que `title` (scan textuel, les deux sigils confondus).
 *
 * Runes et balises globales détachées plus récemment, même doctrine — signal détaillé dans
 * le bandeau de `scanRuntimeFeatures` (bundler/index.ts) : `head` (`<@head>`, mjs_head.ts) ; `body`
 * (`<@body>`/`<@html>`, mjs_body.ts) ; `dynamic` (`<@element>`/`<@module>`, mjs_dynamic.ts) ;
 * `rare_runes` (µplay/µminmax/µinspect/µraw/µsnap/µimport, mjs_rare_runes.ts) ; `on` (µon,
 * mjs_on.ts) ; `effect` (µeffect, mjs_effect.ts — AUSSI forcé par `@persist`/`µdebug $x`/
 * `<@head>`/`<@body>`/`<@html>`/`<@element>`/`<@module>`/`<@window scrollX|scrollY>`, qui
 * s'appuient dessus en silence) ; `every` (µevery, mjs_every.ts) ; `ticker` (`µ.Ticker`,
 * mjs_ticker.ts — forcé si `spring`/`smooth`/`interpolate` est du bundle) ; `failed`
 * (`<@failed>` ou la rune nue `µfailed`, mjs_failed.ts — les deux câblent un `reset` qui appelle
 * `µ._mjs_resetComponent`). Distincts d'`OPTIONAL_RUNTIME_MODULES` : ni vraiment optionnels
 * (retirables sans condition), ni du CŒUR strict (toujours inclus) — `validateRuntimeConfig`
 * les accepte ICI, en plus des optionnels, pour l'usage explicite (`runtime: [..., 'title']`).
 *
 * Les 4 blocs structurels du gabarit, détachés à leur tour (mjs_element.ts en portait le
 * moteur, ~1340 lignes de source) : `for` (`{for item in $liste}`, mjs_for.ts — réconciliation
 * de liste, LIS, pool, FLIP) ; `if` (`{if cond}`, mjs_if.ts — partagé par `{key}`/`{await}`,
 * cf. plus bas) ; `key` (`{key expr}` À LA RACINE, mjs_key.ts — remonte tout le contenu quand la
 * clé change) ; `await` (`{await expr}`, mjs_await.ts — branches `{success}`/`{error}`). Ce sont
 * les briques les plus élémentaires de la syntaxe : le scan (`scanRuntimeFeatures`) reconnaît la
 * forme SOURCE exacte du parseur (`{for `/`{if `/`{key `/`{await `, un espace après le mot-clé,
 * jamais une variante) — un `{if}`/`{key}` IMBRIQUÉ dans `{for}`/`{await}` compile en
 * `_mjs_updItemIf` (mjs_if.ts) mais reste détecté par la MÊME forme SOURCE, pas de signal séparé.
 * `key`/`await` FORCENT `if` (`_mjs_updKey`/`_mjs_updAwait` appellent des méthodes de mjs_if.ts) ; `for`
 * est EN PLUS forcé dès que `flip` (optionnel classique) est du bundle — `mjs_flip.ts` capture
 * `_mjs_reconcileList` à son propre chargement, comme `mjs_ticker.ts` est forcé par
 * `spring`/`smooth`/`interpolate`.
 *
 * `emit` (`_mjs_emit`, mjs_emit.ts — rune `µemit`/`µ.emit`, directive `@emit.NOM`/
 * `@emit.once.NOM`, sucre `@click.emit.NOM`) : self-contained, jamais appelé par le cœur
 * lui-même.
 *
 * `lazy_css` (`µ._mjs_fetchLazyCss`, mjs_lazy_css.ts) : DÉTECTÉ PAR CONFIG SEULE (`css: 'lazy'`),
 * jamais par scan — le bundler n'écrit `µ._cssLazy` au manifeste que dans ce mode.
 *
 * `page_cache` (`µ.LRUCache`/`µ._mjs_isPageCached`/`µ._mjs_destroyEvictedTree`/`µ._mjs_routeErrorCss`/
 * `µ._mjs_label`/`µ._mjs_labelLang`, mjs_page_cache.ts) : DÉTECTÉ PAR CONFIG SEULE — module `router` OU
 * `ujs` OU `modal` sélectionné (ni scan ni forçage par un autre module détecté).
 *
 * `context` (`_mjs_setContext`/`_mjs_getContext`/`_mjs_setRCtx`/`_mjs_getRCtx`/
 * `_mjs_rctxRemember`, mjs_context.ts — symboles `§`/`§§`, leurs formes ASCII `__context.`/`__shared.`
 * de l'option contextAlias et les runes `µsetContext`/`µ.setContext`/`µ.getContext`) :
 * self-contained, jamais appelé par le cœur lui-même.
 *
 * `lifecycle` (`_mjs_hook`/`_mjs_fireMount`/`_mjs_onDestroy`/`_mjs_onSleep`/`_mjs_onAwake`/
 * `_mjs_runDestroyCallbacks`, mjs_lifecycle.ts) : détecté par les runes `µmount`/`µawake`/`µsleep`/
 * `µdestroy`/`µurlChange`/`µfailed` (forme NUE, distincte de `<@failed>`) et par les balises
 * globales `<@window>`/`<@document>`/`<@body>`/`<@html>`/`<@head>` (leur code émis s'attache par
 * `@_mjs_hook 'awake'`/`'sleep'`) ; FORCÉ par `every` (appels sans garde `typeof`), `interpolate`,
 * `smooth`, `socket` et le cache de pages (`router`/`ujs`/`modal`) — ces quatre-là gardent
 * leurs appels, mais sans ce fichier plus rien n'est défait à la destruction (fuite).
 *
 * `layout_variant` (`_mjs_applyLayoutVariant`, mjs_layout_variant.ts — tail de `_mjs_applyLayout`,
 * variants `layout="x"`/`template="x"`) : DÉTECTÉ PAR LA DÉCLARATION `<style name="…">` (ou un
 * fichier `<module>.<nom>.css` déposé dans le dossier de sortie) et par les mots `layout=`/
 * `template=` — la demande seule peut venir d'une page que le build ne lit pas.
 *
 * `destroy_hooks` (`_mjs_destroyWithHooks`, mjs_destroy_hooks.ts — chemin LENT de
 * `_mjs_destroyNodeAndChildren`, transitions `@transition`/`@in`/`@out`/`@attach`/`@this=!`/`@flip`) :
 * DÉTECTÉ PAR SCAN des 5 SEULS émetteurs compilateur de `hasDestroyHooks = true`. Absents
 * PARTOUT dans le projet ⇒ `static _mjs_noDestroyHooks = true` pour CHAQUE composant ⇒ le
 * chemin RAPIDE de `_mjs_destroyNodeAndChildren` (mjs_element.ts, cœur) retourne toujours avant
 * d'atteindre ce fichier.
 *
 * `theme` (thème clair/sombre embarqué — `µ._mjs_themeSheet`/`µ._mjs_themeAppSheet`/
 * `µ._themeAdopt`, mjs_theme.ts) : DÉTECTÉ par le CSS/JS compilé d'une source (une des 8
 * variables canoniques `--mjs-surface`/`fg`/`fg-muted`/`border`/`hover`/`selected`/`accent`/
 * `shadow`, ou `__mjsTheme` — la rune `µtheme`), par un fichier `*.theme.mjs` dans le projet, ou
 * par un consommateur du framework sélectionné (`modal`, `title` — les deux SEULS qui
 * lisent réellement une des 8 variables, vérifié par grep).
 *
 * `html` (`_mjs_updHtml`, mjs_html.ts — interpolation brute `{{…}}`) : DÉTECTÉ PAR SCAN de l'appel
 * littéral `._mjs_updHtml(` que le générateur émet pour chaque `{{…}}` hors {for}/{await} (ces deux
 * blocs posent le nœud eux-mêmes, sans la méthode).
 *
 * `slots` (`_mjs_injectSlots`, mjs_slots.ts — slots indexés `<@slot {i}/>`) : DÉTECTÉ PAR SCAN de
 * l'appel littéral `._mjs_injectSlots(` que le constructeur compilé n'émet plus que pour un composant
 * qui écrit `<@slot` (la méthode ne faisait rien pour les autres).
 *
 * `for_nested` (`_mjs_updList`, mjs_for_nested.ts — `{for}` dans une autre liste, ou dans une branche
 * `{await}`) : DÉTECTÉ PAR SCAN de `this._mjs_updList(`, émis pour ces deux formes seulement ; racine,
 * `{if}` et `{key}` compilent en `this._mjs_updFor(` (mjs_for.ts). FORCE `for` : `_mjs_updList` appelle
 * `_mjs_reconcileList` sans garde.
 *
 * `alias` (`µ._al`, mjs_alias.ts — enregistrement de l'ALIAS COURT d'un composant, `doc/doc-carte.mjs`
 * → `<mjs-carte>`) : DÉTECTÉ PAR SCAN de `µ._al(`, émis par le squelette du module compilé pour le
 * seul composant qui porte un nom court. Un projet dont chaque fichier vit à la racine n'en écrit
 * aucun. Le nom `_al` reste RÉSERVÉ au raccourcisseur même sans le module (cf. `CORE_HELPER_NAMES`,
 * bundler/minify.ts).
 *
 * `deep` (`µ._mjs_deepSet`/`µ._mjs_deepCall`/`µ._mjs_deepDelete`/`µ._mjs_makeDeepProxy`, mjs_deep.ts —
 * mutations PROFONDES d'un état) : DÉTECTÉ PAR SCAN des quatre appels littéraux que le suiveur de
 * chemins (`$o.x = v`, `$liste.push(v)`, `delete $o.x`) émet lui-même.
 *
 * `textpool` (`µ._mjs_getTextNode`/`µ._mjs_releaseTextNode`/`µ._mjs_recycleTextLeaves`, mjs_textpool.ts —
 * pool de nœuds texte) : DÉTECTÉ PAR SCAN de `µ._mjs_getTextNode(`, émis par le seul mode IMPÉRATIF
 * du générateur. Servir et rendre vont ensemble : sans consommateur, remplir le pool ne ferait
 * que retenir des nœuds morts (l'appel du cœur à la libération est gardé).
 *
 * `esc` (`µ._esc`, mjs_esc.ts — échappement HTML) : DÉTECTÉ PAR SCAN de `µ._esc(`, émis pour
 * chaque interpolation d'un `<@head>` ou du repli d'un `<@failed>` (les deux partent en
 * innerHTML) ; joint D'OFFICE dans un build de développement non nu, où le panneau de
 * développement l'appelle pour son propre affichage.
 *
 * `hydrate` (`_mjs_hydrate` et les trois approches d'adoption, mjs_hydrate.ts) : DÉTECTÉ PAR
 * CONFIG SEULE — un mode de rendu qui ADOPTE le DOM du serveur (`ssr:markers`, `ssr:positional`,
 * `ssr:diff`) dans `render.default` ou dans le `mode` d'une route. `csr`/`prerender` n'ont rien à
 * adopter et `ssr`/`ssr:replace` (défaut) reconstruit la vue : aucun des trois n'appelle ces
 * méthodes. Demande EXPLICITE (`runtime: [..., 'hydrate']`) pour un serveur qui rend par l'API
 * sans bloc `render`.
 *
 * `autoloader` (`µ.Autoloader`, mjs_autoloader.ts — découverte des balises `mjs-*` du document et
 * import à la demande du fichier de chaque composant) : DU CŒUR EN `js: 'split'` (jamais retiré),
 * hors du cœur en `js: 'bundle'` — un fichier unique définit lui-même TOUS les composants du
 * projet avant de rendre la main, il n'y a plus rien à aller chercher. Règle de CONFIG pure,
 * aucun scan ; listé ici pour la demande EXPLICITE (`runtime: [..., 'autoloader']`, qui le remet
 * dans un fichier unique — par exemple une page qui insère des balises servies par un autre
 * build).
 */
export const DETECTED_CORE_MODULES = [
  'title', 'vt_presets', 'store', 'interpolate',
  'head', 'body', 'dynamic', 'rare_runes', 'on', 'effect', 'every', 'ticker', 'failed',
  'for', 'if', 'key', 'await', 'emit', 'lazy_css', 'page_cache', 'context', 'lifecycle', 'layout_variant', 'destroy_hooks', 'theme', 'html', 'slots', 'autoloader', 'hydrate', 'deep', 'textpool', 'esc', 'for_nested', 'alias',
] as const

/**
 * Préréglages `runtime` — « paquets activables » CLIENT au-dessus des modules
 * optionnels ci-dessus (branding MJS-WS / MJS-Server : marque de
 * produit en surface, ces clés de config restent en minuscules-tirets — les
 * tirets sont impossibles en identifiant JS, cf. `mjsWs`/`mjsServer` dans
 * mjs-ws/index.ts et mjs-server/index.ts, les identifiants API correspondants). Une
 * entrée `runtime[]` qui correspond à une clé ICI est DÉPLIÉE en ses modules
 * (cf. `expandRuntimePresets`, appelée AVANT la validation stricte des noms de
 * module dans `validateRuntimeConfig` ci-dessous, et à nouveau par
 * `resolveBundlerOpts` pour produire la valeur RÉELLEMENT transmise au
 * Bundler — deux appels, une seule source de vérité). `chat`
 * (src/mjs-ws/chat.ts), `comptes` (src/mjs-ws/accounts.ts) et `lobby`
 * (src/mjs-ws/lobby.ts) ne sont PLUS réservés — les modules de
 * `mjs-ws` + le module client lui-même (`sock.chat`/`sock.account`/`sock.lobby`, src/runtime/
 * mjs_chat.ts|mjs_accounts.ts|mjs_lobby.ts).
 */
export const RUNTIME_PRESETS: Record<string, readonly string[]> = {
  'mjs-ws':      ['socket', 'schema', 'smooth'],
  'mjs-server': ['socket', 'schema', 'smooth', 'game', 'interp', 'predict', 'det', 'lockstep', 'optimistic'],
  chat:          ['socket', 'schema', 'smooth', 'chat'],
  accounts:      ['socket', 'schema', 'smooth', 'accounts'],
  lobby:         ['socket', 'schema', 'smooth', 'lobby'],
}

/**
 * Déplie les préréglages `RUNTIME_PRESETS` d'un tableau `runtime[]` en modules
 * optionnels, puis déduplique (1re occurrence gagne, ordre d'apparition
 * préservé) — PURE, jamais de `console.warn` direct (même patron que
 * `resolveRuntimeFiles`, bundler/index.ts : les avertissements sont RENVOYÉS,
 * à l'appelant de les imprimer — évite un double avertissement puisque cette
 * fonction est appelée deux fois, cf. son commentaire ci-dessus). Une entrée
 * qui n'est PAS un préréglage connu passe telle quelle (un module valide, ou
 * une faute de frappe — la validation stricte qui suit, `validateRuntimeConfig`,
 * s'en charge). Un préréglage RÉSERVÉ (liste vide) n'ajoute rien mais avertit —
 * jamais un échec ; mécanisme CONSERVÉ pour un futur paquet encore sans module
 * (aucun de la table actuelle — mjs-ws/mjs-server/chat/comptes/lobby — n'est
 * plus réservé, cf. RUNTIME_PRESETS ci-dessus).
 */
export function expandRuntimePresets(runtime: readonly string[]): { modules: string[]; warnings: string[] } {
  const modules: string[] = []
  const warnings: string[] = []
  for (const entry of runtime) {
    if (Object.prototype.hasOwnProperty.call(RUNTIME_PRESETS, entry)) {
      const preset = RUNTIME_PRESETS[entry]
      if (preset.length === 0) warnings.push(t('bundler.config.runtime-paquet-non-implemente', { paquet: entry }))
      for (const m of preset) if (!modules.includes(m)) modules.push(m)
      continue
    }
    if (!modules.includes(entry)) modules.push(entry)
  }
  return { modules, warnings }
}

/**
 * Préréglages `@viewTransition` — BASES (cf. src/runtime/mjs_vt_presets.ts,
 * source de vérité du CSS ; miroir côté validation Node). La direction des
 * bases DIRECTIONNELLES se pose désormais UNIQUEMENT via la clé d'option
 * `direction`/`dir` (RETRAIT du suffixe `base:direction` ET des anciens alias
 * suffixés — slide-left, cube-up, turn-right… —, cf. `parseVtValue`).
 * `isVtPresetValue` garde en interne la représentation combinée
 * `base:direction` — usage SYNTHÉTIQUE de reconstruction post-parsing
 * (`validateConfig`), jamais une syntaxe d'entrée. iris/swipe/bars/blocks sont
 * des RIDEAUX « à travers le noir » (vrai DOM) ; les autres animent les
 * pseudos View Transitions.
 */
export const VT_PRESET_BASES = [
  'fade', 'slide', 'zoom', 'zoom-out', 'volet', 'reveal', 'flip',
  'cube', 'turn', 'iris', 'swipe', 'bars', 'blocks',
] as const

export const VT_DIRECTIONS = ['left', 'right', 'up', 'down'] as const

export const VT_DIRECTIONAL_BASES = ['slide', 'volet', 'reveal', 'flip', 'cube', 'turn', 'swipe', 'bars'] as const

/** Rétrocompat : l'ancien export listait les noms plats — il pointe désormais les bases. */
export const VT_PRESET_NAMES = VT_PRESET_BASES

/** Une valeur de préréglage est-elle valide ? (base seule, ou `base:direction` —
 *  représentation SYNTHÉTIQUE interne reconstruite après parsing, jamais une
 *  syntaxe d'entrée : le suffixe n'est plus accepté en ENTRÉE, cf. `parseVtValue`). */
export function isVtPresetValue(v: string): boolean {
  const m = v.match(/^([a-z][a-z0-9-]*?)(?::(left|right|up|down))?$/)
  if (!m) return false
  if (!(VT_PRESET_BASES as readonly string[]).includes(m[1])) return false
  if (m[2] && !(VT_DIRECTIONAL_BASES as readonly string[]).includes(m[1])) return false
  return true
}

// ──────────────────────────────────────────────────────────────────────────
// syntaxe OBJET `@viewTransition.<nom>={ direction, duration, priority }`
// (calquée sur `@transition.fly={ y: 200, duration: 2000 }`) : mini-grammaire
// TEXTE (pas du JS évalué), partagée par la config (`viewTransition`), la
// directive racine et l'attribut `<@view>` — cf. leurs propres call-sites
// pour les erreurs de FORME (ancienne écriture espace/valeur statique, on/off
// explicites, suffixe `:direction` sur le NOM) : hors de portée d'ici, qui
// valide UNIQUEMENT la grammaire du nom+options déjà isolé de son enrobage
// syntaxique (le suffixe `:` du nom est TOUT DE MÊME détecté ici, cf. plus
// bas — seul filet pour le call-site CONFIG, qui n'a pas de label de
// directive à préfixer contrairement aux 3 autres call-sites).
// ──────────────────────────────────────────────────────────────────────────

/** Les 3 clés d'options valides de la mini-grammaire — cf. `parseVtValue`. */
export const VT_OPTION_KEYS = ['direction', 'duration', 'priority'] as const

/** Forme COURTE de chaque clé — mixable librement avec
 *  la forme longue, jamais les DEUX pour la MÊME option (« clé en double »). */
export const VT_OPTION_SHORT: Record<typeof VT_OPTION_KEYS[number], string> = {
  direction: 'dir', duration: 'dur', priority: 'p',
}

/** Table brute (longue OU courte) → forme canonique — les 6 clés réellement acceptées. */
const VT_OPTION_KEY_ALIASES: Record<string, typeof VT_OPTION_KEYS[number]> = {
  direction: 'direction', dir: 'direction',
  duration: 'duration', dur: 'duration',
  priority: 'priority', p: 'priority',
}

// Distance de Levenshtein — clés courtes (1-9 caractères) : suggestion de
// proximité sur une faute de frappe ('duraction' → 'duration'/'dur'), jamais un
// alias silencieux (décision explicite : une faute de frappe DOIT échouer).
export function levenshtein(a: string, b: string): number {
  const dp: number[][] = []
  for (let i = 0; i <= a.length; i++) dp[i] = [i]
  for (let j = 0; j <= b.length; j++) dp[0][j] = j
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j - 1], dp[i - 1][j], dp[i][j - 1])
    }
  }
  return dp[a.length][b.length]
}

// Suggestion « tu voulais dire ? » GÉNÉRIQUE — distance ≤ 2 contre une liste de
// clés valides, sinon aucune suggestion. Réutilisée par la validation `ws`/
// `ws.limits` ci-dessous (clé inconnue) — MÊME politique que suggestVtOptionKey
// juste en dessous (faute de frappe → suggestion, jamais un alias silencieux),
// généralisée ici pour un jeu de clés plates (pas de forme longue/courte).
export function suggestKey(key: string, validKeys: Iterable<string>): string | null {
  let best: string | null = null
  let bestDist = Infinity
  for (const k of validKeys) {
    const d = levenshtein(key, k)
    if (d < bestDist) { bestDist = d; best = k }
  }
  return best !== null && bestDist <= 2 ? best : null
}

// Suggestion « tu voulais dire ? » — distance ≤ 2 contre les 6 formes valides
// (3 clés × longue/courte), sinon aucune suggestion. Retourne TOUJOURS la
// PAIRE canonique (jamais une seule des deux formes) — ex. 'duraction' →
// { long: 'duration', short: 'dur' }, affiché « tu voulais dire 'duration'/'dur' ? ».
function suggestVtOptionKey(key: string): { long: string; short: string } | null {
  let best: typeof VT_OPTION_KEYS[number] | null = null
  let bestDist = Infinity
  for (const variant of Object.keys(VT_OPTION_KEY_ALIASES)) {
    const d = levenshtein(key, variant)
    if (d < bestDist) { bestDist = d; best = VT_OPTION_KEY_ALIASES[variant] }
  }
  return best !== null && bestDist <= 2 ? { long: best, short: VT_OPTION_SHORT[best] } : null
}

/** Valeur `@viewTransition` parsée : base, direction, durée demandée (ms),
 *  priorité — `null` pour les champs absents (défauts résolus par l'appelant). */
export interface VtParsedValue {
  base: string
  dir: 'left' | 'right' | 'up' | 'down' | null
  durationMs: number | null
  priority: number | null
}

export type VtParseResult = { ok: true; value: VtParsedValue } | { ok: false; error: string }

/**
 * Valide + parse la mini-grammaire COMPLÈTE d'une valeur `@viewTransition` :
 * nom seul, `none`, et le bloc d'options `={ clé: valeur, … }` — clés LONGUES
 * ou COURTES (direction/dir, duration/dur, priority/p), mixables librement,
 * jamais la MÊME option sous ses deux formes (« clé en double ») ; guillemets
 * facultatifs autour des valeurs, espaces libres. Le suffixe `base:direction`
 * et les anciens alias suffixés (slide-left, cube-up…) N'EXISTENT PLUS
 * (RETRAIT) : un `:` dans le nom est une erreur ICI (call-site CONFIG,
 * seul niveau sans label de directive à préfixer) — les 3 autres call-sites
 * (racine, `<@view>`, balise) l'interceptent EUX-MÊMES en amont avec un
 * message qui cite leur propre label (cf. directives.ts / transpiler/index.ts),
 * donc n'atteignent jamais cette branche avec un `:` dans le nom. Ne vérifie
 * PAS que `base` appartient à la bibliothèque connue — tolérance historique
 * du COMPILATEUR (cf. le commentaire d'origine dans directives.ts : nom
 * inconnu ⇒ `µ.warn` + repli au runtime, jamais une erreur de compilation) ;
 * SEULE la config ajoute cette vérification stricte en plus, via
 * `isVtPresetValue` sur le résultat.
 */
export function parseVtValue(raw: string): VtParseResult {
  const s = (raw ?? '').trim()
  if (s === '') return { ok: false, error: t('bundler.config.vt-valeur-vide') }
  const m = s.match(/^([^=]+?)(?:=\s*\{([^}]*)\}\s*)?$/)
  if (!m) return { ok: false, error: t('bundler.config.vt-valeur-malformee', { valeur: s }) }
  const namePart = m[1].trim()
  const optsRaw = m[2]

  // le suffixe `:direction` n'existe plus : la SEULE façon d'orienter une
  // base est la clé d'option `direction`/`dir` (cf. le commentaire de tête).
  if (namePart.includes(':')) {
    const before = namePart.split(':')[0]
    return {
      ok: false,
      error: t('bundler.config.vt-direction-dans-nom', { nom: namePart, avant: before }),
    }
  }

  const nm = namePart.match(/^([a-z][a-z0-9-]*)$/)
  if (!nm) return { ok: false, error: t('bundler.config.vt-nom-invalide', { nom: namePart }) }
  const base = nm[1]
  let dir: 'left' | 'right' | 'up' | 'down' | null = null

  let durationMs: number | null = null
  let priority: number | null = null

  if (optsRaw !== undefined && optsRaw.trim() !== '') {
    const seenKeys = new Set<typeof VT_OPTION_KEYS[number]>()
    for (const pairRaw of optsRaw.split(',')) {
      const pair = pairRaw.trim()
      if (pair === '') continue // virgule finale tolérée
      const pm = pair.match(/^([a-zA-Z]+)\s*:\s*(.+)$/)
      if (!pm) return { ok: false, error: t('bundler.config.vt-option-malformee', { option: pair }) }
      const rawKey = pm[1]
      const key = VT_OPTION_KEY_ALIASES[rawKey]
      if (!key) {
        const suggestion = suggestVtOptionKey(rawKey)
        const hint = suggestion ? ` — tu voulais dire '${suggestion.long}'/'${suggestion.short}' ?` : ''
        const validList = VT_OPTION_KEYS.map(k => `${k}/${VT_OPTION_SHORT[k]}`).join(', ')
        return { ok: false, error: t('bundler.config.vt-option-cle-inconnue', { cle: rawKey, hint, valides: validList }) }
      }
      // clé en double — la MÊME option sous ses 2 formes (ou répétée telle quelle) :
      // { dir: left, direction: right } n'a plus de sens depuis que le suffixe
      // `:direction` (seule source possible de conflit) est retiré.
      if (seenKeys.has(key)) {
        return { ok: false, error: t('bundler.config.vt-cle-double', { cle: key, court: VT_OPTION_SHORT[key] }) }
      }
      seenKeys.add(key)
      let val = pm[2].trim()
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1).trim()
      }
      if (key === 'direction') {
        if (!(VT_DIRECTIONAL_BASES as readonly string[]).includes(base)) {
          return {
            ok: false,
            error: t('bundler.config.vt-direction-non-directionnelle', { base, bases: VT_DIRECTIONAL_BASES.join(', ') }),
          }
        }
        if (!(VT_DIRECTIONS as readonly string[]).includes(val)) {
          return { ok: false, error: t('bundler.config.vt-direction-invalide', { valeur: val, valides: VT_DIRECTIONS.join(', ') }) }
        }
        dir = val as 'left' | 'right' | 'up' | 'down'
      }
      else if (key === 'duration') {
        // nombre NU uniquement, toujours des ms (cohérence setTimeout) :
        // 'ms'/'s' suffixés N'EXISTENT PLUS (RETRAIT), cf. le commentaire de tête.
        const dm = val.match(/^(\d+)$/)
        if (!dm) {
          return { ok: false, error: t('bundler.config.vt-duration-invalide') }
        }
        const ms = parseInt(dm[1], 10)
        if (!(ms > 0)) {
          return { ok: false, error: t('bundler.config.vt-duration-invalide') }
        }
        durationMs = ms
      }
      else if (key === 'priority') {
        if (!/^\d+$/.test(val)) {
          return { ok: false, error: t('bundler.config.vt-priority-invalide', { valeur: val }) }
        }
        priority = parseInt(val, 10)
      }
    }
  }

  return { ok: true, value: { base, dir, durationMs, priority } }
}

/**
 * Valeur légale de `viewTransition` (config, et `µ.viewTransition` au runtime) :
 * `"none"` = désactivé (défaut, explicite — AUCUN booléen accepté, cf. son
 * commentaire dans `MjsConfig`), ou une base, `base:direction`, ou alias
 * historique — cf. `isVtPresetValue`.
 */
export type VtValue = 'none' | typeof VT_PRESET_BASES[number] | (string & {})

/** Mode de préchargement d'un lien. `off` = jamais ; `hover` = au survol ;
 *  `on` = dès l'apparition du lien dans le DOM (sans attendre le survol). */
export type PreloadMode = 'off' | 'hover' | 'on'

/**
 * Préchargement des liens, sur DEUX axes (coûts différents) :
 *  - `view` : liens routés MJS `#/…` → import du module de vue (quasi gratuit).
 *  - `page` : liens inter-pages → fetch du HTML de la page serveur (coûte un aller-retour réseau).
 * Raccourci chaîne : `"hover"` ≡ `{ view: "hover", page: "off" }` (n'agit que
 * sur la vue ; la page serveur, coûteuse, reste opt-in). Défauts : view `hover`,
 * page `off`. Surchargeable par `@preload` (racine de module, puis attribut `<a>`).
 */
export type PreloadConfig = PreloadMode | { view?: PreloadMode; page?: PreloadMode }

/** Normalise la config preload vers `{ view, page }` avec les défauts appliqués. */
export function normalizePreload(
  preload: PreloadConfig | undefined,
): { view: PreloadMode; page: PreloadMode } {
  if (typeof preload === 'string') return { view: preload, page: 'off' }
  return { view: preload?.view ?? 'hover', page: preload?.page ?? 'off' }
}

/** Lints de compilation configurables — avertissements orientants, jamais bloquants. */
export interface LintConfig {
  /** Au-delà de N variables d'état `$x` distinctes dans UN composant →
   *  avertissement « découpe en sous-composants ». Entier ≥ 0 ; `0` désactive.
   *  Défaut appliqué (transpiler) : 40 — étalonnage réel : modules sains 5-20,
   *  monolithe pathologique vu à 182. */
  maxStateVars?: number
  /** Alertes d'accessibilité (a11y) au build — sept contrôles ciblés (image sans
   *  alt, iframe sans title, tabindex positif, @click non interactif, bouton/lien
   *  sans nom accessible, champ de saisie sans étiquette), cf. transpiler/a11y.ts.
   *  Avertissements orientants, jamais bloquants. Défaut appliqué (transpiler) :
   *  `true` (activé) — `false` désactive tout le contrôle. */
  a11y?: boolean
  /** Avertissement sur un `<form>` qui n'a ni `action`, ni `@method`/`mjs-method`,
   *  ni `@noUJS` : le pont UJS l'intercepte quand même (contrat conservé), et
   *  repart en navigation vers l'URL courante faute de destination déclarée, cf.
   *  transpiler/ujs-form.ts. Avertissement orientant, jamais bloquant. Défaut
   *  appliqué (transpiler) : `true` (activé) — `false` désactive tout le contrôle. */
  ujsForm?: boolean
}

/** Niveaux de verbosité de la console, du plus bavard au plus muet. */
export type LogLevelName = 'log' | 'warn' | 'error' | 'silent'

/**
 * Réglage de la clé `logLevel` (cf. le JSDoc de `MjsConfig.logLevel` pour la sémantique
 * complète) — une chaîne (même niveau dev/prod) ou un objet `{ dev?, prod? }` (un niveau par
 * environnement, sous-clé absente = défaut de cet environnement).
 */
export type LogLevelConfig = LogLevelName | { dev?: LogLevelName; prod?: LogLevelName }

/** Défauts — dev bavard (`'log'`), prod mesuré (`'warn'`, comportement de build inchangé). */
const DEFAULT_LOG_LEVELS: Record<'dev' | 'prod', LogLevelName> = { dev: 'log', prod: 'warn' }

/** Rang numérique d'un niveau — plus haut = plus bavard. Sert à `logLevelAllows`. */
const LOG_LEVEL_RANK: Record<LogLevelName, number> = { log: 3, warn: 2, error: 1, silent: 0 }

/**
 * Résout `logLevel` (chaîne ou objet `{ dev?, prod? }`, cf. `LogLevelConfig`) vers le niveau
 * EFFECTIF d'un environnement donné, défauts appliqués. `undefined` (clé absente de la config)
 * retombe entièrement sur les défauts.
 */
export function resolveLogLevel(logLevel: LogLevelConfig | undefined, env: 'dev' | 'prod'): LogLevelName {
  if (typeof logLevel === 'string') return logLevel
  return logLevel?.[env] ?? DEFAULT_LOG_LEVELS[env]
}

/**
 * `level` autorise-t-il un message de rang `atLeast` ? Ex. `logLevelAllows('error', 'warn')` →
 * `false` (le niveau `'error'` masque les avertissements) ; `logLevelAllows('log', 'warn')` →
 * `true`.
 */
export function logLevelAllows(level: LogLevelName, atLeast: LogLevelName): boolean {
  return LOG_LEVEL_RANK[level] >= LOG_LEVEL_RANK[atLeast]
}

/**
 * Section `ws` — cf. le JSDoc de `MjsConfig.ws` pour la sémantique complète.
 * `limits` reprend les MÊMES clés que `MjsWsLimits` (src/mjs-ws/core.ts),
 * dupliquées ici en littéral pour ne PAS coupler bundler/config.ts (compilé
 * dans dist/cli.js) au module MJS-WS (Node-seulement, cf. src/mjs-ws/index.ts) —
 * juste une validation de FORME, aucune logique protocolaire.
 */
export interface WsConfig {
  entry?: string
  /**
   * Transport — `'ws'` (défaut, bibliothèque `ws`) ou `'uws'` (uWebSockets.js, paquet natif à
   * installer à part, cf. src/mjs-ws/transport-uws.ts — aucune dépendance ajoutée). Une INSTANCE
   * MjsWsTransport maison n'est PAS représentable en JSON : elle se fournit depuis l'entry
   * (`transport: new MonTransport()`), qui prime alors sur cette clé (MÊME règle que
   * heartbeat/limits — cf. cli/ws.ts buildRunPlan). Cf. docs/23-mjs-ws.md « La façade transport ».
   */
  transport?: 'ws' | 'uws'
  port?: number
  host?: string
  /**
   * µschema (src/mjs-ws/schema.ts) — codec des trames applicatives. `'auto'` (défaut) :
   * type avec schéma déclaré (app.schema()) → binaire, reste JSON. `'binary'` : STRICT, un type
   * applicatif SANS schéma est un refus (throw à l'envoi, rejet à la réception) ; les trames de
   * contrôle µ: restent TOUJOURS JSON. `'json'` : coupe-circuit débogage, tout part en JSON même
   * schématisé. MÊME règle que transport/heartbeat/limits : définissable ICI ou dans l'entry
   * (`codec`), l'ENTRY prime EN BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan).
   */
  codec?: 'auto' | 'binary' | 'json'
  heartbeat?: number
  limits?: {
    rate?: number
    burst?: number
    kickAfter?: number
    maxPayload?: number
    maxBuffered?: number
    /** plafond GLOBAL de connexions simultanées (src/mjs-ws/core.ts
     *  MjsWsLimits) — entier > 0, ou `null` = illimité (défaut). */
    maxConnections?: number | null
    /** plafond de connexions simultanées PAR IP — entier > 0, ou
     *  `null` = illimité (défaut : 100, CHANGEMENT DE COMPORTEMENT ASSUMÉ — cf. src/mjs-ws/index.ts
     *  DEFAULT_LIMITS). */
    maxConnectionsPerIp?: number | null
    /** plafond de salons qu'un MÊME client peut avoir rejoints simultanément (
     *  src/mjs-ws/core.ts MjsWsLimits) — entier > 0, ou `null` = illimité
     *  (défaut : 50, CHANGEMENT DE COMPORTEMENT ASSUMÉ, généreux — cf. src/mjs-ws/index.ts
     *  DEFAULT_LIMITS). */
    maxRoomsPerClient?: number | null
  }
  /**
   * Pont universel (src/mjs-ws/bridge.ts) — API HTTP signée pour pousser du temps
   * réel depuis n'importe quel back (Ruby, PHP, Python…) + webhooks sortants. MÊME règle
   * que heartbeat/limits : définissable ICI ou dans l'entry (`bridge`), l'ENTRY prime EN
   * BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan). `secret` optionnel ICI — validation
   * de FORME seulement (chaîne si présent) : l'obligation réelle (« un secret DOIT exister
   * au final ») est tranchée par bridge.ts au moment où mjsWs() est réellement appelé, que
   * la valeur vienne de ce bloc ou de l'entry.
   */
  bridge?: {
    port?: number
    host?: string
    secret?: string
    webhooks?: {
      url: string
      secret?: string
      events: string[]
      timeoutMs?: number
    }
    /**
     * Limite de débit par IP (src/mjs-ws/bridge.ts) — ACTIVE PAR DÉFAUT, `false` pour
     * désactiver. `perIp` = seau général [capacité, fenêtreMs] sur toutes les routes SAUF
     * `GET /health` (défaut [120, 10000]) ; `fails` = seau plus strict sur les échecs de
     * signature, 401 (défaut [10, 60000]) — au-delà, 429 immédiat sans vérification HMAC.
     */
    rateLimit?: false | {
      perIp?: [number, number]
      fails?: [number, number]
    }
    /**
     * Nonce anti-rejeu (src/mjs-ws/bridge.ts) — défaut `false`. `true` exige un
     * en-tête `x-mjs-ws-nonce` (8-64 caractères) sur chaque requête signée, suffixé à la chaîne
     * canonique — ferme la fenêtre de rejeu ±300 s à un usage strictement unique par nonce.
     */
    nonce?: boolean
  }
  /**
   * Reprise de session (src/mjs-ws/sessions.ts) — `true` = défauts (grâce 30 s,
   * 500 trames, 256 Ko), objet = réglages fins (entiers > 0), `false` ≡ absent (désactivé).
   * MÊME règle que heartbeat/limits/bridge : définissable ICI ou dans l'entry (`resume`),
   * l'ENTRY prime EN BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan), avec un warn.
   */
  resume?: boolean | {
    grace?: number
    maxBuffered?: number
    maxBytes?: number
  }
  /**
   * Session exclusive par identité (src/mjs-ws/core.ts) — défaut
   * `false`, DEUX modes opt-in. `true` ≡ `'replace'` : un `µ:hello` FRAIS d'une identité déjà
   * connue (`identity.id`) éjecte toute AUTRE connexion de cette MÊME identité (vivante ou
   * parquée) — `µ:bye {reason:'replace'}` + fermeture code 4003. `'refuse'` (inverse) : le
   * `µ:hello` FRAIS est REFUSÉ (`µ:denied` + fermeture code 4004) si une connexion VIVANTE de
   * cette MÊME identité existe déjà — les sessions PARQUÉES seules sont purgées. Propagée aux
   * autres process si `adapter` est actif (best effort PAR PROCESS en mode 'refuse'). MÊME règle
   * que heartbeat/limits/bridge/resume/stats : définissable ICI ou dans l'entry
   * (`sessionExclusive`), l'ENTRY prime EN BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan).
   * Cf. docs/23-mjs-ws.md §8.5.
   */
  sessionExclusive?: boolean | 'replace' | 'refuse'
  /**
   * Suivi d'expiration + rafraîchissement du jeton (src/mjs-ws/core.ts) — `sweep` :
   * période du balayage global qui ferme les connexions à jeton expiré (ms, défaut 10000).
   * `slack` : tolérance d'horloge avant fermeture (ms, défaut 5000). MÊME règle que
   * heartbeat/limits : définissable ICI ou dans l'entry (`token`), l'ENTRY prime EN BLOC en
   * cas de doublon (cf. cli/ws.ts buildRunPlan). Opt-in STRICT au RUNTIME (pas un commutateur
   * ici, contrairement à `resume`) : sans échéance `exp` connue d'aucun client, aucun balayage
   * n'est jamais armé, quelle que soit cette config.
   */
  token?: {
    sweep?: number
    slack?: number
  }
  /**
   * Adaptateur multi-processus (src/mjs-ws/adapter-redis.ts) — plusieurs process
   * `mjsWs` (cluster, PM2, plusieurs machines) derrière un répartiteur, reliés par Redis.
   * `redis` obligatoire (URL `redis://[[:motDePasse]@]hôte[:port][/base]`), `prefix` optionnel
   * (défaut `'mjs-ws'`, espace de noms des canaux/clés — utile pour partager UN Redis entre
   * plusieurs applis sans collision). MÊME règle que heartbeat/limits/bridge/resume :
   * définissable ICI ou dans l'entry (`adapter`), l'ENTRY prime EN BLOC en cas de doublon
   * (cf. cli/ws.ts buildRunPlan), avec un warn.
   */
  adapter?: {
    redis: string
    prefix?: string
    /**
     * Anti-entropie de présence (cf. src/mjs-ws/adapter.ts attachPresenceAntiEntropy,
     * docs/23-mjs-ws.md « Anti-entropie de présence ») — cadence de publication de l'instantané
     * de réconciliation, ms (défaut 15000), `false` désactive. MÊME règle que redis/prefix
     * ci-dessus : définissable ICI ou dans l'entry (`adapter.antiEntropy`, ou la racine
     * `antiEntropy` de l'entry qui prime sur celui-ci, cf. MjsWsOptions), l'ENTRY prime EN BLOC
     * en cas de doublon (cf. cli/ws.ts buildRunPlan — le bloc `adapter` entier, pas clé à clé).
     */
    antiEntropy?: number | false
  }
  /**
   * État/métriques (src/mjs-ws/stats.ts) — `true` expose GET /stats, /metrics, /state
   * sur le pont (`ws.bridge` requis pour les servir en HTTP — sans pont, aucun effet observable).
   * Le registre de compteurs (`app.stats()`) tourne TOUJOURS, quelle que soit cette valeur. MÊME
   * règle que heartbeat/limits/bridge/resume/adapter : définissable ICI ou dans l'entry (`stats`),
   * l'ENTRY prime EN BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan), avec un warn.
   */
  stats?: boolean
  /**
   * Vérification d'origine (src/mjs-ws/core.ts) — absente (défaut) =
   * comportement historique STRICT, aucune connexion refusée pour son origine (opt-in). SEULE la
   * forme allowlist (tableau d'origines exactes, ex. `['https://exemple.com']`) est représentable
   * en JSON — la forme fonction n'existe QUE côté entry (`verifyOrigin: (origin, remote) => …`,
   * non représentable ici). Tableau NON VIDE de chaînes non vides exigé (cf. validateWsConfig) —
   * comparaison insensible à la casse, Origin absent ou non listé = refus. MÊME règle que
   * heartbeat/limits/bridge/resume/sessionExclusive/adapter/stats : définissable ICI ou dans
   * l'entry (`verifyOrigin`), l'ENTRY prime EN BLOC en cas de doublon (cf. cli/ws.ts buildRunPlan),
   * avec un warn. Cf. docs/23-mjs-ws.md « Vérification d'origine ».
   */
  verifyOrigin?: string[]
}

/**
 * Section `serveur` — démarrage de `mjs serveur` (cf. le JSDoc de `MjsConfig.serveur`,
 * cli/server.ts). MÊMES clés que `WsConfig` (mjsServer() accepte EXACTEMENT les mêmes
 * options que mjsWs(), cf. docs/24-mjs-server.md §9) — étendue en TYPE plutôt que dupliquée
 * en littéral (source unique de la forme partagée) — plus `antiCheat.movesPerIdentity` et
 * `antiCheat.codePerIp`, les parties de `MjsServerAntiTricheOptions` (mjs-server/index.ts)
 * représentables en JSON (un tableau `[n, fenêtreMs]` ou `null`). `persist` (mjs-server/persist.ts) n'a PAS de
 * pendant ici : ses adaptateurs exposent des FONCTIONS (`load`/`save`/`remove`), non
 * JSON-ables — reste ENTRY-ONLY, comme `schemas`/une instance `transport` maison (§6.4 doc 23).
 */
export interface ServeurConfig extends WsConfig {
  /**
   * anti-triche (mjs-server/index.ts `MjsServerAntiTricheOptions`) — quota de coups
   * PAR IDENTITÉ agrégé sur TOUTES les parties vivantes de l'app. `[n, fenêtreMs]` (entiers > 0)
   * ou `null` (aucun contrôle, défaut). MÊME règle que les clés héritées de `WsConfig` :
   * définissable ICI ou dans l'entry (`antiCheat`), l'ENTRY prime EN BLOC en cas de doublon
   * (cf. cli/server.ts buildServeurRunPlan), avec un warn.
   */
  antiCheat?: {
    movesPerIdentity?: [number, number] | null
    /** anti-brute-force sur le CODE de partie privée — `[n, fenêtreMs]` ou
     *  `null` (désactive) ; absent = défaut TOUJOURS actif de matchmaking.ts (contrairement à
     *  movesPerIdentity, opt-in). Cf. mjs-server/index.ts `MjsServerAntiTricheOptions.codePerIp`. */
    codePerIp?: [number, number] | null
  }
}

/**
 * Langages du composant — cf. le
 * JSDoc de `MjsConfig.languages` pour la sémantique complète des deux axes.
 */
export interface LanguagesConfig {
  script?: SupportedLang
  template?: 'civet' | 'js'
}

/**
 * i18n façon Rails — cf. le JSDoc de `MjsConfig.i18n` pour la sémantique
 * complète. `default` : code langue (chaîne non vide), requis dès que
 * `<sourceDir>/i18n/` existe. `placeholder` : `'auto'` (défaut) / `'key'` /
 * `'wait'`. `hash` : `'auto'` (défaut, haché en prod seulement), `true` (toujours), `false` (jamais).
 * `persist` : booléen, défaut `false` — mémorise le choix de langue EXPLICITE
 * (bascule utilisateur) via `localStorage`. `detect` : booléen, défaut
 * `false` — devine la langue au 1er chargement via `Intl`/`navigator`.
 * `urlParam` : booléen, défaut `false` — reflète la langue dans `?lang=` (écrit
 * à la bascule via `replaceState`, lu au boot EN PRIORITÉ sur persist/detect :
 * recharger `?lang=en` repart en anglais). Langue par défaut = `?lang=` retiré.
 * `source` : code langue, FACULTATIF — active le contrôle d'empreinte des traductions.
 */
export interface I18nConfig {
  default?: string
  placeholder?: 'auto' | 'key' | 'wait'
  /** `'auto'` (défaut) : fragments hachés en production, noms clairs en développement.
   *  `true` : hachés TOUJOURS (un site servi localement garde alors un cache honnête).
   *  `false` : jamais. */
  hash?: boolean | 'auto'
  persist?: boolean
  detect?: boolean
  urlParam?: boolean
  source?: string
}

/** Journal d'erreurs 3 étages — cf. le JSDoc de `MjsConfig.journal` pour la sémantique. */
export interface JournalConfig {
  server?: boolean
  client?: boolean
  viewer?: boolean | string
  maxEntries?: number
  maxBytes?: number
}

/**
 * Mode de rendu d'une PAGE (vraie URL, niveau 1). `csr` = monté au client
 * (rétro-compatible), `prerender` = HTML figé au `mjs build`, `ssr[:x]` = rendu
 * serveur par requête (serveur opt-in). `ssr` seul ≡ `ssr:replace` ;
 * les 4 variantes sont des stratégies d'hydratation (cf. RenderOptions.ssrMode).
 */
export type RenderMode =
  | 'csr' | 'prerender'
  | 'ssr' | 'ssr:replace' | 'ssr:markers' | 'ssr:positional' | 'ssr:diff'

/**
 * Moteur d'exécution du rendu HTML. `'browser'` = vrai navigateur headless
 * (Playwright), fidélité maximale (CSS/JS complets) ; `'happy-dom'` = DOM simulé
 * en pur JS, plus léger, sans dépendance binaire. Deux points d'usage
 * INDÉPENDANTS (cf. `RenderEngineConfig`) : le prérendu (build) et le SSR par
 * requête (serveur) n'ont pas forcément le même besoin de fidélité.
 */
export type RenderEngine = 'browser' | 'happy-dom'

/**
 * Ce que le HTML FIGÉ d'une page prérendue dit au navigateur de charger, AVANT que le manifeste
 * (`bundle_modular.js`) n'ait été téléchargé puis exécuté — lui seul sait sinon quels composants la
 * page affiche, et ils ne partent qu'après lui. Le fragment prérendu, lui, le sait dès sa
 * construction. Ne concerne QUE les routes prérendues (`prerender`) : le HTML figé est la source de
 * vérité.
 *   · `'preload'` (défaut) — le fragment porte un `<link rel="modulepreload">` par unité de son
 *     ensemble de démarrage (composants ET modules). Un fichier par composant, `µ.paths` intact.
 *   · `'bundle'` — en PLUS, une construction de PRODUCTION assemble les COMPOSANTS de la page en un
 *     fichier `mjs_page-<slug>-<empreinte>.js` (cœur, feuilles, animations, fichiers de langue et
 *     MODULES exclus : un module doit rester une instance unique). Le fragment porte alors un lien
 *     vers ce fichier + un lien par module, et la fiche `__mjs_page` que le manifeste relit pour
 *     repointer `µ.paths`. En développement, se comporte comme `'preload'`.
 *   · `'none'` — aucun en-tête, la balise racine et son HTML prérendu seuls.
 */
export type RenderStartupMode = 'preload' | 'bundle' | 'none'

/**
 * Moteur de rendu, sur deux AXES indépendants — `prerender` (build + recompiles
 * dev) et `request` (SSR par requête, serveur opt-in). Sous-clés optionnelles.
 * Défauts NON appliqués ici (`undefined` si absent) : résolus au point de
 * consommation — `prerender` → `'browser'` si Playwright
 * est résolvable, sinon repli `'happy-dom'` (avec message informatif) ;
 * `request` → `'happy-dom'`.
 */
export interface RenderEngineConfig {
  prerender?: RenderEngine
  request?: RenderEngine
}

/**
 * Pool d'instances navigateur (moteur `'browser'`), réutilisées entre rendus
 * plutôt que relancées à chaque fois. Défauts NON appliqués ici, résolus au
 * point de consommation : `size` 2, `keepAlive` true,
 * `maxAgeMs` 300000 (5 min).
 */
export interface RenderBrowserPoolConfig {
  /** Nombre d'instances maintenues en pool. Entier ≥ 1. */
  size?: number
  /** Garder les instances vivantes entre rendus (vs relancées à chaque fois). */
  keepAlive?: boolean
  /** Âge maximum d'une instance avant recyclage, en ms. Entier ≥ 0. */
  maxAgeMs?: number
  /**
   * Garde-fou — plafond global sur UN rendu
   * (`renderPage`), en ms. Sans lui, un `@mount` qui pend (ou un fetch
   * `render.forwardOrigin` proxifié qui ne répond jamais) retenait le slot de
   * pool INDÉFINIMENT (`page.evaluate` de montage et le `fetch()` proxifié
   * n'étaient bornés par AUCUN timeout, contrairement à `page.goto`/
   * `waitForFunction`) — `poolSize` requêtes qui pendent épuisent tout le
   * pool (déni de service du SSR). Défaut résolu au point de consommation :
   * 15000 (15s). Entier > 0.
   */
  renderTimeoutMs?: number
}

/**
 * Plafond de CONCURRENCE sur le rendu SSR/browser PAR REQUÊTE (cf.
 * RenderGate, render-request.ts) : lu en souple, défauts 4/32 résolus au point de
 * consommation (pas ici).
 */
export interface RenderQueueConfig {
  /** Rendus simultanés au maximum. Entier ≥ 1. Défaut résolu au point de consommation : 4. */
  concurrency?: number
  /** Requêtes en attente au maximum derrière `concurrency` (au-delà : 503 + Retry-After). Entier
   *  ≥ 0 (0 = aucune attente, refus immédiat dès `concurrency` atteint). Défaut : 32. */
  maxQueue?: number
}

/** Une PAGE = une vraie URL → le composant qui la rend + son mode. */
export interface RenderRoute {
  /** Nom du composant-page (ex. 'mjs-blog'), sans les chevrons. */
  component: string
  /** Mode de cette page ; hérite de `render.default` si absent. */
  mode?: RenderMode
  /** Délai (ms) laissé au rendu pour se stabiliser avant capture du HTML : entier
   *  > 0. Surcharge par route ; défaut appliqué au point de consommation, pas ici. */
  settleMs?: number
  /** Moteur de rendu pour CETTE route, surcharge `render.engine`. Défaut appliqué
   *  au point de consommation, pas ici. */
  engine?: RenderEngine
  /** Ce que le fragment de CETTE page dit de charger au démarrage, surcharge
   *  `render.startup` (cf. `RenderStartupMode`). Défaut appliqué au point de
   *  consommation, pas ici. */
  startup?: RenderStartupMode
  /** Racine montée en MODE LÉGER (`mjs-light` : aucun Shadow DOM, le contenu vit
   *  dans la page). À poser quand la coquille monte déjà `<mjs-x mjs-light>` : le
   *  fragment prérendu décrit alors le MÊME arbre que celui que le client rebâtit.
   *  Défaut `false` (racine à Shadow DOM déclaratif). */
  light?: boolean
}

/**
 * Rendu déclaratif : le dev mappe des URLs de PAGE → composant + mode, jamais de
 * code de rendu. La navigation in-app `#/…` (niveau 2) reste 100% client (routeur
 * hash inchangé). Prérendu au build (sans runtime) ; SSR par requête = serveur opt-in.
 */
export interface RenderConfig {
  /** Module serveur `mjs serve` (props/actions, cf. src/server/serve-entry.ts) — défauts serve.server.mjs puis server/serve.server.mjs. */
  entry?: string
  /** Mode par défaut d'une page sans `mode`. Défaut appliqué : 'prerender'. */
  default?: RenderMode
  /** Ce que le HTML figé des pages prérendues dit de charger au démarrage (cf.
   *  `RenderStartupMode`), surchargeable par route. Défaut appliqué au point de
   *  consommation : 'preload'. */
  startup?: RenderStartupMode
  /** Header HTTP qui surcharge le mode par requête. Ex. 'X-MJS-Render'. */
  header?: string
  /** Dossier de sortie des pages prérendues. Défaut : `<outputDir>/../mjs_pages`. */
  outDir?: string
  /** Table des PAGES : motif d'URL (`/`, `/blog`, `/produit/:id`) → composant + mode. */
  routes?: Record<string, RenderRoute>
  /**
   * Langues à prérendre (prérendu multi-langue). Absente ou < 2 entrées :
   * comportement mono-langue inchangé (une sortie plate `outDir/<page>`).
   * ≥ 2 entrées : une passe complète par langue, écrite dans `outDir/<langue>/<page>`,
   * chaque langue alimentant `store.__mjsLang` du rendu (cf. i18n).
   */
  locales?: string[]
  /** Moteur de rendu (axes prérendu/requête). Défauts résolus au point de
   *  consommation, pas ici. */
  engine?: RenderEngineConfig
  /** Pool de navigateurs (moteur `'browser'`). Défauts résolus au point de
   *  consommation, pas ici. */
  browserPool?: RenderBrowserPoolConfig
  /** Plafond de concurrence/file d'attente sur le rendu SSR par requête (cf. RenderGate,
   *  render-request.ts). Défauts résolus au point de consommation, pas ici : 4/32. */
  renderQueue?: RenderQueueConfig
  /**
   * Transmet origine + cookies de la requête
   * entrante au moteur de rendu (SSR par requête). JAMAIS dérivé du Host client
   * sans autorisation EXPLICITE ici (cf. src/server/forward-origin.ts pour la
   * résolution + la défense en profondeur `isBlockedForwardTarget`) :
   *   - `false` : désactivé, jamais de forwarding.
   *   - `string` : ORIGINE FIXE imposée par le dev (ex. `'https://back.exemple.com'`)
   *     — toujours cette valeur, jamais le Host du client.
   *   - `{ trustedHosts: string[] }` : ALLOWLIST — seul un Host entrant qui y
   *     figure EXACTEMENT autorise le forwarding (vers ce Host).
   *   - absent, ou `true` : DÉFAUT SÛR (résolu au point de consommation, pas
   *     ici) — `true` n'AUTORISE aucun Host, aucune dérivation ; repli sur
   *     l'origine locale des moteurs de rendu. Même une IP privée/loopback/
   *     lien-local EXPLICITEMENT autorisée (string ou trustedHosts) reste
   *     refusée (défense en profondeur, cf. isBlockedForwardTarget).
   */
  forwardOrigin?: boolean | string | { trustedHosts: string[] }
  /** Liste blanche d'origines autorisées à POSTer, ex. `["https://admin.example"]` ; le joker `["*"]` accepte TOUTE origine (`false` fait la même chose, en coupant le contrôle) ; absent = same-origin strict (défaut). Un `*` collé à autre chose (`"*.exemple.fr"`) n'est pas un motif : il ne matchera jamais. */
  allowedOrigins?: string[] | false
  /** Sélecteur CSS du contenant que les navigations remplacent. Absent : `<body>`. */
  target?: string
  /** Comment le module s'installe dans `target` : `update` = le contenant est vidé puis reçoit le contenu, il survit · `replace` = le contenu prend la PLACE du contenant, qui disparaît · `append` = le contenu est ajouté à la SUITE, rien n'est retiré. Défaut `update`. Sans `target`, `replace` est dégradé en `update` côté client. */
  method?: 'update' | 'replace' | 'append'
  /** Politique de cache de PAGE côté client (µ.pageCache) pour les pages qui n'en déclarent pas la leur (fiche JSON `cache` / en-tête `X-MJS-Cache` / balise `<meta name="mjs-cache">`) : `cache-first` = la page hiberne normalement (défaut) · `revalidate` = affichée depuis le cache puis vérifiée en fond, remplacée seulement si la réponse diffère · `no-cache` = jamais archivée, un retour arrière re-demande la page. */
  cache?: 'cache-first' | 'revalidate' | 'no-cache'
}

/**
 * Cherche `mjs.config.json` à partir de `startDir` en remontant jusqu'à la
 * racine. Retourne `null` si introuvable. Sinon retourne `{ config, configDir }`
 * où `configDir` est utilisé pour résoudre les paths relatifs.
 */
// `urlPrefix` est un champ DOCUMENTÉ de
// `MjsConfig` (cf. son JSDoc plus haut) mais absent d'ici : tout
// mjs.config.json qui le renseigne faisait PLANTER le build entier avec
// « clé inconnue 'urlPrefix' », alors que c'est une option légitime et
// documentée — le schéma et son propre validateur étaient désynchronisés.
const KNOWN_KEYS = new Set([
  'sourceDir', 'outputDir', 'manifestPath', 'manifestExternal', 'urlPrefix',
  'defaultScriptLang', 'languages', 'minify', 'dev',
  'stylesheetsDir', 'runtimeDir', 'sigil', 'contextAlias', 'render', 'preload', 'viewTransition', 'lint', 'logLevel', 'runtime', 'css', 'js', 'ws', 'serveur', 'i18n', 'lang', 'journal',
  'varPrefix', 'defaultTheme', 'image', 'csp', 'sourceMap', 'prune',
])
const KNOWN_IMAGE_KEYS = new Set(['widths', 'formats', 'quality'])
const VALID_IMAGE_FORMATS = new Set(['avif', 'webp', 'jpeg', 'png'])
// un préfixe de variable finit en `--<prefix>-nom` : pas d'espace, pas de tiret aux bouts
const VAR_PREFIX_RE = /^[a-z][a-z0-9-]*$/
const KNOWN_DEV_KEYS = new Set(['port', 'host'])
const VALID_LANGS = new Set(['civet', 'coffee', 'ts', 'js'])
const VALID_SIGILS = new Set(['µ', 'mjs'])
const VALID_CSS_MODES = new Set(['bundle', 'split', 'lazy'])
const VALID_JS_MODES = new Set(['split', 'bundle'])
const VALID_SOURCE_MAP_MODES = new Set(['never', 'dev', 'prod', 'always'])
const KNOWN_RENDER_KEYS = new Set(['default', 'header', 'outDir', 'routes', 'locales', 'engine', 'browserPool', 'renderQueue', 'forwardOrigin', 'entry', 'allowedOrigins', 'target', 'method', 'cache', 'startup'])
const VALID_RENDER_MODES = new Set([
  'csr', 'prerender', 'ssr', 'ssr:replace', 'ssr:markers', 'ssr:positional', 'ssr:diff',
])
const VALID_RENDER_METHODS = new Set(['update', 'replace', 'append'])
const VALID_RENDER_CACHE_POLICIES = new Set(['cache-first', 'revalidate', 'no-cache'])
const KNOWN_RENDER_ENGINE_KEYS = new Set(['prerender', 'request'])
const VALID_RENDER_ENGINES = new Set(['browser', 'happy-dom'])
const VALID_STARTUP_MODES = new Set(['preload', 'bundle', 'none'])
const KNOWN_BROWSER_POOL_KEYS = new Set(['size', 'keepAlive', 'maxAgeMs', 'renderTimeoutMs'])
const KNOWN_RENDER_QUEUE_KEYS = new Set(['concurrency', 'maxQueue'])
const KNOWN_ROUTE_KEYS = new Set(['component', 'mode', 'settleMs', 'engine', 'startup', 'light'])
const KNOWN_PRELOAD_KEYS = new Set(['view', 'page'])
const VALID_PRELOAD_MODES = new Set(['off', 'hover', 'on'])
const KNOWN_LINT_KEYS = new Set(['maxStateVars', 'a11y', 'ujsForm'])
const VALID_LOG_LEVELS = new Set<LogLevelName>(['log', 'warn', 'error', 'silent'])
const KNOWN_LOG_LEVEL_KEYS = new Set(['dev', 'prod'])
const KNOWN_LANGUAGES_KEYS = new Set(['script', 'template'])
const VALID_TEMPLATE_LANGS = new Set(['civet', 'js'])
const KNOWN_I18N_KEYS = new Set(['default', 'placeholder', 'hash', 'persist', 'detect', 'urlParam', 'source'])
const VALID_I18N_PLACEHOLDERS = new Set(['auto', 'key', 'wait'])
const KNOWN_JOURNAL_KEYS = new Set(['server', 'client', 'viewer', 'maxEntries', 'maxBytes'])
const KNOWN_WS_KEYS = new Set(['entry', 'transport', 'port', 'host', 'codec', 'heartbeat', 'limits', 'token', 'bridge', 'resume', 'adapter', 'stats', 'sessionExclusive', 'verifyOrigin'])
// section `serveur` (mjs serveur, cli/server.ts) — MÊMES clés que KNOWN_WS_KEYS (mjsServer()
// accepte exactement les mêmes options que mjsWs()) + `antiCheat` (entièrement propre
// à MJS-Server, cf. `ServeurConfig`). `persist` volontairement ABSENT (adaptateurs à fonctions,
// non JSON-ables — reste ENTRY-ONLY, cf. le JSDoc de `ServeurConfig`).
const KNOWN_SERVEUR_KEYS = new Set([...KNOWN_WS_KEYS, 'antiCheat'])
const KNOWN_SERVEUR_ANTITRICHE_KEYS = new Set(['movesPerIdentity', 'codePerIp'])
const VALID_WS_TRANSPORTS = new Set(['ws', 'uws'])
const VALID_WS_CODECS = new Set(['auto', 'binary', 'json'])
// session exclusive par identité (sessionExclusive — 2 modes) — les 2 formes CHAÎNE
// valides ; le booléen `true`/`false` reste valide EN PLUS (cf. validateWsConfig plus bas), pas
// représenté ici (ce Set ne sert qu'à la branche chaîne + la suggestion orthographique).
const VALID_SESSION_EXCLUSIVE = new Set(['replace', 'refuse'])
const KNOWN_WS_LIMITS_KEYS = new Set(['rate', 'burst', 'kickAfter', 'maxPayload', 'maxBuffered', 'maxConnections', 'maxConnectionsPerIp', 'maxRoomsPerClient'])
// plafonds de connexions/salons — SEULES clés de ws.limits qui acceptent
// `null` (illimité) EN PLUS d'un entier > 0 ; toutes les autres (rate/burst/kickAfter/maxPayload/
// maxBuffered) restent strictement des entiers > 0, jamais null — cf. la boucle de validation plus bas.
const NULLABLE_WS_LIMITS_KEYS = new Set(['maxConnections', 'maxConnectionsPerIp', 'maxRoomsPerClient'])
const KNOWN_WS_TOKEN_KEYS = new Set(['sweep', 'slack'])
const KNOWN_WS_BRIDGE_KEYS = new Set(['port', 'host', 'secret', 'webhooks', 'rateLimit', 'nonce'])
const KNOWN_WS_BRIDGE_WEBHOOKS_KEYS = new Set(['url', 'secret', 'events', 'timeoutMs'])
const KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS = new Set(['perIp', 'fails'])
const KNOWN_WS_RESUME_KEYS = new Set(['grace', 'maxBuffered', 'maxBytes'])
const KNOWN_WS_ADAPTER_KEYS = new Set(['redis', 'prefix', 'antiEntropy'])

/**
 * Normalise `urlPrefix` (pathPrefix de `mjs dev`,
 * `mjs serve`, et préfixe composé DANS chaque URL d'asset émise par le Bundler,
 * `${urlPrefix}/${fichier}`) : un slash final non retiré (`'/app/'`) produisait `'/app//fichier'`
 * partout où ce préfixe compose une URL — plus aucun asset servi. Retire les slashs finaux ;
 * `'/'` seul (racine pure) se ramène à la chaîne vide (aucun segment de préfixe à matcher, les
 * assets se servent alors à la racine). Le slash INITIAL n'est pas ajouté ici (silencieux) : un
 * préfixe qui n'en a pas est un chemin ambigu, refusé explicitement par `validateConfig`
 * ci-dessous — cette fonction reste appelée aussi, défensivement, là où `urlPrefix` peut arriver
 * SANS être passé par cette validation (`StaticServer`, cf. server/index.ts).
 *
 * Les slashs répétés se réduisent à un seul
 * PARTOUT dans le préfixe (INITIAUX compris), pas seulement en fin de chaîne : `'//app'` COMMENCE
 * bien par `'/'` (validateConfig ne vérifiait QUE ce test) et traversait tel quel — chaque URL
 * d'asset composée en `${urlPrefix}/${fichier}` devenait `'//app/fichier'`, une URL
 * PROTOCOL-RELATIVE côté navigateur (pointe vers l'hôte 'app', pas un chemin du même site).
 */
export function normalizeUrlPrefix(prefix: string): string {
  return prefix.replace(/\/{2,}/g, '/').replace(/\/+$/, '')
}

/**
 * Valide la shape du config et lève si une clé inconnue / invalide est trouvée.
 */
function validateConfig(config: any, path: string): void {
  if (typeof config !== 'object' || config === null) {
    throw new Error(t('bundler.config.doit-etre-objet-racine', { chemin: path }))
  }
  // `env` a existé un jour comme clé de config : un projet qui la porte encore doit
  // apprendre où ce choix vit maintenant, pas se prendre un « clé inconnue » opaque
  if (config.env !== undefined) {
    throw new Error(t('bundler.config.env-vient-de-la-commande', { chemin: path }))
  }
  for (const k of Object.keys(config)) {
    if (!KNOWN_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue-racine', { cle: k, chemin: path, valides: Array.from(KNOWN_KEYS).join(', ') }))
    }
  }
  // gardes `!== undefined` (pas
  // falsy) : `defaultScriptLang: ""` / `sigil: ""` (chaîne vide, falsy)
  // contournaient le check puis `opts.sigil ?? 'µ'` conservait la chaîne vide.
  if (config.defaultScriptLang !== undefined && !VALID_LANGS.has(config.defaultScriptLang)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'defaultScriptLang', valeur: config.defaultScriptLang, valides: Array.from(VALID_LANGS).join(', ') }))
  }
  if (config.sigil !== undefined && !VALID_SIGILS.has(config.sigil)) {
    throw new Error(t('bundler.config.sigil-invalide', { valeur: config.sigil, valides: Array.from(VALID_SIGILS).join(', ') }))
  }
  // la validation « stricte » ne
  // typait PAS la moitié des clés : `sourceDir: 42` explosait plus tard dans
  // `resolve()` avec une erreur Node brute sans nommer la clé, `urlPrefix: 42`
  // passait, `contextAlias: "false"` (string) devenait TRUTHY (l'inverse exact
  // du piège `minify: "true"`). On exige le bon type, message clair et immédiat.
  // `varPrefix` et `defaultTheme` finissent tous deux en sélecteur ou en nom de custom
  // property : un espace ou une majuscule y produirait un CSS silencieusement mort
  for (const k of ['varPrefix', 'defaultTheme'] as const) {
    if (config[k] !== undefined && !VAR_PREFIX_RE.test(String(config[k]))) {
      throw new Error(t('bundler.config.valeur-invalide-simple', { cle: k, valeur: String(config[k]), valides: 'minuscules, chiffres et tirets (ex. mjs, app, light)' }))
    }
  }
  const STRING_KEYS = [
    'sourceDir', 'outputDir', 'manifestPath', 'manifestExternal',
    'stylesheetsDir', 'runtimeDir', 'urlPrefix',
  ] as const
  for (const k of STRING_KEYS) {
    if (config[k] !== undefined && typeof config[k] !== 'string') {
      throw new Error(t('bundler.config.doit-etre-chaine', { cle: k, valeur: JSON.stringify(config[k]), type: typeof config[k] }))
    }
  }
  // `urlPrefix` n'était vérifié que pour son TYPE
  // (chaîne) ci-dessus, jamais pour sa FORME : un slash final (`'/app/'`) survivait tel quel
  // jusqu'au Bundler, qui compose CHAQUE URL d'asset en `${urlPrefix}/${fichier}` → `'/app//x'`,
  // plus aucun asset servi. Slash initial EXIGÉ (chemin sinon ambigu, jamais silencieusement
  // corrigé) ; slashs finaux retirés — mutation en place : TOUT consommateur qui lit
  // `config.urlPrefix` après cette validation (resolveBundlerOpts, cli.ts, render-server.ts)
  // reçoit la forme déjà propre, sans avoir à répéter la normalisation.
  if (config.urlPrefix !== undefined) {
    const normalized = normalizeUrlPrefix(config.urlPrefix)
    if (normalized !== '' && !normalized.startsWith('/')) {
      throw new Error(t('bundler.config.urlprefix-slash-initial-exige', { valeur: JSON.stringify(config.urlPrefix) }))
    }
    config.urlPrefix = normalized
  }
  if (config.contextAlias !== undefined && typeof config.contextAlias !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'contextAlias', valeur: JSON.stringify(config.contextAlias), type: typeof config.contextAlias }))
  }
  if (config.csp !== undefined && typeof config.csp !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'csp', valeur: JSON.stringify(config.csp), type: typeof config.csp }))
  }
  if (config.prune !== undefined && typeof config.prune !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'prune', valeur: JSON.stringify(config.prune), type: typeof config.prune }))
  }
  if (config.sourceMap !== undefined && (typeof config.sourceMap !== 'string' || !VALID_SOURCE_MAP_MODES.has(config.sourceMap))) {
    throw new Error(t('bundler.config.source-map-mode-invalide', { valeur: JSON.stringify(config.sourceMap), valides: Array.from(VALID_SOURCE_MAP_MODES).join(', ') }))
  }
  if (config.js !== undefined) validateJsConfig(config.js, path)
  // Impasse DIRECTE, ÉVALUÉE AVANT les deux checks css ci-dessous : `csp: true` exige un CSS
  // DÉCOUPÉ (`split`/`lazy`, cf. juste en dessous) tandis que `js: 'bundle'` exige un CSS
  // FUSIONNÉ (`bundle`, cf. plus bas) — aucune valeur de `css` ne peut jamais satisfaire les
  // deux à la fois. Sans ce garde-fou DÉDIÉ, les deux checks génériques se contredisent l'un
  // l'autre selon la valeur de `css` fournie (« posez css: split » puis, une fois posé,
  // « retirez css » ou « posez js: split ») — l'auteur du config tourne en rond sans jamais
  // trouver de combinaison valide.
  if (config.csp === true && config.js === 'bundle') {
    throw new Error(t('bundler.config.csp-incompatible-js-bundle'))
  }
  // `csp: true` supprime les `<style>` en ligne du rendu serveur en les remplaçant par des
  // `<link>` vers les feuilles émises — feuilles qui n'existent QUE si le CSS est découpé
  if (config.csp === true && (config.css ?? 'bundle') === 'bundle') {
    throw new Error(t('bundler.config.csp-exige-css-decoupe'))
  }
  // `js: 'bundle'` fusionne composants+modules+cœur dans le manifeste — un CSS déjà
  // DÉCOUPÉ en fichiers séparés (`split`/`lazy`) contredirait « un seul fichier JS » : seul
  // `css: 'bundle'` (défaut) reste compatible, même angle que csp ci-dessus.
  if (config.js === 'bundle' && (config.css ?? 'bundle') !== 'bundle') {
    throw new Error(t('bundler.config.js-bundle-exige-css-bundle'))
  }
  // `minify` n'était validé QUE pour la
  // présence de clés inconnues au niveau racine, jamais pour son propre TYPE :
  // `"minify": "true"` (string JSON, faute de frappe fréquente — oublier que
  // JSON n'a pas de coercition automatique) passait la validation sans
  // erreur, puis `resolveBundlerOpts` fait `config.minify === true` →
  // `"true" === true` vaut `false` → forceMinify silencieusement DÉSACTIVÉ,
  // l'inverse exact de l'intention, sans le moindre avertissement.
  //
  // `minify` accepte aussi `'auto'` (le défaut : on suit `env`). Tout le reste
  // (`"true"`, `'prod'`, un nombre…) reste refusé immédiatement, même motif qu'au-dessus.
  if (config.minify !== undefined && typeof config.minify !== 'boolean' && config.minify !== 'auto') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'minify', valeur: JSON.stringify(config.minify), type: typeof config.minify }))
  }
  // un `dev` NON-objet (ex.
  // `dev: "3939"`) faisait sauter EN SILENCE toute la validation du bloc
  // (`typeof "3939" === 'object'` faux → skip). On exige un objet non-array.
  if (config.dev !== undefined) {
    if (typeof config.dev !== 'object' || config.dev === null || Array.isArray(config.dev)) {
      throw new Error(t('bundler.config.dev-doit-etre-objet', { chemin: path }))
    }
    for (const k of Object.keys(config.dev)) {
      if (!KNOWN_DEV_KEYS.has(k)) {
        throw new Error(t('bundler.config.dev-cle-inconnue', { cle: k }))
      }
    }
    // même angle mort que `minify` :
    // `dev.port: "abc"` passait la validation (seule la présence de la clé
    // était vérifiée) puis se propageait tel quel jusqu'à
    // `StaticServer.listen(port)` — échec tardif et confus au démarrage du
    // serveur dev plutôt qu'une erreur de config claire et immédiate.
    if (config.dev.port !== undefined) {
      if (typeof config.dev.port !== 'number' || !Number.isFinite(config.dev.port)) {
        throw new Error(t('bundler.config.dev-port-doit-etre-nombre', { valeur: JSON.stringify(config.dev.port), type: typeof config.dev.port }))
      }
      // `dev.port: 99999` (hors
      // plage TCP) et `3939.5` (non entier) passaient. Un port valide est un
      // entier 1-65535.
      if (!Number.isInteger(config.dev.port) || config.dev.port < 1 || config.dev.port > 65535) {
        throw new Error(t('bundler.config.port-hors-plage', { cle: 'dev.port', valeur: JSON.stringify(config.dev.port) }))
      }
    }
    if (config.dev.host !== undefined && typeof config.dev.host !== 'string') {
      throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'dev.host', valeur: JSON.stringify(config.dev.host), type: typeof config.dev.host }))
    }
  }
  if (config.render !== undefined) {
    validateRenderConfig(config.render, path)
    // `js: 'bundle'` fusionne DÉJÀ tout le projet dans un fichier unique : un fichier de page en
    // plus n'aurait rien à assembler et dupliquerait des composants déjà livrés. Les deux clés sont
    // légitimes séparément, jamais ensemble — refusé ici (seul point où les deux sont en portée)
    // plutôt que silencieusement ignoré au build.
    if (config.js === 'bundle') {
      const routes: Record<string, RenderRoute> = config.render.routes ?? {}
      const pageDemandes = [config.render.startup, ...Object.values(routes).map(r => r?.startup)]
      if (pageDemandes.includes('bundle')) {
        throw new Error(t('bundler.config.startup-bundle-avec-js-bundle'))
      }
    }
  }
  if (config.preload !== undefined) {
    validatePreloadConfig(config.preload, path)
  }
  if (config.viewTransition !== undefined) {
    const vt = config.viewTransition
    const genericError = () => new Error(t('bundler.config.view-transition-invalide-generique', {
      valeur: vt, bases: VT_PRESET_BASES.join(', '), basesDir: VT_DIRECTIONAL_BASES.join(', '),
    }))
    if (typeof vt !== 'string') throw genericError()
    if (vt !== 'none') {
      // accepte la syntaxe OBJET `"base={ direction: …, duration: …, priority: … }"`
      // (même mini-grammaire que la directive/l'attribut, cf. `parseVtValue`) ; le
      // suffixe `base:direction` est REJETÉ par `parseVtValue` elle-même (message dédié).
      const parsed = parseVtValue(vt)
      // Cast explicite : `strictNullChecks: false` (tsconfig du projet) désactive le
      // control-flow narrowing natif des unions discriminées (`if (!parsed.ok)` ne
      // suffit pas à écarter la branche `{ok:true}` sans strictNullChecks).
      if (!parsed.ok) {
        throw new Error(t('bundler.config.view-transition-invalide-detail', { valeur: vt, erreur: (parsed as { ok: false; error: string }).error }))
      }
      // Le NOM (hors options) doit appartenir à la bibliothèque connue — la config
      // reste STRICTE là où le compilateur (directive/attribut) reste tolérant
      // (asymétrie historique délibérée, cf. le commentaire de `parseVtValue`).
      const nameOnly = parsed.value.dir ? `${parsed.value.base}:${parsed.value.dir}` : parsed.value.base
      if (!isVtPresetValue(nameOnly)) throw genericError()
    }
  }
  if (config.lint !== undefined) {
    validateLintConfig(config.lint, path)
  }
  if (config.logLevel !== undefined) {
    validateLogLevelConfig(config.logLevel, path)
  }
  if (config.runtime !== undefined) {
    validateRuntimeConfig(config.runtime, path)
  }
  if (config.image !== undefined) {
    validateImageConfig(config.image, path)
  }
  if (config.css !== undefined) {
    validateCssConfig(config.css, path)
  }
  if (config.ws !== undefined) {
    validateWsConfig(config.ws, path)
  }
  if (config.serveur !== undefined) {
    validateServeurConfig(config.serveur, path)
  }
  if (config.languages !== undefined) {
    validateLanguagesConfig(config.languages, path)
  }
  if (config.i18n !== undefined) {
    validateI18nConfig(config.i18n, path)
  }
  if (config.journal !== undefined) {
    validateJournalConfig(config.journal, path)
  }
  // Rétrocompat `defaultScriptLang` / `languages.script` : les DEUX ne sont
  // acceptées ensemble que si ÉGALES — sinon laquelle prime serait ambigu.
  // (Valeurs invalides déjà écartées plus haut par leurs checks respectifs.)
  if (
    config.defaultScriptLang !== undefined &&
    config.languages?.script !== undefined &&
    config.defaultScriptLang !== config.languages.script
  ) {
    throw new Error(t('bundler.config.default-script-lang-conflit', { a: config.defaultScriptLang, b: config.languages.script }))
  }
}

/**
 * Valide le param `runtime` (sélection des modules du bundle core). Accepte
 * `'all'` / `'core'`, ou un tableau de modules OPTIONNELS valides — les entrées
 * qui sont un nom de préréglage (`RUNTIME_PRESETS`, ex. `'mjs-server'`) sont
 * DÉPLIÉES en leurs modules AVANT cette validation stricte (cf.
 * `expandRuntimePresets`) ; les avertissements qu'elle renvoie (préréglage
 * RÉSERVÉ — aucun actuellement dans la table, cf. son commentaire) sont
 * imprimés ICI (seul point d'impression — évite le double avertissement, cf.
 * le commentaire de `expandRuntimePresets`). Strict
 * comme le reste : valeur/nom inconnu (préréglage OU module) = échec immédiat
 * et explicite, jamais un module retiré en silence sur une faute de frappe.
 * Refuse aussi un nom de module CŒUR (toujours inclus) pour éviter la fausse
 * impression de pouvoir le retirer.
 */
function validateRuntimeConfig(runtime: any, path: string): void {
  if (typeof runtime === 'string') {
    if (runtime !== 'all' && runtime !== 'core') {
      throw new Error(t('bundler.config.runtime-invalide-chaine', { valeur: runtime, modules: OPTIONAL_RUNTIME_MODULES.join(', ') }))
    }
    return
  }
  if (!Array.isArray(runtime)) {
    throw new Error(t('bundler.config.runtime-doit-etre-tableau', { valeur: JSON.stringify(runtime), type: typeof runtime, chemin: path }))
  }
  for (const m of runtime) {
    if (typeof m !== 'string') {
      throw new Error(t('bundler.config.runtime-module-doit-etre-chaine', { valeur: JSON.stringify(m), type: typeof m }))
    }
  }
  // 'autoloader' n'y figure plus : il n'est du cœur qu'en `js: 'split'` et se demande
  // explicitement en `js: 'bundle'` — accepté juste en dessous, avec les DETECTED_CORE_MODULES.
  const CORE = new Set(['init', 'runes', 'element'])
  const { modules: expanded, warnings } = expandRuntimePresets(runtime as string[])
  for (const w of warnings) console.warn(w)
  for (const m of expanded) {
    // 'title'/'vt_presets' : ni CŒUR strict ni optionnel classique, cf.
    // DETECTED_CORE_MODULES — acceptés ICI avant les deux autres checks, une faute de frappe
    // (ex. 'titre') reste refusée par le check 'inconnu' juste en dessous.
    if ((DETECTED_CORE_MODULES as readonly string[]).includes(m)) continue
    if (CORE.has(m)) {
      throw new Error(t('bundler.config.runtime-module-core', { module: m, modules: OPTIONAL_RUNTIME_MODULES.join(', ') }))
    }
    if (!(OPTIONAL_RUNTIME_MODULES as readonly string[]).includes(m)) {
      throw new Error(t('bundler.config.runtime-module-inconnu', { module: m, modules: OPTIONAL_RUNTIME_MODULES.join(', '), presets: Object.keys(RUNTIME_PRESETS).join(', ') }))
    }
  }
}

/**
 * Valide le bloc `preload`. Accepte une chaîne (`"off"|"hover"|"on"`) ou un
 * objet `{ view?, page? }` dont chaque axe est un de ces modes.
 */
function validatePreloadConfig(preload: any, path: string): void {
  if (typeof preload === 'string') {
    if (!VALID_PRELOAD_MODES.has(preload)) {
      throw new Error(t('bundler.config.preload-invalide', { valeur: preload, valides: Array.from(VALID_PRELOAD_MODES).join(', ') }))
    }
    return
  }
  if (typeof preload !== 'object' || preload === null || Array.isArray(preload)) {
    throw new Error(t('bundler.config.preload-doit-etre-objet', { chemin: path }))
  }
  // anciens axes `local`/`server` renommés `view`/`page` : détection
  // CIBLÉE (message dédié, plus clair que le « clé inconnue » générique
  // ci-dessous) si l'une OU l'autre ancienne clé traîne encore.
  if ('local' in preload || 'server' in preload) {
    throw new Error(t('bundler.config.preload-axes-renommes'))
  }
  for (const k of Object.keys(preload)) {
    if (!KNOWN_PRELOAD_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `preload.${k}`, valides: Array.from(KNOWN_PRELOAD_KEYS).join(', ') }))
    }
  }
  for (const axis of ['view', 'page'] as const) {
    if (preload[axis] !== undefined && !VALID_PRELOAD_MODES.has(preload[axis])) {
      throw new Error(t('bundler.config.preload-axis-invalide', { axe: axis, valeur: preload[axis], valides: Array.from(VALID_PRELOAD_MODES).join(', ') }))
    }
  }
}

/**
 * Valide la clé `css` (mode d'émission des styles partagés). Chaîne STRICTEMENT
 * parmi `'bundle'` / `'split'` / `'lazy'` — `'lazy'` est une valeur LÉGALE ici
 * (accepte la validation), mais fait échouer le BUILD plus loin (bundler/index.ts,
 * compile()) : le mode n'est pas encore implémenté.
 */
function validateCssConfig(css: any, _path: string): void {
  if (typeof css !== 'string' || !VALID_CSS_MODES.has(css)) {
    throw new Error(t('bundler.config.css-mode-invalide', { valeur: css, valides: Array.from(VALID_CSS_MODES).join(', ') }))
  }
}

function validateJsConfig(js: any, _path: string): void {
  if (typeof js !== 'string' || !VALID_JS_MODES.has(js)) {
    throw new Error(t('bundler.config.js-mode-invalide', { valeur: js, valides: Array.from(VALID_JS_MODES).join(', ') }))
  }
}

/**
 * Valide le bloc `image` (variantes de largeur produites par `µimage`). Strict comme
 * le reste : clé inconnue = échec, `widths` = entiers > 0, `formats` = liste parmi
 * avif/webp/jpeg/png, `quality` = entier de 1 à 100.
 */
function validateImageConfig(image: any, path: string): void {
  if (typeof image !== 'object' || image === null || Array.isArray(image)) {
    throw new Error(t('bundler.config.image-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(image)) {
    if (!KNOWN_IMAGE_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `image.${k}`, valides: Array.from(KNOWN_IMAGE_KEYS).join(', ') }))
    }
  }
  if (image.widths !== undefined) {
    if (!Array.isArray(image.widths) || image.widths.length === 0 || image.widths.some((w: any) => typeof w !== 'number' || !Number.isInteger(w) || w < 1)) {
      throw new Error(t('bundler.config.image-widths-invalide', { valeur: JSON.stringify(image.widths) }))
    }
  }
  if (image.formats !== undefined) {
    if (!Array.isArray(image.formats) || image.formats.length === 0 || image.formats.some((f: any) => !VALID_IMAGE_FORMATS.has(f))) {
      throw new Error(t('bundler.config.image-formats-invalide', { valeur: JSON.stringify(image.formats), valides: Array.from(VALID_IMAGE_FORMATS).join(', ') }))
    }
  }
  if (image.quality !== undefined) {
    if (typeof image.quality !== 'number' || !Number.isInteger(image.quality) || image.quality < 1 || image.quality > 100) {
      throw new Error(t('bundler.config.image-quality-invalide', { valeur: JSON.stringify(image.quality) }))
    }
  }
}

/**
 * Valide le bloc `lint` (seuils des avertissements de compilation). Strict
 * comme le reste du config : clé inconnue = échec immédiat, `maxStateVars`
 * = entier ≥ 0 (`0` désactive l'avertissement), `a11y` = booléen strict.
 */
function validateLintConfig(lint: any, path: string): void {
  if (typeof lint !== 'object' || lint === null || Array.isArray(lint)) {
    throw new Error(t('bundler.config.lint-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(lint)) {
    if (!KNOWN_LINT_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `lint.${k}`, valides: Array.from(KNOWN_LINT_KEYS).join(', ') }))
    }
  }
  if (lint.maxStateVars !== undefined) {
    if (typeof lint.maxStateVars !== 'number' || !Number.isInteger(lint.maxStateVars) || lint.maxStateVars < 0) {
      throw new Error(t('bundler.config.lint-max-state-vars-invalide', { valeur: JSON.stringify(lint.maxStateVars), type: typeof lint.maxStateVars }))
    }
  }
  if (lint.a11y !== undefined) {
    if (typeof lint.a11y !== 'boolean') {
      throw new Error(t('bundler.config.lint-a11y-invalide', { valeur: JSON.stringify(lint.a11y), type: typeof lint.a11y }))
    }
  }
  if (lint.ujsForm !== undefined) {
    if (typeof lint.ujsForm !== 'boolean') {
      throw new Error(t('bundler.config.lint-ujs-form-invalide', { valeur: JSON.stringify(lint.ujsForm), type: typeof lint.ujsForm }))
    }
  }
}

/**
 * Valide la clé `logLevel` (niveau de la console navigateur + build). Accepte une chaîne parmi
 * `VALID_LOG_LEVELS`, ou un objet strict `{ dev?, prod? }` dont chaque sous-clé est un de ces
 * niveaux — même patron que `validatePreloadConfig` (chaîne ou objet à deux axes optionnels).
 */
function validateLogLevelConfig(value: any, path: string): void {
  if (typeof value === 'string') {
    if (!VALID_LOG_LEVELS.has(value as LogLevelName)) {
      throw new Error(t('bundler.config.log-level-invalide', { valeur: value, valides: Array.from(VALID_LOG_LEVELS).join(', ') }))
    }
    return
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(t('bundler.config.log-level-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(value)) {
    if (!KNOWN_LOG_LEVEL_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `logLevel.${k}`, valides: Array.from(KNOWN_LOG_LEVEL_KEYS).join(', ') }))
    }
  }
  for (const env of ['dev', 'prod'] as const) {
    if (value[env] !== undefined && !VALID_LOG_LEVELS.has(value[env])) {
      throw new Error(t('bundler.config.log-level-env-invalide', { env, valeur: value[env], valides: Array.from(VALID_LOG_LEVELS).join(', ') }))
    }
  }
}

/**
 * Valide le bloc `ws` (démarrage de `mjs ws`, cf. cli/ws.ts). MÊME patron
 * strict que `validateRuntimeConfig`/`validateLintConfig` ci-dessus : clé
 * inconnue ou type faux = échec immédiat, avec suggestion orthographique sur
 * les fautes de frappe (`suggestKey`, cf. plus haut).
 */
function validateWsConfig(ws: any, path: string): void {
  if (typeof ws !== 'object' || ws === null || Array.isArray(ws)) {
    throw new Error(t('bundler.config.ws-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(ws)) {
    if (!KNOWN_WS_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.${k}`, hint, valides: Array.from(KNOWN_WS_KEYS).join(', ') }))
    }
  }
  if (ws.entry !== undefined && typeof ws.entry !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'ws.entry', valeur: JSON.stringify(ws.entry), type: typeof ws.entry }))
  }
  if (ws.transport !== undefined) {
    if (typeof ws.transport !== 'string' || !VALID_WS_TRANSPORTS.has(ws.transport)) {
      const suggestion = typeof ws.transport === 'string' ? suggestKey(ws.transport, VALID_WS_TRANSPORTS) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.transport-invalide', { cle: 'ws.transport', valeur: JSON.stringify(ws.transport), hint, valides: Array.from(VALID_WS_TRANSPORTS).join(', ') }))
    }
  }
  if (ws.host !== undefined && typeof ws.host !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'ws.host', valeur: JSON.stringify(ws.host), type: typeof ws.host }))
  }
  if (ws.codec !== undefined) {
    if (typeof ws.codec !== 'string' || !VALID_WS_CODECS.has(ws.codec)) {
      const suggestion = typeof ws.codec === 'string' ? suggestKey(ws.codec, VALID_WS_CODECS) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.codec-invalide', { cle: 'ws.codec', valeur: JSON.stringify(ws.codec), hint, valides: Array.from(VALID_WS_CODECS).join(', ') }))
    }
  }
  if (ws.port !== undefined) {
    if (typeof ws.port !== 'number' || !Number.isInteger(ws.port) || ws.port < 1 || ws.port > 65535) {
      throw new Error(t('bundler.config.port-hors-plage', { cle: 'ws.port', valeur: JSON.stringify(ws.port) }))
    }
  }
  if (ws.heartbeat !== undefined) {
    if (typeof ws.heartbeat !== 'number' || !Number.isInteger(ws.heartbeat) || ws.heartbeat <= 0) {
      throw new Error(t('bundler.config.entier-positif-ms-invalide', { cle: 'ws.heartbeat', valeur: JSON.stringify(ws.heartbeat), type: typeof ws.heartbeat }))
    }
  }
  if (ws.limits !== undefined) {
    if (typeof ws.limits !== 'object' || ws.limits === null || Array.isArray(ws.limits)) {
      throw new Error(t('bundler.config.limits-doit-etre-objet', { cle: 'ws.limits', chemin: path }))
    }
    for (const k of Object.keys(ws.limits)) {
      if (!KNOWN_WS_LIMITS_KEYS.has(k)) {
        const suggestion = suggestKey(k, KNOWN_WS_LIMITS_KEYS)
        const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
        throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.limits.${k}`, hint, valides: Array.from(KNOWN_WS_LIMITS_KEYS).join(', ') }))
      }
    }
    for (const k of KNOWN_WS_LIMITS_KEYS) {
      const v = (ws.limits as any)[k]
      // plafonds de connexions/salons — `null` EXPLICITE = illimité, valide
      // SEULEMENT pour ces 3 clés (cf. NULLABLE_WS_LIMITS_KEYS) ; toutes les autres n'acceptent
      // jamais null (même règle qu'avant).
      if (v === null && NULLABLE_WS_LIMITS_KEYS.has(k)) continue
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
        const suffix = NULLABLE_WS_LIMITS_KEYS.has(k) ? t('bundler.config.limite-nullable-suffixe') : ''
        throw new Error(t('bundler.config.limits-cle-invalide', { cle: `ws.limits.${k}`, suffixe: suffix, valeur: JSON.stringify(v), type: typeof v }))
      }
    }
  }
  if (ws.token !== undefined) {
    validateWsTokenConfig(ws.token, path)
  }
  if (ws.resume !== undefined) {
    validateWsResumeConfig(ws.resume, path)
  }
  if (ws.bridge !== undefined) {
    validateWsBridgeConfig(ws.bridge, path)
  }
  if (ws.adapter !== undefined) {
    validateWsAdapterConfig(ws.adapter, path)
  }
  if (ws.stats !== undefined && typeof ws.stats !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'ws.stats', valeur: JSON.stringify(ws.stats), type: typeof ws.stats }))
  }
  // session exclusive par identité (sessionExclusive — 2 modes) — élargi (MÊME patron
  // strict que ws.codec plus haut) : booléen `true`/`false` OU une des 2 chaînes de
  // VALID_SESSION_EXCLUSIVE (`true` ≡ 'replace' au runtime, cf. resolveSessionExclusiveOption,
  // mjs-ws/index.ts) — toute autre valeur (chaîne inconnue, nombre…) est rejetée immédiatement.
  if (ws.sessionExclusive !== undefined) {
    const se = ws.sessionExclusive
    if (typeof se !== 'boolean' && !(typeof se === 'string' && VALID_SESSION_EXCLUSIVE.has(se))) {
      const suggestion = typeof se === 'string' ? suggestKey(se, VALID_SESSION_EXCLUSIVE) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.session-exclusive-invalide', { cle: 'ws.sessionExclusive', valeur: JSON.stringify(se), hint, valides: Array.from(VALID_SESSION_EXCLUSIVE).join(', ') }))
    }
  }
  // vérification d'origine (verifyOrigin) — SEULE la forme allowlist existe en JSON (cf.
  // WsConfig.verifyOrigin) : tableau NON VIDE de chaînes NON VIDES, sinon échec immédiat (MÊME
  // ton que les validations voisines).
  if (ws.verifyOrigin !== undefined) {
    const vo = ws.verifyOrigin
    if (!Array.isArray(vo) || vo.length === 0 || vo.some((o: unknown) => typeof o !== 'string' || o.length === 0)) {
      throw new Error(t('bundler.config.verify-origin-invalide', { cle: 'ws.verifyOrigin', valeur: JSON.stringify(vo) }))
    }
  }
}

/**
 * Valide le bloc `ws.adapter` (adaptateur multi-processus, src/mjs-ws/adapter-redis.ts).
 * MÊME patron strict que les autres blocs `ws.*` : clé inconnue = échec immédiat avec suggestion
 * orthographique, type faux = échec immédiat. `redis` est REQUIS (chaîne non vide) — la forme
 * exacte de l'URL (schéma, host, port, base) n'est vérifiée qu'au runtime par adapter-redis.ts
 * (parseRedisUrl), au moment où mjsWs() construit réellement l'adaptateur.
 */
function validateWsAdapterConfig(adapter: any, path: string): void {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    throw new Error(t('bundler.config.adapter-doit-etre-objet', { cle: 'ws.adapter', chemin: path }))
  }
  for (const k of Object.keys(adapter)) {
    if (!KNOWN_WS_ADAPTER_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_ADAPTER_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.adapter.${k}`, hint, valides: Array.from(KNOWN_WS_ADAPTER_KEYS).join(', ') }))
    }
  }
  if (typeof adapter.redis !== 'string' || adapter.redis === '') {
    throw new Error(t('bundler.config.adapter-redis-requis', { cle: 'ws.adapter.redis' }))
  }
  if (adapter.prefix !== undefined && (typeof adapter.prefix !== 'string' || adapter.prefix === '')) {
    throw new Error(t('bundler.config.chaine-non-vide-invalide', { cle: 'ws.adapter.prefix', valeur: JSON.stringify(adapter.prefix), type: typeof adapter.prefix }))
  }
  // anti-entropie de présence (cf. src/mjs-ws/adapter.ts attachPresenceAntiEntropy) — MÊME
  // patron que ws.heartbeat (entier > 0) mais avec `false` en soupape de désactivation
  if (adapter.antiEntropy !== undefined && adapter.antiEntropy !== false) {
    if (typeof adapter.antiEntropy !== 'number' || !Number.isInteger(adapter.antiEntropy) || adapter.antiEntropy <= 0) {
      throw new Error(t('bundler.config.entier-ou-false-invalide', { cle: 'ws.adapter.antiEntropy', valeur: JSON.stringify(adapter.antiEntropy), type: typeof adapter.antiEntropy }))
    }
  }
}

/**
 * Valide le bloc `ws.token` (suivi d'expiration + rafraîchissement du jeton, cf.
 * src/mjs-ws/core.ts). MÊME patron strict que validateWsResumeConfig ci-dessous : clé inconnue
 * = échec immédiat avec suggestion orthographique, type faux = échec immédiat, entiers > 0
 * seulement. Pas de forme booléenne (contrairement à `resume`) : `token` n'est pas un
 * COMMUTATEUR de fonctionnalité, juste un réglage fin — l'activation réelle du balayage reste
 * data-driven au runtime (cf. le JSDoc de `WsConfig.token`).
 */
function validateWsTokenConfig(token: any, path: string): void {
  if (typeof token !== 'object' || token === null || Array.isArray(token)) {
    throw new Error(t('bundler.config.token-doit-etre-objet', { cle: 'ws.token', valeur: JSON.stringify(token), type: typeof token, chemin: path }))
  }
  for (const k of Object.keys(token)) {
    if (!KNOWN_WS_TOKEN_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_TOKEN_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.token.${k}`, hint, valides: Array.from(KNOWN_WS_TOKEN_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_TOKEN_KEYS) {
    const v = (token as any)[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      throw new Error(t('bundler.config.entier-positif-invalide', { cle: `ws.token.${k}`, valeur: JSON.stringify(v), type: typeof v }))
    }
  }
}

/**
 * Valide le bloc `ws.resume` (reprise de session, cf. src/mjs-ws/sessions.ts).
 * MÊME patron strict que validateWsConfig : clé inconnue = échec immédiat avec suggestion
 * orthographique, type faux = échec immédiat. `true` = défauts, `false` ≡ absent (accepté
 * pour couper explicitement), objet = réglages fins — entiers > 0 seulement.
 */
function validateWsResumeConfig(resume: any, path: string): void {
  if (typeof resume === 'boolean') return
  if (typeof resume !== 'object' || resume === null || Array.isArray(resume)) {
    throw new Error(t('bundler.config.resume-doit-etre-objet', { cle: 'ws.resume', valeur: JSON.stringify(resume), type: typeof resume, chemin: path }))
  }
  for (const k of Object.keys(resume)) {
    if (!KNOWN_WS_RESUME_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_RESUME_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.resume.${k}`, hint, valides: Array.from(KNOWN_WS_RESUME_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_RESUME_KEYS) {
    const v = (resume as any)[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      throw new Error(t('bundler.config.entier-positif-invalide', { cle: `ws.resume.${k}`, valeur: JSON.stringify(v), type: typeof v }))
    }
  }
}

/**
 * Valide le bloc `ws.bridge` (pont universel, cf. src/mjs-ws/bridge.ts). MÊME
 * patron strict que validateWsConfig ci-dessus : clé inconnue = échec immédiat avec
 * suggestion orthographique, type faux = échec immédiat. `secret` reste optionnel ICI
 * (validation de FORME) — cf. le JSDoc de `WsConfig.bridge` : l'obligation réelle est
 * tranchée par bridge.ts, au moment où mjsWs() est réellement appelé.
 */
function validateWsBridgeConfig(bridge: any, path: string): void {
  if (typeof bridge !== 'object' || bridge === null || Array.isArray(bridge)) {
    throw new Error(t('bundler.config.bridge-doit-etre-objet', { cle: 'ws.bridge', chemin: path }))
  }
  for (const k of Object.keys(bridge)) {
    if (!KNOWN_WS_BRIDGE_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.bridge.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_KEYS).join(', ') }))
    }
  }
  if (bridge.port !== undefined) {
    if (typeof bridge.port !== 'number' || !Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65535) {
      throw new Error(t('bundler.config.port-hors-plage', { cle: 'ws.bridge.port', valeur: JSON.stringify(bridge.port) }))
    }
  }
  if (bridge.host !== undefined && typeof bridge.host !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'ws.bridge.host', valeur: JSON.stringify(bridge.host), type: typeof bridge.host }))
  }
  if (bridge.secret !== undefined && typeof bridge.secret !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'ws.bridge.secret', valeur: JSON.stringify(bridge.secret), type: typeof bridge.secret }))
  }
  if (bridge.webhooks !== undefined) {
    const wh = bridge.webhooks
    if (typeof wh !== 'object' || wh === null || Array.isArray(wh)) {
      throw new Error(t('bundler.config.webhooks-doit-etre-objet', { cle: 'ws.bridge.webhooks', chemin: path }))
    }
    for (const k of Object.keys(wh)) {
      if (!KNOWN_WS_BRIDGE_WEBHOOKS_KEYS.has(k)) {
        const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_WEBHOOKS_KEYS)
        const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
        throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.bridge.webhooks.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_WEBHOOKS_KEYS).join(', ') }))
      }
    }
    if (typeof wh.url !== 'string' || wh.url === '') {
      throw new Error(t('bundler.config.webhooks-url-requis', { cle: 'ws.bridge.webhooks.url' }))
    }
    if (wh.secret !== undefined && typeof wh.secret !== 'string') {
      throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'ws.bridge.webhooks.secret', valeur: JSON.stringify(wh.secret), type: typeof wh.secret }))
    }
    if (!Array.isArray(wh.events) || wh.events.length === 0 || !wh.events.every((e: unknown) => typeof e === 'string' && e.length > 0)) {
      throw new Error(t('bundler.config.webhooks-events-invalide', { cle: 'ws.bridge.webhooks.events' }))
    }
    if (wh.timeoutMs !== undefined) {
      if (typeof wh.timeoutMs !== 'number' || !Number.isInteger(wh.timeoutMs) || wh.timeoutMs <= 0) {
        throw new Error(t('bundler.config.entier-positif-ms-invalide', { cle: 'ws.bridge.webhooks.timeoutMs', valeur: JSON.stringify(wh.timeoutMs), type: typeof wh.timeoutMs }))
      }
    }
  }
  if (bridge.rateLimit !== undefined) {
    validateWsBridgeRateLimitConfig(bridge.rateLimit, path)
  }
  // nonce anti-rejeu — simple booléen, MÊME patron que guardProcess/stats (racine)
  if (bridge.nonce !== undefined && typeof bridge.nonce !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen-simple', { cle: 'ws.bridge.nonce', valeur: JSON.stringify(bridge.nonce), type: typeof bridge.nonce }))
  }
}

/**
 * Valide `ws.bridge.rateLimit` (limite de débit par IP, src/mjs-ws/bridge.ts) — MÊME
 * patron strict que le reste de `ws.bridge` : `false` accepté tel quel (désactivation explicite),
 * sinon un objet `{ perIp?, fails? }` — clé inconnue = échec immédiat avec suggestion
 * orthographique, chaque seau présent doit être un tuple `[capacité, fenêtreMs]` de 2 entiers > 0.
 */
function validateWsBridgeRateLimitConfig(rateLimit: any, path: string): void {
  if (rateLimit === false) return
  if (typeof rateLimit !== 'object' || rateLimit === null || Array.isArray(rateLimit)) {
    throw new Error(t('bundler.config.ratelimit-doit-etre-objet', { cle: 'ws.bridge.rateLimit', valeur: JSON.stringify(rateLimit), type: typeof rateLimit, chemin: path }))
  }
  for (const k of Object.keys(rateLimit)) {
    if (!KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `ws.bridge.rateLimit.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS) {
    const v = (rateLimit as any)[k]
    if (v === undefined) continue
    const valid = Array.isArray(v) && v.length === 2 && v.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0)
    if (!valid) {
      throw new Error(t('bundler.config.ratelimit-tuple-invalide', { cle: `ws.bridge.rateLimit.${k}`, valeur: JSON.stringify(v) }))
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────
// section `serveur` (mjs serveur, cli/server.ts) — MÊME patron strict que la section `ws`
// ci-dessus, messages préfixés `serveur.` (pas `ws.`) pour ne jamais induire en erreur un dev
// qui configure `mjs serveur`. Les SOUS-STRUCTURES (limits/token/bridge/resume/adapter) ont la
// MÊME forme que `ws.*` — les Sets de clés connues (KNOWN_WS_LIMITS_KEYS, KNOWN_WS_TOKEN_KEYS,
// KNOWN_WS_BRIDGE_KEYS, KNOWN_WS_BRIDGE_WEBHOOKS_KEYS, KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS,
// KNOWN_WS_RESUME_KEYS, KNOWN_WS_ADAPTER_KEYS, VALID_WS_TRANSPORTS, VALID_WS_CODECS,
// VALID_SESSION_EXCLUSIVE, NULLABLE_WS_LIMITS_KEYS) sont RÉUTILISÉES telles quelles (pure
// donnée, aucun texte 'ws.' dedans) — seuls les MESSAGES d'erreur sont dupliqués avec le bon
// préfixe, jamais la logique de validation elle-même.
// ──────────────────────────────────────────────────────────────────────────

/**
 * Valide le bloc `serveur` (démarrage de `mjs serveur`, cf. cli/server.ts). MÊME patron strict
 * que `validateWsConfig` : clé inconnue ou type faux = échec immédiat, avec suggestion
 * orthographique sur les fautes de frappe.
 */
function validateServeurConfig(serveur: any, path: string): void {
  if (typeof serveur !== 'object' || serveur === null || Array.isArray(serveur)) {
    throw new Error(t('bundler.config.serveur-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(serveur)) {
    if (!KNOWN_SERVEUR_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_SERVEUR_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.${k}`, hint, valides: Array.from(KNOWN_SERVEUR_KEYS).join(', ') }))
    }
  }
  if (serveur.entry !== undefined && typeof serveur.entry !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'serveur.entry', valeur: JSON.stringify(serveur.entry), type: typeof serveur.entry }))
  }
  if (serveur.transport !== undefined) {
    if (typeof serveur.transport !== 'string' || !VALID_WS_TRANSPORTS.has(serveur.transport)) {
      const suggestion = typeof serveur.transport === 'string' ? suggestKey(serveur.transport, VALID_WS_TRANSPORTS) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.transport-invalide', { cle: 'serveur.transport', valeur: JSON.stringify(serveur.transport), hint, valides: Array.from(VALID_WS_TRANSPORTS).join(', ') }))
    }
  }
  if (serveur.host !== undefined && typeof serveur.host !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'serveur.host', valeur: JSON.stringify(serveur.host), type: typeof serveur.host }))
  }
  if (serveur.codec !== undefined) {
    if (typeof serveur.codec !== 'string' || !VALID_WS_CODECS.has(serveur.codec)) {
      const suggestion = typeof serveur.codec === 'string' ? suggestKey(serveur.codec, VALID_WS_CODECS) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.codec-invalide', { cle: 'serveur.codec', valeur: JSON.stringify(serveur.codec), hint, valides: Array.from(VALID_WS_CODECS).join(', ') }))
    }
  }
  if (serveur.port !== undefined) {
    if (typeof serveur.port !== 'number' || !Number.isInteger(serveur.port) || serveur.port < 1 || serveur.port > 65535) {
      throw new Error(t('bundler.config.port-hors-plage', { cle: 'serveur.port', valeur: JSON.stringify(serveur.port) }))
    }
  }
  if (serveur.heartbeat !== undefined) {
    if (typeof serveur.heartbeat !== 'number' || !Number.isInteger(serveur.heartbeat) || serveur.heartbeat <= 0) {
      throw new Error(t('bundler.config.entier-positif-ms-invalide', { cle: 'serveur.heartbeat', valeur: JSON.stringify(serveur.heartbeat), type: typeof serveur.heartbeat }))
    }
  }
  if (serveur.limits !== undefined) {
    if (typeof serveur.limits !== 'object' || serveur.limits === null || Array.isArray(serveur.limits)) {
      throw new Error(t('bundler.config.limits-doit-etre-objet', { cle: 'serveur.limits', chemin: path }))
    }
    for (const k of Object.keys(serveur.limits)) {
      if (!KNOWN_WS_LIMITS_KEYS.has(k)) {
        const suggestion = suggestKey(k, KNOWN_WS_LIMITS_KEYS)
        const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
        throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.limits.${k}`, hint, valides: Array.from(KNOWN_WS_LIMITS_KEYS).join(', ') }))
      }
    }
    for (const k of KNOWN_WS_LIMITS_KEYS) {
      const v = (serveur.limits as any)[k]
      if (v === null && NULLABLE_WS_LIMITS_KEYS.has(k)) continue
      if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
        const suffix = NULLABLE_WS_LIMITS_KEYS.has(k) ? t('bundler.config.limite-nullable-suffixe') : ''
        throw new Error(t('bundler.config.limits-cle-invalide', { cle: `serveur.limits.${k}`, suffixe: suffix, valeur: JSON.stringify(v), type: typeof v }))
      }
    }
  }
  if (serveur.token !== undefined) {
    validateServeurTokenConfig(serveur.token, path)
  }
  if (serveur.resume !== undefined) {
    validateServeurResumeConfig(serveur.resume, path)
  }
  if (serveur.bridge !== undefined) {
    validateServeurBridgeConfig(serveur.bridge, path)
  }
  if (serveur.adapter !== undefined) {
    validateServeurAdapterConfig(serveur.adapter, path)
  }
  if (serveur.stats !== undefined && typeof serveur.stats !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'serveur.stats', valeur: JSON.stringify(serveur.stats), type: typeof serveur.stats }))
  }
  if (serveur.sessionExclusive !== undefined) {
    const se = serveur.sessionExclusive
    if (typeof se !== 'boolean' && !(typeof se === 'string' && VALID_SESSION_EXCLUSIVE.has(se))) {
      const suggestion = typeof se === 'string' ? suggestKey(se, VALID_SESSION_EXCLUSIVE) : null
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.session-exclusive-invalide', { cle: 'serveur.sessionExclusive', valeur: JSON.stringify(se), hint, valides: Array.from(VALID_SESSION_EXCLUSIVE).join(', ') }))
    }
  }
  if (serveur.verifyOrigin !== undefined) {
    const vo = serveur.verifyOrigin
    if (!Array.isArray(vo) || vo.length === 0 || vo.some((o: unknown) => typeof o !== 'string' || o.length === 0)) {
      throw new Error(t('bundler.config.verify-origin-invalide', { cle: 'serveur.verifyOrigin', valeur: JSON.stringify(vo) }))
    }
  }
  if (serveur.antiCheat !== undefined) {
    validateServeurAntiCheatConfig(serveur.antiCheat, path)
  }
}

/**
 * Valide `serveur.antiCheat` (mjs-server/index.ts `MjsServerAntiTricheOptions`) —
 * `movesPerIdentity` et `codePerIp` existent ici (JSON-able) : `[n entier ≥ 1, fenêtreMs entier
 * > 0]` ou `null`. MÊME patron strict que le reste : clé inconnue = échec immédiat.
 */
function validateServeurAntiCheatConfig(antiCheat: any, path: string): void {
  if (typeof antiCheat !== 'object' || antiCheat === null || Array.isArray(antiCheat)) {
    throw new Error(t('bundler.config.antitriche-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(antiCheat)) {
    if (!KNOWN_SERVEUR_ANTITRICHE_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_SERVEUR_ANTITRICHE_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.antiCheat.${k}`, hint, valides: Array.from(KNOWN_SERVEUR_ANTITRICHE_KEYS).join(', ') }))
    }
  }
  if (antiCheat.movesPerIdentity !== undefined && antiCheat.movesPerIdentity !== null) {
    const mpi = antiCheat.movesPerIdentity
    const valid = Array.isArray(mpi) && mpi.length === 2 &&
      Number.isInteger(mpi[0]) && mpi[0] >= 1 &&
      typeof mpi[1] === 'number' && Number.isInteger(mpi[1]) && mpi[1] > 0
    if (!valid) {
      throw new Error(t('bundler.config.moves-per-identity-invalide', { valeur: JSON.stringify(mpi) }))
    }
  }
  if (antiCheat.codePerIp !== undefined && antiCheat.codePerIp !== null) {
    const cpi = antiCheat.codePerIp
    const valid = Array.isArray(cpi) && cpi.length === 2 &&
      Number.isInteger(cpi[0]) && cpi[0] >= 1 &&
      typeof cpi[1] === 'number' && Number.isInteger(cpi[1]) && cpi[1] > 0
    if (!valid) {
      throw new Error(t('bundler.config.code-per-ip-invalide', { valeur: JSON.stringify(cpi) }))
    }
  }
}

/**
 * Valide `serveur.adapter` — MÊME logique que `validateWsAdapterConfig`, messages `serveur.`.
 */
function validateServeurAdapterConfig(adapter: any, path: string): void {
  if (typeof adapter !== 'object' || adapter === null || Array.isArray(adapter)) {
    throw new Error(t('bundler.config.adapter-doit-etre-objet', { cle: 'serveur.adapter', chemin: path }))
  }
  for (const k of Object.keys(adapter)) {
    if (!KNOWN_WS_ADAPTER_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_ADAPTER_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.adapter.${k}`, hint, valides: Array.from(KNOWN_WS_ADAPTER_KEYS).join(', ') }))
    }
  }
  if (typeof adapter.redis !== 'string' || adapter.redis === '') {
    throw new Error(t('bundler.config.adapter-redis-requis', { cle: 'serveur.adapter.redis' }))
  }
  if (adapter.prefix !== undefined && (typeof adapter.prefix !== 'string' || adapter.prefix === '')) {
    throw new Error(t('bundler.config.chaine-non-vide-invalide', { cle: 'serveur.adapter.prefix', valeur: JSON.stringify(adapter.prefix), type: typeof adapter.prefix }))
  }
  if (adapter.antiEntropy !== undefined && adapter.antiEntropy !== false) {
    if (typeof adapter.antiEntropy !== 'number' || !Number.isInteger(adapter.antiEntropy) || adapter.antiEntropy <= 0) {
      throw new Error(t('bundler.config.entier-ou-false-invalide', { cle: 'serveur.adapter.antiEntropy', valeur: JSON.stringify(adapter.antiEntropy), type: typeof adapter.antiEntropy }))
    }
  }
}

/**
 * Valide `serveur.token` — MÊME logique que `validateWsTokenConfig`, messages `serveur.`.
 */
function validateServeurTokenConfig(token: any, path: string): void {
  if (typeof token !== 'object' || token === null || Array.isArray(token)) {
    throw new Error(t('bundler.config.token-doit-etre-objet', { cle: 'serveur.token', valeur: JSON.stringify(token), type: typeof token, chemin: path }))
  }
  for (const k of Object.keys(token)) {
    if (!KNOWN_WS_TOKEN_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_TOKEN_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.token.${k}`, hint, valides: Array.from(KNOWN_WS_TOKEN_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_TOKEN_KEYS) {
    const v = (token as any)[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      throw new Error(t('bundler.config.entier-positif-invalide', { cle: `serveur.token.${k}`, valeur: JSON.stringify(v), type: typeof v }))
    }
  }
}

/**
 * Valide `serveur.resume` — MÊME logique que `validateWsResumeConfig`, messages `serveur.`.
 */
function validateServeurResumeConfig(resume: any, path: string): void {
  if (typeof resume === 'boolean') return
  if (typeof resume !== 'object' || resume === null || Array.isArray(resume)) {
    throw new Error(t('bundler.config.resume-doit-etre-objet', { cle: 'serveur.resume', valeur: JSON.stringify(resume), type: typeof resume, chemin: path }))
  }
  for (const k of Object.keys(resume)) {
    if (!KNOWN_WS_RESUME_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_RESUME_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.resume.${k}`, hint, valides: Array.from(KNOWN_WS_RESUME_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_RESUME_KEYS) {
    const v = (resume as any)[k]
    if (v !== undefined && (typeof v !== 'number' || !Number.isInteger(v) || v <= 0)) {
      throw new Error(t('bundler.config.entier-positif-invalide', { cle: `serveur.resume.${k}`, valeur: JSON.stringify(v), type: typeof v }))
    }
  }
}

/**
 * Valide `serveur.bridge` — MÊME logique que `validateWsBridgeConfig`, messages `serveur.`.
 */
function validateServeurBridgeConfig(bridge: any, path: string): void {
  if (typeof bridge !== 'object' || bridge === null || Array.isArray(bridge)) {
    throw new Error(t('bundler.config.bridge-doit-etre-objet', { cle: 'serveur.bridge', chemin: path }))
  }
  for (const k of Object.keys(bridge)) {
    if (!KNOWN_WS_BRIDGE_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.bridge.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_KEYS).join(', ') }))
    }
  }
  if (bridge.port !== undefined) {
    if (typeof bridge.port !== 'number' || !Number.isInteger(bridge.port) || bridge.port < 1 || bridge.port > 65535) {
      throw new Error(t('bundler.config.port-hors-plage', { cle: 'serveur.bridge.port', valeur: JSON.stringify(bridge.port) }))
    }
  }
  if (bridge.host !== undefined && typeof bridge.host !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'serveur.bridge.host', valeur: JSON.stringify(bridge.host), type: typeof bridge.host }))
  }
  if (bridge.secret !== undefined && typeof bridge.secret !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'serveur.bridge.secret', valeur: JSON.stringify(bridge.secret), type: typeof bridge.secret }))
  }
  if (bridge.webhooks !== undefined) {
    const wh = bridge.webhooks
    if (typeof wh !== 'object' || wh === null || Array.isArray(wh)) {
      throw new Error(t('bundler.config.webhooks-doit-etre-objet', { cle: 'serveur.bridge.webhooks', chemin: path }))
    }
    for (const k of Object.keys(wh)) {
      if (!KNOWN_WS_BRIDGE_WEBHOOKS_KEYS.has(k)) {
        const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_WEBHOOKS_KEYS)
        const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
        throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.bridge.webhooks.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_WEBHOOKS_KEYS).join(', ') }))
      }
    }
    if (typeof wh.url !== 'string' || wh.url === '') {
      throw new Error(t('bundler.config.webhooks-url-requis', { cle: 'serveur.bridge.webhooks.url' }))
    }
    if (wh.secret !== undefined && typeof wh.secret !== 'string') {
      throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'serveur.bridge.webhooks.secret', valeur: JSON.stringify(wh.secret), type: typeof wh.secret }))
    }
    if (!Array.isArray(wh.events) || wh.events.length === 0 || !wh.events.every((e: unknown) => typeof e === 'string' && e.length > 0)) {
      throw new Error(t('bundler.config.webhooks-events-invalide', { cle: 'serveur.bridge.webhooks.events' }))
    }
    if (wh.timeoutMs !== undefined) {
      if (typeof wh.timeoutMs !== 'number' || !Number.isInteger(wh.timeoutMs) || wh.timeoutMs <= 0) {
        throw new Error(t('bundler.config.entier-positif-ms-invalide', { cle: 'serveur.bridge.webhooks.timeoutMs', valeur: JSON.stringify(wh.timeoutMs), type: typeof wh.timeoutMs }))
      }
    }
  }
  if (bridge.rateLimit !== undefined) {
    validateServeurBridgeRateLimitConfig(bridge.rateLimit, path)
  }
  if (bridge.nonce !== undefined && typeof bridge.nonce !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen-simple', { cle: 'serveur.bridge.nonce', valeur: JSON.stringify(bridge.nonce), type: typeof bridge.nonce }))
  }
}

/**
 * Valide `serveur.bridge.rateLimit` — MÊME logique que `validateWsBridgeRateLimitConfig`,
 * messages `serveur.`.
 */
function validateServeurBridgeRateLimitConfig(rateLimit: any, path: string): void {
  if (rateLimit === false) return
  if (typeof rateLimit !== 'object' || rateLimit === null || Array.isArray(rateLimit)) {
    throw new Error(t('bundler.config.ratelimit-doit-etre-objet', { cle: 'serveur.bridge.rateLimit', valeur: JSON.stringify(rateLimit), type: typeof rateLimit, chemin: path }))
  }
  for (const k of Object.keys(rateLimit)) {
    if (!KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS.has(k)) {
      const suggestion = suggestKey(k, KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS)
      const hint = suggestion ? t('bundler.config.suggestion-hint', { suggestion }) : ''
      throw new Error(t('bundler.config.cle-inconnue-hint', { cle: `serveur.bridge.rateLimit.${k}`, hint, valides: Array.from(KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS).join(', ') }))
    }
  }
  for (const k of KNOWN_WS_BRIDGE_RATE_LIMIT_KEYS) {
    const v = (rateLimit as any)[k]
    if (v === undefined) continue
    const valid = Array.isArray(v) && v.length === 2 && v.every((n: unknown) => typeof n === 'number' && Number.isInteger(n) && n > 0)
    if (!valid) {
      throw new Error(t('bundler.config.ratelimit-tuple-invalide', { cle: `serveur.bridge.rateLimit.${k}`, valeur: JSON.stringify(v) }))
    }
  }
}

/**
 * Valide le bloc `languages` (remplace
 * progressivement `defaultScriptLang`). `script` admet les mêmes valeurs que
 * `defaultScriptLang` (VALID_LANGS) ; `template` n'admet que `'civet'`/`'js'`
 * (grammaire des interpolations/handlers — Coffee/TS n'y ont jamais existé).
 */
function validateLanguagesConfig(languages: any, path: string): void {
  if (typeof languages !== 'object' || languages === null || Array.isArray(languages)) {
    throw new Error(t('bundler.config.languages-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(languages)) {
    if (!KNOWN_LANGUAGES_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `languages.${k}`, valides: Array.from(KNOWN_LANGUAGES_KEYS).join(', ') }))
    }
  }
  if (languages.script !== undefined && !VALID_LANGS.has(languages.script)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'languages.script', valeur: languages.script, valides: Array.from(VALID_LANGS).join(', ') }))
  }
  if (languages.template !== undefined && !VALID_TEMPLATE_LANGS.has(languages.template)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'languages.template', valeur: languages.template, valides: Array.from(VALID_TEMPLATE_LANGS).join(', ') }))
  }
}

/**
 * Valide le bloc `i18n` — cf. le JSDoc de `MjsConfig.i18n` pour la sémantique.
 * Le check « `i18n/` présent dans `sourceDir` sans `default`» (et son inverse,
 * `i18n` posé sans dossier `i18n/`) se fait au BUILD (bundler/index.ts, scan de
 * `sourceDir`) — pas ici, cette fonction n'a accès qu'à la shape JSON.
 */
function validateI18nConfig(i18n: any, path: string): void {
  if (typeof i18n !== 'object' || i18n === null || Array.isArray(i18n)) {
    throw new Error(t('bundler.config.i18n-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(i18n)) {
    if (!KNOWN_I18N_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `i18n.${k}`, valides: Array.from(KNOWN_I18N_KEYS).join(', ') }))
    }
  }
  if (i18n.default !== undefined && (typeof i18n.default !== 'string' || i18n.default.length === 0)) {
    throw new Error(t('bundler.config.i18n-default-invalide', { valeur: JSON.stringify(i18n.default) }))
  }
  if (i18n.placeholder !== undefined && !VALID_I18N_PLACEHOLDERS.has(i18n.placeholder)) {
    throw new Error(t('bundler.config.i18n-placeholder-invalide', { valeur: i18n.placeholder, valides: Array.from(VALID_I18N_PLACEHOLDERS).join(', ') }))
  }
  if (i18n.hash !== undefined && typeof i18n.hash !== 'boolean' && i18n.hash !== 'auto') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'i18n.hash', defaut: 'auto', valeur: JSON.stringify(i18n.hash) }))
  }
  if (i18n.persist !== undefined && typeof i18n.persist !== 'boolean') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'i18n.persist', defaut: 'false', valeur: JSON.stringify(i18n.persist) }))
  }
  if (i18n.detect !== undefined && typeof i18n.detect !== 'boolean') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'i18n.detect', defaut: 'false', valeur: JSON.stringify(i18n.detect) }))
  }
  if (i18n.urlParam !== undefined && typeof i18n.urlParam !== 'boolean') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'i18n.urlParam', defaut: 'false', valeur: JSON.stringify(i18n.urlParam) }))
  }
  if (i18n.source !== undefined && (typeof i18n.source !== 'string' || i18n.source.length === 0)) {
    throw new Error(t('bundler.config.i18n-source-invalide', { valeur: JSON.stringify(i18n.source) }))
  }
}

/**
 * Valide le bloc `journal` — cf. le JSDoc de `MjsConfig.journal` pour la sémantique.
 * MÊME patron que `validateI18nConfig` (booléens + défauts, clés génériques réutilisées) :
 * `viewer` est le seul champ à forme double (booléen OU chaîne non vide, cf. `render.forwardOrigin`
 * pour un précédent de forme double dans ce fichier).
 */
function validateJournalConfig(journal: any, path: string): void {
  if (typeof journal !== 'object' || journal === null || Array.isArray(journal)) {
    throw new Error(t('bundler.config.journal-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(journal)) {
    if (!KNOWN_JOURNAL_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `journal.${k}`, valides: Array.from(KNOWN_JOURNAL_KEYS).join(', ') }))
    }
  }
  if (journal.server !== undefined && typeof journal.server !== 'boolean') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'journal.server', defaut: 'true', valeur: JSON.stringify(journal.server) }))
  }
  if (journal.client !== undefined && typeof journal.client !== 'boolean') {
    throw new Error(t('bundler.config.booleen-defaut-invalide', { cle: 'journal.client', defaut: 'false', valeur: JSON.stringify(journal.client) }))
  }
  if (journal.viewer !== undefined && typeof journal.viewer !== 'boolean' && !(typeof journal.viewer === 'string' && journal.viewer.length > 0)) {
    throw new Error(t('bundler.config.journal-viewer-invalide', { valeur: JSON.stringify(journal.viewer), type: typeof journal.viewer }))
  }
  if (journal.maxEntries !== undefined && (typeof journal.maxEntries !== 'number' || !Number.isInteger(journal.maxEntries) || journal.maxEntries <= 0)) {
    throw new Error(t('bundler.config.entier-positif-invalide', { cle: 'journal.maxEntries', valeur: JSON.stringify(journal.maxEntries), type: typeof journal.maxEntries }))
  }
  if (journal.maxBytes !== undefined && (typeof journal.maxBytes !== 'number' || !Number.isInteger(journal.maxBytes) || journal.maxBytes <= 0)) {
    throw new Error(t('bundler.config.entier-positif-invalide', { cle: 'journal.maxBytes', valeur: JSON.stringify(journal.maxBytes), type: typeof journal.maxBytes }))
  }
}

// `computeForwardedOrigin` (server/forward-origin.ts) compare l'hôte
// ENTRANT, déjà dépouillé de son port (`stripPort`) et mis en minuscules, à chaque élément de
// `trustedHosts` (lui aussi mis en minuscules à la comparaison, casse donc SANS IMPORTANCE ici).
// Un élément qui porte un port, des crochets, un chemin ou un espace ne matchera donc JAMAIS
// l'hôte nu comparé — panne MUETTE, le forwarding n'est jamais actif pour cet hôte, sans qu'aucune
// erreur ne le signale au build. On refuse donc tout élément qui n'est ni un nom d'hôte/IPv4 nu
// (`[a-z0-9.-]+`, sans `..`, sans point initial) ni une IPv6 NUE (`[0-9a-f:.]+`, ≥ 2 `:` — jamais
// entre crochets, la forme attendue ICI est celle comparée par `computeForwardedOrigin`, pas celle
// d'une URL).
//
// La regex ci-dessus tolérait encore un `.` dans
// l'alphabet IPv6, donc une IPv4 mappée POINTÉE (`::ffff:1.2.3.4`) passait le build. Or
// `computeForwardedOrigin` (server/forward-origin.ts) compose l'URL puis la relit via `new URL` :
// la normalisation WHATWG d'une IPv6 ne produit JAMAIS la forme pointée, seulement la forme hex
// compressée (`::ffff:102:304`) — la comparaison finale échoue donc TOUJOURS pour la forme pointée,
// panne MUETTE (forwarding jamais actif, aucune erreur). `TRUSTED_HOST_IPV6_RE` perd le `.` : une
// IPv6 nue n'est plus que `[0-9a-f:]+`, jamais un mélange `:`+`.`. Formes hex (`::ffff:102:304`,
// `::1`, `fe80::1`) toujours acceptées ; casse et point final d'un nom d'hôte inchangés (cohérents
// avec `computeForwardedOrigin`, hors périmètre de ce fix).
const TRUSTED_HOST_RE      = /^[a-z0-9.-]+$/
const TRUSTED_HOST_IPV6_RE = /^[0-9a-f:]+$/

function isValidTrustedHost(h: string): boolean {
  const bas = h.toLowerCase()
  if (TRUSTED_HOST_RE.test(bas) && !bas.includes('..') && !bas.startsWith('.')) return true
  return TRUSTED_HOST_IPV6_RE.test(bas) && (bas.match(/:/g) || []).length >= 2
}

// Les deux regex ci-dessus acceptent encore des
// formes SYNTAXIQUEMENT valides mais NON CANONIQUES (`01.02.03.04`, `0x7f.1`, `2130706433` pour une
// IPv4 ; `0:0:0:0:0:0:0:1` pour une IPv6) : `computeForwardedOrigin` compare `stripPort(new
// URL(...).host)` — la forme WHATWG NORMALISÉE — au Host brut en minuscules (forward-origin.ts
// l. 194) ; un `trustedHosts[i]` qui n'est pas DÉJÀ sous cette forme ne matche donc JAMAIS un Host
// entrant réel, même identique caractère pour caractère à la config — panne MUETTE, même famille
// que l'IPv4 mappée pointée ci-dessus. Retourne `null` quand `h` n'est même pas composable
// en URL (octets IPv4 hors bornes, ex. `123.456.789.0`) : l'appelant retombe alors sur le message
// d'invalidité EXISTANT, pas sur le message de forme non-canonique.
function canonicalTrustedHost(h: string): string | null {
  const bas = h.toLowerCase()
  try {
    const u = new URL('http://' + (bas.includes(':') ? '[' + bas + ']' : bas) + '/')
    return u.hostname.replace(/^\[|\]$/g, '')
  } catch {
    return null
  }
}

/**
 * Valide `render.forwardOrigin` (cf. son JSDoc sur
 * `RenderConfig`) : booléen, OU chaîne origine (`'https://exemple.com'`, validée
 * comme URL), OU `{ trustedHosts: string[] }` (tableau non vide de chaînes non
 * vides, clé unique, chacune un nom d'hôte/IPv4/IPv6 NU — cf. `isValidTrustedHost`
 * — ET déjà sous sa forme CANONIQUE (WHATWG) — cf. `canonicalTrustedHost`).
 * Toute autre forme/clé lève. Un élément de
 * `trustedHosts` par ailleurs ACCEPTÉ mais qui désigne une cible réseau INTERNE
 * (cf. `isBlockedForwardTarget`, server/forward-origin.ts) n'échoue PAS le build :
 * il reste listé, un AVERTISSEMENT signale juste qu'il n'activera jamais rien à
 * l'exécution (défense en profondeur du forwarding, TOUJOURS active).
 */
function validateForwardOrigin(fo: any): void {
  if (typeof fo === 'boolean') return
  if (typeof fo === 'string') {
    if (!fo) {
      throw new Error(t('bundler.config.forward-origin-vide'))
    }
    try {
      new URL(fo)
    } catch {
      throw new Error(t('bundler.config.forward-origin-url-invalide', { valeur: JSON.stringify(fo) }))
    }
    return
  }
  if (typeof fo === 'object' && fo !== null && !Array.isArray(fo)) {
    for (const k of Object.keys(fo)) {
      if (k !== 'trustedHosts') {
        throw new Error(t('bundler.config.forward-origin-cle-inconnue', { cle: `render.forwardOrigin.${k}` }))
      }
    }
    if (!Array.isArray(fo.trustedHosts) || fo.trustedHosts.length === 0) {
      throw new Error(t('bundler.config.trusted-hosts-invalide', { valeur: JSON.stringify(fo.trustedHosts) }))
    }
    for (let i = 0; i < fo.trustedHosts.length; i++) {
      const h = fo.trustedHosts[i]
      if (typeof h !== 'string' || !h) {
        throw new Error(t('bundler.config.trusted-host-item-invalide', { valeur: JSON.stringify(h), type: typeof h }))
      }
      if (!isValidTrustedHost(h)) {
        throw new Error(t('bundler.config.forward-origin-trusted-host-invalide', { index: i, valeur: JSON.stringify(h) }))
      }
      const canonique = canonicalTrustedHost(h)
      if (canonique === null) {
        throw new Error(t('bundler.config.forward-origin-trusted-host-invalide', { index: i, valeur: JSON.stringify(h) }))
      }
      if (canonique !== h.toLowerCase()) {
        throw new Error(t('bundler.config.forward-origin-trusted-host-non-canonique', { index: i, valeur: JSON.stringify(h), canonique }))
      }
      // Hôte ACCEPTÉ (regex + forme canonique) mais TOUJOURS
      // bloqué à l'exécution par `isBlockedForwardTarget` (server/forward-origin.ts, défense en
      // profondeur SSRF — loopback, réseaux privés, lien-local, métadonnées cloud…) : avertissement
      // NON bloquant, pas un throw (même canal direct que `validateRuntimeConfig` ci-dessus —
      // ICI un seul appel, jamais de risque de double avertissement, donc pas besoin du détour par
      // un tableau `warnings` renvoyé à l'appelant comme `expandRuntimePresets`). Sans ce signal, le
      // dev croit avoir autorisé un hôte qui n'activera jamais rien.
      if (isBlockedForwardTarget(canonique)) {
        console.warn(t('bundler.config.forward-origin-trusted-host-interne', { index: i, valeur: JSON.stringify(h) }))
      }
    }
    return
  }
  throw new Error(t('bundler.config.forward-origin-type-invalide', { valeur: JSON.stringify(fo), type: typeof fo }))
}

/**
 * Valide le bloc `render` (pages pilotées par config + moteur de rendu).
 * Structure attendue : `{ default?, header?, outDir?, routes?: { <url>: {
 * component, mode?, settleMs?, engine? } }, locales?: string[], engine?:
 * { prerender?, request? }, browserPool?: { size?, keepAlive?, maxAgeMs? },
 * forwardOrigin? }` (forwardOrigin : booléen | origine fixe (chaîne) |
 * `{ trustedHosts }`, cf. `validateForwardOrigin`). Toute clé/valeur inconnue
 * lève (comme le reste du config, strict).
 */
/**
 * Chemin RÉEL d'un chemin qui n'existe pas forcément encore : `realpath` du plus proche ancêtre
 * EXISTANT, suivi des segments restants. Un dossier de sortie absent au tout premier build doit
 * rester comparable, et un lien symbolique quelque part sur la chaîne doit être suivi. Aucun
 * ancêtre lisible (droits, chemin fantôme) : le chemin est rendu tel quel, jamais une exception —
 * la garde retombe alors sur la comparaison lexicale, son comportement d'avant.
 */
function cheminReel(chemin: string): string {
  let tete = chemin
  const restes: string[] = []
  for (;;) {
    try { return join(realpathSync(tete), ...restes) } catch { /* pas encore là */ }
    const parent = dirname(tete)
    if (parent === tete) return chemin
    restes.unshift(basename(tete))
    tete = parent
  }
}

function validateRenderConfig(render: any, path: string): void {
  if (typeof render !== 'object' || render === null || Array.isArray(render)) {
    throw new Error(t('bundler.config.render-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(render)) {
    if (!KNOWN_RENDER_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `render.${k}`, valides: Array.from(KNOWN_RENDER_KEYS).join(', ') }))
    }
  }
  if (render.default !== undefined && !VALID_RENDER_MODES.has(render.default)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'render.default', valeur: render.default, valides: Array.from(VALID_RENDER_MODES).join(', ') }))
  }
  if (render.startup !== undefined && !VALID_STARTUP_MODES.has(render.startup)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'render.startup', valeur: render.startup, valides: Array.from(VALID_STARTUP_MODES).join(', ') }))
  }
  if (render.header !== undefined && typeof render.header !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine-simple', { cle: 'render.header', chemin: path }))
  }
  if (render.outDir !== undefined && typeof render.outDir !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine-simple', { cle: 'render.outDir', chemin: path }))
  }
  // `render.outDir` est le dossier que le prérendu ÉCRIT et dont il RETIRE ses fragments périmés (cf.
  // server/prerender.ts) : il doit rester DANS le projet. Un `..`, ou un chemin absolu ailleurs,
  // porterait ces deux gestes hors de l'arbre que le développeur a sous les yeux — refusé à la
  // lecture de la configuration, jamais découvert au premier fichier supprimé. La racine du projet
  // elle-même (`'.'`) reste permise : un site dont la coquille vit à la racine l'utilise.
  if (typeof render.outDir === 'string') {
    // Chemins RÉELS des deux côtés : un LIEN SYMBOLIQUE posé dans le projet et pointant ailleurs
    // passait la comparaison de chaînes — le prérendu écrivait et supprimait alors hors de l'arbre,
    // ce que cette garde existe précisément pour empêcher. Même idiome que la purge des orphelins.
    const projet = cheminReel(dirname(path))
    const cible  = cheminReel(resolve(dirname(path), render.outDir))
    if (cible !== projet && !cible.startsWith(projet + sep)) {
      throw new Error(t('bundler.config.render-outdir-hors-projet', { valeur: render.outDir, chemin: projet }))
    }
  }
  if (render.target !== undefined && (typeof render.target !== 'string' || render.target.length === 0)) {
    throw new Error(t('bundler.config.render-target-invalide', { valeur: JSON.stringify(render.target) }))
  }
  if (render.method !== undefined && !VALID_RENDER_METHODS.has(render.method)) {
    throw new Error(t('bundler.config.valeur-invalide-simple', { cle: 'render.method', valeur: render.method, valides: Array.from(VALID_RENDER_METHODS).join(', ') }))
  }
  if (render.cache !== undefined && !VALID_RENDER_CACHE_POLICIES.has(render.cache)) {
    throw new Error(t('bundler.config.render-cache-invalide', { valeur: render.cache, valides: Array.from(VALID_RENDER_CACHE_POLICIES).join(', ') }))
  }
  if (render.routes !== undefined) {
    if (typeof render.routes !== 'object' || render.routes === null || Array.isArray(render.routes)) {
      throw new Error(t('bundler.config.render-routes-doit-etre-objet', { chemin: path }))
    }
    for (const url of Object.keys(render.routes)) {
      const route = render.routes[url]
      if (typeof route !== 'object' || route === null || Array.isArray(route)) {
        throw new Error(t('bundler.config.route-doit-etre-objet', { url }))
      }
      for (const k of Object.keys(route)) {
        if (!KNOWN_ROUTE_KEYS.has(k)) {
          throw new Error(t('bundler.config.cle-inconnue', { cle: `render.routes['${url}'].${k}`, valides: Array.from(KNOWN_ROUTE_KEYS).join(', ') }))
        }
      }
      if (typeof route.component !== 'string' || !route.component) {
        throw new Error(t('bundler.config.route-component-requis', { url }))
      }
      if (route.mode !== undefined && !VALID_RENDER_MODES.has(route.mode)) {
        throw new Error(t('bundler.config.valeur-invalide-simple', { cle: `render.routes['${url}'].mode`, valeur: route.mode, valides: Array.from(VALID_RENDER_MODES).join(', ') }))
      }
      if (route.settleMs !== undefined) {
        if (typeof route.settleMs !== 'number' || !Number.isInteger(route.settleMs) || route.settleMs <= 0) {
          throw new Error(t('bundler.config.entier-positif-invalide', { cle: `render.routes['${url}'].settleMs`, valeur: JSON.stringify(route.settleMs), type: typeof route.settleMs }))
        }
      }
      if (route.engine !== undefined && !VALID_RENDER_ENGINES.has(route.engine)) {
        throw new Error(t('bundler.config.valeur-invalide-simple', { cle: `render.routes['${url}'].engine`, valeur: route.engine, valides: Array.from(VALID_RENDER_ENGINES).join(', ') }))
      }
      if (route.startup !== undefined && !VALID_STARTUP_MODES.has(route.startup)) {
        throw new Error(t('bundler.config.valeur-invalide-simple', { cle: `render.routes['${url}'].startup`, valeur: route.startup, valides: Array.from(VALID_STARTUP_MODES).join(', ') }))
      }
      if (route.light !== undefined && typeof route.light !== 'boolean') {
        throw new Error(t('bundler.config.doit-etre-booleen-simple', { cle: `render.routes['${url}'].light`, valeur: JSON.stringify(route.light), type: typeof route.light }))
      }
      // `light` décrit comment le SERVEUR monte la racine : une route `csr` n'est jamais rendue
      // au serveur, la clé n'y change donc rien. Avertissement NON bloquant (la configuration
      // reste valide, même canal direct que l'hôte interne de `forwardOrigin` plus bas) : sans
      // lui, le dev croit avoir demandé un fragment léger là où aucun fragment n'est produit.
      if (route.light === true && normalizeMode(route.mode ?? render.default ?? FALLBACK_MODE) === 'csr') {
        console.warn(t('bundler.config.route-light-sans-effet-csr', { url }))
      }
    }
    // Nom du fichier de page (cf. startupSlug) : deux routes PRÉRENDUES qui en demandent un et
    // normalisent vers le même nom se le disputeraient — `writeHashed` n'écrit qu'un fichier par
    // nom de base, la seconde effacerait l'assemblage de la première et son fragment pointerait
    // alors des composants qu'il n'affiche pas. Refusé ici, le seul endroit où toutes les routes
    // sont en portée ensemble. Les langues d'une même route partagent la MÊME URL : jamais une
    // collision. Une route qui ne produit pas de fichier de page (autre mode de démarrage, route
    // paramétrée, page non prérendue) n'entre pas dans le compte.
    const parSlug = new Map<string, string[]>()
    for (const url of Object.keys(render.routes)) {
      const route = render.routes[url]
      if ((route.startup ?? render.startup) !== 'bundle') continue
      if (!isBuildPrerenderable(url, normalizeMode(route.mode ?? render.default ?? FALLBACK_MODE))) continue
      const slug = startupSlug(url)
      parSlug.set(slug, [...(parSlug.get(slug) ?? []), url])
    }
    for (const [slug, urls] of parSlug) {
      if (urls.length > 1) {
        throw new Error(t('bundler.config.startup-slug-collision', { slug, urls: urls.join(', ') }))
      }
    }
  }
  if (render.locales !== undefined) {
    if (!Array.isArray(render.locales)) {
      throw new Error(t('bundler.config.locales-invalide', { valeur: JSON.stringify(render.locales), type: typeof render.locales, chemin: path }))
    }
    for (const l of render.locales) {
      if (typeof l !== 'string' || !l) {
        throw new Error(t('bundler.config.locale-item-invalide', { valeur: JSON.stringify(l), type: typeof l }))
      }
    }
  }
  if (render.engine !== undefined) {
    validateRenderEngineConfig(render.engine, path)
  }
  if (render.browserPool !== undefined) {
    validateBrowserPoolConfig(render.browserPool, path)
  }
  if (render.renderQueue !== undefined) {
    validateRenderQueueConfig(render.renderQueue, path)
  }
  if (render.forwardOrigin !== undefined) {
    validateForwardOrigin(render.forwardOrigin)
  }
  // `allowedOrigins`/`entry` sont dans KNOWN_RENDER_KEYS depuis le début
  // (seule leur PRÉSENCE était vérifiée) mais jamais typés, contrairement à `forwardOrigin`
  // (même bloc) et `ws.entry`/`serveur.entry` (même nom que `entry`) : le repli runtime d'un
  // `allowedOrigins` mal typé est documenté sûr (same-origin strict), mais silencieux — zéro
  // signal pour le dev qui croit avoir configuré une liste blanche.
  if (render.allowedOrigins !== undefined && render.allowedOrigins !== false) {
    if (!Array.isArray(render.allowedOrigins)) {
      throw new Error(t('bundler.config.allowed-origins-invalide', { valeur: JSON.stringify(render.allowedOrigins), type: typeof render.allowedOrigins }))
    }
    for (let i = 0; i < render.allowedOrigins.length; i++) {
      const o = render.allowedOrigins[i]
      if (typeof o !== 'string' || !o) {
        throw new Error(t('bundler.config.allowed-origins-item-invalide', { index: i, valeur: JSON.stringify(o), type: typeof o }))
      }
    }
  }
  if (render.entry !== undefined && typeof render.entry !== 'string') {
    throw new Error(t('bundler.config.doit-etre-chaine', { cle: 'render.entry', valeur: JSON.stringify(render.entry), type: typeof render.entry }))
  }
}

/**
 * Valide le bloc `render.engine` (moteur de rendu, deux axes indépendants
 * prerender/request). Sous-clé inconnue ou valeur hors liste = échec immédiat.
 */
function validateRenderEngineConfig(engine: any, path: string): void {
  if (typeof engine !== 'object' || engine === null || Array.isArray(engine)) {
    throw new Error(t('bundler.config.render-engine-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(engine)) {
    if (!KNOWN_RENDER_ENGINE_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `render.engine.${k}`, valides: Array.from(KNOWN_RENDER_ENGINE_KEYS).join(', ') }))
    }
  }
  for (const axis of ['prerender', 'request'] as const) {
    if (engine[axis] !== undefined && !VALID_RENDER_ENGINES.has(engine[axis])) {
      throw new Error(t('bundler.config.valeur-invalide-simple', { cle: `render.engine.${axis}`, valeur: engine[axis], valides: Array.from(VALID_RENDER_ENGINES).join(', ') }))
    }
  }
}

/**
 * Valide le bloc `render.browserPool` (pool d'instances navigateur, moteur
 * `'browser'`). Clé inconnue ou type/valeur invalide = échec immédiat.
 */
function validateBrowserPoolConfig(pool: any, path: string): void {
  if (typeof pool !== 'object' || pool === null || Array.isArray(pool)) {
    throw new Error(t('bundler.config.browserpool-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(pool)) {
    if (!KNOWN_BROWSER_POOL_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `render.browserPool.${k}`, valides: Array.from(KNOWN_BROWSER_POOL_KEYS).join(', ') }))
    }
  }
  if (pool.size !== undefined) {
    if (typeof pool.size !== 'number' || !Number.isInteger(pool.size) || pool.size < 1) {
      throw new Error(t('bundler.config.browserpool-size-invalide', { valeur: JSON.stringify(pool.size), type: typeof pool.size }))
    }
  }
  if (pool.keepAlive !== undefined && typeof pool.keepAlive !== 'boolean') {
    throw new Error(t('bundler.config.doit-etre-booleen', { cle: 'render.browserPool.keepAlive', valeur: JSON.stringify(pool.keepAlive), type: typeof pool.keepAlive }))
  }
  if (pool.maxAgeMs !== undefined) {
    if (typeof pool.maxAgeMs !== 'number' || !Number.isInteger(pool.maxAgeMs) || pool.maxAgeMs < 0) {
      throw new Error(t('bundler.config.browserpool-maxagems-invalide', { valeur: JSON.stringify(pool.maxAgeMs), type: typeof pool.maxAgeMs }))
    }
  }
  // le plafond de rendu était DÉCLARÉ au type et CONSOMMÉ à l'exécution (défaut 15 s,
  // cf. render-browser.ts) mais absent de la liste blanche : l'écrire dans
  // mjs.config.json faisait échouer le build sur « clé inconnue », le réglage n'étant
  // atteignable qu'en appelant le moteur depuis du code
  if (pool.renderTimeoutMs !== undefined) {
    if (typeof pool.renderTimeoutMs !== 'number' || !Number.isInteger(pool.renderTimeoutMs) || pool.renderTimeoutMs < 1) {
      throw new Error(t('bundler.config.browserpool-rendertimeoutms-invalide', { valeur: JSON.stringify(pool.renderTimeoutMs), type: typeof pool.renderTimeoutMs }))
    }
  }
}

/**
 * Valide le bloc `render.renderQueue` (plafond de concurrence/file
 * d'attente du rendu SSR par requête, cf. RenderGate, render-request.ts) : lu en souple
 * (`as any`, défauts 4/32) — cette clé restait absente de la liste blanche, la déclarer au
 * mjs.config.json faisait échouer TOUT le build sur « clé inconnue ». Même patron que
 * `validateBrowserPoolConfig` ci-dessus.
 */
function validateRenderQueueConfig(queue: any, path: string): void {
  if (typeof queue !== 'object' || queue === null || Array.isArray(queue)) {
    throw new Error(t('bundler.config.renderqueue-doit-etre-objet', { chemin: path }))
  }
  for (const k of Object.keys(queue)) {
    if (!KNOWN_RENDER_QUEUE_KEYS.has(k)) {
      throw new Error(t('bundler.config.cle-inconnue', { cle: `render.renderQueue.${k}`, valides: Array.from(KNOWN_RENDER_QUEUE_KEYS).join(', ') }))
    }
  }
  if (queue.concurrency !== undefined) {
    if (typeof queue.concurrency !== 'number' || !Number.isInteger(queue.concurrency) || queue.concurrency < 1) {
      throw new Error(t('bundler.config.renderqueue-concurrency-invalide', { valeur: JSON.stringify(queue.concurrency), type: typeof queue.concurrency }))
    }
  }
  if (queue.maxQueue !== undefined) {
    if (typeof queue.maxQueue !== 'number' || !Number.isInteger(queue.maxQueue) || queue.maxQueue < 0) {
      throw new Error(t('bundler.config.renderqueue-maxqueue-invalide', { valeur: JSON.stringify(queue.maxQueue), type: typeof queue.maxQueue }))
    }
  }
}

export function findConfig(startDir: string = process.cwd()): {
  config: MjsConfig
  configDir: string
} | null {
  let dir = resolve(startDir)
  while (true) {
    const candidate = join(dir, 'mjs.config.json')
    if (existsSync(candidate)) {
      try {
        const raw = readFileSync(candidate, 'utf-8')
        const config = JSON.parse(raw)
        setMessagesLang((config as { lang?: unknown }).lang)
        validateConfig(config, candidate)
        return { config: config as MjsConfig, configDir: dir }
      } catch (e: any) {
        if (e.message.startsWith('[mjs.config.json]')) throw e
        // SEULE erreur du fichier hors catalogue (sur 185 `throw new
        // Error(...)`, 184 passaient déjà par t('bundler.config....')) : toujours en anglais brut,
        // même `lang: 'fr'` réglé par ailleurs (le message le plus probable pour un débutant, au
        // tout premier mjs.config.json).
        throw new Error(t('bundler.config.parse-error', { chemin: candidate, erreur: e.message }))
      }
    }
    const parent = dirname(dir)
    if (parent === dir) return null
    dir = parent
  }
}

/**
 * Résout les paths du config relativement à `configDir` et retourne un objet
 * prêt à passer à `new Bundler(...)`.
 */
export function resolveBundlerOpts(config: MjsConfig, configDir: string) {
  const r = (p: string | undefined) => p ? resolve(configDir, p) : undefined
  return {
    sourceDir:        r(config.sourceDir),
    outputDir:        r(config.outputDir),
    manifestPath:     r(config.manifestPath),
    manifestExternal: r(config.manifestExternal),
    stylesheetsDir:   r(config.stylesheetsDir),
    // cf. le commentaire de MjsConfig.runtimeDir :
    // validé par KNOWN_KEYS mais jamais résolu/retourné ici, donc jamais transmis
    // au Bundler. Option silencieusement inerte.
    runtimeDir:       r(config.runtimeDir),
    urlPrefix:        config.urlPrefix,
    // `languages.script` prime sur l'ancienne
    // clé si posé (validateConfig garantit qu'elles sont alors ÉGALES si les
    // deux sont présentes, donc l'ordre de priorité ne change rien au résultat).
    defaultScriptLang: config.languages?.script ?? config.defaultScriptLang,
    // `languages.template` : grammaire interpolations/handlers, ENCORE INUTILISÉE
    // en aval (briques suivantes) — défaut 'civet' appliqué côté transpiler
    // (point unique), jamais ici : `undefined` = "non configuré".
    templateLang:     config.languages?.template,
    sigil:            config.sigil,
    contextAlias:     config.contextAlias,
    varPrefix:        config.varPrefix,
    defaultTheme:     config.defaultTheme,
    preload:          config.preload,
    viewTransition:   config.viewTransition,
    logLevel:         config.logLevel,
    maxStateVars:     config.lint?.maxStateVars,
    a11y:             config.lint?.a11y,
    ujsForm:          config.lint?.ujsForm,
    // `minify` ne DÉCIDE PAS de l'environnement : `'auto'` (défaut) suit le
    // mode du build, `true`/`false` forcent. L'environnement, lui, vient de la COMMANDE
    // (`mjs build --prod`) et n'est donc PAS résolu ici (cf. `Bundler.isProd`).
    minify:           config.minify ?? 'auto',
    devPort:          config.dev?.port,
    devHost:          config.dev?.host,
    // `'all'`/`'core'` intacts (pas un tableau) ; un tableau est déplié via `expandRuntimePresets`
    // (préréglages RUNTIME_PRESETS → leurs modules, dédupliqués) — c'est cette valeur EXPANSÉE,
    // pas `config.runtime` brut, qui atteint le Bundler/resolveRuntimeFiles (bundler/index.ts),
    // qui ne connaît lui-même AUCUN préréglage. `config.runtime` déjà validé en amont
    // (findConfig → validateConfig → validateRuntimeConfig, même expansion, seul point
    // d'avertissement — ici on ne fait que ré-appliquer la MÊME fonction pure, sans avertir).
    runtime: Array.isArray(config.runtime) ? expandRuntimePresets(config.runtime).modules : config.runtime,
    css: config.css,
    js: config.js,
    csp: config.csp,
    sourceMap: config.sourceMap,
    image: config.image,
    i18n: config.i18n,
    // le Bundler n'en lit QUE les modes, pour embarquer ou non le module d'hydratation
    // (cf. BundlerOpts.render) ; aucun chemin à résoudre ici, le prérendu et le serveur de
    // rendu lisent le bloc entier de leur côté.
    render: config.render,
  }
}
