// mjs_page_cache.ts — `µ.LRUCache`/`µ._mjs_isPageCached`/`µ._mjs_destroyEvictedTree`/`µ._mjs_routeErrorCss`/
// `µ._mjs_label`/`µ._mjs_labelLang`, DÉTACHÉS du cœur (mjs_init.ts en portait ces symboles), DÉTECTÉS PAR
// CONFIG SEULE (jamais par scan) : module `router` OU `ujs` OU `modal` sélectionné.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_PAGE_CACHE = 'µ._mjs_destroyEvictedTree = function'

async function buildProject(cfgExtra: any): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-page-cache')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')
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

describe('mjs_page_cache.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('runtime: [] (aucun optionnel) : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] })
    assert.equal(coreContent(outDir).includes(MARK_PAGE_CACHE), false)
  })

  it("runtime: ['router'] seul : PRÉSENT", async function () {
    const { outDir } = await buildProject({ runtime: ['router'] })
    assert.ok(coreContent(outDir).includes(MARK_PAGE_CACHE))
  })

  it("runtime: ['ujs'] seul (sans router) : PRÉSENT — mjs_ujs.ts construit new µ.LRUCache() à son chargement", async function () {
    const { outDir } = await buildProject({ runtime: ['ujs'] })
    assert.ok(coreContent(outDir).includes(MARK_PAGE_CACHE))
  })

  it("runtime: ['modal'] seul (sans router ni ujs) : PRÉSENT — labels traduits des toasts/modales", async function () {
    const { outDir } = await buildProject({ runtime: ['modal'] })
    assert.ok(coreContent(outDir).includes(MARK_PAGE_CACHE))
  })

  it("runtime: ['vault'] seul : ABSENT — ni router, ni ujs, ni modal", async function () {
    const { outDir } = await buildProject({ runtime: ['vault'] })
    assert.equal(coreContent(outDir).includes(MARK_PAGE_CACHE), false)
  })

  it('demandé explicitement (runtime: [..., "page_cache"]) sans router/ujs/modal : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['page_cache'] })
    assert.ok(coreContent(outDir).includes(MARK_PAGE_CACHE))
  })
})
