// mjs serve (smoke) : le serveur enveloppe le rendu d'une page dans un shell.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { startRenderServer, isWithinDir } from '../src/server/render-server.js'

describe('render-server — mjs serve (smoke)', () => {
  it('sert une page CSR enveloppée dans un shell + le bundle, avec X-MJS-Mode', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/app': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/app`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('x-mjs-mode'), 'csr')
      assert.match(html, /<mjs-home><\/mjs-home>/)                                 // le tag monté au client
      assert.match(html, /<script type="module" src="\/__mjs\/bundle\.js">/)       // shell + bundle
    } finally {
      await running.close()
    }
  })

  // Path traversal — `new URL()`
  // ne splitte PAS les segments encodés `%2f`, donc `%2e%2e%2f%2e%2e%2fsecret`
  // reste un segment opaque dans `.pathname`, puis `decodeURIComponent` (render-
  // server) le transforme en `/../../secret` → échappait outputDir ET pagesDir.
  // Vérifié empiriquement : undici transmet bien `req.url=/%2e%2e%2f...` tel quel.
  // Le fix rejette tout `..`/NUL décodé AVANT le moindre accès disque → 400.
  it('rejette une traversée encodée %2e%2e%2f avec 400 (jamais de fuite hors racine)', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve-trav')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    // Fichier SECRET hors de outputDir et de pagesDir (dossier racine du projet).
    writeFileSync(join(root, 'secret.html'), 'TOP-SECRET-CONTENU')
    const config = {
      sourceDir: 'src', outputDir: 'out',
      render: { default: 'prerender' as const, routes: { '/*': { component: 'mjs-home' } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/%2e%2e%2f%2e%2e%2fsecret`)
      assert.equal(res.status, 400, 'la traversée décodée en `..` doit être rejetée')
      const body = await res.text()
      assert.doesNotMatch(body, /TOP-SECRET-CONTENU/, 'le contenu hors racine ne doit JAMAIS fuir')
    } finally {
      await running.close()
    }
  })

  // AMÉLIORATION 3 (fork 3a) — `<html lang>` statique = `config.i18n.default` :
  // sans store passé au renderer, la langue SSR effective est TOUJOURS
  // `i18n.default` (aucun mismatch possible), cf. render-server.ts `shell()`.
  it('<html lang> reflète config.i18n.default', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve-lang')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = {
      sourceDir: 'src', outputDir: 'out',
      i18n: { default: 'en' },
      render: { routes: { '/app': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/app`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.match(html, /<html lang="en">/)
    } finally {
      await running.close()
    }
  })

  it('config SANS bloc i18n : <html lang="fr"> (non-régression)', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve-lang-default')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    const config = {
      sourceDir: 'src', outputDir: 'out',
      render: { routes: { '/app': { component: 'mjs-home', mode: 'csr' as const } } },
    }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/app`)
      const html = await res.text()
      assert.equal(res.status, 200)
      assert.match(html, /<html lang="fr">/)
    } finally {
      await running.close()
    }
  })

  it('sert un VRAI asset compilé depuis outputDir (pas de régression sur le cas légitime)', async function () {
    this.timeout(15000)
    const root = mjsTmp('serve-asset')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(outDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<h1>Salut</h1>')
    writeFileSync(join(outDir, 'style-abc123.css'), '.x{color:red}')
    const config = { sourceDir: 'src', outputDir: 'out' }
    const running = await startRenderServer(config as any, root, { port: 0 })
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/style-abc123.css`)
      assert.equal(res.status, 200)
      assert.equal(res.headers.get('content-type'), 'text/css')
      assert.equal(await res.text(), '.x{color:red}')
    } finally {
      await running.close()
    }
  })
})

// `asset.startsWith(outputDir)` est un
// simple préfixe de CHAÎNE, sans vérifier de séparateur de chemin : si
// `outputDir` vaut `.../dist`, un chemin résolu en `.../dist-secret/x`
// (dossier FRÈRE, hors de `outputDir`) COMMENCE PAR la même chaîne
// `.../dist` et passait donc le test à tort — un `rel` construit pour
// échapper via `..` (ex. `../dist-secret/x`) aurait pu servir des fichiers
// d'un dossier voisin. Note : le SEUL appelant actuel (`startRenderServer`)
// reçoit un `pathname` déjà normalisé par `new URL()` (WHATWG), qui élimine
// tout `..` AVANT que ce code ne le voie (vérifié empiriquement :
// `new URL('/../x', base).pathname === '/x'`) — la faille n'est donc PAS
// exploitable via une requête HTTP normale aujourd'hui, mais le garde-fou
// reste, en l'état, structurellement FAUX (coïncidence de préfixe textuel),
// une défense en profondeur fragile pour tout futur appelant qui ne
// passerait pas par `new URL()`. Testé directement sur la fonction exportée.
describe('render-server — isWithinDir (garde-fou d\'échappement de outputDir)', () => {
  it('un chemin réellement À L\'INTÉRIEUR de base : true', () => {
    assert.equal(isWithinDir('/a/b/dist', '/a/b/dist/x/y.js'), true)
  })
  it('base elle-même (chemin identique) : true', () => {
    assert.equal(isWithinDir('/a/b/dist', '/a/b/dist'), true)
  })
  it("dossier FRÈRE dont le nom COMMENCE PAR le même préfixe textuel : false (AVANT le fix : true)", () => {
    assert.equal(isWithinDir('/a/b/dist', '/a/b/dist-secret/x.js'), false)
  })
  it('échappement explicite via .. : false', () => {
    assert.equal(isWithinDir('/a/b/dist', '/a/b/dist/../other/x.js'), false)
  })
  it('chemin totalement indépendant : false', () => {
    assert.equal(isWithinDir('/a/b/dist', '/etc/passwd'), false)
  })
})
