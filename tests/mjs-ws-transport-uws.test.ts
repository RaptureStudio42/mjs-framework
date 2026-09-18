// Tests de l'adaptateur uWebSockets.js (src/mjs-ws/transport-uws.ts) — façade
// transport ouverte. Trois niveaux : (a) FAUX module uWS injecté (mini-implémentation
// App/ws EN MÉMOIRE définie ci-dessous, aucun socket réseau réel) → boucle complète avec le
// VRAI client µ.socket (même technique que tests/mjs-ws-cli.test.ts), backpressure simulée,
// maxPayload/idleTimeout câblés, drapeau anti-usage-après-close ; (b) mjs-ws/index.ts —
// resolveTransport (chaîne 'ws'/'uws'/instance/invalide) ; (c) mjs.config.json — ws.transport
// (validation stricte, patron ws.*) ; (d) SMOKE RÉEL contre le VRAI paquet uWebSockets.js SI
// résolu (MJS_UWS_PATH ou node_modules/uWebSockets.js local, sinon SAUTÉ, rapporté).

import assert from 'node:assert/strict'
import { writeFileSync, readFileSync, rmSync, existsSync, statSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { mjsWs, resolveTransport, WsTransport, MemoryTransport, DEFAULT_LIMITS } from '../src/mjs-ws/index.js'
import { UwsTransport } from '../src/mjs-ws/transport-uws.js'
import type { MjsWsConnection } from '../src/mjs-ws/transport.js'
import { findConfig } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// dossiers temporaires créés par ce fichier — nettoyés une seule fois à la fin (jamais de
// fixture dans le dépôt, cf. feedback_scratch_cleanup_glob_precision)
const tmpDirs: string[] = []
function freshDir(prefix: string): string {
  const d = mjsTmp(prefix)
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

// ============================================================================================
// FAUX module uWebSockets.js — mini App/ws EN MÉMOIRE (aucun socket réseau) : reproduit
// UNIQUEMENT la forme consommée par transport-uws.ts (App().ws('/*', {upgrade, open, message,
// close, drain, maxPayloadLength, idleTimeout}), listen(), us_listen_socket_close(),
// ws.send/getBufferedAmount/end/getUserData) — assez pour exercer la boucle complète avec le
// VRAI client µ.socket, backpressure comprise, sans jamais toucher un vrai réseau.
// ============================================================================================

function strToArrayBuffer(s: string): ArrayBuffer {
  return new TextEncoder().encode(s).buffer
}

/** bout CÔTÉ CLIENT — même surface que MemoryClientSocket (transport.ts) : ce que `new
 *  WebSocket(url, protocols)` doit renvoyer pour que le VRAI client µ.socket morde dessus. */
class FakeClientSocket {
  static readonly CONNECTING = 0
  static readonly OPEN       = 1
  static readonly CLOSING    = 2
  static readonly CLOSED     = 3

  readyState = FakeClientSocket.CONNECTING
  bufferedAmount = 0
  url: string
  protocol: string
  onopen: (() => void) | null = null
  onmessage: ((ev: { data: string }) => void) | null = null
  onclose: ((ev: { code: number; reason: string }) => void) | null = null
  onerror: (() => void) | null = null

  _server: FakeUwsSocket | null = null

  constructor(url: string, protocols?: string | string[]) {
    this.url      = url
    this.protocol = Array.isArray(protocols) ? (protocols[0] ?? '') : (protocols ?? '')
  }

  _open(): void {
    if (this.readyState !== FakeClientSocket.CONNECTING) return
    this.readyState = FakeClientSocket.OPEN
    if (this.onopen) this.onopen()
  }

  send(data: string): void {
    if (this.readyState !== FakeClientSocket.OPEN) throw new Error('[fake uws] send() sur un WebSocket non ouvert')
    const server = this._server
    queueMicrotask(() => { if (server) server._fromClient(data) })
  }

  close(code = 1000, reason = ''): void {
    if (this.readyState === FakeClientSocket.CLOSED) return
    this.readyState = FakeClientSocket.CLOSED
    if (this.onclose) this.onclose({ code, reason })
    const server = this._server
    queueMicrotask(() => { if (server) server._fromClientClose(code, reason) })
  }

  _receiveServerClose(code: number, reason: string): void {
    if (this.readyState === FakeClientSocket.CLOSED) return
    this.readyState = FakeClientSocket.CLOSED
    if (this.onclose) this.onclose({ code, reason })
  }
}

/** bout SERVEUR d'une connexion — implémente la forme `UwsWebSocket` attendue par transport-uws.ts.
 *  `poisoned` simule le PIÈGE MAJEUR réel (uWS) : toute méthode jetée APRÈS fermeture — si
 *  l'adaptateur oubliait son drapeau `_closed`, ce faux module « planterait » (throw) exactement
 *  comme le process entier plante en vrai. */
class FakeUwsSocket {
  bufferedAmount = 0   // piloté par le test (backpressure simulée) — pas un vrai calcul réseau
  poisoned = false

  constructor(private _client: FakeClientSocket, private _userData: any, private _behavior: any) {}

  send(message: string, _isBinary?: boolean): number {
    if (this.poisoned) throw new Error('[fake uws] send() après close — en VRAI uWS, ceci plante le process entier')
    const client = this._client
    queueMicrotask(() => { if (client.readyState === FakeClientSocket.OPEN && client.onmessage) client.onmessage({ data: message }) })
    return 1
  }

  getBufferedAmount(): number {
    if (this.poisoned) throw new Error('[fake uws] getBufferedAmount() après close — en VRAI uWS, ceci plante le process entier')
    return this.bufferedAmount
  }

  end(code?: number, reason?: string): void {
    if (this.poisoned) return   // idempotent — même comportement que le drapeau _closed du vrai adaptateur
    this.poisoned = true
    const client   = this._client
    const behavior = this._behavior
    queueMicrotask(() => {
      client._receiveServerClose(code ?? 1000, reason ?? '')
      behavior.close?.(this, code ?? 1000, strToArrayBuffer(reason ?? ''))
    })
  }

  getUserData(): any { return this._userData }

  _fromClient(data: string): void {
    if (this.poisoned) return
    this._behavior.message?.(this, strToArrayBuffer(data), false)
  }

  /** trame BINAIRE — simule FIDÈLEMENT le piège réel d'uWS : le buffer natif livré
   *  au rappel `message` est écrasé (rempli à 0xff) JUSTE APRÈS le retour du rappel — si
   *  transport-uws.ts n'avait pas copié AVANT de rappeler onMessage (cf. son PIÈGE #2), les
   *  octets déjà transmis en aval seraient corrompus. `bytes` doit être un Uint8Array FRAIS
   *  (byteOffset 0, buffer non partagé) — un littéral `new Uint8Array([...])` suffit toujours. */
  _fromClientBinary(bytes: Uint8Array): void {
    if (this.poisoned) return
    const buf = bytes.buffer as ArrayBuffer
    this._behavior.message?.(this, buf, true)
    new Uint8Array(buf).fill(0xff)
  }

  _fromClientClose(code: number, reason: string): void {
    if (this.poisoned) return
    this.poisoned = true
    this._behavior.close?.(this, code, strToArrayBuffer(reason))
  }
}

interface FakeConnectOpts { url?: string; protocols?: string | string[]; origin?: string; headers?: Record<string, string>; remoteAddress?: string }

/** Fabrique un faux module `uWebSockets.js` — une instance par test (aucun état partagé). */
function makeFakeUwsModule(opts: { unixFails?: boolean; unixVanishes?: boolean } = {}) {
  let behavior: any = null
  const tcpCalls: any[][]  = []
  const unixCalls: string[] = []
  const closed: any[]       = []
  const app: any = {
    ws(_pattern: string, b: any) { behavior = b; return app },
    listen(...args: any[]) {
      tcpCalls.push(args.slice(0, -1))
      const cb = args[args.length - 1]
      queueMicrotask(() => cb({ _fakeToken: true }))
      return app
    },
    // ARGUMENTS INVERSÉS (rappel D'ABORD) — même signature que le vrai uWS. Le fichier est VRAIMENT
    // écrit : c'est ce que le noyau fait au bind, et c'est la seule façon que le chmod de
    // transport-uws.ts porte sur quelque chose. Un chmod avalé par un faux ne prouverait rien.
    listen_unix(cb: (token: any) => void, path: string) {
      unixCalls.push(path)
      queueMicrotask(() => {
        if (opts.unixFails) { cb(false); return }
        writeFileSync(path, '')
        // `unixVanishes` : le bind réussit mais le fichier disparaît juste après — le seul moyen
        // déterministe de faire échouer le chmod sans dépendre des droits de la machine d'essai
        if (opts.unixVanishes) rmSync(path, { force: true })
        cb({ _fakeToken: true })
      })
      return app
    },
  }
  return {
    App() { return app },
    us_listen_socket_close(token: any) { closed.push(token) },
    /** accroche de TEST — ce que le transport a demandé, et par quelle porte */
    _tcpCalls(): any[][] { return tcpCalls },
    _unixCalls(): string[] { return unixCalls },
    _closes(): any[] { return closed },
    /** accroche de TEST — inspecte le behavior capturé (maxPayloadLength/idleTimeout) */
    _behavior(): any { return behavior },
    /** accroche de TEST — simule un client qui se connecte (upgrade → open), retourne le bout CLIENT */
    _connectClient(opts: FakeConnectOpts = {}): FakeClientSocket {
      if (!behavior) throw new Error('[fake uws] _connectClient() avant app.ws()')
      const headers = opts.headers ?? {}
      const req = {
        getHeader: (k: string) => (k === 'origin' ? (opts.origin ?? '') : (headers[k] ?? '')),
        forEach: (cb: (k: string, v: string) => void) => {
          if (opts.origin) cb('origin', opts.origin)
          for (const k of Object.keys(headers)) cb(k, headers[k])
        },
      }
      let userData: any = null
      // getRemoteAddressAsText — MÊME forme que le VRAI uWS (ArrayBuffer
      // TEXTE, cf. transport-uws.ts) : IP configurable par test (opts.remoteAddress), défaut
      // '127.0.0.1' (les tests existants ne l'inspectent pas, juste une valeur plausible).
      const res = { upgrade: (ud: any) => { userData = ud }, getRemoteAddressAsText: () => strToArrayBuffer(opts.remoteAddress ?? '127.0.0.1') }
      behavior.upgrade?.(res, req, {})
      if (!userData) userData = {}

      const client = new FakeClientSocket(opts.url ?? 'fake-uws://test', opts.protocols)
      const server = new FakeUwsSocket(client, userData, behavior)
      client._server = server
      queueMicrotask(() => {
        behavior.open?.(server)
        client._open()
      })
      return client
    },
  }
}

// --- même technique que tests/mjs-ws-cli.test.ts : VRAI client µ.socket, branché ICI sur le faux uWS ---
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

/** branche `globalThis.WebSocket` sur le faux module — expose aussi le dernier bout SERVEUR
 *  connecté (getLastServer), utile pour piloter bufferedAmount depuis le test (backpressure). */
function makeClient(fakeUws: ReturnType<typeof makeFakeUwsModule>): { µ: any; getLastServer: () => FakeUwsSocket } {
  let lastClient: FakeClientSocket | null = null
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    lastClient = fakeUws._connectClient({ url, protocols })
    return lastClient
  }
  return { µ: makeMu(), getLastServer: () => lastClient!._server! }
}

// ============================================================================================
// (a) paquet absent — message d'erreur exact (ModularJS ne dépend PAS de uWebSockets.js)
// ============================================================================================

describe("mjs-ws/transport-uws — paquet uWebSockets.js absent (aucune injection)", () => {
  it("start() sans uwsModule injecté → rejette avec le message français exact", async () => {
    const transport = new UwsTransport({ port: 9999 })
    await assert.rejects(
      transport.start(),
      (err: any) => {
        assert.equal(err.message, "le paquet uWebSockets.js est requis pour transport: 'uws' — npm install uNetworking/uWebSockets.js#v20.52.0")
        return true
      },
    )
  })
})

// ============================================================================================
// (b) boucle complète (faux module uWS injecté) — VRAI client µ.socket
// ============================================================================================

describe('mjs-ws/transport-uws — boucle complète (faux module uWS injecté, VRAI client µ.socket)', function () {
  this.timeout(10000)

  it("hello→welcome→request→ack à travers l'adaptateur uWS", async () => {
    const fakeUws    = makeFakeUwsModule()
    const transport  = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    const app        = mjsWs({ transport, welcome: () => ({ ok: true }), onLog: () => {} })
    app.serve('ping', () => 'pong')
    await app.listen()
    try {
      const { µ } = makeClient(fakeUws)
      const s = µ.socket('fake-uws://loop-1')
      s.connect()
      await tick()
      assert.equal(s.state, 'open')
      const res = await s.request('ping', {})
      assert.equal(res, 'pong')
      s.destroy()
    } finally {
      await app.stop()
    }
  })

  it("trame binaire à travers l'adaptateur uWS : COPIÉE avant le retour du rappel, octets intacts en aval malgré la réutilisation simulée du buffer natif", async () => {
    const fakeUws    = makeFakeUwsModule()
    const transport  = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    const app        = mjsWs({ transport, onLog: () => {} })
    const received: Uint8Array[] = []
    ;(app as any)._binaryHandler = (_client: any, bytes: Uint8Array) => { received.push(bytes) }
    await app.listen()
    try {
      const { µ, getLastServer } = makeClient(fakeUws)
      const s = µ.socket('fake-uws://binary-1')
      s.connect()
      await tick()
      assert.equal(s.state, 'open')

      const server   = getLastServer()
      const original = new Uint8Array([10, 20, 30, 40, 50])
      server._fromClientBinary(original)   // `original` sera écrasé (0xff) juste après, cf. la méthode
      await tick()

      assert.equal(received.length, 1)
      assert.deepEqual(Array.from(received[0]), [10, 20, 30, 40, 50], 'octets INTACTS malgré la réutilisation simulée du buffer natif juste après le rappel')
      assert.deepEqual(Array.from(original), [255, 255, 255, 255, 255], "confirme que le buffer natif A BIEN été réécrit après coup (le test aurait échoué SANS la copie de transport-uws.ts)")
      s.destroy()
    } finally {
      await app.stop()
    }
  })

  it('maxPayload câblé — UwsTransport pose bien opts.maxPayload en maxPayloadLength (pas le défaut natif uWS, 16 Ko)', async () => {
    // instance construite avec un maxPayload EXPLICITE — simule ce que fait resolveTransport()
    // pour la chaîne 'uws' (cf. le test resolveTransport ci-dessous pour CE câblage-là) : ici on
    // isole la seule responsabilité de l'adaptateur — poser fidèlement l'option reçue sur uWS.
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws, port: 9999, maxPayload: 12345 })
    const app       = mjsWs({ transport, onLog: () => {} })
    await app.listen()
    try {
      assert.equal(fakeUws._behavior().maxPayloadLength, 12345)
    } finally {
      await app.stop()
    }
  })

  it("idleTimeout désactivé (0) — le Watchdog applicatif (heartbeat×2.5, guard.ts) reste SEULE autorité d'inactivité", async () => {
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    const app       = mjsWs({ transport, onLog: () => {} })
    await app.listen()
    try {
      assert.equal(fakeUws._behavior().idleTimeout, 0)
    } finally {
      await app.stop()
    }
  })

  it('backpressure simulée (bufferedAmount élevé) → le videur (core.ts) ignore l\'envoi AVANT tout appel à ws.send()', async () => {
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    const app       = mjsWs({ transport, onLog: () => {} })
    app.on('marco', (p: any, client: any) => app.send(client, 'marco', p))
    await app.listen()
    try {
      const { µ, getLastServer } = makeClient(fakeUws)
      const s = µ.socket('fake-uws://backpressure-1')
      const received: any[] = []
      s.on('marco', (p: any) => received.push(p))
      s.connect()
      await tick()
      assert.equal(s.state, 'open')

      const serverWs = getLastServer()
      // DEFAULT_LIMITS.maxBuffered = 1 048 576 — largement dépassé ici : le pré-check de
      // guard.ts (isBackpressured, appelé par sendRaw AVANT client.conn.send()) doit droper.
      serverWs.bufferedAmount = 10_000_000

      s.send('marco', { hello: 1 })
      await tick(20)

      assert.deepEqual(received, [], 'le message ne doit PAS arriver — bufferedAmount dépasse maxBuffered')
      assert.equal(serverWs.poisoned, false, 'ws.send() ne doit même pas avoir été appelé (sinon il aurait tenté un envoi réel)')
    } finally {
      await app.stop()
    }
  })

  it("close → drapeau (fermeture CÔTÉ APP) : aucune méthode ne re-touche le ws natif après le 1er close", async () => {
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    let conn: MjsWsConnection | null = null
    transport.onConnection((c) => { conn = c })
    await transport.start()
    try {
      fakeUws._connectClient({ url: 'fake-uws://poison-app-1' })
      await tick()
      assert.ok(conn, 'onConnection doit avoir été appelé')

      conn!.close(1000, 'ferme-toi')   // 1er close — licite, pose le drapeau
      await tick()

      // 2e close, send(), lecture de bufferedAmount : si le drapeau `_closed` de UwsConnection
      // n'existait pas, l'un de ces appels rappellerait le ws natif déjà fermé — notre faux uWS
      // JETTERAIT alors (simulation fidèle du crash natif réel) et `assert.doesNotThrow` échouerait.
      assert.doesNotThrow(() => conn!.close(2000, 'deuxième appel'))
      assert.doesNotThrow(() => conn!.send('{"t":"noop"}'))
      assert.doesNotThrow(() => { void conn!.bufferedAmount })
      assert.equal(conn!.bufferedAmount, 0, 'repli sûr (0) après fermeture — plus rien à mettre en attente')
    } finally {
      await transport.stop()
    }
  })

  it("close → drapeau (fermeture CÔTÉ CLIENT / native) : le handler close() de l'adaptateur pose le drapeau AVANT tout re-touche", async () => {
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws, port: 9999 })
    let conn: MjsWsConnection | null = null
    transport.onConnection((c) => { conn = c })
    await transport.start()
    try {
      const client = fakeUws._connectClient({ url: 'fake-uws://poison-native-1' })
      await tick()
      assert.ok(conn)

      client.close(1000, 'le client part')   // déconnexion CÔTÉ CLIENT — jamais conn.close() côté app
      await tick()

      // le handler `close` de l'adaptateur (déclenché ici par la fermeture NATIVE, PAS par un
      // appel applicatif à conn.close()) doit avoir posé `_closed` — mêmes garanties qu'au-dessus.
      assert.doesNotThrow(() => conn!.close(4000, 'après coup'))
      assert.doesNotThrow(() => conn!.send('{"t":"noop"}'))
      assert.equal(conn!.bufferedAmount, 0)
    } finally {
      await transport.stop()
    }
  })
})

// ============================================================================================
// (c) mjs-ws/index.ts — resolveTransport (chaîne 'ws'/'uws'/instance/invalide)
// ============================================================================================

describe("mjs-ws/index — resolveTransport (chaîne 'ws'/'uws'/instance/invalide)", () => {
  it("absent ou 'ws' → WsTransport (défaut)", () => {
    assert.ok(resolveTransport(undefined, undefined, undefined, DEFAULT_LIMITS) instanceof WsTransport)
    assert.ok(resolveTransport('ws', undefined, undefined, DEFAULT_LIMITS) instanceof WsTransport)
  })

  it("'uws' → UwsTransport, construite avec limits.maxPayload déjà résolue (câblage maxPayload, cf. index.ts)", () => {
    const t = resolveTransport('uws', undefined, undefined, { ...DEFAULT_LIMITS, maxPayload: 999 })
    assert.ok(t instanceof UwsTransport)
    // accès à l'option privée à des fins de test UNIQUEMENT — même précédent que
    // `(transport as any)._clients` (core.ts, commentaire de tête de l'adaptateur multi-processus).
    assert.equal((t as any)._opts.maxPayload, 999)
  })

  it('une instance MjsWsTransport déjà construite → utilisée telle quelle (jamais reconstruite)', () => {
    const t = new MemoryTransport()
    assert.equal(resolveTransport(t, undefined, undefined, DEFAULT_LIMITS), t)
  })

  it("chaîne inconnue (ex. faute de frappe) → erreur claire immédiate, jamais un crash différé", () => {
    assert.throws(
      () => resolveTransport('wss' as any, undefined, undefined, DEFAULT_LIMITS),
      /transport invalide : 'wss'.*'ws'.*'uws'/s,
    )
  })
})

// ============================================================================================
// (d) mjs.config.json — section `ws.transport` (validation stricte, MÊME patron que ws.*)
// ============================================================================================

describe('mjs.config.json — ws.transport (validation stricte, patron ws.*)', () => {
  function writeConfig(config: Record<string, unknown>): string {
    const root = freshDir('cfg-ws-transport')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
    return root
  }

  it("accepte 'ws' et 'uws'", () => {
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { transport: 'ws' } })))
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { transport: 'uws' } })))
  })

  it("'wss' (faute plausible) → erreur AVEC suggestion orthographique", () => {
    const root = writeConfig({ ws: { transport: 'wss' } })
    assert.throws(() => findConfig(root), /ws\.transport invalide.*tu voulais dire/s)
  })

  it('valeur hors-sujet (ex. \'redis\') → erreur claire, sans suggestion forcée', () => {
    const root = writeConfig({ ws: { transport: 'redis' } })
    assert.throws(() => findConfig(root), /ws\.transport invalide/)
  })

  it('type non-string (nombre) → erreur claire, jamais une exception Node brute', () => {
    const root = writeConfig({ ws: { transport: 42 } })
    assert.throws(() => findConfig(root), /ws\.transport invalide/)
  })
})

// ============================================================================================
// (d bis) mjs.config.json — section `ws.codec` (µschema — validation stricte, MÊME
// patron que ws.transport ci-dessus)
// ============================================================================================

describe('mjs.config.json — ws.codec (validation stricte, patron ws.*)', () => {
  function writeConfig(config: Record<string, unknown>): string {
    const root = freshDir('cfg-ws-codec')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
    return root
  }

  it("accepte 'auto', 'binary' et 'json'", () => {
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { codec: 'auto' } })))
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { codec: 'binary' } })))
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { codec: 'json' } })))
  })

  it("'binry' (faute plausible) → erreur AVEC suggestion orthographique", () => {
    const root = writeConfig({ ws: { codec: 'binry' } })
    assert.throws(() => findConfig(root), /ws\.codec invalide.*tu voulais dire/s)
  })

  it('type non-string (nombre) → erreur claire, jamais une exception Node brute', () => {
    const root = writeConfig({ ws: { codec: 7 } })
    assert.throws(() => findConfig(root), /ws\.codec invalide/)
  })
})

// ============================================================================================
// (d ter) SOCKET UNIX — option `socketPath`. Le faux module écrit un VRAI fichier au bind : les droits posés par le transport
// sont donc LUS sur le disque, jamais supposés.
// ============================================================================================

describe('mjs-ws/transport-uws — écoute sur une socket unix (socketPath)', () => {
  it('socketPath renseigné → listen_unix sur CE chemin, et pas une seule écoute TCP', async () => {
    const dir       = freshDir('uws-sock')
    const path      = join(dir, 'ws.sock')
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws as any, socketPath: path, port: 9999, host: '127.0.0.1' })
    await transport.start()
    assert.deepEqual(fakeUws._unixCalls(), [path])
    assert.deepEqual(fakeUws._tcpCalls(), [], 'un socketPath ne doit JAMAIS traîner une écoute TCP avec lui')
    assert.equal(existsSync(path), true)
    await transport.stop()
  })

  it('la socket est laissée en 0660 — sans ce chmod, uWS la laisse en 0700 et le proxy ne peut pas entrer', async () => {
    const dir       = freshDir('uws-sock-mode')
    const path      = join(dir, 'ws.sock')
    const transport = new UwsTransport({ uwsModule: makeFakeUwsModule() as any, socketPath: path })
    await transport.start()
    assert.equal(statSync(path).mode & 0o777, 0o660)
    await transport.stop()
  })

  it('socketMode explicite → c\'est LUI qui est posé (0660 n\'est qu\'un défaut, pas une politique câblée)', async () => {
    const dir       = freshDir('uws-sock-mode2')
    const path      = join(dir, 'ws.sock')
    const transport = new UwsTransport({ uwsModule: makeFakeUwsModule() as any, socketPath: path, socketMode: 0o600 })
    await transport.start()
    assert.equal(statSync(path).mode & 0o777, 0o600)
    await transport.stop()
  })

  it('répertoire d\'accueil absent → créé récursivement (un déploiement sur arbre vierge ne bloque pas)', async () => {
    const dir       = freshDir('uws-sock-mkdir')
    const path      = join(dir, 'a', 'b', 'ws.sock')
    const transport = new UwsTransport({ uwsModule: makeFakeUwsModule() as any, socketPath: path })
    await transport.start()
    assert.equal(existsSync(path), true)
    await transport.stop()
  })

  // LE CAS QUI SE PAIE LE PLUS CHER : au-delà de 108 octets le bind rend `false` SANS RIEN DIRE
  // (mesuré au banc sur un chemin de 118 octets). Le compte est fait AVANT, pour que
  // le message nomme la vraie cause au lieu d'un « échec du bind » qu'on cherche une heure.
  // LA BORNE EST 108, PAS 107 : le noyau accepte un chemin qui remplit `sun_path` EXACTEMENT, sans
  // terminateur — 108 se lie et se joint pour de vrai, 109 rend `false` (mesuré deux fois, uWS v20.52.0).
  it('chemin de plus de 108 octets → erreur qui NOMME la longueur, et aucun bind tenté', async () => {
    const fakeUws   = makeFakeUwsModule()
    const path      = '/tmp/' + 'x'.repeat(110) + '.sock'
    const transport = new UwsTransport({ uwsModule: fakeUws as any, socketPath: path })
    await assert.rejects(transport.start(), (err: Error) => {
      assert.match(err.message, /chemin de socket unix trop long \(120 octets, 108 au plus\)/)
      assert.ok(err.message.includes(path), 'le message doit porter le chemin fautif')
      return true
    })
    assert.deepEqual(fakeUws._unixCalls(), [], 'rien ne doit être tenté quand le compte est déjà perdu')
  })

  it('bind refusé (token false) → erreur qui nomme LE CHEMIN, jamais un port', async () => {
    const dir       = freshDir('uws-sock-echec')
    const path      = join(dir, 'ws.sock')
    const transport = new UwsTransport({ uwsModule: makeFakeUwsModule({ unixFails: true }) as any, socketPath: path })
    await assert.rejects(transport.start(), (err: Error) => {
      assert.match(err.message, /échec du bind sur la socket unix/)
      assert.ok(err.message.includes(path))
      // `/port/` nu serait un prédicat MENTEUR : le préfixe `[mjs-ws/transport-uws]` contient déjà
      // « port » (dans « transport ») et le test échouait sur son propre étiquetage. On vise donc la
      // phrase EXACTE du message TCP — la seule qu'il ne faut pas voir apparaître ici
      assert.ok(!/sur le port/.test(err.message), 'un échec de socket unix ne doit pas rendre le message du mode TCP')
      return true
    })
  })

  // LA FUITE TROUVÉE ICI : l'écoute est DÉJÀ ouverte quand le
  // chmod s'exécute. Si le chmod lève, l'exception sort avant que `start()` n'ait retenu le jeton —
  // et plus personne ne peut fermer cette socket native. Le chmod n'est toujours PAS avalé (une
  // socket restée en 0700 est injoignable pour le proxy, et l'avaler serait la panne muette) : on
  // ferme, puis on relève.
  it('chmod impossible → l\'erreur remonte ENTIÈRE, et l\'écoute est refermée (aucun jeton perdu)', async () => {
    const dir       = freshDir('uws-sock-chmod')
    const path      = join(dir, 'ws.sock')
    const fakeUws   = makeFakeUwsModule({ unixVanishes: true })
    const transport = new UwsTransport({ uwsModule: fakeUws as any, socketPath: path })

    await assert.rejects(transport.start(), (err: NodeJS.ErrnoException) => {
      assert.equal(err.code, 'ENOENT', 'l\'erreur du chmod doit remonter telle quelle, jamais maquillée')
      return true
    })
    assert.equal(fakeUws._closes().length, 1, 'l\'écoute ouverte doit être refermée avant que l\'erreur ne sorte')
  })


  // NON-RÉGRESSION — la moitié du contrat : sans socketPath, RIEN ne change pour personne
  it('sans socketPath → écoute TCP, exactement comme avant, et listen_unix jamais appelé', async () => {
    const fakeUws   = makeFakeUwsModule()
    const transport = new UwsTransport({ uwsModule: fakeUws as any, port: 7777, host: '127.0.0.1' })
    await transport.start()
    assert.deepEqual(fakeUws._tcpCalls(), [['127.0.0.1', 7777]])
    assert.deepEqual(fakeUws._unixCalls(), [])
    await transport.stop()
  })
})

// ============================================================================================
// (e) SMOKE RÉEL — VRAI paquet uWebSockets.js, SI résolu (MJS_UWS_PATH ou repli local)
// ============================================================================================

// MJS_UWS_PATH pointe vers le DOSSIER du paquet uWebSockets.js (contenant ESM_wrapper.mjs) ;
// à défaut, repli sur un éventuel node_modules/uWebSockets.js du projet.
const UWS_DIR = process.env.MJS_UWS_PATH ?? join(__dirname, '../node_modules/uWebSockets.js')
const REAL_UWS_ENTRY = join(UWS_DIR, 'ESM_wrapper.mjs')

describe('mjs-ws/transport-uws — SMOKE RÉEL (uWebSockets.js, si présent)', function () {
  this.timeout(15000)

  it('boucle complète avec le VRAI module uWebSockets.js, sur un port éphémère (rapporté — jamais bloquant si le paquet est absent)', async function () {
    if (!existsSync(REAL_UWS_ENTRY)) {
      console.log(`    (uWebSockets.js introuvable (${REAL_UWS_ENTRY}) — smoke réel SAUTÉ, attendu hors de cette machine)`)
      this.skip()
      return
    }
    const realModule = await import(pathToFileURL(REAL_UWS_ENTRY).href)
    const port        = 40000 + Math.floor(Math.random() * 10000)
    const transport   = new UwsTransport({ uwsModule: realModule as any, port, host: '127.0.0.1' })
    const app         = mjsWs({ transport, welcome: () => ({ ok: true }), onLog: () => {} })
    app.serve('ping', () => 'pong')
    await app.listen()
    try {
      const { default: RealWebSocket } = await import('ws')
      ;(globalThis as any).WebSocket = RealWebSocket
      const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
      new Function('µ', clientSrc)(µ)
      const s = µ.socket(`ws://127.0.0.1:${port}/`)
      s.connect()
      await tick(300)
      assert.equal(s.state, 'open')
      const res = await s.request('ping', {})
      assert.equal(res, 'pong')
      s.destroy()
    } finally {
      await app.stop()
    }
  })

  // LA MÊME BOUCLE, MAIS PAR UNE SOCKET UNIX — le VRAI paquet, le VRAI client. Le client `ws`
  // joint une socket unix par l'adresse `ws+unix://<chemin>:<route>` (les deux-points séparent le
  // chemin du fichier de la route HTTP) ; c'est la seule chose qui change côté client.
  // Le répertoire vient de mjsTmp (/tmp/mjs-…) et NON du répertoire courant : sur un chemin de
  // travail à rallonge, le bind rendrait `false` sans un mot — arrivé pour de vrai au banc,
  // sur un chemin de 118 octets.
  it('boucle complète par une SOCKET UNIX, et la socket naît bien en 0660 (rapporté — jamais bloquant si le paquet est absent)', async function () {
    if (!existsSync(REAL_UWS_ENTRY)) {
      console.log(`    (uWebSockets.js introuvable (${REAL_UWS_ENTRY}) — smoke socket unix SAUTÉ, attendu hors de cette machine)`)
      this.skip()
      return
    }
    const realModule = await import(pathToFileURL(REAL_UWS_ENTRY).href)
    const sockPath   = join(freshDir('uws-unix'), 'ws.sock')
    const transport  = new UwsTransport({ uwsModule: realModule as any, socketPath: sockPath })
    const app        = mjsWs({ transport, welcome: () => ({ ok: true }), onLog: () => {} })
    app.serve('ping', () => 'pong')
    await app.listen()
    try {
      assert.equal(statSync(sockPath).isSocket(), true, 'le bind doit poser une VRAIE socket, pas un fichier')
      assert.equal(statSync(sockPath).mode & 0o777, 0o660)
      const { default: RealWebSocket } = await import('ws')
      ;(globalThis as any).WebSocket = RealWebSocket
      const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
      new Function('µ', clientSrc)(µ)
      const s = µ.socket(`ws+unix://${sockPath}:/`)
      s.connect()
      await tick(300)
      assert.equal(s.state, 'open')
      const res = await s.request('ping', {})
      assert.equal(res, 'pong')
      s.destroy()
    } finally {
      await app.stop()
    }
  })
})
