// mjs-server/persist-redis — adaptateur Redis ZÉRO dépendance npm du contrat MjsServerPersistAdapter
// (cf. persist.ts) : RÉUTILISE TEL QUEL le mini-client RESP maison de mjs-ws/adapter-redis.ts —
// `RedisConnection`, exportée là-bas pour cet usage (SEULE retouche apportée à ce fichier voisin,
// cf. son commentaire d'export) — AUCUNE réimplémentation du protocole RESP ici, MÊME
// précédent que game.ts qui importe TokenBucket depuis mjs-ws/guard.ts.
//
// STOCKAGE — UN hash Redis pour tout le process MJS-Server (clé `<prefix>games`), un CHAMP par
// partie (`<id>` → JSON de partie.serialize()) :
//   save(id, données) → HSET <prefix>games <id> <json>
//   remove(id)        → HDEL <prefix>games <id>
//   load()             → HGETALL <prefix>games (une seule commande, tout le hash d'un coup,
//                         réponse RESP = tableau PLAT [champ1, valeur1, champ2, valeur2, …])
//
// CONNEXION PARESSEUSE — AUCUN socket ouvert avant le premier save/remove/load (cf. _amorcer) :
// une seule connexion en rôle 'command' (jamais de pub/sub ici, contrairement à RedisAdapter côté
// MJS-WS). FILE D'ATTENTE pendant l'indisponibilité — save/remove/load appelés AVANT que la
// connexion soit prête (1er appel, ou Redis injoignable/en reconnexion) sont mis en attente
// (_awaitConnection) et rejoués dans l'ordre dès `onConnected` (posé après CHAQUE (re)connexion
// réussie, initiale ou après coupure — MÊME callback que RedisAdapter.subscribe() côté MJS-WS) ;
// bornée à CONNECT_TIMEOUT_MS (5 s, même ordre de grandeur que persist-bridge.ts
// DEFAULT_TIMEOUT_MS) — AU-DELÀ, abandon + warn, JAMAIS un blocage indéfini de l'appelant (même
// politique que persist-bridge : « le prochain save() rattrapera l'état dès qu'il repasse »).
// Cette même borne s'applique à load() (awaité par persist.ts loadAtBoot AVANT app.listen()) —
// sans elle, un Redis injoignable au boot gèlerait indéfiniment le démarrage du serveur entier.
//
// flush() attend la file ENTIÈRE (opérations en vol + en attente de connexion, bornées ci-dessus)
// PUIS ferme la connexion (_conn.stop()) — CHOIX délibéré au-delà du contrat minimal (persist.ts
// n'exige que l'attente) : `flush()` est le dernier appel du cycle de vie de l'adaptateur (posé une
// seule fois, dans app.stop(), cf. persist.ts createPersistEngine.stop()) ; SANS cette fermeture,
// le socket + son cycle de reconnexion à backoff resteraient ouverts indéfiniment après l'arrêt du
// serveur (process qui ne rend jamais la main, warnings de reconnexion en boucle vers un Redis dont
// plus personne ne se sert). À signaler côté doc si ce comportement doit être documenté.
//
//   import { mjsServer, RedisPersistAdapter } from 'mjs-framework/mjs-server'
//   app = mjsServer({ persist: new RedisPersistAdapter({ url: 'redis://localhost:6379', prefix: 'mjs-server:' }) })

import { RedisConnection, parseRedisUrl, type RespValue } from '../mjs-ws/adapter-redis.js'
import type { MjsWsLogFn, MjsWsLogLevel } from '../mjs-ws/index.js'
import type { MjsServerPersistAdapter } from './persist.js'
import type { MjsServerGameSnapshot } from './game.js'
import { encodeSnapshot, decodeSnapshot } from './persist.js'
import { t } from '../messages/index.js'

const CONNECT_TIMEOUT_MS = 5000   // borne « jamais bloquant » — même ordre de grandeur que persist-bridge.ts

export interface RedisPersistAdapterOpts {
  /** redis://[[:motDePasse]@]hôte[:port][/base] — prioritaire sur host/port si les deux sont fournis */
  url?: string
  /** défaut '127.0.0.1' — ignoré si `url` est fourni */
  host?: string
  /** défaut 6379 — ignoré si `url` est fourni */
  port?: number
  /** espace de noms de la clé de hash — défaut 'mjs-server:' (clé finale : '<prefix>games') */
  prefix?: string
  onLog?: MjsWsLogFn
}

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-server:persist-redis] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

export class RedisPersistAdapter implements MjsServerPersistAdapter {
  private _conn: RedisConnection
  private _key: string
  private _onLog: MjsWsLogFn
  private _amorcee = false
  private _enVol = new Set<Promise<void>>()
  // callbacks « réveille-moi à la prochaine connexion réussie » — posés par _awaitConnection,
  // consommés (splice) à CHAQUE onConnected (initiale ou reconnexion), jamais accumulés au-delà
  private _ready: Array<() => void> = []

  constructor(opts: RedisPersistAdapterOpts = {}) {
    const target = opts.url ? parseRedisUrl(opts.url) : { host: opts.host ?? '127.0.0.1', port: opts.port ?? 6379, password: undefined, db: undefined }
    this._onLog  = opts.onLog ?? defaultLog
    this._key    = (opts.prefix ?? 'mjs-server:') +'games'
    this._conn   = new RedisConnection({
      host: target.host, port: target.port, password: target.password, db: target.db,
      role:  'command',
      onLog: this._onLog,
      onConnected: () => { const queue = this._ready.splice(0); for (const wake of queue) wake() },
    })
  }

  private _amorcer(): void {
    if (this._amorcee) return
    this._amorcee = true
    this._conn.connect()
  }

  /** résout `true` dès que la connexion est prête, `false` si CONNECT_TIMEOUT_MS est dépassé
   *  avant — ne rejette JAMAIS (cf. commentaire de tête, jamais un blocage de l'appelant). */
  private _awaitConnection(timeoutMs: number): Promise<boolean> {
    this._amorcer()
    if (this._conn.ready) return Promise.resolve(true)
    return new Promise((resolve) => {
      let settled = false
      const timer = setTimeout(() => { if (!settled) { settled = true; resolve(false) } }, timeoutMs)
      this._ready.push(() => { if (!settled) { settled = true; clearTimeout(timer); resolve(true) } })
    })
  }

  /** exécute `task` tout de suite si la connexion est prête, sinon la met en FILE (rejouée à la
   *  prochaine connexion, bornée à CONNECT_TIMEOUT_MS) — jamais throw, toujours un warn en cas
   *  d'échec (connexion jamais obtenue OU commande RESP en erreur). */
  private _runWhenReady(task: () => Promise<void>, label: string): Promise<void> {
    const run = () => task().catch(err => this._onLog('warn', t('serveur.persist-redis-operation-echouee', { label: label }), { err: err instanceof Error ? err.message : String(err) }))
    if (this._conn.ready) return run()
    return this._awaitConnection(CONNECT_TIMEOUT_MS).then((ready) => {
      if (!ready) { this._onLog('warn', t('serveur.persist-redis-connexion-indisponible', { label: label, timeout: CONNECT_TIMEOUT_MS })); return }
      return run()
    })
  }

  // garde-fou — .catch() AVANT .finally() : une promesse orpheline rejetée ne doit
  // JAMAIS devenir un unhandledRejection (Node 20 tue le process dessus). En pratique _runWhenReady
  // catche déjà tout en interne (jamais un rejet ici) — filet de sécurité.
  private _suivre(p: Promise<void>, label: string): void {
    this._enVol.add(p)
    p.catch(err => this._onLog('warn', t('serveur.persist-backend-rejet-non-intercepte', { backend: 'redis', label: label }), { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => this._enVol.delete(p))
  }

  save(id: string, data: MjsServerGameSnapshot): void {
    this._suivre(this._runWhenReady(() => this._conn.send(['HSET', this._key, id, encodeSnapshot(data)]).then(() => {}), `save('${id}')`), `save('${id}')`)
  }

  remove(id: string): void {
    this._suivre(this._runWhenReady(() => this._conn.send(['HDEL', this._key, id]).then(() => {}), `remove('${id}')`), `remove('${id}')`)
  }

  async load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>> {
    const ready = await this._awaitConnection(CONNECT_TIMEOUT_MS)
    if (!ready) { this._onLog('warn', t('serveur.persist-redis-load-delai-depasse', { timeout: CONNECT_TIMEOUT_MS })); return [] }
    try {
      const v = await this._conn.send(['HGETALL', this._key])
      return this._parserHash(v)
    } catch (err) {
      this._onLog('warn', t('serveur.persist-backend-load-echoue', { backend: 'redis' }), { err: err instanceof Error ? err.message : String(err) })
      return []
    }
  }

  private _parserHash(v: RespValue): Array<{ id: string; data: MjsServerGameSnapshot }> {
    const flat = Array.isArray(v) ? v : []
    const results: Array<{ id: string; data: MjsServerGameSnapshot }> = []
    for (let i = 0; i + 1 < flat.length; i += 2) {
      const id = String(flat[i])
      try { results.push({ id, data: decodeSnapshot(flat[i + 1]) }) }
      catch (err) { this._onLog('warn', t('serveur.persist-backend-entree-illisible', { backend: 'redis', id: id }), { err: err instanceof Error ? err.message : String(err) }) }
    }
    return results
  }

  /** attend la file ENTIÈRE (cf. _runWhenReady, bornée) PUIS ferme la connexion — cf.
   *  commentaire de tête pour la justification (dernier appel du cycle de vie). */
  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this._enVol))
    this._conn.stop()
  }
}
