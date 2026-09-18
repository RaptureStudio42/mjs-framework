// le plafond limits.maxConnectionsPerIp (core.ts) se fonde sur remoteInfo.address, jamais normalisée
// — une connexion IPv4 sur un bind dual-stack (host par défaut) arrive systématiquement
// en « ::ffff:a.b.c.d », jamais sous sa forme nue. normalizeRemoteAddress() (transport.ts) retire
// CE préfixe, aux DEUX points d'entrée (transport-ws.ts/transport-uws.ts) — jamais une adresse
// IPv6 NATIVE (« ::1 »), qui n'est PAS la « même » IP qu'une IPv4 au sens réseau (résiduel connu,
// non traité ici : un attaquant multipliant les adresses littérales d'un préfixe IPv6 routé).
//
// uWebSockets.js ABSENT de node_modules : transport-uws.ts prouvé par un FAUX module
// minimal (seul le point d'entrée `upgrade` nous intéresse ici), symétrie de CODE avec
// transport-ws.ts confirmée par `npm run typecheck`, jamais par un socket natif réel.
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { normalizeRemoteAddress } from '../src/mjs-ws/transport.js'
import { WsTransport } from '../src/mjs-ws/transport-ws.js'
import { UwsTransport } from '../src/mjs-ws/transport-uws.js'
import type { MjsWsConnection } from '../src/mjs-ws/transport.js'
import type { UwsModule, UwsTemplatedApp, UwsWebSocketBehavior } from '../src/mjs-ws/transport-uws.js'

function portOf(transport: WsTransport): number {
  const adresse = (transport as any)._wss.address()
  assert.ok(adresse && typeof adresse.port === 'number', 'le serveur doit être lié avant de lire son port')
  return adresse.port
}

function connectReal(url: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// ============================================================================================
// cœur pur — normalizeRemoteAddress()
// ============================================================================================

describe('mjs-ws/transport — normalizeRemoteAddress()', () => {
  it("« ::ffff:a.b.c.d » (IPv4 mappée) → « a.b.c.d »", () => {
    assert.equal(normalizeRemoteAddress('::ffff:127.0.0.1'), '127.0.0.1')
  })

  it('préfixe insensible à la casse (« ::FFFF: »)', () => {
    assert.equal(normalizeRemoteAddress('::FFFF:10.0.0.5'), '10.0.0.5')
  })

  it("adresse IPv6 NATIVE (« ::1 ») jamais réécrite — pas la « même » IP que 127.0.0.1", () => {
    assert.equal(normalizeRemoteAddress('::1'), '::1')
  })

  it('adresse IPv6 native routée quelconque — inchangée', () => {
    assert.equal(normalizeRemoteAddress('2001:db8::1'), '2001:db8::1')
  })

  it('adresse IPv4 déjà nue — inchangée', () => {
    assert.equal(normalizeRemoteAddress('192.168.1.1'), '192.168.1.1')
  })

  it("undefined (transport qui n'expose pas d'adresse, ex. MemoryTransport) → undefined", () => {
    assert.equal(normalizeRemoteAddress(undefined), undefined)
  })
})

// ============================================================================================
// transport-ws.ts — connexion RÉELLE, bind dual-stack par défaut (host ABSENT)
// ============================================================================================

describe('mjs-ws/transport-ws — remoteInfo.address normalisée (connexion RÉELLE)', () => {
  it('une connexion via 127.0.0.1 sur un bind dual-stack expose « 127.0.0.1 » (jamais « ::ffff:127.0.0.1 »)', async () => {
    const transport = new WsTransport({ port: 0 })   // host ABSENT — bind par défaut (dual-stack)
    const addresses: (string | undefined)[] = []
    transport.onConnection((conn: MjsWsConnection) => { addresses.push(conn.remoteInfo.address); conn.onMessage = () => {} })
    await transport.start()
    const port = portOf(transport)
    try {
      const c1 = await connectReal(`ws://127.0.0.1:${port}/`)
      await new Promise(r => setTimeout(r, 100))
      assert.equal(addresses[0], '127.0.0.1', `AVANT le fix : '::ffff:127.0.0.1' — reçu ${JSON.stringify(addresses[0])}`)
      c1.close()
      await new Promise(r => setTimeout(r, 50))
    } finally {
      await transport.stop()
    }
  })

  it("une connexion IPv6 native (« [::1] ») expose « ::1 » — jamais réécrite en 127.0.0.1", async () => {
    const transport = new WsTransport({ port: 0 })
    const addresses: (string | undefined)[] = []
    transport.onConnection((conn: MjsWsConnection) => { addresses.push(conn.remoteInfo.address); conn.onMessage = () => {} })
    await transport.start()
    const port = portOf(transport)
    try {
      const c1 = await connectReal(`ws://[::1]:${port}/`)
      await new Promise(r => setTimeout(r, 100))
      assert.equal(addresses[0], '::1', `reçu ${JSON.stringify(addresses[0])}`)
      c1.close()
      await new Promise(r => setTimeout(r, 50))
    } finally {
      await transport.stop()
    }
  })
})

// ============================================================================================
// transport-uws.ts — symétrie de CODE (FAUX module minimal, package uWS absent)
// ============================================================================================

function strToArrayBuffer(s: string): ArrayBuffer { return new TextEncoder().encode(s).buffer }

/** FAUX module uWebSockets.js MINIMAL — seul le point d'entrée `upgrade` nous intéresse ici : on
 *  capture le userData posé par res.upgrade() et on y lit remoteInfo.address. */
function makeFakeUwsModuleForAddress(remoteAddress: string): { module: UwsModule; upgrade: () => Record<string, unknown> } {
  let behavior: UwsWebSocketBehavior | null = null
  let capturedUserData: Record<string, unknown> | null = null
  const app: UwsTemplatedApp = {
    ws(_pattern: string, b: UwsWebSocketBehavior) { behavior = b; return app },
    listen(...args: any[]) { const cb = args[args.length - 1]; queueMicrotask(() => cb({} as any)); return app },
    listen_unix(cb: (t: any) => void) { queueMicrotask(() => cb({} as any)); return app },
  } as any
  const module: UwsModule = { App: () => app, us_listen_socket_close: () => {} }
  return {
    module,
    upgrade(): Record<string, unknown> {
      const req = { getHeader: () => '', forEach: () => {} }
      const res = { upgrade: (ud: any) => { capturedUserData = ud }, getRemoteAddressAsText: () => strToArrayBuffer(remoteAddress) }
      behavior!.upgrade!(res as any, req as any, {})
      return capturedUserData as Record<string, unknown>
    },
  }
}

describe('mjs-ws/transport-uws — remoteInfo.address normalisée (symétrie stricte avec transport-ws — uWebSockets.js ABSENT, typecheck fait foi)', () => {
  it("« ::ffff:127.0.0.1 » (getRemoteAddressAsText) → remoteInfo.address = « 127.0.0.1 »", async () => {
    const fake = makeFakeUwsModuleForAddress('::ffff:127.0.0.1')
    const transport = new UwsTransport({ uwsModule: fake.module, port: 9999 })
    await transport.start()
    try {
      const userData = fake.upgrade()
      assert.equal((userData.remoteInfo as any).address, '127.0.0.1')
    } finally {
      await transport.stop()
    }
  })

  it("« ::1 » (IPv6 native) → remoteInfo.address = « ::1 », jamais réécrite", async () => {
    const fake = makeFakeUwsModuleForAddress('::1')
    const transport = new UwsTransport({ uwsModule: fake.module, port: 9999 })
    await transport.start()
    try {
      const userData = fake.upgrade()
      assert.equal((userData.remoteInfo as any).address, '::1')
    } finally {
      await transport.stop()
    }
  })
})
