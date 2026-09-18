// compte fantôme si persist.save() échoue (account:create, accounts.ts
// ~544-545) : byName.set()/byId.set() s'exécutaient AVANT persist.save() — un échec de sauvegarde
// laissait le compte en mémoire (jeton reçu valide) mais JAMAIS persisté : le pseudo restait bloqué
// pour toute nouvelle tentative légitime, et login avec le secret d'origine réussissait encore.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, accountsPackage, accountsAuth } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { t } from '../src/messages/index.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsAccountsOptions, MjsWsAccountsPersistAdapter, MjsWsAccountRecord } from '../src/mjs-ws/accounts.js'

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

const SECRET = 'secret-test-persist-echec'

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

describe('MJS-WS — accounts.ts account:create : compte fantôme si persist.save() échoue', () => {
  it('a. save() qui lève → erreur cataloguée, pseudo libéré, secret d\'origine à jamais refusé', async () => {
    let saveCalls = 0
    const store = new Map<string, MjsWsAccountRecord>()
    const persist: MjsWsAccountsPersistAdapter = {
      async load() { return Array.from(store.values()) },
      save(id, account) {
        saveCalls++
        if (saveCalls === 1) throw new Error('panne disque simulée')
        store.set(id, account)
      },
      remove(id) { store.delete(id) },
      flush() {},
    }

    const { transport, app } = await startApp(persist)
    const s1 = connectAnonyme(transport, 'memory://persistfail1')
    await tick()

    // 1re tentative — save() lève → réponse d'erreur code kebab (jamais ok:true, jamais de phrase traduite au client)
    await assert.rejects(
      s1.request('account:create', { name: 'ghost', secret: 'motdepasseorigine1' }),
      (e: any) => e === 'account-persist-failed',
      'la 1re tentative doit être refusée par le code account-persist-failed',
    )

    // rien de persisté après l'échec — aucun index en mémoire non plus (byName/byId jamais peuplés)
    const rowsApresEchec = await persist.load()
    assert.equal(rowsApresEchec.filter(r => r.name === 'ghost').length, 0, 'rien de persisté après un save() en échec')

    // 2e tentative, MÊME pseudo, save() rétabli → réussit (pseudo libéré, aucun compte fantôme bloquant)
    const s2 = connectAnonyme(transport, 'memory://persistfail2')
    await tick()
    const creation = await s2.request('account:create', { name: 'ghost', secret: 'motdepassereussi2' }) as any
    assert.equal(creation.ok, true, 'la 2e création du MÊME pseudo réussit une fois save() rétabli')
    assert.equal(saveCalls, 2, 'save() appelé 2 fois (1er échec + 2e succès)')

    // le secret de la tentative ÉCHOUÉE ne doit JAMAIS permettre de se connecter (compte jamais créé)
    const s3 = connectAnonyme(transport, 'memory://persistfail3')
    await tick()
    await assert.rejects(
      s3.request('account:login', { name: 'ghost', secret: 'motdepasseorigine1' }),
      (e: any) => e === 'account-denied',
      'le secret de la tentative échouée ne doit jamais fonctionner (compte jamais créé)',
    )

    // le secret de la 2e création (RÉUSSIE) fonctionne
    const s4 = connectAnonyme(transport, 'memory://persistfail4')
    await tick()
    let loginOk = false
    try { await s4.request('account:login', { name: 'ghost', secret: 'motdepassereussi2' }); loginOk = true } catch {}
    assert.ok(loginOk, 'le secret de la création réussie fonctionne bien')

    s1.destroy(); s2.destroy(); s3.destroy(); s4.destroy(); await app.stop()
  })
})
