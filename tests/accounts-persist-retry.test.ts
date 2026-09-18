// GARDE MUETTE : accounts.ts::assurerCharge() — un persist.load()
// qui échoue UNE FOIS au 1er accès n'était JAMAIS retenté (`charge` posé, promesse déjà réglée) :
// tous les comptes déjà persistés devenaient invisibles à VIE, et des doublons de pseudo silencieux
// devenaient possibles. `load()` appelé 1 SEULE
// fois malgré 4 requêtes account:* suivantes.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, accountsPackage, accountsAuth } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsAccountsOptions, MjsWsAccountsPersistAdapter, MjsWsAccountRecord } from '../src/mjs-ws/accounts.js'
import { scrypt, randomBytes } from 'node:crypto'

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
function hacherSecret(secret: string, salt: Buffer): Promise<string> {
  return new Promise((resolve, reject) => scrypt(secret, salt, 64, (err, k) => err ? reject(err) : resolve(k.toString('hex'))))
}

const SECRET = 'secret-test-loadfail'

async function startApp(persist: MjsWsAccountsPersistAdapter, opts: Partial<MjsWsAccountsOptions> = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {}, ...wsOpts })
  app.use(accountsPackage({ secret: SECRET, persist, ...opts } as MjsWsAccountsOptions))
  await app.listen()
  return { transport, app }
}
function connectAnonyme(transport: MemoryTransport, url: string): any {
  const s = makeClient(transport).socket(url, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect()
  return s
}

describe('MJS-WS — accounts.ts persist.load() en échec transitoire : retenté au prochain accès', () => {
  it("a. 1er load() qui lève, 2e qui réussit → le compte pré-existant redevient visible", async () => {
    const salt = randomBytes(16)
    const hash = await hacherSecret('secretpreexistant1', salt)
    const preexistant: MjsWsAccountRecord = { id: 'preexistant-id', name: 'zora', hash, salt: salt.toString('hex'), roles: [], createdAt: Date.now(), seenAt: Date.now(), meta: {} }

    let loadCalls = 0
    const adapter: MjsWsAccountsPersistAdapter = {
      async load() {
        loadCalls++
        if (loadCalls === 1) throw new Error('panne disque transitoire simulée')
        return [preexistant]
      },
      save() {}, remove() {}, flush() {},
    }

    const { transport, app } = await startApp(adapter)
    const s = connectAnonyme(transport, 'memory://loadfail1')
    await tick()

    // 1er accès — assurerCharge() échoue, avalé (juste un warn) — login refusé (compte invisible)
    let premierLogin: any
    try { premierLogin = await s.request('account:login', { name: 'zora', secret: 'secretpreexistant1' }) }
    catch (e) { premierLogin = { erreur: e } }
    assert.equal(loadCalls, 1, 'load() appelé une seule fois après le 1er login')
    assert.equal(premierLogin.erreur, 'account-denied', 'compte invisible juste après la panne (comportement attendu, PAS le bug)')

    // 2e accès — DOIT retenter load() (c'est le correctif) : la panne était transitoire, le compte redevient visible
    let secondLogin: any
    try { secondLogin = await s.request('account:login', { name: 'zora', secret: 'secretpreexistant1' }) }
    catch (e) { secondLogin = { erreur: e } }
    assert.equal(loadCalls, 2, 'load() RETENTÉ au 2e accès — plus jamais bloqué à 1 pour toujours')
    assert.equal(secondLogin.erreur, undefined, 'plus de rejet')
    assert.equal(secondLogin.ok, true, 'le compte PRÉ-EXISTANT redevient joignable après la retentative réussie')

    s.destroy(); await app.stop()
  })

  it("b. plus de doublon silencieux une fois la panne résolue — account:create voit l'existant", async () => {
    const salt = randomBytes(16)
    const hash = await hacherSecret('secretpreexistant1', salt)
    const preexistant: MjsWsAccountRecord = { id: 'preexistant-id', name: 'zora', hash, salt: salt.toString('hex'), roles: [], createdAt: Date.now(), seenAt: Date.now(), meta: {} }

    let loadCalls = 0
    const adapter: MjsWsAccountsPersistAdapter = {
      async load() {
        loadCalls++
        if (loadCalls === 1) throw new Error('panne disque transitoire simulée')
        return [preexistant]
      },
      save() {}, remove() {}, flush() {},
    }

    const { transport, app } = await startApp(adapter)
    const s1 = connectAnonyme(transport, 'memory://loadfail2a')
    await tick()
    try { await s1.request('account:login', { name: 'zora', secret: 'secretpreexistant1' }) } catch {}   // 1er accès, échoue

    const s2 = connectAnonyme(transport, 'memory://loadfail2b')
    await tick()
    await assert.rejects(
      s2.request('account:create', { name: 'zora', secret: 'nouveaumdp12' }),
      (e: any) => e === 'account-name-taken',
      "un DEUXIÈME 'zora' ne doit PLUS pouvoir être créé une fois la panne résolue",
    )

    s1.destroy(); s2.destroy(); await app.stop()
  })
})
