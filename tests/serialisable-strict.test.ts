// La garde « sérialisable » (isSerializableEntry/streams.ts,
// isSerializablePayload/bridge.ts) s'appuyait sur `try { JSON.stringify(value) }` — or
// JSON.stringify ne LÈVE PAS pour une Map/Set/fonction/Symbol/`undefined` niché(e) : la valeur
// était acceptée puis disparaissait en silence à l'encodage ({} ou clé absente). Correctif :
// parcours DÉDIÉ (même règle, même message catalogué) refusant aussi ces cas.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

function lp(field: string): string { return field.length +':'+ field }
function sign(secret: string, method: string, pathWithQuery: string, body: string, ts: number): string {
  const fields    = ['in', String(ts), method.toUpperCase(), pathWithQuery, body]
  const canonical = fields.map(lp).join('')
  return createHmac('sha256', secret).update(canonical).digest('hex')
}

describe('garde « sérialisable » stricte (streams.ts + bridge.ts)', () => {
  describe('streams.ts::isSerializableEntry', () => {
    async function startApp(opts: MjsWsOptions = {}): Promise<{ app: MjsWsApp }> {
      const transport = new MemoryTransport()
      const app = mjsWs({ transport, heartbeat: 0, ...opts })
      await app.listen()
      return { app }
    }

    it('add() refuse une Map nichée (JSON.stringify ne lève pas, elle se vide en silence)', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-map')
      assert.throws(() => flux.add('e1', { m: new Map([['a', 1]]) }), /non sérialisable|trop imbriqu/)
      assert.equal(flux.size, 0)
      await app.stop()
    })

    it('add() refuse un Set niché', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-set')
      assert.throws(() => flux.add('e1', { s: new Set([1, 2]) }))
      await app.stop()
    })

    it('add() refuse une fonction nichée', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-fn')
      assert.throws(() => flux.add('e1', { cb: function () { return 1 } }))
      await app.stop()
    })

    it('add() refuse un `undefined` en valeur de propriété', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-undef')
      assert.throws(() => flux.add('e1', { u: undefined }))
      await app.stop()
    })

    it('add() refuse un Symbol niché', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-sym')
      assert.throws(() => flux.add('e1', { s: Symbol('x') }))
      await app.stop()
    })

    it('add() refuse un objet à toJSON NON standard (fidélité invérifiable)', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-tojson')
      assert.throws(() => flux.add('e1', { c: { toJSON: () => ({ ok: 1 }) } }))
      await app.stop()
    })

    it('add() ACCEPTE une Date nichée (toJSON natif, fidèle)', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-date')
      assert.doesNotThrow(() => flux.add('e1', { d: new Date('2026-01-01') }))
      assert.equal(flux.size, 1)
      await app.stop()
    })

    it('add() refuse une Map dans un TABLEAU niché (parcours des éléments)', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-arr')
      assert.throws(() => flux.add('e1', [1, 'x', new Map()]))
      await app.stop()
    })

    it('update()/reset() appliquent la MÊME garde, l\'état n\'est pas muté par un refus', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-upd')
      flux.add('e1', { n: 0 })
      assert.throws(() => flux.update('e1', { m: new Map() }))
      assert.throws(() => flux.reset({ e1: { m: new Map() } }))
      assert.deepEqual(flux.snapshot(), { e1: { n: 0 } })
      await app.stop()
    })

    it('une valeur légitime (objets/tableaux simples) reste acceptée', async () => {
      const { app } = await startApp()
      const flux = app.stream('f-ok')
      assert.doesNotThrow(() => flux.add('e1', { x: 1, tags: ['a', 'b'], meta: { ok: true, n: null } }))
      await app.stop()
    })
  })

  describe('bridge.ts::isSerializablePayload', () => {
    const SECRET = 'secret-serialisable'

    async function startApp(opts: MjsWsOptions = {}): Promise<{ app: MjsWsApp; bridgePort: number }> {
      const transport = new MemoryTransport()
      let bridgePort  = 0
      const app = mjsWs({
        transport, heartbeat: 0, ...opts,
        bridge: { port: 0, secret: SECRET, rateLimit: false, ...(opts.bridge as object ?? {}) },
        onLog: (level, message, meta) => {
          if (meta && typeof (meta as any).port === 'number' && /pont universel en écoute/.test(message)) bridgePort = (meta as any).port
        },
      })
      await app.listen()
      return { app, bridgePort }
    }

    async function post(port: number, path: string, body: any): Promise<{ status: number; json: any }> {
      const bodyStr = JSON.stringify(body)
      const ts      = Math.floor(Date.now() / 1000)
      const sig     = sign(SECRET, 'POST', path, bodyStr, ts)
      const res  = await fetch('http://127.0.0.1:'+ port + path, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-mjs-ws-timestamp': String(ts), 'x-mjs-ws-signature': sig },
        body: bodyStr,
      })
      const text = await res.text()
      let json: any = null
      try { json = JSON.parse(text) } catch { json = text }
      return { status: res.status, json }
    }

    // une charge HTTP naît d'un JSON.parse : elle ne peut JAMAIS porter de Map/Set/fonction/Symbol/
    // BigInt (aucun n'a de littéral JSON) — {} est donc INDISCERNABLE d'une Map vidée à l'écriture,
    // la garde du pont reste limitée à la profondeur (déjà en place) et à l'`undefined` (ci-dessous)
    it('POST /stream (add) — value = {} (équivalent d\'une Map une fois passée en JSON) reste ACCEPTÉ : le pont ne peut pas distinguer un objet vide d\'une Map vidée', async () => {
      const { app, bridgePort } = await startApp()
      const { status, json } = await post(bridgePort, '/stream', { name: 'p-map-equiv', op: 'add', id: 'e1', value: {} })
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      await app.stop()
    })

    // `p` OMIS (undefined) À LA RACINE reste ACCEPTÉ — comportement historique protégé par
    // tests/mjs-ws-bridge.test.ts (« requête bien signée → 200 » envoie `{type:'x'}`, sans `p`) :
    // le refus d'`undefined` ne s'applique donc QU'EN position NICHÉE (clé objet/élément de
    // tableau), jamais à la racine — et un `undefined` NICHÉ ne peut de toute façon JAMAIS naître
    // d'un JSON.parse (aucun littéral JSON pour ce type) : cette branche reste un filet sans effet
    // observable via HTTP aujourd'hui (posée par symétrie stricte avec streams.ts).
    it('POST /broadcast — `p` OMIS (undefined À LA RACINE) reste ACCEPTÉ, comportement historique inchangé', async () => {
      const { app, bridgePort } = await startApp()
      const { status, json } = await post(bridgePort, '/broadcast', { type: 'annonce' })
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      await app.stop()
    })

    it('POST /broadcast — `p: null` (payload explicitement vide) reste ACCEPTÉ (`null` n\'est jamais lossy)', async () => {
      const { app, bridgePort } = await startApp()
      const { status, json } = await post(bridgePort, '/broadcast', { type: 'annonce', p: null })
      assert.equal(status, 200)
      assert.equal(json.ok, true)
      await app.stop()
    })
  })
})
