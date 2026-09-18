// render-request — cœur du rendu PAR REQUÊTE.
//
// Donne, pour une URL + des en-têtes de requête, la réponse de rendu : sert la
// page prérendue (fichier), rend le composant à la volée (SSR), ou laisse la main
// au client (CSR). Le mode vient de la config (`resolvePage`), surchargeable par
// un en-tête HTTP (ex. `X-MJS-Render: csr` sur un appel AJAX).
//
// Réutilisé par `mjs serve` (serveur autonome) ET par un middleware d'un back
// existant (Rails/Express…) qui délègue le rendu des pages à MJS. Le renderer SSR
// est créé UNE fois (compile le projet) puis réutilisé à chaque requête.

import { readFileSync, existsSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { resolveBundlerOpts, type MjsConfig, type RenderMode } from '../bundler/config.js'
import { createSSRRenderer, type SSRRenderer } from './renderToString.js'
import { resolvePage } from './render-routes.js'
import { urlToFile } from './prerender.js'
import { isWithinDir, isRealPathWithin } from './render-server.js'
import { resolveEngine, createBrowserRenderer, type BrowserRenderer } from './render-browser.js'
import type { RecordServerFn } from './journal.js'
// render.forwardOrigin : logique de résolution + garde SSRF dans un module FEUILLE
// dédié (cf. son en-tête) — importée ici (usage dans `handle` ci-dessous) ET
// réexportée (chemin d'import public inchangé, `render-request.js`, utilisé par
// les tests).
import { computeForwardedOrigin, isBlockedForwardTarget } from './forward-origin.js'
export { computeForwardedOrigin, isBlockedForwardTarget }
import { t } from '../messages/index.js'

// Le commentaire d'erreur ci-dessous
// interpole `pathname` (contrôlé par l'appelant de la requête HTTP) et
// `e.message` SANS AUCUN échappement, dans un `<!-- ... -->` servi tel quel
// au navigateur. Un pathname contenant `-->` referme le commentaire
// PRÉMATURÉMENT — tout ce qui suit devient du markup RÉEL, EXÉCUTABLE (XSS
// réfléchie) : `/foo--><script>...</script><!--` suffit. Échappe `&`/`<`/`>`
// (pas seulement `<`, comme `escapeAttr` de renderToString.ts le fait pour
// des ATTRIBUTS — ici `>` compte tout autant, c'est lui qui referme `-->`).
function escapeHtml(v: string): string {
  return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// render.forwardOrigin — (SSRF, cf. l'en-tête de
// forward-origin.ts) : `computeForwardedOrigin` ne dérive PLUS JAMAIS l'origine
// de proxy du Host brut de la requête entrante sans autorisation EXPLICITE en
// config (origine fixe, ou allowlist `trustedHosts`) — défaut désormais SÛR.
// SSR PAR REQUÊTE SEULEMENT (CE fichier, appelé par `handle` ci-dessous) : le
// PRÉRENDU (prerender.ts, au `mjs build`) n'a AUCUNE requête HTTP entrante à un
// instant build — cette option ne s'y applique donc JAMAIS (limite STRUCTURELLE
// assumée, pas un oubli à corriger).

export type RenderKind = 'prerender' | 'ssr' | 'csr' | 'error'

export interface RenderResponse {
  /** Ce que le serveur a décidé de faire. `csr` = pas de rendu serveur, le back
   *  sert le shell et le client monte le composant. */
  kind: RenderKind
  status: number
  /** Corps HTML (fragment DSD + sharedScript pour prerender/ssr ; vide pour csr :
   *  le caller sert le shell). */
  body: string
  /** Composant résolu (si l'URL est une page déclarée). */
  component?: string
  /** Mode effectif appliqué (après override header + héritage default). */
  mode?: RenderMode
  /** Présent seulement sur un status 503 (rendu SSR/browser saturé, cf. RenderGate
   *  plus bas) : nombre de secondes suggéré avant de réessayer — l'appelant HTTP le pose en
   *  en-tête Retry-After (cf. server/index.ts). */
  retryAfter?: number
}

export interface RenderHandler {
  /** Résout et rend l'URL. `headers` = en-têtes de la requête (pour l'override). `signal` :
   *  abandon du DEMANDEUR (socket HTTP fermée côté appelant, ou tout AbortSignal transmis
   *  par un usage « middleware ») — retire la requête de la file d'attente de RenderGate dès
   *  l'abandon plutôt que de garder sa place jusqu'à son tour naturel ; absent = comportement
   *  HISTORIQUE inchangé (jamais de retrait anticipé). */
  handle(pathname: string, headers?: Record<string, string | string[] | undefined>, signal?: AbortSignal): Promise<RenderResponse>
  /** Libère le renderer SSR (à l'arrêt du serveur). */
  close(): Promise<void>
}

// (DoS — résilience) — plafond de CONCURRENCE sur le rendu SSR/browser PAR REQUÊTE :
// sans lui, une route paramétrée (ex. `/produit/:id`) offre un espace d'URLs quasi infini, chacune
// déclenchant un rendu complet EN MÊME TEMPS que toutes les autres (moteur happy-dom par défaut,
// jamais borné — seul le moteur 'browser', non défaut, a son propre pool, cf.
// render.browserPool/render-browser.ts). Défauts « raisonnables » (4 rendus simultanés, 32 en
// ATTENTE derrière) : la clé `render.renderQueue` (`concurrency`/`maxQueue`) suit le MÊME esprit de
// nommage que `render.browserPool` (size/keepAlive/maxAgeMs) — lue en souple (`as any`) : le schéma
// de config (bundler/config.ts, KNOWN_RENDER_KEYS) est HORS PÉRIMÈTRE ICI — la protection tourne
// dès maintenant, avec ses défauts, sans cette clé déclarée.
const DEFAULT_RENDER_CONCURRENCY = 4
const DEFAULT_RENDER_MAX_QUEUE   = 32
const RENDER_RETRY_AFTER_S       = 1

// sémaphore borné : au plus `concurrency` exécutions EN MÊME TEMPS, au plus `maxQueue` EN ATTENTE
// derrière — au-delà, `run()` rend `null` IMMÉDIATEMENT (jamais un rendu qui patiente
// indéfiniment, jamais une file qui grossit sans borne).
class RenderGate {
  private inFlight = 0
  private waiting: Array<{ resolve: () => void; aborted: boolean }> = []

  constructor(private concurrency: number, private maxQueue: number) {
    // Clampe l'invariant ci-dessus : `new
    // RenderGate(0, N)` (concurrency:0) bloquait TOUT rendu À VIE (`inFlight` ne peut jamais être
    // < 0, la porte « au plus concurrency exécutions » ne s'ouvre donc jamais), contredisant
    // « jamais un rendu qui patiente indéfiniment ». Voie « middleware » (createRenderHandler()
    // appelé directement avec un objet config construit à la main, cf. l'en-tête de fichier) : HORS
    // mjs.config.json, donc hors validateRenderQueueConfig (bundler/config.ts), qui refuse déjà
    // concurrency < 1/maxQueue < 0 côté fichier — ce clamp est le SEUL filet pour cette voie.
    if (this.concurrency < 1) this.concurrency = 1
    if (this.maxQueue < 0) this.maxQueue = 0
  }

  async run<T>(fn: () => Promise<T>, signal?: AbortSignal): Promise<T | null> {
    if (this.inFlight >= this.concurrency) {
      if (signal?.aborted) return null
      if (this.waiting.length >= this.maxQueue) return null
      // Requête EN FILE abandonnée par le client (socket
      // fermée, ou tout appelant « middleware » qui transmet son propre AbortSignal) : sans ce
      // filet, l'entrée restait dans `waiting` jusqu'à SON TOUR NATUREL — la file paraissait pleine
      // aux requêtes suivantes (503 en cascade) alors que le client n'attendait déjà plus personne
      // (amplification). `indexOf` : si le tour est DÉJÀ venu naturellement (shift() plus bas, avant
      // un abandon tardif), l'entrée n'est plus dans `waiting` — no-op, jamais de double résolution.
      const entry = { resolve: () => {}, aborted: false }
      const queued = new Promise<void>((r) => { entry.resolve = r })
      this.waiting.push(entry)
      const onAbort = () => {
        const idx = this.waiting.indexOf(entry)
        if (idx === -1) return
        this.waiting.splice(idx, 1)
        entry.aborted = true
        entry.resolve()
      }
      signal?.addEventListener('abort', onAbort)
      await queued
      signal?.removeEventListener('abort', onAbort)
      if (entry.aborted) return null
    }
    this.inFlight++
    try {
      return await fn()
    } finally {
      this.inFlight--
      const next = this.waiting.shift()
      if (next) next.resolve()
    }
  }
}

/**
 * Construit le handler de rendu pour un projet. Le renderer SSR est créé
 * paresseusement (à la 1ʳᵉ requête SSR) pour ne rien coûter aux projets 100 %
 * prérendu/CSR, puis réutilisé (compile une seule fois).
 */
export async function createRenderHandler(config: MjsConfig, configDir: string, recordServer?: RecordServerFn, env?: 'dev' | 'prod'): Promise<RenderHandler> {
  const render = config.render
  // Le corps d'erreur ne testait QUE `NODE_ENV === 'production'`,
  // ignorant `env` (`mjs serve --prod` le transmet, cf. render-server.ts) : un `--prod` sans
  // NODE_ENV positionné divulguait le message brut au client. Déclaré une fois ici, réutilisé
  // dans `handle` ci-dessous.
  const isProd = env === 'prod' || process.env.NODE_ENV === 'production'
  const outputDir = resolve(configDir, config.outputDir || 'dist')
  const sourceDir = resolve(configDir, config.sourceDir || '.')
  const pagesDir = render?.outDir ? resolve(configDir, render.outDir) : join(dirname(outputDir), 'mjs_pages')
  const headerName = (render?.header || 'X-MJS-Render').toLowerCase()
  // Cf. commentaire détaillé
  // sur `SSRRendererOptions.bundlerOpts` (renderToString.ts) : la liste blanche d'options
  // écrite à la main perdait silencieusement toute clé qu'on avait oublié d'y inscrire
  // (`minify`, `runtime`, `preload`, `urlPrefix`…). On transmet les options RÉSOLUES —
  // le rendu par requête compile à l'identique du build, comme la voie navigateur.
  const bundlerOpts = resolveBundlerOpts(config, configDir)

  // Plafond de concurrence sur le rendu PAR REQUÊTE (cf. RenderGate ci-dessus).
  const renderQueueCfg = (render as any)?.renderQueue
  const renderGate = new RenderGate(renderQueueCfg?.concurrency ?? DEFAULT_RENDER_CONCURRENCY, renderQueueCfg?.maxQueue ?? DEFAULT_RENDER_MAX_QUEUE)

  // `if (!renderer) { renderer = await
  // createSSRRenderer(...) }` : `renderer` n'est assigné qu'APRÈS l'`await`
  // — 2 requêtes SSR concurrentes À FROID (avant la 1ʳᵉ résolution) voient
  // TOUTES LES DEUX `renderer === null` et lancent CHACUNE leur propre
  // `createSSRRenderer` (compile tout le projet + dossier temp + bundler,
  // opération coûteuse) ; la 2e assignation écrase la 1ʳᵉ, dont les
  // ressources (bundler, worker pool, dossier temp) ne sont JAMAIS
  // `close()`-ées → fuite. Même famille de bug que `ensureWorkerPool`
  // (bundler/index.ts, déjà corrigé) — même fix : mémoïser
  // la PROMESSE elle-même (pas la valeur résolue), assignée AVANT tout
  // `await`, pour qu'un 2e appelant concurrent trouve la mémoïsation déjà en
  // place et attende LE MÊME renderer au lieu d'en recréer un.
  let rendererPromise: Promise<SSRRenderer> | null = null
  // Sans ce garde, un `handle()`
  // retardataire/concurrent survenant APRÈS `close()` retrouvait
  // `rendererPromise === null` et RECRÉAIT un renderer complet (compile tout le
  // projet + dossier temp) que plus rien ne refermerait ensuite → fuite au
  // shutdown. Le flag rend `close()` définitif.
  let closed = false
  async function getRenderer(): Promise<SSRRenderer> {
    if (closed) throw new Error(t('server.render-handler-ferme'))
    if (!rendererPromise) {
      // `env` : ce renderer recompile dans le VRAI `outputDir` à la 1re requête SSR — sans lui,
      // un serveur lancé en `--prod` verrait son build repassé en développement par cette passe
      rendererPromise = createSSRRenderer({ sourceDir, outputDir, bundlerOpts, env })
      // Une création qui ÉCHOUE ne doit pas "bricker" tous les appels
      // futurs avec la même promesse rejetée à vie — libère la mémoïsation
      // pour permettre un nouvel essai à la prochaine requête.
      rendererPromise.catch(() => { rendererPromise = null })
    }
    return rendererPromise
  }

  // Même motif de mémoïsation que `getRenderer()` ci-dessus (promesse assignée
  // AVANT tout `await`, libérée sur échec, bloquée par `closed`) — le moteur
  // navigateur est un SINGLETON paresseux au niveau du handler : créé à la 1ʳᵉ
  // requête qui en a besoin (résolue vers 'browser', cf. `resolveEngine`), puis
  // réutilisé par TOUTES les requêtes suivantes — c'est LE pool amorti en prod.
  let browserRendererPromise: Promise<BrowserRenderer> | null = null
  async function getBrowserRenderer(): Promise<BrowserRenderer> {
    if (closed) throw new Error(t('server.render-handler-ferme'))
    if (!browserRendererPromise) {
      browserRendererPromise = createBrowserRenderer(config, { configDir, env })
      browserRendererPromise.catch(() => { browserRendererPromise = null })
    }
    return browserRendererPromise
  }

  async function handle(pathname: string, headers: Record<string, string | string[] | undefined> = {}, signal?: AbortSignal): Promise<RenderResponse> {
    const raw = headers[headerName]
    const override = Array.isArray(raw) ? raw[0] : raw
    const page = resolvePage(pathname, render, override || null)

    // URL non déclarée, ou page explicitement en CSR → le back sert le shell.
    if (!page || page.mode === 'csr') {
      return { kind: 'csr', status: 200, body: '', component: page?.component, mode: page?.mode }
    }

    // Prérendu : servir le fichier figé au build s'il existe.
    if (page.mode === 'prerender') {
      const file = join(pagesDir, urlToFile(pathname))
      // (path traversal) — défense
      // en profondeur : le serveur autonome (`render-server.ts`) rejette déjà
      // les `..` en amont, mais un hôte middleware (Rails/Express) réutilisant
      // ce handler pourrait passer un `pathname` décodé contenant `..`, faisant
      // sortir `file` de `pagesDir`. On ne LIT le fichier prérendu que s'il reste
      // DANS `pagesDir` ; sinon repli résilient (SSR/CSR), jamais de readFileSync
      // hors dossier.
      if (isWithinDir(pagesDir, file) && existsSync(file) && isRealPathWithin(pagesDir, file)) {
        return { kind: 'prerender', status: 200, body: readFileSync(file, 'utf-8'), component: page.component, mode: page.mode }
      }
      // Fichier absent (build pas encore lancé) ou hors pagesDir → repli résilient : on rend à la volée.
    }

    // SSR (ou prerender sans fichier) : rendu à la volée. Le mode d'hydratation
    // dérive de `ssr:<x>` (défaut replace).
    const ssrMode = (page.mode.startsWith('ssr:') ? page.mode.slice(4) : 'replace') as 'replace' | 'markers' | 'positional' | 'diff'
    // render.forwardOrigin (défaut SÛR : jamais dérivé du Host client) — cf.
    // computeForwardedOrigin (forward-origin.ts).
    const forwarded = computeForwardedOrigin(render, pathname, headers)
    try {
      // Moteur résolu PAR REQUÊTE (route.engine > render.engine.request > défaut
      // 'happy-dom', jamais 'browser' en défaut implicite ici — cf. resolveEngine) :
      // un navigateur n'est lancé QUE si explicitement configuré pour cet axe.
      const engine = await resolveEngine('request', config, page)
      // Gate AUTOUR du rendu lui-même seulement (pas resolveEngine, pas le prérendu/CSR
      // plus haut, gratuits) : saturé ⇒ null immédiat, jamais un rendu qui patiente indéfiniment.
      const gated = await renderGate.run(async () => engine === 'browser'
        ? await (await getBrowserRenderer()).renderPage(page.component, { props: page.params, ssrMode, settleMs: page.settleMs, light: page.light, ...forwarded })
        : await (await getRenderer()).renderToString(page.component, { props: page.params, ssrMode, settleMs: page.settleMs, light: page.light, ...forwarded }), signal)
      if (gated === null) {
        return { kind: 'error', status: 503, body: 'Service Unavailable', component: page.component, mode: page.mode, retryAfter: RENDER_RETRY_AFTER_S }
      }
      const { html, sharedScript, hydrateScript, warnings } = gated
      // Les warnings du rendu
      // (shadowMode:'closed', rendu non stabilisé, compilation du bundler SSR…)
      // étaient destructurés HORS (`{ html, sharedScript }`) donc perdus : aucun
      // signal dans les flux réels (seul un test unitaire les voyait). On les logue.
      if (warnings.length) for (const w of warnings) console.warn(w)
      // TROUVAILLE LATENTE — `hydrateScript` (balise
      // `<script>window.__mjs_ssrHydrate=…</script>`, posée par renderToString/
      // renderPage pour ssr:markers/positional/diff, cf. RenderResult) était
      // déstructuré NULLE PART ici : perdu pour toute requête réelle — le client
      // ne voyait JAMAIS le flag d'activation, reconstruisait systématiquement
      // au lieu d'hydrater (mjs_init.ts lit `globalThis.__mjs_ssrHydrate` au
      // boot, avant tout montage). Placé APRÈS le html : script CLASSIQUE (pas
      // `type=module`), il s'exécute dès le parsing, donc AVANT le bundle module
      // (toujours différé) quel que soit l'ordre relatif dans le document. Vide
      // en ssr:replace (RenderResult.hydrateScript === '' dans ce mode) → zéro
      // changement de body pour le mode par défaut (non-régression).
      const body = (sharedScript ? sharedScript + '\n' : '') + html + (hydrateScript ? '\n' + hydrateScript : '')
      return { kind: 'ssr', status: 200, body, component: page.component, mode: page.mode }
    } catch (e: any) {
      // En prod, ne pas divulguer au
      // client le message brut (chemins temp/bundle, structure interne exposés
      // dans un commentaire HTML servi tel quel). Message générique sous `isProd`
      // (env: 'prod' OU NODE_ENV=production) ; en dev le détail échappé reste précieux à diagnostiquer.
      const rawMessage = String(e?.message || e)
      const detail = isProd
        ? t('server.render-erreur-interne')
        : escapeHtml(rawMessage)
      const bodyMsg = t('server.render-echec-html', { component: page.component, pathname: escapeHtml(pathname), detail })
      // (point 3 de capture, trou réparé — auparavant, cet échec n'était JAMAIS journalisé
      // nulle part, ni console ni fichier) — même texte que le corps (les DEUX clés existantes,
      // server.render-erreur-interne pour `detail` en prod ET server.render-echec-html pour ce
      // message, cf. cartographie) ; le journal, lui, reçoit TOUJOURS le message RÉEL (jamais
      // redacté — sa propre protection d'accès, config.journal.viewer, joue ce rôle en prod).
      console.error(bodyMsg)
      recordServer?.({ message: rawMessage, pile: e?.stack, url: pathname })
      return {
        kind: 'error', status: 500,
        body: bodyMsg,
        component: page.component, mode: page.mode,
      }
    }
  }

  return {
    handle,
    close: async () => {
      closed = true
      if (rendererPromise) {
        const r = await rendererPromise.catch(() => null)
        rendererPromise = null
        if (r) await r.close()
      }
      // Ferme aussi le renderer navigateur (s'il a été créé) — c'est ce chemin,
      // délégué depuis `render-server.ts` (`close: async () => { await handler.close(); … }`),
      // qui assure la fermeture propre du navigateur à l'arrêt du serveur
      // (signal/close) : aucun changement requis dans render-server.ts lui-même.
      if (browserRendererPromise) {
        const br = await browserRendererPromise.catch(() => null)
        browserRendererPromise = null
        if (br) await br.close()
      }
    },
  }
}
