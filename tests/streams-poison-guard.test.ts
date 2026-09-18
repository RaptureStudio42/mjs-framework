// une seule entrée trop imbriquée (JSON.stringify lève un RangeError,
// pile V8 dépassée) empoisonnait st.values de façon PERMANENTE : snapshotOf() la retraverse à
// CHAQUE futur µ:sub-stream/µ:resync (même d'un client jamais connecté avant l'incident), qui
// échoue donc en silence pour TOUJOURS. Correctif : add/update/reset refusent (throw catalogué)
// une entrée non sérialisable/trop profonde, JAMAIS stockée.
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

async function rawClient(transport: MemoryTransport, url: string): Promise<{ frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

// valeur imbriquée SUFFISAMMENT profonde pour dépasser MAX_VALUE_DEPTH (64) — pas besoin des
// ~170 000 niveaux pour prouver la garde (celle-ci coupe la récursion à la
// profondeur limite, coût constant, aucun besoin de reproduire une telle ampleur ici)
function poisonValue(depth = 200): unknown {
  let v: unknown = 1
  for (let i = 0; i < depth; i++) v = { x: v }
  return v
}

describe('MJS-WS — streams.ts, garde de profondeur/sérialisation', () => {
  it('add() refuse une valeur trop imbriquée (throw catalogué), jamais stockée', async () => {
    const { app } = await startApp()
    const flux = app.stream('etat-partie')
    flux.add('sain', { score: 10 })

    assert.throws(() => flux.add('empoisonnee', poisonValue()), /non sérialisable|trop imbriquée/)
    assert.equal(flux.size, 1)
    assert.deepEqual(flux.snapshot(), { sain: { score: 10 } })

    await app.stop()
  })

  it('update()/reset() refusent aussi — l\'état n\'est PAS muté par une tentative refusée', async () => {
    const { app } = await startApp()
    const flux = app.stream('f2')
    flux.add('e1', { n: 0 })

    assert.throws(() => flux.update('e1', { deep: poisonValue() }))
    assert.throws(() => flux.reset({ e1: poisonValue() }))
    assert.deepEqual(flux.snapshot(), { e1: { n: 0 } })

    await app.stop()
  })

  it('un flux JAMAIS empoisonné reste consultable pour un NOUVEL abonné (AVANT le fix : restait MUET)', async () => {
    const { transport, app } = await startApp()
    const flux = app.stream('etat-partie-2')
    flux.add('sain', { score: 10 })
    try { flux.add('empoisonnee', poisonValue()) } catch { /* refusé — attendu */ }

    // client B, jamais connecté avant la tentative d'empoisonnement
    const { send, frames } = await rawClient(transport, 'ws://b/')
    send({ t: 'µ:sub-stream', p: { stream: 'etat-partie-2' } })
    await tick(30)

    const parsed = frames.map(f => JSON.parse(f))
    const reset = parsed.find(f => f.t === 'etat-partie-2' && f.p?.op === 'reset')
    assert.deepEqual(reset?.p?.values, { sain: { score: 10 } })

    await app.stop()
  })

  it('une valeur légitime (peu profonde, quelconque) reste acceptée sans erreur', async () => {
    const { app } = await startApp()
    const flux = app.stream('f3')
    assert.doesNotThrow(() => flux.add('e1', { x: 10, y: 20, meta: { owner: 'a', tags: ['x', 'y'] } }))
    assert.deepEqual(flux.snapshot(), { e1: { x: 10, y: 20, meta: { owner: 'a', tags: ['x', 'y'] } } })
    await app.stop()
  })
})
