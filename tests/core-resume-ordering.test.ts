// Reprise de session : ordre autour du µ:welcome{resumed:true} quand opts.welcome()
// est asynchrone (src/mjs-ws/core.ts::resumeClient/finishResume). MÊME technique que
// tests/mjs-ws-resume-edge.test.ts (vrai client µ.socket + MemoryTransport + espion de trames
// routé par URL, welcome() qui se bloque sur commande).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

interface Spy { in?: Array<{ url: string; msg: any }> }

// factory WebSocket UNIQUE routée par URL — cf. tests/mjs-ws-resume.test.ts pour le pourquoi
function wireWebSocket(transport: MemoryTransport, perUrl: Record<string, Spy> = {}): void {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    const spy = perUrl[url]
    if (spy && spy.in) {
      const bucket = spy.in
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { bucket.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    return ws
  }
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

describe('reprise de session : ordre autour du welcome() async', () => {
  it('un app.broadcast() pendant welcome() async n\'arrive plus AVANT le µ:welcome{resumed:true}', async () => {
    let releaseWelcome: (() => void) | null = null
    const { transport, app } = await startApp({
      resume: true, onLog: () => {},
      welcome: () => new Promise<void>(resolve => { releaseWelcome = () => resolve() }),
    })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://s2-1': { in: recu } })
    const µ = makeMu()
    const s = µ.socket('memory://s2-1', { reconnect: { enabled: false } })

    // 1er hello — welcome immédiat
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() du 1er hello doit être en attente')
    releaseWelcome!(); await tick()
    assert.equal(recu.filter(f => f.msg.t === 'µ:welcome').length, 1)

    // coupure -> parqué
    s._mjs_ws.close(1006, 'coupure'); await tick()

    // reconnexion (reprise) — welcome() se bloque
    releaseWelcome = null
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() de la reprise doit être en attente')

    // PENDANT cette attente : un broadcast applicatif normal, visant CE client
    app.broadcast('sournois', { n: 1 })
    await tick()

    // le welcome() de la reprise se libère enfin
    releaseWelcome!(); await tick()

    const ordre = recu.filter(f => f.msg.t === 'µ:welcome' || f.msg.t === 'sournois').map(f => f.msg.t)
    assert.deepEqual(ordre, ['µ:welcome', 'µ:welcome', 'sournois'], 'le welcome de reprise précède désormais TOUJOURS le broadcast, plus jamais l\'inverse (piège #1 du contrat)')
    const welcomes = recu.filter(f => f.msg.t === 'µ:welcome').map(f => f.msg)
    assert.equal(welcomes[1].p.resumed, true)

    s.destroy(); await app.stop()
  })

  it('double coupure PENDANT la reprise : les trames de la 1re grâce restent AVANT celles de la 2e (file unique ordonnée)', async () => {
    let releaseWelcome: (() => void) | null = null
    const { transport, app } = await startApp({
      resume: true, onLog: () => {},
      welcome: () => new Promise<void>(resolve => { releaseWelcome = () => resolve() }),
    })
    const recu: any[] = []
    wireWebSocket(transport, { 'memory://s2-2': { in: recu } })
    const µ = makeMu()
    const s = µ.socket('memory://s2-2', { reconnect: { enabled: false } })

    s.connect(); await tick()
    releaseWelcome!(); await tick()

    // coupure 1 -> parqué. M1/M2 tamponnés (gap le plus ANCIEN)
    s._mjs_ws.close(1006, 'coupure 1'); await tick()
    app.broadcast('gap1', { n: 'M1' })
    app.broadcast('gap1', { n: 'M2' })
    await tick()

    // reconnexion (reprise) — welcome() se bloque -> finishResume en attente
    releaseWelcome = null
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() de la reprise doit être en attente')

    // coupure 2 PENDANT ce welcome (re-parque le client repris, AVANT que M1/M2 ne soient rejoués)
    s._mjs_ws.close(1006, 'coupure 2 - pendant la reprise'); await tick()

    // pendant que le client est RE-parqué, M3 (gap le plus RÉCENT) est tamponné
    app.broadcast('gap2', { n: 'M3' })
    await tick()

    // on libère enfin le welcome() de la reprise avortée -> M1/M2 rejoignent la file unique
    releaseWelcome!(); await tick()

    // reprise finale, welcome immédiat
    releaseWelcome = null
    s.connect(); await tick()
    assert.ok(releaseWelcome, 'welcome() de la reprise finale doit être en attente')
    releaseWelcome!(); await tick()

    const ordre = recu.filter(f => f.msg.t === 'gap1' || f.msg.t === 'gap2').map(f => f.msg.p.n)
    assert.deepEqual(ordre, ['M1', 'M2', 'M3'], 'ordre chronologique d\'émission respecté — plus jamais d\'inversion')

    s.destroy(); await app.stop()
  })
})
