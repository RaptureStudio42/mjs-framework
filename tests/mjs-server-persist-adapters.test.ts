// Tests des adaptateurs de persistance Redis/SQL (mjs-server/persist-redis.ts, persist-sql.ts) —
// Redis : MÊME patron « faux serveur node:net qui parle RESP » que
// tests/mjs-ws-adapter-redis.test.ts (AUCUN Redis vivant, RedisConnection réutilisée telle quelle
// depuis mjs-ws/adapter-redis.ts). SQL : faux `query()` espion (AUCUN pilote mysql2/pg vivant).
// Intégration légère : MÊME harnais que tests/mjs-server-persist.test.ts (VRAI client µ.socket sur
// MemoryTransport), avec SqlPersistAdapter au lieu de MemoryPersistAdapter.
import assert from 'node:assert/strict'
import { createServer, type Server, type Socket } from 'node:net'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { encodeCommand } from '../src/mjs-ws/adapter-redis.js'
import { mjsServer, RedisPersistAdapter, SqlPersistAdapter } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp, MjsServerOptions } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

function connecter(transport: MemoryTransport, id: string): any {
  const µ = makeClient(transport)
  return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
}

/** MÊME patron que tests/mjs-server-persist.test.ts — `.game()` AVANT `.listen()`, jamais après
 *  (la restauration tourne DANS `.listen()`, cf. index.ts) */
function creerApp(opts: MjsServerOptions = {}): { transport: MemoryTransport; app: MjsServerApp } {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  return { transport, app }
}

function declarerJeu(app: MjsServerApp): void {
  app.game('duel', {
    seats: 2,
    code: true,
    seatTtl: 500,
    emptyTtl: 150,
    state: () => ({ n: 0 }),
    moves: { inc: (game: any) => { game.state.n++; game.next() } },
    phases: { jeu: ['inc'] },
    turns: { order: 'roundrobin', timeout: 2000 },
  })
}

// --- Redis — faux serveur node:net qui parle RESP (patron EXACT de tests/mjs-ws-adapter-redis.test.ts) --

describe('mjs-server/persist-redis — adaptateur Redis (faux serveur node:net RESP, AUCUN Redis vivant)', function () {
  this.timeout(8000)

  it("save(id, données) → HSET '<prefix>games' <id> <json>", async () => {
    const reçus: string[] = []
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        reçus.push(s)
        if (s.indexOf('HSET') !== -1) socket.write(':1\r\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisPersistAdapter({ host: '127.0.0.1', port, prefix: 'test:', onLog: () => {} })
    adapter.save('partie7', { id: 'partie7', state: { n: 1 } } as any)
    await adapter.flush()

    const trame = reçus.join('')
    assert.ok(trame.indexOf('HSET') !== -1, 'commande HSET attendue')
    assert.ok(trame.indexOf('test:games') !== -1, 'clé de hash préfixée')
    assert.ok(trame.indexOf('partie7') !== -1, 'id en nom de champ')
    assert.ok(trame.indexOf('"n":1') !== -1, 'JSON sérialisé en valeur')

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("remove(id) → HDEL '<prefix>games' <id>", async () => {
    const reçus: string[] = []
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        reçus.push(s)
        if (s.indexOf('HDEL') !== -1) socket.write(':1\r\n')
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisPersistAdapter({ host: '127.0.0.1', port, onLog: () => {} })   // préfixe par défaut 'mjs-server:'
    adapter.remove('partie9')
    await adapter.flush()

    const trame = reçus.join('')
    assert.ok(trame.indexOf('HDEL') !== -1)
    assert.ok(trame.indexOf('mjs-server:games') !== -1, 'préfixe par défaut')
    assert.ok(trame.indexOf('partie9') !== -1)

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('load() → HGETALL, parse le tableau plat [champ,valeur,…] simulé en entrées {id, données}', async () => {
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').indexOf('HGETALL') === -1) return
        const p1 = JSON.stringify({ id: 'p1', state: { n: 1 } })
        const p2 = JSON.stringify({ id: 'p2', state: { n: 2 } })
        socket.write(encodeCommand(['p1', p1, 'p2', p2]))   // réponse ARRAY = même encodage que encodeCommand (déjà réutilisé ainsi pour les push 'subscribe', cf. mjs-ws-adapter-redis.test.ts)
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisPersistAdapter({ host: '127.0.0.1', port, onLog: () => {} })
    const brut = await adapter.load()

    assert.equal(brut.length, 2)
    assert.equal(brut[0].id, 'p1')
    assert.equal((brut[0].data as any).state.n, 1)
    assert.equal(brut[1].id, 'p2')
    assert.equal((brut[1].data as any).state.n, 2)

    await adapter.flush()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it("connexion pas encore prête (paresseuse) → save() mis en FILE, rejoué à la connexion — flush() attend qu'il soit PARTI", async () => {
    let hsetVu = false
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        if (chunk.toString('utf8').indexOf('HSET') !== -1) { hsetVu = true; socket.write(':1\r\n') }
      })
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
    const port = (server.address() as any).port

    const adapter = new RedisPersistAdapter({ host: '127.0.0.1', port, onLog: () => {} })
    adapter.save('p1', { id: 'p1' } as any)   // connexion tout juste amorcée (async) — encore fermée ICI
    assert.equal(hsetVu, false, "sanity : connect() est asynchrone, HSET ne peut pas déjà être parti")

    await adapter.flush()
    assert.ok(hsetVu, "flush() doit avoir attendu le save() en file AVANT de se terminer")

    await new Promise<void>(resolve => server.close(() => resolve()))
  })

  it('Redis injoignable au 1er essai (indisponibilité RÉELLE) → save() mis en file, rattrapé automatiquement à la reconnexion réussie (backoff)', async function () {
    this.timeout(6000)
    const sonde = createServer()
    await new Promise<void>(resolve => sonde.listen(0, '127.0.0.1', () => resolve()))
    const port = (sonde.address() as any).port
    await new Promise<void>(resolve => sonde.close(() => resolve()))   // libère le port — RIEN n'écoute dessus

    const reçus: string[] = []
    const adapter = new RedisPersistAdapter({ host: '127.0.0.1', port, onLog: () => {} })
    adapter.save('tardif', { id: 'tardif' } as any)   // 1er essai de connexion → ECONNREFUSED → backoff 1s

    await tick(200)   // laisse le 1er essai échouer avant de faire apparaître le serveur
    const server: Server = createServer((socket: Socket) => {
      socket.on('data', (chunk: Buffer) => {
        const s = chunk.toString('utf8')
        reçus.push(s)
        if (s.indexOf('HSET') !== -1) socket.write(':1\r\n')
      })
    })
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', () => resolve()))

    await tick(1600)   // > backoffDelayMs(0) = 1000ms (RECONNECT_BACKOFF_MS[0]), marge large
    const trame = reçus.join('')
    assert.ok(trame.indexOf('HSET') !== -1, `HSET attendu après rattrapage à la reconnexion — reçu : ${JSON.stringify(reçus)}`)
    assert.ok(trame.indexOf('tardif') !== -1)

    await adapter.flush()
    await new Promise<void>(resolve => server.close(() => resolve()))
  })
})

// --- SQL — faux query() espion (AUCUN pilote mysql2/pg vivant) --------------------------------

/** colonnes réellement demandées par un SELECT — un vrai pilote (mysql2/pg) renvoie des lignes dont
 *  les CLÉS sont les noms de colonnes. Les faux `query()` d'ici le reproduisent : sans ça, un SELECT
 *  qui demande une colonne et un `row.x` qui en lit une autre passeraient inaperçus (c'est
 *  exactement ce qui est arrivé au balayage anglais — colonne `donnees`, lecture `row.data`). */
function colonnesDuSelect(sql: string): string[] {
  return (/^SELECT\s+(.+?)\s+FROM/i.exec(sql)?.[1] ?? '').split(',').map(c => c.trim())
}

function fauxQuery(lignes: Array<Record<string, unknown>> = []): { query: (sql: string, params: unknown[]) => Promise<unknown>; appels: Array<{ sql: string; params: unknown[] }> } {
  const appels: Array<{ sql: string; params: unknown[] }> = []
  const query = async (sql: string, params: unknown[]) => {
    appels.push({ sql, params })
    if (/^SELECT/i.test(sql)) { const cols = colonnesDuSelect(sql); return lignes.map(l => Object.fromEntries(cols.map(c => [c, l[c]]))) }
    return { affectedRows: 1 }
  }
  return { query, appels }
}

describe('mjs-server/persist-sql — adaptateur SQL générique (faux query() espion, AUCUN pilote vivant)', () => {
  it("CREATE TABLE IF NOT EXISTS émis UNE SEULE fois, à la construction (même après plusieurs save/remove)", async () => {
    const { query, appels } = fauxQuery()
    const adapter = new SqlPersistAdapter({ query, table: 'parties_test' })
    adapter.save('p1', { id: 'p1' } as any)
    adapter.save('p2', { id: 'p2' } as any)
    adapter.remove('p1')
    await adapter.flush()

    const créations = appels.filter(a => /CREATE TABLE/i.test(a.sql))
    assert.equal(créations.length, 1, "CREATE TABLE ne doit apparaître qu'UNE seule fois")
    assert.ok(créations[0].sql.indexOf('parties_test') !== -1, 'doit viser la bonne table')
    assert.ok(créations[0].sql.indexOf('IF NOT EXISTS') !== -1)
  })

  it("save() dialecte '?' (MySQL) : INSERT … ON DUPLICATE KEY UPDATE, 3 placeholders positionnels", async () => {
    const { query, appels } = fauxQuery()
    const adapter = new SqlPersistAdapter({ query, dialect: '?' })
    adapter.save('p1', { id: 'p1', state: { n: 1 } } as any)
    await adapter.flush()

    const upsert = appels.find(a => /^INSERT/i.test(a.sql))
    assert.ok(upsert, 'un INSERT doit avoir été émis')
    assert.ok(/ON DUPLICATE KEY UPDATE/i.test(upsert!.sql), "dialecte '?' → clause MySQL")
    assert.ok(!/ON CONFLICT/i.test(upsert!.sql), "jamais la clause Postgres en '?'")
    assert.equal((upsert!.sql.match(/\?/g) || []).length, 3, '3 placeholders positionnels')
    assert.equal(upsert!.params[0], 'p1')
    assert.equal(JSON.parse(upsert!.params[1] as string).state.n, 1)
    assert.equal(typeof upsert!.params[2], 'number', 'updated_at = horodatage ms')
  })

  it("save() dialecte '$' (Postgres) : INSERT … ON CONFLICT (id) DO UPDATE, placeholders $1/$2/$3", async () => {
    const { query, appels } = fauxQuery()
    const adapter = new SqlPersistAdapter({ query, dialect: '$' })
    adapter.save('p1', { id: 'p1' } as any)
    await adapter.flush()

    const upsert = appels.find(a => /^INSERT/i.test(a.sql))
    assert.ok(upsert)
    assert.ok(/ON CONFLICT \(id\) DO UPDATE/i.test(upsert!.sql), "dialecte '$' → clause Postgres")
    assert.ok(!/ON DUPLICATE KEY/i.test(upsert!.sql), "jamais la clause MySQL en '$'")
    assert.ok(upsert!.sql.indexOf('$1') !== -1 && upsert!.sql.indexOf('$2') !== -1 && upsert!.sql.indexOf('$3') !== -1)
  })

  it('remove() : DELETE FROM <table> WHERE id = … (placeholder selon dialecte)', async () => {
    const { query, appels } = fauxQuery()
    const adapter = new SqlPersistAdapter({ query, dialect: '$' })
    adapter.remove('p9')
    await adapter.flush()

    const suppr = appels.find(a => /^DELETE/i.test(a.sql))
    assert.ok(suppr)
    assert.ok(suppr!.sql.indexOf('$1') !== -1)
    assert.deepEqual(suppr!.params, ['p9'])
  })

  it('load() : SELECT id, data → reconstruit les entrées {id, données} (JSON parsé)', async () => {
    const lignes = [
      { id: 'p1', data: JSON.stringify({ id: 'p1', state: { n: 1 } }) },
      { id: 'p2', data: JSON.stringify({ id: 'p2', state: { n: 2 } }) },
    ]
    const { query, appels } = fauxQuery(lignes)
    const adapter = new SqlPersistAdapter({ query })
    const brut = await adapter.load()

    assert.equal(brut.length, 2)
    assert.equal(brut[0].id, 'p1')
    assert.equal((brut[0].data as any).state.n, 1)
    assert.ok(appels.some(a => /^SELECT/i.test(a.sql) && a.sql.indexOf('data') !== -1))
  })

  it('cohérence du schéma : DDL, upsert et SELECT nomment les MÊMES colonnes (garde anti-dérive)', async () => {
    const { query, appels } = fauxQuery()
    const adapter = new SqlPersistAdapter({ query })
    adapter.save('p1', { id: 'p1' } as any)
    await adapter.flush()
    await adapter.load()

    const ddl    = appels.find(a => /CREATE TABLE/i.test(a.sql))!.sql
    const insert = appels.find(a => /^INSERT/i.test(a.sql))!.sql
    const select = appels.find(a => /^SELECT/i.test(a.sql))!.sql

    for (const col of ['id', 'data', 'updated_at']) assert.ok(new RegExp(`\\b${col}\\b`).test(ddl), `le DDL doit déclarer la colonne ${col}`)
    assert.deepEqual(/INSERT INTO \S+ \(([^)]+)\)/.exec(insert)![1].split(',').map(c => c.trim()), ['id', 'data', 'updated_at'], "l'upsert doit viser les colonnes du DDL")
    assert.deepEqual(colonnesDuSelect(select), ['id', 'data'], 'load() lit row.data — le SELECT doit demander CETTE colonne')
  })

  it('erreur de query() (save ET load) → warn, JAMAIS un throw ni une rejection non gérée', async () => {
    const warns: string[] = []
    const query = async (sql: string) => {
      if (/CREATE TABLE/i.test(sql)) return {}
      throw new Error('connexion perdue')
    }
    const adapter = new SqlPersistAdapter({ query, onLog: (level, message) => { if (level === 'warn') warns.push(message) } })

    assert.doesNotThrow(() => adapter.save('p1', { id: 'p1' } as any))
    await adapter.flush()
    const brut = await adapter.load()

    assert.deepEqual(brut, [], 'load() replie sur [] sans throw')
    assert.ok(warns.some(m => /save/.test(m)), "un warn doit signaler l'échec du save")
    assert.ok(warns.some(m => /load/.test(m)), "un warn doit signaler l'échec du load")
  })
})

// --- intégration légère — vraie app MJS-Server + MemoryTransport + SqlPersistAdapter -------------

describe('mjs-server/persist — intégration légère (SqlPersistAdapter + vraie app MJS-Server)', function () {
  this.timeout(8000)

  it('une partie jouée est sauvée (débounce → save() → upsert) puis restaurée par une NOUVELLE app sur le MÊME faux entrepôt SQL', async () => {
    // faux entrepôt indexé par NOM DE COLONNE (cf. colonnesDuSelect) — le SELECT est projeté comme
    // le ferait un vrai pilote, pas recopié à la main sur des clés supposées
    const table = new Map<string, Record<string, unknown>>()
    const query = async (sql: string, params: unknown[]): Promise<unknown> => {
      if (/CREATE TABLE/i.test(sql)) return {}
      if (/^INSERT/i.test(sql)) { table.set(params[0] as string, { data: params[1], updated_at: params[2] }); return {} }
      if (/^DELETE/i.test(sql)) { table.delete(params[0] as string); return {} }
      if (/^SELECT/i.test(sql)) { const cols = colonnesDuSelect(sql); return Array.from(table.entries()).map(([id, v]) => Object.fromEntries(cols.map(c => [c, c === 'id' ? id : v[c]]))) }
      return {}
    }

    const { transport, app } = creerApp({ persist: { adapter: new SqlPersistAdapter({ query }), debounce: 20 } })
    declarerJeu(app)
    await app.listen()
    const sA = connecter(transport, 'a'); sA.connect(); await tick()
    const repA = await sA.request('µgame:play', { type: 'duel', code: true })
    const sB = connecter(transport, 'b'); sB.connect(); await tick()
    await sB.request('µgame:play', { type: 'duel', code: repA.code })
    await sA.request('µgame:move', { game: repA.game, move: 'inc' })
    await app.stop()   // rafale finale — aucune attente du débounce nécessaire

    assert.equal(table.size, 1, 'la partie doit avoir été upsertée dans le faux entrepôt SQL')

    const { transport: t2, app: app2 } = creerApp({ persist: { adapter: new SqlPersistAdapter({ query }), debounce: 20 } })
    declarerJeu(app2)
    await app2.listen()   // restaure AVANT d'accepter la moindre connexion
    const sA2 = connecter(t2, 'a'); sA2.connect(); await tick()
    const resync = await sA2.request('µgame:resync', { game: repA.game })
    assert.equal(resync.view.n, 1)
    assert.equal(resync.phase, 'jeu')
    assert.equal(resync.turn, 'a')

    await app2.stop()
  })
})
