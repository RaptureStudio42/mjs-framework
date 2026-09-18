// deux défauts distincts corrigés ici :
//  - send(type, p, {cooldown:'abc'}) comparait (now-last) < Number('abc') === NaN, TOUJOURS
//    faux — le cooldown se désactivait en silence, sans le `µ.warn` que debounce/coalesce émettent
//    déjà pour la même faute (cf. tests/socket.test.ts:306-319). Fix : `cooldown` passe désormais
//    par `_mjs_normWait`, comme les deux autres options.
//  - un débordement de `_mjs_queue` (maxQueue) perdait le message le plus ancien en silence
//    (FIFO bornée, conforme à la doc) — aucun `µ.warn`/`lastError` ne signalait la perte. Fix :
//    `µ.warn` UNE fois par débordement CONTINU + `lastError` renseigné, sans changer le contrat.
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
function makeMu(warnSpy?: (m: any) => void): any {
  MockWS.instances = []
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: warnSpy || (() => {}), log: () => {} }
  ;(globalThis as any).WebSocket = MockWS
  new Function('µ', src)(µ)
  return µ
}
const last = () => MockWS.instances[MockWS.instances.length - 1]
const delay = (ms: number) => new Promise<void>(r => setTimeout(r, ms))

// ============================================================================================
// cooldown invalide : averti désormais, comme debounce/coalesce
// ============================================================================================

describe('µ.socket.send — cooldown invalide, normalisé comme debounce/coalesce', () => {
  it("cooldown:'abc' → µ.warn UNE fois (AVANT le fix : 0 warning) — le throttle reste désactivé (repli sûr)", () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s = µ.socket('wss://cd1'); s.connect()
    last()._mjs_open(); last()._srv({ t: 'µ:welcome', p: {} })
    const ws = last()
    assert.equal(s.send('atk', {}, { cooldown: 'abc' }), true, '1er envoi passe')
    assert.equal(s.send('atk', {}, { cooldown: 'abc' }), true, "2e envoi passe aussi — repli sûr, cooldown neutralisé mais SIGNALÉ")
    assert.equal(ws.sent.filter((m: any) => m.t === 'atk').length, 2)
    assert.equal(warnings.length, 1, `PROUVÉ : un seul µ.warn émis — warnings=${warnings.length}`)
    assert.match(String(warnings[0]), /cooldown/)
    s.destroy()
  })

  it("cooldown invalide averti UNE SEULE fois même sur plusieurs envois successifs (même politique que debounce/coalesce)", () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s = µ.socket('wss://cd2'); s.connect()
    last()._mjs_open(); last()._srv({ t: 'µ:welcome', p: {} })
    for (let i = 0; i < 5; i++) { s.send('atk', {}, { cooldown: 'abc' }) }
    assert.equal(warnings.length, 1)
    s.destroy()
  })

  it('cooldown numérique valide throttle toujours normalement (non-régression)', () => {
    const µ = makeMu()
    const s = µ.socket('wss://cd3'); s.connect()
    last()._mjs_open(); last()._srv({ t: 'µ:welcome', p: {} })
    const ws = last()
    assert.equal(s.send('atk', {}, { cooldown: 10000 }), true, '1er envoi passe')
    assert.equal(s.send('atk', {}, { cooldown: 10000 }), false, '2e envoi immédiat → jeté (cooldown actif)')
    assert.equal(ws.sent.filter((m: any) => m.t === 'atk').length, 1)
    s.destroy()
  })

  it("cooldown:0 (falsy, comme AVANT le fix) reste sans effet, sans avertissement (0 est une valeur NUMÉRIQUE valide)", () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s = µ.socket('wss://cd4'); s.connect()
    last()._mjs_open(); last()._srv({ t: 'µ:welcome', p: {} })
    const ws = last()
    assert.equal(s.send('atk', {}, { cooldown: 0 }), true)
    assert.equal(s.send('atk', {}, { cooldown: 0 }), true)
    assert.equal(ws.sent.filter((m: any) => m.t === 'atk').length, 2)
    assert.equal(warnings.length, 0)
    s.destroy()
  })

  it('aucune option cooldown (absente) → comportement historique, aucun warning', () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s = µ.socket('wss://cd5'); s.connect()
    last()._mjs_open(); last()._srv({ t: 'µ:welcome', p: {} })
    assert.equal(s.send('atk', {}), true)
    assert.equal(warnings.length, 0)
    s.destroy()
  })
})

// ============================================================================================
// débordement de _mjs_queue (maxQueue) : averti + lastError, contrat FIFO inchangé
// ============================================================================================

describe('µ.socket._mjs_sendNow — débordement de _mjs_queue signalé (µ.warn + lastError), contrat FIFO inchangé', () => {
  it('5 envois hors-ligne avec maxQueue=3 → file [3,4,5] (FIFO inchangée), µ.warn 1x, lastError renseigné', () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s: any = µ.socket('wss://ov1', { maxQueue: 3 }); s.connect()   // jamais ouvert : reste hors-ligne
    for (let i = 1; i <= 5; i++) { s.send('m', { n: i }) }
    const q = s._mjs_queue.map((m: any) => m.payload.n)
    assert.deepEqual(q, [3, 4, 5], 'contrat FIFO INCHANGÉ : bornée à 3, les 2 plus anciens perdus')
    assert.equal(warnings.length, 1, `PROUVÉ : µ.warn émis (AVANT le fix : 0) — warnings=${warnings.length}`)
    assert.ok(s.lastError && s.lastError.code === 'queue-overflow', `PROUVÉ : lastError renseigné (AVANT le fix : null) — lastError=${JSON.stringify(s.lastError)}`)
    s.destroy()
  })

  it('débordement CONTINU (10 envois de plus, toujours hors-ligne) → un seul warning total, pas un par message perdu', () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s: any = µ.socket('wss://ov2', { maxQueue: 2 }); s.connect()
    for (let i = 1; i <= 12; i++) { s.send('m', { n: i }) }
    assert.equal(warnings.length, 1, `débordement continu → UN warning, pas un par message — warnings=${warnings.length}`)
    s.destroy()
  })

  it('sous le plafond (aucun débordement) → aucun warning, lastError reste null', () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s: any = µ.socket('wss://ov3', { maxQueue: 10 }); s.connect()
    for (let i = 1; i <= 3; i++) { s.send('m', { n: i }) }
    assert.equal(warnings.length, 0)
    assert.equal(s.lastError, null)
    s.destroy()
  })

  it('un nouveau débordement APRÈS une reconnexion (file vidée par le welcome) redéclenche UN nouveau warning (épisode neuf)', async () => {
    const warnings: any[] = []
    const µ = makeMu((m) => warnings.push(m))
    const s: any = µ.socket('wss://ov4', { maxQueue: 2, reconnect: { backoff: [10], jitter: 0 }, heartbeat: 0 })
    s.connect()
    for (let i = 1; i <= 5; i++) { s.send('m', { n: i }) }   // 1er débordement (hors-ligne)
    assert.equal(warnings.length, 1)

    // connexion + welcome → vide la file (rejoue), remet _mjs_queueOverflowWarned à false
    last()._mjs_open()
    last()._srv({ t: 'µ:welcome', p: {} })
    await delay(5)
    last()._mjs_drop()   // repasse hors-ligne

    for (let i = 6; i <= 10; i++) { s.send('m', { n: i }) }   // 2e débordement, épisode NEUF
    assert.equal(warnings.length, 2, `PROUVÉ : un nouveau débordement après une reconnexion redéclenche le warning — warnings=${warnings.length}`)
    s.destroy()
  })
})
