// opts.moderators (lobby.ts::estModerateur) qui LÈVE exposait son
// message brut à un appelant NON privilégié sur lobby:withdraw : aligne estModerateur sur le contrat d'onMessage
// (chat.ts) — message générique au client, détail au journal serveur.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, lobbyPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsLobbyOptions } from '../src/mjs-ws/lobby.js'

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
async function startApp(lobbyOpts: MjsWsLobbyOptions = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {}, ...wsOpts })
  app.use(lobbyPackage({ onLog: () => {}, ...lobbyOpts }))
  await app.listen()
  return { transport, app }
}
function connect(transport: MemoryTransport, url: string, identity: unknown): any {
  const s = makeClient(transport).socket(url, { auth: () => identity, reconnect: { enabled: false } })
  s.connect()
  return s
}
function joinHall(s: any, hall = 'hall', prefixe = 'lobby:'): void { s.room(prefixe + hall) }
async function entrer(s: any, hall?: string): Promise<any> { return s.request('lobby:enter', hall === undefined ? {} : { hall }) }

const zora = { id: '1', name: 'Zora' }
const theo = { id: '2', name: 'Theo' }
const SECRET = 'secret-interne: connexion base a 10.0.0.5 refusee'

describe('MJS-WS — lobby.ts estModerateur qui lève : message générique au client', () => {
  it("a. moderators() qui lève sur lobby:withdraw (non-propriétaire) → 'lobby-denied', jamais le détail interne", async () => {
    const { transport, app } = await startApp({ moderators: () => { throw new Error(SECRET) } })
    const sZ = connect(transport, 'memory://s42-lobby-a-z', zora)   // NI propriétaire NI modératrice
    const sT = connect(transport, 'memory://s42-lobby-a-t', theo)
    joinHall(sZ); joinHall(sT); await tick()
    await entrer(sZ); await entrer(sT)
    const recuT: any[] = []
    sT.on('lobby:listing', (p: any) => recuT.push(p))
    sT.send('lobby:advertise', { title: 'table de Theo' })
    await tick()
    sZ.send('lobby:withdraw', { id: recuT[0].id })
    await tick()
    assert.equal(sZ.lastError.message, 'lobby-denied')
    sZ.destroy(); sT.destroy(); await app.stop()
  })
})
