// mjs-ws/chat — paquet CHAT v1. MÊME patron que packages.ts::
// paquetEcho (definirPaquet + installer composé SUR l'API PUBLIQUE app.serve/on/room — jamais par
// accès à l'interne de core.ts/rooms.ts) : chatPackage(opts) déclare une FAMILLE de salons de
// discussion, préfixés `opts.prefix` (défaut 'chat:'), chacun adossé à `app.room(prefix+room)`
// pour la diffusion, la présence ET le rejeu d'historique (room().history, cf. rooms.ts + docs/
// 23-mjs-ws.md §4.1 — l'épine dorsale de ce paquet, RIEN de réinventé côté salons).
//
//   import { mjsWs, chatPackage } from 'modularjs-framework/ws'
//   app = mjsWs({ auth: ... })
//   app.use(chatPackage({ moderators: (identity) => (identity as any)?.role === 'admin' }))
//   await app.listen()
//
// Protocole (préfixe 'chat:' — simple CONVENTION de nommage, pas de réservation façon µgame: —
// cf. docs/26-chat.md pour le détail complet et les exemples) :
//   chat:me       CLIENT→SERVEUR (requête, µ:ack)        {}                    → { id, name }
//   chat:send     CLIENT→SERVEUR (fire-and-forget)       { room, text }        → rediffuse chat:message (ou µ:error chat-*)
//   chat:message  SERVEUR→CLIENT (room.send, journalisé) { room, id, text, from:{id,name}, ts }
//   chat:typing   LES DEUX SENS (fire-and-forget)        { room } / { room, from:{id,name} } — JAMAIS journalisé
//   chat:remove   CLIENT→SERVEUR (fire-and-forget, modérateur) { room, id }    → chat:removed (journalisé)
//   chat:removed  SERVEUR→CLIENT (room.send, journalisé) { room, id }
//   chat:mute     CLIENT→SERVEUR (fire-and-forget, modérateur) { room, identityId, durationMs }
//
// Identité — AUCUNE confiance dans le client : `from.id`/`from.name` sont TOUJOURS résolus côté
// serveur depuis `client.identity` (peerIdOf/nameOf ci-dessous, mêmes résolutions que rooms.ts/
// sessions.ts) ; `ts` est TOUJOURS Date.now() serveur, jamais une valeur reçue du client.
//
// `opts.canJoin` — MÊME contrat que `MjsWsRoomsOptions.join` (rooms.ts), délègue aux gardes rooms
// EXISTANTES plutôt que d'en réinventer une : le `µ:join` bas niveau (adhésion au salon MJS-WS,
// présence, rejeu d'historique) reste SEUL gouverné par `mjsWs({ rooms: { join } })` — un paquet
// installé via `app.use()` ne peut PAS s'y brancher (résolu avant toute installation, cf.
// index.ts::mjsWs, packages.ts). `canJoin` ICI est un filet SUPPLÉMENTAIRE réévalué à CHAQUE
// action chat (send/typing/modération) — jamais un remplacement du filet `µ:join`.
//
// Ce que `room().history()` ne permet PAS (v1) — retirer une entrée PRÉCISE du
// journal d'un salon n'a pas de primitive dédiée (cf. rooms.ts::RoomHistoryState, anneau append-
// only) : la suppression d'un message (modération) ne peut donc jamais RÉÉCRIRE le passé, seulement
// diffuser un retrait ULTÉRIEUR — tombstone côté client (cf. runtime/mjs_chat.ts), jamais une
// vraie réécriture d'historique. Aucune persistance au-delà du journal EN MÉMOIRE de
// `room().history()` (purement local, purgé quand le salon se vide, cf. docs/23-mjs-ws.md §4.1) —
// pas de crochet µpersist ici (celui de mjs-server/persist.ts est un mécanisme SÉPARÉ, scopé aux
// `partie`, hors zone de ce paquet) : à combler par une itération future si un vrai stockage est requis.

import { randomBytes } from 'node:crypto'
import type { MjsWsApp, MjsWsClient, MjsWsLogFn, MjsWsLogLevel } from './core.js'
import { definePackage } from './packages.js'
import type { MjsPackage } from './packages.js'
import { peerIdOf } from './rooms.js'
import type { MjsWsJoinFn } from './rooms.js'
import { TokenBucket } from './guard.js'
import { t } from '../messages/index.js'

/** contexte transmis à `opts.onMessage` — `text` déjà VALIDÉ (trimé, forme/longueur) avant l'appel. */
export interface MjsWsChatMessageCtx {
  /** texte COURANT — remplacé en retournant `{ text }` (re-validé ensuite, cf. tête de fichier) */
  text: string
  /** nom COURT du salon (sans le préfixe, ex. 'general') */
  room: string
  client: MjsWsClient
  /** raccourci — identique à `client.identity` */
  identity: unknown
}

export interface MjsWsChatOptions {
  /** préfixe des noms de salon MJS-WS — `app.room(prefix + room)` (défaut `'chat:'`) */
  prefix?: string
  /** longueur maximale d'un message, caractères (défaut 2000) — au-delà (ou vide/non-string) : 'chat-length' */
  maxLength?: number
  /** débit PAR IDENTITÉ ET PAR SALON — seau à jetons (défaut `{ rate: 1, burst: 5 }`) — au-delà : 'chat-rate' */
  rateLimit?: { rate?: number; burst?: number }
  /** messages rejoués au join, `room().history(n)` (défaut 100 ; `<= 0` désactive l'historique) */
  history?: number
  /**
   * garde d'accès À UN SALON, réévaluée à CHAQUE action chat — MÊME contrat que
   * `MjsWsRoomsOptions.join` (rooms.ts) : délègue aux gardes rooms EXISTANTES, n'en réinvente pas
   * une (cf. tête de fichier). Absente (défaut) = aucune restriction chat au-delà de celle déjà en
   * place côté rooms (`mjsWs({ rooms: { join } })`).
   */
  canJoin?: MjsWsJoinFn
  /** transforme (retour `{ text }`) ou rejette (retour `false`/throw → 'chat-denied') un message déjà validé, juste avant diffusion */
  onMessage?(ctx: MjsWsChatMessageCtx): unknown | Promise<unknown>
  /** réservé aux actions de modération (suppression, mute) — `identity` = `client.identity` brut */
  moderators?(identity: unknown): boolean | Promise<boolean>
  /** défaut : console, préfixe '[mjs-ws:chat]' — utilisé UNIQUEMENT pour logguer canJoin/moderators
   *  qui lèvent (le détail reste au journal serveur, jamais au client). */
  onLog?: MjsWsLogFn
}

const DEFAULT_PREFIX      = 'chat:'
const DEFAULT_MAX_LENGTH  = 2000
const DEFAULT_RATE        = 1
const DEFAULT_BURST       = 5
const DEFAULT_HISTORY     = 100
const TYPING_THROTTLE_MS  = 3000

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-ws:chat] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

// balayage mémoire OPPORTUNISTE (durcissement — cf. opportunisticSweep
// plus bas) — détail d'implémentation INTERNE, jamais une option `opts.*` documentée (docs/26-chat.md §7)
const SWEEP_EVERY_N_ACTIONS = 50

// name — `identity.name` si c'est une chaîne non vide, sinon repli `peerIdOf(client)` (lui-même
// `identity.id` puis `client.id`) — id/name TOUJOURS résolus SERVEUR, jamais depuis une charge
// client (même esprit que peerIdOf, rooms.ts/sessions.ts).
//
// `identity.name` est la convention d'identité PARTAGÉE par les paquets : lobby.ts::nameOf lit le
// MÊME champ, accounts.ts l'ÉMET dans le jeton. Elle se renomme d'un seul tenant — jamais dans un
// paquet isolé, sous peine d'un chat qui lirait un champ pendant que le reste en écrit un autre.
function nameOf(client: MjsWsClient): string {
  const identity = client.identity
  if (identity && typeof identity === 'object') {
    const name = (identity as Record<string, unknown>).name
    if (typeof name === 'string' && name) return name
  }
  return peerIdOf(client)
}

// id court, unique — 12 caractères hex (même primitive que stats.ts processId, cf. randomBytes)
function genId(): string {
  return randomBytes(6).toString('hex')
}

/** paquet CHAT — `app.use(chatPackage(opts))` (cf. tête de fichier pour le protocole complet). */
export function chatPackage(opts: MjsWsChatOptions = {}): MjsPackage {
  const prefix     = opts.prefix ?? DEFAULT_PREFIX
  const maxLength  = opts.maxLength ?? DEFAULT_MAX_LENGTH
  const rate       = opts.rateLimit?.rate ?? DEFAULT_RATE
  const burst      = opts.rateLimit?.burst ?? DEFAULT_BURST
  const history    = opts.history ?? DEFAULT_HISTORY
  const onLog      = opts.onLog ?? defaultLog

  // débit — 1 seau PAR (salon, identité), PARTAGÉ entre connexions d'une même identité (2 onglets
  // = même quota — compatible sessionExclusive/anti-triche sans rien faire de spécial)
  const buckets = new Map<string, Map<string, TokenBucket>>()
  // frappe — throttle ~3s PAR (salon, identité) — SÉPARÉ du débit ci-dessus, jamais journalisé
  const lastTypingAt = new Map<string, Map<string, number>>()
  // mute — échéance ms epoch PAR (salon, identité), mémoire PROCESS v1 (cf. tête de fichier —
  // limite multi-processus non couverte, pas répliqué via l'adaptateur cluster)
  const mutedUntil = new Map<string, Map<string, number>>()

  function fullNameOf(room: string): string { return prefix + room }

  function bucketOf(fullName: string, identityId: string): TokenBucket {
    let perRoom = buckets.get(fullName)
    if (!perRoom) { perRoom = new Map(); buckets.set(fullName, perRoom) }
    let b = perRoom.get(identityId)
    if (!b) { b = new TokenBucket(burst, rate); perRoom.set(identityId, b) }
    return b
  }

  function isMuted(fullName: string, identityId: string): boolean {
    const perRoom = mutedUntil.get(fullName)
    const until = perRoom?.get(identityId)
    if (until == null) return false
    if (Date.now() >= until) { perRoom!.delete(identityId); return false }
    return true
  }

  // mémoire bornée (durcissement — contrairement au
  // journal `room().history()` qui se purge tout seul quand un salon se vide (rooms.ts::leaveRoom),
  // `buckets`/`lastTypingAt`/`mutedUntil` ci-dessus ne l'ont jamais fait — croissance sans borne
  // sur un serveur à salons éphémères). AUCUN hook « salon vidé » n'est accessible depuis un paquet (`MjsWsApp`/
  // `MjsWsRoomHandle` n'exposent ni événement ni callback d'adhésion, cf. rooms.ts) — un paquet reste
  // SUR l'API publique (cf. tête de fichier) : purge OPPORTUNISTE ci-dessous, armée à chaque action
  // chat référençant un salon (opportunisticSweep plus bas), coût O(1) amorti sur SWEEP_EVERY_N_ACTIONS.
  let actionsSinceSweep = 0

  // seaux de débit ET throttle de frappe — purgés dès qu'un salon n'a PLUS AUCUN membre
  // (`app.room(fullName).size`, la même primitive publique que isAllowed plus bas) : repartir de
  // zéro au prochain arrivant est sans enjeu pour un seau, et un timestamp de throttle n'a AUCUNE
  // valeur à survivre au vidage (fenêtre de ~3 s, cf. TYPING_THROTTLE_MS) — même sous-arbre par
  // salon, même sort, la sous-map entière part avec la clé, jamais un registre conservé pour un salon mort.
  function sweepBucketsOfEmptyRooms(app: MjsWsApp): void {
    for (const fullName of buckets.keys()) if (app.room(fullName).size === 0) buckets.delete(fullName)
    for (const fullName of lastTypingAt.keys()) if (app.room(fullName).size === 0) lastTypingAt.delete(fullName)
  }

  // mutes — AUCUN rapport avec le vidage d'un salon (on ne démute pas quelqu'un parce que le salon
  // s'est vidé, cf. tête de fichier) : ne balaie QUE les échéances déjà EXPIRÉES, même condition que
  // isMuted ci-dessus mais appliquée à TOUTES les entrées — un mute encore actif traverse ce
  // balayage intact, salon vide ou pas.
  function sweepExpiredMutes(): void {
    const now = Date.now()
    for (const [fullName, perRoom] of mutedUntil) {
      for (const [identityId, until] of perRoom) if (now >= until) perRoom.delete(identityId)
      if (perRoom.size === 0) mutedUntil.delete(fullName)
    }
  }

  // point d'entrée UNIQUE des deux purges ci-dessus — jamais de minuterie dédiée (rien à armer ni
  // fuiter si le paquet ne sert jamais) : un compteur d'actions suffit, cf. tête de fichier.
  function opportunisticSweep(app: MjsWsApp): void {
    actionsSinceSweep++
    if (actionsSinceSweep < SWEEP_EVERY_N_ACTIONS) return
    actionsSinceSweep = 0
    sweepBucketsOfEmptyRooms(app)
    sweepExpiredMutes()
  }

  // garde composite — membre du salon (µ:join bas niveau déjà accepté) ET canJoin (si fourni,
  // filet SUPPLÉMENTAIRE réévalué ICI, cf. tête de fichier) : PAS de cache, `n'invente rien`,
  // toujours réévaluée (canJoin peut dépendre d'un état qui change entre deux actions du même client).
  // canJoin qui LÈVE — MÊME contrat que onMessage (chat:send,
  // catch générique → 'chat-denied') : jamais le détail de l'exception applicative à l'appelant,
  // qui n'est PAS forcément privilégié (canJoin est réévalué à CHAQUE action, pas juste à l'admission).
  async function isAllowed(app: MjsWsApp, fullName: string, client: MjsWsClient): Promise<boolean> {
    if (!app.room(fullName).has(client)) return false
    if (opts.canJoin) {
      let ok: unknown
      try { ok = await opts.canJoin(fullName, client) }
      catch (err) { onLog('error', t('ws.chat.canjoin-a-leve'), { err: err instanceof Error ? err.message : String(err) }); return false }
      if (ok === false) return false
    }
    return true
  }

  // moderators qui LÈVE — MÊME garde que isAllowed ci-dessus : chat:remove/chat:mute l'appellent
  // pour TOUT appelant (pas seulement un modérateur réel), un non-modérateur ne doit donc jamais
  // observer le détail d'une exception applicative.
  async function isModerator(client: MjsWsClient): Promise<boolean> {
    if (!opts.moderators) return false
    try { return await opts.moderators(client.identity) }
    catch (err) { onLog('error', t('ws.chat.moderators-a-leve'), { err: err instanceof Error ? err.message : String(err) }); return false }
  }

  const pkg = definePackage('chat', app => {

    // identité résolue SERVEUR — indépendante du salon, aucun besoin de `canJoin`/appartenance ici
    app.serve('chat:me', (_p, client) => ({ id: peerIdOf(client), name: nameOf(client) }))

    app.on('chat:send', async (p, client) => {
      const room = p?.room
      if (typeof room !== 'string' || !room) return   // salon malformé — trame hors protocole, ignorée silencieusement
      const fullName = fullNameOf(room)
      opportunisticSweep(app)   // mémoire bornée — cf. son commentaire de tête
      if (!(await isAllowed(app, fullName, client))) throw new Error('chat-denied')

      const identityId = peerIdOf(client)
      if (isMuted(fullName, identityId)) throw new Error('chat-muted')
      if (!bucketOf(fullName, identityId).take()) throw new Error('chat-rate')

      let text = p?.text
      if (typeof text !== 'string') throw new Error('chat-length')
      text = text.trim()
      if (!text || text.length > maxLength) throw new Error('chat-length')

      if (opts.onMessage) {
        let result: unknown
        try { result = await opts.onMessage({ text, room, client, identity: client.identity }) }
        catch { throw new Error('chat-denied') }
        if (result === false) throw new Error('chat-denied')
        if (result && typeof result === 'object' && typeof (result as { text?: unknown }).text === 'string') {
          text = (result as { text: string }).text.trim()
        }
        if (!text || text.length > maxLength) throw new Error('chat-length')   // filet — même après transformation
      }

      // armée à CHAQUE envoi (idempotent, cf. rooms.ts::history — jamais une resélection coûteuse) :
      // un salon revenu à zéro membre perd son historique (purge automatique rooms.ts), le rearmer
      // ICI plutôt qu'une fois pour toutes évite un historique qui reste éteint pour de bon après un
      // salon qui s'est vidé puis repeuplé.
      app.room(fullName).history(history)
      const enriched = { room, id: genId(), text, from: { id: identityId, name: nameOf(client) }, ts: Date.now() }
      app.room(fullName).send('chat:message', enriched)
    })

    app.on('chat:typing', async (p, client) => {
      const room = p?.room
      if (typeof room !== 'string' || !room) return
      const fullName = fullNameOf(room)
      opportunisticSweep(app)   // mémoire bornée — cf. son commentaire de tête
      if (!(await isAllowed(app, fullName, client))) return   // best-effort, jamais d'erreur pour un indicateur
      const identityId = peerIdOf(client)
      if (isMuted(fullName, identityId)) return

      let perRoom = lastTypingAt.get(fullName)
      if (!perRoom) { perRoom = new Map(); lastTypingAt.set(fullName, perRoom) }
      const now = Date.now()
      const last = perRoom.get(identityId)
      if (last != null && now - last < TYPING_THROTTLE_MS) return
      perRoom.set(identityId, now)

      // diffusion MANUELLE (jamais room.send) — l'indicateur de frappe est ÉPHÉMÈRE, il ne doit
      // JAMAIS entrer dans le journal d'historique du salon (cf. tête de fichier) ; `.clients` reste
      // une accroche LIVE (core.ts), jamais un instantané figé.
      const payload = { room, from: { id: identityId, name: nameOf(client) } }
      for (const member of app.room(fullName).clients) {
        if (member !== client) member.send('chat:typing', payload)
      }
    })

    app.on('chat:remove', async (p, client) => {
      const room = p?.room
      const id   = p?.id
      if (typeof room !== 'string' || !room || typeof id !== 'string' || !id) return
      const fullName = fullNameOf(room)
      opportunisticSweep(app)   // mémoire bornée — cf. son commentaire de tête
      if (!(await isAllowed(app, fullName, client))) throw new Error('chat-denied')
      if (!(await isModerator(client))) throw new Error('chat-denied')
      // journalisé (si historique actif) — un retrait est TOUJOURS diffusé APRÈS son message, donc
      // jamais évincé du journal AVANT lui (anneau append-only, cf. tête de fichier) : un rejoueur
      // tardif verra les deux, ou aucun des deux, jamais le message SANS son retrait.
      app.room(fullName).send('chat:removed', { room, id })
    })

    app.on('chat:mute', async (p, client) => {
      const room       = p?.room
      const identityId = p?.identityId
      const durationMs = p?.durationMs
      if (typeof room !== 'string' || !room) return
      if (typeof identityId !== 'string' || !identityId) return
      if (typeof durationMs !== 'number' || !isFinite(durationMs) || durationMs <= 0) return
      const fullName = fullNameOf(room)
      opportunisticSweep(app)   // mémoire bornée — cf. son commentaire de tête
      if (!(await isAllowed(app, fullName, client))) throw new Error('chat-denied')
      if (!(await isModerator(client))) throw new Error('chat-denied')
      let perRoom = mutedUntil.get(fullName)
      if (!perRoom) { perRoom = new Map(); mutedUntil.set(fullName, perRoom) }
      perRoom.set(identityId, Date.now() + durationMs)
    })
  })

  // accès à l'état interne à des fins de TEST UNIQUEMENT — même précédent que `(t as any)._opts`
  // (tests/mjs-ws-transport-uws.test.ts) : aucune primitive publique n'expose la taille des seaux
  // de débit ni les échéances de mute, indispensable pour prouver depuis les tests que la purge
  // mémoire ci-dessus (sweepBucketsOfEmptyRooms/sweepExpiredMutes) a bien eu lieu.
  ;(pkg as any)._buckets      = buckets
  ;(pkg as any)._mutedUntil   = mutedUntil
  ;(pkg as any)._lastTypingAt = lastTypingAt
  return pkg
}
