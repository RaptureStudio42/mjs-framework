// mjs-ws/streams — « les flux » : état courant (Map) + journal circulaire des
// N derniers deltas + resync incrémental — remplace
// les stubs déclaratifs de core.ts (µ:sub-stream/µ:resync, reset vide).
// Contrat exact : runtime/mjs_socket.ts (_onStreamDelta) — delta {t: nomFlux,
// seq, p:{op,…}}, `seq` STRICTEMENT croissant PAR flux (le client ignore tout
// seq ≤ dernier vu — dédup), `reset` accepté à n'importe quelle seq (nouvelle
// époque, aucune contrainte de contiguïté).
//
// JOURNAL = tampon circulaire des deltas add/update/remove SEULEMENT (pas les
// reset — un reset VIDE le journal, cf. reset() ci-dessous) : TOUJOURS
// contigu par construction (push en ordre de seq, purge en tête quand la
// taille dépasse `journalSize`), donc « from+1..seq est couvert » se réduit à
// une seule comparaison : « le 1er élément du journal a une seq ≤ from+1 ».

import type { MjsWsClient, MjsWsLogFn, MjsWsFanSend } from './core.js'
import { safeKey } from './guard.js'
import type { MjsWsStatsRegistry } from './stats.js'
import { t } from '../messages/index.js'

/** garde d'ABONNEMENT à un flux — MIROIR de MjsWsJoinFn (rooms.ts), même contrat (sync/async, false = refus) */
export type MjsWsStreamAccessFn = (client: MjsWsClient, name: string) => boolean | Promise<boolean>

export interface MjsWsStreamOptions {
  /** taille du journal circulaire des derniers deltas — défaut 200 */
  journal?: number
  /**
   * Faille HAUTE comblée — garde d'ABONNEMENT (µ:sub-stream/µ:resync), consultée
   * AVANT tout snapshot/rejeu. SANS elle, n'importe quel client authentifié reçoit le flux complet
   * en devinant/connaissant son nom, MÊME s'il n'a jamais rejoint un salon — `rooms.join` n'est
   * JAMAIS consulté par app.stream() (deux gardes INDÉPENDANTES à dessein, cf. `room` ci-dessous).
   * `false`/throw = refus (MÊME contrat que `MjsWsRoomsOptions.join`, rooms.ts). ABSENTE (défaut) =
   * comportement HISTORIQUE INCHANGÉ, flux PUBLIC à tout authentifié — À TRANCHER par l'application,
   * cf. docs/23-mjs-ws.md « Les flux qui se rattrapent ».
   */
  canSubscribe?: MjsWsStreamAccessFn
  /**
   * sucre — exige l'appartenance au salon `room` (MÊME notion que rooms.ts) avant tout
   * µ:sub-stream/µ:resync. Combinable avec `canSubscribe` ci-dessus (les deux doivent accepter,
   * ET logique). NÉCESSITE un accroche posée par le moteur (core.ts, hors périmètre de ce module,
   * cf. le paramètre `hasRoomMember` de `createStreamsEngine`) — SANS elle, `stream()` REFUSE de
   * démarrer (throw explicite au moment de la déclaration, jamais un refus silencieux à l'usage).
   */
  room?: string
}

export interface MjsWsStreamHandle {
  add(key: string, value: unknown): void
  update(key: string, patch: Record<string, unknown>): void
  remove(key: string): void
  reset(values: Record<string, unknown>): void
  readonly size: number
  snapshot(): Record<string, unknown>
  /**
   * retire ce flux du registre (journal, abonnés, tampon de
   * réordonnancement cluster) : SANS ça, `streams` ne rétrécit JAMAIS (aucun autre point du
   * moteur ne fait `streams.delete(name)`) — un flux par PARTIE (ex. `app.stream('partie-'+id)`,
   * cas d'usage documenté, §5) fuit à vie, et `onDisconnect` (appelé à CHAQUE déconnexion, tous
   * clients confondus) itère l'intégralité des flux JAMAIS détruits — coût croissant sans borne.
   * `destroy()` n'annonce RIEN aux abonnés courants (cohérent avec un flux jamais déclaré : un
   * futur µ:sub-stream/µ:resync sur ce nom retombe sur `unknownStreamFallback`, reset vide +
   * warn) — à l'appli de prévenir ses clients AVANT si besoin (ex. un dernier message applicatif).
   * LIMITE CONNUE (multi-processus) : purement LOCALE, jamais propagée aux autres
   * process du cluster — ceux-ci gardent leur propre état pour ce nom tant qu'ils ne le
   * détruisent pas eux-mêmes (pas de canal de destruction cross-process).
   */
  destroy(): void
}

/** frame brute {t,seq,p} — même primitive que sendRaw (core.ts), élargie à MjsWsClient */
export type MjsWsRawSend = (client: MjsWsClient, frame: Record<string, unknown>) => void

interface JournalEntry { seq: number; p: unknown }

// garde d'accès résolue à la déclaration (cf. accessOf, dans createStreamsEngine) — `undefined` =
// flux PUBLIC (comportement historique), jamais réévaluée depuis les opts (cf. « opts ignorées »,
// bridge.ts::handleStream, MÊME principe que journalSize)
interface StreamAccess { canSubscribe?: MjsWsStreamAccessFn; room?: string }

interface StreamState {
  values: Map<string, unknown>
  seq: number
  journal: JournalEntry[]
  journalSize: number
  subscribers: Set<MjsWsClient>
  /** FIFO des mutations LOCALES clusterisées — sérialise incr/apply/publish de CE flux (cf. produceLocal) */
  chain: Promise<void>
  access?: StreamAccess
}

const DEFAULT_JOURNAL = 200

// Faille HAUTE comblée — profondeur bornée AVANT toute écriture (add/update/
// reset) : SANS cette garde, une SEULE entrée trop imbriquée (JSON.stringify lève un RangeError,
// pile V8 dépassée) empoisonne st.values de façon PERMANENTE — snapshotOf() la retraverse à CHAQUE
// futur µ:sub-stream/µ:resync (même d'un client jamais connecté avant l'incident), qui échoue donc
// en silence pour TOUJOURS (cf. core.ts::preEncodeFrame, qui avale l'exception sans jamais remonter
// à l'appelant — cf. bridge.ts pour le même plafond, dupliqué là-bas : ce module reste indépendant).
const MAX_VALUE_DEPTH = 64

// récursion elle-même bornée à `limit` (jamais plus loin, MÊME sur un objet cyclique — un cycle
// grimpe en profondeur à chaque tour, il ne peut donc QUE heurter le mur, jamais boucler à l'infini
// ni faire lever la garde elle-même) — SEULS objets/tableaux comptent un niveau
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

// sérialisable ET pas trop imbriquée — profondeur D'ABORD (borne la récursion AVANT tout appel à
// JSON.stringify sur une structure potentiellement énorme), puis JSON.stringify en `try` pour les
// AUTRES cas (BigInt, etc.) — jamais un throw qui remonterait jusqu'à l'appelant de cette fonction.
// JSON.stringify seul NE SUFFIT PAS : une Map/Set/fonction/Symbol NICHÉ(E) ne lève JAMAIS, elle
// disparaît en silence à
// l'encodage ({}) — parcours DÉDIÉ ci-dessous (la profondeur est déjà bornée par isTooDeep juste
// au-dessus, cette walk reste donc bornée SANS compteur propre) avant JSON.stringify ; seul le
// toJSON natif de Date reste toléré (fidèle), tout AUTRE toJSON refusé (fidélité invérifiable en
// général). `undefined` NICHÉ (clé objet/élément de tableau) est REFUSÉ (disparaît en silence, MÊME
// symptôme) — MAIS `value`/`patch`/`values` valant `undefined` AU SOMMET reste ACCEPTÉ (comportement
// historique inchangé, cf. tests/mjs-ws-bridge.test.ts côté pont pour la MÊME distinction).
function isSerializableEntry(value: unknown): boolean {
  if (isTooDeep(value, MAX_VALUE_DEPTH)) return false
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

// --- clustering (adaptateur) — cf. core.ts pour le branchement réel -----------------
// absent (undefined) = comportement historique STRICT, compteur LOCAL synchrone, zéro octet de
// différence (même précédent que resume/bridge, opt-in). Présent = compteur GLOBAL cross-process
// (adapter.incr), l'application locale devient asynchrone (attend l'allocation du seq).

export interface MjsWsStreamsCluster {
  /** alloue le PROCHAIN seq d'un flux — compteur GLOBAL cross-process (remplace le compteur local) */
  allocateSeq(name: string): Promise<number>
  /** mutation locale déjà appliquée (op connu, seq déjà alloué) — à publier vers les autres process */
  publish(name: string, seq: number, p: Record<string, unknown>): void
}

// descripteur d'une opération EN ENTRÉE (avant application) — le delta {op,...} qui en résulte
// (calculé par applyOp) a la MÊME forme pour 'add'/'remove', mais PAS pour 'update' (patch, pas
// la valeur fusionnée) ni 'reset' (values = l'INSTANTANÉ post-remplacement, pas l'entrée brute) —
// cf. applyOp. C'est CE delta qui voyage sur le réseau (journal local ET publication cluster).
type StreamOp =
  | { op: 'add'; key: string; value: unknown }
  | { op: 'update'; key: string; patch: Record<string, unknown> }
  | { op: 'remove'; key: string }
  | { op: 'reset'; values: Record<string, unknown> }

const REORDER_MAX_PENDING  = 100
const REORDER_TIMEOUT_MS   = 2000

interface ReorderState {
  pending: Map<number, Record<string, unknown>>
  timer: ReturnType<typeof setTimeout> | null
}

// accroche du sucre `room` (MjsWsStreamOptions) : vérifie l'appartenance d'un
// client à un salon rooms.ts. `undefined` = accroche NON câblée (core.ts, hors périmètre de ce
// module) — `stream(name, {room})` refuse alors de démarrer (cf. accessOf) plutôt que de laisser
// `room` silencieusement inactif. Câblage attendu, CÔTÉ core.ts, au point de construction de
// l'engine (INCHANGÉ ici, juste l'accroche décrite) : `(client, room) => roomsEngine.room(room).has(client)`.
export type MjsWsStreamRoomMembership = (client: MjsWsClient, room: string) => boolean

export function createStreamsEngine(
  rawSend: MjsWsRawSend, log: MjsWsLogFn, cluster?: MjsWsStreamsCluster, stats?: MjsWsStatsRegistry,
  fanSend?: MjsWsFanSend, hasRoomMember?: MjsWsStreamRoomMembership,
) {
  const streams = new Map<string, StreamState>()
  const reorderByStream = new Map<string, ReorderState>()   // réordonnancement des deltas DISTANTS, par flux (cf. receiveRemote)

  // fan-out à encodage unique (perf, cf. core.ts preEncodeFrame/sendPre/fanSend) —
  // MÊME principe que rooms.ts : injecté par core.ts, repli boucle rawSend si absent (moteur
  // constructible SANS core.ts, comportement HISTORIQUE strict). SEUL produceLocal s'en sert
  // (applyRemoteOne, delta DISTANT du cluster, hors mandat de cette optimisation, garde rawSend).
  const fan: MjsWsFanSend = fanSend ?? ((targets, frame, skip) => { for (const c of targets) { if (skip?.has(c)) continue; rawSend(c, frame) } })

  function snapshotOf(st: StreamState): Record<string, unknown> {
    const out: Record<string, unknown> = {}
    for (const [k, v] of st.values) if (safeKey(k)) out[k] = v
    return out
  }

  function pushJournal(st: StreamState, entry: JournalEntry): void {
    st.journal.push(entry)
    if (st.journal.length > st.journalSize) st.journal.shift()
  }

  // résout la garde d'accès à la DÉCLARATION (jamais réévaluée depuis les opts ensuite, cf.
  // getOrCreateStream) — `room` sans accroche câblée (hasRoomMember absent) = throw IMMÉDIAT,
  // jamais un refus silencieux à l'usage (cf. MjsWsStreamOptions.room)
  function accessOf(name: string, streamOpts?: MjsWsStreamOptions): StreamAccess | undefined {
    if (!streamOpts || (streamOpts.canSubscribe == null && streamOpts.room == null)) return undefined
    if (streamOpts.room != null && !hasRoomMember) throw new Error(t('ws.streams.room-sans-accroche', { name, room: streamOpts.room }))
    return { canSubscribe: streamOpts.canSubscribe, room: streamOpts.room }
  }

  function getOrCreateStream(name: string, streamOpts?: MjsWsStreamOptions): StreamState {
    let st = streams.get(name)
    if (!st) {
      st = {
        values: new Map(), seq: 0, journal: [], journalSize: streamOpts?.journal ?? DEFAULT_JOURNAL,
        subscribers: new Set(), chain: Promise.resolve(), access: accessOf(name, streamOpts),
      }
      streams.set(name, st)
    }
    return st
  }

  // évalue la garde d'accès (canSubscribe ET/OU room, ET logique — cf. MjsWsStreamOptions) —
  // retourne un booléen SYNCHRONE si tout est sync/absent (chemin HISTORIQUE, zéro await de plus
  // dans le cas courant sans garde), sinon une Promise (au moins une garde async) — MÊME contrat
  // que rooms.ts::opts.join, jamais un throw qui remonterait jusqu'au dispatcheur réseau (core.ts)
  function checkAccess(st: StreamState, client: MjsWsClient, name: string): boolean | Promise<boolean> {
    const access = st.access
    if (!access) return true
    if (access.room != null && !(hasRoomMember && hasRoomMember(client, access.room))) return false
    if (!access.canSubscribe) return true
    try {
      const result = access.canSubscribe(client, name)
      return result instanceof Promise ? result.then(ok => ok === true).catch(() => false) : result === true
    } catch { return false }
  }

  // applique un descripteur d'opération à st.values — retourne le delta `p` À DIFFUSER/JOURNALISER
  // (spread : sûr même si `patch`/`values` contient __proto__, CreateDataProperty, pas le setter).
  // PARTAGÉE par le producteur LOCAL (mutation d'origine) ET le rejeu d'un delta DISTANT
  // (applyRemoteOne, ci-dessous) : un delta reçu du réseau a EXACTEMENT la forme d'un StreamOp
  // (add/remove : verbatim ; update : {key,patch} ; reset : {values: instantané}) — le rejouer
  // avec applyOp() produit donc, sur chaque process, EXACTEMENT le même état.
  function applyOp(st: StreamState, op: StreamOp): Record<string, unknown> {
    if (op.op === 'add')    { st.values.set(op.key, op.value); return { op: 'add', key: op.key, value: op.value } }
    if (op.op === 'update') {
      const cur  = st.values.get(op.key)
      const base = (cur && typeof cur === 'object') ? cur as Record<string, unknown> : {}
      st.values.set(op.key, { ...base, ...op.patch })
      return { op: 'update', key: op.key, patch: op.patch }
    }
    if (op.op === 'remove') { st.values.delete(op.key); return { op: 'remove', key: op.key } }
    // 'reset' — nouvelle époque : journal vidé, un rejeu ne doit JAMAIS le traverser
    st.values = new Map(Object.entries(op.values))
    st.journal.length = 0
    return { op: 'reset', values: snapshotOf(st) }
  }

  // --- production LOCALE (add/update/remove/reset applicatifs) ---------------------------------
  function produceLocal(name: string, st: StreamState, op: StreamOp): void {
    if (!cluster) {
      // comportement HISTORIQUE, inchangé octet pour octet — compteur local synchrone
      const p = applyOp(st, op)
      st.seq++
      if (op.op !== 'reset') pushJournal(st, { seq: st.seq, p })
      fan(st.subscribers, { t: name, seq: st.seq, p })
      if (stats) stats.fluxCompteurs.deltasEmis++
      return
    }
    // clusterisé — FIFO PAR FLUX (même idée que client.chain, core.ts) : sérialise les
    // incr/apply/publish LOCAUX de CE flux, pour que deux appels d'affilée (add(); add();)
    // restent dans l'ordre d'APPEL même si allocateSeq() est asynchrone (réseau, cas Redis).
    st.chain = st.chain
      .then(async () => {
        const seq = await cluster.allocateSeq(name)
        const p   = applyOp(st, op)
        st.seq    = seq
        if (op.op !== 'reset') pushJournal(st, { seq, p })
        fan(st.subscribers, { t: name, seq, p })
        if (stats) stats.fluxCompteurs.deltasEmis++
        cluster.publish(name, seq, p)
      })
      .catch(err => log('error', t('ws.streams.mutation-clusterisee-echec', { name }), { err }))
  }

  // --- API applicative — app.stream(nom, opts) ---
  function stream(name: string, streamOpts?: MjsWsStreamOptions): MjsWsStreamHandle {
    const s = getOrCreateStream(name, streamOpts)
    return {
      add(key, value) {
        // refuse plutôt que d'empoisonner st.values (cf. isSerializableEntry)
        if (!isSerializableEntry(value)) throw new Error(t('ws.streams.entree-non-serialisable', { name, op: 'add', depth: MAX_VALUE_DEPTH }))
        produceLocal(name, s, { op: 'add', key, value })
      },
      update(key, patch) {
        if (!isSerializableEntry(patch)) throw new Error(t('ws.streams.entree-non-serialisable', { name, op: 'update', depth: MAX_VALUE_DEPTH }))
        produceLocal(name, s, { op: 'update', key, patch })
      },
      remove(key)           { produceLocal(name, s, { op: 'remove', key }) },
      reset(values) {
        if (!isSerializableEntry(values)) throw new Error(t('ws.streams.entree-non-serialisable', { name, op: 'reset', depth: MAX_VALUE_DEPTH }))
        produceLocal(name, s, { op: 'reset', values })
      },
      get size(): number   { return s.values.size },
      snapshot()           { return snapshotOf(s) },
      destroy() {
        streams.delete(name)
        const rs = reorderByStream.get(name)
        if (rs) { if (rs.timer) clearTimeout(rs.timer); reorderByStream.delete(name) }
      },
    }
  }

  // flux non déclaré (jamais vu app.stream()) → réponse honnête ; PAS d'auto-création, PAS d'abonnement fantôme
  function unknownStreamFallback(client: MjsWsClient, name: string, via: string): void {
    log('warn', t('ws.streams.flux-non-declare', { via, name }), { client: client.id })
    rawSend(client, { t: name, seq: 0, p: { op: 'reset', values: {} } })
  }

  // refus d'abonnement : log + µ:error catalogué, JAMAIS un simple silence (la
  // « garde muette » serait indiscernable d'un flux non déclaré ou d'un bogue réseau côté client)
  function denyStreamAccess(client: MjsWsClient, name: string, via: string): void {
    log('warn', t('ws.streams.abonnement-refuse', { via, name }), { client: client.id })
    rawSend(client, { t: 'µ:error', p: { message: t('ws.streams.acces-flux-refuse') } })
  }

  function grantSubStream(client: MjsWsClient, st: StreamState, name: string): void {
    st.subscribers.add(client)
    rawSend(client, { t: name, seq: st.seq, p: { op: 'reset', values: snapshotOf(st) } })
  }

  // --- µ:sub-stream — garde d'accès (cf. checkAccess), puis abonne + instantané reset ---
  function handleSubStream(client: MjsWsClient, name: string): void {
    const st = streams.get(name)
    if (!st) { unknownStreamFallback(client, name, 'µ:sub-stream'); return }
    const allowed = checkAccess(st, client, name)
    if (allowed === true) { grantSubStream(client, st, name); return }
    if (allowed === false) { denyStreamAccess(client, name, 'µ:sub-stream'); return }
    allowed.then(ok => { if (ok) grantSubStream(client, st, name); else denyStreamAccess(client, name, 'µ:sub-stream') })
  }

  // rejeu incrémental ou reset complet — SÉPARÉ de handleResync pour n'exécuter qu'APRÈS la garde
  // d'accès (checkAccess, potentiellement async), cf. handleResync ci-dessous
  function doResync(client: MjsWsClient, st: StreamState, name: string, from: number): void {
    st.subscribers.add(client)

    const seq = st.seq
    // époque future/serveur redémarré (from > seq) → reset complet
    if (from > seq) { rawSend(client, { t: name, seq, p: { op: 'reset', values: snapshotOf(st) } }); if (stats) stats.fluxCompteurs.resyncsReset++; return }
    // déjà à jour → rien à renvoyer (ni rejeu ni reset — pas de compteur, rien ne s'est passé)
    if (from === seq) return

    const covered = st.journal.length > 0 && st.journal[0].seq <= from + 1
    if (!covered) { rawSend(client, { t: name, seq, p: { op: 'reset', values: snapshotOf(st) } }); if (stats) stats.fluxCompteurs.resyncsReset++; return }
    // REJEU dans l'ordre, avec les seq D'ORIGINE du journal (jamais renumérotés)
    for (const entry of st.journal) { if (entry.seq > from) rawSend(client, { t: name, seq: entry.seq, p: entry.p }) }
    if (stats) stats.fluxCompteurs.resyncsRejeu++
  }

  // --- µ:resync — garde d'accès (cf. checkAccess), puis abonne (si besoin) + doResync ---
  function handleResync(client: MjsWsClient, name: string, from: number): void {
    const st = streams.get(name)
    if (!st) { unknownStreamFallback(client, name, 'µ:resync'); return }
    const allowed = checkAccess(st, client, name)
    if (allowed === true) { doResync(client, st, name, from); return }
    if (allowed === false) { denyStreamAccess(client, name, 'µ:resync'); return }
    allowed.then(ok => { if (ok) doResync(client, st, name, from); else denyStreamAccess(client, name, 'µ:resync') })
  }

  function onDisconnect(client: MjsWsClient): void {
    for (const st of streams.values()) st.subscribers.delete(client)
  }

  // --- réception d'un delta DISTANT (cluster, core.ts) — réordonnancement par flux -------------
  // le producteur (un AUTRE process) a déjà alloué `seq` (INCR global) et appliqué chez lui ; ici
  // on REJOUE la même opération (applyOp) pour arriver au MÊME état, dans l'ORDRE des seq — deux
  // publications concurrentes peuvent arriver dans le désordre (pas de garantie d'ordre du
  // transport pub/sub), d'où le petit tampon ci-dessous (cf. docs/23-mjs-ws.md « flux multi-
  // processus » pour la version vulgarisée).

  function applyRemoteOne(name: string, st: StreamState, seq: number, p: Record<string, unknown>): void {
    applyOp(st, p as StreamOp)   // rejoue l'opération — même fonction que le producteur, même résultat
    st.seq = seq
    if (p.op !== 'reset') pushJournal(st, { seq, p })
    for (const c of st.subscribers) rawSend(c, { t: name, seq, p })
    if (stats) stats.fluxCompteurs.deltasEmis++
  }

  function drainReorder(name: string, st: StreamState): void {
    const rs = reorderByStream.get(name)
    if (!rs) return
    while (rs.pending.has(st.seq + 1)) {
      const next = st.seq + 1
      const p = rs.pending.get(next)!
      rs.pending.delete(next)
      applyRemoteOne(name, st, next, p)
    }
    if (rs.pending.size === 0) { if (rs.timer) clearTimeout(rs.timer); reorderByStream.delete(name) }
  }

  // applique ce qui est en attente MALGRÉ le trou (seq manquants jamais arrivés) — la divergence
  // possible est documentée (docs/23-mjs-ws.md) ; le client protocolaire s'auto-corrige de toute
  // façon via µ:resync dès qu'il détecte un saut de seq (cf. runtime/mjs_socket.ts _onStreamDelta).
  function forceFlush(name: string, st: StreamState, reason: string): void {
    const rs = reorderByStream.get(name)
    if (!rs) return
    const seqs = Array.from(rs.pending.keys()).sort((a, b) => a - b)
    log('warn', t('ws.streams.application-avec-trou', { name, reason, count: seqs.length }), { pending: seqs })
    for (const seq of seqs) {
      const p = rs.pending.get(seq)!
      rs.pending.delete(seq)
      if (seq > st.seq) applyRemoteOne(name, st, seq, p)
    }
    if (rs.timer) clearTimeout(rs.timer)
    reorderByStream.delete(name)
  }

  function bufferReorder(name: string, st: StreamState, seq: number, p: Record<string, unknown>): void {
    let rs = reorderByStream.get(name)
    if (!rs) { rs = { pending: new Map(), timer: null }; reorderByStream.set(name, rs) }
    rs.pending.set(seq, p)
    // statistiques (stats.ts) — un delta DISTANT mis de côté faute d'ordre = « réordonnancé » (famille
    // adaptateur, pas flux : c'est le pub/sub cluster qui n'a pas garanti l'ordre, pas le flux lui-même)
    if (stats) stats.adaptateur.reordonnances++
    if (rs.pending.size > REORDER_MAX_PENDING) { forceFlush(name, st, t('ws.streams.tampon-reordonnancement-plein', { max: REORDER_MAX_PENDING })); return }
    if (!rs.timer) rs.timer = setTimeout(() => forceFlush(name, st, t('ws.streams.delai-reordonnancement-depasse', { ms: REORDER_TIMEOUT_MS })), REORDER_TIMEOUT_MS)
  }

  function receiveRemote(name: string, seq: number, p: Record<string, unknown>): void {
    const st = getOrCreateStream(name)
    if (seq <= st.seq) return   // déjà appliqué / obsolète — dédup, même politique que le journal local
    if (seq === st.seq + 1) { applyRemoteOne(name, st, seq, p); drainReorder(name, st); return }
    bufferReorder(name, st, seq, p)
  }

  // état/métriques (stats.ts) — GAUGE lue EN DIRECT à la demande (app.stats(), core.ts) ;
  // les compteurs cumulés (deltasEmis/resyncs*) vivent dans le registre lui-même (fluxCompteurs).
  function statsSnapshot(): { nombre: number } {
    return { nombre: streams.size }
  }

  return { stream, handleSubStream, handleResync, onDisconnect, receiveRemote, statsSnapshot }
}
