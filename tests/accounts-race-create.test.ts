// race TOCTOU sur account:create — `byName.has(key)` vérifié
// AVANT l'`await hacherSecret` (accounts.ts), deux créations concurrentes du MÊME pseudo passaient
// TOUTES LES DEUX ce contrôle synchrone. Deux comptes
// distincts persistés sous le même pseudo, un seul joignable par account:login, l'autre devenant un
// compte FANTÔME (jeton reçu valide, secret d'origine ne permet plus jamais de se reconnecter).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs, accountsPackage, accountsAuth, MemoryAccountsPersistAdapter } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'
import type { MjsWsAccountsOptions } from '../src/mjs-ws/accounts.js'

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

const SECRET = 'secret-test-race-accounts'

async function startApp(opts: Partial<MjsWsAccountsOptions> = {}, wsOpts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp; persist: MemoryAccountsPersistAdapter }> {
  const transport = new MemoryTransport()
  const persist = new MemoryAccountsPersistAdapter()
  const app = mjsWs({ transport, heartbeat: 0, auth: accountsAuth(SECRET), onLog: () => {}, ...wsOpts })
  app.use(accountsPackage({ secret: SECRET, persist, ...opts } as MjsWsAccountsOptions))
  await app.listen()
  return { transport, app, persist }
}

function connectAnonyme(transport: MemoryTransport, url: string): any {
  const s = makeClient(transport).socket(url, { auth: () => undefined, reconnect: { enabled: false } })
  s.connect()
  return s
}

describe('MJS-WS — accounts.ts account:create sans race TOCTOU', () => {
  it('a. deux créations concurrentes du MÊME pseudo → UNE SEULE réussit, aucun doublon persisté', async () => {
    const { transport, app, persist } = await startApp()
    const s1 = connectAnonyme(transport, 'memory://race1')
    const s2 = connectAnonyme(transport, 'memory://race2')
    await tick()

    const [r1, r2] = await Promise.all([
      s1.request('account:create', { name: 'zora', secret: 'motdepasse123' }).then((r: any) => ({ ok: true, r })).catch((e: any) => ({ ok: false, e })),
      s2.request('account:create', { name: 'zora', secret: 'autremdp1234' }).then((r: any) => ({ ok: true, r })).catch((e: any) => ({ ok: false, e })),
    ])

    const succes = [r1, r2].filter((r: any) => r.ok)
    const echecs = [r1, r2].filter((r: any) => !r.ok)
    assert.equal(succes.length, 1, 'UNE SEULE des deux créations concurrentes doit réussir')
    assert.equal(echecs.length, 1, 'la SECONDE doit être refusée')
    assert.equal((echecs[0] as any).e, 'account-name-taken', 'même code catalogué qu\'une création normale sur pseudo déjà pris')

    const rows = await persist.load()
    const zoraRows = rows.filter(r => r.name.toLowerCase() === 'zora')
    assert.equal(zoraRows.length, 1, 'AUCUN doublon en persistance — un seul compte "zora"')

    // le compte réellement créé reste joignable par login — aucun compte fantôme (un des deux
    // secrets DOIT fonctionner, peu importe lequel des deux appelants a gagné la course)
    const s3 = connectAnonyme(transport, 'memory://race3')
    await tick()
    let loginOk = false
    try { await s3.request('account:login', { name: 'zora', secret: 'motdepasse123' }); loginOk = true } catch {}
    if (!loginOk) { try { await s3.request('account:login', { name: 'zora', secret: 'autremdp1234' }); loginOk = true } catch {} }
    assert.ok(loginOk, 'le secret du GAGNANT permet toujours de se reconnecter (pas de compte fantôme)')

    s1.destroy(); s2.destroy(); s3.destroy(); await app.stop()
  })
})
