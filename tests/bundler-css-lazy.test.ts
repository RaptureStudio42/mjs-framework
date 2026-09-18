// mode `css: 'lazy'`.
//
// Le contrat : chaque feuille partagée devient un VRAI fichier `.css` haché, chargé au
// montage du PREMIER composant qui la déclare (`@css`), mis en cache PAR URL — une feuille
// réclamée par dix composants = UNE requête. `'bundle'` (défaut) et `'split'` inchangés.
//
// Pipeline RÉEL de bout en bout (Bundler → core + composant compilés puis montés dans
// happy-dom, patron de tests/mjs-layout-runtime.test.ts) : jamais une copie recodée à la
// main de `_mjs_applyLayout`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join, basename } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root      = mjsTmp(prefix)
  const srcDir    = join(root, 'src')
  const outDir    = join(root, 'out')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, outDir, stylesDir, manifest: join(root, 'bundle.js') }
}

/** La ligne `µ._cssLazy = {…};` du manifeste, désérialisée — undefined si elle n'y est pas.
 *  `.trim()` : cascade de modules, la ligne vit désormais dans le corps indenté du
 *  `.then()` du manifeste (cf. writeManifest, bundler/index.ts). */
function lazyTable(manifestPath: string): Record<string, string> | undefined {
  const line = readFileSync(manifestPath, 'utf-8').split('\n').find(l => l.trim().startsWith('µ._cssLazy = '))
  return line ? JSON.parse(line.trim().slice('µ._cssLazy = '.length).replace(/;$/, '')) : undefined
}

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe("bundler — css: 'lazy' (feuilles partagées différées)", function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('chaque feuille déclarée devient un .css haché, et le manifeste publie la table nom → URL', async function () {
    const p = makeProject('lazy-emit')
    writeFileSync(join(p.stylesDir, 'theme.sass'), '.card\n  color: teal\n')
    writeFileSync(join(p.stylesDir, 'grid.sass'), '.grid\n  display: grid\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<style @css="theme grid"></style>\n\n<div class="card">x</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const emis = readdirSync(p.outDir)
    assert.ok(emis.some(f => /^mjs_style_theme-[a-f0-9]{8}\.css$/.test(f)), `theme.css haché absent : ${emis.join(', ')}`)
    assert.ok(emis.some(f => /^mjs_style_grid-[a-f0-9]{8}\.css$/.test(f)), `grid.css haché absent : ${emis.join(', ')}`)

    const table = lazyTable(p.manifest)
    assert.ok(table, 'le manifeste doit publier µ._cssLazy')
    assert.deepEqual(Object.keys(table!), ['grid', 'theme'], 'la table doit être triée, comme µ.paths')
    assert.match(basename(table!.theme), /^mjs_style_theme-[a-f0-9]{8}\.css$/)
    assert.match(readFileSync(join(p.outDir, basename(table!.theme)), 'utf-8'), /color:\s*teal/)

    await bundler.close()
  })

  it("le composant n'importe RIEN de la feuille : c'est toute la différence avec 'split'", async function () {
    const p = makeProject('lazy-noimport')
    writeFileSync(join(p.stylesDir, 'theme.sass'), '.card\n  color: teal\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<style @css="theme"></style>\n\n<div class="card">x</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const compFile = readdirSync(p.outDir).find(f => /^comp-[a-f0-9]{8}\.js$/.test(f))!
    const compSrc  = readFileSync(join(p.outDir, compFile), 'utf-8')
    assert.ok(!/mjs_style_theme/.test(compSrc), `le JS du composant ne doit contenir aucun chemin de feuille :\n${compSrc.slice(0, 400)}`)
    const manifestSrc = readFileSync(p.manifest, 'utf-8')
    assert.ok(!/import '.*mjs_style_theme/.test(manifestSrc), 'le manifeste ne doit pas importer la feuille non plus')

    await bundler.close()
  })

  it('`mjs_root` reste EAGER (personne ne le déclare, il habille le document)', async function () {
    const p = makeProject('lazy-root')
    writeFileSync(join(p.stylesDir, 'mjs_root.sass'), '.app\n  color: purple\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<div>x</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    assert.ok(bundler.splitRootHashedPath, 'mjs_root doit produire son propre module eager')
    assert.match(basename(bundler.splitRootHashedPath!), /^mjs_style_root-[a-f0-9]{8}\.js$/)
    // styles/animations partent en `Promise.all([import(...), ...])` (cf. writeManifest,
    // bundler/index.ts) — recherche de l'appel `import(...)`, peu importe s'il est SEUL
    // (`await import(x);`) ou un ÉLÉMENT du tableau `Promise.all`.
    assert.ok(readFileSync(p.manifest, 'utf-8').includes(`import(${JSON.stringify(bundler.splitRootHashedPath)})`), 'le manifeste doit importer mjs_root')
    assert.equal(lazyTable(p.manifest), undefined, "mjs_root ne doit pas entrer dans la table paresseuse (il n'est pas différé)")

    await bundler.close()
  })

  it("une feuille que personne ne réclame est écrite mais JAMAIS chargée — et le build le dit", async function () {
    const p = makeProject('lazy-orpheline')
    writeFileSync(join(p.stylesDir, 'oubliee.sass'), '.x\n  color: red\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<div>x</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    assert.ok(readdirSync(p.outDir).some(f => /^mjs_style_oubliee-[a-f0-9]{8}\.css$/.test(f)), 'le fichier doit exister sur disque')
    // son URL reste dans la table (un `<@view css={…}>` calculé peut encore la nommer à
    // l'exécution) mais RIEN ne l'importe : aucune requête ne part tant que personne ne
    // la demande — c'est le sens même du mode
    assert.ok(!/import '[^']*mjs_style_oubliee/.test(readFileSync(p.manifest, 'utf-8')), 'aucun import ne doit la charger')
    assert.ok(lazyTable(p.manifest)!['oubliee'], 'son URL reste résolvable par nom, au cas où une vue la réclame')
    assert.ok(stats.warnings.some(w => /oubliee/.test(w) && /jamais/i.test(w)), `une information de build doit la nommer :\n${stats.warnings.join('\n')}`)

    await bundler.close()
  })

  // DÉFAUT TROUVÉ : `dark-theme` et `dark_theme` se
  // réduisent au MÊME nom de fichier une fois normalisés, et le fichier écrit est le CSS
  // NU (sans le nom dedans, contrairement au module JS de 'split') — deux contenus
  // identiques donnaient donc le même hachage, donc la même URL pour deux noms. Le second
  // nom n'obtenait jamais sa feuille, en silence : le composant s'affichait nu, pour
  // toujours, sans un mot.
  it('deux noms de feuille qui se normalisent pareil obtiennent des URL DISTINCTES', async function () {
    const p = makeProject('lazy-collision')
    writeFileSync(join(p.stylesDir, 'dark-theme.sass'), '.x\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'dark_theme.sass'), '.x\n  color: red\n')
    writeFileSync(join(p.srcDir, 'comp-a.mjs'), '<style @css="dark-theme"></style>\n\n<div class="x">a</div>')
    writeFileSync(join(p.srcDir, 'comp-b.mjs'), '<style @css="dark_theme"></style>\n\n<div class="x">b</div>')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const table = lazyTable(p.manifest)!
    assert.ok(table['dark-theme'] && table['dark_theme'], `les deux noms doivent être publiés : ${JSON.stringify(table)}`)
    assert.notEqual(table['dark-theme'], table['dark_theme'], `deux noms distincts ne doivent JAMAIS partager une URL :\n${JSON.stringify(table, null, 2)}`)

    await bundler.close()
  })

  it("le mode par défaut ('bundle') reste byte-identique — aucune régression collatérale", async function () {
    const build = async (css: 'bundle' | undefined) => {
      const p = makeProject('lazy-nonregression')
      writeFileSync(join(p.stylesDir, 'theme.sass'), '.card\n  color: teal\n')
      writeFileSync(join(p.srcDir, 'comp.mjs'), '<style @css="theme"></style>\n\n<div class="card">x</div>')
      const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, ...(css ? { css } : {}) })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const sortie = readdirSync(p.outDir).map(f => f.replace(/-[a-f0-9]{8}\./, '-<hash>.')).sort()
      await bundler.close()
      return { manifest: readFileSync(p.manifest, 'utf-8').replace(/[a-f0-9]{8}/g, '<hash>'), sortie }
    }
    const sansCle = await build(undefined)
    const bundle  = await build('bundle')
    assert.deepEqual(bundle.sortie, sansCle.sortie)
    assert.equal(bundle.manifest, sansCle.manifest)
    assert.ok(sansCle.sortie.some(f => /^mjs_styles-<hash>\.js$/.test(f)), `le mode bundle doit toujours écrire son bundle unique : ${sansCle.sortie.join(', ')}`)
  })
})

// ---------------------------------------------------------------------------
// Volet RUNTIME — le composant va chercher sa feuille au montage, une seule fois.
// ---------------------------------------------------------------------------

const COMPONENT_LAZY = [
  '<p class="t">salut</p>',
  '<style @css="theme">',
  '  .t',
  '    color: red',
  '</style>',
].join('\n')

// même feuille différée + un variant de mise en page déclaré (servi par un satellite `.large.css`)
const COMPONENT_LAZY_VARIANT = [
  '<p class="t">salut</p>',
  '<style @css="theme">',
  '  .t',
  '    color: red',
  '</style>',
  '<style name="large">',
  '  .t',
  '    font-size: 2em',
  '</style>'
].join('\n')

/** Compile un projet en mode lazy, charge core + composant + la table µ._cssLazy dans une
 *  Window happy-dom fraîche, avec `fetch` stubé et compté. */
async function loadLazyHarness(extraComponents: Record<string, string> = {}) {
  const p = makeProject('lazy-rt')
  writeFileSync(join(p.stylesDir, 'theme.sass'), '.t\n  font-weight: bold\n')
  writeFileSync(join(p.srcDir, 'lazy-demo.mjs'), COMPONENT_LAZY)
  for (const [nom, src] of Object.entries(extraComponents)) writeFileSync(join(p.srcDir, `${nom}.mjs`), src)

  const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir, css: 'lazy' })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const fetchCalls: string[] = []
  let fetchImpl: (url: string) => Promise<any> = async () => ({ ok: true, status: 200, text: async () => '.t{font-weight:bold}' })
  window.fetch = (url: string) => { fetchCalls.push(url); return fetchImpl(url) }

  const files    = readdirSync(p.outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  const sources  = [stripEsm(readFileSync(join(p.outDir, coreFile), 'utf-8')), 'globalThis.µ = µ;']
  // la table paresseuse vient du MANIFESTE RÉEL (stripEsm jette ses imports) : c'est elle
  // qui pilote le runtime, on ne la fabrique pas à la main. `.trim()` : cascade de modules,
  // la ligne vit désormais dans le corps indenté du `.then()` (cf. writeManifest).
  const lazyLine = readFileSync(p.manifest, 'utf-8').split('\n').find(l => l.trim().startsWith('µ._cssLazy = '))!
  assert.ok(lazyLine, 'le manifeste doit publier µ._cssLazy')
  sources.push(lazyLine)
  for (const nom of ['lazy-demo', ...Object.keys(extraComponents)]) {
    const f = files.find((x: string) => new RegExp(`^${nom}-[a-f0-9]{8}\\.js$`).test(x))!
    assert.ok(f, `sortie du build inattendue pour ${nom} : ${files.join(', ')}`)
    sources.push(stripEsm(readFileSync(join(p.outDir, f), 'utf-8')))
  }
  window.eval(sources.join('\n'))

  const warned: string[] = []
  window.µ.warn = (...args: any[]) => { warned.push(args.join(' ')) }

  return { window, document, fetchCalls, warned, outDir: p.outDir, setFetch(impl: (url: string) => Promise<any>) { fetchImpl = impl } }
}

describe("mjs_element — css: 'lazy' au montage", function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('un composant qui déclare une feuille va la chercher UNE fois et l\'adopte', async () => {
    const { document, fetchCalls, window } = await loadLazyHarness()
    document.body.innerHTML = '<mjs-lazy-demo></mjs-lazy-demo>'
    await new Promise(r => setTimeout(r, 120))

    assert.equal(fetchCalls.length, 1, `une seule requête attendue : ${fetchCalls.join(', ')}`)
    assert.match(fetchCalls[0], /mjs_style_theme-[a-f0-9]{8}\.css$/)
    assert.ok(window.µ.CSS['theme'], 'la feuille doit être posée dans le registre µ.CSS')
    const el: any = document.body.firstElementChild
    assert.ok(el._shadow.adoptedStyleSheets.includes(window.µ.CSS['theme']), 'la feuille doit être adoptée dans le shadow du composant')
  })

  it('dix composants qui déclarent la même feuille : toujours UNE seule requête', async () => {
    const { document, fetchCalls } = await loadLazyHarness()
    document.body.innerHTML = Array.from({ length: 10 }, () => '<mjs-lazy-demo></mjs-lazy-demo>').join('')
    await new Promise(r => setTimeout(r, 150))
    assert.equal(fetchCalls.length, 1, `le cache par URL doit dédoublonner : ${fetchCalls.length} requêtes`)
  })

  it("le composant reste caché ([mjs-loading]) tant que sa feuille n'est pas là", async () => {
    let relacher: (v: any) => void = () => {}
    const attente = new Promise(r => { relacher = r })
    const { document, setFetch } = await loadLazyHarness()
    setFetch(async () => { await attente; return { ok: true, status: 200, text: async () => '.t{font-weight:bold}' } })

    document.body.innerHTML = '<mjs-lazy-demo></mjs-lazy-demo>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))
    assert.ok(el.hasAttribute('mjs-loading'), 'le composant doit rester masqué pendant le chargement de sa feuille')

    relacher(null)
    await new Promise(r => setTimeout(r, 80))
    assert.ok(!el.hasAttribute('mjs-loading'), 'et réapparaître une fois la feuille adoptée')
  })

  // le moteur de rendu `browser` pose `µ.server = true` mais PAS `µ._isServer` (il monte
  // pour de vrai). Sans ce garde, un vrai Chromium irait chercher la feuille pendant le
  // prérendu et retiendrait [mjs-loading] : le HTML capturé pourrait embarquer des
  // composants encore masqués — une page prérendue invisible jusqu'à l'hydratation.
  it('au rendu serveur (µ.server), AUCUNE requête ne part et le composant ne reste pas masqué', async () => {
    const { document, fetchCalls, window } = await loadLazyHarness()
    window.µ.server = true
    document.body.innerHTML = '<mjs-lazy-demo></mjs-lazy-demo>'
    await new Promise(r => setTimeout(r, 120))
    assert.equal(fetchCalls.length, 0, `aucune requête attendue au rendu serveur : ${fetchCalls.join(', ')}`)
    const el: any = document.body.firstElementChild
    assert.ok(!el.hasAttribute('mjs-loading'), 'le composant ne doit pas rester masqué dans le HTML rendu')
  })

  // bascules demandées PENDANT l'attente de la feuille différée : à la reprise, seule la dernière
  // demande continue — un appel périmé ne réadopte rien et ne va surtout pas chercher le satellite
  // du variant qu'il visait
  it('bascule de variant PENDANT le chargement de la feuille : la dernière demande gagne, l\'appel périmé ne va rien chercher', async () => {
    let relacher: (v: any) => void = () => {}
    const attente = new Promise(r => { relacher = r })
    const { document, fetchCalls, setFetch } = await loadLazyHarness({ 'lazy-variant': COMPONENT_LAZY_VARIANT })
    setFetch(async (url: string) => {
      if (/mjs_style_theme/.test(url)) await attente
      return { ok: true, status: 200, text: async () => '.t{font-weight:bold}' }
    })
    document.body.innerHTML = '<mjs-lazy-variant></mjs-lazy-variant>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 30))
    el.setAttribute('layout', 'large')
    await new Promise(r => setTimeout(r, 30))
    el.setAttribute('layout', 'default')
    await new Promise(r => setTimeout(r, 30))
    assert.ok(el.hasAttribute('mjs-loading'), 'toujours masqué : la feuille n\'est pas encore là')

    relacher(null)
    await new Promise(r => setTimeout(r, 150))
    assert.equal(fetchCalls.filter(u => /\.large\.css/.test(u)).length, 0, `aucune requête du variant abandonné attendue : ${fetchCalls.join(', ')}`)
    assert.ok(!el.hasAttribute('mjs-loading'), 'le composant réapparaît habillé')
  })

  it('feuille introuvable (404) : un avertissement UNE fois, et le composant finit par s\'afficher', async () => {
    const { document, warned, setFetch } = await loadLazyHarness()
    setFetch(async () => ({ ok: false, status: 404 }))
    document.body.innerHTML = '<mjs-lazy-demo></mjs-lazy-demo><mjs-lazy-demo></mjs-lazy-demo>'
    await new Promise(r => setTimeout(r, 150))

    const el: any = document.body.firstElementChild
    assert.ok(!el.hasAttribute('mjs-loading'), 'un 404 ne doit pas laisser le composant invisible pour toujours')
    const plaintes = warned.filter(w => /introuvable/.test(w))
    assert.equal(plaintes.length, 1, `un seul avertissement par URL attendu : ${JSON.stringify(warned)}`)
    assert.match(plaintes[0], /theme/)
  })
})

// ---------------------------------------------------------------------------
// `µ._mjs_lazyCssWait(el, héritées)` — la seule chose que `_mjs_applyLayout` (mjs_element.ts) demande au
// mode paresseux : la promesse des feuilles à attendre, ou `null` quand il n'y a rien à attendre
// (et alors aucun `await` de plus dans `_mjs_applyLayout`). Source brute exécutée telle quelle.
// ---------------------------------------------------------------------------

describe('µ._mjs_lazyCssWait — ce que _mjs_applyLayout attend avant d\'adopter', function () {
  const LAZY_SRC = readFileSync(new URL('../src/runtime/mjs_lazy_css.ts', import.meta.url), 'utf-8')

  function makeMu(extra: any = {}) {
    const µ: any = { CSS: {}, warn() {}, ...extra }
    new Function('µ', LAZY_SRC)(µ)
    const demandes: string[] = []
    µ._mjs_fetchLazyCss = (name: string) => { demandes.push(name); return Promise.resolve(null) }
    return { µ, demandes }
  }

  it('sans table paresseuse (µ._cssLazy absent) : null, aucune requête', () => {
    const { µ, demandes } = makeMu()
    assert.equal(µ._mjs_lazyCssWait({ _mjs_sharedCss: ['theme'] }, ['vue']), null)
    assert.equal(demandes.length, 0)
  })

  it('au rendu serveur (µ.server comme µ._isServer) : null, aucune requête', () => {
    for (const drapeau of [{ server: true }, { _isServer: true }]) {
      const { µ, demandes } = makeMu({ _cssLazy: { theme: '/t.css' }, ...drapeau })
      assert.equal(µ._mjs_lazyCssWait({ _mjs_sharedCss: ['theme'] }, []), null, JSON.stringify(drapeau))
      assert.equal(demandes.length, 0)
    }
  })

  it('feuilles héritées puis déclarées, absentes du registre et connues de la table : une promesse, une requête chacune, dans cet ordre', async () => {
    const { µ, demandes } = makeMu({ _cssLazy: { vue: '/v.css', theme: '/t.css', deja: '/d.css' } })
    µ.CSS.deja = {}
    const attente = µ._mjs_lazyCssWait({ _mjs_sharedCss: ['theme', 'deja', 'inconnue'] }, ['vue'])
    assert.equal(attente instanceof Promise, true)
    assert.deepEqual(demandes, ['vue', 'theme'])
    assert.equal((await attente).length, 2)
  })

  it('tout déjà dans le registre ou inconnu de la table : null — rien à attendre', () => {
    const { µ, demandes } = makeMu({ _cssLazy: { theme: '/t.css' } })
    µ.CSS.theme = {}
    assert.equal(µ._mjs_lazyCssWait({ _mjs_sharedCss: ['theme', 'inconnue'] }, ['autre']), null)
    assert.equal(µ._mjs_lazyCssWait({}, []), null, 'composant sans aucune feuille partagée')
    assert.equal(demandes.length, 0)
  })
})
