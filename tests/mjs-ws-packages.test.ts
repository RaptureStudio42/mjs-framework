// Tests des paquets activables (src/mjs-ws/packages.ts) — mécanisme de
// COMPOSITION serveur au-dessus de mjsWs()/mjs-server() (« regrouper les briques
// en paquets activables qui marchent ensemble », symétrique CÔTÉ SERVEUR des préréglages
// `runtime` déjà livrés côté CLIENT). Ceci pose l'INTERFACE (MjsPackage, definirPaquet,
// app.use) + un exemple de référence (paquetEcho) — PAS les paquets applicatifs
// (chat, comptes, lobby : tests à part). MÊME technique que tests/mjs-ws-core.test.ts (vrai
// client µ.socket, MemoryTransport).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, definePackage, echoPackage } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { mjsServer } from '../src/mjs-server/index.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsServerApp } from '../src/mjs-server/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// même stub minimal que tests/mjs-ws-core.test.ts — µ.state non réactif (simple copie) : ces
// tests portent sur app.use, pas sur la réactivité MJS.
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

// même patron que tests/mjs-server-core.test.ts::startApp — identité = hello.auth TEL QUEL
async function startMjsServerApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsServerApp }> {
  const transport = new MemoryTransport()
  const app = mjsServer({ transport, heartbeat: 0, auth: (hello: any) => hello.auth, ...opts })
  await app.listen()
  return { transport, app }
}

// connecte un vrai client µ.socket et renvoie sa fonction request() — le handler d'un paquet
// n'est prouvé que par un aller-retour PROTOCOLE réel, pas par une lecture interne de servers.
async function connectRequest(transport: MemoryTransport, url: string): Promise<(type: string, p?: unknown) => Promise<any>> {
  const µ = makeClient(transport)
  const s = µ.socket(url, { reconnect: { enabled: false } })
  s.connect()
  await tick()
  return (type: string, p?: unknown) => s.request(type, p)
}

describe('MJS-WS — paquets activables (app.use, MjsPackage, definirPaquet)', () => {
  it('1. app.use(paquetEcho()) — un vrai client request(\'echo\', {x:1}) reçoit {x:1}', async () => {
    const { transport, app } = await startApp()
    app.use(echoPackage())
    const request = await connectRequest(transport, 'memory://pkg1')
    const res = await request('echo', { x: 1 })
    assert.deepEqual(res, { x: 1 })
    await app.stop()
  })

  it('2. chaînage — app.use(a).use(b) renvoie l\'app, les deux handlers marchent', async () => {
    const { transport, app } = await startApp()
    const paquetA = definePackage('a', a => a.serve('a', (p: any) => ({ ...p, via: 'a' })))
    const paquetB = definePackage('b', a => a.serve('b', (p: any) => ({ ...p, via: 'b' })))
    const returned = app.use(paquetA).use(paquetB)
    assert.equal(returned, app, 'use() retourne bien app (chaînable)')
    const request = await connectRequest(transport, 'memory://pkg2')
    assert.deepEqual(await request('a', { n: 1 }), { n: 1, via: 'a' })
    assert.deepEqual(await request('b', { n: 2 }), { n: 2, via: 'b' })
    await app.stop()
  })

  it('3. double installation du même nom — un seul enregistrement, warn émis, pas de crash', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { transport, app } = await startApp({ onLog: (level, message) => { logs.push({ level, message }) } })
    assert.doesNotThrow(() => { app.use(echoPackage()).use(echoPackage()) })
    const warns = logs.filter(l => l.level === 'warn')
    assert.equal(warns.length, 1, 'une seule alerte pour la 2e installation (même nom)')
    assert.ok(/echo/.test(warns[0].message))
    const request = await connectRequest(transport, 'memory://pkg3')
    assert.deepEqual(await request('echo', { ok: true }), { ok: true })   // marche quand même, une seule fois
    await app.stop()
  })

  it('4. definirPaquet(nom, installer) — installable et fonctionnel', async () => {
    const { transport, app } = await startApp()
    const paquetPing = definePackage('ping', a => a.serve('ping', () => ({ pong: true })))
    app.use(paquetPing)
    const request = await connectRequest(transport, 'memory://pkg4')
    assert.deepEqual(await request('ping', {}), { pong: true })
    await app.stop()
  })

  it('5. MJS-Server hérite de app.use — installe et fonctionne sur une app MJS-Server', async () => {
    const { transport, app } = await startMjsServerApp()
    assert.equal(typeof app.use, 'function')
    app.use(echoPackage())
    const µ = makeClient(transport)
    const s = µ.socket('memory://pkg5', { auth: () => ({ id: 'x' }), reconnect: { enabled: false } })
    s.connect(); await tick()
    const res = await s.request('echo', { ok: 1 })
    assert.deepEqual(res, { ok: 1 })
    await app.stop()
  })
})
