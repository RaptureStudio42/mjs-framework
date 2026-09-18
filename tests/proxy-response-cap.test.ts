// postSigned() (proxy.ts) lisait la réponse du back via res.text() SANS
// AUCUNE borne de taille, contrairement au corps ENTRANT du pont (bridge.ts::readBody, plafonné
// à 1 Mo). Un back configuré bogué/compromis (ou une redirection) pouvait faire
// bufferiser une réponse arbitrairement grosse en mémoire. Correctif : lecture EN FLUX
// (res.body.getReader()), plafonnée à 1 Mo (MÊME valeur que le pont) — dépassement = refus catalogué.
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function startServer(handler: (req: any, res: any) => void): Promise<{ port: number; close: () => Promise<void> }> {
  return new Promise((resolveStart) => {
    const server = createServer(handler)
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({ port: addr.port, close: () => new Promise<void>(r => server.close(() => r())) })
    })
  })
}

interface LogLine { level: string; message: string }

async function startApp(opts: MjsWsOptions, logs: LogLine[]): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts, onLog: (level, message) => logs.push({ level, message }) })
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

describe('MJS-WS — proxy.ts, plafond de la réponse du back', () => {
  it('réponse de 8 Mo (8x le plafond) — refusée, connexion NON acceptée sur cette base', async () => {
    const bourrage = 'a'.repeat(8 * 1024 * 1024)
    const back = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, identity: { bourrage } }))
    })

    const logs: LogLine[] = []
    const { transport } = await startApp({ auth: { url: 'http://127.0.0.1:'+ back.port +'/decide', secret: 's3-5' } }, logs)
    const { frames } = await rawClient(transport, 'ws://x/')
    await tick(500)

    const parsed = frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'µ:welcome'), undefined)
    assert.ok(logs.some(l => l.level === 'warn' && /volumineu/i.test(l.message)), 'un avertissement de taille attendu dans onLog')

    await back.close()
  })

  it('réponse normale (petite) — continue de fonctionner, µ:welcome reçu', async () => {
    const back = await startServer((req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, identity: { id: 7 } }))
    })

    const logs: LogLine[] = []
    const { transport } = await startApp({ auth: { url: 'http://127.0.0.1:'+ back.port +'/decide', secret: 's3-5b' } }, logs)
    const { frames } = await rawClient(transport, 'ws://y/')
    await tick(200)

    const parsed = frames.map(f => JSON.parse(f))
    assert.ok(parsed.find(f => f.t === 'µ:welcome'))

    await back.close()
  })
})
