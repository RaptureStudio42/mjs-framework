// mjs-ws/transport-ws — adaptateur MjsWsTransport sur la bibliothèque `ws`
// (transport par défaut de mjsWs(), utilisé si aucun `transport` custom n'est
// fourni). Import PARESSEUX de `ws` (dynamic import() dans start(), jamais en
// tête de fichier) : charger ce module — voire tout le paquet MJS-WS — sans
// jamais appeler .listen() avec le transport par défaut (ex. tests sous
// MemoryTransport) ne touche donc PAS au paquet `ws`. `ws` est déjà une
// dépendance de ModularJS (package.json), rien à installer.

import type { IncomingMessage } from 'node:http'
import type { WebSocket as WsSocket, WebSocketServer as WsServer } from 'ws'
import type { MjsWsConnection, MjsWsRemoteInfo, MjsWsTransport } from './transport.js'
import { normalizeRemoteAddress } from './transport.js'
import { t } from '../messages/index.js'

export interface WsTransportOpts {
  port?: number
  host?: string
  /** Taille max d'une trame, en octets — mjsWs() y câble `limits.maxPayload` (défaut 65536, cf.
   *  index.ts DEFAULT_LIMITS). SANS ce réglage, `ws` retombe sur SON propre défaut (100 Mo, cf.
   *  node_modules/ws/lib/websocket-server.js) — bien AU-DELÀ de ce que core.ts croit garantir : le
   *  garde-fou applicatif (core.ts, `Buffer.byteLength(raw) > opts.limits.maxPayload`) n'agit
   *  qu'APRÈS réassemblage complet de la trame (allocation déjà faite) — `maxPayload` posé ICI
   *  coupe, LUI, PENDANT la réception (Receiver.haveLength, code de fermeture 1009 natif), même
   *  garantie que transport-uws.ts (maxPayloadLength). */
  maxPayload?: number
}

// défaut aligné sur DEFAULT_LIMITS.maxPayload (index.ts) — dupliqué ici en LITTÉRAL pour ne pas
// créer de dépendance circulaire (index.ts importe ce fichier), MÊME patron que transport-uws.ts
// (DEFAULT_MAX_PAYLOAD) : mjsWs() passe de toute façon limits.maxPayload RÉSOLU à chaque
// construction via resolveTransport() — ce défaut ne joue qu'en usage STANDALONE (`new
// WsTransport()` hors mjsWs(), ex. tests). PIÈGE évité en gardant `?? DEFAULT_MAX_PAYLOAD` (jamais
// `maxPayload: this._opts.maxPayload` tel quel) : un objet littéral `{ maxPayload: undefined }`
// passé à `new WebSocketServer()` ÉCRASE le défaut interne de `ws` (100 Mo) avec `undefined` — la
// clé PRÉSENTE (même valant `undefined`) gagne sur le spread des défauts internes de la lib, qui
// coerce ensuite en 0 côté Receiver (`options.maxPayload | 0`) = AUCUNE limite, pire que le bug
// d'origine. Vérifié en direct contre node_modules/ws (8.20.0).
const DEFAULT_MAX_PAYLOAD = 65536

// mémoïsé : un seul import() réel même si plusieurs WsTransport démarrent dans le même process
let wsModulePromise: Promise<typeof import('ws')> | null = null
function loadWs(): Promise<typeof import('ws')> {
  if (!wsModulePromise) {
    // `import('ws')` échoue en un message Node brut et cryptique ("Cannot find
    // package 'ws'…") si le paquet est absent (install partielle/pruning) — `ws`
    // est une dependency normale de mjs-framework (jamais à installer à part en
    // usage courant), mais `mjs ws` (cli/ws.ts) reste le PREMIER point qui charge
    // vraiment ce module (import paresseux, cf. commentaire de tête) : c'est ICI,
    // et ICI SEULEMENT, que l'absence se révèle — message clair, en français.
    wsModulePromise = import('ws').catch((err) => {
      throw new Error(t('ws.transport-ws.paquet-requis'), { cause: err })
    })
  }
  return wsModulePromise
}

// valeur standard du readyState "ouvert" (spec WebSocket, navigateur ET `ws`) —
// évite d'attendre le chargement paresseux juste pour lire une constante
const READY_STATE_OPEN = 1

// borne de stop() — MÊME esprit que STOP_CLOSE_TIMEOUT_MS (core.ts) :
// une valeur locale plutôt qu'importée, ce fichier n'a aucune autre dépendance vers core.ts (façade
// transport indépendante du protocole µ:, cf. commentaire de tête) — les deux bornes restent
// volontairement proches (2000/2500) sans être couplées en dur.
const STOP_TIMEOUT_MS = 2500

class WsConnection implements MjsWsConnection {
  onMessage: ((data: string | Uint8Array) => void) | null = null
  onClose: ((code: number, reason: string) => void) | null = null

  constructor(private _ws: WsSocket, public readonly remoteInfo: MjsWsRemoteInfo) {
    this._ws.on('message', (data: Buffer, isBinary: boolean) => {
      // trame binaire (socle du futur µschema) — `new Uint8Array(data)` COPIE les
      // octets dans un buffer NEUF (constructeur « depuis un TypedArray », jamais une vue) : la
      // représentation interne transmise à core.ts n'est jamais un Buffer `ws` (mutable, pooling
      // possible côté bibliothèque) — même garantie de copie que transport-uws.ts, cf. transport.ts.
      if (isBinary) { if (this.onMessage) this.onMessage(new Uint8Array(data)); return }
      if (this.onMessage) this.onMessage(data.toString('utf8'))
    })
    this._ws.on('close', (code: number, reason: Buffer) => {
      if (this.onClose) this.onClose(code, reason ? reason.toString('utf8') : '')
    })
    // une erreur socket sans 'close' associé laisserait une connexion fantôme
    // côté core (jamais nettoyée) — `ws` émet TOUJOURS 'close' après 'error',
    // ce listener vide évite juste un crash process sur 'error' sans écouteur.
    this._ws.on('error', () => {})
  }

  get bufferedAmount(): number { return this._ws.bufferedAmount }

  send(data: string | Uint8Array): void {
    if (this._ws.readyState !== READY_STATE_OPEN) return
    // binaire vs texte (µschema) — AUCUNE option à passer : `ws` détecte tout seul
    // (`binary: typeof data !== 'string'`, cf. node_modules/ws/lib/websocket.js) — un Uint8Array
    // part donc déjà en trame WebSocket BINAIRE avec ce seul appel, comme une string part en texte.
    try { this._ws.send(data) }
    catch { /* socket fermée entre l'envoi et le check readyState — silencieux, guard.ts compte au niveau core */ }
  }

  close(code?: number, reason?: string): void {
    try { this._ws.close(code, reason) }
    catch { /* déjà fermée */ }
  }
}

export class WsTransport implements MjsWsTransport {
  private _opts: WsTransportOpts
  private _wss: WsServer | null = null
  private _handler: ((conn: MjsWsConnection) => void) | null = null

  constructor(opts: WsTransportOpts = {}) { this._opts = opts }

  onConnection(handler: (conn: MjsWsConnection) => void): void { this._handler = handler }

  async start(): Promise<void> {
    const { WebSocketServer } = await loadWs()
    const wss = new WebSocketServer({ port: this._opts.port ?? 8080, host: this._opts.host, maxPayload: this._opts.maxPayload ?? DEFAULT_MAX_PAYLOAD })
    this._wss = wss
    wss.on('connection', (ws: WsSocket, req: IncomingMessage) => {
      const remoteInfo: MjsWsRemoteInfo = {
        origin:  req.headers.origin as string | undefined,
        headers: req.headers as MjsWsRemoteInfo['headers'],
        // IP distante (plafond de connexions PAR IP — core.ts) —
        // req.socket est le socket TCP brut de la requête d'upgrade, MÊME source que
        // bridge.ts::clientIp() (jamais un en-tête X-Forwarded-For, trivialement falsifiable).
        // normalisée à la source (IPv4-mappée « ::ffff:a.b.c.d » → « a.b.c.d »), cf. transport.ts
        address: normalizeRemoteAddress(req.socket?.remoteAddress),
      }
      const conn = new WsConnection(ws, remoteInfo)
      if (this._handler) this._handler(conn)
    })
    await new Promise<void>((resolve, reject) => {
      // erreur AU DÉMARRAGE (port déjà utilisé, EACCES…) → rejette start(), écouteur RETIRÉ
      // dès 'listening' (jamais empilé indéfiniment). Sans ce retrait, une erreur SERVEUR
      // survenant APRÈS coup (ex. EMFILE, trop de descripteurs ouverts) tomberait sur ce MÊME
      // `reject` — orphelin, la promesse de start() étant déjà résolue depuis longtemps — et
      // un 'error' EventEmitter sans écouteur fait crasher le process ENTIER (comportement Node
      // par défaut) : cf. le handler permanent posé juste en dessous.
      const onStartupError = (err: Error) => reject(err)
      wss.once('error', onStartupError)
      wss.once('listening', () => {
        wss.off('error', onStartupError)
        // handler PERMANENT — une erreur serveur tardive (EMFILE…) ne tue plus le process ; même
        // politique que `this._ws.on('error', () => {})` plus haut (aucun logger injecté ici, un
        // handler vide suffit à désamorcer le crash — core.ts/opts.onLog n'a pas de fil jusqu'ici).
        wss.on('error', () => {})
        resolve()
      })
    })
  }

  async stop(): Promise<void> {
    const wss = this._wss
    if (!wss) return
    this._wss = null
    await new Promise<void>((resolve) => {
      let done = false
      const finish = () => { if (done) return; done = true; resolve() }
      wss.close(() => finish())
      // clients qui ignorent la trame close (jamais de 'close' individuel ⇒ wss.clients ne redescend
      // jamais à 0) : SANS cette borne, wss.close() peut pendre jusqu'à ~30s (CLOSE_TIMEOUT interne
      // de `ws`, cf. node_modules/ws/lib/websocket.js) — contredit l'invariant documenté côté core.ts
      // (STOP_CLOSE_TIMEOUT_MS = 2000). Au timeout : fermeture FORCÉE (terminate(), pas de handshake).
      const timer = setTimeout(() => {
        for (const c of wss.clients) { try { c.terminate() } catch { /* déjà fermée */ } }
        finish()
      }, STOP_TIMEOUT_MS)
      timer.unref?.()   // ne garde jamais le process en vie juste pour ce timer
    })
  }
}
