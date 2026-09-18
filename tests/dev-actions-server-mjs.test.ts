// mjs dev — pipeline d'actions `.server.mjs` (action-pipeline.ts). Calqué sur
// tests/serve-protocol-loaders-forms.test.ts (même fixture Civet, mêmes gardes) mais câblé sur
// StaticServer (server/index.ts, `mjs dev`) au lieu de startRenderServer (`mjs serve`) — même
// harnais que tests/journal-dev-endpoints.test.ts (startDev calqué EXACTEMENT sur cli.ts, case
// 'dev'). Le pipeline lui-même n'est PAS re-testé exhaustivement ici (déjà couvert par
// serve-protocol-loaders-forms.test.ts, MÊME code depuis action-pipeline.ts) : ce fichier prouve
// seulement que `mjs dev` l'atteint bien, avec les mêmes réponses.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { StaticServer } from '../src/server/index.js'
import { createServeEntry } from '../src/server/serve-entry.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())
after(async () => { await terminateSharedWorkerPool() })

const FIXTURE = `export default {
  props: {
    '/p/:id': (params, req) -> { id: params.id, source: 'chargeur' }
  }
  actions: {
    '/p/:id': (params, body, req) ->
      if body.name is 'bad'
        { errors: { name: 'invalide' } }
      else
        { redirect: "/p/#{params.id}" }
  }
}
`

// config PARTAGÉE : bloc `render` minimal (routes utilisées seulement pour la relecture des props
// au 422, cf. action-pipeline.ts) + serve.server.mjs au défaut racine.
function setup() {
  const root   = mjsTmp('dev-actions')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
  writeFileSync(join(root, 'serve.server.mjs'), FIXTURE)
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: { routes: { '/p/:id': { component: 'mjs-page', mode: 'csr' as const } } },
  }
  return { root, outDir, config }
}

// démarre un StaticServer avec l'entry câblée EXACTEMENT comme cli.ts (case 'dev') :
// createServeEntry + entry passée telle quelle à StaticServer. `withEntry: false` simule un
// projet SANS entrée serveur (ni `serve.server.mjs`, ni bloc `render.entry`) — même condition
// que cli.ts (`found` sans fichier d'entrée trouvé, cf. resolveServeEntryPath).
async function startDev(config: any, root: string, withEntry = true) {
  const entry = withEntry ? await createServeEntry(config, root) : null
  const server = new StaticServer({
    rootDir: join(root, 'out'), port: 0, host: '127.0.0.1', config, configDir: root,
    manifestPath: join(root, 'out', 'manifest.js'),
    entry: entry ?? undefined,
  })
  await server.start()
  const port = (server.server!.address() as any).port
  return { port, close: async () => { await server.stop(); entry?.close() } }
}

function postForm(port: number, path: string, body: string, headers: Record<string, string> = {}, method: string = 'POST') {
  return fetch(`http://127.0.0.1:${port}${path}`, {
    method, redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...headers },
    body,
  })
}

function multipartBody(boundary: string, champs: Array<{ name: string, valeur: string }>): string {
  const parts = champs.map((c) => `--${boundary}\r\nContent-Disposition: form-data; name="${c.name}"\r\n\r\n${c.valeur}\r\n`)
  return parts.join('') + `--${boundary}--\r\n`
}

describe('mjs dev — pipeline d\'actions .server.mjs', () => {
  it('1. POST /p/42 name=ok (même origine) : action exécutée, 303 + Location', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await dev.close() }
  })

  it('2. POST sur un chemin SANS action déclarée : 405 + Allow: GET, HEAD', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/inconnu', 'x=1', { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), 'GET, HEAD')
    } finally { await dev.close() }
  })

  it('3. corps urlencoded : lu et transmis à l\'action (name=bad → 422 avec errors)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/p/42', 'name=bad', { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 422)
      const json = await res.json()
      assert.equal(json.props.errors.name, 'invalide')
      assert.equal(json.props.id, '42')   // props du chargeur rechargées AUSSI
    } finally { await dev.close() }
  })

  it('4. corps multipart texte (name=ok) : même effet que l\'urlencoded équivalent (303)', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const boundary = 'mjsDevBoundary1'
      const corps = multipartBody(boundary, [{ name: 'name', valeur: 'ok' }])
      const res = await fetch(`http://127.0.0.1:${dev.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': `multipart/form-data; boundary=${boundary}`, origin: `http://127.0.0.1:${dev.port}` },
        body: corps,
      })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/42')
    } finally { await dev.close() }
  })

  it('5. retour {redirect} : 303 + Location interne', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/p/7', 'name=ok', { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 303)
      assert.equal(res.headers.get('location'), '/p/7')
    } finally { await dev.close() }
  })

  it('6. garde open-redirect : cible externe (//evil.example) REFUSÉE, jamais de Location', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  actions: {
    '/p/:id': (params, body, req) -> { redirect: body.cible }
  }
}
`)
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/p/42', 'cible=' + encodeURIComponent('//evil.example'), { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 500)
      assert.equal(res.headers.get('location'), null)
    } finally { await dev.close() }
  })

  // Une tabulation/un saut de ligne juste après le '/' initial passe la
  // garde `cible[1] !== '/' && cible[1] !== '\\'` (ni slash ni backslash) : Node envoie l'en-tête
  // Location tel quel, le navigateur RETIRE ces caractères en analysant l'URL → `//evil.example`
  // → redirection externe. Même fixture que le test 6 (redirect: body.cible).
  it('6b. garde open-redirect : caractère de contrôle (tabulation/saut de ligne) REFUSÉ, jamais de Location', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    writeFileSync(join(root, 'serve.server.mjs'), `export default {
  actions: {
    '/p/:id': (params, body, req) -> { redirect: body.cible }
  }
}
`)
    const dev = await startDev(config, root)
    try {
      const tab = await postForm(dev.port, '/p/42', 'cible=' + encodeURIComponent('/\t/evil.example'), { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(tab.status, 500)
      assert.equal(tab.headers.get('location'), null)
      const nl = await postForm(dev.port, '/p/42', 'cible=' + encodeURIComponent('/\n/evil.example'), { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(nl.status, 500)
      assert.equal(nl.headers.get('location'), null)
      const ok = await postForm(dev.port, '/p/42', 'cible=' + encodeURIComponent('/ok'), { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(ok.status, 303, 'non-régression : une cible interne normale reste acceptée')
      assert.equal(ok.headers.get('location'), '/ok')
    } finally { await dev.close() }
  })

  it('7. garde origine croisée (Origin étrangère) : 403', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/p/42', 'name=ok', { origin: 'http://evil.test' })
      assert.equal(res.status, 403)
    } finally { await dev.close() }
  })

  it('8. Content-Type non supporté (application/json) : 415', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const res = await fetch(`http://127.0.0.1:${dev.port}/p/42`, {
        method: 'POST', redirect: 'manual',
        headers: { 'content-type': 'application/json', origin: `http://127.0.0.1:${dev.port}` },
        body: '{}',
      })
      assert.equal(res.status, 415)
    } finally { await dev.close() }
  })

  it('9. corps > 1 Mo : 413', async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const dev = await startDev(config, root)
    try {
      const enorme = 'name=' + 'x'.repeat(1_100_000)
      const res = await postForm(dev.port, '/p/42', enorme, { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 413)
    } finally { await dev.close() }
  })

  it('10. projet SANS entrée serveur (ni serve.server.mjs, ni render.entry) : 405 sec, comportement HISTORIQUE inchangé', async function () {
    this.timeout(15000)
    const root   = mjsTmp('dev-actions-noentry')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
    const config: any = { sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js' }
    // withEntry: false — AUCUN serve.server.mjs sur le disque, AUCUN fichier d'entrée
    const dev = await startDev(config, root, false)
    try {
      const res = await postForm(dev.port, '/p/42', 'name=ok', { origin: `http://127.0.0.1:${dev.port}` })
      assert.equal(res.status, 405)
      assert.equal(res.headers.get('allow'), null, 'AUCUN en-tête Allow : comportement historique, pas le 405 du pipeline')
    } finally { await dev.close() }
  })

  // le préfixe réservé du serveur de développement ne devient jamais une route d'application
  it('POST /__mjs/errors n\'est jamais capté par une action, même sans bloc journal', async () => {
    const { root, config } = setup()
    writeFileSync(join(root, 'serve.server.mjs'), `export default {\n  actions: {\n    '/__mjs/errors': (params, body, req) -> { redirect: '/pirate' }\n  }\n}\n`)
    const dev = await startDev(config, root)
    try {
      const res = await postForm(dev.port, '/__mjs/errors', 'a=1')
      assert.equal(res.status, 404)
      assert.equal(res.headers.get('location'), null, 'aucune redirection : l\'action ne doit pas s\'exécuter')
    } finally { await dev.close() }
  })
})
