// Tests HMR : connexion WebSocket, reload broadcast.

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import WebSocket from 'ws'
import { StaticServer } from '../src/server/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('HMR WebSocket', () => {
  let server: StaticServer
  let port: number
  let rootDir: string

  before(async () => {
    rootDir = mjsTmp('hmr')
    writeFileSync(join(rootDir, 'app-12345678.js'), `// app`)
    port = 35000 + Math.floor(Math.random() * 5000)
    server = new StaticServer({ rootDir, port, host: '127.0.0.1', hmr: true })
    await server.start()
  })

  after(async () => {
    await server.stop()
  })

  it('client se connecte et reçoit un message connected', async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()))
      ws.on('error', reject)
      setTimeout(() => reject(new Error('timeout')), 2000)
    })
    const parsed = JSON.parse(msg)
    assert.equal(parsed.type, 'connected')
    ws.close()
  })

  it('notifyReload broadcast à tous les clients', async function () {
    this.timeout(5000)

    const collectMessages = (ws: WebSocket) => {
      const messages: string[] = []
      ws.on('message', (d) => messages.push(d.toString()))
      return messages
    }

    const ws1 = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
    const ws2 = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
    const m1 = collectMessages(ws1)
    const m2 = collectMessages(ws2)

    await Promise.all([
      new Promise<void>(r => ws1.on('open', () => r())),
      new Promise<void>(r => ws2.on('open', () => r())),
    ])

    // Petit délai pour laisser le serveur traiter les connections + envoyer "connected"
    await new Promise(r => setTimeout(r, 100))
    server.notifyReload(['foo.mjs'])
    await new Promise(r => setTimeout(r, 100))

    const reload1 = m1.find(s => s.includes('"type":"reload"'))
    const reload2 = m2.find(s => s.includes('"type":"reload"'))
    assert.ok(reload1, 'ws1 doit recevoir reload')
    assert.ok(reload2, 'ws2 doit recevoir reload')
    assert.deepEqual(JSON.parse(reload1!), { type: 'reload', modules: ['foo.mjs'] })

    ws1.close()
    ws2.close()
  })

  it('endpoint /__mjs_hmr/client.js sert le snippet', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__mjs_hmr/client.js`)
    assert.equal(res.status, 200)
    const body = await res.text()
    assert.match(body, /WebSocket/)
    assert.match(body, /location\.reload/)
  })

  it('snippet client contient l\'overlay error', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/__mjs_hmr/client.js`)
    const body = await res.text()
    assert.match(body, /__mjs_hmr_overlay/)
    assert.match(body, /Échec de compilation/)
    assert.match(body, /position:\s*fixed/)
  })

  it('notifyError broadcast un message error', async function () {
    this.timeout(5000)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`)
    const messages: string[] = []
    ws.on('message', (d) => messages.push(d.toString()))
    await new Promise<void>(r => ws.on('open', () => r()))
    await new Promise(r => setTimeout(r, 100))

    server.hmr?.notifyError('boom — broken syntax in foo.mjs:42')
    await new Promise(r => setTimeout(r, 100))

    const errMsg = messages.find(m => m.includes('"type":"error"'))
    assert.ok(errMsg)
    const parsed = JSON.parse(errMsg!)
    assert.match(parsed.message, /boom/)
    ws.close()
  })

  // cf. commentaire détaillé dans
  // hmr.ts (`isTrustedDevOrigin`) : le handshake WebSocket n'est PAS soumis à
  // la same-origin policy du navigateur — SANS vérification côté serveur,
  // N'IMPORTE QUEL site web ouvert dans le même navigateur pouvait se
  // connecter à ce WS de dev local (et, via DNS rebinding, un site distant
  // aussi). Fix : l'`Origin` du handshake est vérifié ; une origine non
  // locale fait fermer la connexion (code 1008) avant tout message.
  it("une connexion avec un Origin ÉTRANGER (ex. un site tiers) est REFUSÉE (fermée, code 1008)", async function () {
    this.timeout(5000)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`, { origin: 'http://evil.example.com' })
    const closeCode = await new Promise<number>((resolve, reject) => {
      ws.on('close', (code) => resolve(code))
      ws.on('message', () => reject(new Error("AVANT le fix : un client d'origine étrangère recevait quand même le message 'connected' — aucune vérification d'Origin")))
      setTimeout(() => reject(new Error('timeout : la connexion aurait dû être fermée par le serveur')), 2000)
    })
    assert.equal(closeCode, 1008)
  })

  it('une connexion avec un Origin LOCAL mais un port DIFFÉRENT (ex. un dashboard sur un autre port) est ACCEPTÉE', async function () {
    this.timeout(5000)
    const ws = new WebSocket(`ws://127.0.0.1:${port}/__mjs_hmr`, { origin: 'http://localhost:5173' })
    const msg = await new Promise<string>((resolve, reject) => {
      ws.on('message', (data) => resolve(data.toString()))
      ws.on('close', (code) => reject(new Error(`fermée à tort (code ${code}) — une origine locale, même sur un autre port, doit être acceptée`)))
      setTimeout(() => reject(new Error('timeout')), 2000)
    })
    assert.equal(JSON.parse(msg).type, 'connected')
    ws.close()
  })
})
