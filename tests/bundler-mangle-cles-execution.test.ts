// production — clés qui n'existent QU'À L'EXÉCUTION contre les noms courts des propriétés internes
// `_mjs_*` (esbuild `mangleProps`, cache partagé `<outputDir>/.mangle-cache.json`). Le relevé des
// noms ÉCRITS dans le code (état, props, méthodes) ne peut rien pour deux chemins :
//   • un parent qui étale un objet (`<@enfant {...$data}>`) sur un enfant PAS ENCORE défini : la
//     clé vient d'un JSON reçu, elle n'est nulle part dans le code, et posée SUR l'élément elle
//     masque la méthode du prototype qui porte le même nom court une fois minifiée ;
//   • un marqueur interne lu sur une VALEUR (`_mjs_c`, l'enveloppe des valeurs dérivées) : une
//     donnée qui porte le nom court du marqueur est prise pour une valeur dérivée et gèle.
//
// Les clés d'exécution sont relevées dans le cache d'une PREMIÈRE construction, puis injectées en
// base64 dans la source : elles n'apparaissent ainsi jamais en clair dans le code compilé.
//
// Montage dans un Chromium réel : la page charge `bundle.js` servi en HTTP, avec les modules hachés
// tels qu'écrits sur disque. Chromium absent : les montages sont sautés, les assertions sur le
// cache écrit et sur la construction restent.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { CORE_HELPER_NAMES, DATA_MARKER_NAMES, reserveDataMarkers, reserveMangleNames } from '../src/bundler/minify.js'
import { renderToString } from '../src/server/renderToString.js'

type JsMode = 'split' | 'bundle'
type Cache  = Record<string, string | false>

interface Projet { root: string; srcDir: string; outDir: string }
interface Options { retards?: Record<string, number>; clic?: { balise: string; sel: string }; etats?: string[] }
interface Releve { rendus: Record<string, string>; apres: Record<string, string>; erreurs: string[]; polluees: string[]; etats: Record<string, Record<string, string>> }

// valeur témoin portée par chaque clé d'exécution : ce qu'on cherche ensuite sur l'élément
const TEMOIN = 'polluant'

/** Tous les `.ts` d'un dossier de source, sous-dossiers compris. */
function sourcesTs(dir: string): string[] {
  const trouves: string[] = []
  for(const entree of readdirSync(dir, { withFileTypes: true })) {
    if(entree.isDirectory()) trouves.push(...sourcesTs(join(dir, entree.name)))
    else if(entree.name.endsWith('.ts')) trouves.push(join(dir, entree.name))
  }
  return trouves
}

function projet(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir }
}

function nouveauBundler(p: Projet, js: JsMode): Bundler {
  return new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), urlPrefix: '/out', env: 'prod', js })
}

async function construire(p: Projet, js: JsMode = 'split'): Promise<void> {
  const bundler = nouveauBundler(p, js)
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
}

function lireCache(p: Projet): Cache {
  return JSON.parse(readFileSync(join(p.outDir, '.mangle-cache.json'), 'utf-8'))
}

// noms courts qu'une construction a donnés à une propriété interne
function nomsCourts(cache: Cache): string[] {
  return [...new Set(Object.values(cache).filter((c): c is string => typeof c === 'string'))].sort()
}

// une clé JSON par nom court, en base64 : le code compilé ne porte qu'un littéral opaque, les clés
// n'existent que dans la donnée décodée à l'exécution
function encoder(donnees: Record<string, unknown>): string {
  return Buffer.from(JSON.stringify(donnees), 'utf-8').toString('base64')
}

// construit, relève les noms courts, réécrit les sources avec une clé par nom, reconstruit — jusqu'à
// ce que la construction n'attribue plus de nom court inconnu des sources
async function construireAvecClesCourtes(p: Projet, js: JsMode, ecrire: (cles: string[]) => void): Promise<string[]> {
  let cles: string[] = []
  for(let tour = 0; tour < 3; tour++) {
    ecrire(cles)
    await construire(p, js)
    const manquants = nomsCourts(lireCache(p)).filter(c => !cles.includes(c))
    if(cles.length > 0 && manquants.length === 0) return cles
    cles = [...cles, ...manquants].sort()
  }
  ecrire(cles)
  await construire(p, js)
  return cles
}

// parent qui étale sur un enfant une donnée d'exécution : la prop DÉCLARÉE de l'enfant (`name`) et
// une clé par nom court de propriété interne
function ecrireEtalement(p: Projet, cles: string[]): void {
  const donnees: Record<string, string> = { name: 'Ana' }
  for(const c of cles) donnees[c] = TEMOIN
  writeFileSync(join(p.srcDir, 'parent.mjs'), `<script>\n$data = JSON.parse(atob('${encoder(donnees)}'))\n</script>\n<@enfant {...$data}>\n`)
  writeFileSync(join(p.srcDir, 'enfant.mjs'), '<p>{$name}</p>\n')
}

// même étalement, mais DANS UN {for} : les lignes sont peuplées AVANT leur insertion dans le
// document, donc avant la mise à niveau de l'enfant — même quand sa balise est déjà définie
function ecrireEtalementFor(p: Projet, cles: string[]): void {
  const donnees: Record<string, string> = { name: 'Ana' }
  for(const c of cles) donnees[c] = TEMOIN
  writeFileSync(join(p.srcDir, 'parent.mjs'), `<script>\n$rows = [JSON.parse(atob('${encoder(donnees)}'))]\n</script>\n{for r in $rows}<@enfant {...r}>{end}\n`)
  writeFileSync(join(p.srcDir, 'enfant.mjs'), '<p>{$name}</p>\n')
}

// donnée d'exécution qui porte les noms courts des marqueurs internes, remplacée au clic
function ecrireMarqueur(p: Projet, cles: string[]): void {
  const donnees: Record<string, unknown> = { x: 'un' }
  for(const c of cles) donnees[c] = 1
  writeFileSync(join(p.srcDir, 'donnee.mjs'), [
    '<script>',
    `$d = JSON.parse(atob('${encoder(donnees)}'))`,
    '@remplacer = ->',
    '  $d = JSON.parse(\'{"x":"deux"}\')',
    '</script>',
    '<p>{$d.x}</p>',
    '<button class="maj" @click={@remplacer()}>maj</button>',
    '',
  ].join('\n'))
}

// parent qui pose quatre props sur un enfant qui n'en déclare aucune : trois noms d'attributs
// natifs de l'élément (`id`, `title`, `dir`) et un nom libre
function ecrireProps(p: Projet): void {
  writeFileSync(join(p.srcDir, 'parent.mjs'), [
    '<script>',
    "$monId = 'i7'",
    "$t = 'titre'",
    "$d = 'rtl'",
    "$z = 'zz'",
    '</script>',
    '<@enfant id={$monId} title={$t} dir={$d} data-x={$z}>',
    '',
  ].join('\n'))
  writeFileSync(join(p.srcDir, 'enfant.mjs'), '<p>enfant</p>\n')
}

// deux chronologies autour d'un enfant servi en retard, sur la même prop `nom` :
//   a — propriété propre posée par la page, PUIS écriture du parent (la dernière doit gagner) ;
//   b — écriture du parent au premier rendu, PUIS propriété propre (la dernière doit gagner).
function ecrireChronologie(p: Projet): void {
  const enfant = ['<script>', "$nom = 'defaut'", '</script>', '<p>{$nom}</p>', ''].join('\n')
  writeFileSync(join(p.srcDir, 'enfant-a.mjs'), enfant)
  writeFileSync(join(p.srcDir, 'enfant-b.mjs'), enfant)
  writeFileSync(join(p.srcDir, 'parent-a.mjs'), ['<script>', "$n = 'un'", '@changer = ->', "  $n = 'trois'", '</script>', '<@enfant-a nom={$n}>', ''].join('\n'))
  writeFileSync(join(p.srcDir, 'parent-b.mjs'), ['<script>', "$n = 'un'", '</script>', '<@enfant-b nom={$n}>', ''].join('\n'))
}

// enfant servi en retard dont la page FIGE une propriété propre (non configurable) avant que le
// parent réécrive sa prop : rien ne doit tenter de la retirer — l'exception partirait du rendu du
// PARENT, avalée par la frontière d'erreur (parent vidé, enfant jamais monté, zéro message)
function ecrireFige(p: Projet): void {
  writeFileSync(join(p.srcDir, 'enfant-c.mjs'), ['<script>', "$nom = 'defaut'", '</script>', '<p>{$nom}</p>', ''].join('\n'))
  writeFileSync(join(p.srcDir, 'parent-c.mjs'), ['<script>', "$n = 'un'", '@changer = ->', "  $n = 'trois'", '</script>', '<b>parent</b>', '<@enfant-c nom={$n}>', ''].join('\n'))
}

// hôte qui pose des props sur un élément TIERS (`<my-widget>`, balise à tiret étrangère au
// projet, définie par une autre bibliothèque) : prop dynamique, étalement, {for} de deux lignes,
// et une mise à jour au clic
function ecrireTiers(p: Projet): void {
  writeFileSync(join(p.srcDir, 'hote.mjs'), [
    '<script>',
    "$x = 'coucou'",
    "$o = { a: 'un', b: 'deux' }",
    "$lignes = ['une', 'deux']",
    '@changer = ->',
    "  $x = 'salut'",
    '</script>',
    '<my-widget class="direct" value={$x}></my-widget>',
    '<my-widget class="etale" {...$o}></my-widget>',
    '{for l in $lignes}<my-widget class="ligne" value={l}></my-widget>{end}',
    '<button class="maj" @click={@changer()}>maj</button>',
    '',
  ].join('\n'))
}

// hôte qui pose une prop sur deux balises définies PLUS TARD par la page : une balise à tiret
// quelconque et une balise `mjs-` littérale absente du manifeste (cas documenté d'un web
// component tiers, docs/15-elements-speciaux.md)
function ecrireTiersTardif(p: Projet): void {
  writeFileSync(join(p.srcDir, 'hote.mjs'), [
    '<script>',
    "$x = 'coucou'",
    '</script>',
    '<my-tardif class="quelconque" value={$x}></my-tardif>',
    '<mjs-tiers class="prefixe" value={$x}></mjs-tiers>',
    '',
  ].join('\n'))
}

// hôte qui pose une prop sur un élément TIERS dont la page fige ensuite la propriété en LECTURE
// SEULE (`writable: false`) : l'écriture directe lève alors en mode strict, et l'exception part du
// rendu de l'HÔTE — frontière d'erreur, hôte vidé, rien de dit
function ecrireTiersFige(p: Projet): void {
  writeFileSync(join(p.srcDir, 'hote.mjs'), [
    '<script>',
    "$x = 'coucou'",
    '@changer = ->',
    "  $x = $x + '!'",
    '</script>',
    '<b>hote {$x}</b>',
    '<my-widget class="cible" value={$x}></my-widget>',
    '<button class="maj" @click={@changer()}>maj</button>',
    '',
  ].join('\n'))
}

// élément tiers défini AVANT le rendu de l'hôte : chaque prop reçue passe par un accesseur du
// prototype et s'affiche en texte (`a=un,b=deux`), rien d'autre. Les lignes d'un `{for}` sont
// peuplées AVANT leur insertion dans le document, donc avant la mise à niveau de l'élément : la
// prop y arrive en propriété PROPRE, qui masque l'accesseur — d'où la reprise en
// `connectedCallback`, le motif standard des bibliothèques de composants
const PAGE_WIDGET = [
  '<script>',
  'class W extends HTMLElement {',
  '  connectedCallback() {',
  "    ['value', 'a', 'b'].forEach(function (k) {",
  '      if(!Object.prototype.hasOwnProperty.call(this, k)) return;',
  '      var v = this[k];',
  '      delete this[k];',
  '      this[k] = v;',
  '    }, this);',
  '  }',
  '  _poser(k, v) {',
  '    this._recu = this._recu || {};',
  '    this._recu[k] = v;',
  '    var r = this._recu;',
  "    this.textContent = Object.keys(r).sort().map(function (n) { return n +'='+ r[n] }).join(',');",
  '  }',
  "  set value(v) { this._poser('value', v) }",
  "  set a(v) { this._poser('a', v) }",
  "  set b(v) { this._poser('b', v) }",
  '}',
  "customElements.define('my-widget', W);",
  '</script>',
].join('\n')

// éléments tiers définis 600 ms APRÈS le rendu de l'hôte : leur mise à niveau lit la propriété
// propre que l'hôte a posée avant, comme le font les bibliothèques de composants
const PAGE_TIERS_TARDIF = [
  '<script>',
  'setTimeout(function () {',
  '  customElements.define(\'my-tardif\', class extends HTMLElement {',
  "    connectedCallback() { this.textContent = 'reçu '+ this.value }",
  '  });',
  '  customElements.define(\'mjs-tiers\', class extends HTMLElement {',
  "    connectedCallback() { this.textContent = 'reçu '+ this.value }",
  '  });',
  '}, 600);',
  '</script>',
].join('\n')

// chaque fichier de out/ (points compris) → son contenu, pour comparer deux constructions à l'octet
function instantane(outDir: string): Record<string, string> {
  const out: Record<string, string> = {}
  for(const f of readdirSync(outDir).sort()) {
    const chemin = join(outDir, f)
    if(statSync(chemin).isFile()) out[f] = readFileSync(chemin, 'latin1')
  }
  return out
}

// sert la page puis les fichiers de out/ tels qu'écrits ; `retards` retient les fichiers dont le nom
// commence par une clé (un enfant défini après le rendu de son parent)
async function servir(p: Projet, body: string, retards: Record<string, number> = {}): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8"></head><body>${body}<script type="module" src="/out/bundle.js"></script></body></html>`
  const server = createServer((req, res) => {
    const chemin  = decodeURIComponent((req.url ?? '/').split('?')[0])
    const envoyer = () => {
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
    }
    const nom    = chemin.split('/').pop() ?? ''
    const retard = Object.entries(retards).find(([prefixe]) => nom.startsWith(prefixe))
    if(retard) setTimeout(envoyer, retard[1])
    else envoyer()
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => resolve()))
  return { url: `http://127.0.0.1:${(server.address() as any).port}/`, server }
}

// textes rendus (les <p> et <b> de chaque ombre, joints par |) et propriétés PROPRES qui portent
// encore la valeur témoin, pour chaque composant de la page — des chaînes seulement, jamais un nœud
function releverPage(temoin: string): { rendus: Record<string, string>; polluees: string[] } {
  const rendus: Record<string, string> = {}
  const polluees: string[]             = []
  const parcourir                      = (racine: any) => {
    for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
      if(!el.tagName.startsWith('MJS-')) continue
      const tag  = el.tagName.toLowerCase()
      rendus[tag] = el._shadow ? Array.from(el._shadow.querySelectorAll('p, b')).map((n: any) => n.textContent).join('|') : '(sans ombre)'
      for(const nom of Object.getOwnPropertyNames(el)) {
        const desc = Object.getOwnPropertyDescriptor(el, nom)
        if(desc && desc.value === temoin) polluees.push(`${tag}.${nom}`)
      }
      if(el._shadow) parcourir(el._shadow)
    }
  }
  parcourir(document)
  return { rendus, polluees: polluees.sort() }
}

// état des composants demandés, clé par clé, en CHAÎNES (jamais un nœud ni une instance ne
// franchit la frontière de la page) : ce qu'une prop posée par un parent a réellement laissé
function releverEtats(balises: string[]): Record<string, Record<string, string>> {
  const out: Record<string, Record<string, string>> = {}
  const parcourir = (racine: any) => {
    for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
      if(!el.tagName.startsWith('MJS-')) continue
      const tag = el.tagName.toLowerCase()
      if(balises.includes(tag) && el._state) {
        const etat: Record<string, string> = {}
        for(const k of Object.keys(el._state)) {
          const v = el._state[k]
          etat[k] = v !== null && typeof v === 'object' ? '(objet)' : String(v)
        }
        out[tag] = etat
      }
      if(el._shadow) parcourir(el._shadow)
    }
  }
  parcourir(document)
  return out
}

async function monter(browser: any, p: Projet, body: string, balises: string[], opts: Options = {}): Promise<Releve> {
  const { url, server }   = await servir(p, body, opts.retards ?? {})
  const page              = await browser.newPage()
  const erreurs: string[] = []
  let apres: Record<string, string> = {}
  page.on('pageerror', (e: Error) => erreurs.push(e.message))
  page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
  try {
    await page.goto(url, { waitUntil: 'load' })
    // attente bornée : un composant cassé n'a jamais d'ombre rendue, on relit quand même ce qui est là
    await page.waitForFunction((attendues: string[]) => {
      const vus       = new Set<string>()
      const parcourir = (racine: any) => {
        for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
          if(!el.tagName.startsWith('MJS-')) continue
          if(el._shadow && !el.hasAttribute('mjs-loading')) vus.add(el.tagName.toLowerCase())
          if(el._shadow) parcourir(el._shadow)
        }
      }
      parcourir(document)
      return attendues.every(b => vus.has(b))
    }, balises, { timeout: 10000 }).catch(() => {})
    await page.waitForTimeout(100)
    const { rendus, polluees } = await page.evaluate(releverPage, TEMOIN)
    const etats = opts.etats ? await page.evaluate(releverEtats, opts.etats) : {}
    if(opts.clic) {
      await page.evaluate(({ balise, sel }: { balise: string; sel: string }) => {
        const hote  = document.querySelector(balise) as any
        const cible = hote && hote._shadow ? hote._shadow.querySelector(sel) : null
        if(cible) cible.click()
      }, opts.clic)
      await page.waitForTimeout(100)
      apres = (await page.evaluate(releverPage, TEMOIN)).rendus
    }
    return { rendus, apres, erreurs, polluees, etats }
  }
  finally {
    await page.close()
    await new Promise(resolve => server.close(() => resolve(null)))
  }
}

// texte de chaque élément repéré par sa classe, document et ombres comprises — des chaînes
// seulement, jamais un nœud ; plusieurs éléments d'une même classe sont joints par |
function releverTiers(classes: string[]): Record<string, string> {
  const trouves: Record<string, string[]> = {}
  for(const c of classes) trouves[c] = []
  const parcourir = (racine: any) => {
    for(const el of Array.from(racine.querySelectorAll('*')) as any[]) {
      for(const c of classes) if(el.classList && el.classList.contains(c)) trouves[c].push(el.textContent || '(jamais posé)')
      if(el._shadow) parcourir(el._shadow)
    }
  }
  parcourir(document)
  const out: Record<string, string> = {}
  for(const c of classes) out[c] = trouves[c].length > 0 ? trouves[c].join('|') : '(absent)'
  return out
}

async function monterTiers(browser: any, p: Projet, body: string, classes: string[], opts: { attente?: number; clic?: { balise: string; sel: string } } = {}): Promise<{ textes: Record<string, string>; apres: Record<string, string>; erreurs: string[] }> {
  const { url, server }   = await servir(p, body)
  const page              = await browser.newPage()
  const erreurs: string[] = []
  let apres: Record<string, string> = {}
  page.on('pageerror', (e: Error) => erreurs.push(e.message))
  page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
  try {
    await page.goto(url, { waitUntil: 'load' })
    await page.waitForTimeout(opts.attente ?? 400)
    const textes = await page.evaluate(releverTiers, classes)
    if(opts.clic) {
      await page.evaluate(({ balise, sel }: { balise: string; sel: string }) => {
        const hote  = document.querySelector(balise) as any
        const cible = hote && hote._shadow ? hote._shadow.querySelector(sel) : null
        if(cible) cible.click()
      }, opts.clic)
      await page.waitForTimeout(100)
      apres = await page.evaluate(releverTiers, classes)
    }
    return { textes, apres, erreurs }
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
    return await playwright.chromium.launch()
  }
  catch {
    return null
  }
}

describe('production — clés d\'exécution et marqueurs de données contre les noms courts', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(30000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de construction gardées. Activer : `npx playwright install chromium`')
  })

  after(async () => {
    if(browser) await browser.close()
  })

  for(const js of ['split', 'bundle'] as JsMode[]) {
    it(`js: '${js}' — un objet d'exécution étalé sur un enfant ne lui laisse que sa prop déclarée`, async function () {
      const p    = projet(`cles-etalement-${js}`)
      const cles = await construireAvecClesCourtes(p, js, c => ecrireEtalement(p, c))
      assert.ok(cles.length > 0, 'la construction doit avoir donné des noms courts à des propriétés internes')
      if(!browser) return
      // le module de l'enfant arrive 500 ms après le rendu du parent : les clés sont posées sur un
      // élément pas encore mis à niveau (sans effet en découpage groupé, où l'enfant est déjà défini)
      const releve = await monter(browser, p, '<mjs-parent></mjs-parent>', ['mjs-parent', 'mjs-enfant'], { retards: { 'enfant-': 500 } })
      assert.equal(releve.rendus['mjs-enfant'], 'Ana', `prop déclarée perdue — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(releve.polluees, [], 'aucune clé d\'exécution ne doit rester sur l\'élément')
      assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
    })
  }

  for(const js of ['split', 'bundle'] as JsMode[]) {
    it(`js: '${js}' — une donnée qui porte les noms courts des marqueurs internes reste remplaçable`, async function () {
      const p    = projet(`cles-marqueur-${js}`)
      const cles = await construireAvecClesCourtes(p, js, c => ecrireMarqueur(p, c))
      assert.ok(cles.length > 0, 'la construction doit avoir donné des noms courts à des propriétés internes')
      if(!browser) return
      const releve = await monter(browser, p, '<mjs-donnee></mjs-donnee>', ['mjs-donnee'], { clic: { balise: 'mjs-donnee', sel: '.maj' } })
      assert.equal(releve.rendus['mjs-donnee'], 'un', `donnée initiale faussée — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.equal(releve.apres['mjs-donnee'], 'deux', `la donnée n'a pas été remplacée — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
      assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
    })
  }

  it('un enfant servi en retard reçoit EXACTEMENT les props d\'un enfant défini à temps', async function () {
    const tot  = projet('props-enfant-a-temps')
    ecrireProps(tot)
    await construire(tot, 'bundle')
    const tard = projet('props-enfant-tardif')
    ecrireProps(tard)
    await construire(tard, 'split')
    if(!browser) return
    // référence : l'enfant est déjà défini quand son parent pose les props (`node._set`)
    const aTemps = await monter(browser, tot, '<mjs-parent></mjs-parent>', ['mjs-parent', 'mjs-enfant'], { etats: ['mjs-enfant'] })
    // le module de l'enfant arrive 500 ms après le rendu du parent : les props passent par le registre
    const tardif = await monter(browser, tard, '<mjs-parent></mjs-parent>', ['mjs-parent', 'mjs-enfant'], { etats: ['mjs-enfant'], retards: { 'enfant-': 500 } })
    assert.deepEqual(aTemps.etats['mjs-enfant'], { 'data-x': 'zz', dir: 'rtl', id: 'i7', title: 'titre' }, `props perdues sur le chemin « à temps » — erreurs de page : ${aTemps.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(tardif.etats['mjs-enfant'], aTemps.etats['mjs-enfant'], `un enfant servi en retard doit recevoir les mêmes props, clé par clé — erreurs de page : ${tardif.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(aTemps.erreurs, [], 'aucune erreur de page (enfant défini à temps)')
    assert.deepEqual(tardif.erreurs, [], 'aucune erreur de page (enfant servi en retard)')
  })

  it('enfant servi en retard : la DERNIÈRE écriture gagne, propriété propre ou prop du parent', async function () {
    const p = projet('props-chronologie')
    ecrireChronologie(p)
    await construire(p, 'split')
    if(!browser) return
    // t = 150 ms : la page pose une propriété propre sur les deux enfants (pas encore définis) ;
    // t = 400 ms : le parent « a » change sa prop ; t ≈ 900 ms : les modules des enfants arrivent
    const body = [
      '<mjs-parent-a></mjs-parent-a><mjs-parent-b></mjs-parent-b>',
      '<script>',
      'setTimeout(function () {',
      "  var a = document.querySelector('mjs-parent-a');",
      "  var ea = a && a._shadow ? a._shadow.querySelector('mjs-enfant-a') : null;",
      "  if (!ea) throw new Error('enfant a introuvable');",
      "  ea.nom = 'deux-ancien';",
      "  var b = document.querySelector('mjs-parent-b');",
      "  var eb = b && b._shadow ? b._shadow.querySelector('mjs-enfant-b') : null;",
      "  if (!eb) throw new Error('enfant b introuvable');",
      "  eb.nom = 'deux-ancien';",
      '}, 150);',
      'setTimeout(function () {',
      "  var a = document.querySelector('mjs-parent-a');",
      "  if (!a || typeof a.changer !== 'function') throw new Error('methode changer absente');",
      '  a.changer();',
      '}, 400);',
      '</script>',
    ].join('\n')
    const releve = await monter(browser, p, body, ['mjs-parent-a', 'mjs-parent-b', 'mjs-enfant-a', 'mjs-enfant-b'], { retards: { 'enfant-': 900 } })
    assert.equal(releve.rendus['mjs-enfant-a'], 'trois', `écriture du parent POSTÉRIEURE à la propriété propre : c'est elle qui doit gagner — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.rendus['mjs-enfant-b'], 'deux-ancien', `propriété propre POSTÉRIEURE à l'écriture du parent : c'est elle qui doit gagner — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })

  it('enfant servi en retard : une propriété propre FIGÉE ne fait crever ni le parent ni l\'enfant', async function () {
    const p = projet('props-figee')
    ecrireFige(p)
    await construire(p, 'split')
    if(!browser) return
    // t = 150 ms : la page fige `nom` sur l'enfant (pas encore défini) ; t = 400 ms : le parent
    // réécrit sa prop ; t ≈ 900 ms : le module de l'enfant arrive
    const body = [
      '<mjs-parent-c></mjs-parent-c>',
      '<script>',
      'setTimeout(function () {',
      "  var p = document.querySelector('mjs-parent-c');",
      "  var e = p && p._shadow ? p._shadow.querySelector('mjs-enfant-c') : null;",
      "  if (!e) throw new Error('enfant introuvable');",
      "  Object.defineProperty(e, 'nom', { value: 'fige', configurable: false, writable: true, enumerable: true });",
      '}, 150);',
      'setTimeout(function () {',
      "  var p = document.querySelector('mjs-parent-c');",
      "  if (!p || typeof p.changer !== 'function') throw new Error('methode changer absente');",
      '  p.changer();',
      '}, 400);',
      '</script>',
    ].join('\n')
    const releve = await monter(browser, p, body, ['mjs-parent-c', 'mjs-enfant-c'], { retards: { 'enfant-c-': 900 } })
    // ni le registre ni la reprise des propriétés propres au montage ne tentent de retirer une
    // propriété figée : aucune levée, l'enfant finit son montage
    assert.equal(releve.rendus['mjs-parent-c'], 'parent', `le parent doit rester rendu — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.rendus['mjs-enfant-c'], 'fige', `la propriété propre figée doit gagner à la mise à niveau — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })

  it('js: \'bundle\' — un objet d\'exécution étalé DANS UN {for} ne laisse rien sur l\'enfant', async function () {
    const p    = projet('cles-etalement-for')
    const cles = await construireAvecClesCourtes(p, 'bundle', c => ecrireEtalementFor(p, c))
    assert.ok(cles.length > 0, 'la construction doit avoir donné des noms courts à des propriétés internes')
    if(!browser) return
    // découpage groupé : la balise de l'enfant est DÉJÀ définie quand le parent peuple sa ligne —
    // la ligne, elle, n'est pas encore dans le document, donc l'enfant n'est pas encore mis à niveau
    const releve = await monter(browser, p, '<mjs-parent></mjs-parent>', ['mjs-parent', 'mjs-enfant'])
    assert.equal(releve.rendus['mjs-enfant'], 'Ana', `prop déclarée perdue — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.polluees, [], 'aucune clé d\'exécution ne doit rester sur l\'élément')
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })

  it('élément tiers DÉFINI avant le rendu : prop dynamique, étalement et {for} lui arrivent', async function () {
    const p = projet('tiers-defini')
    ecrireTiers(p)
    await construire(p, 'bundle')
    if(!browser) return
    const releve = await monterTiers(browser, p, PAGE_WIDGET +'<mjs-hote></mjs-hote>', ['direct', 'etale', 'ligne'], { clic: { balise: 'mjs-hote', sel: '.maj' } })
    assert.equal(releve.textes.direct, 'value=coucou', `prop dynamique perdue par l'élément tiers — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.textes.etale, 'a=un,b=deux', `étalement perdu par l'élément tiers — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.textes.ligne, 'value=une|value=deux', `props de {for} perdues par l'élément tiers — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.apres.direct, 'value=salut', `mise à jour perdue par l'élément tiers — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })

  it('élément tiers défini EN RETARD : la prop posée avant est là à la mise à niveau', async function () {
    const p = projet('tiers-tardif')
    ecrireTiersTardif(p)
    await construire(p, 'bundle')
    if(!browser) return
    const releve = await monterTiers(browser, p, PAGE_TIERS_TARDIF +'<mjs-hote></mjs-hote>', ['quelconque', 'prefixe'], { attente: 1200 })
    // balise `mjs-` inconnue du manifeste : l'autoloader la refuse (message attendu), la page la définit
    const autres = releve.erreurs.filter(e => !e.includes('Autoloader'))
    assert.equal(releve.textes.quelconque, 'reçu coucou', `prop perdue par une balise tierce définie après coup — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.equal(releve.textes.prefixe, 'reçu coucou', `prop perdue par une balise « mjs- » littérale absente du manifeste — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(autres, [], 'aucune erreur de page hors le refus attendu de l\'autoloader')
  })

  it('élément tiers dont la page FIGE une propriété : l\'hôte reste rendu, un seul avertissement', async function () {
    const p = projet('tiers-lecture-seule')
    ecrireTiersFige(p)
    await construire(p, 'bundle')
    if(!browser) return
    const { url, server }          = await servir(p, '<mjs-hote></mjs-hote>')
    const page                     = await browser.newPage()
    const erreurs: string[]        = []
    const avertissements: string[] = []
    page.on('pageerror', (e: Error) => erreurs.push(e.message))
    page.on('console', (m: any) => {
      if(m.type() === 'error') erreurs.push(m.text())
      if(m.type() === 'warning') avertissements.push(m.text())
    })
    try {
      await page.goto(url, { waitUntil: 'load' })
      await page.waitForTimeout(400)
      // la page fige `value` sur l'élément tiers : plus aucune écriture n'y est possible
      const fige = await page.evaluate(() => {
        const h: any = document.querySelector('mjs-hote')
        const w: any = h && h._shadow ? h._shadow.querySelector('my-widget') : null
        if(!w) return 'widget absent'
        Object.defineProperty(w, 'value', { value: 'fige', writable: false, configurable: false, enumerable: true })
        return 'fige'
      })
      assert.equal(fige, 'fige', 'la page doit avoir figé la propriété de l\'élément tiers')
      // deux mises à jour de la prop : l'avertissement ne doit pas se répéter
      for(let i = 0; i < 2; i++) {
        await page.evaluate(() => {
          const h: any = document.querySelector('mjs-hote')
          const b: any = h && h._shadow ? h._shadow.querySelector('.maj') : null
          if(b) b.click()
        })
        await page.waitForTimeout(150)
      }
      const etat = await page.evaluate(() => {
        const h: any = document.querySelector('mjs-hote')
        const w: any = h && h._shadow ? h._shadow.querySelector('my-widget') : null
        return {
          hote:   h && h._shadow ? (h._shadow.querySelector('b')?.textContent ?? '(pas de b)') : '(sans ombre)',
          valeur: w ? String(w.value) : '(absent)',
        }
      })
      assert.equal(etat.hote, 'hote coucou!!', `le rendu de l'hôte doit survivre à la propriété figée — erreurs de page : ${erreurs.join(' / ') || 'aucune'}`)
      assert.equal(etat.valeur, 'fige', 'la propriété figée doit rester telle que la page l\'a posée')
      const lectureSeule = avertissements.filter(a => a.includes('lecture seule'))
      assert.equal(lectureSeule.length, 1, `une seule fois par élément et par clé — avertissements : ${avertissements.join(' / ') || 'aucun'}`)
      assert.ok(lectureSeule[0].includes('my-widget') && lectureSeule[0].includes('value'), `l'avertissement doit nommer la balise et la clé : ${lectureSeule[0]}`)
      assert.deepEqual(erreurs, [], 'aucune erreur de page')
    }
    finally {
      await page.close()
      await new Promise(resolve => server.close(() => resolve(null)))
    }
  })

  it('contrat public — une propriété posée sur l\'élément avant sa définition entre dans l\'état', async function () {
    const p = projet('cles-contrat-public')
    writeFileSync(join(p.srcDir, 'compteur.mjs'), '<script>\n$count = 0\n</script>\n<p>{$count}</p>\n')
    await construire(p)
    if(!browser) return
    const body   = '<mjs-compteur></mjs-compteur><script>document.querySelector(\'mjs-compteur\').count = 5</script>'
    const releve = await monter(browser, p, body, ['mjs-compteur'])
    assert.equal(releve.rendus['mjs-compteur'], '5', `état faussé — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })

  it('cache pollué d\'avance (_mjs_c → u) : le marqueur des valeurs dérivées n\'est plus raccourci', async function () {
    const p = projet('cles-cache-pollue')
    mkdirSync(p.outDir, { recursive: true })
    writeFileSync(join(p.outDir, '.mangle-cache.json'), JSON.stringify({ _mjs_c: 'u' }))
    writeFileSync(join(p.srcDir, 'derive.mjs'), '<script>\n$a = 2\n$double = $a * 2\n</script>\n<p>{$double}</p>\n')
    await construire(p)
    assert.equal(lireCache(p)._mjs_c, false, 'le marqueur des valeurs dérivées doit être réservé, jamais raccourci')
    const premiere = instantane(p.outDir)
    await construire(p)
    const seconde = instantane(p.outDir)
    await construire(p)
    const troisieme = instantane(p.outDir)
    assert.deepEqual(Object.keys(seconde), Object.keys(premiere), 'mêmes fichiers émis')
    assert.deepEqual(Object.keys(troisieme), Object.keys(premiere), 'mêmes fichiers émis')
    for(const f of Object.keys(premiere)) {
      assert.ok(seconde[f] === premiere[f], `${f} diffère d'une construction à l'autre`)
      assert.ok(troisieme[f] === premiere[f], `${f} diffère d'une construction à l'autre`)
    }
    if(!browser) return
    const releve = await monter(browser, p, '<mjs-derive></mjs-derive>', ['mjs-derive'])
    assert.equal(releve.rendus['mjs-derive'], '4', `valeur dérivée faussée — erreurs de page : ${releve.erreurs.join(' / ') || 'aucune'}`)
    assert.deepEqual(releve.erreurs, [], 'aucune erreur de page')
  })
})

describe('réservation des marqueurs lus sur une donnée', function () {
  it('couvre le marqueur des valeurs dérivées', function () {
    assert.ok(DATA_MARKER_NAMES.includes('_mjs_c'), '`_mjs_c` se lit sur la valeur d\'un état : il ne peut pas être raccourci')
  })

  it('pose chaque marqueur à false et rend les correspondances héritées retirées', function () {
    const cache: Record<string, string | false> = { _mjs_c: 'u', _mjs_dead: 'g', h: false }
    assert.deepEqual(reserveDataMarkers(cache), ['_mjs_c'])
    assert.deepEqual(cache, { _mjs_c: false, _mjs_dead: 'g', h: false })
  })

  it('ne retire rien quand le marqueur est déjà réservé', function () {
    const cache: Record<string, string | false> = { _mjs_c: false, _mjs_dead: 'g' }
    assert.deepEqual(reserveDataMarkers(cache), [])
    assert.deepEqual(cache, { _mjs_c: false, _mjs_dead: 'g' })
  })
})

describe('réservation des aides du cœur posées sur µ (`µ._p`, `µ._set`, `µ._storeSet`, `µ._setHead`…)', function () {
  this.timeout(120000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('couvre TOUTES les aides posées sur µ que le code émis cite, majuscules comprises', function () {
    assert.deepEqual([...CORE_HELPER_NAMES], ['_p', '_tm', '_al', '_def', '_esc', '_set', '_storeSet', '_storeDeclare', '_glCl', '_glSt', '_updDynEl', '_updModule', '_setHead', '_clearHead', '_vtPresets', '_isServer'], 'les aides citées par le code émis ne peuvent pas être écrasées par un nom court')
  })

  // la liste se re-relève ICI sur les sources du compilateur : un `µ._nouvelleAide` ajouté au
  // transpileur ou au générateur fait rougir ce test tant qu'il n'est pas réservé. Relevé TEXTUEL
  // (commentaires compris) et volontairement large, comme celui des noms d'instance : un nom réservé
  // à tort coûte quelques octets, un nom manqué rouvre le bogue.
  //
  // Le relevé BRUT rend 48 jetons distincts : les 16 aides, plus 32 propriétés internes
  // (`µ._mjs_pend`, `µ._mjs_deepSet`…) — celles-là, le raccourcisseur DOIT pouvoir les raccourcir,
  // elles ne sont jamais réservées. Le filtre `_mjs` les écarte toutes, et n'écarte qu'elles.
  it('la liste EST le relevé des `µ._*` du transpileur et du générateur, noms internes mis à part', function () {
    const releve = new Set<string>()
    for(const dossier of ['transpiler', 'generator']) {
      for(const file of sourcesTs(fileURLToPath(new URL(`../src/${dossier}`, import.meta.url)))) {
        for(const m of readFileSync(file, 'utf-8').matchAll(/µ\._([A-Za-z][\w$]*)/g)) releve.add(`_${m[1]}`)
      }
    }
    const attendues = [...releve].filter(nom => !nom.startsWith('_mjs')).sort()
    assert.deepEqual([...CORE_HELPER_NAMES].sort(), attendues, `relevé des aides citées par le compilateur : ${attendues.join(' ')}`)
  })

  it('un cache qui a donné le nom d\'une aide à une propriété interne perd la correspondance', function () {
    const cache: Record<string, string | false> = { _mjs_dead: '_p', _mjs_ancien: '_esc', _mjs_vieux: '_set', _mjs_tete: '_setHead', _mjs_store: '_storeSet', _mjs_autre: 'q' }
    assert.deepEqual(reserveMangleNames(cache, CORE_HELPER_NAMES), ['_mjs_ancien', '_mjs_dead', '_mjs_store', '_mjs_tete', '_mjs_vieux'])
    assert.deepEqual(cache, { _mjs_autre: 'q', ...Object.fromEntries(CORE_HELPER_NAMES.map(nom => [nom, false])) })
  })

  it('construction prod d\'un composant PLAT (qui ne cite aucune aide) : les noms restent réservés', async function () {
    const p = projet('aides-cache-pollue')
    mkdirSync(p.outDir, { recursive: true })
    writeFileSync(join(p.outDir, '.mangle-cache.json'), JSON.stringify({ _mjs_dead: '_p', _mjs_efface: '_esc', _mjs_pose: '_set', _mjs_tete: '_setHead' }))
    // gabarit plat : son code compilé ne cite ni `µ._p` ni `µ._tm`, donc le relevé des noms
    // d'instance ne les voit pas — seule la réservation explicite protège les aides du cœur
    writeFileSync(join(p.srcDir, 'plat.mjs'), '<script>\n$m = \'bonjour\'\n</script>\n<p>{$m}</p>\n')
    await construire(p, 'bundle')
    const cache = lireCache(p)
    assert.equal(cache._p, false, '`_p` doit être réservé : le raccourcisseur ne doit jamais le donner à une propriété interne')
    assert.equal(cache._tm, false, '`_tm` doit être réservé')
    assert.equal(cache._al, false, '`_al` (enregistrement de l\'alias de balise) doit être réservé, même sans son module dans ce bundle')
    assert.equal(cache._def, false, '`_def` (enregistrement de la balise du composant) doit être réservé')
    assert.equal(cache._esc, false, '`_esc` (échappement des interpolations qui partent en innerHTML) doit être réservé')
    assert.equal(cache._set, false, '`_set` (assignation depuis le code du composant) doit être réservé')
    assert.equal(cache._setHead, false, '`_setHead` (injection du <head> vivant) doit être réservé, sa majuscule ne le met pas hors du relevé')
    assert.equal(cache._storeSet, false, '`_storeSet` (écriture notifiante dans le store) doit être réservé')
    assert.notEqual(cache._mjs_dead, '_p', 'la correspondance héritée vers une aide du cœur doit être retirée')
    assert.notEqual(cache._mjs_efface, '_esc', 'la correspondance héritée vers `_esc` doit être retirée')
    assert.notEqual(cache._mjs_pose, '_set', 'la correspondance héritée vers `_set` doit être retirée')
    assert.notEqual(cache._mjs_tete, '_setHead', 'la correspondance héritée vers `_setHead` doit être retirée')
  })

  it('construction prod d\'un composant IMBRIQUÉ : le bundle minifié cite les aides et se monte', async function () {
    const p = projet('aides-montage')
    mkdirSync(p.outDir, { recursive: true })
    writeFileSync(join(p.outDir, '.mangle-cache.json'), JSON.stringify({ _mjs_dead: '_p' }))
    writeFileSync(join(p.srcDir, 'hote.mjs'), '<script>\n$m = \'bonjour\'\n</script>\n<div><section><b>a {$m} b</b><i>{$m}</i></section></div>\n')
    await construire(p, 'bundle')
    const code = readFileSync(join(p.outDir, 'bundle.js'), 'utf-8')
    assert.match(code, /\._p\(/, 'le code compilé du composant doit citer l\'aide de navigation')
    assert.match(code, /\._tm\(/, 'le code compilé du composant doit citer l\'aide du marqueur texte')
    // bundle ES d'un seul tenant évalué dans une fenêtre happy-dom : les aides doivent répondre
    const fenetre: any = new Window({ url: 'http://localhost/' })
    fenetre.eval(code.replace(/import\.meta\.url/g, "'http://localhost/'").replace(/export\s*\{[^}]*\}\s*;?/g, ''))
    fenetre.document.body.insertAdjacentHTML('beforeend', '<mjs-hote></mjs-hote>')
    await new Promise(resolve => setTimeout(resolve, 200))
    const hote: any = fenetre.document.body.querySelector('mjs-hote')
    assert.equal(hote && hote._shadow ? hote._shadow.innerHTML : '(sans ombre)', '<div><section><b>a bonjour b</b><i>bonjour</i></section></div>', 'le composant doit se monter et afficher son texte')
  })
})

// où atterrit une prop selon la balise : registre du framework (composant du projet, reconnu par
// le manifeste) ou propriété propre de l'élément (tout le reste). Construction de DÉVELOPPEMENT :
// les noms internes ne sont pas raccourcis, `µ` est exposé sur window — le critère se lit tel quel.
describe('critère du registre — composant du projet contre élément tiers', function () {
  this.timeout(120000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('reconnaît le projet par le manifeste, jamais par l\'héritage d\'Object', async function () {
    const root   = mjsTmp('critere-registre')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), '<script>\n$m = \'bonjour\'\n</script>\n<p>{$m}</p>\n')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(outDir, 'bundle.js'), urlPrefix: '/out', env: 'dev', js: 'bundle' })
    const stats   = await bundler.compile()
    await bundler.close()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const code     = readFileSync(join(outDir, 'bundle.js'), 'utf-8')
    const fenetre: any = new Window({ url: 'http://localhost/' })
    fenetre.eval(code.replace(/import\.meta\.url/g, "'http://localhost/out/bundle.js'").replace(/export\s*\{[^}]*\}\s*;?/g, ''))
    await new Promise(resolve => setTimeout(resolve, 200))
    const µ: any = fenetre.µ
    assert.equal(typeof µ._mjs_pend, 'function', 'la construction de développement doit exposer µ sur window, noms internes intacts')
    // `<mjs-constructor>` : une balise tierce dont le nom EST une clé héritée d'Object.prototype —
    // le manifeste ne la porte pas, elle doit recevoir sa prop comme tout élément tiers
    const tiers: any = fenetre.document.createElement('mjs-constructor')
    µ._mjs_pend(tiers, 'valeur', 'V')
    assert.equal(Object.prototype.hasOwnProperty.call(tiers, 'valeur'), true, 'un élément tiers reçoit la prop sur lui-même')
    assert.equal(String(tiers.valeur), 'V', 'la valeur posée sur un élément tiers doit être la bonne')
    assert.equal(µ._mjs_pending.has(tiers), false, 'un élément tiers n\'entre pas dans le registre du framework')
    // composant DU PROJET (clé propre du manifeste) : la prop est retenue hors de l'instance
    const hote: any = fenetre.document.createElement('mjs-hote')
    µ._mjs_pend(hote, 'valeur', 'V')
    assert.equal(Object.prototype.hasOwnProperty.call(hote, 'valeur'), false, 'un composant du projet ne reçoit rien sur l\'élément')
    assert.equal(µ._mjs_pending.has(hote), true, 'un composant du projet passe par le registre')
    assert.equal(String(µ._mjs_pending.get(hote).valeur), 'V', 'le registre doit porter la valeur')
    // clés de pollution de prototype : refusées AVANT toute écriture, tiers compris
    for(const cle of ['__proto__', 'constructor', 'prototype']) {
      µ._mjs_pend(tiers, cle, 'X')
      assert.equal(Object.prototype.hasOwnProperty.call(tiers, cle), false, `« ${cle} » ne doit jamais être écrite sur un élément`)
    }
    assert.equal(String(({} as any).valeur), 'undefined', 'aucune clé spéciale ne doit avoir touché Object.prototype')
  })
})

describe('rendu serveur — un parent qui étale une donnée sur un enfant', function () {
  this.timeout(60000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('rend la prop déclarée de l\'enfant', async function () {
    const root   = mjsTmp('cles-ssr')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'parent.mjs'), '<script>\n$data = JSON.parse(\'{"name":"Ana"}\')\n</script>\n<@enfant {...$data}>\n')
    writeFileSync(join(srcDir, 'enfant.mjs'), '<p>{$name}</p>\n')
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-parent' })
    assert.match(res.html, /Ana/, 'la prop étalée doit arriver jusqu\'à l\'enfant')
  })
})
