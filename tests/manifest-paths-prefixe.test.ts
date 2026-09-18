// writeManifest — PRÉFIXE FACTORISÉ de `µ.paths`.
//
// Les 1 398 entrées d'un vrai site répétaient toutes le même début d'URL
// (`/assets/modularJS_compiled/`), soit 37 Ko de préfixe recopié dans une ligne servie
// sur CHAQUE page. Le préfixe est désormais publié UNE fois (`µ.pathsPrefix`) et chaque
// valeur ne garde que son suffixe ; tout consommateur de chemin recolle les deux
// (Autoloader, préchargement du manifeste). Les CLÉS, elles, ne bougent pas : c'est
// tout ce que lit `mjs_ujs.ts` pour savoir si un module lui est connu.
//
// Mode `js: 'bundle'` : forme INCHANGÉE (`µ.paths[nom] = µSelfUrl`, une seule URL
// partagée — rien à factoriser, et `µ.pathsPrefix` n'y est jamais posé).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const AUTOLOADER = join(__dirname, '..', 'src', 'runtime', 'mjs_autoloader.ts')

function makeProject(urlPrefix?: string): { srcDir: string; outDir: string; manifestPath: string; urlPrefix?: string } {
  const root = mjsTmp('paths-prefixe')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'a.mjs'), '<@b></@b>\n')
  writeFileSync(join(srcDir, 'b.mjs'), '<p>b</p>\n')
  return { srcDir, outDir: join(root, 'out'), manifestPath: join(root, 'bundle.js'), urlPrefix }
}

/** Valeur d'un `const µNOM = {...};` du manifeste (une seule ligne, cf. writeManifest). */
function extractConst(manifestSrc: string, name: string): any {
  const marker = `const ${name} = `
  const line = manifestSrc.split('\n').find(l => l.startsWith(marker))
  assert.ok(line, `manifeste sans ligne ${marker}`)
  return JSON.parse(line!.slice(marker.length).replace(/;$/, ''))
}

describe('bundler — writeManifest() : préfixe factorisé de µ.paths', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('le manifeste pose `µ.pathsPrefix` une fois et ne garde que les suffixes', async function () {
    const p = makeProject()
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifestPath, urlPrefix: '/assets/mjs' })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const src = readFileSync(p.manifestPath, 'utf-8')

      assert.match(src, /^\s*µ\.pathsPrefix = "\/assets\/mjs\/";$/m, 'préfixe commun publié une seule fois')
      const paths = extractConst(src, 'µPaths')
      assert.deepEqual(Object.keys(paths).sort(), ['a', 'b'], 'les CLÉS ne changent pas (µ.paths lu par mjs_ujs.ts)')
      assert.match(paths.a, /^a-[a-f0-9]{8}\.js$/, `suffixe seul attendu, reçu : ${paths.a}`)
      assert.match(paths.b, /^b-[a-f0-9]{8}\.js$/, `suffixe seul attendu, reçu : ${paths.b}`)
      assert.equal(src.includes('"/assets/mjs/a-'), false, 'plus aucune URL entière dans la table')
    } finally {
      await bundler.close()
    }
  })

  it('le préchargement du manifeste pose des href ENTIERS (préfixe recollé)', async function () {
    const p = makeProject()
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifestPath, urlPrefix: '/assets/mjs' })
    try {
      await bundler.compile()
      const src = readFileSync(p.manifestPath, 'utf-8')
      const window: any = new Window({ url: 'http://localhost/' })
      window.document.body.innerHTML = '<mjs-a></mjs-a>'
      window.eval(src)

      const hrefs = Array.from(window.document.head.querySelectorAll('link[rel="modulepreload"]'))
        .map((l: any) => l.getAttribute('href'))
      const paths = extractConst(src, 'µPaths')
      assert.equal(hrefs.includes('/assets/mjs/' + paths.a), true, `href entier attendu pour a :\n${hrefs.join('\n')}`)
      assert.equal(hrefs.includes('/assets/mjs/' + paths.b), true, `href entier attendu pour b (dépendance directe) :\n${hrefs.join('\n')}`)
      assert.equal(hrefs.includes(paths.a), false, 'jamais un suffixe nu en href')
    } finally {
      await bundler.close()
    }
  })

  it("l'Autoloader recolle le préfixe avant d'importer un composant", async function () {
    const µ: any = { log() {}, warn() {}, error() {}, paths: { panier: 'panier-1234abcd.js' }, pathsPrefix: '/assets/mjs/' }
    const vus: string[] = []
    µ.log = (m: string) => { vus.push(String(m)) }
    ;(globalThis as any).customElements = { get: () => undefined }
    try {
      new Function('µ', readFileSync(AUTOLOADER, 'utf-8'))(µ)
      await µ.Autoloader.load('mjs-panier')
      const demande = vus.find(m => m.includes('Downloading')) ?? ''
      assert.equal(demande.includes('/assets/mjs/panier-1234abcd.js'), true, `chemin entier attendu dans la demande de chargement : ${demande}`)
    } finally {
      delete (globalThis as any).customElements
    }
  })

  it("js: 'bundle' : forme inchangée, aucun préfixe posé", async function () {
    const p = makeProject()
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifestPath, urlPrefix: '/assets/mjs', js: 'bundle' })
    try {
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const src = readFileSync(p.manifestPath, 'utf-8')
      assert.equal(/pathsPrefix/.test(src), false, 'un fichier unique n\'a rien à factoriser')
      assert.equal(/import\.meta\.url/.test(src), true, 'chaque nom pointe toujours le fichier lui-même')
    } finally {
      await bundler.close()
    }
  })
})
