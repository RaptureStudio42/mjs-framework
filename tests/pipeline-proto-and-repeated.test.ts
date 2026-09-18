// action-pipeline.ts : un champ de formulaire nommé `__proto__` invoque le
// SETTER hérité d'Object.prototype (Annex B) sur `body[champ] = v` (parseMultipart l.73, urlencoded
// l.194) — comme la valeur est toujours une chaîne, le setter est un no-op PAR SPEC (`body` n'expose
// donc AVANT MÊME tout correctif aucune clé propre `__proto__`),
// mais la valeur est PERDUE SANS AUCUNE TRACE : ni erreur, ni
// avertissement. `constructor`/`prototype` n'ont PAS ce problème de setter (propriétés de données
// normales) : AVANT correctif, `body['constructor'] = 'hostile'` réussit et CRÉE une clé PROPRE
// 'constructor' — observable directement (Object.keys). Incohérent avec le reste du codebase
// (mjs_init.ts:563, `µ._mjs_guardPath`/`µ._mjs_safeKey`) qui refuse EXPLICITEMENT les 3 noms, avec
// avertissement. Correctif attendu : même refus explicite + même avertissement ici. Ajout de la
// couverture manquante d'un champ RÉPÉTÉ (`a=1&a=2`, comportement déjà documenté —
// action-pipeline.ts:184 « dernière valeur gagne » — jamais vérifié par un test ; comportement
// EXISTANT, non touché par ce correctif, tests toujours verts).
//
// Harnais calqué sur tests/dev-actions-server-mjs.test.ts (StaticServer, `mjs dev`). Interception de
// `console.error` calquée sur tests/journal-endpoints.test.ts (l.458-470).
//
//   npx mocha tests/pipeline-proto-and-repeated.test.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StaticServer } from '../src/server/index.js'
import { createServeEntry } from '../src/server/serve-entry.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())
after(async () => { await terminateSharedWorkerPool() })

// renvoie le corps reçu par l'action dans `errors` (jamais un vrai 422 applicatif) — seul moyen
// d'inspecter, DEPUIS le test HTTP, ce que `body` contient réellement côté serveur.
const FIXTURE = `export default {
  actions: {
    '/echo/:id': (params, body, req) -> { errors: { keysJson: JSON.stringify(Object.keys(body)), nom: body.nom, a: body.a } }
  }
}
`

function setup() {
  const root   = mjsTmp('pipeline')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
  const config: any = { sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js' }
  return { root, outDir, config }
}

async function startDev(config: any, root: string) {
  const entry = await createServeEntry(config, root)
  const server = new StaticServer({
    rootDir: join(root, 'out'), port: 0, host: '127.0.0.1', config, configDir: root,
    manifestPath: join(root, 'out', 'manifest.js'),
    entry: entry ?? undefined,
  })
  await server.start()
  const port = (server.server!.address() as any).port
  return { port, close: async () => { await server.stop(); entry?.close() } }
}

function postForm(port: number, path: string, body: string, headers: Record<string, string> = {}) {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  })
}

function multipartBody(boundary: string, champs: Array<{ name: string, valeur: string }>): string {
  const parts = champs.map((c) => `--${boundary}\r\nContent-Disposition: form-data; name="${c.name}"\r\n\r\n${c.valeur}\r\n`)
  return parts.join('') + `--${boundary}--\r\n`
}

async function postMultipart(port: number, path: string, champs: Array<{ name: string, valeur: string }>) {
  const boundary = 'mjsLot3Boundary1'
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': `multipart/form-data; boundary=${boundary}` },
    body: multipartBody(boundary, champs),
  })
}

// espion console.error, même patron que tests/journal-endpoints.test.ts (l.458-470) — restauré en
// `finally` par l'appelant, jamais laissé posé entre deux `it()`.
function spyConsoleError(): { calls: string[], restore: () => void } {
  const original = console.error
  const calls: string[] = []
  console.error = (...args: any[]) => { calls.push(String(args[0])) }
  return { calls, restore: () => { console.error = original } }
}

describe('action-pipeline — champ __proto__/constructor/prototype et champ répété', () => {
  it('1. urlencoded __proto__=hostile&nom=Alice : un avertissement nomme le champ refusé, nom conservé', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    const spy = spyConsoleError()
    try {
      const res = await postForm(dev.port, '/echo/1', '__proto__=hostile&nom=Alice')
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.nom, 'Alice', 'le champ nom, lui, doit être transmis normalement')
      assert.ok(spy.calls.some(c => c.includes('__proto__')), `un avertissement doit nommer le champ '__proto__' refusé — console.error observés : ${JSON.stringify(spy.calls)}`)
    } finally { spy.restore(); await dev.close() }
  })

  it('2. multipart __proto__=hostile&nom=Alice : même avertissement côté parseMultipart', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    const spy = spyConsoleError()
    try {
      const res = await postMultipart(dev.port, '/echo/1', [{ name: '__proto__', valeur: 'hostile' }, { name: 'nom', valeur: 'Alice' }])
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.nom, 'Alice', 'le champ nom, lui, doit être transmis normalement')
      assert.ok(spy.calls.some(c => c.includes('__proto__')), `un avertissement doit nommer le champ '__proto__' refusé — console.error observés : ${JSON.stringify(spy.calls)}`)
    } finally { spy.restore(); await dev.close() }
  })

  it('3. urlencoded constructor=hostile&nom=Alice : AUCUNE clé propre \'constructor\' ne doit apparaître dans body (avant correctif : apparaît, valeur \'hostile\')', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    const spy = spyConsoleError()
    try {
      const res = await postForm(dev.port, '/echo/1', 'constructor=hostile&nom=Alice')
      assert.equal(res.status, 422)
      const json = await res.json()
      const keys = JSON.parse(json.props.errors.keysJson)
      assert.ok(!keys.includes('constructor'), `body ne doit exposer aucune clé propre 'constructor', trouvé : ${json.props.errors.keysJson}`)
      assert.equal(json.props.errors.nom, 'Alice', 'le champ nom, lui, doit être transmis normalement')
      assert.ok(spy.calls.some(c => c.includes('constructor')), `un avertissement doit nommer le champ 'constructor' refusé — console.error observés : ${JSON.stringify(spy.calls)}`)
    } finally { spy.restore(); await dev.close() }
  })

  it('4. multipart prototype=hostile&nom=Alice : AUCUNE clé propre \'prototype\' ne doit apparaître dans body', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    const spy = spyConsoleError()
    try {
      const res = await postMultipart(dev.port, '/echo/1', [{ name: 'prototype', valeur: 'hostile' }, { name: 'nom', valeur: 'Alice' }])
      assert.equal(res.status, 422)
      const json = await res.json()
      const keys = JSON.parse(json.props.errors.keysJson)
      assert.ok(!keys.includes('prototype'), `body ne doit exposer aucune clé propre 'prototype', trouvé : ${json.props.errors.keysJson}`)
      assert.equal(json.props.errors.nom, 'Alice', 'le champ nom, lui, doit être transmis normalement')
      assert.ok(spy.calls.some(c => c.includes('prototype')), `un avertissement doit nommer le champ 'prototype' refusé — console.error observés : ${JSON.stringify(spy.calls)}`)
    } finally { spy.restore(); await dev.close() }
  })

  it('5. champ répété urlencoded (a=1&a=2) : dernière valeur gagne (comportement documenté, figé par un test)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/echo/1', 'a=1&a=2')
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.a, '2', 'URLSearchParams itère dans l\'ordre d\'insertion, la dernière écriture de body[k] gagne')
    } finally { await dev.close() }
  })

  it('6. champ répété multipart (2 parties nommées a) : même règle, dernière valeur gagne', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postMultipart(dev.port, '/echo/1', [{ name: 'a', valeur: '1' }, { name: 'a', valeur: '2' }])
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.a, '2', 'parseMultipart itère dans l\'ordre d\'apparition, la dernière écriture de body[champ] gagne')
    } finally { await dev.close() }
  })
})
