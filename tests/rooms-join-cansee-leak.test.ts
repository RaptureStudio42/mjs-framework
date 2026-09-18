// opts.join/opts.canSeePresence (rooms.ts::handleJoin/handleSubPresence)
// qui LÈVENT renvoyaient errMessage(err) VERBATIM au client (rooms.ts:290-291/384-385) — on
// tranche : « rooms.ts fait pareil » que chat.ts/lobby.ts, aligne les trois sur le contrat d'onMessage
// (message générique au client — le MÊME que le refus explicite `false` — détail au journal serveur).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { t } from '../src/messages/index.js'

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
  const app = mjsWs({ transport, heartbeat: 0, onLog: () => {}, ...opts })
  await app.listen()
  return { transport, app }
}

const SECRET = 'secret-interne: connexion base a 10.0.0.5 refusee'

describe('MJS-WS — rooms.ts join/canSeePresence qui lèvent : message générique au client', () => {
  it('a. join() qui lève → même message générique que le refus explicite (false), jamais le détail interne', async () => {
    const { transport, app } = await startApp({ rooms: { join: () => { throw new Error(SECRET) } } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://s42-rooms-a')
    s.connect(); await tick()
    s.room('salon'); await tick()
    assert.equal(app.room('salon').size, 0)
    assert.notEqual(s.lastError.message, SECRET, 'le détail interne ne doit JAMAIS atteindre le client')
    assert.equal(s.lastError.message, t('ws.rooms.acces-salon-refuse'))
    s.destroy(); await app.stop()
  })

  it('b. canSeePresence() qui lève → même message générique que le refus explicite (false), jamais le détail interne', async () => {
    const { transport, app } = await startApp({ rooms: { canSeePresence: () => { throw new Error(SECRET) } } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://s42-rooms-b')
    s.connect(); await tick()
    s.room('salon'); await tick()
    s.presence('salon'); await tick()
    assert.notEqual(s.lastError.message, SECRET, 'le détail interne ne doit JAMAIS atteindre le client')
    assert.equal(s.lastError.message, t('ws.rooms.acces-presence-refuse'))
    s.destroy(); await app.stop()
  })
})
