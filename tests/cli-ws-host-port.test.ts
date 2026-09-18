// `mjs ws` écoutait sur toutes les interfaces par défaut, sans le dire (bannière muette
//    quand `host` est absent) ; aucun moyen de poser un hôte depuis WsCommandArgs/buildRunPlan.
//    `--port` (cliPort) n'était borné nulle part au niveau cli/ws.ts — un port hors plage
//    traversait buildRunPlan puis faisait lever un RangeError Node BRUT à la construction du
//    transport, au lieu d'un message clair (même règle que ws.port, bundler/config.ts).
//
// NOTE : le flag CLI --host lui-même (src/cli.ts, parseArgs générique,
// PARTAGÉ avec dev/serve/serveur) est hors périmètre de ce fichier — ce fichier
// teste `WsCommandArgs.host`/`buildRunPlan(..., cliHost)`, la plomberie côté cli/ws.ts, déjà prête
// à recevoir --host une fois câblé à cli.ts.
import assert from 'node:assert/strict'
import { writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { networkInterfaces } from 'node:os'
import WebSocket from 'ws'
import { buildRunPlan, runWsCommand } from '../src/cli/ws.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import { mjsTmp } from './helpers/tmp.js'

const noWarn = () => {}

const tmpDirs: string[] = []
function freshDir(prefix: string): string {
  const d = mjsTmp(prefix)
  tmpDirs.push(d)
  return d
}
after(() => { for (const d of tmpDirs) rmSync(d, { recursive: true, force: true }) })

function randomPort(): number { return 56500 + Math.floor(Math.random() * 2000) }

function patchConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = []
  const orig = { log: console.log, warn: console.warn, error: console.error }
  console.log   = (...a: any[]) => { lines.push(a.join(' ')) }
  console.warn  = (...a: any[]) => { lines.push(a.join(' ')) }
  console.error = (...a: any[]) => { lines.push(a.join(' ')) }
  return { lines, restore: () => { console.log = orig.log; console.warn = orig.warn; console.error = orig.error } }
}

// ============================================================================================
// buildRunPlan : --port/ws.port hors plage 1-65535
// ============================================================================================

describe('cli/ws — buildRunPlan : --port/ws.port hors plage 1-65535', () => {
  it('cliPort hors plage haute (99999) → throw catalogué, jamais un RangeError Node brut', () => {
    assert.throws(() => buildRunPlan({ options: {} }, undefined, 99999, noWarn), /port 99999 hors plage.*1 et 65535/)
  })

  it('cliPort négatif (-1) → throw catalogué', () => {
    assert.throws(() => buildRunPlan({ options: {} }, undefined, -1, noWarn), /hors plage/)
  })

  it('cliPort à 0 → throw catalogué (0 = port éphémère, hors de la plage 1-65535 explicitement demandée)', () => {
    assert.throws(() => buildRunPlan({ options: {} }, undefined, 0, noWarn), /hors plage/)
  })

  it('cliPort non entier (4000.5) → throw catalogué', () => {
    assert.throws(() => buildRunPlan({ options: {} }, undefined, 4000.5, noWarn), /hors plage/)
  })

  it('cliPort dans la plage → aucune exception, port repris tel quel', () => {
    assert.equal(buildRunPlan({ options: {} }, undefined, 4001, noWarn).port, 4001)
  })

  it('aucun cliPort/ws.port → défaut 4000, jamais rejeté par la borne', () => {
    assert.equal(buildRunPlan({ options: {} }, undefined, undefined, noWarn).port, 4000)
  })

  it('ws.port (config, déjà validée 1-65535 par bundler/config.ts) → jamais re-rejeté ici', () => {
    assert.equal(buildRunPlan({ options: {} }, { port: 4321 }, undefined, noWarn).port, 4321)
  })
})

// ============================================================================================
// buildRunPlan : host, cliHost (--host) prime sur ws.host
// ============================================================================================

describe('cli/ws — buildRunPlan : host, cliHost (--host) prime sur ws.host', () => {
  it('cliHost posé → prime sur ws.host', () => {
    assert.equal(buildRunPlan({ options: {} }, { host: '0.0.0.0' }, undefined, noWarn, '127.0.0.1').host, '127.0.0.1')
  })

  it('cliHost absent (appel à 4 arguments, forme HISTORIQUE) → ws.host inchangé, aucune régression', () => {
    assert.equal(buildRunPlan({ options: {} }, { host: '0.0.0.0' }, undefined, noWarn).host, '0.0.0.0')
  })

  it('ni cliHost ni ws.host → 127.0.0.1 (défaut loopback, comme le pont)', () => {
    assert.equal(buildRunPlan({ options: {} }, undefined, undefined, noWarn).host, '127.0.0.1')
  })
})

// ============================================================================================
// runWsCommand : host: '127.0.0.1' RESTREINT réellement le bind + bannière explicite
// ============================================================================================

describe("cli/ws — runWsCommand : host: '127.0.0.1'", function () {
  this.timeout(10000)

  it("un serveur lancé avec host: '127.0.0.1' accepte le loopback, refuse une IP LAN de la même machine (si dispo), et la bannière l'affiche", async () => {
    const root = freshDir('ws-host')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {\n    app.serve('ping', () => 'pong')\n  },\n}\n`)
    const port = randomPort()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs', port, host: '127.0.0.1' }, undefined, { watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('127.0.0.1')), `bannière sans l'hôte configuré. lignes:\n${cap.lines.join('\n')}`)

      const loopback = await new Promise<string>((resolve) => {
        const ws = new WebSocket(`ws://127.0.0.1:${port}/`)
        const timer = setTimeout(() => { ws.terminate(); resolve('TIMEOUT') }, 2000)
        ws.once('open', () => { clearTimeout(timer); ws.close(); resolve('CONNECTE') })
        ws.once('error', () => { clearTimeout(timer); resolve('ERREUR') })
      })
      assert.equal(loopback, 'CONNECTE', "host: '127.0.0.1' doit rester joignable en loopback")

      const lanIp = Object.values(networkInterfaces()).flat().find(i => i && i.family === 'IPv4' && !i.internal)?.address
      if (lanIp) {
        const viaLan = await new Promise<string>((resolve) => {
          const ws = new WebSocket(`ws://${lanIp}:${port}/`)
          const timer = setTimeout(() => { ws.terminate(); resolve('TIMEOUT/ECHEC') }, 2000)
          ws.once('open', () => { clearTimeout(timer); ws.close(); resolve('CONNECTE') })
          ws.once('error', () => { clearTimeout(timer); resolve('ERREUR') })
        })
        assert.notEqual(viaLan, 'CONNECTE', `host: '127.0.0.1' doit REFUSER une connexion via l'IP LAN (${lanIp})`)
      }
    } finally {
      await handle.stop()
    }
  })
})

// ============================================================================================
// bannière : hôte effectif TOUJOURS affiché, y compris le défaut (127.0.0.1)
// ============================================================================================

describe('cli/ws — bannière : hôte effectif toujours affiché, même par défaut', () => {
  it("aucun host (ni --host ni ws.host) → bannière affiche 127.0.0.1, PAS 'toutes les interfaces'", async () => {
    const root = freshDir('ws-banner-default')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {},\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => l.includes('127.0.0.1')), `bannière sans mention de l'hôte par défaut. lignes:\n${cap.lines.join('\n')}`)
      assert.ok(!cap.lines.some(l => /toutes les interfaces/.test(l)), `bannière mentionne encore 'toutes les interfaces' par défaut. lignes:\n${cap.lines.join('\n')}`)
    } finally {
      await handle.stop()
    }
  })

  it("host: '::' (--host ::) → bannière mentionne explicitement 'toutes les interfaces' (exposition assumée)", async () => {
    const root = freshDir('ws-banner-all')
    writeFileSync(join(root, 'ws.mjs'), `export default {\n  setup(app) {},\n}\n`)
    const transport = new MemoryTransport()
    const cap = patchConsole()
    const handle = await runWsCommand({ root, entry: 'ws.mjs', host: '::' }, undefined, { transport, watch: false })
    cap.restore()
    try {
      assert.ok(cap.lines.some(l => /toutes les interfaces/.test(l)), `bannière sans mention 'toutes les interfaces' avec --host ::. lignes:\n${cap.lines.join('\n')}`)
    } finally {
      await handle.stop()
    }
  })
})
