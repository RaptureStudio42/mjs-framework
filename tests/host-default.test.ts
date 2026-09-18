// L'hôte par défaut de `mjs ws` passe à 127.0.0.1 (comme le
// pont, cf. resolveBridgeOptions/bridge.ts) — qui veut exposer le serveur le dit explicitement
// avec `--host ::`. Avant ce correctif, buildRunPlan laissait `host` undefined en l'absence de --host
// et de ws.host, ce que le transport `ws` traduit en « toutes les interfaces » (0.0.0.0) sans
// que personne ne l'ait demandé.
import assert from 'node:assert/strict'
import WebSocket from 'ws'
import { buildRunPlan } from '../src/cli/ws.js'
import { sweepRegistered } from './helpers/tmp.js'

const noWarn = () => {}

after(() => sweepRegistered())

function randomPort(): number { return 57500 + Math.floor(Math.random() * 1500) }

// ============================================================================================
// buildRunPlan — défaut 127.0.0.1
// ============================================================================================

describe('cli/ws — buildRunPlan : défaut host = 127.0.0.1', () => {
  it('ni --host ni ws.host → 127.0.0.1', () => {
    assert.equal(buildRunPlan({ options: {} }, undefined, undefined, noWarn).host, '127.0.0.1')
  })

  it('ws.host respecté quand posé', () => {
    assert.equal(buildRunPlan({ options: {} }, { host: '::' }, undefined, noWarn).host, '::')
  })

  it('--host prioritaire sur ws.host', () => {
    assert.equal(buildRunPlan({ options: {} }, { host: '::' }, undefined, noWarn, '127.0.0.1').host, '127.0.0.1')
  })

  it('--host :: → traverse tel quel (toutes interfaces, à la demande)', () => {
    assert.equal(buildRunPlan({ options: {} }, undefined, undefined, noWarn, '::').host, '::')
  })
})

// ============================================================================================
// serveur réel — sans --host, le bind est loopback (127.0.0.1), pas 0.0.0.0
// ============================================================================================

describe('cli/ws — mjsWs() en vrai serveur : sans host, écoute en loopback', () => {
  it('WsTransport.listen() sans host → connexion 127.0.0.1 acceptée', async () => {
    const { mjsWs } = await import('../src/mjs-ws/index.js')
    const port = randomPort()
    const app = mjsWs({ port, host: buildRunPlan({ options: {} }, undefined, undefined, noWarn).host })
    app.serve('ping', () => 'pong')
    await app.listen()
    try {
      const etat = await new Promise<string>((res) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        const minuteur = setTimeout(() => { ws.terminate(); res('TIMEOUT') }, 3000)
        ws.once('open', () => { clearTimeout(minuteur); ws.close(); res('CONNECTE') })
        ws.once('error', () => { clearTimeout(minuteur); res('ERREUR') })
      })
      assert.equal(etat, 'CONNECTE')
    } finally {
      await app.stop()
    }
  })
})
