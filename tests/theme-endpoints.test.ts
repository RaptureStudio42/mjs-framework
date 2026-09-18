// theme-endpoints — atelier /__mjs/theme : registre des variables de thème ($$) écrit par le
// bundler (computeVarRegistry, src/bundler/index.ts), lu tel quel par les deux serveurs. Calque
// tests/journal-endpoints.test.ts (visionneuse GET page/.json, gating NODE_ENV) pour `mjs serve`
// (startRenderServer) + tests/server-render-routes.test.ts (StaticServer + renderHandle/
// manifestPath réels) pour `mjs dev`. Couvre aussi la garantie « cache PAR visionneuse » de
// viewer-page.ts : ouvrir l'atelier ne doit jamais corrompre le cache du journal.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { startRenderServer } from '../src/server/render-server.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

// registre RÉALISTE (même forme que .mjs-theme-vars.json) — 1 variable, 1 déclaration.
const SAMPLE_REGISTRY = {
  accent: {
    declarations: [
      { value: '#3b82f6', declaredBy: 'framework', kind: 'framework', variant: '', file: 'mjs_init.ts', line: 66, doc: '' },
    ],
    readBy: ['mjs-card'],
  },
}

// config PARTAGÉE (mjs serve) : sourceDir/outputDir minimaux + manifest RÉALISTE (ligne
// `const µCore = `, nécessaire à la visionneuse — cf. viewer-page.ts, getViewerScript).
function setup() {
  const root = mjsTmp('theme-ep')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(outDir, { recursive: true })
  writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
  writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
  const config: any = {
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/manifest.js',
    render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
  }
  return { root, outDir, config }
}

describe('GET /__mjs/theme.json (mjs serve)', () => {
  it('rend le contenu du registre quand le fichier existe', async function () {
    this.timeout(15000)
    const { root, outDir, config } = setup()
    writeFileSync(join(outDir, '.mjs-theme-vars.json'), JSON.stringify(SAMPLE_REGISTRY))
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme.json`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8')
      assert.deepEqual(await res.json(), SAMPLE_REGISTRY)
    } finally {
      await running.close()
    }
  })

  it("rend {} quand le registre n'existe pas (silence par défaut du bundler, pas une panne)", async function () {
    this.timeout(15000)
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme.json`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), {})
    } finally {
      await running.close()
    }
  })
})

describe('GET /__mjs/theme (mjs serve)', () => {
  let originalNodeEnv: string | undefined
  before(() => { originalNodeEnv = process.env.NODE_ENV })
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  it('hors production : 200, script du cœur + mjs-theme-viewer créé APRÈS sa définition (pas de balise nue)', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme`)
      assert.equal(res.status, 200)
      const html = await res.text()
      // la balise n'est plus écrite en dur dans le corps (course avec l'autoloader,
      // cf. viewer-page.ts:viewerScriptElement) : elle n'existe QUE dans le script, créée après sa
      // définition (document.createElement, jamais une balise nue dans le document).
      assert.doesNotMatch(html, /<mjs-theme-viewer>/, 'plus de balise nue dans le corps')
      assert.match(html, /<script type="module" src="\/__mjs\/bundle\.js">/)
      assert.match(html, /µ\._def\("mjs-theme-viewer"/, 'le script inline compile bien le composant theme-viewer')
      assert.match(html, /document\.createElement\("mjs-theme-viewer"\)/, 'le nom de balise apparaît dans le script (créée APRÈS sa définition), jamais en balise nue')
      // le NOM du composant vient de `moduleName`, le CONTENU vient de `fileName` : sans cette
      // paire d'assertions, un ViewerSpec pointant vers le mauvais fichier source passerait
      // inaperçu tant que le nom de module reste juste (trou de preuve)
      assert.match(html, /Variables de thème/, 'le script compilé vient bien de theme-viewer.mjs, pas d\'une autre visionneuse')
      assert.doesNotMatch(html, /Journal d'erreurs/, 'l\'atelier ne doit jamais servir le contenu de la visionneuse du journal')
    } finally {
      await running.close()
    }
  })

  it("les deux routes rendent 404 en production — outil de développement uniquement (jamais 403)", async function () {
    this.timeout(15000)
    process.env.NODE_ENV = 'production'
    const { root, outDir, config } = setup()
    writeFileSync(join(outDir, '.mjs-theme-vars.json'), JSON.stringify(SAMPLE_REGISTRY))
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const page = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme`)
      const json = await fetch(`http://127.0.0.1:${running.port}/__mjs/theme.json`)
      assert.equal(page.status, 404)
      assert.equal(json.status, 404)
      assert.notEqual(page.status, 403)
    } finally {
      await running.close()
    }
  })
})

describe('cache viewer-page.ts — PAR visionneuse', () => {
  it('journal puis atelier puis journal : le 3e appel ressert le JOURNAL (pas de collision de cache entre visionneuses)', async function () {
    this.timeout(15000)
    delete process.env.NODE_ENV
    const { root, config } = setup()
    const running = await startRenderServer(config, root, { port: 0 })
    try {
      const journal1 = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)).text()
      assert.match(journal1, /µ\._def\("mjs-journal-viewer"/)
      assert.match(journal1, /Journal d'erreurs/, 'le journal sert bien errors-viewer.mjs, pas une autre visionneuse')
      const theme1 = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/theme`)).text()
      assert.match(theme1, /µ\._def\("mjs-theme-viewer"/)
      const journal2 = await (await fetch(`http://127.0.0.1:${running.port}/__mjs/errors`)).text()
      assert.match(journal2, /µ\._def\("mjs-journal-viewer"/, 'le journal doit rester le journal après un aller-retour par l\'atelier')
      assert.doesNotMatch(journal2, /µ\._def\("mjs-theme-viewer"/, 'un cache à slot unique aurait reservi le mauvais composant ici')
      assert.equal(journal2, journal1, 'même page, même script — le cache par visionneuse a tenu')
    } finally {
      await running.close()
    }
  })
})

// StaticServer (mjs dev) — mêmes 2 routes, mais le registre vit dans rootDir et la page HTML a
// besoin d'un manifestPath réel (couplé à renderHandle, cf. constructeur ServerOpts.renderHandle).
function devServer(rootDir: string, port: number) {
  return new StaticServer({ rootDir, port, host: '127.0.0.1' })
}

describe('GET /__mjs/theme(.json) (mjs dev, StaticServer)', () => {
  it('theme.json : rend le registre depuis rootDir, MÊME SANS manifestPath/renderHandle', async function () {
    this.timeout(15000)
    const root = mjsTmp('theme-dev')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, '.mjs-theme-vars.json'), JSON.stringify(SAMPLE_REGISTRY))
    const server = devServer(outDir, 0)
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), SAMPLE_REGISTRY)
    } finally {
      await server.stop()
    }
  })

  it('theme.json absent : {}', async function () {
    this.timeout(15000)
    const root = mjsTmp('theme-dev')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    const server = devServer(outDir, 0)
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
      assert.equal(res.status, 200)
      assert.deepEqual(await res.json(), {})
    } finally {
      await server.stop()
    }
  })

  it('theme (page HTML) : sans manifestPath, 404 — porte fermée plutôt que page morte', async function () {
    this.timeout(15000)
    const root = mjsTmp('theme-dev')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    const server = devServer(outDir, 0)
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme`)
      assert.equal(res.status, 404)
    } finally {
      await server.stop()
    }
  })

  it('theme (page HTML) : avec manifestPath+renderHandle réels, 200 et mjs-theme-viewer (créé APRÈS sa définition)', async function () {
    this.timeout(15000)
    const root = mjsTmp('theme-dev')
    mkdirSync(join(root, 'src'), { recursive: true })
    writeFileSync(join(root, 'src', 'home.mjs'), '<h1>Salut</h1>')
    const outDir = join(root, 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'manifest.js'), "const µCore = '/mjs_core-test1234.js';\nµ.paths = {};\nµ.version = \"abcd1234\";\n")
    const config = { sourceDir: 'src', outputDir: 'out', render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } } }
    const handler = await createRenderHandler(config, root)
    const server = new StaticServer({
      rootDir: outDir, port: 0, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(outDir, 'manifest.js'),
    })
    await server.start()
    try {
      const port = (server.server!.address() as any).port
      const res = await fetch(`http://127.0.0.1:${port}/__mjs/theme`)
      assert.equal(res.status, 200)
      const html = await res.text()
      assert.doesNotMatch(html, /<mjs-theme-viewer>/, 'plus de balise nue dans le corps')
      assert.match(html, /µ\._def\("mjs-theme-viewer"/)
      assert.match(html, /document\.createElement\("mjs-theme-viewer"\)/, 'le nom de balise apparaît dans le script, jamais en balise nue')
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  it('les deux routes rendent 404 en production', async function () {
    this.timeout(15000)
    const original = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      const root = mjsTmp('theme-dev')
      const outDir = join(root, 'out')
      mkdirSync(outDir, { recursive: true })
      writeFileSync(join(outDir, '.mjs-theme-vars.json'), JSON.stringify(SAMPLE_REGISTRY))
      const server = devServer(outDir, 0)
      await server.start()
      try {
        const port = (server.server!.address() as any).port
        const page = await fetch(`http://127.0.0.1:${port}/__mjs/theme`)
        const json = await fetch(`http://127.0.0.1:${port}/__mjs/theme.json`)
        assert.equal(page.status, 404)
        assert.equal(json.status, 404)
      } finally {
        await server.stop()
      }
    } finally {
      if (original === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = original
    }
  })
})
