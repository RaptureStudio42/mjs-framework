// mjs-ws/transport-uws — adaptateur MjsWsTransport sur uWebSockets.js, transport
// ALTERNATIF à `ws` (transport-ws.ts, le défaut) pour les très gros volumes de
// connexions. MÊME façade, MÊME esprit : import PARESSEUX (dynamic import()
// dans start(), jamais en tête de fichier) — charger ce module sans jamais
// appeler .listen() avec transport: 'uws' ne touche donc PAS au paquet. À la
// différence de `ws`, uWebSockets.js N'EST PAS une dépendance de ModularJS
// (paquet natif, install séparée, cf. loadRealUws() pour le message clair si
// absent) — AUCUNE dépendance n'est ajoutée.
//
// ⚠️ PIÈGE MAJEUR (natif, pas une exception JS) : un objet `ws` uWebSockets.js
// devient INVALIDE dès l'instant où sa connexion se ferme — tout usage après
// (send/end/getBufferedAmount, même juste LIRE une propriété) fait planter le
// PROCESS ENTIER, pas juste lever une erreur rattrapable. Chaque UwsConnection
// pose donc un drapeau `_closed`, posé AVANT tout appel natif de fermeture et
// vérifié en tête de CHAQUE méthode qui touche `_ws` — jamais d'accès direct
// à `_ws` ailleurs dans ce fichier.
//
// ⚠️ PIÈGE #2, DISTINCT (trames binaires — socle du futur µschema) : le `ArrayBuffer`
// livré par le rappel `message` est un buffer NATIF RÉUTILISÉ par uWS dès le retour du rappel —
// jamais question de le conserver tel quel au-delà. `message.slice(0)` (ArrayBuffer.prototype.slice)
// COPIE les octets dans un buffer NEUF avant tout retour vers core.ts (cf. le handler `message`
// plus bas) — c'est la SEULE ligne de défense contre une corruption silencieuse d'une trame déjà
// « reçue » par le reste du moteur.
//
// `uwsModule` (options du constructeur) court-circuite l'import réel — MÊME
// esprit que WsCommandInjections.transport (cli/ws.ts) : une fausse
// implémentation App/ws en mémoire, injectée par les tests.

import { Buffer } from 'node:buffer'
import { chmodSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { MjsWsConnection, MjsWsRemoteInfo, MjsWsTransport } from './transport.js'
import { normalizeRemoteAddress } from './transport.js'
import { t } from '../messages/index.js'

// --- forme minimale de l'API uWebSockets.js réellement consommée ici -------
// PAS de @types/uWebSockets.js : le paquet n'est ni une dependency ni une
// devDependency de ModularJS (cf. commentaire de tête) — ce sous-ensemble
// structurel suffit à tout ce que cet adaptateur utilise ; le VRAI module
// (import() paresseux) est casté vers UwsModule au chargement (loadRealUws).

export interface UwsHttpRequest {
  getHeader(lowerCaseKey: string): string
  forEach(cb: (key: string, value: string) => void): void
}

export interface UwsHttpResponse {
  upgrade(userData: unknown, secWebSocketKey: string, secWebSocketProtocol: string, secWebSocketExtensions: string, context: unknown): void
  /** IP distante, forme TEXTE (plafond de connexions PAR IP — core.ts) —
   *  ArrayBuffer BRUT côté uWS (comme `message` du rappel `message`, cf. PIÈGE #2 en tête de
   *  fichier) : valide PENDANT la fenêtre `upgrade` (avant tout `res.upgrade()`), MÊME fenêtre que
   *  getHeader/forEach ci-dessus — décodée en chaîne ICI, jamais conservée sous forme d'ArrayBuffer. */
  getRemoteAddressAsText(): ArrayBuffer
}

/** UserData attachée à CHAQUE connexion via res.upgrade() (cf. UwsTransport.start) — une seule forme utilisée dans tout le fichier, pas de générique. */
interface UwsUserData {
  remoteInfo: MjsWsRemoteInfo
  conn?: UwsConnection
}

export interface UwsWebSocket {
  /** `message` élargi à Uint8Array (µschema) — forme réelle de uWebSockets.js :
   *  `RecognizedString | ArrayBuffer | Uint8Array | ...` ; on ne passe jamais que ces deux-là. */
  send(message: string | Uint8Array, isBinary?: boolean, compress?: boolean): number
  getBufferedAmount(): number
  end(code?: number, shortMessage?: string): void
  getUserData(): UwsUserData
}

// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- handle opaque uWebSockets.js, aucune forme à typer
export interface UwsListenSocket {}

export interface UwsWebSocketBehavior {
  maxPayloadLength?: number
  idleTimeout?: number
  upgrade?(res: UwsHttpResponse, req: UwsHttpRequest, context: unknown): void
  open?(ws: UwsWebSocket): void
  message?(ws: UwsWebSocket, message: ArrayBuffer, isBinary: boolean): void
  close?(ws: UwsWebSocket, code: number, message: ArrayBuffer): void
  drain?(ws: UwsWebSocket): void
}

export interface UwsTemplatedApp {
  ws(pattern: string, behavior: UwsWebSocketBehavior): UwsTemplatedApp
  listen(host: string, port: number, cb: (token: UwsListenSocket | false) => void): UwsTemplatedApp
  listen(port: number, cb: (token: UwsListenSocket | false) => void): UwsTemplatedApp
  /** Écoute sur une socket unix — ARGUMENTS INVERSÉS par rapport à `listen` (rappel D'ABORD), c'est la signature
   *  d'uWebSockets.js, pas un choix d'ici. ⚠️ Le `.d.ts` du paquet type le rappel `(token: us_listen_socket)`,
   *  SANS le `| false` — c'est FAUX : mesuré au banc sur uWS v20.52.0, un bind impossible
   *  (répertoire absent, chemin trop long) appelle bien le rappel avec `false`. Typé juste ici. */
  listen_unix(cb: (token: UwsListenSocket | false) => void, path: string): UwsTemplatedApp
}

/** Forme du module `uWebSockets.js` — ce que loadRealUws()/l'injection de test doivent fournir. */
export interface UwsModule {
  App(): UwsTemplatedApp
  us_listen_socket_close(token: UwsListenSocket): void
}

// --- import paresseux, mémoïsé (même précédent que transport-ws.ts loadWs) --
// nom du paquet en VARIABLE (pas en littéral direct dans import()) — évite que
// tsc tente de résoudre 'uWebSockets.js' comme un vrai module au typage (le
// paquet n'existe dans AUCUN node_modules de ModularJS) ; comportement runtime
// strictement identique à `import('uWebSockets.js')` littéral.
const UWS_PACKAGE_NAME = 'uWebSockets.js'

let uwsModulePromise: Promise<UwsModule> | null = null
function loadRealUws(): Promise<UwsModule> {
  if (!uwsModulePromise) {
    uwsModulePromise = import(UWS_PACKAGE_NAME).then((m) => m as UwsModule).catch((err) => {
      throw new Error(t('ws.transport-uws.paquet-requis'), { cause: err })
    })
  }
  return uwsModulePromise
}

export interface UwsTransportOpts {
  port?: number
  host?: string
  /**
   * Chemin d'une socket unix. RENSEIGNÉ, il l'emporte sur `port`/`host` : le transport n'écoute plus du
   * tout en TCP et devient injoignable depuis le réseau, même sur une erreur de pare-feu — les droits
   * unix du fichier sont alors la seule porte, et le noyau les APPLIQUE vraiment sur une socket.
   * ABSENT (défaut), rien ne change : port TCP, comportement historique, aucun poste de développement
   * n'a à connaître ce mode. Un reverse-proxy y va par `proxy_pass http://unix:<chemin>:` (nginx).
   */
  socketPath?: string
  /** Droits posés sur la socket unix APRÈS le bind (défaut 0o660). Sans ce chmod, elle reste en 0700 — cf. listenUnix(). */
  socketMode?: number
  /** Taille max d'une trame, en octets — mjsWs() y câble `limits.maxPayload` (défaut local ci-dessous, pour un usage standalone). */
  maxPayload?: number
  /** injection de test — court-circuite loadRealUws() (même esprit que WsCommandInjections.transport, cli/ws.ts) */
  uwsModule?: UwsModule
}

// défaut aligné sur DEFAULT_LIMITS.maxPayload (index.ts) — dupliqué ici en
// LITTÉRAL pour ne pas créer de dépendance circulaire (index.ts importe ce
// fichier) ; mjsWs() passe de toute façon limits.maxPayload RÉSOLU à chaque
// construction via la chaîne 'uws' — ce défaut ne joue qu'en usage STANDALONE
// (`new UwsTransport()` hors mjsWs(), ex. tests/usage programmatique direct).
const DEFAULT_MAX_PAYLOAD = 65536

// LES 108 OCTETS, ET LA RAISON DE LES COMPTER : l'adresse d'une socket unix tient dans un `sun_path`
// de 108 octets — au-dela, le bind echoue SANS DIRE POURQUOI. Pris en defaut au banc,
// et pas sur un cas theorique : un chemin de 118 octets a rendu `false`, point. Le compte se fait
// donc ICI, avant le bind, pour que le message nomme la vraie cause.
//
// 108 ET NON 107 : la regle « moins le NUL final » est celle des chaines C, et elle est FAUSSE ici —
// le noyau linux accepte un chemin qui remplit `sun_path` EXACTEMENT, sans terminateur, quand la
// longueur d'adresse le dit. Mesure sur uWS v20.52.0, refaite deux fois : 107 et 108
// se lient, le fichier est cree et un client s'y connecte pour de vrai ; 109 rend `false`. Une borne
// a 107 aurait donc refuse un chemin parfaitement valide, avec un message affirmant le contraire.
const SUN_PATH_MAX = 108

// uWebSockets.js cree sa socket en 0700 EN DUR et n'ecoute AUCUN umask (0000, 0007 et 0022 essayes au
// banc : meme resultat) — un reverse-proxy qui tourne sous un AUTRE compte se voit donc refuser la
// connexion par le noyau tant que ce chmod n'a pas eu lieu. 0660 = proprietaire et groupe, personne
// d'autre. Le chmod porte sur une socket VIVANTE et ne la coupe pas (verifie au banc).
const DEFAULT_SOCKET_MODE = 0o660

class UwsConnection implements MjsWsConnection {
  onMessage: ((data: string | Uint8Array) => void) | null = null
  onClose: ((code: number, reason: string) => void) | null = null

  private _closed = false

  constructor(private _ws: UwsWebSocket, public readonly remoteInfo: MjsWsRemoteInfo) {}

  get bufferedAmount(): number {
    // fermée : ne JAMAIS toucher `_ws` (cf. PIÈGE MAJEUR, commentaire de tête) — 0 est un
    // repli sûr (isBackpressured() en tirera juste « pas de contre-pression », correct :
    // il n'y a plus rien à mettre en attente pour une connexion déjà fermée).
    return this._closed ? 0 : this._ws.getBufferedAmount()
  }

  send(data: string | Uint8Array): void {
    if (this._closed) return
    try {
      // code retour uWS : 1 succès, 0 mis en file (contre-pression en cours, sera livré),
      // 2 abandonné (au-delà de maxBackpressure, 64 Ko par défaut côté uWS — PLUS PETIT que
      // limits.maxBuffered, 1 Mo par défaut côté MJS-WS : un send() encore accepté par le
      // pré-check de guard.ts peut donc, plus rarement, revenir 2 ICI). Silencieux dans tous
      // les cas — même politique que le catch de transport-ws.ts : guard.ts compte déjà la
      // contre-pression au niveau core, pas ici.
      // isBinary (µschema) — `true` pour un Uint8Array, jamais déduit autrement :
      // MÊME détection que transport-ws.ts (`typeof data !== 'string'`), explicite ici car
      // l'API uWS l'exige en 2e argument (pas d'auto-détection côté natif).
      this._ws.send(data, typeof data !== 'string')
    } catch { /* ws invalide entre le check `_closed` et l'appel (fermeture concurrente côté natif) — silencieux, même politique que transport-ws.ts */ }
  }

  close(code?: number, reason?: string): void {
    if (this._closed) return
    this._closed = true   // posé AVANT l'appel natif — cf. PIÈGE MAJEUR (commentaire de tête)
    try { this._ws.end(code, reason) }
    catch { /* déjà fermée côté natif */ }
  }

  /** appelée par le handler `close` de UwsTransport (fermeture NATIVE — déconnexion réseau, timeout…) : pose juste le drapeau, ne touche JAMAIS `_ws` (déjà invalide à cet instant). */
  _markClosed(): void { this._closed = true }
}

export class UwsTransport implements MjsWsTransport {
  private _opts: UwsTransportOpts
  private _handler: ((conn: MjsWsConnection) => void) | null = null
  private _uws: UwsModule | null = null
  private _listenToken: UwsListenSocket | null = null

  constructor(opts: UwsTransportOpts = {}) { this._opts = opts }

  onConnection(handler: (conn: MjsWsConnection) => void): void { this._handler = handler }

  async start(): Promise<void> {
    const uws = this._opts.uwsModule ?? await loadRealUws()
    const app = uws.App()

    app.ws('/*', {
      maxPayloadLength: this._opts.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      // watchdog NATIF désactivé — core.ts a DÉJÀ son propre Watchdog (heartbeat × 2.5,
      // guard.ts), SEULE autorité d'inactivité pour TOUS les transports (WsTransport n'a pas
      // non plus de kill natif — `ws` ne le propose même pas). Choix retenu = LE PLUS SÛR :
      // une SEULE autorité, un comportement IDENTIQUE entre transports (y compris
      // heartbeat: 0 → jamais de kick, des deux côtés). Aligner idleTimeout sur heartbeat×2.5
      // au lieu de le désactiver ferait doublonner la protection avec une fermeture NATIVE
      // (code/raison hors du contrat µ:, sans passer par kickClient — stats/logs faussés).
      idleTimeout: 0,
      upgrade: (res, req, context) => {
        const headers: Record<string, string> = {}
        req.forEach((k, v) => { headers[k] = v })
        // IP distante — capturée ICI, PENDANT la fenêtre valide de `res`
        // (avant tout res.upgrade() ci-dessous, cf. le commentaire de UwsHttpResponse.getRemoteAddressAsText) ;
        // décodage Buffer.from(ArrayBuffer).toString('utf8'), MÊME technique que message/close plus
        // bas — chaîne vide (aucune IP, ex. connexion interne exotique) repliée sur `undefined`,
        // jamais comptée par le plafond par IP (cf. MjsWsRemoteInfo.address) ; normalisée à
        // la source, symétrie stricte avec transport-ws.ts — cf. transport.ts::normalizeRemoteAddress
        const address = normalizeRemoteAddress(Buffer.from(res.getRemoteAddressAsText()).toString('utf8') || undefined)
        const remoteInfo: MjsWsRemoteInfo = { origin: req.getHeader('origin') || undefined, headers, address }
        res.upgrade({ remoteInfo } as UwsUserData, req.getHeader('sec-websocket-key'), req.getHeader('sec-websocket-protocol'), req.getHeader('sec-websocket-extensions'), context)
      },
      open: (ws) => {
        const ud   = ws.getUserData()
        const conn = new UwsConnection(ws, ud.remoteInfo)
        ud.conn    = conn
        if (this._handler) this._handler(conn)
      },
      message: (ws, message, isBinary) => {
        const conn = ws.getUserData().conn
        if (!conn || !conn.onMessage) return
        // trame binaire (socle du futur µschema) — COPIE OBLIGATOIRE avant tout
        // retour de ce rappel (cf. PIÈGE #2, commentaire de tête) : `message.slice(0)` alloue un
        // ArrayBuffer NEUF avec les octets copiés, jamais une vue sur le buffer natif réutilisable.
        if (isBinary) { conn.onMessage(new Uint8Array(message.slice(0))); return }
        conn.onMessage(Buffer.from(message).toString('utf8'))
      },
      close: (ws, code, message) => {
        const conn = ws.getUserData().conn
        if (!conn) return
        conn._markClosed()   // AVANT tout — cf. PIÈGE MAJEUR (commentaire de tête)
        if (conn.onClose) conn.onClose(code, Buffer.from(message).toString('utf8'))
      },
      drain: () => {
        // MjsWsConnection n'expose pas de callback drain — guard.ts (core.ts) relit
        // .bufferedAmount à la demande à CHAQUE envoi, la prochaine lecture verra donc déjà le
        // buffer vidé. Rien à répercuter ici ; handler gardé pour respecter la forme attendue
        // par uWS (et un futur hook métriques, si besoin un jour).
      },
    })

    // LE MODE D'ECOUTE SE CHOISIT TOUT SEUL SUR LA PRESENCE DE socketPath — aucun drapeau a poser, et
    // surtout aucun changement pour qui ne l'utilise pas : sans lui, on est EXACTEMENT dans le code d'hier
    const token = this._opts.socketPath ? await listenUnix(uws, app, this._opts.socketPath, this._opts.socketMode ?? DEFAULT_SOCKET_MODE) : await listenTcp(app, this._opts.port ?? 8080, this._opts.host)
    this._uws         = uws
    this._listenToken = token
  }

  async stop(): Promise<void> {
    // ⚠️ LA SOCKET UNIX SURVIT A CET APPEL — `us_listen_socket_close` ferme l'ECOUTE, il ne DELIE PAS le
    // fichier (mesuré : present apres fermeture). C'est deliberement laisse ainsi : delier
    // ici ouvrirait une course avec un process qui se serait deja relie au meme chemin, et l'orphelin ne
    // coute rien — uWebSockets.js l'ECRASE au bind suivant (mesuré, deux process separes),
    // et un reverse-proxy qui tombe dessus rend une erreur de connexion franche, jamais un silence.
    if (this._listenToken && this._uws) this._uws.us_listen_socket_close(this._listenToken)
    this._listenToken = null
  }
}

// --- l'ecoute : un port TCP (defaut) ou une socket unix (socketPath) ---------------------------
// Deux fonctions de module plutot que deux branches dans start() : chacune se lit d'un bloc, et
// aucune ne peut voir les options de l'autre — un socketPath ne peut donc pas trainer un port avec lui.

async function listenTcp(app: UwsTemplatedApp, port: number, host: string | undefined): Promise<UwsListenSocket> {
  const token = await new Promise<UwsListenSocket | false>((resolve) => {
    if (host) app.listen(host, port, resolve)
    else app.listen(port, resolve)
  })
  if (token === false) throw new Error(t('ws.transport-uws.echec-ecoute', { port, host }))
  return token
}

async function listenUnix(uws: UwsModule, app: UwsTemplatedApp, path: string, mode: number): Promise<UwsListenSocket> {
  const bytes = Buffer.byteLength(path)
  if (bytes > SUN_PATH_MAX) throw new Error(t('ws.transport-uws.socket-trop-longue', { path, bytes, max: SUN_PATH_MAX }))

  // FILET, PAS BESOIN : le repertoire d'accueil existe presque toujours (tmp/sockets/ d'une app rails,
  // par exemple). `dirname` et PAS une expression reguliere : sur un chemin sans slash, un `replace`
  // rendrait la chaine inchangee et on creerait un REPERTOIRE portant le nom de la socket.
  mkdirSync(dirname(path), { recursive: true })

  const token = await new Promise<UwsListenSocket | false>((resolve) => { app.listen_unix(resolve, path) })
  if (token === false) throw new Error(t('ws.transport-uws.echec-ecoute-socket', { path }))

  // LE CHMOD NE SE RATTRAPE JAMAIS EN SILENCE — une socket restee en 0700 est une socket que le
  // reverse-proxy ne peut pas joindre, et l'avaler donnerait un service « demarre » que personne
  // n'atteint. Mais l'ecoute est DEJA ouverte a cet instant : sans ce close, l'exception sortirait
  // avant que `start()` n'ait pu retenir le jeton, et plus personne ne pourrait fermer cette socket
  // native (fuite trouvee). On ferme, PUIS on releve.
  try { chmodSync(path, mode) }
  catch (err) { uws.us_listen_socket_close(token); throw err }

  return token
}
