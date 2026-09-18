// mjs_slots.ts (`_mjs_injectSlots`, index `slot="N"` posé sur les enfants d'un composant à slots
// indexés `<@slot {i}/>`), RATTACHÉE D'OFFICE au cœur jusqu'ici (méthode de classe dans
// mjs_element.ts, appelée par TOUT constructeur compilé), ne doit être embarquée QUE si le code
// compilé du projet l'appelle — le générateur n'émet plus l'appel que pour un composant qui écrit
// `<@slot` (le seul cas où la méthode avait du travail). Patch de `µ.Element.prototype`, même
// technique que mjs_on.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_SLOTS = 'µ.Element.prototype._mjs_injectSlots = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root   = mjsTmp('detect-slots')
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

describe('mjs_slots.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS <@slot> (un <slot> natif écrit à la main compris) : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<div><slot></slot></div>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_SLOTS), false)
    assert.equal(core.includes('_mjs_injectSlots('), false, 'aucune trace de la méthode dans le cœur')
  })

  it('composant avec <@slot {i}/> dans un {for} : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<script>\n$items = [1, 2]\n</script>\n<div>{for i, t in $items}<@slot {i}/>{end}</div>\n'
    })
    assert.ok(coreContent(outDir).includes(MARK_SLOTS))
  })

  it('<@slot> apporté SEULEMENT par un partiel <@include> : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<@include fente>\n',
      '_fente.mjs': '<div><@slot/></div>\n'
    })
    assert.ok(coreContent(outDir).includes(MARK_SLOTS))
  })

  it("runtime:['slots'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['slots'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_SLOTS))
  })
})
