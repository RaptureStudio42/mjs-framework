// MJS-WS — serveur compagnon officiel de µ.socket (cf. runtime/mjs_socket.ts
// pour le contrat exact) : cœur du protocole
// (core.ts, « le standardiste ») + protections de série (guard.ts, « le
// videur ») + salons/présence agrégée/kick (rooms.ts) + flux à journal borné
// avec resync incrémental (streams.ts) + pont universel/jetons (bridge.ts/
// token.ts) + reprise de session opt-in (sessions.ts) +
// adaptateur multi-processus (adapter.ts/adapter-redis.ts) + état/métriques
// toujours actifs (stats.ts, page /state dans stats-page.ts), derrière un
// transport interchangeable (WsTransport par défaut, MemoryTransport pour les
// tests). Module NODE-SEULEMENT — jamais chargé par le runtime navigateur
// (hors src/runtime/, absent de orderedFiles du bundler).
//
//   import { mjsWs } from 'mjs-framework/ws'
//
//   app = mjsWs({
//     auth:    (hello, meta) => hello.auth?.token === SECRET ? { id: 1, pseudo: 'Zora' } : false,
//     welcome: (client) => ({ serverTime: Date.now() }),
//     rooms:   { join: (room, client) => room !== 'vip', meta: (client) => ({ pseudo: client.identity?.pseudo }) },
//   })
//   app.serve('achat', (p, client) => ({ solde: 100 - p.prix }))
//   app.on('chat', (p, client) => app.broadcast('chat', p, { except: client }))
//   const ennemis = app.stream('ennemis', { journal: 200 })
//   ennemis.add('e1', { x: 10, y: 20 })              // delta numéroté + journal (resync auto)
//   app.room('partie-42').kick(tricheur, 'triche')   // µ:left, la connexion reste ouverte
//   await app.listen()
//
// docs/23-mjs-ws.md pour le détail des options/protections/état d'avancement.

import { WsTransport } from './transport-ws.js'
// transport uWebSockets.js (optionnel, AUCUNE dépendance ajoutée) — cf. transport-uws.ts pour
// l'import paresseux + le piège « ws natif invalide après close » ; docs/23-mjs-ws.md « La façade
// transport » pour le guide (choix 'ws'/'uws'/instance maison, squelette d'adaptateur commenté).
import { UwsTransport } from './transport-uws.js'
import { createCore } from './core.js'
import type {
  MjsWsApp, MjsWsClient, MjsWsHelloPayload, MjsWsLimits, MjsWsLogFn, MjsWsLogLevel, MjsWsResolvedOptions, MjsWsTokenOptions,
} from './core.js'
import type { MjsWsRemoteInfo, MjsWsTransport } from './transport.js'
import type { MjsWsRoomsOptions } from './rooms.js'
import { resolveBridgeOptions } from './bridge.js'
import type { MjsWsBridgeOptions } from './bridge.js'
// proxy de décisions (proxy.ts) — TYPE SEUL ICI : `auth` (ci-dessous) accepte désormais
// un objet-proxy {url,secret,...} EN PLUS de la fonction historique. La résolution objet→fonction
// (typeof === 'function' vs objet) vit dans core.ts (createCore), jamais ici — mjsWs() reste un
// simple passthrough de userOpts.auth vers resolved.auth, exactement comme avant.
import type { MjsWsProxyOptions } from './proxy.js'
import { resolveResumeOptions } from './sessions.js'
import type { MjsWsResumeOptions } from './sessions.js'
// adaptateur multi-processus — cf. adapter.ts (façade + MemoryAdapter),
// adapter-redis.ts (mini-client RESP maison, zéro dépendance)
import { RedisAdapter } from './adapter-redis.js'
import type { MjsWsAdapter } from './adapter.js'
// état/métriques — cf. stats.ts (registre + types), stats-page.ts (page /state),
// isLoopbackHost réexportée depuis bridge.ts (source UNIQUE, réutilisée par cli/ws.ts pour la bannière)
// µschema — cf. mjs-ws/schema.ts (résolution ws.codec + schemas en masse),
// src/schema/core.ts (registre pur, réexporté ICI pour l'ergonomie d'un fichier serveur :
// `import { mjsWs, list, bits } from 'mjs-framework/ws'`)
import { resolveSchemaOptions } from './schema.js'
import type { MjsWsCodec, MjsWsSchemaOptions } from './schema.js'
import { t } from '../messages/index.js'
export { list, bits } from '../schema/core.js'
export type { MjschemaScalar, MjschemaFieldType, MjschemaFields, MjschemaListType, MjschemaBitsType, MjschemaDefinitionsJSON } from '../schema/core.js'
export type { MjsWsCodec, MjsWsSchemaOptions } from './schema.js'

export { MemoryTransport, MemoryClientSocket } from './transport.js'
export type { MemoryTransportConnectOpts } from './transport.js'
export { WsTransport } from './transport-ws.js'
export type { WsTransportOpts } from './transport-ws.js'
// transport uWebSockets.js — cf. le commentaire d'import ci-dessus + docs/23-mjs-ws.md
export { UwsTransport } from './transport-uws.js'
export type { UwsTransportOpts, UwsModule, UwsTemplatedApp, UwsWebSocketBehavior, UwsWebSocket, UwsHttpRequest, UwsHttpResponse, UwsListenSocket } from './transport-uws.js'
export type { MjsWsConnection, MjsWsRemoteInfo, MjsWsTransport } from './transport.js'
export type {
  MjsWsApp, MjsWsClient, MjsWsHelloPayload, MjsWsLimits, MjsWsBroadcastOpts, MjsWsLogFn, MjsWsLogLevel, MjsWsTokenOptions,
} from './core.js'
export type { MjsWsRoomsOptions, MjsWsRoomHandle, MjsWsJoinFn } from './rooms.js'
export type { MjsWsStreamOptions, MjsWsStreamHandle } from './streams.js'
// pont universel — cf. bridge.ts pour l'implémentation, docs/23-mjs-ws.md pour le guide
export { resolveBridgeOptions } from './bridge.js'
export type {
  MjsWsBridgeOptions, MjsWsBridgeWebhooksOptions, MjsWsResolvedBridgeOptions, MjsWsResolvedBridgeWebhooks,
  MjsWsBridgeRateLimitOptions, MjsWsResolvedRateLimit,
} from './bridge.js'
// proxy de décisions — cf. proxy.ts pour l'implémentation ;
// docs/23-mjs-ws.md « Proxy de décisions » pour le guide (auth/rooms.join délégués à un back HTTP
// signé, réutilise le MÊME schéma de signature que le pont ci-dessus)
export { isProxyOptions } from './proxy.js'
export type { MjsWsProxyOptions } from './proxy.js'
// refus d'auth explicite — un opts.auth qui `throw new MjsWsAuthDenied('msg')` transmet son
// message métier au client ; une exception nue devient un `µ:denied` générique (détail loggé serveur seul)
export { MjsWsAuthDenied } from './core.js'
// jetons JWT HS256 sans dépendance — cf. token.ts, autonomes vis-à-vis du pont
export { signToken, verifyToken, jwtAuth } from './token.js'
export type { SignTokenOpts } from './token.js'
// reprise de session — cf. sessions.ts, docs/23-mjs-ws.md « La reprise de session »
export { DEFAULT_RESUME, resolveResumeOptions } from './sessions.js'
export type { MjsWsResumeOptions, MjsWsResolvedResume } from './sessions.js'
// adaptateur multi-processus — cf. adapter.ts/adapter-redis.ts, docs/23-mjs-ws.md
// « Plusieurs processus : l'adaptateur Redis ». MemoryAdapter est exportée pour les tests des
// applis (2+ apps MJS-WS dans le même processus, cf. tests/mjs-ws-adapter.test.ts) ; RedisAdapter
// pour une construction programmatique fine (sinon `opts.adapter = { redis, prefix? }` suffit).
export { MemoryAdapter, createMemoryAdapterBus } from './adapter.js'
export type { MjsWsAdapter, MjsWsAdapterHandler, MemoryAdapterBus, MemoryAdapterOpts } from './adapter.js'
export { RedisAdapter, parseRedisUrl } from './adapter-redis.js'
export type { RedisAdapterOpts, ParsedRedisUrl } from './adapter-redis.js'
// état/métriques — cf. stats.ts, stats-page.ts, docs/23-mjs-ws.md « L'état du serveur »
export { isLoopbackHost } from './bridge.js'
export { LatencyReservoir, LATENCY_RESERVOIR_SIZE, createStatsRegistry, toPrometheusText } from './stats.js'
export type {
  MjsWsGuardCause, MjsWsStatsSnapshot, MjsWsStatsRegistry, MjsWsStatsGauges, MjsWsStatsLatences,
  MjsWsStatsConnexions, MjsWsStatsMessages, MjsWsStatsGuard, MjsWsStatsRooms, MjsWsStatsFlux,
  MjsWsStatsPont, MjsWsStatsAdaptateur, MjsWsStatsSessions, MjsWsStatsErreurs,
} from './stats.js'
export { renderStatsPage } from './stats-page.js'
// contrat TYPÉ optionnel — cf. contract.ts (ZÉRO runtime, que des
// types + deux casts identité), docs/23-mjs-ws.md « Contrat typé »
export { asTypedApp, asTypedSocket } from './contract.js'
export type {
  MjsWsContract, MjsWsResultOf, TypedApp, TypedSocket, MjsSocketLoose, MjsRoomProxyLoose, MjsRequestOpts, MjsSendOpts,
} from './contract.js'
// paquets activables (packages.ts) — cf. son commentaire de tête : `app.use`
// (core.ts) installe un MjsPackage ; `definirPaquet` = fabrique ergonomique ; `paquetEcho` =
// exemple de référence (patron des paquets chat, comptes et lobby).
export { definePackage, echoPackage } from './packages.js'
export type { MjsPackage } from './packages.js'
// paquet CHAT v1 (chat.ts) — 1er paquet applicatif RÉEL
// au-dessus du patron paquetEcho : salons à historique, débit par identité+salon, modération
// (suppression/muet), frappe. Cf. docs/26-chat.md pour le guide, chat.ts pour le protocole complet.
export { chatPackage } from './chat.js'
export type { MjsWsChatOptions, MjsWsChatMessageCtx } from './chat.js'
// paquet COMPTES & IDENTITÉS v1 (comptes.ts) — comptes
// persistés (scrypt), jetons réutilisant token.ts (signToken), élévation invité→compte par
// µ:refresh EXISTANT (jamais dupliqué, cf. son en-tête « Élévation »), rôles + `hasRole`,
// anti-force-brute. `opts.secret` DOIT être le MÊME que `jwtAuth(secret)` posé en `mjsWs({ auth })`.
// Cf. docs/27-accounts.md pour le guide, comptes.ts pour le protocole complet.
export { accountsPackage, accountsAuth, hasRole, MemoryAccountsPersistAdapter, FileAccountsPersistAdapter, FailureBucket } from './accounts.js'
export type { MjsWsAccountsOptions, MjsWsAccountRecord, MjsWsAccountsPersistAdapter, FileAccountsPersistAdapterOpts } from './accounts.js'
// paquet LOBBY v1 (lobby.ts) —
// hall d'accueil : présence riche (statuts libre/occupe/absent, absent auto), invitations anti-spam
// (blocage silencieux), annonces de tables génériques avec crochet d'appariement (`opts.onJoin`,
// AUCUN import du module jeu ici). Cf. docs/28-lobby.md pour le guide, lobby.ts pour le protocole complet.
export { lobbyPackage } from './lobby.js'
export type {
  MjsWsLobbyOptions, MjsWsLobbyStatus, MjsWsLobbyMember, MjsWsLobbyInvitationPayload,
  MjsWsLobbyListingPayload, MjsWsLobbyJoinCtx,
} from './lobby.js'

export interface MjsWsOptions {
  /**
   * Transport — trois formes acceptées. Chaîne `'ws'` (défaut, bibliothèque `ws`) ou `'uws'`
   * (uWebSockets.js, cf. transport-uws.ts — paquet natif à installer à part, PAS une dépendance
   * de ModularJS) : résolues vers l'adaptateur intégré correspondant, construit avec
   * `port`/`host` (+ `limits.maxPayload` pour 'uws'). Ou une INSTANCE MjsWsTransport déjà
   * construite — un transport maison, ou `MemoryTransport` en test. Cf. docs/23-mjs-ws.md
   * « La façade transport : brancher uWebSockets.js (ou autre chose) ».
   */
  transport?: MjsWsTransport | 'ws' | 'uws'
  /** Port TCP du transport par défaut ('ws'/'uws'). Ignoré si `transport` est une instance. */
  port?: number
  /** Host du transport par défaut ('ws'/'uws'). Ignoré si `transport` est une instance. */
  host?: string
  /**
   * Authentifie le µ:hello. `false` ou throw → µ:denied {message}. Retour → `client.identity`.
   * Fonction historique OU objet-proxy `{url, secret, timeout?, cache?}` (proxy.ts)
   * délégant la décision à un back HTTP signé (POST `{event:'connect', hello}`, réponse
   * `{ok:true, identity}` ou `{ok:false, raison?}`) — façon Centrifugo, le dev ne code plus
   * l'appel HTTP lui-même. Cf. docs/23-mjs-ws.md « Proxy de décisions ».
   */
  auth?: ((hello: MjsWsHelloPayload, meta: MjsWsRemoteInfo) => unknown | Promise<unknown>) | MjsWsProxyOptions
  /** Construit la charge du µ:welcome (défaut : `{}`). Appelé après auth, avant l'envoi (synchrone dans le flux — cf. contrat). */
  welcome?: (client: MjsWsClient) => unknown | Promise<unknown>
  /** Désérialisation des trames entrantes (défaut : JSON.parse). */
  parse?: (data: string) => any
  /** Sérialisation des trames sortantes (défaut : JSON.stringify). */
  serialize?: (obj: unknown) => string
  /** Période ATTENDUE des µ:ping client, ms (défaut 15000). Watchdog serveur = 2.5×. `0` = watchdog désactivé. */
  heartbeat?: number
  /** Quotas anti-abus par connexion (cf. MjsWsLimits pour les défauts). */
  limits?: Partial<MjsWsLimits>
  /**
   * Suivi d'expiration + rafraîchissement du jeton (src/mjs-ws/core.ts) — `sweep` :
   * période du balayage global qui ferme les connexions à jeton expiré (ms, défaut 10000).
   * `slack` : tolérance d'horloge avant fermeture (ms, défaut 5000). Opt-in STRICT au RUNTIME
   * (pas un commutateur ici) : sans échéance `exp` connue d'aucun client (`opts.auth` qui n'en
   * pose jamais), aucun balayage n'est jamais armé — cette clé ne fait alors RIEN d'observable.
   * Cf. docs/23-mjs-ws.md « Expiration et rafraîchissement du jeton ».
   */
  token?: Partial<MjsWsTokenOptions>
  /**
   * Salons : garde d'admission `join(room, client)` (false/throw = refus) et méta de présence
   * `meta(client)` (défaut {}). `canSeePresence(room, client)` : garde de LECTURE de présence
   * de salon, opt-in, MIROIR de `join` — absente (défaut)
   * = présence de salon lisible par tout authentifié comme avant, SANS lien avec `join`. Plafond de
   * salons par client : `limits.maxRoomsPerClient` (pas ici, cf. MjsWsLimits).
   */
  rooms?: MjsWsRoomsOptions
  /** Pose des filets uncaughtException/unhandledRejection qui LOGGENT sans tuer le process (défaut false). */
  guardProcess?: boolean
  /** Callback de log (défaut : console, format sobre). */
  onLog?: MjsWsLogFn
  /** Pont universel (bridge.ts) — absent = désactivé. cf. docs/23-mjs-ws.md « Le pont universel ». */
  bridge?: MjsWsBridgeOptions
  /** Reprise de session (sessions.ts) — absent/false = comportement historique STRICT ; `true` = défauts (grâce 30 s, 500 trames, 256 Ko) ; objet = réglages fins. */
  resume?: boolean | MjsWsResumeOptions
  /**
   * Session exclusive par identité (core.ts) — défaut `false`, DEUX
   * modes opt-in. `true` ≡ `'replace'` : un `µ:hello` FRAIS d'une identité déjà connue
   * (`identity.id`) éjecte toute AUTRE connexion de cette MÊME identité — vivante (`µ:bye
   * { reason: 'replace' }` + fermeture code **4003**, jamais parquée/reprise) ou déjà parquée
   * (révoquée, ne peut plus être reprise). `'refuse'` (inverse) : le `µ:hello` FRAIS est REFUSÉ
   * (`µ:denied` + fermeture code **4004**) si une connexion VIVANTE de cette MÊME identité existe
   * déjà — l'EXISTANT gagne ; les sessions PARQUÉES seules sont purgées (même règle que
   * 'replace'). Identité anonyme (`auth` qui ne pose jamais `id`) → jamais concernée, quel que
   * soit le mode. Multi-processus : exclusivité PAR PROCESS seulement en mode `'refuse'` (best
   * effort global, cf. docs/23-mjs-ws.md §8.5).
   */
  sessionExclusive?: boolean | 'replace' | 'refuse'
  /**
   * Vérification d'origine (core.ts::acceptConnection) — absente (défaut)
   * = comportement historique STRICT, aucune connexion refusée pour son origine (opt-in). Forme
   * TABLEAU : allowlist stricte d'origines exactes (schéma+hôte+port, ex. `'https://exemple.com'`),
   * comparaison insensible à la casse (compilée en Set minuscule UNE fois à la résolution, jamais
   * par connexion) — Origin absent ou non listé = refus. Forme FONCTION : contrôle total, reçoit
   * l'Origin brut (`string | undefined`) + le `MjsWsRemoteInfo` de la connexion, retourne `true`
   * pour admettre ; une exception levée = refus (fail-closed). Refus = fermeture immédiate code
   * **1008** (Policy Violation, définitif), AVANT le hello (pas de µ:denied), compteur DÉDIÉ
   * `stats.connexions.refuseesOrigine`. Cf. docs/23-mjs-ws.md « Vérification d'origine ».
   */
  verifyOrigin?: string[] | ((origin: string | undefined, remote: MjsWsRemoteInfo) => boolean)
  /**
   * Rappelée à la déconnexion DÉFINITIVE d'un client authentifié — immédiate sans reprise
   * (`opts.resume` absent), différée à l'expiration de la grâce sinon (jamais pour une coupure
   * encore en grâce, jamais deux fois pour la même connexion). Miroir du webhook 'disconnect' du
   * pont universel (bridge.ts, notifyDisconnect), mais TOUJOURS disponible même sans `opts.bridge`
   * — pensée pour un module de composition (ex. MJS-Server, cf. mjs-framework/mjs-server) qui a besoin
   * d'être prévenu sans monter un pont HTTP juste pour ça. Cf. docs/23-mjs-ws.md §8.2 point 5.
   */
  onDisconnect?: (client: MjsWsClient, reason?: string) => void
  /**
   * Adaptateur multi-processus — absent = mono-process (défaut). Objet `{ redis,
   * prefix? }` → RedisAdapter construite automatiquement ; ou une instance MjsWsAdapter déjà
   * construite (MemoryAdapter en test, ou un adaptateur maison). Cf. docs/23-mjs-ws.md
   * « Plusieurs processus : l'adaptateur Redis ».
   */
  adapter?: MjsWsAdapterConfig | MjsWsAdapter
  /**
   * Anti-entropie de présence (cf. docs/23-mjs-ws.md « Anti-entropie de présence ») — cadence de
   * publication de l'instantané de réconciliation, ms (défaut 15000, cf. DEFAULT_ANTI_ENTROPY),
   * `false` = désactivée (comportement identique à avant ce mécanisme). PRIME sur
   * `opts.adapter.antiEntropy` (forme déclarative `{redis,...}` SEULEMENT — une instance
   * MjsWsAdapter déjà construite n'a pas ce champ, cf. resolveAntiEntropyOption) — sans effet
   * si `opts.adapter` est absent.
   */
  antiEntropy?: number | false
  /**
   * État/métriques (stats.ts) — absent/`false` = le registre de compteurs tourne QUAND
   * MÊME (`app.stats()` marche toujours), mais aucun endpoint HTTP n'est exposé. `true` = en plus,
   * si `opts.bridge` est actif : GET /stats (JSON), GET /metrics (Prometheus), GET /state (page HTML
   * sombre) — signés comme le reste du pont, SAUF si le host effectif du pont est loopback (dev
   * local, cf. `isLoopbackHost`). Sans `opts.bridge`, `stats: true` n'a aucun effet observable (rien
   * n'écoute en HTTP pour les servir). Cf. docs/23-mjs-ws.md « L'état du serveur ».
   */
  stats?: boolean
  /**
   * µschema (mjs-ws/schema.ts) — codec des trames applicatives SORTANTES/ENTRANTES.
   * `'auto'` (défaut) : un type avec schéma déclaré (app.schema()/opts.schemas) part en BINAIRE,
   * le reste en JSON. `'binary'` : STRICT — un type applicatif SANS schéma est un refus (throw à
   * l'envoi, rejet + µ:error à la réception) ; les trames de contrôle µ: restent TOUJOURS JSON
   * (bootstrap du hello). `'json'` : coupe-circuit débogage, tout part en JSON même schématisé.
   * MÊME règle que heartbeat/limits/bridge… (cf. cli/ws.ts buildRunPlan) : définissable ICI ou
   * dans `mjs.config.json` (`ws.codec`), l'ENTRY prime EN BLOC en cas de doublon. Cf.
   * docs/23-mjs-ws.md « µschema ».
   */
  codec?: MjsWsCodec
  /**
   * µschema — déclaration EN MASSE, ÉQUIVALENT à autant d'appels `app.schema(nom,
   * champs)` avant `.listen()` (même garde ajout-seul). Réservée à l'entry (fonctions `list`/
   * `bits` non représentables en JSON) — PAS de pendant `mjs.config.json`, cf. docs/23-mjs-ws.md.
   */
  schemas?: MjsWsSchemaOptions['schemas']
}

/** Forme OBJET de `opts.adapter` — résolue en RedisAdapter par mjsWs() (cf. resolveAdapterOption). */
export interface MjsWsAdapterConfig {
  /** redis://[[:motDePasse]@]hôte[:port][/base] */
  redis: string
  /** espace de noms des canaux/clés Redis — défaut 'mjs-ws' */
  prefix?: string
  /**
   * Anti-entropie de présence, forme DÉCLARATIVE — MÊME sémantique que `opts.antiEntropy`
   * (racine), lue seulement si celle-ci est absente (cf. resolveAntiEntropyOption). Utile pour
   * `mjs.config.json` (`ws.adapter.antiEntropy`, cf. bundler/config.ts) : une instance
   * MjsWsAdapter déjà construite n'a pas ce champ, `opts.antiEntropy` (racine) reste alors le
   * SEUL levier (tests, adaptateur maison).
   */
  antiEntropy?: number | false
}

// une INSTANCE déjà construite a toujours .publish/.subscribe/.start/.stop (interface
// MjsWsAdapter) — un objet de CONFIG n'a que `redis` (+ `prefix`/`antiEntropy` optionnels) : la
// présence de `publish` suffit à trancher, jamais d'ambiguïté entre les deux formes.
function isAdapterInstance(x: MjsWsAdapterConfig | MjsWsAdapter): x is MjsWsAdapter {
  return typeof (x as MjsWsAdapter).publish === 'function'
}

/** Résout `opts.adapter` — instance donnée telle quelle, objet `{redis,prefix?}` → RedisAdapter. */
export function resolveAdapterOption(raw: MjsWsAdapterConfig | MjsWsAdapter | undefined, onLog: MjsWsLogFn): MjsWsAdapter | undefined {
  if (!raw) return undefined
  if (isAdapterInstance(raw)) return raw
  if (!raw.redis) throw new Error(t('ws.index.adapter-redis-manquant'))
  return new RedisAdapter({ url: raw.redis, prefix: raw.prefix, onLog })
}

/**
 * Résout la cadence d'anti-entropie de présence — `top` (racine `opts.antiEntropy`) PRIME s'il
 * est défini ; sinon repli sur `opts.adapter.antiEntropy` (forme déclarative `{redis,...}`
 * SEULEMENT — une instance déjà construite n'a pas ce champ) ; sinon défaut
 * DEFAULT_ANTI_ENTROPY. `false` (l'une ou l'autre source) = désactivée.
 */
export function resolveAntiEntropyOption(top: number | false | undefined, adapterRaw: MjsWsAdapterConfig | MjsWsAdapter | undefined): number | false {
  if (top !== undefined) return top
  if (adapterRaw && !isAdapterInstance(adapterRaw) && adapterRaw.antiEntropy !== undefined) return adapterRaw.antiEntropy
  return DEFAULT_ANTI_ENTROPY
}

// exportées — réutilisées par cli/ws.ts (bannière : heartbeat/limites EFFECTIFS
// résolus AVANT l'appel à mjsWs(), source UNIQUE, jamais recopiées en dur)
export const DEFAULT_HEARTBEAT = 15000
// maxConnections: null (illimité, opt-in strict) / maxConnectionsPerIp: 100 (CHANGEMENT DE
// COMPORTEMENT ASSUMÉ : cf. le commentaire de
// MjsWsLimits.maxConnectionsPerIp, core.ts, pour le détail du pourquoi 100 par défaut) /
// maxRoomsPerClient: 50 (CHANGEMENT DE COMPORTEMENT ASSUMÉ
// lui aussi, généreux : cf. le commentaire de MjsWsLimits.maxRoomsPerClient, core.ts).
export const DEFAULT_LIMITS: MjsWsLimits = { rate: 40, burst: 80, kickAfter: 50, maxPayload: 65536, maxBuffered: 1048576, maxConnections: null, maxConnectionsPerIp: 100, maxRoomsPerClient: 50 }
// suivi d'expiration + rafraîchissement du jeton — MÊME patron que DEFAULT_LIMITS
// ci-dessus (réutilisable par cli/ws.ts pour une bannière future, source unique)
export const DEFAULT_TOKEN: MjsWsTokenOptions = { sweep: 10000, slack: 5000 }
// anti-entropie de présence — MÊME patron que DEFAULT_HEARTBEAT/DEFAULT_TOKEN (source unique,
// cf. resolveAntiEntropyOption, rooms.ts attachPresenceAntiEntropy)
export const DEFAULT_ANTI_ENTROPY = 15000

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[MJS-WS] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

/**
 * Résout `opts.transport` vers une instance MjsWsTransport. Chaîne `'ws'`/absente → WsTransport
 * (défaut, bibliothèque `ws`) ; `'uws'` → UwsTransport (uWebSockets.js, paquet natif à installer
 * à part — cf. transport-uws.ts, aucune dépendance ajoutée ici) ; toute AUTRE chaîne = faute de
 * frappe, erreur claire immédiate (sinon elle traverserait telle quelle jusqu'à un crash confus
 * dès `app.listen()`, `transport.onConnection` n'étant pas une fonction sur une chaîne) ; un objet
 * (déjà `MjsWsTransport` — MemoryTransport en test, ou un transport maison) est utilisé tel quel.
 * `limits` déjà résolue (défauts appliqués) — nécessaire pour câbler `maxPayload` côté 'ws' ET 'uws'
 * (les DEUX transports réels acceptent ce réglage nativement, cf. transport-ws.ts/transport-uws.ts ;
 * sans lui, `ws` retomberait sur son propre défaut de 100 Mo — bien au-delà de `limits.maxPayload`).
 */
export function resolveTransport(raw: MjsWsOptions['transport'], port: number | undefined, host: string | undefined, limits: MjsWsLimits): MjsWsTransport {
  if (raw === undefined || raw === 'ws') return new WsTransport({ port, host, maxPayload: limits.maxPayload })
  if (raw === 'uws') return new UwsTransport({ port, host, maxPayload: limits.maxPayload })
  if (typeof raw === 'string') throw new Error(t('ws.index.transport-invalide', { raw }))
  return raw
}

/**
 * Résout `opts.sessionExclusive` (2 modes) — absent/`false` = désactivé
 * (défaut) ; `true` ≡ `'replace'` (comportement historique : le hello frais éjecte l'ancienne
 * connexion) ; `'refuse'` inverse (l'existant gagne, le hello frais est refusé) ; toute AUTRE
 * valeur = faute de frappe, erreur claire immédiate (MÊME esprit que resolveTransport ci-dessus —
 * sinon elle traverserait telle quelle jusqu'à un `if` qui ne la reconnaît jamais, cf.
 * core.ts::handleHello). Cf. docs/23-mjs-ws.md §8.5.
 */
export function resolveSessionExclusiveOption(raw: MjsWsOptions['sessionExclusive']): false | 'replace' | 'refuse' {
  if (raw === undefined || raw === false) return false
  if (raw === true) return 'replace'
  if (raw === 'replace' || raw === 'refuse') return raw
  throw new Error(t('ws.index.session-exclusive-invalide', { raw: JSON.stringify(raw) }))
}

/**
 * Résout `opts.verifyOrigin` — absent/`undefined` = `null` (désactivé,
 * défaut, aucune connexion refusée pour son origine). Forme TABLEAU : compilée UNE SEULE fois en
 * Set minuscule (comparaison insensible à la casse), jamais recompilée par connexion — prédicat
 * retourné refuse l'Origin absent ou non listé. Forme FONCTION : passée telle quelle, contrôle
 * total. Cf. docs/23-mjs-ws.md « Vérification d'origine ».
 */
export function resolveVerifyOriginOption(raw: MjsWsOptions['verifyOrigin']): ((origin: string | undefined, remote: MjsWsRemoteInfo) => boolean) | null {
  if (raw === undefined) return null
  if (typeof raw === 'function') return raw
  const allowlist = new Set(raw.map(o => o.toLowerCase()))
  return (origin) => origin !== undefined && allowlist.has(origin.toLowerCase())
}

/** Crée un serveur MJS-WS — cf. docs/23-mjs-ws.md. Rien ne démarre avant `.listen()`. */
export function mjsWs(userOpts: MjsWsOptions = {}): MjsWsApp {
  // résolue AVANT le transport (pas juste dans `resolved` ci-dessous) : la chaîne 'uws' a besoin
  // de limits.maxPayload DÉJÀ résolue (défauts appliqués) pour construire UwsTransport — un seul
  // calcul, réutilisé aux deux endroits (jamais recalculé, jamais désynchronisé).
  const limits: MjsWsLimits = { ...DEFAULT_LIMITS, ...(userOpts.limits ?? {}) }
  const transport = resolveTransport(userOpts.transport, userOpts.port, userOpts.host, limits)
  // adaptateur résolu ICI (pas inline dans `resolved` ci-dessous) : la MÊME instance sert deux
  // champs de `resolved` — `adapter` (core.ts, cluster) ET `rooms._cluster.adapter` (anti-
  // entropie, cf. rooms.ts attachPresenceAntiEntropy) — jamais deux résolutions séparées.
  const adapter       = resolveAdapterOption(userOpts.adapter, userOpts.onLog ?? defaultLog)
  const antiEntropyMs = resolveAntiEntropyOption(userOpts.antiEntropy, userOpts.adapter)
  const resolved: MjsWsResolvedOptions = {
    auth:         userOpts.auth,
    welcome:      userOpts.welcome,
    parse:        userOpts.parse ?? ((s: string) => JSON.parse(s)),
    serialize:    userOpts.serialize ?? ((o: unknown) => JSON.stringify(o)),
    heartbeat:    userOpts.heartbeat ?? DEFAULT_HEARTBEAT,
    limits,
    // suivi d'expiration + rafraîchissement du jeton — TOUJOURS résolu (comme
    // limits ci-dessus) ; l'armement RÉEL du balayage reste data-driven (cf. core.ts)
    token:        { ...DEFAULT_TOKEN, ...(userOpts.token ?? {}) },
    // anti-entropie de présence (cf. rooms.ts MjsWsRoomsClusterOptions/attachPresenceAntiEntropy,
    // adapter.ts) — posée ICI, jamais dans core.ts : `_cluster`
    // absent si aucun adaptateur (ZÉRO changement de comportement, même principe que le reste
    // du clustering, opt-in via `adapter`).
    rooms: { ...(userOpts.rooms ?? {}), ...(adapter ? { _cluster: { adapter, antiEntropyMs } } : {}) },
    guardProcess: userOpts.guardProcess ?? false,
    onLog:        userOpts.onLog ?? defaultLog,
    // résolu ICI (synchrone, avant tout .listen()) — secret manquant/vide lève tout de
    // suite, en français, plutôt que d'attendre un démarrage à moitié fait (cf. bridge.ts)
    bridge: userOpts.bridge ? resolveBridgeOptions(userOpts.bridge, userOpts.port ?? 8080) : undefined,
    // reprise de session — absent/false = undefined : core.ts ne crée alors AUCUN moteur
    resume: resolveResumeOptions(userOpts.resume),
    // session exclusive par identité (2 modes) — TOUJOURS résolu (comme
    // stats ci-dessus), défaut false : opt-in strict, aucun changement de comportement tant que
    // non posé. `true` ≡ 'replace' (comportement historique), cf. resolveSessionExclusiveOption.
    sessionExclusive: resolveSessionExclusiveOption(userOpts.sessionExclusive),
    // déconnexion définitive (cf. son commentaire dans MjsWsOptions ci-dessus) — transmise telle
    // quelle, résolue ICI comme le reste (jamais consultée avant ce point du boot)
    onDisconnect: userOpts.onDisconnect,
    // adaptateur multi-processus — MÊME instance que rooms._cluster.adapter ci-dessus
    // (résolue une seule fois, tout en haut de cette fonction)
    adapter,
    // état/métriques — le registre lui-même tourne TOUJOURS (créé par createCore) ;
    // cette valeur ne gouverne que l'exposition HTTP (GET /stats, /metrics, /state sur le pont)
    stats: userOpts.stats ?? false,
    // µschema — TOUJOURS résolu (comme limits/token ci-dessus) : codec 'auto' +
    // registre VIDE si `codec`/`schemas` absents des deux, la voie JSON reste alors
    // byte-identique (cf. schema.ts::resolveSchemaOptions, tests/mjs-ws-schema.test.ts)
    schema: resolveSchemaOptions({ codec: userOpts.codec, schemas: userOpts.schemas }),
    // vérification d'origine — TOUJOURS résolu (comme sessionExclusive
    // ci-dessus), `null` = jamais appelé par acceptConnection, opt-in strict.
    verifyOrigin: resolveVerifyOriginOption(userOpts.verifyOrigin),
  }
  return createCore(transport, resolved)
}
