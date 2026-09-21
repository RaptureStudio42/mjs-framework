// server — serveur HTTP statique pour fichiers compilés (dev mode).
//
// V2 est 100% standalone, zéro dépendance à un framework backend spécifique :
//   - esbuild est en-process → plus de socket externe
//   - chokidar watch est en-process → le bundler recompile direct
//   - ce serveur sert les fichiers compilés via HTTP, suffisant pour le dev
//
// Pour la prod, n'importe quel serveur statique (nginx, Caddy, Express,
// Express, hébergement) peut servir `outputDir/` tel quel. Aucune intégration
// framework requise — le bundler produit un manifest `µ.paths = {...}` que
// le browser charge directement via `<script src="bundle.js">`.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFileSync, writeFileSync, existsSync, statSync } from 'node:fs'
import { resolve, join, extname } from 'node:path'
import { normalizeUrlPrefix, type MjsConfig } from '../bundler/config.js'
import { HMRServer, hmrClientSnippet, isTrustedDevOrigin } from './hmr.js'
import { shell, isRealPathWithin, MIME } from './render-server.js'
import { buildSsrHead } from './ssr-head.js'
import { rewriteThemeValue } from './theme-write.js'
import { readBuildVersion } from './build-version.js'
import { getViewerScript, isViewerAllowed, viewerScriptElement, warnIfJournalViewerOpenInProd, isProdEnv, JOURNAL_VIEWER, THEME_VIEWER } from './viewer-page.js'
import type { Journal, RecordServerFn } from './journal.js'
import { isPlainObject } from './serve-entry.js'
import type { RenderHandler, RenderResponse } from './render-request.js'
import type { ServeEntry } from './serve-entry.js'
import { handleMutatingRequest, MUTATING_METHODS, navExtras } from './action-pipeline.js'
import { TokenBucket, pruneIdleBuckets } from './token-bucket.js'
import { resolvePage } from './render-routes.js'
import { escapeJsonForScript } from './renderToString.js'
import { t } from '../messages/index.js'

// Chemin virtuel FIXE du bundle pour la résolution `render.routes` en dev — même
// convention que render-server.ts (`/__mjs/bundle.js`, hors de `outputDir`/
// `pathPrefix`) : fonctionne quelle que soit la configuration réelle du projet
// (manifestPath externe, urlPrefix custom…), cf. renderFallback ci-dessous.
const RENDER_BUNDLE_PATH = '/__mjs/bundle.js'

// Crible des variables de thème éditables en direct (POST /__mjs/theme/edit) — LISTE BLANCHE
// de FORMES, pas seulement de caractères. Le nom suit VAR_ID_RE du transpiler (tirets internes
// admis, cf. transpiler/style-vars.ts).
//
// La valeur doit ÊTRE une couleur : `#rgb`/`#rrggbb`/`#rrggbbaa`, un appel à l'une des fonctions
// couleur nommées ci-dessous, ou un mot-clé nu (`red`, `transparent`, `currentColor`). Un simple
// crible de caractères ne suffisait pas : il admettait `url(//exemple.test/x)`, qui n'est pas
// une couleur mais déclenche une requête réseau dès qu'une variable sert d'image de fond — une
// page tierce peut POSTer ici en cross-origin sans lire la réponse (cf. l'avertissement d'origine
// en tête de hmr.ts). `url` n'est pas dans la liste, donc la forme entière est refusée.
const THEME_NAME_RE  = /^[A-Za-z_][A-Za-z0-9_-]*$/
const THEME_FN       = 'rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix|var'
const THEME_VALUE_RE = new RegExp('^(?:#[0-9A-Fa-f]{3,8}|(?:' + THEME_FN + ')\\([A-Za-z0-9 ,.%#()\\/_-]{0,56}\\)|[A-Za-z][A-Za-z-]{0,31})$')
/** Plafond de longueur, tenu à part du motif : une valeur légale mais absurdement longue
 *  n'a rien à faire dans une feuille de style, et un motif borné se relit mal. */
const THEME_VALUE_MAX = 64

export interface ServerOpts {
  /** Répertoire à servir. */
  rootDir: string
  /** Port TCP (défaut : 3939). */
  port?: number
  /** Hostname (défaut : '127.0.0.1'). */
  host?: string
  /** Préfixe de path (défaut : '/modularjs'). */
  pathPrefix?: string
  /** Environnement du build (`--prod` côté CLI, MÊME paramètre que `mjs serve`
   *  reçoit déjà, cf. render-server.ts `RenderServerOptions.env`) : ferme `/__mjs/theme(.json)` et
   *  la visionneuse du journal (`isViewerAllowed`/`warnIfJournalViewerOpenInProd`, viewer-page.ts)
   *  en production même sans `NODE_ENV=production` posé séparément (même OR que render-request.ts,
   *  `isProdEnv = env==='prod' || NODE_ENV==='production'`) — AVANT, ces gardes ne
   *  regardaient QUE `NODE_ENV`. Absent ⇒ NODE_ENV reste seul juge, comportement HISTORIQUE
   *  inchangé. */
  env?: 'dev' | 'prod'
  /** Active le HMR WebSocket (défaut : false). */
  hmr?: boolean
  /**
   * Résolution `render.routes` pour les chemins HORS assets (`mjs dev` + bloc
   * `render` dans mjs.config.json) — même moteur que `mjs serve`
   * (`createRenderHandler`, cf. server/render-request.ts) : le HTML
   * prérendu/SSR FRAIS est servi directement en dev plutôt qu'un 404 sec.
   * Absent (pas de bloc `render` dans la config) = 404 pour tout chemin hors
   * `pathPrefix`, comportement HISTORIQUE inchangé. `manifestPath` DOIT
   * accompagner `renderHandle` (sert le bundle sur `RENDER_BUNDLE_PATH`, requis
   * par le shell HTML enveloppant la page rendue) — sans lui, `renderHandle`
   * est ignoré (repli 404, aucun rendu à moitié fonctionnel). L'INVERSE n'est
   * PAS vrai : cf. `manifestPath` juste en dessous.
   * PRIORITÉS INCHANGÉES : les chemins d'assets (`pathPrefix`, ligne ci-dessus)
   * et le canal HMR restent servis EXACTEMENT comme avant, TOUJOURS AVANT toute
   * résolution render (cf. `handle`, cette résolution n'intervient QUE là où le
   * code existant retournait déjà 404).
   */
  renderHandle?: RenderHandler['handle']
  /** Chemin absolu du bundle compilé. Requis PAR `renderHandle` (cf. ci-dessus), mais
   *  INDÉPENDANT de lui : `mjs dev` le passe TOUJOURS (cli.ts), bloc `render`
   *  ou pas. C'est lui — et lui seul — qui ouvre `RENDER_BUNDLE_PATH`, les deux visionneuses
   *  (`/__mjs/errors`, `/__mjs/theme`, qui y lisent le chemin du cœur µ) et le tag `version`
   *  des entrées de journal. Auparavant il était nullifié en l'absence de `renderHandle` :
   *  un projet sans bloc `render` n'avait donc PAS de journal consultable, alors que le
   *  manifeste, lui, existait bel et bien sur le disque. */
  manifestPath?: string
  /** Config + dossier de config du projet — SEULS arguments qu'il manquait à
   *  `buildSsrHead` (déjà appelée par `mjs serve`, cf. render-server.ts) pour thémer aussi le
   *  `<head>` des pages render.routes servies par `mjs dev` (serveRenderFallback plus bas). Absents
   *  (pas de mjs.config.json trouvé, cf. cli.ts `findConfig`) ⇒ `headExtra` reste '' — comportement
   *  HISTORIQUE inchangé, jamais de page cassée pour un thème manquant. */
  config?: MjsConfig
  configDir?: string
  /** Racine du PROJET (dossier de `mjs.config.json`, ou `--root` sans config trouvée) — dernier
   *  repli pour tout chemin HORS `pathPrefix` quand `renderHandle` est absent (cf. `handle`) :
   *  sert `index.html`/`public/…` directement depuis ce dossier, comme le ferait un serveur de
   *  dev Vite/Angular : sans lui, un projet SANS bloc `render` ne recevait QUE ses assets
   *  compilés (`pathPrefix`), sa propre page restant à la charge d'un serveur tiers. `renderHandle` reste PRIORITAIRE et STRICTEMENT inchangé — cette racine n'est
   *  jamais consultée quand un bloc `render` est configuré. Absent (StaticServer construit
   *  directement, hors `mjs dev` — la quasi-totalité des tests existants) ⇒ 404 HISTORIQUE
   *  inchangé pour tout chemin hors `pathPrefix`, comme avant cette feature. Fichier/dossier
   *  caché (segment `.xxx`) ou `node_modules/` jamais servis, même présents sur le disque —
   *  cf. `serveProjectRoot`. */
  projectRoot?: string
  /** Langue statique de `<html lang>` (shell render.routes en dev) — défaut 'fr',
   *  résolue par cli.ts depuis `config.i18n.default`. Même limite que render-server.ts
   *  (mjs serve) : statique, pas de résolution par-visiteur. */
  defaultLang?: string
  /** Magasin du journal d'erreurs 3 étages, MÊME magasin que `mjs serve`
   *  (cf. render-server.ts, createJournal) — construit par cli.ts UNIQUEMENT quand un
   *  mjs.config.json existe (coût nul tant qu'aucun fichier n'est lu/écrit, cf. journal.ts).
   *  Absent ⇒ AUCUNE des 4 routes /__mjs/errors(.json) n'est servie par `handle`, comportement
   *  HISTORIQUE inchangé. Présent : les portes `journal.client`/`journal.viewer`/`journal.server`
   *  (mêmes défauts que `mjs serve` — false/true hors prod/true) sont relues à CHAQUE requête
   *  depuis `config.journal` (option ci-dessus), pas de pré-gating à la construction. */
  journal?: Journal
  /** Chargeur d'actions `.server.mjs` (cf. serve-entry.ts), MÊME instance que `mjs serve`
   *  brancherait : ouvre le pipeline partagé (action-pipeline.ts) sur les verbes mutants (POST/PUT/
   *  PATCH/DELETE). Absent (pas de mjs.config.json, cf. cli.ts) ⇒ AUCUN verbe mutant n'est traité ici,
   *  comportement HISTORIQUE inchangé (405 sec, cf. `handle`). `entry.close()` est de la responsabilité
   *  de l'appelant (cli.ts), pas de `StaticServer.stop()` — même posture que `renderHandle` ci-dessus. */
  entry?: ServeEntry
  /** Accompagne `entry` (capture des exceptions d'action, point 2) — MÊME contrat que
   *  render-server.ts. Absent ⇒ no-op transmis tel quel au pipeline. */
  recordServer?: RecordServerFn
}

// Fusionnée sur la table de `mjs serve` (MIME, render-server.ts) : UNE seule source
// pour les types binaires (images/polices/son) — auparavant, deux tables tenues séparément, une
// seule à jour (les fichiers `.webp`/`.woff2`/`.png`/`.jpg`/`.woff`/`.ico` recevaient
// `application/octet-stream`). Les entrées LOCALES ci-dessous (avec charset, + `.map`, absent de
// l'autre table) gardent le pas sur celles de MIME (spread en premier) ; `.avif`/`.mp3` ajoutées
// ICI (ni l'une ni l'autre table ne les couvrait encore).
const MIME_TYPES: Record<string, string> = {
  ...MIME,
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.map':  'application/json; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.avif': 'image/avif',
  '.mp3':  'audio/mpeg',
}

// Sérialise µres pour le 1er chargement HTML, MÊME fonction que render-server.ts
// (resScript, non exportée là-bas — dupliquée ICI à l'identique plutôt que factorisée, sans
// toucher render-server.ts). Props vides → chaîne vide (zéro octet
// ajouté).
function resScript(pathname: string, props: Record<string, unknown>): string {
  if (Object.keys(props).length === 0) return ''
  try {
    const json = JSON.stringify(props)
    return `<script type="application/json" id="__mjs_res">${escapeJsonForScript(json)}</script>`
  } catch (e: any) {
    console.warn(t('server.res-serialisation-echec', { pathname, erreur: e && e.message ? e.message : String(e) }))
    return ''
  }
}

// Seau à jetons par IP (POST /__mjs/errors) — CLASSE PARTAGÉE,
// cf. token-bucket.ts (portait ici une copie locale, comme render-server.ts).
export class StaticServer {
  rootDir: string
  port: number
  host: string
  pathPrefix: string
  env: 'dev' | 'prod' | undefined
  server: ReturnType<typeof createServer> | null = null
  hmr: HMRServer | null = null
  hmrEnabled: boolean
  renderHandle: RenderHandler['handle'] | null
  manifestPath: string | null
  config: MjsConfig | null
  configDir: string | null
  projectRoot: string | null
  defaultLang: string
  journal: Journal | null
  entry: ServeEntry | null
  recordServer: RecordServerFn
  errorsRateLimit = new Map<string, TokenBucket>()

  constructor(opts: ServerOpts) {
    this.rootDir = resolve(opts.rootDir)
    this.port = opts.port ?? 3939
    this.host = opts.host ?? '127.0.0.1'
    // Normalisation DÉFENSIVE (slashs finaux retirés) :
    // `StaticServer` peut être construit directement (middleware, tests), hors `validateConfig`
    // (bundler/config.ts), qui normalise déjà `urlPrefix` côté mjs.config.json — sans ce filet ICI
    // aussi, un `pathPrefix: '/app/'` cassait tout matching d'asset (cf. handle() plus bas).
    this.pathPrefix = normalizeUrlPrefix(opts.pathPrefix ?? '/modularjs')
    this.env = opts.env
    this.hmrEnabled = opts.hmr ?? false
    this.defaultLang = opts.defaultLang ?? 'fr'
    // Appariement à SENS UNIQUE (cf. ServerOpts.renderHandle/manifestPath) — un `manifestPath`
    // manquant rendrait `renderHandle` inerte (bundle jamais servable par la page rendue) : on
    // préfère le repli 404 HISTORIQUE, jamais un rendu à moitié fonctionnel. L'INVERSE n'est
    // PAS vrai : un `manifestPath` seul (projet sans bloc `render`) est parfaitement exploitable —
    // il sert le bundle sur RENDER_BUNDLE_PATH, ouvre les deux visionneuses et tague les entrées
    // de journal. Le nullifier privait `mjs dev` de son propre journal pour une raison qui ne
    // concernait que le rendu.
    this.renderHandle = (opts.renderHandle && opts.manifestPath) ? opts.renderHandle : null
    this.manifestPath = opts.manifestPath ?? null
    // Utilisés SEULEMENT par serveRenderFallback (déjà gaté par this.renderHandle) :
    // pas besoin du même appariement strict que renderHandle/manifestPath ci-dessus, absents ⇒
    // simplement pas de <head> thématisé pour ce chemin (cf. serveRenderFallback).
    this.config = opts.config ?? null
    this.configDir = opts.configDir ?? null
    // cf. ServerOpts.projectRoot : absent ⇒ 404 HISTORIQUE inchangé pour tout chemin hors
    // `pathPrefix` (cf. `handle`) — résolu en absolu, même défense que `this.rootDir` ci-dessus.
    this.projectRoot = opts.projectRoot ? resolve(opts.projectRoot) : null
    warnIfJournalViewerOpenInProd(this.config?.journal?.viewer, this.env) // une fois au démarrage, cf. viewer-page.ts
    // cf. ServerOpts.journal : absent ⇒ AUCUNE route journal servie par `handle`.
    this.journal = opts.journal ?? null
    // cf. ServerOpts.entry : absent ⇒ AUCUN verbe mutant traité par `handle` (405 sec, porte
    // GET/HEAD historique inchangée).
    this.entry = opts.entry ?? null
    this.recordServer = opts.recordServer ?? (() => {})
  }

  async start(): Promise<void> {
    return new Promise((resolveStart, reject) => {
      // `handle` est désormais async (résolution render.routes, cf. plus bas) —
      // `createServer` ne l'attend pas (fire-and-forget, comme tout serveur HTTP
      // Node) ; le `.catch` est un filet best-effort, `handle` ne devrait jamais
      // rejeter (chaque branche gère déjà ses propres erreurs), défense en
      // profondeur seulement (même posture que render-server.ts, son propre
      // handler HTTP). Dernier filet du journal (recordServerError, no-op
      // sans this.journal) : même posture que le catch global de render-server.ts (point 1).
      this.server = createServer((req, res) => { this.handle(req, res).catch((e) => { this.recordServerError(e, req.url || '/'); try { res.destroy() } catch { /* ignore */ } }) })
      this.server.on('error', reject)
      this.server.listen(this.port, this.host, () => {
        if (this.hmrEnabled) {
          this.hmr = new HMRServer(this.server!)
          // eslint-disable-next-line no-console
          console.log(t('server.index-hmr-actif', { host: this.host, port: this.port }))
        }
        // eslint-disable-next-line no-console
        console.log(t('server.index-ecoute', { host: this.host, port: this.port, pathPrefix: this.pathPrefix }))
        resolveStart()
      })
    })
  }

  async stop(): Promise<void> {
    if (this.hmr) this.hmr.close()
    if (!this.server) return
    return new Promise(r => this.server!.close(() => r()))
  }

  /** Notifie tous les clients HMR connectés. */
  notifyReload(modules: string[] = []): void {
    this.hmr?.notifyReload(modules)
  }

  /** Snippet client à injecter dans la page de dev. */
  getHMRClientSnippet(): string {
    const protocol = 'ws'
    const wsUrl = `${protocol}://${this.host}:${this.port}/__mjs_hmr`
    return hmrClientSnippet(wsUrl)
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // `req.url` inclut la
    // query-string (`?v=5`, `?_hmr=...`) ; sans la retirer AVANT toute
    // résolution de chemin, `app-xxx.js?v=5` devient un nom de fichier
    // LITTÉRAL → `statSync` échoue → 404. Or le HMR CSS ajoute justement un
    // `?_hmr=<ts>` cache-buster sur les `<link rel=stylesheet>` (cf. hmr.ts) —
    // sans cette césure, tout asset demandé avec un cache-buster casse.
    const url = (req.url ?? '/').split('?')[0]

    // cf. commentaire détaillé dans
    // hmr.ts (`isTrustedDevOrigin`) : un wildcard `*` inconditionnel permet à
    // N'IMPORTE QUEL site web de LIRE la réponse (fetch/XHR) d'une requête
    // vers ce serveur de dev local — combiné à un DNS rebinding, un site
    // distant peut ainsi lire le contenu servi ici. Restreint aux origines
    // locales de confiance (autre port = autre origine pour CORS, donc un
    // dashboard/app local sur un port différent reste couvert).
    const origin = req.headers.origin
    if (isTrustedDevOrigin(origin)) {
      res.setHeader('Access-Control-Allow-Origin', origin ?? '*')
    }

    // Aperçu de thème EN DIRECT (atelier /__mjs/theme) — deux routes, traitées ICI pour la
    // même raison que le journal juste en dessous : avant la porte GET/HEAD (le POST lui est
    // propre) et avant la barrière `/__mjs/…` des requêtes mutantes, qui sinon rendrait 404 sur
    // ce POST. Même garde de production que l'atelier : 404, jamais 403.
    //   GET  → le direct est-il possible ici, et combien de pages écoutent
    //   POST → diffuse les couleurs aux pages ouvertes. RIEN n'est écrit sur le disque : un
    //          aperçu ne touche jamais le source (cadrage 21/09), le canal HMR suffit.
    if (url === '/__mjs/theme/edit') {
      if (isProdEnv(this.env)) { res.statusCode = 404; res.end('Not Found'); return }
      const varPrefix = this.config?.varPrefix ?? 'mjs'
      if (req.method === 'GET') {
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        // `clients` sert à l'atelier pour distinguer « rien ne bouge » de « aucune page
        // ouverte » — deux pannes identiques à l'écran, deux causes opposées.
        res.end(JSON.stringify({ live: !!this.hmr, clients: this.hmr?.clientCount ?? 0, varPrefix }))
        return
      }
      if (req.method === 'POST') { await this.serveThemeEditPost(req, res, varPrefix); return }
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    // POST /__mjs/theme/write — l'interrupteur « enregistrer » de l'atelier est allumé : la
    // couleur ne se contente plus d'être diffusée aux pages ouvertes, elle est ÉCRITE dans le
    // fichier qui la déclare, à sa ligne — ce que tu vois devient ce qui est. Route SÉPARÉE
    // de /edit, et plus sévère : /edit parle à des pages déjà
    // ouvertes, celle-ci touche le code source.
    if (url === '/__mjs/theme/write') {
      if (isProdEnv(this.env)) { res.statusCode = 404; res.end('Not Found'); return }
      if (req.method !== 'POST') { res.statusCode = 405; res.end('Method Not Allowed'); return }
      // origine vérifiée ICI alors que /edit s'en passe : n'importe quelle page du navigateur
      // peut POSTer en cross-origin sans lire la réponse (cf. l'en-tête de hmr.ts) — sur une
      // diffusion ça repeint un onglet de dev, ici ça écrirait dans le code du projet
      if (!isTrustedDevOrigin(req.headers.origin)) { res.statusCode = 403; res.end('Forbidden'); return }
      await this.serveThemeWritePost(req, res)
      return
    }

    // Journal d'erreurs 3 étages, mêmes 4 routes que `mjs serve` (cf. render-server.ts
    // pour le détail des plafonds/troncatures) : AVANT la porte GET/HEAD juste en dessous (POST/
    // DELETE lui sont propres) et avant /__mjs/theme et pathPrefix (hors de l'arborescence des
    // assets, quel que soit le préfixe configuré). `this.journal` absent (pas de mjs.config.json
    // trouvé, cf. cli.ts) ⇒ branche sautée, comportement HISTORIQUE inchangé pour tout le reste.
    if (this.journal && (url === '/__mjs/errors' || url === '/__mjs/errors.json')) {
      if (url === '/__mjs/errors' && req.method === 'POST') {
        // POST suit SA PROPRE porte (`journal.client`, défaut false) — pas la règle viewer plus
        // bas. Ce chemin RÉSERVÉ est intercepté ICI, AVANT le pipeline d'actions (cf. plus bas
        // dans `handle`) : aucune action `.server.mjs` ne peut jamais s'y substituer — étage coupé
        // ⇒ 404 direct, jamais un 405 de repli.
        if (this.config?.journal?.client === true) { await this.serveErrorsPost(req, res); return }
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      if (req.method === 'GET' || req.method === 'DELETE') {
        const fullUrl = new URL(req.url || '/', 'http://' + this.host)
        if (!isViewerAllowed(this.config?.journal?.viewer, fullUrl, this.env)) {
          res.statusCode = 404
          res.end('Not Found')
          return
        }
        if (url === '/__mjs/errors.json' && req.method === 'GET') {
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(JSON.stringify(this.journal.list()))
          return
        }
        if (url === '/__mjs/errors' && req.method === 'DELETE') {
          const src = fullUrl.searchParams.get('source')
          this.journal.purge(src === 'server' || src === 'client' ? src : null)
          res.statusCode = 204
          res.end()
          return
        }
        if (url === '/__mjs/errors' && req.method === 'GET') {
          // sans manifeste SUR LE DISQUE, aucun cœur µ à charger — porte fermée plutôt que page
          // morte (même convention que l'atelier /__mjs/theme, cf. plus bas). La condition
          // portait sur la seule PRÉSENCE de `manifestPath`, qui valait « bloc `render` configuré »
          // (cf. constructeur) : elle teste désormais le FICHIER, seule chose dont la visionneuse
          // ait réellement besoin. Un projet sans bloc `render` a bien son journal ; un projet dont
          // le tout premier build n'a pas encore fini garde son 404 (jamais un 500 de compilation).
          if (!this.manifestPath || !existsSync(this.manifestPath)) { res.statusCode = 404; res.end('Not Found'); return }
          try {
            const script = await getViewerScript(this.manifestPath, JOURNAL_VIEWER)
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(shell('', RENDER_BUNDLE_PATH, this.defaultLang, viewerScriptElement(script, JOURNAL_VIEWER)))
          } catch (e: any) {
            console.error(t('server.journal-viewer-compile-echec', { erreur: e && e.message ? e.message : String(e) }))
            res.statusCode = 500
            res.end('Internal Server Error')
          }
          return
        }
      }
    }

    // Verbes MUTANTS (POST/PUT/PATCH/DELETE) : même pipeline que `mjs serve`
    // (action-pipeline.ts), SEULEMENT si un chargeur d'actions `.server.mjs` est branché
    // (`this.entry`, cf. constructeur) — sans lui, comportement HISTORIQUE inchangé (405 sec juste
    // en dessous, AUCUN en-tête `Allow`). Le pipeline lui-même répond 405 + `Allow: GET, HEAD` quand
    // aucune action ne matche le chemin (cf. son commentaire) : dans les deux cas la porte se
    // referme, seule la forme exacte du 405 diffère selon qu'un chargeur existe ou non.
    if (this.entry && this.config && req.method && MUTATING_METHODS.has(req.method)) {
      let pathname: string
      try {
        pathname = decodeURIComponent(url)
      } catch {
        res.statusCode = 400
        res.end('Bad Request')
        return
      }
      if (pathname.includes('..') || pathname.includes('\0')) {
        res.statusCode = 400
        res.end('Bad Request')
        return
      }
      // `/__mjs/…` est le préfixe RÉSERVÉ du serveur de développement (journal, atelier de thème,
      // client HMR) : il ne devient jamais une route d'application, même si un `.server.mjs` y
      // déclare une action par mégarde. Sans cette barrière, un projet sans bloc `journal` laissait
      // le pipeline d'actions récupérer POST /__mjs/errors.
      if(pathname === '/__mjs' || pathname.startsWith('/__mjs/') || pathname.startsWith('/__mjs_hmr')) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      const reqUrl = req.url || '/'
      await handleMutatingRequest(req, res, pathname, reqUrl, { config: this.config, entry: this.entry, recordServer: this.recordServer, manifestPath: this.manifestPath })
      return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.statusCode = 405
      res.end('Method Not Allowed')
      return
    }

    // Bundle sur son chemin virtuel FIXE (cf. RENDER_BUNDLE_PATH) — sert `this.manifestPath`
    // directement, indépendant de `outputDir`/`pathPrefix` (même convention que render-server.ts,
    // qui le sert lui aussi depuis son handler PRINCIPAL). Cette branche vivait dans
    // `serveRenderFallback`, donc INJOIGNABLE sans bloc `render` : les deux visionneuses, dont le
    // shell réclame ce script, servaient alors une page morte. Remontée ici, elle ne dépend plus
    // que du manifeste. Le cas `manifestPath` nul retombe sur le 404 générique plus bas —
    // strictement le comportement d'avant.
    if (url === RENDER_BUNDLE_PATH && this.manifestPath) {
      if (existsSync(this.manifestPath)) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/javascript')
        res.end(readFileSync(this.manifestPath))
      } else {
        res.statusCode = 404
        res.end('bundle introuvable : ' + this.manifestPath)
      }
      return
    }

    // Endpoint dédié au client HMR (snippet JS à inclure dans la page).
    if (this.hmrEnabled && url === '/__mjs_hmr/client.js') {
      res.statusCode = 200
      res.setHeader('Content-Type', MIME_TYPES['.js'])
      res.setHeader('Cache-Control', 'no-cache')
      res.end(this.getHMRClientSnippet())
      return
    }

    // Atelier /__mjs/theme (mêmes 2 routes que `mjs serve`, cf. render-server.ts) : lit le
    // registre écrit par le bundler dans rootDir, aucun calcul ici. OUTIL DE DÉVELOPPEMENT
    // UNIQUEMENT : 404 (jamais 403, indistinct d'une route absente) dès que NODE_ENV=production ;
    // AUCUNE clé de config ajoutée pour ce garde — un éventuel jeton pourrait s'ajouter,
    // `?token=` comme celui du journal. Traitée AVANT pathPrefix : ces routes vivent hors de
    // l'arborescence des assets, quel que soit le préfixe configuré.
    if (url === '/__mjs/theme' || url === '/__mjs/theme.json') {
      // isProdEnv (viewer-page.ts) teste aussi `this.env` (drapeau --prod du CLI),
      // pas seulement NODE_ENV : cf. JSDoc de ServerOpts.env pour le détail du OR.
      if (isProdEnv(this.env)) { res.statusCode = 404; res.end('Not Found'); return }
      if (url === '/__mjs/theme.json') {
        const registryPath = join(this.rootDir, '.mjs-theme-vars.json')
        res.statusCode = 200
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.end(existsSync(registryPath) ? readFileSync(registryPath) : '{}')
        return
      }
      // GET /__mjs/theme : sans manifeste sur le disque, aucun cœur µ à charger — porte fermée
      // plutôt que page morte, MÊME condition exacte que la page du journal (cf. plus haut :
      // le fichier, pas la présence d'un bloc `render`).
      if (!this.manifestPath || !existsSync(this.manifestPath)) { res.statusCode = 404; res.end('Not Found'); return }
      try {
        const script = await getViewerScript(this.manifestPath, THEME_VIEWER)
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.end(shell('', RENDER_BUNDLE_PATH, this.defaultLang, viewerScriptElement(script, THEME_VIEWER)))
      } catch (e: any) {
        console.error(t('server.theme-viewer-compile-echec', { erreur: e && e.message ? e.message : String(e) }))
        res.statusCode = 500
        res.end('Internal Server Error')
      }
      return
    }

    // Comparaison de SEGMENT (`===` ou suivi de `/`), pas de préfixe de CHAÎNE nu :
    // une page render.routes dont l'URL commence par le même mot que pathPrefix (ex. urlPrefix
    // '/modularjs', route '/modularjs-notes') tombait à tort dans le service de fichiers
    // statiques → 404 immédiat, jamais de repli render (contrairement à `mjs serve`,
    // render-server.ts:311, qui retombe sur le rendu faute de fichier existant — même faiblesse
    // texto, mais sans conséquence là-bas).
    if (!(url === this.pathPrefix || url.startsWith(this.pathPrefix + '/'))) {
      // Chemin HORS assets (pathPrefix) : résolution `render.routes` si un
      // renderHandle est configuré (bloc `render` présent, cf. cli.ts) — MÊME
      // contrat que `mjs serve` (server/render-request.ts). Sans lui : 404
      // HISTORIQUE inchangé, comportement identique à AVANT cette feature.
      if (this.renderHandle) { await this.serveRenderFallback(req, res, url); return }
      // Sans bloc `render` : la racine du PROJET (cf. ServerOpts.projectRoot) se sert
      // elle-même — `mjs dev` devient un serveur de dev autonome (Vite/Angular), pas seulement
      // un fournisseur d'assets compilés. Absent (StaticServer construit hors `mjs dev`, la
      // quasi-totalité des tests) ⇒ 404 HISTORIQUE inchangé, comportement identique à AVANT.
      if (this.projectRoot) { await this.serveProjectRoot(req, res, url); return }
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    // Strip prefix → path relatif. Sécurité : interdire `..` pour prévenir
    // les directory traversals.
    let rel: string
    try {
      rel = decodeURIComponent(url.slice(this.pathPrefix.length).replace(/^\/+/, ''))
    } catch {
      // Percent-encoding invalide (`/%E0%A4%A`) → URIError. Sans ce catch,
      // l'exception synchrone tuait tout le process `mjs dev`
      // (uncaughtException) — déni de service trivial en un curl.
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    if (rel.includes('..') || rel.includes('\0')) {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }

    const filePath = join(this.rootDir, rel)
    const ext = extname(filePath).toLowerCase()
    const mime = MIME_TYPES[ext] ?? 'application/octet-stream'
    let body: Buffer
    try {
      // Un DOSSIER n'est pas un fichier servable. Préfixe d'assets NON vide : `url === pathPrefix`
      // désigne la racine de CE namespace — 404 historique, jamais un repli (pinné par
      // serve-dev-parity). Préfixe VIDE : il n'y a pas de namespace d'assets à part, tout chemin
      // passe par ici et `/` résout le dossier RACINE servi, alors que c'est la page déclarée pour
      // `/` qu'on demande — même repli que pour un fichier absent (cf. le `catch` ci-dessous), et
      // que `mjs serve`, qui retombe déjà sur le rendu faute de FICHIER.
      if (!statSync(filePath).isFile()) {
        if (this.pathPrefix !== '') {
          res.statusCode = 404
          res.end('Not Found')
          return
        }
        throw new Error('pas un fichier')
      }
      // Rejeter `..` dans l'URL ne suffit pas : un LIEN SYMBOLIQUE
      // posé dans la racine servie et pointant ailleurs sortait de l'arborescence sans jamais
      // écrire `..` (prouvé : lien vers /etc/hostname → HTTP 200 avec le contenu réel). On
      // compare donc les chemins RÉELS, des deux côtés — la racine peut elle-même vivre
      // derrière un lien (/tmp sur macOS, dossiers de déploiement datés)
      if (!isRealPathWithin(this.rootDir, filePath)) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      body = readFileSync(filePath)
    } catch {
      // Absent, PAS UN FICHIER, ou supprimé ENTRE stat et read (TOCTOU réel en dev : le
      // cleanup du watcher retire les anciens hash pendant que le navigateur
      // recharge). Avant : exception synchrone → mort du process.
      // Fichier ABSENT sous pathPrefix : repli render.routes AVANT le
      // 404, même logique que `mjs serve` (render-server.ts:317-323, qui retombe déjà sur le rendu
      // si l'asset n'existe pas) — une page render.routes dont l'URL vit SOUS pathPrefix (ex.
      // /modularjs/faq, préfixe par défaut) tombait ici en 404 sec, jamais essayée en rendu.
      // Ce repli était TROP LARGE : un chemin à
      // EXTENSION (script/style/wasm cassé, ex. /modularjs/inexistant.js) tombait aussi dedans et
      // recevait le shell HTML 200 (render-request.ts sert 200 pour toute URL non déclarée) — un
      // <script src> mort ne doit jamais recevoir du HTML. Extension + pas de X-MJS-Nav → 404 net ;
      // sans extension (page probable), ou X-MJS-Nav (fiche JSON de nav) → repli inchangé.
      // Cette garde tombait AUSSI sur une route DÉCLARÉE avec extension
      // (render.routes['/modularjs/sitemap.xml']) : jamais rendue, 404 sec. Une route résolue par
      // `resolvePage` sur le chemin complet (préfixe + rel) passe toujours au rendu.
      const rawNavPeek = req.headers['x-mjs-nav']
      const navPeek = Array.isArray(rawNavPeek) ? rawNavPeek[0] : rawNavPeek
      const hasExt = /\.[a-z0-9]+$/i.test(rel)
      const declaredRoute = resolvePage(this.pathPrefix + '/' + rel, this.config?.render, null)
      if (this.renderHandle && (!hasExt || navPeek || declaredRoute)) { await this.serveRenderFallback(req, res, url); return }
      res.statusCode = 404
      res.end('Not Found')
      return
    }

    res.statusCode = 200
    res.setHeader('Content-Type', mime)
    res.setHeader('Content-Length', body.length)
    // Cache fort sur les fichiers hashed (immutable). Les non-hashed ne
    // devraient pas être servis par ici, mais on évite de cacher trop fort
    // par défaut pour ne pas tirer dans le pied du dev.
    if (/-[a-f0-9]{8}\./.test(rel)) {
      res.setHeader('Cache-Control', 'public, max-age=31536000, immutable')
    } else {
      res.setHeader('Cache-Control', 'no-cache')
    }

    if (req.method === 'HEAD') {
      res.end()
    } else {
      res.end(body)
    }
  }

  // POST /__mjs/theme/edit — l'atelier envoie `{ vars: { accent: '#ff0000' } }` (noms NUS, tels
  // que le registre `.mjs-theme-vars.json` les porte), on diffuse `--<varPrefix>-<nom>` à toutes
  // les pages ouvertes. Le préfixe est appliqué ICI : le serveur est le seul des trois à connaître
  // `varPrefix` sans le deviner (config chargée par le CLI).
  //
  // CRIBLE PAR LISTE BLANCHE, jamais par liste noire. Nom et valeur finissent TELS QUELS dans le
  // texte d'une feuille de style côté page (`:root{--mjs-x:VALEUR}`) : une valeur portant `;` ou
  // `}` sortirait de la déclaration et écrirait des règles arbitraires. Et le canal de sortie est
  // le WebSocket HMR, dont l'en-tête de hmr.ts rappelle qu'il est joignable par n'importe quelle
  // page du navigateur. Une entrée refusée ne fait pas tomber les autres : elle est comptée et
  // rendue à l'appelant, qui l'affiche — un refus muet ressemblerait à une couleur sans effet.
  /** Corps JSON d'un POST d'atelier : borné à 64 Kio, rendu en objet simple. `undefined` =
   *  la réponse d'erreur est DÉJÀ partie (413 ou 400), l'appelant n'a plus qu'à sortir. */
  private async readJsonBody(req: IncomingMessage, res: ServerResponse): Promise<Record<string, unknown> | undefined> {
    const chunks: Buffer[] = []
    let total = 0
    let rejected = false
    await new Promise<void>((done) => {
      req.on('data', (chunk: Buffer) => {
        if (rejected) return
        total += chunk.length
        if (total > 65_536) {
          rejected = true
          res.statusCode = 413
          res.setHeader('Connection', 'close')
          res.end('Payload Too Large')
          req.destroy()
          done(); return
        }
        chunks.push(chunk)
      })
      req.on('end', () => done())
      req.on('error', () => done())
    })
    if (rejected) return undefined
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    } catch {
      res.statusCode = 400; res.end('Bad Request'); return undefined
    }
    if (!isPlainObject(payload)) { res.statusCode = 400; res.end('Bad Request'); return undefined }
    return payload as Record<string, unknown>
  }

  private async serveThemeEditPost(req: IncomingMessage, res: ServerResponse, varPrefix: string): Promise<void> {
    const payload = await this.readJsonBody(req, res)
    if (payload === undefined) return
    const vars = payload.vars
    if (!isPlainObject(vars)) { res.statusCode = 400; res.end('Bad Request'); return }

    const retenues: Record<string, string> = {}
    const refusees: string[] = []
    for (const [nom, valeur] of Object.entries(vars as Record<string, unknown>)) {
      // '' = retrait de la surcharge (retour à la valeur du source) : valeur LÉGALE, elle
      // traverse le crible de forme qui, lui, exige au moins un caractère.
      if (typeof valeur !== 'string' || valeur.length > THEME_VALUE_MAX || !THEME_NAME_RE.test(nom) || (valeur !== '' && !THEME_VALUE_RE.test(valeur))) {
        refusees.push(nom)
        continue
      }
      retenues['--' + varPrefix + '-' + nom] = valeur
    }

    // `this.hmr` absent = serveur monté sans HMR : l'aperçu n'a aucun canal, on le DIT (200 avec
    // `live: false`) plutôt que de rendre un succès sur une diffusion qui n'a pas eu lieu.
    const nbPages = this.hmr?.clientCount ?? 0
    if (this.hmr && Object.keys(retenues).length > 0) this.hmr.notifyThemeVars(retenues)
    res.statusCode = 200
    res.setHeader('Content-Type', 'application/json; charset=utf-8')
    res.end(JSON.stringify({ live: !!this.hmr, clients: nbPages, applied: Object.keys(retenues).length, rejected: refusees }))
  }

  // POST /__mjs/theme/write — `{ name, value, file, line }`. `file` et `line` viennent du
  // registre `.mjs-theme-vars.json` que l'atelier a DÉJÀ lu : c'est lui qui sait quelle
  // déclaration la pastille éditait, une variable en ayant souvent plusieurs (un thème clair et
  // un thème sombre, deux composants qui la posent). Le serveur ne s'y fie pas pour autant : le
  // chemin est ramené sous la racine du projet, et la ligne revérifiée contre le fichier réel
  // (cf. theme-write.ts, qui refuse plutôt que d'écrire au jugé).
  //
  // Un refus sort en 200 avec son motif, comme /edit : ce n'est pas une panne du serveur mais un
  // fait sur le source, que l'atelier doit AFFICHER. Seules les requêtes malformées font 4xx.
  private async serveThemeWritePost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const payload = await this.readJsonBody(req, res)
    if (payload === undefined) return
    const rendre = (corps: Record<string, unknown>) => {
      res.statusCode = 200
      res.setHeader('Content-Type', 'application/json; charset=utf-8')
      res.end(JSON.stringify(corps))
    }

    const name  = payload.name
    const value = payload.value
    const file  = payload.file
    const line  = typeof payload.line === 'number' && Number.isInteger(payload.line) && payload.line > 0 ? payload.line : 0

    // MÊME crible de formes que l'aperçu, pour une raison plus forte encore : la valeur finit
    // dans une feuille de style DU DÉPÔT, pas seulement dans un onglet de dev. La chaîne vide —
    // le « rétablir » de l'aperçu — n'a aucun sens ici : on ne devine pas une valeur d'origine.
    if (typeof name !== 'string' || !THEME_NAME_RE.test(name)) { rendre({ written: false, reason: 'nom-refuse' }); return }
    if (typeof value !== 'string' || value === '' || value.length > THEME_VALUE_MAX || !THEME_VALUE_RE.test(value)) { rendre({ written: false, reason: 'valeur-refusee' }); return }
    if (typeof file !== 'string' || file === '') { rendre({ written: false, reason: 'fichier-manquant' }); return }
    // `mjs dev` connaît la racine du projet (cli.ts la passe toujours) ; un StaticServer monté à
    // la main n'en a pas — sans elle on ne sait pas contre quoi borner le chemin, donc on ne
    // touche à rien plutôt que de résoudre depuis le dossier courant du process
    if (!this.projectRoot) { rendre({ written: false, reason: 'racine-inconnue' }); return }

    const cible = resolve(this.projectRoot, file)
    // le chemin arrive du navigateur : `../../.ssh/config` et un lien symbolique qui sort du
    // projet sont deux façons d'en échapper — isRealPathWithin résout les deux avant de comparer
    if (!existsSync(cible) || !statSync(cible).isFile() || !isRealPathWithin(this.projectRoot, cible)) { rendre({ written: false, reason: 'hors-projet' }); return }

    const varPrefix = this.config?.varPrefix ?? 'mjs'
    const issue     = rewriteThemeValue(readFileSync(cible, 'utf-8'), name, varPrefix, value, line)
    if (!issue.ok) { rendre({ written: false, reason: issue.reason, lines: issue.lines, file }); return }

    writeFileSync(cible, issue.source)
    // AUCUNE diffusion `theme-vars` derrière l'écriture : le watcher voit le fichier changer et
    // recompile, la page reçoit la vraie couleur par le canal normal. Une surcharge posée en plus
    // masquerait le résultat réel — et masquerait donc aussi un échec de compilation.
    rendre({ written: true, file, line: issue.line, before: issue.before, after: issue.after })
  }

  // POST /__mjs/errors (étage 2 du journal) : mêmes plafonds/troncatures que `mjs serve`,
  // cf. render-server.ts pour le commentaire détaillé (seau à jetons PARTAGÉ, cf. token-bucket.ts).
  // `journal.client` déjà vérifié par l'appelant (`handle`).
  private async serveErrorsPost(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const ip = req.socket.remoteAddress ?? 'inconnue'
    let bucket = this.errorsRateLimit.get(ip)
    if (!bucket) {
      pruneIdleBuckets(this.errorsRateLimit)   // purge avant croissance, cf. token-bucket.ts
      bucket = new TokenBucket(10, 0.5); this.errorsRateLimit.set(ip, bucket)
    }
    if (!bucket.take()) { res.statusCode = 429; res.end('Too Many Requests'); return }
    const chunks: Buffer[] = []
    let total = 0
    let rejected = false
    await new Promise<void>((done) => {
      req.on('data', (chunk: Buffer) => {
        if (rejected) return
        total += chunk.length
        if (total > 65_536) {
          rejected = true
          res.statusCode = 413
          res.setHeader('Connection', 'close')
          res.end('Payload Too Large')
          req.destroy()
          done(); return
        }
        chunks.push(chunk)
      })
      req.on('end', () => done())
      req.on('error', () => done())
    })
    if (rejected) return
    let payload: unknown
    try {
      payload = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
    } catch {
      res.statusCode = 400; res.end('Bad Request'); return
    }
    if (!isPlainObject(payload)) { res.statusCode = 400; res.end('Bad Request'); return }
    const p = payload as Record<string, unknown>
    const message  = typeof p.message === 'string' ? p.message.slice(0, 2048) : ''
    const pile     = typeof p.pile === 'string' ? p.pile.slice(0, 8192) : ''
    const errUrl   = typeof p.url === 'string' ? p.url.slice(0, 2048) : ''
    const version  = typeof p.version === 'string' ? p.version.slice(0, 32) : null
    const uaHeader = req.headers['user-agent']
    const ua       = typeof uaHeader === 'string' ? uaHeader.slice(0, 256) : undefined
    // source FORCÉE 'client' — cf. render-server.ts, même défense (p.source jamais lu).
    this.journal!.record('client', { message, pile, url: errUrl, version, ua })
    res.statusCode = 204
    res.end()
  }

  // Capture serveur du journal (cf. journal.ts) pour les erreurs propres à `mjs dev`
  // lui-même — au minimum le catch de serveRenderFallback (cf. plus bas) et le filet de start().
  // `this.journal` absent ou `journal.server: false` (même défaut TRUE que render-server.ts) ⇒ no-op.
  // `version` posée ici comme le fait `mjs serve` (render-server.ts, même appel à
  // readBuildVersion) : une entrée de dev dit désormais de QUEL build elle vient. Le cache par mtime
  // suit les recompiles du watcher, donc la valeur est celle du build en vigueur à l'instant de
  // l'erreur, pas celle du démarrage. Manifeste absent ⇒ null, exactement comme en production.
  private recordServerError(e: any, url: string): void {
    if (!this.journal) return
    if (this.config?.journal?.server === false) return
    this.journal.record('server', { message: e && e.message ? e.message : String(e), pile: e && e.stack, url, version: readBuildVersion(this.manifestPath) })
  }

  // render.routes en dev (feature) — appelée UNIQUEMENT quand `this.renderHandle`
  // est configuré, pour tout chemin qui n'a pas matché `pathPrefix` (cf. handle).
  // Décodage + garde `..`/NUL AVANT toute résolution : même défense que
  // render-server.ts (path traversal) — ce chemin-ci n'a PAS encore été
  // décodé/validé (contrairement à `rel` dans la branche assets ci-dessus, qui a
  // sa PROPRE validation locale).
  private async serveRenderFallback(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    let pathname: string
    try {
      pathname = decodeURIComponent(url)
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    if (pathname.includes('..') || pathname.includes('\0')) {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }

    // La branche RENDER_BUNDLE_PATH vivait ICI ; elle a été REMONTÉE dans `handle` (cf. son
    // commentaire), où elle est joignable même sans bloc `render`. Rien ne la remplace ici : tout
    // `renderHandle` implique un `manifestPath` (cf. constructeur), donc `handle` l'a forcément
    // déjà interceptée avant d'arriver jusqu'à ce repli.

    try {
      // Négociation de protocole PORTÉE depuis render-server.ts:323-343 (mjs serve
      // la parle déjà, docs/19-ssr.md l'affirmait aussi pour mjs dev, à tort auparavant) :
      // X-MJS-Nav non vide ⇒ fiche JSON {module,props,url,title,version,…} au lieu du shell HTML —
      // même URL, deux représentations (Vary). `req.url` brut (pas `url`, déjà débarrassé de la
      // query-string plus haut dans `handle`) : même normalisation `//` que render-server.ts, la
      // query-string doit survivre dans le champ `url` de la fiche.
      const rawNav = req.headers['x-mjs-nav']
      const navHeader = Array.isArray(rawNav) ? rawNav[0] : rawNav
      if (navHeader) {
        const reqUrl = (req.url || '/').replace(/^\/{2,}/, '/')
        const page = resolvePage(pathname, this.config?.render, null)
        const version = readBuildVersion(this.manifestPath)
        res.statusCode = page ? 200 : 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Vary', 'X-MJS-Nav')
        if (version) res.setHeader('X-MJS-Version', version)
        const props = (page && this.entry) ? await this.entry.propsFor(pathname, req) : {}
        res.end(JSON.stringify({ module: page ? page.component : null, props, url: reqUrl, title: null, version, ...navExtras(this.config?.render) }))
        return
      }

      // Requête abandonnée par le client (socket
      // fermée) PENDANT qu'elle patiente dans RenderGate (render-request.ts, plafond
      // render.renderQueue) : sans ce signal, sa place en file restait occupée jusqu'à son tour
      // NATUREL — la file paraissait pleine aux requêtes suivantes (503 en cascade) alors que le
      // client n'attendait déjà plus personne. `close` : seul événement fiable côté IncomingMessage
      // pour un abandon (pas de AbortSignal natif sur `req` ici) — retiré dans le `finally`, jamais
      // laissé accroché après une réponse normale.
      const abortOnClose = new AbortController()
      const onReqClose = () => abortOnClose.abort()
      req.on('close', onReqClose)
      let r: RenderResponse
      try {
        r = await this.renderHandle!(pathname, req.headers as any, abortOnClose.signal)
      } finally {
        req.off('close', onReqClose)
      }
      res.statusCode = r.status
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('X-MJS-Mode', r.mode || 'csr')
      // Retombée du plafond de concurrence SSR (render-request.ts, RenderGate) :
      // status 503 seulement, avec le délai suggéré posé par le handler.
      if (r.status === 503 && r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter))
      // Props du chargeur serve.server.mjs injectées AU 1er chargement HTML, MÊME
      // mécanique que render-server.ts:368-372 (`resScript` dupliquée plus haut dans ce fichier,
      // cf. son commentaire) : jamais un 500 pour un chargeur en échec sur une page HTML (rattrapé
      // ci-dessous), contrairement à la branche JSON juste au-dessus qui laisse remonter au catch.
      const resProps = (r.component && this.entry) ? await this.entry.propsFor(pathname, req).catch((e: any) => {
        this.recordServerError(e, pathname)
        return {}
      }) : {}
      const resTag = resScript(pathname, resProps)
      const body = r.kind === 'csr'
        ? (r.component ? '<' + r.component + '></' + r.component + '>' : '<!-- mjs: csr -->')
        : r.body
      // Même <head> thématisé que `mjs serve` (render-server.ts:shell, 5e paramètre) :
      // sans lui, `mjs dev` (le chemin quotidien de render.routes en dev) gardait le flash que cette
      // correction supprime. config/configDir absents (cf. constructeur) ⇒ '' ; buildSsrHead
      // elle-même ne jette jamais non plus (cf. son propre commentaire) — page servie dans tous les cas.
      const headExtra = (this.config && this.configDir) ? buildSsrHead(this.config, this.configDir, this.manifestPath) : ''
      res.end(shell((resTag ? resTag + '\n' : '') + body, RENDER_BUNDLE_PATH, this.defaultLang, '', headExtra))
    } catch (e: any) {
      // (point de capture dev, cf. recordServerError) — auparavant, l'échec était avalé
      // en SILENCE TOTAL, comme le catch global de render-server.ts.
      this.recordServerError(e, pathname)
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  }

  // Racine du PROJET (cf. ServerOpts.projectRoot) — dernier repli pour tout chemin HORS
  // `pathPrefix`, SEULEMENT quand `this.renderHandle` est absent (cf. `handle`, appelé APRÈS ce
  // test) : un bloc `render` reste prioritaire et garde son propre 404/CSR, exactement comme avant
  // cette feature. Décodage + garde `..`/NUL AVANT toute résolution, MÊME défense que
  // `serveRenderFallback` ci-dessus — ce chemin n'a pas encore été validé (contrairement à `rel`
  // de la branche assets, qui a sa PROPRE validation locale plus haut dans `handle`).
  private async serveProjectRoot(req: IncomingMessage, res: ServerResponse, url: string): Promise<void> {
    let pathname: string
    try {
      pathname = decodeURIComponent(url)
    } catch {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    if (pathname.includes('..') || pathname.includes('\0')) {
      res.statusCode = 400
      res.end('Bad Request')
      return
    }
    // Segment caché (`.git`, `.env`…) ou `node_modules` : jamais servi, même présent sur le
    // disque — la racine servie ICI est celle du PROJET ENTIER (dossier de mjs.config.json), pas
    // un `public/` déjà isolé de ces dossiers par construction.
    const segments = pathname.split('/').filter(Boolean)
    if (segments.some(s => s.startsWith('.') || s === 'node_modules')) {
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    // `/` et tout chemin qui SE TERMINE par `/` → `index.html` de ce dossier ; sinon le fichier
    // lui-même, littéralement — aucune résolution implicite `/dossier` → `/dossier/index.html`
    // sans le `/` final (même politique que Vite/Angular : pas de redirection cachée).
    const rel = pathname.endsWith('/') ? pathname + 'index.html' : pathname
    const filePath = join(this.projectRoot!, rel)
    let body: Buffer
    try {
      if (!statSync(filePath).isFile()) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      // Même défense que la branche assets ci-dessus (cf. son commentaire) : un lien symbolique
      // posé dans la racine et pointant ailleurs sort de l'arborescence sans jamais écrire `..`.
      if (!isRealPathWithin(this.projectRoot!, filePath)) {
        res.statusCode = 404
        res.end('Not Found')
        return
      }
      body = readFileSync(filePath)
    } catch {
      // Absent, ou supprimé ENTRE stat et read (même TOCTOU que la branche assets ci-dessus).
      res.statusCode = 404
      res.end('Not Found')
      return
    }
    const ext = extname(filePath).toLowerCase()
    res.statusCode = 200
    res.setHeader('Content-Type', MIME_TYPES[ext] ?? 'application/octet-stream')
    res.setHeader('Cache-Control', 'no-cache')
    if (req.method === 'HEAD') { res.end(); return }
    // Client de rechargement injecté dans toute page HTML servie DEPUIS ICI (hmr actif) — même
    // script que l'atelier/le journal (getHMRClientSnippet), simplement RÉFÉRENCÉ plutôt qu'en
    // ligne : un projet sans bloc `render` n'avait jusqu'ici aucun moyen de le recevoir (cf.
    // cli/init.ts, qui documente encore l'ajout MANUEL du même tag dans la page de l'utilisateur).
    if (ext === '.html' && this.hmrEnabled) {
      const html = body.toString('utf-8')
      const tag = '<script src="/__mjs_hmr/client.js"></script>'
      res.end(/<\/body>/i.test(html) ? html.replace(/<\/body>/i, tag + '\n</body>') : html + '\n' + tag + '\n')
      return
    }
    res.end(body)
  }
}
