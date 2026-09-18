// Tests de la vérification d'origine opt-in des connexions entrantes (verifyOrigin,
// src/mjs-ws/core.ts::acceptConnection/refuseForOrigin + index.ts::resolveVerifyOriginOption) —
// absente (défaut) = comportement historique STRICT, aucune connexion refusée pour son origine ;
// posée (tableau = allowlist stricte, ou fonction = contrôle total), chaque connexion entrante est
// contrôlée à l'admission, AVANT le hello (pas de µ:denied, code de fermeture 1008 « Policy
// Violation », compteur DÉDIÉ stats.connexions.refuseesOrigine — MÊME patron que refuseForCap,
// cf. tests/mjs-ws-connection-cap.test.ts). MemoryTransport pour l'essentiel (origin déjà exposée
// par transport.ts::MemoryTransport.connect, cf. MjsWsRemoteInfo) ; un test transport RÉEL
// (bibliothèque `ws`) pour couvrir aussi transport-ws.ts (remoteInfo.origin posé ligne 119).
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport, MemoryClientSocket } from '../src/mjs-ws/transport.js'
import { findConfig } from '../src/bundler/config.js'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// plage dédiée à ce fichier — distincte des autres suites `ws` réelles (cf. leurs propres
// commentaires de tête, ex. tests/mjs-ws-connection-cap.test.ts 55000-59999) : réutilise la MÊME
// plage que connection-cap (aucune collision constatée, `randomPort()` reste local à ce fichier).
function randomPort(): number { return 55000 + Math.floor(Math.random() * 5000) }

function connectReal(port: number, origin?: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/`, origin !== undefined ? { origin } : undefined)
    ws.once('open', () => resolve(ws))
    ws.once('error', reject)
  })
}

// dossiers temporaires pour les tests de validation config (mjs.config.json) — jamais dans le
// dépôt, cf. feedback_scratch_cleanup_glob_precision.
const tmpDirs: string[] = []
function freshDir(): string {
  const d = mjsTmp('verify-origin')
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

function writeConfig(config: Record<string, unknown>): string {
  const root = freshDir()
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
  return root
}

// ============================================================================================
// non-régression — sans verifyOrigin, comportement historique STRICT (opt-in)
// ============================================================================================

describe('MJS-WS — verifyOrigin ABSENT : non-régression stricte (opt-in)', () => {
  it('aucune connexion refusée pour son origine, MÊME une origine exotique/absente', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, onLog: () => {} })
    await app.listen()
    try {
      const c1 = transport.connect({ url: 'memory://vo-noop-1' })
      const c2 = transport.connect({ url: 'memory://vo-noop-2', origin: 'http://tout-a-fait-etranger.example' })
      const c3 = transport.connect({ url: 'memory://vo-noop-3' })   // origin ABSENTE
      await tick()
      assert.equal(c1.readyState, MemoryClientSocket.OPEN)
      assert.equal(c2.readyState, MemoryClientSocket.OPEN)
      assert.equal(c3.readyState, MemoryClientSocket.OPEN)
      assert.equal(app.stats().connexions.refuseesOrigine, 0)
      c1.close(); c2.close(); c3.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// forme TABLEAU — allowlist stricte, insensible à la casse
// ============================================================================================

describe('MJS-WS — verifyOrigin (forme tableau, allowlist stricte)', () => {
  it('origine listée admise ; origine non listée refusée (close 1008) ; Origin absent refusé', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, verifyOrigin: ['https://exemple.com'], onLog: () => {} })
    await app.listen()
    try {
      const admis = transport.connect({ url: 'memory://vo-allow-ok', origin: 'https://exemple.com' })
      await tick()
      assert.equal(admis.readyState, MemoryClientSocket.OPEN)
      assert.equal(app.stats().connexions.refuseesOrigine, 0)
      admis.close()

      const refuse = transport.connect({ url: 'memory://vo-allow-ko', origin: 'https://autre.com' })
      const refuseClosed = new Promise<{ code: number; reason: string }>((resolve) => { refuse.onclose = (ev) => resolve(ev) })
      const ev1 = await refuseClosed
      assert.equal(ev1.code, 1008, "origine non listée → close 1008")
      assert.equal(app.stats().connexions.refuseesOrigine, 1)

      const sansOrigin = transport.connect({ url: 'memory://vo-allow-absent' })   // pas de champ `origin`
      const sansOriginClosed = new Promise<{ code: number; reason: string }>((resolve) => { sansOrigin.onclose = (ev) => resolve(ev) })
      const ev2 = await sansOriginClosed
      assert.equal(ev2.code, 1008, "Origin absent → refusé")
      assert.equal(app.stats().connexions.refuseesOrigine, 2)

      await tick()
    } finally {
      await app.stop()
    }
  })

  it("insensibilité à la casse ('https://Exemple.com' listé ↔ 'https://exemple.com' reçu)", async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, verifyOrigin: ['https://Exemple.com'], onLog: () => {} })
    await app.listen()
    try {
      const c = transport.connect({ url: 'memory://vo-case', origin: 'https://exemple.com' })
      await tick()
      assert.equal(c.readyState, MemoryClientSocket.OPEN, "comparaison insensible à la casse — admise")
      assert.equal(app.stats().connexions.refuseesOrigine, 0)
      c.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// forme FONCTION — contrôle total, fail-closed sur exception
// ============================================================================================

describe('MJS-WS — verifyOrigin (forme fonction)', () => {
  it('admet/refuse selon le retour du prédicat, reçoit origin + remote', async () => {
    const transport = new MemoryTransport()
    const vus: Array<{ origin: string | undefined; hasRemote: boolean }> = []
    const app = mjsWs({
      transport,
      verifyOrigin: (origin, remote) => {
        vus.push({ origin, hasRemote: remote !== undefined })
        return origin === 'https://admis.example'
      },
      onLog: () => {},
    })
    await app.listen()
    try {
      const ok = transport.connect({ url: 'memory://vo-fn-ok', origin: 'https://admis.example' })
      await tick()
      assert.equal(ok.readyState, MemoryClientSocket.OPEN)

      const ko = transport.connect({ url: 'memory://vo-fn-ko', origin: 'https://refuse.example' })
      const koClosed = new Promise<{ code: number; reason: string }>((resolve) => { ko.onclose = (ev) => resolve(ev) })
      const ev = await koClosed
      assert.equal(ev.code, 1008)
      assert.equal(app.stats().connexions.refuseesOrigine, 1)

      assert.equal(vus.length, 2)
      assert.ok(vus.every(v => v.hasRemote), 'le MjsWsRemoteInfo doit être transmis au prédicat')

      ok.close()
      await tick()
    } finally {
      await app.stop()
    }
  })

  it('un prédicat qui LÈVE une exception → refus (fail-closed)', async () => {
    const transport = new MemoryTransport()
    const app = mjsWs({
      transport,
      verifyOrigin: () => { throw new Error('boom — prédicat cassé') },
      onLog: () => {},
    })
    await app.listen()
    try {
      const c = transport.connect({ url: 'memory://vo-fn-throw', origin: 'https://peu-importe.example' })
      const closed = new Promise<{ code: number; reason: string }>((resolve) => { c.onclose = (ev) => resolve(ev) })
      const ev = await closed
      assert.equal(ev.code, 1008, "un prédicat qui lève doit REFUSER la connexion (fail-closed), pas planter/admettre")
      assert.equal(app.stats().connexions.refuseesOrigine, 1)
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// compteur stats — incrémenté SEULEMENT sur refus, jamais sur admission
// ============================================================================================

describe('MJS-WS — verifyOrigin : compteur stats.connexions.refuseesOrigine', () => {
  it('incrémenté sur refus, PAS sur admission', async () => {
    const transport = new MemoryTransport()
    const app       = mjsWs({ transport, verifyOrigin: ['https://exemple.com'], onLog: () => {} })
    await app.listen()
    try {
      assert.equal(app.stats().connexions.refuseesOrigine, 0)

      const ok1 = transport.connect({ url: 'memory://vo-stats-ok1', origin: 'https://exemple.com' })
      const ok2 = transport.connect({ url: 'memory://vo-stats-ok2', origin: 'https://exemple.com' })
      await tick()
      assert.equal(app.stats().connexions.refuseesOrigine, 0, "aucune admission ne doit incrémenter le compteur")

      const ko = transport.connect({ url: 'memory://vo-stats-ko', origin: 'https://etranger.example' })
      const koClosed = new Promise<void>((resolve) => { ko.onclose = () => resolve() })
      await koClosed
      assert.equal(app.stats().connexions.refuseesOrigine, 1)

      ok1.close(); ok2.close()
      await tick()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// transport RÉEL (bibliothèque `ws`) — remoteInfo.origin posé par transport-ws.ts
// ============================================================================================

describe('MJS-WS — verifyOrigin (transport RÉEL, bibliothèque `ws`)', function () {
  this.timeout(10000)

  it('client avec une origine non listée → close 1008', async () => {
    const port = randomPort()
    const app  = mjsWs({ transport: 'ws', port, host: '127.0.0.1', verifyOrigin: ['https://exemple.com'], onLog: () => {} })
    await app.listen()
    try {
      // MÊME technique que tests/mjs-ws-connection-cap.test.ts (refus au niveau APPLICATIF,
      // APRÈS l'upgrade WebSocket déjà complété par la bibliothèque `ws` côté transport) : le
      // client voit forcément 'open' (handshake TCP/HTTP déjà terminé), la fermeture arrive
      // juste après — c'est `close`/son CODE qui porte le refus, jamais l'absence d'`open`.
      const closeCode = await new Promise<number>((resolve, reject) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`, { origin: 'https://etranger.example' })
        ws.once('close', (code: number) => resolve(code))
        setTimeout(() => reject(new Error('timeout — la connexion aurait dû être fermée par le serveur')), 4000)
      })
      assert.equal(closeCode, 1008)
      assert.equal(app.stats().connexions.refuseesOrigine, 1)

      // non-régression : une origine listée passe toujours en transport RÉEL
      const admis = await connectReal(port, 'https://exemple.com')
      admis.close()
    } finally {
      await app.stop()
    }
  })
})

// ============================================================================================
// validation config (mjs.config.json) — SEULE la forme allowlist est représentable en JSON
// ============================================================================================

describe('mjs.config.json — section `ws.verifyOrigin` (validation stricte, patron des voisins)', () => {
  it('accepte un tableau non vide de chaînes non vides', () => {
    const root = writeConfig({ ws: { verifyOrigin: ['https://exemple.com', 'https://autre.com'] } })
    const found = findConfig(root)
    assert.ok(found)
    assert.deepEqual(found!.config.ws?.verifyOrigin, ['https://exemple.com', 'https://autre.com'])
  })

  it('throw sur ws.verifyOrigin = [] (tableau vide)', () => {
    const root = writeConfig({ ws: { verifyOrigin: [] } })
    assert.throws(() => findConfig(root), /ws\.verifyOrigin doit être un tableau non vide de chaînes non vides/)
  })

  it('throw sur ws.verifyOrigin = [42] (élément non-chaîne)', () => {
    const root = writeConfig({ ws: { verifyOrigin: [42] } })
    assert.throws(() => findConfig(root), /ws\.verifyOrigin doit être un tableau non vide de chaînes non vides/)
  })

  it("throw sur clé inconnue, avec suggestion orthographique ('verifyOrigim' → 'verifyOrigin') — non-régression Levenshtein", () => {
    const root = writeConfig({ ws: { verifyOrigim: ['https://exemple.com'] } })
    assert.throws(() => findConfig(root), /ws\.verifyOrigim : clé inconnue.*tu voulais dire 'verifyOrigin'/)
  })
})
