// Tests UI OPTIMISTE (µ.optimistic, mjs_optimistic.ts) — VRAI serveur
// MJS-WS (MemoryTransport) + VRAI client (mjs_socket.ts + mjs_optimistic.ts concaténés, ordre
// CANONIQUE du bundler), MÊME patron que tests/socket-schema.test.ts/socket-netcode.test.ts. Un SEUL
// `app.serve('op', …)` accepte/refuse/retarde selon la CHARGE reçue (`echoue`/`delaiMs`/`dx`) — suffit
// à construire tous les scénarios (succès, échec, empilage, timeout) sans multiplier les handlers.
// Réactivité prouvée UNE fois (test f) via le MÊME store réactif MINIMAL que tests/socket-game.test.ts
// (reactiveState/watchKey) — les autres tests utilisent un objet PLAIN (µ.optimistic ne connaît QUE
// get/set/énumération de propriétés, jamais une API `.subscribe`).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const socketSrc     = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')
const optimisticSrc = readFileSync(join(__dirname, '../src/runtime/mjs_optimistic.ts'), 'utf8')
// CONCATÉNÉS dans UN seul new Function, ordre CANONIQUE du bundler (mjs_socket.ts PUIS
// mjs_optimistic.ts, cf. src/bundler/index.ts::resolveRuntimeFiles) — mjs_optimistic.ts n'a AUCUNE
// dépendance dure à mjs_socket.ts (patron 'schema'/'predict' : `via` accepte n'importe quelle
// fonction -> Promise), l'ordre ne change donc rien à la correction, seulement le réalisme du test.
const clientSrc = socketSrc + '\n' + optimisticSrc

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

// store réactif MINIMAL — repris TEL QUEL de tests/socket-game.test.ts (cf. son commentaire) : seul
// le test (f) en a besoin, les autres se contentent d'un objet PLAIN (µ.optimistic ne lit/écrit que
// des propriétés ordinaires, aucune dépendance à une store µ précise).
const __optStoreSubs = new WeakMap<object, Map<string, Set<() => void>>>()
function reactiveState(init: any): any {
  const target: any = { ...init }
  const subs = new Map<string, Set<() => void>>()
  const proxy = new Proxy(target, {
    set(obj, key, value) {
      obj[key as string] = value
      const s = subs.get(key as string)
      if (s) s.forEach(fn => fn())
      return true
    },
    deleteProperty(obj, key) { delete obj[key as string]; return true },
  })
  __optStoreSubs.set(proxy, subs)
  return proxy
}
function watchKey(store: any, key: string, fn: () => void): void {
  const subs = __optStoreSubs.get(store)
  if (!subs) return
  let s = subs.get(key)
  if (!s) { s = new Set(); subs.set(key, s) }
  s.add(fn)
}

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

// serveur de référence — accepte/refuse/retarde selon la CHARGE reçue : `dx` (incrément appliqué au
// compteur serveur), `echoue` (throw immédiat, sans toucher au compteur), `delaiMs` (retard ARTIFICIEL
// avant de répondre — sert à observer un optimiste ENCORE EN VOL pendant qu'un autre s'est déjà réglé).
function declarerOp(app: MjsWsApp): { get: () => number } {
  let compteur = 0
  app.serve('op', async (p: any) => {
    if (p && typeof p.delaiMs === 'number' && p.delaiMs > 0) await tick(p.delaiMs)
    if (p && p.echoue) throw new Error('refus serveur')
    compteur += (p && typeof p.dx === 'number') ? p.dx : 0
    return { n: compteur }
  })
  return { get: () => compteur }
}

async function connecterAvecMu(transport: MemoryTransport, id: string): Promise<{ µ: any; sock: any }> {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  const µ = makeMu()
  const sock = µ.socket('memory://'+ id, { auth: () => ({ id }), reconnect: { enabled: false } })
  sock.connect()
  await tick()
  return { µ, sock }
}

describe('µ.optimistic — UI optimiste générique', () => {
  it('a. succès : le store porte la valeur optimiste AVANT la réponse serveur (aucun await entre l’appel et la lecture), et la garde après', async () => {
    const { transport, app } = await startApp()
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'a')
    const store: any = { n: 0 }
    const p = µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { dx: 1 }) })
    assert.equal(store.n, 1, 'valeur optimiste visible IMMÉDIATEMENT — preuve d’une application SYNCHRONE')
    const res = await p
    assert.equal(res.ok, true)
    assert.equal(store.n, 1, 'la valeur optimiste est GARDÉE après succès')
    await app.stop()
  })

  it('b. échec serveur (throw dans le handler) → ROLLBACK exact à l’état d’avant', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'b')
    const store: any = { n: 0 }
    const res = await µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { echoue: true }) })
    assert.equal(res.ok, false)
    assert.equal(store.n, 0, 'le store doit être revenu EXACTEMENT à l’état d’avant (0)')
    await app.stop()
  })

  it('c. `puis` re-applique la réponse serveur — remplace la devinette optimiste par la vérité serveur', async () => {
    const { transport, app } = await startApp()
    const srv = declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'c')
    const store: any = { n: 0 }
    // deviné localement +1, MAIS le serveur applique +5 (logique métier serveur) — `puis` doit faire
    // converger la store vers ce que le serveur a RÉELLEMENT décidé, pas la devinette locale.
    const res = await µx.optimistic(store, {
      apply: (state: any) => { state.n += 1 },
      via: () => sock.request('op', { dx: 5 }),
      after: (state: any, response: any) => { state.n = response.n },
    })
    assert.equal(res.ok, true)
    assert.equal(res.response.n, 5)
    assert.equal(store.n, 5, '`puis` doit avoir REMPLACÉ la devinette optimiste (1) par la vérité serveur (5)')
    assert.equal(srv.get(), 5)
    await app.stop()
  })

  it('d. deux optimistes EMPILÉS sur le même store, les DEUX réussissent → état final cohérent', async () => {
    const { transport, app } = await startApp()
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'd')
    const store: any = { n: 0 }
    const rA = µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { dx: 1 }) })
    const rB = µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { dx: 1 }) })
    assert.equal(store.n, 2, 'les DEUX effets optimistes doivent être visibles IMMÉDIATEMENT, empilés')
    const [resA, resB] = await Promise.all([rA, rB])
    assert.equal(resA.ok, true)
    assert.equal(resB.ok, true)
    assert.equal(store.n, 2, 'état final cohérent : les deux incréments sont restés appliqués')
    await app.stop()
  })

  it('e. deux empilés, le PREMIER échoue pendant que le SECOND est encore en vol → son rollback ne perd PAS l’effet du second', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'e')
    const store: any = { n: 0 }
    const rA = µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { echoue: true }) })
    const rB = µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { dx: 1, delaiMs: 150 }) })
    assert.equal(store.n, 2, 'sanity : les deux optimistes sont visibles, empilés')
    const resA = await rA
    assert.equal(resA.ok, false, 'sanity : A a bien échoué')
    assert.equal(store.n, 1, 'le rollback de A ne doit PAS avoir perdu l’effet de B, encore en vol à cet instant')
    const resB = await rB
    assert.equal(resB.ok, true)
    assert.equal(store.n, 1, 'état final : seul l’effet de B doit rester (A a été annulé)')
    await app.stop()
  })

  it('f. réactivité PROUVÉE : un abonné voit la valeur optimiste PUIS le rollback (deux notifications distinctes)', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'f')
    const store = reactiveState({ n: 0 })
    const vues: number[] = []
    watchKey(store, 'n', () => vues.push(store.n))
    const res = await µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { echoue: true }) })
    assert.equal(res.ok, false)
    assert.deepEqual(vues, [1, 0], 'un abonné doit avoir vu EXACTEMENT la valeur optimiste (1) PUIS le rollback (0)')
    await app.stop()
  })

  it('g. rejet RÉSEAU (timeout, pas un throw serveur) → rollback identique à un échec serveur', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerOp(app)   // 'op' existe, mais on cible un type SANS handler → aucun µ:ack ne peut jamais arriver
    const { µ: µx, sock } = await connecterAvecMu(transport, 'g')
    const store: any = { n: 0 }
    const res = await µx.optimistic(store, {
      apply: (state: any) => { state.n += 1 },
      via: () => sock.request('type-jamais-servi', {}, { timeout: 150 }),
    })
    assert.equal(res.ok, false)
    assert.equal(res.error.code, 'timeout')
    assert.equal(store.n, 0, 'rollback après timeout réseau, comme après un throw serveur')
    await app.stop()
  })

  it('h. la Promise résout TOUJOURS {ok:true, response} ou {ok:false, error} — jamais un rejet', async () => {
    const { transport, app } = await startApp({ onLog: () => {} })
    declarerOp(app)
    const { µ: µx, sock } = await connecterAvecMu(transport, 'h')
    const store: any = { n: 0 }

    const resOk = await µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { dx: 1 }) })
    assert.deepEqual(Object.keys(resOk).sort(), ['ok', 'response'])
    assert.equal(resOk.ok, true)
    assert.deepEqual(resOk.response, { n: 1 })

    const resKo = await µx.optimistic(store, { apply: (state: any) => { state.n += 1 }, via: () => sock.request('op', { echoue: true }) })
    assert.deepEqual(Object.keys(resKo).sort(), ['error', 'ok'])
    assert.equal(resKo.ok, false)
    assert.ok(resKo.error)
    await app.stop()
  })

  it('i. non-régression : sock.request() seul (sans µ.optimistic) reste inchangé', async () => {
    const { transport, app } = await startApp()
    app.serve('echo', async (p: any) => ({ echo: p }))
    const { sock } = await connecterAvecMu(transport, 'i')
    const res = await sock.request('echo', { x: 42 })
    assert.deepEqual(res, { echo: { x: 42 } })
    await app.stop()
  })
})
