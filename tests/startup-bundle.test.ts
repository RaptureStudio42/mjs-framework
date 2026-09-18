// démarrage d'une page prérendue — `render.startup: 'bundle'` : en PLUS des liens de
// préchargement, une construction de PRODUCTION assemble les COMPOSANTS de la page en un fichier
// `mjs_page-<slug>-<empreinte>.js`. Le cœur, les feuilles, les animations, les fichiers de langue et
// les MODULES restent EXTERNES (un module doit rester une instance unique : un store singleton
// dupliqué dans le fichier de page casserait l'état partagé).
//
// Le fragment porte alors UN lien vers le fichier de page, un lien par module de la fermeture, et une
// fiche `<script type="application/json" id="__mjs_page">` que le manifeste lit pour repointer
// `µ.paths` sur ce fichier : son bloc de préchargement ne redemande donc aucun fichier séparé, et
// l'Autoloader, en important n'importe quelle balise de la page, charge le fichier déjà en cache.
//
// Les fichiers séparés existent toujours (une autre page les charge seuls, le rendu serveur les lit
// un par un) : le fichier de page est un chemin de démarrage, jamais un remplacement.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, basename, dirname, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts, type RenderConfig } from '../src/bundler/config.js'
import { prerenderPages, type PrerenderReport } from '../src/server/prerender.js'
import { emitStartup, type StartupReport } from '../src/bundler/startup.js'
import { stripEsm } from '../src/server/renderToString.js'

interface Projet { root: string; srcDir: string; outDir: string }

const PAGE_RE  = /^mjs_page-index-[a-f0-9]{8}\.js$/
const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

// accueil : 3 composants rendus + 1 enfant d'un `{if}` faux + 1 module `@import`-é ;
// `/solo` n'a qu'un seul composant (sous le seuil : jamais de fichier de page).
function fixture(prefix: string, render: RenderConfig, cfgExtra: Record<string, unknown> = {}, carteTexte = 'carte'): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'shared.module.civet'), 'export bump := (x) -> x + 1\n')
  writeFileSync(join(srcDir, 'card.mjs'), `<p class="card">${carteTexte}</p>\n`)
  writeFileSync(join(srcDir, 'badge.mjs'), '<b class="badge">neuf</b>\n')
  writeFileSync(join(srcDir, 'later.mjs'), '<p class="later">plus tard</p>\n')
  writeFileSync(join(srcDir, 'solo.mjs'), '<p class="solo">seul</p>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '@import bump \'shared.module.civet\'',
    '',
    '<script>',
    '$open ?= false',
    '</script>',
    '',
    '<h1 class="t">accueil {bump(1)}</h1>',
    '<mjs-card></mjs-card>',
    '<mjs-badge></mjs-badge>',
    '{if $open}<mjs-later></mjs-later>{end}'
  ].join('\n') + '\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out', render, ...cfgExtra,
  }, null, 2))
  return { root, srcDir, outDir }
}

// deux routes de basename identique (`/` et `/a/index`) aux composants distincts : leur fichier de
// page se nomme d'après l'URL, jamais d'après le nom du fragment.
function fixtureDeuxRoutes(prefix: string, routes: Record<string, unknown>): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'badge.mjs'), '<b class="badge">neuf</b>\n')
  writeFileSync(join(srcDir, 'extra.mjs'), '<i class="extra">plus</i>\n')
  writeFileSync(join(srcDir, 'zebre.mjs'), '<u class="zebre">rayé</u>\n')
  writeFileSync(join(srcDir, 'home.mjs'), '<h1 class="t">accueil</h1>\n<mjs-card></mjs-card>\n<mjs-badge></mjs-badge>\n')
  writeFileSync(join(srcDir, 'other.mjs'), '<h2 class="o">autre</h2>\n<mjs-extra></mjs-extra>\n<mjs-zebre></mjs-zebre>\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', routes },
  }, null, 2))
  return { root, srcDir, outDir }
}

// deux langues aux ensembles DIVERGENTS : `mjs-anglais` n'est rendu que dans la passe `en`, et par
// une balise DYNAMIQUE — aucune analyse statique du gabarit ne peut l'annoncer comme dépendance.
function fixtureLocales(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'badge.mjs'), '<b class="badge">neuf</b>\n')
  writeFileSync(join(srcDir, 'anglais.mjs'), '<p class="anglais">english only</p>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '<script>',
    '$tag = µlang == \'en\' ? \'mjs-anglais\' : \'span\'',
    '</script>',
    '',
    '<h1 class="t">accueil</h1>',
    '<mjs-card></mjs-card>',
    '<mjs-badge></mjs-badge>',
    '<@element $tag>langue</@element>',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', locales: ['fr', 'en'], routes: { '/': { component: 'mjs-home' } } },
  }, null, 2))
  return { root, srcDir, outDir }
}

// deux langues dont la divergence vient d'un `{if}` SUR LA LANGUE : chaque fragment n'en rend qu'une
// branche, mais les deux enfants sont des dépendances STATIQUES du gabarit — la fermeture les ramène
// dans l'ensemble de démarrage des deux langues.
function fixtureLocalesIf(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'anglais.mjs'), '<p class="anglais">english only</p>\n')
  writeFileSync(join(srcDir, 'francais.mjs'), '<p class="francais">français seulement</p>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '<h1 class="t">accueil</h1>',
    '<mjs-card></mjs-card>',
    '{if µlang == \'en\'}<mjs-anglais></mjs-anglais>{end}',
    '{if µlang == \'fr\'}<mjs-francais></mjs-francais>{end}',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', locales: ['fr', 'en'], routes: { '/': { component: 'mjs-home' } } },
  }, null, 2))
  return { root, srcDir, outDir }
}

// une balise citée dans la FEUILLE DE STYLE du composant (`content:`) : le `<style>` part dans le
// fragment, son contenu est du texte brut — `mjs-faux` n'est rien que la page affiche.
function fixtureStyleCite(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'card.mjs'), '<p class="card">carte</p>\n')
  writeFileSync(join(srcDir, 'badge.mjs'), '<b class="badge">neuf</b>\n')
  writeFileSync(join(srcDir, 'faux.mjs'), '<p class="faux">jamais affiché sur cette page</p>\n')
  writeFileSync(join(srcDir, 'home.mjs'), [
    '<style>',
    '  .t::after',
    '    content: \'<mjs-faux></mjs-faux>\'',
    '</style>',
    '',
    '<h1 class="t">accueil</h1>',
    '<mjs-card></mjs-card>',
    '<mjs-badge></mjs-badge>',
  ].join('\n') + '\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
    render: { default: 'prerender', engine: { prerender: 'happy-dom' }, startup: 'bundle', routes: { '/': { component: 'mjs-home' } } },
  }, null, 2))
  return { root, srcDir, outDir }
}

function renderBundle(extra: Record<string, unknown> = {}): RenderConfig {
  return {
    default: 'prerender',
    engine: { prerender: 'happy-dom' },
    startup: 'bundle',
    routes: { '/': { component: 'mjs-home' }, '/solo': { component: 'mjs-solo' } },
    ...extra,
  } as RenderConfig
}

async function construire(p: Projet, env: 'dev' | 'prod' = 'prod'): Promise<{ bundler: Bundler; report: PrerenderReport; startup: StartupReport; journal: string[] }> {
  const found = findConfig(p.root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const bundler = new Bundler({ ...resolveBundlerOpts(found!.config, found!.configDir), env } as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const report  = await prerenderPages(found!.config, found!.configDir, () => {}, { env })
  const journal: string[] = []
  const startup = await emitStartup(bundler, found!.config.render, report, { prod: env === 'prod', log: m => journal.push(m) })
  await bundler.close()
  return { bundler, report, startup, journal }
}

// construction par la VRAIE CLI, en sous-processus : purge des orphelins, prérendu, en-tête de
// démarrage et précache s'y enchaînent dans leur ordre de production, jamais celui d'un test
function buildCli(p: Projet): string {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--prod', '--root', p.root], { cwd: repoRoot, encoding: 'utf-8' })
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  return result.stdout
}

function fragment(report: PrerenderReport, url: string): string {
  const page = report.generated.find(g => g.url === url)
  assert.ok(page, `la page ${url} doit être générée`)
  return page!.file
}

function liens(texte: string): string[] {
  return [...texte.matchAll(/<link rel="modulepreload" href="([^"]+)">/g)].map(m => m[1])
}

function fiche(texte: string): { file: string; names: string[] } {
  const m = texte.match(/<script type="application\/json" id="__mjs_page">(.*?)<\/script>/)
  assert.ok(m, 'la fiche __mjs_page doit être dans le fragment')
  return JSON.parse(m![1])
}

function fichierDePage(p: Projet): string {
  const trouves = readdirSync(p.outDir).filter(f => PAGE_RE.test(f))
  assert.equal(trouves.length, 1, `un seul fichier de page attendu, vus : ${trouves.join(', ')}`)
  return join(p.outDir, trouves[0])
}

// sert la coquille (fragment dans le <body>, manifeste en module dans le <head>) puis out/ tel quel
async function servir(p: Projet, fragmentFile: string): Promise<{ url: string; server: Server }> {
  const corps = readFileSync(fragmentFile, 'utf-8')
  const html  = `<!doctype html><html><head><meta charset="utf-8"><script type="module" src="/out/bundle.js"></script></head><body>${corps}</body></html>`
  const server = createServer((req, res) => {
    const chemin = decodeURIComponent((req.url ?? '/').split('?')[0])
    if (chemin === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
      res.end(html)
      return
    }
    const fichier = join(p.root, normalize(chemin))
    if (!fichier.startsWith(p.outDir) || !existsSync(fichier) || !statSync(fichier).isFile()) {
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

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if (!existsSync(playwright.chromium.executablePath())) return null
    return await playwright.chromium.launch()
  }
  catch {
    return null
  }
}

describe('démarrage des pages prérendues — fichier de page', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    browser = await chromiumDisponible()
    if (!browser) console.log('  ℹ️  Chromium non installé : le montage réel est sauté, les assertions de construction restent. Activer : `npx playwright install chromium`')
  })

  after(async function () {
    if (browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('production : un fichier de page assemble les composants, le cœur et les modules restent externes', async () => {
    const p = fixture('startup-bundle', renderBundle())
    const { report, startup } = await construire(p)
    const pageFile = fichierDePage(p)
    const code     = readFileSync(pageFile, 'utf-8')
    const coeur    = readFileSync(join(p.outDir, readdirSync(p.outDir).find(f => /^mjs_core-/.test(f))!), 'utf-8')

    // les 4 composants de l'ensemble y sont définis, une fois chacun — fichier MINIFIÉ, le nom sous
    // lequel le cœur est importé y est raccourci : l'appel se reconnaît à `._def("mjs-…"`, pas à `µ`
    const definis = [...code.matchAll(/\._def\("(mjs-[a-z-]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(definis, ['mjs-badge', 'mjs-card', 'mjs-home', 'mjs-later'], `définis : ${definis.join(', ')}`)

    // le cœur est importé par URL, son code n'est pas recopié : témoin propre au cœur (clé de
    // sessionStorage de la garde « bundle périmé » de l'Autoloader), absente de tout composant
    assert.match(code, /import\s*\{[^}]*\}\s*from\s*"\/out\/mjs_core-[a-f0-9]{8}\.js"/, 'le cœur reste un import externe')
    assert.ok(coeur.includes('mjs-stale-reload'), 'témoin du cœur présent dans le cœur')
    assert.equal(code.includes('mjs-stale-reload'), false, 'le code du cœur n\'est pas recopié dans le fichier de page')
    assert.ok(code.length < coeur.length / 4, `le fichier de page (${code.length} o) doit rester bien plus petit que le cœur (${coeur.length} o)`)

    // le module reste externe (instance unique)
    assert.match(code, /from\s*"\/out\/shared\.module-[a-f0-9]{8}\.js"/, 'le module reste un import externe')

    // fragment : 1 lien de page + 1 lien par module, et la fiche du fichier de page
    const texte = readFileSync(fragment(report, '/'), 'utf-8')
    const hrefs = liens(texte)
    assert.equal(hrefs.length, 2, `2 liens attendus (page + module), vus : ${hrefs.join(' ')}`)
    assert.equal(hrefs[0], `/out/${basename(pageFile)}`, 'le fichier de page passe en premier')
    assert.match(hrefs[1], /^\/out\/shared\.module-[a-f0-9]{8}\.js$/, 'le module de la fermeture garde son lien')
    assert.equal(hrefs.some(h => /\/out\/(card|badge|home|later)-/.test(h)), false, 'aucun lien vers un fichier séparé de la page')

    // `file` dans la MÊME forme que les valeurs de µ.paths (préfixe factorisé → basename seul)
    const json = fiche(texte)
    assert.equal(json.file, basename(pageFile))
    assert.deepEqual(json.names, ['badge', 'card', 'home', 'later'])
    assert.deepEqual(startup.pageFiles, [`/out/${basename(pageFile)}`])
  })

  it('le manifeste lit la fiche et repointe µ.paths sur le fichier de page', async () => {
    const p = fixture('startup-bundle-paths', renderBundle())
    const { report } = await construire(p)
    const pageFile = basename(fichierDePage(p))
    const texte    = readFileSync(fragment(report, '/'), 'utf-8')
    const HappyDOM = await import('happy-dom')
    const window: any = new HappyDOM.Window({ url: 'http://localhost/' })
    window.document.body.innerHTML = texte
    // prologue SYNCHRONE du manifeste (tout ce qui précède l'import dynamique du cœur, que
    // happy-dom ne sait pas résoudre) : c'est là que vivent la table et sa relecture de la fiche
    const src = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    const prologue = src.slice(0, src.indexOf('const µReady'))
    window.eval(stripEsm(prologue) + '\nwindow.__paths = µPaths;\nwindow.__prefix = µPathsPrefix;')
    for (const nom of ['badge', 'card', 'home', 'later']) {
      assert.equal(window.__paths[nom], pageFile, `µ.paths['${nom}'] doit pointer le fichier de page`)
    }
    assert.equal(window.__prefix, '/out/', 'le préfixe factorisé reste celui du manifeste')
    // le module, lui, garde son propre fichier
    assert.match(window.__paths['shared.module'], /^shared\.module-[a-f0-9]{8}\.js$/)
    // le bloc de préchargement du manifeste tourne dans ce prologue : il ne doit poser AUCUN lien
    // vers un fichier séparé de la page (la table vient d'être repointée sur le fichier de page)
    const poses = [...window.document.head.querySelectorAll('link[rel="modulepreload"]')].map((l: any) => l.getAttribute('href'))
    assert.ok(poses.length > 0, `le manifeste doit poser des liens (vus : ${poses.join(' ')})`)
    assert.deepEqual(poses.filter(h => /\/out\/(card|badge|home|later)-[a-f0-9]{8}\.js$/.test(h)), [], `aucun fichier séparé de la page, vus : ${poses.join(' ')}`)
    assert.ok(poses.includes(`/out/${pageFile}`), `le fichier de page doit être préchargé par le manifeste aussi (vus : ${poses.join(' ')})`)
  })

  it('montage réel : les composants s\'affichent, une seule requête de composants, zéro erreur', async function () {
    if (!browser) this.skip()
    const p = fixture('startup-bundle-chromium', renderBundle())
    const { report } = await construire(p)
    const pageFile = basename(fichierDePage(p))
    const { url, server } = await servir(p, fragment(report, '/'))
    const page = await browser.newPage()
    const erreurs: string[] = []
    const jsDemandes: string[] = []
    page.on('pageerror', (e: Error) => erreurs.push(e.message))
    page.on('console', (m: any) => { if (m.type() === 'error') erreurs.push(m.text()) })
    page.on('request', (r: any) => { if (/\.js$/.test(new URL(r.url()).pathname)) jsDemandes.push(new URL(r.url()).pathname) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForFunction(() => {
        const home: any = document.querySelector('mjs-home')
        return !!(home && (home._shadow || home.shadowRoot))
      }, null, { timeout: 15000 }).catch(() => {})
      await page.waitForTimeout(300)
      const vus = await page.evaluate(() => {
        const trouves: string[] = []
        const parcourir = (racine: any): void => {
          for (const el of Array.from(racine.querySelectorAll('*')) as any[]) {
            if (!el.tagName.startsWith('MJS-')) continue
            if (customElements.get(el.tagName.toLowerCase())) trouves.push(el.tagName.toLowerCase())
            const sr = el._shadow || el.shadowRoot
            if (sr) parcourir(sr)
          }
        }
        parcourir(document)
        return trouves.sort()
      })
      assert.deepEqual(erreurs, [], `erreurs de page : ${erreurs.join(' | ')}`)
      assert.deepEqual([...new Set(vus)], ['mjs-badge', 'mjs-card', 'mjs-home'], `balises définies et montées : ${vus.join(', ')}`)
      assert.ok(jsDemandes.includes(`/out/${pageFile}`), `le fichier de page doit être demandé (vues : ${jsDemandes.join(' ')})`)
      const separes = jsDemandes.filter(u => /\/out\/(card|badge|home|later)-[a-f0-9]{8}\.js$/.test(u))
      assert.deepEqual(separes, [], `aucun fichier séparé de composant ne doit être demandé, vus : ${separes.join(' ')}`)
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })

  it('reconstruction à l\'identique : même fichier de page, fragment inchangé ; un composant modifié purge l\'ancien haché', async () => {
    const p = fixture('startup-bundle-stable', renderBundle())
    const premier = await construire(p)
    const pageFile1 = basename(fichierDePage(p))
    const texte1 = readFileSync(fragment(premier.report, '/'), 'utf-8')
    const second = await construire(p)
    const pageFile2 = basename(fichierDePage(p))
    const texte2 = readFileSync(fragment(second.report, '/'), 'utf-8')
    assert.equal(pageFile2, pageFile1, 'même contenu ⇒ même empreinte')
    assert.equal(texte2, texte1, 'fragment identique au bit près')
    assert.deepEqual(second.startup.pageFiles, premier.startup.pageFiles, 'même fichier de page annoncé')

    // un composant de la page change : nouveau fichier de page, l'ancien haché disparaît
    writeFileSync(join(p.srcDir, 'card.mjs'), '<p class="card">carte revue</p>\n')
    const troisieme = await construire(p)
    const pageFile3 = basename(fichierDePage(p))
    assert.notEqual(pageFile3, pageFile1, 'nouveau contenu ⇒ nouvelle empreinte')
    assert.equal(existsSync(join(p.outDir, pageFile1)), false, 'l\'ancien fichier de page est purgé')
    assert.equal(fiche(readFileSync(fragment(troisieme.report, '/'), 'utf-8')).file, pageFile3)
  })

  it('moins de 2 composants : aucun fichier de page, préchargement seul', async () => {
    const p = fixture('startup-bundle-solo', renderBundle())
    const { report } = await construire(p)
    const texte = readFileSync(fragment(report, '/solo'), 'utf-8')
    assert.equal(liens(texte).length, 1, 'le seul composant est simplement préchargé')
    assert.match(liens(texte)[0], /^\/out\/solo-[a-f0-9]{8}\.js$/)
    assert.equal(texte.includes('__mjs_page'), false, 'aucune fiche de fichier de page')
    assert.deepEqual(readdirSync(p.outDir).filter(f => /^mjs_page-solo-/.test(f)), [])
  })

  it('développement : liens seuls, aucun fichier de page, une ligne au journal', async () => {
    const p = fixture('startup-bundle-dev', renderBundle())
    const { report, journal } = await construire(p, 'dev')
    const texte = readFileSync(fragment(report, '/'), 'utf-8')
    assert.equal(liens(texte).length, 5, `5 liens attendus, vus : ${liens(texte).join(' ')}`)
    assert.equal(texte.includes('__mjs_page'), false, 'aucune fiche de fichier de page en développement')
    assert.deepEqual(readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f)), [])
    assert.ok(journal.some(l => /bundle|fichier de page/i.test(l)), `une ligne d'information attendue, journal : ${journal.join(' | ')}`)
  })

  it("csp: true accepté (la fiche est de la donnée, jamais du code)", async () => {
    const p = fixture('startup-bundle-csp', renderBundle(), { csp: true, css: 'split' })
    const { report } = await construire(p)
    const texte = readFileSync(fragment(report, '/'), 'utf-8')
    assert.match(texte, /<script type="application\/json" id="__mjs_page">/)
    assert.ok(existsSync(fichierDePage(p)))
  })

  it("js: 'bundle' avec startup: 'bundle' : configuration refusée", () => {
    const p = fixture('startup-bundle-refus', renderBundle(), { js: 'bundle' })
    assert.throws(() => findConfig(p.root), /startup/)
  })

  it('deux constructions de production consécutives : rien de purgé, fichier de page intact, précache à jour', () => {
    const p = fixture('startup-bundle-deux-builds', renderBundle())
    buildCli(p)
    const page1 = readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f)).sort()
    assert.equal(page1.length, 1, `un fichier de page attendu, vus : ${page1.join(' ')}`)
    const sortie = buildCli(p)
    assert.equal(sortie.includes('🧹'), false, `aucun orphelin à retirer au second build :\n${sortie}`)
    assert.deepEqual(readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f)).sort(), page1, 'le fichier de page survit à la construction suivante')
    const precache = JSON.parse(readFileSync(join(p.outDir, 'mjs-precache.json'), 'utf-8'))
    assert.ok(precache.assets.includes(`/out/${page1[0]}`), `le précache doit lister le fichier de page (${page1[0]}), vus : ${precache.assets.join(' ')}`)
  })

  it('le fichier de page porte le nom de l\'URL de la route, jamais celui du fragment', async () => {
    const p = fixtureDeuxRoutes('startup-bundle-slug', { '/': { component: 'mjs-home' }, '/a/index': { component: 'mjs-other' } })
    const { report } = await construire(p)
    const noms = readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f)).map(f => f.replace(/-[a-f0-9]{8}\.js$/, '')).sort()
    assert.deepEqual(noms, ['mjs_page-a-index', 'mjs_page-index'], `fichiers de page : ${noms.join(' ')}`)
    const accueil = fiche(readFileSync(fragment(report, '/'), 'utf-8'))
    const autre   = fiche(readFileSync(fragment(report, '/a/index'), 'utf-8'))
    assert.deepEqual(accueil.names, ['badge', 'card', 'home'])
    assert.deepEqual(autre.names, ['extra', 'other', 'zebre'])
    assert.match(accueil.file, /^mjs_page-index-[a-f0-9]{8}\.js$/)
    assert.match(autre.file, /^mjs_page-a-index-[a-f0-9]{8}\.js$/)
  })

  it('deux routes qui donnent le même nom de fichier de page : configuration refusée', () => {
    const p = fixtureDeuxRoutes('startup-bundle-slug-collision', { '/a-b': { component: 'mjs-home' }, '/a/b': { component: 'mjs-other' } })
    assert.throws(() => findConfig(p.root), /a-b/)
  })

  it('deux langues aux ensembles divergents : un seul fichier de page, l\'union assemblée, chaque fiche ses noms', async () => {
    const p = fixtureLocales('startup-bundle-locales')
    const { report } = await construire(p)
    const fichiers = readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f))
    assert.equal(fichiers.length, 1, `un seul fichier de page pour les deux langues, vus : ${fichiers.join(' ')}`)
    const definis = [...readFileSync(join(p.outDir, fichiers[0]), 'utf-8').matchAll(/\._def\("(mjs-[a-z-]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(definis, ['mjs-anglais', 'mjs-badge', 'mjs-card', 'mjs-home'], `l'union des deux langues est assemblée : ${definis.join(', ')}`)
    const fr = fiche(readFileSync(report.generated.find(g => g.file.includes('/fr/'))!.file, 'utf-8'))
    const en = fiche(readFileSync(report.generated.find(g => g.file.includes('/en/'))!.file, 'utf-8'))
    assert.equal(fr.file, en.file, 'les deux fragments pointent le même fichier de page')
    assert.deepEqual(fr.names, ['badge', 'card', 'home'], `noms de la fiche française : ${fr.names.join(', ')}`)
    assert.deepEqual(en.names, ['anglais', 'badge', 'card', 'home'], `noms de la fiche anglaise : ${en.names.join(', ')}`)
  })

  it('divergence par un {if} sur la langue : chaque fiche porte l\'ensemble de SA langue, fermé par les dépendances statiques', async () => {
    const p = fixtureLocalesIf('startup-bundle-locales-if')
    const { report } = await construire(p)
    const fragFr = report.generated.find(g => g.file.includes('/fr/'))!.file
    const fragEn = report.generated.find(g => g.file.includes('/en/'))!.file
    // ce que chaque langue rend diffère bien
    assert.match(readFileSync(fragFr, 'utf-8'), /<mjs-francais/, 'la passe française rend la branche française')
    assert.equal(/<mjs-anglais/.test(readFileSync(fragFr, 'utf-8')), false, 'la branche anglaise n\'est pas rendue en français')
    assert.match(readFileSync(fragEn, 'utf-8'), /<mjs-anglais/, 'la passe anglaise rend la branche anglaise')
    // les deux enfants sont des dépendances STATIQUES du gabarit : la fermeture les ramène des deux
    // côtés — un composant déclaré dans une branche `{if}` sur la langue est déclaré dans les deux
    const attendu = ['anglais', 'card', 'francais', 'home']
    assert.deepEqual(fiche(readFileSync(fragFr, 'utf-8')).names, attendu, 'fiche française')
    assert.deepEqual(fiche(readFileSync(fragEn, 'utf-8')).names, attendu, 'fiche anglaise')
    const fichiers = readdirSync(p.outDir).filter(f => /^mjs_page-/.test(f))
    assert.equal(fichiers.length, 1, `un seul fichier de page pour les deux langues, vus : ${fichiers.join(' ')}`)
    const definis = [...readFileSync(join(p.outDir, fichiers[0]), 'utf-8').matchAll(/\._def\("(mjs-[a-z-]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(definis, ['mjs-anglais', 'mjs-card', 'mjs-francais', 'mjs-home'], `assemblés : ${definis.join(', ')}`)
  })

  it('une balise citée dans la feuille de style du composant n\'entre ni dans la fiche ni dans le fichier de page', async () => {
    const p = fixtureStyleCite('startup-bundle-style-cite')
    const { report } = await construire(p)
    const texte = readFileSync(fragment(report, '/'), 'utf-8')
    assert.match(texte, /<mjs-faux><\/mjs-faux>/, 'la citation est bien dans le fragment, dans le <style>')
    assert.equal(report.generated[0].tags.includes('mjs-faux'), false, `balises relevées : ${report.generated[0].tags.join(', ')}`)
    assert.deepEqual(fiche(texte).names, ['badge', 'card', 'home'], 'la fiche ne déclare que ce que la page affiche')
    const definis = [...readFileSync(fichierDePage(p), 'utf-8').matchAll(/\._def\("(mjs-[a-z-]+)"/g)].map(m => m[1]).sort()
    assert.deepEqual(definis, ['mjs-badge', 'mjs-card', 'mjs-home'], `assemblés : ${definis.join(', ')}`)
  })
})
