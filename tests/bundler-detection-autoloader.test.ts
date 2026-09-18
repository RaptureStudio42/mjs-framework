// mjs_autoloader.ts (`µ.Autoloader` — découverte des balises `mjs-*` du document et import à la
// demande du fichier haché de chaque composant), rattaché D'OFFICE au cœur jusqu'ici : en
// `js: 'bundle'` il n'a plus rien à charger, le fichier unique exécute lui-même le
// `customElements.define` de CHAQUE composant du projet avant de rendre la main. Il quitte donc le
// cœur DANS CE SEUL MODE ; `runtime: ['autoloader']` le remet, `js: 'split'` (défaut, un fichier
// par composant à aller chercher) reste strictement inchangé.
//
// Une balise `mjs-*` inconnue (faute de frappe) n'est alors plus rejetée par l'Autoloader : le
// point d'entrée du fichier unique la signale lui-même, une fois, après la définition de tous les
// composants.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

// définition de l'objet, telle qu'écrite dans mjs_autoloader.ts (build de développement : rien
// n'est minifié, le marqueur survit à l'identique)
const MARQUE_AUTOLOADER = 'µ.Autoloader = {'

interface Projet { root: string; outDir: string; manifestPath: string }

async function construire(cfgExtra: any, files: Record<string, string>, prefix = 'detect-autoloader'): Promise<Projet> {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out', ...cfgExtra
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts    = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { root, outDir, manifestPath: join(outDir, 'bundle.js') }
}

function contenuCoeur(outDir: string): string {
  const coeur = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))
  assert.ok(coeur, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coeur!), 'utf-8')
}

// sert la page puis les fichiers de out/ tels qu'écrits sur disque
async function servir(p: Projet, body: string): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script type="module" src="/out/bundle.js"></script></body></html>`
  const server = createServer((req, res) => {
    const chemin = decodeURIComponent((req.url ?? '/').split('?')[0])
    if(chemin === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const fichier = join(p.root, normalize(chemin))
    if(!fichier.startsWith(p.outDir) || !existsSync(fichier) || !statSync(fichier).isFile()) {
      res.writeHead(404)
      res.end()
      return
    }
    res.writeHead(200, { 'content-type': extname(fichier) === '.js' ? 'text/javascript; charset=utf-8' : 'application/octet-stream' })
    res.end(readFileSync(fichier))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/`, server }
}

// monte la page dans Chromium : rend les TEXTES de chaque composant (jamais un nœud) et les
// messages de console
async function monter(browser: any, p: Projet, body: string): Promise<{ rendus: Record<string, string>; messages: string[] }> {
  const { url, server }    = await servir(p, body)
  const page               = await browser.newPage()
  const messages: string[] = []
  page.on('pageerror', (e: Error) => messages.push('pageerror: ' + e.message))
  page.on('console', (m: any) => messages.push(m.type() + ': ' + m.text()))
  try {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(300)
    const rendus = await page.evaluate(() => {
      const out: Record<string, string> = {}
      for(const el of Array.from(document.querySelectorAll('*')) as any[]) {
        if(!el.tagName.startsWith('MJS-')) continue
        out[el.tagName.toLowerCase()] = el._shadow ? Array.from(el._shadow.querySelectorAll('p')).map((n: any) => n.textContent).join('|') : '(sans ombre)'
      }
      return out
    })
    return { rendus, messages }
  }
  finally {
    await page.close()
    await new Promise(resolve => server.close(() => resolve(null)))
  }
}

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if(!existsSync(playwright.chromium.executablePath())) return null
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

const SOURCES = {
  'hop.mjs':  '<script>\n$t = \'ok\'\n</script>\n<p>{$t}</p>\n',
  'zig.mjs':  '<p>zig</p>\n',
}

describe('mjs_autoloader.ts — hors du cœur en js: bundle, build RÉEL', function () {
  this.timeout(120000)
  let browser: any = null

  before(async function () {
    this.timeout(60000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de construction gardées.')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it("js: 'bundle' : ABSENT du fichier unique", async function () {
    const p = await construire({ js: 'bundle' }, SOURCES)
    const texte = readFileSync(p.manifestPath, 'utf-8')
    assert.equal(texte.includes(MARQUE_AUTOLOADER), false, "le fichier unique ne doit pas porter l'Autoloader")
    assert.equal(texte.includes('pendingComponents'), false, 'aucune trace du module dans le fichier unique')
  })

  it("js: 'split' (défaut) : PRÉSENT dans le cœur, inchangé", async function () {
    const p = await construire({}, SOURCES)
    assert.ok(contenuCoeur(p.outDir).includes(MARQUE_AUTOLOADER))
  })

  it("js: 'bundle' + runtime: ['autoloader'] : présent quand même (explicite gagne)", async function () {
    const p = await construire({ js: 'bundle', runtime: ['autoloader'] }, SOURCES)
    assert.ok(readFileSync(p.manifestPath, 'utf-8').includes(MARQUE_AUTOLOADER))
  })

  it("js: 'bundle' : les composants de la page se montent sans l'Autoloader", async function () {
    const p = await construire({ js: 'bundle' }, SOURCES)
    if(!browser) return
    const { rendus, messages } = await monter(browser, p, '<mjs-hop></mjs-hop><mjs-zig></mjs-zig>')
    assert.deepEqual(rendus, { 'mjs-hop': 'ok', 'mjs-zig': 'zig' }, `rendus faux — console : ${messages.join(' / ') || 'vide'}`)
    assert.equal(messages.some(m => m.includes('pageerror')), false, `aucune erreur de page attendue : ${messages.join(' / ')}`)
    assert.equal(messages.some(m => m.includes('inconnue')), false, `aucune balise inconnue dans cette page : ${messages.join(' / ')}`)
  })

  it("js: 'bundle' : une balise mjs-* inconnue est signalée en console", async function () {
    const p = await construire({ js: 'bundle' }, SOURCES)
    if(!browser) return
    const { rendus, messages } = await monter(browser, p, '<mjs-hop></mjs-hop><mjs-typo></mjs-typo>')
    assert.equal(rendus['mjs-hop'], 'ok', `le composant connu doit se monter — console : ${messages.join(' / ')}`)
    const signalees = messages.filter(m => m.includes('mjs-typo') && m.includes('inconnue'))
    assert.equal(signalees.length, 1, `<mjs-typo> doit être signalée UNE fois — console : ${messages.join(' / ') || 'vide'}`)
    assert.equal(messages.some(m => m.includes('mjs-hop') && m.includes('inconnue')), false, 'une balise connue ne doit jamais être signalée')
  })
})
