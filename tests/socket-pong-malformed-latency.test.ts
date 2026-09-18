// un `µ:pong` malformé
// (`msg.p` absent, ou `msg.p.ts` non numérique/incohérent) produisait un
// `NaN` ou une valeur négative absurde propagée TELLE QUELLE dans
// `sock.latency` — un champ RÉACTIF exposé au développeur (ex. un "ping:
// NaNms" affiché à l'écran). Le `_mjs_petWatchdog()` (preuve de vie) reste, lui,
// INCONDITIONNEL : recevoir ne serait-ce qu'un pong malformé prouve déjà que
// la connexion est vivante, indépendamment de la qualité de son contenu.
//
// Fix : la latence n'est assignée que si `_mjs_now() - ts` est un nombre FINI et
// >= 0 — un échantillon invalide est ignoré (la dernière valeur connue et
// valide reste affichée) plutôt que de corrompre le champ réactif.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

class MockWS {
  static instances: MockWS[] = []
  url: string; readyState = 0; sent: any[] = []
  onopen: any; onmessage: any; onclose: any; onerror: any
  constructor(url: string) { this.url = url; MockWS.instances.push(this) }
  send(data: string) { this.sent.push(JSON.parse(data)) }
  close() { this.readyState = 3 }
  _mjs_open() { this.readyState = 1; this.onopen && this.onopen({}) }
  _srv(obj: any) { this.onmessage && this.onmessage({ data: JSON.stringify(obj) }) }
  _mjs_drop(code = 1006) { this.readyState = 3; this.onclose && this.onclose({ code }) }
}
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
const last = () => MockWS.instances[MockWS.instances.length - 1]
function open(µ: any, url: string, opts?: any) {
  const s = µ.socket(url, opts); s.connect(); const ws = last()
  ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} }); return { s, ws }
}

// --- Harnais de timers 100% fake (même technique que
// socket-heartbeat-watchdog-ghost.test.ts — déterministe, pas de vraie
// temporisation, posé/restauré PAR TEST pour ne pas polluer les autres
// fichiers du même process Mocha).
type Timer = { id: number; at: number; fn: Function; intervalMs?: number }
let fakeNow = 0
let timers: Timer[] = []
let nextId = 1
function fakeSetTimeout(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn }); return id }
function fakeClearTimeout(id: number) { timers = timers.filter(t => t.id !== id) }
function fakeSetInterval(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn, intervalMs: ms }); return id }
function fakeClearInterval(id: number) { timers = timers.filter(t => t.id !== id) }
function advance(ms: number) {
  const target = fakeNow + ms
  for (let guard = 0; guard < 10000; guard++) {
    let earliest: Timer | null = null
    for (const t of timers) { if (t.at <= target && (!earliest || t.at < earliest.at)) earliest = t }
    if (!earliest) break
    fakeNow = earliest.at
    if (earliest.intervalMs != null) { earliest.at = fakeNow + earliest.intervalMs }
    else { timers = timers.filter(t => t !== earliest) }
    earliest.fn()
  }
  fakeNow = target
}

describe('µ.socket — µ:pong malformé : latence protégée, watchdog toujours nourri', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("µ:pong SANS p du tout : latency n'est PAS mise à NaN (reste à sa valeur précédente)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg1', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } }) // 1er pong valide
    const validLatency = s.latency
    assert.ok(typeof validLatency === 'number' && !Number.isNaN(validLatency))

    ws._srv({ t: 'µ:pong' }) // 2e pong SANS p
    assert.equal(s.latency, validLatency, "AVANT le fix : la latence valide précédente était écrasée par NaN")
    s.destroy()
  })

  it('µ:pong avec p.ts non numérique (chaîne) : latency inchangée', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg2', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    const validLatency = s.latency

    ws._srv({ t: 'µ:pong', p: { ts: 'not-a-number' } })
    assert.equal(s.latency, validLatency)
    assert.equal(Number.isNaN(s.latency), false, "AVANT le fix : NaN se propageait dans le champ réactif latency")
    s.destroy()
  })

  it('µ:pong avec ts INCOHÉRENT (futur, latence négative) : latency inchangée (valeur physiquement impossible rejetée)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg3', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    const validLatency = s.latency

    ws._srv({ t: 'µ:pong', p: { ts: performance.now() + 999999 } }) // ts dans le futur → latence négative
    assert.equal(s.latency, validLatency, "AVANT le fix : une latence négative absurde était acceptée telle quelle")
    s.destroy()
  })

  it('µ:pong avec p:null : latency inchangée (`now - null === now` ne doit PAS passer)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg6', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    const validLatency = s.latency
    ws._srv({ t: 'µ:pong', p: null })
    assert.equal(s.latency, validLatency, "AVANT le fix : p:null → now - null === now → latency = durée de session (positif, accepté)")
    s.destroy()
  })

  it('µ:pong avec p.ts booléen true : latency inchangée', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg7', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    const validLatency = s.latency
    ws._srv({ t: 'µ:pong', p: { ts: true } })
    assert.equal(s.latency, validLatency, "AVANT le fix : ts:true → now - 1 → latence absurde acceptée (typeof true !== 'number' maintenant)")
    s.destroy()
  })

  it('µ:pong valide : latency reste calculée normalement (comportement nominal inchangé)', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://pg4', { heartbeat: 0 })
    ws._srv({ t: 'µ:pong', p: { ts: performance.now() - 5 } })
    assert.ok(s.latency >= 0 && Number.isFinite(s.latency))
    s.destroy()
  })

  describe('watchdog nourri par un pong malformé (timers 100% fake, déterministe)', () => {
    let __prevSetTimeout: any, __prevClearTimeout: any, __prevSetInterval: any, __prevClearInterval: any
    beforeEach(() => {
      fakeNow = 0; timers = []; nextId = 1
      __prevSetTimeout = (globalThis as any).setTimeout
      __prevClearTimeout = (globalThis as any).clearTimeout
      __prevSetInterval = (globalThis as any).setInterval
      __prevClearInterval = (globalThis as any).clearInterval
      ;(globalThis as any).setTimeout = fakeSetTimeout
      ;(globalThis as any).clearTimeout = fakeClearTimeout
      ;(globalThis as any).setInterval = fakeSetInterval
      ;(globalThis as any).clearInterval = fakeClearInterval
    })
    afterEach(() => {
      ;(globalThis as any).setTimeout = __prevSetTimeout
      ;(globalThis as any).clearTimeout = __prevClearTimeout
      ;(globalThis as any).setInterval = __prevSetInterval
      ;(globalThis as any).clearInterval = __prevClearInterval
    })

    it('un pong malformé nourrit quand même le watchdog (garde-fou : la validation de latence ne doit PAS rendre _mjs_petWatchdog() conditionnel)', () => {
      // heartbeat=1000ms → watchdog à 2000ms par cycle (cf. socket-heartbeat-watchdog-ghost.test.ts).
      // Ce comportement (petWatchdog inconditionnel) était DÉJÀ correct avant
      // ce fix — le risque introduit par CE fix est spécifiquement d'imbriquer
      // _mjs_petWatchdog() par erreur DANS le nouveau `if` de validation de la
      // latence, ce qui le rendrait à tort conditionnel. Ce test verrouille
      // que ça n'arrive pas.
      const µ = makeMu()
      const { s, ws } = open(µ, 'wss://pg5', { heartbeat: 1000 })
      advance(1000) // 1er ping part, son watchdog est armé pour t=2000
      ws._srv({ t: 'µ:pong' }) // malformé (pas de p.ts), mais DOIT quand même nourrir le watchdog
      advance(1500) // dépasse l'échéance du 1er watchdog (2000) si non nourri
      assert.equal(s.state, 'open', '_mjs_petWatchdog() doit tourner MÊME quand la latence calculée est invalide et rejetée')
      s.destroy()
    })
  })
})
