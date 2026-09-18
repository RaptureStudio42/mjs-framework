// Tests du suivi d'expiration + rafraîchissement du jeton EN VOL (src/mjs-ws/core.ts
// § µ:refresh / balayage périodique) — contre le VRAI client µ.socket (sock.refresh) et un vrai
// mjsWs() en mémoire, même technique que tests/mjs-ws-core.test.ts/tests/mjs-ws-resume.test.ts.
// sweep/slack réduits par test (option `token`) pour rester rapides — le contrat par défaut
// (10 s / 5 s) est couvert par la résolution des options (index.ts) et par la validation stricte
// de ws.token (bundler/config.ts, même patron que ws.resume, cf. tests/mjs-ws-resume-edge.test.ts).
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { signToken, jwtAuth } from '../src/mjs-ws/token.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import { findConfig } from '../src/bundler/config.js'
import { buildRunPlan } from '../src/cli/ws.js'
import type { EntryContract } from '../src/cli/ws.js'
import { mjsTmp } from './helpers/tmp.js'

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

interface Spy { in?: Array<{ url: string; msg: any }> }

// espion de trames ENTRANTES routé par URL — cf. tests/mjs-ws-resume.test.ts pour le pourquoi
// (une reconnexion réutilise la MÊME factory WebSocket globale)
function wireWebSocket(transport: MemoryTransport, perUrl: Record<string, Spy> = {}): void {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) {
    const ws: any = transport.connect({ url, protocols })
    const spy = perUrl[url]
    if (spy && spy.in) {
      const bucket = spy.in
      let real: any = null
      Object.defineProperty(ws, 'onmessage', {
        get() { return real },
        set(fn: any) { real = fn && ((ev: any) => { bucket.push({ url, msg: JSON.parse(ev.data) }); fn(ev) }) },
      })
    }
    return ws
  }
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

const SECRET = 'secret-test-token-expiry'

// exp PRÉCIS en ms depuis maintenant — CONTOURNE l'arrondi seconde entière de signToken({ttl})
// (iat = Math.floor(Date.now()/1000), exp = iat + ttl : un ttl=1 peut donc ne laisser qu'une
// FRACTION de seconde de validité réelle selon l'instant de signature dans la seconde en cours —
// PIÈGE découvert en écrivant ce test). `payload.exp` explicite n'est
// JAMAIS réécrit par signToken tant que `opts.ttl` est omis (spread AVANT `iat`, jamais `exp`) —
// précision au ms, déterministe, indispensable pour un test (b) qui rafraîchit à mi-course.
function tokenExpiringIn(ms: number, id: string): string {
  return signToken({ id, exp: (Date.now() + ms) / 1000 }, SECRET)
}

describe('MJS-WS — suivi d\'expiration + rafraîchissement du jeton (boucle complète, vrai client µ.socket)', () => {
  it('a. jeton exp ~1 s → µ:error token-expired reçu PUIS fermeture, reconnexion possible', async () => {
    const { transport, app } = await startApp({ auth: jwtAuth(SECRET), token: { sweep: 30, slack: 20 }, onLog: () => {} })   // le kick d'expiration est INTENTIONNEL
    const recu: Array<{ url: string; msg: any }> = []
    wireWebSocket(transport, { 'memory://token-a': { in: recu } })
    const µ = makeMu()
    const s = µ.socket('memory://token-a', { auth: () => ({ token: tokenExpiringIn(1000, 'u1') }), reconnect: { backoff: [10], jitter: 0 } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')

    await tick(1200)   // 1000ms (précis) + détection (sweep 30ms/slack 20ms) + reconnexion (backoff 10ms) + marge
    assert.equal(s.state, 'open', 'reconnexion possible après expiration (pas un µ:bye)')

    const iErr     = recu.findIndex(f => f.msg.t === 'µ:error' && f.msg.p?.code === 'token-expired')
    const welcomes = recu.map((f, i) => ({ i, msg: f.msg })).filter(f => f.msg.t === 'µ:welcome')
    assert.ok(iErr !== -1, `µ:error{code:'token-expired'} attendu, reçu : ${JSON.stringify(recu.map(f => f.msg.t))}`)
    assert.equal(welcomes.length, 2, 'accueil initial + accueil de reconnexion')
    assert.ok(welcomes[1].i > iErr, 'le 2e accueil (reconnexion) arrive APRÈS le µ:error de fermeture')
    // Le manque connu est désormais comblé (stats.ts) — la fermeture pour jeton expiré est désormais comptée,
    // DÉDIÉE (hors des 4 causes de MjsWsGuardCause : cette fermeture ne passe jamais par kickClient)
    assert.equal(app.stats().garde.expirationsJeton, 1, 'fermeture pour jeton expiré comptée (compteur dédié)')
    s.destroy(); await app.stop()
  })

  it('b. sock.refresh avec jeton neuf AVANT échéance → la connexion survit au-delà de l\'ancienne échéance', async () => {
    const { transport, app } = await startApp({ auth: jwtAuth(SECRET), token: { sweep: 30, slack: 20 }, onLog: () => {} })
    const recu: Array<{ url: string; msg: any }> = []
    wireWebSocket(transport, { 'memory://token-b': { in: recu } })
    const µ = makeMu()
    const s = µ.socket('memory://token-b', { auth: () => ({ token: tokenExpiringIn(1000, 'u1') }), reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')

    await tick(400)   // bien avant l'échéance initiale précise (1000ms après connect)
    const ack = await s.refresh(() => ({ token: tokenExpiringIn(3000, 'u1') }))
    assert.equal(typeof ack.exp, 'number', 'ack de succès porte la nouvelle échéance (secondes epoch)')

    await tick(800)   // total ~1200ms depuis connect — dépasse l'ANCIENNE échéance précise (1000ms) avec marge, bien avant la NOUVELLE (~3400ms)
    assert.equal(s.state, 'open', 'toujours ouverte au-delà de l\'ancienne échéance grâce au refresh')
    assert.ok(!recu.some(f => f.msg.t === 'µ:error' && f.msg.p?.code === 'token-expired'), 'aucune expiration détectée : le refresh a bien décalé l\'échéance suivie côté serveur')
    s.destroy(); await app.stop()
  })

  it('c. refresh invalide → refresh-denied, connexion toujours vivante', async () => {
    const { transport, app } = await startApp({ auth: jwtAuth(SECRET), token: { sweep: 30, slack: 20 }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://token-c', { auth: () => ({ token: signToken({ id: 'u1' }, SECRET, { ttl: 60 }) }), reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')

    await assert.rejects(
      s.refresh(() => ({ token: 'ceci-nest-pas-un-jeton-valide' })),
      (e: any) => e === 'refresh-denied',
    )
    await tick()
    assert.equal(s.state, 'open', 'connexion toujours vivante après un refresh raté')
    s.destroy(); await app.stop()
  })

  it('d. refresh changeant identity.id → refusé', async () => {
    const { transport, app } = await startApp({ auth: jwtAuth(SECRET), token: { sweep: 30, slack: 20 }, onLog: () => {} })
    const µ = makeClient(transport)
    const s = µ.socket('memory://token-d', { auth: () => ({ token: signToken({ id: 'u1' }, SECRET, { ttl: 60 }) }), reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    assert.equal((Array.from(app.clients)[0] as any).identity.id, 'u1')

    await assert.rejects(
      s.refresh(() => ({ token: signToken({ id: 'u2' }, SECRET, { ttl: 60 }) })),
      (e: any) => e === 'refresh-denied',
    )
    await tick()
    assert.equal(s.state, 'open')
    assert.equal((Array.from(app.clients)[0] as any).identity.id, 'u1', 'identity.id INCHANGÉE — le refresh refusé n\'a rien modifié')
    s.destroy(); await app.stop()
  })

  it('e. sans jwtAuth (ni exp nulle part) → aucun balayage jamais armé', async () => {
    const { transport, app } = await startApp({ token: { sweep: 30, slack: 20 }, onLog: () => {} })
    // introspection interne (`as any`, précédent établi cf. (app as any)._cluster/_presence,
    // core.ts) — seul moyen d'observer directement qu'AUCUN setInterval n'a jamais été créé
    assert.equal((app as any)._tokenSweepArmed(), false, 'aucun client ne fournit jamais d\'échéance : le balayage ne doit jamais être armé')
    const µ = makeClient(transport)
    const s = µ.socket('memory://token-e', { reconnect: { enabled: false } })
    s.connect(); await tick()
    assert.equal(s.state, 'open')
    assert.equal((app as any)._tokenSweepArmed(), false, 'toujours désarmé après une connexion authentifiée SANS échéance')

    // sans opts.auth DU TOUT, µ:refresh ne peut rien re-vérifier : refusé, jamais un succès silencieux
    await assert.rejects(s.refresh(() => 'peu importe'), (e: any) => e === 'refresh-denied')
    await tick(100)
    assert.equal(s.state, 'open', 'aucune fermeture inattendue en l\'absence totale de suivi')
    s.destroy(); await app.stop()
  })

  // le validateur ws.token (bundler/config.ts) et la priorité
  // entry > config du CLI (cli/ws.ts buildRunPlan) n'avaient AUCUN test — même patron que
  // tests 5/6 de tests/mjs-ws-resume-edge.test.ts (ws.resume), transposé à ws.token.
  it('f. validation config ws.token : clé inconnue → suggestion, type faux → erreur, entier ≤ 0 → erreur, formes valides acceptées', () => {
    const write = (config: unknown): string => {
      const root = mjsTmp('token-cfg')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
      return root
    }
    assert.throws(() => findConfig(write({ ws: { token: { sweep: 5000, slak: 3000 } } })), /ws\.token\.slak : clé inconnue — tu voulais dire 'slack' \?/)
    assert.throws(() => findConfig(write({ ws: { token: 'oui' } })), /'ws\.token' doit être un objet/)
    assert.throws(() => findConfig(write({ ws: { token: { sweep: 0 } } })), /ws\.token\.sweep doit être un entier > 0/)
    assert.throws(() => findConfig(write({ ws: { token: { slack: 12.5 } } })), /ws\.token\.slack doit être un entier > 0/)
    assert.deepEqual(findConfig(write({ ws: { token: {} } }))!.config.ws!.token, {}, 'les deux clés sont optionnelles — objet vide accepté')
    assert.deepEqual(findConfig(write({ ws: { token: { sweep: 20000, slack: 8000 } } }))!.config.ws!.token, { sweep: 20000, slack: 8000 })
  })

  it('g. CLI (buildRunPlan) : ws.token transmis depuis la config ; entry + config → warn doublon et l\'ENTRY prime en bloc', () => {
    const warns: string[] = []
    const warn = (message: string) => { warns.push(message) }

    // config seule → transmise telle quelle
    const seul: EntryContract = { options: {} }
    const planA = buildRunPlan(seul, { token: { sweep: 20000 } }, undefined, warn)
    assert.deepEqual(planA.options.token, { sweep: 20000 })
    assert.equal(warns.length, 0)

    // entry + config → warn + l'entry prime EN BLOC (pas de fusion clé à clé)
    const deux: EntryContract = { options: { token: { sweep: 1000, slack: 500 } } }
    const planB = buildRunPlan(deux, { token: { sweep: 99999 } }, undefined, warn)
    assert.deepEqual(planB.options.token, { sweep: 1000, slack: 500 }, 'l\'entry prime EN BLOC — pas de fusion clé à clé avec la config')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /token défini à la fois dans l'entry et dans mjs\.config\.json \(ws\.token\) — l'entry prime/)
  })
})
