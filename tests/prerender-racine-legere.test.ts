// Racine prérendue en mode léger — clé de route `light: true` (mjs.config.json → `render.routes`).
// Une page dont le composant racine est monté `mjs-light` côté client (`<mjs-x mjs-light>` dans la
// coquille) n'avait aucun moyen de se faire PRÉRENDRE léger : le rendu serveur construisait
// toujours un hôte à Shadow DOM, et le fragment servi (`<template shadowrootmode>`) ne
// correspondait pas au DOM que le client rebâtit — deux arbres différents pour la même page.
// Contrat : `light: true` sur la route → racine sérialisée `<mjs-x mjs-light mjs-ssr>`, contenu en
// ENFANTS DIRECTS (aucun `<template shadowrootmode>`), feuille scopée portée par le fragment avec
// `:host` réécrit en nom de balise (un léger n'a pas d'hôte réel).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { findConfig } from '../src/bundler/config.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const COMPOSANT = [
  '<style>',
  ':host',
  '  display: block',
  '  color: crimson',
  '</style>',
  '<script>',
  '$titre = \'Accueil\'',
  '</script>',
  '',
  '<h1 class="t">{$titre}</h1>',
].join('\n') + '\n'

function fixtureProject(prefix: string, light: boolean, engine: 'happy-dom' | 'browser'): string {
  const root = mjsTmp(prefix)
  mkdirSync(join(root, 'src'), { recursive: true })
  writeFileSync(join(root, 'src', 'app-home.mjs'), COMPOSANT)
  const route: Record<string, unknown> = { component: 'mjs-app-home' }
  if (light) route.light = true
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'dist', manifestPath: 'dist/bundle.js', urlPrefix: '/dist', runtime: 'core',
    render: { default: 'prerender', engine: { prerender: engine }, routes: { '/': route } },
  }, null, 2))
  return root
}

function build(root: string): string {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root, '--prod'], { cwd: repoRoot, encoding: 'utf-8' })
  assert.equal(result.status, 0, `build en échec :\n${result.stderr}\n${result.stdout}`)
  return readFileSync(join(root, 'mjs_pages', 'index.html'), 'utf-8')
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' }

/** Sert la racine du projet fixture (index.html + dist/) sur un port libre. */
async function servir(root: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chemin  = decodeURIComponent((req.url ?? '/').split('?')[0])
    const fichier = join(root, normalize(chemin === '/' ? '/index.html' : chemin))
    if (!fichier.startsWith(root) || !existsSync(fichier) || !statSync(fichier).isFile()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, { 'content-type': MIME[extname(fichier)] || 'application/octet-stream', 'cache-control': 'no-store' })
    res.end(readFileSync(fichier))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/`, server }
}

async function chromiumDisponible(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

describe('racine prérendue en mode léger (clé de route `light`)', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('configuration : `light` est une clé de route connue, et refuse une valeur non booléenne', () => {
    const ecrire = (light: unknown): string => {
      const root = mjsTmp('cfg-route-light')
      writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ render: { routes: { '/': { component: 'mjs-app-home', light } } } }))
      return root
    }
    const found = findConfig(ecrire(true))
    assert.ok(found)
    assert.equal(found!.config.render!.routes!['/'].light, true)
    assert.throws(() => findConfig(ecrire('oui')), /light/)
  })

  it('configuration : `light` sur une route `csr` est signalé — le serveur n\'y rend rien', () => {
    const root = mjsTmp('cfg-route-light-csr')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ render: { routes: { '/': { component: 'mjs-app-home', mode: 'csr', light: true } } } }))
    const avertis: string[] = []
    const orig = console.warn
    console.warn = (...a: unknown[]) => { avertis.push(String(a[0])) }
    try { findConfig(root) } finally { console.warn = orig }
    assert.equal(avertis.filter(m => m.includes('light')).length, 1, `un avertissement attendu, obtenus : ${avertis.join(' | ')}`)
    assert.match(avertis.find(m => m.includes('light'))!, /sans effet sur une route 'csr'/)
  })

  it('API : `renderToString(tag, { light: true })` rend la racine en mode léger, feuille comprise', async () => {
    const root = mjsTmp('racine-legere-api')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'app-home.mjs'), COMPOSANT)
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: join(root, 'dist') })
    try {
      const res = await renderer.renderToString('mjs-app-home', { light: true })
      assert.equal(res.light, true, 'le rendu doit se déclarer léger')
      assert.ok(!res.html.includes('<template shadowrootmode'), `aucun Shadow DOM déclaratif attendu, obtenu :\n${res.html}`)
      assert.match(res.html, /^<mjs-app-home[^>]*\smjs-light(\s|>)/, `la racine doit porter l'attribut mjs-light, obtenue :\n${res.html}`)
      assert.match(res.html, /<h1 class="t">Accueil<\/h1>/, 'le contenu doit être un enfant DIRECT de la racine')
      assert.match(res.html, /<style>[^<]*mjs-app-home\s*\{/, `la feuille scopée doit voyager avec le fragment, ':host' réécrit en nom de balise, obtenue :\n${res.html}`)
      assert.ok(!/<style>[^<]*:host/.test(res.html), 'aucun `:host` ne doit subsister : un léger n\'a pas d\'hôte réel')
    } finally {
      await renderer.close()
    }
  })

  it('prérendu happy-dom : `light: true` sur la route → fragment léger', () => {
    const fragment = build(fixtureProject('racine-legere-happy', true, 'happy-dom'))
    assert.ok(!fragment.includes('<template shadowrootmode'), `aucun Shadow DOM déclaratif attendu, obtenu :\n${fragment}`)
    assert.match(fragment, /<mjs-app-home[^>]*\smjs-light[^>]*\smjs-ssr[^>]*>/, `racine légère attendue, obtenue :\n${fragment}`)
    assert.match(fragment, /<h1 class="t">Accueil<\/h1>/, 'le contenu doit être un enfant DIRECT de la racine')
    assert.match(fragment, /mjs-app-home\s*\{/, 'la feuille scopée doit voyager avec le fragment')
  })

  it('prérendu happy-dom : sans la clé, la racine reste à Shadow DOM (comportement par défaut)', () => {
    const fragment = build(fixtureProject('racine-ombre-happy', false, 'happy-dom'))
    assert.match(fragment, /<mjs-app-home[^>]*><template shadowrootmode="open">/, `Shadow DOM déclaratif attendu par défaut, obtenu :\n${fragment}`)
    assert.ok(!fragment.includes('mjs-light'), 'aucun mode léger sans la clé de route')
  })

  it('page servie : le client REMPLACE la photo serveur d\'une racine légère (jamais deux arbres)', async function () {
    if (!(await chromiumDisponible())) { this.skip(); return }
    const root = fixtureProject('racine-legere-servie', true, 'happy-dom')
    const fragment = build(root)
    // page assemblée : le fragment prend la place de la balise racine, comme le ferait le back
    const corps = fragment.split('\n').filter(l => !l.startsWith('<!--')).join('\n').trim()
    writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/dist/bundle.js"></script></head><body>${corps}</body></html>`)
    const { url, server } = await servir(root)
    const playwright: any = await import('playwright')
    const browser = await playwright.chromium.launch({ headless: true })
    try {
      const page = await (await browser.newContext()).newPage()
      const erreurs: string[] = []
      page.on('pageerror', (e: any) => erreurs.push(String(e)))
      page.on('console', (m: any) => { if (m.type() === 'error') erreurs.push(m.text()) })
      await page.goto(url, { waitUntil: 'load', timeout: 60000 })
      await page.waitForTimeout(500)
      const releve = await page.evaluate(() => ({
        titres: document.querySelectorAll('h1.t').length,
        enfants: document.querySelector('mjs-app-home')!.children.length,
        texte: document.querySelector('mjs-app-home')!.textContent!.trim(),
      }))
      assert.deepEqual(erreurs, [], 'aucune erreur au remontage client')
      assert.equal(releve.titres, 1, 'un seul titre : la photo serveur est REMPLACÉE, jamais doublée')
      assert.equal(releve.enfants, 1, 'la racine ne garde qu\'un enfant — celui que le client vient de construire')
      assert.equal(releve.texte, 'Accueil')
    } finally {
      await browser.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })

  it('prérendu navigateur : `light: true` sur la route → fragment léger', async function () {
    if (!(await chromiumDisponible())) { this.skip(); return }
    const fragment = build(fixtureProject('racine-legere-browser', true, 'browser'))
    assert.ok(!fragment.includes('<template shadowrootmode'), `aucun Shadow DOM déclaratif attendu, obtenu :\n${fragment}`)
    assert.match(fragment, /<mjs-app-home[^>]*\smjs-light[^>]*\smjs-ssr[^>]*>/, `racine légère attendue, obtenue :\n${fragment}`)
    assert.match(fragment, /<h1 class="t">Accueil<\/h1>/, 'le contenu doit être un enfant DIRECT de la racine')
    assert.match(fragment, /mjs-app-home\s*\{/, 'la feuille scopée doit voyager avec le fragment')
  })
})
