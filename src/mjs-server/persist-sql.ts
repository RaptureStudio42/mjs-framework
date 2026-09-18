// mjs-server/persist-sql — adaptateur SQL GÉNÉRIQUE du contrat MjsServerPersistAdapter (cf.
// persist.ts) : AUCUN pilote embarqué (ZÉRO dépendance npm, comme tous les adaptateurs de ce
// dossier) — l'appli hôte injecte SON propre exécuteur de requêtes via `opts.query(sql, params)`,
// qui doit renvoyer une Promise résolue en TABLEAU DE LIGNES pour un SELECT (peu importe la forme
// exacte renvoyée par le pilote pour les autres requêtes, jamais lue ici). Deux dialectes de
// paramètres bind supportés (`opts.dialect`) : `'?'` (MySQL/mysql2, positionnel) ou `'$'`
// (PostgreSQL/pg, `$1 $2 …`).
//
// CÂBLAGE — l'appli fournit `query`, PAS un client/pool brut (cette façade ne connaît AUCUN nom de
// paquet) :
//
//   mysql2 (dialecte '?') :
//     const pool  = mysql.createPool({ host: '…', database: '…' }).promise()
//     const query = async (sql, params) => { const [rows] = await pool.query(sql, params); return rows }
//     app = mjsServer({ persist: new SqlPersistAdapter({ query, dialect: '?' }) })
//
//   pg (dialecte '$') :
//     const client = new pg.Client({ connectionString: '…' }); await client.connect()
//     const query  = async (sql, params) => { const { rows } = await client.query(sql, params); return rows }
//     app = mjsServer({ persist: new SqlPersistAdapter({ query, dialect: '$' }) })
//
// SCHÉMA — à la construction, une seule fois (fire-and-forget, MÊME patron que persist-file.ts
// `_ready` pour le mkdir initial) :
//   CREATE TABLE IF NOT EXISTS <table> (id VARCHAR(64) PRIMARY KEY, data TEXT, updated_at BIGINT)
// DDL volontairement dialecte-agnostique (types portables MySQL/Postgres, aucun paramètre bind) —
// toute opération publique (save/remove/load) ATTEND cette promesse avant sa propre requête
// (`this._ready`, jamais réémise si l'appel initial échoue — limite connue v1, même choix assumé
// que persist-file.ts pour son mkdir). `data` et `updated_at` sont des identifiants NON RÉSERVÉS
// dans les deux dialectes (MySQL 8 comme PostgreSQL) : aucun échappement nécessaire.
//
// save() = UPSERT (1 aller-retour, jamais SELECT-puis-INSERT/UPDATE) :
//   '?' (MySQL)    : INSERT INTO <table> (id, data, updated_at) VALUES (?, ?, ?)
//                      ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)
//   '$' (Postgres) : INSERT INTO <table> (id, data, updated_at) VALUES ($1, $2, $3)
//                      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at
// `updated_at` = horodatage ms (Date.now()) posé à CHAQUE save(), jamais lu par load() (réservé à un
// usage diagnostic/tri côté appli — hors périmètre de ce contrat, qui ne restitue que `id`+`data`).
// remove() = DELETE FROM <table> WHERE id = ?|$1. load() = SELECT id, data FROM <table> — le nom de
// COLONNE est aussi la clé des lignes renvoyées par le pilote : les deux doivent rester d'accord.
//
// ERREURS — MÊME politique que persist-bridge.ts : un `query()` qui rejette (table verrouillée,
// pool épuisé, coupure réseau…) → warn, JAMAIS throw/rejet vers l'appelant (save/remove sont
// fire-and-forget par contrat ; load() avale l'erreur et renvoie [], démarrage SANS restauration —
// MÊME repli que persist-redis.ts/persist-bridge.ts).
//
//   import { mjsServer, SqlPersistAdapter } from 'mjs-framework/mjs-server'
//   app = mjsServer({ persist: new SqlPersistAdapter({ query, table: 'saved_games', dialect: '$' }) })

import type { MjsWsLogFn, MjsWsLogLevel } from '../mjs-ws/index.js'
import type { MjsServerPersistAdapter } from './persist.js'
import type { MjsServerGameSnapshot } from './game.js'
import { encodeSnapshot, decodeSnapshot } from './persist.js'
import { t } from '../messages/index.js'

export type SqlDialect = '?' | '$'

export interface SqlPersistAdapterOpts {
  /** exécuteur fourni par l'appli — SON pilote (mysql2/pg/…) déjà connecté, cf. commentaire de tête
   *  pour les 2 recettes de câblage. Résout en TABLEAU DE LIGNES pour un SELECT. */
  query: (sql: string, params: unknown[]) => Promise<unknown>
  /** défaut 'mjs_server_games' */
  table?: string
  /** '?' = MySQL/mysql2 (défaut), '$' = PostgreSQL/pg */
  dialect?: SqlDialect
  onLog?: MjsWsLogFn
}

function defaultLog(level: MjsWsLogLevel, message: string, meta?: unknown): void {
  const line = `[mjs-server:persist-sql] ${message}`
  if (level === 'error') console.error(line, meta ?? '')
  else if (level === 'warn') console.warn(line, meta ?? '')
  else console.log(line, meta ?? '')
}

// identifiant SQL simple — table CONFIGURÉE par l'appli (jamais une entrée utilisateur), mais une
// garde immédiate à la construction (erreur claire) coûte 1 ligne et évite d'injecter un nom
// malformé tel quel dans le texte SQL (aucun bind possible sur un nom de table)
const SQL_IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/

export class SqlPersistAdapter implements MjsServerPersistAdapter {
  private _query: (sql: string, params: unknown[]) => Promise<unknown>
  private _table: string
  private _dialect: SqlDialect
  private _onLog: MjsWsLogFn
  private _ready: Promise<void>
  private _enVol = new Set<Promise<void>>()

  constructor(opts: SqlPersistAdapterOpts) {
    if (typeof opts.query !== 'function') throw new Error(t('serveur.persist-sql-query-manquant'))
    if (opts.dialect !== undefined && opts.dialect !== '?' && opts.dialect !== '$') throw new Error(t('serveur.persist-sql-dialect-invalide', { received: JSON.stringify(opts.dialect) }))
    this._table = opts.table ?? 'mjs_server_games'
    if (!SQL_IDENTIFIER.test(this._table)) throw new Error(t('serveur.persist-sql-table-invalide', { table: this._table }))
    this._query   = opts.query
    this._dialect = opts.dialect ?? '?'
    this._onLog   = opts.onLog ?? defaultLog
    this._ready   = this._query(`CREATE TABLE IF NOT EXISTS ${this._table} (id VARCHAR(64) PRIMARY KEY, data TEXT, updated_at BIGINT)`, [])
      .then(() => {})
      .catch(err => { this._onLog('warn', t('serveur.persist-sql-table-creation-echouee', { table: this._table }), { err: err instanceof Error ? err.message : String(err) }) })
  }

  // garde-fou — .catch() AVANT .finally() : une promesse orpheline rejetée ne doit
  // JAMAIS devenir un unhandledRejection (Node 20 tue le process dessus). En pratique save()/remove()
  // catchent déjà tout en interne (le .catch() ci-dessous ferme la chaîne) — filet de sécurité.
  private _suivre(p: Promise<void>, label: string): void {
    this._enVol.add(p)
    p.catch(err => this._onLog('warn', t('serveur.persist-backend-rejet-non-intercepte', { backend: 'sql', label: label }), { err: err instanceof Error ? err.message : String(err) }))
      .finally(() => this._enVol.delete(p))
  }

  private _upsertSql(): string {
    return this._dialect === '?'
      ? `INSERT INTO ${this._table} (id, data, updated_at) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE data = VALUES(data), updated_at = VALUES(updated_at)`
      : `INSERT INTO ${this._table} (id, data, updated_at) VALUES ($1, $2, $3) ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = EXCLUDED.updated_at`
  }

  private _deleteSql(): string {
    return this._dialect === '?' ? `DELETE FROM ${this._table} WHERE id = ?` : `DELETE FROM ${this._table} WHERE id = $1`
  }

  save(id: string, data: MjsServerGameSnapshot): void {
    const params = [id, encodeSnapshot(data), Date.now()]
    this._suivre(this._ready
      .then(() => this._query(this._upsertSql(), params)).then(() => {})
      .catch(err => this._onLog('warn', t('serveur.persist-backend-save-echouee', { backend: 'sql', id: id }), { err: err instanceof Error ? err.message : String(err) })), `save('${id}')`)
  }

  remove(id: string): void {
    this._suivre(this._ready
      .then(() => this._query(this._deleteSql(), [id])).then(() => {})
      .catch(err => this._onLog('warn', t('serveur.persist-backend-remove-echouee', { backend: 'sql', id: id }), { err: err instanceof Error ? err.message : String(err) })), `remove('${id}')`)
  }

  async load(): Promise<Array<{ id: string; data: MjsServerGameSnapshot }>> {
    await this._ready
    try {
      const rows = await this._query(`SELECT id, data FROM ${this._table}`, [])
      const results: Array<{ id: string; data: MjsServerGameSnapshot }> = []
      for (const row of (Array.isArray(rows) ? rows as Array<Record<string, unknown>> : [])) {
        const id = String(row.id)
        try { results.push({ id, data: decodeSnapshot(row.data) }) }
        catch (err) { this._onLog('warn', t('serveur.persist-backend-entree-illisible', { backend: 'sql', id: id }), { err: err instanceof Error ? err.message : String(err) }) }
      }
      return results
    } catch (err) {
      this._onLog('warn', t('serveur.persist-backend-load-echoue', { backend: 'sql' }), { err: err instanceof Error ? err.message : String(err) })
      return []
    }
  }

  async flush(): Promise<void> {
    await Promise.allSettled(Array.from(this._enVol))
  }
}
