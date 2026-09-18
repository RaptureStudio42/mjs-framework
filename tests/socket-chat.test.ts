// Tests du CLIENT réactif sock.chat (mjs_chat.ts) contre un VRAI serveur MJS-WS + chatPackage
// (MemoryTransport) — même patron que tests/socket-game.test.ts (`new Function('µ', src)(stub)`,
// MemoryTransport, store réactif MINIMAL Proxy set + Set d'abonnés PAR CLÉ pour PROUVER qu'une
// mutation déclenche un abonné réactif — une simple relecture après coup ne le prouverait pas).
// Le PROTOCOLE serveur (débit/mute/onMessage/canJoin/préfixe…) est déjà couvert exhaustivement par
// tests/mjs-ws-chat.test.ts — ici, uniquement le comportement du CLIENT : store rempli au join,
// envoyer()/frappe(), typingUsers, retrait appliqué, resynchro à la reconnexion, erreurs exposées
// (sock.lastError), plusieurs poignées indépendantes, fermer().
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
// CONCATÉNÉS dans UN seul new Function — même patron que socket-game.test.ts (mjs_chat.ts référence
// `MjsSocket`/`_mjs_safeKey` en identifiants NUS, ordre canonique du bundler : socket PUIS chat).
const clientSrc = socketSrc + '\n' + chatSrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// store réactif MINIMAL (Proxy set + Set d'abonnés PAR CLÉ) — MÊME stub que socket-game.test.ts :
// prouve qu'une mutation (réassignation top-level, cf. mjs_chat.ts::_chatInsert) déclenche un VRAI
// abonné réactif, pas seulement une relecture après coup.
const __chatStoreSubs = new WeakMap<object, Map<string, Set<() => void>>>()
function reactiveState(init: any): any {
  const target: any = { ...init }
  const subs = new Map<string, Set<() => void>>()
  const proxy = new Proxy(target, {
    set(obj, key, value) {
      obj[key as string] = value
      const s = subs.get(key as string)
      if (s) s.forEach(fn => fn())
      return true
    },
    deleteProperty(obj, key) {
      delete obj[key as string]
      return true
    },
  })
  __chatStoreSubs.set(proxy, subs)
  return proxy
}
function watchKey(store: any, key: string, fn: () => void): void {
  const subs = __chatStoreSubs.get(store)
  if (!subs) return
  let s = subs.get(key)
  if (!s) { s = new Set(); subs.set(key, s) }
  s.add(fn)
}

function makeMu(): any {
  const µ: any = { state: reactiveState, error: () => {}, warn: () => {}, log: () => {} }
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
const theo = { id: '2', name: 'Theo' }

describe('sock.chat — client réactif du paquet CHAT (mjs_chat.ts, vrai serveur MJS-WS + chatPackage)', () => {
  it("a. store rempli au join — moi (chat:me) + historique rejoué, dans l'ordre", async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://a1', { auth: () => zora, reconnect: { enabled: false } })
    const salonA = sA.chat('general')
    await tick()
    salonA.send('m1')
    await tick()
    salonA.send('m2')
    await tick()

    const µB = makeClient(transport)
    const sB = µB.socket('memory://a2', { auth: () => theo, reconnect: { enabled: false } })
    const salonB = sB.chat('general')
    await tick()

    assert.deepEqual(salonB.me, { id: '2', name: 'Theo' })
    assert.deepEqual(salonB.messages.map((m: any) => m.text), ['m1', 'm2'], 'historique rejoué DANS L\'ORDRE')
    assert.deepEqual(salonA.me, { id: '1', name: 'Zora' })
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('b. envoyer() — le message apparaît dans .messages après un aller-retour réel, réactivité prouvée', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://b1', { auth: () => zora, reconnect: { enabled: false } })
    const salon = sA.chat('general')
    await tick()

    let fired = false
    watchKey(salon, 'messages', () => { fired = true })

    salon.send('salut le monde')
    await tick()

    assert.equal(salon.messages.length, 1)
    assert.equal(salon.messages[0].text, 'salut le monde')
    assert.deepEqual(salon.messages[0].from, { id: '1', name: 'Zora' })
    assert.ok(fired, 'la mutation du store (messages réécrit) doit avoir déclenché un abonné réactif')
    sA.destroy(); await app.stop()
  })

  it('c. typingUsers — se remplit à la réception d\'une frappe étrangère, dédup par identité', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://c1', { auth: () => zora, reconnect: { enabled: false } })
    const salonA = sA.chat('general')
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://c2', { auth: () => theo, reconnect: { enabled: false } })
    const salonB = sB.chat('general')
    await tick()

    salonB.typing()
    await tick()
    assert.deepEqual(salonA.typingUsers, ['Theo'], "A voit Theo écrire")
    assert.deepEqual(salonB.typingUsers, [], "B ne voit jamais sa PROPRE frappe")
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it("d. retrait appliqué — un message supprimé disparaît de .messages (modérateur)", async () => {
    const { transport, app } = await startApp({ moderators: (identity: any) => identity?.id === zora.id })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://d1', { auth: () => zora, reconnect: { enabled: false } })
    const salonA = sA.chat('general')
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://d2', { auth: () => theo, reconnect: { enabled: false } })
    const salonB = sB.chat('general')
    await tick()

    salonB.send('à retirer')
    await tick()
    assert.equal(salonA.messages.length, 1)
    const id = salonA.messages[0].id

    salonA.remove(id)   // Zora EST modératrice
    await tick()
    assert.deepEqual(salonA.messages, [], 'retiré du store de A (émetteur du retrait)')
    assert.deepEqual(salonB.messages, [], 'retiré du store de B (auteur du message) aussi')
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('e. erreurs chat-* exposées via sock.lastError (même mécanique que le reste de MJS-WS)', async () => {
    const { transport, app } = await startApp({ maxLength: 3 })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://e1', { auth: () => zora, reconnect: { enabled: false } })
    const salon = sA.chat('general')
    await tick()
    salon.send('bien trop long pour la limite')
    await tick()
    assert.equal(sA.lastError.message, 'chat-length')
    assert.deepEqual(salon.messages, [], 'aucun message ajouté au refus')
    sA.destroy(); await app.stop()
  })

  it('f. reconnexion — resynchronise (rejoue l\'historique), purge les doublons par id de message', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://f1', { auth: () => zora, reconnect: { backoff: [50], jitter: 0 } })
    const salonA = sA.chat('general')
    await tick()
    salonA.send('avant-coupure')
    await tick()
    assert.equal(salonA.messages.length, 1)

    sA._mjs_ws.close(1006, 'coupure simulée')
    assert.equal(sA.state, 'reconnecting')

    const µB = makeClient(transport)
    const sB = µB.socket('memory://f2', { auth: () => theo, reconnect: { enabled: false } })
    const salonB = sB.chat('general')
    await tick()
    salonB.send('pendant-coupure')   // envoyé par un AUTRE client PENDANT que A est déconnecté
    await tick(200)   // > backoff 50ms — laisse la reconnexion + rejeu d'historique se dérouler

    assert.equal(sA.state, 'open', 'le socket doit avoir repris tout seul')
    assert.deepEqual(
      salonA.messages.map((m: any) => m.text),
      ['avant-coupure', 'pendant-coupure'],
      'rattrapé après reconnexion, AUCUN doublon de avant-coupure (dédup par id)'
    )
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('g. plusieurs poignées indépendantes sur le même socket — salons distincts isolés', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://g1', { auth: () => zora, reconnect: { enabled: false } })
    const general = sA.chat('general')
    const random  = sA.chat('random')
    await tick()
    general.send('dans general')
    await tick()
    assert.equal(general.messages.length, 1)
    assert.equal(random.messages.length, 0, "'random' ne voit pas le trafic de 'general'")
    sA.destroy(); await app.stop()
  })

  it("h. fermer() — quitte le salon, plus aucun message reçu ensuite", async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://h1', { auth: () => zora, reconnect: { enabled: false } })
    const salonA = sA.chat('general')
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://h2', { auth: () => theo, reconnect: { enabled: false } })
    const salonB = sB.chat('general')
    await tick()

    salonA.close()
    await tick()
    salonB.send('après le départ de A')
    await tick()
    assert.deepEqual(salonA.messages, [], "A a quitté AVANT ce message — jamais reçu")
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('i. préfixe personnalisé — sock.chat(nom, {prefixe}) rejoint le BON salon MJS-WS', async () => {
    const { transport, app } = await startApp({ prefix: 'room:' })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://i1', { auth: () => zora, reconnect: { enabled: false } })
    const salon = sA.chat('general', { prefix: 'room:' })
    await tick()
    salon.send('yo')
    await tick()
    assert.equal(salon.messages.length, 1)
    assert.equal(app.room('room:general').size, 1)
    sA.destroy(); await app.stop()
  })
})
