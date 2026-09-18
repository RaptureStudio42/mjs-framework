// Le correctif existant n'entoure que l'appel SYNCHRONE de pkg.installer(app) — un installer `async` qui rejette (ou
// qui retourne une Promise déjà rejetée) échappe au try/catch, poisonne le nom (inscrit avant
// résolution) et laisse un rejet NON intercepté (unhandledRejection, tue le process en Node 24).
// src/mjs-ws/core.ts::app.use.
import assert from 'node:assert/strict'
import { mjsWs } from '../src/mjs-ws/index.js'
import { MemoryTransport } from '../src/mjs-ws/transport.js'
import type { MjsWsApp, MjsWsOptions } from '../src/mjs-ws/index.js'

const tick = (ms = 0) => new Promise<void>(r => setTimeout(r, ms))

async function startApp(opts: MjsWsOptions = {}): Promise<{ transport: MemoryTransport; app: MjsWsApp }> {
  const transport = new MemoryTransport()
  const app = mjsWs({ transport, heartbeat: 0, ...opts })
  await app.listen()
  return { transport, app }
}

describe('app.use() : installer ASYNCHRONE, rejet capturé', () => {
  it('installer async qui rejette : use() reste synchrone/chaînable, aucun crash, erreur journalisée, réinstallation possible', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { app } = await startApp({ onLog: (level, message) => logs.push({ level, message }) })

    let unhandled: unknown = null
    const onUnhandled = (err: unknown) => { unhandled = err }
    process.on('unhandledRejection', onUnhandled)

    let returned: MjsWsApp | undefined
    assert.doesNotThrow(
      () => { returned = app.use({ nom: 'z', installer: async () => { await Promise.resolve(); throw new Error('boom asynchrone') } }) },
      'use() reste SYNCHRONE et ne lève jamais pour un installer async — même en cas de rejet',
    )
    assert.equal(returned, app, 'use() reste chaînable même pour un installer async')

    await tick(30) // laisse le temps au rejet de se propager
    process.off('unhandledRejection', onUnhandled)
    assert.equal(unhandled, null, 'le rejet ne doit JAMAIS devenir une unhandledRejection Node')

    const errLogs = logs.filter(l => l.level === 'error' && /installer/.test(l.message) && /'z'/.test(l.message))
    assert.equal(errLogs.length, 1, 'l\'échec ASYNCHRONE est journalisé (catalogue), comme le cas synchrone')

    let retryRan = false
    app.use({ nom: 'z', installer: () => { retryRan = true } })
    assert.ok(retryRan, 'le nom N\'EST PAS resté "installé" après un rejet asynchrone — réinstallation possible')

    await app.stop()
  })

  it('installer async qui réussit : le paquet est bien inscrit à la résolution (2e use() du même nom ignoré)', async () => {
    const logs: Array<{ level: string; message: string }> = []
    const { app } = await startApp({ onLog: (level, message) => logs.push({ level, message }) })

    let installed = false
    app.use({ nom: 'w', installer: async () => { await Promise.resolve(); installed = true } })
    await tick(30)
    assert.ok(installed, 'l\'installer async a bien tourné')

    let secondRan = false
    app.use({ nom: 'w', installer: () => { secondRan = true } })
    assert.equal(secondRan, false, 'un 2e use() du même nom, une fois la résolution passée, est ignoré (déjà installé)')

    const warnLogs = logs.filter(l => l.level === 'warn' && /déjà installé/.test(l.message) && /'w'/.test(l.message))
    assert.equal(warnLogs.length, 1, 'le 2e essai est bien journalisé comme "déjà installé"')

    await app.stop()
  })
})
