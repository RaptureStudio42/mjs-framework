// la file d'attente publique (matchmaking.ts::playQueued) doit refuser les
// tickets au-delà d'un plafond (DEFAULT_QUEUE_CAP), au lieu de grossir sans borne.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsServer } from '../src/mjs-server/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsServerApp } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}
function connecter(transport: MemoryTransport, id: string): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  const µ = makeMu()
  return µ.socket('memory://' + id, { auth: () => ({ id }), reconnect: { enabled: false } })
}

describe('matchmaking — plafond de la file d\'attente publique', () => {
  it('rejette au-delà du plafond, avec une erreur cataloguée', async function () {
    this.timeout(30000)
    const transport = new MemoryTransport()
    const app: MjsServerApp = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {} })
    ;(app as any).game('foule', { seats: 100000, state: () => ({}), moves: { noop: (g: any) => true } })
    await app.listen()

    // DEFAULT_QUEUE_CAP = 1000 (matchmaking.ts) — le 1001e ticket doit être rejeté
    let dernierAccepte: any = null
    let rejet: any = null
    for (let i = 0; i < 1001; i++) {
      const c = connecter(transport, 'j' + i)
      c.connect(); await tick()
      try {
        const r = await c.request('µgame:play', { type: 'foule' })
        if (i < 1000) dernierAccepte = r
      } catch (e) {
        rejet = e
      }
    }
    assert.ok(dernierAccepte, 'les 1000 premiers tickets doivent passer')
    assert.ok(rejet, 'le 1001e ticket doit être rejeté')
    assert.match(String(rejet), /file/)
    await app.stop()
  })
})
