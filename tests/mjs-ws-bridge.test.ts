// Tests du pont universel (bridge.ts) — MÊME technique « boucle complète » que
// tests/mjs-ws-core.test.ts et tests/mjs-ws-rooms-streams.test.ts : l'app tourne sur
// MemoryTransport (les clients µ.socket sont de VRAIS clients, chargés via
// `new Function('µ', src)`), et le pont HTTP tourne sur un VRAI serveur node:http en
// 127.0.0.1 port 0 (éphémère — le port réel est lu via onLog, cf. startApp ci-dessous, le
// pont ne l'expose pas comme API publique). Les requêtes signées sont fabriquées à la main
// (node:crypto, indépendamment de bridge.ts) — preuve en boîte noire que l'algorithme
// DOCUMENTÉ (docs/23-mjs-ws.md) fonctionne, pas juste que le serveur est cohérent avec lui-même.
// Chaîne canonique DIRIGÉE + INJECTIVE — cf. lp()/sign()
// ci-dessous (réimplémentation boîte noire, direction 'in') et startMockBack (direction 'out').
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { signToken, verifyToken, jwtAuth } from '../src/mjs-ws/token.js'
import { findConfig } from '../src/bundler/config.js'
// direction 'in'/'out' + chaîne injective — importées DIRECTEMENT ici (contrairement à
// sign()/lp() ci-dessous, réimplémentés en boîte noire) : ce sont des propriétés STRUCTURELLES de la
// fonction elle-même (injectivité, divergence par direction), pas une fidélité au format documenté.
import { canonicalString, signCanonical } from '../src/mjs-ws/bridge.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { mjsTmp } from './helpers/tmp.js'

// écrit un mjs.config.json isolé — MÊME patron que tests/mjs-ws-bridge-ratelimit.test.ts (test « e »)
function writeConfig(config: unknown): string {
  const root = mjsTmp('bridge-nonce-cfg')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
  return root
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

const SECRET = 'secret-de-test-1234567890'

// --- même technique que les autres tests MJS-WS — vrai client µ.socket sur MemoryTransport ---

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport, trace?: Array<{ url: string; msg: any }>): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    if (trace) {
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { trace.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    return ws
  }
  return makeMu()
}

interface LogLine { level: string; message: string; meta?: any }

// démarre une app avec MemoryTransport — si `opts.bridge` est fourni, lit le port RÉEL
// (éphémère, port: 0) depuis la ligne onLog émise par bridge.ts au démarrage (le pont
// n'expose sciemment aucune API publique pour ça, cf. bridge.ts createBridge().start())
async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; bridgePort: number; logs: LogLine[] }> {
  const transport  = new MemoryTransport()
  const logs: LogLine[] = []
  let bridgePort   = 0
  const userOnLog  = opts.onLog
  const app = mjsWs({
    transport, heartbeat: 0,
    ...opts,
    onLog: (level, message, meta) => {
      logs.push({ level, message, meta })
      if (meta && typeof (meta as any).port === 'number' && /pont universel en écoute/.test(message)) bridgePort = (meta as any).port
      userOnLog?.(level, message, meta)
    },
  })
  await app.listen()
  return { transport, app, bridgePort, logs }
}

// --- requêtes signées, fabriquées indépendamment de bridge.ts (node:crypto brut) --------

// format DIRIGÉ + INJECTIF — chaque champ encodé en
// longueur-préfixée (`{longueur}:{champ}`), `direction` en premier champ ('in' = commande admin
// entrante, ICI, `sign()` ne signe QUE ce sens — les webhooks 'out' sont vérifiés par startMockBack
// plus bas, indépendamment). `nonce` — SUFFIXÉ en dernier champ quand fourni.
function lp(field: string): string { return field.length +':'+ field }

function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number, nonce?: string): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  if (nonce != null) fields.push(nonce)
  const canonical = fields.map(lp).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

async function req(
  port: number, method: string, path: string, body?: any,
  override: { secret?: string; ts?: number; badSig?: boolean; nonce?: string } = {},
): Promise<{ status: number; json: any }> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  const ts      = override.ts ?? Math.floor(Date.now() / 1000)
  const sig     = override.badSig ? '0'.repeat(64) : sign(override.secret ?? SECRET, method, path, bodyStr, ts, override.nonce)
  const headers: Record<string, string> = { 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig }
  if (override.nonce) headers['x-mjs-ws-nonce'] = override.nonce
  if (bodyStr) headers['content-type'] = 'application/json'
  const res  = await fetch('http://127.0.0.1:'+ port + path, { method, headers, body: bodyStr || undefined })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

async function waitUntil(pred: () => boolean, timeoutMs = 3000): Promise<void> {
  const start = Date.now()
  while (!pred()) {
    if (Date.now() - start > timeoutMs) throw new Error('waitUntil : délai dépassé — condition jamais vraie')
    await tick(10)
  }
}

// --- mini-serveur node:http jouant « le back » — capture + RE-VÉRIFIE la signature reçue ---

interface MockBack { port: number; received: any[]; readonly attempts: number; close: () => Promise<void> }

function startMockBack(secret: string, opts: { failFirstN?: number } = {}): Promise<MockBack> {
  return new Promise((resolveStart) => {
    const received: any[] = []
    let attempts = 0
    const server = createServer((httpReq, res) => {
      const chunks: Buffer[] = []
      httpReq.on('data', (c: Buffer) => chunks.push(c))
      httpReq.on('end', () => {
        attempts++
        const body      = Buffer.concat(chunks).toString('utf8')
        const ts        = httpReq.headers['x-mjs-ws-timestamp']
        const sig       = httpReq.headers['x-mjs-ws-signature']
        // direction 'out' — un webhook du pont se signe TOUJOURS dans ce sens, cf. bridge.ts deliver()
        const canonical = ['out', String(ts), 'POST', httpReq.url, body].map(lp).join('')
        const expected  = createHmac('sha256', secret).update(canonical).digest('hex')
        if (expected !== sig) { res.writeHead(401); res.end('signature invalide'); return }
        if (opts.failFirstN != null && attempts <= opts.failFirstN) { res.writeHead(500); res.end('boom'); return }
        received.push(JSON.parse(body))
        res.writeHead(200); res.end('ok')
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as any
      resolveStart({
        port: addr.port, received,
        get attempts() { return attempts },
        close: () => new Promise<void>(r => server.close(() => r())),
      })
    })
  })
}

// ============================================================================================

describe('MJS-WS — pont universel : signature HMAC-SHA256 anti-rejeu (vrai serveur node:http)', function () {
  this.timeout(10000)

  it('requête bien signée → 200', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const res = await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true })
    await app.stop()
  })

  it('secret faux → 401', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const res = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { secret: 'mauvais-secret' })
    assert.equal(res.status, 401)
    assert.equal(res.json.ok, false)
    await app.stop()
  })

  it('timestamp vieux de 301 s → 401 (anti-rejeu)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const oldTs = Math.floor(Date.now() / 1000) - 301
    const res   = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts: oldTs })
    assert.equal(res.status, 401)
    await app.stop()
  })

  it('corps altéré après signature → 401', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const ts     = Math.floor(Date.now() / 1000)
    const signed = JSON.stringify({ type: 'x' })
    const sig    = sign(SECRET, 'POST', '/broadcast', signed, ts)
    const sentButDifferent = JSON.stringify({ type: 'y' })   // corps ENVOYÉ diffère du corps SIGNÉ
    const r = await fetch('http://127.0.0.1:'+ bridgePort +'/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
      body: sentButDifferent,
    })
    assert.equal(r.status, 401)
    await app.stop()
  })

  it('/health sans signature → 200 (seul endpoint non signé)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const r = await fetch('http://127.0.0.1:'+ bridgePort +'/health')
    assert.equal(r.status, 200)
    assert.equal(await r.text(), 'ok')
    await app.stop()
  })

  it("chemin inconnu (mais bien signé) → 404 JSON", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const res = await req(bridgePort, 'POST', '/nope', {})
    assert.equal(res.status, 404)
    assert.equal(res.json.ok, false)
    await app.stop()
  })

  it("bridge sans secret → erreur française claire, dès mjsWs() (pas d'attente du démarrage)", () => {
    assert.throws(() => mjsWs({ transport: new MemoryTransport(), bridge: {} as any }), /secret.*obligatoire/i)
  })

  it("bridge.secret = 'env:NOM_VAR' → résolu depuis process.env, ne lève pas", () => {
    process.env.MJS_WS_TEST_BRIDGE_SECRET = 'depuis-env'
    try {
      assert.doesNotThrow(() => mjsWs({ transport: new MemoryTransport(), bridge: { port: 0, secret: 'env:MJS_WS_TEST_BRIDGE_SECRET' } }))
    } finally {
      delete process.env.MJS_WS_TEST_BRIDGE_SECRET
    }
  })
})

describe('MJS-WS — pont universel : chaîne canonique dirigée + injective', function () {
  this.timeout(10000)

  it("même ts/méthode/chemin/corps, direction 'in' vs 'out' → chaîne ET HMAC différents (unitaire)", () => {
    const ts   = Math.floor(Date.now() / 1000)
    const cIn  = canonicalString(ts, 'POST', '/broadcast', '{"type":"x"}', undefined, 'in')
    const cOut = canonicalString(ts, 'POST', '/broadcast', '{"type":"x"}', undefined, 'out')
    assert.notEqual(cIn, cOut)
    assert.notEqual(signCanonical(SECRET, cIn), signCanonical(SECRET, cOut))
  })

  it("collision historique (chemin/corps découpés autrement) désormais impossible — chaîne ET HMAC différents (unitaire)", () => {
    const ts = Math.floor(Date.now() / 1000)
    // AVANT le préfixe longueur, ces 2 découpages produisaient la MÊME chaîne '.'-jointe :
    // '/a' + 'b.c' === '/a.b' + 'c' une fois concaténés avec le délimiteur '.'
    const c1 = canonicalString(ts, 'POST', '/a', 'b.c', undefined, 'in')
    const c2 = canonicalString(ts, 'POST', '/a.b', 'c', undefined, 'in')
    assert.notEqual(c1, c2)
    assert.notEqual(signCanonical(SECRET, c1), signCanonical(SECRET, c2))
  })

  it("signature calculée pour 'out' (comme un webhook) → 401 en tant que commande admin entrante ('in' attendu)", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const ts      = Math.floor(Date.now() / 1000)
    const bodyStr = JSON.stringify({ type: 'x' })
    const sig     = signCanonical(SECRET, canonicalString(ts, 'POST', '/broadcast', bodyStr, undefined, 'out'))
    const r = await fetch('http://127.0.0.1:'+ bridgePort +'/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
      body: bodyStr,
    })
    assert.equal(r.status, 401)
    await app.stop()
  })

  it("signature calculée pour 'in' (comme une commande admin) rejouée contre un récepteur de webhook ('out' attendu) → rejetée", async () => {
    const back    = await startMockBack(SECRET)
    const ts      = Math.floor(Date.now() / 1000)
    const bodyStr = JSON.stringify({ event: 'connect' })
    const sig     = signCanonical(SECRET, canonicalString(ts, 'POST', '/hook', bodyStr, undefined, 'in'))
    const r = await fetch('http://127.0.0.1:'+ back.port +'/hook', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
      body: bodyStr,
    })
    assert.equal(r.status, 401)
    await back.close()
  })

  it("aller-retour signer→vérifier direction 'in' toujours valide → 200 (non-régression)", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const res = await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
    assert.equal(res.status, 200)
    await app.stop()
  })
})

describe('MJS-WS — pont universel : nonce anti-rejeu (optionnel, ws.bridge.nonce)', function () {
  this.timeout(10000)

  it('nonce actif : requête signée+noncée → 200, la MÊME rejouée (même ts/sig/nonce) → 401 nonce-rejoué', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, nonce: true } })
    const ts    = Math.floor(Date.now() / 1000)
    const nonce = 'nonce-de-test-abcdef01'
    const first = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts, nonce })
    assert.equal(first.status, 200)
    const replay = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts, nonce })
    assert.equal(replay.status, 401)
    assert.equal(replay.json.error, 'nonce-rejoué')
    await app.stop()
  })

  it('nonce actif : en-tête x-mjs-ws-nonce absent → 401 (même requête, autrement valide)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, nonce: true } })
    const ts      = Math.floor(Date.now() / 1000)
    const bodyStr = JSON.stringify({ type: 'x' })
    const sig     = sign(SECRET, 'POST', '/broadcast', bodyStr, ts)   // signée SANS nonce (en-tête oublié)
    const r = await fetch('http://127.0.0.1:'+ bridgePort +'/broadcast', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
      body: bodyStr,
    })
    assert.equal(r.status, 401)
    await app.stop()
  })

  it('nonce off (défaut) : comportement actuel INTACT — un rejeu dans la fenêtre ±300s reste accepté', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const ts      = Math.floor(Date.now() / 1000)
    const bodyStr = JSON.stringify({ type: 'x' })
    const sig     = sign(SECRET, 'POST', '/broadcast', bodyStr, ts)
    const headers = { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig }
    const a = await fetch('http://127.0.0.1:'+ bridgePort +'/broadcast', { method: 'POST', headers, body: bodyStr })
    const b = await fetch('http://127.0.0.1:'+ bridgePort +'/broadcast', { method: 'POST', headers, body: bodyStr })
    assert.equal(a.status, 200)
    assert.equal(b.status, 200, "option off (défaut) : la fenêtre ±300s seule gouverne, rejeu accepté — comportement historique documenté, inchangé")
    await app.stop()
  })

  it('nonce actif : le rejeu CRÉDITE le seau-échecs (429 une fois le budget épuisé)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, nonce: true, rateLimit: { fails: [1, 60000] } } })
    const ts    = Math.floor(Date.now() / 1000)
    const nonce = 'nonce-credit-seau-01'
    const first   = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts, nonce })
    const replay1 = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts, nonce })
    const replay2 = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, { ts, nonce })
    assert.equal(first.status, 200)
    assert.equal(replay1.status, 401, 'seau-échecs capacité 1 : le rejeu CONSOMME le seul jeton, encore 401 cette fois (même sémantique que la signature invalide)')
    assert.equal(replay1.json.error, 'nonce-rejoué')
    assert.equal(replay2.status, 429, 'seau-échecs déjà déchargé par le rejeu précédent → 429, sans même revérifier la signature')
    await app.stop()
  })

  it('ws.bridge.nonce : clé inconnue avec typo → suggestion ; type invalide → erreur ; booléen valide accepté', () => {
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { noncee: true } } })),
      /ws\.bridge\.noncee : clé inconnue — tu voulais dire 'nonce' \?/,
    )
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { nonce: 'oui' } } })),
      /ws\.bridge\.nonce doit être un booléen/,
    )
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { bridge: { nonce: true } } })))
    assert.equal(findConfig(writeConfig({ ws: { bridge: { nonce: true } } }))!.config.ws!.bridge!.nonce, true)
  })
})

describe('MJS-WS — pont universel : endpoints (boucle complète, vrai client µ.socket)', function () {
  this.timeout(10000)

  it('/broadcast → le vrai client reçoit', async () => {
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-bcast')
    s.connect(); await tick()
    const recu: any[] = []
    s.on('annonce', (p: any) => recu.push(p))
    const res = await req(bridgePort, 'POST', '/broadcast', { type: 'annonce', p: { texte: 'salut tous' } })
    assert.equal(res.status, 200)
    await tick()
    assert.deepEqual(recu, [{ texte: 'salut tous' }])
    s.destroy(); await app.stop()
  })

  it('/send par user → les 2 connexions du même identity.id reçoivent, une 3e (autre user) ne reçoit rien', async () => {
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, auth: (hello: any) => ({ id: hello.auth.uid }) })
    const µ1 = makeClient(transport); const s1 = µ1.socket('memory://br-send-1', { auth: () => ({ uid: 'u1' }) }); s1.connect()
    const µ2 = makeClient(transport); const s2 = µ2.socket('memory://br-send-2', { auth: () => ({ uid: 'u1' }) }); s2.connect()
    const µ3 = makeClient(transport); const s3 = µ3.socket('memory://br-send-3', { auth: () => ({ uid: 'u2' }) }); s3.connect()
    await tick()
    const r1: any[] = []; const r2: any[] = []; const r3: any[] = []
    s1.on('note', (p: any) => r1.push(p)); s2.on('note', (p: any) => r2.push(p)); s3.on('note', (p: any) => r3.push(p))

    const res = await req(bridgePort, 'POST', '/send', { user: 'u1', type: 'note', p: { texte: 'coucou' } })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, sent: 2 })
    await tick()
    assert.deepEqual(r1, [{ texte: 'coucou' }])
    assert.deepEqual(r2, [{ texte: 'coucou' }])
    assert.deepEqual(r3, [])
    s1.destroy(); s2.destroy(); s3.destroy(); await app.stop()
  })

  it('/send par client (id de connexion) → une seule connexion visée, sent:0 si introuvable', async () => {
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-send-solo')
    s.connect(); await tick()
    const cible = Array.from((app as any).clients)[0] as any
    const recu: any[] = []
    s.on('note', (p: any) => recu.push(p))

    const res = await req(bridgePort, 'POST', '/send', { client: cible.id, type: 'note', p: { n: 1 } })
    assert.deepEqual(res.json, { ok: true, sent: 1 })
    await tick()
    assert.deepEqual(recu, [{ n: 1 }])

    const missed = await req(bridgePort, 'POST', '/send', { client: 'id-qui-n-existe-pas', type: 'note', p: {} })
    assert.deepEqual(missed.json, { ok: true, sent: 0 })
    s.destroy(); await app.stop()
  })

  it('/room/send → seul le membre du salon reçoit (type verbatim, aucun préfixe ajouté)', async () => {
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    const µA = makeClient(transport); const sA = µA.socket('memory://br-room-a'); sA.connect(); sA.room('zone'); await tick()
    const µB = makeClient(transport); const sB = µB.socket('memory://br-room-b'); sB.connect(); await tick()   // PAS membre
    const recuA: any[] = []; const recuB: any[] = []
    sA.room('zone').on('tick', (p: any) => recuA.push(p))
    sB.on('zone/tick', (p: any) => recuB.push(p))
    await tick()

    const res = await req(bridgePort, 'POST', '/room/send', { room: 'zone', type: 'zone/tick', p: { n: 1 } })
    assert.equal(res.status, 200)
    await tick()
    assert.deepEqual(recuA, [{ n: 1 }])
    assert.deepEqual(recuB, [])
    sA.destroy(); sB.destroy(); await app.stop()
  })

  it('/room/kick → µ:left {room, reason} UNIQUE chez le visé, connexion TOUJOURS ouverte', async () => {
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })
    app.serve('ping', () => 'pong')
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-kick')
    s.connect()
    const zone = s.room('zone')
    let leftReason: any = null
    zone.onLeft((reason: any) => { leftReason = reason })
    await tick()
    assert.equal(app.room('zone').size, 1)

    const cible = Array.from(app.clients)[0] as any
    const res = await req(bridgePort, 'POST', '/room/kick', { room: 'zone', client: cible.id, reason: 'triche' })
    assert.equal(res.status, 200)
    assert.deepEqual(res.json, { ok: true, kicked: 1 })
    await tick()
    assert.equal(leftReason, 'triche')
    assert.equal(app.room('zone').size, 0)
    assert.equal(s.state, 'open')                          // kick de SALON ≠ fermeture
    assert.equal(await s.request('ping', {}), 'pong')
    s.destroy(); await app.stop()
  })

  it('/stream add/update/remove/reset → deltas seq corrects chez l\'abonné, un µ:resync rattrape des ops venues DU PONT', async () => {
    const trace: Array<{ url: string; msg: any }> = []
    const { transport, app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })

    // créé À LA VOLÉE par le tout premier appel HTTP (aucun app.stream() préalable côté code)
    const created = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'add', id: 'a', value: { v: 1 } })
    assert.deepEqual(created.json, { ok: true })

    const µ = makeClient(transport, trace)
    const s = µ.socket('memory://br-stream', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect()
    const $$m = s.stream('monde')
    await tick()
    assert.deepEqual({ ...$$m }, { a: { v: 1 } })   // reset initial reflète l'add fait via HTTP avant la connexion

    s._mjs_ws.close(1006, 'coupure simulée')   // coupure réseau — PAS un close() volontaire
    assert.equal(s.state, 'reconnecting')

    const rUpd = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'update', id: 'a', value: { v: 2 } })
    assert.equal(rUpd.status, 200)
    const rAdd = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'add', id: 'b', value: { v: 5 } })
    assert.equal(rAdd.status, 200)
    const rDel = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'remove', id: 'b' })
    assert.equal(rDel.status, 200)

    await tick(30)   // backoff [0] → reconnexion + µ:resync automatique
    assert.equal(s.state, 'open')
    assert.deepEqual({ ...$$m }, { a: { v: 2 } })

    const frames = trace.filter(f => f.msg.t === 'monde')
    const resets = frames.filter(f => f.msg.p.op === 'reset')
    assert.equal(resets.length, 1, 'un SEUL reset (le tout premier abonnement) — le rattrapage des ops du pont est un REJEU, pas une 2e photo')

    // op 'reset' via le pont — nouvelle époque
    const rReset = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'reset', values: { z: { v: 9 } } })
    assert.equal(rReset.status, 200)
    await tick()
    assert.deepEqual({ ...$$m }, { z: { v: 9 } })

    // validations 400
    const bad = await req(bridgePort, 'POST', '/stream', { name: 'monde', op: 'inconnu' })
    assert.equal(bad.status, 400)

    s.destroy(); await app.stop()
  })

  it('GET /presence (globale et par salon) → JSON agrégé exact', async () => {
    const { transport, app, bridgePort } = await startApp({
      bridge: { port: 0, secret: SECRET },
      auth:  (hello: any) => ({ id: hello.auth.uid, pseudo: hello.auth.pseudo }),
      rooms: { meta: (client: any) => ({ pseudo: client.identity.pseudo }) },
    })
    const µA = makeClient(transport); const sA = µA.socket('memory://br-pres-a', { auth: () => ({ uid: 'u1', pseudo: 'Ana' }) }); sA.connect(); sA.room('zone')
    const µB = makeClient(transport); const sB = µB.socket('memory://br-pres-b', { auth: () => ({ uid: 'u2', pseudo: 'Bob' }) }); sB.connect()
    await tick()

    const g = await req(bridgePort, 'GET', '/presence')
    assert.equal(g.status, 200)
    assert.equal(g.json.ok, true)
    assert.deepEqual(g.json.peers.map((p: any) => p.id).sort(), ['u1', 'u2'])

    const r = await req(bridgePort, 'GET', '/presence?room=zone')
    assert.equal(r.status, 200)
    assert.deepEqual(r.json.peers, [{ id: 'u1', meta: { pseudo: 'Ana' } }])

    sA.destroy(); sB.destroy(); await app.stop()
  })
})

describe('MJS-WS — pont universel : webhooks sortants (mini-serveur node:http, signature re-vérifiée)', function () {
  this.timeout(15000)

  it('connect/disconnect/join/leave/message:x — payloads exacts, signature re-vérifiée côté récepteur', async () => {
    const back = await startMockBack(SECRET)
    const { transport, app } = await startApp({
      bridge: {
        port: 0, secret: SECRET,
        webhooks: { url: 'http://127.0.0.1:'+ back.port +'/hook', events: ['connect', 'disconnect', 'join', 'leave', 'message:chat'] },
      },
      auth: (hello: any) => ({ id: hello.auth.uid }),
    })
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-wh-cycle', { auth: () => ({ uid: 'u1' }), reconnect: { enabled: false } })
    s.connect(); await tick()
    s.room('zone'); await tick()
    s.send('chat', { texte: 'yo' })
    await tick()
    s.room('zone').leave(); await tick()
    await waitUntil(() => back.received.filter((m: any) => m.event !== 'disconnect').length >= 4, 4000)
    s.destroy()
    await waitUntil(() => back.received.some((m: any) => m.event === 'disconnect'), 4000)

    const connect = back.received.find((m: any) => m.event === 'connect')
    assert.ok(connect, 'connect manquant')
    assert.equal(connect.client.identity.id, 'u1')
    assert.equal(typeof connect.at, 'number')

    const join = back.received.find((m: any) => m.event === 'join')
    assert.ok(join, 'join manquant')
    assert.equal(join.room, 'zone')
    assert.equal(join.user.id, 'u1')

    const message = back.received.find((m: any) => m.event === 'message')
    assert.ok(message, 'message manquant')
    assert.equal(message.type, 'chat')
    assert.deepEqual(message.p, { texte: 'yo' })
    assert.equal(message.client.identity.id, 'u1')
    assert.ok(!('meta' in message.client), "payload 'message' : SEULEMENT {id, identity} (pas de meta)")

    const leave = back.received.find((m: any) => m.event === 'leave')
    assert.ok(leave, 'leave manquant')
    assert.equal(leave.room, 'zone')
    assert.equal(leave.user.id, 'u1')

    const disconnect = back.received.find((m: any) => m.event === 'disconnect')
    assert.ok(disconnect, 'disconnect manquant')
    assert.equal(disconnect.client.identity.id, 'u1')

    await back.close(); await app.stop()
  })

  it('livraison : premier essai en 500 → retenté et reçu (délai avant retentative ~2 s)', async function () {
    this.timeout(8000)
    const back = await startMockBack(SECRET, { failFirstN: 1 })
    const { transport, app } = await startApp({
      bridge: { port: 0, secret: SECRET, webhooks: { url: 'http://127.0.0.1:'+ back.port +'/hook', events: ['connect'] } },
    })
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-wh-retry')
    s.connect(); await tick()
    await waitUntil(() => back.received.length >= 1, 6000)
    assert.equal(back.attempts, 2, 'le pont doit avoir retenté après le premier échec (500)')
    assert.equal(back.received[0].event, 'connect')
    s.destroy(); await back.close(); await app.stop()
  })

  it("événement absent de 'events' → jamais appelé ('leave'/'disconnect' non écoutés ici)", async () => {
    const back = await startMockBack(SECRET)
    const { transport, app } = await startApp({
      bridge: { port: 0, secret: SECRET, webhooks: { url: 'http://127.0.0.1:'+ back.port +'/hook', events: ['join'] } },
    })
    const µ = makeClient(transport)
    const s = µ.socket('memory://br-wh-filter')
    s.connect(); await tick()
    s.room('zone'); await tick()
    await waitUntil(() => back.received.some((m: any) => m.event === 'join'), 3000)
    s.room('zone').leave()
    s.destroy()
    await tick(300)   // laisse le temps à un envoi (fautif) éventuel d'arriver
    assert.ok(!back.received.some((m: any) => m.event === 'leave'), "'leave' absent de events → jamais livré")
    assert.ok(!back.received.some((m: any) => m.event === 'disconnect'), "'disconnect' absent de events → jamais livré")
    await back.close(); await app.stop()
  })
})

describe('mjs-ws/token — JWT HS256 sans dépendance', () => {
  it('signToken → verifyToken : aller-retour', () => {
    const tok     = signToken({ id: 'u1', role: 'admin' }, SECRET)
    const payload = verifyToken(tok, SECRET)
    assert.ok(payload)
    assert.equal(payload!.id, 'u1')
    assert.equal(payload!.role, 'admin')
    assert.equal(typeof payload!.iat, 'number')
  })

  it('exp passé → null', () => {
    const tok = signToken({ id: 'u1' }, SECRET, { ttl: -10 })   // déjà expiré à l'émission
    assert.equal(verifyToken(tok, SECRET), null)
  })

  it('signature tordue → null', () => {
    const tok      = signToken({ id: 'u1' }, SECRET)
    const tampered = tok.slice(0, -4) +'xxxx'
    assert.equal(verifyToken(tampered, SECRET), null)
  })

  it('format invalide (pas 3 segments, mauvais secret, alg différent) → null, jamais un throw', () => {
    assert.equal(verifyToken('pasunjeton', SECRET), null)
    assert.equal(verifyToken('a.b.c', SECRET), null)
    const tok = signToken({ id: 'u1' }, SECRET)
    assert.equal(verifyToken(tok, 'autre-secret'), null)
  })

  it("jwtAuth() — lit hello.auth directement (chaîne) OU hello.auth.token (objet)", () => {
    const tok    = signToken({ id: 'u1' }, SECRET)
    const authFn = jwtAuth(SECRET)
    assert.equal((authFn({ auth: tok } as any, {} as any) as any).id, 'u1')
    assert.equal((authFn({ auth: { token: tok } } as any, {} as any) as any).id, 'u1')
    assert.equal(authFn({ auth: { token: 'garbage' } } as any, {} as any), false)
    assert.equal(authFn({ auth: undefined } as any, {} as any), false)
  })

  it('jwtAuth en boucle complète : jeton valide → identity posée, jeton faux → refusé (µ:denied)', async () => {
    const { transport, app } = await startApp({ auth: jwtAuth(SECRET) })
    app.serve('whoami', (p: any, client: any) => client.identity)

    const tok = signToken({ id: 'u1', pseudo: 'Ana' }, SECRET)
    const µOk = makeClient(transport)
    const sOk = µOk.socket('memory://tok-ok', { auth: () => ({ token: tok }) })
    sOk.connect(); await tick()
    assert.equal(sOk.state, 'open')
    const identity = await sOk.request('whoami', {})
    assert.equal(identity.id, 'u1')
    assert.equal(identity.pseudo, 'Ana')

    const µBad = makeClient(transport)
    const sBad = µBad.socket('memory://tok-bad', { auth: () => ({ token: 'garbage' }), reconnect: { backoff: [0], jitter: 0 } })
    sBad.connect(); await tick()
    assert.equal(sBad.state, 'closed')
    assert.ok(sBad.lastError && /refus/i.test(sBad.lastError.message))

    sOk.destroy(); sBad.destroy(); await app.stop()
  })
})
