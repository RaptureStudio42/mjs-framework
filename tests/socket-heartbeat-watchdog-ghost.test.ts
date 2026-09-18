// le watchdog du heartbeat
// (`_mjs_startHeartbeat`) vivait dans un slot UNIQUE (`_hbWatchdog`), réassigné à
// CHAQUE tick de `setInterval` SANS `clearTimeout` du précédent. La
// réassignation écrase seulement la RÉFÉRENCE JS — le timer NATIF du cycle
// précédent, lui, continue de courir en fantôme (orphelin, plus aucune
// variable ne le référence) jusqu'à son propre terme. Comme l'intervalle par
// défaut (`ms`) est plus COURT que le délai du watchdog (`ms*2`), un 2ᵉ ping
// part TOUJOURS avant l'échéance du 1ᵉʳ watchdog : un `µ:pong` reçu entre-temps
// n'annulait (`_mjs_petWatchdog`) que le watchdog COURANT (déjà réassigné au
// nouveau) — le FANTÔME du cycle d'avant restait armé et finissait par fermer
// une connexion PARFAITEMENT SAINE à son échéance, malgré un pong reçu depuis.
//
// Fix : TOUS les watchdogs en vol sont trackés (`_mjs_hbWatchdogs`, un tableau,
// pas un slot) ; un pong (`_mjs_petWatchdog`) les efface TOUS d'un coup — la
// preuve de vie la plus récente rend caduques toutes les échéances
// antérieures, pas seulement la plus proche.
//
// Piège évité pendant le développement de CE fix : une 1ʳᵉ version plus
// simple ("clear l'ancien watchdog avant de poser le nouveau, à chaque
// ping") semblait corriger le bug ci-dessus, mais désactivait ENTIÈREMENT la
// détection de connexion morte dans la config PAR DÉFAUT (intervalle <
// délai du watchdog) : le watchdog n'a alors JAMAIS le temps d'atteindre son
// échéance avant d'être supplanté par le ping suivant — repéré par le test
// "cas nominal" ci-dessous, qui a échoué avec cette 1ʳᵉ version.
//
// Testé avec un harnais de timers 100% FAKE (avance manuelle du temps virtuel,
// aucune vraie temporisation) — déterministe, rapide, et permet d'observer
// PRÉCISÉMENT la course entre plusieurs cycles de heartbeat qui serait sinon
// impossible à séquencer de façon fiable avec de vrais timers.

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
const last = () => MockWS.instances[MockWS.instances.length - 1]

// --- Harnais de timers 100% fake (avance manuelle, déterministe) ---
type Timer = { id: number; at: number; fn: Function; intervalMs?: number }
let fakeNow = 0
let timers: Timer[] = []
let nextId = 1
function fakeSetTimeout(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn }); return id }
function fakeClearTimeout(id: number) { timers = timers.filter(t => t.id !== id) }
function fakeSetInterval(fn: Function, ms: number) { const id = nextId++; timers.push({ id, at: fakeNow + ms, fn, intervalMs: ms }); return id }
function fakeClearInterval(id: number) { timers = timers.filter(t => t.id !== id) }
// Avance le temps virtuel de `ms`, exécutant tout timer dont l'échéance tombe
// dans l'intervalle, DANS L'ORDRE chronologique (les setInterval se replanifient).
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

let __prevSetTimeout: any, __prevClearTimeout: any, __prevSetInterval: any, __prevClearInterval: any
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
function open(µ: any, url: string, opts?: any) {
  const s = µ.socket(url, opts); s.connect(); const ws = last(); ws._mjs_open()
  ws._srv({ t: 'µ:welcome', p: {} }); return { s, ws }
}

describe('µ.socket — heartbeat : watchdog fantôme (cycle précédent jamais clearTimeout)', function () {
  beforeEach(() => {
    MockWS.instances = []
    fakeNow = 0; timers = []; nextId = 1
    // Globals de timer posés/restaurés PAR TEST (pas au top-level du module) :
    // ne pas répéter le piège de pollution croisée déjà rencontré 2× ce tour
    // avec des globals partagés entre fichiers du même process Mocha.
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

  it("un pong reçu au cycle N n'empêche PAS le watchdog fantôme du cycle N-1 de fermer une connexion saine", function () {
    // heartbeat=1000ms → watchdog à 2000ms par cycle.
    const µ = makeMu()
    const { s, ws } = open(µ, 'wss://hb-ghost', { heartbeat: 1000 })

    advance(1000) // tick #1 : ping envoyé, watchdog A armé pour t=3000 (1000+2000)
    assert.equal(ws.sent.filter((m: any) => m.t === 'µ:ping').length, 1)

    advance(1000) // t=2000 : tick #2 : ping envoyé, watchdog B armé pour t=4000 (2000+2000)
    assert.equal(ws.sent.filter((m: any) => m.t === 'µ:ping').length, 2)

    // Pong pour le ping du cycle #2 (connexion saine, répond normalement) —
    // clearTimeout du watchdog COURANT (B), comme _mjs_petWatchdog le fait déjà.
    ws._srv({ t: 'µ:pong', p: { ts: s._mjs_now() } })

    // Watchdog A (cycle #1, jamais clearTimeout AVANT le fix) doit arriver à
    // échéance à t=3000 — AVANT le fix, il fermait la connexion ICI malgré le
    // pong reçu juste au-dessus.
    advance(1000) // t=3000

    assert.equal(
      s.state, 'open',
      "AVANT le fix : le watchdog fantôme du cycle #1 (jamais clearTimeout) fermait une connexion SAINE à t=3000, malgré le pong reçu au cycle #2",
    )

    s.destroy()
  })

  it("cas nominal : AUCUN pong reçu → le watchdog ferme bien la connexion (pas de régression du comportement utile)", function () {
    const µ = makeMu()
    const { s } = open(µ, 'wss://hb-nominal', { heartbeat: 1000, reconnect: { enabled: false } })

    advance(1000) // ping #1, watchdog à t=3000
    // Aucun pong envoyé.
    advance(2000) // t=3000 : le watchdog doit fermer la connexion morte

    assert.notEqual(s.state, 'open', 'sans AUCUN pong, le watchdog doit toujours fermer la connexion morte')
    s.destroy()
  })
})
