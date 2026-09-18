// mjs-ws/adapter-redis — implémentation RÉELLE de MjsWsAdapter sur un mini-client
// Redis RESP écrit À LA MAIN, node:net + node:crypto SEULS (ZÉRO dépendance npm — pas de
// paquet `redis`/`ioredis`). Deux connexions séparées, comme Redis l'exige : `_sub` (dédiée
// SUBSCRIBE + réception des push `message`), `_cmd` (PING/PUBLISH/INCR/DEL/SET EX/GET/KEYS —
// une connexion en mode abonné ne peut plus parler qu'un sous-ensemble de commandes). Chacune
// reconnecte seule, à backoff (1/2/5/10 s), et re-déclare ses abonnements après une reconnexion
// (Redis oublie l'état d'abonnement d'une connexion qui tombe). AUCUN import dynamique ici —
// node:net/node:crypto sont des builtins Node, jamais « absents » comme le paquet optionnel
// `ws` (cf. transport-ws.ts) : la paresse porte sur la CONNEXION (aucun socket ouvert avant
// `.start()`), pas sur le chargement du module.
//
// PROTOCOLE RESP (Redis Serialization Protocol) — lignes CRLF, encodage des commandes en
// tableau de chaînes « bulk » (`*N\r\n$len\r\n texte \r\n …`), réponses en 5 types : simple
// string (+), erreur (-), entier (:), bulk string ($, `$-1` = null), tableau (*, `*-1` =
// null, imbriqué pour les push `message`/`subscribe`). `RespParser` est un parseur INCRÉMENTAL
// (méthode `push(chunk)` ajoutée au tampon, extrait toutes les valeurs COMPLÈTES disponibles,
// garde le reliquat pour le prochain chunk) — une trame Redis peut arriver coupée en plein
// milieu sur `data` (TCP ne connaît pas les limites de message), jamais supposé complet d'un coup.

import { connect as netConnect, type Socket } from 'node:net'
import { randomBytes } from 'node:crypto'
import { errMessage } from './guard.js'
import type { MjsWsAdapter, MjsWsAdapterHandler } from './adapter.js'
import type { MjsWsLogFn } from './core.js'
import { t } from '../messages/index.js'

// --- RESP : encodage des commandes -----------------------------------------------------------

// exportée — testée en unité (tests/mjs-ws-adapter-redis.test.ts), SANS Redis vivant
export function encodeCommand(args: Array<string | number>): string {
  let out = `*${args.length}\r\n`
  for (const a of args) {
    const s = String(a)
    out += `$${Buffer.byteLength(s, 'utf8')}\r\n${s}\r\n`
  }
  return out
}

// --- RESP : décodage incrémental -------------------------------------------------------------

/** réponse d'erreur Redis (`-ERR …`) — distincte d'une simple string, jamais confondue avec une valeur */
export class RespError {
  constructor(public message: string) {}
}

export type RespValue = string | number | null | RespValue[] | RespError

interface ParseStep { value: RespValue; next: number }

// récursif — une ligne d'en-tête (`+`/`-`/`:`/`$`/`*`) DOIT être entièrement présente pour
// avancer ; `$`/`*` ont en plus besoin de leur CORPS (peut arriver dans un AUTRE chunk TCP) —
// retourne `null` (jamais une exception) tant que le tampon ne contient pas une valeur COMPLÈTE.
function tryParseOne(buf: Buffer, offset: number): ParseStep | null {
  if (offset >= buf.length) return null
  const type = buf[offset]
  const lineEnd = buf.indexOf('\r\n', offset + 1)
  if (lineEnd === -1) return null
  const line = buf.toString('utf8', offset + 1, lineEnd)
  const afterLine = lineEnd + 2

  if (type === 0x2b) return { value: line, next: afterLine }              // '+' simple string
  if (type === 0x2d) return { value: new RespError(line), next: afterLine } // '-' erreur
  if (type === 0x3a) {   // ':' entier — peut légitimement être négatif (DECR), jamais NaN
    const n = parseInt(line, 10)
    if (!Number.isFinite(n)) throw new Error(t('ws.adapter-redis.entier-invalide', { line }))
    return { value: n, next: afterLine }
  }

  if (type === 0x24) {   // '$' bulk string
    const len = parseInt(line, 10)
    if (len === -1) return { value: null, next: afterLine }
    // longueur non-numérique (NaN) NON gardée : `need`/`toString`/`subarray` coercent tous NaN
    // en 0 (vérifié empiriquement) → `buf.length < need` vaut TOUJOURS false (NaN) → la valeur
    // est renvoyée SANS jamais consommer le tampon (`next` lui aussi NaN→0) → boucle infinie
    // dans push() (event loop entièrement bloqué, tout le process gelé — pas juste l'adaptateur)
    // à la première longueur bulk mal formée reçue du pair Redis. Prouvé par repro.
    if (!Number.isFinite(len) || len < 0) throw new Error(t('ws.adapter-redis.longueur-bulk-invalide', { line }))
    const need = afterLine + len + 2
    if (buf.length < need) return null
    return { value: buf.toString('utf8', afterLine, afterLine + len), next: need }
  }

  if (type === 0x2a) {   // '*' tableau (imbriqué — push SUBSCRIBE/message)
    const n = parseInt(line, 10)
    if (n === -1) return { value: null, next: afterLine }
    if (!Number.isFinite(n) || n < 0) throw new Error(t('ws.adapter-redis.longueur-tableau-invalide', { line }))
    const items: RespValue[] = []
    let cursor = afterLine
    for (let i = 0; i < n; i++) {
      const sub = tryParseOne(buf, cursor)
      if (!sub) return null   // élément pas encore complet — attend la suite du tableau aussi
      items.push(sub.value)
      cursor = sub.next
    }
    return { value: items, next: cursor }
  }

  throw new Error(t('ws.adapter-redis.octet-inattendu', { hex: type.toString(16) }))
}

/** parseur incrémental — `push(chunk)` retourne les valeurs COMPLÈTES désormais disponibles */
export class RespParser {
  private _buf: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): RespValue[] {
    this._buf = this._buf.length === 0 ? chunk : Buffer.concat([this._buf, chunk])
    const out: RespValue[] = []
    for (;;) {
      const step = tryParseOne(this._buf, 0)
      if (!step) break
      out.push(step.value)
      this._buf = this._buf.subarray(step.next)
    }
    return out
  }
}

// --- redis:// — parsing d'URL (host, port, mot de passe, base) ------------------------------

export interface ParsedRedisUrl {
  host: string
  port: number
  password?: string
  db?: number
}

/** parse `redis://[[:motDePasse]@]hôte[:port][/base]` (`rediss://` accepté, TLS non câblé ici) */
export function parseRedisUrl(raw: string): ParsedRedisUrl {
  let u: URL
  try { u = new URL(raw) }
  catch { throw new Error(t('ws.adapter-redis.url-invalide', { raw })) }
  if (u.protocol !== 'redis:' && u.protocol !== 'rediss:') {
    throw new Error(t('ws.adapter-redis.url-schema-invalide', { raw, protocol: u.protocol }))
  }
  const host     = u.hostname || '127.0.0.1'
  const port     = u.port ? parseInt(u.port, 10) : 6379
  const password = u.password ? decodeURIComponent(u.password) : undefined
  const path     = u.pathname.replace(/^\//, '')
  let db: number | undefined
  if (path !== '') {
    const n = parseInt(path, 10)
    if (!Number.isFinite(n) || String(n) !== path) throw new Error(t('ws.adapter-redis.url-base-invalide', { raw, path }))
    db = n
  }
  return { host, port, password, db }
}

// --- une connexion Redis (rôle 'command' OU 'subscriber') — reconnecte seule, à backoff -----

// exportés — testés en unité (tests/mjs-ws-adapter-redis.test.ts) SANS socket ni Redis vivant :
// `backoffDelayMs` est le plan de reconnexion en PUR (aucun timer, aucun I/O) — la Ne tentative
// (0-indexée) attend `RECONNECT_BACKOFF_MS[min(n, longueur-1)]` ms, palier au dernier au-delà.
export const RECONNECT_BACKOFF_MS = [1000, 2000, 5000, 10000]
export function backoffDelayMs(attempt: number): number {
  return RECONNECT_BACKOFF_MS[Math.min(attempt, RECONNECT_BACKOFF_MS.length - 1)]
}

type RedisConnRole = 'command' | 'subscriber'

interface RedisConnOpts {
  host: string
  port: number
  password?: string
  db?: number
  role: RedisConnRole
  onLog: MjsWsLogFn
  /** rappelée à CHAQUE connexion réussie (post AUTH/SELECT) — sert à re-PING/re-SUBSCRIBE */
  onConnected: () => void
  /** rôle 'subscriber' SEULEMENT — un push `message {canal, corps}` reçu */
  onMessage?: (channel: string, body: string) => void
}

interface PendingReply { resolve: (v: RespValue) => void; reject: (err: Error) => void }

/** encapsule UN socket Redis (commandes FIFO OU flux d'abonné) — jamais les deux rôles mélangés.
 *  export SIGNALÉ — réutilisée telle quelle par mjs-server/persist-redis.ts (rôle
 *  'command' seul, HSET/HDEL/HGETALL), AUCUNE autre modification de ce fichier. */
export class RedisConnection {
  private _socket: Socket | null = null
  private _parser = new RespParser()
  private _pending: PendingReply[] = []
  private _backoffAttempt = 0
  private _stopped = false
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private _ready = false   // AUTH/SELECT terminés — cf. le getter ready ci-dessous
  private _everConnected = false   // posé APRÈS la 1re réussite — distingue 1re connexion / reconnexion
  private _reconnectCount = 0

  constructor(private _opts: RedisConnOpts) {}

  // `true` seulement APRÈS AUTH/SELECT (pas juste « socket ouvert ») — RedisAdapter.subscribe()
  // s'en sert pour éviter un envoi voué à l'échec avant start() (cf. son commentaire).
  get ready(): boolean { return this._ready }
  /** reconnexions RÉUSSIES cumulées sur CETTE connexion (jamais la 1re) — cf. RedisAdapter.reconnexions */
  get reconnectCount(): number { return this._reconnectCount }

  connect(): void { this._open() }

  private _open(): void {
    if (this._stopped) return
    const socket = netConnect({ host: this._opts.host, port: this._opts.port })
    this._socket = socket
    socket.on('connect', () => { void this._onSocketConnected() })
    socket.on('data', (chunk: Buffer) => this._onData(chunk))
    socket.on('error', (err) => this._opts.onLog('warn', `[mjs-ws/adapter-redis] erreur socket (${this._opts.role}) : ${errMessage(err)}`))
    socket.on('close', () => this._onClose())
  }

  private async _onSocketConnected(): Promise<void> {
    this._backoffAttempt = 0
    try {
      if (this._opts.password) await this._raw(['AUTH', this._opts.password])
      if (this._opts.db != null) await this._raw(['SELECT', String(this._opts.db)])
      // compteur reconnexions — la 2e réussite ou plus est une VRAIE reconnexion,
      // jamais la 1re connexion initiale (cf. _everConnected, posé une fois pour toutes ensuite)
      if (this._everConnected) this._reconnectCount++
      this._everConnected = true
      this._ready = true
      this._opts.onConnected()
    } catch (err) {
      this._opts.onLog('error', t('ws.adapter-redis.auth-echec', { role: this._opts.role, err: errMessage(err) }))
    }
  }

  private _onData(chunk: Buffer): void {
    // `push()` peut lever sur un flux RESP corrompu (longueur non-numérique, octet de type
    // inattendu — cf. tryParseOne) : SANS ce filet, l'exception traverserait cet écouteur
    // 'data' sans jamais être rattrapée → exception non gérée → CRASH DU PROCESS ENTIER (pas
    // seulement de l'adaptateur), pour un simple hoquet protocole (proxy Redis non standard,
    // RESP3 inattendu, coupure en plein milieu d'une trame suivie d'un désync). On traite ça
    // comme n'importe quelle perte de connexion : destroy() déclenche 'close' → le cycle de
    // reconnexion à backoff DÉJÀ EN PLACE (_onClose) prend le relais, rien à réinventer ici.
    let values: RespValue[]
    try { values = this._parser.push(chunk) }
    catch (err) {
      this._opts.onLog('error', t('ws.adapter-redis.flux-corrompu', { role: this._opts.role, err: errMessage(err) }))
      this._socket?.destroy()
      return
    }
    for (const v of values) this._onValue(v)
  }

  private _onValue(v: RespValue): void {
    // rôle 'subscriber' — `message {canal, corps}` est un PUSH non sollicité (jamais une
    // réponse à une commande en attente) ; `subscribe`/`unsubscribe` sont des confirmations,
    // ignorées (subscribe() de l'adaptateur est synchrone, cf. adapter.ts — rien ne les attend).
    if (this._opts.role === 'subscriber' && Array.isArray(v)) {
      if (v[0] === 'message') { this._opts.onMessage?.(String(v[1]), String(v[2])); return }
      if (v[0] === 'subscribe' || v[0] === 'unsubscribe') return
    }
    const pending = this._pending.shift()
    if (!pending) return
    if (v instanceof RespError) pending.reject(new Error(v.message))
    else pending.resolve(v)
  }

  private _onClose(): void {
    this._socket = null
    this._ready  = false
    const err = new Error(t('ws.adapter-redis.connexion-perdue', { role: this._opts.role }))
    for (const p of this._pending.splice(0)) p.reject(err)
    if (this._stopped) return
    const delay = backoffDelayMs(this._backoffAttempt)
    this._backoffAttempt++
    this._opts.onLog('warn', t('ws.adapter-redis.reconnexion-backoff', { role: this._opts.role, delay }))
    this._reconnectTimer = setTimeout(() => { this._reconnectTimer = null; this._open() }, delay)
  }

  /** commande FIFO — résout/rejette dans l'ORDRE de réception (Redis répond dans l'ordre des requêtes) */
  private _raw(args: Array<string | number>): Promise<RespValue> {
    return new Promise((resolve, reject) => {
      if (!this._socket) { reject(new Error(t('ws.adapter-redis.connexion-indisponible', { role: this._opts.role }))); return }
      this._pending.push({ resolve, reject })
      this._socket.write(encodeCommand(args))
    })
  }

  send(args: Array<string | number>): Promise<RespValue> { return this._raw(args) }

  stop(): void {
    this._stopped = true
    if (this._reconnectTimer) { clearTimeout(this._reconnectTimer); this._reconnectTimer = null }
    if (this._socket) { this._socket.destroy(); this._socket = null }
    const err = new Error(t('ws.adapter-redis.adaptateur-arrete', { role: this._opts.role }))
    for (const p of this._pending.splice(0)) p.reject(err)
  }
}

// --- RedisAdapter — MjsWsAdapter sur les deux connexions ci-dessus --------------------------

export interface RedisAdapterOpts {
  /** redis://[[:motDePasse]@]hôte[:port][/base] */
  url: string
  /** espace de noms des canaux/clés — défaut 'mjs-ws' */
  prefix?: string
  onLog?: MjsWsLogFn
}

export class RedisAdapter implements MjsWsAdapter {
  readonly processId: string
  readonly prefix: string
  private _onLog: MjsWsLogFn
  private _cmd: RedisConnection
  private _sub: RedisConnection
  private _handlers = new Map<string, Set<MjsWsAdapterHandler>>()
  private _ignoresOrigin = 0   // cf. le getter ignoresOrigin ci-dessous pour le détail/la limite

  constructor(opts: RedisAdapterOpts) {
    this.processId = randomBytes(8).toString('hex')
    this.prefix    = opts.prefix ?? 'mjs-ws'
    this._onLog    = opts.onLog ?? (() => {})
    const parsed   = parseRedisUrl(opts.url)
    const shared   = { host: parsed.host, port: parsed.port, password: parsed.password, db: parsed.db, onLog: this._onLog }
    this._cmd = new RedisConnection({ ...shared, role: 'command', onConnected: () => {} })
    this._sub = new RedisConnection({
      ...shared, role: 'subscriber',
      // reconnexion (initiale ou après coupure) : Redis a OUBLIÉ nos abonnements côté
      // connexion neuve — on les repose tous depuis notre propre registre (source de vérité).
      onConnected: () => { for (const channel of this._handlers.keys()) this._sub.send(['SUBSCRIBE', channel]).catch(() => {}) },
      onMessage: (channel, body) => this._deliver(channel, body),
    })
  }

  // compteurs LOCAUX — ignoresOrigin (skip-self pub/sub, cf. _deliver ci-dessous)
  // + reconnexions (reconnexion RÉUSSIE du mini-client RESP, cumul _cmd+_sub, cf.
  // RedisConnection._onSocketConnected/.reconnectCount) : MÊMES familles que
  // MjsWsStatsAdaptateur (stats.ts), mais PAS ENCORE branchées sur le registre app-wide
  // (ctx.stats.adaptateur, core.ts createClusterEngine) — ce câblage exigerait de faire
  // transiter le registre jusqu'à RedisAdapterOpts (core.ts/index.ts,
  // cf. docs/23-mjs-ws.md « L'état du serveur »). Lisibles dès maintenant en DIRECT
  // sur l'instance (adapter.ignoresOrigin/.reconnexions) — suivi : à brancher dans
  // createClusterEngine plus tard.
  get ignoresOrigin(): number { return this._ignoresOrigin }
  get reconnexions(): number { return this._cmd.reconnectCount + this._sub.reconnectCount }

  private _deliver(channel: string, body: string): void {
    let envelope: { origin?: string; payload?: unknown } | null = null
    try { envelope = JSON.parse(body) }
    catch { this._onLog('warn', t('ws.adapter-redis.message-non-json', { channel })); return }
    if (!envelope || typeof envelope.origin !== 'string') return
    if (envelope.origin === this.processId) { this._ignoresOrigin++; return }   // jamais ses propres messages (écho pub/sub) — compté
    const hs = this._handlers.get(channel)
    if (!hs) return
    for (const h of hs) h(envelope.payload, envelope.origin)
  }

  async start(): Promise<void> {
    this._cmd.connect()
    this._sub.connect()
    await this._cmd.send(['PING'])   // confirme AUTH/SELECT + une connexion RÉELLEMENT vivante
  }

  async stop(): Promise<void> {
    this._cmd.stop()
    this._sub.stop()
  }

  publish(channel: string, message: unknown): void {
    const body = JSON.stringify({ origin: this.processId, payload: message })
    // fire-and-forget — un échec (coupure en cours) est un warn, jamais bloquant (cf. docs/23-mjs-ws.md §10.7)
    this._cmd.send(['PUBLISH', channel, body]).catch(err => this._onLog('warn', t('ws.adapter-redis.publish-echec', { channel, err: errMessage(err) })))
  }

  subscribe(channel: string, handler: MjsWsAdapterHandler): void {
    let hs = this._handlers.get(channel)
    const isNew = !hs
    if (!hs) { hs = new Set(); this._handlers.set(channel, hs) }
    hs.add(handler)
    // enregistré dans this._handlers dans tous les cas (source de vérité pour le rattrapage
    // onConnected, cf. le constructeur) — l'envoi IMMÉDIAT n'est tenté que si la connexion est
    // DÉJÀ prête : core.ts abonne les canaux à la CONSTRUCTION du cluster engine, AVANT même
    // que start() ait ouvert le socket (cf. son commentaire, setup() doit voir ses seeds
    // propagées dès le 1er coup) — sans cette garde, c'est un avertissement systématique et
    // sans conséquence à CHAQUE démarrage normal (onConnected rattrape de toute façon).
    if (isNew && this._sub.ready) {
      this._sub.send(['SUBSCRIBE', channel]).catch(err => this._onLog('warn', t('ws.adapter-redis.subscribe-echec', { channel, err: errMessage(err) })))
    }
  }

  async incr(key: string): Promise<number> {
    const v = await this._cmd.send(['INCR', key])
    return Number(v)
  }

  async setLease(key: string, ttlSeconds: number): Promise<void> {
    await this._cmd.send(['SET', key, '1', 'EX', String(ttlSeconds)])
  }

  async removeLease(key: string): Promise<void> {
    await this._cmd.send(['DEL', key])
  }

  async listLeases(prefix: string): Promise<string[]> {
    const v = await this._cmd.send(['KEYS', prefix + '*'])
    return Array.isArray(v) ? v.map(String) : []
  }
}
