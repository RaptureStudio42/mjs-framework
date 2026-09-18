// mjs-ws/stats — « l'état du serveur » : registre de compteurs LÉGER, TOUJOURS actif —
// connexions/messages/garde/salons/flux/pont/adaptateur/sessions/erreurs +
// réservoir de latences ping (p50/p95). Créé UNE FOIS par app (core.ts), passé en ÉCRITURE aux
// moteurs qui en ont besoin (streams.ts, sessions.ts, bridge.ts) — rooms.ts n'écrit RIEN ici, ses
// gauges (nombre de salons, membres) sont lues EN DIRECT à la demande (cf. MjsWsStatsGauges plus
// bas) : jamais deux sources de vérité, jamais de drift. app.stats() (core.ts) assemble le tout en
// un instantané JSON. Le pont (bridge.ts) sert cet instantané en HTTP (GET /stats), sa forme texte
// Prometheus (GET /metrics, cf. toPrometheusText) et une page HTML sombre (GET /state, cf.
// stats-page.ts) — SEULEMENT si l'option `stats` de mjsWs() est active (le registre, lui, tourne
// toujours : app.stats() marche même sans pont). cf. docs/23-mjs-ws.md « L'état du serveur ».

import { randomBytes } from 'node:crypto'

// --- réservoir de latences ping — échantillon glissant borné, p50/p95 calculés à la demande ---

export const LATENCY_RESERVOIR_SIZE = 256

/** Anneau borné de latences (ms) — au-delà de LATENCY_RESERVOIR_SIZE valeurs, les plus anciennes
 *  sont écrasées (fenêtre GLISSANTE) plutôt que jetées par un shift() O(n) inutile. */
export class LatencyReservoir {
  private _buf: number[] = []
  private _idx = 0

  push(ms: number): void {
    if (this._buf.length < LATENCY_RESERVOIR_SIZE) this._buf.push(ms)
    else { this._buf[this._idx] = ms; this._idx = (this._idx + 1) % LATENCY_RESERVOIR_SIZE }
  }

  get size(): number { return this._buf.length }

  percentiles(): MjsWsStatsLatences {
    if (this._buf.length === 0) return { p50: null, p95: null, echantillon: 0 }
    const sorted = this._buf.slice().sort((a, b) => a - b)
    const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * (sorted.length - 1)))]
    return { p50: at(0.50), p95: at(0.95), echantillon: sorted.length }
  }
}

// --- cause d'expulsion de garde — cf. guard.ts pour les primitives, core.ts pour les call-sites,
// « trop de messages invalides » (JSON) est comptée sous 'debit' (même seuil kickAfter, même
// famille d'abus « le client envoie trop », pas une 5e catégorie) ---

export type MjsWsGuardCause = 'debit' | 'silence' | 'engorgement' | 'charge'

export interface MjsWsStatsLatences {
  p50: number | null
  p95: number | null
  echantillon: number
}

// --- familles de compteurs — cf. docs/23-mjs-ws.md « L'état du serveur » pour le sens de chacune ---

export interface MjsWsStatsConnexions {
  actives: number
  parquees: number
  accueillies: number
  refusees: number
  fermees: number
  /** plafond de connexions — connexions refusées AVANT le hello par
   *  limits.maxConnections/maxConnectionsPerIp (core.ts::refuseForCap), DISTINCT de `refusees`
   *  ci-dessus (celui-ci compte les µ:denied applicatifs POST-hello, cf. sendDeniedAndClose). */
  refuseesPlafond: number
  /** vérification d'origine — connexions refusées AVANT le hello par
   *  opts.verifyOrigin (core.ts::refuseForOrigin), DISTINCTE de `refusees`/`refuseesPlafond` :
   *  même famille « refus pré-hello », pas une décision applicative. */
  refuseesOrigine: number
}

export interface MjsWsStatsMessages {
  recus: number
  envoyes: number
  tamponnes: number
  rejoues: number
  rejetes: number
  /** trames BINAIRES reçues (socle du futur µschema) — comptée AVANT toute garde,
   *  même politique que `recus` pour le texte (cf. core.ts::handleBinaryRaw). */
  binaireRecues: number
  /** sous-ensemble de `binaireRecues` : ignorée faute d'authentification, d'accroche interne, OU
   *  (µschema) id de schéma inconnu/trame corrompue — jamais un crash, µ:error
   *  SEULEMENT en mode ws.codec 'binary' (cf. core.ts::handleBinaryRaw, mjs-ws/schema.ts). */
  binaireIgnorees: number
  /** µschema — trame TEXTE applicative (t hors préfixe µ:) reçue alors que
   *  ws.codec === 'binary' (strict) : rejetée avant tout routage, µ:error throttlé envoyé (cf.
   *  mjs-ws/schema.ts::rejectIfStrictText, core.ts::handleRaw). Zéro en dehors du mode 'binary'. */
  texteRejete: number
}

export interface MjsWsStatsGuard {
  kicksDebit: number
  kicksSilence: number
  kicksEngorgement: number
  kicksChargeUtile: number
  /** fermetures pour JETON EXPIRÉ (core.ts::expireClientToken) — DÉDIÉE, hors de
   *  l'union MjsWsGuardCause : cette fermeture ne passe jamais par kickClient (µ:error{code}
   *  spécifique, code de fermeture 4002, jamais de µ:bye — cf. son commentaire de tête core.ts). */
  expirationsJeton: number
}

/** gauges — lues EN DIRECT depuis rooms.ts à la demande (jamais accumulées ici, jamais de drift) */
export interface MjsWsStatsRooms {
  nombre: number
  membresTotal: number
  abonnesPresence: number
}

export interface MjsWsStatsFlux {
  /** gauge — lue EN DIRECT depuis streams.ts à la demande, cf. MjsWsStatsSalons ci-dessus */
  nombre: number
  deltasEmis: number
  resyncsRejeu: number
  resyncsReset: number
}

export interface MjsWsStatsPont {
  requetesParEndpoint: Record<string, number>
  http401: number
  /** limite de débit — 429 renvoyés (seau général OU seau-échecs), cf. bridge.ts */
  rateLimited: number
  webhooksEnvoyes: number
  webhooksEchoues: number
  webhooksAbandonnes: number
}

export interface MjsWsStatsAdaptateur {
  publies: number
  recus: number
  ignoresOrigin: number
  reordonnances: number
  reconnexions: number
}

export interface MjsWsStatsSessions {
  emises: number
  reprises: number
  expirees: number
  debordees: number
}

export interface MjsWsStatsErreurs {
  erreurs: number
  avertissements: number
}

export interface MjsWsStatsSnapshot {
  /** secondes écoulées depuis app.listen() — cf. core.ts, posé au moment de créer le registre */
  uptime: number
  processId: string
  horodatage: number
  memoire: { rss: number }
  connexions: MjsWsStatsConnexions
  messages: MjsWsStatsMessages
  garde: MjsWsStatsGuard
  salons: MjsWsStatsRooms
  flux: MjsWsStatsFlux
  pont: MjsWsStatsPont
  adaptateur: MjsWsStatsAdaptateur
  sessions: MjsWsStatsSessions
  latences: MjsWsStatsLatences
  erreurs: MjsWsStatsErreurs
}

// --- le registre — TOUJOURS actif (aucune option ne le désactive), incréments = simple ++ -----

/** gauges lues EN DIRECT par l'appelant (core.ts, via rooms.ts/streams.ts) au moment du snapshot —
 *  jamais stockées dans le registre, cf. le commentaire de tête (une seule source de vérité). */
export interface MjsWsStatsGauges {
  salons: MjsWsStatsRooms
  /** streams.ts ne fournit QUE la gauge — les compteurs cumulés (deltasEmis/resyncs*) vivent
   *  dans le registre lui-même (`fluxCompteurs` ci-dessous), streams.ts les incrémente en direct */
  flux: Pick<MjsWsStatsFlux, 'nombre'>
}

export interface MjsWsStatsRegistry {
  readonly processId: string
  connexions: MjsWsStatsConnexions
  messages: MjsWsStatsMessages
  garde: MjsWsStatsGuard
  pont: MjsWsStatsPont
  adaptateur: MjsWsStatsAdaptateur
  sessions: MjsWsStatsSessions
  erreurs: MjsWsStatsErreurs
  fluxCompteurs: Pick<MjsWsStatsFlux, 'deltasEmis' | 'resyncsRejeu' | 'resyncsReset'>
  latencesPing: LatencyReservoir
  /** assemble l'instantané complet — `gauges` : valeurs lues EN DIRECT par l'appelant (core.ts) */
  snapshot(gauges: MjsWsStatsGauges): MjsWsStatsSnapshot
}

export function createStatsRegistry(): MjsWsStatsRegistry {
  const startedAt = Date.now()
  const processId = randomBytes(6).toString('hex')

  const registry: MjsWsStatsRegistry = {
    processId,
    connexions:    { actives: 0, parquees: 0, accueillies: 0, refusees: 0, fermees: 0, refuseesPlafond: 0, refuseesOrigine: 0 },
    messages:      { recus: 0, envoyes: 0, tamponnes: 0, rejoues: 0, rejetes: 0, binaireRecues: 0, binaireIgnorees: 0, texteRejete: 0 },
    garde:         { kicksDebit: 0, kicksSilence: 0, kicksEngorgement: 0, kicksChargeUtile: 0, expirationsJeton: 0 },
    pont:          { requetesParEndpoint: {}, http401: 0, rateLimited: 0, webhooksEnvoyes: 0, webhooksEchoues: 0, webhooksAbandonnes: 0 },
    adaptateur:    { publies: 0, recus: 0, ignoresOrigin: 0, reordonnances: 0, reconnexions: 0 },
    sessions:      { emises: 0, reprises: 0, expirees: 0, debordees: 0 },
    erreurs:       { erreurs: 0, avertissements: 0 },
    fluxCompteurs: { deltasEmis: 0, resyncsRejeu: 0, resyncsReset: 0 },
    latencesPing:  new LatencyReservoir(),

    snapshot(gauges: MjsWsStatsGauges): MjsWsStatsSnapshot {
      return {
        uptime:     Math.round((Date.now() - startedAt) / 1000),
        processId,
        horodatage: Date.now(),
        memoire:    { rss: process.memoryUsage().rss },
        connexions: { ...registry.connexions },
        messages:   { ...registry.messages },
        garde:      { ...registry.garde },
        salons:     { ...gauges.salons },
        flux:       { ...gauges.flux, ...registry.fluxCompteurs },
        pont:       { ...registry.pont, requetesParEndpoint: { ...registry.pont.requetesParEndpoint } },
        adaptateur: { ...registry.adaptateur },
        sessions:   { ...registry.sessions },
        latences:   registry.latencesPing.percentiles(),
        erreurs:    { ...registry.erreurs },
      }
    },
  }
  return registry
}

// --- format texte Prometheus (GET /metrics, bridge.ts) — lignes PLATES, aucun label (des noms
// distincts à la place, ex. par endpoint) : lisible par n'importe quel scraper sans config exotique,
// chaque valeur sur sa propre ligne `mjs_ws_<nom> <valeur>` précédée de son `# TYPE` -------------

function sanitizeEndpointName(route: string): string {
  return route.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '')
}

export function toPrometheusText(snapshot: MjsWsStatsSnapshot): string {
  const lines: string[] = []
  const gauge   = (name: string, value: number) => { lines.push(`# TYPE mjs_ws_${name} gauge`);   lines.push(`mjs_ws_${name} ${value}`) }
  const counter = (name: string, value: number) => { lines.push(`# TYPE mjs_ws_${name} counter`); lines.push(`mjs_ws_${name} ${value}`) }

  gauge('uptime_seconds', snapshot.uptime)
  gauge('memory_rss_bytes', snapshot.memoire.rss)

  gauge('connections_active', snapshot.connexions.actives)
  gauge('connections_parked', snapshot.connexions.parquees)
  counter('connections_welcomed_total', snapshot.connexions.accueillies)
  counter('connections_refused_total', snapshot.connexions.refusees)
  counter('connections_refused_cap_total', snapshot.connexions.refuseesPlafond)
  counter('connections_refused_origin_total', snapshot.connexions.refuseesOrigine)
  counter('connections_closed_total', snapshot.connexions.fermees)

  counter('messages_received_total', snapshot.messages.recus)
  counter('messages_sent_total', snapshot.messages.envoyes)
  counter('messages_buffered_total', snapshot.messages.tamponnes)
  counter('messages_replayed_total', snapshot.messages.rejoues)
  counter('messages_dropped_total', snapshot.messages.rejetes)
  counter('messages_binary_received_total', snapshot.messages.binaireRecues)
  counter('messages_binary_ignored_total', snapshot.messages.binaireIgnorees)
  counter('messages_text_rejected_strict_total', snapshot.messages.texteRejete)

  counter('guard_kicks_rate_total', snapshot.garde.kicksDebit)
  counter('guard_kicks_silence_total', snapshot.garde.kicksSilence)
  counter('guard_kicks_backpressure_total', snapshot.garde.kicksEngorgement)
  counter('guard_kicks_payload_total', snapshot.garde.kicksChargeUtile)
  counter('guard_token_expired_total', snapshot.garde.expirationsJeton)

  gauge('rooms_total', snapshot.salons.nombre)
  gauge('rooms_members_total', snapshot.salons.membresTotal)
  gauge('rooms_presence_subscribers', snapshot.salons.abonnesPresence)

  gauge('streams_total', snapshot.flux.nombre)
  counter('streams_deltas_total', snapshot.flux.deltasEmis)
  counter('streams_resync_replay_total', snapshot.flux.resyncsRejeu)
  counter('streams_resync_reset_total', snapshot.flux.resyncsReset)

  // pas de chiffre dans le NOM de la métrique (mjs_ws_bridge_http_401_total violerait la forme
  // attendue par un scraper strict, noms = lettres+underscore seulement — le code 401 reste
  // dans la doc/description, jamais dans le nom de la métrique elle-même)
  counter('bridge_unauthorized_total', snapshot.pont.http401)
  counter('bridge_rate_limited_total', snapshot.pont.rateLimited)
  counter('bridge_webhooks_sent_total', snapshot.pont.webhooksEnvoyes)
  counter('bridge_webhooks_failed_total', snapshot.pont.webhooksEchoues)
  counter('bridge_webhooks_abandoned_total', snapshot.pont.webhooksAbandonnes)
  for (const route of Object.keys(snapshot.pont.requetesParEndpoint)) {
    counter(`bridge_requests_${sanitizeEndpointName(route)}_total`, snapshot.pont.requetesParEndpoint[route])
  }

  counter('adapter_published_total', snapshot.adaptateur.publies)
  counter('adapter_received_total', snapshot.adaptateur.recus)
  counter('adapter_ignored_origin_total', snapshot.adaptateur.ignoresOrigin)
  counter('adapter_reordered_total', snapshot.adaptateur.reordonnances)
  counter('adapter_reconnects_total', snapshot.adaptateur.reconnexions)

  counter('sessions_issued_total', snapshot.sessions.emises)
  counter('sessions_resumed_total', snapshot.sessions.reprises)
  counter('sessions_expired_total', snapshot.sessions.expirees)
  counter('sessions_overflowed_total', snapshot.sessions.debordees)

  counter('log_errors_total', snapshot.erreurs.erreurs)
  counter('log_warnings_total', snapshot.erreurs.avertissements)

  if (snapshot.latences.p50 != null) gauge('ping_p50_ms', snapshot.latences.p50)
  if (snapshot.latences.p95 != null) gauge('ping_p95_ms', snapshot.latences.p95)
  gauge('ping_samples', snapshot.latences.echantillon)

  return lines.join('\n') + '\n'
}
