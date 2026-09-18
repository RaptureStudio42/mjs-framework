// Tests du serveur HTTP statique.

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'

async function fetchText(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const res = await fetch(url)
  const body = await res.text()
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => { headers[k] = v })
  return { status: res.status, body, headers }
}

describe('StaticServer', () => {
  let server: StaticServer
  let rootDir: string
  let port: number

  before(async () => {
    rootDir = mjsTmp('server')
    writeFileSync(join(rootDir, 'app-12345678.js'), `console.log('hello');`)
    writeFileSync(join(rootDir, 'plain.js'), `console.log('plain');`)
    mkdirSync(join(rootDir, 'sub'))
    writeFileSync(join(rootDir, 'sub', 'nested.js'), `// nested`)

    // Pick a random high port to avoid collisions
    port = 30000 + Math.floor(Math.random() * 5000)
    server = new StaticServer({ rootDir, port, host: '127.0.0.1' })
    await server.start()
  })

  after(async () => {
    await server.stop()
  })

  it('sert un fichier hashé avec cache immutable', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/app-12345678.js`)
    assert.equal(r.status, 200)
    assert.match(r.body, /hello/)
    assert.match(r.headers['cache-control'] ?? '', /immutable/)
    assert.match(r.headers['content-type'] ?? '', /javascript/)
  })

  it('sert un fichier sans hash avec no-cache', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/plain.js`)
    assert.equal(r.status, 200)
    assert.match(r.headers['cache-control'] ?? '', /no-cache/)
  })

  it('sert un fichier dans un sous-répertoire', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/sub/nested.js`)
    assert.equal(r.status, 200)
    assert.match(r.body, /nested/)
  })

  it('404 pour fichier inexistant', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/missing.js`)
    assert.equal(r.status, 404)
  })

  it('404 hors prefix', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/other/path.js`)
    assert.equal(r.status, 404)
  })

  it('400 sur path traversal', async () => {
    // .. encodés sont décodés et bloqués
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/..%2Fetc/passwd`)
    assert.equal(r.status, 400)
  })

  it('CORS header présent (requête sans Origin, ex. curl/serveur-à-serveur : non concerné par CORS)', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/modularjs/app-12345678.js`)
    assert.equal(r.headers['access-control-allow-origin'], '*')
  })

  it('405 sur POST', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modularjs/app-12345678.js`, {
      method: 'POST',
    })
    assert.equal(res.status, 405)
  })

  // `Access-Control-Allow-Origin: *`
  // inconditionnel permettait à N'IMPORTE QUEL site web (via fetch/XHR côté
  // navigateur) de LIRE la réponse d'une requête vers ce serveur de dev local
  // — combiné à un DNS rebinding, un site distant peut faire croire à son
  // origine qu'elle "est" 127.0.0.1. Fix : seules les origines locales
  // (localhost/127.0.0.1/[::1], port variable) obtiennent le header.
  it("une requête avec Origin LOCAL (autre port, ex. dashboard) reçoit le header, avec CETTE origine précise", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modularjs/app-12345678.js`, {
      headers: { Origin: 'http://localhost:5173' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), 'http://localhost:5173')
  })

  it("une requête avec Origin ÉTRANGER (site tiers) ne reçoit PAS le header (AVANT le fix : '*' quand même)", async () => {
    const res = await fetch(`http://127.0.0.1:${port}/modularjs/app-12345678.js`, {
      headers: { Origin: 'http://evil.example.com' },
    })
    assert.equal(res.headers.get('access-control-allow-origin'), null)
  })
})
