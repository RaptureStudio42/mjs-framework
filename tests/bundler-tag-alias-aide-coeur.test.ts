// alias de balise — la garde d'enregistrement vit dans le CŒUR (`µ._al`), plus recopiée dans
// chaque composant. Chaque fichier compilé portait la ligne entière (test d'existence, critère du
// manifeste, sous-classe anonyme) : 189 octets en moyenne, le même test partout. Sur le site de
// doc — 657 composants porteurs d'un alias court — la seule garde du manifeste pesait 51 756
// octets bruts (27 806 gzip) pour cinq clés disputées que personne n'écrit. L'aide du cœur dit la
// même chose une fois pour toutes ; le composant ne garde que ses trois arguments.
//
// Ce que ce fichier prouve : la FORME émise (développement et production), le comportement au
// montage (happy-dom sur un fichier unique, Chromium réel en production avec le symbole ASCII) et
// le rendu serveur d'un composant écrit par son alias.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, dirname, extname, normalize } from 'node:path'
import { Window } from 'happy-dom'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { renderToString } from '../src/server/renderToString.js'

type JsMode = 'split' | 'bundle'

interface Projet { root: string; srcDir: string; outDir: string }

const ENFANT = ['<script>', "$name = 'defaut'", '</script>', '<p>{$name}</p>', ''].join('\n')

// même composant écrit au symbole ASCII (`sigil: 'mjs'`) : `mjs.effect ->` ≡ `µeffect ->`. Le code
// compilé, lui, nomme TOUJOURS le cœur `µ` — c'est ce que l'appel à l'aide doit respecter.
const ENFANT_ASCII = ['<script>', "$name = 'defaut'", '$vu = 0', 'mjs.effect ->', '  $vu = $name.length', '</script>', '<p>{$name}|{$vu}</p>', ''].join('\n')

const PARENT = '<div><mjs-carte name="Ana"></mjs-carte></div>\n'

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

async function construire(p: Projet, js: JsMode, env: 'dev' | 'prod', extra: Record<string, unknown> = {}): Promise<string[]> {
  const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), urlPrefix: '/out', env, js, ...extra })
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return stats.warnings ?? []
}

function lireComposant(p: Projet, nom: string): string {
  const fichiers = readdirSync(p.outDir)
  const f        = fichiers.find(f => new RegExp(`^${nom}-[a-f0-9]{8}\\.js$`).test(f))
  assert.ok(f, `${nom}-*.js attendu dans la sortie (trouvés : ${fichiers.join(', ')})`)
  return readFileSync(join(p.outDir, f!), 'utf-8')
}

// fichier unique évalué dans une fenêtre happy-dom : `import.meta.url` et l'export final sont les
// deux seules formes de module que l'évaluation ne sait pas prendre (patron déjà utilisé par
// tests/bundler-mangle-cles-execution.test.ts)
function fenetreAvecBundle(p: Projet): any {
  const code       = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
  const fenetre: any = new Window({ url: 'http://localhost/' })
  fenetre.eval(code.replace(/import\.meta\.url/g, "'http://localhost/out/bundle.js'").replace(/export\s*\{[^}]*\}\s*;?/g, ''))
  return fenetre
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
    // bac à sable du navigateur coupé : là où le noyau le refuse, `launch()` lève, le `catch`
    // rend `null` et TOUS les montages seraient sautés — verts sans avoir rien monté
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

describe('alias de balise — forme émise (aide du cœur µ._al)', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it("développement — l'alias passe par l'aide du cœur, la garde du manifeste n'est plus recopiée", async function () {
    const p = projet('alias-forme-dev', { 'doc/doc-carte.mjs': ENFANT, 'doc/doc-liste.mjs': ENFANT, 'parent.mjs': PARENT })
    await construire(p, 'split', 'dev')
    const code = lireComposant(p, 'doc-carte')
    const ligne = code.split('\n').filter(l => l.includes('mjs-carte')).join(' / ')
    assert.match(ligne, /µ\._al\("mjs-carte", "carte", [A-Za-z_$][\w$]*\);/, `la ligne d'alias doit être un appel à l'aide du cœur — reçu : ${ligne || '(aucune ligne)'}`)
    assert.equal(code.includes('customElements.define("mjs-carte"'), false, "le composant ne doit plus enregistrer l'alias lui-même")
    assert.equal(code.includes('µ.paths, "carte"'), false, 'le critère du manifeste ne doit plus être recopié dans le composant')
    // la balise du composant lui-même, elle, reste enregistrée par le composant — par l'aide de
    // définition du cœur (`µ._def`, runtime mjs_dom.ts), pas par l'aide d'alias
    assert.equal(code.includes('µ._def("mjs-doc-carte"'), true, "la balise complète du composant reste enregistrée par le composant")
  })

  it("production — un appel par composant porteur d'alias, aucun enregistrement d'alias recopié", async function () {
    const p = projet('alias-forme-prod', { 'doc/doc-carte.mjs': ENFANT, 'doc/doc-liste.mjs': ENFANT, 'parent.mjs': PARENT })
    await construire(p, 'bundle', 'prod')
    const code = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    assert.equal((code.match(/\._al\(/g) ?? []).length, 2, "un appel à l'aide du cœur par composant porteur d'alias (carte, liste)")
    assert.equal(/(?:customElements\.define|\._def)\("mjs-(carte|liste)"/.test(code), false, "aucun alias ne doit être enregistré depuis le code d'un composant")
    assert.equal(/hasOwnProperty\.call\([A-Za-z_$][\w$]*\.paths, ?"carte"\)/.test(code), false, 'le critère du manifeste ne doit plus être recopié par composant')
  })
})

describe('alias de balise — montage happy-dom (fichier unique de production)', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it("alias non disputé : la balise courte est définie et le composant rend sa prop", async function () {
    const p = projet('alias-montage-simple', { 'doc/doc-carte.mjs': ENFANT, 'parent.mjs': PARENT })
    await construire(p, 'bundle', 'prod')
    const fenetre = fenetreAvecBundle(p)
    fenetre.document.body.insertAdjacentHTML('beforeend', '<mjs-carte name="Ana"></mjs-carte>')
    await new Promise(resolve => setTimeout(resolve, 250))
    const el: any = fenetre.document.body.querySelector('mjs-carte')
    assert.equal(!!fenetre.customElements.get('mjs-carte'), true, "l'alias non disputé doit être défini par l'aide du cœur")
    assert.equal(el && el._shadow ? el._shadow.textContent : '(sans ombre)', 'Ana', "le composant monté par son alias doit rendre sa prop")
  })

  it("alias disputé par deux composants : la balise courte reste inerte", async function () {
    const p = projet('alias-montage-dispute', { 'doc/doc-carte.mjs': ENFANT, 'tuto/tuto-carte.mjs': ENFANT, 'parent.mjs': PARENT })
    const avertissements = await construire(p, 'bundle', 'prod')
    assert.equal(avertissements.filter(w => w.includes('alias ambigu')).length, 1, `le build doit signaler l'alias disputé — avertissements : ${avertissements.join(' / ') || 'aucun'}`)
    const fenetre = fenetreAvecBundle(p)
    fenetre.document.body.insertAdjacentHTML('beforeend', '<mjs-carte name="Ana"></mjs-carte>')
    await new Promise(resolve => setTimeout(resolve, 250))
    const el: any = fenetre.document.body.querySelector('mjs-carte')
    assert.equal(!!fenetre.customElements.get('mjs-carte'), false, "l'alias disputé ne doit jamais être défini")
    assert.equal(el && el._shadow ? el._shadow.textContent : '(sans ombre)', '(sans ombre)', "la balise disputée ne doit jamais être montée")
  })
})

describe('alias de balise — Chromium de production, symbole ASCII (sigil: mjs)', function () {
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

  for(const js of ['bundle', 'split'] as JsMode[]) {
    it(`js: '${js}' — l'alias reste défini et le composant rend ses deux valeurs`, async function () {
      const p = projet(`alias-sigil-${js}`, { 'doc/doc-carte.mjs': ENFANT_ASCII, 'parent.mjs': PARENT })
      await construire(p, js, 'prod', { sigil: 'mjs' })
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
        assert.equal(releve.rendu, 'Ana|3', `le composant doit rendre sa prop et son effet — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
        assert.deepEqual(erreurs, [], 'aucune erreur de page')
      }
      finally {
        await page.close()
        await new Promise(resolve => server.close(() => resolve(null)))
      }
    })
  }
})

describe('alias de balise — rendu serveur', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it("un enfant écrit par son alias est rendu par renderToString", async function () {
    const p = projet('alias-ssr', { 'doc/doc-carte.mjs': ENFANT, 'parent.mjs': PARENT })
    const res = await renderToString({ sourceDir: p.srcDir, tag: 'mjs-parent' })
    assert.match(res.html, /<mjs-carte name="Ana"[^>]*><template shadowrootmode="open">/, `l'enfant écrit par son alias doit être rendu — HTML : ${res.html}`)
    assert.match(res.html, /<p>Ana<\/p>/, `la prop de l'enfant doit être rendue — HTML : ${res.html}`)
  })
})
