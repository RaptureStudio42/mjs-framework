// Tests du CLIENT réactif sock.lobby (mjs_lobby.ts) contre un VRAI serveur MJS-WS + lobbyPackage
// (MemoryTransport) — même patron que tests/socket-chat.test.ts (`new Function('µ', src)(stub)`,
// MemoryTransport, store réactif MINIMAL Proxy set + Set d'abonnés PAR CLÉ pour PROUVER qu'une
// mutation déclenche un abonné réactif). Le PROTOCOLE serveur (débit/absent-auto/blocage/TTL/
// modération…) est déjà couvert exhaustivement par tests/mjs-ws-lobby.test.ts — ici, uniquement le
// comportement du CLIENT : store rempli au join, statut()/inviter()/annoncer(), TTL LOCAL des
// invitations/annonces (sans nouvelle trame serveur), candidat/reponse reçus, erreurs exposées
// (sock.lastError), plusieurs halls indépendants, fermer().
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, lobbyPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsLobbyOptions } from '../src/mjs-ws/lobby.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const lobbySrc  = readFileSync(join(__dirname, '../src/runtime/mjs_lobby.ts'), 'utf8')
// CONCATÉNÉS dans UN seul new Function — même patron que socket-chat.test.ts (mjs_lobby.ts référence
// `MjsSocket`/`_mjs_safeKey` en identifiants NUS, ordre canonique du bundler : socket PUIS lobby).
const clientSrc = socketSrc + '\n' + lobbySrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// store réactif MINIMAL (Proxy set + Set d'abonnés PAR CLÉ) — MÊME stub que socket-chat.test.ts :
// prouve qu'une mutation (réassignation top-level, cf. mjs_lobby.ts::_lobbyUpsertMember) déclenche
// un VRAI abonné réactif, pas seulement une relecture après coup.
const __lobbyStoreSubs = new WeakMap<object, Map<string, Set<() => void>>>()
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
  __lobbyStoreSubs.set(proxy, subs)
  return proxy
}
function watchKey(store: any, key: string, fn: () => void): void {
  const subs = __lobbyStoreSubs.get(store)
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

async function startApp(lobbyOpts: MjsWsLobbyOptions = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, onLog: () => {}, ...wsOpts })
  app.use(lobbyPackage({ onLog: () => {}, ...lobbyOpts }))
  await app.listen()
  return { transport, app }
}

const zora = { id: '1', name: 'Zora' }
const theo = { id: '2', name: 'Theo' }

describe('sock.lobby — client réactif du paquet LOBBY (mjs_lobby.ts, vrai serveur MJS-WS + lobbyPackage)', () => {
  it("a. store rempli au join — moi (lobby:enter) + presents SELF-INCLUSIF, réactivité prouvée", async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://a1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    let fired = false
    watchKey(hallA, 'me', () => { fired = true })
    await tick()

    assert.deepEqual(hallA.me, { id: '1', name: 'Zora' })
    assert.equal(hallA.members.length, 1, 'presents contient déjà MOI-MÊME (.me ne porte pas statut/texte/depuis)')
    assert.equal(hallA.members[0].name, 'Zora')
    assert.ok(fired, "l'arrivée de .me doit avoir déclenché un abonné réactif")

    const µB = makeClient(transport)
    const sB = µB.socket('memory://a2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()
    assert.equal(hallB.members.length, 2, 'Theo voit Zora déjà présente ET lui-même')
    assert.ok(hallB.members.some((p: any) => p.name === 'Zora'))
    assert.ok(hallB.members.some((p: any) => p.name === 'Theo'))
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it("b. statut() — la mutation apparaît dans .members de TOUS (soi-même inclus), réactivité prouvée", async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://b1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://b2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()

    let fired = false
    watchKey(hallB, 'members', () => { fired = true })
    hallA.status('busy', 'en partie')
    await tick()

    const moiVuParB = hallB.members.find((p: any) => p.id === '1')
    assert.equal(moiVuParB.status, 'busy')
    assert.equal(moiVuParB.text, 'en partie')
    assert.ok(fired, 'la mutation de .members chez B doit avoir déclenché un abonné réactif')
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('c. invitations — reçue puis expire LOCALEMENT après le délai, sans nouvelle trame serveur', async () => {
    const { transport, app } = await startApp({ invitationTtlMs: 30 })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://c1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://c2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()

    hallA.invite(theo.id, 'viens')
    await tick()
    assert.equal(hallB.invitations.length, 1)
    assert.equal(hallB.invitations[0].from.name, 'Zora')
    assert.equal(hallB.invitations[0].note, 'viens')

    await tick(50)   // > invitationTtlMs (30ms) — expiration LOCALE, purement cliente
    assert.deepEqual(hallB.invitations, [], 'expirée toute seule, horloge locale')
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it("d. annonces — TTL LOCAL identique, ET un retrait EXPLICITE annule le minuteur (pas de double retrait)", async () => {
    const { transport, app } = await startApp({ listingTtlMs: 30 })
    const µA = makeClient(transport)
    const sA = µA.socket('memory://d1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://d2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()

    hallA.advertise({ title: 'Partie rapide', seats: 4 })
    await tick()
    assert.equal(hallB.listings.length, 1)
    assert.equal(hallB.listings[0].title, 'Partie rapide')

    hallA.withdraw()   // retrait EXPLICITE, AVANT le TTL
    await tick()
    assert.deepEqual(hallB.listings, [], 'retiré tout de suite')

    await tick(50)   // le minuteur TTL, s'il n'avait pas été annulé, tenterait un 2e retrait ici
    assert.deepEqual(hallB.listings, [], 'toujours vide — aucun effet de bord du minuteur annulé')
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('e. rejoindre(annonce) — accepte un OBJET (pas seulement un id) ; candidat + reponse reçus', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://e1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://e2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()

    hallA.advertise({ title: 'Table' })
    await tick()
    hallB.join(hallB.listings[0])   // l'OBJET entier, pas juste son id
    await tick()
    assert.equal(hallA.applicants.length, 1)
    assert.deepEqual(hallA.applicants[0].from, { id: '2', name: 'Theo' })

    hallA.invite(theo.id)
    await tick()
    hallB.reply(hallB.invitations[0], true)   // idem — l'OBJET entier, pas juste son id
    await tick()
    assert.equal(hallA.replies.length, 1)
    assert.equal(hallA.replies[0].accepted, true)
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('f. erreurs lobby-* exposées via sock.lastError (même mécanique que le reste de MJS-WS)', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://f1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    hallA.status('n-importe-quoi')
    await tick()
    assert.equal(sA.lastError.message, 'lobby-status-invalid')
    sA.destroy(); await app.stop()
  })

  it('g. plusieurs halls indépendants sur le même socket', async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://g1', { auth: () => zora, reconnect: { enabled: false } })
    const hall  = sA.lobby()
    const vip   = sA.lobby('vip')
    await tick()
    hall.advertise({ title: 'Dans hall' })
    await tick()
    assert.equal(hall.listings.length, 1)
    assert.equal(vip.listings.length, 0, "'vip' ne voit pas le trafic de 'hall'")
    sA.destroy(); await app.stop()
  })

  it("h. fermer() — quitte le hall, plus aucune mise à jour reçue ensuite", async () => {
    const { transport, app } = await startApp()
    const µA = makeClient(transport)
    const sA = µA.socket('memory://h1', { auth: () => zora, reconnect: { enabled: false } })
    const hallA = sA.lobby()
    await tick()
    const µB = makeClient(transport)
    const sB = µB.socket('memory://h2', { auth: () => theo, reconnect: { enabled: false } })
    const hallB = sB.lobby()
    await tick()

    hallA.close()
    await tick()
    hallB.status('busy')
    await tick()
    assert.equal(hallA.members.filter((p: any) => p.id === '2' && p.status === 'busy').length, 0, 'A a fermé AVANT ce changement — jamais reçu')
    sA.destroy(); sB.destroy(); await app.stop()
  })
})
