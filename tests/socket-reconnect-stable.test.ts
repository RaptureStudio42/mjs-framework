// `_mjs_attempt` était remis à 0 à CHAQUE µ:welcome (mjs_socket.ts, AVANT le fix) — un serveur qui
// accueille PUIS coupe aussitôt (surcharge, bug, attaque) faisait donc retomber le client au
// palier le PLUS COURT du backoff à CHAQUE cycle, indéfiniment (l'escalade `[500,1000,2000,5000]`
// n'entrait jamais en jeu). Correctif : `_mjs_attempt` ne repart à 0 qu'après MJSOCKET_STABLE_MS de
// connexion TENUE depuis le welcome (cf. mjs_socket.ts, constante documentée).
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
  MockWS.instances = []
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
const last = () => MockWS.instances[MockWS.instances.length - 1]
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

describe('µ.socket — tempête de reconnexion (welcome+drop rapide → backoff escalade désormais)', function () {
  this.timeout(10000)

  it('6 cycles welcome+drop(5ms) → délais CROISSANTS (jamais le palier minimal à chaque fois)', async () => {
    const µ = makeMu()
    // MÊME backoff que la sonde (échelonné, jitter 0) — si l'escalade fonctionne, le délai entre
    // tentative N et N+1 grandit ; AVANT le fix, `attempts` valait [0,0,0,0,0,0] et tous les gaps
    // restaient sous 150ms (jamais 200/1000ms).
    const s: any = µ.socket('wss://storm', { reconnect: { backoff: [50, 200, 1000], jitter: 0 }, heartbeat: 0 })
    s.connect()
    const attempts: number[] = []
    const gaps: number[] = []
    for (let cycle = 0; cycle < 6; cycle++) {
      const ws = last()
      ws._mjs_open()
      ws._srv({ t: 'µ:welcome', p: {} })
      attempts.push(s._mjs_attempt)
      assert.equal(s.state, 'open')
      await delay(5)   // bien en dessous de MJSOCKET_STABLE_MS — jamais jugée stable
      const tDrop = Date.now()
      ws._mjs_drop()
      const nBefore = MockWS.instances.length
      while (MockWS.instances.length === nBefore) { await delay(2) }
      gaps.push(Date.now() - tDrop)
    }
    console.log('attempts après chaque welcome :', attempts)
    console.log('délais mesurés entre drop et prochaine tentative (ms) :', gaps)
    assert.ok(attempts.some(a => a > 0), `PROUVÉ : _mjs_attempt ne retombe plus systématiquement à 0 après welcome — attempts=${JSON.stringify(attempts)}`)
    assert.ok(gaps[gaps.length - 1] > gaps[0] + 30, `PROUVÉ : le dernier délai (${gaps[gaps.length - 1]}ms) doit être NETTEMENT plus grand que le premier (${gaps[0]}ms) — backoff qui escalade enfin`)
    s.destroy()
  })

  it("connexion TENUE au-delà de MJSOCKET_STABLE_MS → _mjs_attempt REPART bien à 0 au cycle suivant (cas nominal préservé)", async () => {
    const µ = makeMu()
    const s: any = µ.socket('wss://stable', { reconnect: { backoff: [50, 200, 1000], jitter: 0 }, heartbeat: 0 })
    s.connect()

    // 1er cycle : échoue vite (2 tentatives) pour faire monter _mjs_attempt AVANT la connexion stable
    let ws = last(); ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} }); await delay(5); ws._mjs_drop()
    await delay(70)   // laisse passer le 1er palier de backoff (50ms)
    ws = last(); ws._mjs_open(); ws._srv({ t: 'µ:welcome', p: {} })
    assert.ok(s._mjs_attempt > 0, `sanity : _mjs_attempt doit être > 0 juste après ce 2e welcome (pas encore stable) — ${s._mjs_attempt}`)

    // tient la connexion PLUS LONGTEMPS que MJSOCKET_STABLE_MS (2000ms, cf. mjs_socket.ts)
    await delay(2100)
    assert.equal(s._mjs_attempt, 0, 'PROUVÉ : une connexion tenue au-delà du délai de stabilité remet bien _mjs_attempt à 0')

    ws._mjs_drop()
    const nBefore = MockWS.instances.length
    while (MockWS.instances.length === nBefore) { await delay(2) }
    s.destroy()
  })
})
