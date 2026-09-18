// mjs_body.ts (<@body>/<@html> — liaisons class/style globales µ._glCl/µ._glSt), RATTACHÉ
// D'OFFICE au cœur jusqu'ici, ne doit être embarqué QUE s'il sert — même règle que
// mjs_title.ts. Une liaison dynamique (`@class{...}`/`@style.*`/`--var={...}`) émet elle-même
// un `µeffect =>` (transpiler/macros.ts) : sa présence doit AUSSI forcer mjs_effect.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_BODY   = 'µ._glCl = function'
const MARK_EFFECT = 'µ.effect = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-body')
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

describe('mjs_body.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS <@body>/<@html> : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_BODY), false)
  })

  it("composant avec <@body @class{$actif}=\"vif\"/> : PRÉSENT, et mjs_effect.ts AUSSI", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@actif = true', '</script>', '<@body @class{@actif}="vif"/>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_BODY), '<@body> doit être détecté')
    assert.ok(core.includes(MARK_EFFECT), '<@body> avec liaison de classe émet son propre µeffect => en silence')
  })

  it('composant avec <@html> (balise sœur) : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<@html @style.color={\'red\'}/>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_BODY))
  })

  it("runtime:['body'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['body'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_BODY))
  })
})
