// garde anti-répétition (src/mjs-ws/core.ts) : une action de
// garde déjà DÉCIDÉE (kick ou expiration de jeton) ne doit plus jamais se rejouer avant que la
// fermeture PHYSIQUE (asynchrone) n'ait eu lieu. MÊME technique que tests/mjs-ws-core.test.ts
// (MemoryTransport, accès direct à app.clients pour espionner conn.close).
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// hello brut + attend le welcome (pas besoin du vrai
// client µ.socket ici, on espionne le transport bas niveau)
async function helloAndWelcome(transport: MemoryTransport, url: string, authPayload: any = {}): Promise<{ ws: any; frames: any[] }> {
  const ws = transport.connect({ url })
  const frames: any[] = []
  ws.onmessage = (ev: any) => frames.push(JSON.parse(ev.data as string))
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, auth: authPayload } }))
  await tick()
  assert.ok(frames.some(f => f.t === 'µ:welcome'), 'µ:welcome attendu')
  return { ws, frames }
}

describe('cœur MJS-WS : garde anti-répétition', () => {
  it('kickClient(engorgement) ne se redéclenche plus tant que la fermeture physique n\'a pas eu lieu', async () => {
    const { transport, app } = await startApp({ limits: { maxBuffered: 100 }, onLog: () => {} })   // le kick est INTENTIONNEL
    const { ws } = await helloAndWelcome(transport, 'memory://guard-engorgement')

    const client: any = Array.from(app.clients)[0]
    assert.ok(client, 'un client authentifié attendu')
    let closeCalls = 0
    const origClose = client.conn.close.bind(client.conn)
    client.conn.close = (code: number, reason: string) => { closeCalls++; return origClose(code, reason) }
    // simule un consommateur bloqué en PERMANENCE — la contre-pression est franchie à CHAQUE tour
    client.conn.bufferedAmount = 999999

    // 60 diffusions SYNCHRONES (aucun await) — la fermeture physique (MemoryTransport, différée
    // via queueMicrotask) n'a pas le temps de s'exécuter avant la fin de cette boucle
    for (let i = 0; i < 60; i++) app.broadcast('spam', { i })

    assert.equal(closeCalls, 1, 'une SEULE fermeture physique demandée malgré 60 diffusions synchrones')
    assert.equal(app.stats().garde.kicksEngorgement, 1, 'un SEUL kick compté (pas 10)')

    ws.close()
    await tick(20)   // laisse la fermeture async se terminer avant stop()
    await app.stop()
  })

  it('sweepExpiredTokens n\'expire plus (en boucle ni du tout) un client PARQUÉ en grâce de reprise', async () => {
    const { transport, app } = await startApp({
      resume: { grace: 5000 },                                   // grâce large — bien > plusieurs cycles de sweep
      token: { sweep: 50, slack: 20 },                            // sweep rapide pour observer plusieurs passages
      auth: () => ({ id: 'u1', exp: (Date.now() + 120) / 1000 }), // expire ~120ms après le hello
      onLog: () => {},
    })
    const { ws } = await helloAndWelcome(transport, 'memory://guard-sweep')

    // coupure réseau (pas de µ:bye) — le serveur doit parquer le client (resume actif)
    ws.close(1006, 'coupure simulée')
    await tick(30)
    assert.equal(app.stats().connexions.parquees, 1, 'le client doit être PARQUÉ (pas purgé) après la coupure')

    // largement plus que l'échéance du jeton (120ms) et plusieurs cycles de sweep (50ms), bien
    // moins que la grâce (5000ms) — AVANT le fix, sweepExpiredTokens re-« expirait » ce parqué à
    // CHAQUE cycle (state reste 'authenticated' pendant tout le parcage, cf. cleanupClient)
    await tick(400)

    assert.equal(app.stats().garde.expirationsJeton, 0, 'un PARQUÉ n\'a plus de connexion physique à expirer : jamais compté')

    await app.stop()
  })

  it('kickClient(debit) ne se redéclenche plus (même racine que kickClient(engorgement) ci-dessus, rafale de JSON invalide)', async () => {
    const { transport, app } = await startApp({ limits: { kickAfter: 2 }, onLog: () => {} })   // le kick est INTENTIONNEL
    const { ws } = await helloAndWelcome(transport, 'memory://guard-debit')

    const client: any = Array.from(app.clients)[0]
    let closeCalls = 0
    const origClose = client.conn.close.bind(client.conn)
    client.conn.close = (code: number, reason: string) => { closeCalls++; return origClose(code, reason) }

    // rafale de JSON invalide, bien au-delà de kickAfter (2) — chaque message passe par la FIFO
    // (client.chain), MÊME garde attendue que kickClient(engorgement) ci-dessus (racine kickClient commune)
    for (let i = 0; i < 20; i++) ws.send('{ceci n\'est pas du json')
    await tick(30)

    assert.equal(closeCalls, 1, 'une SEULE fermeture physique demandée malgré la rafale')
    assert.equal(app.stats().garde.kicksDebit, 1, 'un SEUL kick débit compté')

    await app.stop()
  })
})
