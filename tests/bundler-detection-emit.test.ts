// mjs_emit.ts — `_mjs_emit` (rune `µemit`/`µ.emit`, directive `@emit.NOM=`/`@emit.once.NOM=`,
// sucre `@click.emit.NOM`), DÉTACHÉ du cœur (mjs_element.ts en portait la méthode) : ne doit
// être embarqué QUE si le projet écrit l'une des trois formes — jamais appelé par le cœur
// lui-même, donc jamais forcé par un autre module.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_EMIT = 'µ.Element.prototype._mjs_emit = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-emit')
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

describe('mjs_emit.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucune forme d\'émission : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_EMIT), false)
  })

  it('rune µemit dans un handler : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<button @click={-> µemit \'saved\', 1}>go</button>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EMIT), 'µemit doit embarquer mjs_emit.ts')
  })

  it('directive @emit.NOM= seule : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>$n = 1</script>', '<p @emit.saved={$n}>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EMIT), '@emit.saved doit embarquer mjs_emit.ts')
  })

  it('sucre @click.emit.NOM seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<button @click.emit.saved>go</button>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EMIT), '@click.emit.saved doit embarquer mjs_emit.ts')
  })

  it('demandé explicitement (runtime: [..., "emit"]) même sans usage : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['emit'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_EMIT))
  })
})
