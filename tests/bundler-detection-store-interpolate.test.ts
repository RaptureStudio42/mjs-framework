// mjs_store.ts et mjs_interpolate.ts, RATTACHÉS D'OFFICE au
// cœur jusqu'ici, ne doivent être embarqués QUE s'ils servent — même règle que mjs_title.ts
// (cf. tests/bundler-detection-title-vt.test.ts) : DÉTECTÉS à l'usage, scan textuel de
// sourceDir. Symboles reconnus, dans les DEUX sigils configurables (cf. src/sigils.ts,
// MU_PASCAL_BODY/MU_SHORT_GLOBALS/normalizeSigilAlias) : `µStore`/`µ.Store`/`mjs.Store` (classe),
// `µinterpolate`/`µ.interpolate`/`mjs.interpolate` (fabrique).
//
// Builds RÉELS (même patron que tests/bundler-detection-title-vt.test.ts) : preuve sur le
// bundle mjs_core-*.js produit, pas sur la liste de fichiers de resolveRuntimeFiles() (déjà
// couverte par tests/bundler-runtime-selection.test.ts).
//
// Marqueurs `'µ.Store = class Store'` et `'µ.interpolate = function'` (DÉFINITION), jamais un
// simple nom seul : aucun autre module du cœur ne les définit, donc leur présence dans le bundle
// prouve directement l'inclusion du fichier — même exigence que `_mjs_titleAttach = function` pour
// mjs_title.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_STORE       = 'µ.Store = class Store'
const MARK_INTERPOLATE = 'µ.interpolate = function'

// Même patron que buildProject()/coreContent() de tests/bundler-detection-title-vt.test.ts.
async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ root: string; outDir: string; manifestPath: string }> {
  const root = mjsTmp('detect-store-interp')
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

describe('mjs_store.ts / mjs_interpolate.ts — détachés du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucun usage : les deux ABSENTS', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_STORE), false, 'aucune source ne pose µStore : mjs_store.ts ne doit pas être bundlé')
    assert.equal(core.includes(MARK_INTERPOLATE), false, 'aucune source ne pose µinterpolate : mjs_interpolate.ts ne doit pas être bundlé')
  })

  it("runtime:'core' sans usage : les deux ABSENTS (cas du banc js-framework-benchmark)", async function () {
    const { outDir } = await buildProject({ runtime: 'core' }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_STORE), false)
    assert.equal(core.includes(MARK_INTERPOLATE), false)
  })

  it('API directe minimalRuntime:true sans usage : les deux ABSENTS (même résultat que runtime:"core")', async function () {
    const root = mjsTmp('detect-store-interp-api')
    const srcDir = join(root, 'app/modularjs')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), minimalRuntime: true })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_STORE), false)
    assert.equal(core.includes(MARK_INTERPOLATE), false)
  })

  it("composant avec `@box = new µStore({a: 1})` (forme bare) : mjs_store.ts présent, mjs_interpolate.ts ABSENT", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@box = new µStore({a: 1})', '</script>', '<p>{@box.data.a}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE), 'µStore (forme bare) doit être détecté')
    assert.equal(core.includes(MARK_INTERPOLATE), false, 'aucun usage de µinterpolate ici')
  })

  it("composant avec `const s = new µ.Store({a: 1})` (forme pointée) : présent", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@box = new µ.Store({a: 1})', '</script>', '<p>{@box.data.a}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE), 'µ.Store (forme pointée) doit être détecté')
  })

  it("composant avec `mjs.Store` (sigil ASCII, config sigil:'mjs') : présent", async function () {
    const { outDir } = await buildProject({ sigil: 'mjs' }, {
      'hop.mjs': ['<script lang="coffee">', '@box = new mjs.Store({a: 1})', '</script>', '<p>{@box.data.a}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE), 'mjs.Store (sigil ASCII) doit être détecté')
  })

  it("détection via un module .civet autonome (`new µStore(...)`), aucun .mjs qui l'utilise : présent", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs':     '<p>x</p>\n',
      'outil.civet': "export creerStore = ->\n  new µStore({a: 1})\n",
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE), 'un usage posé depuis un .civet doit être détecté')
  })

  it("runtime:['store'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['store'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE))
    assert.equal(core.includes(MARK_INTERPOLATE), false)
  })

  it("composant avec `$progress = µinterpolate(0, 400)` (forme bare) : mjs_interpolate.ts présent, mjs_store.ts ABSENT", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '$progress = µinterpolate(0, 400)', '</script>', '<p>{$progress}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_INTERPOLATE), 'µinterpolate (forme bare) doit être détecté')
    assert.equal(core.includes(MARK_STORE), false, 'aucun usage de µStore ici')
  })

  it("composant avec `µ.interpolate` (forme pointée) : présent", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '$progress = µ.interpolate(0, 400)', '</script>', '<p>{$progress}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_INTERPOLATE), 'µ.interpolate (forme pointée) doit être détecté')
  })

  it("composant avec `mjs.interpolate` (sigil ASCII, config sigil:'mjs') : présent", async function () {
    const { outDir } = await buildProject({ sigil: 'mjs' }, {
      'hop.mjs': ['<script lang="coffee">', '$progress = mjs.interpolate(0, 400)', '</script>', '<p>{$progress}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_INTERPOLATE), 'mjs.interpolate (sigil ASCII) doit être détecté')
  })

  it("détection interpolate via un module .civet autonome, aucun .mjs qui l'utilise : présent", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs':     '<p>x</p>\n',
      'outil.civet': "export creerTween = ->\n  µinterpolate(0, 400)\n",
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_INTERPOLATE), 'un usage posé depuis un .civet doit être détecté')
  })

  it("runtime:['interpolate'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['interpolate'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_INTERPOLATE))
    assert.equal(core.includes(MARK_STORE), false)
  })

  it('les deux ensemble : chacun détecté indépendamment de l\'autre', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': [
        '<script lang="coffee">', '@box = new µStore({a: 1})', '$progress = µinterpolate(0, 400)', '</script>',
        '<p>{@box.data.a}{$progress}</p>',
      ].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_STORE))
    assert.ok(core.includes(MARK_INTERPOLATE))
  })
})

describe('mjs_store.ts / mjs_interpolate.ts — garde anti-angle-mort : les modules cœur n\'en dépendent pas', () => {
  // collectUsedFeatures() lit le CODE COMPILÉ de chaque unité (composants, modules
  // cœur transitivement référencés via <@nom>) : un module cœur adoptant µStore/µinterpolate
  // serait détecté DÈS qu'il est réellement compilé (référencé au moins une fois) — plus
  // d'angle mort dans ce cas (même remarque que mjs_title.ts). Ce test garde une hypothèse
  // INDÉPENDANTE : aucun module cœur n'adopte ces symboles aujourd'hui. Si elle casse un
  // jour, la détection suit automatiquement via la compilation du module concerné.
  function listMjsRecursive(dir: string): string[] {
    const out: string[] = []
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, entry.name)
      if (entry.isDirectory()) out.push(...listMjsRecursive(p))
      else if (entry.name.endsWith('.mjs')) out.push(p)
    }
    return out
  }

  it('aucun fichier de src/core-modules/ (récursif, .mjs) ne matche les regex de détection Store/interpolate', () => {
    const b = new Bundler({})
    const REGEX_STORE       = /µ\.?Store(?![a-zA-Z0-9_])|mjs\.Store(?![a-zA-Z0-9_])/
    const REGEX_INTERPOLATE = /µ\.?interpolate(?![a-zA-Z0-9_])|mjs\.interpolate(?![a-zA-Z0-9_])/
    const files = listMjsRecursive(b.coreModulesDir)
    const offendersStore = files.filter((f) => REGEX_STORE.test(readFileSync(f, 'utf-8')))
    const offendersInterp = files.filter((f) => REGEX_INTERPOLATE.test(readFileSync(f, 'utf-8')))
    assert.deepEqual(offendersStore, [], 'un module cœur qui adopte µStore serait détecté dès sa compilation réelle (cf. collectUsedFeatures) — cette garde documente juste qu\'aucun ne le fait aujourd\'hui')
    assert.deepEqual(offendersInterp, [], 'un module cœur qui adopte µinterpolate serait détecté dès sa compilation réelle (cf. collectUsedFeatures) — cette garde documente juste qu\'aucun ne le fait aujourd\'hui')
  })
})
