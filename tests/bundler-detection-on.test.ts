// mjs_on.ts (rune `µon`, délégation d'événement manuelle), RATTACHÉE D'OFFICE au cœur
// jusqu'ici (méthode de classe dans mjs_element.ts), ne doit être embarquée QUE si elle
// sert. DÉPLACÉE en patch de `µ.Element.prototype` (même technique que mjs_flip.ts) —
// `µon`/`µ.on` compile TOUJOURS en `@_mjs_on` (transpiler/index.ts), jamais un
// « µ.emit »/« µ.setContext » voisin (même préfixe de remplacement, gardé DISTINCT).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_ON = 'µ.Element.prototype._mjs_on = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-on')
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

describe('mjs_on.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS µon : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_ON), false)
  })

  it("composant avec µon 'click', (e) -> ... (forme bare) : PRÉSENT", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', "µon 'click', (e) -> e.preventDefault()", '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_ON))
  })

  it("composant avec µ.on(...) (forme pointée) : PRÉSENT", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', "µ.on('click', (e) -> e.preventDefault())", '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_ON))
  })

  it("µemit/µonline (préfixe voisin) SEULS : ABSENT — pas une fausse détection par sous-chaîne", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<script lang="coffee">', '@go = -> µemit \'x\'', '@up = µonline', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.equal(coreContent(outDir).includes(MARK_ON), false)
  })

  it("runtime:['on'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['on'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_ON))
  })
})
