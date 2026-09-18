// mjs_rare_runes.ts (µplay/µminmax/µinspect/µraw/µsnap/µimport), RATTACHÉES D'OFFICE au
// cœur jusqu'ici, ne doivent être embarquées QUE si l'une d'elles sert — même règle que
// mjs_title.ts, mais un SEUL fichier pour les 6 (aucune n'apporte grand-chose seule).
// `µsnap` a une forme SANS le mot « snap » (opérateur `=:`) ; `µimport` réclame un
// fichier CIBLE réel (empreinte résolue par µasset au build).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_RARE = 'µ._mjs_import = function'

async function buildProject(cfgExtra: any, files: Record<string, string>, extraSetup?: (srcDir: string) => void): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-rare')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  extraSetup?.(srcDir)
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

describe('mjs_rare_runes.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucune des 6 runes : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_RARE), false)
  })

  it('µplay(node, classe) seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@go = -> µplay(@_shadow, \'anim\')', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it('µminmax $x, 0, 10 seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@x = 5', 'µminmax $x, 0, 10', '</script>', '<p>{$x}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it('µinspect $x seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@x = 5', 'µinspect $x', '</script>', '<p>{$x}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it('µraw({...}) seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@obj = µraw({a: 1})', '</script>', '<p>{@obj.a}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it('$total =: expr (opérateur =:, jamais le mot « snap ») seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '$total =: 1 + 1', '</script>', '<p>{$total}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it("µimport('vendor/lib.js') seul (fichier cible réel) : PRÉSENT", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@go = -> await µimport(\'vendor/lib.js\')', '</script>', '<p>x</p>'].join('\n'),
    }, (srcDir) => {
      mkdirSync(join(srcDir, 'vendor'), { recursive: true })
      writeFileSync(join(srcDir, 'vendor', 'lib.js'), 'export const v = 1\n')
    })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })

  it("runtime:['rare_runes'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['rare_runes'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_RARE))
  })
})
