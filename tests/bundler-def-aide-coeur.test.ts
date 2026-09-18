// définition d'un composant — la garde d'enregistrement vit dans le CŒUR (`µ._def`), plus recopiée
// dans chaque composant. Chaque fichier compilé portait le test d'existence, l'enregistrement ET le
// message français de collision écrit DEUX fois (branche `µ.warn`, branche `console.warn`) : le
// message seul pèse 106 caractères, payés deux fois par composant. L'aide du cœur le dit une fois
// pour toutes ; le composant ne garde que sa balise et sa classe.
//
// Ce que ce fichier prouve : la FORME émise (développement et production), le COMPORTEMENT à la
// seconde définition du même tag (un seul avertissement, au texte inchangé — caractérisé sur le
// cœur réel), le montage en production dans un Chromium réel (fichiers séparés ET fichier unique),
// le mode léger, et que le rendu serveur comme le harnais de test définissent toujours.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { Window } from 'happy-dom'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { renderToString } from '../src/server/renderToString.js'
import { createHarness } from '../src/testing/index.js'

type JsMode = 'split' | 'bundle'

interface Projet { root: string; srcDir: string; outDir: string }

// texte EXACT de l'avertissement de collision, relevé sur l'arbre d'avant l'aide du cœur : deux
// évaluations du même module compilé, cœur réel, `µ.warn` interceptée
const COLLISION = '[ModularJS] mjs-hop déjà défini par un autre bundle : cette définition est ignorée'

const HOP  = ['<script>', "$m = 'bonjour'", '</script>', '<p>{$m}</p>', ''].join('\n')
const NICHE = ['<script>', "$m = 'bonjour'", '</script>', '<div><section><b>a {$m} b</b><i>{$m}</i></section></div>', ''].join('\n')

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

function lireComposant(p: Projet, nom: string): string {
  const fichiers = readdirSync(p.outDir)
  const f        = fichiers.find(f => new RegExp(`^${nom}-[a-f0-9]{8}\\.js$`).test(f))
  assert.ok(f, `${nom}-*.js attendu dans la sortie (trouvés : ${fichiers.join(', ')})`)
  return readFileSync(join(p.outDir, f!), 'utf-8')
}

function lireCoeur(p: Projet): string {
  const f = readdirSync(p.outDir).find(f => /^mjs_core-[a-f0-9]{8}\.js$/.test(f))
  assert.ok(f, 'mjs_core-*.js attendu dans la sortie')
  return readFileSync(join(p.outDir, f!), 'utf-8')
}

// module ES d'un composant rendu évaluable par `window.eval` : l'import du cœur retiré (le cœur est
// déjà chargé, `µ` est global), l'export par défaut et `import.meta.url` neutralisés
function nu(code: string): string {
  return code
    .replace(/^\s*import\s*\{[^}]*\}\s*from\s*'[^']*'\s*;\s*$/m, '')
    .replace(/\bexport\s+default\s+/, '')
    .replace(/export\s*\{[^}]*\}\s*;?/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/out/'")
    .replace(/^\/\/# sourceMappingURL=.*$/m, '')
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
    rendu:  el && el._shadow ? (el._shadow.textContent ?? '') : el ? (el.textContent ?? '') : '(absent)',
  }
}

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if(!existsSync(playwright.chromium.executablePath())) return null
    // bac à sable du navigateur coupé : là où le noyau le refuse, `launch()` lève, le `catch`
    // rend `null` et TOUS les montages seraient sautés — verts sans avoir rien monté
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

describe('définition d\'un composant — forme émise (aide du cœur µ._def)', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it("développement — un appel à l'aide du cœur, aucune garde recopiée dans le composant", async function () {
    const p = projet('def-forme-dev', { 'hop.mjs': HOP })
    await construire(p, 'split', 'dev')
    const code = lireComposant(p, 'hop')
    assert.match(code, /µ\._def\("mjs-hop", [A-Za-z_$][\w$]*\);/, `la définition doit passer par l'aide du cœur — sortie : ${code.split('\n').slice(-4).join(' / ')}`)
    assert.equal(code.includes('customElements.define('), false, 'le composant ne doit plus enregistrer sa balise lui-même')
    assert.equal(code.includes('customElements.get("mjs-hop")'), false, "le test d'existence ne doit plus être recopié dans le composant")
    assert.equal(code.includes('déjà défini par un autre bundle'), false, 'le message de collision ne doit plus être recopié dans le composant')
  })

  it("développement — le message de collision vit UNE fois, dans le cœur", async function () {
    const p = projet('def-forme-coeur', { 'hop.mjs': HOP, 'autre.mjs': HOP })
    await construire(p, 'split', 'dev')
    const coeur = lireCoeur(p)
    assert.equal(coeur.split('déjà défini par un autre bundle').length - 1, 1, 'le texte doit être écrit une seule fois dans tout le cœur')
    assert.match(coeur, /µ\._def = function/, "l'aide doit être posée sur µ")
  })

  it('production, fichier unique — un appel par composant, aucun enregistrement recopié', async function () {
    const p = projet('def-forme-prod', { 'hop.mjs': HOP, 'autre.mjs': HOP, 'tiers.mjs': HOP })
    await construire(p, 'bundle', 'prod')
    const code = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    assert.equal((code.match(/\._def\(/g) ?? []).length, 3, "un appel à l'aide du cœur par composant du projet")
    assert.equal(/customElements\.define\("mjs-(hop|autre|tiers)"/.test(code), false, 'aucune balise de composant ne doit être enregistrée depuis son propre code')
    // le message reste écrit une seule fois (dans l'aide), accents échappés par le minifieur
    assert.equal((code.match(/d\\xE9j\\xE0 d\\xE9fini par un autre bundle|déjà défini par un autre bundle/g) ?? []).length, 1, 'le message de collision ne doit apparaître qu\'une fois dans tout le fichier')
  })
})

describe('deux définitions du même tag — un seul avertissement, texte inchangé', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('deux évaluations du module compilé : la balise reste définie, un avertissement au texte relevé', async function () {
    const p = projet('def-collision', { 'hop.mjs': HOP })
    await construire(p, 'split', 'dev')
    const fenetre: any = new Window({ url: 'http://localhost/' })
    fenetre.eval(`${nu(lireCoeur(p))}\nglobalThis.µ = µ;`)
    fenetre.eval('globalThis.__warns = []; µ.warn = function(...a) { globalThis.__warns.push(a.join(" ")) };')
    const code = nu(lireComposant(p, 'hop'))
    fenetre.eval(`(function(){\n${code}\n})();`)
    assert.doesNotThrow(() => fenetre.eval(`(function(){\n${code}\n})();`), 'la 2e définition ne doit jamais lever')
    // relevé en JSON : un tableau rendu par `eval` vient d'un autre royaume, `deepEqual` strict le
    // refuse sur son prototype avant même de comparer son contenu
    assert.deepEqual(JSON.parse(fenetre.eval('JSON.stringify(globalThis.__warns)')), [COLLISION], 'un seul avertissement, au texte relevé avant le changement')
    assert.equal(!!fenetre.customElements.get('mjs-hop'), true, 'la balise doit rester définie par la PREMIÈRE définition')
  })
})

describe('définition par l\'aide du cœur — Chromium de production', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(60000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de construction gardées. Activer : `npx playwright install chromium`')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  for(const js of ['split', 'bundle'] as JsMode[]) {
    it(`js: '${js}' — le composant imbriqué se définit et rend son texte`, async function () {
      const p = projet(`def-montage-${js}`, { 'hote.mjs': NICHE })
      await construire(p, js, 'prod')
      if(!browser) return
      const { url, server }   = await servir(p, '<mjs-hote></mjs-hote>')
      const page              = await browser.newPage()
      const erreurs: string[] = []
      page.on('pageerror', (e: Error) => erreurs.push(e.message))
      page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
      try {
        await page.goto(url, { waitUntil: 'load' })
        await page.waitForTimeout(700)
        const releve = await page.evaluate(releverPage, 'mjs-hote')
        assert.equal(releve.defini, true, `la balise doit être définie — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
        assert.equal(releve.rendu, 'a bonjour bbonjour', `le composant doit rendre son texte — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
        assert.deepEqual(erreurs, [], 'aucune erreur de page')
      }
      finally {
        await page.close()
        await new Promise(resolve => server.close(() => resolve(null)))
      }
    })
  }

  it('mode léger (mjs-light) — le composant rend dans le document, sans ombre', async function () {
    const p = projet('def-montage-light', { 'leger.mjs': HOP })
    await construire(p, 'bundle', 'prod')
    if(!browser) return
    const { url, server }   = await servir(p, '<mjs-leger mjs-light></mjs-leger>')
    const page              = await browser.newPage()
    const erreurs: string[] = []
    page.on('pageerror', (e: Error) => erreurs.push(e.message))
    page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForTimeout(700)
      const releve = await page.evaluate(releverPage, 'mjs-leger')
      assert.equal(releve.defini, true, `la balise doit être définie — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.rendu.includes('bonjour'), true, `le composant léger doit rendre son texte — reçu « ${releve.rendu} », erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(erreurs, [], 'aucune erreur de page')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })
})

describe('l\'aide du cœur sert aussi le rendu serveur et le harnais de test', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('renderToString rend le composant (happy-dom)', async function () {
    const p = projet('def-ssr', { 'hop.mjs': HOP })
    const res = await renderToString({ sourceDir: p.srcDir, tag: 'mjs-hop' })
    assert.match(res.html, /<p>bonjour<\/p>/, `le composant doit être rendu — HTML : ${res.html}`)
  })

  it('le harnais de test monte le composant', async function () {
    const p   = projet('def-harnais', { 'hop.mjs': HOP })
    const app = await createHarness({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js') })
    try {
      const monte = await app.mount('hop')
      assert.equal(monte.text('p'), 'bonjour')
    }
    finally {
      await app.destroy()
    }
  })
})
