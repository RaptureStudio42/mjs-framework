// Tests du proxy de décisions (proxy.ts) — MÊME technique « boucle
// complète » que tests/mjs-ws-core.test.ts/mjs-ws-rooms-streams.test.ts (MemoryTransport + vrai
// client µ.socket) CROISÉE avec la technique « vrai serveur node:http qui vérifie la signature »
// de tests/mjs-ws-bridge.test.ts (le faux back DÉCIDE ici, au lieu de juste capter un webhook) :
// preuve en boîte noire que le POST signé émis par MJS-WS est conforme au format documenté
// (docs/23-mjs-ws.md), pas juste cohérent avec lui-même. `waitUntil` (pas un simple `tick()`) pour
// tout ce qui dépend du proxy : un VRAI aller-retour HTTP (même en loopback) prend plus d'un tick.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer, type IncomingMessage } from 'node:http'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { resolveProxyOptions } from '../src/mjs-ws/proxy.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil : délai dépassé — condition jamais vraie')
    await tick(10)
  }
}

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

// Même chose, mais la requête d'upgrade porte des en-têtes (cookie…) — MemoryTransport.connect les
// recopie tels quels dans remoteInfo.headers, exactement comme transport-uws (req.forEach) et
// transport-ws (req.headers) le font d'une VRAIE requête. Sert aux tests « cookie transmis au back ».
function makeClientAvecEntetes(transport: MemoryTransport, headers: Record<string, string | string[] | undefined>): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols, headers }) }
  return makeMu()
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

const SECRET = 'secret-proxy-test-1234567890'

// --- faux serveur node:http qui DÉCIDE (accepte/refuse/hang) et vérifie la signature reçue -----
// `sign` (durcissement verifyResponse) — optionnel : quand présent, la RÉPONSE est à son tour
// signée (x-mjs-ws-timestamp/x-mjs-ws-signature, canonicalString avec 'RESPONSE'), via createHmac
// BRUT — MÊME technique que la vérification de la requête ci-dessous (jamais une primitive de
// production importée : preuve boîte noire, comme le reste du fichier). Absent = réponse NON
// signée, EXACTEMENT le comportement d'avant (non-régression des 12 tests existants).
interface DecisionReq { event: string; body: any; rawBody: string; path: string; headers: IncomingMessage['headers'] }
type DecisionOutcome = { status: number; json?: any; sign?: { secret?: string; ts?: number } } | 'hang'

function startDecisionServer(secret: string, decide: (req: DecisionReq) => DecisionOutcome): Promise<{ url: string; received: DecisionReq[]; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const received: DecisionReq[] = []
    const server = createServer((httpReq, res) => {
      const chunks: Buffer[] = []
      httpReq.on('data', (c: Buffer) => chunks.push(c))
      httpReq.on('end', () => {
        const rawBody   = Buffer.concat(chunks).toString('utf8')
        const ts        = httpReq.headers['x-mjs-ws-timestamp'] as string
        const sig       = httpReq.headers['x-mjs-ws-signature'] as string
        const canonical = ts +'.POST.'+ httpReq.url +'.'+ rawBody
        const expected  = createHmac('sha256', secret).update(canonical).digest('hex')
        if (!sig || expected !== sig) { res.writeHead(401); res.end('signature invalide'); return }
        const parsed = JSON.parse(rawBody)
        const entry: DecisionReq = { event: parsed.event, body: parsed, rawBody, path: httpReq.url || '/', headers: httpReq.headers }
        received.push(entry)
        const outcome = decide(entry)
        if (outcome === 'hang') return   // ne répond JAMAIS — exerce le timeout côté proxy
        const bodyOut     = outcome.json !== undefined ? JSON.stringify(outcome.json) : ''
        const headersOut: Record<string, string> = { 'content-type': 'application/json' }
        if (outcome.sign) {
          const signTs        = outcome.sign.ts ?? Math.floor(Date.now() / 1000)
          const signSecret    = outcome.sign.secret ?? secret
          const canonicalResp = signTs +'.RESPONSE.'+ httpReq.url +'.'+ bodyOut
          headersOut['x-mjs-ws-timestamp'] = String(signTs)
          headersOut['x-mjs-ws-signature'] = createHmac('sha256', signSecret).update(canonicalResp).digest('hex')
        }
        res.writeHead(outcome.status, headersOut)
        res.end(bodyOut)
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({
        url: `http://127.0.0.1:${addr.port}/decide`, received,
        close: () => { server.closeAllConnections(); return new Promise<void>(r => server.close(() => r())) },
      })
    })
  })
}

describe('MJS-WS — proxy de décisions (proxy.ts)', () => {
  it('1. connect autorisé via proxy auth → identity posée, µ:welcome', async () => {
    const server = await startDecisionServer(SECRET, (req) => {
      const token = req.body.hello?.auth?.token
      return { status: 200, json: token === 'bon-jeton' ? { ok: true, identity: { id: 'u1', pseudo: 'Zora' } } : { ok: false } }
    })
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p1', { auth: { token: 'bon-jeton' } })
    s.connect()
    await waitUntil(() => s.state === 'open')
    const c = Array.from(app.clients)[0] as any
    assert.deepEqual(c.identity, { id: 'u1', pseudo: 'Zora' })
    s.destroy(); await app.stop(); await server.close()
  })

  it('2. connect refusé via proxy auth → µ:denied avec la raison du back', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: false, raison: 'compte banni' } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p2', { auth: { token: 'x' }, reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await waitUntil(() => s.state === 'closed')
    assert.ok(s.lastError && /banni/.test(s.lastError.message))
    s.destroy(); await app.stop(); await server.close()
  })

  it('3. join autorisé via proxy rooms.join → membre du salon', async () => {
    const server = await startDecisionServer(SECRET, (req) => ({ status: 200, json: { ok: req.body.room === 'zone' } }))
    const { transport, app } = await startApp({ rooms: { join: { url: server.url, secret: SECRET } } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p3')
    s.connect()
    await waitUntil(() => s.state === 'open')
    s.room('zone')
    await waitUntil(() => app.room('zone').size > 0)
    assert.equal(app.room('zone').size, 1)
    s.destroy(); await app.stop(); await server.close()
  })

  it('4. join refusé via proxy rooms.join → pas membre, µ:error', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: false } }))
    const { transport, app } = await startApp({ rooms: { join: { url: server.url, secret: SECRET } } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p4')
    s.connect()
    await waitUntil(() => s.state === 'open')
    s.room('prive')
    await waitUntil(() => s.lastError != null)
    assert.equal(app.room('prive').size, 0)
    assert.ok(s.lastError && /refus/i.test(s.lastError.message))
    s.destroy(); await app.stop(); await server.close()
  })

  it('5. timeout auth (le back ne répond jamais) → décision de refus, jamais bloquant', async () => {
    const server = await startDecisionServer(SECRET, () => 'hang')
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, timeout: 150 }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p5', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await waitUntil(() => s.state === 'closed')
    assert.ok(s.lastError)
    s.destroy(); await app.stop(); await server.close()
  })

  it('6. timeout join (le back ne répond jamais) → décision de refus, jamais bloquant', async () => {
    const server = await startDecisionServer(SECRET, () => 'hang')
    const { transport, app } = await startApp({ rooms: { join: { url: server.url, secret: SECRET, timeout: 150 } }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p6')
    s.connect()
    await waitUntil(() => s.state === 'open')
    s.room('zone')
    await waitUntil(() => s.lastError != null)
    assert.equal(app.room('zone').size, 0)
    s.destroy(); await app.stop(); await server.close()
  })

  it('7. le POST reçu est bien SIGNÉ — HMAC recalculé indépendamment (node:crypto brut)', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: {} } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p7', { auth: { token: 'peu-importe' } })
    s.connect()
    await waitUntil(() => s.state === 'open')
    assert.equal(server.received.length, 1)
    const req = server.received[0]
    const ts  = req.headers['x-mjs-ws-timestamp'] as string
    const sig = req.headers['x-mjs-ws-signature'] as string
    const canonical = ts +'.POST.'+ req.path +'.'+ req.rawBody
    assert.equal(sig, createHmac('sha256', SECRET).update(canonical).digest('hex'))
    s.destroy(); await app.stop(); await server.close()
  })

  it('8. cache actif : 2 connects identiques rapprochés → 1 seul POST', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u8' } } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, cache: { ttl: 5000 } } })
    const µA = makeClient(transport); const sA = µA.socket('memory://p8a', { auth: { token: 'meme-jeton' } })
    sA.connect(); await waitUntil(() => sA.state === 'open')
    const µB = makeClient(transport); const sB = µB.socket('memory://p8b', { auth: { token: 'meme-jeton' } })
    sB.connect(); await waitUntil(() => sB.state === 'open')
    assert.equal(server.received.length, 1)   // 2e connect servi depuis le cache, jamais reposté
    sA.destroy(); sB.destroy(); await app.stop(); await server.close()
  })

  it('9. cache ABSENT par défaut : 2 connects identiques → 2 POST (opt-in, jamais un comportement caché)', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: {} } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µA = makeClient(transport); const sA = µA.socket('memory://p9a', { auth: { token: 'meme-jeton' } })
    sA.connect(); await waitUntil(() => sA.state === 'open')
    const µB = makeClient(transport); const sB = µB.socket('memory://p9b', { auth: { token: 'meme-jeton' } })
    sB.connect(); await waitUntil(() => sB.state === 'open')
    assert.equal(server.received.length, 2)
    sA.destroy(); sB.destroy(); await app.stop(); await server.close()
  })

  it('10. forme FONCTION classique pour auth — non-régression, zéro appel HTTP', async () => {
    const { transport, app } = await startApp({ auth: (hello: any) => hello.auth?.token === 'x' ? { id: 'u10' } : false })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p10', { auth: { token: 'x' } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    s.destroy(); await app.stop()
  })

  it('11. forme FONCTION classique pour rooms.join — non-régression, zéro appel HTTP', async () => {
    const { transport, app } = await startApp({ rooms: { join: () => true } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p11')
    s.connect(); await tick()
    s.room('zone'); await tick()
    assert.equal(app.room('zone').size, 1)
    s.destroy(); await app.stop()
  })

  it("12. secret 'env:VAR' résolu — connect réussit avec le secret lu depuis process.env", async () => {
    process.env.MJS_WS_PROXY_TEST_SECRET = SECRET
    try {
      const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u12' } } }))
      const { transport, app } = await startApp({ auth: { url: server.url, secret: 'env:MJS_WS_PROXY_TEST_SECRET' } })
      const µ = makeClient(transport)
      const s = µ.socket('memory://p12')
      s.connect()
      await waitUntil(() => s.state === 'open')
      s.destroy(); await app.stop(); await server.close()
    } finally {
      delete process.env.MJS_WS_PROXY_TEST_SECRET
    }
  })

  it('13. verifyResponse:true + réponse correctement signée par le back → acceptée', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u13' } }, sign: { secret: SECRET } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, verifyResponse: true } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p13', { auth: { token: 'peu-importe' } })
    s.connect()
    await waitUntil(() => s.state === 'open')
    const c = Array.from(app.clients)[0] as any
    assert.deepEqual(c.identity, { id: 'u13' })
    s.destroy(); await app.stop(); await server.close()
  })

  it("14. verifyResponse:true + réponse NON signée par le back → refus (onLog('warn') observable)", async () => {
    const warnings: string[] = []
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u14' } } }))   // pas de `sign` — réponse NON signée
    const { transport, app } = await startApp({
      auth:  { url: server.url, secret: SECRET, verifyResponse: true },
      onLog: (level: string, message: string) => { if (level === 'warn') warnings.push(message) },
    })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p14', { auth: { token: 'peu-importe' }, reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await waitUntil(() => s.state === 'closed')
    assert.ok(warnings.some(m => /non sign/.test(m)), `attendu un avertissement 'non signée', reçu : ${JSON.stringify(warnings)}`)
    s.destroy(); await app.stop(); await server.close()
  })

  it('15. verifyResponse:true + timestamp de réponse hors fenêtre ± 300 s (rejeu suspect) → refus', async () => {
    const server = await startDecisionServer(SECRET, () => ({
      status: 200, json: { ok: true, identity: { id: 'u15' } },
      sign:   { secret: SECRET, ts: Math.floor(Date.now() / 1000) - 3600 },   // 1h dans le passé — largement hors fenêtre
    }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, verifyResponse: true }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p15', { auth: { token: 'x' }, reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await waitUntil(() => s.state === 'closed')
    assert.ok(s.lastError)
    s.destroy(); await app.stop(); await server.close()
  })

  it('16. verifyResponse:true + réponse signée avec un MAUVAIS secret → refus', async () => {
    const server = await startDecisionServer(SECRET, () => ({
      status: 200, json: { ok: true, identity: { id: 'u16' } },
      sign:   { secret: 'un-tout-autre-secret' },
    }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, verifyResponse: true }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://p16', { auth: { token: 'x' }, reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    await waitUntil(() => s.state === 'closed')
    assert.ok(s.lastError)
    s.destroy(); await app.stop(); await server.close()
  })

  it('17. verifyResponse ABSENT (défaut) + réponse non signée → acceptée, non-régression', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u17' } } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })   // pas de verifyResponse
    const µ = makeClient(transport)
    const s = µ.socket('memory://p17', { auth: { token: 'peu-importe' } })
    s.connect()
    await waitUntil(() => s.state === 'open')
    const c = Array.from(app.clients)[0] as any
    assert.deepEqual(c.identity, { id: 'u17' })
    s.destroy(); await app.stop(); await server.close()
  })

  // --- le cookie de la requête d'upgrade (patron docs §7.12 × proxy §7.11) -------------------
  // Avant : `creerAuthProxy` recevait `meta` puis le JETAIT — le patron « mjsWs rejoue le cookie »
  // ne pouvait donc PAS passer par le proxy, et devait réécrire signature + délai + cache à la main.

  it("18. le cookie de la requête d'upgrade part dans le POST connect", async () => {
    const server = await startDecisionServer(SECRET, (req) => ({
      status: 200, json: req.body.cookie === 'session=abc; autre=1' ? { ok: true, identity: { id: 'u18' } } : { ok: false, raison: 'cookie absent du POST' },
    }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µ = makeClientAvecEntetes(transport, { cookie: 'session=abc; autre=1' })
    const s = µ.socket('memory://p18')
    s.connect()
    await waitUntil(() => s.state === 'open')
    assert.equal(server.received.length, 1)
    assert.equal(server.received[0].body.cookie, 'session=abc; autre=1')
    assert.deepEqual((Array.from(app.clients)[0] as any).identity, { id: 'u18' })
    s.destroy(); await app.stop(); await server.close()
  })

  it('19. aucun cookie → corps STRICTEMENT identique à l\'historique (clé absente, pas une chaîne vide)', async () => {
    const server = await startDecisionServer(SECRET, () => ({ status: 200, json: { ok: true, identity: { id: 'u19' } } }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET } })
    const µ = makeClient(transport)                       // aucun en-tête sur l'upgrade
    const s = µ.socket('memory://p19', { auth: { token: 'x' } })
    s.connect()
    await waitUntil(() => s.state === 'open')
    assert.deepEqual(Object.keys(server.received[0].body).sort(), [ 'event', 'hello' ])
    s.destroy(); await app.stop(); await server.close()
  })

  it('20. cache actif — le cookie entre dans la clé : deux visiteurs = deux décisions, jamais une identité pour l\'autre', async () => {
    const server = await startDecisionServer(SECRET, (req) => ({
      status: 200, json: { ok: true, identity: { id: req.body.cookie === 'session=zora' ? 'zora' : 'kaeli' } },
    }))
    const { transport, app } = await startApp({ auth: { url: server.url, secret: SECRET, cache: { ttl: 5000 } } })

    const µ1 = makeClientAvecEntetes(transport, { cookie: 'session=zora' })
    const s1 = µ1.socket('memory://p20a')
    s1.connect()
    await waitUntil(() => s1.state === 'open')

    const µ2 = makeClientAvecEntetes(transport, { cookie: 'session=kaeli' })
    const s2 = µ2.socket('memory://p20b')
    s2.connect()
    await waitUntil(() => s2.state === 'open')

    const identites = Array.from(app.clients).map((c: any) => c.identity.id).sort()
    assert.deepEqual(identites, [ 'kaeli', 'zora' ], 'un cache indexé sur le seul `hello` aurait servi la MÊME identité aux deux')
    assert.equal(server.received.length, 2, 'deux cookies distincts = deux appels au back')
    s1.destroy(); s2.destroy(); await app.stop(); await server.close()
  })
})

// Garde TLS — la RÉPONSE du proxy AUTHENTIFIE l'utilisateur (§1-2 ci-dessus) ou
// décide d'un accès de salon (§3-4) : en http:// non-loopback, un MITM peut forger cette réponse.
// resolveProxyOptions refuse donc http:// hors loopback, sauf allowInsecure:true. #1-6 exercent le
// helper DIRECTEMENT (couverture précise des 4 formes loopback) ; #7-8 prouvent le câblage réel au
// boot via mjsWs() (auth ET rooms.join), AVANT tout .listen() — cf. proxy.ts::estLoopback.
describe('MJS-WS — garde TLS du proxy de décisions (resolveProxyOptions)', () => {
  it("1. http:// non-loopback → throw, message clair MITM", () => {
    assert.throws(
      () => resolveProxyOptions({ url: 'http://back.example.com/decide', secret: SECRET }),
      /http:\/\/ non-loopback/,
    )
  })

  it('2. http://127.0.0.1:x → OK (loopback IPv4)', () => {
    assert.doesNotThrow(() => resolveProxyOptions({ url: 'http://127.0.0.1:4000/decide', secret: SECRET }))
  })

  it("3. http://localhost:x → OK (loopback, alias 'localhost')", () => {
    assert.doesNotThrow(() => resolveProxyOptions({ url: 'http://localhost:4000/decide', secret: SECRET }))
  })

  it('4. http://[::1]:x → OK (loopback IPv6 entre crochets)', () => {
    assert.doesNotThrow(() => resolveProxyOptions({ url: 'http://[::1]:4000/decide', secret: SECRET }))
  })

  it('5. https://back non-loopback → OK (TLS, garde non applicable)', () => {
    assert.doesNotThrow(() => resolveProxyOptions({ url: 'https://back.example.com/decide', secret: SECRET }))
  })

  it('6. http:// non-loopback + allowInsecure:true → OK (échappatoire explicite)', () => {
    assert.doesNotThrow(() => resolveProxyOptions({ url: 'http://back.example.com/decide', secret: SECRET, allowInsecure: true }))
  })

  it('7. câblage réel — mjsWs({ auth: {url: http:// non-loopback} }) throw AU BOOT, avant .listen()', () => {
    assert.throws(
      () => mjsWs({ transport: new MemoryTransport(), auth: { url: 'http://back.example.com/decide', secret: SECRET } }),
      /http:\/\/ non-loopback/,
    )
  })

  it('8. câblage réel — mjsWs({ rooms: { join: {url: http:// non-loopback} } }) throw AU BOOT, avant .listen()', () => {
    assert.throws(
      () => mjsWs({ transport: new MemoryTransport(), rooms: { join: { url: 'http://back.example.com/decide', secret: SECRET } } }),
      /http:\/\/ non-loopback/,
    )
  })
})
