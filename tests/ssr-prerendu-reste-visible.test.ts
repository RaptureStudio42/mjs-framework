// Prérendu — le balisage rendu par le serveur reste VISIBLE jusqu'au premier rendu client.
//
// Le bouclier anti-FOUC du cœur masque tout custom element pas encore défini (`:not(:defined)`) :
// sur une page prérendue, le visiteur voyait le contenu peint sans JavaScript, puis une page VIDE
// dès l'évaluation du cœur, jusqu'à l'arrivée du module de chaque composant — le prérendu perdait sa
// raison d'être. Le rendu serveur marque donc chaque élément `mjs-*` qu'il rend (attribut `mjs-ssr`)
// et le bouclier épargne ces éléments-là ; un composant que le serveur n'a PAS rendu reste masqué
// jusqu'à sa définition (le bouclier garde son rôle).
//
// Montage dans un Chromium réel, cœur ET modules de composants servis EN RETARD (route interceptée)
// : c'est la seule façon d'observer la fenêtre entre « cœur évalué » et « composant défini ».
// Chromium absent : les montages sont sautés, les assertions sur le fragment restent.

import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import { mkdirSync, writeFileSync, readFileSync, existsSync, statSync } from 'node:fs'
import { join, extname, normalize } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { createSSRRenderer, type RenderResult } from '../src/server/renderToString.js'

interface Projet { root: string; srcDir: string; outDir: string }
interface Ligne { t: number; valeurs: string[] }
interface Releve { jalons: Record<string, string[]>; trames: Ligne[]; textes: Record<string, string>; textesFinaux: Record<string, string> }

// retards en ms par préfixe de fichier servi : le cœur arrive après le premier affichage, les
// modules de composants bien après le cœur — la fenêtre « cœur là, composant pas encore défini »
// devient alors observable
const RETARD_COEUR   = 1000
const RETARD_MODULES = 2400
const SELECTEURS     = ['mjs-racine', 'mjs-leger', 'mjs-tardif']

function fixture(prefix: string): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'enfant.mjs'), ['<p class="enfant-wrap">ENFANT-TEXTE</p>', '<style>', '  .enfant-wrap', '    color: seagreen', '</style>', ''].join('\n'))
  writeFileSync(join(srcDir, 'leger.mjs'), ['<p class="leger-wrap">LEGER-TEXTE</p>', '<style>', '  .leger-wrap', '    color: tomato', '</style>', ''].join('\n'))
  writeFileSync(join(srcDir, 'tardif.mjs'), ['<p class="tardif-wrap">TARDIF-TEXTE</p>', ''].join('\n'))
  writeFileSync(join(srcDir, 'racine.mjs'), ['<div class="racine-wrap">', '  <p class="racine-marque">RACINE-TEXTE</p>', '  <@enfant>', '  <@leger mjs-light>', '</div>', '<style>', '  .racine-wrap', '    color: rebeccapurple', '</style>', ''].join('\n'))
  return { root, srcDir, outDir }
}

async function rendre(p: Projet, ssrMode: 'replace' | 'markers' | 'positional' | 'diff'): Promise<RenderResult> {
  const renderer = await createSSRRenderer({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), bundlerOpts: { urlPrefix: '/out' } })
  try {
    return await renderer.renderToString('mjs-racine', { ssrMode })
  }
  finally {
    await renderer.close()
  }
}

// l'îlot light aplati tel que le serveur l'a rendu, extrait du fragment pour être posé DANS le
// document (ce que fait une coquille qui insère un rendu serveur à plat, hors de toute ombre)
function ilotLight(html: string): string {
  const m = html.match(/<mjs-leger\b[^>]*>[\s\S]*?<\/mjs-leger>/)
  assert.ok(m, `le fragment doit porter le sous-composant light aplati — HTML : ${html}`)
  return m![0]
}

// sert la coquille puis out/ tel quel ; chaque préfixe de `retards` diffère l'envoi du fichier
async function servir(p: Projet, corps: string, tete: string, retards: Record<string, number>): Promise<{ url: string; server: Server }> {
  const html   = `<!doctype html><html><head><meta charset="utf-8">${tete}<script type="module" src="/out/bundle.js"></script></head><body>${corps}</body></html>`
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

// posée AVANT tout script de la page : relève `display` de chaque sélecteur à CHAQUE trame, pour que
// la moindre fenêtre de masquage entre deux `requestAnimationFrame` laisse une trace
function poserSonde(sels: string[]): void {
  const trames: { t: number; valeurs: string[] }[] = []
  ;(window as any).__mjsTrames = trames
  const tick = () => {
    trames.push({
      t: Math.round(performance.now()),
      valeurs: sels.map((s) => {
        const el = document.querySelector(s)
        return el ? getComputedStyle(el).display : 'absent'
      }),
    })
    requestAnimationFrame(tick)
  }
  requestAnimationFrame(tick)
}

// `display` de chaque sélecteur MAINTENANT, lu hors de la sonde (jamais un nœud ne franchit la
// frontière de la page : des chaînes seulement)
function lireDisplay(sels: string[]): string[] {
  return sels.map((s) => {
    const el = document.querySelector(s)
    return el ? getComputedStyle(el).display : 'absent'
  })
}

// texte visible de chaque sélecteur (ombre comprise), pour prouver que le contenu prérendu est bien
// celui qu'on regarde
function lireTextes(sels: string[]): Record<string, string> {
  const out: Record<string, string> = {}
  for(const s of sels) {
    const el: any = document.querySelector(s)
    out[s] = el ? String((el.shadowRoot || el).textContent || '').replace(/\s+/g, ' ').trim() : '(absent)'
  }
  return out
}

async function sonder(browser: any, p: Projet, corps: string, tete: string): Promise<{ releve: Releve; erreurs: string[] }> {
  const { url, server } = await servir(p, corps, tete, { 'mjs_core-': RETARD_COEUR, 'racine-': RETARD_MODULES, 'enfant-': RETARD_MODULES, 'leger-': RETARD_MODULES, 'tardif-': RETARD_MODULES })
  const page              = await browser.newPage()
  const erreurs: string[] = []
  page.on('pageerror', (e: Error) => erreurs.push(e.message))
  page.on('console', (m: any) => { if(m.type() === 'error') erreurs.push(m.text()) })
  const jalons: Record<string, string[]> = {}
  try {
    await page.addInitScript(poserSonde, SELECTEURS)
    await page.goto(url, { waitUntil: 'commit' })
    // 800 ms : le cœur n'est pas encore arrivé, rien ne masque — le contenu prérendu est peint
    await page.waitForTimeout(800)
    jalons.avantCoeur = await page.evaluate(lireDisplay, SELECTEURS)
    const textes      = await page.evaluate(lireTextes, SELECTEURS)
    // 1 400 ms : le cœur est évalué (bouclier adopté), aucun composant n'est encore défini
    await page.waitForTimeout(600)
    jalons.coeurSansModule = await page.evaluate(lireDisplay, SELECTEURS)
    // modules servis, composants définis et montés, puis 2 s de trames
    await page.waitForFunction(() => !!customElements.get('mjs-racine') && !!customElements.get('mjs-leger'), null, { timeout: 15000 })
    await page.waitForTimeout(2000)
    jalons.apresMontage = await page.evaluate(lireDisplay, SELECTEURS)
    const trames: Ligne[]  = await page.evaluate(() => (window as any).__mjsTrames)
    const textesFinaux     = await page.evaluate(lireTextes, SELECTEURS)
    return { releve: { jalons, trames, textes, textesFinaux }, erreurs }
  }
  finally {
    await page.close()
    await new Promise(resolve => server.close(() => resolve(null)))
  }
}

// trames où le sélecteur d'indice `i` était masqué, en millisecondes depuis le début
function tramesMasquees(trames: Ligne[], i: number): number[] {
  return trames.filter(l => l.valeurs[i] === 'none').map(l => l.t)
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

describe('prérendu — le balisage servi reste visible jusqu\'au premier rendu client', function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(30000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montages sautés, assertions de fragment gardées. Activer : `npx playwright install chromium`')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('le rendu serveur marque chaque élément mjs-* rendu (racine, imbriqué, light)', async () => {
    const res = await rendre(fixture('prerendu-marque'), 'replace')
    assert.match(res.html, /^<mjs-racine\b[^>]*\bmjs-ssr\b/, `la racine rendue doit porter mjs-ssr — HTML : ${res.html}`)
    assert.match(res.html, /<mjs-enfant\b[^>]*\bmjs-ssr\b/, `le sous-composant à shadow doit porter mjs-ssr — HTML : ${res.html}`)
    assert.match(res.html, /<mjs-leger\b[^>]*\bmjs-ssr\b/, `le sous-composant light doit porter mjs-ssr — HTML : ${res.html}`)
  })

  for(const ssrMode of ['replace', 'markers', 'positional', 'diff'] as const) {
    it(`ssr '${ssrMode}' — cœur évalué, composants pas encore définis : le contenu prérendu reste peint ; un composant non rendu reste masqué`, async function () {
      if(!browser) this.skip()
      const p   = fixture(`prerendu-visible-${ssrMode}`)
      const res = await rendre(p, ssrMode)
      const corps = res.html + ilotLight(res.html) + '<mjs-tardif></mjs-tardif>'
      const { releve, erreurs } = await sonder(browser, p, corps, res.sharedScript + res.hydrateScript)

      assert.deepEqual(erreurs, [], 'aucune erreur de page')
      assert.match(releve.textes['mjs-racine'], /RACINE-TEXTE/, 'le texte prérendu de la racine doit être là')

      // avant le cœur : rien ne masque (aucun bouclier n'existe encore)
      assert.notEqual(releve.jalons.avantCoeur[0], 'none', `racine masquée AVANT même le cœur — relevé : ${JSON.stringify(releve.jalons)}`)
      assert.notEqual(releve.jalons.avantCoeur[1], 'none', `îlot light masqué AVANT même le cœur — relevé : ${JSON.stringify(releve.jalons)}`)

      // cœur évalué, aucun composant défini : le contenu rendu par le serveur reste peint, celui
      // que le serveur n'a pas rendu reste masqué
      assert.notEqual(releve.jalons.coeurSansModule[0], 'none', `racine prérendue masquée alors que le cœur vient de s'évaluer — relevé : ${JSON.stringify(releve.jalons)}`)
      assert.notEqual(releve.jalons.coeurSansModule[1], 'none', `îlot light prérendu masqué alors que le cœur vient de s'évaluer — relevé : ${JSON.stringify(releve.jalons)}`)
      assert.equal(releve.jalons.coeurSansModule[2], 'none', `un composant que le serveur n'a PAS rendu doit rester masqué jusqu'à sa définition — relevé : ${JSON.stringify(releve.jalons)}`)

      // après montage : contenu rendu par le client, et aucune trame masquée depuis le début
      assert.notEqual(releve.jalons.apresMontage[0], 'none', `racine masquée après montage — relevé : ${JSON.stringify(releve.jalons)}`)
      assert.match(releve.textesFinaux['mjs-racine'], /RACINE-TEXTE/, 'le contenu doit rester en place après le rendu client')
      assert.match(releve.textesFinaux['mjs-leger'], /LEGER-TEXTE/, 'l\'îlot light doit rester en place après le rendu client')
      assert.ok(releve.trames.length > 60, `sonde trop courte pour conclure : ${releve.trames.length} trames`)
      assert.deepEqual(tramesMasquees(releve.trames, 0), [], 'aucune trame ne doit voir la racine prérendue masquée')
      assert.deepEqual(tramesMasquees(releve.trames, 1), [], 'aucune trame ne doit voir l\'îlot light prérendu masqué')
    })
  }
})
