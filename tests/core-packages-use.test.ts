// app.use() : un installer qui LÈVE ne doit plus poisonner installedPackages
// (src/mjs-ws/core.ts). MÊME technique que tests/mjs-ws-packages.test.ts.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

describe('app.use() : un installer en échec n\'empoisonne plus le nom', () => {
  it('installer qui lève PUIS installer corrigé du MÊME nom : le 2e s\'installe bel et bien', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { app } = await startApp({ onLog: (level, message) => logs.push({ level, message }) })

    let secondRan = false
    assert.throws(
      () => app.use({ nom: 'x', installer: () => { throw new Error('boom') } }),
      /boom/,
      'l\'erreur du 1er installer remonte TOUJOURS à l\'appelant (comportement inchangé)',
    )
    assert.doesNotThrow(
      () => app.use({ nom: 'x', installer: () => { secondRan = true } }),
      'le nom NE DOIT PLUS être poisonné — un 2e installer (même nom, corrigé) doit pouvoir s\'installer',
    )
    assert.ok(secondRan, 'le 2e installer a bien tourné')

    const errLogs = logs.filter(l => l.level === 'error' && /installer/.test(l.message) && /'x'/.test(l.message))
    assert.equal(errLogs.length, 1, 'l\'échec du 1er installer est journalisé (catalogue) UNE fois')

    await app.stop()
  })

  it('un 3e app.use() du MÊME nom, une fois installé avec succès, reste ignoré (comportement pré-existant, non régressé)', async () => {
    const { app } = await startApp({ onLog: () => {} })
    let runs = 0
    app.use({ nom: 'y', installer: () => { runs++ } })
    app.use({ nom: 'y', installer: () => { runs++ } })
    assert.equal(runs, 1, 'double installation d\'un paquet qui RÉUSSIT reste ignorée, comme avant')
    await app.stop()
  })
})
