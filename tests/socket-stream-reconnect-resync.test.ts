// Test de régression — streams/presence re-souscrits via hello.resub mais pas de µ:resync depuis
// lastSeq : un stream déjà entamé (`lastSeq > 0`) qui se RE-abonnait après
// une reconnexion envoyait le MÊME `µ:sub-stream` nu qu'un tout PREMIER
// abonnement — aucune indication au serveur de « je suis déjà à la séquence
// N ». Les deltas survenus PENDANT la déconnexion étaient donc soit reperdus
// (si le serveur reprend le flux "à partir de maintenant"), soit re-livrés en
// double (si le serveur renvoie tout depuis le début) — incohérent avec le
// contrat déjà établi par `_mjs_onStreamDelta` (détection de trou EN COURS DE
// FLUX, qui envoie déjà `µ:resync` avec `from: lastSeq`).
//
// Fix : `_mjs_onWelcome` envoie désormais `µ:resync` (avec `from: lastSeq`), pas
// `µ:sub-stream`, pour tout stream ayant déjà vu AU MOINS un delta. Un stream
// jamais entamé (lastSeq encore à 0, ex. `stream()` appelé mais jamais reçu
// de delta avant la coupure) garde `µ:sub-stream` (rien à resynchroniser).

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

describe('µ.socket — reconnexion d\'un stream déjà entamé : µ:resync depuis lastSeq (PARTIEL du registre)', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("stream ayant déjà reçu des deltas AVANT la coupure : le reconnect envoie µ:resync(from:lastSeq), pas un µ:sub-stream nu", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://resync-basic', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    const $$x = s.stream('flux')
    const ws1 = last()
    ws1._mjs_open()
    ws1._srv({ t: 'µ:welcome', p: {} })
    ws1.sent.length = 0

    // Le stream progresse jusqu'à seq=3 (contigu) avant la coupure.
    ws1._srv({ t: 'flux', seq: 1, p: { op: 'add', key: 'a', value: 1 } })
    ws1._srv({ t: 'flux', seq: 2, p: { op: 'add', key: 'b', value: 2 } })
    ws1._srv({ t: 'flux', seq: 3, p: { op: 'add', key: 'c', value: 3 } })
    ws1.sent.length = 0

    ws1._mjs_drop()
    assert.equal(s.state, 'reconnecting')
    await new Promise(r => setTimeout(r, 10))

    const ws2 = last()
    assert.notEqual(ws2, ws1)
    ws2._mjs_open()
    ws2._srv({ t: 'µ:welcome', p: {} })

    const resync = ws2.sent.find((m: any) => m.t === 'µ:resync' && m.p.stream === 'flux')
    assert.ok(resync,
      "AVANT le fix : envoyait µ:sub-stream nu — aucune indication de lastSeq, deltas manqués pendant la coupure potentiellement reperdus")
    assert.equal(resync.p.from, 3, 'le resync doit repartir de la DERNIÈRE séquence connue AVANT la coupure')
    assert.ok(!ws2.sent.find((m: any) => m.t === 'µ:sub-stream' && m.p.stream === 'flux'),
      'ne doit PLUS envoyer le µ:sub-stream nu en parallèle (un seul message, sans ambiguïté pour le serveur)')

    // Bout-en-bout : les deltas repris après le resync (contigus à from:3) s'appliquent normalement.
    ws2._srv({ t: 'flux', seq: 4, p: { op: 'add', key: 'd', value: 4 } })
    assert.equal($$x.d, 4)
    s.destroy()
  })

  it("stream JAMAIS entamé (lastSeq=0, aucun delta reçu avant la coupure) : garde µ:sub-stream nu (rien à resynchroniser)", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://resync-fresh', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    s.stream('jamais-recu')
    const ws1 = last()
    ws1._mjs_open()
    ws1._srv({ t: 'µ:welcome', p: {} })
    ws1.sent.length = 0
    // Aucun delta ne survient — lastSeq reste à 0.

    ws1._mjs_drop()
    await new Promise(r => setTimeout(r, 10))
    const ws2 = last()
    ws2._mjs_open()
    ws2._srv({ t: 'µ:welcome', p: {} })

    assert.ok(ws2.sent.find((m: any) => m.t === 'µ:sub-stream' && m.p.stream === 'jamais-recu'),
      'toujours un µ:sub-stream nu quand il n\'y a rien à resynchroniser')
    assert.ok(!ws2.sent.find((m: any) => m.t === 'µ:resync' && m.p.stream === 'jamais-recu'),
      'pas de µ:resync pour un stream qui n\'a jamais vu le moindre delta')
    s.destroy()
  })

  it("un delta qui ressemble à un trou juste APRÈS le resync de reconnexion n'envoie PAS un 2e resync redondant (resyncing déjà posé)", async () => {
    const µ = makeMu()
    const s = µ.socket('wss://resync-noduplicate', { reconnect: { backoff: [0], jitter: 0 }, heartbeat: 0 })
    s.stream('flux')
    const ws1 = last()
    ws1._mjs_open()
    ws1._srv({ t: 'µ:welcome', p: {} })
    ws1._srv({ t: 'flux', seq: 1, p: { op: 'add', key: 'a', value: 1 } })
    ws1.sent.length = 0

    ws1._mjs_drop()
    await new Promise(r => setTimeout(r, 10))
    const ws2 = last()
    ws2._mjs_open()
    ws2._srv({ t: 'µ:welcome', p: {} })
    ws2.sent.length = 0 // on a déjà vérifié le 1er resync ci-dessus, on regarde APRÈS

    // Le serveur pousse un delta en avance (trou apparent) avant même d'avoir répondu au resync.
    ws2._srv({ t: 'flux', seq: 15, p: { op: 'add', key: 'z', value: 9 } })
    assert.ok(!ws2.sent.find((m: any) => m.t === 'µ:resync'),
      "resyncing déjà posé par _mjs_onWelcome → pas de 2e µ:resync en rafale avant la réponse au 1er")
    s.destroy()
  })
})
