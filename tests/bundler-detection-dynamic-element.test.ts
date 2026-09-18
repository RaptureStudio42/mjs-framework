// mjs_dynamic.ts (<@element>/<@module> — balise/composant dynamiques µ._updDynEl/
// µ._updModule), RATTACHÉ D'OFFICE au cœur jusqu'ici, ne doit être embarqué QUE s'il sert —
// même règle que mjs_title.ts. Les deux macros émettent TOUJOURS un `µeffect =>` (jamais
// conditionnel, contrairement à <@head>/<@body>) : leur présence doit AUSSI forcer
// mjs_effect.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_DYNAMIC = 'µ._updDynEl = function'
const MARK_EFFECT  = 'µ.effect = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-dynamic')
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

describe('mjs_dynamic.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS <@element>/<@module> : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_DYNAMIC), false)
  })

  it('composant avec <@element $tag>...</@element> : PRÉSENT, et mjs_effect.ts AUSSI', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@tag = \'div\'', '</script>', '<@element $tag>x</@element>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_DYNAMIC), '<@element> doit être détecté')
    assert.ok(core.includes(MARK_EFFECT), '<@element> émet toujours son propre µeffect => en silence')
  })

  it('composant avec <@module $comp>...</@module> (balise sœur) : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@comp = \'my-comp\'', '</script>', '<@module $comp>x</@module>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_DYNAMIC))
  })

  it("runtime:['dynamic'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['dynamic'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_DYNAMIC))
  })
})
