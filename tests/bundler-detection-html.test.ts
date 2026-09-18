// mjs_html.ts (`_mjs_updHtml`, mise à jour d'une interpolation brute `{{…}}`), RATTACHÉE D'OFFICE au
// cœur jusqu'ici (méthode de classe dans mjs_element.ts), ne doit être embarquée QUE si le code
// compilé du projet l'appelle — patch de `µ.Element.prototype`, même technique que mjs_on.ts. Le
// générateur émet l'appel littéral `this._mjs_updHtml('tN', …)` pour chaque `{{…}}` hors {for}/{await}
// (cf. tests/bundler-features-scan.test.ts pour les formes prouvées une à une).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_HTML = 'µ.Element.prototype._mjs_updHtml = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root   = mjsTmp('detect-html')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts    = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { outDir }
}

function coreContent(outDir: string): string {
  const files    = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('mjs_html.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS {{…}} : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<script>\n$t = \'x\'\n</script>\n<p>{$t}</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_HTML), false)
    assert.equal(core.includes('_mjs_updHtml('), false, 'aucune trace de la méthode dans le cœur')
  })

  it('composant avec {{$h}} : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<script>\n$h = \'<b>x</b>\'\n</script>\n<p>{{$h}}</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_HTML))
  })

  it('{{…}} apporté SEULEMENT par un partiel <@include> : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<script>\n$h = \'<b>x</b>\'\n</script>\n<@include bloc>\n',
      '_bloc.mjs': '<div>{{$h}}</div>\n'
    })
    assert.ok(coreContent(outDir).includes(MARK_HTML))
  })

  it("runtime:['html'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['html'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_HTML))
  })
})
