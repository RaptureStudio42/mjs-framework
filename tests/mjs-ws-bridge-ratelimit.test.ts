// Tests de la limite de débit du pont universel (bridge.ts) — MÊME technique « boîte
// noire » que tests/mjs-ws-bridge.test.ts : vrai serveur node:http (127.0.0.1, port 0 éphémère),
// requêtes signées fabriquées à la main (node:crypto, indépendamment de bridge.ts). Seule
// exception (f) : createBridgeRateLimiter testé en direct (horloge injectée) — TokenBucket
// (guard.ts) n'expose aucun « peek », impossible de prouver l'éviction sans attendre 10 minutes
// réelles sinon (cf. commentaire du test).
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { createBridgeRateLimiter } from '../src/mjs-ws/bridge.js'
import { findConfig } from '../src/bundler/config.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { mjsTmp } from './helpers/tmp.js'

const SECRET = 'secret-de-test-ratelimit-1234567890'

interface LogLine { level: string; message: string; meta?: any }

// démarre une app — lit le port RÉEL du pont (éphémère, port: 0) depuis la ligne onLog émise par
// bridge.ts au démarrage (même technique que tests/mjs-ws-bridge.test.ts)
async function startApp(opts: MjsWsOptions = {}): Promise<{ app: MjsWsApp; bridgePort: number; logs: LogLine[] }> {
  const transport = new MemoryTransport()
  const logs: LogLine[] = []
  let bridgePort  = 0
  const app = mjsWs({
    transport, heartbeat: 0,
    ...opts,
    onLog: (level, message, meta) => {
      logs.push({ level, message, meta })
      if (meta && typeof (meta as any).port === 'number' && /pont universel en écoute/.test(message)) bridgePort = (meta as any).port
    },
  })
  await app.listen()
  return { app, bridgePort, logs }
}

// requête signée — MÊME algorithme que bridge.ts, fabriqué indépendamment (node:crypto brut) ;
// badSig envoie une signature fausse MAIS un timestamp valide (fenêtre anti-rejeu respectée) —
// isole bien « échec de signature » de « échec d'horodatage ». Chaîne DIRIGÉE + INJECTIVE
// — direction 'in' (ces requêtes sont TOUTES des commandes admin entrantes),
// cf. tests/mjs-ws-bridge.test.ts pour la couverture directe de la séparation de domaine.
function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  const canonical = fields.map(f => f.length +':'+ f).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

async function req(port: number, method: string, path: string, body?: any, badSig = false): Promise<{ status: number; json: any }> {
  const bodyStr = body !== undefined ? JSON.stringify(body) : ''
  const ts      = Math.floor(Date.now() / 1000)
  const sig     = badSig ? '0'.repeat(64) : sign(SECRET, method, path, bodyStr, ts)
  const headers: Record<string, string> = { 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig }
  if (bodyStr) headers['content-type'] = 'application/json'
  const res  = await fetch('http://127.0.0.1:'+ port + path, { method, headers, body: bodyStr || undefined })
  const text = await res.text()
  let json: any = null
  try { json = JSON.parse(text) } catch { json = text }
  return { status: res.status, json }
}

// écrit un mj.config.json isolé dans un dossier temporaire — MÊME patron que
// tests/mjs-ws-resume-edge.test.ts (test « 5. validation config ws.resume »)
function writeConfig(config: unknown): string {
  const root = mjsTmp('bridge-ratelimit-cfg')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
  return root
}

// ============================================================================================

describe('MJS-WS — pont universel : limite de débit par IP', function () {
  this.timeout(15000)

  it('(a) seau général PAR IP dépassé → 429 rate-limited ; en dessous du seau → 200', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, rateLimit: { perIp: [3, 10000] } } })
    const statuses: number[] = []
    let last429: any = null
    for (let i = 0; i < 5; i++) {
      const r = await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
      statuses.push(r.status)
      if (r.status === 429) last429 = r.json
    }
    assert.deepEqual(statuses, [200, 200, 200, 429, 429], 'capacité 3 — les 2 requêtes suivantes sont rejetées')
    assert.deepEqual(last429, { ok: false, error: 'rate-limited' }, 'corps 429 minimal, sans autre détail')
    await app.stop()
  })

  it("(b) GET /health n'est JAMAIS 429, même seau général déjà épuisé", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, rateLimit: { perIp: [2, 10000] } } })
    await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
    await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
    const blocked = await req(bridgePort, 'POST', '/broadcast', { type: 'x' })
    assert.equal(blocked.status, 429, 'le seau général doit être épuisé à ce stade (pré-condition du test)')
    for (let i = 0; i < 5; i++) {
      const h = await fetch('http://127.0.0.1:'+ bridgePort +'/health')
      assert.equal(h.status, 200, `/health doit rester 200 même IP en pénalité (essai ${i})`)
      assert.equal(await h.text(), 'ok')
    }
    await app.stop()
  })

  it('(c) flot de signatures fausses (seau-échecs, défauts) → 401 ×10 puis 429, jamais de 401 après', async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET } })   // défauts : fails = [10, 60000]
    const statuses: number[] = []
    for (let i = 0; i < 13; i++) {
      const r = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, true)
      statuses.push(r.status)
    }
    // comptage 401 vs 429 (preuve en boîte noire — cf. commentaire de tête : TokenBucket
    // n'offrant aucun « peek », le seau-échecs se verrouille au moment même du 10e 401 confirmé ;
    // à partir de la 11e requête, isFailBlocked() court-circuite AVANT toute vérification HMAC)
    assert.deepEqual(statuses, [401, 401, 401, 401, 401, 401, 401, 401, 401, 401, 429, 429, 429])
    await app.stop()
  })

  it("(d) rateLimit: false → jamais 429, ni seau général ni seau-échecs", async () => {
    const { app, bridgePort } = await startApp({ bridge: { port: 0, secret: SECRET, rateLimit: false } })
    // seau-échecs désactivé — largement plus que le défaut (10) de mauvaises signatures restent 401
    for (let i = 0; i < 15; i++) {
      const r = await req(bridgePort, 'POST', '/broadcast', { type: 'x' }, true)
      assert.equal(r.status, 401, `requête ${i} : attendu 401 (jamais 429), reçu ${r.status}`)
    }
    // seau général désactivé — largement plus que le défaut (120) de requêtes signées restent 200
    // (en parallèle, pour la vitesse — 130 aller-retours HTTP séquentiels seraient inutilement lents)
    const results = await Promise.all(Array.from({ length: 130 }, () => req(bridgePort, 'POST', '/broadcast', { type: 'x' })))
    assert.ok(results.every(r => r.status === 200), 'aucune des 130 requêtes signées ne doit être 429')
    await app.stop()
  })

  it('(e) ws.bridge.rateLimit : clé inconnue / forme invalide → erreur avec suggestion ; formes valides acceptées', () => {
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { rateLimit: { perIpp: [120, 10000] } } } })),
      /ws\.bridge\.rateLimit\.perIpp : clé inconnue — tu voulais dire 'perIp' \?/,
    )
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { rateLimit: 'oui' } } })),
      /ws\.bridge\.rateLimit doit être 'false' ou un objet/,
    )
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { rateLimit: { perIp: [120] } } } })),
      /ws\.bridge\.rateLimit\.perIp doit être un tableau \[capacité, fenêtreMs\]/,
    )
    assert.throws(
      () => findConfig(writeConfig({ ws: { bridge: { rateLimit: { fails: [10, 0] } } } })),
      /ws\.bridge\.rateLimit\.fails doit être un tableau \[capacité, fenêtreMs\]/,
    )
    assert.doesNotThrow(() => findConfig(writeConfig({ ws: { bridge: { rateLimit: false } } })))
    assert.deepEqual(
      findConfig(writeConfig({ ws: { bridge: { rateLimit: { perIp: [200, 5000], fails: [5, 30000] } } } }))!.config.ws!.bridge!.rateLimit,
      { perIp: [200, 5000], fails: [5, 30000] },
    )
  })

  it('(f) éviction paresseuse : entrée intacte > 10 min → purgée au passage (horloge injectée)', () => {
    // createBridgeRateLimiter accepte `now` sur chaque méthode (défaut Date.now()) — SEULE la
    // logique d'éviction (comparaison de dates que l'on contrôle) est testée ici, jamais le
    // remplissage réel des TokenBucket internes (celui-ci reste sur l'horloge système, cf. guard.ts).
    const limiter = createBridgeRateLimiter({ perIp: { capacity: 5, windowMs: 10000 }, fails: { capacity: 5, windowMs: 10000 } })
    const t0 = 1_000_000_000
    limiter.admitGeneral('1.1.1.1', t0)
    limiter.admitGeneral('2.2.2.2', t0)
    limiter.admitGeneral('3.3.3.3', t0)
    assert.equal(limiter.size, 3)

    const t1 = t0 + 9 * 60 * 1000   // 3.3.3.3 retouchée AVANT ses 10 min d'inactivité — doit survivre
    limiter.admitGeneral('3.3.3.3', t1)

    const t2 = t0 + 11 * 60 * 1000   // 1.1.1.1/2.2.2.2 intactes depuis t0 : 11 min > 10 min → purgeables
    limiter.admitGeneral('4.4.4.4', t2)   // déclenche le passage de purge (sweep, cf. bridge.ts)

    assert.equal(limiter.size, 2, '1.1.1.1 et 2.2.2.2 purgées (>10 min sans accès) ; 3.3.3.3 (retouchée) et 4.4.4.4 (neuve) restent')
  })
})
