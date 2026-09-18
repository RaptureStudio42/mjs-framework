// Tests du plafond de connexions — le noyau WS
// (src/mjs-ws/core.ts::acceptConnection) n'avait AUCUN plafond de connexions, ni global ni par IP :
// un client kické pouvait rouvrir un socket et repartir avec un TokenBucket neuf (celui-ci est créé
// PAR connexion, cf. guard.ts), contournant tout guard.ts et épuisant FD/mémoire. Ce fichier couvre
// les deux plafonds (limits.maxConnections/maxConnectionsPerIp, défauts null/100 — cf. index.ts
// DEFAULT_LIMITS), leur décrément SANS FUITE, et la non-régression MemoryTransport (adresse absente
// = jamais comptée/limitée par IP, cf. transport.ts MjsWsRemoteInfo.address).
//
// MemoryTransport où l'IP n'entre pas en jeu (plafond GLOBAL, décrément, non-régression) ; socket
// RÉEL (bibliothèque `ws`, MÊME technique que tests/mjs-ws-transport-ws.test.ts::connectReal) pour le
// plafond PAR IP, qui a besoin d'une VRAIE adresse (toutes les connexions ici partagent 127.0.0.1).
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { mjsWs, DEFAULT_LIMITS } from '../src/mjs-ws/index.js'
import { MemoryTransport, MemoryClientSocket } from '../src/mjs-ws/transport.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// plage dédiée à ce fichier — distincte de tests/hmr.test.ts (35000-39999), de la plage SMOKE RÉEL
// de mjs-ws-transport-uws.test.ts (40000-49999) et de tests/mjs-ws-transport-ws.test.ts (50000-54999) :
// évite toute collision inter-fichiers même si mocha les exécute dans le même process (--recursive, série).
function randomPort(): number { return 55000 + Math.floor(Math.random() * 5000) }

function connectReal(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

function closeReal(ws: WebSocket): Promise<void> {
  return new Promise((resolve) => { ws.once('close', () => resolve()); ws.close(1000, 'départ') })
}

// ============================================================================================

describe('MJS-WS — DEFAULT_LIMITS : nouveaux plafonds de connexions', () => {
  it('maxConnections=null (illimité, opt-in strict) ; maxConnectionsPerIp=100 (CHANGEMENT DE COMPORTEMENT assumé)', () => {
    assert.equal(DEFAULT_LIMITS.maxConnections, null)
    assert.equal(DEFAULT_LIMITS.maxConnectionsPerIp, 100)
  })
})

// ============================================================================================
// plafond PAR IP — socket RÉEL (WsTransport, loopback), toutes les connexions = 127.0.0.1
// ============================================================================================

describe('MJS-WS — plafond de connexions PAR IP (limits.maxConnectionsPerIp, socket RÉEL loopback)', function () {
  this.timeout(10000)

  it('la 3e connexion depuis la MÊME IP est refusée (code 1013) ; après fermeture d’une, une nouvelle passe', async () => {
    const port = randomPort()
    const app  = mjsWs({ transport: 'ws', port, host: '127.0.0.1', limits: { maxConnectionsPerIp: 2 }, onLog: () => {} })
    await app.listen()
    try {
      const c1 = await connectReal(port)
      const c2 = await connectReal(port)
      assert.equal(app.stats().connexions.refuseesPlafond, 0, 'les 2 premières connexions (plafond = 2) doivent passer sans refus')

      // 3e connexion depuis la MÊME IP (127.0.0.1) — doit être refusée AVANT le hello
      const c3 = new WebSocket(`ws://127.0.0.1:${port}/`)
      const c3Closed = new Promise<number>((resolve) => c3.once('close', (code: number) => resolve(code)))
      assert.equal(await c3Closed, 1013, 'la 3e connexion depuis la même IP doit être refusée (plafond par IP = 2, code 1013)')
      assert.equal(app.stats().connexions.refuseesPlafond, 1, 'compteur stats dédié incrémenté une fois')

      // libère un slot — la fermeture de c1 doit décrémenter le compteur par IP
      await closeReal(c1)
      await tick(250)   // laisse cleanupClient (côté serveur, onClose du transport) tourner

      const c4 = await connectReal(port)   // doit réussir : le plafond n'est plus atteint
      await closeReal(c2)
      await closeReal(c4)
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// plafond GLOBAL — MemoryTransport (IP absente, sans incidence sur ce plafond)
// ============================================================================================

describe('MJS-WS — plafond de connexions GLOBAL (limits.maxConnections, MemoryTransport)', () => {
  it('la 3e connexion (toutes IP confondues) est refusée (code 1013) ; après fermeture d’une, une nouvelle passe', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, limits: { maxConnections: 2 }, onLog: () => {} })
    await app.listen()
    try {
      const c1 = transport.connect({ url: 'memory://cap-global-1' })
      const c2 = transport.connect({ url: 'memory://cap-global-2' })
      await tick()
      assert.equal(c1.readyState, MemoryClientSocket.OPEN)
      assert.equal(c2.readyState, MemoryClientSocket.OPEN)
      assert.equal(app.stats().connexions.refuseesPlafond, 0)

      const c3 = transport.connect({ url: 'memory://cap-global-3' })
      const c3Closed = new Promise<{ code: number; reason: string }>((resolve) => { c3.onclose = (ev) => resolve(ev) })
      const ev = await c3Closed
      assert.equal(ev.code, 1013, 'la 3e connexion doit être refusée — plafond global = 2, code 1013')
      assert.equal(app.stats().connexions.refuseesPlafond, 1)

      // libère un slot
      const c1Closed = new Promise<void>((resolve) => { c1.onclose = () => resolve() })
      c1.close(1000, 'départ')
      await c1Closed
      await tick()

      const c4 = transport.connect({ url: 'memory://cap-global-4' })
      await tick()
      assert.equal(c4.readyState, MemoryClientSocket.OPEN, 'le plafond global libéré doit permettre une nouvelle connexion')

      c2.close(); c4.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// décrément SANS FUITE — le compteur revient bien à 0 après fermeture de TOUTES les connexions
// ============================================================================================

describe('MJS-WS — décrément SANS FUITE : le compteur revient à 0 après fermeture de TOUTES les connexions', () => {
  it('N connexions ouvertes puis TOUTES fermées → N nouvelles connexions repassent TOUTES (aucune fuite du compteur)', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, limits: { maxConnections: 3 }, onLog: () => {} })
    await app.listen()
    try {
      const round1 = [1, 2, 3].map(i => transport.connect({ url: `memory://cap-leak-${i}` }))
      await tick()
      for (const c of round1) assert.equal(c.readyState, MemoryClientSocket.OPEN)

      await Promise.all(round1.map(c => new Promise<void>((resolve) => { c.onclose = () => resolve(); c.close(1000, 'départ') })))
      await tick()

      // si le compteur avait fuité (ex. resté à 1 ou 2 au lieu de 0), au moins une de CES 3
      // connexions serait refusée — le test échouerait précisément sur celle-là
      const round2 = [4, 5, 6].map(i => transport.connect({ url: `memory://cap-leak-${i}` }))
      await tick()
      for (const c of round2) assert.equal(c.readyState, MemoryClientSocket.OPEN, 'le plafond doit être totalement libéré après fermeture de TOUTES les connexions précédentes — sinon fuite du compteur')

      for (const c of round2) c.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// non-régression — MemoryTransport (adresse ABSENTE) : jamais compté ni limité PAR IP
// ============================================================================================

describe('MJS-WS — non-régression : MemoryTransport (adresse absente) jamais limité PAR IP', () => {
  it('maxConnectionsPerIp très bas (1) + plusieurs connexions MemoryTransport → toutes admises (IP absente = jamais comptée)', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, limits: { maxConnectionsPerIp: 1 }, onLog: () => {} })
    await app.listen()
    try {
      const clients = [1, 2, 3, 4, 5].map(i => transport.connect({ url: `memory://cap-noregression-${i}` }))
      await tick()
      for (const c of clients) assert.equal(c.readyState, MemoryClientSocket.OPEN, "l'IP absente (MemoryTransport) ne doit jamais être comptée/limitée par IP")
      assert.equal(app.stats().connexions.refuseesPlafond, 0)

      for (const c of clients) c.close()
      await tick()
    } finally {
      await app.stop()
    }
  })

  it('opts.limits par défaut (aucune clé posée) → comportement historique intact, aucune connexion refusée', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, onLog: () => {} })   // aucun `limits` — DEFAULT_LIMITS pur
    await app.listen()
    try {
      const clients = [1, 2, 3].map(i => transport.connect({ url: `memory://cap-defaults-${i}` }))
      await tick()
      for (const c of clients) assert.equal(c.readyState, MemoryClientSocket.OPEN)
      assert.equal(app.stats().connexions.refuseesPlafond, 0)
      for (const c of clients) c.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})
