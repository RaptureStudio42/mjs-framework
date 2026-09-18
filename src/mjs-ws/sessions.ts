// mjs-ws/sessions — reprise de session opt-in. Une micro-coupure réseau ne perd RIEN : le client revient avec
// { id, key } (reçus dans son µ:welcome), prouve qu'il est la même session
// (clé comparée à temps constant + identity.id identique, l'auth normale ayant
// DÉJÀ re-tourné avant — une reprise n'est jamais un contournement), et le
// MÊME objet client est recyclé : salons et présence n'ont jamais bougé, le
// tampon des trames ratées est rejoué dans l'ordre juste après le µ:welcome.
// Moteur autonome comme rooms.ts/streams.ts — core.ts le branche au cycle de
// vie (park au lieu de purger, claim au re-hello, discard sur µ:bye) sans
// réimplémenter sa logique. La clé TOURNE à chaque µ:welcome (même id).
//
// EXCLUSIONS du tampon (jamais rejouées) : trames à `seq` top-level (deltas de
// flux — le µ:resync du client s'en charge au retour, ne JAMAIS doubler),
// µ:ping/µ:pong (battement), µ:presence (le µ:sub-presence du retour
// re-snapshotte), µ:error. INCLUS : messages applicatifs et µ:left (un kick de
// salon pendant l'absence doit arriver). Débordement (trames OU octets) → la
// session devient NON reprenable (jamais de rejeu partiel), la minuterie
// continue pour la purge différée.

import { randomBytes, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { MjsWsClient, MjsWsLogFn } from './core.js'
import type { MjsWsStatsRegistry } from './stats.js'
import { t } from '../messages/index.js'

export interface MjsWsResumeOptions {
  /** durée de la grâce après une coupure, ms — défaut 30000 */
  grace?: number
  /** trames tamponnées au maximum pendant la grâce — défaut 500 */
  maxBuffered?: number
  /** octets tamponnés au maximum pendant la grâce — défaut 262144 (256 Ko) */
  maxBytes?: number
}

export interface MjsWsResolvedResume {
  grace: number
  maxBuffered: number
  maxBytes: number
}

// exportés — réutilisés par cli/ws.ts (bannière : valeurs EFFECTIVES résolues,
// source UNIQUE, jamais recopiées en dur — même précédent que DEFAULT_LIMITS)
export const DEFAULT_RESUME: MjsWsResolvedResume = { grace: 30000, maxBuffered: 500, maxBytes: 262144 }

/** Résout l'option `resume` de mjsWs() — absent/false = désactivé (undefined), true = défauts, objet = défauts surchargés. */
export function resolveResumeOptions(raw: boolean | MjsWsResumeOptions | undefined): MjsWsResolvedResume | undefined {
  if (!raw) return undefined
  if (raw === true) return { ...DEFAULT_RESUME }
  return { ...DEFAULT_RESUME, ...raw }
}

/** id d'identité pour la garde de reprise — identity.id s'il existe (stringifié), sinon null
 *  (client anonyme : null === null, la clé crypto suffit alors). PAS de repli sur l'id de
 *  connexion (contrairement à peerIdOf, rooms.ts) : celui du re-hello diffère toujours. */
export function identityIdOf(identity: unknown): string | null {
  if (identity && typeof identity === 'object' && 'id' in identity) {
    const raw = (identity as Record<string, unknown>).id
    if (raw != null) return String(raw)
  }
  return null
}

// types de contrôle jamais tamponnés — cf. le commentaire de tête pour le POURQUOI de chacun
const EXCLUDED_TYPES = new Set(['µ:ping', 'µ:pong', 'µ:presence', 'µ:error'])

interface SessionRecord {
  id: string
  key: string
  identityId: string | null
  client: MjsWsClient
  parked: boolean
  overflowed: boolean
  buffer: Array<Record<string, unknown>>
  bytes: number
  timer: ReturnType<typeof setTimeout> | null
  reason?: string
}

/** accroche vers core.ts — LA purge historique complète (présence, salons, webhook disconnect), différée à l'expiration */
export interface MjsWsSessionsHooks {
  onExpire: (client: MjsWsClient, reason?: string) => void
}

// comparaison de clés à temps constant — égalité de LONGUEUR d'abord (timingSafeEqual lève
// un RangeError sinon, ce qui planterait le handshake au lieu d'un simple accueil frais)
function keysEqual(expected: string, given: string): boolean {
  const a = Buffer.from(expected, 'utf8')
  const b = Buffer.from(given, 'utf8')
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export function createSessionsEngine(opts: MjsWsResolvedResume, sizeOf: (frame: Record<string, unknown>) => number, log: MjsWsLogFn, hooks: MjsWsSessionsHooks, stats?: MjsWsStatsRegistry) {
  const registry = new Map<string, SessionRecord>()   // id de session → session
  const byClient = new Map<MjsWsClient, SessionRecord>()

  // --- µ:welcome — session neuve au 1er accueil, clé TOURNÉE (même id) ensuite ---
  function issue(client: MjsWsClient): { id: string; key: string } {
    let record = byClient.get(client)
    if (record) {
      record.key = randomBytes(32).toString('hex')   // la clé tourne à CHAQUE welcome — l'ancienne meurt ici
      if (stats) stats.sessions.emises++
      return { id: record.id, key: record.key }
    }
    let id = randomBytes(8).toString('hex')
    while (registry.has(id)) id = randomBytes(8).toString('hex')
    record = { id, key: randomBytes(32).toString('hex'), identityId: identityIdOf(client.identity), client, parked: false, overflowed: false, buffer: [], bytes: 0, timer: null, reason: undefined }
    registry.set(id, record)
    byClient.set(client, record)
    if (stats) stats.sessions.emises++
    return { id: record.id, key: record.key }
  }

  // --- déconnexion NON définitive — le client est parqué, minuterie de grâce lancée ---
  function park(client: MjsWsClient, reason?: string): boolean {
    const record = byClient.get(client)
    if (!record || record.parked) return false
    record.parked = true
    record.reason = reason
    record.timer  = setTimeout(() => {
      record.timer = null
      registry.delete(record.id)
      byClient.delete(client)
      log('info', t('ws.sessions.expiree-purge-differee', { id: record.id, clientId: client.id }))
      if (stats) stats.sessions.expirees++
      hooks.onExpire(client, record.reason)
    }, opts.grace)
    log('info', t('ws.sessions.client-parque', { clientId: client.id, id: record.id, grace: opts.grace }))
    return true
  }

  // --- sendRaw vers un parqué — tamponne (exclusions + bornes), au lieu d'envoyer ---
  function buffer(client: MjsWsClient, frame: Record<string, unknown>): void {
    const record = byClient.get(client)
    if (!record || !record.parked || record.overflowed) return
    if (frame.seq != null) return   // delta de flux — couvert par le µ:resync du retour, ne JAMAIS doubler
    if (typeof frame.t === 'string' && EXCLUDED_TYPES.has(frame.t)) return
    record.buffer.push(frame)
    record.bytes += sizeOf(frame)
    if (record.buffer.length > opts.maxBuffered || record.bytes > opts.maxBytes) {
      record.overflowed    = true    // non reprenable — JAMAIS de rejeu partiel ; la minuterie continue pour la purge
      record.buffer.length = 0
      record.bytes         = 0
      log('warn', t('ws.sessions.tampon-reprise-deborde', { clientId: client.id, id: record.id }))
      if (stats) stats.sessions.debordees++
    }
  }

  // --- re-hello avec session {id, key} — TOUT bon = le client parqué + son tampon, sinon null (accueil frais, sans fuite) ---
  function claim(sessionField: unknown, identityId: string | null): { client: MjsWsClient; frames: Array<Record<string, unknown>> } | null {
    if (!sessionField || typeof sessionField !== 'object') return null
    const id  = (sessionField as Record<string, unknown>).id
    const key = (sessionField as Record<string, unknown>).key
    if (typeof id !== 'string' || typeof key !== 'string' || key === '') return null
    const record = registry.get(id)
    if (!record || !record.parked) return null           // inconnue/expirée — ou client encore vivant : jamais le vol d'une connexion
    if (record.overflowed) return null
    if (!keysEqual(record.key, key)) return null
    if (record.identityId !== identityId) return null    // l'auth (déjà re-vérifiée par core.ts) doit prouver le MÊME utilisateur
    if (record.timer) { clearTimeout(record.timer); record.timer = null }
    record.parked = false
    record.reason = undefined
    const frames  = record.buffer
    record.buffer = []
    record.bytes  = 0
    if (stats) stats.sessions.reprises++
    return { client: record.client, frames }
  }

  // --- fin définitive (µ:bye, purge) — session détruite, minuterie coupée ---
  function discard(client: MjsWsClient): void {
    const record = byClient.get(client)
    if (!record) return
    if (record.timer) { clearTimeout(record.timer); record.timer = null }
    registry.delete(record.id)
    byClient.delete(client)
  }

  // --- révocation ciblée par identité (core.ts) — MÊME purge que
  // l'expiration naturelle de la grâce (onExpire, cf. park ci-dessus), déclenchée IMMÉDIATEMENT
  // par un hello FRAIS de la MÊME identité ailleurs : sans elle, une session encore PARQUÉE (grâce
  // pas expirée) resterait réclamable — l'ancien onglet « reprendrait » la place en douce à sa
  // reconnexion (claim() ci-dessus ne regarde que id+clé+identityId, jamais « une éjection a eu
  // lieu entre-temps »). Ne cible QUE les sessions PARQUÉES de cette identité — une session encore
  // VIVANTE (record.parked === false) est éjectée par un autre chemin (core.ts::clientsByIdentity/
  // dismissClient, close 4003), jamais ici. Réutilise stats.sessions.expirees (pas de compteur
  // dédié : même famille « session parquée jamais reprise », qu'elle meure de la grâce ou d'un
  // remplacement immédiat).
  function dismissByIdentity(identityId: string, reason?: string): void {
    for (const record of Array.from(registry.values())) {
      if (!record.parked || record.identityId !== identityId) continue
      if (record.timer) { clearTimeout(record.timer); record.timer = null }
      registry.delete(record.id)
      byClient.delete(record.client)
      log('info', t('ws.sessions.session-revoquee', { id: record.id, clientId: record.client.id }))
      if (stats) stats.sessions.expirees++
      hooks.onExpire(record.client, reason ?? record.reason)
    }
  }

  // --- app.stop() — toutes les sessions détruites, toutes les minuteries coupées ---
  function destroyAll(): void {
    for (const record of registry.values()) { if (record.timer) { clearTimeout(record.timer); record.timer = null } }
    registry.clear()
    byClient.clear()
  }

  return { issue, park, buffer, claim, discard, dismissByIdentity, destroyAll }
}
