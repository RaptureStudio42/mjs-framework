// BridgePersistAdapter.load() doit valider la forme des entrées `{id, data}` reçues
// du back : id chaîne non vide, data objet ; entrées fautives ignorées avec avertissement.
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { createServer } from 'node:http'
import { BridgePersistAdapter } from '../src/mjs-server/index.js'

describe('persist-bridge.ts — load() : validation de forme', () => {
  it('filtre les entrées malformées reçues du back, journalise un avertissement, garde les valides', async function () {
    this.timeout(8000)
    const SECRET = 'secret-persist-bridge-shape-test'
    const server = createServer((req, res) => {
      const chunks: Buffer[] = []
      req.on('data', (c: Buffer) => chunks.push(c))
      req.on('end', () => {
        const body      = Buffer.concat(chunks).toString('utf8')
        const ts        = req.headers['x-mjs-ws-timestamp']
        const sig       = req.headers['x-mjs-ws-signature']
        const canonical = ts + '.' + req.method + '.' + req.url + '.' + body
        const expected  = createHmac('sha256', SECRET).update(canonical).digest('hex')
        if (expected !== sig) { res.writeHead(401); res.end('signature invalide'); return }
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, games: [
          { data: { type: 'x' } },        // id manquant
          { id: 'g1', data: null },       // data null
          { id: 42, data: { type: 'y' } },  // id non-string
          { id: 'g2', data: { type: 'z' } },  // valide
        ] }))
      })
    })
    await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()))
    const port = (server.address() as any).port
    const logs: Array<[string, string]> = []
    const adapter = new BridgePersistAdapter({ url: `http://127.0.0.1:${port}/mjs-server/persist`, secret: SECRET, onLog: (level: string, msg: string) => logs.push([level, msg]) })

    const rows = await adapter.load()
    await new Promise<void>(r => server.close(() => r()))

    assert.deepEqual(rows.map(r => r.id), ['g2'], 'seule l\'entrée bien formée doit survivre')
    assert.ok(logs.some(([level]) => level === 'warn'), 'un avertissement doit signaler les entrées malformées')
  })
})
