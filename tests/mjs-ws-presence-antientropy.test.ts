// tests/mjs-ws-presence-antientropy.test.ts — anti-entropie de présence (rooms.ts
// attachPresenceAntiEntropy/adapter.ts) : réconciliation périodique de la vue DISTANTE de la
// présence, au-delà du bail (qui ne corrige que la mort d'un process ENTIER, cf.
// tests/mjs-ws-adapter.test.ts test 8). MÊME technique que les autres tests adaptateur — VRAI
// client µ.socket, deux apps MJS-WS reliées par un MemoryAdapter sur le MÊME bus (2 « process »
// simulés) ; cadence RÉDUITE (CADENCE, 50 ms au lieu du défaut réel 15000 ms) pour des tests
// rapides. Le fantôme/le retrait artificiel (tests a/b) réutilisent le précédent établi par
// tests/mjs-ws-adapter.test.ts test 6 : un 3e MemoryAdapter (« injector ») publie DIRECTEMENT sur
// le canal `<prefix>:presence` en usurpant le processId d'un process réel — exactement ce qu'un
// message pub/sub incrémental perdu/mal appliqué produirait en vrai.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { MemoryAdapter, createMemoryAdapterBus } from '../src/mjs-ws/adapter.js'
import type { MemoryAdapterBus } from '../src/mjs-ws/adapter.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick    = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))
const CADENCE = 50   // cadence anti-entropie RÉDUITE pour les tests (défaut réel : 15000 ms)

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

// factory WebSocket + espion optionnel de trames — MÊME technique que tests/mjs-ws-adapter.test.ts
function makeClient(transport: MemoryTransport, trace?: Array<{ url: string; msg: any }>): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    if (trace) {
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { trace.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    return ws
  }
  return makeMu()
}

// démarre une app avec MemoryTransport + un MemoryAdapter posé sur le bus PARTAGÉ — cadence
// anti-entropie RÉDUITE par défaut (CADENCE), identité = auth.uid (la présence a besoin d'un id stable)
async function startApp(bus: MemoryAdapterBus, opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; adapter: MemoryAdapter }> {
  const transport = new MemoryTransport()
  const adapter   = new MemoryAdapter({ bus })
  const app       = mjsWs({ transport, heartbeat: 0, adapter, antiEntropy: CADENCE, auth: (h: any) => ({ id: h.auth.uid }), ...opts })
  await app.listen()
  return { transport, app, adapter }
}

describe('MJS-WS — anti-entropie de présence (MemoryAdapter, boucle complète)', () => {
  it('a. pair fantôme injecté dans la vue distante de B (attribué à A) → purgé, µ:presence leave reçu en ≤ 2 cycles', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA, adapter: adapterA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)

    const µA = makeClient(tA); const sA = µA.socket('memory://ghost-a', { auth: () => ({ uid: 'ana' }) }); sA.connect(); await tick()
    const traceB: Array<{ url: string; msg: any }> = []
    const µB = makeClient(tB, traceB)
    const sB = µB.socket('memory://ghost-b', { auth: () => ({ uid: 'bea' }) })
    sB.connect()
    const $$pres = sB.presence()
    await tick()
    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana', 'bea'])

    // fantôme : injecté comme si A l'avait publié — processId RÉEL de A, précédent établi
    // (tests/mjs-ws-adapter.test.ts test 6 : un 3e MemoryAdapter publie directement sur le canal)
    const injector = new MemoryAdapter({ bus, processId: adapterA.processId })
    await injector.start()
    injector.publish(`${adapterA.prefix}:presence`, { room: undefined, op: 'join', id: 'fantome', meta: { faux: true } })
    await tick()
    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana', 'bea', 'fantome'], 'précondition : le fantôme est bien vu par B')

    await tick(CADENCE * 2 + 30)   // ≤ 2 cycles anti-entropie

    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana', 'bea'], 'fantôme purgé, ana (RÉEL) toujours là')
    const leaves = traceB.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'leave' && f.msg.p.id === 'fantome')
    assert.equal(leaves.length, 1, 'exactement UNE trame µ:presence {op:leave, id:fantome} reçue')
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('b. pair réel retiré artificiellement de la vue de B → réapparaît (µ:presence join) en ≤ 2 cycles', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA, adapter: adapterA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)

    const µA = makeClient(tA); const sA = µA.socket('memory://real-a', { auth: () => ({ uid: 'ana2' }) }); sA.connect(); await tick()
    const traceB: Array<{ url: string; msg: any }> = []
    const µB = makeClient(tB, traceB)
    const sB = µB.socket('memory://real-b', { auth: () => ({ uid: 'bea2' }) })
    sB.connect()
    const $$pres = sB.presence()
    await tick()
    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana2', 'bea2'])

    // retrait ARTIFICIEL : injecté comme si A avait publié le départ d'ana2 (processId RÉEL de A)
    // — simule un message pub/sub incrémental perdu/mal appliqué, PAS un vrai départ
    const injector = new MemoryAdapter({ bus, processId: adapterA.processId })
    await injector.start()
    injector.publish(`${adapterA.prefix}:presence`, { room: undefined, op: 'leave', id: 'ana2' })
    await tick()
    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['bea2'], 'précondition : ana2 artificiellement retirée')

    await tick(CADENCE * 2 + 30)

    assert.deepEqual(Object.keys({ ...$$pres }).sort(), ['ana2', 'bea2'], 'ana2 réapparue — corrigée par le prochain instantané réel de A')
    const joins = traceB.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op === 'join' && f.msg.p.id === 'ana2')
    assert.equal(joins.length, 1, "exactement UNE trame µ:presence {op:join, id:ana2} reçue (pas de doublon d'agrégation)")
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('c. régime permanent cohérent → zéro trame µ:presence (join/leave) pendant 3 cycles', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA } = await startApp(bus)
    const { transport: tB, app: appB } = await startApp(bus)

    const µA = makeClient(tA); const sA = µA.socket('memory://steady-a', { auth: () => ({ uid: 'ana3' }) }); sA.connect(); await tick()
    const traceB: Array<{ url: string; msg: any }> = []
    const µB = makeClient(tB, traceB)
    const sB = µB.socket('memory://steady-b', { auth: () => ({ uid: 'bea3' }) })
    sB.connect()
    await tick()
    sB.presence()   // abonnement — déclenche un reset initial, jamais un delta join/leave
    await tick()

    traceB.length = 0   // ne compter que les trames APRÈS le régime permanent établi

    await tick(CADENCE * 3 + 30)

    const deltas = traceB.filter(f => f.msg.t === 'µ:presence' && f.msg.p.op !== 'reset')
    assert.deepEqual(deltas, [], 'aucune trame µ:presence join/leave pendant 3 cycles cohérents')
    sA.destroy(); sB.destroy(); await appA.stop(); await appB.stop()
  })

  it('d. antiEntropy: false → aucune publication périodique sur le canal de synchronisation', async () => {
    const bus = createMemoryAdapterBus()
    const { app: appA, adapter: adapterA } = await startApp(bus, { antiEntropy: false })
    const spy = new MemoryAdapter({ bus })
    await spy.start()
    const seen: any[] = []
    spy.subscribe(`${adapterA.prefix}:presence:sync`, msg => seen.push(msg))

    await tick(CADENCE * 4)

    assert.deepEqual(seen, [], 'aucun instantané publié — antiEntropy désactivée')
    await appA.stop()
  })

  it('e. skip-self : un processus ignore son propre instantané (aucune pollution de sa vue locale)', async () => {
    const bus = createMemoryAdapterBus()
    const { transport: tA, app: appA, adapter: adapterA } = await startApp(bus)
    const µA = makeClient(tA); const sA = µA.socket('memory://self-a', { auth: () => ({ uid: 'aseule' }) }); sA.connect()
    const $$pres = sA.presence()
    await tick()
    assert.deepEqual(Object.keys({ ...$$pres }), ['aseule'])

    // preuve que le timer publie BIEN (observé par un tiers) — sans quoi le test suivant serait
    // trivialement vrai (rien ne tournerait du tout)
    const spy = new MemoryAdapter({ bus })
    await spy.start()
    const seen: any[] = []
    spy.subscribe(`${adapterA.prefix}:presence:sync`, msg => seen.push(msg))

    await tick(CADENCE * 3 + 30)

    assert.ok(seen.length >= 2, 'le timer publie bien — observé par un tiers')
    // et pourtant la vue LOCALE de A reste stable : aucun doublon, aucune entrée fantôme issue de
    // SON PROPRE instantané (self-skip de l'adaptateur, cf. adapter.ts publish/subscribe)
    assert.deepEqual(Object.keys({ ...$$pres }), ['aseule'])
    sA.destroy(); await appA.stop()
  })
})
