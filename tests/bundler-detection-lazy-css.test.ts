// mjs_lazy_css.ts — `µ._mjs_fetchLazyCss`, DÉTACHÉ du cœur (mjs_init.ts en portait la fonction) :
// signal de CONFIG PURE (`css: 'lazy'`), jamais un scan — le bundler n'écrit `µ._cssLazy` au
// manifeste QUE dans ce mode (cf. bundler-css-lazy.test.ts pour le comportement fonctionnel
// complet, ici seulement la présence/absence dans le cœur).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_LAZY_CSS = 'µ._mjs_fetchLazyCss = function'
const MARK_WAIT     = 'µ._mjs_lazyCssWait = function'

async function buildProject(cfgExtra: any): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-lazy-css')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  const stylesDir = join(root, 'app/styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', stylesheetsDir: 'app/styles', ...cfgExtra,
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

describe('mjs_lazy_css.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("css par défaut ('bundle') : ABSENT", async function () {
    const { outDir } = await buildProject({ runtime: [] })
    assert.equal(coreContent(outDir).includes(MARK_LAZY_CSS), false)
  })

  it("css par défaut ('bundle') : l'attente des feuilles différées ABSENTE du cœur (aucun appel à µ._mjs_fetchLazyCss)", async function () {
    const { outDir } = await buildProject({ runtime: [] })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_WAIT), false)
    assert.equal(core.includes('_mjs_fetchLazyCss('), false, 'plus aucun appelant resté dans mjs_element.ts')
  })

  it("css: 'split' : ABSENT", async function () {
    const { outDir } = await buildProject({ runtime: [], css: 'split' })
    assert.equal(coreContent(outDir).includes(MARK_LAZY_CSS), false)
  })

  it("css: 'lazy' (aucune feuille déclarée par le composant) : PRÉSENT quand même — faux positif accepté", async function () {
    const { outDir } = await buildProject({ runtime: [], css: 'lazy' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_LAZY_CSS))
    assert.ok(core.includes(MARK_WAIT), 'l\'attente appelée par _mjs_applyLayout suit la feuille')
  })

  it('demandé explicitement (runtime: [..., "lazy_css"]) même en mode bundle : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['lazy_css'] })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_LAZY_CSS))
    assert.ok(core.includes(MARK_WAIT))
  })
})
