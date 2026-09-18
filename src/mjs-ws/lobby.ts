// mjs-ws/lobby — paquet LOBBY / PRÉSENCE RICHE v1. MÊME patron que packages.ts::echoPackage et chat.ts/
// accounts.ts (definePackage + installer composé SUR l'API PUBLIQUE app.serve/on/room/sendUser —
// jamais par accès à l'interne de core.ts/rooms.ts) : lobbyPackage(opts) déclare un hall d'accueil
// prêt-à-l'emploi — qui est en ligne (avec statut), s'inviter, annoncer une table/partie ouverte et
// la rejoindre en un clic. AUCUNE dépendance dure au module jeu : l'intégration jeu passe par
// `opts.onJoin`, un simple crochet (recette complète, docs/28-lobby.md).
//
//   import { mjsWs, lobbyPackage } from 'mjs-framework/ws'
//   app = mjsWs({ auth: ... })
//   app.use(lobbyPackage({ moderators: (identity) => (identity as any)?.role === 'admin' }))
//   await app.listen()
//
// Protocole (préfixe 'lobby:' — simple CONVENTION de nommage comme 'chat:'/'compte:', pas une
// réservation façon µgame: — cf. docs/28-lobby.md). `hall` figure dans CHAQUE trame (optionnel côté
// client, défaut DEFAULT_HALL = 'hall') — MULTI-HALLS possibles (plusieurs 'lobby:xxx' isolés, un
// même paquet), même esprit que `room` pour chat.ts :
//
//   lobby:enter       CLIENT→SERVEUR (requête, µ:ack)   {hall?} → {me:{id,name}, members:[...]}
//   lobby:status      CLIENT→SERVEUR (fire-and-forget)  {hall?, status, text?}
//   lobby:member      SERVEUR→CLIENT (diffusion, delta) {hall, id, name, status, text, since}
//   lobby:left        SERVEUR→CLIENT (diffusion, delta) {hall, id}
//   lobby:invite      CLIENT→SERVEUR (fire-and-forget)  {hall?, identityId, note?}
//   lobby:invitation  SERVEUR→CLIENT (sendUser, ciblé)  {hall, id, from:{id,name}, note, expiresAt}
//   lobby:reply       CLIENT→SERVEUR (fire-and-forget)  {hall?, id, accepted}
//   lobby:replied     SERVEUR→CLIENT (sendUser, ciblé)  {hall, id, from:{id,name}, accepted}
//   lobby:advertise   CLIENT→SERVEUR (fire-and-forget)  {hall?, title, code?, seats?, meta?}
//   lobby:listing     SERVEUR→CLIENT (diffusion + sendUser au join) {hall, id, from, title, code, seats, meta, expiresAt}
//   lobby:withdraw    CLIENT→SERVEUR (fire-and-forget)  {hall?, id?}   — id absent = SA PROPRE annonce
//   lobby:withdrawn   SERVEUR→CLIENT (diffusion)        {hall, id}
//   lobby:join        CLIENT→SERVEUR (fire-and-forget)  {hall?, id}
//   lobby:applicant   SERVEUR→CLIENT (sendUser, ciblé)  {hall, id, from:{id,name}}
//   lobby:block       CLIENT→SERVEUR (fire-and-forget)  {hall?, identityId}
//
// Identité — AUCUNE confiance dans le client, MÊME résolution que chat.ts (peerIdOf/nameOf,
// duck-typing `identity.name` pour le nom, `identity.id` puis `client.id` pour l'id) : tout
// `from`/`id` est TOUJOURS résolu SERVEUR.
//
// PRÉSENCE — pourquoi une Map INTERNE plutôt que le registre de rooms.ts. Un paquet composé sur
// l'API PUBLIQUE (`MjsWsApp`/`MjsWsRoomHandle`) n'a accès qu'à `room(x).clients` (connexions BRUTES,
// pas agrégées par identité) et `room(x).has/size/kick/history` — aucune primitive n'expose la
// présence AGRÉGÉE par identité avec métadonnées riches (statut/texte/depuis), ni un hook « untel a
// rejoint/quitté » (cf. chat.ts, même limite pour ses seaux de débit — AUCUN hook « salon vidé »
// n'est accessible depuis un paquet). La présence RICHE de ce paquet (`presence`, Map<hall,
// Map<identityId, ...>>) est donc une agrégation MAISON, tenue à jour à `lobby:enter` (création/
// rafraîchissement) et NETTOYÉE au balayage opportuniste (ci-dessous) en comparant contre
// `room(fullName).clients` (agrégation peerIdOf) — jamais en réinventant un registre de MEMBRES
// (celui-là reste `app.room()`, seul juge de qui est réellement connecté : un départ disparaît
// TOUJOURS de `.clients` immédiatement, que ce paquet l'ait remarqué ou non — cf. « Limites » du
// balayage opportuniste, docs/28-lobby.md, pour le délai de propagation aux AUTRES clients).
//
// ABSENT AUTO — même philosophie que le balayage opportuniste des seaux de chat.ts : PAS de nouveau
// ping/heartbeat dédié (le watchdog de silence, core.ts, kick 4000, prouve qu'une détection
// « silence ⇒ action » est un patron déjà VALIDÉ du framework) — mais un paquet composé sur l'API
// publique ne peut PAS lire l'horodatage interne du watchdog (non exposé par `MjsWsClient`) :
// `lastActivity` ci-dessous est donc un horodatage propre à CE paquet, mis à jour à CHAQUE
// action `lobby:*` RÉUSSIE (validée AVANT toute mutation, cf. les handlers) — jamais sur un rejet
// (débit/forme invalide), simplification assumée (cf. docs/28-lobby.md « Limites »). Un auto-absent
// (`awayAuto: true`) revient SEUL à son statut précédent à la prochaine action réussie
// (`touchActivity`) ; un statut 'away' choisi EXPLICITEMENT (`lobby:status`) ne porte JAMAIS ce
// drapeau — il ne revient donc jamais tout seul.
//
// BLOCAGE — « ses invitations sont silencieusement ignorées » : `lobby:invite` ne renvoie
// AUCUNE erreur différente que la cible bloque ou non (seul `lobby-away` — cible non présente DANS
// CE HALL — reste un refus visible) ; le blocage vit dans la présence RICHE de la cible (Set par
// identité), donc SESSION/PROCESS (« même limite v1 que le muet du
// chat ») : redémarrage, ou processus voisin en cluster, table rase.
//
// ANNONCES DE TABLE — générique, AUCUN import du module jeu ici : `lobby:join`
// notifie l'annonceur (`lobby:applicant`) et renvoie l'annonce au demandeur — le VRAI appariement
// (créer/rejoindre une partie mjs-server) reste la responsabilité de l'appli hôte, via
// `opts.onJoin` (best-effort, ne conditionne JAMAIS la notification/le renvoi ci-dessus, cf.
// son commentaire sur le handler `lobby:join`). Cf. docs/28-lobby.md pour la recette complète.
//
// Toutes les Maps internes bornées dès la v1 (cf. chat.ts
// opportunisticSweep) : purge au vidage (sous-Map d'un hall retombée à zéro entrée) + TTL au
// balayage opportuniste (compteur d'actions GLOBAL, cf. SWEEP_EVERY_N_ACTIONS) — jamais de
// minuterie dédiée.

import { randomBytes } from 'node:crypto'
import type { MjsWsApp, MjsWsClient, MjsWsLogFn, MjsWsLogLevel } from './core.js'
import { definePackage } from './packages.js'
import type { MjsPackage } from './packages.js'
import { peerIdOf } from './rooms.js'
import { TokenBucket } from './guard.js'
import { t } from '../messages/index.js'

/** statuts riches — cf. tête de fichier « ABSENT AUTO » pour la nuance auto vs explicite. */
export type MjsWsLobbyStatus = 'free' | 'busy' | 'away'

/** une entrée de `presents[]` (store client ET valeur de retour de `lobby:enter`). */
export interface MjsWsLobbyMember {
  id: string
  name: string
  status: MjsWsLobbyStatus
  text: string | null
  since: number
}

/** charge `lobby:invitation` (sendUser, ciblée) — reçue par TOUTES les connexions de l'invité. */
export interface MjsWsLobbyInvitationPayload {
  id: string
  from: { id: string; name: string }
  note: string | null
  expiresAt: number
}

/** charge `lobby:listing` (diffusion de salon, et sendUser direct au demandeur d'un rejoindre). */
export interface MjsWsLobbyListingPayload {
  id: string
  from: { id: string; name: string }
  title: string
  code: string | null
  seats: number | null
  meta: unknown
  expiresAt: number
}

/** contexte transmis à `opts.onJoin` — cf. tête de fichier « ANNONCES DE TABLE ». */
export interface MjsWsLobbyJoinCtx {
  listing: MjsWsLobbyListingPayload
  client: MjsWsClient
  identity: unknown
}

export interface MjsWsLobbyOptions {
  /** préfixe des noms de salon MJS-WS — `app.room(prefixe + hall)` (défaut `'lobby:'`). */
  prefix?: string
  /** longueur max du texte court de statut, caractères (défaut 60) — au-delà : 'lobby-text-invalid'. */
  statusTextMaxLength?: number
  /** intervalle minimal entre deux changements de statut, PAR IDENTITÉ, ms (défaut 5000) — 'lobby-rate'. */
  statusRateMs?: number
  /** seuil d'absence automatique, ms (défaut 300000 = 5 min) — `null` désactive le mécanisme. */
  awayAfterMs?: number | null
  /** durée de vie d'une invitation, ms (défaut 60000). */
  invitationTtlMs?: number
  /** débit d'envoi d'invitations PAR IDENTITÉ — seau à jetons (défaut `{ rate: 6/60, burst: 6 }` ≈ 6/min). */
  invitationRate?: { rate?: number; burst?: number }
  /** longueur max de la note d'invitation, caractères (défaut 200). */
  noteMaxLength?: number
  /** longueur max du titre d'une annonce, caractères (défaut 80) — au-delà : 'lobby-title-invalid'. */
  listingTitleMaxLength?: number
  /** longueur max du code d'une annonce, caractères (défaut 40, même statut que `noteMaxLength`)
   *  — au-delà, TRONQUÉ (pas un refus, cf. lobby:advertise). */
  listingCodeMaxLength?: number
  /** taille max de `meta` UNE FOIS sérialisée en JSON, caractères (défaut 2000) — au-delà
   *  (ou valeur non sérialisable) : 'lobby-meta-invalid'. */
  listingMetaMaxLength?: number
  /** débit d'annonce/mise à jour de table PAR IDENTITÉ — seau à jetons (défaut `{ rate: 6/60, burst:
   *  6 }` ≈ 6/min, même cadence que `invitationRate`) — au-delà : 'lobby-rate'. */
  listingRate?: { rate?: number; burst?: number }
  /** durée de vie d'une annonce, ms (défaut 300000 = 5 min). */
  listingTtlMs?: number
  /** réservé aux actions de modération (`lobby:withdraw` sur l'annonce d'un AUTRE) — `identity` = `client.identity` brut. */
  moderators?(identity: unknown): boolean | Promise<boolean>
  /**
   * crochet d'appariement — appelé (best-effort, jamais bloquant) quand quelqu'un `lobby:join`
   * une annonce, APRÈS que l'annonceur ait été notifié (`lobby:applicant`) et que l'annonce ait été
   * renvoyée au demandeur : brancher ICI l'appariement mjs-server réel (recette docs/28-lobby.md).
   * PAS d'import du module jeu dans ce fichier (cf. tête de fichier « ANNONCES DE TABLE »).
   */
  onJoin?(ctx: MjsWsLobbyJoinCtx): unknown | Promise<unknown>
  /** défaut : console, préfixe '[mjs-ws:lobby]' — utilisé UNIQUEMENT pour logguer un `onJoin` qui lève. */
  onLog?: MjsWsLogFn
}

const DEFAULT_PREFIXE                    = 'lobby:'
const DEFAULT_HALL                       = 'hall'
const DEFAULT_STATUT_TEXTE_MAX_LENGTH    = 60
const DEFAULT_STATUT_DEBIT_MS            = 5000
const DEFAULT_ABSENT_APRES_MS            = 300000
const DEFAULT_INVITATION_TTL_MS          = 60000
const DEFAULT_INVITATION_DEBIT_BURST     = 6
const DEFAULT_INVITATION_DEBIT_RATE      = 6 / 60
const DEFAULT_NOTE_MAX_LENGTH            = 200
const DEFAULT_ANNONCE_TITRE_MAX_LENGTH   = 80
const DEFAULT_ANNONCE_CODE_MAX_LENGTH    = 40
const DEFAULT_ANNONCE_TTL_MS             = 300000
// meta — taille/forme + débit dédié (AMPLIFICATION diffusée à tout
// le hall, sans aucune borne ni seau propre, contrairement à title/code/note/invitation) — même
// ordre de grandeur qu'un message de chat (chat.ts::DEFAULT_MAX_LENGTH), même cadence que l'invite.
const DEFAULT_ANNONCE_META_MAX_LENGTH    = 2000
const DEFAULT_ANNONCE_DEBIT_BURST        = 6
const DEFAULT_ANNONCE_DEBIT_RATE         = 6 / 60
const VALID_STATUSES: readonly MjsWsLobbyStatus[] = ['free', 'busy', 'away']

// balayage mémoire OPPORTUNISTE (cf. chat.ts::
// opportunisticSweep) — détail d'implémentation INTERNE, jamais une option `opts.*` documentée.
const SWEEP_EVERY_N_ACTIONS = 50

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-ws:lobby] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

// name — MÊME résolution que chat.ts::nameOf (`identity.name`, repli `peerIdOf(client)`) :
// dupliquée ICI plutôt qu'importée (chat.ts est hors zone, lecture seule) — même esprit que
// accounts.ts qui n'a pas eu besoin de ce helper.
// Convention d'identité PARTAGÉE : accounts.ts l'ÉMET dans le jeton, chat.ts le lit à l'identique.
function nameOf(client: MjsWsClient): string {
  const identity = client.identity
  if (identity && typeof identity === 'object') {
    const name = (identity as Record<string, unknown>).name
    if (typeof name === 'string' && name) return name
  }
  return peerIdOf(client)
}

// id court, unique — même primitive que chat.ts::genId (randomBytes(6), pas les 8 de accounts.ts :
// ici des id ÉPHÉMÈRES — invitation/annonce —, jamais un identifiant de compte persisté).
function genId(): string {
  return randomBytes(6).toString('hex')
}

// présence riche PAR HALL ET PAR IDENTITÉ — cf. tête de fichier « PRÉSENCE ».
interface PresenceEntry {
  name: string
  status: MjsWsLobbyStatus
  text: string | null
  since: number
  lastActivity: number
  /** statut à restaurer quand `awayAuto` revient — `null` si aucun absent-auto en cours. */
  previousStatus: MjsWsLobbyStatus | null
  /** `true` ssi le statut 'absent' courant a été posé par le balayage (jamais par l'identité elle-même). */
  awayAuto: boolean
  /** dernier `lobby:status` réussi, ms epoch — débit 1 changement / `statusRateMs` (défaut 5 s). */
  lastStatusChangeAt: number | null
  /** identités bloquées PAR cette identité — session/process (cf. tête de fichier « BLOCAGE »). */
  blocked: Set<string>
  /** seau à jetons des invitations ENVOYÉES par cette identité — créé paresseusement au 1er `lobby:invite`. */
  inviteBucket: TokenBucket | null
  /** seau à jetons des annonces (`lobby:advertise`) — créé paresseusement. */
  listingBucket: TokenBucket | null
}

interface ListingRecord {
  id: string
  fromId: string
  fromNick: string
  title: string
  code: string | null
  seats: number | null
  meta: unknown
  expireAt: number
}

interface InvitationRecord {
  id: string
  fromId: string
  fromNick: string
  aId: string
  note: string | null
  expireAt: number
}

/** paquet LOBBY — `app.use(lobbyPackage(opts))` (cf. tête de fichier pour le protocole complet). */
export function lobbyPackage(opts: MjsWsLobbyOptions = {}): MjsPackage {
  const prefix               = opts.prefix ?? DEFAULT_PREFIXE
  const statusTextMaxLength  = opts.statusTextMaxLength ?? DEFAULT_STATUT_TEXTE_MAX_LENGTH
  const statusRateMs         = opts.statusRateMs ?? DEFAULT_STATUT_DEBIT_MS
  // `undefined` (absent) → défaut ; `null` (explicite) → désactivé — cf. MjsWsLobbyOptions.awayAfterMs
  const awayAfterMs         = opts.awayAfterMs === undefined ? DEFAULT_ABSENT_APRES_MS : opts.awayAfterMs
  const invitationTtlMs       = opts.invitationTtlMs ?? DEFAULT_INVITATION_TTL_MS
  const inviteDebitBurst      = opts.invitationRate?.burst ?? DEFAULT_INVITATION_DEBIT_BURST
  const inviteDebitRate       = opts.invitationRate?.rate ?? DEFAULT_INVITATION_DEBIT_RATE
  const noteMaxLength         = opts.noteMaxLength ?? DEFAULT_NOTE_MAX_LENGTH
  const titreMaxLength        = opts.listingTitleMaxLength ?? DEFAULT_ANNONCE_TITRE_MAX_LENGTH
  const codeMaxLength         = opts.listingCodeMaxLength ?? DEFAULT_ANNONCE_CODE_MAX_LENGTH
  const listingTtlMs          = opts.listingTtlMs ?? DEFAULT_ANNONCE_TTL_MS
  const listingMetaMaxLength  = opts.listingMetaMaxLength ?? DEFAULT_ANNONCE_META_MAX_LENGTH
  const listingDebitBurst     = opts.listingRate?.burst ?? DEFAULT_ANNONCE_DEBIT_BURST
  const listingDebitRate      = opts.listingRate?.rate ?? DEFAULT_ANNONCE_DEBIT_RATE
  const onLog                 = opts.onLog ?? defaultLog

  // présence riche — Map<hall complet, Map<identityId, PresenceEntry>> (cf. tête de fichier « PRÉSENCE »)
  const presence = new Map<string, Map<string, PresenceEntry>>()
  // annonces actives — Map<hall complet, Map<annonceId, AnnonceRecord>> + index identité→annonceId
  // COURANTE (« 1 annonce active par identité ») pour la retrouver/la remplacer en O(1)
  const listings           = new Map<string, Map<string, ListingRecord>>()
  const listingByIdentity = new Map<string, Map<string, string>>()
  // invitations en attente — Map<hall complet, Map<invitationId, InvitationRecord>>
  const invitations = new Map<string, Map<string, InvitationRecord>>()

  let actionsDepuisBalayage = 0

  function salonPourHall(hall: string): string { return prefix + hall }
  // fullName → hall COURT (retire le préfixe) — utilisé au balayage, qui ne connaît que fullName
  // (cf. tousLesHalls) mais doit reposer `hall` dans les trames diffusées (routage client, cf. tête
  // de fichier « multi-halls »).
  function hallDeFullName(fullName: string): string { return fullName.slice(prefix.length) }
  // `hall` reçu du client — absent/non-chaîne/vide → DEFAULT_HALL, jamais un refus (même esprit que
  // `room` de chat.ts, qui lui EXIGE une chaîne — ici un défaut existe : un seul salon
  // par défaut).
  function hallOf(p: any): string {
    const h = p?.hall
    return typeof h === 'string' && h ? h : DEFAULT_HALL
  }

  function presenceHall(fullName: string): Map<string, PresenceEntry> {
    let m = presence.get(fullName)
    if (!m) { m = new Map(); presence.set(fullName, m) }
    return m
  }
  function listingsOfHall(fullName: string): Map<string, ListingRecord> {
    let m = listings.get(fullName)
    if (!m) { m = new Map(); listings.set(fullName, m) }
    return m
  }
  function listingIndexOfHall(fullName: string): Map<string, string> {
    let m = listingByIdentity.get(fullName)
    if (!m) { m = new Map(); listingByIdentity.set(fullName, m) }
    return m
  }
  function invitationsOfHall(fullName: string): Map<string, InvitationRecord> {
    let m = invitations.get(fullName)
    if (!m) { m = new Map(); invitations.set(fullName, m) }
    return m
  }

  // membre du salon MJS-WS bas niveau (µ:join déjà accepté, cf. `mjsWs({ rooms: { join } })`) — MÊME
  // garde que chat.ts::isAllowed, sans l'équivalent `canJoin` (aucun besoin identifié :
  // ce paquet n'a qu'UN hall par défaut, pas une famille de salons à filtrer un par un).
  function estMembre(app: MjsWsApp, fullName: string, client: MjsWsClient): boolean {
    return app.room(fullName).has(client)
  }
  // moderators qui LÈVE — MÊME contrat que onMessage (chat.ts) :
  // lobby:withdraw appelle estModerateur pour TOUT appelant (pas seulement un modérateur réel), un
  // non-modérateur ne doit donc jamais observer le détail d'une exception applicative — générique
  // au client ('lobby-denied', posé par l'appelant), détail au journal serveur.
  async function estModerateur(client: MjsWsClient): Promise<boolean> {
    if (!opts.moderators) return false
    try { return await opts.moderators(client.identity) }
    catch (err) { onLog('error', t('ws.lobby.moderators-a-leve'), { err: err instanceof Error ? err.message : String(err) }); return false }
  }
  // présence AGRÉGÉE par identité (peerIdOf), calculée à la demande depuis `room().clients` — jamais
  // mise en cache (cf. tête de fichier « PRÉSENCE ») : source de vérité UNIQUE de « qui est réellement
  // connecté », que ce paquet l'ait remarqué ou non.
  function estPresentDansHall(app: MjsWsApp, fullName: string, identityId: string): boolean {
    for (const c of app.room(fullName).clients) if (peerIdOf(c) === identityId) return true
    return false
  }

  function broadcastPresence(app: MjsWsApp, fullName: string, hall: string, identityId: string, entry: PresenceEntry, exceptClient?: MjsWsClient): void {
    const charge: MjsWsLobbyMember & { hall: string } = { hall, id: identityId, name: entry.name, status: entry.status, text: entry.text, since: entry.since }
    app.room(fullName).send('lobby:member', charge, { except: exceptClient })
  }

  function snapshotMembers(fullName: string): MjsWsLobbyMember[] {
    const pres = presence.get(fullName)
    if (!pres) return []
    return Array.from(pres, ([id, e]) => ({ id, name: e.name, status: e.status, text: e.text, since: e.since }))
  }

  // touche l'activité — MAJ lastActivity + revient d'un absent-AUTO (jamais un absent explicite,
  // cf. tête de fichier « ABSENT AUTO ») ; retourne `true` si un retour a eu lieu (l'appelant décide
  // s'il doit diffuser ce retour, cf. toucherEtRevenir juste en dessous et lobby:status qui l'ignore
  // — son propre `diffuserPresence` final reflète déjà l'état à jour, un 2e envoi serait redondant).
  function touchActivity(entry: PresenceEntry): boolean {
    entry.lastActivity = Date.now()
    if (entry.awayAuto) {
      entry.status = entry.previousStatus ?? 'free'
      entry.previousStatus = null
      entry.awayAuto = false
      return true
    }
    return false
  }

  // sucre — touche l'activité ET diffuse immédiatement si un retour d'absence a eu lieu (handlers qui
  // ne diffusent pas déjà eux-mêmes un lobby:member en sortie, ex. inviter/repondre/annoncer/
  // retirer/rejoindre/bloquer).
  function touchAndReturn(app: MjsWsApp, fullName: string, hall: string, identityId: string, entry: PresenceEntry): void {
    if (touchActivity(entry)) broadcastPresence(app, fullName, hall, identityId, entry)
  }

  // retire l'annonce COURANTE d'une identité si elle existe (remplacement à `lobby:advertise`, ou
  // départ définitif du hall au balayage) — diffuse TOUJOURS lobby:withdrawn (jamais un retrait muet :
  // un client peut avoir déjà affiché cette annonce).
  function withdrawListingOfIdentity(app: MjsWsApp, fullName: string, hall: string, identityId: string): void {
    const idx = listingByIdentity.get(fullName)
    const id = idx?.get(identityId)
    if (id == null) return
    listings.get(fullName)?.delete(id)
    idx!.delete(identityId)
    app.room(fullName).send('lobby:withdrawn', { hall, id })
  }

  // invitations pendantes CONCERNANT cette identité (émises PAR elle ou reçues PAR elle) — purgées
  // sans notification (cf. tête de fichier : le client les expire déjà localement sur `expiresAt`, cf.
  // docs/28-lobby.md) — appelée au départ définitif du hall (balayage), jamais ailleurs.
  function purgerInvitationsIdentite(fullName: string, identityId: string): void {
    const invs = invitations.get(fullName)
    if (!invs) return
    for (const [id, rec] of invs) if (rec.fromId === identityId || rec.aId === identityId) invs.delete(id)
  }

  function tousLesHalls(): Set<string> {
    const out = new Set<string>()
    for (const k of presence.keys()) out.add(k)
    for (const k of listings.keys()) out.add(k)
    for (const k of invitations.keys()) out.add(k)
    return out
  }

  // un passage de balayage pour UN hall — départs (présence riche désynchronisée de room().clients),
  // absent-auto, TTL des annonces/invitations. Mêmes garanties de bornage que chat.ts :
  // sous-Map retombée à zéro entrée → la clé de hall elle-même est réclamée (jamais un registre qui
  // grossit pour des halls morts).
  function balayerHall(app: MjsWsApp, fullName: string): void {
    const hall = hallDeFullName(fullName)
    const now = Date.now()

    const pres = presence.get(fullName)
    if (pres) {
      for (const [id, entry] of pres) {
        if (!estPresentDansHall(app, fullName, id)) {
          pres.delete(id)
          app.room(fullName).send('lobby:left', { hall, id })
          withdrawListingOfIdentity(app, fullName, hall, id)
          purgerInvitationsIdentite(fullName, id)
          continue
        }
        if (awayAfterMs != null && !entry.awayAuto && entry.status !== 'away' && now - entry.lastActivity > awayAfterMs) {
          entry.previousStatus = entry.status
          entry.status = 'away'
          entry.awayAuto = true
          broadcastPresence(app, fullName, hall, id, entry)
        }
      }
      if (pres.size === 0) presence.delete(fullName)
    }

    const ann = listings.get(fullName)
    if (ann) {
      for (const [id, rec] of ann) {
        if (now < rec.expireAt) continue
        ann.delete(id)
        listingByIdentity.get(fullName)?.delete(rec.fromId)
        app.room(fullName).send('lobby:withdrawn', { hall, id })
      }
      if (ann.size === 0) { listings.delete(fullName); listingByIdentity.delete(fullName) }
    }

    const invs = invitations.get(fullName)
    if (invs) {
      for (const [id, rec] of invs) if (now >= rec.expireAt) invs.delete(id)
      if (invs.size === 0) invitations.delete(fullName)
    }
  }

  // point d'entrée UNIQUE du balayage — jamais de minuterie dédiée, cf. chat.ts::opportunisticSweep
  // (même seuil SWEEP_EVERY_N_ACTIONS, même compteur GLOBAL au paquet entier, pas par hall).
  function opportunisticSweep(app: MjsWsApp): void {
    actionsDepuisBalayage++
    if (actionsDepuisBalayage < SWEEP_EVERY_N_ACTIONS) return
    actionsDepuisBalayage = 0
    for (const fullName of tousLesHalls()) balayerHall(app, fullName)
  }

  const pkg = definePackage('lobby', app => {

    // entrée dans le hall — crée (1re fois) ou rafraîchit (reconnexion/2e onglet) la présence riche
    // de cette identité, renvoie l'état COMPLET (diffusion delta, état complet au
    // join). `estMembre` suppose le µ:join bas niveau déjà accepté — MÊME ordre que sock.chat()
    // (mjs_chat.ts appelle `this.room(...)` avant `lobby:enter`, FIFO par connexion garantit l'ordre).
    app.serve('lobby:enter', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')

      const identityId = peerIdOf(client)
      const pres = presenceHall(fullName)
      let entry = pres.get(identityId)
      if (!entry) {
        const now = Date.now()
        entry = {
          name: nameOf(client), status: 'free', text: null, since: now, lastActivity: now,
          previousStatus: null, awayAuto: false, lastStatusChangeAt: null, blocked: new Set(), inviteBucket: null,
          listingBucket: null,
        }
        pres.set(identityId, entry)
        // annoncé aux AUTRES membres seulement — CE client reçoit l'état complet ci-dessous, se
        // rebroadcaster sa propre arrivée serait redondant (MÊME choix que rooms.ts::onFirst, qui
        // exclut structurellement l'émetteur puisqu'il n'est pas encore abonné à sa propre présence).
        broadcastPresence(app, fullName, hall, identityId, entry, client)
      } else {
        entry.name = nameOf(client)
        if (touchActivity(entry)) broadcastPresence(app, fullName, hall, identityId, entry)
      }
      return { me: { id: identityId, name: entry.name }, members: snapshotMembers(fullName) }
    })

    // statut riche — fire-and-forget (erreurs lobby-* exposées comme chat),
    // validation COMPLÈTE avant toute mutation (jamais d'état à moitié appliqué sur un rejet).
    app.on('lobby:status', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')   // jamais entré (lobby:enter) — cf. tête de fichier

      const status = p?.status
      if (typeof status !== 'string' || VALID_STATUSES.indexOf(status as MjsWsLobbyStatus) === -1) throw new Error('lobby-status-invalid')
      let text: string | null = null
      if (p?.text !== undefined) {
        if (typeof p.text !== 'string') throw new Error('lobby-text-invalid')
        text = p.text.trim() || null
        if (text && text.length > statusTextMaxLength) throw new Error('lobby-text-invalid')
      }
      const now = Date.now()
      if (entry.lastStatusChangeAt != null && now - entry.lastStatusChangeAt < statusRateMs) throw new Error('lobby-rate')

      // validé — applique (le choix EXPLICITE écrase tout de suite un éventuel absent-auto en cours,
      // cf. toucherActivite : pas besoin de son retour ici, ce diffuserPresence final fait foi)
      touchActivity(entry)
      entry.name = nameOf(client)
      entry.lastStatusChangeAt = now
      entry.status = status as MjsWsLobbyStatus
      entry.text = text
      entry.previousStatus = null
      entry.awayAuto = false
      broadcastPresence(app, fullName, hall, identityId, entry)
    })

    // invitation — fire-and-forget. Blocage = AUCUNE différence observable pour l'émetteur (cf. tête
    // de fichier « BLOCAGE ») ; seule une cible ABSENTE du hall (jamais rencontrée, ou déjà repartie)
    // reste un refus visible ('lobby-away').
    app.on('lobby:invite', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      const cibleId = p?.identityId
      if (typeof cibleId !== 'string' || !cibleId) throw new Error('lobby-away')
      if (cibleId === identityId) throw new Error('lobby-self-invite')
      if (!estPresentDansHall(app, fullName, cibleId)) throw new Error('lobby-away')

      let note: string | null = null
      if (p?.note !== undefined) {
        if (typeof p.note !== 'string') throw new Error('lobby-text-invalid')
        note = p.note.trim() || null
        if (note && note.length > noteMaxLength) throw new Error('lobby-text-invalid')
      }

      if (!entry.inviteBucket) entry.inviteBucket = new TokenBucket(inviteDebitBurst, inviteDebitRate)
      if (!entry.inviteBucket.take()) throw new Error('lobby-rate')

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)

      // bloqué PAR la cible → ignoré silencieusement à partir d'ici (AUCUNE trace, AUCUNE différence
      // de réponse pour l'émetteur — le débit/la validation ci-dessus se sont déjà appliqués tout pareil)
      const cibleEntry = presence.get(fullName)?.get(cibleId)
      if (cibleEntry?.blocked.has(identityId)) return

      const id = genId()
      const now = Date.now()
      const expireAt = now + invitationTtlMs
      invitationsOfHall(fullName).set(id, { id, fromId: identityId, fromNick: entry.name, aId: cibleId, note, expireAt })
      app.sendUser(cibleId, 'lobby:invitation', { hall, id, from: { id: identityId, name: entry.name }, note, expiresAt: expireAt })
    })

    // réponse à une invitation REÇUE — anti-énumération légère, MÊME esprit que accounts.ts::account-
    // denied : une invitation inconnue ET une invitation qui n'est pas la MIENNE renvoient la MÊME
    // erreur ('lobby-invitation-unknown'), jamais de distinction qui confirmerait l'existence
    // d'une invitation adressée à quelqu'un d'autre.
    app.on('lobby:reply', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      const id = p?.id
      if (typeof id !== 'string' || !id) throw new Error('lobby-invitation-unknown')
      const invs = invitations.get(fullName)
      const inv = invs?.get(id)
      if (!inv || inv.aId !== identityId) throw new Error('lobby-invitation-unknown')

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)

      invs!.delete(id)   // consommée — une réponse ne vaut qu'une fois
      app.sendUser(inv.fromId, 'lobby:replied', { hall, id, from: { id: identityId, name: entry.name }, accepted: p?.accepted === true })
    })

    // annonce de table — 1 annonce active par identité (la nouvelle REMPLACE l'ancienne) :
    // retrait diffusé AVANT la nouvelle annonce (un client ne voit jamais les deux
    // coexister). `code`/`seats`/`meta` sont permissifs (coercés/tronqués, jamais un refus) — seul
    // `title` est strictement validé ('lobby-title-invalid').
    app.on('lobby:advertise', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      let title = p?.title
      if (typeof title !== 'string') throw new Error('lobby-title-invalid')
      title = title.trim()
      if (!title || title.length > titreMaxLength) throw new Error('lobby-title-invalid')

      let code: string | null = null
      if (typeof p?.code === 'string') code = p.code.trim().slice(0, codeMaxLength) || null
      let seats: number | null = null
      if (typeof p?.seats === 'number' && isFinite(p.seats) && p.seats >= 0) seats = Math.floor(p.seats)

      // meta — taille/forme bornées (amplification taille(meta) ×
      // membres du hall, à CHAQUE advertise) : JSON sérialisé ≤ listingMetaMaxLength, même refus
      // catalogué qu'un titre invalide — jamais de troncature silencieuse (contrairement à `code`,
      // meta est une structure, pas juste un texte tronquable sans perte de sens).
      let meta: unknown = null
      if (p?.meta !== undefined) {
        let serialized: string | undefined
        try { serialized = JSON.stringify(p.meta) }
        catch { throw new Error('lobby-meta-invalid') }
        if (typeof serialized !== 'string' || serialized.length > listingMetaMaxLength) throw new Error('lobby-meta-invalid')
        meta = p.meta
      }

      // débit dédié — même patron que inviteBucket (lobby:invite) : lobby:advertise était le SEUL
      // protocole riche sans seau propre (seul le débit générique de connexion s'appliquait).
      if (!entry.listingBucket) entry.listingBucket = new TokenBucket(listingDebitBurst, listingDebitRate)
      if (!entry.listingBucket.take()) throw new Error('lobby-rate')

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)

      withdrawListingOfIdentity(app, fullName, hall, identityId)   // remplace l'ancienne, s'il y en a une

      const id = genId()
      const now = Date.now()
      const expireAt = now + listingTtlMs
      const record: ListingRecord = { id, fromId: identityId, fromNick: entry.name, title, code, seats, meta, expireAt }
      listingsOfHall(fullName).set(id, record)
      listingIndexOfHall(fullName).set(identityId, id)
      app.room(fullName).send('lobby:listing', { hall, id, from: { id: identityId, name: entry.name }, title, code, seats, meta, expiresAt: expireAt })
    })

    // retrait — SA PROPRE annonce (id omis, résolu via l'index identité→annonce) OU une annonce
    // ARBITRAIRE si modérateur (id fourni, MÊME signature que chat.ts::isModerator). Deux codes
    // d'erreur distincts et volontairement séparés : 'lobby-listing-unknown' (fait objectif — id
    // inconnu, déjà expiré, ou aucune annonce active à retirer sans id) vs 'lobby-denied' (fait
    // AUTORISATION — annonce trouvée mais ni propriétaire ni modérateur).
    app.on('lobby:withdraw', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      const idDemande = p?.id
      const cibleId = typeof idDemande === 'string' && idDemande ? idDemande : listingByIdentity.get(fullName)?.get(identityId)
      const record = cibleId ? listings.get(fullName)?.get(cibleId) : undefined
      if (!record) throw new Error('lobby-listing-unknown')

      const estProprietaire = record.fromId === identityId
      if (!estProprietaire && !(await estModerateur(client))) throw new Error('lobby-denied')

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)

      listings.get(fullName)?.delete(record.id)
      listingByIdentity.get(fullName)?.delete(record.fromId)
      app.room(fullName).send('lobby:withdrawn', { hall, id: record.id })
    })

    // rejoindre une annonce — notifie l'annonceur (lobby:applicant) ET renvoie l'annonce au demandeur
    // (`client.send`, MÊME type que la diffusion `lobby:listing` — un seul handler client à écrire,
    // cf. runtime/mjs_lobby.ts). `opts.onJoin` best-effort : jamais avant, jamais conditionnant
    // les deux étapes précédentes (cf. tête de fichier « ANNONCES DE TABLE ») — une appli qui veut
    // réellement refuser un rejoindre le fait dans SA PROPRE logique d'appariement, pas ici.
    app.on('lobby:join', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      const id = p?.id
      if (typeof id !== 'string' || !id) throw new Error('lobby-listing-unknown')
      const record = listings.get(fullName)?.get(id)
      if (!record) throw new Error('lobby-listing-unknown')

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)

      const snapshot: MjsWsLobbyListingPayload = {
        id: record.id, from: { id: record.fromId, name: record.fromNick }, title: record.title,
        code: record.code, seats: record.seats, meta: record.meta, expiresAt: record.expireAt,
      }
      app.sendUser(record.fromId, 'lobby:applicant', { hall, id: record.id, from: { id: identityId, name: entry.name } })
      client.send('lobby:listing', { hall, ...snapshot })

      if (opts.onJoin) {
        try { await opts.onJoin({ listing: snapshot, client, identity: client.identity }) }
        catch (err) { onLog('error', t('ws.lobby.onrejoindre-a-leve'), { err: err instanceof Error ? err.message : String(err) }) }
      }
    })

    // blocage — session/process, cf. tête de fichier « BLOCAGE ». Payload malformé (identityId
    // absent/non-chaîne) ou auto-blocage : ignoré silencieusement, jamais une erreur métier (rien à
    // signaler de plus qu'un no-op, MÊME esprit que chat.ts pour un salon malformé).
    app.on('lobby:block', async (p, client) => {
      const hall = hallOf(p)
      const fullName = salonPourHall(hall)
      opportunisticSweep(app)
      if (!estMembre(app, fullName, client)) throw new Error('lobby-denied')
      const identityId = peerIdOf(client)
      const entry = presence.get(fullName)?.get(identityId)
      if (!entry) throw new Error('lobby-denied')

      const cibleId = p?.identityId
      if (typeof cibleId !== 'string' || !cibleId || cibleId === identityId) return

      entry.name = nameOf(client)
      touchAndReturn(app, fullName, hall, identityId, entry)
      entry.blocked.add(cibleId)
    })
  })

  // accès à l'état interne à des fins de TEST UNIQUEMENT — MÊME précédent que chat.ts (_buckets/
  // _muetJusque/_dernierFrappeAt) : aucune primitive publique n'expose ces registres, indispensable
  // pour prouver depuis les tests que la purge mémoire (balayerHall) a bien eu lieu.
  ;(pkg as any)._presence    = presence
  ;(pkg as any)._listings    = listings
  ;(pkg as any)._invitations = invitations
  return pkg
}
