// `app.stream(name, { room })` exige une accroche `hasRoomMember`
// câblée par core.ts (cf. streams.ts::MjsWsStreamRoomMembership) : SANS elle, `createStreamsEngine`
// appelé à la main (tests/streams-access-control.test.ts) prouve le refus au démarrage.
// Ici : preuve que le câblage RÉEL (mjsWs()/core.ts, pas un appel direct à createStreamsEngine)
// fonctionne de bout en bout — plus d'erreur au démarrage, membre accepté, non-membre refusé.
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

// client BRUT (sans µ.socket) : parle le protocole à la main, garde les trames en CHAÎNES
async function rawClient(transport: MemoryTransport, url: string): Promise<{ frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

describe('MJS-WS — core.ts câble hasRoomMember à createStreamsEngine', () => {
  it('déclaration sans accroche : plus d\'erreur au démarrage (accroche câblée par core.ts)', async () => {
    const { app } = await startApp()
    assert.doesNotThrow(() => app.stream('salon-cable', { room: 'salon-cable' }))
    await app.stop()
  })

  it('membre du salon (µ:join) : µ:sub-stream → snapshot puis delta reçus', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('private', { room: 'vip' })
    flux.add('e1', { x: 1 })

    const membre = await rawClient(transport, 'ws://membre/')
    membre.send({ t: 'µ:join', p: { room: 'vip' } })
    await tick()
    membre.send({ t: 'µ:sub-stream', p: { stream: 'private' } })
    await tick(30)

    const reset = membre.frames.map(f => JSON.parse(f)).find(f => f.t === 'private' && f.p?.op === 'reset')
    assert.deepEqual(reset?.p?.values, { e1: { x: 1 } })

    membre.frames.length = 0
    flux.add('e2', { x: 2 })
    await tick()
    const delta = membre.frames.map(f => JSON.parse(f)).find(f => f.t === 'private')
    assert.equal(delta?.p?.op, 'add')
    assert.deepEqual(delta?.p?.value, { x: 2 })

    await app.stop()
  })

  it('non-membre du salon : µ:error seul, ni snapshot ni delta', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('private2', { room: 'vip2' })
    flux.add('e1', { x: 1 })

    const etranger = await rawClient(transport, 'ws://etranger/')
    etranger.send({ t: 'µ:sub-stream', p: { stream: 'private2' } })
    await tick(30)

    const parsed = etranger.frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'private2'), undefined)
    assert.equal(parsed.find(f => f.t === 'µ:error')?.p?.message, 'accès au flux refusé')

    await app.stop()
  })
})
