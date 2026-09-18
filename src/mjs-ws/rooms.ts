// mjs-ws/rooms — « les salons » : registre de salons (adhésion par connexion)
// + présence agrégée par IDENTITÉ (globale et par salon), expulsion (kick) —
// remplace les stubs déclaratifs de core.ts (µ:join/
// µ:leave/µ:sub-presence, ex-« déclaratif pour l'instant »). Branché par
// core.ts aux points du cycle de vie (onWelcome/onDisconnect) et du routage
// (handleJoin/handleLeave/handleSubPresence) ; expose app.room(nom).
//
// AGRÉGATION MULTI-CONNEXIONS — un même utilisateur (même client.identity.id)
// ouvert dans 2 onglets = UN SEUL peer de présence : le delta 'join' ne part
// qu'à la 1re connexion de cet id, le 'leave' qu'à la dernière qui se ferme/
// part. La présence GLOBALE suit le cycle de vie de la connexion (welcome →
// apparition / déconnexion → disparition), INDÉPENDANTE de tout salon. La
// présence DE SALON suit µ:join/µ:leave/kick. Les deux partagent le même
// mécanisme d'agrégation (addPeer/removePeer ci-dessous) mais des registres
// séparés — rejoindre un salon ne touche JAMAIS la présence globale.

import type { MjsWsClient, MjsWsLogFn, MjsWsFanSend } from './core.js'
import { RATE_ERROR_THROTTLE_MS, safeKey } from './guard.js'
// anti-entropie de présence (cf. plus bas, zone « accroches DISTANTES ») — attachPresenceAntiEntropy
// est la SEULE façon de brancher le timer/l'abonnement, jamais réimplémentée ici (adapter.ts)
import { attachPresenceAntiEntropy } from './adapter.js'
import type { MjsWsAdapter, MjsWsPresencePairs, MjsWsPresenceSnapshot } from './adapter.js'
// proxy de décisions (proxy.ts) — TYPE SEUL : `join` accepte désormais un objet-proxy
// {url,secret,...} EN PLUS de la fonction historique, cf. MjsWsRoomsOptions ci-dessous. AUCUNE
// valeur importée depuis proxy.ts ICI (proxy.ts dépend de bridge.ts, qui dépend LUI-MÊME de ce
// fichier pour peerIdOf — un import de valeur rooms.ts→proxy.ts boucherait le graphe de modules) :
// la résolution objet→fonction vit dans core.ts, qui fournit à createRoomsEngine un `join` TOUJOURS
// déjà résolu (cf. MjsWsRoomsEngineOptions plus bas) — ce fichier n'en sait jamais rien de plus.
import type { MjsWsProxyOptions } from './proxy.js'
import { t } from '../messages/index.js'

export type MjsWsJoinFn = (room: string, client: MjsWsClient) => unknown | Promise<unknown>

// garde de LECTURE de présence (cf. MjsWsRoomsOptions.
// canSeePresence) — MIROIR de MjsWsJoinFn au typage près (booléen STRICT, pas de forme objet-proxy :
// cas d'usage plus rare, aucun besoin identifié d'un back HTTP dédié pour CETTE décision).
export type MjsWsCanSeePresenceFn = (room: string, client: MjsWsClient) => boolean | Promise<boolean>

export interface MjsWsRoomsOptions {
  /** garde d'admission à un salon — false ou throw = refus (défaut : accepté). Fonction historique
   *  OU objet-proxy `{url, secret, timeout?, cache?}` délégant la décision à un back
   *  HTTP signé — cf. docs/23-mjs-ws.md « Proxy de décisions ». Résolu en fonction UNE FOIS par
   *  core.ts, jamais réévalué ici (cf. MjsWsRoomsEngineOptions). */
  join?: MjsWsJoinFn | MjsWsProxyOptions
  /** charge de présence associée à une connexion (défaut : {}) */
  meta?: (client: MjsWsClient) => unknown
  /**
   * garde de LECTURE de présence DE SALON — opt-in, MIROIR de `join` ci-dessus (false ou throw =
   * refus), consultée par rooms.ts::handleSubPresence AVANT d'envoyer l'instantané µ:presence.
   * Ne concerne QUE la présence de SALON — la présence GLOBALE n'a pas de garde, structurellement
   * hors salon (même principe que `join`, jamais consulté pour elle non plus). ABSENTE (défaut) =
   * comportement HISTORIQUE INCHANGÉ : présence de salon lisible par tout authentifié, SANS AUCUN
   * lien avec `join` — rejoindre un salon et VOIR sa présence restent deux autorisations
   * INDÉPENDANTES à dessein (PAS de couplage forcé à `join`, juste le levier offert). Avant ce
   * correctif, la présence de salon était lisible via µ:sub-presence SANS
   * AUCUNE autorisation, contrairement à `join` — cf. docs/23-mjs-ws.md.
   */
  canSeePresence?: MjsWsCanSeePresenceFn
  /**
   * INTERNE — posé par index.ts (mjsWs()) quand un adaptateur est branché, JAMAIS par l'espace
   * utilisateur (absent du contrat documenté de `rooms:`, cf. MjsWsOptions). Anti-entropie de
   * présence (cf. adapter.ts attachPresenceAntiEntropy) : createRoomsEngine s'en sert pour
   * publier périodiquement un instantané de la présence LOCALE et réconcilier ceux REÇUS des
   * autres process — SEUL point de branchement (core.ts).
   */
  _cluster?: MjsWsRoomsClusterOptions
}

/**
 * Forme INTERNE consommée par createRoomsEngine — `join`, s'il est présent, est
 * TOUJOURS une fonction déjà prête (jamais l'objet-proxy brut) : core.ts a résolu la détection
 * objet-vs-fonction UNE SEULE FOIS avant d'appeler createRoomsEngine (cf. son commentaire, et
 * celui de proxy.ts sur le graphe de modules). Le reste de ce fichier ne change pas — `opts.join`
 * reste appelé exactement comme avant, cf. handleJoin plus bas.
 *
 * `maxRoomsPerClient` — INTERNE comme `_cluster`
 * (MjsWsRoomsOptions ci-dessus) : posé par core.ts depuis `opts.limits.maxRoomsPerClient`
 * (MjsWsLimits, core.ts), JAMAIS par l'espace utilisateur via `rooms:` (c'est un NOMBRE, même
 * famille que maxConnections/maxConnectionsPerIp, configuré via `limits:` — cf. MjsWsLimits pour
 * le détail). `null`/absent = illimité.
 */
export type MjsWsRoomsEngineOptions =
  Omit<MjsWsRoomsOptions, 'join'> & { join?: MjsWsJoinFn; maxRoomsPerClient?: number | null }

export interface MjsWsRoomsClusterOptions {
  /** MÊME instance que core.ts opts.adapter — référence PARTAGÉE, jamais une 2e résolution (cf. index.ts) */
  adapter: MjsWsAdapter
  /** cadence de publication de l'instantané anti-entropie, ms — false = désactivée (défaut mjsWs() : 15000) */
  antiEntropyMs: number | false
}

export interface MjsWsRoomHandle {
  /** diffuse aux membres du salon (`except` : un ou plusieurs clients à exclure) */
  send(type: string, p?: unknown, opts?: { except?: MjsWsClient | MjsWsClient[] }): void
  readonly clients: Iterable<MjsWsClient>
  readonly size: number
  has(client: MjsWsClient): boolean
  /** expulse UN membre — µ:left {room, reason} au visé, connexion gardée ouverte */
  kick(clientOrId: MjsWsClient | string, reason?: string): void
  /**
   * SUCRE — active (ou redimensionne) un journal borné des `n` derniers `send()` de ce
   * salon (anneau : au-delà de `n`, les plus anciens tombent — même patron que le journal de
   * streams.ts). Un nouvel arrivant (µ:join ACCEPTÉ, jamais un membre déjà présent, cf. handleJoin)
   * reçoit ces `n` trames REJOUÉES TELLES QUELLES ({t: type, p}, aucune enveloppe dédiée), dans
   * l'ordre, avant tout trafic live — `sock.on(type)` les reçoit sans code client spécial. Cf.
   * docs/23-mjs-ws.md « Salon avec historique ».
   * OPT-IN STRICT — jamais appelé = zéro coût (aucune Map créée, `send()` ne journalise rien).
   * `n <= 0` PURGE/désactive (reset explicite) — même effet que la purge automatique quand le salon
   * se vide (plus aucun membre) : à rappeler pour réactiver l'historique d'un salon revenu à zéro
   * membre. Rétrécir une taille déjà active retaille tout de suite (les plus anciennes trames
   * tombent) ; l'agrandir garde le contenu existant.
   */
  history(n: number): void
}

/** frame brute {t,p,seq?} — même primitive que sendRaw (core.ts), juste élargie à MjsWsClient */
export type MjsWsRawSend = (client: MjsWsClient, frame: Record<string, unknown>) => void

// peer agrégé (identité) — plusieurs connexions du même id ne comptent que pour UN
interface PeerAgg {
  meta: unknown
  members: Set<MjsWsClient>
}

// historique de salon (sucre — cf. MjsWsRoomHandle.history) — `journal` garde les
// trames VERBATIM d'un send() ({type,p} — jamais {op,key,…} : ce n'est PAS un app.stream() interne,
// le rejeu au join doit ressembler AU MILLIMÈTRE à un send() live, cf. handleJoin/replayHistory).
interface RoomHistoryEntry { type: string; p: unknown }
interface RoomHistoryState { size: number; journal: RoomHistoryEntry[] }

// id de peer = identity.id si présent, sinon l'id de connexion — cf. contrat agrégation
// EXPORTÉE — réutilisée telle quelle par bridge.ts (résolution client/user d'un
// id reçu par HTTP) : source UNIQUE de « qui est qui », jamais dupliquée ailleurs.
export function peerIdOf(client: MjsWsClient): string {
  const identity = client.identity
  if (identity && typeof identity === 'object' && 'id' in identity) {
    const raw = (identity as Record<string, unknown>).id
    if (raw != null) return String(raw)
  }
  return client.id
}

// EXPORTÉE — réutilisée par core.ts (cluster) pour sérialiser un client OBJET (except
// d'un broadcast/room.send, cible d'un kick…) en id(s) transmissibles cross-process : l'id de
// connexion (toujours), PLUS l'id de peer s'il diffère (identity.id) — même résolution PERMISSIVE
// que resolveClients (bridge.ts) côté réception, id de connexion OU id agrégé.
export function idsOfClient(client: MjsWsClient): string[] {
  const pid = peerIdOf(client)
  return pid === client.id ? [client.id] : [client.id, pid]
}

// accroches OPTIONNELLES pour le pont universel (bridge.ts) — jamais consultées par
// le protocole µ: lui-même, juste des notifications passives en plus du travail habituel
// (broadcastPresence). Absentes par défaut : ZÉRO coût quand le pont n'est pas activé.
export interface MjsWsRoomsHooks {
  /** peer AGRÉGÉ entré dans un salon (1re connexion de son id) */
  onJoin?: (room: string, id: string, meta: unknown) => void
  /** peer AGRÉGÉ sorti d'un salon (dernière connexion partie — leave, kick ou déconnexion) */
  onLeave?: (room: string, id: string, meta: unknown) => void
  /** peer AGRÉGÉ apparu en présence GLOBALE (1er welcome de son id) — cluster */
  onGlobalJoin?: (id: string, meta: unknown) => void
  /** peer AGRÉGÉ disparu de la présence GLOBALE (dernière connexion partie) — cluster */
  onGlobalLeave?: (id: string) => void
  /**
   * Vivacité de la connexion, consultée par handleJoin APRÈS la garde `join` async ET par
   * handleSubPresence APRÈS la garde `canSeePresence` async (MÊME course) :
   * absente = toujours vivante (comportement historique, tests qui construisent le moteur
   * directement). Fournie par core.ts (`client.state !== 'closed'`) : une déconnexion PENDANT
   * cette garde a déjà tout purgé (onDisconnect) — sans ce contrôle, l'adhésion/l'abonnement serait
   * quand même enregistré pour une connexion qui n'existe déjà plus nulle part, un membre/abonné
   * FANTÔME qu'aucun futur onDisconnect ne reverra jamais (il n'a lieu qu'UNE fois par connexion).
   */
  isAlive?: (client: MjsWsClient) => boolean
}

export function createRoomsEngine(opts: MjsWsRoomsEngineOptions, rawSend: MjsWsRawSend, log: MjsWsLogFn, hooks: MjsWsRoomsHooks = {}, fanSend?: MjsWsFanSend) {
  const roomMembers  = new Map<string, Set<MjsWsClient>>()    // salon → connexions membres
  const clientRooms  = new Map<MjsWsClient, Set<string>>()    // connexion → salons rejoints
  const presenceSubsGlobal = new Set<MjsWsClient>()
  const presenceSubsByRoom = new Map<string, Set<MjsWsClient>>()
  const globalPeers = new Map<string, PeerAgg>()               // présence globale — liée au cycle de vie de la connexion
  const roomPeers   = new Map<string, Map<string, PeerAgg>>()  // présence par salon — liée à µ:join/µ:leave/kick
  const lastJoinErrorAt = new Map<MjsWsClient, number>()
  // présence FUSIONNÉE cross-process (adaptateur) — deltas reçus des AUTRES process
  // (core.ts les alimente via applyRemotePresence/purgeRemoteProcess) : clé = processId, valeur
  // = pairs de CE process pour ce scope. Jamais alimentées hors clustering (adapter absent) —
  // Maps qui restent vides pour toujours, même principe opt-in déjà en place pour bridge/resume.
  const remoteGlobalPeers = new Map<string, Map<string, unknown>>()            // processId → (peerId → meta)
  const remoteRoomPeers   = new Map<string, Map<string, Map<string, unknown>>>() // room → processId → (peerId → meta)

  // historique OPT-IN par salon (sucre — zone SÉPARÉE de la garde `join`/proxy
  // ci-dessus) — clé jamais posée = comportement HISTORIQUE inchangé, send() ne fait rien de plus
  // qu'avant. Purgé dans leaveRoom quand le salon se vide (plus aucun membre) — purement LOCAL,
  // comme le journal des flux (streams.ts), jamais propagé au cluster.
  const roomHistory = new Map<string, RoomHistoryState>()

  function metaOf(client: MjsWsClient): unknown {
    if (!opts.meta) return {}
    try { return opts.meta(client) ?? {} }
    catch (err) { log('error', t('ws.rooms.meta-a-leve'), { err }); return {} }
  }

  // fusionne LOCAL + DISTANT (dédoublonné par peerId — un même peerId présent sur 2 process ne
  // compte qu'une fois, le DERNIER croisé gagne) — ORDRE de Map préservé (local d'abord, dans
  // son ordre d'arrivée, puis distant) : jamais de passage par un objet JS intermédiaire, dont
  // les clés qui RESSEMBLENT à un entier (ex. identity.id '7') se réordonneraient devant les
  // autres (piège connu de l'itération d'objet) — cf. presenceList (cluster).
  function mergedEntries(room: string | undefined): Map<string, unknown> {
    const local = room === undefined ? globalPeers : roomPeers.get(room)
    const out = new Map<string, unknown>()
    if (local) for (const [id, p] of local) if (safeKey(id)) out.set(id, p.meta)
    const remoteByProcess = room === undefined ? remoteGlobalPeers : remoteRoomPeers.get(room)
    if (remoteByProcess) for (const peers of remoteByProcess.values()) for (const [id, meta] of peers) if (safeKey(id)) out.set(id, meta)
    return out
  }

  function mergedSnapshot(room: string | undefined): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [id, meta] of mergedEntries(room)) out[id] = meta
    return out
  }

  // +1 connexion pour ce peer — 1er arrivant seulement → onFirst (delta 'join')
  function addPeer(agg: Map<string, PeerAgg>, client: MjsWsClient, onFirst: (id: string, meta: unknown) => void): void {
    const id   = peerIdOf(client)
    const meta = metaOf(client)
    let p = agg.get(id)
    if (!p) { p = { meta, members: new Set() }; agg.set(id, p) }
    const wasEmpty = p.members.size === 0
    p.members.add(client)
    p.meta = meta   // toujours la connexion la plus récente
    if (wasEmpty) onFirst(id, meta)
  }

  // -1 connexion pour ce peer — dernier partant seulement → onLast (delta 'leave'). `meta`
  // transmise à onLast (bridge.ts, webhook 'leave') — `p` reste un objet valide après
  // agg.delete(id) (delete ne touche que la Map, pas l'objet PeerAgg pointé par `p`).
  function removePeer(agg: Map<string, PeerAgg>, client: MjsWsClient, onLast: (id: string, meta: unknown) => void): void {
    const id = peerIdOf(client)
    const p  = agg.get(id)
    if (!p || !p.members.has(client)) return
    p.members.delete(client)
    if (p.members.size === 0) { agg.delete(id); onLast(id, p.meta) }
  }

  function broadcastPresence(subs: Set<MjsWsClient> | undefined, p: Record<string, unknown>): void {
    if (!subs) return
    for (const c of subs) rawSend(c, { t: 'µ:presence', p })
  }

  // --- cycle de vie de la connexion — présence GLOBALE, indépendante des salons ---
  function onWelcome(client: MjsWsClient): void {
    addPeer(globalPeers, client, (id, meta) => {
      broadcastPresence(presenceSubsGlobal, { room: undefined, op: 'join', id, meta })
      hooks.onGlobalJoin?.(id, meta)
    })
  }

  function onDisconnect(client: MjsWsClient): void {
    const rooms = clientRooms.get(client)
    if (rooms) { for (const room of Array.from(rooms)) leaveRoom(client, room) }
    removePeer(globalPeers, client, (id) => {
      broadcastPresence(presenceSubsGlobal, { room: undefined, op: 'leave', id })
      hooks.onGlobalLeave?.(id)
    })
    presenceSubsGlobal.delete(client)
    for (const [room, subs] of presenceSubsByRoom) { subs.delete(client); if (subs.size === 0) presenceSubsByRoom.delete(room) }
    lastJoinErrorAt.delete(client)
  }

  // --- µ:join — garde async, dédup silencieuse, delta 'join' ssi 1re connexion du peer ---
  async function handleJoin(client: MjsWsClient, room: string): Promise<void> {
    const already = clientRooms.get(client)
    if (already && already.has(room)) return   // dédup silencieuse — déjà membre

    // plafond de salons par client — SANS lui, un client
    // authentifié pouvait rejoindre un nombre ILLIMITÉ de salons à noms arbitraires : `clientRooms`
    // grossit sans borne, tenue jusqu'à déconnexion (fuite mémoire), EXPOSÉ PAR DÉFAUT tant qu'aucune
    // garde `join` n'est configurée (défaut historique : tout accepté). Vérifié ICI, AVANT même la
    // garde `join` (potentiellement async/HTTP, cf. proxy.ts) — un client qui a déjà atteint son
    // plafond n'a pas à déclencher un aller-retour réseau pour un join de toute façon refusé.
    // `null`/absent = illimité (opt-in explicite, cf. MjsWsLimits.maxRoomsPerClient, core.ts).
    if (opts.maxRoomsPerClient != null && (already?.size ?? 0) >= opts.maxRoomsPerClient) {
      refuseJoin(client, t('ws.rooms.trop-de-salons'))
      return
    }

    if (opts.join) {
      let allowed: unknown
      // join qui LÈVE — MÊME contrat que onMessage (chat.ts) :
      // le détail d'une exception applicative (ex. échec DB, timeout) reste au journal serveur,
      // JAMAIS renvoyé verbatim au client — même message générique que le refus explicite (false).
      try { allowed = await opts.join(room, client) }
      catch (err) { log('error', t('ws.rooms.join-a-leve'), { err }); refuseJoin(client, t('ws.rooms.acces-salon-refuse')); return }
      if (allowed === false) { refuseJoin(client, t('ws.rooms.acces-salon-refuse')); return }
      // cf. le commentaire de MjsWsRoomsHooks.isAlive : abandon silencieux si la
      // connexion est tombée PENDANT cette garde async (onDisconnect a déjà tout purgé)
      if (hooks.isAlive && !hooks.isAlive(client)) return
    }

    let rooms = clientRooms.get(client)
    if (!rooms) { rooms = new Set(); clientRooms.set(client, rooms) }
    rooms.add(room)
    let members = roomMembers.get(room)
    if (!members) { members = new Set(); roomMembers.set(room, members) }
    members.add(client)

    let agg = roomPeers.get(room)
    if (!agg) { agg = new Map(); roomPeers.set(room, agg) }
    addPeer(agg, client, (id, meta) => {
      broadcastPresence(presenceSubsByRoom.get(room), { room, op: 'join', id, meta })
      hooks.onJoin?.(room, id, meta)
    })

    replayHistory(client, room)
  }

  // historique de salon (sucre — zone SÉPARÉE de la garde `join` ci-dessus) — REJEU
  // TRANSPARENT : mêmes trames que le live ({t: type, p}, rien de dédié), dans l'ordre du journal,
  // SYNCHRONE ici donc TOUJOURS avant tout room().send() futur (déclenché par un message reçu plus
  // tard, jamais pendant ce tour synchrone — aucun `await` entre ce point et le retour de
  // handleJoin). No-op si `room` n'a pas d'historique actif (opt-in, cf. MjsWsRoomHandle.history) —
  // un membre DÉJÀ présent ne repasse jamais ici (dédup tout en haut de handleJoin ci-dessus).
  function replayHistory(client: MjsWsClient, room: string): void {
    const hist = roomHistory.get(room)
    if (!hist) return
    for (const entry of hist.journal) rawSend(client, { t: entry.type, p: entry.p })
  }

  // µ:error throttlé (même politique que le rate-limit, guard.ts) — 1 message/s, pas un par refus
  function refuseJoin(client: MjsWsClient, message: string): void {
    const now  = Date.now()
    const last = lastJoinErrorAt.get(client)
    if (last != null && now - last <= RATE_ERROR_THROTTLE_MS) return
    lastJoinErrorAt.set(client, now)
    rawSend(client, { t: 'µ:error', p: { message } })
  }

  // --- µ:leave — client-initié, pas de µ:left en retour (il sait déjà qu'il part) ---
  function handleLeave(client: MjsWsClient, room: string): void {
    leaveRoom(client, room)
  }

  // départ partagé leave()/kick()/disconnect() — `left` posé = kick (µ:left envoyé au visé, message UNIQUE)
  function leaveRoom(client: MjsWsClient, room: string, left?: { reason?: string }): void {
    const rooms = clientRooms.get(client)
    if (!rooms || !rooms.has(room)) return   // no-op silencieux si non membre
    rooms.delete(room)
    if (rooms.size === 0) clientRooms.delete(client)

    const members = roomMembers.get(room)
    if (members) {
      members.delete(client)
      // le salon disparaît (plus aucun membre) : son historique éventuel PART avec
      // lui, même patron que roomMembers/roomPeers juste ici (jamais un registre qui grossit pour
      // des salons morts). À rappeler (history(n)) si ce salon revit après ça, cf. MjsWsRoomHandle.
      if (members.size === 0) { roomMembers.delete(room); roomHistory.delete(room) }
    }

    const agg = roomPeers.get(room)
    if (agg) {
      removePeer(agg, client, (id, meta) => {
        broadcastPresence(presenceSubsByRoom.get(room), { room, op: 'leave', id })
        hooks.onLeave?.(room, id, meta)
      })
      if (agg.size === 0) roomPeers.delete(room)
    }

    if (left) rawSend(client, { t: 'µ:left', p: { room, reason: left.reason } })
  }

  // --- µ:sub-presence — reset immédiat, globale (room absent, TOUS les authentifiés) ou de salon ---
  // canSeePresence (opt-in, cf. MjsWsRoomsOptions) ne
  // gouverne QUE la présence DE SALON — la présence GLOBALE n'a pas de garde, structurellement hors
  // salon (même principe que `join`, jamais consulté pour elle non plus, cf. handleJoin ci-dessus).
  // TOUJOURS async (même choix que handleJoin) : `canSeePresence` absent → aucun `await` ne suspend
  // réellement, le reste s'exécute dans le même tour synchrone — ZÉRO changement observable.
  async function handleSubPresence(client: MjsWsClient, room: string | undefined): Promise<void> {
    if (room == null) {
      presenceSubsGlobal.add(client)
      rawSend(client, { t: 'µ:presence', p: { room: undefined, op: 'reset', peers: mergedSnapshot(undefined) } })
      return
    }

    if (opts.canSeePresence) {
      let allowed: boolean
      // canSeePresence qui LÈVE — MÊME garde que opts.join ci-dessus
      try { allowed = await opts.canSeePresence(room, client) }
      catch (err) { log('error', t('ws.rooms.can-see-presence-a-leve'), { err }); refuseJoin(client, t('ws.rooms.acces-presence-refuse')); return }
      if (allowed === false) { refuseJoin(client, t('ws.rooms.acces-presence-refuse')); return }
      // même course que handleJoin (cf. le commentaire de MjsWsRoomsHooks.isAlive) :
      // abandon silencieux si la connexion est tombée PENDANT cette garde async (onDisconnect a
      // déjà tout purgé) — sinon un abonné FANTÔME resterait inscrit à vie dans presenceSubsByRoom.
      if (hooks.isAlive && !hooks.isAlive(client)) return
    }

    let subs = presenceSubsByRoom.get(room)
    if (!subs) { subs = new Set(); presenceSubsByRoom.set(room, subs) }
    subs.add(client)
    rawSend(client, { t: 'µ:presence', p: { room, op: 'reset', peers: mergedSnapshot(room) } })
  }

  // lecture ponctuelle de la présence agrégée (pont universel, GET /presence) —
  // MÊME source que les deltas µ:presence, jamais recalculée : room absente = globale ;
  // FUSIONNÉE cross-process (mergedEntries — no-op si l'adaptateur est absent)
  function presenceList(room?: string): Array<{ id: string; meta: unknown }> {
    return Array.from(mergedEntries(room), ([id, meta]) => ({ id, meta }))
  }

  // fan-out à encodage unique (perf, cf. core.ts preEncodeFrame/sendPre/fanSend) —
  // INJECTÉ par core.ts (ce fichier ignore tout de µschema/opts.serialize) ; repli boucle rawSend
  // si absent — createRoomsEngine reste une fonction exportée indépendante, appelable SANS
  // core.ts (aucun appelant actuel ne le fait hors createCore, MÊME esprit que hooks={} par
  // défaut) — comportement HISTORIQUE strict, un rawSend par membre, aucun octet de différence.
  const fan: MjsWsFanSend = fanSend ?? ((targets, frame, skip) => { for (const c of targets) { if (skip?.has(c)) continue; rawSend(c, frame) } })

  // --- API applicative — app.room(nom) ---
  function room(name: string): MjsWsRoomHandle {
    return {
      send(type, p, sOpts) {
        const members = roomMembers.get(name)
        if (members) {
          const except = !sOpts?.except ? null : new Set(Array.isArray(sOpts.except) ? sOpts.except : [sOpts.except])
          fan(members, { t: type, p }, except)
        }
        // sucre — journalise CE send() ssi l'historique est actif pour ce salon (opt-in,
        // cf. history() plus bas) : `except` de CET envoi est ignoré à dessein (il ne scope QUE les
        // membres COURANTS — un futur arrivant n'en faisait de toute façon pas partie). Anneau
        // borné : push, puis purge en tête tant que ça dépasse `size` (même patron que pushJournal,
        // streams.ts). INDÉPENDANT de `members` ci-dessus : un send() avant même le tout premier
        // join journalise quand même (le futur 1er arrivant doit le voir).
        const hist = roomHistory.get(name)
        if (hist) { hist.journal.push({ type, p }); if (hist.journal.length > hist.size) hist.journal.shift() }
      },
      get clients(): Iterable<MjsWsClient> { return (roomMembers.get(name) ?? new Set<MjsWsClient>()).values() },
      get size(): number { return roomMembers.get(name)?.size ?? 0 },
      has(client) { return roomMembers.get(name)?.has(client) ?? false },
      kick(clientOrId, reason) {
        const members = roomMembers.get(name)
        if (!members) return
        // par chaîne : id de connexion (client.id) OU id de peer (identity.id) — un
        // utilisateur multi-onglets est alors expulsé sur TOUTES ses connexions du
        // salon, chacune recevant SON µ:left {room, reason} (message unique par connexion)
        const targets: MjsWsClient[] = []
        if (typeof clientOrId === 'string') { for (const c of members) if (c.id === clientOrId || peerIdOf(c) === clientOrId) targets.push(c) }
        else if (members.has(clientOrId)) targets.push(clientOrId)
        for (const t of targets) leaveRoom(t, name, { reason })
      },
      history(n) {
        if (!(n > 0)) { roomHistory.delete(name); return }
        let hist = roomHistory.get(name)
        if (!hist) { hist = { size: n, journal: [] }; roomHistory.set(name, hist) }
        else { hist.size = n }
        while (hist.journal.length > hist.size) hist.journal.shift()
      },
    }
  }

  // --- accroches DISTANTES (cluster, core.ts) — delta de présence venu d'un AUTRE process -----
  // applique au registre distant PUIS rediffuse aux abonnés LOCAUX exactement comme un delta
  // local : pour un client connecté à CE process, un pair distant apparaît/disparaît pareil.

  function remoteRoomBucket(room: string): Map<string, Map<string, unknown>> {
    let m = remoteRoomPeers.get(room)
    if (!m) { m = new Map(); remoteRoomPeers.set(room, m) }
    return m
  }

  function applyRemotePresence(room: string | undefined, processId: string, op: 'join' | 'leave', id: string, meta?: unknown): void {
    const byProcess = room === undefined ? remoteGlobalPeers : remoteRoomBucket(room)
    const subs = room === undefined ? presenceSubsGlobal : presenceSubsByRoom.get(room)
    if (op === 'join') {
      let peers = byProcess.get(processId)
      if (!peers) { peers = new Map(); byProcess.set(processId, peers) }
      peers.set(id, meta)
      broadcastPresence(subs, { room, op: 'join', id, meta })
    } else {
      const peers = byProcess.get(processId)
      peers?.delete(id)
      if (peers && peers.size === 0) byProcess.delete(processId)
      broadcastPresence(subs, { room, op: 'leave', id })
    }
  }

  // bail expiré (cluster, core.ts) — purge TOUS les pairs distants de ce process (global + tous
  // les salons) et émet le `leave` correspondant à chacun, aux abonnés locaux concernés
  function purgeRemoteProcess(processId: string): void {
    const globalOfProc = remoteGlobalPeers.get(processId)
    if (globalOfProc) {
      remoteGlobalPeers.delete(processId)
      for (const id of globalOfProc.keys()) broadcastPresence(presenceSubsGlobal, { room: undefined, op: 'leave', id })
    }
    for (const [room, byProcess] of remoteRoomPeers) {
      const peers = byProcess.get(processId)
      if (!peers) continue
      byProcess.delete(processId)
      if (byProcess.size === 0) remoteRoomPeers.delete(room)
      for (const id of peers.keys()) broadcastPresence(presenceSubsByRoom.get(room), { room, op: 'leave', id })
    }
  }

  // processId de tout process ayant AU MOINS un pair distant tracké ici (global ou en salon) —
  // cf. core.ts checkLeasesNow (bail expiré → purgeRemoteProcess) : la liste à vérifier auprès
  // de l'adaptateur vient d'ICI, jamais recalculée ailleurs.
  function remoteProcessIds(): Set<string> {
    const out = new Set<string>(remoteGlobalPeers.keys())
    for (const byProcess of remoteRoomPeers.values()) for (const pid of byProcess.keys()) out.add(pid)
    return out
  }

  // --- anti-entropie de présence (cf. adapter.ts attachPresenceAntiEntropy) ------------------
  // réconciliation périodique — le bail (checkLeasesNow, core.ts) ne corrige que la mort d'un
  // process ENTIER ; ceci corrige les dérives fines d'un process resté VIVANT (pair fantôme ou
  // manquant après un blip réseau/message perdu). Compare AVANT de muter/émettre (silence si
  // l'instantané REÇU est déjà conforme) ; les mutations passent par applyRemotePresence, le
  // SEUL circuit d'agrégation par identity.id (jamais réinventé ici).

  // instantané COMPACT de la présence LOCALE — { peerId: {meta, rooms} }. `globalPeers` est
  // TOUJOURS un sur-ensemble des présences de salon (welcome précède tout join, cf. core.ts) :
  // un seul passage sur les salons suffit à reconstruire, par peer, la liste de ses salons.
  function localSnapshot(): MjsWsPresencePairs {
    const roomsByPeer = new Map<string, string[]>()
    for (const [room, agg] of roomPeers) for (const id of agg.keys()) {
      let list = roomsByPeer.get(id)
      if (!list) { list = []; roomsByPeer.set(id, list) }
      list.push(room)
    }
    const pairs: MjsWsPresencePairs = {}
    for (const [id, p] of globalPeers) if (safeKey(id)) pairs[id] = { meta: p.meta, rooms: roomsByPeer.get(id) ?? [] }
    return pairs
  }

  // instantané REÇU d'un AUTRE process (`processId`) — recale UNIQUEMENT la part de
  // remoteGlobalPeers/remoteRoomPeers attribuée à CE process (les autres process distants ne
  // sont jamais touchés par cet appel). Charge réseau non fiable — jamais fait confiance sans
  // validation de forme (même politique que handleResync/handleSubStream, core.ts).
  function reconcileRemoteSnapshot(processId: string, snapshot: MjsWsPresenceSnapshot): void {
    const raw = snapshot && typeof snapshot === 'object' ? snapshot.pairs : null
    const pairs = new Map<string, { meta: unknown; rooms: string[] }>()
    if (raw && typeof raw === 'object') for (const id of Object.keys(raw)) {
      if (!safeKey(id)) continue
      const entry = raw[id]
      if (entry && typeof entry === 'object') pairs.set(id, { meta: entry.meta, rooms: Array.isArray(entry.rooms) ? entry.rooms : [] })
    }

    // présence GLOBALE — inconnue ici → join ; connue ici mais absente de l'instantané → leave
    const knownGlobal = remoteGlobalPeers.get(processId)
    for (const [id, entry] of pairs) if (!knownGlobal || !knownGlobal.has(id)) applyRemotePresence(undefined, processId, 'join', id, entry.meta)
    if (knownGlobal) for (const id of Array.from(knownGlobal.keys())) if (!pairs.has(id)) applyRemotePresence(undefined, processId, 'leave', id)

    // présence DE SALON — MÊME principe, par salon listé dans l'instantané (join manquants)
    for (const [id, entry] of pairs) for (const room of entry.rooms) {
      const known = remoteRoomPeers.get(room)?.get(processId)
      if (!known || !known.has(id)) applyRemotePresence(room, processId, 'join', id, entry.meta)
    }
    // présence DE SALON — salons connus ici pour ce processId mais absents (ou plus listés) côté instantané
    for (const [room, byProcess] of remoteRoomPeers) {
      const known = byProcess.get(processId)
      if (!known) continue
      for (const id of Array.from(known.keys())) {
        const entry = pairs.get(id)
        if (!entry || entry.rooms.indexOf(room) === -1) applyRemotePresence(room, processId, 'leave', id)
      }
    }
  }

  // branchement — SEUL appelant d'attachPresenceAntiEntropy ; absent/false = ZÉRO changement de
  // comportement (aucun abonnement, aucun timer, cf. index.ts resolveAntiEntropyOption)
  if (opts._cluster && opts._cluster.antiEntropyMs !== false) {
    attachPresenceAntiEntropy(opts._cluster.adapter, opts._cluster.antiEntropyMs, { localSnapshot, reconcile: reconcileRemoteSnapshot })
  }

  // état/métriques (stats.ts) — GAUGES lues EN DIRECT à la demande (app.stats(), core.ts) :
  // jamais accumulées à part, jamais de drift avec roomMembers/presenceSubs* (source unique).
  // `membresTotal` compte les ADHÉSIONS (un client dans 2 salons compte 2 fois), pas les clients
  // distincts ; `abonnesPresence` = globale + toutes les présences de salon confondues.
  function statsSnapshot(): { nombre: number; membresTotal: number; abonnesPresence: number } {
    let membresTotal = 0
    for (const members of roomMembers.values()) membresTotal += members.size
    let abonnesPresence = presenceSubsGlobal.size
    for (const subs of presenceSubsByRoom.values()) abonnesPresence += subs.size
    return { nombre: roomMembers.size, membresTotal, abonnesPresence }
  }

  return {
    onWelcome, onDisconnect, handleJoin, handleLeave, handleSubPresence, room, presence: presenceList,
    applyRemotePresence, purgeRemoteProcess, remoteProcessIds, statsSnapshot,
  }
}
