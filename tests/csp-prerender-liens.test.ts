// `csp: true` × prérendu — un fragment prérendu ne doit contenir AUCUN `<style>` en ligne : sous une
// politique `style-src 'self'`, le navigateur refuse purement et simplement de l'appliquer. Chaque
// feuille scopée (racine à ombre, racine légère, sous-composant à ombre, sous-composant léger) part
// donc en `<link rel="stylesheet">` vers un fichier haché du dossier de sortie.
//
// Deux trous distincts, même symptôme :
//   · le mode strict du PROJET n'atteignait pas le rendu (le prérendu construit son renderer avec
//     les options du bundler, où `csp` vit — jamais avec la clé explicite du renderer) : même la
//     racine sortait un `<style>` ;
//   · la sérialisation d'un composant IMBRIQUÉ inline sa feuille sans consulter le mode : seule la
//     racine passait en `<link>`.
//
// Preuve finale en Chromium, sous une VRAIE politique stricte posée en en-tête HTTP : zéro
// violation relevée sur la page servie.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync, unlinkSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

const RACINE = [
  '<style @css="une deux">',
  ':host',
  '  display: block',
  '  color: crimson',
  '</style>',
  '<script>',
  '$titre = \'Accueil\'',
  '</script>',
  '',
  '<h1 class="t">{$titre}</h1>',
  '<@carte></@carte>',
  '<@vignette @lightDom></@vignette>',
].join('\n') + '\n'

const CARTE = [
  '<style>',
  ':host',
  '  display: block',
  '  background: papayawhip',
  '</style>',
  '',
  '<p class="c">carte</p>',
].join('\n') + '\n'

const VIGNETTE = [
  '<style>',
  ':host',
  '  display: block',
  '  border: 1px solid teal',
  '</style>',
  '',
  '<p class="v">vignette</p>',
].join('\n') + '\n'

function fixtureProject(prefix: string, light: boolean): string {
  const root = mjsTmp(prefix)
  mkdirSync(join(root, 'src'), { recursive: true })
  mkdirSync(join(root, 'styles'), { recursive: true })
  writeFileSync(join(root, 'styles', 'une.sass'), '.une\n  color: navy\n')
  writeFileSync(join(root, 'styles', 'deux.sass'), '.deux\n  color: olive\n')
  writeFileSync(join(root, 'src', 'app-home.mjs'), RACINE)
  writeFileSync(join(root, 'src', 'carte.mjs'), CARTE)
  writeFileSync(join(root, 'src', 'vignette.mjs'), VIGNETTE)
  const route: Record<string, unknown> = { component: 'mjs-app-home' }
  if (light) route.light = true
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'dist', manifestPath: 'dist/bundle.js', urlPrefix: '/dist', stylesheetsDir: 'styles',
    csp: true, css: 'split',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, routes: { '/': route } },
  }, null, 2))
  return root
}

function build(root: string): string {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root, '--prod'], { cwd: repoRoot, encoding: 'utf-8' })
  assert.equal(result.status, 0, `build en échec :\n${result.stderr}\n${result.stdout}`)
  return readFileSync(join(root, 'mjs_pages', 'index.html'), 'utf-8')
}

/** Les `href` des `<link rel="stylesheet">` du fragment, dans l'ordre. */
function feuilles(fragment: string): string[] {
  return [...fragment.matchAll(/<link rel="stylesheet" href="([^"]+)">/g)].map(m => m[1])
}

const MIME: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.css': 'text/css' }

/** Sert la racine du projet fixture avec une politique de sécurité STRICTE, comme un vrai hébergeur. */
async function servirSousCsp(root: string): Promise<{ url: string; server: Server }> {
  const server = createServer((req, res) => {
    const chemin  = decodeURIComponent((req.url ?? '/').split('?')[0])
    const fichier = join(root, normalize(chemin === '/' ? '/index.html' : chemin))
    if (!fichier.startsWith(root) || !existsSync(fichier) || !statSync(fichier).isFile()) { res.writeHead(404); res.end(); return }
    res.writeHead(200, {
      'content-type': MIME[extname(fichier)] || 'application/octet-stream',
      'content-security-policy': 'default-src \'self\'; style-src \'self\'; script-src \'self\'',
      'cache-control': 'no-store',
    })
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

describe('csp: true × prérendu — aucune feuille en ligne dans le fragment', function () {
  this.timeout(180000)

  after(async () => { await terminateSharedWorkerPool() })

  it('racine à ombre : la racine ET ses sous-composants sortent leur feuille en `<link>`', () => {
    const root = fixtureProject('csp-prerender-ombre', false)
    const fragment = build(root)
    assert.ok(!/<style[\s>]/.test(fragment), `aucun <style> en ligne attendu, obtenu :\n${fragment}`)
    const href = feuilles(fragment)
    assert.equal(href.length, 3, `une feuille par composant rendu (racine + carte à ombre + vignette légère), obtenues : ${href.join(', ')}`)
    for (const h of href) {
      assert.match(h, /^\/dist\/mjs_ssr_style_[a-z0-9-]+-[a-f0-9]{8}\.css$/, `chaque feuille est un fichier haché du dossier de sortie, obtenue : ${h}`)
      assert.ok(existsSync(join(root, 'dist', h.slice('/dist/'.length))), `le fichier visé par ${h} doit exister APRÈS le build (purge des orphelins comprise)`)
    }
  })

  it('racine légère : même règle, aucune feuille en ligne', () => {
    const root = fixtureProject('csp-prerender-legere', true)
    const fragment = build(root)
    assert.ok(!/<style[\s>]/.test(fragment), `aucun <style> en ligne attendu, obtenu :\n${fragment}`)
    assert.match(fragment, /<mjs-app-home[^>]*\smjs-light[^>]*>/, 'la racine doit bien être rendue légère')
    const href = feuilles(fragment)
    assert.equal(href.length, 3, `une feuille par composant rendu, obtenues : ${href.join(', ')}`)
    for (const h of href) assert.ok(existsSync(join(root, 'dist', h.slice('/dist/'.length))), `le fichier visé par ${h} doit exister après le build`)
  })

  it('purge des orphelins : une unité de feuille PARTAGÉE retirée est bien purgée, la feuille du RENDU est épargnée', () => {
    const root = fixtureProject('csp-prerender-purge', false)
    build(root)
    const dist = join(root, 'dist')
    const unite = readdirSync(dist).find(f => /^mjs_style_deux-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(unite, `l'unité de la feuille partagée doit exister après le premier build, dist : ${readdirSync(dist).join(', ')}`)
    // la feuille partagée disparaît du projet : son unité compilée n'appartient plus à aucun build
    unlinkSync(join(root, 'styles', 'deux.sass'))
    writeFileSync(join(root, 'src', 'app-home.mjs'), RACINE.replace('@css="une deux"', '@css="une"'))
    build(root)
    const apres = readdirSync(dist)
    assert.ok(!apres.includes(unite!), `l'unité orpheline ${unite} doit être purgée, dist : ${apres.join(', ')}`)
    assert.ok(apres.some(f => /^mjs_ssr_style_[a-z0-9-]+-[a-f0-9]{8}\.css$/.test(f)), `les feuilles écrites par le rendu restent, dist : ${apres.join(', ')}`)
  })

  it('page servie sous une politique stricte réelle (`style-src \'self\'`) : zéro violation en Chromium', async function () {
    if (!(await chromiumDisponible())) { this.skip(); return }
    const root = fixtureProject('csp-prerender-navigateur', true)
    const fragment = build(root)
    const corps = fragment.split('\n').filter(l => !l.startsWith('<!--')).join('\n').trim()
    writeFileSync(join(root, 'index.html'), `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/dist/bundle.js"></script></head><body>${corps}</body></html>`)
    const { url, server } = await servirSousCsp(root)
    const playwright: any = await import('playwright')
    const browser = await playwright.chromium.launch({ headless: true })
    try {
      const page = await (await browser.newContext()).newPage()
      const violations: string[] = []
      page.on('console', (m: any) => { if (/Content Security Policy|Refused to/i.test(m.text())) violations.push(m.text()) })
      page.on('requestfailed', (r: any) => violations.push(`${r.url()} — ${r.failure()?.errorText || '?'}`))
      await page.goto(url, { waitUntil: 'load', timeout: 60000 })
      await page.waitForTimeout(800)
      assert.deepEqual(violations, [], 'aucune violation de la politique, aucune requête en échec')
      const peint = await page.evaluate(() => {
        const h1: any = document.querySelector('h1.t')
        return { texte: h1 ? h1.textContent : null, couleur: h1 ? getComputedStyle(h1).color : null }
      })
      assert.equal(peint.texte, 'Accueil', 'la page doit bien être montée')
    } finally {
      await browser.close()
      await new Promise<void>(resolve => server.close(() => resolve()))
    }
  })
})
