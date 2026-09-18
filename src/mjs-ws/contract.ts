// mjs-ws/contract — contrat TYPÉ optionnel entre un fichier serveur (.server.mjs) et les
// composants client (.mjs) qui lui parlent. Patron tRPC adapté à
// MJS : l'appli déclare UNE interface de messages (MjsWsContract) dans un fichier .ts partagé,
// importée EN TYPE des deux côtés — TypedApp<C>/TypedSocket<C> ne sont que des VUES typées de
// app/sock, asTypedApp/asTypedSocket ne font QUE caster (identité stricte à l'exécution, jamais
// un octet ajouté au bundle : que des types + deux fonctions d'un retour direct). RÉALITÉ HONNÊTE
// à connaître (cf. docs/23-mjs-ws.md « Contrat typé ») : .server.mjs et .mjs sont compilés
// SÉPARÉMENT (Civet propre à chacun, ce fichier en TS pur) — le contrat ne relie PERSONNE au
// runtime, seulement les DEUX COMPILATIONS via un `import type`, effacé avant que le moindre
// octet ne parte au navigateur/process serveur. Toucher CE fichier ne change AUCUN comportement
// de core.ts/mjs_socket.ts — zéro branche runtime nouvelle, zéro import runtime de leur part.

import type { MjsWsApp, MjsWsClient } from './core.js'

// --- le contrat : forme que l'appli déclare -----------------------------------------------------

/**
 * Un contrat MJS-WS — l'appli en déclare UNE interface, typiquement dans un fichier `contrat.ts`
 * partagé (cf. docs/23-mjs-ws.md « Contrat typé ») :
 *
 *   interface MonContrat extends MjsWsContract {
 *     serves: { achat: (p: { prix: number }) => { solde: number } }
 *     sends:  { chat: { texte: string; auteur: string } }
 *   }
 *
 * Les trois clés sont OPTIONNELLES — un contrat qui n'en déclare qu'une (ex. seulement `sends`)
 * laisse les deux autres aussi LIBRES qu'aujourd'hui (type quelconque, charge `any`), jamais une
 * interdiction de fait. `extends MjsWsContract` n'est même pas requis : le typage structurel de TS
 * suffit — une interface qui a la même forme convient tout autant en argument de TypedApp/TypedSocket.
 */
export interface MjsWsContract {
  /** requêtes CLIENT → SERVEUR avec réponse (app.serve / sock.request) — nom → (payload) => résultat */
  serves?: Record<string, (p: any) => any>
  /** messages SANS réponse, dans les deux sens (app.on+app.send / sock.on+sock.send) — nom → forme du payload */
  sends?: Record<string, any>
  /** forme des méta de présence (opts.rooms.meta(client), cf. core.ts) — UNE seule forme pour tous les salons de l'appli */
  presences?: any
}

// replis PERMISSIFS quand l'appli ne contraint pas un pan du contrat — MÊME souplesse qu'un app/
// sock NON typés (nom de type libre, charge `any`), jamais une interdiction par défaut.
type AnyServes = Record<string, (p: any) => any>
type AnySends  = Record<string, any>

type ServesOf<C extends MjsWsContract> = C['serves'] extends AnyServes ? C['serves'] : AnyServes
// 'welcome' toujours utilisable (nom d'événement RÉSERVÉ par le protocole côté client, cf.
// mjs_socket.ts::_onWelcome) même hors contrat — payload `unknown` sauf si l'appli le redéclare.
type SendsOf<C extends MjsWsContract> = (C['sends'] extends AnySends ? C['sends'] : AnySends) & { welcome?: unknown }
type PresenceOf<C extends MjsWsContract> = C['presences'] extends undefined ? unknown : C['presences']

/** résultat OBTENU par l'appelant, toujours « déballé » — que `serves.x` déclare un retour direct
 *  ou une Promise, `sock.request()` résout au même type ET `app.serve()` accepte un handler sync
 *  OU async pour la même entrée de contrat (cf. core.ts routeAppMessage : `await handler(...)`,
 *  déjà vrai aujourd'hui SANS contrat — ce type ne fait que le refléter dans les types). */
export type MjsWsResultOf<F extends (...args: any) => any> = Awaited<ReturnType<F>>

// --- TypedApp<C> — vue typée de `app` (mjsWs()/mjs-server()) ---------------------------------------

/** vue typée de `app` — MÊME objet, juste `serve`/`on`/`send`/`sendUser` bornés au contrat `C`
 *  (room/stream/broadcast/schema/clients/listen/stop/stats… traversent INCHANGÉS, cf. MjsWsApp). */
export type TypedApp<C extends MjsWsContract> = Omit<MjsWsApp, 'serve' | 'on' | 'send' | 'sendUser'> & {
  serve<K extends keyof ServesOf<C> & string>(
    type: K,
    handler: (p: Parameters<ServesOf<C>[K]>[0], client: MjsWsClient) => MjsWsResultOf<ServesOf<C>[K]> | Promise<MjsWsResultOf<ServesOf<C>[K]>>,
  ): void
  on<K extends keyof SendsOf<C> & string>(type: K, handler: (p: SendsOf<C>[K], client: MjsWsClient) => unknown): void
  // `boolean` reflète désormais MjsWsApp.send/sendUser (core.ts) : `false`
  // UNIQUEMENT si la charge n'a pas pu être sérialisée, cf. leur commentaire.
  send<K extends keyof SendsOf<C> & string>(client: MjsWsClient, type: K, p: SendsOf<C>[K]): boolean
  sendUser<K extends keyof SendsOf<C> & string>(id: string, type: K, p: SendsOf<C>[K]): boolean
}

/**
 * Cast SEUL — AUCUNE vérification, AUCUN wrapping à l'exécution (`app` est renvoyé TEL QUEL) :
 * donne à `app` (mjsWs()/mjs-server()) le typage `TypedApp<C>`. `contract` n'est JAMAIS lu — porte
 * seulement le générique `C` pour qui préfère l'inférer d'une valeur plutôt que l'écrire en
 * argument de type explicite (`asTypedApp<MonContrat>(app)` marche identiquement, `contract`
 * omis). Cf. docs/23-mjs-ws.md « Contrat typé ».
 */
export function asTypedApp<C extends MjsWsContract>(app: MjsWsApp, _contract?: C): TypedApp<C> {
  return app as TypedApp<C>
}

// --- TypedSocket<C> — vue typée de `sock` (µ.socket(url)) ----------------------------------------
//
// RÉALITÉ (cf. tête de fichier) : `src/runtime/mjs_socket.ts` est EXCLU du typecheck de ce paquet
// (tsconfig.json, `exclude: ["src/runtime/**/*.ts"]`) — écrit en JS de prototype pur (`MjsSocket.
// prototype.request = function(type, payload, opts) {…}`), il n'a JAMAIS eu de type TS ; `µ` lui-
// même est `any` (globals.d.ts). Ce qui suit est une RECONSTRUCTION MANUELLE de la surface publique
// de MjsSocket.prototype (cf. le commentaire de tête de mjs_socket.ts pour le contrat exact) —
// jamais une projection automatique : elle peut dériver si ce contrat évolue sans qu'on la mette à
// jour ici (aucun garde-fou du compilateur ne le verrait).

export type MjsRequestOpts = { timeout?: number; waitForOpen?: boolean }
export type MjsSendOpts    = { cooldown?: number; coalesce?: boolean | number; debounce?: boolean | number }

/** poignée de salon (sock.room(name), cf. mjs_socket.ts) — namespace de préfixe SANS état propre,
 *  volontairement NON bornée au contrat ICI (non couverte : serve/request, send/on,
 *  game/move — pas room().send) : reste aussi souple qu'aujourd'hui. */
export interface MjsRoomProxyLoose {
  on(type: string, handler: (p: any, msg: any) => void): () => void
  send(type: string, p?: unknown, opts?: MjsSendOpts): boolean
  request(type: string, p?: unknown, opts?: MjsRequestOpts): Promise<any>
  stream(type: string, opts?: unknown): Record<string, unknown>
  presence(): Record<string, unknown>
  onLeft(fn: (reason?: string) => void): void
  leave(): void
}

/** surface publique de `MjsSocket.prototype` — cf. RÉALITÉ ci-dessus. */
export interface MjsSocketLoose {
  readonly url: string
  readonly state: 'closed' | 'connecting' | 'open' | 'reconnecting'
  readonly latency: number | null
  readonly connected: boolean
  readonly lastError: unknown
  readonly resumed: boolean
  connect(): this
  close(code?: number, reason?: string): void
  destroy(): void
  refresh(auth: unknown): Promise<unknown>
  off(type: string, handler?: (...args: any[]) => void): void
  stream(type: string, opts?: unknown): Record<string, unknown>
  presence(room?: string): Record<string, unknown>
  room(name: string): MjsRoomProxyLoose
  request(type: string, p?: unknown, opts?: MjsRequestOpts): Promise<any>
  on(type: string, handler: (p: any, msg: any) => void): () => void
  send(type: string, p?: unknown, opts?: MjsSendOpts): boolean
}

/** vue typée de `sock` — MÊME objet, juste `request`/`on`/`send`/`presence` bornés au contrat `C`
 *  (state/room/stream/close/destroy/refresh/off… traversent INCHANGÉS, cf. MjsSocketLoose). */
export type TypedSocket<C extends MjsWsContract> = Omit<MjsSocketLoose, 'request' | 'on' | 'send' | 'presence'> & {
  request<K extends keyof ServesOf<C> & string>(type: K, p: Parameters<ServesOf<C>[K]>[0], opts?: MjsRequestOpts): Promise<MjsWsResultOf<ServesOf<C>[K]>>
  on<K extends keyof SendsOf<C> & string>(type: K, handler: (p: SendsOf<C>[K], msg: unknown) => void): () => void
  send<K extends keyof SendsOf<C> & string>(type: K, p: SendsOf<C>[K], opts?: MjsSendOpts): boolean
  presence(room?: string): Record<string, PresenceOf<C>>
}

/** cast SEUL — MÊME contrat que asTypedApp ci-dessus, côté client. `sock` accepte le vrai retour
 *  de `µ.socket(url)` (typé `any`, cf. RÉALITÉ) — `MjsSocketLoose` sert de charnière minimale pour
 *  que le cast reste vérifié plutôt qu'un `as any` aveugle sur une valeur mal formée. */
export function asTypedSocket<C extends MjsWsContract>(sock: MjsSocketLoose, _contract?: C): TypedSocket<C> {
  return sock as unknown as TypedSocket<C>
}
