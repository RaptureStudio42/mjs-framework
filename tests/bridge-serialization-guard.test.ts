// les 4 endpoints de push du pont (broadcast/send/room-send/stream)
// répondaient `{ok:true}` même quand la livraison échouait à 100 % : une charge trop imbriquée
// (~170 000 niveaux, sous le plafond de 1 Mo du corps) fait lever JSON.stringify à l'ENVOI
// (core.ts::preEncodeFrame), avalé en silence — 0 trame livrée, réponse HTTP « ok » menteuse.
// Correctif : validation d'entrée (sérialisable + profondeur bornée à 64) AVANT tout envoi → 400
// catalogué ; échec d'encodage résiduel (accroche future core.ts) → 500.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))
const SECRET = 'secret-test-bridge'

// MÊME chaîne canonique DIRIGÉE + INJECTIVE que bridge.ts::canonicalString(direction='in'),
// réimplémentée en boîte noire (comme tests/mjs-ws-bridge.test.ts) — preuve indépendante.
function lp(field: string): string { return field.length +':'+ field }
function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  const canonical = fields.map(lp).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

interface LogLine { level: string; message: string; meta?: any }

// port ÉPHÉMÈRE (bridge: { port: 0 }) — MÊME convention que tests/mjs-ws-bridge.test.ts, sinon
// deux tests qui s'enchaînent se disputent le même port par défaut (wsPort+1) et EADDRINUSE
async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; bridgePort: number; logs: LogLine[] }> {
  const transport = new MemoryTransport()
  const logs: LogLine[] = []
  let bridgePort  = 0
  const app = mjsWs({
    transport, heartbeat: 0, ...opts,
    bridge: { port: 0, secret: SECRET, rateLimit: false, ...(opts.bridge as object ?? {}) },
    onLog: (level, message, meta) => {
      logs.push({ level, message, meta })
      if (meta && typeof (meta as any).port === 'number' && /pont universel en écoute/.test(message)) bridgePort = (meta as any).port
    },
  })
  await app.listen()
  return { transport, app, bridgePort, logs }
}

async function post(port: number, path: string, body: any): Promise<{ status: number; json: any }> {
  const bodyStr = JSON.stringify(body)
  const ts      = Math.floor(Date.now() / 1000)
  const sig     = sign(SECRET, 'POST', path, bodyStr, ts)
  const res  = await fetch('http://127.0.0.1:'+ port + path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
    body: bodyStr,
  })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
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

// charge imbriquée > MAX_PAYLOAD_DEPTH (64) — construite en boucle (jamais récursive côté TEST,
// aucun risque de pile ici non plus)
function nestedPayload(depth = 200): any {
  let v: any = 1
  for (let i = 0; i < depth; i++) v = { x: v }
  return v
}

describe('MJS-WS — bridge.ts, garde de sérialisation des 4 endpoints de push', () => {
  it('POST /broadcast — charge trop imbriquée → 400 catalogué, AUCUNE trame livrée (jamais 200 « ok » menteur)', async () => {
    const { transport, app, bridgePort } = await startApp()
    const { frames } = await rawClient(transport, 'ws://c1/')

    const { status, json } = await post(bridgePort, '/broadcast', { type: 'annonce', p: nestedPayload() })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
    assert.match(json.error, /non sérialisable|trop imbriqu/)

    await tick(30)
    assert.equal(frames.length, 1)   // seul µ:welcome — aucune trame en plus
    await app.stop()
  })

  it('POST /send — charge trop imbriquée → 400 catalogué', async () => {
    const { app, bridgePort } = await startApp()
    const { status, json } = await post(bridgePort, '/send', { type: 'x', client: 'nimporte', p: nestedPayload() })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
    await app.stop()
  })

  it('POST /room/send — charge trop imbriquée → 400 catalogué', async () => {
    const { app, bridgePort } = await startApp()
    const { status, json } = await post(bridgePort, '/room/send', { room: 'r1', type: 'x', p: nestedPayload() })
    assert.equal(status, 400)
    assert.equal(json.ok, false)
    await app.stop()
  })

  it('POST /stream (op add) — value trop imbriquée → 400 catalogué, le flux N\'EST JAMAIS empoisonné', async () => {
    const { transport, app, bridgePort } = await startApp()
    const { status, json } = await post(bridgePort, '/stream', { name: 'partie-x', op: 'add', id: 'poison', value: nestedPayload() })
    assert.equal(status, 400)
    assert.equal(json.ok, false)

    // un nouvel abonné reçoit un reset NORMAL (vide, rien n'a jamais été stocké) — jamais muet
    const { send, frames } = await rawClient(transport, 'ws://b/')
    send({ t: 'µ:sub-stream', p: { stream: 'partie-x' } })
    await tick(30)
    const parsed = frames.map(f => JSON.parse(f))
    const reset = parsed.find(f => f.t === 'partie-x' && f.p?.op === 'reset')
    assert.deepEqual(reset?.p?.values, {})
    await app.stop()
  })

  it('POST /stream (op update/reset) — charge trop imbriquée → 400 catalogué', async () => {
    const { app, bridgePort } = await startApp()
    await post(bridgePort, '/stream', { name: 'partie-y', op: 'add', id: 'e1', value: { n: 0 } })
    const upd = await post(bridgePort, '/stream', { name: 'partie-y', op: 'update', id: 'e1', value: nestedPayload() })
    assert.equal(upd.status, 400)
    const rst = await post(bridgePort, '/stream', { name: 'partie-y', op: 'reset', values: { e1: nestedPayload() } })
    assert.equal(rst.status, 400)
    await app.stop()
  })

  it('charge légitime (peu profonde) — livrée normalement, 200 ok:true', async () => {
    const { transport, app, bridgePort } = await startApp()
    const { frames } = await rawClient(transport, 'ws://normal/')

    const { status, json } = await post(bridgePort, '/broadcast', { type: 'annonce', p: { texte: 'coucou' } })
    assert.equal(status, 200)
    assert.equal(json.ok, true)

    await tick(30)
    assert.equal(frames.length, 2)   // welcome + annonce
    const last = JSON.parse(frames[1])
    assert.deepEqual(last, { t: 'annonce', p: { texte: 'coucou' } })
    await app.stop()
  })
})
