// Tests de « l'état du serveur » de MJS-WS (stats.ts/stats-page.ts) : registre de
// compteurs TOUJOURS actif (app.stats()), exposition HTTP sur le pont (GET /stats JSON, /metrics
// Prometheus, /state page HTML) SEULEMENT si `opts.stats` est actif, règle de signature loopback.
// MÊME technique « boucle complète » que les autres fichiers mjs-ws-*.test.ts : VRAI client
// µ.socket sur MemoryTransport pour les compteurs protocolaires, vrai serveur node:http (port 0,
// éphémère) pour le pont — requêtes signées fabriquées à la main (cf. tests/mjs-ws-bridge.test.ts).
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, isLoopbackHost, LatencyReservoir, LATENCY_RESERVOIR_SIZE } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

const SECRET = 'secret-de-test-stats-1234567890'

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}

interface LogLine { level: string; message: string; meta?: any }

// démarre une app — si `opts.bridge` est fourni, lit le port RÉEL (éphémère, port: 0) depuis la
// ligne onLog émise par bridge.ts au démarrage (même technique que tests/mjs-ws-bridge.test.ts)
async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; bridgePort: number; logs: LogLine[] }> {
  const transport = new MemoryTransport()
  const logs: LogLine[] = []
  let bridgePort  = 0
  const userOnLog = opts.onLog
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

// requête signée — MÊME algorithme que bridge.ts, fabriqué indépendamment (node:crypto brut).
// Chaîne DIRIGÉE + INJECTIVE — direction 'in' (commandes admin entrantes, y
// compris /stats-/metrics-/state hors loopback), cf. tests/mjs-ws-bridge.test.ts pour la
// couverture directe de la séparation de domaine.
function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  const canonical = fields.map(f => f.length +':'+ f).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

async function req(port: number, method: string, path: string): Promise<{ status: number; headers: Headers; text: string }> {
  const ts  = Math.floor(Date.now() / 1000)
  const sig = sign(SECRET, method, path, '', ts)
  const res = await fetch('http://127.0.0.1:'+ port + path, {
    method,
    headers: { 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
  })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

async function reqUnsigned(port: number, method: string, path: string): Promise<{ status: number; headers: Headers; text: string }> {
  const res = await fetch('http://127.0.0.1:'+ port + path, { method })
  return { status: res.status, headers: res.headers, text: await res.text() }
}

// ============================================================================================

describe('mjs-ws/stats — compteurs cohérents après activité réelle (vrai client µ.socket)', () => {
  it('welcome → connexions.accueillies/actives', async () => {
    const { transport, app } = await startApp()
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-welcome')
    s.connect(); await tick()
    const snap = app.stats()
    assert.equal(snap.connexions.accueillies, 1)
    assert.equal(snap.connexions.actives, 1)
    s.destroy(); await app.stop()
    assert.equal(app.stats().connexions.fermees, 1, 'fermeture comptée après app.stop()')
  })

  it('send/serve → messages.recus/envoyes en hausse', async () => {
    const { transport, app } = await startApp()
    app.serve('ping', () => 'pong')
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-messages')
    s.connect(); await tick()
    const before = app.stats().messages
    await s.request('ping', {})
    const after = app.stats().messages
    assert.ok(after.recus > before.recus, 'au moins la requête ping reçue en plus')
    assert.ok(after.envoyes > before.envoyes, 'au moins le µ:ack envoyé en plus')
    s.destroy(); await app.stop()
  })

  it("join → salons.nombre/membresTotal", async () => {
    const { transport, app } = await startApp()
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-room')
    s.connect(); await tick()
    s.room('zone-stats')
    await tick()
    const snap = app.stats()
    assert.equal(snap.salons.nombre, 1)
    assert.equal(snap.salons.membresTotal, 1)
    s.destroy(); await app.stop()
  })

  it('stream add → flux.nombre/deltasEmis', async () => {
    const { app } = await startApp()
    const ennemis = app.stream('ennemis-stats')
    ennemis.add('e1', { x: 1, y: 2 })
    const snap = app.stats()
    assert.equal(snap.flux.nombre, 1)
    assert.equal(snap.flux.deltasEmis, 1)
    await app.stop()
  })

  it('kick de garde simulé (rafale > burst) → garde.kicksDebit', async () => {
    const { transport, app } = await startApp({ limits: { rate: 5, burst: 5, kickAfter: 3 }, onLog: () => {} })   // kick INTENTIONNEL
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-garde', { reconnect: { enabled: false } })
    s.connect(); await tick()
    for (let i = 0; i < 30; i++) s.send('spam', { i })
    await tick(60)
    const snap = app.stats()
    assert.ok(snap.garde.kicksDebit >= 1)
    assert.equal(snap.garde.kicksSilence, 0)
    assert.equal(snap.garde.kicksEngorgement, 0)
    assert.equal(snap.garde.kicksChargeUtile, 0)
    s.destroy(); await app.stop()
  })

  it('reprise de session → sessions.reprises', async () => {
    const { transport, app } = await startApp({ resume: true, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-resume', { reconnect: { backoff: [0], jitter: 0 } })
    s.connect(); await tick()
    assert.equal(app.stats().sessions.emises, 1, '1re émission au welcome initial')
    s._mjs_ws.close(1006, 'coupure simulée')   // coupure réseau — PAS un close() volontaire
    await tick(30)                         // backoff [0] → reconnexion quasi immédiate
    assert.equal(s.state, 'open')
    const snap = app.stats()
    assert.equal(snap.sessions.reprises, 1)
    assert.equal(snap.sessions.emises, 2, '2e émission (clé tournée) au welcome de reprise')
    s.destroy(); await app.stop()
  })
})

// ============================================================================================

describe('mjs-ws/stats — app.stats() : forme complète + uptime/processId', () => {
  it('toutes les familles présentes, uptime/processId/horodatage/mémoire du bon type', async () => {
    const { app } = await startApp()
    const snap = app.stats()
    assert.equal(typeof snap.uptime, 'number')
    assert.ok(snap.uptime >= 0)
    assert.equal(typeof snap.processId, 'string')
    assert.ok(snap.processId.length > 0)
    assert.equal(typeof snap.horodatage, 'number')
    assert.equal(typeof snap.memoire.rss, 'number')
    assert.ok(snap.memoire.rss > 0)
    for (const famille of ['connexions', 'messages', 'garde', 'salons', 'flux', 'pont', 'adaptateur', 'sessions', 'latences', 'erreurs']) {
      assert.ok(famille in snap, `famille '${famille}' manquante dans l'instantané`)
    }
    assert.deepEqual(Object.keys(snap.connexions).sort(), ['accueillies', 'actives', 'fermees', 'parquees', 'refusees', 'refuseesOrigine', 'refuseesPlafond'].sort())
    assert.deepEqual(snap.latences, { p50: null, p95: null, echantillon: 0 }, 'aucun ping encore mesuré')
    await app.stop()
  })

  it('app.stats() est un INSTANTANÉ (2 appels successifs ne partagent pas le même objet muté)', async () => {
    const { transport, app } = await startApp()
    const a = app.stats()
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-snapshot')
    s.connect(); await tick()
    const b = app.stats()
    assert.equal(a.connexions.actives, 0, "l'instantané PRÉCÉDENT ne doit pas avoir été muté après coup")
    assert.equal(b.connexions.actives, 1)
    s.destroy(); await app.stop()
  })
})

// ============================================================================================

describe('mjs-ws/stats — option `stats` absente : /stats et /state = 404, app.stats() marche quand même', () => {
  it('pont actif mais opts.stats absent → 404 sur /stats et /state, app.stats() fonctionne', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })   // stats: absent
    const rStats = await reqUnsigned(bridgePort, 'GET', '/stats')
    assert.equal(rStats.status, 404)
    const rEtat = await reqUnsigned(bridgePort, 'GET', '/state')
    assert.equal(rEtat.status, 404)
    const rMetrics = await reqUnsigned(bridgePort, 'GET', '/metrics')
    assert.equal(rMetrics.status, 404)
    const snap = app.stats()
    assert.equal(typeof snap.uptime, 'number')
    await app.stop()
  })

  it('sans pont du tout → app.stats() fonctionne (le registre tourne indépendamment du pont)', async () => {
    const { app } = await startApp({ stats: true })   // stats:true mais bridge absent — sans effet HTTP observable
    const snap = app.stats()
    assert.equal(typeof snap.uptime, 'number')
    await app.stop()
  })
})

// ============================================================================================

describe('mjs-ws/stats — pont : GET /stats + /metrics, règle de signature loopback', function () {
  this.timeout(10000)

  it('host loopback (défaut 127.0.0.1) → GET /stats SANS signature accepté, JSON exploitable', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await reqUnsigned(bridgePort, 'GET', '/stats')
    assert.equal(r.status, 200)
    const json = JSON.parse(r.text)
    assert.equal(typeof json.uptime, 'number')
    assert.equal(typeof json.processId, 'string')
    await app.stop()
  })

  it('host loopback → GET /metrics SANS signature accepté, lignes Prometheus valides', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await reqUnsigned(bridgePort, 'GET', '/metrics')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') || '', /text\/plain/)
    const valueLines = r.text.split('\n').filter(l => l && !l.startsWith('#'))
    assert.ok(valueLines.length > 10, `attendu plusieurs lignes de métriques, reçu ${valueLines.length}`)
    for (const line of valueLines) assert.match(line, /^mjs_ws_[a-z_]+ [0-9.]+$/, `ligne non conforme : '${line}'`)
    assert.ok(r.text.includes('mjs_ws_ping_samples'), 'latences exposées (mjs_ws_ping_p50_ms/p95 quand échantillon non vide, mjs_ws_ping_samples toujours)')
    assert.ok(r.text.includes('mjs_ws_connections_active'), 'préfixe mjs_ws_ respecté')
    await app.stop()
  })

  it('requête SIGNÉE acceptée aussi (la gate loopback est une EXEMPTION, pas une interdiction)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await req(bridgePort, 'GET', '/stats')
    assert.equal(r.status, 200)
    await app.stop()
  })

  it("isLoopbackHost : SEUL endroit qui tranche la question — 127.0.0.1/::1 → true, tout le reste → false (host public non simulé ici : lourd à monter, la fonction de gate est testée directement)", () => {
    assert.equal(isLoopbackHost('127.0.0.1'), true)
    assert.equal(isLoopbackHost('::1'), true)
    assert.equal(isLoopbackHost('0.0.0.0'), false)
    assert.equal(isLoopbackHost('192.168.1.10'), false)
    assert.equal(isLoopbackHost('example.com'), false)
    assert.equal(isLoopbackHost('localhost'), false, "seuls 127.0.0.1/::1 sont loopback ICI — 'localhost' n'est pas la forme résolue par défaut (opts.bridge.host)")
  })

  it("les endpoints usuels (/broadcast etc.) restent signés même en loopback — l'exemption est LIMITÉE à /stats, /metrics, /state", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await reqUnsigned(bridgePort, 'POST', '/broadcast')
    assert.equal(r.status, 401)
    await app.stop()
  })
})

// ============================================================================================

describe('mjs-ws/stats — pont : GET /state (page HTML sombre)', function () {
  this.timeout(10000)

  it('200, Content-Type html, contient « µWS » et des valeurs (instantané initial embarqué)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await reqUnsigned(bridgePort, 'GET', '/state')
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') || '', /html/)
    assert.match(r.text, /µWS/)
    assert.match(r.text, /"uptime"/, "l'instantané initial (JSON) doit être embarqué dans la page — pas d'attente réseau pour la 1re peinture")
    assert.match(r.text, /"processId"/)
    assert.doesNotMatch(r.text, /style="/, 'zéro attribut style= en ligne (règle nº1 MJS)')
    await app.stop()
  })

  it('aucune ressource externe (pas de <link>/<script src=.../<img src="http)', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET }, stats: true })
    const r = await reqUnsigned(bridgePort, 'GET', '/state')
    assert.doesNotMatch(r.text, /<link\b/i)
    assert.doesNotMatch(r.text, /<script[^>]+src=/i)
    assert.doesNotMatch(r.text, /https?:\/\//i)
    await app.stop()
  })
})

// ============================================================================================

describe('mjs-ws/stats — LatencyReservoir : p50/p95 sur un échantillon connu, borné', () => {
  it('p50/p95 corrects sur 1..100 (méthode « plus proche rang »)', () => {
    const r = new LatencyReservoir()
    for (let i = 1; i <= 100; i++) r.push(i)
    const p = r.percentiles()
    assert.equal(p.echantillon, 100)
    assert.equal(p.p50, 50)
    assert.equal(p.p95, 95)
  })

  it(`borné à ${LATENCY_RESERVOIR_SIZE} — au-delà, fenêtre GLISSANTE (les plus anciennes valeurs sont écrasées)`, () => {
    const r = new LatencyReservoir()
    for (let i = 1; i <= LATENCY_RESERVOIR_SIZE + 50; i++) r.push(i)
    const p = r.percentiles()
    assert.equal(p.echantillon, LATENCY_RESERVOIR_SIZE, `jamais plus de ${LATENCY_RESERVOIR_SIZE} échantillons`)
    // les 50 plus anciennes valeurs (1..50) ont été écrasées — il reste 51..306 (256 valeurs contiguës)
    assert.equal(p.p50, 51 + 127)
    assert.equal(p.p95, 51 + 242)
  })

  it('réservoir vide → p50/p95 null, échantillon 0', () => {
    const r = new LatencyReservoir()
    assert.deepEqual(r.percentiles(), { p50: null, p95: null, echantillon: 0 })
  })

  it('ping réel (heartbeat actif) → latences.p50/p95 numériques, échantillon ≥ 1', async () => {
    const { transport, app } = await startApp({ heartbeat: 20 })
    const µ = makeClient(transport)
    const s = µ.socket('memory://stats-latency', { heartbeat: 20 })
    s.connect(); await tick()
    await tick(45)   // laisse au moins 1 aller-retour ping/pong passer (même délai que mjs-ws-core.test.ts #5)
    const snap = app.stats()
    assert.equal(typeof snap.latences.p50, 'number')
    assert.ok(snap.latences.echantillon >= 1)
    s.destroy(); await app.stop()
  })
})
