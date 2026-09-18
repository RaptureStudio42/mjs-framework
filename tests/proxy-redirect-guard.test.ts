// postSigned() (proxy.ts) suivait une redirection HTTP 3xx (fetch,
// redirect:'follow' implicite) : si le back CONFIGURÉ (déjà admis par la garde TLS/loopback,
// resolveProxyOptions) répond une redirection, la requête signée part vers une destination
// JAMAIS soumise à cette garde. Correctif : redirect:'manual' — tout 3xx est désormais traité
// comme un refus (res.ok déjà false), MÊME chemin que le refus « statut non-2xx » existant.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function waitUntil(pred: () => boolean, timeoutMs = 1500): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil : délai dépassé — condition jamais vraie')
    await tick(10)
  }
}

function startServer(handler: (req: any, res: any) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

async function rawClient(transport: MemoryTransport, url: string): Promise<{ frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

describe('MJS-WS — proxy.ts, redirection NON suivie', () => {
  it('auth proxy — 307 vers un back JAMAIS configuré : refusé, B ne reçoit jamais la requête signée', async () => {
    let finalHit = false
    const b = await startServer((req, res) => {
      finalHit = true
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, identity: { via: 'redirige-vers-B' } }))
    })
    let redirectHit = false
    const a = await startServer((req, res) => {
      redirectHit = true
      res.writeHead(307, { location: 'http://127.0.0.1:'+ b.port +'/ailleurs' })
      res.end()
    })

    const { transport } = await startApp({ auth: { url: 'http://127.0.0.1:'+ a.port +'/decide', secret: 's3-4' } })
    const { frames } = await rawClient(transport, 'ws://x/')
    await tick(200)

    assert.equal(redirectHit, true)    // A (configuré) bien contacté
    assert.equal(finalHit, false)      // B (redirection) JAMAIS contacté
    const parsed = frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'µ:welcome'), undefined)   // connexion refusée

    await a.close(); await b.close()
  })

  it('join proxy — MÊME refus sur une redirection (postSigned partagé)', async () => {
    let finalHit = false
    const b = await startServer((req, res) => {
      finalHit = true
      res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ ok: true }))
    })
    const a = await startServer((req, res) => {
      res.writeHead(302, { location: 'http://127.0.0.1:'+ b.port +'/ailleurs' }); res.end()
    })

    const { transport } = await startApp({ rooms: { join: { url: 'http://127.0.0.1:'+ a.port +'/decide', secret: 's3-4b' } } })
    const { send, frames } = await rawClient(transport, 'ws://y/')
    await tick(50)
    send({ t: 'µ:join', p: { room: 'salon' } })
    await waitUntil(() => frames.some(f => JSON.parse(f).t === 'µ:joined' || JSON.parse(f).t === 'µ:error'))

    assert.equal(finalHit, false)
    const parsed = frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'µ:joined'), undefined)

    await a.close(); await b.close()
  })
})
