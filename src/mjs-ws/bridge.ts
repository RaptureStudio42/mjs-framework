// mjs-ws/bridge — « le pont universel » : serveur HTTP embarqué (node:http/node:crypto
// SEULS, aucune dépendance ajoutée) qui laisse n'importe quel back (Ruby, PHP, Python, un
// autre Node…) pousser du temps réel dans MJS-WS par simple POST signé, et recevoir en
// retour des webhooks sur les événements qui l'intéressent —
// activé par `opts.bridge` de mjsWs() (cf. index.ts), démarré/arrêté avec le reste de
// l'app (app.listen()/app.stop(), câblage dans core.ts qui fournit un `MjsWsBridgeContext`
// et pilote `MjsWsBridgeEngine`). AUCUNE connaissance du protocole µ: ici — tout passe par
// la façade publique `MjsWsApp` (broadcast/send/room/stream/clients) + une poignée de
// lectures/notifications internes fournies par core.ts (présence agrégée, cycle de vie).
// cf. docs/23-mjs-ws.md « Le pont universel » : signature canonique expliquée pas à pas +
// un exemple curl complet par endpoint + recettes Ruby/PHP/Python côté back.

import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http'
import { request as httpsRequest } from 'node:https'
import { createHmac, timingSafeEqual } from 'node:crypto'
import { Buffer } from 'node:buffer'
import type { AddressInfo } from 'node:net'
import { peerIdOf } from './rooms.js'
// limite de débit — seau à jetons réutilisé TEL QUEL depuis guard.ts (lecture seule,
// aucune primitive dupliquée) ; cf. la section « limite de débit » plus bas pour l'assemblage.
import { TokenBucket } from './guard.js'
import type { MjsWsApp, MjsWsClient, MjsWsLogFn } from './core.js'
// état/métriques — cf. stats.ts (registre + formateur Prometheus), stats-page.ts (page /state)
import { toPrometheusText } from './stats.js'
import type { MjsWsStatsRegistry } from './stats.js'
import { renderStatsPage } from './stats-page.js'
import { t } from '../messages/index.js'

// --- options utilisateur (opts.bridge de mjsWs()) ---------------------------------------

export interface MjsWsBridgeWebhooksOptions {
  /** URL du back qui reçoit les webhooks (POST signé, cf. docs/23-mjs-ws.md). */
  url: string
  /** Secret de signature des webhooks — défaut : celui du pont (`opts.bridge.secret`). Même forme (littérale ou
   *  `env:NOM_VAR`). Le préfixe de direction ('in'/'out', cf. canonicalString) rend désormais un secret PARTAGÉ
   *  sûr — une signature entrante n'est plus rejouable en sortie ni l'inverse — mais un secret DISTINCT reste
   *  recommandé en défense supplémentaire (compromission d'un des deux canaux sans effet sur l'autre). */
  secret?: string
  /** Événements à transmettre : 'connect', 'disconnect', 'join', 'leave', 'message:<type>'. */
  events: string[]
  /** Délai avant abandon d'UNE tentative, ms (défaut 5000). */
  timeoutMs?: number
}

// limite de débit — [capacité, fenêtreMs] par seau ; défauts appliqués par
// resolveBridgeOptions si la clé (ou l'objet entier) est absente. cf. docs/23-mjs-ws.md « Limite de débit ».
export interface MjsWsBridgeRateLimitOptions {
  /** seau général PAR IP, toutes routes sauf GET /health — défaut [120, 10000] (120 req/10 s, éclatement = capacité). */
  perIp?: [number, number]
  /** seau des échecs de signature PAR IP, PLUS STRICT — défaut [10, 60000] (10×401/60 s, au-delà 429 sans vérification HMAC). */
  fails?: [number, number]
}

export interface MjsWsBridgeOptions {
  /** Port du serveur HTTP du pont — défaut : port du transport `ws` + 1. */
  port?: number
  /** Host d'écoute — défaut '127.0.0.1' (loopback : c'est le back qui appelle, jamais Internet). */
  host?: string
  /** OBLIGATOIRE — chaîne littérale, ou `'env:NOM_VAR'` résolue via `process.env.NOM_VAR`. */
  secret: string
  /** Webhooks sortants (MJS-WS → le back) — absent = aucun webhook émis. */
  webhooks?: MjsWsBridgeWebhooksOptions
  /**
   * Limite de débit par IP — ACTIVE PAR DÉFAUT, `false` pour désactiver. Seau général
   * sur TOUTES les routes SAUF `GET /health`, + seau séparé plus strict sur les échecs de
   * signature (401) — au-delà, 429 immédiat SANS vérification HMAC. cf. docs/23-mjs-ws.md « Limite de débit ».
   */
  rateLimit?: MjsWsBridgeRateLimitOptions | false
  /**
   * Nonce anti-rejeu — défaut `false` (COMPATIBILITÉ stricte : les recettes
   * documentées, docs/23-mjs-ws.md §7.3, marchent SANS changement tant que cette option reste
   * absente). `true` exige un en-tête `x-mjs-ws-nonce` (8-64 caractères) sur CHAQUE requête
   * signée, suffixé à la chaîne canonique — ferme la fenêtre de rejeu ±300 s (§7.2) à un usage
   * strictement unique par nonce. cf. docs/23-mjs-ws.md « Nonce anti-rejeu (optionnel) ».
   */
  nonce?: boolean
}

// --- options résolues (défauts appliqués, secret(s) déjà lus depuis l'environnement) ----

export interface MjsWsResolvedBridgeWebhooks {
  url: string
  secret: string
  events: Set<string>
  timeoutMs: number
}

// limite de débit — forme RÉSOLUE (défauts déjà appliqués) d'un seau ; `null` au
// niveau `MjsWsResolvedBridgeOptions.rateLimit` = désactivée (opts.bridge.rateLimit === false).
export interface MjsWsResolvedRateLimit {
  perIp: { capacity: number; windowMs: number }
  fails: { capacity: number; windowMs: number }
}

export interface MjsWsResolvedBridgeOptions {
  port: number
  host: string
  secret: string
  webhooks?: MjsWsResolvedBridgeWebhooks
  rateLimit: MjsWsResolvedRateLimit | null
  /** nonce anti-rejeu — TOUJOURS résolu (comme rateLimit ci-dessus), défaut false */
  nonce: boolean
}

// résout 'env:NOM_VAR' → process.env.NOM_VAR — même règle pour le secret du pont et celui
// des webhooks (si absent côté webhooks, celui du pont est réutilisé, DÉJÀ résolu ici)
function resolveSecretValue(raw: string | undefined, label: string): string {
  if (raw == null || raw === '') {
    throw new Error(t('ws.bridge.secret-manquant', { label }))
  }
  if (raw.indexOf('env:') === 0) {
    const varName = raw.slice(4)
    const value   = process.env[varName]
    if (!value) throw new Error(t('ws.bridge.secret-env-absent', { label, varName }))
    return value
  }
  return raw
}

// limite de débit — défauts : 120 req/10 s par IP (seau général), 10×401/60 s (seau
// des échecs de signature, plus strict) — exportées pour que la bannière CLI (cli/ws.ts) et les
// tests affichent/vérifient les MÊMES littéraux, jamais recopiés en dur ailleurs.
export const DEFAULT_BRIDGE_RATE_LIMIT_PER_IP: [number, number] = [120, 10000]
export const DEFAULT_BRIDGE_RATE_LIMIT_FAILS:  [number, number] = [10, 60000]

function resolveRateLimitBucket(tuple: [number, number] | undefined, fallback: [number, number]): { capacity: number; windowMs: number } {
  const [capacity, windowMs] = tuple ?? fallback
  return { capacity, windowMs }
}

/** Résout `opts.bridge` — défauts (port = port ws + 1, host = 127.0.0.1) + secret(s) lus
 *  depuis l'environnement si besoin. Lève en français si `secret` est absent/vide. */
export function resolveBridgeOptions(userBridge: MjsWsBridgeOptions, wsPort: number): MjsWsResolvedBridgeOptions {
  const secret = resolveSecretValue(userBridge.secret, 'opts.bridge.secret')
  const port   = userBridge.port ?? (wsPort + 1)
  const host   = userBridge.host ?? '127.0.0.1'

  let webhooks: MjsWsResolvedBridgeWebhooks | undefined
  if (userBridge.webhooks) {
    const wh = userBridge.webhooks
    if (!wh.url) throw new Error(t('ws.bridge.webhooks-url-manquant'))
    if (!Array.isArray(wh.events) || wh.events.length === 0) {
      throw new Error(t('ws.bridge.webhooks-events-vide'))
    }
    webhooks = {
      url:       wh.url,
      secret:    wh.secret != null ? resolveSecretValue(wh.secret, 'opts.bridge.webhooks.secret') : secret,
      events:    new Set(wh.events),
      timeoutMs: wh.timeoutMs ?? 5000,
    }
  }

  // limite de débit — ACTIVE PAR DÉFAUT (userBridge.rateLimit absent = objet vide,
  // les deux seaux prennent alors leurs défauts) ; `false` EXPLICITE = désactivée (null).
  const rateLimit: MjsWsResolvedRateLimit | null = userBridge.rateLimit === false ? null : {
    perIp: resolveRateLimitBucket(userBridge.rateLimit?.perIp, DEFAULT_BRIDGE_RATE_LIMIT_PER_IP),
    fails: resolveRateLimitBucket(userBridge.rateLimit?.fails, DEFAULT_BRIDGE_RATE_LIMIT_FAILS),
  }

  // nonce anti-rejeu — défaut false, MÊME philosophie que rateLimit ci-dessus
  // (résolu ici une fois pour toutes, jamais relu depuis userBridge ailleurs)
  const nonce = userBridge.nonce ?? false

  return { port, host, secret, webhooks, rateLimit, nonce }
}

// état/métriques — SEUL endroit qui tranche « le pont est-il en loopback ? » (réutilisé
// pour la gate de signature de /stats, /metrics, /state ci-dessous ET pour la bannière de `mjs ws`,
// cf. cli/ws.ts via l'export de index.ts) : dès que `host` n'est PAS 127.0.0.1/::1, la signature
// redevient obligatoire PARTOUT, aucune exception — cf. docs/23-mjs-ws.md « L'état du serveur ».
export function isLoopbackHost(host: string): boolean {
  return host === '127.0.0.1' || host === '::1'
}

// --- signature HMAC-SHA256 — chaîne canonique --------------------------------------------
// DEUX formats cohabitent dans `canonicalString`, choisis par la présence du 6e argument
// `direction` — jamais deux fonctions, un seul point d'entrée :
//
// 1. format HISTORIQUE (`direction` absent) — `${ts}.${MÉTHODE}.${cheminAvecQuery}.${corps}`
//    (+ `.{nonce}` si fourni), INCHANGÉ OCTET PRÈS. C'est celui que réutilisent tels quels
//    proxy.ts (canonicalString POST/RESPONSE du proxy de décisions, direction déjà portée par
//    le champ MÉTHODE — cf. docs/23-mjs-ws.md §7.11) et src/mjs-server/persist-bridge.ts, SANS
//    jamais passer `direction` : zéro régression pour ces deux modules, ni pour la recette du
//    proxy de décisions documentée telle quelle.
//
// 2. format DIRIGÉ + INJECTIF (séparation de domaine du secret, canonicalString rendue
//    injective) — réservé aux DEUX usages
//    internes de bridge.ts : verifyIncomingSignature ci-dessous (`'in'`, commande admin entrante)
//    et deliver() des webhooks sortants plus bas (`'out'`). Chaque champ (direction, ts, méthode,
//    chemin, corps, nonce éventuel) est encodé en LONGUEUR-PRÉFIXÉE (`{longueur}:{champ}`) avant
//    concaténation — la chaîne devient INJECTIVE (un `.` dans le corps ne permet plus de la
//    re-découper autrement, cf. docs/23-mjs-ws.md « Chaîne canonique »), et `direction` est le
//    PREMIER champ : une signature calculée pour un sens est désormais inutilisable dans l'autre,
//    MÊME secret partagé (webhooks.secret absent) — cf. docs/23-mjs-ws.md « Séparation de domaine ».
//    ⚠️ CHANGEMENT DE PROTOCOLE (pré-publication, cf. docs) : les recettes §7.3/§7.5/§7.7/§7.10
//    sont mises à jour vers ce nouveau format — aucun back existant ne suivait encore l'ancien
//    format en production.
export type MjsWsBridgeDirection = 'in' | 'out'

// encodage longueur-préfixée d'UN champ — cf. point 2 ci-dessus
function lengthPrefixed(field: string): string {
  return field.length +':'+ field
}

export function canonicalString(ts: number, method: string, pathWithQuery: string, rawBody: string, nonce?: string, direction?: MjsWsBridgeDirection): string {
  if (direction == null) {
    const base = ts +'.'+ method.toUpperCase() +'.'+ pathWithQuery +'.'+ rawBody
    return nonce != null ? base +'.'+ nonce : base
  }
  const fields = [direction, String(ts), method.toUpperCase(), pathWithQuery, rawBody]
  if (nonce != null) fields.push(nonce)
  return fields.map(lengthPrefixed).join('')
}

export function signCanonical(secret: string, canonical: string): string {
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

// comparaison à temps constant — longueur d'abord (timingSafeEqual lève sinon, ce qui
// planterait le handler au lieu de répondre proprement 401)
export function safeEqualHex(expectedHex: string, givenHex: string): boolean {
  const a = Buffer.from(expectedHex, 'hex')
  const b = Buffer.from(givenHex, 'hex')
  if (a.length === 0 || a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

export const REPLAY_WINDOW_S = 300   // ± 5 min autour de maintenant — au-delà, 401 anti-rejeu

// nonce anti-rejeu — gabarit de longueur, cf. docs/23-mjs-ws.md « Nonce anti-rejeu »
const NONCE_MIN_LEN = 8
const NONCE_MAX_LEN = 64

// dé-duplique un en-tête Node (`string | string[] | undefined`, un tableau si répété sur le fil) —
// MÊME repli que ts/sig ci-dessous, factorisé pour x-mjs-ws-nonce sans tripler la logique
function firstHeader(h: string | string[] | undefined): string | undefined {
  return Array.isArray(h) ? h[0] : h
}

/** `null` si la requête est correctement signée, sinon le message d'erreur (français, → 401).
 *  `nonce.required` — `nonce.value` = en-tête x-mjs-ws-nonce déjà extrait par
 *  l'appelant (cf. handleRequest, qui en a aussi besoin ENSUITE pour la vérification anti-rejeu
 *  proprement dite, hors de cette fonction restée SANS état — cf. createBridgeNonceStore). */
function verifyIncomingSignature(
  secret: string, method: string, pathWithQuery: string, rawBody: string, headers: IncomingMessage['headers'], now = Date.now(),
  nonce?: { required: true; value: string | undefined },
): string | null {
  const ts  = firstHeader(headers['x-mjs-ws-timestamp'])
  const sig = firstHeader(headers['x-mjs-ws-signature'])
  if (!ts || !sig) return t('ws.bridge.signature-manquante')

  const tsNum = Number(ts)
  if (!Number.isFinite(tsNum)) return t('ws.bridge.timestamp-invalide')
  if (Math.abs(now / 1000 - tsNum) > REPLAY_WINDOW_S) return t('ws.bridge.horodatage-hors-fenetre')

  if (nonce) {
    const n = nonce.value
    if (n == null || n.length < NONCE_MIN_LEN || n.length > NONCE_MAX_LEN) {
      return t('ws.bridge.nonce-requis', { min: NONCE_MIN_LEN, max: NONCE_MAX_LEN })
    }
  }

  // direction 'in' — une signature calculée côté back pour un webhook ('out') ne
  // vérifie plus ici, cf. canonicalString ci-dessus « Séparation de domaine »
  const expected = signCanonical(secret, canonicalString(tsNum, method, pathWithQuery, rawBody, nonce?.value, 'in'))
  if (!safeEqualHex(expected, sig)) return t('ws.bridge.signature-invalide')
  return null
}

// --- lecture du corps, bornée à 1 Mo (au-delà : 413, mémoire jamais dépassée) -----------

const MAX_BODY_BYTES = 1024 * 1024

function readBody(req: IncomingMessage): Promise<{ ok: true; body: string } | { ok: false; status: number; error: string }> {
  return new Promise((resolvePromise) => {
    let total    = 0
    let tooLarge = false
    const chunks: Buffer[] = []
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) { tooLarge = true; return }   // on continue de drainer, sans accumuler — mémoire bornée
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (tooLarge) resolvePromise({ ok: false, status: 413, error: t('ws.bridge.corps-trop-volumineux') })
      else resolvePromise({ ok: true, body: Buffer.concat(chunks).toString('utf8') })
    })
    req.on('error', () => resolvePromise({ ok: false, status: 400, error: t('ws.bridge.erreur-lecture-corps') }))
  })
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const data = JSON.stringify(body)
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(data) })
  res.end(data)
}

function sendText(res: ServerResponse, status: number, text: string): void {
  res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

// --- ce que core.ts fournit au pont (lecture seule, ZÉRO connaissance du protocole µ:) ---

export interface MjsWsBridgeContext {
  app: MjsWsApp
  /** présence agrégée — MÊME source que les deltas µ:presence (rooms.ts), room absente = globale */
  presence(room?: string): Array<{ id: string; meta: unknown }>
  onLog: MjsWsLogFn
  /**
   * propage un `/send` ciblé (client|user) aux AUTRES process du cluster — absent =
   * mono-process (rien à propager). `/broadcast`, `/room/send`, `/room/kick` et `/stream`
   * traversent DÉJÀ tout seuls (app.broadcast/room()/stream() sont cluster-aware à la source,
   * cf. core.ts) : `/send` est le SEUL endpoint qui a besoin de cette accroche dédiée, parce
   * qu'il résout son id-cible en objet client LOCAL avant d'appeler app.send() (qui, lui,
   * reste sciemment local-only — cf. core.ts pour le pourquoi).
   */
  publishSend?: (target: { client?: string; user?: string }, type: string, p: unknown) => void
  /** état/métriques (stats.ts) — registre TOUJOURS peuplé (écriture : compteurs pont ci-dessous) ; lecture d'un instantané via `app.stats()` (déjà dans `app`). */
  stats: MjsWsStatsRegistry
  /** GET /stats, /metrics, /state actifs seulement si true (option `stats` de mjsWs(), désactivée par défaut) — le registre tourne quand même dans les deux cas. */
  statsEnabled: boolean
}

// --- ce que core.ts pilote (démarrage/arrêt + notifications de cycle de vie, webhooks) --

export interface MjsWsBridgeEngine {
  start(): Promise<void>
  stop(): Promise<void>
  notifyConnect(client: MjsWsClient): void
  notifyDisconnect(client: MjsWsClient, reason?: string): void
  notifyMessage(type: string, p: unknown, client: MjsWsClient): void
  notifyRoomJoin(room: string, id: string, meta: unknown): void
  notifyRoomLeave(room: string, id: string, meta: unknown): void
}

// --- petites aides de validation des corps entrants --------------------------------------

function isStr(x: unknown): x is string { return typeof x === 'string' && x.length > 0 }
function isPlainObject(x: unknown): x is Record<string, unknown> { return typeof x === 'object' && x !== null && !Array.isArray(x) }

// 'except' (broadcast/room-send) : absente, une chaîne, ou un tableau de chaînes — id de
// connexion OU id agrégé (identity.id), MÊME résolution que /room/kick et /send (peerIdOf)
function parseIdList(x: unknown): string[] | null {
  if (x === undefined) return []
  if (typeof x === 'string') return [x]
  if (Array.isArray(x) && x.every(v => typeof v === 'string')) return x as string[]
  return null
}

// Bogue comblé — valide la charge (p/value/values) à L'ENTRÉE plutôt que de
// laisser core.ts::preEncodeFrame échouer en silence à l'envoi (JSON.stringify lève un RangeError
// sur une charge trop imbriquée — atteignable en UNE requête sous le plafond de 1 Mo du pont, environ
// 170 000 niveaux) : SANS cette garde, les 4 endpoints de push répondent `{ok:true}` alors qu'AUCUN
// client n'a rien reçu. MÊME plafond que streams.ts::MAX_VALUE_DEPTH, dupliqué ICI (module
// indépendant, cf. le commentaire de tête de proxy.ts sur la duplication délibérée entre fichiers
// mjs-ws) — profondeur D'ABORD (borne la récursion avant tout JSON.stringify d'une structure
// potentiellement énorme), sérialisable ensuite (`try`, pour les autres cas — BigInt, etc.).
const MAX_PAYLOAD_DEPTH = 64

function isTooDeep(value: unknown, limit: number, depth = 0): boolean {
  if (depth > limit) return true
  if (value === null || typeof value !== 'object') return false
  if (Array.isArray(value)) {
    for (const item of value) if (isTooDeep(item, limit, depth + 1)) return true
    return false
  }
  for (const k in value as Record<string, unknown>) if (isTooDeep((value as Record<string, unknown>)[k], limit, depth + 1)) return true
  return false
}

// MÊME règle que
// streams.ts::isSerializableEntry (dupliquée à dessein, cf. commentaire de tête ci-dessus) : JSON.
// stringify seul laisse passer Map/Set/fonction/Symbol NICHÉ(E) sans jamais lever, la valeur
// disparaît en silence à l'encodage ({}). `undefined` NICHÉ (clé objet/élément de tableau) est
// REFUSÉ pour la MÊME raison — MAIS `p`/`value`/`values` omis À LA RACINE (donc `undefined` au
// premier niveau) reste ACCEPTÉ, comportement historique inchangé (cf. tests/mjs-ws-bridge.test.ts
// « requête bien signée → 200 » avec `{type:'x'}`, sans `p`). En pratique une charge HTTP naît d'un
// JSON.parse : elle ne peut JAMAIS porter de Map/Set/fonction/Symbol/BigInt (aucun littéral JSON
// pour ces types) NI d'`undefined` NICHÉ (idem) — cette walk reste donc, pour tout appelant HTTP
// réel, un filet SANS effet observable aujourd'hui ; postée ici par symétrie stricte avec
// streams.ts, pour un futur appelant NON-HTTP de cette fonction. Date tolérée (toJSON natif,
// fidèle), tout AUTRE toJSON refusé.
function isSerializablePayload(value: unknown): boolean {
  if (isTooDeep(value, MAX_PAYLOAD_DEPTH)) return false
  function hasLossyValue(v: unknown, nested: boolean): boolean {
    if (nested && v === undefined) return true
    if (typeof v === 'function' || typeof v === 'bigint' || typeof v === 'symbol') return true
    if (v instanceof Map || v instanceof Set) return true
    if (v === null || typeof v !== 'object') return false
    if (v instanceof Date) return false
    if (typeof (v as { toJSON?: unknown }).toJSON === 'function') return true
    if (Array.isArray(v)) { for (const item of v) if (hasLossyValue(item, true)) return true; return false }
    for (const k in v as Record<string, unknown>) if (hasLossyValue((v as Record<string, unknown>)[k], true)) return true
    return false
  }
  if (hasLossyValue(value, false)) return false
  try { JSON.stringify(value); return true }
  catch { return false }
}

// exportée — réutilisée par core.ts (cluster) pour résoudre localement les ids
// (connexion OU peer) reçus d'un AUTRE process (except/target d'un broadcast, room.send, send
// ciblé…) : MÊME résolution ici et côté cluster, une seule implémentation.
export function resolveClients(app: MjsWsApp, ids: string[]): MjsWsClient[] {
  if (ids.length === 0) return []
  const wanted = new Set(ids)
  const out: MjsWsClient[] = []
  for (const c of app.clients) if (wanted.has(c.id) || wanted.has(peerIdOf(c))) out.push(c)
  return out
}

// --- endpoints ----------------------------------------------------------------------------

function handleBroadcast(ctx: MjsWsBridgeContext, payload: any, res: ServerResponse): void {
  if (!isStr(payload?.type)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.type-requis') }); return }
  const ids = parseIdList(payload.except)
  if (ids === null) { sendJson(res, 400, { ok: false, error: t('ws.bridge.except-invalide') }); return }
  if (!isSerializablePayload(payload.p)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }
  const except = resolveClients(ctx.app, ids)
  // `app.broadcast` renvoie désormais `boolean` — `false` UNIQUEMENT si la
  // charge n'a pas pu être sérialisée à l'envoi, résiduel après la validation d'entrée ci-dessus
  const delivered = ctx.app.broadcast(payload.type, payload.p, except.length > 0 ? { except } : undefined)
  if (!delivered) { ctx.onLog('error', t('ws.bridge.echec-envoi')); sendJson(res, 500, { ok: false, error: t('ws.bridge.echec-envoi') }); return }
  sendJson(res, 200, { ok: true })
}

// 'client' (id de connexion, AU PLUS une correspondance) OU 'user' (id agrégé, TOUTES ses connexions) — jamais les deux, jamais aucun
function handleSend(ctx: MjsWsBridgeContext, payload: any, res: ServerResponse): void {
  if (!isStr(payload?.type)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.type-requis') }); return }
  const hasClient = payload?.client !== undefined
  const hasUser   = payload?.user !== undefined
  if (hasClient === hasUser) { sendJson(res, 400, { ok: false, error: t('ws.bridge.client-ou-user') }); return }
  const target = hasClient ? payload.client : payload.user
  if (!isStr(target)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.client-user-chaine') }); return }
  if (!isSerializablePayload(payload.p)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }

  let sent = 0
  let echecEnvoi = false
  for (const c of ctx.app.clients) {
    const hit = hasClient ? c.id === target : peerIdOf(c) === target
    if (!hit) continue
    // `app.send` renvoie désormais `boolean` — cf. handleBroadcast ci-dessus
    if (!ctx.app.send(c, payload.type, payload.p)) echecEnvoi = true
    sent++
    if (hasClient) break   // id de connexion — au plus une correspondance possible
  }
  // cluster — un autre process peut détenir d'autres connexions (client|user)
  ctx.publishSend?.({ client: hasClient ? target : undefined, user: hasUser ? target : undefined }, payload.type, payload.p)
  if (echecEnvoi) { ctx.onLog('error', t('ws.bridge.echec-envoi')); sendJson(res, 500, { ok: false, error: t('ws.bridge.echec-envoi') }); return }
  sendJson(res, 200, { ok: true, sent })
}

function handleRoomSend(ctx: MjsWsBridgeContext, payload: any, res: ServerResponse): void {
  if (!isStr(payload?.room)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.room-requis') }); return }
  if (!isStr(payload?.type)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.type-requis') }); return }
  const ids = parseIdList(payload.except)
  if (ids === null) { sendJson(res, 400, { ok: false, error: t('ws.bridge.except-invalide') }); return }
  if (!isSerializablePayload(payload.p)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }
  const except = resolveClients(ctx.app, ids)
  try {
    // MÊME sémantique que room().send actuel — type VERBATIM, le pont ne préfixe rien (cf. docs/23-mjs-ws.md §4)
    // room().send() (rooms.ts, hors périmètre de ce module) reste `void` — CONTRAIREMENT à
    // app.broadcast/send ci-dessus, aucun signal d'échec d'encodage
    // résiduel n'est disponible ICI (accroche rooms.ts à poser) ; ce
    // try/catch reste un filet pour un throw IMPRÉVU (aucun aujourd'hui), pas un vrai signal.
    ctx.app.room(payload.room).send(payload.type, payload.p, except.length > 0 ? { except } : undefined)
  } catch (err) {
    ctx.onLog('error', t('ws.bridge.echec-envoi'), { err })
    sendJson(res, 500, { ok: false, error: t('ws.bridge.echec-envoi') })
    return
  }
  sendJson(res, 200, { ok: true })
}

function handleRoomKick(ctx: MjsWsBridgeContext, payload: any, res: ServerResponse): void {
  if (!isStr(payload?.room)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.room-requis') }); return }
  const hasClient = payload?.client !== undefined
  const hasUser   = payload?.user !== undefined
  if (hasClient === hasUser) { sendJson(res, 400, { ok: false, error: t('ws.bridge.client-ou-user') }); return }
  const target = hasClient ? payload.client : payload.user
  if (!isStr(target)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.client-user-chaine') }); return }

  // comptage AVANT le kick (même prédicat que room.kick — id de connexion OU id agrégé) : .kick() ne retourne rien
  const roomHandle = ctx.app.room(payload.room)
  const kicked = Array.from(roomHandle.clients).filter(c => c.id === target || peerIdOf(c) === target).length
  roomHandle.kick(target, payload.reason)
  sendJson(res, 200, { ok: true, kicked })
}

const STREAM_OPS = new Set(['add', 'update', 'remove', 'reset'])

function handleStream(ctx: MjsWsBridgeContext, payload: any, res: ServerResponse): void {
  if (!isStr(payload?.name)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.name-requis') }); return }
  if (!STREAM_OPS.has(payload?.op)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.op-invalide') }); return }

  const s = ctx.app.stream(payload.name)   // créé à la volée si nouveau — repris tel quel si déjà déclaré (opts ignorées dans ce cas, cf. streams.ts)
  switch (payload.op) {
    case 'add':
      if (!isStr(payload.id)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.id-requis-add') }); return }
      if (payload.value === undefined) { sendJson(res, 400, { ok: false, error: t('ws.bridge.value-requis-add') }); return }
      if (!isSerializablePayload(payload.value)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }
      s.add(payload.id, payload.value)
      break
    case 'update':
      if (!isStr(payload.id)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.id-requis-update') }); return }
      if (!isPlainObject(payload.value)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.value-objet-update') }); return }
      if (!isSerializablePayload(payload.value)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }
      s.update(payload.id, payload.value)
      break
    case 'remove':
      if (!isStr(payload.id)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.id-requis-remove') }); return }
      s.remove(payload.id)
      break
    case 'reset':
      if (!isPlainObject(payload.values)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.values-objet-reset') }); return }
      if (!isSerializablePayload(payload.values)) { sendJson(res, 400, { ok: false, error: t('ws.bridge.charge-non-serialisable', { depth: MAX_PAYLOAD_DEPTH }) }); return }
      s.reset(payload.values)
      break
  }
  sendJson(res, 200, { ok: true })
}

function handlePresence(ctx: MjsWsBridgeContext, url: URL, res: ServerResponse): void {
  const room  = url.searchParams.get('room') ?? undefined
  const peers = ctx.presence(room)
  sendJson(res, 200, { ok: true, peers })
}

// --- état/métriques (stats.ts) — 3 endpoints, actifs seulement si ctx.statsEnabled ----
// (sinon MÊME 404 qu'un chemin réellement inconnu — jamais un comportement observable différent
// qui trahirait « l'option existe mais est coupée »). Gate de signature : cf. STATS_ROUTES + son
// call-site dans handleRequest (isLoopbackHost, seul endroit qui tranche la question).

function handleStats(ctx: MjsWsBridgeContext, res: ServerResponse): void {
  if (!ctx.statsEnabled) { sendJson(res, 404, { ok: false, error: t('ws.bridge.chemin-inconnu', { route: 'GET /stats' }) }); return }
  sendJson(res, 200, ctx.app.stats())
}

function handleMetrics(ctx: MjsWsBridgeContext, res: ServerResponse): void {
  if (!ctx.statsEnabled) { sendJson(res, 404, { ok: false, error: t('ws.bridge.chemin-inconnu', { route: 'GET /metrics' }) }); return }
  const text = toPrometheusText(ctx.app.stats())
  res.writeHead(200, { 'content-type': 'text/plain; version=0.0.4; charset=utf-8', 'content-length': Buffer.byteLength(text) })
  res.end(text)
}

function handleState(ctx: MjsWsBridgeContext, res: ServerResponse): void {
  if (!ctx.statsEnabled) { sendJson(res, 404, { ok: false, error: t('ws.bridge.chemin-inconnu', { route: 'GET /state' }) }); return }
  const html = renderStatsPage(ctx.app.stats())
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'content-length': Buffer.byteLength(html) })
  res.end(html)
}

// --- limite de débit par IP — seau général + seau (plus strict) des échecs de
// signature, réutilisent TokenBucket (guard.ts, LECTURE SEULE) ---------------------------------
// TokenBucket n'expose qu'un take() CONSOMMATEUR (aucun « peek ») : le seau-échecs ne peut donc
// pas se pré-vérifier sans se consommer lui-même. On dérive un verrou `failBlockedUntil` (horloge),
// posé au moment où un take() de comptage échoue (le 401 QUI FAIT DÉBORDER le seau) — il couvre
// exactement « au-delà, 429 immédiat AVANT toute vérification HMAC » pour toutes les requêtes
// SUIVANTES, sans jamais faire payer le budget-échecs à une requête correctement signée (cf.
// docs/23-mjs-ws.md « Limite de débit »). Mémoire bornée par éviction PARESSEUSE : la Map reste
// ordonnée par ancienneté de DERNIER accès (ré-insertion en fin à chaque touche), un passage de
// purge regarde donc seulement le FRONT (borné à IP_SWEEP_MAX), jamais un scan complet.

const IP_ENTRY_TTL_MS = 10 * 60 * 1000   // entrée intacte depuis > 10 min → purgée au passage
const IP_SWEEP_MAX    = 8                // borne le coût d'un passage (jamais O(n) sur une IP isolée)

interface IpBucketEntry {
  general: TokenBucket
  fails: TokenBucket
  failBlockedUntil: number
  lastSeen: number
}

export interface MjsWsBridgeRateLimiter {
  /** true = admis (jeton général consommé) ; false = seau général épuisé → 429. */
  admitGeneral(ip: string, now?: number): boolean
  /** true = IP actuellement en pénalité (trop d'échecs de signature récents) → 429 immédiat, AUCUNE vérification HMAC. */
  isFailBlocked(ip: string, now?: number): boolean
  /** à appeler après un 401 CONFIRMÉ — true = encore dans le budget (401 normal), false = dépassé (429, IP verrouillée pour la fenêtre). */
  recordFailure(ip: string, now?: number): boolean
  /** nombre d'IP actuellement suivies — tests d'éviction uniquement. */
  readonly size: number
}

/** Construit le limiteur d'un pont — un couple de seaux PAR IP, créés à la volée au premier
 *  contact. `now` accepté sur chaque méthode (défaut Date.now()) : permet aux tests d'injecter
 *  une horloge pour l'éviction, SANS prétendre pouvoir accélérer le remplissage propre à
 *  TokenBucket (celui-ci reste sur l'horloge réelle, cf. guard.ts). */
export function createBridgeRateLimiter(config: MjsWsResolvedRateLimit): MjsWsBridgeRateLimiter {
  const perIpRefill = config.perIp.capacity / (config.perIp.windowMs / 1000)
  const failsRefill = config.fails.capacity / (config.fails.windowMs / 1000)
  const map = new Map<string, IpBucketEntry>()

  function sweep(now: number): void {
    let evicted = 0
    for (const [ip, entry] of map) {
      if (now - entry.lastSeen <= IP_ENTRY_TTL_MS) break   // Map ordonnée par ancienneté d'accès — le reste est plus récent
      map.delete(ip)
      if (++evicted >= IP_SWEEP_MAX) break
    }
  }

  function touch(ip: string, now: number): IpBucketEntry {
    sweep(now)
    let entry = map.get(ip)
    if (entry) {
      entry.lastSeen = now
      map.delete(ip); map.set(ip, entry)   // ré-insère en fin — ordre = ancienneté de dernier accès
    } else {
      entry = {
        general:          new TokenBucket(config.perIp.capacity, perIpRefill),
        fails:            new TokenBucket(config.fails.capacity, failsRefill),
        failBlockedUntil: 0,
        lastSeen:         now,
      }
      map.set(ip, entry)
    }
    return entry
  }

  return {
    admitGeneral(ip, now = Date.now()) { return touch(ip, now).general.take(1) },
    isFailBlocked(ip, now = Date.now()) { return now < touch(ip, now).failBlockedUntil },
    recordFailure(ip, now = Date.now()) {
      const entry  = touch(ip, now)
      const within = entry.fails.take(1)
      if (!within) entry.failBlockedUntil = now + config.fails.windowMs
      return within
    },
    get size() { return map.size },
  }
}

// --- nonce anti-rejeu (optionnel — ws.bridge.nonce) — store PARTAGÉ, éviction PARESSEUSE
// même patron que createBridgeRateLimiter ci-dessus ---------------------------------------------
// un nonce, une fois VU, n'est plus jamais retouché (contrairement à un seau de débit qui se
// rafraîchit à chaque accès) : le revoir EST la fraude détectée, pas un événement à prolonger.
// L'ordre d'INSERTION de la Map suffit donc déjà (jamais besoin de ré-insérer en fin comme
// touch() ci-dessus) — un passage de purge regarde seulement le FRONT (borné à NONCE_SWEEP_MAX),
// jamais un scan complet. Fenêtre d'éviction = REPLAY_WINDOW_S, LA MÊME que l'horodatage lui-même
// (§7.2) : un nonce plus vieux que ça correspondrait de toute façon à un ts déjà rejeté par
// verifyIncomingSignature avant d'atteindre ce store — inutile de le garder plus longtemps.

const NONCE_SWEEP_MAX = 16

export interface MjsWsBridgeNonceStore {
  /** true = nonce inédit dans la fenêtre (ACCEPTÉ, désormais enregistré) ; false = déjà vu (REJETÉ, rien ré-enregistré). */
  checkAndRecord(nonce: string, now?: number): boolean
  /** nombre de nonces actuellement suivis — tests d'éviction uniquement. */
  readonly size: number
}

export function createBridgeNonceStore(): MjsWsBridgeNonceStore {
  const seenAt = new Map<string, number>()

  function sweep(now: number): void {
    let evicted = 0
    for (const [nonce, at] of seenAt) {
      if (now - at <= REPLAY_WINDOW_S * 1000) break   // Map ordonnée par ancienneté d'INSERTION — le reste est plus récent
      seenAt.delete(nonce)
      if (++evicted >= NONCE_SWEEP_MAX) break
    }
  }

  return {
    checkAndRecord(nonce, now = Date.now()) {
      sweep(now)
      if (seenAt.has(nonce)) return false
      seenAt.set(nonce, now)
      return true
    },
    get size() { return seenAt.size },
  }
}

// adresse IP source — clé de compteur SEULEMENT (jamais journalisée nommément, jamais renvoyée
// au client) ; remoteAddress est la seule source fiable ici (le pont écoute en loopback par
// défaut — un en-tête X-Forwarded-For serait trivialement falsifiable par l'appelant lui-même,
// qui EST la source de la requête).
function clientIp(req: IncomingMessage): string {
  return req.socket.remoteAddress ?? 'inconnue'
}

// --- dispatch HTTP --------------------------------------------------------------------------

// routes CONNUES — seules celles-ci comptent dans pont.requetesParEndpoint : un chemin
// bidon envoyé en rafale par un client curieux ne doit JAMAIS faire grossir le registre sans borne
// (même esprit que le journal circulaire des flux ou la file de webhooks, toujours bornés).
const KNOWN_ROUTES = new Set([
  'GET /health', 'POST /broadcast', 'POST /send', 'POST /room/send', 'POST /room/kick',
  'POST /stream', 'GET /presence', 'GET /stats', 'GET /metrics', 'GET /state',
])
// /stats, /metrics, /state — signature EXEMPTÉE uniquement si le host effectif du pont
// est loopback (isLoopbackHost) : outil de dev local. Dès que le pont écoute ailleurs, ces 3
// endpoints redeviennent signés comme tout le reste — AUCUNE exception au-delà du loopback.
const STATS_ROUTES = new Set(['GET /stats', 'GET /metrics', 'GET /state'])

// 401 (signature invalide/absente OU nonce rejoué) — CRÉDITE le seau-échecs (limite
// de débit) : CHOKE POINT unique pour tout refus adjacent à la signature, jamais
// dupliqué entre le chemin sigError et le chemin nonce ci-dessous. Peut lui-même se transformer
// en 429 si le budget déborde (cf. createBridgeRateLimiter) — http401 ne compte alors QUE les
// vraies réponses 401, jamais celles requalifiées en 429 (mêmes garanties Prometheus qu'avant).
function rejectUnauthorized(
  ctx: MjsWsBridgeContext, limiter: MjsWsBridgeRateLimiter | null, ip: string, now: number,
  res: ServerResponse, error: string, method: string, path: string,
): void {
  const withinBudget = limiter ? limiter.recordFailure(ip, now) : true
  if (!withinBudget) {
    ctx.stats.pont.rateLimited++
    sendJson(res, 429, { ok: false, error: 'rate-limited' })
    return
  }
  ctx.stats.pont.http401++
  ctx.onLog('warn', t('ws.bridge.requete-refusee', { error }), { method, path })
  sendJson(res, 401, { ok: false, error })
}

async function handleRequest(
  resolved: MjsWsResolvedBridgeOptions, ctx: MjsWsBridgeContext, limiter: MjsWsBridgeRateLimiter | null,
  nonceStore: MjsWsBridgeNonceStore | null, req: IncomingMessage, res: ServerResponse,
): Promise<void> {
  const method = (req.method ?? 'GET').toUpperCase()
  const url    = new URL(req.url ?? '/', 'http://mjs-ws.local')   // base bidon — seuls pathname/searchParams servent
  const route  = method +' '+ url.pathname
  if (KNOWN_ROUTES.has(route)) ctx.stats.pont.requetesParEndpoint[route] = (ctx.stats.pont.requetesParEndpoint[route] ?? 0) + 1

  if (method === 'GET' && url.pathname === '/health') { sendText(res, 200, 'ok'); return }   // SEUL endpoint non signé ET jamais limité (sonde d'orchestrateur — hors /stats-/metrics-/state en loopback, cf. plus bas)

  const now = Date.now()
  const ip  = clientIp(req)

  // limite de débit — seau général PAR IP, TOUTES les routes restantes (/health exempté
  // ci-dessus) ; AVANT toute lecture de corps (ne dépense rien — mémoire/CPU — pour un flux déjà bloqué).
  if (limiter && !limiter.admitGeneral(ip, now)) {
    ctx.stats.pont.rateLimited++
    sendJson(res, 429, { ok: false, error: 'rate-limited' })
    return
  }

  const bodyResult = await readBody(req)
  // cast explicite : strictNullChecks: false (tsconfig du projet) désactive le control-flow
  // narrowing natif des unions discriminées (cf. bundler/config.ts, même angle mort connu)
  if (!bodyResult.ok) {
    const bad = bodyResult as { ok: false; status: number; error: string }
    sendJson(res, bad.status, { ok: false, error: bad.error })
    return
  }
  const rawBody = bodyResult.body

  const skipSignature = STATS_ROUTES.has(route) && isLoopbackHost(resolved.host)

  // seau-échecs — IP déjà en pénalité → 429 immédiat, AUCUNE vérification HMAC tentée
  // (cf. docs/23-mjs-ws.md « Limite de débit ») ; seulement pertinent là où une signature SERAIT
  // vérifiée (skipSignature = rien à vérifier ici, cf. /stats-/metrics-/state en loopback plus bas).
  if (!skipSignature && limiter && limiter.isFailBlocked(ip, now)) {
    ctx.stats.pont.rateLimited++
    sendJson(res, 429, { ok: false, error: 'rate-limited' })
    return
  }

  if (!skipSignature) {
    // nonce anti-rejeu (ws.bridge.nonce) — extrait AVANT verifyIncomingSignature :
    // suffixé à la chaîne canonique (cf. canonicalString), donc requis pour même CALCULER la
    // signature attendue quand l'option est active. Chaîne BYTE-IDENTIQUE à avant si `resolved.nonce`
    // est false (défaut) — nonceHeader reste alors `undefined`, jamais lu ni exigé.
    const nonceHeader = resolved.nonce ? firstHeader(req.headers['x-mjs-ws-nonce']) : undefined
    const sigError = verifyIncomingSignature(
      resolved.secret, method, req.url ?? '/', rawBody, req.headers, undefined,
      resolved.nonce ? { required: true, value: nonceHeader } : undefined,
    )
    if (sigError) { rejectUnauthorized(ctx, limiter, ip, now, res, sigError, method, url.pathname); return }
    // signature (et gabarit du nonce) valides — reste à vérifier que ce nonce PRÉCIS n'a jamais
    // été vu dans la fenêtre ±300 s (cf. createBridgeNonceStore) : un rejeu de la MÊME requête
    // (même ts, même sig, même nonce) est désormais détecté même DANS la fenêtre de §7.2.
    if (nonceStore && !nonceStore.checkAndRecord(nonceHeader!, now)) {
      rejectUnauthorized(ctx, limiter, ip, now, res, 'nonce-rejoué', method, url.pathname)
      return
    }
  }

  let payload: any = {}
  if (rawBody.length > 0) {
    try { payload = JSON.parse(rawBody) }
    catch { sendJson(res, 400, { ok: false, error: t('ws.bridge.json-invalide') }); return }
  }

  try {
    switch (route) {
      case 'POST /broadcast':  handleBroadcast(ctx, payload, res); return
      case 'POST /send':       handleSend(ctx, payload, res); return
      case 'POST /room/send':  handleRoomSend(ctx, payload, res); return
      case 'POST /room/kick':  handleRoomKick(ctx, payload, res); return
      case 'POST /stream':     handleStream(ctx, payload, res); return
      case 'GET /presence':    handlePresence(ctx, url, res); return
      case 'GET /stats':       handleStats(ctx, res); return
      case 'GET /metrics':     handleMetrics(ctx, res); return
      case 'GET /state':        handleState(ctx, res); return
      default: sendJson(res, 404, { ok: false, error: t('ws.bridge.chemin-inconnu', { route }) })
    }
  } catch (err) {
    ctx.onLog('error', t('ws.bridge.erreur-interne'), { err })
    sendJson(res, 400, { ok: false, error: err instanceof Error ? err.message : String(err) })
  }
}

// --- webhooks sortants : file bornée, parallélisme borné, retentatives bornées ----------
// un échec ne bloque JAMAIS le serveur (fire-and-forget) — la réponse du back n'est JAMAIS
// renvoyée au client d'origine, cf. docs/23-mjs-ws.md.

const WEBHOOK_QUEUE_MAX       = 1000
const WEBHOOK_INFLIGHT_MAX    = 4
const WEBHOOK_RETRY_DELAYS_MS = [2000, 10000]   // délai AVANT chaque retentative — l'essai initial part sans délai (0/2/10 s)

interface WebhookJob { event: string; payload: unknown }

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)) }

function postJson(target: URL, body: string, ts: number, sig: string, timeoutMs: number): Promise<boolean> {
  return new Promise((resolvePromise, reject) => {
    const requester = target.protocol === 'https:' ? httpsRequest : httpRequest
    const req = requester(target, {
      method: 'POST',
      headers: {
        'content-type':      'application/json; charset=utf-8',
        'content-length':    Buffer.byteLength(body),
        'x-mjs-ws-timestamp': String(ts),
        'x-mjs-ws-signature': sig,
      },
      timeout: timeoutMs,
    }, (res) => {
      res.resume()   // corps de réponse du back ignoré — fire-and-forget
      const status = res.statusCode ?? 0
      resolvePromise(status >= 200 && status < 300)
    })
    req.on('timeout', () => req.destroy(new Error(t('ws.bridge.delai-webhook-depasse'))))
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

function createWebhookSender(webhooks: MjsWsResolvedBridgeWebhooks | undefined, onLog: MjsWsLogFn, stats: MjsWsStatsRegistry) {
  if (!webhooks) return { emit(_event: string, _payload: unknown): void {}, stop(): void {} }
  const wh = webhooks
  const target = new URL(wh.url)
  const queue: WebhookJob[] = []
  let inflight = 0
  let stopped  = false

  function pump(): void {
    while (!stopped && inflight < WEBHOOK_INFLIGHT_MAX && queue.length > 0) {
      const job = queue.shift()!
      inflight++
      void deliver(job, 0).finally(() => { inflight--; pump() })
    }
  }

  async function deliver(job: WebhookJob, attempt: number): Promise<void> {
    const body = JSON.stringify(job.payload)
    const ts   = Math.floor(Date.now() / 1000)
    // direction 'out' — une signature captée sur une commande admin ('in') ne
    // vérifie plus côté back pour un webhook, cf. canonicalString ci-dessus « Séparation de domaine »
    const sig  = signCanonical(wh.secret, canonicalString(ts, 'POST', target.pathname + target.search, body, undefined, 'out'))
    try {
      const okStatus = await postJson(target, body, ts, sig, wh.timeoutMs)
      if (!okStatus) throw new Error(t('ws.bridge.reponse-http-non-2xx'))
      stats.pont.webhooksEnvoyes++
    } catch (err) {
      stats.pont.webhooksEchoues++
      if (stopped) return
      if (attempt < WEBHOOK_RETRY_DELAYS_MS.length) {
        await sleep(WEBHOOK_RETRY_DELAYS_MS[attempt])
        if (!stopped) { await deliver(job, attempt + 1) }
        return
      }
      stats.pont.webhooksAbandonnes++
      onLog('warn', t('ws.bridge.webhook-abandonne', { event: job.event, tentative: attempt + 1 }), { err: err instanceof Error ? err.message : String(err), url: wh.url })
    }
  }

  return {
    emit(event: string, payload: unknown): void {
      if (stopped || !wh.events.has(event)) return
      if (queue.length >= WEBHOOK_QUEUE_MAX) { onLog('warn', t('ws.bridge.file-webhooks-pleine', { max: WEBHOOK_QUEUE_MAX, event })); return }
      queue.push({ event, payload })
      pump()
    },
    stop(): void { stopped = true },
  }
}

// --- le pont — démarrage/arrêt + notifications de cycle de vie (câblées par core.ts) -----

export function createBridge(resolved: MjsWsResolvedBridgeOptions, ctx: MjsWsBridgeContext): MjsWsBridgeEngine {
  const webhooks = createWebhookSender(resolved.webhooks, ctx.onLog, ctx.stats)
  // limite de débit — un seul limiteur pour la durée de vie du pont (Maps internes
  // par IP, éviction paresseuse, cf. createBridgeRateLimiter ci-dessus) ; `null` = désactivée.
  const limiter = resolved.rateLimit ? createBridgeRateLimiter(resolved.rateLimit) : null
  // nonce anti-rejeu — MÊME principe que limiter ci-dessus : un seul store pour la
  // durée de vie du pont, `null` = désactivé (défaut, cf. resolveBridgeOptions)
  const nonceStore = resolved.nonce ? createBridgeNonceStore() : null
  let server: ReturnType<typeof createServer> | null = null

  return {
    async start() {
      server = createServer((req, res) => {
        handleRequest(resolved, ctx, limiter, nonceStore, req, res).catch(err => {
          ctx.onLog('error', t('ws.bridge.erreur-interne-non-geree'), { err })
          try { res.destroy() } catch { /* déjà fermée */ }
        })
      })
      await new Promise<void>((resolveStart, reject) => {
        server!.once('error', reject)
        server!.listen(resolved.port, resolved.host, () => resolveStart())
      })
      const addr       = server.address() as AddressInfo | null
      const actualPort = addr ? addr.port : resolved.port
      // mention « nonce : exigé » — mini-bannière PROPRE au pont (log de démarrage
      // bridge.ts) ; la bannière ÉLABORÉE de `mjs ws` (limite de débit, etc.) vit dans cli/ws.ts.
      ctx.onLog('info', t('ws.bridge.ecoute-pont', { host: resolved.host, port: actualPort, nonce: resolved.nonce }), {
        host: resolved.host, port: actualPort,
        webhookEvents: resolved.webhooks ? Array.from(resolved.webhooks.events) : null,
        nonce: resolved.nonce,
      })
    },

    async stop() {
      webhooks.stop()
      if (!server) return
      const s = server
      server = null
      await new Promise<void>(r => s.close(() => r()))
    },

    notifyConnect(client) {
      webhooks.emit('connect', { event: 'connect', at: Date.now(), client: { id: client.id, identity: client.identity, meta: client.meta } })
    },

    notifyDisconnect(client, reason) {
      const p: Record<string, unknown> = { event: 'disconnect', at: Date.now(), client: { id: client.id, identity: client.identity, meta: client.meta } }
      if (reason !== undefined) p.reason = reason
      webhooks.emit('disconnect', p)
    },

    notifyMessage(type, p, client) {
      webhooks.emit(`message:${type}`, { event: 'message', type, p, client: { id: client.id, identity: client.identity } })
    },

    notifyRoomJoin(room, id, meta) {
      webhooks.emit('join', { event: 'join', at: Date.now(), room, user: { id, meta } })
    },

    notifyRoomLeave(room, id, meta) {
      webhooks.emit('leave', { event: 'leave', at: Date.now(), room, user: { id, meta } })
    },
  }
}
