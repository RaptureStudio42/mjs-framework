// mjs_chat.ts (client) — .messages/._mjs_seenIds/._mjs_retired grossissaient
// SANS BORNE pour toute la durée de la session (500 chat:send → 500 entrées dans .messages ET
// dans _mjs_seenIds, jamais purgées).
// Borne alignée sur DEFAULT_HISTORY (mjs-ws/chat.ts, 100) — plus ancien évincé au-delà, cf.
// MJS_CHAT_HISTORY_MAX (mjs_chat.ts). MÊME technique que tests/socket-chat.test.ts (vrai serveur
// MJS-WS + chatPackage, MemoryTransport) — ici uniquement le comportement du CLIENT.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, chatPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsChatOptions } from '../src/mjs-ws/chat.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const chatSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_chat.ts'), 'utf8')
const clientSrc = socketSrc + '\n' + chatSrc

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

const zora = { id: '1', name: 'Zora' }

describe('sock.chat — .messages/._mjs_seenIds/._mjs_retired bornés (client)', () => {
  it("a. 250 messages envoyés → .messages plafonne à 100, les 100 DERNIERS conservés (plus ancien évincé)", async () => {
    const { transport, app } = await startApp({ rateLimit: { rate: 100000, burst: 100000 } }, { limits: { rate: 100000, burst: 100000 } })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://s43a', { auth: () => zora, reconnect: { enabled: false } })
    const salon = sA.chat('general')
    await tick()

    const N = 250
    for (let i = 0; i < N; i++) sA.send('chat:send', { room: 'general', text: 'm' + i })
    await tick(50)

    assert.equal(salon.messages.length, 100, 'plafonné à MJS_CHAT_HISTORY_MAX (aligné sur DEFAULT_HISTORY serveur)')
    assert.equal(salon.messages[0].text, 'm150', 'le plus ANCIEN restant est le 150e envoi — les 150 premiers évincés')
    assert.equal(salon.messages[99].text, 'm249', 'le plus RÉCENT est bien conservé')
    sA.destroy(); await app.stop()
  })

  it("b. _mjs_seenIds/_mjs_retired bornés eux aussi — pas de fuite mémoire au-delà de la fenêtre", async () => {
    const { transport, app } = await startApp({ rateLimit: { rate: 100000, burst: 100000 } }, { limits: { rate: 100000, burst: 100000 } })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://s43b', { auth: () => zora, reconnect: { enabled: false } })
    sA.chat('general')
    await tick()

    const N = 250
    for (let i = 0; i < N; i++) sA.send('chat:send', { room: 'general', text: 'm' + i })
    await tick(50)

    const h = sA._mjs_chats[sA._mjs_chats.length - 1]
    assert.equal(Object.keys(h._mjs_seenIds).length, 100, '_mjs_seenIds ne garde que la fenêtre bornée')
    assert.equal(Object.keys(h._mjs_retired).length, 0, 'aucun retrait ici — _mjs_retired reste vide')
    sA.destroy(); await app.stop()
  })

  it("c. un message retiré (modération) puis évincé plus tard ne laisse aucune trace dans les 3 registres", async () => {
    const { transport, app } = await startApp({ moderators: () => true, rateLimit: { rate: 100000, burst: 100000 } }, { limits: { rate: 100000, burst: 100000 } })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://s43c', { auth: () => zora, reconnect: { enabled: false } })
    const salon = sA.chat('general')
    await tick()

    sA.send('chat:send', { room: 'general', text: 'à retirer' })
    await tick()
    const idRetire = salon.messages[0].id
    salon.remove(idRetire)
    await tick()
    assert.deepEqual(salon.messages, [], 'retiré immédiatement du store')

    const N = 150
    for (let i = 0; i < N; i++) sA.send('chat:send', { room: 'general', text: 'm' + i })
    await tick(50)

    const h = sA._mjs_chats[sA._mjs_chats.length - 1]
    assert.equal(Object.prototype.hasOwnProperty.call(h._mjs_retired, idRetire), false, 'le tombstone lui-même finit évincé, aligné sur la même fenêtre bornée')
    assert.ok(Object.keys(h._mjs_seenIds).length <= 100, '_mjs_seenIds reste borné même avec un retrait dans le lot')
    sA.destroy(); await app.stop()
  })
})
