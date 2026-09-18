// mjs_theme.ts — le thème clair/sombre embarqué
// (`µ._mjs_themeSheet`/`µ._mjs_themeAppSheet`/`µ._themeAdopt`, 8 variables `--mjs-surface`/`--mjs-fg`/
// `--mjs-fg-muted`/`--mjs-border`/`--mjs-hover`/`--mjs-selected`/`--mjs-accent`/`--mjs-shadow`)
// N'EST PLUS rattaché d'office au cœur : embarqué seulement si une source le lit (`var(--mjs-…)`
// ou `$$nom` résolu vers l'une des 8 variables canoniques, ou `µtheme`), si le projet a un
// fichier `*.theme.mjs`, ou si un consommateur du framework est sélectionné.
//
// Consommateurs RÉELS (vérifiés par grep `var\(--mjs-` dans src/runtime/*.ts, PAS la liste
// candidate de la conception) : mjs_modal.ts (--mjs-border/fg/fg-muted/hover/shadow/surface) et
// mjs_title.ts (--mjs-border) lisent VRAIMENT l'une des 8 variables canoniques. mjs_page_cache.ts
// (--mjs-route-error-*), mjs_vt_presets.ts (--mjs-vtc-r) et mjs_devpanel.ts (--mjs-devpanel-h,
// dans un COMMENTAIRE seulement) ont chacun leur PROPRE espace `--mjs-<module>-*` — aucun des
// trois ne lit une variable canonique : ÉCARTÉS de la liste des consommateurs.
//
// Builds RÉELS (même patron que tests/bundler-detection-title-vt.test.ts) : preuve sur le bundle
// mjs_core-*.js produit, pas sur la liste de fichiers de resolveRuntimeFiles() (déjà couverte
// par tests/bundler-runtime-selection.test.ts).
//
// Marqueur `'_mjs_themeSheet = new CSSStyleSheet()'` (DÉFINITION, 1re instruction du bloc déplacé) :
// aucune garde défensive ailleurs ne mentionne cette forme précise (contrairement à
// `_mjs_titleAttach`, gardé `typeof … === 'function'` par mjs_element.ts), pas de faux positif
// possible côté cœur.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const THEME_MARKER = '_mjs_themeSheet = new CSSStyleSheet()'

// jumeau de buildProject()/coreContent() de tests/bundler-detection-title-vt.test.ts.
async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ root: string; outDir: string; manifestPath: string }> {
  const root = mjsTmp('detect-theme')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(srcDir, name), content)
  }
  const manifestPath = join(root, 'bundle.js')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { root, outDir, manifestPath }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('mjs_theme.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  // `runtime: 'core'` (aucun optionnel classique, donc aucun 'modal') — la config DÉFAUT
  // (`runtime` absent) inclut déjà TOUS les optionnels classiques (dont 'modal', consommateur
  // du thème, cf. bandeau) : un projet nu SANS restriction de runtime EMBARQUE donc le thème,
  // même sans aucun usage — attendu, même comportement historique que 'all'.
  it("runtime:'core' sans aucun usage (cas du banc js-framework-benchmark) : ABSENT du cœur", async () => {
    const { outDir } = await buildProject({ runtime: 'core' }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(THEME_MARKER), false)
  })

  it('var(--mjs-fg) écrit en dur dans le <style> : présent', async () => {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<style>\n:host\n  color: var(--mjs-fg)\n</style>\n<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it('$$surface lu dans le <style> : présent', async () => {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<style>\n:host\n  background: $$surface\n</style>\n<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it("µtheme = 'dark' : présent", async () => {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<button @click={µtheme = \'dark\'}>x</button>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it('fichier gold.theme.mjs dans le projet (aucun composant n\'en a besoin) : présent', async () => {
    const { outDir } = await buildProject({}, {
      'hop.mjs': '<p>x</p>\n',
      'gold.theme.mjs': '<theme>\n  $$brand: gold\n</theme>\n',
    })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it("runtime:['title'] sans aucun usage : présent (mjs_title.ts lit var(--mjs-border), consommateur)", async () => {
    const { outDir } = await buildProject({ runtime: ['title'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it("runtime:['modal'] sans aucun usage : présent (mjs_modal.ts lit --mjs-fg/--mjs-surface/…, consommateur)", async () => {
    const { outDir } = await buildProject({ runtime: ['modal'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })

  it("runtime:['router'] SEUL, sans title/modal ni usage : ABSENT (router/vt_presets/page_cache ne lisent aucune variable canonique)", async () => {
    const { outDir } = await buildProject({ runtime: ['router'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(THEME_MARKER), false)
  })

  it("runtime:['theme'] sans aucun usage : présent (explicite gagne)", async () => {
    const { outDir } = await buildProject({ runtime: ['theme'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(THEME_MARKER))
  })
})

describe('mjs_theme.ts — montage happy-dom', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")

  async function mountHarness(cfgExtra: any, componentSrc: string): Promise<{ window: any; document: any; µ: any }> {
    const { outDir } = await buildProject(cfgExtra, { 'hop.mjs': componentSrc })
    const files = readdirSync(outDir)
    const coreFile = files.find((f) => /^mjs_core-/.test(f))!
    const compFile = files.find((f) => /^hop-/.test(f))!
    const window: any = new Window({ url: 'http://localhost/' })
    window.eval([
      stripEsm(readFileSync(join(outDir, coreFile), 'utf-8')),
      'globalThis.µ = µ;',
      stripEsm(readFileSync(join(outDir, compFile), 'utf-8')),
    ].join('\n'))
    return { window, document: window.document, µ: window.µ }
  }

  it('composant SANS thème (runtime router seul) : montage sans erreur', async () => {
    const { window, document } = await mountHarness({ runtime: ['router'] }, '<p>x</p>\n')
    assert.doesNotThrow(() => { document.body.innerHTML = '<mjs-hop></mjs-hop>' })
    assert.equal(window.µ._mjs_themeSheet, undefined, 'mjs_theme.ts absent : aucune feuille de thème posée')
  })

  it('composant AVEC thème : document.adoptedStyleSheets porte les deux feuilles (framework + application)', async () => {
    const { window, document, µ } = await mountHarness({}, '<style>\n:host\n  color: var(--mjs-fg)\n</style>\n<p>x</p>\n')
    document.body.innerHTML = '<mjs-hop></mjs-hop>'
    assert.ok(µ._mjs_themeSheet, 'la feuille de thème du framework doit exister au boot')
    assert.ok(µ._mjs_themeAppSheet, "la feuille de thème de l'application doit exister au boot, même vide")
    assert.ok(document.adoptedStyleSheets.includes(µ._mjs_themeSheet))
    assert.ok(document.adoptedStyleSheets.includes(µ._mjs_themeAppSheet))
  })
})
