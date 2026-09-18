// mjs dev sans bloc `render` ne servait QUE ses assets compilés (pathPrefix) : tout chemin hors
// de ce préfixe rendait 404, la page du projet elle-même restant à la charge d'un serveur tiers.
// `mjs dev` sert la racine du projet (index.html, public/…)
// pour tout chemin hors pathPrefix SANS bloc `render` — comme le ferait un serveur de dev
// Vite/Angular. `renderHandle` reste prioritaire et STRICTEMENT inchangé (cf. dev-pathprefix-
// render.test.ts), tout comme les assets sous `pathPrefix` : cette fonctionnalité ne s'active QUE
// dans le repli qui rendait 404 jusqu'ici.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'

async function fetchText(url: string, init?: RequestInit) {
  const res = await fetch(url, init)
  return { status: res.status, body: await res.text(), headers: res.headers }
}

// Fixture partagée : racine de projet + fichiers/dossiers cachés + lien symbolique évasif
// (`fuite.txt` pointe vers un fichier HORS de `projectRoot`, dans un dossier temporaire frère).
function setupProject() {
  const projectRoot = mjsTmp('dev-project-root')
  const outDir       = join(projectRoot, 'out')
  const dehors        = mjsTmp('dev-project-root-dehors')
  mkdirSync(outDir, { recursive: true })
  mkdirSync(join(projectRoot, 'public', 'notes'), { recursive: true })
  mkdirSync(join(projectRoot, '.git'), { recursive: true })
  mkdirSync(join(projectRoot, 'node_modules', 'pkg'), { recursive: true })
  writeFileSync(join(projectRoot, 'index.html'), '<!doctype html><html><body><h1>Accueil</h1></body></html>')
  writeFileSync(join(projectRoot, 'public', 'notes', 'index.html'), '<!doctype html><html><body><h1>Notes</h1></body></html>')
  writeFileSync(join(projectRoot, 'public', 'logo.svg'), '<svg>logo</svg>')
  writeFileSync(join(projectRoot, '.env'), 'SECRET=1')
  writeFileSync(join(projectRoot, '.git', 'config'), '[core]')
  writeFileSync(join(projectRoot, 'node_modules', 'pkg', 'index.js'), 'module.exports = {}')
  writeFileSync(join(dehors, 'secret.txt'), 'CONTENU HORS RACINE')
  symlinkSync(join(dehors, 'secret.txt'), join(projectRoot, 'fuite.txt'))
  return { projectRoot, outDir }
}

describe('mjs dev — sert la racine du projet (sans bloc render)', () => {
  let projectRoot: string, outDir: string, server: StaticServer, port: number

  before(async function () {
    this.timeout(15000)
    ;({ projectRoot, outDir } = setupProject())
    server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', projectRoot })
    await server.start()
    port = (server.server!.address() as any).port
  })

  after(async () => { await server.stop() })

  it('/ → 200, sert index.html de la racine du projet', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/`)
    assert.equal(r.status, 200)
    assert.match(r.body, /Accueil/)
    assert.match(r.headers.get('content-type') || '', /text\/html/)
  })

  it('/public/notes/ (chemin finissant par /) → 200, sert index.html de CE dossier', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/public/notes/`)
    assert.equal(r.status, 200)
    assert.match(r.body, /Notes/)
  })

  it('/public/logo.svg → 200, fichier littéral, bon type MIME', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/public/logo.svg`)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type') || '', /svg/)
    assert.match(r.body, /logo/)
  })

  it('/inexistant.html → 404 (absent, comme aujourd\'hui)', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/inexistant.html`)
    assert.equal(r.status, 404)
  })

  it('/.env (fichier caché à la racine) → 404, jamais servi', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/.env`)
    assert.equal(r.status, 404)
    assert.doesNotMatch(r.body, /SECRET/)
  })

  it('/.git/config (dossier caché) → 404, jamais servi', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/.git/config`)
    assert.equal(r.status, 404)
  })

  it('/node_modules/pkg/index.js → 404, jamais servi', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/node_modules/pkg/index.js`)
    assert.equal(r.status, 404)
  })

  it('/..%2Fetc/passwd (traversal encodé) → 400, jamais hors racine', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/..%2Fetc/passwd`)
    assert.equal(r.status, 400)
  })

  it('/fuite.txt (lien symbolique évasif) → 404 via isRealPathWithin, contenu jamais divulgué', async () => {
    const r = await fetchText(`http://127.0.0.1:${port}/fuite.txt`)
    assert.equal(r.status, 404)
    assert.doesNotMatch(r.body, /CONTENU HORS RACINE/)
  })

  it('POST / (méthode non GET/HEAD) → 405, inchangé', async () => {
    const res = await fetch(`http://127.0.0.1:${port}/`, { method: 'POST' })
    assert.equal(res.status, 405)
  })
})

describe('mjs dev — page du projet en env "prod" : même règle que les autres routes de ce serveur (pas fermée)', () => {
  it('/ reste 200 même avec env:"prod" (comme pathPrefix/renderHandle, jamais gatée par isProdEnv)', async function () {
    this.timeout(15000)
    const { projectRoot, outDir } = setupProject()
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', projectRoot, env: 'prod' })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 200)
    } finally {
      await server.stop()
    }
  })
})

describe('mjs dev — client de rechargement (HMR) injecté dans une page HTML servie depuis la racine du projet', () => {
  it('hmr:true → le tag <script src="/__mjs_hmr/client.js"> est injecté avant </body>', async function () {
    this.timeout(15000)
    const { projectRoot, outDir } = setupProject()
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', projectRoot, hmr: true })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 200)
      assert.match(r.body, /<script src="\/__mjs_hmr\/client\.js"><\/script>\s*<\/body>/)
    } finally {
      await server.stop()
    }
  })

  it('hmr absent (défaut false) → aucune injection', async () => {
    const { projectRoot, outDir } = setupProject()
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', projectRoot })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.doesNotMatch(r.body, /__mjs_hmr/)
    } finally {
      await server.stop()
    }
  })
})

describe('mjs dev — avec renderHandle : STRICTEMENT inchangé, projectRoot ignoré', () => {
  it('/ rendue par render.routes, jamais le index.html du projet même si projectRoot en a un', async function () {
    this.timeout(20000)
    const root   = mjsTmp('dev-project-root-render')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Accueil rendu</h1>')
    writeFileSync(join(outDir, 'manifest.js'), 'µ.paths = {};\nµ.version = "abcd1234";\n')
    writeFileSync(join(root, 'index.html'), '<!doctype html><html><body>PAGE STATIQUE DU PROJET</body></html>')
    const config: any = { sourceDir: 'src', outputDir: 'out', render: { default: 'csr', routes: { '/': { component: 'mjs-home', mode: 'csr' } } } }
    const renderHandler = await createRenderHandler(config, root)
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      config, configDir: root, manifestPath: join(outDir, 'manifest.js'),
      renderHandle: renderHandler.handle, projectRoot: root,
    })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 200)
      assert.doesNotMatch(r.body, /PAGE STATIQUE DU PROJET/)
      assert.match(r.body, /<mjs-home>/)
    } finally {
      await server.stop()
      await renderHandler.close()
    }
  })
})

describe('mjs dev — assets sous pathPrefix : inchangé malgré projectRoot', () => {
  it('/modularjs/app-abcdefgh.js (asset compilé) reste servi normalement', async () => {
    const { projectRoot, outDir } = setupProject()
    writeFileSync(join(outDir, 'app-abcdefgh.js'), '// app compilé')
    const server = new StaticServer({ rootDir: outDir, port: 0, host: '127.0.0.1', projectRoot })
    try {
      await server.start()
      const port = (server.server!.address() as any).port
      const r = await fetchText(`http://127.0.0.1:${port}/modularjs/app-abcdefgh.js`)
      assert.equal(r.status, 200)
      assert.match(r.body, /app compilé/)
    } finally {
      await server.stop()
    }
  })
})
