// mjs-ws/transport — façade de transport : interface MjsWsTransport/MjsWsConnection
// (indépendante du protocole µ:) + MemoryTransport, une paire client/serveur
// 100% en mémoire pour les tests (aucun socket réseau réel). transport-ws.ts
// fournit l'implémentation par défaut (bibliothèque `ws`) derrière la MÊME
// interface — le cœur du protocole (core.ts) ne connaît QUE MjsWsTransport/
// MjsWsConnection, jamais `ws` directement (façade = transport interchangeable).
//
// Trames BINAIRES (câblées au moteur µschema) — représentation interne
// UNIQUE quel que soit le transport réel : `Uint8Array`, TOUJOURS une copie indépendante de tout
// buffer natif réutilisable par le transport (piège uWS documenté en tête de transport-uws.ts) —
// sûre à conserver au-delà du rappel `onMessage`, même après un `await`. Décodage : mjs-ws/schema.ts.
//
// SORTANT (µschema) — `MjsWsConnection.send` accepte `string | Uint8Array` : un `Uint8Array`
// part en trame WebSocket BINAIRE, une `string` en trame TEXTE, jamais d'ambiguïté (chaque
// transport concret détecte le type EXACTEMENT comme à la réception, cf. transport-ws.ts/
// transport-uws.ts). Le choix string-vs-Uint8Array est fait UNE fois, en amont (core.ts::sendRaw,
// via mjs-ws/schema.ts::encodeOutbound) — aucun transport ne re-décide quoi que ce soit.

import { t } from '../messages/index.js'

/** Origine + en-têtes de la requête d'upgrade, quand le transport les expose. */
export interface MjsWsRemoteInfo {
  origin?: string
  headers?: Record<string, string | string[] | undefined>
  /** IP distante (plafond de connexions PAR IP, cf. core.ts
   *  acceptConnection/MjsWsLimits.maxConnectionsPerIp) — absente pour un transport qui ne
   *  l'expose pas (MemoryTransport, harnais de test, cf. plus bas) : une IP `undefined` n'est
   *  JAMAIS comptée ni limitée par le plafond par IP (seul le plafond GLOBAL peut encore
   *  s'appliquer). Posée par transport-ws.ts (req.socket.remoteAddress) et transport-uws.ts
   *  (res.getRemoteAddressAsText(), pendant la fenêtre `upgrade`). Toujours déjà normalisée par
   *  normalizeRemoteAddress() ci-dessous — jamais une forme IPv4-mappée brute. */
  address?: string
}

// une connexion IPv4 sur un bind DUAL-STACK (host par défaut)
// arrive systématiquement sous forme IPv4-MAPPÉE (« ::ffff:a.b.c.d ») côté `remoteAddress`/
// `getRemoteAddressAsText()` — jamais sous sa forme nue. Sans normalisation, le plafond PAR IP
// (core.ts, clé de `connectionsByIp`) pourrait traiter différemment la MÊME IPv4 selon le transport
// ('ws'/'uws') ou l'API réseau sous-jacente. Retire UNIQUEMENT ce préfixe — une adresse IPv6
// NATIVE (`::1`, `2001:db8::1`…) n'est jamais réécrite, ce n'est PAS la « même » IP qu'une IPv4 au
// sens réseau (un attaquant multipliant les adresses littérales d'un préfixe IPv6
// routé reste un risque DISTINCT, non traité ici). Seul point d'appel légitime : transport-ws.ts/
// transport-uws.ts, à la source — jamais recanonisée plus loin (core.ts consomme déjà la forme finale).
const IPV4_MAPPED_PREFIX = '::ffff:'
export function normalizeRemoteAddress(address: string | undefined): string | undefined {
  if (address === undefined) return undefined
  return address.toLowerCase().indexOf(IPV4_MAPPED_PREFIX) === 0 ? address.slice(IPV4_MAPPED_PREFIX.length) : address
}

/** Une connexion unique, côté serveur — quel que soit le transport réel. */
export interface MjsWsConnection {
  readonly bufferedAmount: number
  readonly remoteInfo: MjsWsRemoteInfo
  /** `string` = trame texte (JSON) ; `Uint8Array` = trame BINAIRE (µschema) */
  send(data: string | Uint8Array): void
  close(code?: number, reason?: string): void
  /** `string` = trame texte (JSON attendu par le protocole µ:) ; `Uint8Array` = trame BINAIRE
   *  normalisée (cf. commentaire de tête) — jamais les deux à la fois, jamais autre chose. */
  onMessage: ((data: string | Uint8Array) => void) | null
  onClose: ((code: number, reason: string) => void) | null
}

/** Un transport accepte des connexions et les remonte au cœur du protocole. */
export interface MjsWsTransport {
  onConnection(handler: (conn: MjsWsConnection) => void): void
  start(): Promise<void>
  stop(): Promise<void>
}

// ----------------------------------------------------------------------------
// MemoryTransport — paire client/serveur en mémoire, pour les tests
// ----------------------------------------------------------------------------
// `connect()` fabrique une paire : le faux WebSocket rendu (readyState/send/
// close/onopen/onmessage/onclose) est branchable TEL QUEL sur le vrai client
// µ.socket (`globalThis.WebSocket = (url) => memTransport.connect({url})`), et
// le bout serveur (MjsWsConnection) part vers le handler enregistré via
// onConnection(). Livraison ASYNCHRONE (queueMicrotask) des deux côtés, comme
// un vrai WebSocket — jamais de callback synchrone depuis send()/close(), pour
// ne pas masquer les bugs d'ordonnancement que l'async révélerait en vrai.

export interface MemoryTransportConnectOpts {
  url?: string
  protocols?: string | string[]
  origin?: string
  headers?: Record<string, string | string[] | undefined>
}

/** Faux WebSocket CLIENT — même surface que le WebSocket natif attendu par mjs_socket.ts. */
export class MemoryClientSocket {
  static readonly CONNECTING = 0
  static readonly OPEN       = 1
  static readonly CLOSING    = 2
  static readonly CLOSED     = 3

  readyState = MemoryClientSocket.CONNECTING
  bufferedAmount = 0
  url: string
  protocol: string
  onopen: (() => void) | null = null
  /** `data` élargi à Uint8Array (µschema) — le VRAI client µ.socket décode aussi bien
   *  le binaire que le texte (mjs_schema.ts) ; un test qui simule une trame binaire
   *  ENTRANTE côté client (serveur → faux client) inspecte `ev.data` directement, cf.
   *  tests/mjs-ws-schema.test.ts. */
  onmessage: ((ev: { data: string | Uint8Array }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  private _server: MemoryServerConnection | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url      = url
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '')
  }

  /** appelé par MemoryTransport juste après construction — relie le pair serveur */
  _bindServer(server: MemoryServerConnection): void { this._server = server }

  _open(): void {
    if (this.readyState !== MemoryClientSocket.CONNECTING) return
    this.readyState = MemoryClientSocket.OPEN
    if (this.onopen) this.onopen()
  }

  // `data` accepte aussi un Uint8Array — UNIQUEMENT pour les tests qui simulent une
  // trame binaire directement sur ce faux socket : le VRAI client µ.socket n'envoie que du texte
  // (JSON.stringify), ce paramètre élargi ne change donc rien pour lui (string reste toujours accepté).
  send(data: string | Uint8Array): void {
    if (this.readyState !== MemoryClientSocket.OPEN) throw new Error(t('ws.transport.send-non-ouvert'))
    const server = this._server
    queueMicrotask(() => { if (server) server._receiveFromClient(data) })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === MemoryClientSocket.CLOSED) return
    this.readyState = MemoryClientSocket.CLOSED
    if (this.onclose) this.onclose({ code, reason })
    const server = this._server
    queueMicrotask(() => { if (server) server._receiveClientClose(code, reason) })
  }

  /** appelé par le pair serveur quand LUI ferme (conn.close() côté core/guard) */
  _receiveServerClose(code: number, reason: string): void {
    if (this.readyState === MemoryClientSocket.CLOSED) return
    this.readyState = MemoryClientSocket.CLOSED
    if (this.onclose) this.onclose({ code, reason })
  }
}

/** Bout SERVEUR d'une paire mémoire — implémente MjsWsConnection. */
class MemoryServerConnection implements MjsWsConnection {
  bufferedAmount = 0
  onMessage: ((data: string | Uint8Array) => void) | null = null
  onClose: ((code: number, reason: string) => void) | null = null

  private _closed = false

  constructor(private _client: MemoryClientSocket, public readonly remoteInfo: MjsWsRemoteInfo) {}

  send(data: string | Uint8Array): void {
    if (this._closed) return
    const client = this._client
    queueMicrotask(() => {
      if (client.readyState === MemoryClientSocket.OPEN && client.onmessage) client.onmessage({ data })
    })
  }

  close(code = 1000, reason = ''): void {
    if (this._closed) return
    this._closed = true
    const client = this._client
    queueMicrotask(() => {
      client._receiveServerClose(code, reason)
      if (this.onClose) this.onClose(code, reason)
    })
  }

  /** appelé par le pair CLIENT quand LUI ferme (ou se déconnecte) */
  _receiveClientClose(code: number, reason: string): void {
    if (this._closed) return
    this._closed = true
    if (this.onClose) this.onClose(code, reason)
  }

  _receiveFromClient(data: string | Uint8Array): void {
    if (this._closed) return
    if (this.onMessage) this.onMessage(data)
  }
}

export class MemoryTransport implements MjsWsTransport {
  private _handler: ((conn: MjsWsConnection) => void) | null = null
  private _started = false
  private _clients: MemoryClientSocket[] = []

  onConnection(handler: (conn: MjsWsConnection) => void): void { this._handler = handler }

  async start(): Promise<void> { this._started = true }

  async stop(): Promise<void> {
    this._started = false
    const clients = this._clients
    this._clients = []
    for (const c of clients) c.close(1001, t('ws.transport.arrete'))
  }

  /**
   * Fabrique une paire client/serveur et retourne le faux WebSocket CLIENT — à
   * assigner à `globalThis.WebSocket` (ou instancier directement) pour brancher
   * le vrai client µ.socket dessus. Le bout serveur part vers le handler
   * onConnection() de manière asynchrone (microtask), comme une vraie ouverture
   * réseau — puis le client reçoit son `onopen`.
   */
  connect(opts: MemoryTransportConnectOpts = {}): MemoryClientSocket {
    if (!this._started) throw new Error(t('ws.transport.connect-avant-start'))
    const client = new MemoryClientSocket(opts.url ?? 'memory://mjs-ws', opts.protocols)
    // `address` jamais posée ICI — harnais de test, aucune IP réelle à
    // exposer : cf. le commentaire de MjsWsRemoteInfo.address (jamais comptée/limitée par IP).
    const remoteInfo: MjsWsRemoteInfo = { origin: opts.origin, headers: opts.headers }
    const server = new MemoryServerConnection(client, remoteInfo)
    client._bindServer(server)
    this._clients.push(client)
    queueMicrotask(() => {
      if (this._handler) this._handler(server)
      client._open()
    })
    return client
  }
}
