// server/render-browser — MOTEUR NAVIGATEUR du rendu serveur (Option A : vrai
// Chromium, via Playwright).
//
// Complète renderToString.ts (moteur happy-dom, DOM simulé) par un SECOND moteur,
// à fidélité maximale : un VRAI Chromium charge le bundle compilé exactement comme
// le ferait un visiteur (mêmes fichiers, mêmes imports ES natifs, AUCUNE des
// transformations SSR-only de renderToString.ts — stripEsm/ssrScopeFile/topoSort
// n'existent QUE parce que happy-dom n'a pas de chargeur de modules ; un vrai
// navigateur en a un, natif, donc on sert le bundle TEL QUEL). Conséquence directe
// et VOULUE : `µmount`/`µawake` s'exécutent pour de vrai (contrairement au SSR
// happy-dom, où `µ._isServer=true` les court-circuite) — c'est tout le point de ce
// moteur. Corollaire à connaître : un composant dont `@mount` fait un vrai fetch()/
// ouvre un vrai WebSocket le fera aussi pendant CE rendu (prérendu ou par requête) —
// comportement attendu d'un « vrai client », pas une fuite à colmater ici.
//
// AMORÇAGE — `page.route` sur une origine FACTICE (`http://mjs-render.invalid`,
// TLD réservé RFC 2606 : ne résout jamais en DNS réel) qui sert les fichiers de
// `outputDir` tels qu'un serveur de prod le ferait, PLUTÔT que `page.setContent` +
// bundle inliné. Deux raisons :
//   1. Le bundle compilé référence ses propres imports par URL PUBLIQUE
//      (`${urlPrefix}/xxx-<hash>.js`, cf. Bundler.writeHashed) — les servir tels
//      quels évite toute réécriture d'import (ce que stripEsm/ssrScopeFile doivent
//      faire pour happy-dom) : zéro transformation, fidélité totale.
//   2. Sondé empiriquement : `page.setContent()` sur une
//      page qui n'a JAMAIS navigué ne déclenche pas de façon fiable les scripts
//      `addInitScript` — nécessaires ici pour forcer les Shadow DOM 'open' (cf.
//      plus bas). Une VRAIE navigation (`page.goto`), même vers une origine
//      interceptée, les déclenche systématiquement.
//
// SHADOW DOM — mjs_element.ts attache TOUJOURS le Shadow DOM en mode 'closed'
// (encapsulation cliente voulue, cf. son commentaire). Mais `getHTML()` (cf. plus
// bas) reflète le mode RÉEL du shadow au moment de l'appel — un DSD
// `shadowrootmode="closed"` est EXACTEMENT la forme que mjs_element.ts ne sait PAS
// adopter côté client (`.shadowRoot` renvoie toujours `null` en mode closed, même
// pour un shadow posé par le parseur) → hydratation cassée (cf. l'avertissement
// jumeau dans renderToString.ts). On applique donc le correctif déjà connu
// pour l'inspection d'un shadow closed : un `addInitScript` patche `Element.prototype.
// attachShadow` pour forcer `mode:'open'` AVANT que le bundle ne s'exécute — le
// shadow réellement attaché est donc 'open', et `getHTML()` émet alors
// `shadowrootmode="open"` NATIVEMENT, sans le moindre post-traitement de chaîne.
// Sans incidence fonctionnelle : MJS n'utilise JAMAIS `.shadowRoot` en interne
// (toujours sa propre référence `_shadow`) — 'closed' n'est qu'un choix
// d'encapsulation vis-à-vis d'un script TIERS, jamais une nécessité de son propre
// fonctionnement.
//
// SÉRIALISATION — `Element.prototype.getHTML({serializableShadowRoots,
// shadowRoots})` : sondé empiriquement disponible (Chromium bundlé par Playwright
// 1.59 — repli documenté si absent un jour : sérialiseur
// récursif manuel, cf. `mjsSsrPrepareAndSerialize` qui reste le point d'entrée
// unique à remplacer). Contrairement à `el._shadow.innerHTML` (utilisé par
// renderToString.ts, qui ne descend JAMAIS dans le shadow d'un DESCENDANT — limite
// documentée, « un seul niveau », cf. ssr-nested-await-settle.test.ts), `getHTML()`
// avec la liste EXPLICITE des shadow roots collectés (récursivement, même parcours
// que `collectAwaitStates`) sérialise l'arbre ENTIER en un seul appel — sous-
// composants imbriqués inclus, avec leurs PROPRES gabarits `<template
// shadowrootmode>`. Amélioration NATURELLE (pas un hack) : c'est ce qu'un vrai
// navigateur sait faire nativement. `adoptedStyleSheets` reste hors du périmètre de
// `getHTML()` (comme de `innerHTML`) : le CSS scopé de CHAQUE composant rencontré
// est inliné comme un VRAI nœud `<style>` (1er enfant de son shadow) avant l'appel
// — capturé alors naturellement, à tous les niveaux.
//
// POOL — un navigateur Chromium (processus) coûte cher à lancer (~200-500ms) ; une
// PAGE beaucoup moins. `browserPool.size` emplacements (contexte + page) sont donc
// réutilisés (checkout/release façon pool de connexions) plutôt que recréés à
// chaque rendu ; chacun sur son PROPRE BrowserContext (isolation cookies/storage
// entre deux rendus qui partagent l'emplacement). Une re-NAVIGATION (pas une
// recréation) suffit à repartir d'un état JS vierge (nouveau Realm) entre deux
// rendus du MÊME emplacement — c'est elle qui fait le gros du travail d'isolation ;
// `localStorage`/`sessionStorage` (qui SURVIVENT à une navigation, même origine)
// sont vidés explicitement en plus. `keepAlive:false` désactive la réutilisation du
// PROCESSUS navigateur lui-même (fermé + relancé à chaque rendu — coûteux, isolation
// maximale). `maxAgeMs` recycle un emplacement trop ancien (hygiène mémoire sur un
// serveur longue durée).

import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { createRequire } from 'node:module'
import type { MjsConfig, RenderEngine, RenderBrowserPoolConfig } from '../bundler/config.js'
import { resolveBundlerOpts } from '../bundler/config.js'
import { Bundler } from '../bundler/index.js'
import { ssrCoreOf, collectAwaitStates, hasPendingAwait, settleRender, type RenderOptions, type RenderResult } from './renderToString.js'
import { isWithinDir, isRealPathWithin, MIME } from './render-server.js'
import { writeHashedAsset } from './ssr-head.js'
import { openRenderCompileDir } from './render-compile-dir.js'
import { t } from '../messages/index.js'
// (SSRF) — même défense en profondeur que renderToString.ts
// (cf. son commentaire d'import) : un `forwardedUrl` pointant vers une cible
// réseau interne ne doit JAMAIS armer le proxy `routeHandler`, même passé
// DIRECTEMENT à `renderPage` (API publique) sans passer par
// `computeForwardedOrigin`. Cf. forward-origin.ts pour le détail des plages.
import { isBlockedForwardTarget } from './forward-origin.js'

// Alias LOCAUX — jamais `import type … from 'playwright'` : même en ABSENCE du
// paquet (npm i -D playwright non lancé), ce fichier doit rester typable
// (tsc --noEmit) — importer SES types casserait exactement la dégradation
// gracieuse que ce fichier construit plus bas (résolution paresseuse).
type PwBrowser = any
type PwBrowserContext = any
type PwPage = any

// ============================================================================
// 1. RÉSOLUTION PARESSEUSE DE PLAYWRIGHT
// ============================================================================
// JAMAIS d'import top-level dur : un projet 100% happy-dom ne doit jamais être
// contraint d'avoir Playwright résolvable. Mémoïsée (la résolution d'un module ne
// change pas en cours de process) — un seul essai réel, quel que soit le nombre
// d'appelants (resolveEngine ET createBrowserRenderer partagent ce cache).
let cachedPlaywright: Promise<any | null> | null = null

/**
 * Résout le module `playwright`, ou `null` si absent/non installé. Deux essais :
 * `import()` dynamique standard (résout depuis CE fichier — suffisant ici,
 * `playwright` est une devDependency du framework lui-même, présente dans SON
 * propre node_modules, retrouvée par la remontée standard de résolution ESM quel
 * que soit le cwd de l'appelant), puis repli `createRequire` scopé sur ce même
 * fichier — motif identique à un script qui vit HORS de l'arbre du framework et en
 * a besoin pour se résoudre, gardé ici en ceinture-bretelles pour des
 * résolutions ESM plus exotiques (pnpm strict,
 * symlinks…). Ne lève JAMAIS : une absence réelle se traduit par `null`, à charge
 * de l'appelant de décider (erreur franche si le moteur browser a été
 * explicitement demandé, repli silencieux vers happy-dom sinon — cf. `resolveEngine`).
 */
export async function resolveBrowserEngine(): Promise<any | null> {
  if (!cachedPlaywright) {
    cachedPlaywright = (async () => {
      try {
        return await import('playwright')
      } catch {
        try {
          return createRequire(import.meta.url)('playwright')
        } catch {
          return null
        }
      }
    })()
  }
  return cachedPlaywright
}

// ============================================================================
// 2. RÉSOLUTION DU MOTEUR — priorité route > config > défaut
// ============================================================================
// Avertissement UNE fois par process (jamais par page/route) : un `mjs dev` qui
// recompile en boucle sans Playwright installé ne doit pas spammer la console à
// chaque sauvegarde. Même motif que `warnedFiles` (languages/coffee.ts).
let warnedPrerenderFallback = false

export interface ResolveEngineOptions {
  /** Sonde injectable (tests) : remplace `resolveBrowserEngine()` par un stub — le
   *  test de résolution pure tourne alors sans Playwright ni navigateur réel. */
  probeBrowserAvailable?: () => Promise<boolean>
  /** Émetteur du message informatif de repli (défaut `console.log`, injectable
   *  pour les tests — jamais de log parasite dans une suite verte). */
  log?: (msg: string) => void
}

/**
 * Résout le moteur de rendu effectif pour un AXE (`prerender` au build/dev-
 * recompile, `request` au serveur par requête) : priorité `route.engine` >
 * `render.engine[kind]` (config globale) > défaut. Défauts DÉCIDÉS : `request` →
 * toujours `'happy-dom'` (jamais de navigateur en défaut IMPLICITE par requête —
 * trop coûteux à lancer à la volée sans configuration explicite de l'auteur du
 * projet) ; `prerender` → `'browser'` SI Playwright est résolvable, sinon repli
 * `'happy-dom'` (avec message informatif, une fois par process).
 *
 * `route` n'a besoin que du champ `engine` (accepte aussi bien un `RenderRoute`
 * qu'un `ResolvedPage` — les deux le portent, cf. render-routes.ts) : couplage
 * minimal, structurel plutôt que nominal.
 */
export async function resolveEngine(
  kind: 'prerender' | 'request',
  config: MjsConfig,
  route?: { engine?: RenderEngine },
  opts: ResolveEngineOptions = {},
): Promise<RenderEngine> {
  if (route?.engine) return route.engine
  const configured = config.render?.engine?.[kind]
  if (configured) return configured
  if (kind === 'request') return 'happy-dom'
  const probe = opts.probeBrowserAvailable ?? (async () => (await resolveBrowserEngine()) !== null)
  if (await probe()) return 'browser'
  if (!warnedPrerenderFallback) {
    warnedPrerenderFallback = true
    const log = opts.log ?? ((msg: string) => console.log(msg))
    log(t('server.browser-prerender-happydom-fallback'))
  }
  return 'happy-dom'
}

// ============================================================================
// 3. FONCTIONS PAGE-SIDE (exécutées DANS le navigateur, jamais ici)
// ============================================================================
// Écrites comme de VRAIES fonctions TS (typées `any` — aucune API Node dedans),
// injectées plus bas via `.toString()` dans la page réelle. Volontaire : écrire du
// JS-dans-une-chaîne-TS imposerait un double niveau d'échappement (regex/quotes
// dans une template string) fragile et illisible ; `.toString()` sur une VRAIE
// fonction reproduit son code source fidèlement, sans le moindre échappement manuel.

// Neutralise `</style` dans un CSS scopé avant de l'inliner (round-trip sûr : `\/`
// est un échappement CSS VALIDE, round-trip exact, aucun changement de valeur
// calculée) — même parade que renderToString.ts (m5), nécessaire ici aussi car le
// résultat repasse par une sérialisation `getHTML()` qui, comme `innerHTML`, ne
// ré-échappe pas le contenu d'un élément `<style>` (élément « raw text »).
function mjsSsrSafeCss(css: any): string {
  return String(css).replace(/<\/(style)/gi, '<\\/$1')
}

// Feuille scopée et mode light d'un composant monté, lus par l'accès à nom LONG que le runtime
// expose (`µ._ssrInfo`, runtime/mjs_element.ts — ici `window.__mjsCore`, cf. `bootHtml`). Les
// propriétés internes `_mjs_*` portent un nom RACCOURCI dès que le bundle est minifié (production,
// esbuild mangleProps) : cette page charge le bundle TEL QUEL, les nommer depuis ce code injecté ne
// rendrait rien — le `<style>` du `<template shadowrootmode>` comme le mode light partiraient en
// silence. `baseCss` est rendu BRUT (le trim appartient à chaque point d'usage).
function mjsSsrInfo(el: any): { baseCss: string; isLight: boolean; nodes: any } {
  const info = (window as any).__mjsCore._ssrInfo(el)
  return { baseCss: info.baseCss == null ? '' : String(info.baseCss), isLight: info.isLight === true, nodes: info.nodes }
}

// Marque chaque élément `mjs-*` de l'arbre rendu (attribut `mjs-ssr`, vide) : c'est ce que le
// bouclier anti-FOUC du cœur épargne (`:not(:defined):not([mjs-ssr])`, runtime/mjs_init.ts) — le
// balisage peint par le serveur reste à l'écran jusqu'à ce que le premier rendu client le remplace.
// Même convention que renderToString.ts (`markSsrTree`), posée ici dans le MÊME parcours que les
// `<style>` et les marqueurs d'hydratation.
function mjsSsrMarkTree(el: any): void {
  if (el.setAttribute && el.tagName && String(el.tagName).toUpperCase().indexOf('MJS-') === 0) el.setAttribute('mjs-ssr', '')
}

// Marque un nœud réactif pour l'hydratation 'markers' — même convention que
// renderToString.ts (attribut `mjs-h` sur élément, commentaire `mjs-h:<clé>` juste
// avant un nœud texte).
function mjsSsrMarkNode(n: any, key: string): void {
  if (n.nodeType === 1 && n.setAttribute) {
    n.setAttribute('mjs-h', key)
  } else if (n.nodeType === 3 && n.parentNode) {
    n.parentNode.insertBefore(document.createComment('mjs-h:' + key), n)
  }
}

// Force TOUT Shadow DOM attaché dans cette page à 'open' — cf. en-tête de fichier
// (section SHADOW DOM). Posée via `context.addInitScript`, donc AVANT tout script
// de la page. Sans incidence fonctionnelle sur MJS (toujours `_shadow`, jamais
// `.shadowRoot`, en interne).
function mjsSsrForceOpenShadow(): void {
  const orig = Element.prototype.attachShadow
  Element.prototype.attachShadow = function (init: any) {
    return orig.call(this, Object.assign({}, init, { mode: 'open' }))
  }
}

// (mode `csp`) — PREMIÈRE PASSE, lecture seule (aucune mutation du DOM) : collecte le CSS
// scopé de chaque shadow rencontré, DANS L'ORDRE de `walk()` — le MÊME ordre que celui que
// `mjsSsrPrepareAndSerialize` reparcourt ensuite pour poser les `<link>` (cf. son propre
// commentaire). Nécessaire car les URLs hashées se calculent côté NODE (écriture fichier,
// `writeHashedAsset`, hors de la page) : impossible de les connaître AVANT ce premier passage.
function mjsSsrCollectCss(root: any): { css: string; tag: string }[] {
  const list: { css: string; tag: string }[] = []
  const vus: any = {}
  function walk(el: any): void {
    if (!el) return
    const isShadow = !!(el._shadow && el._shadow !== el)
    if (isShadow) {
      const css = mjsSsrInfo(el).baseCss
      if (css.trim() !== '') list.push({ css, tag: String(el.tagName).toLowerCase() })
    } else {
      const orphelin = mjsSsrOrphanLightCss(el, vus, true)
      if (orphelin !== '') list.push({ css: orphelin, tag: String(el.tagName).toLowerCase() })
    }
    if (isShadow) { for (let i = 0; i < el._shadow.children.length; i++) walk(el._shadow.children[i]) }
    if (el.children) { for (let j = 0; j < el.children.length; j++) walk(el.children[j]) }
  }
  walk(root)
  return list
}

// Feuille d'un composant LÉGER que le fragment doit emporter LUI-MÊME, chaîne vide sinon.
// Un léger n'a pas d'hôte à qui adopter sa feuille : le runtime la dépose dans le shadow de son
// ancêtre quand il en a un (elle est alors sérialisée avec ce shadow, rien à faire ici), sinon
// dans le `document.head` — que le fragment n'emporte pas. `:host` y est réécrit en nom de balise,
// comme le fait le runtime, faute d'hôte réel à désigner. Une balise n'est comptée qu'UNE fois
// (`vus`) : plusieurs instances d'un même composant léger ne dupliquent pas la règle.
// `vus` est propre à UNE passe : les deux passes du mode `csp` (collecte puis pose) parcourent le
// même arbre dans le même ordre avec leur propre table, et voient donc la MÊME liste — c'est ce qui
// apparie chaque feuille à son URL.
function mjsSsrOrphanLightCss(el: any, vus: any, marquer?: boolean): string {
  if (!el._shadow || el._shadow !== el) return ''
  const racine = el.getRootNode ? el.getRootNode() : null
  if (racine && racine.host) return ''
  const tag = String(el.tagName).toLowerCase()
  if (vus[tag]) return ''
  const css = mjsSsrInfo(el).baseCss
  if (css.trim() === '') return ''
  if (marquer) vus[tag] = true
  return String((window as any).__mjsCore._lightHostCss(css, tag))
}

// Parcourt la RACINE + tous les sous-composants (shadow ET light — même structure
// que `collectAwaitStates` : `_shadow !== el` évite de redescendre deux fois en
// mode light, où `_shadow === el`) : inline le CSS scopé de chaque shadow
// rencontré (adoptedStyleSheets invisible à `getHTML()`, comme à `innerHTML` — cf.
// en-tête de fichier), pose les marqueurs 'markers' si demandé, et collecte tous
// les ShadowRoot pour un SEUL appel `getHTML()` final à la racine (les shadows
// imbriqués y sont alors inclus nativement, cf. en-tête de fichier SÉRIALISATION).
// (mode `csp`) — `cssUrls` (undefined hors csp, chemin INCHANGÉ) : au lieu de créer un
// `<style>` en ligne (BLOQUÉ par `style-src` sans 'unsafe-inline', vérifié en navigateur),
// pose un `<link>` vers l'URL PRÉ-CALCULÉE (même ORDRE que `mjsSsrCollectCss`, cf. son
// commentaire) — un `<link>` s'applique dans une racine d'ombre, prouvé.
function mjsSsrPrepareAndSerialize(root: any, hydrateMode: string | undefined, cssUrls?: string[]): any {
  const shadowRoots: any[] = []
  const vus: any = {}
  let cssIndex = 0
  function walk(el: any): void {
    if (!el) return
    const isShadow = !!(el._shadow && el._shadow !== el)
    mjsSsrMarkTree(el)
    if (isShadow) {
      shadowRoots.push(el._shadow)
      const css = mjsSsrInfo(el).baseCss
      if (css.trim() !== '' && !el._shadow.querySelector('style[data-mjs-ssr], link[data-mjs-ssr]')) {
        if (cssUrls) {
          const linkEl = document.createElement('link')
          linkEl.setAttribute('data-mjs-ssr', '')
          linkEl.setAttribute('rel', 'stylesheet')
          linkEl.setAttribute('href', cssUrls[cssIndex++])
          el._shadow.insertBefore(linkEl, el._shadow.firstChild)
        } else {
          const styleEl = document.createElement('style')
          styleEl.setAttribute('data-mjs-ssr', '')
          styleEl.textContent = mjsSsrSafeCss(css)
          el._shadow.insertBefore(styleEl, el._shadow.firstChild)
        }
      }
    } else {
      // composant LÉGER hors de tout shadow (racine `light`, ou son sous-composant léger) : sa
      // feuille vit dans le `document.head` de CETTE page, que le fragment n'emporte pas — cf.
      // mjsSsrOrphanLightCss. Posée en premier enfant, même place que dans un shadow.
      const orphelin = mjsSsrOrphanLightCss(el, vus, true)
      if (orphelin !== '' && !el.querySelector('style[data-mjs-ssr], link[data-mjs-ssr]')) {
        if (cssUrls) {
          const linkEl = document.createElement('link')
          linkEl.setAttribute('data-mjs-ssr', '')
          linkEl.setAttribute('rel', 'stylesheet')
          linkEl.setAttribute('href', cssUrls[cssIndex++])
          el.insertBefore(linkEl, el.firstChild)
        } else {
          const styleEl = document.createElement('style')
          styleEl.setAttribute('data-mjs-ssr', '')
          styleEl.textContent = mjsSsrSafeCss(orphelin)
          el.insertBefore(styleEl, el.firstChild)
        }
      }
    }
    const hydrateNodes = mjsSsrInfo(el).nodes
    if (hydrateMode === 'a' && hydrateNodes) {
      for (const key in hydrateNodes) { if (hydrateNodes[key]) mjsSsrMarkNode(hydrateNodes[key], key) }
    }
    if (isShadow) { for (let i = 0; i < el._shadow.children.length; i++) walk(el._shadow.children[i]) }
    if (el.children) { for (let j = 0; j < el.children.length; j++) walk(el.children[j]) }
  }
  walk(root)
  return {
    inner: root.getHTML({ serializableShadowRoots: true, shadowRoots }),
    // Miroir EXACT de renderToString.ts (`el._shadow?.innerHTML`, un seul niveau) —
    // gardé pour la parité du champ `shadowHtml` de RenderResult, indépendamment de
    // `inner` (plus riche, cf. en-tête de fichier) qui alimente lui `html`.
    rawShadow: (root._shadow && root._shadow !== root) ? root._shadow.innerHTML : '',
    light: mjsSsrInfo(root).isLight,
    css: mjsSsrInfo(root).baseCss.trim(),
  }
}

// Concatène les sources (réutilisées ET propres au moteur navigateur) dans UN
// script, posé une fois par page d'amorçage. `collectAwaitStates`/`hasPendingAwait`/
// `settleRender` sont RÉUTILISÉES telles quelles (import Node-side, cf. plus haut,
// `.toString()` ici) : un seul et même critère de stabilité pour les DEUX moteurs,
// jamais deux implémentations qui dérivent l'une de l'autre.
// PIÈGE (trouvé en testant le rendu réel, pas en théorie) — esbuild (tsx en dev,
// potentiellement le build en prod) injecte, pour une fonction déclarée et
// NOMMÉE À L'INTÉRIEUR d'une autre fonction (ex. `walk` dans
// `mjsSsrPrepareAndSerialize`), un appel `__name(walk, "walk")` juste après sa
// déclaration — un helper qui préserve `.name` à travers la chaîne de transform,
// défini UNE fois ailleurs dans le module compilé (jamais dans le texte de LA
// fonction elle-même). `.toString()` ne capture QUE le corps de la fonction, pas
// ce helper externe → `ReferenceError: __name is not defined` à l'exécution dans
// la page (constaté empiriquement). Shim minimal (no-op, retourne la fonction
// telle quelle) posé en tête du script concaténé : couvre CETTE fonction-ci et
// toute fonction imbriquée qu'on y ajouterait plus tard, sans dépendre des
// conditions exactes qui déclenchent cette injection côté compilateur.
const NAME_HELPER_SHIM = 'var __name = function(fn){ return fn };\n'

function pageHelperScript(): string {
  const fns = [ssrCoreOf, collectAwaitStates, hasPendingAwait, settleRender, mjsSsrSafeCss, mjsSsrInfo, mjsSsrOrphanLightCss, mjsSsrMarkTree, mjsSsrMarkNode, mjsSsrCollectCss, mjsSsrPrepareAndSerialize]
  const decls = fns.map(f => f.toString()).join('\n')
  const names = fns.map(f => f.name).join(', ')
  return NAME_HELPER_SHIM + decls + '\nwindow.__mjsSsr = { ' + names + ' };\n'
}

// ============================================================================
// 4. AMORÇAGE DE PAGE (bootstrap HTML + interception réseau)
// ============================================================================
const BOOT_ORIGIN = 'http://mjs-render.invalid'
const BOOT_HOST = new URL(BOOT_ORIGIN).hostname   // 'mjs-render.invalid' — cf. renderPage (cookies de contexte)
const BOOT_PATH = '/__mjs_ssr_boot__.html'
const BUNDLE_PATH = '/__mjs/bundle.js'   // même convention que render-server.ts (chemin fixe, hors outputDir)

// Page d'amorçage minimale : monte RIEN (le body reste vide jusqu'au montage
// explicite piloté par renderPage, cf. en-tête de fichier — sinon le store serait
// injecté APRÈS que l'Autoloader ait pu commencer à monter un tag déjà présent).
// Importe le core DIRECTEMENT (en plus du manifeste, qui l'importe aussi — même
// URL, même instance de module, mise en cache par le navigateur) : garantit une
// référence `µ` exploitable même en build minifié, où `window.µ` n'est PAS exposé
// (cf. Bundler.writeManifest, `if (!this.isProd())`) — `window.__mjsCore` est
// notre propre exposition, indépendante de ce choix de build.
// PIÈGE (trouvé en testant le rendu réel) — les DEUX scripts vont dans `<head>`,
// JAMAIS dans `<body>` : `renderPage` retrouve le composant monté via
// `document.body.firstElementChild` (même convention que renderToString.ts) — un
// `<script>` posé dans `<body>` y resterait comme ÉLÉMENT (les scripts ne
// disparaissent pas du DOM après exécution) et en deviendrait le PREMIER enfant,
// avant même le montage du composant. `<body>` doit rester intégralement vide
// jusqu'au montage explicite piloté par `renderPage`. Un script `type="module"`
// reste différé (comportement `defer` implicite) qu'il soit en tête ou en corps —
// le déplacer en `<head>` ne change donc rien à son timing d'exécution.
// `µ.server = true` (rune publique `µserver`, cf. mjs_store_globals.ts) — posé
// APRÈS les deux imports (µ garanti défini ; le montage réel ne démarre que
// PLUS TARD, déclenché par renderPage APRÈS __mjsBootDone, cf. plus bas) plutôt
// qu'INTERCALÉ entre les deux `import` (syntaxiquement légal en ESM mais évité
// ici, sans bénéfice réel : rien ne LIT `µ.server` avant le montage). Que
// mjs_store_globals.ts (son garde `if (µ.server === undefined)`) soit importé
// EAGERLY par le bundle ci-dessus ou PLUS TARD par l'Autoloader, il voit alors
// TOUJOURS `true` déjà posé, jamais son défaut client `false`. `µ._isServer`
// INTERNE reste, lui, délibérément ABSENT ici (cf. en-tête de fichier — @mount/
// @awake tournent POUR DE VRAI dans ce moteur, à dessein) : `µ.server` est un
// axe PUBLIC indépendant (sémantique « passe de rendu serveur » pour le code
// applicatif), vrai sur LES DEUX moteurs même quand `_isServer` diverge.
// cascade de modules — `bundle.js` n'importe plus le cœur STATIQUEMENT (cf. writeManifest,
// bundler/index.ts) : son corps (styles/animations/manifeste externe/Autoloader.observe)
// tourne désormais dans un `.then()`, jamais un top-level `await` (resterait éval-able tel
// quel dans un script classique) — l'import STATIQUE `import BUNDLE_PATH;` ci-dessous reprend
// donc sa propre évaluation dès la fin du corps SYNCHRONE de bundle.js (l'appel `.then()`
// posé), PAS après que le cœur+les composants soient réellement prêts. `window.__mjsBundleReady`
// (la promesse elle-même, posée par bundle.js) est le signal EXPLICITE qu'il faut attendre —
// sans ce `await`, `__mjsBootDone` pouvait passer à `true` AVANT que l'Autoloader n'ait
// observé le document, course perdue selon la vitesse du réseau/de la machine.
function bootHtml(helperSrc: string, coreUrl: string): string {
  return '<!doctype html>\n<html><head><meta charset="utf-8">\n' +
    '<script>\n' + helperSrc + '\n</script>\n' +
    '<script type="module">\n' +
    'import { µ } from ' + JSON.stringify(coreUrl) + ';\n' +
    'import ' + JSON.stringify(BUNDLE_PATH) + ';\n' +
    'await window.__mjsBundleReady;\n' +
    'µ.server = true;\n' +
    'window.__mjsCore = µ;\n' +
    'window.__mjsBootDone = true;\n' +
    '</script>\n</head><body></body></html>\n'
}

// render.forwardOrigin (défaut SÛR à la consommation, cf. render-request.ts et
// forward-origin.ts) — origine RÉELLE (scheme+host), validée (jamais interne,
// cf. isBlockedForwardTarget) + en-tête Cookie brut,
// pour le PROXY des chemins non-assets (cf. routeHandler ci-dessous). PAR
// RENDU, pas par SLOT : un slot de pool est réutilisé entre PLUSIEURS rendus
// (potentiellement plusieurs requêtes/utilisateurs différents, cf. en-tête de
// fichier section POOL) — une « boîte » MUTABLE (au lieu d'une valeur figée à
// la création du slot) permet à `renderPage` de la mettre à jour à CHAQUE appel
// ; `routeHandler`, créé UNE fois par slot mais fermé sur cette même boîte, lit
// donc toujours la valeur du rendu EN COURS, jamais celle d'un rendu antérieur.
// `signal` — même budget que le plafond global du rendu
// EN COURS (`renderTimeoutMs`, cf. renderPage) : lié UNE fois par rendu (pas
// une fraîche par appel fetch), donc une ÉCHÉANCE ABSOLUE ancrée au début du
// rendu, pas un délai qui repartirait de zéro à chaque requête proxifiée.
interface ForwardOriginCtx { origin: string; cookie?: string; signal?: AbortSignal }

/** Sert les dossiers de sortie + le bundle + la page d'amorçage sur l'origine FACTICE ; pour
 *  tout le reste, si `forwardBox.current` est posé (render.forwardOrigin actif
 *  pour CE rendu, cf. renderPage), PROXY vers l'origine réelle — sinon abandonné
 *  (défense en profondeur : aucune requête ne doit jamais atteindre un VRAI
 *  réseau depuis cette page hors du proxy explicitement voulu). */
function routeHandler(
  outputDirs: string[], urlPrefix: string, manifestPath: string, helperSrc: string, coreUrl: string,
  forwardBox: { current: ForwardOriginCtx | null },
) {
  return async (route: any): Promise<void> => {
    const req = route.request()
    const target = new URL(req.url())
    if (target.origin !== BOOT_ORIGIN) { await route.abort(); return }
    const pathname = decodeURIComponent(target.pathname)
    if (pathname === BOOT_PATH) {
      await route.fulfill({ status: 200, contentType: 'text/html', body: bootHtml(helperSrc, coreUrl) })
      return
    }
    if (pathname === BUNDLE_PATH) {
      if (existsSync(manifestPath)) {
        await route.fulfill({ status: 200, contentType: 'text/javascript', body: readFileSync(manifestPath) })
      } else {
        await route.fulfill({ status: 404, body: 'bundle introuvable : ' + manifestPath })
      }
      return
    }
    // Assets compilés (imports du bundle/de l'Autoloader) — même logique que
    // render-server.ts (urlPrefix strip + isWithinDir + MIME), réutilisée telle
    // quelle (isWithinDir/MIME importées) : une seule source pour ce garde-fou.
    const rel = (urlPrefix && pathname.startsWith(urlPrefix) ? pathname.slice(urlPrefix.length) : pathname).replace(/^\/+/, '')
    // Deux dossiers quand la compilation est détournée (`js: 'bundle'`, cf. render-compile-dir.ts) :
    // d'abord celui où CE rendu vient de compiler, puis le VRAI dossier de sortie — un fichier que
    // le projet y pose à la main (données, mock, fichier statique) reste servi comme il l'était.
    for (const dir of outputDirs) {
      const asset = join(dir, rel)
      if (rel && isWithinDir(dir, asset) && existsSync(asset) && statSync(asset).isFile() && isRealPathWithin(dir, asset)) {
        await route.fulfill({ status: 200, contentType: MIME[extname(asset)] || 'application/octet-stream', body: readFileSync(asset) })
        return
      }
    }
    // Chemin NON-asset : PROXY vers l'origine réelle si forwardOrigin est actif
    // pour CE rendu (SSR PAR REQUÊTE seulement — le prérendu n'a pas de requête
    // entrante à forwarder, `forwardBox.current` y reste toujours `null`) — les
    // fetch RELATIFS de l'app ({await fetch('/api/x')}) atteignent alors le VRAI
    // back au lieu d'un 404 sec. En-têtes transmis : Accept (celui de la requête
    // PAGE, telle quelle) + Cookie (celui de la requête ENTRANTE HTTP d'origine,
    // porté par render-request.ts jusqu'ici) — jamais l'inverse (aucun en-tête de
    // la page vers le Cookie, aucune fuite d'un rendu vers un AUTRE rendu : la
    // boîte est remise à jour à CHAQUE appel de renderPage, cf. sa définition).
    const fwd = forwardBox.current
    if (fwd) {
      try {
        const upstream = new URL(pathname + target.search, fwd.origin)
        // Garde-fou — SANS `signal`, un back
        // forwardOrigin qui ne répond jamais laissait ce `fetch()` pendre à vie,
        // bloquant le `finally{ release(slot) }` de `renderPage` (cf. son
        // commentaire) : 1 slot de pool perdu par hang. `fwd.signal` porte le
        // MÊME budget que le plafond global du rendu (renderTimeoutMs) — une
        // échéance qui expire ici fait rejeter `fetch()` (AbortError), capturé
        // par le catch ci-dessous (502 propre), jamais un pendu silencieux.
        const proxied = await fetch(upstream, {
          headers: {
            accept: req.headers()['accept'] || '*/*',
            ...(fwd.cookie ? { cookie: fwd.cookie } : {}),
          },
          signal: fwd.signal,
        })
        const body = Buffer.from(await proxied.arrayBuffer())
        await route.fulfill({
          status: proxied.status,
          contentType: proxied.headers.get('content-type') || 'application/octet-stream',
          body,
        })
      } catch (e: any) {
        // Panne réseau/back réel (indépendante d'un bug MJS) — 502 explicite
        // plutôt qu'un throw qui ferait planter TOUT le rendu de la page pour
        // une ressource annexe (même posture que le 404 qu'il remplace).
        await route.fulfill({ status: 502, body: 'Bad Gateway (proxy render.forwardOrigin) : ' + (e?.message || e) })
      }
      return
    }
    await route.fulfill({ status: 404, body: 'Not Found: ' + pathname })
  }
}

// ============================================================================
// 5. PROPS — mêmes garde-fous que renderToString.ts (dupliqués : petites
//    fonctions pures, pas d'export à exposer côté renderToString.ts pour ça).
// ============================================================================
const PROP_NAME_RE = /^[A-Za-z_][\w:.-]*$/

function serializeProp(v: unknown): string {
  return (v !== null && typeof v === 'object') ? JSON.stringify(v) : String(v)
}

function escapeAttr(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

function buildSharedScript(json: string | null, id: string = '__mjs_store'): string {
  if (!json || json === '{}' || json === 'null') return ''
  // Même échappement que renderToString.ts (serializeGlobal) : tout
  // `<` en `<`, round-trip JSON exact, élimine tout déclencheur d'état de
  // parsing spécial (`<!--`+`<script` notamment). `id` — même helper
  // pour la balise `__mjs_store` (défaut) ET la graine `__mjs_i18n`.
  return `<script type="application/json" id="${id}">${json.replace(/</g, '\\u003c')}</script>`
}

// Même esprit que journal.ts (DEFAULT_MAX_ENTRIES/MAX_MESSAGE_CHARS) : sans plafond,
// un composant qui lève massivement pendant `settleMs` gonfle `pageErrors` (donc `warnings`, cf.
// renderPage) sans aucune borne, mémoire + verbosité de logs (render-request.ts les console.warn
// une à une).
const PAGE_ERROR_MAX_ENTRIES = 50
const PAGE_ERROR_MAX_CHARS   = 1000

// ============================================================================
// 6. RENDERER — pool de pages Chromium
// ============================================================================
export interface BrowserRendererOptions {
  /** Racine du projet — résout les chemins relatifs de `config` (même rôle que
   *  `configDir` partout ailleurs dans server/*.ts). */
  configDir: string
  /** Récepteur de messages informatifs (warnings de compilation…). */
  log?: (msg: string) => void
  /**
   * Garde-fou — overrides EXPLICITES qui
   * priment sur la dérivation par défaut depuis `config` (`config.sourceDir`/
   * `config.outputDir`/`config.manifestPath`, résolus normalement relativement
   * à `configDir`). Sans eux, ce renderer re-dérivait TOUJOURS ses chemins
   * depuis `mjs.config.json`, quel que soit un `--output`/`--manifest` CLI déjà
   * appliqué par l'appelant (cas réel : `prerenderPages`, cf. son commentaire)
   * — un build redirigé voyait son prérendu recompiler puis ÉCRASER les
   * fichiers du VRAI projet. Valeurs attendues déjà résolues (chemins
   * ABSOLUS) : aucune résolution relative à `configDir` n'est appliquée ici.
   */
  sourceDir?: string
  outputDir?: string
  manifestPath?: string
  /** Environnement du build (`mjs build --prod`). Défaut : développement. Même motif que
   *  `outputDir` ci-dessus — ce renderer recompile dans le VRAI dossier de sortie. */
  env?: 'dev' | 'prod'
}

export interface BrowserRenderer {
  /** Rend un composant dans un VRAI Chromium (page du pool) — même contrat de
   *  sortie que `SSRRenderer.renderToString` (RenderResult), nom différent
   *  (`renderPage`) pour signaler sans ambiguïté le moteur utilisé. */
  renderPage(tag: string, options?: RenderOptions): Promise<RenderResult>
  /** Ferme le pool (contextes + pages), le navigateur et le bundler. */
  close(): Promise<void>
}

interface PoolSlot {
  context: PwBrowserContext
  page: PwPage
  createdAt: number
  /** Boîte mutable lue par CE slot's `routeHandler` (cf. sa définition) — mise à
   *  jour à CHAQUE `renderPage` (jamais figée à la création du slot). */
  forwardBox: { current: ForwardOriginCtx | null }
  /** Nom du composant EN COURS de rendu sur ce slot, lu par l'écouteur
   *  `context.on('page', …)` posé dans `bootSlot()` (nomme le composant fautif dans
   *  l'avertissement de popup fermée) — même patron mutable que `forwardBox`
   *  ci-dessus, mis à jour à CHAQUE `renderPage` (slot POOLED, réutilisé). */
  activeTag: { current: string | null }
}

/**
 * Crée le renderer navigateur : compile le projet UNE fois (Bundler standard —
 * un vrai navigateur charge le bundle TEL QUEL, aucune transformation SSR-only
 * requise, cf. en-tête de fichier), lance Chromium PARESSEUSEMENT (au premier
 * `renderPage`, jamais à la construction — un renderer créé mais jamais utilisé ne
 * doit rien coûter de plus que le compile), puis permet des rendus répétés via un
 * pool de pages. Erreurs franches : compilation cassée, ou Playwright absent —
 * jamais un renderer à moitié fonctionnel.
 */
export async function createBrowserRenderer(config: MjsConfig, opts: BrowserRendererOptions): Promise<BrowserRenderer> {
  const configDir = opts.configDir
  const log = opts.log ?? (() => {})

  // Compile PROPRE (même Bundler, mêmes options que la voie CSR/prod réelle — via
  // resolveBundlerOpts, DÉJÀ testé/maintenu à cet effet, réutilisé tel quel pour
  // une fidélité maximale) : un vrai navigateur charge EXACTEMENT ce qu'un visiteur
  // recevrait. `sourceDir`/`outputDir`/`manifestPath` recalculés explicitement
  // (comme prerender.ts/render-request.ts) plutôt que laissés au défaut du
  // constructeur Bundler : ce défaut est relatif au CWD du process, pas à
  // `configDir` — mélanger les deux romprait la cohérence des chemins dès que le
  // process tourne depuis un répertoire différent de la racine du projet.
  // `js` EXCEPTÉ de cette fidélité : ce renderer relit le cœur et les composants
  // FICHIER PAR FICHIER (cf. plus bas), un contrat que `js: 'bundle'` (un seul fichier fusionné,
  // plus aucun `mjs_core-*.js` séparé) casserait — forcé à 'split' quoi que dise le projet,
  // ci-dessous, APRÈS le spread de bundlerOpts.
  const bundlerOpts = resolveBundlerOpts(config, configDir)
  // Garde-fou — `opts.sourceDir`/`outputDir`/
  // `manifestPath` (déjà résolus en ABSOLU par l'appelant, cf.
  // BrowserRendererOptions) priment sur la dérivation depuis `config` : sans
  // ça, un `--output`/`--manifest` CLI déjà appliqué au build principal était
  // ignoré ICI, ce renderer recompilant vers le chemin par défaut de
  // `mjs.config.json` — risque réel d'écrasement des fichiers du projet.
  const sourceDir = opts.sourceDir ?? resolve(configDir, config.sourceDir || '.')
  const outputDir = opts.outputDir ?? resolve(configDir, config.outputDir || 'dist')
  const manifestPath = opts.manifestPath ?? (config.manifestPath ? resolve(configDir, config.manifestPath) : join(outputDir, 'bundle.js'))
  // Où CETTE compilation a le droit d'écrire (cf. render-compile-dir.ts) : le vrai dossier de
  // sortie quand le projet émet lui aussi des unités séparées, un dossier temporaire quand il émet
  // un FICHIER UNIQUE (`js: 'bundle'`) — le `split` forcé ci-dessous écraserait sinon ce fichier
  // par un manifeste éclaté. `urlPrefix` reste celui du VRAI build dans les deux cas : les URLs
  // d'assets du HTML rendu désignent ce que sert le back, jamais un dossier éphémère.
  const atelier = openRenderCompileDir({ js: bundlerOpts.js, outputDir, manifestPath, urlPrefix: bundlerOpts.urlPrefix })
  const bundler = new Bundler({ ...bundlerOpts, sourceDir, outputDir: atelier.outputDir, manifestPath: atelier.manifestPath, urlPrefix: atelier.urlPrefix, js: 'split', ...(opts.env ? { env: opts.env } : {}) })
  let stats
  try {
    stats = await bundler.compile()
  } catch (e) {
    await bundler.close()
    atelier.cleanup()
    throw e
  }
  if (stats.errors.length) {
    await bundler.close()
    atelier.cleanup()
    throw new Error(t('server.browser-erreurs-compilation', { errors: stats.errors.map(e => e.message).join('\n') }))
  }
  const compileWarnings = stats.warnings.slice()

  // Sélection déterministe du core — même garde que renderToString.ts (m8) :
  // `readdirSync` n'est PAS garanti trié par POSIX.
  const coreFiles = readdirSync(atelier.outputDir).filter(f => /^mjs_core-/.test(f)).sort()
  if (coreFiles.length === 0) {
    await bundler.close()
    atelier.cleanup()
    throw new Error(t('server.browser-core-introuvable'))
  }
  if (coreFiles.length > 1) {
    log(t('server.browser-plusieurs-core', { files: coreFiles.join(', '), first: coreFiles[0] }))
  }
  const coreUrl = bundler.urlPrefix + '/' + coreFiles[0]
  const helperSrc = pageHelperScript()

  const poolCfg: RenderBrowserPoolConfig = config.render?.browserPool || {}
  const poolSize = Math.max(1, poolCfg.size ?? 2)
  const keepAlive = poolCfg.keepAlive ?? true
  const maxAgeMs = poolCfg.maxAgeMs ?? 300000
  // Garde-fou — cf. RenderBrowserPoolConfig.
  // renderTimeoutMs pour le pourquoi ; défaut résolu ICI (au point de
  // consommation, même convention que poolSize/keepAlive/maxAgeMs ci-dessus).
  const renderTimeoutMs = Math.max(1, poolCfg.renderTimeoutMs ?? 15000)

  // PIÈGE DE CONCURRENCE JUMEAU (même famille que celui du pool, cf. `reserved`
  // plus bas) — une simple variable `browser` assignée APRÈS l'await du lancement
  // laisse la MÊME fenêtre : deux `bootSlot()` concurrents (typiquement les tout
  // premiers rendus d'un pool de taille ≥ 2) verraient tous deux `browser` vide et
  // lanceraient chacun LEUR PROPRE Chromium. Fix identique à `rendererPromise`
  // (render-request.ts) : mémoïser la PROMESSE elle-même, assignée SYNCHRONEMENT
  // avant tout await — un 2e appelant concurrent trouve alors la mémoïsation déjà
  // en place et attend CE MÊME lancement au lieu d'en démarrer un second.
  let browserPromise: Promise<PwBrowser> | null = null
  let closed = false

  async function getBrowser(): Promise<PwBrowser> {
    if (!browserPromise) {
      browserPromise = (async () => {
        const playwright = await resolveBrowserEngine()
        if (!playwright) {
          throw new Error(t('server.browser-playwright-manquant'))
        }
        // headless:true — vérifié empiriquement dans CE dépôt (browser-playwright.test.ts,
        // sous xvfb-run) : fonctionne sans réserve, aucune raison de s'en écarter.
        return playwright.chromium.launch({ headless: true })
      })()
      // Un lancement qui ÉCHOUE ne doit pas bricker tous les rendus futurs avec la
      // même promesse rejetée à vie — libère la mémoïsation pour un nouvel essai.
      browserPromise.catch(() => { browserPromise = null })
    }
    return browserPromise
  }

  async function bootSlot(): Promise<PoolSlot> {
    const b = await getBrowser()
    const context: PwBrowserContext = await b.newContext()
    // `newContext()` a réussi mais une étape SUIVANTE (addInitScript/route/newPage)
    // peut échouer (navigateur/IPC en défaut) : sans ce filet, le context déjà créé fuyait, jamais
    // refermé nulle part (createSlot() n'entoure que `reserved--`, cf. son commentaire plus bas).
    try {
      const forwardBox: { current: ForwardOriginCtx | null } = { current: null }
      const activeTag: { current: string | null } = { current: null }
      await context.addInitScript(mjsSsrForceOpenShadow)
      await context.route('**/*', routeHandler([...new Set([atelier.outputDir, atelier.assetsDir])], bundler.urlPrefix, atelier.manifestPath, helperSrc, coreUrl, forwardBox))
      const page: PwPage = await context.newPage()
      // Popup (window.open) jamais suivie ni fermée par Playwright : posé APRÈS
      // `newPage()` (une page créée AVANT cet appel ne déclenche jamais cet écouteur, sondé
      // empiriquement) pour ne JAMAIS refermer la page officielle du slot, seulement une page
      // SECONDAIRE ouverte plus tard (widget de partage, target=_blank, pub tierce…) — laissée
      // sinon vivante dans ce contexte POOLED (réutilisé entre plusieurs rendus/utilisateurs)
      // jusqu'à maxAgeMs.
      context.on('page', (popup: PwPage) => {
        log(t('server.browser-popup-fermee', { tag: activeTag.current || '?' }))
        popup.close().catch(() => { /* best-effort */ })
      })
      return { context, page, createdAt: Date.now(), forwardBox, activeTag }
    } catch (e) {
      await context.close().catch(() => { /* best-effort */ })
      throw e
    }
  }

  const idle: PoolSlot[] = []
  const all: PoolSlot[] = []
  const waiters: { resolve: (s: PoolSlot) => void; reject: (e: any) => void }[] = []
  // PIÈGE DE CONCURRENCE (trouvé en relisant le pool APRÈS l'avoir écrit — un 1er
  // test « rendus concurrents » axé sur le contenu ne l'avait PAS détecté : chaque
  // emplacement, même en surnombre, reste isolé et produit un résultat correct ;
  // seul un test axé sur le TIMING de sérialisation le révèle, cf. render-
  // browser.test.ts) — `all.length < poolSize` puis `await bootSlot()` laisse une
  // FENÊTRE : deux `acquire()` concurrents peuvent tous les deux lire `all.length`
  // AVANT que l'un des deux n'ait fini de pousser son slot dans `all` (le push
  // n'arrive qu'APRÈS l'await), dépassant `poolSize` sous charge concurrente.
  // `reserved` compte les créations EN COURS (incrémenté SYNCHRONEMENT, avant tout
  // await) — un 2e appelant voit alors `all.length + reserved` déjà à jour et part
  // correctement en file d'attente au lieu de créer un emplacement de trop.
  let reserved = 0

  async function closeBrowserIfIdle(): Promise<void> {
    if (all.length !== 0 || reserved !== 0 || !browserPromise) return
    const p = browserPromise
    browserPromise = null
    try { const b = await p; await b.close() } catch { /* best-effort */ }
  }

  async function teardownSlot(slot: PoolSlot): Promise<void> {
    const i = all.indexOf(slot)
    if (i >= 0) all.splice(i, 1)
    try { await slot.context.close() } catch { /* best-effort */ }
    await closeBrowserIfIdle()
  }

  async function createSlot(): Promise<PoolSlot> {
    reserved++
    try {
      const slot = await bootSlot()
      // `close()` a pu survenir PENDANT ce `await bootSlot()` (fermeture demandée
      // alors qu'une création était déjà en vol) — ne pas raccrocher ce slot au
      // pool déjà fermé : le refermer aussitôt plutôt que le laisser fuir.
      if (closed) {
        try { await slot.context.close() } catch { /* best-effort */ }
        throw new Error(t('server.browser-ferme-pendant-creation'))
      }
      all.push(slot)
      return slot
    } finally {
      reserved--
    }
  }

  async function acquire(): Promise<PoolSlot> {
    if (closed) throw new Error(t('server.browser-deja-ferme'))
    const free = idle.pop()
    if (free) {
      if (Date.now() - free.createdAt > maxAgeMs) {
        await teardownSlot(free)
        return createSlot()
      }
      return free
    }
    if (all.length + reserved < poolSize) {
      return createSlot()
    }
    return new Promise((resolveWait, rejectWait) => waiters.push({ resolve: resolveWait, reject: rejectWait }))
  }

  function release(slot: PoolSlot): void {
    if (closed) { teardownSlot(slot).catch(() => {}); return }
    if (!keepAlive) {
      teardownSlot(slot).then(() => {
        const waiter = waiters.shift()
        if (waiter) acquire().then(waiter.resolve, waiter.reject)
      }).catch(() => {})
      return
    }
    const waiter = waiters.shift()
    if (waiter) { waiter.resolve(slot); return }
    idle.push(slot)
  }

  // Garde-fou — appelée UNIQUEMENT quand un
  // rendu a franchi `renderTimeoutMs` (cf. renderPage) : le slot est dans un
  // état INCONNU (potentiellement toujours occupé par le `page.evaluate` qui a
  // fait pendre le rendu — Playwright n'offre aucune annulation réelle d'un
  // `evaluate`/`waitForFunction` en vol), donc JAMAIS remis en `idle` comme le
  // ferait `release()` — toujours démonté (`teardownSlot`, qui ferme le
  // contexte : une navigation/exécution en cours dans CE contexte est de facto
  // interrompue, son `page.evaluate` en attente rejette côté Node avec un
  // contexte détruit). Même motif que la branche `!keepAlive` de `release()` :
  // un waiter en file mérite un NOUVEAU slot plutôt que d'attendre indéfiniment
  // celui qu'on vient de sacrifier.
  async function reclaimSlot(slot: PoolSlot): Promise<void> {
    await teardownSlot(slot)
    const waiter = waiters.shift()
    if (waiter) acquire().then(waiter.resolve, waiter.reject)
  }

  async function renderPage(tag: string, options: RenderOptions = {}): Promise<RenderResult> {
    const { props = {}, store, shadowMode = 'open', settleMs = 1000, ssrMode = 'replace', forwardedUrl, forwardedCookie, light: lightRoot = false } = options
    const slot = await acquire()
    // render.forwardOrigin (cf. RenderOptions.forwardedUrl/forwardedCookie et la
    // définition de ForwardOriginCtx) — reposé à CHAQUE rendu (jamais hérité d'un
    // rendu antérieur du MÊME slot pooled, cf. son commentaire) : `null` (proxy
    // désactivé pour CE rendu → 404 sur les chemins non-assets, comme avant) si
    // `forwardedUrl` est absent (prérendu, ou forwardOrigin désactivé/refusé).
    // (SSRF) — défense en profondeur AVANT d'armer le
    // proxy : une cible réseau interne (`isBlockedForwardTarget`) est REFUSÉE
    // ici même, quel que soit le chemin par lequel `forwardedUrl` est arrivé.
    const warnings: string[] = compileWarnings.slice()
    let forwardOrigin: string | null = null
    if (forwardedUrl) {
      const target = new URL(forwardedUrl).origin
      if (isBlockedForwardTarget(new URL(forwardedUrl).host)) {
        warnings.push(t('server.browser-forward-refuse-interne', { tag, host: new URL(forwardedUrl).host }))
      } else {
        forwardOrigin = target
      }
    }
    // Garde-fou — échéance ABSOLUE de CE
    // rendu, posée UNE fois ici (pas une fraîche par appel `fetch()` du proxy,
    // cf. ForwardOriginCtx.signal) : partagée entre le plafond global
    // ci-dessous (`timeoutPromise`) et le `fetch()` proxifié de routeHandler.
    const renderSignal = AbortSignal.timeout(renderTimeoutMs)
    slot.forwardBox.current = forwardOrigin ? { origin: forwardOrigin, cookie: forwardedCookie, signal: renderSignal } : null
    // Nomme CE rendu dans l'avertissement de popup fermée (cf. bootSlot(), écouteur
    // `context.on('page', …)` posé UNE fois à la création du slot, lu à CHAQUE rendu).
    slot.activeTag.current = tag
    // `message` ET `stack` (avant : seulement `message`) : le filtre d'origine du
    // point 3 (plus bas) a besoin de la pile pour distinguer un crash PROJET d'un script TIERS.
    const pageErrors: { message: string; stack: string }[] = []
    // Plafond en nombre ET en taille (cf. PAGE_ERROR_MAX_ENTRIES/PAGE_ERROR_MAX_CHARS
    // ci-dessus) : au-delà, une erreur supplémentaire est silencieusement ignorée (déjà largement
    // assez de matière pour le diagnostic), jamais un tableau ni des messages sans borne.
    const onPageError = (err: any) => {
      if (pageErrors.length >= PAGE_ERROR_MAX_ENTRIES) return
      const msg = String(err?.message || err)
      // `.stack` COMMENCE par le message : un message hostile (des Ko de "x",
      // cf. browser-pageerrors-cap.test.ts) tronqué à `PAGE_ERROR_MAX_CHARS` depuis le DÉBUT
      // coupait la pile AVANT la moindre ligne « at fichier:ligne » — le filtre d'origine (plus
      // bas) ne voyait alors plus jamais aucune ressource projet. On ne garde que les lignes
      // « at … » (tout ce qui suit la première ligne du message), bornées séparément.
      const stackFrames = String(err?.stack || '').split('\n').slice(1).join('\n')
      pageErrors.push({
        message: msg.length > PAGE_ERROR_MAX_CHARS ? msg.slice(0, PAGE_ERROR_MAX_CHARS) : msg,
        stack: stackFrames.length > PAGE_ERROR_MAX_CHARS ? stackFrames.slice(0, PAGE_ERROR_MAX_CHARS) : stackFrames,
      })
    }
    slot.page.on('pageerror', onPageError)

    // Garde-fou — `bootRender` porte TOUT le
    // corps du rendu (identique à la version précédente, aucune étape
    // retirée) : c'est SON résultat qui est couru contre le plafond global
    // ci-dessous, plutôt que de laisser le `finally` (qui libère le slot)
    // attendre une étape non bornée. Deux points NON bornés en profitent
    // directement : le `page.evaluate` de montage (~ligne 40 plus bas) et le
    // `fetch()` proxifié de routeHandler (borné, lui, par `renderSignal`
    // ci-dessus — même budget).
    const bootRender = async (): Promise<RenderResult> => {
      await slot.page.goto(BOOT_ORIGIN + BOOT_PATH, { timeout: 30000 })
      // Hygiène entre deux rendus du MÊME emplacement pooled — la navigation
      // remet à zéro le Realm JS, mais pas localStorage/sessionStorage (persistent
      // par origine). Cf. en-tête de fichier, section POOL.
      await slot.page.evaluate(() => {
        try { localStorage.clear() } catch { /* ignore */ }
        try { sessionStorage.clear() } catch { /* ignore */ }
      })
      // Cookies de contexte, MÊME hygiène que localStorage/sessionStorage ci-dessus
      // (un slot pooled sert PLUSIEURS rendus successifs, potentiellement pour des
      // requêtes/utilisateurs différents) : on retire D'ABORD tout cookie posé pour
      // l'origine FACTICE d'amorçage par un rendu ANTÉRIEUR de ce même slot, puis on
      // repose ceux du rendu COURANT (s'il y en a). Domaine = hôte de l'origine
      // FACTICE (`mjs-render.invalid`), PAS celui de l'origine réelle : la page ne
      // navigue JAMAIS vers cette dernière (cf. en-tête de fichier, section
      // AMORÇAGE) — des cookies qui y seraient scopés seraient invisibles à
      // `document.cookie` ET jamais attachés par Chromium aux fetch relatifs de la
      // page (qui ciblent tous `mjs-render.invalid`). Ceci couvre la visibilité
      // `document.cookie` CÔTÉ PAGE ; le PROXY lui-même (routeHandler) transmet le
      // cookie indépendamment, en-tête HTTP explicite sur son propre fetch Node.
      await slot.context.clearCookies({ domain: BOOT_HOST })
      if (forwardedCookie) {
        const pairs = forwardedCookie.split(';').map(p => p.trim()).filter(Boolean)
        await slot.context.addCookies(pairs.map((pair) => {
          const eq = pair.indexOf('=')
          const name = eq === -1 ? pair : pair.slice(0, eq)
          const value = eq === -1 ? '' : pair.slice(eq + 1)
          return { name, value, url: BOOT_ORIGIN }
        }))
      }
      await slot.page.waitForFunction(() => (window as any).__mjsBootDone === true, undefined, { timeout: 10000 })

      // CORRECTIF — `Object.assign` pose des
      // propriétés PLATES sur toute clé non encore déclarée (aucun accesseur en
      // attente) : un module chargé APRÈS coup qui écrit cette clé ne notifierait
      // alors jamais rien. Seed clé par clé via `_storeSet` (crée l'accesseur au
      // passage) — aucun composant monté à ce stade (`document.createElement`
      // n'intervient que plus bas), donc la notification est sans abonné, sans risque.
      // CORRECTIF (canal d'ENTRÉE) — `__mjsLang` doit
      // rester une clé store CACHÉE (cf. `_storeDeclare(keys, true)` côté
      // réhydratation client, mjs_store_globals.ts:242-269) même quand elle
      // arrive par `options.store` : la PRÉ-déclarer non-énumérable AVANT
      // `_storeSet`, sinon celui-ci l'auto-déclare ÉNUMÉRABLE faute d'accesseur
      // existant — et resterait ainsi visible pour de bon (`Object.keys(µ.store)`,
      // `{for k in $$}`, `JSON.stringify(µ.store)` exécutés côté serveur).
      if (store && Object.keys(store).length > 0) {
        await slot.page.evaluate((s: any) => {
          const core = (window as any).__mjsCore
          if (Object.prototype.hasOwnProperty.call(s, '__mjsLang') && !Object.prototype.hasOwnProperty.call(core.store, '__mjsLang')) {
            core._storeDeclare(['__mjsLang'], true)
          }
          for (const k in s) { if (Object.prototype.hasOwnProperty.call(s, k)) { core._storeSet(k, s[k]) } }
        }, store)
      }

      // Nom de prop validé AVANT concaténation dans le HTML final retourné (sinon
      // XSS réfléchie possible via une clé forgée, cf. escapeAttr plus bas) ; la
      // VALEUR est sérialisée identiquement à renderToString.ts (objets/tableaux →
      // JSON, `parseProp` les ré-hydrate au montage — même contrat serveur/client).
      // Le montage lui-même passe par `setAttribute` (DOM, pas de concaténation
      // HTML) : aucun risque d'injection à cette étape, seule la reconstruction du
      // `html` final (plus bas) doit échapper.
      const attrs: Record<string, string> = {}
      for (const [k, v] of Object.entries(props)) {
        if (!PROP_NAME_RE.test(k)) { warnings.push(t('server.browser-prop-invalide', { keyJson: JSON.stringify(k) })); continue }
        attrs[k] = serializeProp(v)
      }

      const mounted = await slot.page.evaluate(async ({ tag, attrs, lightRoot }: any) => {
        const core = (window as any).__mjsCore
        // µ.Autoloader n'est du cœur qu'en `js: 'split'` : un fichier unique (`js: 'bundle'`) a
        // déjà défini TOUS les composants du projet à son évaluation, il n'y a rien à charger —
        // le test `customElements.get` juste en dessous reste le seul verdict.
        if (core.Autoloader) await core.Autoloader.load(tag)
        const classe: any = customElements.get(tag)
        if (!classe) return { ok: false }
        // Racine en mode léger (cf. `RenderOptions.light`) : drapeau posé sur la CLASSE avant
        // `createElement` — le constructeur décide là, et l'attribut posé juste après y arriverait
        // trop tard. L'attribut voyage quand même dans le HTML servi : c'est lui que lit le client.
        if (lightRoot) classe.mjsLight = true
        const el = document.createElement(tag)
        for (const k in attrs) el.setAttribute(k, attrs[k])
        if (lightRoot) el.setAttribute('mjs-light', '')
        document.body.appendChild(el)
        return { ok: true }
      }, { tag, attrs, lightRoot })
      if (!mounted.ok) {
        throw new Error(t('server.browser-composant-non-enregistre', { tag }))
      }

      const settled: boolean = await slot.page.evaluate(({ maxMs }: any) => {
        return (window as any).__mjsSsr.settleRender(document.body.firstElementChild, maxMs)
      }, { maxMs: settleMs })
      if (!settled) {
        warnings.push(t('server.browser-non-stabilise', { tag, settleMs }))
      }

      const modeMap: Record<string, string> = { markers: 'a', positional: 'b', diff: 'c' }
      const hydrateMode = modeMap[ssrMode]

      // (mode `csp`) — DEUX passages : `mjsSsrCollectCss` (lecture seule) donne le CSS de
      // chaque shadow DANS L'ORDRE, `writeHashedAsset` (côté Node, seul endroit où fs existe)
      // calcule les URLs hashées correspondantes, `mjsSsrPrepareAndSerialize` les repose ensuite
      // en `<link>` au MÊME ordre. `csp: false` (défaut) : `cssUrls` reste `undefined`, chemin
      // INCHANGÉ (`<style>` en ligne comme avant).
      let cssUrls: string[] | undefined
      if (config.csp === true) {
        const cssList: { css: string; tag: string }[] = await slot.page.evaluate(() => {
          return (window as any).__mjsSsr.mjsSsrCollectCss(document.body.firstElementChild)
        })
        // nom de fichier par BALISE, comme le moteur happy-dom (renderToString.ts) : une feuille se
        // reconnaît dans le dossier de sortie sans avoir à l'ouvrir
        cssUrls = cssList.map(c => writeHashedAsset(atelier.assetsDir, bundler.urlPrefix, 'mjs_ssr_style_' + c.tag, '.css', c.css))
      }

      const serialized = await slot.page.evaluate(({ mode, urls }: any) => {
        return (window as any).__mjsSsr.mjsSsrPrepareAndSerialize(document.body.firstElementChild, mode, urls)
      }, { mode: hydrateMode, urls: cssUrls })

      // même correctif que renderToString.ts (serializeGlobal) : `__mjsLang`
      // (clé store CACHÉE, non-énumérable) est absente de `JSON.stringify(store)`
      // PAR CONSTRUCTION — on la rajoute EXPLICITEMENT (accès direct par nom,
      // insensible à l'énumérabilité) sinon un rendu SSR dans une langue non par
      // défaut n'est jamais réhydraté côté client. `Object.assign` ne copie que
      // les clés énumérables de `store` (computed déjà déballés par le getter).
      const storeJson: string | null = await slot.page.evaluate(() => {
        try {
          const store = (window as any).__mjsCore.store || {}
          const out = (store.__mjsLang !== undefined) ? Object.assign({}, store, { __mjsLang: store.__mjsLang }) : store
          return JSON.stringify(out)
        } catch { return null }
      })

      // (graine i18n) — ce moteur ne pose PAS `µ._isServer` (cf. en-tête de
      // fichier) : `_ensure()` y fetche pour de vrai, `µ._i18nCache` porte donc de
      // VRAIES données résolues (`entry.data`), contrairement au moteur happy-dom
      // (qui, lui, s'appuie sur `µ._i18nUsed`, cf. renderToString.ts). Langue
      // effective = `µ.store.__mjsLang` si posée, sinon le défaut du manifeste.
      // CORRECTIF — `sections` regroupée PAR LANGUE RÉELLE de chaque
      // entrée du cache (`{lang:{section:…}}`), plus seulement celles de la langue
      // effective : un fetch de REPLI (`_ensure(defLang, section)`, section absente
      // de la langue courante) pose son entrée sous `defLang/section` dans
      // `µ._i18nCache` — l'ancien filtre (`parts[0] === lang`) l'écartait TOUJOURS,
      // la graine sortait sans lui alors que le fetch avait pourtant eu lieu. Même
      // forme de balise que le moteur happy-dom (renderToString.ts).
      // CORRECTIF — le repli de `_ensure` (mjs_i18n.ts, § Repli de
      // section) pose DEUX entrées pour une MÊME donnée : `defLang/section` (le vrai fetch) ET
      // `lang/section` (alias, même `entry.data`, posé pour que `_mjs_mountReal` retrouve une entrée
      // sous la clé qu'il a demandée). Semer les DEUX étiquetait `lang` comme traduite alors
      // qu'aucun fichier n'existe pour elle (`{ en: { panier }, fr: { panier } }` alors que seul
      // `fr/panier.yml` existe) — le client réhydraté croyait `en` déjà résolue et n'affichait
      // JAMAIS l'avertissement dev de repli. Une entrée n'est retenue que si le manifeste a un
      // chemin RÉEL pour ce couple langue/section (`core._i18nData.sections[entryLang]
      // [section]`) : l'alias de repli n'en a pas sous SA langue (celle qui manquait), seule
      // l'entrée `defLang/section` (qui, elle, en a un) passe le filtre.
      const i18nJson: string | null = await slot.page.evaluate(() => {
        try {
          const core = (window as any).__mjsCore
          const lang = (core.store && core.store.__mjsLang !== undefined) ? core.store.__mjsLang : (core._i18nData && core._i18nData.default)
          if (!lang || !core._i18nCache) { return null }
          const sections: Record<string, any> = {}
          let any = false
          core._i18nCache.forEach((entry: any, key: string) => {
            if (!entry || entry.data == null) { return }
            const parts = key.split('/')
            const entryLang = parts[0], section = parts[1]
            // table des sections d'une langue : dans le FICHIER DE LANGUE chargé par le
            // runtime (`µ._i18nLangs`), plus dans le manifeste.
            const langue = core._i18nLangs && core._i18nLangs[entryLang]
            if (!langue || !langue.sections || !langue.sections[section]) { return } // alias de repli (pas de fragment sous SA langue) : jamais semé
            if (!sections[entryLang]) { sections[entryLang] = {} }
            sections[entryLang][section] = entry.data
            any = true
          })
          return any ? JSON.stringify({ lang, sections }) : null
        } catch { return null }
      })

      // Une `pageerror` (exception NON interceptée par la page, cf. `onPageError`
      // ci-dessus) était jusqu'ici rangée dans `warnings` sans jamais faire échouer CE rendu :
      // un composant qui lève au montage (`µmount`, top-level du <script>…) écrivait quand même
      // sa page comme un succès. Même contrat que `server.ssr-composant-non-enregistre` : ce
      // rendu doit rejeter (prerender.ts la marque alors `fatal`, supprime le fichier périmé).
      // MAIS toute `pageerror`, sans filtre, faisait aussi échouer un composant
      // SAIN dont le montage injecte un script TIERS (widget, analytics…) qui lève de son côté, sans
      // rapport avec le rendu MJS. N'est fatale qu'une pageerror dont la pile référence une
      // ressource DU PROJET (bundle/chunks servis sous `bundler.urlPrefix`, ou `BUNDLE_PATH` — cf.
      // en-tête de fichier) OU qui coïncide avec le crash structurel détecté (`µ._fatalErrors`,
      // mjs_element.ts `_mjs_catchError`) ; les autres restent des avertissements (journal), jamais un
      // échec de rendu.
      const hadFatalFlag: boolean = await slot.page.evaluate(() => {
        const core = (window as any).__mjsCore
        return !!(core && core._fatalErrors)
      })
      // Une pile VIDE (`throw 'chaîne'`, valeur sans `.stack`) ne
      // référence AUCUNE ressource, ni projet ni tiers : `isProjectStack` la jugeait donc jamais
      // fatale, page écrite intacte. Ne pouvant l'attribuer à un tiers, elle compte PAR PRUDENCE
      // comme venant du projet — même contrat conservateur que le signal structurel `_fatalErrors`.
      const isProjectStack = (stack: string): boolean =>
        !/^\s*at\s/m.test(stack) || (!!bundler.urlPrefix && stack.includes(bundler.urlPrefix)) || stack.includes(BUNDLE_PATH)
      const pageErrorMsgs = pageErrors.map(err => t('server.browser-erreur-page', { tag, err: err.message }))
      for (const m of pageErrorMsgs) warnings.push(m)
      const fatalPageErrors = pageErrors.filter(err => hadFatalFlag || isProjectStack(err.stack))
      if (fatalPageErrors.length > 0) {
        throw new Error(fatalPageErrors.map(err => t('server.browser-erreur-page', { tag, err: err.message })).join(' | '))
      }

      // (mode `csp`) — même correctif que renderToString.ts : le flag d'hydratation ne
      // passe plus par un `<script>` inline mais par un attribut du nœud racine quand `csp: true`
      // (`csp: false`, défaut : chemin INCHANGÉ, script inline comme avant).
      let attrsStr = Object.entries(attrs).map(([k, v]) => ` ${k}="${escapeAttr(v)}"`).join('')
      // racine légère : l'attribut posé sur l'élément monté (cf. le montage plus haut) doit se
      // retrouver dans la chaîne SERVIE — c'est lui que lit le client au remontage
      if (lightRoot) attrsStr += ' mjs-light'
      if (hydrateMode && config.csp === true) {
        attrsStr += ` data-mjs-ssr-hydrate="${hydrateMode}"`
      }
      // balisage rendu par le serveur : marqué pour rester peint jusqu'au premier rendu client (cf.
      // `mjsSsrMarkTree`, qui couvre tout le reste de l'arbre). La racine porte l'attribut par sa
      // chaîne d'attributs, seule source de sa balise sérialisée.
      attrsStr += ' mjs-ssr'
      let inner = serialized.inner as string
      // shadowMode:'closed' explicite — honore l'option (parité avec renderToString.ts)
      // en réécrivant l'ATTRIBUT ÉMIS (le shadow réel de CETTE page reste 'open', cf.
      // en-tête de fichier — getHTML() en a besoin ; seule la chaîne SERVIE change).
      if (!serialized.light && shadowMode === 'closed') {
        inner = inner.replace('shadowrootmode="open"', 'shadowrootmode="closed"')
        warnings.push(t('server.browser-shadow-closed', { tag }))
      }
      const html = `<${tag}${attrsStr}>${inner}</${tag}>`

      // `html.includes('mjs-fatal-error')` = FAUX POSITIF : une page dont la
      // PROSE cite littéralement cette classe (aucun crash) échouait quand même. Signal STRUCTUREL
      // désormais : le compteur posé par `_mjs_catchError` (mjs_element.ts, `µ._fatalErrors`, incrémenté
      // SEULEMENT quand l'overlay fatal est réellement construit) relu via `window.__mjsCore` (fiable
      // même en build minifié où `window.µ` n'est pas exposé, cf. en-tête de fichier) ; à défaut, un
      // ÉLÉMENT réel `.mjs-fatal-error` dans le DOM (jamais un test de texte).
      const hasFatalOverlay: boolean = await slot.page.evaluate(() => {
        const core = (window as any).__mjsCore
        if (core && core._fatalErrors) return true
        return !!(document.querySelector && document.querySelector('.mjs-fatal-error'))
      })
      if (hasFatalOverlay) {
        throw new Error(t('server.browser-erreur-non-geree', { tag }))
      }

      const sharedScript = buildSharedScript(storeJson) + buildSharedScript(i18nJson, '__mjs_i18n')
      const hydrateScript = (hydrateMode && config.csp !== true) ? '<script>window.__mjs_ssrHydrate=' + JSON.stringify(hydrateMode) + '</' + 'script>' : ''

      return {
        html,
        shadowHtml: serialized.rawShadow,
        css: serialized.css,
        light: serialized.light,
        sharedScript,
        hydrateScript,
        warnings,
      }
    }

    // Course contre le plafond global. `bootPromise` catchée SÉPARÉMENT (ligne
    // suivante) : si `bootRender()` finit par rejeter APRÈS que le timeout a
    // déjà gagné la course (Playwright n'annule RIEN réellement en vol — cf.
    // `reclaimSlot` — l'exécution abandonnée continue en tâche de fond jusqu'à
    // ce que son contexte soit refermé), ce rejet reste géré ici plutôt que de
    // devenir un unhandledRejection (fatal par défaut sur ce Node ≥20).
    const bootPromise = bootRender()
    bootPromise.catch(() => { /* déjà géré par la course ci-dessous, ou par reclaimSlot si elle l'a perdue */ })
    let timedOut = false
    let renderTimer: ReturnType<typeof setTimeout>
    const timeoutPromise = new Promise<never>((_, reject) => {
      renderTimer = setTimeout(() => {
        timedOut = true
        reject(new Error(t('server.browser-render-timeout', { tag, renderTimeoutMs })))
      }, renderTimeoutMs)
    })

    try {
      return await Promise.race([bootPromise, timeoutPromise])
    } finally {
      clearTimeout(renderTimer!)
      slot.page.off('pageerror', onPageError)
      // Chemin nominal (rendu dans les temps) : `release()` habituel, slot
      // remis en `idle` comme avant — AUCUN ralentissement du cas commun (la
      // course ne coûte qu'une Promise + un setTimeout aussitôt annulé).
      // Chemin timeout : JAMAIS `release()` — `reclaimSlot()` (cf. son
      // commentaire : état du slot inconnu, ne doit jamais revenir en `idle`).
      // `.catch` : un échec de démontage (best-effort, cf. `teardownSlot`) ne
      // doit jamais faire déborder CE `finally`.
      if (timedOut) {
        reclaimSlot(slot).catch(() => {})
      } else {
        release(slot)
      }
    }
  }

  async function close(): Promise<void> {
    closed = true
    for (const w of waiters.splice(0)) w.reject(new Error(t('server.browser-ferme-pendant-attente')))
    for (const slot of [...all]) { try { await slot.context.close() } catch { /* best-effort */ } }
    all.length = 0
    idle.length = 0
    if (browserPromise) {
      const p = browserPromise
      browserPromise = null
      try { const b = await p; await b.close() } catch { /* best-effort */ }
    }
    await bundler.close()
    // dossier de travail de CETTE compilation (temporaire en `js: 'bundle'`, cf. plus haut)
    atelier.cleanup()
  }

  return { renderPage, close }
}
