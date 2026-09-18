// un `reset` de stream à
// une seq INFÉRIEURE à la dernière vue était jeté par la garde anti-doublon —
// exactement le cas d'un SERVEUR QUI REDÉMARRE (compteur de seq reparti de
// zéro, ex. seq=1) alors que le client avait vu une seq plus haute dans la
// session précédente (ex. 500). Le reset étant rejeté, `lastSeq` restait
// bloqué à 500 pour toujours, et TOUS les deltas suivants du serveur
// redémarré (seq repartant de 1, 2, 3…) étaient ENSUITE eux aussi jetés par
// la même garde — flux figé jusqu'à reload manuel de la page.
//
// Fix : `p.op !== 'reset'` ajouté à la garde anti-doublon (mjs_socket.ts,
// _mjs_onStreamDelta) — un reset est TOUJOURS appliqué et fait toujours autorité
// sur `lastSeq`, quelle que soit sa valeur relative à l'ancienne. Même
// exception déjà en place pour la détection de trou (juste en dessous dans
// le code) : un reset n'est ni un doublon ni un trou, c'est un remplacement
// d'état complet.

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

describe('µ.socket — stream : reset à seq inférieure (serveur redémarré)', () => {
  beforeEach(() => { MockWS.instances = [] })

  it("un reset à seq=1 APRÈS avoir vu seq=500 remplace bien l'état (pas jeté par la garde anti-doublon)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rs1')
    const $$x = s.stream('ennemis')
    ws._srv({ t: 'ennemis', seq: 500, p: { op: 'add', key: 'stale', value: { hp: 1 } } })
    assert.deepEqual($$x.stale, { hp: 1 })

    // Le serveur redémarre : son compteur de seq repart de 1, il repousse un
    // reset complet — AVANT le fix, `seq(1) <= lastSeq(500)` → jeté en silence.
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'reset', values: { fresh: { hp: 10 } } } })
    assert.ok(!('stale' in $$x), "AVANT le fix : le reset était jeté, l'ancien état 'stale' survivait")
    assert.deepEqual($$x.fresh, { hp: 10 }, "AVANT le fix : le reset était jeté, aucune nouvelle valeur appliquée")
    s.destroy()
  })

  it("après le reset à seq=1, les deltas suivants du serveur redémarré (seq=2, 3…) sont appliqués (pas bloqués à vie)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rs2')
    const $$x = s.stream('ennemis')
    ws._srv({ t: 'ennemis', seq: 500, p: { op: 'add', key: 'stale', value: {} } })
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'reset', values: {} } })

    // AVANT le fix : lastSeq restait figé à 500 → seq=2 (2 <= 500) aurait
    // AUSSI été jeté par la même garde, à vie.
    ws._srv({ t: 'ennemis', seq: 2, p: { op: 'add', key: 'a', value: { hp: 9 } } })
    assert.deepEqual($$x.a, { hp: 9 }, "AVANT le fix : le flux restait figé après le reset, seq=2 aussi jeté")
    s.destroy()
  })

  it("un delta NON-reset à seq déjà vue reste ignoré (la garde anti-doublon fonctionne toujours pour le cas normal)", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rs3')
    const $$x = s.stream('ennemis')
    ws._srv({ t: 'ennemis', seq: 5, p: { op: 'add', key: 'a', value: { v: 1 } } })
    // Retransmission dupliquée de la même seq, avec une valeur DIFFÉRENTE :
    // ne doit PAS être ré-appliquée (sinon on avalise n'importe quel doublon).
    ws._srv({ t: 'ennemis', seq: 5, p: { op: 'add', key: 'a', value: { v: 999 } } })
    assert.deepEqual($$x.a, { v: 1 }, 'un doublon (non-reset) doit rester ignoré, comme avant le fix')
    // Une seq PLUS ANCIENNE (arrivée hors-ordre), non-reset : ignorée aussi.
    ws._srv({ t: 'ennemis', seq: 3, p: { op: 'add', key: 'b', value: {} } })
    assert.ok(!('b' in $$x), 'une seq passée (non-reset) doit rester ignorée')
    s.destroy()
  })

  it("un reset SANS seq (snapshot non numéroté) remet lastSeq à 0 : les deltas suivants ne sont plus jetés", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rs5')
    const $$x = s.stream('ennemis')
    ws._srv({ t: 'ennemis', seq: 500, p: { op: 'add', key: 'stale', value: {} } })
    // Reset SANS seq : le serveur repart de zéro sans numéroter son snapshot.
    ws._srv({ t: 'ennemis', p: { op: 'reset', values: { fresh: { hp: 7 } } } })
    assert.ok(!('stale' in $$x), 'le reset non numéroté remplace bien l\'état')
    assert.deepEqual($$x.fresh, { hp: 7 })
    // AVANT le fix : le bloc `if (seq != null)` était sauté → lastSeq restait à
    // 500 → seq=1,2 (<=500) jetés à vie (flux figé).
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'add', key: 'a', value: { v: 1 } } })
    ws._srv({ t: 'ennemis', seq: 2, p: { op: 'add', key: 'b', value: { v: 2 } } })
    assert.deepEqual($$x.a, { v: 1 }, 'AVANT le fix : seq=1 jeté (lastSeq figé à 500 par le reset non numéroté)')
    assert.deepEqual($$x.b, { v: 2 })
    s.destroy()
  })

  it("un reset à seq PLUS HAUTE que lastSeq (cas normal, pas de redémarrage) continue de fonctionner", () => {
    const µ = makeMu(); const { s, ws } = open(µ, 'wss://rs4')
    const $$x = s.stream('ennemis')
    ws._srv({ t: 'ennemis', seq: 1, p: { op: 'add', key: 'a', value: {} } })
    ws._srv({ t: 'ennemis', seq: 2, p: { op: 'reset', values: { b: { hp: 3 } } } })
    assert.ok(!('a' in $$x))
    assert.deepEqual($$x.b, { hp: 3 })
    s.destroy()
  })
})
