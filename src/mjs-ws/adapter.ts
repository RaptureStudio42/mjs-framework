// mjs-ws/adapter — la façade multi-processus : interface MjsWsAdapter (même
// patron que transport.ts) + MemoryAdapter, bus PARTAGÉ en mémoire pour les tests (plusieurs
// apps MJS-WS dans le MÊME processus mocha). adapter-redis.ts fournit l'implémentation réelle
// (mini-client Redis RESP maison, node:net/node:crypto SEULS) derrière la MÊME interface — le
// cœur du protocole (core.ts) ne connaît QUE MjsWsAdapter, jamais Redis directement.
//
// LE MOTEUR D'ÉCHANGE : chaque message publié porte son `origin` (processId aléatoire hex, UN
// par app/adapter) ; à la réception, un message dont l'origin == processId LOCAL est IGNORÉ —
// un process ne se re-livre jamais ses propres messages (écho pub/sub naturel de Redis :
// PUBLISH livre à TOUS les abonnés du canal, publisher compris s'il est aussi abonné). Ce
// filtrage vit ICI, au niveau de la façade — jamais réimplémenté par les call-sites (core.ts/
// rooms.ts/streams.ts, cf. leurs accroches de cluster, docs/23-mjs-ws.md).
//
// AU-DELÀ du pub/sub pur, deux primitives de coordination cross-process :
//   - incr(clé)                        — compteur ATOMIQUE partagé (seq GLOBAL des flux, streams.ts)
//   - set/removeLease/listLeases       — bail de vie à expiration (présence fusionnée, rooms.ts)
// MemoryAdapter simule les deux sur un bus en mémoire (compteur partagé, horloge injectable
// pour tester un bail expiré SANS vrai délai) ; adapter-redis.ts les traduit en INCR / SET EX /
// GET / DEL / KEYS Redis (cf. son commentaire de tête pour le détail du protocole RESP).

import { randomBytes } from 'node:crypto'

// --- la façade -----------------------------------------------------------------------------

export type MjsWsAdapterHandler = (message: unknown, origin: string) => void

export interface MjsWsAdapter {
  /** identifiant aléatoire de CE process — porté par chaque message publié (filtrage écho) */
  readonly processId: string
  /** espace de noms des canaux/clés — défaut 'mjs-ws' (cf. index.ts, opts.adapter.prefix) */
  readonly prefix: string
  /** fire-and-forget — jamais bloquant, jamais un throw (échec = warn via onLog, cf. adapter-redis.ts) */
  publish(channel: string, message: unknown): void
  /** `handler` ne voit JAMAIS les messages de CE process (origin filtré, cf. le commentaire de tête) */
  subscribe(channel: string, handler: MjsWsAdapterHandler): void
  /** compteur atomique partagé — retourne la valeur APRÈS incrément (≥ 1) */
  incr(key: string): Promise<number>
  /** pose/renouvelle un bail à expiration — `ttlSeconds` = durée de vie restante */
  setLease(key: string, ttlSeconds: number): Promise<void>
  /** libère un bail explicitement (arrêt propre — n'attend pas l'expiration) */
  removeLease(key: string): Promise<void>
  /** clés de bail VIVANTES sous ce préfixe exact (baux expirés déjà exclus) */
  listLeases(prefix: string): Promise<string[]>
  start(): Promise<void>
  stop(): Promise<void>
}

// ----------------------------------------------------------------------------
// MemoryAdapter — bus PARTAGÉ en mémoire, pour les tests (plusieurs apps, même process)
// ----------------------------------------------------------------------------
// `createMemoryAdapterBus()` fabrique un bus ; passe-le à `new MemoryAdapter({ bus })` pour
// CHAQUE app qui doit se voir l'une l'autre (2 apps + 1 bus commun = 2 « process » simulés).
// Sans `bus` fourni, chaque MemoryAdapter est SEUL sur son propre bus (utile en test d'unité
// isolé, mais alors rien ne « traverse » nulle part).

interface MemorySubscriber {
  processId: string
  handler: MjsWsAdapterHandler
}

interface MemoryLease {
  expiresAt: number
}

/** état interne du bus — le type exporté `MemoryAdapterBus` n'en est qu'un jeton opaque */
class MemoryAdapterBusState {
  subscribers = new Map<string, Set<MemorySubscriber>>()
  counters    = new Map<string, number>()
  leases      = new Map<string, MemoryLease>()
}

export type MemoryAdapterBus = MemoryAdapterBusState

/** fabrique un bus neuf — à PARTAGER entre les MemoryAdapter qui doivent se voir (cf. plus haut) */
export function createMemoryAdapterBus(): MemoryAdapterBus { return new MemoryAdapterBusState() }

export interface MemoryAdapterOpts {
  /** bus partagé — défaut : bus NEUF (cet adapter serait alors seul dessus) */
  bus?: MemoryAdapterBus
  /** processId forcé (lisibilité en test) — défaut : aléatoire hex */
  processId?: string
  /** préfixe de canaux/clés — défaut 'mjs-ws' */
  prefix?: string
  /** horloge injectable — simule un bail expiré SANS vrai délai (cf. mjs-ws-adapter.test.ts) */
  now?: () => number
}

export class MemoryAdapter implements MjsWsAdapter {
  readonly processId: string
  readonly prefix: string
  private _bus: MemoryAdapterBusState
  private _now: () => number

  constructor(opts: MemoryAdapterOpts = {}) {
    this.processId = opts.processId ?? randomBytes(8).toString('hex')
    this.prefix    = opts.prefix ?? 'mjs-ws'
    this._bus      = opts.bus ?? new MemoryAdapterBusState()
    this._now      = opts.now ?? (() => Date.now())
  }

  async start(): Promise<void> {}

  async stop(): Promise<void> {
    for (const subs of this._bus.subscribers.values()) {
      for (const s of Array.from(subs)) if (s.processId === this.processId) subs.delete(s)
    }
  }

  subscribe(channel: string, handler: MjsWsAdapterHandler): void {
    let subs = this._bus.subscribers.get(channel)
    if (!subs) { subs = new Set(); this._bus.subscribers.set(channel, subs) }
    subs.add({ processId: this.processId, handler })
  }

  publish(channel: string, message: unknown): void {
    const subs = this._bus.subscribers.get(channel)
    if (!subs || subs.size === 0) return
    const origin = this.processId
    for (const s of subs) {
      if (s.processId === origin) continue   // jamais ses propres messages (cf. le commentaire de tête)
      const handler = s.handler
      // asynchrone (microtask) — même politique que MemoryTransport.send() : jamais de callback
      // synchrone depuis publish(), pour ne pas masquer les bugs d'ordonnancement qu'un VRAI
      // aller-retour réseau (Redis) révélerait. Un abonné parti entre-temps (stop()) est ignoré.
      queueMicrotask(() => { if (subs.has(s)) handler(message, origin) })
    }
  }

  async incr(key: string): Promise<number> {
    const next = (this._bus.counters.get(key) ?? 0) + 1
    this._bus.counters.set(key, next)
    return next
  }

  async setLease(key: string, ttlSeconds: number): Promise<void> {
    this._bus.leases.set(key, { expiresAt: this._now() + ttlSeconds * 1000 })
  }

  async removeLease(key: string): Promise<void> { this._bus.leases.delete(key) }

  async listLeases(prefix: string): Promise<string[]> {
    const now = this._now()
    const out: string[] = []
    for (const [key, lease] of this._bus.leases) {
      if (lease.expiresAt <= now) continue   // expiré = absent, comme une clé Redis EX purgée toute seule
      if (key.indexOf(prefix) === 0) out.push(key)
    }
    return out
  }
}

// ----------------------------------------------------------------------------
// Anti-entropie de présence (réconciliation périodique multi-processus) — cf. docs/23-mjs-ws.md
// « Anti-entropie de présence », rooms.ts (localSnapshot/reconcileRemoteSnapshot, seul appelant
// d'attachPresenceAntiEntropy ci-dessous). Le bail (processId → vivant/mort, cf. core.ts
// checkLeasesNow) ne corrige que la mort d'un process ENTIER — un pair fantôme ou manquant sur
// un process resté VIVANT (blip réseau, message pub/sub perdu) peut y survivre indéfiniment.
// Chaque process publie donc, à intervalle régulier, un instantané COMPACT de SA présence
// locale ; les autres le comparent à leur vue distante de ce process et corrigent les écarts —
// EN SILENCE quand tout concorde (rooms.ts compare avant de muter/émettre, jamais de trame
// parasite). MÊME enveloppe que les autres messages adaptateur : skip-self par processId assuré
// par publish()/subscribe() (ci-dessus), jamais réimplémenté ici.
// ----------------------------------------------------------------------------

/** un peer GLOBAL liste les salons où il est membre (welcome précède toujours tout join, cf.
 *  core.ts : jamais de peer de salon sans son entrée globale) — instantané COMPACT, une entrée par peer */
export type MjsWsPresencePairs = Record<string, { meta: unknown; rooms: string[] }>

/** forme sur le fil (canal `<prefix>:presence:sync`) */
export interface MjsWsPresenceSnapshot {
  processId: string
  pairs: MjsWsPresencePairs
}

export interface MjsWsAntiEntropyHooks {
  /** construit l'instantané de la présence LOCALE — jamais recalculé ici (source unique : rooms.ts) */
  localSnapshot(): MjsWsPresencePairs
  /** applique un instantané REÇU — recale la vue distante attribuée à `processId` (rooms.ts) */
  reconcile(processId: string, snapshot: MjsWsPresenceSnapshot): void
}

/**
 * Branche l'anti-entropie de présence sur un adaptateur DÉJÀ construit — appelée par
 * createRoomsEngine (rooms.ts) quand un adaptateur est fourni, jamais directement par l'appli.
 * Abonnement posé ICI, à l'appel (même précédent que les canaux de createClusterEngine,
 * core.ts : avant même app.listen()) ; MAIS le TIMER de publication est calé sur le cycle de vie
 * RÉEL de l'app en enveloppant `adapter.start`/`adapter.stop` EN PLACE (même référence — core.ts
 * les appelle déjà tel quel depuis createClusterEngine, cf.
 * docs/23-mjs-ws.md) : armé APRÈS le vrai start, coupé AVANT le vrai stop — jamais un
 * setInterval livré à lui-même.
 */
export function attachPresenceAntiEntropy(adapter: MjsWsAdapter, intervalMs: number, hooks: MjsWsAntiEntropyHooks): void {
  const channel = `${adapter.prefix}:presence:sync`
  adapter.subscribe(channel, (msg, origin) => hooks.reconcile(origin, msg as MjsWsPresenceSnapshot))

  const realStart = adapter.start.bind(adapter)
  const realStop  = adapter.stop.bind(adapter)
  let timer: ReturnType<typeof setInterval> | null = null

  adapter.start = async () => {
    await realStart()
    timer = setInterval(() => adapter.publish(channel, { processId: adapter.processId, pairs: hooks.localSnapshot() }), intervalMs)
  }
  adapter.stop = async () => {
    if (timer) { clearInterval(timer); timer = null }
    await realStop()
  }
}
