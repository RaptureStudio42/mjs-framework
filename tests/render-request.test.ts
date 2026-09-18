// Rendu PAR REQUÊTE : URL + en-têtes → prerender / ssr / csr.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { createRenderHandler } from '../src/server/render-request.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('render-request — rendu par requête', () => {
  after(async () => { await terminateSharedWorkerPool() })

  function project() {
    const root = mjsTmp('req')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), `
<script lang="coffee">
$titre = "Accueil"
</script>
<h1 class="t">{$titre}</h1>
`)
    return root
  }

  const config = {
    sourceDir: 'src',
    outputDir: 'public/out',
    render: {
      default: 'prerender' as const,
      header: 'X-MJS-Render',
      routes: {
        '/':        { component: 'mjs-home', mode: 'ssr' as const },
        '/app':     { component: 'mjs-home', mode: 'csr' as const },
        '/static':  { component: 'mjs-home', mode: 'prerender' as const },
        '/markers': { component: 'mjs-home', mode: 'ssr:markers' as const },
      },
    },
  }

  it('URL non déclarée → csr (le back sert le shell)', async () => {
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/inconnu')
    assert.equal(res.kind, 'csr')
    assert.equal(res.body, '')
    await h.close()
  })

  it('route en mode csr → csr', async () => {
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/app')
    assert.equal(res.kind, 'csr')
    await h.close()
  })

  it('prerender sert le fichier figé s\'il existe', async () => {
    const root = project()
    const pagesDir = join(root, 'public', 'mjs_pages')
    mkdirSync(pagesDir, { recursive: true })
    writeFileSync(join(pagesDir, 'static.html'), '<mjs-home>FIGÉ</mjs-home>')
    const h = await createRenderHandler(config, root)
    const res = await h.handle('/static')
    assert.equal(res.kind, 'prerender')
    assert.match(res.body, /FIGÉ/)
    await h.close()
  })

  it('override header X-MJS-Render force csr sur une route ssr', async () => {
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/', { 'x-mjs-render': 'csr' })
    assert.equal(res.kind, 'csr')
    assert.equal(res.mode, 'csr')
    await h.close()
  })

  it('SSR rend le composant à la volée', async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/')
    assert.equal(res.kind, 'ssr')
    assert.match(res.body, /<mjs-home[^>]*><template shadowrootmode="open">/)
    assert.match(res.body, /Accueil/)
    await h.close()
  })

  // TROUVAILLE LATENTE — `hydrateScript` (RenderResult,
  // cf. renderToString.ts/render-browser.ts) était déstructuré NULLE PART dans
  // `handle()` : perdu, jamais concaténé au body → `window.__mjs_ssrHydrate`
  // n'atteignait jamais le client, qui reconstruisait toujours au lieu
  // d'hydrater (cf. mjs_init.ts). Fix : destructuration + concat après le html.
  it('ssr:markers : le body sert __mjs_ssrHydrate (hydratation propagée au client)', async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/markers')
    assert.equal(res.kind, 'ssr')
    assert.match(res.body, /<script>window\.__mjs_ssrHydrate="a"<\/script>/,
      'AVANT le fix : hydrateScript déstructuré nulle part → jamais concaténé, flag absent du body servi')
    await h.close()
  })

  it('ssr:replace (défaut) : __mjs_ssrHydrate absent (non-régression, RenderResult.hydrateScript vide dans ce mode)', async function () {
    this.timeout(30000)
    const h = await createRenderHandler(config, project())
    const res = await h.handle('/')
    assert.equal(res.kind, 'ssr')
    assert.doesNotMatch(res.body, /__mjs_ssrHydrate/)
    await h.close()
  })

  // Path traversal — un pathname
  // décodé contenant `..` (via `%2e%2e%2f%2e%2e%2f` non normalisé par `new URL`,
  // décodé ensuite par le serveur/middleware) sur une route catch-all `*` en mode
  // prerender faisait `join(pagesDir, '../../secret.html')` → HORS de pagesDir →
  // `readFileSync` d'un fichier ARBITRAIRE servi au client. Le fix `isWithinDir`
  // (render-request.ts) refuse de LIRE hors pagesDir et retombe sur le rendu.
  it('pathname décodé avec `..` (catch-all prerender) : ne LIT jamais hors pagesDir', async function () {
    this.timeout(30000)
    const root = project()
    const pagesDir = join(root, 'public', 'mjs_pages')
    mkdirSync(pagesDir, { recursive: true })
    // Fichier SECRET hors pagesDir, exactement là où `/../../secret` pointerait
    // depuis pagesDir (root/public/mjs_pages/../../secret.html === root/secret.html).
    writeFileSync(join(root, 'secret.html'), 'TOP-SECRET-HORS-PAGESDIR')
    const travConfig = {
      sourceDir: 'src', outputDir: 'public/out',
      render: { default: 'prerender' as const, routes: { '/*': { component: 'mjs-home' } } },
    }
    const h = await createRenderHandler(travConfig, root)
    // `/%2e%2e%2f%2e%2e%2fsecret` tel que reçu par le serveur → décodé `/../../secret`.
    const res = await h.handle('/../../secret')
    assert.notEqual(res.kind, 'prerender',
      'AVANT le fix : renvoyait le fichier prérendu situé HORS pagesDir (kind:prerender)')
    assert.doesNotMatch(res.body, /TOP-SECRET-HORS-PAGESDIR/,
      'le contenu d\'un fichier hors pagesDir ne doit JAMAIS fuir au client')
    await h.close()
  })
})
