// Tests du plafond de salons par client (limits.maxRoomsPerClient) et de la garde de présence
// optionnelle (rooms.canSeePresence) — 2 défauts de rooms.ts :
// (a) CRITIQUE — un client authentifié pouvait rejoindre un nombre ILLIMITÉ de salons à noms
// arbitraires (`clientRooms`, rooms.ts, grossit sans borne, tenue jusqu'à déconnexion) dès lors
// qu'AUCUNE garde `join` n'est configurée (défaut historique : tout accepté) — fuite mémoire.
// (b) MAJEUR — la présence d'un salon était lisible via µ:sub-presence SANS AUCUNE autorisation,
// contrairement à `join` : un client pouvait voir membres+méta d'un salon qu'un `join` lui
// refuserait. Même technique que tests/mjs-ws-rooms-streams.test.ts (MemoryTransport + vrai client
// µ.socket pour le plafond, client BRUT pour la présence — seule façon de prouver qu'AUCUNE trame
// µ:presence n'a été émise, cf. son commentaire sur rawClient).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, DEFAULT_LIMITS } from '../src/mjs-ws/index.js'
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
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// client BRUT (sans µ.socket) : parle le protocole à la main — seule façon de prouver qu'une
// trame µ:presence n'a PAS été émise (un store réactif masquerait l'absence derrière un état qui
// ne bouge simplement pas, moins direct qu'un comptage exact des trames reçues)
async function rawClient(transport: MemoryTransport, url: string): Promise<{ ws: any; frames: string[]; send: (o: any) => void }> {
  const ws = transport.connect({ url })
  const frames: string[] = []
  ws.onmessage = (ev: any) => frames.push(ev.data)
  await tick()
  ws.send(JSON.stringify({ t: 'µ:hello', p: { protocol: 1, resub: [], rooms: [] } }))
  await tick()
  return { ws, frames, send: (o: any) => ws.send(JSON.stringify(o)) }
}

// ============================================================================================
// (a) CRITIQUE — plafond de salons par client (limits.maxRoomsPerClient)
// ============================================================================================

describe('MJS-WS — plafond de salons par client (limits.maxRoomsPerClient)', () => {
  it('DEFAULT_LIMITS.maxRoomsPerClient = 50 (généreux, CHANGEMENT DE COMPORTEMENT ASSUMÉ)', () => {
    assert.equal(DEFAULT_LIMITS.maxRoomsPerClient, 50)
  })

  it('cap=2 : les 2 premiers join passent, le 3e est refusé (µ:error « trop de salons »), aucune entrée créée', async () => {
    const { transport, app } = await startApp({ limits: { maxRoomsPerClient: 2 } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://cap1')
    s.connect(); await tick()

    s.room('a'); await tick()
    s.room('b'); await tick()
    assert.equal(app.room('a').size, 1)
    assert.equal(app.room('b').size, 1)
    assert.equal(s.lastError, null, 'les 2 premiers joins (cap = 2) ne doivent déclencher aucune erreur')

    s.room('c'); await tick()
    assert.equal(app.room('c').size, 0, 'le 3e salon (au-delà du plafond) ne doit avoir AUCUN membre — rien créé')
    assert.ok(s.lastError && /trop de salons/.test(s.lastError.message), 'µ:error côté client, message « trop de salons »')

    // libère un slot (leave) — un nouveau salon doit alors passer : la garde borne le NOMBRE
    // courant, ce n'est pas un blocage définitif de la connexion
    s.room('a').leave(); await tick()
    s.room('d'); await tick()
    assert.equal(app.room('d').size, 1, 'un salon libéré rouvre un slot sous le plafond')

    s.destroy(); await app.stop()
  })

  it('null = illimité (opt-out explicite) — plus de 50 salons (le défaut) passent tous', async () => {
    const { transport, app } = await startApp({ limits: { maxRoomsPerClient: null, rate: 200, burst: 200 } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://cap2')
    s.connect(); await tick()

    for (let i = 0; i < 55; i++) s.room('r' + i)
    await tick()
    for (let i = 0; i < 55; i++) assert.equal(app.room('r' + i).size, 1, `salon r${i} doit être rejoint (plafond désactivé)`)
    assert.equal(s.lastError, null)

    s.destroy(); await app.stop()
  })

  it('comportement historique : aucune limite configurée (défaut 50) — un usage normal (5 salons) n\'est jamais impacté', async () => {
    const { transport, app } = await startApp()   // aucun `limits` — DEFAULT_LIMITS pur (50)
    const µ = makeClient(transport)
    const s = µ.socket('memory://cap3')
    s.connect(); await tick()
    for (let i = 0; i < 5; i++) s.room('x' + i)
    await tick()
    for (let i = 0; i < 5; i++) assert.equal(app.room('x' + i).size, 1)
    assert.equal(s.lastError, null)
    s.destroy(); await app.stop()
  })
})

// ============================================================================================
// (b) MAJEUR — garde de présence optionnelle (rooms.canSeePresence)
// ============================================================================================

describe('MJS-WS — garde de présence optionnelle (rooms.canSeePresence)', () => {
  it('hook renvoyant false → µ:sub-presence refusé (µ:error), AUCUN instantané µ:presence', async () => {
    const { transport, app } = await startApp({ rooms: { canSeePresence: (room: string) => room !== 'vip' } })
    const brut = await rawClient(transport, 'memory://pres1')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: { room: 'vip' } })
    await tick()
    const msgs = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs.length, 1, 'une seule trame : le refus — pas de µ:presence en plus')
    assert.equal(msgs[0].t, 'µ:error')
    assert.ok(/présence/.test(msgs[0].p.message))
    assert.ok(!msgs.some(m => m.t === 'µ:presence'), 'aucun instantané renvoyé')

    // salon ouvert (hook renvoie true) : abonnement normal, non affecté par le refus précédent
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: { room: 'public' } })
    await tick()
    const msgs2 = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs2.length, 1)
    assert.equal(msgs2[0].t, 'µ:presence')
    assert.equal(msgs2[0].p.op, 'reset')

    await app.stop()
  })

  // le message qui atteint le client est GÉNÉRIQUE depuis le correctif — MÊME contrat que
  // onMessage (chat.ts) : le détail de l'exception ('explosé') ne
  // quitte JAMAIS le serveur, cf. tests/rooms-join-cansee-leak.test.ts pour la preuve dédiée.
  it('hook qui throw → même refus GÉNÉRIQUE (µ:error), jamais le détail interne, aucun crash', async () => {
    const { transport, app } = await startApp({ rooms: { canSeePresence: () => { throw new Error('explosé') } } })
    const brut = await rawClient(transport, 'memory://pres1b')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: { room: 'zone' } })
    await tick()
    const msgs = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].t, 'µ:error')
    assert.ok(!/explosé/.test(msgs[0].p.message), 'le détail interne ne doit JAMAIS atteindre le client')
    assert.equal(msgs[0].p.message, t('ws.rooms.acces-presence-refuse'), 'même message générique que le refus explicite (false)')
    await app.stop()
  })

  it('hook async (Promise<boolean>) → attend la résolution avant de trancher', async () => {
    let release: ((v: boolean) => void) | null = null
    const { transport, app } = await startApp({ rooms: { canSeePresence: () => new Promise<boolean>(r => { release = r }) } })
    const brut = await rawClient(transport, 'memory://pres3')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: { room: 'zone' } })
    await tick()
    assert.equal(brut.frames.length, 0, 'aucune réponse tant que la garde async ne résout pas')

    release!(true)
    await tick()
    const msgs = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].t, 'µ:presence')
    await app.stop()
  })

  it('hook ABSENT → présence de salon ouverte comme avant (NON-RÉGRESSION, comportement historique inchangé)', async () => {
    const { transport, app } = await startApp()   // aucun rooms.canSeePresence
    const brut = await rawClient(transport, 'memory://pres2')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: { room: 'zone' } })
    await tick()
    const msgs = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].t, 'µ:presence')
    assert.equal(msgs[0].p.op, 'reset')
    assert.deepEqual(msgs[0].p.peers, {})
    await app.stop()
  })

  it('canSeePresence n\'affecte JAMAIS la présence GLOBALE (room absent) — même un hook qui refuse tout salon', async () => {
    const { transport, app } = await startApp({ rooms: { canSeePresence: () => false } })
    const brut = await rawClient(transport, 'memory://pres4')
    brut.frames.length = 0
    brut.send({ t: 'µ:sub-presence', p: {} })   // pas de room → présence GLOBALE
    await tick()
    const msgs = brut.frames.map(f => JSON.parse(f))
    assert.equal(msgs.length, 1)
    assert.equal(msgs[0].t, 'µ:presence', 'la présence globale ignore canSeePresence — structurellement hors salon')
    assert.equal(msgs[0].p.op, 'reset')
    assert.equal(Object.keys(msgs[0].p.peers).length, 1, 'le client brut lui-même (seul authentifié)')
    await app.stop()
  })
})
