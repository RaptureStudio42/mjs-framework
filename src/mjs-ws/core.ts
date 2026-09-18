// mjs-ws/core — « le standardiste » : moteur du protocole µ: (contrat exact :
// runtime/mjs_socket.ts, le CLIENT). États par connexion : attente-hello →
// authentifiée → fermée. Routage des trames de contrôle, requêtes {t,p,id} →
// µ:ack, pub/sub {t,p}, registre des clients authentifiés. Les protections
// (débit, contre-pression, watchdog, anti-crash) viennent de guard.ts — ce
// fichier les BRANCHE mais n'en réimplémente aucune.
//
// Salons/présence (µ:join/µ:leave/µ:sub-presence) et flux (µ:sub-stream/
// µ:resync) suivent le MÊME principe : moteurs autonomes (rooms.ts/streams.ts),
// ce fichier les BRANCHE au routage des trames et au cycle de vie de la
// connexion (onWelcome juste après le µ:welcome, onDisconnect dans
// cleanupClient) sans réimplémenter leur logique.

import { Buffer } from 'node:buffer'
import type { MjsWsConnection, MjsWsRemoteInfo, MjsWsTransport } from './transport.js'
import { MAX_CONSECUTIVE_DROPS, RATE_ERROR_THROTTLE_MS, TokenBucket, Watchdog, errMessage, isBackpressured } from './guard.js'
import { createRoomsEngine, peerIdOf, idsOfClient } from './rooms.js'
import type { MjsWsRoomHandle, MjsWsRoomsEngineOptions, MjsWsRoomsOptions } from './rooms.js'
import { createStreamsEngine } from './streams.js'
import type { MjsWsStreamHandle, MjsWsStreamOptions, MjsWsStreamsCluster } from './streams.js'
import { createBridge, resolveClients } from './bridge.js'
import type { MjsWsBridgeEngine, MjsWsResolvedBridgeOptions } from './bridge.js'
// proxy de décisions (proxy.ts) — auth ET join (rooms.ts) résolus ICI, UNE SEULE FOIS
// (cf. leurs commentaires respectifs) : objet {url,secret,...} → fonction compatible via
// creerAuthProxy/creerJoinProxy, fonction historique → passthrough tel quel. proxy.ts dépend de
// bridge.ts (signCanonical/canonicalString) : core.ts reste le SEUL point qui importe proxy.ts EN
// VALEUR dans ce module (rooms.ts ne le peut pas, cf. son commentaire — graphe de modules).
import { creerAuthProxy, creerJoinProxy } from './proxy.js'
import type { MjsWsProxyOptions } from './proxy.js'
import { createSessionsEngine, identityIdOf } from './sessions.js'
import type { MjsWsResolvedResume } from './sessions.js'
// adaptateur multi-processus — cf. adapter.ts pour la façade, adapter-redis.ts pour
// l'implémentation Redis ; core.ts ne connaît QUE l'interface MjsWsAdapter (jamais Redis direct)
import type { MjsWsAdapter } from './adapter.js'
// état/métriques — cf. stats.ts : registre TOUJOURS actif, créé ICI, passé en écriture
// aux moteurs qui en ont besoin (streams.ts/sessions.ts/bridge.ts) ; rooms.ts n'en a pas besoin
// (gauges lues en direct, cf. son statsSnapshot()). app.stats()/bridge.ts assemblent l'instantané.
import { createStatsRegistry } from './stats.js'
import type { MjsWsGuardCause, MjsWsStatsRegistry, MjsWsStatsSnapshot } from './stats.js'
// µschema — cf. mjs-ws/schema.ts pour le moteur (BRANCHÉ ici, jamais réimplémenté) ;
// src/schema/core.ts pour le registre pur (defSchema/encode/decode/hash, zéro API node/navigateur)
import { createSchemaEngine } from './schema.js'
import type { MjsWsResolvedSchema, MjsWsSchemaEngine } from './schema.js'
import type { MjschemaFields } from '../schema/core.js'
// paquets activables (packages.ts) — TYPE SEUL : packages.ts importe le type
// MjsWsApp d'ICI en retour (cf. son commentaire de tête) — type-only DES DEUX CÔTÉS, effacé à la
// compilation, ZÉRO cycle runtime (aucun des deux fichiers n'importe l'autre en VALEUR). Seul
// `app.use` (plus bas) s'en sert, pour typer `pkg`.
import type { MjsPackage } from './packages.js'
// chien de garde systemd (étage 1 de la supervision) — cf. watchdog.ts : le battement
// vit dans la boucle d'événements, il s'arrête donc AVEC elle. Aucun effet hors systemd.
import { armWatchdog } from './watchdog.js'
import type { MjsWsWatchdogHandle } from './watchdog.js'
import { t } from '../messages/index.js'

// --- charge du handshake µ:hello -------------------------------------------

export interface MjsWsHelloPayload {
  auth?: unknown
  // OBLIGATOIRE côté fil (docs/25-protocole-mjs-ws.md:53, absence → µ:denied AVANT
  // même opts.auth) : handleHello le garantit valant 1 avant que ce type ne soit lu par
  // authFn/proxy.ts — aucun appelant légitime n'en construit un littéral sans lui
  protocol: number
  resub?: string[]
  rooms?: string[]
  /** reprise de session (sessions.ts) — le {id, key} du dernier µ:welcome, rejoué par le client */
  session?: { id: string; key: string }
  /**
   * µschema — hash du registre CLIENT (miroir local, ou reçu d'un µ:schema
   * précédent). Absent = client sans registre (pas encore branché, ou aucun schéma côté
   * appli) : jamais de µ:schema poussé dans ce cas. Différent du hash SERVEUR (porté par CHAQUE
   * µ:welcome dès qu'un registre existe, cf. handleHello) → le serveur pousse µ:schema
   * immédiatement après, cf. mjs-ws/schema.ts::definitions()/hash().
   */
  schemaHash?: string
}

// --- limites (déjà résolues avec défauts par index.ts) ---------------------

export interface MjsWsLimits {
  rate: number
  burst: number
  kickAfter: number
  maxPayload: number
  maxBuffered: number
  /**
   * Plafond GLOBAL de connexions simultanées (le noyau
   * WS n'avait AUCUN plafond, ni global ni par IP). `null` (défaut) = illimité, opt-in strict :
   * ZÉRO changement de comportement tant que cette clé n'est pas posée explicitement. Au-delà,
   * une connexion ENTRANTE est refusée avant même la création d'un MjsWsClientImpl (fermeture
   * immédiate, code 1013 « réessayez plus tard », cf. core.ts::acceptConnection).
   */
  maxConnections: number | null
  /**
   * Plafond de connexions simultanées PAR IP — défaut **100**
   * (CHANGEMENT DE COMPORTEMENT ASSUMÉ, cf. index.ts DEFAULT_LIMITS) : généreux pour tout usage
   * légitime, borne le flood de reconnexion d'une même IP (un client kické qui rouvrait un socket
   * contournait sinon TOUT guard.ts — le TokenBucket repart à zéro à chaque connexion). `null` =
   * illimité. Une IP inconnue (transport qui n'expose pas `remoteInfo.address`, ex.
   * MemoryTransport) N'est JAMAIS comptée ni limitée par CE plafond (seul le plafond global peut
   * encore s'appliquer) — cf. transport.ts::MjsWsRemoteInfo.address.
   */
  maxConnectionsPerIp: number | null
  /**
   * Plafond de salons qu'un MÊME client peut avoir rejoints simultanément (sans lui, un client
   * authentifié pouvait rejoindre un nombre ILLIMITÉ de salons
   * à noms arbitraires : `clientRooms` (rooms.ts) grossit sans borne, tenue jusqu'à déconnexion —
   * fuite mémoire, EXPOSÉE PAR DÉFAUT tant qu'aucune garde `rooms.join` n'est configurée (défaut
   * historique : tout accepté). Défaut **50** (CHANGEMENT DE COMPORTEMENT ASSUMÉ, cf. index.ts
   * DEFAULT_LIMITS) : généreux pour tout usage légitime. `null` = illimité (opt-in explicite).
   * Vérifié par rooms.ts::handleJoin, AVANT même la garde `join` (potentiellement async) — cf. son
   * commentaire pour le détail. Transmis à createRoomsEngine via roomsEngineOpts.maxRoomsPerClient
   * (cf. plus bas) — PAS via `opts.rooms` (c'est un nombre, jamais une fonction).
   */
  maxRoomsPerClient: number | null
}

/** options résolues du suivi d'expiration + rafraîchissement du jeton — TOUJOURS
 *  présentes (comme MjsWsLimits ci-dessus), mais le balayage périodique reste lui-même
 *  data-driven : il ne s'arme QUE si au moins un client authentifié expose une échéance `exp`
 *  (cf. ensureTokenSweep/handleHello dans createCore) — opt-in strict, zéro timer sinon. */
export interface MjsWsTokenOptions {
  /** période du balayage global, ms */
  sweep: number
  /** tolérance d'horloge avant fermeture (jeton expiré depuis MOINS que ça = pas encore fermé), ms */
  slack: number
}

export type MjsWsLogLevel = 'debug' | 'info' | 'warn' | 'error'
export type MjsWsLogFn = (level: MjsWsLogLevel, message: string, meta?: unknown) => void

/** signature historique de opts.auth — cf. MjsWsResolvedOptions.auth ci-dessous (widen
 *  en union avec MjsWsProxyOptions, ce alias reste la forme RÉSOLUE que createCore appelle réellement). */
export type MjsWsAuthFn = (hello: MjsWsHelloPayload, meta: MjsWsRemoteInfo) => unknown | Promise<unknown>

/**
 * Fuite d'erreur à un client NON authentifié — un opts.auth FONCTION
 * BRUTE peut throw pour deux raisons bien distinctes : un refus MÉTIER voulu (« mot de passe
 * incorrect », message légitimement destiné au client) ou un bug/panne INTERNE (DB en rade, bug
 * de code — jamais destiné au client, cf. handleHello/catch). Le langage ne distingue pas les
 * deux À LA FORME (un throw quelconque dans les deux cas) : cette classe est le marqueur EXPLICITE
 * du premier cas — `throw new MjsWsAuthDenied('mot de passe incorrect')` pour un refus dont le
 * message doit atteindre le client tel quel ; tout le reste (Error nue, throw d'une chaîne, etc.)
 * est traité comme interne et SANITISÉ (message générique au client, détail loggé côté serveur).
 * Le proxy de décisions (creerAuthProxy, proxy.ts) reste transmis tel quel SANS passer par cette
 * classe — son throw est déjà sûr par construction (cf. authIsProxy plus bas).
 */
export class MjsWsAuthDenied extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MjsWsAuthDenied'
  }
}

/** Options déjà normalisées (défauts appliqués) — cf. index.ts pour la surface publique avec défauts. */
export interface MjsWsResolvedOptions {
  /** Fonction historique OU objet-proxy `{url, secret, timeout?, cache?}` (proxy.ts)
   *  délégant la décision à un back HTTP signé — cf. docs/23-mjs-ws.md « Proxy de décisions ».
   *  Résolu en fonction UNE FOIS par createCore (`authFn`), jamais réévalué à chaque hello. */
  auth?: MjsWsAuthFn | MjsWsProxyOptions
  welcome?: (client: MjsWsClient) => unknown | Promise<unknown>
  parse: (data: string) => any
  serialize: (obj: unknown) => string
  heartbeat: number
  limits: MjsWsLimits
  /** suivi d'expiration + rafraîchissement du jeton — cf. MjsWsTokenOptions */
  token: MjsWsTokenOptions
  rooms: MjsWsRoomsOptions
  guardProcess: boolean
  onLog: MjsWsLogFn
  /** pont universel (bridge.ts) — absent = désactivé, déjà résolu par index.ts (secret lu, défauts port/host appliqués) */
  bridge?: MjsWsResolvedBridgeOptions
  /** reprise de session (sessions.ts) — absent = comportement historique STRICT (aucun octet de différence, aucun timer), déjà résolu par index.ts */
  resume?: MjsWsResolvedResume
  /** déconnexion définitive (cf. MjsWsOptions, index.ts) — appelée depuis finalizeCleanup UNIQUEMENT, jamais pour un client jamais authentifié ni pour un parcage encore en grâce */
  onDisconnect?: (client: MjsWsClient, reason?: string) => void
  /** adaptateur multi-processus (adapter.ts) — absent = mono-process, déjà résolu par index.ts (instance concrète, Memory OU Redis) */
  adapter?: MjsWsAdapter
  /** état/métriques (stats.ts) — active GET /stats, /metrics, /state sur le pont (opts.bridge requis pour les servir en HTTP). Le registre lui-même (app.stats()) tourne TOUJOURS, quelle que soit cette valeur. */
  stats: boolean
  /**
   * session exclusive par identité — défaut `false` (opt-in strict,
   * comme `stats` ci-dessus), DEUX modes opt-in. `'replace'` (≡ `true` côté options publiques,
   * cf. index.ts) : un hello FRAIS d'une identité déjà connue (`identity.id`, cf.
   * identityIdOf/sessions.ts) éjecte toute AUTRE connexion — vivante ou parquée — de cette MÊME
   * identité (µ:bye {reason:'replace'} + close 4003, jamais parquée/reprise). `'refuse'`
   * (inverse) : un hello FRAIS est REFUSÉ (µ:denied + close 4004) s'il existe déjà une connexion
   * VIVANTE de cette MÊME identité — l'EXISTANT gagne ; les sessions PARQUÉES seules sont purgées
   * (MÊME evictIdentity que 'replace', pour rester reprenables proprement). Propagé à travers
   * plusieurs process (adaptateur, cf. createClusterEngine) — exclusivité PAR PROCESS seulement en
   * mode 'refuse' (best effort global, `clientsByIdentity` est LOCAL). Identité anonyme (sans
   * `id`) → jamais concernée, quel que soit le mode. Cf. docs/23-mjs-ws.md §8.5.
   */
  sessionExclusive: false | 'replace' | 'refuse'
  /**
   * µschema (mjs-ws/schema.ts) — TOUJOURS résolu (comme `limits`/`token` ci-dessus) :
   * `codec` défaut 'auto', `registre` VIDE si aucun `opts.schemas`/`app.schema()` — la voie JSON
   * existante reste alors byte-identique (aucune branche de sendRaw/handleRaw ne s'active jamais
   * pour un registre vide, cf. tests/mjs-ws-schema.test.ts « non-régression »).
   */
  schema: MjsWsResolvedSchema
  /**
   * vérification d'origine — `null` (défaut) = comportement historique
   * STRICT, aucune connexion refusée pour son origine. Posé = prédicat UNIQUE `(origin, remote)
   * => boolean` appelé à l'admission (cf. core.ts::acceptConnection/refuseForOrigin) — la forme
   * tableau publique (index.ts) est déjà compilée en Set minuscule à la résolution, jamais
   * recompilée par connexion. Cf. docs/23-mjs-ws.md « Vérification d'origine ».
   */
  verifyOrigin: ((origin: string | undefined, remote: MjsWsRemoteInfo) => boolean) | null
}

// --- client exposé à l'application -------------------------------------------

export interface MjsWsClient {
  readonly id: string
  readonly identity: unknown
  readonly latency: number | null
  readonly meta: MjsWsRemoteInfo
  send(type: string, p?: unknown): void
  close(reason?: string): void
}

export interface MjsWsBroadcastOpts {
  except?: MjsWsClient | MjsWsClient[]
}

export interface MjsWsApp {
  serve(type: string, handler: (p: any, client: MjsWsClient) => unknown): void
  on(type: string, handler: (p: any, client: MjsWsClient) => unknown): void
  /**
   * paquets activables (cf. packages.ts) — installe un paquet : enregistre ses
   * handlers/conventions sur CETTE app (`pkg.installer(app)`, SYNCHRONE — cf. MjsPackage).
   * Chaînable (`app.use(a).use(b)`, retourne toujours `app`). Double installation du MÊME
   * `pkg.nom` = `log('warn', …)`, IGNORÉE (jamais réinstallée, jamais un throw) — cf. createCore
   * pour le registre des noms déjà installés. Un `installer` qui LÈVE : `pkg.nom`
   * n'est PAS inscrit (retry du même nom possible ensuite, ex. paquet corrigé), l'erreur remonte
   * telle quelle à l'appelant (log cataloguée + rethrow). Exemple de référence : packages.ts::paquetEcho.
   */
  use(pkg: MjsPackage): MjsWsApp
  /** `false` UNIQUEMENT si la charge n'a pas pu être sérialisée — cf. core.ts::sendRaw. */
  send(client: MjsWsClient, type: string, p?: unknown): boolean
  /**
   * Envoie à TOUTES les connexions d'un même utilisateur (`identity.id`,
   * repli id de connexion — même résolution que `peerIdOf`), pas seulement une. Symétrique du
   * pont universel (bridge.ts, `POST /send { user }`), qui offrait déjà cette portée SANS
   * équivalent programmatique côté code serveur : `send()` reste sciemment local à UNE connexion
   * qu'on a déjà en main (cf. son commentaire dans bridge.ts) ; `sendUser` résout l'id lui-même,
   * localement ET à travers le cluster (adaptateur) si actif — MÊME propagation que
   * le pont, un seul chemin de résolution (peerIdOf), jamais deux implémentations qui divergent.
   * `false` UNIQUEMENT si la charge n'a pas pu être sérialisée.
   */
  sendUser(id: string, type: string, p?: unknown): boolean
  /** `false` UNIQUEMENT si la charge n'a pas pu être sérialisée — cf. core.ts::preEncodeFrame. */
  broadcast(type: string, p?: unknown, opts?: MjsWsBroadcastOpts): boolean
  /**
   * SUCRE — diffuse à UN SALON via le préfixe manuel documenté (docs/23-mjs-ws.md §4) : équivaut à
   * `room(salon).send(salon + '/' + type, p)`. Pas d'option `except` ICI (contrairement à
   * `room(x).send`) ni d'accès `.size`/`.kick` ensuite — pour ça, garder l'appel explicite
   * `app.room(salon)`. Délègue à `room()` ci-dessous : hérite donc de la même validation µschema
   * et de la même publication cluster, jamais une 2e implémentation qui diverge.
   */
  sendTo(room: string, type: string, p?: unknown): void
  error(client: MjsWsClient, message: string): void
  /** salon nommé — adhésion, diffusion, présence agrégée, kick (cf. rooms.ts) */
  room(name: string): MjsWsRoomHandle
  /** flux à journal borné — état courant + deltas numérotés + resync (cf. streams.ts) */
  stream(name: string, opts?: MjsWsStreamOptions): MjsWsStreamHandle
  readonly clients: Iterable<MjsWsClient>
  listen(): Promise<void>
  stop(): Promise<void>
  /** état/métriques (stats.ts) — instantané JSON, TOUJOURS disponible (indépendant de opts.stats, qui ne gouverne que l'exposition HTTP via le pont). Cf. docs/23-mjs-ws.md « L'état du serveur ». */
  stats(): MjsWsStatsSnapshot
  /**
   * µschema — déclare (ou ré-affirme à l'identique, no-op) un schéma binaire nommé.
   * `champs` = objet ORDONNÉ { nom: type, ... } (cf. src/schema/core.ts pour les types et `list`/
   * `bits`). Garde AJOUT-SEUL : re-déclarer `nom` avec une forme DIFFÉRENTE (champ/type/ordre) jette
   * clair — un schéma existant est IMMUABLE. Cf. docs/23-mjs-ws.md « µschema » pour le guide complet.
   */
  schema(nom: string, champs: MjschemaFields): void
}

// ----------------------------------------------------------------------------

let _idCounter = 0

class MjsWsClientImpl implements MjsWsClient {
  readonly id: string
  identity: unknown = undefined
  latency: number | null = null
  readonly meta: MjsWsRemoteInfo
  conn: MjsWsConnection   // MUTABLE — la reprise de session échange la connexion morte contre la neuve (resumeClient)
  readonly bucket: TokenBucket
  readonly watchdog: Watchdog
  // plafond de connexions (cf. acceptConnection/releaseConnectionSlot) —
  // `connSlotHeld` : vrai tant que ce client compte encore dans liveConnections/connectionsByIp
  // (décrémenté UNE fois, choke point cleanupClient). `connSlotIp` : IP au moment de l'ADMISSION —
  // PAS `this.meta.address` (figé à l'identité logique du client, jamais réassigné à une reprise,
  // cf. resumeClient) : la connexion PHYSIQUE peut changer d'IP entre deux reprises, le décrément
  // doit viser le compteur de l'IP réellement incrémentée, jamais l'ancienne.
  connSlotHeld = false
  connSlotIp: string | undefined = undefined

  // Course d'état à la fermeture refusée — 'closing' : décision de
  // fermeture déjà prise SYNCHRONEMENT (sendDeniedAndClose/kickClient/dismissClient, cf. leurs
  // commentaires) mais fermeture PHYSIQUE pas encore confirmée (onClose du transport, async) —
  // UNIQUEMENT depuis 'hello' (jamais depuis 'authenticated' : préserve l'éligibilité au parcage
  // de session + wasAuthenticated, cf. cleanupClient/finalizeCleanup, tous deux inchangés). La
  // FIFO (handleRaw/handleBinaryRaw) ignore tout message d'un client 'closing' au même titre que
  // 'closed' — un 2e µ:hello pipeliné après un refus n'est donc plus jamais routé.
  state: 'hello' | 'authenticated' | 'closing' | 'closed' = 'hello'
  parked    = false   // reprise : coupé mais en grâce — sendRaw tamponne au lieu d'envoyer, salons/présence conservés
  dismissed = false   // µ:bye envoyé (stop()/close()) : fin DÉFINITIVE — jamais parqué, session détruite
  // suivi d'expiration du jeton (cf. expireClientToken) : fermé par le balayage
  // périodique, PAS par µ:bye (le client doit pouvoir reconnecter avec un jeton neuf) — cf.
  // cleanupClient, qui court-circuite le parcage pour cette raison dédiée (même esprit que dismissed)
  tokenExpired = false
  // garde anti-répétition de garde — posé dès la 1re décision de
  // fermeture protectrice (kick ou expiration de jeton) sur ce client : la fermeture PHYSIQUE
  // (conn.close) est TOUJOURS asynchrone, une 2e/3e décision peut retomber sur le MÊME client
  // avant que la 1re n'ait abouti (state reste 'authenticated', cf. state ci-dessus) —
  // court-circuite toute garde ultérieure. Distinct de `state`/'closing' (réservé aux clients
  // encore 'hello') : un authentifié DOIT garder son state jusqu'à cleanupClient (éligibilité
  // au parcage). Réarmé à false par une reprise réussie (resumeClient) — connexion neuve.
  guardFired = false
  violations = 0
  invalidJsonCount = 0
  consecutiveDrops = 0
  // reprise en cours — vrai entre resumeClient() et l'envoi RÉEL du µ:welcome
  // (finishResume) : sendRaw/sendPre tamponnent ENCORE dans `resumeQueue`, MÊME si `parked` est
  // déjà retombé à false (connexion physique déjà vivante, cf. resumeClient) — dismissClient/
  // evictIdentity/sessionExclusive doivent continuer de voir cette connexion comme VIVANTE.
  resuming = false
  // file d'attente UNIQUE ordonnée pendant la reprise — MÊME référence que le
  // tableau `frames` de finishResume : tout ce qui arrive ici s'ajoute À LA SUITE des trames de
  // l'ANCIENNE grâce, jamais avant (plus d'inversion possible même sur une double coupure
  // pendant l'attente du welcome). `null` hors reprise.
  resumeQueue: Array<Record<string, unknown>> | null = null
  lastPingAt: number | null = null
  lastRateErrorAt: number | null = null
  // échéance du jeton — ms epoch, null = aucune échéance connue (jamais posée tant
  // que opts.auth ne renvoie pas de claim `exp` numérique) : c'est CE null qui garde le balayage
  // désarmé (opt-in strict, cf. ensureTokenSweep/sweepExpiredTokens)
  tokenExpiresAt: number | null = null
  chain: Promise<void> = Promise.resolve()   // FIFO — un message traité en entier avant le suivant (cf. piège #1 : rien entre auth et welcome)

  // rebranchés par acceptConnection() — a besoin du moteur (sendRaw/dismiss)
  send: (type: string, p?: unknown) => void = () => {}
  close: (reason?: string) => void = () => {}

  constructor(conn: MjsWsConnection, meta: MjsWsRemoteInfo, bucket: TokenBucket, watchdog: Watchdog) {
    this.id       = 'c' + (++_idCounter)
    this.conn     = conn
    this.meta     = meta
    this.bucket   = bucket
    this.watchdog = watchdog
  }
}

// échéance d'un résultat d'auth — `exp` numérique = convention JWT (secondes
// epoch, cf. token.ts signToken/verifyToken) : jwtAuth() la pose telle quelle sur l'identity
// qu'il retourne, mais TOUT opts.auth qui renvoie un `exp` numérique est suivi de la même façon
// (pas un couplage à jwtAuth spécifiquement). `null` = pas d'échéance connue (jamais suivi).
function tokenExpOf(identity: unknown): number | null {
  if (!identity || typeof identity !== 'object') return null
  const exp = (identity as Record<string, unknown>).exp
  return typeof exp === 'number' && isFinite(exp) ? exp * 1000 : null
}

// --- stop() attend les fermetures async ---------------------
// app.stop() dismiss chaque client puis coupe le transport, mais conn.close() (contrat
// MjsWsConnection, transport.ts) ne RETOURNE rien : le VRAI signal de fin (onClose, qui déclenche
// cleanupClient/finalizeCleanup — webhook 'disconnect', purge salons/flux, sessions) arrive sur un
// tick ULTÉRIEUR (microtask/IO réel du transport), jamais synchrone. SANS attente, stop() pouvait
// résoudre avant que ces nettoyages n'aient tourné. Timeout de sécurité : un onClose anormalement
// lent (bug d'intégration transport maison, réseau qui traîne) ne doit JAMAIS faire pendre stop().
// Exportée (comme RATE_ERROR_THROTTLE_MS, guard.ts) : la branche timeout se teste en isolation,
// avec un timeoutMs COURT injecté — jamais en attendant 2s réelles dans la suite, cf. mjs-ws-core.test.ts.
export const STOP_CLOSE_TIMEOUT_MS = 2000

/** résout dès que TOUTES les `promises` sont tenues, sinon au bout de `timeoutMs` — jamais les
 *  deux (le timer est TOUJOURS nettoyé, aucun handle actif ne survit à cette fonction). Tableau
 *  vide → résout immédiatement (rien à attendre, cf. stop() sans client connecté). */
export async function awaitBounded(promises: Array<Promise<void>>, timeoutMs: number): Promise<void> {
  if (promises.length === 0) return
  let timer: ReturnType<typeof setTimeout>
  const timeout = new Promise<void>(resolve => { timer = setTimeout(resolve, timeoutMs) })
  await Promise.race([Promise.all(promises), timeout])
  clearTimeout(timer!)
}

// compteurs LOCAUX optionnels d'un adaptateur (ignoresOrigin/reconnexions, cf.
// adapter-redis.ts RedisAdapter) — duck typing SOBRE (jamais un `instanceof RedisAdapter` en dur,
// hors du contrat MjsWsAdapter lui-même) : tout adaptateur qui expose ces deux getters NUMÉRIQUES
// les voit recopiés dans app.stats(), MemoryAdapter pourra les exposer un jour sans qu'aucune
// ligne ici ne change. Absent/non-numérique → 0, déjà la valeur par défaut du registre (stats.ts)
// — AUCUNE régression pour un adaptateur qui ne les expose pas (mono-process ou adaptateur maison).
function adapterLocalCounters(adapter: MjsWsAdapter | undefined): { ignoresOrigin: number; reconnexions: number } {
  const a = adapter as unknown as { ignoresOrigin?: unknown; reconnexions?: unknown } | undefined
  return {
    ignoresOrigin: typeof a?.ignoresOrigin === 'number' ? a.ignoresOrigin : 0,
    reconnexions:  typeof a?.reconnexions  === 'number' ? a.reconnexions  : 0,
  }
}

// fan-out à encodage unique (perf — cf. son commentaire dans createCore) —
// signature PARTAGÉE injectée dans createRoomsEngine/createStreamsEngine (rooms.ts/streams.ts,
// `fanSend?` optionnel, repli boucle rawSend si absent) : `skip` couvre `except` (room().send/
// broadcast) aussi bien qu'une absence de filtre (streams.ts, jamais d'except sur un flux).
export type MjsWsFanSend = (targets: Iterable<MjsWsClient>, frame: Record<string, unknown>, skip?: Set<MjsWsClient> | null) => void

export function createCore(transport: MjsWsTransport, opts: MjsWsResolvedOptions): MjsWsApp {
  const clientsById = new Map<string, MjsWsClientImpl>()
  // index par IDENTITÉ — clientsById ci-dessus n'indexe QUE par id de
  // CONNEXION ; sessionExclusive a besoin de retrouver TOUTES les connexions d'une MÊME identité
  // pour l'éjection (evictIdentity, plus bas). Maintenu à 2 choke points SEULEMENT : ajout en
  // hello FRAIS (handleHello, juste après client.identity=), retrait en finalizeCleanup (cf. son
  // commentaire) — RIEN à faire à la reprise (resumeClient) : `fresh` n'a jamais son identity
  // posée (retourne avant, cf. handleHello), jamais indexée ; `parked` y figure déjà depuis son
  // propre hello d'origine et n'en est JAMAIS retiré tant qu'il reste dans clientsById (un parcage
  // ne purge pas, cf. cleanupClient) — donc toujours présent, sans rien à transférer. Une entrée
  // peut donc contenir un client PARQUÉ (pas de connexion vivante) : evictIdentity le sait et
  // route via dismissClient, qui bascule déjà sur finalizeCleanup direct pour un parqué (cf. son
  // commentaire) — jamais un µ:bye/close sur une connexion qui n'existe plus.
  const clientsByIdentity = new Map<string, Set<MjsWsClientImpl>>()
  // plafond de connexions — compteurs LOCAUX (mono-process, comme
  // clientsById ci-dessus) : `liveConnections` pour le plafond GLOBAL (limits.maxConnections),
  // `connectionsByIp` pour le plafond PAR IP (limits.maxConnectionsPerIp). Tenus à jour EXCLUSIVEMENT
  // par acceptConnection (+1 admission)/releaseConnectionSlot (-1 nettoyage, cf. cleanupClient) —
  // jamais ailleurs. cf. le commentaire de MjsWsLimits.maxConnections/maxConnectionsPerIp.
  let liveConnections = 0
  const connectionsByIp = new Map<string, number>()
  const servers     = new Map<string, (p: any, client: MjsWsClient) => unknown>()
  const subscribers = new Map<string, Array<(p: any, client: MjsWsClient) => unknown>>()
  // paquets activables (packages.ts) — noms déjà installés via app.use (cf. son
  // commentaire dans le littéral `app` plus bas) : idempotence PAR NOM, jamais par référence
  // d'objet (deux instances distinctes du MÊME paquet, ex. deux `paquetEcho()`, comptent comme
  // une double installation).
  const installedPackages = new Set<string>()
  let uncaughtHandler: ((err: unknown) => void) | null  = null
  let unhandledHandler: ((reason: unknown) => void) | null = null
  let systemdWatchdog: MjsWsWatchdogHandle | null          = null
  // affecté APRÈS la façade `app` (bridge.ts a besoin de la référence) — capturé par
  // closure ici, donc déjà visible des accroches ci-dessous dès qu'il est posé
  let bridgeEngine: MjsWsBridgeEngine | null = null
  // adaptateur multi-processus — MÊME principe que bridgeEngine ci-dessus : posé
  // AVANT app.listen() (synchrone, cf. le bloc `if (opts.adapter)` plus bas), mais référencé
  // par closure dans les accroches roomsEngine/streamsEngine/app.broadcast/app.room ci-dessous
  // dès leur DÉCLARATION — la valeur n'est lue qu'à l'APPEL, jamais avant la fin du boot.
  let clusterEngine: MjsWsClusterEngine | null = null
  // suivi d'expiration du jeton — null tant qu'aucun client authentifié n'a jamais
  // exposé d'échéance (opt-in strict, cf. ensureTokenSweep plus bas) : AUCUN timer tant que cette
  // variable reste null, zéro octet de différence sur le chemin existant.
  let tokenSweepTimer: ReturnType<typeof setInterval> | null = null

  // rendez-vous de fermeture posés par stop() (cf. STOP_CLOSE_TIMEOUT_MS plus haut) —
  // un par client DISMISSED en cours de fermeture async, résolu depuis finalizeCleanup (CHOKE
  // POINT unique, cf. son commentaire) ; vide en dehors d'un stop() en cours (aucun coût sinon).
  const stopCloseWaiters = new Map<MjsWsClientImpl, () => void>()

  // état/métriques (stats.ts) — registre TOUJOURS actif (indépendant de opts.stats, qui
  // ne gouverne que l'exposition HTTP via le pont, cf. plus bas). `log` est le SEUL point de
  // passage de tous les niveaux — rooms/streams/sessions/bridge/cluster le reçoivent tous en
  // paramètre — donc compter erreurs/avertissements ICI couvre l'app entière sans autre accroche.
  const stats: MjsWsStatsRegistry = createStatsRegistry()
  const log: MjsWsLogFn = (level, message, meta) => {
    if (level === 'error') stats.erreurs.erreurs++
    else if (level === 'warn') stats.erreurs.avertissements++
    // filet — `log()` est appelé depuis des dizaines de sites, SYNCHRONES et dans des
    // chaînes `.catch(err => log(...))` (FIFO par connexion, cf. handleRaw/resumeClient) : un
    // onLog utilisateur qui THROW (bug de son intégration — Winston/Pino cassé, JSON.stringify
    // sur un meta cyclique, disque plein…) traverserait ce dernier `.catch` SANS être rattrapé
    // → rejet de promesse jamais géré → CRASH du process entier (comportement par défaut de
    // Node depuis la 15) pour un simple bug de LOGGING, hors de tout contrôle du protocole
    // lui-même. Un SEUL point de passage (ici) protège tous les appelants sans les changer.
    try { opts.onLog(level, message, meta) }
    catch { /* onLog cassé — jamais laisser un bug de journalisation faire tomber le serveur */ }
  }

  // garde-fou origine × cookie — `opts.auth` fourni SANS `verifyOrigin`
  // armé est le terrain du détournement CSWSH (patron cookie de docs/23-mjs-ws.md) : on ne peut
  // pas savoir ICI si `opts.auth` lit VRAIMENT `meta.headers.cookie` (fonction opaque, jamais
  // instrumentée), donc formulation plus large — « auth applicative sans contrôle d'origine ».
  // Émis UNE SEULE FOIS au démarrage, jamais par connexion (sinon déni de service par journal).
  if (opts.auth && !opts.verifyOrigin) log('warn', t('ws.core.origine-non-verifiee-avec-cookie'))

  // --- envoi bas niveau (contre-pression + sérialisation gardées) ----------
  // retour — `false` UNIQUEMENT si la charge n'a pas pu être SÉRIALISÉE (cf.
  // preEncodeFrame, même racine) : closed/resuming/parqué/contre-pression/échec de TRANSPORT
  // restent des issues silencieuses comme avant (`true`) — ce n'est PAS un accusé de livraison.
  function sendRaw(client: MjsWsClientImpl, obj: unknown): boolean {
    if (client.state === 'closed' || client.state === 'closing') return true   // 'closing' = décision de fermeture déjà prise, cf. state (MjsWsClientImpl)
    // reprise en cours — AVANT `parked` : une reconnexion en cours a déjà
    // `client.parked` à false (connexion physique vivante), mais rien ne doit se glisser
    // devant le µ:welcome de reprise (piège #1 du contrat, cf. finishResume). Bornée par
    // opts.resume.maxBuffered (même plafond que le tampon normal de sessions.ts) — au-delà,
    // silencieusement laissée de côté plutôt que de croître sans borne.
    if (client.resuming) {
      if (client.resumeQueue!.length < opts.resume!.maxBuffered) { stats.messages.tamponnes++; client.resumeQueue!.push(obj as Record<string, unknown>) }
      return true
    }
    // client parqué (reprise) : tamponné au lieu d'envoyé — exclusions et bornes
    // dans le moteur (sessions.ts). `parked` implique que sessionsEngine existe.
    if (client.parked) { stats.messages.tamponnes++; sessionsEngine!.buffer(client, obj as Record<string, unknown>); return true }
    if (isBackpressured(client.conn.bufferedAmount, opts.limits.maxBuffered)) {
      client.consecutiveDrops++
      stats.messages.rejetes++
      log('warn', t('ws.core.envoi-ignore-contre-pression', { clientId: client.id }), { bufferedAmount: client.conn.bufferedAmount })
      if (client.consecutiveDrops > MAX_CONSECUTIVE_DROPS) kickClient(client, 1008, t('ws.core.close-contre-pression-persistante'), 'engorgement')
      return true
    }
    client.consecutiveDrops = 0

    // µschema — SEUL choke point d'encodage (app.send/sendUser/broadcast/room().send
    // ET le rejeu de session ET la diffusion cluster locale passent TOUS par sendRaw, cf. rawSend
    // ci-dessus) : encode en binaire ssi `frame.t` a un schéma déclaré, codec ≠ 'json', et ce n'est
    // NI une trame de contrôle µ: (toujours JSON, cf. schema.ts) NI un delta de flux — `seq` est le
    // signal qui les distingue à coup sûr (streams.ts est le SEUL à poser `seq`, jamais schématisé,
    // cf. son commentaire dans schema.ts). Validation (throw si codec 'binary' strict SANS schéma)
    // déjà faite EN AMONT (schemaEngine.assertSendable, app.send/sendUser/broadcast/room().send
    // ci-dessous) — jamais ici : un rejeu de session ne doit JAMAIS re-lever pour une frame déjà
    // valide à son envoi d'origine (cf. commentaire de tête de schema.ts).
    const frame = obj as Record<string, unknown>
    const binaire = frame.seq == null && typeof frame.t === 'string' ? schemaEngine.encodeOutbound(frame.t, frame.p) : null
    if (binaire) {
      try { client.conn.send(binaire); stats.messages.envoyes++ }
      catch (err) { stats.messages.rejetes++; log('error', t('ws.core.echec-envoi-binaire'), { err }) }
      return true
    }

    let data: string
    // échec de SÉRIALISATION (charge trop imbriquée, RangeError JSON.stringify) :
    // avant, la trame disparaissait en silence (compteur muet) — log cataloguée AVEC le type de
    // message, `false` remonté à l'appelant (cf. app.send/preEncodeFrame, MÊME racine)
    try { data = opts.serialize(obj) }
    catch (err) { stats.messages.rejetes++; log('error', t('ws.core.echec-serialisation', { type: String(frame.t) }), { err }); return false }
    try { client.conn.send(data); stats.messages.envoyes++ }
    catch (err) { stats.messages.rejetes++; log('error', t('ws.core.echec-envoi'), { err }) }
    return true
  }

  // fan-out à encodage unique (perf, scénario « saturation fan-out » — 150 membres, payload
  // 1 Kio) — room().send()/app.broadcast()/app.sendUser()/les deltas de flux (streams.ts)
  // diffusent TOUS la MÊME trame à N destinataires, mais sendRaw ci-dessus ré-encode
  // (JSON.stringify OU µschema.encodeOutbound) ET réalloue un objet {t,p} littéral À CHAQUE
  // destinataire — plafond mesuré ~260 000 livraisons/s avant cette primitive, dominé par ce
  // travail strictement redondant (le résultat de l'encodage ne dépend jamais du destinataire,
  // seulement de la trame). preEncodeFrame le calcule UNE SEULE fois par diffusion ; sendPre
  // (sœur de sendRaw, MÊME contrat) l'applique ensuite par client SANS jamais ré-encoder ;
  // fanSend enchaîne les deux pour une cible entière (membres d'un salon, abonnés d'un flux…).

  /** résultat de preEncodeFrame — EXACTEMENT un des deux champs non-null (jamais les deux, jamais
   *  aucun : un échec de sérialisation renvoie `null` en amont, cf. preEncodeFrame lui-même). */
  type MjsWsPreEncoded = { bin: Uint8Array | null, txt: string | null }

  // MÊME condition binaire que sendRaw (frame.seq == null && typeof frame.t === 'string') : un
  // `null` ici a la MÊME cause qu'un sendRaw individuel en échec (échec de sérialisation), jamais
  // une 2e logique qui diverge. Compteur/log posés ICI (une fois par diffusion) plutôt que dans
  // chaque sendPre : un fan-out qui échoue à encoder échoue POUR TOUT LE MONDE EN UNE FOIS.
  // Changement de comportement ASSUMÉ, double : (1) avant, sendRaw comptait 1 échec par destinataire
  // (aucun test n'asserte ce compte) ; (2) un membre PARQUÉ ne tamponne plus une trame insérialisable
  // (avant, la garde parked de sendRaw passait AVANT l'encodage → l'échec ne surfaçait qu'au rejeu ;
  // issue finale identique dans les deux mondes : la trame malformée n'atteint jamais personne).
  function preEncodeFrame(frame: Record<string, unknown>): MjsWsPreEncoded | null {
    const binaire = frame.seq == null && typeof frame.t === 'string' ? schemaEngine.encodeOutbound(frame.t, frame.p) : null
    if (binaire) return { bin: binaire, txt: null }
    // MÊME correctif que sendRaw ci-dessus (racine commune) : log cataloguée
    // AVEC le type de message (une fois par diffusion, jamais par destinataire), `null` déjà
    // remonté à TOUS les appelants existants (broadcastLocal/sendUser/fanSend) — désormais
    // exploité par broadcastLocal/app.sendUser pour renvoyer un résultat d'échec (cf. plus bas).
    try { return { bin: null, txt: opts.serialize(frame) } }
    catch (err) { stats.messages.rejetes++; log('error', t('ws.core.echec-serialisation', { type: String(frame.t) }), { err }); return null }
  }

  // sœur de sendRaw — MÊMES gardes, MÊME ordre (closed/closing → resuming → parqué → contre-
  // pression/drops/kick → consecutiveDrops=0), mais reçoit un encodage DÉJÀ prêt (preEncodeFrame)
  // au lieu de le refaire. DUPLICATION ASSUMÉE (~15 lignes) plutôt qu'un sendRaw réécrit pour
  // hisser l'encodage en tête : sendRaw encode APRÈS ses gardes (closed/parqué/contre-pression
  // court-circuitent SANS jamais encoder) — inverser l'ordre gaspillerait un encodage à chaque
  // envoi UNITAIRE (app.send, µ:bye, rejeu de session…) vers un client déjà fermé/parqué, un coût
  // réel que ce bench ne mesure pas. Toute divergence future entre les deux (garde oubliée, compteur
  // différent) est un bug. Retour `void` (contrairement à sendRaw) : `pre` est DÉJÀ encodé avec
  // succès à ce stade (cf. son appelant, qui a déjà vérifié `!pre` avant de boucler) — aucun
  // nouvel échec de SÉRIALISATION possible ici, seulement du transport, hors du périmètre de ce correctif.
  function sendPre(client: MjsWsClientImpl, frame: Record<string, unknown>, pre: MjsWsPreEncoded): void {
    if (client.state === 'closed' || client.state === 'closing') return
    // reprise en cours — cf. sendRaw, MÊME garde/MÊME file unique ordonnée.
    if (client.resuming) {
      if (client.resumeQueue!.length < opts.resume!.maxBuffered) { stats.messages.tamponnes++; client.resumeQueue!.push(frame) }
      return
    }
    if (client.parked) { stats.messages.tamponnes++; sessionsEngine!.buffer(client, frame); return }
    if (isBackpressured(client.conn.bufferedAmount, opts.limits.maxBuffered)) {
      client.consecutiveDrops++
      stats.messages.rejetes++
      log('warn', t('ws.core.envoi-ignore-contre-pression', { clientId: client.id }), { bufferedAmount: client.conn.bufferedAmount })
      if (client.consecutiveDrops > MAX_CONSECUTIVE_DROPS) kickClient(client, 1008, t('ws.core.close-contre-pression-persistante'), 'engorgement')
      return
    }
    client.consecutiveDrops = 0

    try { client.conn.send(pre.bin ?? pre.txt!); stats.messages.envoyes++ }
    catch (err) { stats.messages.rejetes++; log('error', pre.bin ? t('ws.core.echec-envoi-binaire') : t('ws.core.echec-envoi'), { err }) }
  }

  // façade exportée (MjsWsFanSend, injectée dans createRoomsEngine/createStreamsEngine ci-dessous)
  // — preEncodeFrame UNE fois pour toute la cible, puis sendPre par membre : c'est CETTE fonction
  // qui relève ce plafond, quel que soit le nombre de membres/abonnés d'une diffusion.
  const fanSend: MjsWsFanSend = (targets, frame, skip) => {
    const pre = preEncodeFrame(frame)
    if (!pre) return
    for (const client of targets) {
      if (skip?.has(client)) continue
      sendPre(client as MjsWsClientImpl, frame, pre)
    }
  }

  // primitive brute partagée par rooms/streams — MÊME sendRaw (sérialisation, contre-
  // pression, kick sur drops persistants), juste élargie à MjsWsClient (façade publique) :
  // streams.ts en a besoin pour poser `seq` en frère de `p` (hors du contrat client.send()).
  const rawSend = (client: MjsWsClient, frame: Record<string, unknown>): void => { sendRaw(client as MjsWsClientImpl, frame) }

  // µschema — moteur autonome, MÊME principe que roomsEngine/streamsEngine juste en
  // dessous (branché ICI, jamais réimplémenté ailleurs) ; TOUJOURS créé (opts.schema TOUJOURS
  // résolu, cf. son commentaire dans MjsWsResolvedOptions/index.ts) — no-op de bout en bout tant
  // qu'aucun schéma n'est déclaré (registre vide), cf. tests/mjs-ws-schema.test.ts.
  const schemaEngine: MjsWsSchemaEngine = createSchemaEngine(opts.schema, rawSend, log, stats)

  // diffusion LOCALE SEULE (jamais de publication cluster) — utilisée par app.broadcast (après
  // avoir publié) ET par la réception d'un broadcast DISTANT (cluster engine) : cette
  // dernière ne doit JAMAIS repasser par app.broadcast (qui republierait → amplification en
  // boucle sur tout le cluster) — un seul endroit qui sait vraiment « livrer aux authentifiés
  // locaux », les deux call-sites s'y raccrochent. Retour — `false` ssi la
  // charge n'a pas pu être sérialisée (cf. preEncodeFrame) ; ignoré par le relais cluster
  // (aucun appelant HTTP à prévenir de ce côté), consommé par app.broadcast ci-dessous.
  function broadcastLocal(type: string, p: unknown, except: Set<MjsWsClient> | null): boolean {
    // gain de perf — UN SEUL encodage pour toute la diffusion (cf. preEncodeFrame/sendPre) au lieu d'un
    // JSON.stringify + une allocation {t,p} par client authentifié, cf. leur commentaire commun.
    const frame = { t: type, p }
    const pre = preEncodeFrame(frame)
    if (!pre) return false
    for (const client of clientsById.values()) {
      if (client.state !== 'authenticated') continue
      if (except && except.has(client)) continue
      sendPre(client, frame, pre)
    }
    return true
  }

  // proxy de décisions (proxy.ts) — opts.auth ET opts.rooms.join acceptent désormais
  // un objet-proxy {url,secret,...} EN PLUS de la fonction historique. Détection objet-vs-fonction
  // + résolution UNE SEULE FOIS ICI (jamais à chaque hello/join : le cache interne du proxy, cf.
  // proxy.ts, doit survivre aux reconnexions/rejoins, pas être reconstruit à chaque appel) — authFn
  // est ensuite ce que handleHello/handleRefresh appellent réellement (jamais opts.auth
  // directement) ; roomsEngineOpts.join est ce que createRoomsEngine reçoit (rooms.ts ne sait rien
  // de proxy.ts, cf. son commentaire — le graphe de modules l'interdit).
  const authFn: MjsWsAuthFn | undefined =
    typeof opts.auth === 'function' ? opts.auth : (opts.auth ? creerAuthProxy(opts.auth, log) : undefined)
  // fuite d'erreur — vrai UNIQUEMENT quand authFn est le proxy de
  // décisions (creerAuthProxy ci-dessus, TOUJOURS sûr : cf. le commentaire de tête de
  // MjsWsAuthDenied) — jamais un opts.auth FONCTION BRUTE. Consulté dans le catch de handleHello.
  const authIsProxy = !!opts.auth && typeof opts.auth !== 'function'
  const joinFn = typeof opts.rooms.join === 'function' ? opts.rooms.join : (opts.rooms.join ? creerJoinProxy(opts.rooms.join, log) : undefined)
  // plafond de salons par client — vient de `limits` (MjsWsLimits), PAS
  // de `opts.rooms` : même famille que maxConnections/maxConnectionsPerIp (un NOMBRE, jamais une
  // fonction), câblé ICI vers roomsEngineOpts, jamais consulté ailleurs (cf. MjsWsRoomsEngineOptions).
  const roomsEngineOpts: MjsWsRoomsEngineOptions = { ...opts.rooms, join: joinFn, maxRoomsPerClient: opts.limits.maxRoomsPerClient }

  // hooks join/leave → pont universel (webhooks 'join'/'leave') ET cluster (présence
  // cross-process) : no-op tant que bridgeEngine/clusterEngine ne sont pas posés
  // (options absentes, ou pas encore atteint ce point du boot).
  const roomsEngine = createRoomsEngine(roomsEngineOpts, rawSend, log, {
    onJoin:        (room, id, meta) => { bridgeEngine?.notifyRoomJoin(room, id, meta); clusterEngine?.publishRoomJoin(room, id, meta) },
    onLeave:       (room, id, meta) => { bridgeEngine?.notifyRoomLeave(room, id, meta); clusterEngine?.publishRoomLeave(room, id, meta) },
    onGlobalJoin:  (id, meta) => clusterEngine?.publishGlobalJoin(id, meta),
    onGlobalLeave: (id) => clusterEngine?.publishGlobalLeave(id),
    isAlive:       (client) => (client as MjsWsClientImpl).state !== 'closed',
  }, fanSend)
  // cluster absent (opts.adapter non fourni) → `undefined` : streams.ts garde son compteur de
  // seq LOCAL synchrone, comportement historique STRICT (aucun octet de différence, cf. streams.ts)
  const streamsCluster: MjsWsStreamsCluster | undefined = opts.adapter ? {
    allocateSeq: (name: string) => clusterEngine!.allocateStreamSeq(name),
    publish:     (name: string, seq: number, p: Record<string, unknown>) => clusterEngine!.publishStreamDelta(name, seq, p),
  } : undefined
  // accroche du sucre `room` (streams.ts::MjsWsStreamOptions.room) — appartenance au salon rooms.ts,
  // MÊME notion que app.room(x).has(client) : sans elle, app.stream(name,
  // {room}) refuse de démarrer, cf. streams.ts::accessOf
  const hasRoomMember = (client: MjsWsClient, room: string): boolean => roomsEngine.room(room).has(client)
  const streamsEngine = createStreamsEngine(rawSend, log, streamsCluster, stats, fanSend, hasRoomMember)
  // reprise de session (sessions.ts) — opt-in : moteur ABSENT = comportement
  // historique strict (aucun octet de différence dans les trames, aucun timer). onExpire =
  // LA purge historique complète (présence, salons, webhook disconnect), différée à la fin
  // de la grâce — finalizeCleanup est hoistée (déclaration `function`), la closure la voit.
  const sessionsEngine = !opts.resume ? null : createSessionsEngine(
    opts.resume,
    (frame) => { try { return Buffer.byteLength(opts.serialize(frame), 'utf8') } catch { return 0 } },
    log,
    { onExpire: (client, reason) => finalizeCleanup(client as MjsWsClientImpl, reason) },
    stats,
  )

  function sendError(client: MjsWsClientImpl, message: string): void {
    sendRaw(client, { t: 'µ:error', p: { message } })
  }

  // fermeture PROTECTRICE (guard) — pas de µ:bye : le client peut reconnecter
  // (backoff standard côté client), utile pour une coupure qui peut être transitoire.
  // `cause` (stats.ts) — catégorise le kick pour garde.kicksXxx ; « trop de messages
  // invalides » (JSON) est comptée sous 'debit', cf. le commentaire de tête de MjsWsGuardCause.
  // `guardFired` : la fermeture PHYSIQUE (conn.close) est asynchrone — un
  // client authentifié backpressuré/en débit reste 'authenticated' (design voulu pour le
  // parcage) tant qu'elle n'a pas abouti, RIEN n'empêchait alors un 2e/Ne appel de rejouer tout
  // le corps (log+stats+close) pour LA MÊME décision déjà prise. Réarmé par une reprise réussie
  // (resumeClient) — connexion neuve, garde neuve.
  function kickClient(client: MjsWsClientImpl, code: number, reason: string, cause: MjsWsGuardCause): void {
    if (client.state === 'closed' || client.state === 'closing' || client.guardFired) return
    client.guardFired = true
    log('warn', t('ws.core.client-expulse', { clientId: client.id, reason }))
    if (cause === 'debit') stats.garde.kicksDebit++
    else if (cause === 'silence') stats.garde.kicksSilence++
    else if (cause === 'engorgement') stats.garde.kicksEngorgement++
    else stats.garde.kicksChargeUtile++
    // Course d'état — MÊME garde que sendDeniedAndClose : un client
    // encore NON authentifié ('hello', ex. watchdog/débit/payload déclenchés AVANT le hello)
    // bascule en 'closing' SYNCHRONE pour fermer la même fenêtre de pipelining (cf. state,
    // MjsWsClientImpl). Un client déjà 'authenticated' garde son state jusqu'à cleanupClient —
    // c'est LUI qui décide encore de l'éligibilité au parcage de session ; un kick n'exclut
    // jamais le parcage par lui-même (cf. cleanupClient/sessionsEngine.park).
    if (client.state === 'hello') client.state = 'closing'
    client.conn.close(code, reason)
  }

  // fermeture APPLICATIVE volontaire (stop()/client.close()/éjection sessionExclusive) — µ:bye
  // D'ABORD : fin DÉFINITIVE annoncée au client, aucune reconnexion (cf. contrat µ:bye).
  // reprise de session : `dismissed` posé AVANT la fermeture — cleanupClient saura que ce
  // départ ne se parque JAMAIS ; la session (si reprise active) meurt tout de suite.
  // `code` — 1000 par défaut (stop()/client.close(), inchangé) ; 4003
  // pour une éviction sessionExclusive (cf. evictIdentity plus bas) — SEUL le code de fermeture
  // change, le reste du contrat µ:bye est IDENTIQUE (même charge {reason}, même `dismissed=true`).
  function dismissClient(client: MjsWsClientImpl, reason?: string, code = 1000): void {
    if (client.state === 'closed' || client.state === 'closing') return
    client.dismissed = true
    sessionsEngine?.discard(client)
    if (client.parked) { finalizeCleanup(client, reason); return }   // parqué : plus de connexion pour porter le µ:bye — purge immédiate
    sendRaw(client, { t: 'µ:bye', p: reason != null ? { reason } : {} })
    // Course d'état — MÊME garde que kickClient/sendDeniedAndClose : un
    // client encore 'hello' (ex. stop() du serveur pendant un handshake en cours — app.stop()
    // dismiss TOUS les clients sans filtrer sur state, cf. plus bas) bascule en 'closing'
    // SYNCHRONE. Un client 'authenticated' garde son state jusqu'à cleanupClient
    // (wasAuthenticated/webhook 'disconnect' en dépendent, cf. finalizeCleanup) — déjà protégé
    // du parcage par le drapeau `dismissed`, jamais besoin d'y toucher ici.
    if (client.state === 'hello') client.state = 'closing'
    client.conn.close(code, reason)
  }

  // --- index par identité — cf. clientsByIdentity plus haut ---
  function identityAdd(identityId: string, client: MjsWsClientImpl): void {
    let set = clientsByIdentity.get(identityId)
    if (!set) { set = new Set(); clientsByIdentity.set(identityId, set) }
    set.add(client)
  }

  function identityRemove(identityId: string | null, client: MjsWsClientImpl): void {
    if (identityId == null) return
    const set = clientsByIdentity.get(identityId)
    if (!set) return
    set.delete(client)
    if (set.size === 0) clientsByIdentity.delete(identityId)
  }

  // session exclusive par identité — éjecte TOUTES les connexions de
  // `identityId` SAUF `exceptId` (le nouvel arrivant, déjà indexé au moment de l'appel dans
  // handleHello — `undefined` pour un appel DISTANT, cf. le canal identity:kick plus bas : aucun
  // client local ne porte jamais l'id d'une connexion d'un AUTRE process, rien à protéger). Une
  // entrée VIVANTE reçoit µ:bye {reason} + close 4003 (dismissClient) ; une entrée déjà PARQUÉE
  // (cf. commentaire de clientsByIdentity) est routée par dismissClient vers finalizeCleanup
  // DIRECT — jamais de µ:bye/close sur une connexion qui n'existe plus. Purge AUSSI les sessions
  // parquées d'AUTRES process (cluster) où cette Map locale ne peut structurellement rien savoir
  // — sessionsEngine.dismissByIdentity couvre ce cas ET tout parqué LOCAL déjà couvert ci-dessus
  // (idempotent : sa session est déjà discard par dismissClient, un 2e passage ne trouve plus rien).
  // `parkedOnly` (correctif fuite cluster mode 'refuse') — défaut false
  // (INCHANGÉ : mode 'replace', éjecte vivantes ET parquées, cf. ci-dessus). `true` : épargne
  // toute entrée VIVANTE (`!client.parked` → `continue`, AUCUN µ:bye/close), ne purge QUE les
  // parquées — sessionsEngine.dismissByIdentity reste inconditionnel, DÉJÀ parked-only par
  // construction (cf. son commentaire, sessions.ts). Nécessaire pour un appel DISTANT (canal
  // identity:kick) : le process ÉMETTEUR sait localement qu'aucune vivante ne reste (refus précoce
  // déjà passé, cf. handleHello), mais un AUTRE process ne le sait PAS — sans ce filtre, sa propre
  // `clientsByIdentity` locale pourrait contenir la connexion vivante d'origine et l'évincerait à
  // tort (sémantique 'replace' qui fuit dans 'refuse' : l'EXISTANT doit TOUJOURS gagner).
  function evictIdentity(identityId: string, exceptId: string | undefined, reason: string | undefined, parkedOnly = false): void {
    const set = clientsByIdentity.get(identityId)
    if (set) {
      for (const client of Array.from(set)) {
        if (exceptId !== undefined && client.id === exceptId) continue
        if (parkedOnly && !client.parked) continue
        dismissClient(client, reason, 4003)
      }
    }
    sessionsEngine?.dismissByIdentity(identityId, reason)
  }

  // déconnexion d'une connexion — une coupure NON définitive d'un client
  // authentifié sous reprise active est PARQUÉE (salons/présence conservés, tampon armé,
  // minuterie de grâce) au lieu d'être purgée ; la purge historique est alors DIFFÉRÉE à
  // l'expiration de la grâce (onExpire → finalizeCleanup). Tout le reste passe direct.
  function cleanupClient(client: MjsWsClientImpl, reason?: string): void {
    if (client.state === 'closed') return
    // plafond de connexions — CHOKE POINT unique de décrément : la
    // connexion PHYSIQUE vient de se fermer (onClose du transport), qu'elle se parque ensuite ou
    // non (le FD/socket est déjà parti dans les deux cas) — cf. releaseConnectionSlot, et
    // resumeClient pour le seul cas où la connexion SURVIT (transférée, jamais relâchée ici).
    releaseConnectionSlot(client)
    // suivi d'expiration du jeton — `tokenExpired` court-circuite le parcage au
    // même titre que `dismissed` : une fermeture pour jeton expiré n'est JAMAIS une coupure
    // réseau anodine à mettre en grâce, le client doit re-authentifier avec un jeton neuf.
    if (sessionsEngine && client.state === 'authenticated' && !client.dismissed && !client.parked && !client.tokenExpired && sessionsEngine.park(client, reason)) {
      client.parked = true
      stats.connexions.actives--
      stats.connexions.parquees++
      client.watchdog.stop()
      // la connexion MORTE ne doit plus jamais rappeler ce client — un onClose tardif
      // (timeout TCP après coup) re-parquerait sinon un client déjà REPRIS sur une conn neuve
      client.conn.onMessage = null
      client.conn.onClose   = null
      return
    }
    finalizeCleanup(client, reason)
  }

  // LA purge historique (étapes 1-8) — immédiate sans reprise, différée à l'expiration de
  // la grâce avec (onExpire), immédiate quand même sur µ:bye (dismissClient ci-dessus).
  function finalizeCleanup(client: MjsWsClientImpl, reason?: string): void {
    if (client.state === 'closed') return
    // 'disconnect' (pont universel) ne fait sens QUE pour un client qui a eu son 'connect'
    // (µ:welcome envoyé) — une connexion coupée pendant le hello n'en a jamais eu
    const wasAuthenticated = client.state === 'authenticated'
    // stats.ts — capturé AVANT le reset ci-dessous (`client.parked = false`) : dit si
    // cette fermeture définitive vient d'un client ACTIF ou déjà PARQUÉ (grâce expirée/µ:bye reçu
    // pendant la grâce), pour décrémenter le bon compteur — jamais les deux à la fois.
    const wasParked = client.parked
    client.state  = 'closed'
    client.parked = false
    client.watchdog.stop()
    clientsById.delete(client.id)
    // index par identité — MÊME choke point que la ligne au-dessus,
    // SEUL point de retrait (cf. le commentaire de clientsByIdentity) — no-op pour un client
    // jamais identifié (identityIdOf renvoie null avant authentification, ou identité anonyme).
    identityRemove(identityIdOf(client.identity), client)
    sessionsEngine?.discard(client)
    roomsEngine.onDisconnect(client)
    streamsEngine.onDisconnect(client)
    if (wasParked) stats.connexions.parquees--
    else if (wasAuthenticated) stats.connexions.actives--
    stats.connexions.fermees++
    // webhook pont + accroche générique (cf. MjsWsOptions.onDisconnect) — MÊME garde
    // `wasAuthenticated` que le pont : un client jamais accueilli n'a rien à notifier de sa
    // « déconnexion », il n'a jamais été là pour personne (MJS-Server et consorts s'appuient
    // là-dessus pour ne JAMAIS voir un client fantôme qu'ils n'ont eux-mêmes jamais vu welcome)
    if (wasAuthenticated) { bridgeEngine?.notifyDisconnect(client, reason); opts.onDisconnect?.(client, reason) }
    // CHOKE POINT unique (onClose réel OU parcage déjà mort, cf. dismissClient) :
    // résout le rendez-vous que stop() a posé pour CE client avant de le dismiss. No-op si stop()
    // n'est pas en cours (Map vide) ou si ce client n'était pas concerné (déjà retirée une fois).
    const waiter = stopCloseWaiters.get(client)
    if (waiter) { stopCloseWaiters.delete(client); waiter() }
  }

  // --- suivi d'expiration du jeton -----------------------------
  // fermeture pour EXPIRATION DE JETON — µ:error{code} PUIS close SANS µ:bye (même sémantique
  // que les kicks de garde ci-dessus : le client peut reconnecter avec un jeton neuf). Pas de
  // kickClient() ici : cette fermeture n'est ni un débit, ni un silence, ni un engorgement, ni
  // une charge utile (les 4 causes de MjsWsGuardCause restent SPÉCIFIQUES à kickClient, cf. son
  // commentaire de tête stats.ts) — code de fermeture (4002) et absence de µ:bye propres à ELLE
  // seule. Compteur DÉDIÉ plutôt qu'un rattachement approximatif à
  // une cause erronée : stats.garde.expirationsJeton, hors de l'union MjsWsGuardCause — cf.
  // stats.ts/stats-page.ts/toPrometheusText (métrique guard_token_expired_total).
  // Course d'état — PAS de bascule 'closing' ici (contrairement à
  // kickClient/dismissClient/sendDeniedAndClose) : sweepExpiredTokens (cf. plus bas) ne cible QUE
  // des clients déjà `state === 'authenticated'` (jamais 'hello') — la course de pipelining d'un
  // 2e µ:hello ne s'y applique donc structurellement pas, rien à changer.
  // `guardFired` : MÊME garde que kickClient (racine commune, cf. son commentaire) —
  // sans elle, un client PARQUÉ (state reste 'authenticated', cf. cleanupClient) était re-«
  // expiré » à CHAQUE cycle de sweepExpiredTokens jusqu'à sa purge de grâce.
  function expireClientToken(client: MjsWsClientImpl): void {
    if (client.state === 'closed' || client.guardFired) return
    client.guardFired = true
    log('warn', t('ws.core.client-expulse', { clientId: client.id, reason: t('ws.core.close-jeton-expire') }))
    stats.garde.expirationsJeton++
    sendRaw(client, { t: 'µ:error', p: { code: 'token-expired' } })
    client.tokenExpired = true
    client.conn.close(4002, t('ws.core.close-jeton-expire'))
  }

  // balayage périodique GLOBAL — jamais un timer par client (cf. Watchdog de guard.ts pour le
  // patron d'inspiration cité au brief : inadapté ICI tel quel, Watchdog est un timer PAR
  // INSTANCE qui se réarme à chaque pet(), alors qu'il faut ici UN SEUL setInterval qui scrute
  // TOUS les clients authentifiés à échéance connue — cf. NOTE de rapport).
  function sweepExpiredTokens(): void {
    const now = Date.now()
    for (const client of clientsById.values()) {
      // un parqué n'a plus de connexion PHYSIQUE à couper : le laisser au balayage
      // ne faisait QUE le re-« expirer » en boucle (guardFired seul évite la répétition, pas le
      // poison `tokenExpired=true` qui bloquerait un futur re-parcage, cf. cleanupClient). La
      // reprise re-vérifie déjà le jeton via un authFn FRAIS — rien à faire ici pour
      // un client sans socket à fermer.
      if (client.state !== 'authenticated' || client.parked || client.tokenExpiresAt == null) continue
      if (now - client.tokenExpiresAt > opts.token.slack) expireClientToken(client)
    }
  }

  // armement PARESSEUX (opt-in strict, point 4) — jamais avant la 1re rencontre d'un client dont
  // l'auth expose une échéance `exp` ; jamais désarmé ensuite (un serveur qui en a vu un peut en
  // revoir d'autres plus tard, pas la peine de réarmer à chaque fois).
  function ensureTokenSweep(): void {
    if (tokenSweepTimer) return
    tokenSweepTimer = setInterval(sweepExpiredTokens, opts.token.sweep)
  }

  // --- vérification d'origine — refus AVANT toute admission, MÊME patron
  // que refuseForCap ci-dessous (code 1008 « Policy Violation » — refus DÉFINITIF, pas 1013 : ce
  // n'est pas transitoire, réessayer avec la même origine échouera toujours). Pas de µ:denied (le
  // hello n'a pas eu lieu). Prédicat qui LÈVE → fail-closed (refusé, log warn).
  function refuseForOrigin(conn: MjsWsConnection): void {
    stats.connexions.refuseesOrigine++
    log('warn', t('ws.core.connexion-refusee-origine', { origin: conn.remoteInfo.origin, address: conn.remoteInfo.address }))
    conn.close(1008, t('ws.core.close-origine-refusee'))
  }

  // --- plafond de connexions — admission/décrément symétriques -----
  // refus AVANT toute admission (plafonds) — code 1013 (RFC 6455 : « Try Again Later », sémantique
  // EXACTE ici), AUCUN MjsWsClientImpl créé (rien à nettoyer plus tard : conn.onClose/onMessage ne
  // sont même pas posés). Pas de µ:denied (le hello n'a pas eu lieu, ce n'est pas une décision
  // applicative) — compteur DÉDIÉ (stats.connexions.refuseesPlafond, DISTINCT de .refusees, cf.
  // sendDeniedAndClose) + log, même esprit que sendDeniedAndClose mais sans trame µ:.
  function refuseForCap(conn: MjsWsConnection, reason: string): void {
    stats.connexions.refuseesPlafond++
    log('warn', t('ws.core.connexion-refusee-raison', { reason }))
    conn.close(1013, t('ws.core.close-reessayez-plus-tard'))
  }

  // décrément SYMÉTRIQUE de l'admission ci-dessous — CHOKE POINT unique (cf. cleanupClient, appelé
  // une fois par connexion PHYSIQUE qui se ferme) ; idempotent via connSlotHeld : resumeClient
  // TRANSFÈRE ce drapeau vers le client repris plutôt que de relâcher ici — la connexion physique
  // de `fresh` survit à la reprise (réutilisée par `parked`), jamais fermée à ce moment-là.
  function releaseConnectionSlot(client: MjsWsClientImpl): void {
    if (!client.connSlotHeld) return
    client.connSlotHeld = false
    liveConnections--
    const ip = client.connSlotIp
    if (ip === undefined) return
    const n = connectionsByIp.get(ip)
    if (n === undefined) return
    if (n <= 1) connectionsByIp.delete(ip)
    else connectionsByIp.set(ip, n - 1)
  }

  // --- acceptation d'une connexion transport --------------------------------
  function acceptConnection(conn: MjsWsConnection): void {
    const ip = conn.remoteInfo.address

    // vérification d'origine — vérifiée AVANT les plafonds (une origine
    // refusée n'a pas à consommer de slot, même symbolique) : `null` (défaut) = jamais appelé,
    // opt-in strict, ZÉRO changement de comportement tant que non posé. Prédicat qui LÈVE → refus
    // (fail-closed), jamais une exception qui remonterait jusqu'au transport.
    if (opts.verifyOrigin != null) {
      let admis: boolean
      try {
        admis = opts.verifyOrigin(conn.remoteInfo.origin, conn.remoteInfo)
      } catch (err) {
        log('warn', t('ws.core.verifyorigin-exception'), { err })
        admis = false
      }
      if (!admis) {
        refuseForOrigin(conn)
        return
      }
    }

    // plafond GLOBAL — vérifié EN PREMIER, avant toute allocation
    // (bucket/watchdog/client) : `null` (défaut) = illimité, opt-in strict, ZÉRO changement de
    // comportement tant que non posé.
    if (opts.limits.maxConnections != null && liveConnections >= opts.limits.maxConnections) {
      refuseForCap(conn, t('ws.core.plafond-global-atteint', { max: opts.limits.maxConnections }))
      return
    }
    // plafond PAR IP — IP absente (transport sans adresse, ex.
    // MemoryTransport) = jamais comptée ni limitée, cf. MjsWsRemoteInfo.address. Vérifié ICI,
    // AVANT tout incrément (ni global ni par IP) : les DEUX plafonds sont contrôlés avant que l'un
    // ou l'autre compteur ne bouge — aucune « admission partielle » à annuler en cas de refus.
    if (ip !== undefined && opts.limits.maxConnectionsPerIp != null && (connectionsByIp.get(ip) ?? 0) >= opts.limits.maxConnectionsPerIp) {
      refuseForCap(conn, t('ws.core.plafond-par-ip-atteint', { ip, max: opts.limits.maxConnectionsPerIp }))
      return
    }

    // admission — comptée AVANT toute autre étape (cf. releaseConnectionSlot pour le décrément
    // symétrique, TOUJOURS au nettoyage : jamais de fuite, même pour une connexion qui échoue plus
    // tard son hello/auth — sendDeniedAndClose/kickClient closent conn, cleanupClient suit).
    liveConnections++
    if (ip !== undefined) connectionsByIp.set(ip, (connectionsByIp.get(ip) ?? 0) + 1)

    const bucket   = new TokenBucket(opts.limits.burst, opts.limits.rate)
    const watchdog = new Watchdog(opts.heartbeat > 0 ? opts.heartbeat * 2.5 : 0, () => kickClient(client, 4000, t('ws.core.close-inactivite'), 'silence'))
    const client   = new MjsWsClientImpl(conn, conn.remoteInfo, bucket, watchdog)
    client.connSlotHeld = true
    client.connSlotIp   = ip
    client.send  = (type, p) => sendRaw(client, { t: type, p })
    client.close = (reason) => dismissClient(client, reason)

    clientsById.set(client.id, client)
    conn.onClose = (_code, reason) => cleanupClient(client, reason)
    conn.onMessage = (raw) => enqueueMessage(client, raw)
    // amorcé dès l'acceptation, AVANT même le hello — une connexion qui ne dit
    // jamais bonjour est aussi une connexion muette.
    watchdog.pet()
  }

  // FIFO stricte par connexion, PARTAGÉE texte/binaire — le message N+1 attend la
  // fin COMPLÈTE du traitement (awaits compris) du message N, quel qu'en soit le type — garantit
  // entre autres qu'aucune trame ne se glisse entre l'auth async et l'envoi du µ:welcome (piège
  // #1). Branchement UNIQUE sur `typeof raw` — jamais deux chaînes de traitement séparées qui
  // pourraient désynchroniser l'ordre côté connexion.
  function enqueueMessage(client: MjsWsClientImpl, raw: string | Uint8Array): void {
    client.chain = client.chain
      .then(() => (typeof raw === 'string' ? handleRaw(client, raw) : handleBinaryRaw(client, raw)))
      .catch(err => log('error', t('ws.core.erreur-interne-non-geree'), { err }))
  }

  // --- une trame brute reçue -------------------------------------------------
  async function handleRaw(client: MjsWsClientImpl, raw: string): Promise<void> {
    stats.messages.recus++
    // Course d'état — 'closing' ignoré au même titre que 'closed' : un
    // 2e message pipeliné après une décision de fermeture (µ:denied/kick pré-auth, cf. state
    // dans MjsWsClientImpl) n'est PLUS jamais routé, même si la fermeture PHYSIQUE (onClose,
    // async) n'a pas encore eu lieu — cas concret : un 2e µ:hello valide après un 1er refusé ne
    // s'authentifie plus (cf. sendDeniedAndClose).
    if (client.state === 'closed' || client.state === 'closing') return
    if (Buffer.byteLength(raw, 'utf8') > opts.limits.maxPayload) { kickClient(client, 1009, t('ws.core.close-payload-trop-volumineux'), 'charge'); return }
    client.watchdog.pet()

    let msg: any
    try { msg = opts.parse(raw) }
    catch { onInvalidJson(client); return }
    if (!msg || typeof msg !== 'object' || typeof msg.t !== 'string') { onInvalidJson(client); return }

    if (!client.bucket.take()) { onRateLimitViolation(client); return }

    if (client.state === 'hello') {
      if (msg.t !== 'µ:hello') { sendDeniedAndClose(client, t('ws.core.hello-attendu-premier')); return }
      return handleHello(client, msg)
    }

    switch (msg.t) {
      case 'µ:hello':       sendError(client, t('ws.core.hello-deja-recu')); return
      case 'µ:ping':         handlePing(client, msg); return
      case 'µ:refresh':      return handleRefresh(client, msg)   // await : re-vérifie via opts.auth (peut être async) — la FIFO par connexion doit l'attendre, même garde que µ:join
      case 'µ:sub-stream':   handleSubStream(client, msg); return
      case 'µ:resync':       handleResync(client, msg); return
      case 'µ:sub-presence': return handleSubPresence(client, msg)   // await : la garde rooms.canSeePresence peut être async — même FIFO que µ:join (cf. son commentaire)
      case 'µ:join':         return handleJoin(client, msg)   // await : la garde rooms.join peut être async — la FIFO par connexion doit l'attendre (un µ:leave qui suit ne double pas le join)
      case 'µ:leave':        handleLeave(client, msg); return
    }
    if (msg.t.indexOf('µ:') === 0) { sendError(client, t('ws.core.type-inconnu', { type: msg.t })); return }
    // µschema — ws.codec 'binary' STRICT : un message applicatif TEXTE (donc hors
    // schéma par construction) est un refus, pas un routage silencieux — compté +
    // µ:error throttlé (cf. schema.ts::rejectIfStrictText), jamais en 'auto'/'json'.
    if (schemaEngine.rejectIfStrictText(client, msg.t)) return
    // webhook 'message:<type>' (pont universel) — TOUT message applicatif, que
    // serve()/on() existe ou non pour ce type ; notifyMessage filtre lui-même sur `events`
    bridgeEngine?.notifyMessage(msg.t, msg.p, client)
    return routeAppMessage(client, msg)
  }

  function onInvalidJson(client: MjsWsClientImpl): void {
    client.invalidJsonCount++
    log('warn', t('ws.core.json-invalide-recu', { clientId: client.id }))
    if (client.invalidJsonCount > opts.limits.kickAfter) kickClient(client, 1008, t('ws.core.close-trop-messages-invalides'), 'debit')
  }

  function onRateLimitViolation(client: MjsWsClientImpl): void {
    client.violations++
    const now = Date.now()
    if (client.lastRateErrorAt == null || now - client.lastRateErrorAt > RATE_ERROR_THROTTLE_MS) {
      sendError(client, t('ws.core.debit-depasse-ralentis'))
      client.lastRateErrorAt = now
    }
    if (client.violations > opts.limits.kickAfter) kickClient(client, 1008, t('ws.core.close-debit-depasse'), 'debit')
  }

  // --- trame binaire (socle du futur µschema) -------------------
  // AUCUN décodage ici — une évolution future du µschema posera le décodage réel ; cette étape ne fait QUE
  // transmettre en sûreté : le videur (bucket de débit + garde de taille) s'applique EXACTEMENT
  // comme à un message texte (mêmes clés/valeurs opts.limits, même kickClient) — un flot binaire
  // ne doit jamais le contourner. Avant authentification (hello pas encore reçu), la trame est
  // ignorée SANS fermer la connexion : le hello reste JSON obligatoire, aucune trame binaire ne
  // peut s'y substituer. Après authentification, routage vers une accroche INTERNE non publique
  // (`(app as any)._binaryHandler`, posée plus tard par µschema, cf. sa pose plus bas) — absente :
  // trame ignorée SILENCIEUSEMENT (PAS de µ:error : un client pourrait sonder le protocole avant
  // même d'avoir le droit d'y parler, µ:error lui offrirait un canal de reconnaissance gratuit).
  async function handleBinaryRaw(client: MjsWsClientImpl, bytes: Uint8Array): Promise<void> {
    stats.messages.binaireRecues++
    if (client.state === 'closed' || client.state === 'closing') return   // même garde que handleRaw, cf. son commentaire
    if (bytes.byteLength > opts.limits.maxPayload) { kickClient(client, 1009, t('ws.core.close-trame-binaire-trop-volumineuse'), 'charge'); return }
    client.watchdog.pet()
    if (!client.bucket.take()) { onRateLimitViolation(client); return }
    if (client.state !== 'authenticated') { stats.messages.binaireIgnorees++; return }
    // signature élargie — `void | Promise<void>` : le décodeur µschema route vers
    // routeAppMessage (peut attendre un serve() async), la FIFO de CETTE connexion (client.chain,
    // cf. enqueueMessage) doit donc attendre la promesse EXACTEMENT comme pour handleRaw — sinon
    // un message texte/binaire suivant pourrait doubler un µ:ack encore en vol (piège #1, même
    // famille que le hello/welcome). `await` sur un retour non-promesse est un no-op inoffensif.
    const handler = (app as any)._binaryHandler as ((c: MjsWsClient, b: Uint8Array) => void | Promise<void>) | null
    if (!handler) { stats.messages.binaireIgnorees++; return }
    try { await handler(client, bytes) }
    catch (err) { log('error', t('ws.core.accroche-binaire-a-leve'), { err }) }
  }

  // --- handshake ---------------------------------------------------------
  // µschema — augmente une charge de µ:welcome du hash SERVEUR, SEULEMENT si un
  // registre existe (sinon `p` est renvoyé TEL QUEL — même référence, zéro octet de différence,
  // cf. tests/mjs-ws-schema.test.ts « non-régression »).
  function withSchemaHash(p: Record<string, unknown>): Record<string, unknown> {
    return schemaEngine.hasSchemas ? { ...p, schemaHash: schemaEngine.hash() } : p
  }

  // µschema — juste APRÈS le µ:welcome : si le client annonce un hash ET qu'il
  // diffère du nôtre, pousse la définition complète du registre (le client peut alors
  // régénérer son miroir à la volée). Silencieux si le registre est vide ou si le client n'a rien
  // annoncé (cf. MjsWsHelloPayload.schemaHash) — jamais de µ:schema « pour rien ».
  function pushSchemaIfMismatch(client: MjsWsClientImpl, clientHash: string | undefined): void {
    if (!schemaEngine.hasSchemas || clientHash == null) return
    const serverHash = schemaEngine.hash()
    if (clientHash === serverHash) return
    sendRaw(client, { t: 'µ:schema', p: { version: serverHash, definitions: schemaEngine.definitions() } })
  }

  async function handleHello(client: MjsWsClientImpl, msg: any): Promise<void> {
    const p: MjsWsHelloPayload = msg.p || {}
    if (p.protocol !== 1) { sendDeniedAndClose(client, t('ws.core.close-protocole-non-supporte')); return }

    let identity: unknown
    if (authFn) {
      try { identity = await authFn(p, client.meta) }
      catch (err) {
        // Fuite d'erreur à un client NON authentifié — cf. le
        // commentaire de tête de MjsWsAuthDenied pour la distinction complète. Résumé : authIsProxy
        // (proxy de décisions, TOUJOURS sûr) OU throw explicite MjsWsAuthDenied → message transmis
        // tel quel ; sinon (fonction brute, throw nu = bug/panne interne présumé) → détail loggé
        // ICI côté serveur, message GÉNÉRIQUE au client (même motif que le `false` ci-dessous).
        if (!(err instanceof MjsWsAuthDenied) && !authIsProxy) {
          log('warn', t('ws.core.auth-exception-interne', { clientId: client.id, err: errMessage(err) }))
          sendDeniedAndClose(client, t('ws.core.close-authentification-refusee'))
          return
        }
        sendDeniedAndClose(client, errMessage(err))
        return
      }
      if (identity === false) { sendDeniedAndClose(client, t('ws.core.close-authentification-refusee')); return }
      // La connexion a pu tomber PENDANT cet auth async (finalizeCleanup déjà passé,
      // client.state === 'closed') : SANS ce garde-fou, la suite (resumeClient / présence
      // globale / webhook connect, plus bas) s'exécute quand même sur une connexion qui n'existe
      // déjà plus nulle part — un pair de présence FANTÔME qu'aucun futur onDisconnect ne
      // reverra jamais (finalizeCleanup n'a lieu qu'UNE fois par connexion), un webhook
      // 'connect' pour un client déjà 'disconnect', une session orpheline si la reprise est
      // active. Abandon silencieux, cohérent avec la politique déjà en place (sendRaw sur un
      // client 'closed' est déjà un no-op) — juste étendue au RESTE du handshake.
      // Course d'état — 'closing' AUSSI : un kick/deny déclenché par un
      // AUTRE chemin (watchdog silence, app.stop() en plein handshake, cf. state dans
      // MjsWsClientImpl) PENDANT ce MÊME await bascule déjà le client en 'closing' — SANS ce 2e
      // cas ici, la ligne `client.state = 'authenticated'` plus bas écraserait cette décision de
      // fermeture déjà prise (conn.close() déjà appelé) et ressusciterait un client déjà kické.
      if (client.state === 'closed' || client.state === 'closing') return
    }
    // session exclusive par identité — MÊME identityId que la reprise
    // ci-dessous (calculé UNE FOIS, jamais deux résolutions qui pourraient diverger)
    const identityId = identityIdOf(identity)
    // reprise de session — tentée seulement APRÈS l'auth normale ci-dessus (une
    // reprise n'est JAMAIS un contournement : hello.auth re-vérifié comme toujours). Échec
    // quelconque (session inconnue/expirée, clé fausse, identité différente, tampon
    // débordé) = accueil FRAIS silencieux ci-dessous — sans erreur ni fuite d'information.
    if (sessionsEngine && p.session != null) {
      const claimed = sessionsEngine.claim(p.session, identityId)
      // `identity` (déjà FRAÎCHEMENT validé par authFn ci-dessus) transmis à
      // resumeClient : sans lui, une reprise réussie continuait de tourner sur les
      // droits/l'échéance D'AVANT la coupure (cf. son commentaire).
      if (claimed) { resumeClient(client, claimed.client as MjsWsClientImpl, claimed.frames, p.schemaHash, identity); return }
    }

    // session exclusive par identité, mode 'refuse' (2 modes) — AVANT
    // toute indexation/état (client.identity/identityAdd/stats plus bas) : un hello FRAIS dont
    // l'identité a déjà AU MOINS une connexion VIVANTE (ni parquée ni déjà `dismissed`, cf.
    // clientsByIdentity) est refusé tel quel — l'EXISTANT gagne, à l'inverse du mode 'replace'
    // (cf. la décision plus bas, après le µ:welcome). Ne s'applique qu'au hello FRAIS (la reprise
    // ci-dessus est déjà sortie par `return`). Multi-processus : `clientsByIdentity` est LOCAL au
    // process — 'refuse' garantit l'exclusivité PAR PROCESS seulement (best effort global, cf.
    // docs/23-mjs-ws.md §8.5).
    if (opts.sessionExclusive === 'refuse' && identityId != null) {
      const existantes = clientsByIdentity.get(identityId)
      if (existantes && Array.from(existantes).some(c => !c.parked && !c.dismissed)) {
        sendDeniedAndClose(client, t('ws.core.close-session-deja-active'), 4004)
        return
      }
    }

    client.identity = identity
    // index par identité — SEUL point d'ajout (cf. le commentaire de
    // clientsByIdentity) ; identité anonyme (identityId null) → jamais indexée, cohérent avec
    // sessionExclusive qui ne les éjecte jamais (cf. juste en dessous).
    if (identityId != null) identityAdd(identityId, client)
    // suivi d'expiration du jeton — armement PARESSEUX : seul un premier client
    // dont l'auth expose une échéance `exp` déclenche le balayage global (opt-in strict)
    client.tokenExpiresAt = tokenExpOf(identity)
    if (client.tokenExpiresAt != null) ensureTokenSweep()
    client.state    = 'authenticated'
    // stats.ts — welcome FRAIS uniquement (le chemin resumeClient ci-dessus est
    // déjà sorti par `return` et compte séparément sous sessions.reprises, jamais les deux)
    stats.connexions.accueillies++
    stats.connexions.actives++

    // session exclusive par identité (2 modes) — AVANT le µ:welcome.
    // 'replace' : le nouveau prend la place, toute AUTRE connexion (vivante ou parquée) de la
    // MÊME identité est éjectée proprement (µ:bye {reason:'replace'} + close 4003, jamais
    // parquée/reprise, cf. evictIdentity). 'refuse' : n'arrive ICI que si aucune connexion vivante
    // n'a été trouvée par le refus précoce ci-dessus (juste après la reprise de session) — seules
    // des sessions PARQUÉES peuvent donc encore traîner ici, purgées par le MÊME evictIdentity pour
    // qu'une reprise ultérieure de l'ancien onglet ne recrée pas une 2e session (MÊME appel, MÊME
    // reason 'replace' — le mot ne qualifie que l'action d'evictIdentity, pas le mode courant).
    // Identité anonyme (identityId null) → jamais d'éjection, quel que soit le mode.
    // `parkedOnly` (correctif fuite cluster mode 'refuse') — LOCALEMENT redondant avec la garde
    // ci-dessus (seules des parquées peuvent structurellement rester dans le Set à ce point, en
    // mode 'refuse'), posé quand même pour rendre l'invariant EXPLICITE plutôt qu'implicite (défense
    // en profondeur), et SURTOUT propagé à publishIdentityKick : un AUTRE process du cluster ne
    // partage PAS cette garantie locale (sa propre clientsByIdentity peut très bien contenir LA
    // connexion vivante d'origine) — SANS ce filtre distant, un hello 'refuse' accepté sur CE process
    // évincerait à tort une session vivante sur un AUTRE (cf. le commentaire d'evictIdentity).
    // Multi-processus : publie sur le canal identity:kick pour que les AUTRES process fassent le
    // même ménage localement (MÊME patron que room:kick, cf. createClusterEngine plus bas) — garde
    // posée ICI (rien n'est jamais publié quand l'option est désactivée, 'false').
    if ((opts.sessionExclusive === 'replace' || opts.sessionExclusive === 'refuse') && identityId != null) {
      const parkedOnly = opts.sessionExclusive === 'refuse'
      evictIdentity(identityId, client.id, 'replace', parkedOnly)
      clusterEngine?.publishIdentityKick(identityId, 'replace', parkedOnly)
    }

    let welcomeP: unknown = {}
    if (opts.welcome) {
      try { welcomeP = (await opts.welcome(client)) ?? {} }
      catch (err) { log('error', t('ws.core.welcome-a-leve'), { err }); welcomeP = {} }
      // Même course que celle documentée après l'auth ci-dessus, ici pendant welcome() :
      // `client.state` est déjà passé à 'authenticated' juste avant (stats déjà comptées), donc
      // une coupure PENDANT ce await est passée par finalizeCleanup DIRECTEMENT (jamais par le
      // chemin park — sessionsEngine.issue() n'a pas encore eu lieu, cf. sessions.ts) : sortir
      // ici évite un pair de présence fantôme + un webhook 'connect' postérieur à son
      // propre 'disconnect' + une session orpheline pour un client déjà entièrement purgé.
      // Widening explicite (`: string`) — sans lui, tsc croit `client.state` encore figé à
      // 'authenticated' (dernière affectation vue dans CE flux synchrone) : il ne modélise pas
      // qu'un `await` laisse la main à un AUTRE chemin (conn.onClose → cleanupClient) qui peut
      // le repasser à 'closed' entre-temps — précisément la course examinée ici, cf. bridge.ts/
      // bundler/config.ts pour le même angle mort déjà rencontré côté unions discriminées.
      const stateAfterWelcome: string = client.state
      if (stateAfterWelcome === 'closed') return
    }
    // OBLIGATOIRE et IMMÉDIAT (piège #1 du contrat) — envoyé quoi qu'il arrive ci-dessus.
    // Reprise active : le µ:welcome porte EN PLUS session {id, key} (clé neuve à chaque
    // welcome) + resumed:false ; sans reprise, trame STRICTEMENT identique à avant (aucun
    // octet de différence — pas même une copie de welcomeP).
    if (sessionsEngine) {
      const session = sessionsEngine.issue(client)
      sendRaw(client, { t: 'µ:welcome', p: { ...withSchemaHash(welcomeP as Record<string, unknown>), session, resumed: false } })
    } else {
      sendRaw(client, { t: 'µ:welcome', p: withSchemaHash(welcomeP as Record<string, unknown>) })
    }
    pushSchemaIfMismatch(client, p.schemaHash)
    // présence GLOBALE : un client authentifié « apparaît » à son welcome (delta join aux
    // abonnés globaux si c'est la 1re connexion de son identité — agrégation, cf. rooms.ts)
    roomsEngine.onWelcome(client)
    bridgeEngine?.notifyConnect(client)
  }

  // REPRISE : le MÊME objet client est recyclé — sa connexion interne est
  // échangée contre la neuve, son id/salons/présence n'ont JAMAIS bougé (ni delta de
  // présence, ni webhook : une session reprise n'est jamais « partie »). `fresh` (la
  // connexion entrante qui portait le re-hello) est retirée du registre SANS purge :
  // jamais authentifiée — ni salon, ni présence, ni webhook connect.
  // index par identité (cf. clientsByIdentity plus haut) — RIEN à
  // faire ici : `fresh` n'a jamais son identity posée (retourne avant dans handleHello), jamais
  // indexée ; `parked` y figure déjà depuis son propre hello d'origine et n'en est jamais retiré
  // tant qu'il reste dans clientsById (cf. cleanupClient) — donc encore présent, sans rien à
  // transférer. Cette reprise ne déclenche jamais l'éviction sessionExclusive (cf. handleHello :
  // le bloc `if (opts.sessionExclusive...)` est dans la branche hello FRAIS, jamais ici).
  function resumeClient(fresh: MjsWsClientImpl, parked: MjsWsClientImpl, frames: Array<Record<string, unknown>>, schemaHash: string | undefined, identity: unknown): void {
    const conn = fresh.conn
    fresh.state = 'closed'
    fresh.watchdog.stop()
    clientsById.delete(fresh.id)
    // plafond de connexions — TRANSFERT du compte vers `parked` : la
    // connexion PHYSIQUE de `fresh` est RÉUTILISÉE juste en dessous (parked.conn = conn), jamais
    // refermée ici — la décrémenter la perdrait pour de bon (fuite : `fresh` est jeté sans jamais
    // repasser par cleanupClient/releaseConnectionSlot). `parked` avait déjà relâché SON propre
    // compte quand il a été parqué (cf. cleanupClient) — jamais un double comptage. `connSlotIp`
    // suit : l'IP de la connexion physique en cours peut différer de celle d'origine de `parked`.
    parked.connSlotHeld = fresh.connSlotHeld
    parked.connSlotIp   = fresh.connSlotIp
    fresh.connSlotHeld  = false

    parked.conn   = conn
    parked.parked = false
    stats.connexions.parquees--
    stats.connexions.actives++
    parked.consecutiveDrops = 0
    parked.guardFired = false   // connexion neuve, une garde neuve doit pouvoir s'appliquer
    parked.lastPingAt = null   // sinon le 1er ping post-reprise mesurerait une « latence » de toute la grâce
    parked.watchdog.pet()

    // identité/échéance RAFRAÎCHIES avec le résultat FRAIS de authFn (déjà validé
    // par handleHello AVANT d'appeler claim(), cf. son commentaire) : MÊME traitement que
    // handleRefresh (core.ts) — sans ça, une reprise réussie continuait de tourner sur les
    // droits/l'échéance D'AVANT la coupure (autorisation périmée conservée, déconnexions
    // parasites sur un jeton neuf).
    parked.identity       = identity
    parked.tokenExpiresAt = tokenExpOf(identity)
    if (parked.tokenExpiresAt != null) ensureTokenSweep()

    // file UNIQUE ordonnée : tant que `resuming` reste vrai, sendRaw/sendPre
    // tamponnent ICI (resumeQueue, MÊME référence que `frames`) au lieu d'envoyer — même si
    // `parked` est déjà retombé à false ci-dessus (connexion physique déjà vivante). `frames`
    // (l'ancienne grâce) est la BASE : tout ce qui arrive pendant l'attente du welcome() async
    // s'y ajoute à la suite, jamais avant (cf. finishResume, plus aucune inversion possible même
    // sur une double coupure pendant cette attente).
    parked.resuming    = true
    parked.resumeQueue = frames

    // suite du handshake SÉQUENCÉE dans la FIFO du client repris : le µ:welcome (+ rejeu du
    // tampon) est enfilé AVANT tout message de la connexion neuve — rien ne se glisse entre
    // (piège #1 du contrat), même avec un welcome() applicatif async.
    parked.chain = parked.chain
      .then(() => finishResume(parked, frames, schemaHash))
      .catch(err => log('error', t('ws.core.erreur-interne-non-geree'), { err }))
    conn.onClose   = (_code, reason) => cleanupClient(parked, reason)
    conn.onMessage = (raw) => enqueueMessage(parked, raw)
  }

  async function finishResume(parked: MjsWsClientImpl, frames: Array<Record<string, unknown>>, schemaHash: string | undefined): Promise<void> {
    let welcomeP: unknown = {}
    if (opts.welcome) {
      try { welcomeP = (await opts.welcome(parked)) ?? {} }
      catch (err) { log('error', t('ws.core.welcome-a-leve'), { err }); welcomeP = {} }
    }
    // La connexion neuve a pu retomber PENDANT ce await (re-parquée par cleanupClient,
    // voire purgée pour de bon si la grâce a expiré entre-temps) : émettre le µ:welcome
    // MAINTENANT tournerait la clé de session vers une valeur que le client ne recevra JAMAIS
    // (sendRaw la tamponnerait elle-même, `parked.parked` étant redevenu vrai) — la session
    // devient alors DÉFINITIVEMENT injoignable : la clé requise pour déverrouiller son propre
    // tampon est PRISONNIÈRE de ce même tampon (prouvé en test, mjs-ws-resume-edge.test.ts). On
    // retamponne plutôt ces trames pour la PROCHAINE reprise (no-op silencieux si la session a
    // entre-temps été purgée pour de bon) SANS toucher à la clé en cours — elle reste valable.
    if (parked.state === 'closed' || parked.parked) {
      // `frames` EST la file unique (resumeQueue, MÊME référence, cf. resumeClient) :
      // déjà dans l'ordre chronologique exact (grâce d'origine PUIS trafic de CETTE fenêtre) —
      // `record.buffer` (sessions.ts) est resté VIDE tout du long (resuming a détourné tout
      // sendRaw/sendPre vers `frames` au lieu de sessionsEngine.buffer()) : plus jamais
      // d'inversion d'ordre en le repeuplant ici, on le reverse simplement TEL QUEL.
      parked.resuming    = false
      parked.resumeQueue = null
      for (const frame of frames) { stats.messages.tamponnes++; sessionsEngine!.buffer(parked, frame) }
      return
    }
    const session = sessionsEngine!.issue(parked)   // clé TOURNÉE (même id) — l'ancienne ne marche plus
    // dé-tamponne SEULEMENT maintenant : le µ:welcome part avant que quoi que ce soit
    // d'autre ne puisse encore se glisser devant (sendRaw/sendPre l'auraient tamponné dans
    // `frames`/resumeQueue jusqu'à cette ligne, cf. piège #1 du contrat).
    parked.resuming    = false
    parked.resumeQueue = null
    sendRaw(parked, { t: 'µ:welcome', p: { ...withSchemaHash(welcomeP as Record<string, unknown>), session, resumed: true } })
    pushSchemaIfMismatch(parked, schemaHash)
    // rejeu ORDONNÉ du tampon, juste après le welcome — la salve du client (resync/join)
    // arrivera indépendamment ; les join re-tentés sont déjà dédupliqués (rooms.ts)
    for (const frame of frames) sendRaw(parked, frame)
    stats.messages.rejoues += frames.length
    log('info', t('ws.core.client-repris', { clientId: parked.id, sessionId: session.id, count: frames.length }))
  }

  // Course d'état — TOUJOURS appelée sur un client encore 'hello' (les
  // 4 call-sites, cf. handleHello/handleRaw, précèdent tous l'authentification) : garde
  // d'idempotence + bascule SYNCHRONE en 'closing' AVANT conn.close() — plus jamais de double
  // comptage `refusees`/double µ:denied si jamais appelée deux fois (ex. réentrance), et surtout
  // plus de fenêtre où un 2e µ:hello pipeliné sur ce même socket serait encore routé vers
  // handleHello avant que la fermeture réelle (async, onClose) n'ait eu lieu — cf. state
  // (MjsWsClientImpl) + le nouveau garde-fou de handleRaw/handleBinaryRaw.
  // `code` (mode 'refuse') — 4001 par défaut (INCHANGÉ pour tous les
  // appels préexistants) ; 4004 pour le refus d'un hello FRAIS quand une session vivante existe
  // déjà pour cette identité (cf. handleHello plus bas) — SEUL le code de fermeture change,
  // `refusees` reste incrémenté au même titre (pas de compteur dédié, cf. docs/23-mjs-ws.md §8.5).
  function sendDeniedAndClose(client: MjsWsClientImpl, message: string, code = 4001): void {
    if (client.state === 'closed' || client.state === 'closing') return
    stats.connexions.refusees++
    sendRaw(client, { t: 'µ:denied', p: { message } })
    client.state = 'closing'
    client.conn.close(code, 'denied')
  }

  // --- ping/pong -----------------------------------------------------------
  function handlePing(client: MjsWsClientImpl, msg: any): void {
    const ts = msg.p && msg.p.ts
    sendRaw(client, { t: 'µ:pong', p: { ts } })   // verbatim — même non-numérique, cf. contrat piège #5
    const now = Date.now()
    if (client.lastPingAt != null) { client.latency = now - client.lastPingAt; stats.latencesPing.push(client.latency) }
    client.lastPingAt = now
  }

  // --- rafraîchissement du jeton EN VOL ------------------------
  // µ:refresh { auth } — MÊME charge que hello.p.auth (« MÊME chemin que le hello ») : re-vérifie
  // via opts.auth, mais REFUSE tout changement d'identity.id (une session ne change jamais
  // d'identité en vol — casserait présence/salons, cf. identityIdOf/sessions.ts). Trame avec id →
  // µ:ack (patron requête existant, cf. routeAppMessage) ; ÉCHEC → µ:error{code:'refresh-denied'}
  // TOUJOURS + µ:ack{id,e:true} SI un id était fourni (jamais un sock.refresh() qui pendrait
  // jusqu'à son timeout côté client). Un refresh raté ne ferme JAMAIS la connexion — elle vit
  // jusqu'à son échéance courante (sweepExpiredTokens reste inchangé par un refresh refusé).
  async function handleRefresh(client: MjsWsClientImpl, msg: any): Promise<void> {
    if (!authFn) { denyRefresh(client, msg.id); return }
    const p: MjsWsHelloPayload = msg.p || {}
    let identity: unknown
    try { identity = await authFn(p, client.meta) }
    catch { denyRefresh(client, msg.id); return }
    if (identity === false) { denyRefresh(client, msg.id); return }
    if (client.state === 'closed') return   // course : coupé pendant l'await (même garde que handleHello)
    if (identityIdOf(identity) !== identityIdOf(client.identity)) { denyRefresh(client, msg.id); return }
    client.identity       = identity
    client.tokenExpiresAt = tokenExpOf(identity)
    if (client.tokenExpiresAt != null) ensureTokenSweep()
    if (msg.id != null) sendRaw(client, { t: 'µ:ack', id: msg.id, p: { exp: client.tokenExpiresAt != null ? Math.round(client.tokenExpiresAt / 1000) : null } })
  }

  function denyRefresh(client: MjsWsClientImpl, id: unknown): void {
    sendRaw(client, { t: 'µ:error', p: { code: 'refresh-denied' } })
    if (id != null) sendRaw(client, { t: 'µ:ack', id, e: true, p: 'refresh-denied' })
  }

  // --- salve post-welcome : délégation aux moteurs (rooms.ts / streams.ts) ---
  // ici seulement la VALIDATION de la charge réseau (types des champs) — la
  // logique vit dans les moteurs. Charge invalide = no-op silencieux (même
  // politique que les stubs d'origine : ne jamais bloquer ni faire planter).
  function handleSubStream(client: MjsWsClientImpl, msg: any): void {
    const stream = msg.p && msg.p.stream
    if (typeof stream !== 'string') return
    streamsEngine.handleSubStream(client, stream)
  }

  function handleResync(client: MjsWsClientImpl, msg: any): void {
    const stream = msg.p && msg.p.stream
    if (typeof stream !== 'string') return
    const rawFrom = msg.p.from
    // from absent/non-numérique → 0 : rejeu complet si le journal couvre tout, sinon reset — jamais un trou silencieux
    const from = (typeof rawFrom === 'number' && isFinite(rawFrom)) ? rawFrom : 0
    streamsEngine.handleResync(client, stream, from)
  }

  async function handleSubPresence(client: MjsWsClientImpl, msg: any): Promise<void> {
    const room = msg.p ? msg.p.room : undefined
    // non-string (dont absent) = présence GLOBALE — l'écho `room` restera ABSENT du JSON (undefined verbatim, cf. rooms.ts)
    return roomsEngine.handleSubPresence(client, typeof room === 'string' ? room : undefined)
  }

  async function handleJoin(client: MjsWsClientImpl, msg: any): Promise<void> {
    const room = msg.p && msg.p.room
    if (typeof room !== 'string') return
    return roomsEngine.handleJoin(client, room)
  }

  function handleLeave(client: MjsWsClientImpl, msg: any): void {
    const room = msg.p && msg.p.room
    if (typeof room !== 'string') return
    roomsEngine.handleLeave(client, room)
  }

  // --- messages applicatifs : requêtes {t,p,id} → µ:ack, ou pub/sub {t,p} ----
  async function routeAppMessage(client: MjsWsClientImpl, msg: any): Promise<void> {
    const handler = servers.get(msg.t)
    const pubsub  = subscribers.get(msg.t)
    if (!handler && (!pubsub || pubsub.length === 0)) { sendError(client, t('ws.core.type-inconnu', { type: msg.t })); return }

    if (msg.id != null && handler) {
      try {
        const result = await handler(msg.p, client)
        sendRaw(client, { t: 'µ:ack', id: msg.id, p: result })
      } catch (err) {
        log('error', t('ws.core.serve-a-leve', { type: msg.t }), { err })
        sendRaw(client, { t: 'µ:ack', id: msg.id, e: true, p: errMessage(err) })
      }
      return
    }
    // pub/sub — soit un send() applicatif normal, soit une requête sur un type
    // SANS serve() (déclenche quand même les abonnés on(), par cohérence avec
    // la règle « inconnu ssi ni serve ni on » ; aucun ack n'est alors possible).
    if (!pubsub) return
    for (const h of pubsub.slice()) {
      try { await h(msg.p, client) }
      catch (err) { log('error', t('ws.core.on-a-leve', { type: msg.t }), { err }); sendError(client, errMessage(err)) }
    }
  }

  // --- garde process (option guardProcess, défaut false) ---------------------
  function armProcessGuard(): void {
    if (!opts.guardProcess) return
    uncaughtHandler  = (err) => log('error', t('ws.core.uncaught-exception-survit'), { err })
    unhandledHandler = (reason) => log('error', t('ws.core.unhandled-rejection-survit'), { reason })
    process.on('uncaughtException', uncaughtHandler)
    process.on('unhandledRejection', unhandledHandler)
  }

  function disarmProcessGuard(): void {
    if (uncaughtHandler) process.off('uncaughtException', uncaughtHandler)
    if (unhandledHandler) process.off('unhandledRejection', unhandledHandler)
    uncaughtHandler  = null
    unhandledHandler = null
  }

  function* iterateClients(): IterableIterator<MjsWsClient> {
    for (const c of clientsById.values()) if (c.state === 'authenticated') yield c
  }

  // --- façade applicative ------------------------------------------------------
  const app: MjsWsApp = {
    serve(type, handler) { servers.set(type, handler) },

    on(type, handler) {
      let hs = subscribers.get(type)
      if (!hs) { hs = []; subscribers.set(type, hs) }
      hs.push(handler)
    },

    // paquets activables (packages.ts) — `app` fermé par CLOSURE (const déclarée
    // plus bas, déjà pleinement assignée au moment où `use` est APPELÉE — jamais avant, MÊME
    // principe que les accroches `(app as any)._binaryHandler`/`_cluster` posées après ce littéral)
    // : c'est CET objet — avec toute mutation ultérieure d'un composeur externe (ex. MJS-Server, qui
    // réassigne app.serve/app.on APRÈS mjsWs(), cf. mjs-framework/mjs-server) déjà en place au moment de
    // l'appel — que reçoit `pkg.installer`. Un paquet installé sur une app MJS-Server voit donc bien
    // la garde de préfixe réservé de MJS-Server sur `app.serve`/`app.on`, jamais contournée.
    // `pkg.nom` inscrit SEULEMENT après un installer qui n'a PAS levé (avant :
    // inscrit AVANT l'appel, un installer en échec poisonnait le nom à vie — tout retry, même
    // d'un paquet CORRIGÉ, restait ignoré pour toujours). L'erreur est journalisée (catalogue)
    // PUIS relancée telle quelle — comportement inchangé pour l'appelant, qui la voyait déjà.
    // Le try/catch ci-dessus ne voit
    // QUE le throw SYNCHRONE : un installer `async` (ou qui retourne une Promise) NE lève JAMAIS
    // sync, même s'il rejette plus tard — le nom passait donc AVANT ce correctif, et le rejet,
    // jamais intercepté, tuait le process (unhandledRejection, Node 24). `r` thenable ⇒ inscrit
    // SEULEMENT à la résolution, rejet capturé et journalisé (MÊME message que le cas sync), JAMAIS
    // relancé (aucun appelant synchrone à qui le faire remonter). CHOIX ASSUMÉ : `use()` reste
    // SYNCHRONE et chaînable dans tous les cas — pour un installer async, le paquet est donc « en
    // cours d'installation » entre l'appel et la résolution (une réutilisation du MÊME nom PENDANT
    // cette fenêtre n'est pas gardée — cf. commentaire ci-dessus, aucune machinerie de statut
    // "pending" ajoutée, hors mandat).
    use(pkg) {
      if (installedPackages.has(pkg.nom)) { log('warn', t('ws.core.paquet-deja-installe', { nom: pkg.nom })); return app }
      let r: unknown
      try { r = pkg.installer(app) }
      catch (err) { log('error', t('ws.core.installer-a-leve', { nom: pkg.nom }), { err }); throw err }
      if (r && typeof (r as any).then === 'function') {
        Promise.resolve(r as PromiseLike<unknown>).then(
          () => { installedPackages.add(pkg.nom) },
          (err) => { log('error', t('ws.core.installer-a-leve', { nom: pkg.nom }), { err }) },
        )
        return app
      }
      installedPackages.add(pkg.nom)
      return app
    },

    send(client, type, p) { schemaEngine.assertSendable(type); return sendRaw(client as MjsWsClientImpl, { t: type, p }) },

    sendUser(id, type, p) {
      // µschema — validée ICI, AVANT la boucle : un throw en mode 'binary' strict
      // doit être déterministe (« erreur de dev claire »), pas dépendre du hasard d'avoir ou non
      // une connexion LOCALE qui correspond à `id` (cf. commentaire de tête de schema.ts).
      schemaEngine.assertSendable(type)
      // gain de perf — MÊME primitive que broadcastLocal (cf. son commentaire) : un encodage,
      // partagé par toutes les connexions locales de cet utilisateur (multi-onglets compris).
      const frame = { t: type, p }
      const pre = preEncodeFrame(frame)
      if (pre) {
        for (const client of clientsById.values()) {
          if (client.state !== 'authenticated') continue
          if (peerIdOf(client) !== id) continue
          sendPre(client, frame, pre)
        }
      }
      // cluster — un autre process peut détenir d'autres connexions de ce user ;
      // no-op tant que clusterEngine n'est pas posé (opts.adapter absent), MÊME accroche que
      // le pont universel pour /send{user} (bridge.ts, ctx.publishSend)
      clusterEngine?.publishSend({ user: id }, type, p)
      return pre != null
    },

    broadcast(type, p, bOpts) {
      schemaEngine.assertSendable(type)   // MÊME raison que sendUser ci-dessus (déterministe, même sans destinataire)
      const exceptClients = !bOpts?.except ? [] : (Array.isArray(bOpts.except) ? bOpts.except : [bOpts.except])
      const ok = broadcastLocal(type, p, exceptClients.length > 0 ? new Set(exceptClients) : null)
      // ordre PRODUCTEUR (cluster) : LOCAL d'abord (ci-dessus), publication ensuite —
      // no-op tant que clusterEngine n'est pas posé (opts.adapter absent)
      clusterEngine?.publishBroadcast(type, p, exceptClients.flatMap(idsOfClient))
      return ok
    },

    // SUCRE — cf. son commentaire dans MjsWsApp ci-dessus : passe par `app.room()` (déclaré plus
    // bas dans ce même littéral, résolu par closure comme `use()` référence déjà `app`) — jamais un
    // accès direct à roomsEngine qui contournerait la validation µschema/publication cluster.
    sendTo(room, type, p) { app.room(room).send(room + '/' + type, p) },

    error(client, message) { sendError(client as MjsWsClientImpl, message) },

    room(name) {
      const handle = roomsEngine.room(name)
      const engine = clusterEngine
      // TOUJOURS enveloppé (auparavant : `if (!clusterEngine) return handle`, retour
      // direct SANS validation schéma) : .send()/.kick() appliquent LOCALEMENT (handle d'origine,
      // inchangé) PUIS publient si le cluster est actif — .clients/.size/.has restent des
      // ACCROCHES LIVES vers le handle d'origine (jamais un spread, qui figerait un instantané au
      // lieu de lire en direct — cf. le piège des getters copiés par {...obj}). Comportement
      // IDENTIQUE à avant quand `!engine` (publishRoomSend/publishRoomKick simplement sautés) —
      // seule la validation .send() est nouvelle, cf. schemaEngine.assertSendable.
      const wrapped: MjsWsRoomHandle = {
        send(type, p, sOpts) {
          schemaEngine.assertSendable(type)
          handle.send(type, p, sOpts)
          if (!engine) return
          const exceptClients = !sOpts?.except ? [] : (Array.isArray(sOpts.except) ? sOpts.except : [sOpts.except])
          engine.publishRoomSend(name, type, p, exceptClients.flatMap(idsOfClient))
        },
        get clients(): Iterable<MjsWsClient> { return handle.clients },
        get size(): number { return handle.size },
        has(client) { return handle.has(client) },
        kick(clientOrId, reason) {
          handle.kick(clientOrId, reason)
          if (!engine) return
          const target = typeof clientOrId === 'string' ? clientOrId : (clientOrId as MjsWsClient).id
          engine.publishRoomKick(name, target, reason)
        },
        // sucre (rooms.ts) — accroche MINIME requise par le contrat MjsWsRoomHandle
        // (TS refuserait `wrapped` sans elle) : PAS de publication cluster ici, l'historique reste
        // purement LOCAL, même limite déjà assumée pour stream().destroy() (cf. streams.ts/docs
        // 23 « destroy() »).
        history(n) { handle.history(n) },
      }
      return wrapped
    },

    schema(nom, champs) { schemaEngine.def(nom, champs) },

    stream(name, sOpts) { return streamsEngine.stream(name, sOpts) },

    // état/métriques (stats.ts) — TOUJOURS disponible, indépendant de opts.stats
    // (qui ne gouverne que l'exposition HTTP via le pont, cf. le bloc `if (opts.bridge)` plus
    // bas). Gauges salons/flux.nombre lues EN DIRECT ici — jamais stockées dans le registre.
    stats() {
      const snapshot = stats.snapshot({ salons: roomsEngine.statsSnapshot(), flux: streamsEngine.statsSnapshot() })
      // compteurs LOCAUX de l'adaptateur (ignoresOrigin/reconnexions) recopiés ICI,
      // au moment du snapshot, MÊME philosophie que les gauges salons/flux ci-dessus (jamais
      // accumulés à part dans le registre, jamais de drift avec la source — cf. adapterLocalCounters)
      const local = adapterLocalCounters(opts.adapter)
      snapshot.adaptateur.ignoresOrigin = local.ignoresOrigin
      snapshot.adaptateur.reconnexions  = local.reconnexions
      return snapshot
    },

    get clients(): Iterable<MjsWsClient> { return iterateClients() },

    async listen() {
      armProcessGuard()
      // APRÈS armProcessGuard, AVANT le transport : le chien de garde de systemd est armé dès l'instant
      // où l'unité démarre — attendre que l'écoute soit ouverte laisserait une fenêtre où personne ne
      // bat alors que le compte tourne déjà (mesuré : `WatchdogSec` court dès le `ExecStart`)
      systemdWatchdog = armWatchdog(log)
      transport.onConnection(acceptConnection)
      await transport.start()
    },

    async stop() {
      const all = Array.from(clientsById.values())
      // rendez-vous POSÉS avant tout dismiss (synchrone, aucun entrelacement possible d'ici la
      // fin de la boucle ci-dessous) — résolus depuis finalizeCleanup, qu'un client se ferme
      // SYNCHRONE (déjà parqué, cf. dismissClient) ou par le rappel ASYNCHRONE onClose du
      // transport (contrat MjsWsConnection.close(), jamais un retour de promesse, cf. transport.ts)
      const closings = all.map(client => new Promise<void>(resolve => { stopCloseWaiters.set(client, resolve) }))
      for (const client of all) dismissClient(client, undefined)
      // filet : toutes les sessions détruites, toutes les minuteries de grâce
      // coupées (chaque dismiss ci-dessus a déjà discard la sienne — ceci attrape le reste)
      sessionsEngine?.destroyAll()
      // suivi d'expiration du jeton — coupe le balayage global s'il a été armé
      if (tokenSweepTimer) { clearInterval(tokenSweepTimer); tokenSweepTimer = null }
      // laisse partir les µ:bye (microtask/IO du transport) avant de couper
      await new Promise<void>(resolve => setTimeout(resolve, 0))
      // attend les fermetures RÉELLES (webhook 'disconnect', purge salons/flux/
      // sessions déjà comprises dans finalizeCleanup), bornée par STOP_CLOSE_TIMEOUT_MS : ne
      // pend JAMAIS indéfiniment même si un onClose de transport traîne anormalement.
      await awaitBounded(closings, STOP_CLOSE_TIMEOUT_MS)
      disarmProcessGuard()
      systemdWatchdog?.stop()
      systemdWatchdog = null
      await transport.stop()
    },
  }

  // introspection de TEST uniquement (jamais un contrat public) — précédent : (app as any)._cluster/
  // _presence plus bas. INCONDITIONNEL ici (pas de garde opts.xxx : l'armement du balayage est
  // data-driven, cf. ensureTokenSweep) — expose une FONCTION (pas la valeur figée au moment de
  // cette ligne) : `tokenSweepTimer` est réassigné plus tard, un simple recopiage la verrait
  // toujours à `null`.
  ;(app as any)._tokenSweepArmed = () => tokenSweepTimer !== null

  // accroche binaire INTERNE (socle posé, câblée ICI au µschema) — champ NON
  // PUBLIC (absent de MjsWsApp) : décode via schemaEngine puis route EXACTEMENT comme un message
  // texte (bridgeEngine.notifyMessage + routeAppMessage, MÊME couple que handleRaw ci-dessus —
  // aucune 2e implémentation qui pourrait diverger) — app.on/serve reçoivent le résultat sans
  // jamais savoir qu'il est arrivé en binaire. `null` de decodeInbound = id inconnu/
  // trame corrompue, déjà comptée + signalée par schemaEngine — rien de plus à faire ici.
  ;(app as any)._binaryHandler = (client: MjsWsClient, bytes: Uint8Array): void | Promise<void> => {
    const decoded = schemaEngine.decodeInbound(client, bytes)
    if (!decoded) return
    bridgeEngine?.notifyMessage(decoded.t, decoded.p, client)
    // retournée (pas juste appelée) — handleBinaryRaw l'attend, cf. son commentaire (FIFO)
    return routeAppMessage(client as MjsWsClientImpl, { t: decoded.t, p: decoded.p })
  }

  // adaptateur multi-processus (adapter.ts) — opt-in via opts.adapter : PLACÉ AVANT le
  // pont (ordre LISTEN : transport → cluster → pont ; ordre STOP, LIFO : pont → cluster →
  // transport — le pont s'arrête d'ABORD pour ne plus accepter de requêtes qui déclencheraient
  // encore une publication pendant que le cluster se démonte). Les accroches roomsEngine/
  // streamsEngine/app.broadcast/app.room posées plus haut (optional chaining sur `clusterEngine`)
  // restent des no-op tant qu'on n'atteint pas cette ligne.
  if (opts.adapter) {
    const engine = createClusterEngine(opts.adapter, { app, roomsEngine, streamsEngine, broadcastLocal, onLog: log, stats, evictIdentity })
    clusterEngine = engine
    const baseListen = app.listen
    const baseStop   = app.stop
    app.listen = async () => { await baseListen(); await engine.start() }
    app.stop   = async () => { await engine.stop(); await baseStop() }
    // accroches de TEST uniquement (jamais un contrat public, cf. tests/mjs-ws-adapter.test.ts) —
    // _cluster.checkLeasesNow() force une vérification des baux distants sans attendre le cycle
    // ~3s réel ; _presence expose la présence FUSIONNÉE (rooms.ts) sans monter un pont HTTP
    // juste pour la lire en test (même précédent que `(transport as any)._clients` ailleurs).
    ;(app as any)._cluster  = engine
    ;(app as any)._presence = roomsEngine.presence
  }

  // pont universel (bridge.ts) — opt-in via opts.bridge : démarré par app.listen()
  // (APRÈS le transport ws), arrêté par app.stop() (AVANT le transport ws — LIFO). Les
  // accroches connect/disconnect/message/join/leave posées plus haut (optional chaining sur
  // `bridgeEngine`) restent des no-op tant qu'on n'atteint pas cette ligne.
  if (opts.bridge) {
    const engine = createBridge(opts.bridge, {
      app, presence: roomsEngine.presence, onLog: log,
      // cluster — SEUL /send a besoin de cette accroche dédiée (cf. bridge.ts,
      // MjsWsBridgeContext.publishSend) : /broadcast, /room/send, /room/kick et /stream
      // traversent déjà tout seuls (app.broadcast/room()/stream() cluster-aware à la source)
      publishSend: clusterEngine ? (target, type, p) => clusterEngine!.publishSend(target, type, p) : undefined,
      // état/métriques (stats.ts) — écriture (compteurs pont) ; lecture via app.stats()
      // (déjà dans `app` ci-dessus). statsEnabled gouverne UNIQUEMENT l'exposition HTTP (/stats,
      // /metrics, /state) — le registre, lui, tourne déjà (créé tout en haut de createCore).
      stats, statsEnabled: opts.stats,
    })
    bridgeEngine = engine
    const baseListen = app.listen
    const baseStop   = app.stop
    app.listen = async () => { await baseListen(); await engine.start() }
    app.stop   = async () => { await engine.stop(); await baseStop() }
  }

  return app
}

// ============================================================================================
// ADAPTATEUR MULTI-PROCESSUS — ce que core.ts fournit au cluster (lecture/écriture
// LOCALES) + ce que core.ts en attend (démarrage/arrêt + primitives de publication). AUCUNE
// connaissance de Redis ici — tout passe par MjsWsAdapter (adapter.ts), le mini-client RESP vit
// entièrement dans adapter-redis.ts. cf. docs/23-mjs-ws.md « Plusieurs processus » pour le guide
// vulgarisé (canaux, seq global, présence fusionnée, bail de vie, limite en cas de coupure).
// ============================================================================================

interface MjsWsClusterCtx {
  app: MjsWsApp
  roomsEngine: ReturnType<typeof createRoomsEngine>
  streamsEngine: ReturnType<typeof createStreamsEngine>
  /** diffusion LOCALE SEULE (cf. son commentaire dans createCore) — jamais app.broadcast (boucle) */
  broadcastLocal: (type: string, p: unknown, except: Set<MjsWsClient> | null) => void
  onLog: MjsWsLogFn
  /** état/métriques (stats.ts) — publies/recus comptés ICI (adapter.ts reste inchangé,
   *  ignoresOrigin/reconnexions non couverts ici, cf. docs/23-mjs-ws.md) */
  stats: MjsWsStatsRegistry
  /** session exclusive par identité — éviction LOCALE (vivantes +
   *  parquées, cf. core.ts::evictIdentity) : le canal identity:kick l'appelle avec `exceptId`
   *  `undefined` (aucun client local ne porte jamais l'id d'une connexion d'un AUTRE process).
   *  `parkedOnly` (correctif fuite cluster mode 'refuse') — propagé TEL QUEL depuis le message reçu
   *  sur le canal (cf. son champ dans MjsWsClusterEngine.publishIdentityKick) : `true` épargne
   *  toute connexion VIVANTE locale, jamais un mode 'replace' distant qui tuerait à tort la
   *  session gagnante d'un 'refuse' local. */
  evictIdentity: (identityId: string, exceptId: string | undefined, reason: string | undefined, parkedOnly?: boolean) => void
}

interface MjsWsClusterEngine {
  start(): Promise<void>
  stop(): Promise<void>
  publishBroadcast(type: string, p: unknown, exceptIds: string[]): void
  publishRoomSend(room: string, type: string, p: unknown, exceptIds: string[]): void
  publishRoomKick(room: string, target: string, reason: string | undefined): void
  publishSend(target: { client?: string; user?: string }, type: string, p: unknown): void
  allocateStreamSeq(name: string): Promise<number>
  publishStreamDelta(name: string, seq: number, p: Record<string, unknown>): void
  publishGlobalJoin(id: string, meta: unknown): void
  publishGlobalLeave(id: string): void
  publishRoomJoin(room: string, id: string, meta: unknown): void
  publishRoomLeave(room: string, id: string, meta: unknown): void
  /**
   * session exclusive par identité — MÊME patron que publishRoomKick :
   * dit aux AUTRES process d'éjecter localement les connexions/sessions de `identityId`.
   * `parkedOnly` (correctif fuite cluster mode 'refuse') — `false`/absent (mode 'replace') : les
   * AUTRES process éjectent TOUT (vivantes + parquées), comportement historique inchangé. `true`
   * (mode 'refuse') : les AUTRES process n'éjectent QUE leurs sessions parquées de cette identité —
   * une connexion VIVANTE distante n'est JAMAIS touchée (l'existant doit gagner, PARTOUT dans le
   * cluster, pas seulement sur le process qui a reçu le hello). Cf. evictIdentity, core.ts.
   */
  publishIdentityKick(identityId: string, reason: string | undefined, parkedOnly?: boolean): void
  /** force une vérification des baux distants MAINTENANT, hors du cycle ~3 s normal — TESTS seulement */
  checkLeasesNow(): Promise<void>
}

const CLUSTER_LEASE_TTL_S    = 10     // durée de vie du bail — cf. docs/23-mjs-ws.md « présence fusionnée »
const CLUSTER_LEASE_RENEW_MS = 3000   // renouvellement + vérification des pairs, même minuterie

function createClusterEngine(adapter: MjsWsAdapter, ctx: MjsWsClusterCtx): MjsWsClusterEngine {
  const prefix      = adapter.prefix
  const chBroadcast = `${prefix}:broadcast`
  const chRoomSend  = `${prefix}:room:send`
  const chRoomKick  = `${prefix}:room:kick`
  // session exclusive par identité — MÊME patron que chRoomKick juste
  // au-dessus (cf. docs/23-mjs-ws.md §8.5)
  const chIdentityKick = `${prefix}:identity:kick`
  const chSend      = `${prefix}:send`
  const chStream    = `${prefix}:stream`
  const chPresence  = `${prefix}:presence`
  const leasePrefix = `${prefix}:proc:`
  const leaseKey    = leasePrefix + adapter.processId
  let leaseTimer: ReturnType<typeof setInterval> | null = null

  // abonnements posés à la CONSTRUCTION (synchrone, avant même app.listen()) — pas à start() :
  // un setup(app) applicatif qui sème un flux AVANT listen() (cf. docs/23-mjs-ws.md §6.1, exemple
  // d'entry) doit voir sa mutation publiée dès le 1er coup, pas seulement APRÈS le boot complet.
  adapter.subscribe(chBroadcast, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { type: string; p: unknown; except: string[] }
    const except = m.except.length > 0 ? new Set(resolveClients(ctx.app, m.except)) : null
    ctx.broadcastLocal(m.type, m.p, except)
  })
  adapter.subscribe(chRoomSend, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { room: string; type: string; p: unknown; except: string[] }
    const except = m.except.length > 0 ? resolveClients(ctx.app, m.except) : []
    ctx.roomsEngine.room(m.room).send(m.type, m.p, except.length > 0 ? { except } : undefined)
  })
  adapter.subscribe(chRoomKick, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { room: string; target: string; reason?: string }
    ctx.roomsEngine.room(m.room).kick(m.target, m.reason)
  })
  // session exclusive par identité — `exceptId` undefined : aucun
  // client LOCAL ne porte jamais l'id d'une connexion d'un AUTRE process, rien à protéger ici
  // (cf. le commentaire d'evictIdentity, core.ts). `parkedOnly` (correctif fuite cluster mode
  // 'refuse') — propagé TEL QUEL, transparent : ce process ne décide RIEN, il applique fidèlement
  // ce que l'émetteur a demandé (cf. publishIdentityKick).
  adapter.subscribe(chIdentityKick, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { identityId: string; reason?: string; parkedOnly?: boolean }
    ctx.evictIdentity(m.identityId, undefined, m.reason, m.parkedOnly)
  })
  adapter.subscribe(chSend, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { client?: string; user?: string; type: string; p: unknown }
    const hasClient = m.client !== undefined
    for (const c of ctx.app.clients) {
      const hit = hasClient ? c.id === m.client : peerIdOf(c) === m.user
      if (!hit) continue
      ctx.app.send(c, m.type, m.p)
      if (hasClient) break   // id de connexion — au plus une correspondance possible (même règle que bridge.ts)
    }
  })
  adapter.subscribe(chStream, (msg) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { name: string; seq: number; p: Record<string, unknown> }
    ctx.streamsEngine.receiveRemote(m.name, m.seq, m.p)
  })
  adapter.subscribe(chPresence, (msg, origin) => {
    ctx.stats.adaptateur.recus++
    const m = msg as { room?: string; op: 'join' | 'leave'; id: string; meta?: unknown }
    ctx.roomsEngine.applyRemotePresence(m.room, origin, m.op, m.id, m.meta)
  })

  async function checkLeasesNow(): Promise<void> {
    try {
      const alive = new Set(await adapter.listLeases(leasePrefix))
      for (const pid of ctx.roomsEngine.remoteProcessIds()) {
        if (alive.has(leasePrefix + pid)) continue
        ctx.onLog('warn', t('ws.core.process-distant-bail-expire', { pid }))
        ctx.roomsEngine.purgeRemoteProcess(pid)
      }
    } catch (err) {
      ctx.onLog('warn', t('ws.core.verification-baux-echec', { err: errMessage(err) }))
    }
  }

  return {
    async start() {
      await adapter.start()
      await adapter.setLease(leaseKey, CLUSTER_LEASE_TTL_S)
      leaseTimer = setInterval(() => {
        void adapter.setLease(leaseKey, CLUSTER_LEASE_TTL_S).catch(err => ctx.onLog('warn', t('ws.core.renouvellement-bail-echec', { err: errMessage(err) })))
        void checkLeasesNow()
      }, CLUSTER_LEASE_RENEW_MS)
    },

    async stop() {
      if (leaseTimer) { clearInterval(leaseTimer); leaseTimer = null }
      try { await adapter.removeLease(leaseKey) } catch { /* best-effort — l'arrêt continue quand même */ }
      await adapter.stop()
    },

    publishBroadcast(type, p, exceptIds)                { ctx.stats.adaptateur.publies++; adapter.publish(chBroadcast, { type, p, except: exceptIds }) },
    publishRoomSend(room, type, p, exceptIds)           { ctx.stats.adaptateur.publies++; adapter.publish(chRoomSend, { room, type, p, except: exceptIds }) },
    publishRoomKick(room, target, reason)               { ctx.stats.adaptateur.publies++; adapter.publish(chRoomKick, { room, target, reason }) },
    publishIdentityKick(identityId, reason, parkedOnly) { ctx.stats.adaptateur.publies++; adapter.publish(chIdentityKick, { identityId, reason, parkedOnly }) },
    publishSend(target, type, p)                        { ctx.stats.adaptateur.publies++; adapter.publish(chSend, { client: target.client, user: target.user, type, p }) },
    allocateStreamSeq(name)                             { return adapter.incr(`${prefix}:seq:${name}`) },
    publishStreamDelta(name, seq, p)                    { ctx.stats.adaptateur.publies++; adapter.publish(chStream, { name, seq, p }) },
    publishGlobalJoin(id, meta)                         { ctx.stats.adaptateur.publies++; adapter.publish(chPresence, { room: undefined, op: 'join', id, meta }) },
    publishGlobalLeave(id)                              { ctx.stats.adaptateur.publies++; adapter.publish(chPresence, { room: undefined, op: 'leave', id }) },
    publishRoomJoin(room, id, meta)                     { ctx.stats.adaptateur.publies++; adapter.publish(chPresence, { room, op: 'join', id, meta }) },
    publishRoomLeave(room, id, _meta)                   { ctx.stats.adaptateur.publies++; adapter.publish(chPresence, { room, op: 'leave', id }) },
    checkLeasesNow,
  }
}
