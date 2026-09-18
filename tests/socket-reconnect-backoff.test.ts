// deux régressions distinctes corrigées ici :
//   `_mjs_ensure()` (connexion paresseuse, appelé par tout on/send/request/
//           stream) passait par `connect()` → `_mjs_open()`, qui ANNULE le
//           `_mjs_reconnectTimer` et rouvre IMMÉDIATEMENT. Un émetteur continu
//           (position coalescée ~20/s) transformait alors le backoff en ~20
//           tentatives/s vers un serveur en difficulté. Fix : `_mjs_ensure()`
//           respecte une reconnexion déjà programmée ; `connect()` PUBLIC garde
//           le droit de forcer.
//   `new WebSocket(url)` qui jette (URL invalide) enclenchait le cycle
//           de reconnexion standard → boucle INFINIE sur une erreur permanente.
//           Fix : on abandonne (closed, lastError.code='badurl').

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

describe('µ.socket — _mjs_ensure() respecte le backoff de reconnexion', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("un send() pendant 'reconnecting' NE crée PAS de WebSocket immédiat (le timer de backoff reste l'arbitre)", () => {
    const µ = makeMu()
    const s = µ.socket('wss://bk1', { reconnect: { backoff: [5000], jitter: 0 }, heartbeat: 0 })
    s.connect()
    const ws1 = last(); ws1._mjs_open(); ws1._srv({ t: 'µ:welcome', p: {} })
    ws1._mjs_drop() // → reconnecting, timer 5000ms
    assert.equal(s.state, 'reconnecting')

    const nBefore = MockWS.instances.length
    s.send('move', { x: 1 }) // send pendant l'attente du backoff → _mjs_ensure()
    assert.equal(MockWS.instances.length, nBefore,
      "AVANT le fix : _mjs_ensure()→connect()→_mjs_open() annulait le backoff et rouvrait IMMÉDIATEMENT (pilonnage serveur)")
    assert.ok((s as any)._mjs_queue.find((m: any) => m.type === 'move'),
      'le message émis pendant le backoff alimente _mjs_queue (repart au prochain welcome), il n\'est pas perdu')
    s.destroy()
  })

  it("connect() EXPLICITE force toujours l'ouverture immédiate (l'appel PUBLIC garde ce droit)", () => {
    const µ = makeMu()
    const s = µ.socket('wss://bk2', { reconnect: { backoff: [5000], jitter: 0 }, heartbeat: 0 })
    s.connect()
    const ws1 = last(); ws1._mjs_open(); ws1._srv({ t: 'µ:welcome', p: {} })
    ws1._mjs_drop()
    const nBefore = MockWS.instances.length
    s.connect() // appel explicite : doit rouvrir tout de suite
    assert.equal(MockWS.instances.length, nBefore + 1, 'connect() explicite force la reconnexion immédiate (droit conservé)')
    s.destroy()
  })
})

describe('µ.socket — URL invalide : pas de reconnexion infinie', () => {
  it('un constructeur WebSocket qui jette abandonne (closed, badurl) au lieu de boucler', async () => {
    const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
    let created = 0
    ;(globalThis as any).WebSocket = class {
      constructor() { created++; throw new Error('SyntaxError: URL invalide') }
    } as any
    new Function('µ', src)(µ)

    const s = µ.socket('ws://[invalid')
    s.connect()
    assert.equal(s.state, 'closed', "AVANT le fix : _mjs_onClose({code:1006}) → reconnexion, la boucle repartait à vie")
    assert.equal(s.lastError.code, 'badurl', 'erreur explicite badurl (bug de dev, pas une panne réseau)')

    await new Promise((r) => setTimeout(r, 30))
    assert.equal(created, 1, "AVANT le fix : le constructeur était rappelé en boucle (backoff plafonné à 5s) — ici on n'essaie qu'UNE fois")
    s.destroy()
  })
})
