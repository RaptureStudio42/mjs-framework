// lobby:advertise::meta sans plafond de taille/forme NI débit dédié
// (amplification) : `title`/`code`/`note` sont
// TOUS bornés, `meta` ne l'était pas — n'importe quelle valeur JSON pouvait être rediffusée à TOUT
// le hall, sans le moindre seau à jetons dédié (contrairement à lobby:status/lobby:invite).
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

describe('MJS-WS — lobby:advertise::meta bornée (taille/forme + débit dédié)', () => {
  it('a. meta trop grande (JSON sérialisé au-delà de la borne) → lobby-meta-invalid, rien diffusé', async () => {
    const { transport, app } = await startApp()
    const sZ = connect(transport, 'memory://l4-1a-z', zora)
    const sT = connect(transport, 'memory://l4-1a-t', theo)
    joinHall(sZ); joinHall(sT); await tick()
    await entrer(sZ); await entrer(sT)
    const recuT: any[] = []
    sT.on('lobby:listing', (p: any) => recuT.push(p))
    sZ.send('lobby:advertise', { title: 'table', meta: 'A'.repeat(60000) })
    await tick()
    assert.equal(sZ.lastError.message, 'lobby-meta-invalid')
    assert.deepEqual(recuT, [], 'aucune diffusion — refus AVANT toute mutation')
    sZ.destroy(); sT.destroy(); await app.stop()
  })

  it('b. meta de taille raisonnable → acceptée, diffusée intacte (non-régression)', async () => {
    const { transport, app } = await startApp()
    const sZ = connect(transport, 'memory://l4-1b-z', zora)
    const sT = connect(transport, 'memory://l4-1b-t', theo)
    joinHall(sZ); joinHall(sT); await tick()
    await entrer(sZ); await entrer(sT)
    const recuT: any[] = []
    sT.on('lobby:listing', (p: any) => recuT.push(p))
    sZ.send('lobby:advertise', { title: 'table', meta: { niveau: 3, carte: 'foret' } })
    await tick()
    assert.equal(sZ.lastError, null)
    assert.deepEqual(recuT[0].meta, { niveau: 3, carte: 'foret' })
    sZ.destroy(); sT.destroy(); await app.stop()
  })

  it('c. débit dédié — au-delà du burst, un advertise supplémentaire est rejeté lobby-rate', async () => {
    const { transport, app } = await startApp()
    const s = connect(transport, 'memory://l4-1c', zora)
    joinHall(s); await tick()
    await entrer(s)
    for (let i = 0; i < 6; i++) s.send('lobby:advertise', { title: 'table ' + i })
    await tick()
    assert.equal(s.lastError, null, 'les 6 premières passent (burst par défaut)')
    s.send('lobby:advertise', { title: 'table 7' })
    await tick()
    assert.equal(s.lastError.message, 'lobby-rate')
    s.destroy(); await app.stop()
  })
})
