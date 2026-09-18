// `alias` — l'enregistrement de l'alias court d'un composant (`µ._al`, mjs_alias.ts) : une brique
// jointe À L'USAGE, plus une fonction du cœur toujours livrée.
//
// Seul un projet qui donne à ses composants un nom court (`doc/doc-carte.mjs` → `<mjs-carte>`)
// appelle cette aide, et le compilateur émet l'appel LITTÉRALEMENT — `µ._al(` dans le code d'au
// moins un composant. Un projet plat (aucun alias) ne l'a jamais citée.
//
// `runtime: ['alias']` la force, comme pour les autres briques détectées.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

type JsMode = 'split' | 'bundle'

interface Projet { root: string; srcDir: string; outDir: string }

// définition telle qu'écrite dans le module (build de développement : rien n'est minifié)
const MARQUE_ALIAS = 'µ._al = function'

const ENFANT = ['<script>', "$name = 'defaut'", '</script>', '<p>{$name}</p>', ''].join('\n')

// projet PLAT : un composant à la racine, son nom de fichier EST son nom de balise — aucun alias
const PLAT = { 'carte.mjs': ENFANT }
// projet à ALIAS : le composant vit dans un dossier, son nom court est `carte`
const ALIAS = { 'doc/doc-carte.mjs': ENFANT, 'parent.mjs': '<div><mjs-carte name="Ana"></mjs-carte></div>\n' }

function projet(prefixe: string, fichiers: Record<string, string>): Projet {
  const root   = mjsTmp(prefixe)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  for(const [rel, contenu] of Object.entries(fichiers)) {
    const complet = join(srcDir, rel)
    mkdirSync(dirname(complet), { recursive: true })
    writeFileSync(complet, contenu)
  }
  return { root, srcDir, outDir }
}

async function construire(p: Projet, js: JsMode, env: 'dev' | 'prod', extra: Record<string, unknown> = {}): Promise<void> {
  const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), urlPrefix: '/out', env, js, ...extra })
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
}

function contenuCoeur(p: Projet): string {
  const f = readdirSync(p.outDir).find(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f))
  assert.ok(f, `mjs_core-*.js attendu dans la sortie (trouvés : ${readdirSync(p.outDir).join(', ')})`)
  return readFileSync(join(p.outDir, f!), 'utf-8')
}

async function servir(p: Projet, corps: string): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8"></head><body>${corps}<script type="module" src="/out/bundle.js"></script></body></html>`
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

// relevé de page : des chaînes et des booléens seulement, jamais un nœud
function releverPage(tag: string): { defini: boolean; rendu: string } {
  const el: any = document.querySelector(tag)
  return {
    defini: !!customElements.get(tag),
    rendu:  el && el._shadow ? (el._shadow.textContent ?? '') : '(sans ombre)',
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

describe('mjs_alias.ts — alias de balise détecté, build RÉEL', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('projet sans alias, fichiers séparés : le module est ABSENT du cœur', async function () {
    const p = projet('alias-detect-plat-split', PLAT)
    await construire(p, 'split', 'dev')
    const coeur = contenuCoeur(p)
    assert.equal(coeur.includes(MARQUE_ALIAS), false, "l'aide d'alias ne doit pas être livrée à un projet plat")
    assert.equal(readdirSync(p.outDir).some(f => /^mjs_alias/.test(f)), false, 'aucun fichier séparé mjs_alias dans la sortie')
  })

  it('projet sans alias, fichier unique : le code est ABSENT du bundle', async function () {
    const p = projet('alias-detect-plat-bundle', PLAT)
    await construire(p, 'bundle', 'dev')
    const code = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    assert.equal(code.includes(MARQUE_ALIAS), false, "l'aide d'alias ne doit pas être livrée à un projet plat")
  })

  it('projet à alias : PRÉSENT', async function () {
    const p = projet('alias-detect-alias', ALIAS)
    await construire(p, 'split', 'dev')
    assert.ok(contenuCoeur(p).includes(MARQUE_ALIAS), "l'aide d'alias doit être livrée dès qu'un composant l'appelle")
  })

  it("runtime: ['alias'] sans aucun alias : présent quand même (explicite gagne)", async function () {
    const p = projet('alias-detect-force', PLAT)
    await construire(p, 'split', 'dev', { runtime: ['alias'] })
    assert.ok(contenuCoeur(p).includes(MARQUE_ALIAS), "la demande explicite doit joindre l'aide")
  })

  it('cache-hit : une 2e construction sans rien changer garde le module', async function () {
    const p = projet('alias-detect-cache', ALIAS)
    await construire(p, 'split', 'dev')
    assert.ok(contenuCoeur(p).includes(MARQUE_ALIAS), "l'aide doit être là à la 1re construction")
    await construire(p, 'split', 'dev')
    assert.ok(contenuCoeur(p).includes(MARQUE_ALIAS), "le signal doit survivre au cache-hit (aucune unité recompilée)")
  })
})

describe('cœur avec (puis sans) mjs_alias — montage dans Chromium', function () {
  this.timeout(180000)
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

  it("AVEC l'aide : la balise courte est définie et le composant rend sa prop", async function () {
    const p = projet('alias-montage-avec', ALIAS)
    await construire(p, 'bundle', 'prod')
    if(!browser) return
    const { url, server }   = await servir(p, '<mjs-carte name="Ana"></mjs-carte>')
    const page              = await browser.newPage()
    const erreurs: string[] = []
    page.on('pageerror', (e: Error) => erreurs.push(e.message))
    page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForTimeout(700)
      const releve = await page.evaluate(releverPage, 'mjs-carte')
      assert.equal(releve.defini, true, `l'alias doit être défini — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.rendu, 'Ana', `le composant monté par son alias doit rendre sa prop — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(erreurs, [], 'aucune erreur de page')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })

  it("SANS l'aide : le composant plat se monte par sa balise, sans erreur", async function () {
    const p = projet('alias-montage-sans', PLAT)
    await construire(p, 'bundle', 'prod')
    const code = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    assert.equal(code.includes('._al='), false, "ce bundle ne doit pas porter l'aide d'alias")
    if(!browser) return
    const { url, server }   = await servir(p, '<mjs-carte name="Ana"></mjs-carte>')
    const page              = await browser.newPage()
    const erreurs: string[] = []
    page.on('pageerror', (e: Error) => erreurs.push(e.message))
    page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForTimeout(700)
      const releve = await page.evaluate(releverPage, 'mjs-carte')
      assert.equal(releve.defini, true, `la balise du composant doit être définie — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.rendu, 'Ana', `le composant doit rendre sa prop — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(erreurs, [], 'aucune erreur de page')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })
})
