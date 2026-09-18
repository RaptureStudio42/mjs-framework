// Reprise de session : identity/tokenExpiresAt RAFRAÎCHIS depuis le authFn frais
// (src/mjs-ws/core.ts::resumeClient) — sinon autorisation périmée conservée + déconnexions
// parasites sur un jeton neuf. MÊME technique que tests/mjs-ws-token-expiry.test.ts.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const clientSrc = readFileSync(join(__dirname, '../src/runtime/mjs_socket.ts'), 'utf8')

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

function makeMu(): any {
  const µ: any = { state: (i: any) => ({ ...i }), error: () => {}, warn: () => {}, log: () => {} }
  new Function('µ', clientSrc)(µ)
  return µ
}

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

describe('reprise de session : identity/tokenExpiresAt rafraîchis', () => {
  it('identity RAFRAÎCHIE avec le résultat du authFn REJOUÉ à la reprise (pas l\'ancien objet figé)', async () => {
    let authCalls = 0
    const { transport, app } = await startApp({
      resume: true, onLog: () => {},
      auth: () => { authCalls++; return { id: 'u1', appelNo: authCalls, exp: (Date.now() + 10000) / 1000 } },
    })
    ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
    const µ = makeMu()
    const s = µ.socket('memory://s2-4a', { auth: () => ({}), reconnect: { enabled: false } })

    s.connect(); await tick()
    assert.equal(authCalls, 1)
    let client: any = Array.from(app.clients)[0]
    assert.equal(client.identity.appelNo, 1)

    s._mjs_ws.close(1006, 'coupure'); await tick()   // parqué
    s.connect(); await tick()                     // reprise — authFn rappelé (docs/23 §8.2)

    assert.equal(authCalls, 2, 'authFn bien rejoué à la reprise')
    client = Array.from(app.clients)[0]
    assert.equal(client.identity.appelNo, 2, 'identity RAFRAÎCHIE avec le résultat de CE 2e appel — pas l\'ancien')

    s.destroy(); await app.stop()
  })

  it('jeton COURT avant coupure, jeton LONG à la reprise : aucune déconnexion parasite sur l\'ANCIENNE échéance', async () => {
    let authCalls = 0
    const { transport, app } = await startApp({
      resume: true, onLog: () => {},
      token: { sweep: 30, slack: 20 },
      // 1er appel (hello initial) : échéance COURTE (~150ms) ; 2e appel (reprise) : échéance LONGUE (~5000ms)
      auth: () => { authCalls++; return { id: 'u1', exp: (Date.now() + (authCalls === 1 ? 150 : 5000)) / 1000 } },
    })
    ;(globalThis as any).WebSocket = function(url: string, protocols?: any) { return transport.connect({ url, protocols }) }
    const µ = makeMu()
    const s = µ.socket('memory://s2-4b', { auth: () => ({}), reconnect: { enabled: false } })

    s.connect(); await tick()
    s._mjs_ws.close(1006, 'coupure'); await tick()   // parqué AVANT que la 1re échéance (150ms) ne soit atteinte
    s.connect(); await tick()                     // reprise — jeton LONG (5000ms) rafraîchi

    // dépasse largement l'ANCIENNE échéance (150ms) mais reste bien en-deçà de la NOUVELLE (5000ms)
    await tick(400)

    assert.equal(s.state, 'open', 'pas de kick token-expired parasite : l\'échéance a bien été rafraîchie à la reprise')
    assert.equal(app.stats().garde.expirationsJeton, 0)

    s.destroy(); await app.stop()
  })
})
