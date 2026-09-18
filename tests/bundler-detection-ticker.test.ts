// mjs_ticker.ts (µ.Ticker, boucle rAF partagée), RATTACHÉE D'OFFICE au cœur (mjs_runes.ts)
// jusqu'ici, ne doit être embarquée QUE si l'un de ses 3 consommateurs (spring/smooth/
// interpolate) l'est, ou si le projet l'appelle DIRECTEMENT — les trois appellent
// `µ.Ticker.add(...)` SANS AUCUNE garde (vérifié : mjs_spring.ts, mjs_smooth.ts,
// mjs_interpolate.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_TICKER = 'µ.Ticker = {'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-ticker')
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

describe('mjs_ticker.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("runtime:'core' sans spring/smooth/interpolate : ABSENT", async function () {
    const { outDir } = await buildProject({ runtime: 'core' }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(MARK_TICKER), false)
  })

  it("runtime:['spring'] : mjs_ticker.ts présent (mjs_spring.ts appelle µ.Ticker.add sans garde)", async function () {
    const { outDir } = await buildProject({ runtime: ['spring'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_TICKER))
  })

  it("runtime:['smooth'] : mjs_ticker.ts présent", async function () {
    const { outDir } = await buildProject({ runtime: ['smooth'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_TICKER))
  })

  it('µinterpolate détecté (scan) : mjs_ticker.ts présent (mjs_interpolate.ts en dépend)', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '$p = µinterpolate(0, 400)', '</script>', '<p>{$p}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_TICKER))
  })

  it('ni spring/smooth/interpolate ni µ.Ticker direct : ABSENT (défaut all, aucun des 3)', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(MARK_TICKER), false)
  })

  it('µ.Ticker appelé directement (filet de sécurité, sans spring/smooth/interpolate) : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script lang="coffee">', '@go = -> µ.Ticker.add(@)', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_TICKER))
  })

  it("runtime:['ticker'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['ticker'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_TICKER))
  })
})
