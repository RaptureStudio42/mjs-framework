// opts.moderators/opts.canJoin (chat.ts) qui LÈVENT exposaient leur
// message brut à un appelant NON privilégié — contrairement à onMessage (chat.ts:231-235, protégé
// par un catch générique → 'chat-denied'). Fix : aligne isModerator/isAllowed sur le MÊME contrat.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, chatPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsChatOptions } from '../src/mjs-ws/chat.js'

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
async function startApp(chatOpts: MjsWsChatOptions = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {}, ...wsOpts })
  app.use(chatPackage(chatOpts))
  await app.listen()
  return { transport, app }
}
function connect(transport: MemoryTransport, url: string, identity: unknown): any {
  const s = makeClient(transport).socket(url, { auth: () => identity, reconnect: { enabled: false } })
  s.connect()
  return s
}
function joinRoom(s: any, room: string, prefix = 'chat:'): void { s.room(prefix + room) }

const zora = { id: '1', name: 'Zora' }
const theo = { id: '2', name: 'Theo' }
const SECRET = 'secret-interne: connexion base a 10.0.0.5 refusee'

describe('MJS-WS — chat.ts moderators/canJoin qui lèvent : message générique au client', () => {
  it("a. moderators() qui lève sur chat:remove → 'chat-denied', jamais le détail interne", async () => {
    const { transport, app } = await startApp({ moderators: () => { throw new Error(SECRET) } })
    const sZ = connect(transport, 'memory://s42-chat-a-z', zora)   // PAS modératrice
    const sT = connect(transport, 'memory://s42-chat-a-t', theo)
    joinRoom(sZ, 'general'); joinRoom(sT, 'general'); await tick()
    sT.send('chat:send', { room: 'general', text: 'hello' })
    await tick()
    sZ.send('chat:remove', { room: 'general', id: 'peu-importe' })
    await tick()
    assert.equal(sZ.lastError.message, 'chat-denied')
    sZ.destroy(); sT.destroy(); await app.stop()
  })

  it("b. moderators() qui lève sur chat:mute → 'chat-denied', jamais le détail interne", async () => {
    const { transport, app } = await startApp({ moderators: () => { throw new Error(SECRET) } })
    const sZ = connect(transport, 'memory://s42-chat-b-z', zora)
    joinRoom(sZ, 'general'); await tick()
    sZ.send('chat:mute', { room: 'general', identityId: theo.id, durationMs: 1000 })
    await tick()
    assert.equal(sZ.lastError.message, 'chat-denied')
    sZ.destroy(); await app.stop()
  })

  it("c. canJoin() qui lève sur chat:send → 'chat-denied', jamais le détail interne", async () => {
    const { transport, app } = await startApp({ canJoin: () => { throw new Error(SECRET) } })
    const sZ = connect(transport, 'memory://s42-chat-c-z', zora)
    joinRoom(sZ, 'general'); await tick()
    sZ.send('chat:send', { room: 'general', text: 'salut' })
    await tick()
    assert.equal(sZ.lastError.message, 'chat-denied')
    sZ.destroy(); await app.stop()
  })
})
