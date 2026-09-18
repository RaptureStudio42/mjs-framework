// render-server — serveur HTTP `mjs serve`.
//
// Enveloppe le handler de rendu (render-request) dans un serveur : sert les assets
// compilés (outputDir) + le bundle, et pour chaque page applique le mode résolu
// (prerender / ssr / csr). Pensé pour un projet MJS autonome ; pour un back existant
// (Rails…), on réutilise plutôt `createRenderHandler` en sidecar/middleware.

import { createServer, type Server } from 'node:http'
import { readFileSync, existsSync, statSync, realpathSync } from 'node:fs'
import { join, resolve, relative, isAbsolute, extname, sep } from 'node:path'
import type { MjsConfig } from '../bundler/config.js'
import { createRenderHandler, type RenderHandler, type RenderResponse } from './render-request.js'
import { resolvePage } from './render-routes.js'
import { createServeEntry, isPlainObject } from './serve-entry.js'
import { escapeJsonForScript } from './renderToString.js'
import { createJournal, type Journal, type RecordServerFn } from './journal.js'
import { handleMutatingRequest, navExtras } from './action-pipeline.js'
import { TokenBucket, pruneIdleBuckets } from './token-bucket.js'
import { getViewerScript, isViewerAllowed, viewerScriptElement, warnIfJournalViewerOpenInProd, isProdEnv, JOURNAL_VIEWER, THEME_VIEWER } from './viewer-page.js'
import { buildSsrHead } from './ssr-head.js'
import { deriveUrlPrefix } from '../bundler/index.js'
import { readBuildVersion } from './build-version.js'
import { t } from '../messages/index.js'

// Exportée : réutilisée telle quelle par render-browser.ts (interception page.route
// du moteur navigateur — mêmes types MIME que le serveur HTTP, une seule source) ET par
// server/index.ts (MIME_TYPES, spread sur celle-ci) — UNE seule table pour les deux serveurs
// `.wasm` manquait aux DEUX consommateurs (octet-stream par défaut), ajoutée ICI
// plutôt que dupliquée localement dans chacun.
export const MIME: Record<string, string> = {
  '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.json': 'application/json', '.html': 'text/html', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.webp': 'image/webp',
  '.woff2': 'font/woff2', '.woff': 'font/woff', '.ico': 'image/x-icon',
  '.wasm': 'application/wasm',
}

export interface RenderServerOptions { port?: number; host?: string; /** environnement du build (`mjs serve --prod`) — le rendu par requête RECOMPILE dans le vrai dossier de sortie */ env?: 'dev' | 'prod' }
export interface RunningServer { server: Server; port: number; close(): Promise<void> }

// L'ancien garde-fou d'asset était
// `asset.startsWith(outputDir)`, un simple préfixe de CHAÎNE, sans vérifier
// de séparateur de chemin : si `outputDir` vaut `.../dist`, un chemin résolu
// en `.../dist-secret/x` (dossier FRÈRE, hors de `outputDir`) COMMENCE PAR la
// même chaîne `.../dist` et passait donc le test à tort. Fix :
// `path.relative(base, target)` — si le résultat commence par `..` (ou est
// absolu, cas Windows multi-lecteurs), `target` est RÉELLEMENT hors de
// `base`, indépendamment de toute coïncidence de préfixe textuel. Exportée
// pour test direct (le seul appelant actuel reçoit un `pathname` déjà
// normalisé par `new URL()`, qui élimine `..` en amont — ce garde-fou reste
// une défense en profondeur pour tout futur appelant moins prudent).
export function isWithinDir(base: string, target: string): boolean {
  const rel = relative(base, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** `isWithinDir` raisonne sur le TEXTE du chemin : un LIEN SYMBOLIQUE
 *  posé dans le dossier servi et pointant ailleurs le traverse sans jamais écrire `..` (prouvé :
 *  lien vers un fichier système, servi en 200 avec son contenu réel). Ce garde-ci compare les
 *  chemins RÉELS, liens résolus DES DEUX CÔTÉS — la racine elle-même vit souvent derrière un lien
 *  (déploiement `current -> releases/…`), la résoudre d'un seul côté rendrait 404 sur tout.
 *  À utiliser juste avant de LIRE un fichier ; `isWithinDir` reste bon pour un chemin qui n'existe
 *  pas encore. Chemin irrésoluble (fichier disparu entre deux appels) → refusé : en cas de doute, 404. */
export function isRealPathWithin(base: string, target: string): boolean {
  try {
    const realBase = realpathSync(base)
    const realFile = realpathSync(target)
    return realFile === realBase || realFile.startsWith(realBase.endsWith(sep) ? realBase : realBase + sep)
  } catch { return false }
}

/** Shell HTML minimal : enveloppe le rendu d'une page + charge le bundle client.
 *  Exportée : réutilisée telle quelle par server/index.ts (`mjs dev` + bloc
 *  `render`, feature render.routes en dev) — même enveloppe que `mjs serve`,
 *  une seule source. `lang` (défaut 'fr') : langue statique de `<html lang>`,
 *  résolue par l'appelant depuis `config.i18n.default` — sans store passé au
 *  renderer, la langue SSR effective est TOUJOURS `i18n.default` (jamais de
 *  mismatch). Par-visiteur (Accept-Language/cookie) : hors périmètre ici.
 *  `extraScript` (défaut '') : contenu additionnel posé APRÈS le
 *  `<script src>` du bundle — SEUL consommateur aujourd'hui, la visionneuse du
 *  journal d'erreurs (son JS compilé inline, cf. viewer-page.ts) ; chaîne vide
 *  = sortie BYTE-identique à avant pour tous les appelants existants.
 *  `headExtra` (défaut '') : contenu posé JUSTE AVANT `</head>` —
 *  SEUL consommateur aujourd'hui, le `<style data-mjs-ssr-head>` construit par
 *  ssr-head.ts (thème inliné, anti-flash SSR) ; chaîne vide = sortie
 *  BYTE-identique à avant pour tous les appelants existants. */
export function shell(body: string, bundleUrl: string, lang: string = 'fr', extraScript: string = '', headExtra: string = ''): string {
  return '<!doctype html>\n<html lang="' + lang + '">\n' +
    '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' + headExtra + '</head>\n' +
    '<body>\n' + body + '\n<script type="module" src="' + bundleUrl + '"></script>\n' + extraScript + '</body>\n</html>\n'
}

// `readBuildVersion` (+ son cache par mtime) vivait ICI, avant d'être DÉPLACÉE dans
// build-version.ts, sans changer une ligne de son corps, pour que `mjs dev` tague ses entrées de
// journal avec la même valeur (cf. l'en-tête de ce fichier-là). Import seul ci-dessus.

// navExtras vivait ICI ; déplacée dans action-pipeline.ts (partagée avec `mjs dev`),
// sans changer une ligne de son corps. Import seul ci-dessus.

// Sérialise µres (props résolues par le chargeur .server.mjs) pour le 1er chargement HTML :
// balise consommée UNE fois au boot client (mjs_store_globals.ts), le chemin JSON de nav reprend la
// main ensuite. Props vides → chaîne vide (zéro octet ajouté, cf. appelant). Échec de sérialisation
// (référence circulaire...) → chaîne vide + avertissement, jamais un 500 (même défense que
// serializeGlobal, renderToString.ts, dont on réutilise l'échappement — escapeJsonForScript).
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

// MUTATING_METHODS et parseMultipart vivaient ICI ; déplacés dans action-pipeline.ts
// (partagée avec `mjs dev`), sans changer une ligne de leur corps. Import (MUTATING_METHODS via
// handleMutatingRequest) ci-dessus.

// (étage 2, POST /__mjs/errors) — seau à jetons par IP — CLASSE PARTAGÉE,
// cf. token-bucket.ts (portait ici une copie locale, comme server/index.ts) : ~10 jetons, recharge
// 30/min (0.5/s) — cf. le patron d'appel dans startRenderServer.
export async function startRenderServer(
  config: MjsConfig, configDir: string, opts: RenderServerOptions = {},
): Promise<RunningServer> {
  const port = opts.port ?? 3000
  const host = opts.host ?? '127.0.0.1'
  const outputDir = resolve(configDir, config.outputDir || 'dist')
  // Manifeste servi sous `/__mjs/bundle.js` : celui que le projet déclare, sinon le défaut du
  // bundler (`public/modularjs/bundle.js`, relatif à la racine du projet) — `mjs build` et
  // `mjs dev` passent déjà celui de LEUR bundler, ce serveur-ci ne le dérivait pas : un projet
  // qui ne déclare pas `manifestPath` servait une page dont le propre `<script src>` rendait 404.
  // Le défaut n'est retenu que s'il EXISTE : sans fichier, on garde `null` comme avant.
  const manifestDeclare = config.manifestPath ? resolve(configDir, config.manifestPath) : null
  const manifestDefaut  = resolve(configDir, 'public/modularjs/bundle.js')
  const manifestPath    = manifestDeclare ?? (existsSync(manifestDefaut) ? manifestDefaut : null)
  // Préfixe PUBLIC sous lequel ce serveur monte le dossier de sortie : celui que le projet
  // déclare, sinon celui que le bundler DÉRIVE de ce même dossier — même fonction, donc même
  // réponse des deux côtés. Un `|| ''` montait tout à la racine pendant que les URLs ÉCRITES
  // (manifeste, feuilles du rendu) portaient, elles, le préfixe dérivé : chaque asset que la page
  // référençait tombait alors à côté. Une chaîne VIDE déclarée reste une réponse, elle : le projet
  // dit alors « sers à la racine », et `??` la respecte.
  const urlPrefix = config.urlPrefix ?? deriveUrlPrefix(outputDir)

  // Journal d'erreurs 3 étages. Le MAGASIN (createJournal) est TOUJOURS créé (coût nul tant
  // qu'aucun fichier n'est lu/écrit, cf. journal.ts) : ce qui est débrayable ÉTAGE PAR ÉTAGE, c'est
  // le BRANCHEMENT — capture serveur (`journal.server`, défaut true), canal client (`journal.client`,
  // défaut false), visionneuse (`journal.viewer`, défaut true hors prod). `recordServer` est
  // PRÉ-GATÉ une seule fois ici (no-op si l'étage serveur est coupé) : aucun des 5 points de capture
  // n'a besoin de retester la config lui-même — cf. RecordServerFn (journal.ts).
  const journalCfg = config.journal
  // `opts.env` (drapeau --prod du CLI) manquait ICI, seul NODE_ENV comptait :
  // même patron que la garde /__mjs/theme jumelle plus bas (isProdEnv(opts.env), déjà fermée).
  warnIfJournalViewerOpenInProd(journalCfg?.viewer, opts.env) // une fois au démarrage, cf. viewer-page.ts
  const journalServerEnabled = journalCfg?.server !== false
  const journalClientEnabled = journalCfg?.client === true
  const journalStore: Journal = createJournal({ dir: join(configDir, 'log'), maxEntries: journalCfg?.maxEntries, maxBytes: journalCfg?.maxBytes })
  const recordServer: RecordServerFn = journalServerEnabled
    ? (input) => journalStore.record('server', { ...input, version: readBuildVersion(manifestPath) })
    : () => {}
  // seau à jetons PAR IP (POST /__mjs/errors, étage 2) — état propre à CE serveur (jamais partagé entre
  // deux instances, ex. deux tests concurrents) ; ~10 jetons, recharge 30/min (0.5/s).
  const errorsRateLimit = new Map<string, TokenBucket>()

  const handler: RenderHandler = await createRenderHandler(config, configDir, recordServer, opts.env)
  // Chargeurs de props/actions `.server.mjs` (cf. serve-entry.ts) : couture posée par
  // `loadPropsFor`, remplacée par entry.propsFor ci-dessous ; entry.close() au close() du serveur.
  const entry = await createServeEntry(config, configDir, recordServer)

  const server = createServer(async (req, res) => {
    try {
      // `new URL('//p/42', base)` avale `p` comme host WHATWG (routage voit `/42`) — normalise les
      // slashs de tête AVANT résolution (reste du chemin + query intacts). RÉUTILISÉE
      // (jamais `req.url` brut) pour le champ `url` des deux réponses JSON du protocole plus bas :
      // sans cette normalisation ici aussi, un client recevait `//p/42` (lu comme protocole-relatif).
      const reqUrl = (req.url || '/').replace(/^\/{2,}/, '/')
      const url = new URL(reqUrl, 'http://' + host)
      // Un pourcentage malformé (`/%zz`) fait JETER `decodeURIComponent` (URIError) :
      // sans ce filet, seul le catch global (bas de fichier) l'attrapait → 500 silencieux
      // pour ce qui n'est qu'une requête mal formée, jamais une erreur serveur réelle.
      let pathname: string
      try {
        pathname = decodeURIComponent(url.pathname)
      } catch {
        res.statusCode = 400
        res.end('Bad Request'); return
      }

      // (path traversal) — `new URL()`
      // ne normalise PAS les séparateurs encodés `%2f` : `/%2e%2e%2f%2e%2e%2fx`
      // reste tel quel dans `.pathname` (le `%2f` empêche la reconnaissance du
      // segment `..`), puis `decodeURIComponent` le transforme en `/../../x`.
      // Ce `..` échappait ensuite de `outputDir` (asset) ET de `pagesDir` (page
      // prérendue via une route catch-all `*`) → lecture de fichier ARBITRAIRE
      // servie au client. On rejette tout `..`/NUL APRÈS décodage, avant le
      // moindre accès disque (même défense que `index.ts`, jusqu'ici absente ici).
      if (pathname.includes('..') || pathname.includes('\0')) {
        res.statusCode = 400
        res.end('Bad Request'); return
      }

      // Bundle à un chemin fixe (référencé par le shell autonome).
      if (pathname === '/__mjs/bundle.js' && manifestPath && existsSync(manifestPath)) {
        res.setHeader('Content-Type', 'text/javascript')
        res.end(readFileSync(manifestPath)); return
      }
      // Journal d'erreurs : POST (dépôt client, étage 2) + GET page/.json + DELETE (purge, étage 3).
      // POST suit SA PROPRE porte (`journal.client`) ; les 3 autres suivent la RÈGLE VIEWER
      // (isViewerAllowed) — refus TOUJOURS un 404 indistinct, jamais un 403 (cf. viewer-page.ts).
      if (pathname === '/__mjs/errors' && req.method === 'POST') {
        if (journalClientEnabled) {
          // a. seau à jetons par IP — même défense que bridge.ts:clientIp (jamais X-Forwarded-For,
          // trivialement falsifiable par l'appelant lui-même).
          const ip = req.socket.remoteAddress ?? 'inconnue'
          let bucket = errorsRateLimit.get(ip)
          if (!bucket) {
            pruneIdleBuckets(errorsRateLimit)   // purge avant croissance, cf. token-bucket.ts
            bucket = new TokenBucket(10, 0.5); errorsRateLimit.set(ip, bucket)
          }
          if (!bucket.take()) { res.statusCode = 429; res.end('Too Many Requests'); return }
          // b. corps plafonné à 64 Ko (même patron que le plafond 1 Mo du bloc MUTANTS plus bas,
          // fenêtre bien plus étroite — ce n'est qu'un rapport d'erreur, jamais un formulaire).
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
          // c. JSON strict (sinon 400) — AUCUNE interprétation/évaluation du contenu, juste des
          // champs copiés un à un, chacun plafonné et retypé défensivement.
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
          // d. source FORCÉE 'client' — `p.source` n'est JAMAIS lu : un payload menteur
          // (`source: 'server'`) est ignoré PAR CONSTRUCTION, pas par un filtre a posteriori.
          journalStore.record('client', { message, pile, url: errUrl, version, ua })
          res.statusCode = 204
          res.end()
          return
        }
        // étage client coupé : NE PAS intercepter — retombe dans le pipeline normal plus bas
        // (aucune action `.server.mjs` déclarée pour ce pathname ⇒ 405 par le bloc MUTANTS).
      } else if (pathname === '/__mjs/errors' || pathname === '/__mjs/errors.json') {
        if (req.method === 'GET' || req.method === 'DELETE') {
          // `opts.env` manquait ICI aussi (même bogue que warnIfJournalViewerOpenInProd
          // plus haut) : un `--prod` sans NODE_ENV laissait cette route ouverte en production réelle.
          if (!isViewerAllowed(journalCfg?.viewer, url, opts.env)) {
            res.statusCode = 404; res.end('Not Found'); return
          }
          if (pathname === '/__mjs/errors.json' && req.method === 'GET') {
            res.statusCode = 200
            res.setHeader('Content-Type', 'application/json; charset=utf-8')
            res.end(JSON.stringify(journalStore.list()))
            return
          }
          if (pathname === '/__mjs/errors' && req.method === 'GET') {
            try {
              const script = await getViewerScript(manifestPath, JOURNAL_VIEWER)
              res.statusCode = 200
              res.setHeader('Content-Type', 'text/html; charset=utf-8')
              res.end(shell('', '/__mjs/bundle.js', config.i18n?.default || 'fr', viewerScriptElement(script, JOURNAL_VIEWER)))
            } catch (e: any) {
              console.error(t('server.journal-viewer-compile-echec', { erreur: e && e.message ? e.message : String(e) }))
              res.statusCode = 500
              res.end('Internal Server Error')
            }
            return
          }
          if (pathname === '/__mjs/errors' && req.method === 'DELETE') {
            const src = url.searchParams.get('source')
            journalStore.purge(src === 'server' || src === 'client' ? src : null)
            res.statusCode = 204
            res.end()
            return
          }
        }
      }
      // Atelier /__mjs/theme : variables de thème ($$) déclarées/lues par le projet, lit
      // SEULEMENT le registre déjà écrit par le bundler (computeVarRegistry, bundler/index.ts)
      // — aucun calcul ici. OUTIL DE DÉVELOPPEMENT UNIQUEMENT : 404 (jamais 403, indistinct d'une
      // route absente) dès que production ; AUCUNE clé de config ajoutée pour ce garde — un éventuel
      // jeton `?token=` pourrait s'ajouter, comme celui du journal.
      // isProdEnv (viewer-page.ts) teste aussi `opts.env` (drapeau
      // --prod du CLI), plus seulement NODE_ENV : même patron que server/index.ts (StaticServer,
      // déjà fermée), cf. tests/serve-prod-guard.test.ts.
      if (pathname === '/__mjs/theme' || pathname === '/__mjs/theme.json') {
        if (isProdEnv(opts.env)) { res.statusCode = 404; res.end('Not Found'); return }
        if (pathname === '/__mjs/theme.json' && req.method === 'GET') {
          const registryPath = join(outputDir, '.mjs-theme-vars.json')
          res.statusCode = 200
          res.setHeader('Content-Type', 'application/json; charset=utf-8')
          res.end(existsSync(registryPath) ? readFileSync(registryPath) : '{}')
          return
        }
        if (pathname === '/__mjs/theme' && req.method === 'GET') {
          try {
            const script = await getViewerScript(manifestPath, THEME_VIEWER)
            res.statusCode = 200
            res.setHeader('Content-Type', 'text/html; charset=utf-8')
            res.end(shell('', '/__mjs/bundle.js', config.i18n?.default || 'fr', viewerScriptElement(script, THEME_VIEWER)))
          } catch (e: any) {
            console.error(t('server.theme-viewer-compile-echec', { erreur: e && e.message ? e.message : String(e) }))
            res.statusCode = 500
            res.end('Internal Server Error')
          }
          return
        }
      }
      // Assets compilés (imports du manifeste) : outputDir, en retirant l'éventuel urlPrefix.
      const rel = (urlPrefix && pathname.startsWith(urlPrefix) ? pathname.slice(urlPrefix.length) : pathname).replace(/^\/+/, '')
      const asset = join(outputDir, rel)
      if (rel && isWithinDir(outputDir, asset) && existsSync(asset) && statSync(asset).isFile() && isRealPathWithin(outputDir, asset)) {
        res.setHeader('Content-Type', MIME[extname(asset)] || 'application/octet-stream')
        res.end(readFileSync(asset)); return
      }
      // Verbes MUTANTS (POST/PUT/PATCH/DELETE) : pipeline PARTAGÉ avec `mjs dev`
      // (garde origin, content-type, plafond corps, action, 303/422), cf. action-pipeline.ts pour le
      // détail. mjs_ajax.ts (client) : POST/PUT/PATCH envoient un corps (FormData → multipart posé
      // par fetch, ou objet → JSON, cf. `_request`) ; DELETE part SANS corps ni Content-Type
      // (µ.ajax.delete n'a pas de paramètre `data`, cf. mjs_ujs.ts `_mjs_navDispatch`).
      if (await handleMutatingRequest(req, res, pathname, reqUrl, { config, entry, recordServer, manifestPath })) return
      // Asset ABSENT dont le dernier segment porte une
      // extension (script/style/wasm cassé, ex. /modularjs/inexistant.js) : 404 direct, jamais le
      // repli rendu plus bas (qui sert le shell 200 pour toute URL non déclarée, cf.
      // render-request.ts) — sauf X-MJS-Nav, qui veut la fiche JSON (négociée juste en dessous)
      // même pour un chemin à extension. Même règle que `mjs dev` (server/index.ts).
      // Cette garde tombait AUSSI sur une route DÉCLARÉE avec extension
      // (render.routes['/modularjs/sitemap.xml'], sitemap/robots…) : jamais rendue, 404 sec. Une
      // route résolue par `resolvePage` (déclarée telle quelle, préfixe ou pas) passe toujours au
      // rendu — la garde ne vaut que pour un chemin non déclaré.
      const rawNavPeek = req.headers['x-mjs-nav']
      const navPeek = Array.isArray(rawNavPeek) ? rawNavPeek[0] : rawNavPeek
      const declaredRoute = resolvePage(pathname, (config as any).render, null)
      if (rel && /\.[a-z0-9]+$/i.test(rel) && !navPeek && !declaredRoute) { res.statusCode = 404; res.end('Not Found'); return }
      // Négociation de protocole : X-MJS-Nav présent et non vide → JSON
      // { module, props, url, title, version } au lieu du shell HTML ; même URL,
      // deux représentations, d'où Vary sur les deux branches (ici et HTML plus bas).
      const rawNav = req.headers['x-mjs-nav']
      const navHeader = Array.isArray(rawNav) ? rawNav[0] : rawNav
      if (navHeader) {
        const page = resolvePage(pathname, (config as any).render, null)
        const version = readBuildVersion(manifestPath)
        res.statusCode = page ? 200 : 404
        res.setHeader('Content-Type', 'application/json; charset=utf-8')
        res.setHeader('Vary', 'X-MJS-Nav')
        if (version) res.setHeader('X-MJS-Version', version)
        const props = page ? await entry.propsFor(pathname, req) : {}
        // title: null — mjs serve laisse ce champ vide (le titre de SES pages vient du <@head><title> du
        // composant, cf. mjs_runes.ts µ._mjs_setTitle) mais le CLIENT le LIT désormais : un back applicatif
        // qui parle ce protocole peut y poser le titre qu'il connaît (fiche produit, article…) pour l'imposer
        // à l'onglet — le <@head><title> du composant qui arrive, s'il existe, tire ensuite dans sa microtâche
        // et garde toujours le dernier mot.
        res.end(JSON.stringify({ module: page ? page.component : null, props, url: reqUrl, title: null, version, ...navExtras(config.render) }))
        return
      }
      // Sinon : une PAGE → handler de rendu (mode résolu + override header).
      // Ce signal était déjà câblé côté `mjs dev` (server/index.ts,
      // req.on('close') → AbortController) seulement, `render-server.ts` alors restreint à sa
      // table MIME (503 persistant confirmé côté `mjs serve`
      // sans ce câblage). Même patron : `close` retiré dans le `finally`, jamais accroché après
      // une réponse normale.
      const abortOnClose = new AbortController()
      const onReqClose = () => abortOnClose.abort()
      req.on('close', onReqClose)
      let r: RenderResponse
      try {
        r = await handler.handle(pathname, req.headers as any, abortOnClose.signal)
      } finally {
        req.off('close', onReqClose)
      }
      res.statusCode = r.status
      res.setHeader('Content-Type', 'text/html; charset=utf-8')
      res.setHeader('X-MJS-Mode', r.mode || 'csr')
      res.setHeader('Vary', 'X-MJS-Nav')
      // Même en-tête que `mjs dev` (server/index.ts) : status 503 seulement, avec le
      // délai suggéré posé par le handler (RenderGate, render-request.ts) — manquait ICI jusque-là.
      if (r.status === 503 && r.retryAfter) res.setHeader('Retry-After', String(r.retryAfter))
      // même en-tête que les 2 branches JSON : sans lui, un client qui navigue en mode
      // HTML ne peut jamais détecter un nouveau build (cf. readBuildVersion plus haut).
      const version = readBuildVersion(manifestPath)
      if (version) res.setHeader('X-MJS-Version', version)
      // NEUF — même règle que la fiche JSON (navExtras) : la page qui ARRIVE en HTML la porte
      // aussi, posée SEULEMENT si configurée (Vary INCHANGÉ : la variation dépend de la requête
      // X-MJS-Nav, pas de ces en-têtes fixes issus de la config).
      const extras = navExtras(config.render)
      if (extras.target) res.setHeader('X-MJS-Target', extras.target)
      if (extras.method) res.setHeader('X-MJS-Method', extras.method)
      if (extras.cache) res.setHeader('X-MJS-Cache', extras.cache)
      // µres plein dès le 1er chargement HTML : même chargeur (entry.propsFor) que la
      // branche JSON plus haut, mais rattrapé ICI (jamais de 500 pour un chargeur en échec sur une
      // page HTML — la branche JSON, elle, laisse remonter au catch global).
      // (point 5 de capture) — auparavant, l'échec était avalé en SILENCE TOTAL (props
      // vides, aucune trace nulle part : serve-entry.ts logue déjà 'server.entry-props-echec' puis
      // RELANCE, cf. son commentaire — mais rien ICI ne recueillait ce 2e passage). Comportement
      // HTTP INCHANGÉ (props vides, jamais un 500 pour un chargeur en échec sur une page HTML).
      const resProps = r.component ? await entry.propsFor(pathname, req).catch((e: any) => {
        recordServer({ message: e && e.message ? e.message : String(e), pile: e && e.stack, url: pathname })
        return {}
      }) : {}
      const resTag = resScript(pathname, resProps)
      const body = r.kind === 'csr'
        ? (r.component ? '<' + r.component + '></' + r.component + '>' : '<!-- mjs: csr -->')
        : r.body
      res.end(shell((resTag ? resTag + '\n' : '') + body, '/__mjs/bundle.js', config.i18n?.default || 'fr', '', buildSsrHead(config, configDir, manifestPath)))
    } catch (e: any) {
      console.error(t('server.erreur-imprevue', { url: req.url || '/', erreur: e && e.message ? e.message : String(e) }))
      // (point 1 de capture — dernier filet, quelle qu'en soit la cause).
      recordServer({ message: e && e.message ? e.message : String(e), pile: e && e.stack, url: req.url || '/' })
      res.statusCode = 500
      res.end('Internal Server Error')
    }
  })

  await new Promise<void>((ok) => server.listen(port, host, ok))
  const addr = server.address()
  const actualPort = (addr && typeof addr === 'object') ? addr.port : port
  return {
    server, port: actualPort,
    close: async () => { entry.close(); await handler.close(); journalStore.flush(); await new Promise<void>((ok) => server.close(() => ok())) },
  }
}
