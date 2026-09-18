// Tests du sucre « salon avec historique » (rooms.ts) — même technique que
// tests/mjs-ws-rooms-streams.test.ts (MemoryTransport + vrai client µ.socket) : app.room(x).history(n)
// adosse un petit journal borné au salon, REJOUÉ TRANSPARENT (mêmes trames que le live, {t: type, p})
// à tout nouvel arrivant, AVANT le trafic live — jamais au membre déjà présent.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

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

describe('MJS-WS — salon avec historique (room().history)', () => {
  it('a. history(3) : 5 messages envoyés, un nouvel arrivant reçoit les 3 derniers dans l\'ordre puis le live', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(3)
    for (let i = 1; i <= 5; i++) app.room('chat').send('chat/msg', { n: i })

    const µ = makeClient(transport)
    const s = µ.socket('memory://ha')
    const recu: any[] = []
    s.connect(); s.room('chat').on('msg', (p: any) => recu.push(p))
    await tick()
    assert.deepEqual(recu, [{ n: 3 }, { n: 4 }, { n: 5 }], 'les 3 derniers, dans l\'ordre — pas les 2 plus vieux')

    app.room('chat').send('chat/msg', { n: 6 })
    await tick()
    assert.deepEqual(recu, [{ n: 3 }, { n: 4 }, { n: 5 }, { n: 6 }], 'le live s\'ajoute APRÈS l\'historique, jamais avant')
    s.destroy(); await app.stop()
  })

  it('b. sans history() : un arrivant ne reçoit AUCUN historique (comportement actuel)', async () => {
    const { transport, app } = await startApp()
    app.room('chat').send('chat/msg', { n: 1 })   // avant même un premier membre — perdu, comme auparavant
    app.room('chat').send('chat/msg', { n: 2 })

    const µ = makeClient(transport)
    const s = µ.socket('memory://hb')
    const recu: any[] = []
    s.connect(); s.room('chat').on('msg', (p: any) => recu.push(p))
    await tick()
    assert.deepEqual(recu, [], 'history() jamais appelé → zéro rattrapage, comportement HISTORIQUE inchangé')

    app.room('chat').send('chat/msg', { n: 3 })
    await tick()
    assert.deepEqual(recu, [{ n: 3 }], 'le live normal, lui, continue de fonctionner')
    s.destroy(); await app.stop()
  })

  it('c. anneau borné : au-delà de n, les vieux tombent', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(2)
    for (let i = 1; i <= 4; i++) app.room('chat').send('chat/msg', { n: i })

    const µ = makeClient(transport)
    const s = µ.socket('memory://hc')
    const recu: any[] = []
    s.connect(); s.room('chat').on('msg', (p: any) => recu.push(p))
    await tick()
    assert.deepEqual(recu, [{ n: 3 }, { n: 4 }], '1 et 2 sont tombés de l\'anneau (capacité 2)')
    s.destroy(); await app.stop()
  })

  it('d. le membre DÉJÀ présent ne reçoit pas de doublon d\'historique (seul le nouvel arrivant)', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(5)

    const µA = makeClient(transport); const sA = µA.socket('memory://hd-a')
    const recuA: any[] = []
    sA.connect(); sA.room('chat').on('msg', (p: any) => recuA.push(p))
    await tick()

    app.room('chat').send('chat/msg', { n: 1 })
    app.room('chat').send('chat/msg', { n: 2 })
    await tick()
    assert.deepEqual(recuA, [{ n: 1 }, { n: 2 }], 'A reçoit le LIVE normalement')

    const µB = makeClient(transport); const sB = µB.socket('memory://hd-b')
    const recuB: any[] = []
    sB.connect(); sB.room('chat').on('msg', (p: any) => recuB.push(p))
    await tick()

    assert.deepEqual(recuB, [{ n: 1 }, { n: 2 }], 'B (nouvel arrivant) reçoit l\'historique complet')
    assert.deepEqual(recuA, [{ n: 1 }, { n: 2 }], 'A (déjà membre) INCHANGÉ — aucun replay/doublon pour lui')
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('e. salon vidé → journal purgé (un nouvel arrivant après purge ne voit rien)', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(5)

    const µA = makeClient(transport); const sA = µA.socket('memory://he-a')
    sA.connect(); sA.room('chat'); await tick()
    app.room('chat').send('chat/msg', { n: 1 })
    await tick()
    assert.equal(app.room('chat').size, 1)

    sA.destroy(); await tick()   // dernier membre parti → salon vidé → historique purgé avec lui
    assert.equal(app.room('chat').size, 0)

    const µB = makeClient(transport); const sB = µB.socket('memory://he-b')
    const recuB: any[] = []
    sB.connect(); sB.room('chat').on('msg', (p: any) => recuB.push(p))
    await tick()
    assert.deepEqual(recuB, [], 'le journal a disparu avec le salon vide — pas un vestige')
    sB.destroy(); await app.stop()
  })

  it('f. history n\'affecte pas la présence/kick (un kick marche toujours)', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(5)
    app.room('chat').send('chat/msg', { n: 1 })

    const µ = makeClient(transport); const s = µ.socket('memory://hf')
    let leftReason: any = null
    s.connect(); const salon = s.room('chat'); salon.onLeft((r: any) => { leftReason = r })
    await tick()
    assert.equal(app.room('chat').size, 1)

    const cible = Array.from(app.clients)[0]
    app.room('chat').kick(cible, 'triche')
    await tick()
    assert.equal(leftReason, 'triche')
    assert.equal(app.room('chat').size, 0)
    assert.equal(app.room('chat').has(cible), false)
    assert.equal(s.state, 'open', 'kick de SALON ≠ fermeture — la connexion reste ouverte, history n\'y change rien')
    s.destroy(); await app.stop()
  })

  it('g. deux salons, l\'un avec history l\'autre sans → isolés', async () => {
    const { transport, app } = await startApp()
    app.room('avec-histo').history(5)
    app.room('avec-histo').send('avec-histo/msg', { n: 1 })
    app.room('sans-histo').send('sans-histo/msg', { n: 1 })   // jamais historisé — pas de history() pour ce salon

    const µ = makeClient(transport); const s = µ.socket('memory://hg')
    const recuAvec: any[] = []; const recuSans: any[] = []
    s.connect()
    s.room('avec-histo').on('msg', (p: any) => recuAvec.push(p))
    s.room('sans-histo').on('msg', (p: any) => recuSans.push(p))
    await tick()
    assert.deepEqual(recuAvec, [{ n: 1 }], 'salon avec history() : rattrapage')
    assert.deepEqual(recuSans, [], 'salon SANS history() : isolé, aucune fuite du journal du voisin')
    s.destroy(); await app.stop()
  })

  it('h. reset/history(0) purge', async () => {
    const { transport, app } = await startApp()
    app.room('chat').history(5)
    app.room('chat').send('chat/msg', { n: 1 })
    app.room('chat').history(0)   // purge explicite — indépendante d'un salon qui se vide

    const µ = makeClient(transport); const s = µ.socket('memory://hh')
    const recu: any[] = []
    s.connect(); s.room('chat').on('msg', (p: any) => recu.push(p))
    await tick()
    assert.deepEqual(recu, [], 'history(0) a purgé le journal avant même ce join')
    s.destroy(); await app.stop()
  })
})
