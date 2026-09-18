// StaticServer (mjs dev) — render.routes pour les chemins HORS assets (feature :
// mjs dev applique AUSSI la résolution render.routes, comme mjs serve, via
// createRenderHandler). Calque tests/server.test.ts (StaticServer nu, priorités
// pathPrefix/404 inchangées) + tests/render-request.test.ts (createRenderHandler,
// motif « prerender sert le fichier figé ») — assemble les deux briques câblées
// par cli.ts (`case 'dev'`).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { StaticServer } from '../src/server/index.js'
import { createRenderHandler, type RenderHandler } from '../src/server/render-request.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

async function fetchText(url: string): Promise<{ status: number; body: string; headers: Record<string, string> }> {
  const res = await fetch(url)
  const body = await res.text()
  const headers: Record<string, string> = {}
  res.headers.forEach((v, k) => { headers[k] = v })
  return { status: res.status, body, headers }
}

function randomPort(): number {
  return 31000 + Math.floor(Math.random() * 4000)
}

function project(): string {
  const root = mjsTmp('dev-render')
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'home.mjs'), `
<script lang="coffee">
$titre = "Accueil"
</script>
<h1 class="t">{$titre}</h1>
`)
  return root
}

describe('StaticServer (mjs dev) — render.routes pour les chemins hors assets', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('avec bloc render + fichier prérendu sur disque : GET / renvoie le HTML prérendu FRAIS', async function () {
    this.timeout(15000)
    const root = project()
    // Même convention que render-request.test.ts : pagesDir dérivé de outputDir
    // ('public/out' → dirname 'public' → 'public/mjs_pages').
    const pagesDir = join(root, 'public', 'mjs_pages')
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(join(pagesDir, 'index.html'), '<mjs-home>FIGÉ-DEV</mjs-home>')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, routes: { '/': { component: 'mjs-home' } } },
    }
    const handler: RenderHandler = await createRenderHandler(config, root)
    const port = randomPort()
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
    })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 200)
      assert.match(r.body, /FIGÉ-DEV/, 'le body doit contenir le HTML prérendu (pas un 404, pas un shell CSR vide)')
      assert.equal(r.headers['x-mjs-mode'], 'prerender')
      assert.match(r.body, /<script type="module" src="\/__mjs\/bundle\.js">/, 'shell + bundle, même enveloppe que mjs serve')
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  // AMÉLIORATION 3 (fork 3a) — même `shell()` que mjs serve : `defaultLang`
  // (StaticServer, câblé par cli.ts depuis `config.i18n.default`) pilote
  // `<html lang>` en dev exactement comme render-server.ts.
  it('avec defaultLang:\'en\' : <html lang="en"> dans le corps servi', async function () {
    this.timeout(15000)
    const root = project()
    const pagesDir = join(root, 'public', 'mjs_pages')
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(join(pagesDir, 'index.html'), '<mjs-home>FIGÉ-DEV</mjs-home>')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, routes: { '/': { component: 'mjs-home' } } },
    }
    const handler: RenderHandler = await createRenderHandler(config, root)
    const port = randomPort()
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
      defaultLang: 'en',
    })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 200)
      assert.match(r.body, /<html lang="en">/)
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  it('sans bloc render (renderHandle absent) : 404 comme AVANT — comportement historique intact', async function () {
    const root = project()
    const port = randomPort()
    const server = new StaticServer({ rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1' })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/`)
      assert.equal(r.status, 404)
    } finally {
      await server.stop()
    }
  })

  it('chemin asset (pathPrefix) : servi comme AVANT, priorité INCHANGÉE sur render.routes', async function () {
    this.timeout(15000)
    const root = project()
    const outDir = join(root, 'public', 'out')
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(outDir, 'style-abc123.css'), '.x{color:red}')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { routes: { '/': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const handler = await createRenderHandler(config, root)
    const port = randomPort()
    const server = new StaticServer({
      rootDir: outDir, port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(outDir, 'bundle.js'),
    })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/modularjs/style-abc123.css`)
      assert.equal(r.status, 200)
      assert.equal(r.body, '.x{color:red}', 'un asset RÉEL doit rester servi tel quel, jamais détourné vers le rendu render.routes')
      assert.equal(r.headers['content-type'], 'text/css; charset=utf-8')
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  // vérifie que le chemin `mjs dev` (StaticServer,
  // même `shell()` que `mjs serve`) hérite AUSSI de la propagation de
  // `hydrateScript` : `serveRenderFallback` (server/index.ts) prend `r.body`
  // de `handler.handle()` tel quel et l'enveloppe avec `shell()` — aucun code
  // séparé à corriger ici, ce test le PROUVE bout-en-bout (pas juste par lecture).
  it('avec bloc render : ssr:markers hérite AUSSI de __mjs_ssrHydrate (shell() partagé avec mjs serve)', async function () {
    this.timeout(15000)
    const root = project()
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { routes: { '/markers': { component: 'mjs-home', mode: 'ssr:markers' as const } } },
    }
    const handler = await createRenderHandler(config, root)
    const port = randomPort()
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
    })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/markers`)
      assert.equal(r.status, 200)
      assert.equal(r.headers['x-mjs-mode'], 'ssr:markers')
      assert.match(r.body, /<script>window\.__mjs_ssrHydrate="a"<\/script>/)
    } finally {
      await server.stop()
      await handler.close()
    }
  })

  it('avec bloc render : une page CSR (sans fichier prérendu) reçoit le shell + le tag monté client, comme mjs serve', async function () {
    this.timeout(15000)
    const root = project()
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { routes: { '/app': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const handler = await createRenderHandler(config, root)
    const port = randomPort()
    const server = new StaticServer({
      rootDir: join(root, 'public', 'out'), port, host: '127.0.0.1',
      renderHandle: handler.handle, manifestPath: join(root, 'public', 'out', 'bundle.js'),
    })
    await server.start()
    try {
      const r = await fetchText(`http://127.0.0.1:${port}/app`)
      assert.equal(r.status, 200)
      assert.equal(r.headers['x-mjs-mode'], 'csr')
      assert.match(r.body, /<mjs-home><\/mjs-home>/)
    } finally {
      await server.stop()
      await handler.close()
    }
  })
})
