// accounts.ts::genId() ne revérifiait PAS les collisions,
// contrairement à sessions.ts::issue() (`while (registry.has(id)) id = randomBytes(8)...`). Une
// collision réelle à 64 bits d'aléa n'est PAS observable de bout en bout (« pas de sonde
// pertinente à échelle testable » ; confirmé ici — monkey-patcher `crypto.randomBytes` n'atteint
// PAS la référence déjà liée statiquement par `import { randomBytes } from 'node:crypto'` dans
// accounts.ts sous ce bundler). `genId` accepte donc un `draw` optionnel (défaut = randomBytes réel,
// AUCUN changement de comportement pour tout appelant réel) — exposé en test UNIQUEMENT
// (`pkg._genId`/`pkg._byId`, même précédent que `_buckets`/`_presence`, chat.ts/lobby.ts) pour
// piloter une collision DÉTERMINISTE sans toucher à crypto.
import assert from 'node:assert/strict'
import { mjsWs, accountsPackage, accountsAuth } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}
function makeClient(transport: MemoryTransport): any {
  ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
  return makeMu()
}
function connectAnonyme(transport: MemoryTransport, url: string): any {
  const s = makeClient(transport).socket(url, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect()
  return s
}

const SECRET = 'secret-test-genid'

describe('MJS-WS — accounts.ts genId() revérifie les collisions', () => {
  it("a. id déjà présent dans byId → genId() reboucle jusqu'à un id LIBRE (même patron que sessions.ts::issue)", async () => {
    const transport = new MemoryTransport()
    const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {} })
    const pkg = accountsPackage({ secret: SECRET }) as any
    app.use(pkg)
    await app.listen()

    const s = connectAnonyme(transport, 'memory://genid1')
    await tick()
    await s.request('account:create', { name: 'zora', secret: 'motdepasse123' })
    const [idExistant] = pkg._byId.keys()
    assert.equal(typeof idExistant, 'string')

    // `draw` piloté à la main — 1er tirage = COLLISION délibérée (id déjà dans byId), 2e = libre.
    let appels = 0
    const draw = () => { appels++; return appels === 1 ? idExistant : 'id-libre-deterministe' }
    const resultat = pkg._genId(draw)

    assert.equal(appels, 2, 'genId() a dû retirer une 2e fois après la collision forcée')
    assert.equal(resultat, 'id-libre-deterministe', "l'id RETENU est celui du 2e tirage, jamais le collisionné")
    assert.notEqual(resultat, idExistant)

    s.destroy(); await app.stop()
  })

  it("b. aucune collision → genId() tire UNE SEULE fois (zéro changement de comportement, cas normal)", async () => {
    const transport = new MemoryTransport()
    const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {} })
    const pkg = accountsPackage({ secret: SECRET }) as any
    app.use(pkg)
    await app.listen()

    let appels = 0
    const draw = () => { appels++; return 'jamais-en-collision' }
    const resultat = pkg._genId(draw)

    assert.equal(appels, 1, 'un seul tirage si byId ne connaît pas déjà cet id (comportement historique préservé)')
    assert.equal(resultat, 'jamais-en-collision')

    await app.stop()
  })

  it("c. account:create réel (sans draw fourni) — toujours randomBytes, ids distincts (non-régression)", async () => {
    const transport = new MemoryTransport()
    const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {} })
    app.use(accountsPackage({ secret: SECRET }))
    await app.listen()

    const s1 = connectAnonyme(transport, 'memory://genid2a')
    const s2 = connectAnonyme(transport, 'memory://genid2b')
    await tick()
    const r1: any = await s1.request('account:create', { name: 'zora', secret: 'motdepasse123' })
    const r2: any = await s2.request('account:create', { name: 'theo', secret: 'motdepasse456' })
    assert.notEqual(r1.token, r2.token, 'deux comptes réels distincts (draw réel par défaut, inchangé)')

    s1.destroy(); s2.destroy(); await app.stop()
  })
})
