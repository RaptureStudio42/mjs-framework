// `sock.on(type, handler, { owner })` — dé-abonnement automatique
// à la destruction du owner, MÊME mécanisme que `µ.smooth` (opts.owner via
// `_mjs_onDestroy`, cf. mjs_smooth.ts) : pas de nouveau canal, un appelant de plus
// de l'API interne DÉJÀ prévue pour ça.
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
}
function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
function makeFakeOwner() {
  const cbs: Array<() => void> = []
  return {
    _mjs_onDestroy(fn: () => void) { cbs.push(fn); return fn },
    _destroyAll() { cbs.forEach(fn => fn()) }, // simule le teardown réel (disconnectedCallback)
  }
}
const last = () => MockWS.instances[MockWS.instances.length - 1]
function open(µ: any, url: string, opts?: any) {
  const s = µ.socket(url, opts); s.connect(); const ws = last(); ws._mjs_open()
  ws._srv({ t: 'µ:welcome', p: {} }); return { s, ws }
}

describe('µ.socket — dé-abonnement automatique via opts.owner', () => {
  beforeEach(() => { MockWS.instances = [] })

  it('owner détruit : le handler ne reçoit plus rien, et le compteur d\'abonnés redescend', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x')
    const owner = makeFakeOwner()
    let calls = 0
    s.on('score', function() { calls++; }, { owner: owner })
    ws._srv({ t: 'score', p: {} })
    assert.equal(calls, 1, 'reçoit le message tant que le owner est vivant')
    assert.equal(!!s._mjs_handlers.score, true, 'abonné avant destruction')

    owner._destroyAll()

    ws._srv({ t: 'score', p: {} })
    assert.equal(calls, 1, 'plus aucun appel après destruction du owner')
    assert.equal(!!s._mjs_handlers.score, false, 'compteur d\'abonnés redescendu (clé retirée)')
  })

  it('sans owner : comportement inchangé, aucune inscription à une destruction', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x')
    let calls = 0
    const off = s.on('score', function() { calls++; })
    ws._srv({ t: 'score', p: {} })
    assert.equal(calls, 1)
    off()
    ws._srv({ t: 'score', p: {} })
    assert.equal(calls, 1, 'off() explicite fonctionne toujours')
  })

  it('owner fourni ET off() explicite appelé avant destruction : pas de double-retrait, pas d\'erreur', () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://x')
    const owner = makeFakeOwner()
    let calls = 0
    const off = s.on('score', function() { calls++; }, { owner: owner })
    off()
    assert.doesNotThrow(() => owner._destroyAll())
    ws._srv({ t: 'score', p: {} })
    assert.equal(calls, 0)
  })
})
