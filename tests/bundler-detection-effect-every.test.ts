// mjs_effect.ts (µeffect) et mjs_every.ts (µevery), RATTACHÉS D'OFFICE au cœur jusqu'ici,
// ne doivent être embarqués QUE s'ils servent — même règle que mjs_title.ts. `µeffect` a
// TROIS émetteurs INDIRECTS qui ne laissent jamais le mot « effect » dans le source du
// projet : `@persist` (transpiler/directives.ts), `µdebug $x` (transpiler/index.ts) et
// `<@window scrollX|scrollY=!{...}>` (liaison two-way, transpiler/macros.ts) — vérifiés
// appelant par appelant, aucun autre. `µevery` n'a AUCUN émetteur indirect.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_EFFECT = 'µ.effect = function'
const MARK_EVERY  = 'µ.every = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-effect-every')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { outDir }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('mjs_effect.ts / mjs_every.ts — détachés du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucun signal : les deux ABSENTS', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_EFFECT), false)
    assert.equal(core.includes(MARK_EVERY), false)
  })

  it('µeffect direct (forme bare) : mjs_effect.ts présent, mjs_every.ts ABSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@x = 1', 'µeffect -> console.log($x)', '</script>', '<p>{$x}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EFFECT))
    assert.equal(core.includes(MARK_EVERY), false)
  })

  it('µevery direct : mjs_every.ts présent, mjs_effect.ts ABSENT (aucun émetteur indirect)', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@x = 1', 'µevery 1000, -> @x++', '</script>', '<p>{$x}</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EVERY))
    assert.equal(core.includes(MARK_EFFECT), false, 'µevery seul ne doit jamais forcer mjs_effect.ts')
  })

  it('@persist $x (jamais le mot « effect » dans le source) : mjs_effect.ts présent', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script>$x = 1</script>', '@persist $x', '<p>{$x}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_EFFECT))
  })

  it('µdebug $x (jamais le mot « effect » dans le source) : mjs_effect.ts présent', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@x = 1', 'µdebug $x', '</script>', '<p>{$x}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_EFFECT))
  })

  it('<@window scrollY=!{$y}/> (liaison two-way, jamais le mot « effect » dans le source) : mjs_effect.ts présent', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@y = 0', '</script>', '<@window scrollY=!{$y}/>', '<p>{$y}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_EFFECT))
  })

  it("runtime:['effect'] et runtime:['every'] sans usage : présents quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['effect', 'every'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EFFECT))
    assert.ok(core.includes(MARK_EVERY))
  })
})
