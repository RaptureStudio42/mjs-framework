// Échec de SÉRIALISATION (charge trop imbriquée, RangeError JSON.stringify) :
// avant, la trame disparaissait en silence (preEncodeFrame/sendRaw, racine commune avec le bogue
// constaté côté pont, cf. bridge.ts::handleBroadcast/handleSend, hors du présent correctif). Ici : le
// correctif CŒUR (core.ts) — log cataloguée avec le TYPE de message, retour d'échec remonté à
// app.broadcast/app.send/app.sendUser. MÊME technique que tests/mjs-ws-core.test.ts.
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

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// pas de récursion (jamais de dépassement de pile CÔTÉ TEST) — imbrication par boucle, même
// ordre de grandeur mesuré empiriquement (~170 000 niveaux)
function deepNest(n: number): any {
  let obj: any = { leaf: true }
  for (let i = 0; i < n; i++) obj = { x: obj }
  return obj
}

describe('sérialisation : échec remonté, plus jamais silencieux (racine core.ts)', () => {
  it('app.broadcast() : charge trop imbriquée → false, log cataloguée AVEC le type, rien livré, le canal reste utilisable ensuite', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { transport, app } = await startApp({ onLog: (level, message) => logs.push({ level, message }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://s3-broadcast', { reconnect: { enabled: false } })
    s.connect(); await tick()
    const recu: any[] = []
    s.on('etat', (p: any) => recu.push(p))

    const ok = app.broadcast('etat', deepNest(200000))
    assert.equal(ok, false, 'app.broadcast() doit signaler l\'échec de sérialisation (retour false)')
    await tick()
    assert.equal(recu.length, 0, 'rien n\'a été livré — l\'échec a lieu AVANT tout encodage/diffusion')

    const errLog = logs.find(l => l.level === 'error' && /sérialisation/.test(l.message))
    assert.ok(errLog, 'une erreur cataloguée doit être journalisée (plus un simple compteur muet)')
    assert.ok(/etat/.test(errLog!.message), 'le TYPE du message doit apparaître dans le log')

    // le canal reste UTILISABLE ensuite — un échec de sérialisation n'empoisonne rien côté core.ts
    // (contrairement à streams.ts, hors du présent correctif)
    const ok2 = app.broadcast('etat', { fine: true })
    assert.equal(ok2, true)
    await tick()
    assert.deepEqual(recu, [{ fine: true }])

    s.destroy(); await app.stop()
  })

  it('app.send() (client unique) : MÊME correctif — false + log cataloguée avec le type', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { transport, app } = await startApp({ onLog: (level, message) => logs.push({ level, message }) })
    const µ = makeClient(transport)
    const s = µ.socket('memory://s3-send', { reconnect: { enabled: false } })
    s.connect(); await tick()
    const client = Array.from(app.clients)[0]

    const ok = app.send(client, 'etat', deepNest(200000))
    assert.equal(ok, false)
    const errLog = logs.find(l => l.level === 'error' && /sérialisation/.test(l.message) && /etat/.test(l.message))
    assert.ok(errLog, 'log cataloguée avec le type attendue')

    const ok2 = app.send(client, 'etat', { fine: true })
    assert.equal(ok2, true, 'le canal reste utilisable après un échec ponctuel')

    s.destroy(); await app.stop()
  })

  it('app.sendUser() : MÊME correctif — false sur charge insérialisable', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://s3-senduser', { auth: () => ({ id: 'u1' }), reconnect: { enabled: false } })
    s.connect(); await tick()

    const ok = app.sendUser('u1', 'etat', deepNest(200000))
    assert.equal(ok, false)
    const ok2 = app.sendUser('u1', 'etat', { fine: true })
    assert.equal(ok2, true)

    s.destroy(); await app.stop()
  })
})
