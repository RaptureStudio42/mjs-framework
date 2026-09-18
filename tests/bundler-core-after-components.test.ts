// refonte « cœur après composants ». compile() compile désormais TOUTES les unités en mémoire d'abord
// (le cœur est INCONNU, `coreHashedPath` vide), déduit les briques du cœur du CODE COMPILÉ
// (collectUsedFeatures(), src/bundler/features.ts), construit le cœur, PUIS écrit composants/
// modules/manifeste externe en résolvant un REPÈRE provisoire (`-ZZZZZZZZ.`, même longueur
// qu'un vrai hash md5) vers le chemin réel. scanRuntimeFeatures() (balayage textuel de
// sourceDir) est supprimé — remplacé par la lecture des signaux dans les unités compilées.
//
// Patron repris de tests/bundler-detection-store-interpolate.test.ts (buildProject/
// coreContent, Bundler réel, artefact sur disque).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_FOR   = 'µ.Element.prototype._mjs_reconcileList = function'
const MARK_STORE = 'µ.Store = class Store'

function makeProject(prefix: string): { root: string; srcDir: string; outDir: string; manifestPath: string } {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir, manifestPath: join(root, 'bundle.js') }
}

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ root: string; outDir: string; manifestPath: string; bundler: Bundler; stats: any }> {
  const { root, srcDir, outDir, manifestPath } = makeProject('core-after-components')
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  return { root, outDir, manifestPath, bundler, stats }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

// aucun repère `-ZZZZZZZZ.` nulle part : ni dans un fichier de outputDir, ni dans bundle.js.
function assertNoPlaceholderAnywhere(outDir: string, manifestPath: string): void {
  for (const f of readdirSync(outDir)) {
    if (!/\.(js|css|json)$/.test(f)) continue
    const content = readFileSync(join(outDir, f), 'utf-8')
    assert.equal(content.includes('-ZZZZZZZZ.'), false, `${f} contient encore un repère non résolu`)
  }
  if (existsSync(manifestPath)) {
    const bundleJs = readFileSync(manifestPath, 'utf-8')
    assert.equal(bundleJs.includes('-ZZZZZZZZ.'), false, 'bundle.js contient encore un repère non résolu')
  }
}

// bundle.js ne référence (par chemin `/out/xxx-hash.ext`) que des fichiers qui EXISTENT
// réellement dans outDir.
function assertManifestReferencesExist(outDir: string, manifestPath: string): void {
  const bundleJs = readFileSync(manifestPath, 'utf-8')
  const names = new Set(readdirSync(outDir))
  const re = /\/out\/([a-zA-Z0-9_.-]+\.(?:js|css))/g
  let m: RegExpExecArray | null
  let count = 0
  while ((m = re.exec(bundleJs)) !== null) {
    count++
    assert.ok(names.has(m[1]), `bundle.js référence ${m[1]}, absent de outDir`)
  }
  assert.ok(count > 0, 'au moins une référence /out/... doit exister dans bundle.js pour que ce garde-fou ait un sens')
}

describe('compile() : le cœur se décide APRÈS les composants (code compilé, plus de scan texte)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('faux positif du balayage textuel CORRIGÉ : {for} en commentaire HTML + µ.Store en chaîne → NI mjs_for.ts NI mjs_store.ts', async function () {
    const src = [
      '<script lang="coffee">',
      '@doc = \'µ.Store\'',
      '</script>',
      '<!-- {for x in xs} -->',
      '<p>{@doc}</p>',
    ].join('\n')
    // runtime: [] — aucun optionnel (donc `flip` absent) : SANS ce réglage, `mjs_flip.ts`
    // (sélectionné par défaut) force `wantsFor` de toute façon (capture `_mjs_reconcileList` à son
    // chargement) et le test ne prouverait rien sur la détection de 'for' elle-même.
    const { outDir, stats } = await buildProject({ runtime: [] }, { 'hop.mjs': src })
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_FOR), false, 'un commentaire HTML ne doit plus embarquer mjs_for.ts')
    assert.equal(core.includes(MARK_STORE), false, 'une chaîne qui MENTIONNE µ.Store ne doit plus embarquer mjs_store.ts')
  })

  // non-régression : un VRAI usage reste détecté (jamais de faux négatif)
  it('vrai usage TOUJOURS détecté : {for x in xs} et new µStore(...) réels → mjs_for.ts ET mjs_store.ts présents', async function () {
    const src = [
      '<script lang="coffee">',
      '@xs = [1, 2, 3]',
      '@box = new µStore({a: 1})',
      '</script>',
      '{for x in @xs}<p>{x}{@box.data.a}</p>{end}',
    ].join('\n')
    // runtime: [] — même remarque que le test précédent : sans lui, `mjs_flip.ts` (par
    // défaut) force déjà 'for' tout seul, le test ne prouverait rien.
    const { outDir, stats } = await buildProject({ runtime: [] }, { 'hop.mjs': src })
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FOR), '{for} réel doit embarquer mjs_for.ts')
    assert.ok(core.includes(MARK_STORE), 'µStore réel doit embarquer mjs_store.ts')
  })

  // stabilité : deux compile() sans changement → mêmes fichiers, rien de réécrit
  it('deux compile() sans aucun changement : mêmes noms de fichiers, aucun repère, second tour tout en cache-hit', async function () {
    const { root, srcDir, outDir, manifestPath } = makeProject('stability')
    writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js' }))
    const found = findConfig(root)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    const bundler = new Bundler(opts as any)
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0)
    const filesAfter1 = new Set(readdirSync(outDir))
    assertNoPlaceholderAnywhere(outDir, manifestPath)

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0)
    const filesAfter2 = new Set(readdirSync(outDir))
    assert.deepEqual([...filesAfter1].sort(), [...filesAfter2].sort(), 'aucun fichier ne doit changer de nom entre deux compiles identiques')
    assertNoPlaceholderAnywhere(outDir, manifestPath)
  })

  // cache-hit périmé PAR LE CŒUR : composant A inchangé, B gagne un {for} entre les
  // deux tours → le cœur change → le fichier de A sur disque doit suivre le NOUVEAU cœur.
  it('cache-hit périmé par un changement du cœur : le composant INCHANGÉ réémet avec le NOUVEAU chemin du cœur', async function () {
    const { root, srcDir, outDir, manifestPath } = makeProject('stale-cache-core')
    writeFileSync(join(srcDir, 'a.mjs'), '<p>a inchangé</p>\n')
    writeFileSync(join(srcDir, 'b.mjs'), '<p>b</p>\n')
    // runtime: [] — sans lui, mjs_flip.ts (par défaut) force déjà 'for' au 1er tour, le cœur
    // ne changerait alors jamais entre les deux tours et le test ne prouverait rien.
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', runtime: [] }))
    const found = findConfig(root)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    const bundler = new Bundler(opts as any)

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
    const aFile1 = readdirSync(outDir).find((f) => /^a-/.test(f))!
    const coreFile1 = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!
    const aImport1 = readFileSync(join(outDir, aFile1), 'utf-8').match(/import\s*\{\s*µ\s*\}\s*from\s*'([^']+)'/)![1]
    assert.ok(aImport1.includes(coreFile1.replace(/\.js$/, '')), 'a importe bien le cœur du 1er tour')

    // B gagne un {for} → le cœur change (mjs_for.ts entre dans le bundle)
    writeFileSync(join(srcDir, 'b.mjs'), ['<script lang="coffee">', '@xs = [1]', '</script>', '{for x in @xs}<p>{x}</p>{end}'].join('\n'))
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))

    const coreFile2 = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))!
    assert.notEqual(coreFile1, coreFile2, 'le cœur doit changer de hash (mjs_for.ts en plus)')
    assert.equal(existsSync(join(outDir, coreFile1)), false, 'l\'ancien cœur doit avoir été nettoyé')

    const aFile2 = readdirSync(outDir).find((f) => /^a-/.test(f))!
    const aImport2 = readFileSync(join(outDir, aFile2), 'utf-8').match(/import\s*\{\s*µ\s*\}\s*from\s*'([^']+)'/)![1]
    assert.ok(aImport2.includes(coreFile2.replace(/\.js$/, '')), 'a (inchangé) doit réémettre avec le NOUVEAU chemin du cœur')
    assertNoPlaceholderAnywhere(outDir, manifestPath)
    assertManifestReferencesExist(outDir, manifestPath)
  })

  // dépendance module → composant, à travers un changement du cœur EN PLUS
  it('module @import-é par un composant : changer le module réémet le composant ; changer ENSUITE le cœur réémet module ET composant', async function () {
    const { root, srcDir, outDir, manifestPath } = makeProject('module-then-core')
    writeFileSync(join(srcDir, 'util.civet'), 'export triple := (x) -> x * 3\n')
    writeFileSync(join(srcDir, 'a.mjs'), ['@import triple \'util.civet\'', '<p>{triple(2)}</p>'].join('\n'))
    writeFileSync(join(srcDir, 'b.mjs'), '<p>b</p>\n')
    // runtime: [] — même remarque que le test précédent (isole la détection de 'for' de
    // mjs_flip.ts, sélectionné par défaut).
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', runtime: [] }))
    const found = findConfig(root)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    const bundler = new Bundler(opts as any)

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
    const util1 = readdirSync(outDir).find((f) => /^util-/.test(f))!

    // seul le module change
    writeFileSync(join(srcDir, 'util.civet'), 'export triple = (x) -> x * 30\n')
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
    const util2 = readdirSync(outDir).find((f) => /^util-/.test(f))!
    assert.notEqual(util1, util2, 'le module édité doit changer de hash')
    const a2 = readdirSync(outDir).find((f) => /^a-/.test(f))!
    const a2Content = readFileSync(join(outDir, a2), 'utf-8')
    assert.ok(a2Content.includes(util2.replace(/\.js$/, '')), 'a doit référencer le NOUVEAU chemin du module édité')

    // maintenant SEUL le cœur change (b gagne un {for})
    writeFileSync(join(srcDir, 'b.mjs'), ['<script lang="coffee">', '@xs = [1]', '</script>', '{for x in @xs}<p>{x}</p>{end}'].join('\n'))
    const stats3 = await bundler.compile()
    assert.equal(stats3.errors.length, 0, stats3.errors.map((e: any) => e.message).join('\n'))
    const util3 = readdirSync(outDir).find((f) => /^util-/.test(f))!
    const a3 = readdirSync(outDir).find((f) => /^a-/.test(f))!
    const a3Content = readFileSync(join(outDir, a3), 'utf-8')
    assert.ok(a3Content.includes(util3.replace(/\.js$/, '')), 'a doit référencer le chemin ACTUEL du module (réémis avec le nouveau cœur lui aussi)')
    assertNoPlaceholderAnywhere(outDir, manifestPath)
    assertManifestReferencesExist(outDir, manifestPath)
  })

  // échec d'une unité : les autres composants sont émis normalement, jamais de repère
  it('un composant en erreur de syntaxe : stats.errors non vide, bundle.js SANS repère, les autres composants émis normalement', async function () {
    const { outDir, manifestPath, stats } = await buildProject({}, {
      'bon.mjs': '<p>ok</p>\n',
      'casse.mjs': ['<script lang="coffee">', '@x = ((('  , '</script>', '<p>{@x}</p>'].join('\n'),
    })
    assert.ok(stats.errors.length > 0, 'le composant cassé doit produire une erreur')
    const bonFile = readdirSync(outDir).find((f) => /^bon-/.test(f))
    assert.ok(bonFile, 'le composant SAIN doit quand même être émis')
    assertNoPlaceholderAnywhere(outDir, manifestPath)
  })

  // mode split : composant qui déclare @css theme → chemin RÉEL de la feuille, pas un
  // repère ; changer la feuille seule réémet le composant (cache) avec le nouveau chemin.
  it('mode split : composant @css theme → chemin réel de la feuille split, jamais un repère ; feuille éditée seule → composant réémis', async function () {
    const root = mjsTmp('split-real-path')
    const srcDir = join(root, 'app/modularjs')
    const stylesDir = join(root, 'styles')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(stylesDir, 'theme.sass'), '.p\n  color: red\n')
    writeFileSync(join(srcDir, 'hop.mjs'), ['<style @css="theme"></style>', '<div>x</div>'].join('\n'))
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', stylesheetsDir: 'styles', css: 'split',
    }))
    const found = findConfig(root)
    const opts = resolveBundlerOpts(found!.config, found!.configDir)
    const bundler = new Bundler(opts as any)

    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map((e: any) => e.message).join('\n'))
    const theme1 = readdirSync(outDir).find((f) => /^mjs_style_theme-/.test(f))!
    assert.ok(theme1, 'la feuille split doit être émise')
    const hop1 = readdirSync(outDir).find((f) => /^hop-/.test(f))!
    const hop1Content = readFileSync(join(outDir, hop1), 'utf-8')
    assert.ok(hop1Content.includes(theme1.replace(/\.js$/, '')), 'hop doit importer le chemin RÉEL de la feuille, jamais un repère')
    assert.equal(hop1Content.includes('-ZZZZZZZZ.'), false)

    writeFileSync(join(stylesDir, 'theme.sass'), '.p\n  color: blue\n')
    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map((e: any) => e.message).join('\n'))
    const theme2 = readdirSync(outDir).find((f) => /^mjs_style_theme-/.test(f))!
    assert.notEqual(theme1, theme2, 'la feuille éditée doit changer de hash')
    const hop2 = readdirSync(outDir).find((f) => /^hop-/.test(f))!
    const hop2Content = readFileSync(join(outDir, hop2), 'utf-8')
    assert.ok(hop2Content.includes(theme2.replace(/\.js$/, '')), 'hop (cache) doit être réémis avec le NOUVEAU chemin de la feuille')
  })
})
