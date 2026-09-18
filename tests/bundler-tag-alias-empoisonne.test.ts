// production — alias de balise `mjs-<nom court>` que DEUX composants se disputent. Le bundler
// donne à chaque composant un alias court (`doc/doc-carte.mjs` → `<mjs-carte>`) ; quand deux
// fichiers publient le même, la clé est EMPOISONNÉE : elle quitte le manifeste, aucun des deux
// ne la publie (chacun reste joignable par sa balise complète).
//
// L'alias, lui, restait DÉFINI par le premier module chargé : `<mjs-carte>` écrite dans un
// gabarit n'était signalée nulle part au build, et absente du manifeste elle passait au runtime
// pour un composant TIERS — chaque clé posée dessus devenait une propriété propre, qui masque en
// production la méthode du prototype portant le même nom court (« this.a is not a function »,
// composant vide). Deux gardes : la définition de l'alias est conditionnée au manifeste, et le
// build avertit quand un gabarit écrit la balise courte ambiguë.
//
// Les clés d'exécution sont relevées dans le cache d'une PREMIÈRE construction puis injectées en
// base64 dans la source : elles n'apparaissent jamais en clair dans le code compilé. Montage dans
// un Chromium réel ; Chromium absent : les montages sont sautés, les assertions de construction
// restent.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

type JsMode = 'split' | 'bundle'
type Cache  = Record<string, string | false>

interface Projet { root: string; srcDir: string; outDir: string }
interface Releve { rendus: Record<string, string>; polluees: string[]; erreurs: string[]; definies: Record<string, boolean> }

// valeur témoin portée par chaque clé d'exécution : ce qu'on cherche ensuite sur l'élément
const TEMOIN = 'polluant'

const ENFANT = ['<script>', "$name = 'defaut'", '</script>', '<p>{$name}</p>', ''].join('\n')

function projet(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(join(srcDir, 'doc'), { recursive: true })
  mkdirSync(join(srcDir, 'tuto'), { recursive: true })
  return { root, srcDir, outDir }
}

async function construire(p: Projet, js: JsMode): Promise<string[]> {
  const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), urlPrefix: '/out', env: 'prod', js })
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return stats.warnings ?? []
}

function nomsCourts(p: Projet): string[] {
  const cache: Cache = JSON.parse(readFileSync(join(p.outDir, '.mangle-cache.json'), 'utf-8'))
  return [...new Set(Object.values(cache).filter((c): c is string => typeof c === 'string'))].sort()
}

// clés du manifeste émis (µ.paths), quel que soit le mode de découpage : découpage éclaté =
// `const µPaths = {…}` en clair ; fichier unique minifié = `…paths={…}`, clés NUES quand ce sont
// des identifiants valides (`parent:Je`)
function clesManifeste(p: Projet): string[] {
  const code  = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
  const bloc  = code.match(/µPaths\s*=\s*\{([^}]*)\}/) ?? code.match(/\bpaths\s*=\s*\{([^}]*)\}/)
  const cles  = [...(bloc?.[1] ?? '').matchAll(/(?:"([^"]+)"|([A-Za-z_$][A-Za-z0-9_$]*))\s*:/g)].map(m => m[1] ?? m[2])
  return cles.sort()
}

// parent qui étale une donnée d'exécution sur chaque balise demandée, DANS UN {for} : la ligne est
// peuplée avant son insertion dans le document, donc avant toute mise à niveau
function ecrire(p: Projet, cles: string[], tags: string[], deuxComposants: boolean): void {
  writeFileSync(join(p.srcDir, 'doc', 'doc-carte.mjs'), ENFANT)
  if(deuxComposants) writeFileSync(join(p.srcDir, 'tuto', 'tuto-carte.mjs'), ENFANT)
  const donnees: Record<string, string> = { name: 'Ana' }
  for(const c of cles) donnees[c] = TEMOIN
  const b64    = Buffer.from(JSON.stringify(donnees), 'utf-8').toString('base64')
  const lignes = tags.map(t => `<${t} {...r}></${t}>`).join('')
  writeFileSync(join(p.srcDir, 'parent.mjs'), `<script>\n$rows = [JSON.parse(atob('${b64}'))]\n</script>\n{for r in $rows}${lignes}{end}\n`)
}

// construit, relève les noms courts, réécrit les sources avec une clé par nom, reconstruit —
// jusqu'à ce que la construction n'attribue plus de nom court inconnu des sources
async function construireAvecClesCourtes(p: Projet, js: JsMode, tags: string[], deuxComposants: boolean): Promise<{ cles: string[]; avertissements: string[] }> {
  let cles: string[] = []
  let avertissements: string[] = []
  for(let tour = 0; tour < 3; tour++) {
    ecrire(p, cles, tags, deuxComposants)
    avertissements = await construire(p, js)
    const manquants = nomsCourts(p).filter(c => !cles.includes(c))
    if(cles.length > 0 && manquants.length === 0) return { cles, avertissements }
    cles = [...cles, ...manquants].sort()
  }
  ecrire(p, cles, tags, deuxComposants)
  avertissements = await construire(p, js)
  return { cles, avertissements }
}

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

// textes rendus, propriétés propres qui portent encore le témoin, et balises réellement définies —
// des chaînes et des booléens seulement, jamais un nœud
function releverPage([temoin, balises]: [string, string[]]): { rendus: Record<string, string>; polluees: string[]; definies: Record<string, boolean> } {
  const rendus: Record<string, string>     = {}
  const polluees: string[]                 = []
  const definies: Record<string, boolean>  = {}
  for(const b of balises) definies[b] = !!customElements.get(b)
  const parcourir = (racine: any) => {
    for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
      if(!el.tagName.startsWith('MJS-')) continue
      const tag   = el.tagName.toLowerCase()
      rendus[tag] = el._shadow ? Array.from(el._shadow.querySelectorAll('p, b')).map((n: any) => n.textContent).join('|') : '(sans ombre)'
      for(const nom of Object.getOwnPropertyNames(el)) {
        const desc = Object.getOwnPropertyDescriptor(el, nom)
        if(desc && desc.value === temoin) polluees.push(`${tag}.${nom}`)
      }
      if(el._shadow) parcourir(el._shadow)
    }
  }
  parcourir(document)
  return { rendus, polluees: polluees.sort(), definies }
}

async function monter(browser: any, p: Projet, balises: string[]): Promise<Releve> {
  const { url, server }   = await servir(p, '<mjs-parent></mjs-parent>')
  const page              = await browser.newPage()
  const erreurs: string[] = []
  page.on('pageerror', (e: Error) => erreurs.push(e.message))
  page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
  try {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(700)
    const { rendus, polluees, definies } = await page.evaluate(releverPage, [TEMOIN, balises] as [string, string[]])
    return { rendus, polluees, erreurs, definies }
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
    // bac à sable du navigateur coupé : là où le noyau le refuse, `launch()` lève, le `catch` rend
    // `null` et TOUS les montages seraient sautés — verts sans avoir rien monté
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

describe('production — alias de balise disputé par deux composants', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(30000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de construction gardées. Activer : `npx playwright install chromium`')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  for(const js of ['bundle', 'split'] as JsMode[]) {
    it(`js: '${js}' — la balise courte ambiguë reste inerte, la balise complète rend sa prop`, async function () {
      const p = projet(`alias-ambigu-${js}`)
      // le gabarit écrit LES DEUX : la balise courte disputée et la balise complète du premier
      // composant (c'est elle qui, en découpage éclaté, fait charger le module — et donc jouer la
      // ligne d'enregistrement de l'alias)
      const { cles, avertissements } = await construireAvecClesCourtes(p, js, ['mjs-carte', 'mjs-doc-carte'], true)
      assert.ok(cles.length > 0, 'la construction doit avoir donné des noms courts à des propriétés internes')
      // la clé disputée ne peut pas être publiée : chaque composant garde sa balise complète
      assert.deepEqual(clesManifeste(p), ['doc-carte', 'parent', 'tuto-carte'], 'la clé disputée ne doit pas entrer dans le manifeste')
      const ambigus = avertissements.filter(w => w.includes('alias ambigu'))
      assert.equal(ambigus.length, 1, `le build doit signaler la balise courte ambiguë — avertissements : ${avertissements.join(' / ') || 'aucun'}`)
      assert.ok(ambigus[0].includes('doc-carte') && ambigus[0].includes('tuto-carte'), `l'avertissement doit nommer les deux composants qui se disputent l'alias : ${ambigus[0]}`)
      if(!browser) return
      const releve = await monter(browser, p, ['mjs-carte', 'mjs-doc-carte'])
      // balise jamais définie : elle reste inerte, exactement comme une faute de frappe
      assert.equal(releve.definies['mjs-carte'], false, `la balise courte ambiguë ne doit pas être définie — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.definies['mjs-doc-carte'], true, `la balise complète doit rester définie — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.rendus['mjs-doc-carte'], 'Ana', `prop déclarée perdue sur la balise complète — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(releve.polluees.filter(n => n.startsWith('mjs-doc-carte.')), [], 'aucune clé d\'exécution ne doit rester sur le composant')
      // la balise inerte n'est jamais mise à niveau : rien ne la monte, rien ne lit ce qui a été
      // posé dessus — les clés étalées y restent en propriétés propres, comme sur n'importe quel
      // élément tiers absent du manifeste (cas documenté, docs/15-elements-speciaux.md)
      assert.equal(releve.rendus['mjs-carte'], '(sans ombre)', 'la balise courte ambiguë ne doit jamais être montée')
      // seul message toléré : le refus de l'autoloader (balise absente du manifeste, découpage éclaté)
      const autres = releve.erreurs.filter(e => !e.includes('[Autoloader]'))
      assert.deepEqual(autres, [], 'aucune erreur de page hors le refus attendu de l\'autoloader')
    })
  }

  for(const js of ['bundle', 'split'] as JsMode[]) {
    it(`js: '${js}' — sans dispute, l'alias court reste défini et rend la prop déclarée`, async function () {
      const p = projet(`alias-sans-dispute-${js}`)
      const { cles, avertissements } = await construireAvecClesCourtes(p, js, ['mjs-carte'], false)
      assert.ok(cles.length > 0, 'la construction doit avoir donné des noms courts à des propriétés internes')
      assert.deepEqual(clesManifeste(p), ['carte', 'doc-carte', 'parent'], 'l\'alias court non disputé doit rester publié')
      assert.deepEqual(avertissements.filter(w => w.includes('alias ambigu')), [], 'aucun alias n\'est disputé ici')
      if(!browser) return
      const releve = await monter(browser, p, ['mjs-carte'])
      assert.equal(releve.definies['mjs-carte'], true, 'l\'alias court non disputé doit être défini')
      assert.equal(releve.rendus['mjs-carte'], 'Ana', `prop déclarée perdue — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(releve.polluees, [], 'aucune clé d\'exécution ne doit rester sur l\'élément')
      assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
    })
  }
})
