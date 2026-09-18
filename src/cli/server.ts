// cli/server — commande `mjs serveur` : lance le serveur de jeu (MJS-Server, mjsServer() +
// app.game()) d'une appli à partir d'un fichier d'entry (`export default { …options mjsServer(),
// setup(app) }`). Commande SŒUR de `mjs ws` (cli/ws.ts, MJS-WS) — MÊME contrat, MÊME format
// d'entry, MÊME dialecte Civet des composants pour `.server.mjs`, MÊME rechargement à chaud —
// SEULE différence : `setup(app)` reçoit une app construite par `mjsServer()` (qui expose
// `.game()`), pas `mjsWs()`. Cf. docs/24-mjs-server.md §2 « Démarrer ».
//
// Briques RÉUTILISÉES telles quelles depuis cli/ws.ts (génériques, exportées pour l'occasion,
// AUCUN changement de comportement de `mjs ws`) : RESERVED_ENTRY_KEYS, CliLogger/createLogger,
// errText, describeTransport, importEntryModule (compilation dialecte Civet + grammaire @import
// déléguée à cli/server-entry.ts, import via une URL file:// cache-bustée),
// WATCHED_EXT/RELOAD_DEBOUNCE_MS. Briques DUPLIQUÉES (spécifiques à MJS-Server) : résolution
// d'entry (défauts propres, AUCUNE collision avec ceux de `mjs ws` — les deux commandes
// coexistent dans un même projet), contrat d'entry (typé MjsServerApp/MjsServerOptions),
// plan de fusion entry/config (+ `antiTriche`, propre à MJS-Server), boot/rechargement/arrêt
// (appellent TOUJOURS `mjsServer()`, jamais `mjsWs()`).
//
// Résolution de l'entry : --entry > mjs.config.json `serveur.entry` > défauts
// `serveur.server.mjs` > `server/serveur.server.mjs` > `serveur.js` > `serveur.civet` >
// `server/serveur.js` > `server/serveur.civet`, relatifs à --root.
//
// Contrat de l'entry : `export default` = OBJET, clés acceptées = options de mjsServer()
// (= options mjsWs() + `persist`/`antiTriche`) sauf port/host/onLog (réservées au CLI, ignorées
// avec un warn — MÊME liste que `mjs ws`), plus `setup(app)` optionnelle (sync ou async), reçoit
// l'app construite par `mjsServer()`.

import { existsSync, watch as fsWatch } from 'node:fs'
import { resolve, dirname, relative } from 'node:path'
import { mjsServer } from '../mjs-server/index.js'
import type { MjsServerApp, MjsServerOptions } from '../mjs-server/index.js'
import { DEFAULT_LIMITS, DEFAULT_HEARTBEAT, DEFAULT_TOKEN, resolveBridgeOptions, resolveResumeOptions, isLoopbackHost, isProxyOptions } from '../mjs-ws/index.js'
import type { MjsWsLimits, MjsWsTokenOptions } from '../mjs-ws/index.js'
import type { MjsConfig, ServeurConfig } from '../bundler/config.js'
import {
  RESERVED_ENTRY_KEYS, createLogger, errText, describeTransport, importEntryModule,
  WATCHED_EXT, RELOAD_DEBOUNCE_MS,
} from './ws.js'
import type { CliLogger } from './ws.js'
import { t } from '../messages/index.js'

// --- squelette imprimé quand aucune entry n'est trouvée ---------------------

// dialecte Civet des composants (MÊME pré-passe que `ws.server.mjs`, cf. cli/ws.ts) —
// app.game(...) via setup(app) : l'app est construite par le CLI (mjsServer), AUCUN import
// dans le squelette (l'entry est chargée par data: URL → un import npm y planterait, cf. ws)
const ENTRY_SKELETON = `export default
  setup: (app) ->
    app.game 'morpion',
      seats: 2
      state: (partie) -> { grille: Array(9).fill(null) }
      moves:
        jouer: (partie, joueur, p) ->
          partie.state.grille[p.i] = joueur.id
          partie.next()
`

// ordre de résolution des défauts : serveur.server.mjs > server/serveur.server.mjs >
// serveur.js > serveur.civet > server/serveur.js > server/serveur.civet — AUCUN chevauchement
// avec ENTRY_DEFAULTS de `mjs ws` (ws.*) : les deux commandes résolvent chacune leur propre
// fichier dans un même projet, sans jamais se marcher dessus.
const SERVEUR_ENTRY_DEFAULTS = ['serveur.server.mjs', 'server/serveur.server.mjs', 'serveur.js', 'serveur.civet', 'server/serveur.js', 'server/serveur.civet']

function entryNotFoundMessage(reason: string): string {
  return t('cli.serveur.entry-introuvable', { raison: reason, squelette: ENTRY_SKELETON })
}

/** Résout le chemin ABSOLU de l'entry — --entry > serveur.entry (config) > serveur.server.mjs >
 *  server/serveur.server.mjs > serveur.js > serveur.civet > server/serveur.js > server/serveur.civet. */
export function resolveServeurEntryPath(root: string, cliEntry: string | undefined, configEntry: string | undefined): string {
  if (cliEntry !== undefined) {
    const p = resolve(root, cliEntry)
    if (!existsSync(p)) throw new Error(entryNotFoundMessage(t('cli.entry-cli-introuvable', { cliEntry, chemin: p })))
    return p
  }
  if (configEntry !== undefined) {
    const p = resolve(root, configEntry)
    if (!existsSync(p)) throw new Error(entryNotFoundMessage(t('cli.entry-config-introuvable', { champ: 'serveur.entry', valeur: configEntry, chemin: p })))
    return p
  }
  for (const rel of SERVEUR_ENTRY_DEFAULTS) {
    const p = resolve(root, rel)
    if (existsSync(p)) return p
  }
  throw new Error(entryNotFoundMessage(t('cli.entry-aucun-trouve', { liste: SERVEUR_ENTRY_DEFAULTS.join(', '), racine: root })))
}

// --- contrat de l'entry : export default = objet, clés mjsServer() + setup(app) -----------

export interface ServeurEntryContract {
  options: MjsServerOptions
  setup?: (app: MjsServerApp) => unknown
}

/** Valide + isole le contrat d'un module d'entry déjà importé (`mod` = namespace ES) — MÊME
 *  règle que readEntryContract (cli/ws.ts) : RESERVED_ENTRY_KEYS (port/host/onLog) réutilisée
 *  telle quelle, `setup` doit être une fonction si présente. */
export function readServeurEntryContract(mod: any, entryPath: string, warn: (message: string) => void): ServeurEntryContract {
  const dflt = mod ? mod.default : undefined
  if (dflt === undefined || dflt === null || typeof dflt !== 'object' || Array.isArray(dflt)) {
    const got = dflt === undefined ? t('cli.aucun-export-defaut') : (Array.isArray(dflt) ? t('cli.un-tableau') : typeof dflt)
    throw new Error(t('cli.entry-doit-export-default', { produit: 'mjs serveur', entryPath, recu: got }))
  }

  const options: Record<string, unknown> = {}
  for (const key of Object.keys(dflt)) {
    if (key === 'setup') continue   // traité séparément ci-dessous
    if (RESERVED_ENTRY_KEYS.includes(key)) { warn(t('cli.entry-cle-ignoree', { cle: key })); continue }
    options[key] = (dflt as any)[key]
  }

  let setup: ((app: MjsServerApp) => unknown) | undefined
  if (dflt.setup !== undefined) {
    if (typeof dflt.setup !== 'function') {
      throw new Error(t('cli.entry-setup-doit-etre-fonction', { produit: 'mjs serveur', entryPath, recu: typeof dflt.setup }))
    }
    setup = dflt.setup
  }

  return { options: options as MjsServerOptions, setup }
}

// --- priorités port/host/heartbeat/limits/antiTriche : entry > config > défauts CLI ---------

export interface ServeurRunPlan {
  options: MjsServerOptions
  setup?: (app: MjsServerApp) => unknown
  port: number
  host?: string
  heartbeat: number
  limits: MjsWsLimits
}

// port par défaut DISTINCT de `mjs ws` (4000) — les deux commandes peuvent tourner en même temps
// dans un même projet (ex. chat MJS-WS + lobby MJS-Server), sur des ports différents par défaut.
const DEFAULT_SERVEUR_PORT = 4001

/** Fusionne le contrat de l'entry + la section `serveur` de la config + --port/--host — l'ENTRY
 *  prime EN BLOC sur chaque clé partagée (warn si doublon) — MÊME règle que buildRunPlan (cli/ws.ts).
 *  `cliHost` : dernier paramètre, OPTIONNEL — même patron que buildRunPlan. */
export function buildServeurRunPlan(
  contract: ServeurEntryContract,
  serveurConfig: ServeurConfig | undefined,
  cliPort: number | undefined,
  warn: (message: string) => void,
  cliHost?: string,
): ServeurRunPlan {
  const options: MjsServerOptions = { ...contract.options }

  if (serveurConfig?.transport !== undefined) {
    if (options.transport !== undefined) warn(t('cli.entry-config-doublon', { champ: 'transport', chemin: 'serveur.transport' }))
    else options.transport = serveurConfig.transport
  }
  if (serveurConfig?.codec !== undefined) {
    if (options.codec !== undefined) warn(t('cli.entry-config-doublon', { champ: 'codec', chemin: 'serveur.codec' }))
    else options.codec = serveurConfig.codec
  }
  if (serveurConfig?.heartbeat !== undefined) {
    if (options.heartbeat !== undefined) warn(t('cli.entry-config-doublon', { champ: 'heartbeat', chemin: 'serveur.heartbeat' }))
    else options.heartbeat = serveurConfig.heartbeat
  }
  if (serveurConfig?.limits !== undefined) {
    if (options.limits !== undefined) warn(t('cli.entry-config-doublon', { champ: 'limits', chemin: 'serveur.limits' }))
    else options.limits = serveurConfig.limits
  }
  if (serveurConfig?.token !== undefined) {
    if (options.token !== undefined) warn(t('cli.entry-config-doublon', { champ: 'token', chemin: 'serveur.token' }))
    else options.token = serveurConfig.token
  }
  if (serveurConfig?.bridge !== undefined) {
    if (options.bridge !== undefined) warn(t('cli.entry-config-doublon', { champ: 'bridge', chemin: 'serveur.bridge' }))
    else options.bridge = serveurConfig.bridge as MjsServerOptions['bridge']
  }
  if (serveurConfig?.resume !== undefined) {
    if (options.resume !== undefined) warn(t('cli.entry-config-doublon', { champ: 'resume', chemin: 'serveur.resume' }))
    else options.resume = serveurConfig.resume
  }
  if (serveurConfig?.adapter !== undefined) {
    if (options.adapter !== undefined) warn(t('cli.entry-config-doublon', { champ: 'adapter', chemin: 'serveur.adapter' }))
    else options.adapter = serveurConfig.adapter as MjsServerOptions['adapter']
  }
  if (serveurConfig?.stats !== undefined) {
    if (options.stats !== undefined) warn(t('cli.entry-config-doublon', { champ: 'stats', chemin: 'serveur.stats' }))
    else options.stats = serveurConfig.stats
  }
  if (serveurConfig?.sessionExclusive !== undefined) {
    if (options.sessionExclusive !== undefined) warn(t('cli.entry-config-doublon', { champ: 'sessionExclusive', chemin: 'serveur.sessionExclusive' }))
    else options.sessionExclusive = serveurConfig.sessionExclusive
  }
  if (serveurConfig?.verifyOrigin !== undefined) {
    if (options.verifyOrigin !== undefined) warn(t('cli.entry-config-doublon', { champ: 'verifyOrigin', chemin: 'serveur.verifyOrigin' }))
    else options.verifyOrigin = serveurConfig.verifyOrigin
  }
  // antiTriche (propre à MJS-Server) — MÊME règle que les clés héritées ci-dessus :
  // pas de fusion clé à clé, l'entry prime EN BLOC si les deux sont posés, avec un warn.
  if (serveurConfig?.antiCheat !== undefined) {
    if (options.antiCheat !== undefined) warn(t('cli.entry-config-doublon', { champ: 'antiCheat', chemin: 'serveur.antiCheat' }))
    else options.antiCheat = serveurConfig.antiCheat as MjsServerOptions['antiCheat']
  }

  // résolus AVANT l'appel à mjsServer() : passthrough (mjsServer()/mjsWs() appliquent les MÊMES
  // défauts, cf. buildRunPlan cli/ws.ts) — permet à la bannière d'afficher les valeurs EFFECTIVES.
  const heartbeat = options.heartbeat ?? DEFAULT_HEARTBEAT
  const limits: MjsWsLimits = { ...DEFAULT_LIMITS, ...(options.limits ?? {}) }
  options.heartbeat = heartbeat
  options.limits = limits

  const port = cliPort ?? serveurConfig?.port ?? DEFAULT_SERVEUR_PORT
  // MÊME borne que ws.port-hors-plage (cli/ws.ts) — sinon --port échappe à
  // toute validation et retombe sur un RangeError Node brut au moment de lier le transport
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(t('cli.serveur.port-hors-plage', { valeur: port }))
  // défaut loopback, MÊME règle que buildRunPlan (cli/ws.ts) — sans ce repli,
  // `mjs serveur` écoutait sur TOUTES les interfaces (host undefined transmis tel quel au
  // transport) : qui veut exposer le serveur le dit avec `--host ::`, jamais un silence
  const host = (cliHost ?? serveurConfig?.host ?? '').trim() || '127.0.0.1'

  return { options, setup: contract.setup, port, host, heartbeat, limits }
}

// --- bannière ------------------------------------------------------------------

function printBanner(logger: CliLogger, entryPath: string, root: string, plan: ServeurRunPlan): void {
  const rel = relative(root, entryPath) || entryPath
  logger.info(`MJS-Server — entry ${rel}`)
  logger.info(`transport : ${describeTransport(plan.options.transport)}`)
  logger.info(`codec ws : ${plan.options.codec ?? 'auto'}`)
  logger.info(t('cli.banniere-port', { port: plan.port, hote: plan.host ? ` (${plan.host})` : '' }))
  logger.info(t('cli.banniere-heartbeat', { etat: plan.heartbeat === 0 ? t('cli.desactive') : `${plan.heartbeat} ms` }))
  logger.info(t('cli.banniere-limites', { rate: plan.limits.rate, burst: plan.limits.burst, kickAfter: plan.limits.kickAfter, maxPayload: plan.limits.maxPayload, maxBuffered: plan.limits.maxBuffered, maxConnections: plan.limits.maxConnections ?? t('cli.illimite'), maxConnectionsPerIp: plan.limits.maxConnectionsPerIp ?? t('cli.illimite') }))
  const authOpt = plan.options.auth
  const joinOpt = plan.options.rooms?.join
  if (isProxyOptions(authOpt)) logger.info(`auth : proxy ${authOpt.url}`)
  if (isProxyOptions(joinOpt)) logger.info(t('cli.banniere-salons-proxy', { url: joinOpt.url }))
  if (plan.options.token) {
    const token: MjsWsTokenOptions = { ...DEFAULT_TOKEN, ...plan.options.token }
    logger.info(t('cli.banniere-jeton', { sweep: token.sweep / 1000, marge: token.slack / 1000 }))
  }
  if (plan.options.bridge) {
    const bridge = resolveBridgeOptions(plan.options.bridge, plan.port)
    logger.info(t('cli.banniere-pont', { host: bridge.host, port: bridge.port }))
    logger.info(bridge.webhooks
      ? t('cli.banniere-webhooks-actifs', { url: bridge.webhooks.url, evenements: Array.from(bridge.webhooks.events).join(', ') })
      : t('cli.banniere-webhooks-desactives'))
    logger.info(bridge.rateLimit
      ? t('cli.banniere-rate-limit-actif', { capacite: bridge.rateLimit.perIp.capacity, fenetre: bridge.rateLimit.perIp.windowMs / 1000, echecsCapacite: bridge.rateLimit.fails.capacity, echecsFenetre: bridge.rateLimit.fails.windowMs / 1000 })
      : t('cli.banniere-rate-limit-desactive'))
    if (plan.options.stats && isLoopbackHost(bridge.host)) {
      logger.info(t('cli.banniere-etat', { host: bridge.host, port: bridge.port }))
    }
  }
  if (plan.options.resume) {
    const resume = resolveResumeOptions(plan.options.resume)!
    logger.info(t('cli.banniere-reprise-session', { grace: resume.grace / 1000, maxBuffered: resume.maxBuffered, maxBytes: resume.maxBytes }))
  }
  if (plan.options.adapter) {
    const a = plan.options.adapter as { redis?: string; prefix?: string }
    const prefix = a.prefix ?? 'mjs-ws'
    logger.info(typeof a.redis === 'string'
      ? t('cli.banniere-multi-processus-redis', { redis: a.redis, prefixe: prefix })
      : t('cli.banniere-multi-processus-custom', { prefixe: prefix }))
  }
  // anti-triche (propre à MJS-Server) — mention SEULEMENT si armé (opt-in strict).
  if (plan.options.antiCheat?.movesPerIdentity) {
    const [n, fenetre] = plan.options.antiCheat.movesPerIdentity
    logger.info(t('cli.serveur.anti-triche', { n, fenetre: fenetre / 1000 }))
  }
  logger.info(t('cli.ctrl-c-arreter'))
}

// --- commande -----------------------------------------------------------------

export interface ServeurCommandArgs {
  root: string
  entry?: string
  port?: number
  /** posé par le flag générique --host (src/cli.ts), prioritaire sur serveur.host
   *  de la config — cf. buildServeurRunPlan. */
  host?: string
}

export interface ServeurCommandInjections {
  /** transport custom — MemoryTransport pour les tests (jamais de vrai port lié) */
  transport?: MjsServerOptions['transport']
  /** désactive le fs.watch (défaut true) — tests qui n'exercent pas le rechargement */
  watch?: boolean
}

export interface ServeurRunHandle {
  /** app COURANTE — change de référence après un rechargement à chaud réussi */
  readonly app: MjsServerApp
  readonly entryPath: string
  /** arrêt propre : watcher + timer + listeners signal + app.stop() (µ:bye) — SANS process.exit, réutilisé par le handler SIGINT et par les tests */
  stop(): Promise<void>
}

export async function runServeurCommand(
  args: ServeurCommandArgs,
  config: MjsConfig | undefined,
  injections: ServeurCommandInjections = {},
): Promise<ServeurRunHandle> {
  const logger    = createLogger()
  const entryPath = resolveServeurEntryPath(args.root, args.entry, config?.serveur?.entry)
  const transport = injections.transport

  async function boot(): Promise<MjsServerApp> {
    const mod      = await importEntryModule(entryPath, args.root)
    const contract = readServeurEntryContract(mod, entryPath, logger.warn)
    const plan     = buildServeurRunPlan(contract, config?.serveur, args.port, logger.warn, args.host)
    // MÊME règle que boot() de cli/ws.ts : l'injection de TEST prime TOUJOURS, sinon
    // plan.options.transport (résolu depuis l'entry/la config) passe tel quel.
    const app      = mjsServer({ ...plan.options, transport: transport ?? plan.options.transport, port: plan.port, host: plan.host, onLog: logger.log })
    if (plan.setup) await plan.setup(app)
    await app.listen()
    printBanner(logger, entryPath, args.root, plan)
    return app
  }

  let currentApp = await boot()

  // rechargement à chaud — MÊME machinerie (sérialisation par génération) que cli/ws.ts, cf. son
  // commentaire détaillé : dupliquée ici (fermetures propres à currentApp/mjsServer,
  // pas extraite en fonction générique — choix délibéré, propre à ce fichier).
  let reloadGeneration = 0
  let reloadRunning    = false
  let reloadPending    = false

  function scheduleReload(): void {
    reloadGeneration++
    if (reloadRunning) { reloadPending = true; return }
    runReloadLoop()
  }

  function runReloadLoop(): void {
    reloadRunning = true
    const myGeneration = reloadGeneration
    void reload(myGeneration).finally(() => {
      reloadRunning = false
      if (reloadPending) { reloadPending = false; runReloadLoop() }
    })
  }

  async function reload(myGeneration: number): Promise<void> {
    let mod: any
    try {
      mod = await importEntryModule(entryPath, args.root)
    } catch (err) {
      if (myGeneration === reloadGeneration) {
        logger.error(t('cli.reload-import-echec', { erreur: errText(err) }))
      }
      return
    }
    if (myGeneration !== reloadGeneration) return   // import périmé — jeté même réussi
    let contract: ServeurEntryContract
    try {
      contract = readServeurEntryContract(mod, entryPath, logger.warn)
    } catch (err) {
      logger.error(t('cli.reload-echec-generique', { erreur: errText(err) }))
      return
    }
    try {
      const plan = buildServeurRunPlan(contract, config?.serveur, args.port, logger.warn, args.host)
      await currentApp.stop()
      const app = mjsServer({ ...plan.options, transport: transport ?? plan.options.transport, port: plan.port, host: plan.host, onLog: logger.log })
      if (plan.setup) await plan.setup(app)
      await app.listen()
      currentApp = app
      logger.info(t('cli.redemarre', { chemin: relative(args.root, entryPath) || entryPath }))
    } catch (err) {
      logger.error(t('cli.reload-echec-fatal', { erreur: errText(err) }))
    }
  }

  let watcher: ReturnType<typeof fsWatch> | null = null
  let debounceTimer: ReturnType<typeof setTimeout> | null = null
  if (injections.watch ?? true) {
    const dir = dirname(entryPath)
    watcher = fsWatch(dir, { persistent: true, recursive: false }, (_event, filename) => {
      if (!filename || !WATCHED_EXT.test(filename)) return
      if (debounceTimer) clearTimeout(debounceTimer)
      debounceTimer = setTimeout(() => { debounceTimer = null; scheduleReload() }, RELOAD_DEBOUNCE_MS)
    })
  }

  async function shutdown(): Promise<void> {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
    if (watcher) { watcher.close(); watcher = null }
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
    await currentApp.stop()
  }
  const onSignal = (): void => { void shutdown().then(() => process.exit(0)) }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  return {
    get app() { return currentApp },
    entryPath,
    stop: shutdown,
  }
}
