// app.stream() n'avait AUCUNE garde d'accès : un client jamais membre
// d'un salon (rooms.join refusant tout) recevait quand même le snapshot complet ET tous les
// deltas futurs d'un flux en devinant son nom. Correctif : option `canSubscribe` (sync/async,
// MIROIR de rooms.ts::opts.join) + sucre `room` (nécessite l'accroche `hasRoomMember`, câblée
// par core.ts — absente ici par construction : `stream()` refuse alors
// de démarrer plutôt que de laisser `room` silencieusement inactif).
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { createStreamsEngine } from '../src/mjs-ws/streams.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsClient } from '../src/mjs-ws/core.js'

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

function fakeClient(id: string): MjsWsClient {
  return { id, identity: null, latency: null, meta: {} as any, send() {}, close() {} }
}

describe('MJS-WS — streams.ts, garde d\'accès', () => {
  it('canSubscribe ferme l\'exploit d\'origine — rooms.join refuse tout, attaquant jamais membre, µ:sub-stream direct', async () => {
    const { transport, app } = await startApp({ rooms: { join: async () => false } })
    const flux = app.stream('partie-42', { canSubscribe: (client) => app.room('partie-42').has(client) })
    flux.add('main', { cartesJoueur: ['As de pique'], solde: 4200 })
    await tick()

    const { send, frames } = await rawClient(transport, 'ws://attaquant/')
    send({ t: 'µ:sub-stream', p: { stream: 'partie-42' } })
    await tick(30)

    const parsed = frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'partie-42'), undefined)   // aucune fuite — ni reset ni delta
    const err = parsed.find(f => f.t === 'µ:error')
    assert.equal(err?.p?.message, 'accès au flux refusé')

    await app.stop()
  })

  it('canSubscribe accepte (async) : flux normal (reset + delta)', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('y', { canSubscribe: async (_client) => true })
    flux.add('e1', { x: 1 })
    await tick()

    const { send, frames } = await rawClient(transport, 'ws://membre/')
    send({ t: 'µ:sub-stream', p: { stream: 'y' } })
    await tick(30)

    const parsed = frames.map(f => JSON.parse(f))
    const reset = parsed.find(f => f.t === 'y' && f.p?.op === 'reset')
    assert.deepEqual(reset?.p?.values, { e1: { x: 1 } })

    await app.stop()
  })

  it('canSubscribe refuse (sync) : µ:resync aussi bloqué, aucun rejeu', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('z', { canSubscribe: () => false })
    flux.add('e1', { x: 1 })
    await tick()

    const { send, frames } = await rawClient(transport, 'ws://refuse/')
    send({ t: 'µ:resync', p: { stream: 'z', from: 0 } })
    await tick(30)

    const parsed = frames.map(f => JSON.parse(f))
    assert.equal(parsed.find(f => f.t === 'z'), undefined)
    assert.equal(parsed.find(f => f.t === 'µ:error')?.p?.message, 'accès au flux refusé')

    await app.stop()
  })

  it('sans canSubscribe/room : comportement HISTORIQUE inchangé (flux public)', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('public')
    flux.add('e1', { x: 1 })
    await tick()

    const { send, frames } = await rawClient(transport, 'ws://nimporte-qui/')
    send({ t: 'µ:sub-stream', p: { stream: 'public' } })
    await tick(30)

    const parsed = frames.map(f => JSON.parse(f))
    const reset = parsed.find(f => f.t === 'public' && f.p?.op === 'reset')
    assert.deepEqual(reset?.p?.values, { e1: { x: 1 } })

    await app.stop()
  })

  it('room via app.stream() : l\'accroche hasRoomMember est câblée par core.ts, la déclaration démarre sans erreur', async () => {
    const { app } = await startApp()
    assert.doesNotThrow(() => app.stream('salon-prive', { room: 'salon-prive' }))
    await app.stop()
  })

  it('room avec accroche câblée (createStreamsEngine direct) : membre accepté, non-membre refusé', async () => {
    const sent: Array<{ id: string; frame: any }> = []
    const rawSend = (client: MjsWsClient, frame: Record<string, unknown>) => sent.push({ id: client.id, frame })
    const membres = new Set(['membre-A'])
    const hasRoomMember = (client: MjsWsClient, room: string) => room === 'salle-1' && membres.has(client.id)

    const engine = createStreamsEngine(rawSend, () => {}, undefined, undefined, undefined, hasRoomMember)
    const flux = engine.stream('salle-1', { room: 'salle-1' })
    flux.add('k', 'v')

    const membre    = fakeClient('membre-A')
    const nonMembre = fakeClient('etranger-B')

    engine.handleSubStream(membre, 'salle-1')
    engine.handleSubStream(nonMembre, 'salle-1')

    const framesMembre    = sent.filter(s => s.id === 'membre-A').map(s => s.frame)
    const framesNonMembre = sent.filter(s => s.id === 'etranger-B').map(s => s.frame)
    assert.deepEqual(framesMembre.find(f => f.t === 'salle-1')?.p?.values, { k: 'v' })
    assert.equal(framesNonMembre.find(f => f.t === 'salle-1'), undefined)
    assert.equal(framesNonMembre.find(f => f.t === 'µ:error')?.p?.message, 'accès au flux refusé')
  })

  it('room + canSubscribe combinés : ET logique — membre du salon MAIS canSubscribe refuse → refus', async () => {
    const sent: Array<{ id: string; frame: any }> = []
    const rawSend = (client: MjsWsClient, frame: Record<string, unknown>) => sent.push({ id: client.id, frame })
    const hasRoomMember = () => true   // toujours membre, ne doit PAS suffire seul

    const engine = createStreamsEngine(rawSend, () => {}, undefined, undefined, undefined, hasRoomMember)
    const flux = engine.stream('combi', { room: 'x', canSubscribe: () => false })
    flux.add('k', 'v')

    const client = fakeClient('c1')
    engine.handleSubStream(client, 'combi')

    const frames = sent.filter(s => s.id === 'c1').map(s => s.frame)
    assert.equal(frames.find(f => f.t === 'combi'), undefined)
    assert.equal(frames.find(f => f.t === 'µ:error')?.p?.message, 'accès au flux refusé')
  })
})
