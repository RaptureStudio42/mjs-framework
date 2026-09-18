// mjs_title.ts et mjs_vt_presets.ts, RATTACHÉS D'OFFICE au
// cœur jusqu'ici, ne doivent être embarqués QUE s'ils servent :
//   - mjs_vt_presets.ts : règle de CONFIGURATION pure (si 'router' OU 'ujs' sélectionné, ou
//     demandé explicitement) — AUCUN scan.
//   - mjs_title.ts : DÉTECTÉ à l'usage — scan textuel de sourceDir (@title=/mjs-title), ou
//     demandé explicitement (`runtime: [..., 'title']`).
// Builds RÉELS (même patron que tests/mjs-modal-bundler-integration.test.ts) : preuve sur le
// bundle mjs_core-*.js produit, pas sur la liste de fichiers de resolveRuntimeFiles() (déjà
// couverte par tests/bundler-runtime-selection.test.ts).
//
// Marqueur `'_mjs_titleAttach = function'` (DÉFINITION), jamais juste `'_mjs_titleAttach'` : mjs_element.ts
// (module du CŒUR, toujours présent) contient une garde défensive `typeof µ._mjs_titleAttach ===
// 'function'` — le simple nom apparaît donc dans TOUT bundle, avec ou sans mjs_title.ts. Même
// raisonnement pour `'_mjs_vtApplyPreset = function'` (mjs_router.ts/mjs_ujs.ts ne font que
// l'APPELER, jamais le définir) — moins critique ici (les deux restent optionnels), gardé par
// cohérence.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

// Même patron que buildProject()/coreContent() de tests/mjs-modal-bundler-integration.test.ts,
// généralisé à un JEU de fichiers sources (composant .mjs et/ou module .civet autonome) au lieu
// d'un composant fixe unique — chaque cas ci-dessous a besoin d'un source différent.
async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ root: string; outDir: string; manifestPath: string }> {
  const root = mjsTmp('detect-title-vt')
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

describe('mjs_title.ts / mjs_vt_presets.ts — détachés du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant avec @title="aide", runtime par défaut : _mjs_titleAttach présent', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p @title="aide">x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_titleAttach = function'), '_mjs_titleAttach doit être bundlé dès qu\'une source pose @title')
  })

  it("composant SANS @title, runtime par défaut : _mjs_titleAttach ABSENT, _mjs_vtApplyPreset présent (router+ujs dans 'all')", async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes('_mjs_titleAttach = function'), false, 'aucune source ne pose @title : _mjs_titleAttach ne doit pas être bundlé')
    assert.ok(core.includes('_mjs_vtApplyPreset = function'), "'all' embarque router+ujs → mjs_vt_presets.ts doit suivre")
  })

  it("runtime:'core' sans @title : les deux ABSENTS (cas du banc js-framework-benchmark)", async function () {
    const { outDir } = await buildProject({ runtime: 'core' }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes('_mjs_titleAttach = function'), false)
    assert.equal(core.includes('_mjs_vtApplyPreset = function'), false)
  })

  it('API directe minimalRuntime:true sans @title : les deux ABSENTS (même résultat que runtime:"core")', async function () {
    const root = mjsTmp('detect-title-vt-api')
    const srcDir = join(root, 'app/modularjs')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), minimalRuntime: true })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const core = coreContent(outDir)
    assert.equal(core.includes('_mjs_titleAttach = function'), false)
    assert.equal(core.includes('_mjs_vtApplyPreset = function'), false)
  })

  it("runtime:['modal'] : _mjs_vtApplyPreset absent (ni router ni ujs)", async function () {
    const { outDir } = await buildProject({ runtime: ['modal'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes('_mjs_vtApplyPreset = function'), false)
  })

  it("runtime:['router'] : _mjs_vtApplyPreset présent", async function () {
    const { outDir } = await buildProject({ runtime: ['router'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_vtApplyPreset = function'))
  })

  it("runtime:['title'] sans @title dans les sources : _mjs_titleAttach présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['title'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_titleAttach = function'))
  })

  it("runtime:['vt_presets'] : _mjs_vtApplyPreset présent (explicite, sans router ni ujs)", async function () {
    const { outDir } = await buildProject({ runtime: ['vt_presets'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_vtApplyPreset = function'))
  })

  it("détection via un module .civet autonome (el.setAttribute('mjs-title', …)), aucun .mjs avec @title : _mjs_titleAttach présent", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs':     '<p>x</p>\n',
      'outil.civet': "export poserTitre = (el) ->\n  el.setAttribute('mjs-title', 'x')\n",
    })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_titleAttach = function'), "un attribut mjs-title posé en JS depuis un .civet doit être détecté")
  })

  it('détection via @title={{ $html }} (forme HTML réactive) : _mjs_titleAttach présent', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': '<script>\n$html = \'<b>x</b>\'\n</script>\n<p @title={{ $html }}>x</p>\n',
    })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_titleAttach = function'))
  })

  it('détection via mjs-title="x" écrit en dur (attribut compilé posé à la main) : _mjs_titleAttach présent', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p mjs-title="x">x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('_mjs_titleAttach = function'))
  })
})

describe('mjs_title.ts — garde anti-angle-mort : les modules cœur ne posent pas @title', () => {
  // collectUsedFeatures() lit le CODE COMPILÉ de chaque unité (composants, modules
  // cœur transitivement référencés via <@nom>, cf. resolveTagShortcuts) : un module cœur
  // adoptant @title serait donc détecté DÈS qu'il est réellement compilé (référencé au moins
  // une fois) — plus d'angle mort dans ce cas. Ce test garde une hypothèse INDÉPENDANTE :
  // aucun module cœur n'adopte @title lui-même aujourd'hui. Si elle casse un jour (un module
  // cœur RÉFÉRENCÉ pose @title), la détection suit automatiquement via sa propre compilation
  // — comportement normal, pas un angle mort à combler.
  function listMjsRecursive(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...listMjsRecursive(p))
      else if (entry.name.endsWith('.mjs')) out.push(p)
    }
    return out
  }

  it('aucun fichier de src/core-modules/ (récursif, .mjs) ne matche la regex de détection @title/mjs-title', () => {
    const b = new Bundler({})
    const REGEX_TITLE = /(^|[\s"'`(])@title\s*=|mjs-title/
    const offenders = listMjsRecursive(b.coreModulesDir).filter((f) => REGEX_TITLE.test(readFileSync(f, 'utf-8')))
    assert.deepEqual(offenders, [], 'un module cœur qui adopte @title serait détecté dès sa compilation réelle (cf. collectUsedFeatures) — cette garde documente juste qu\'aucun ne le fait aujourd\'hui')
  })
})
