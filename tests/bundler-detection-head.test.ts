// mjs_head.ts (<@head> — injection dans document.head), RATTACHÉ D'OFFICE au cœur
// jusqu'ici, ne doit être embarqué QUE s'il sert — même règle que mjs_title.ts (cf.
// tests/bundler-detection-title-vt.test.ts) : DÉTECTÉ à l'usage, scan textuel de sourceDir.
// <@head> à contenu émet lui-même un `µeffect =>` (transpiler/macros.ts) : sa présence doit
// AUSSI forcer mjs_effect.ts, sans qu'aucune source ne cite littéralement « effect ».
//
// Builds RÉELS (même patron que tests/bundler-detection-title-vt.test.ts) : preuve sur le
// bundle mjs_core-*.js produit.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_HEAD   = 'µ._setHead = function'
const MARK_EFFECT = 'µ.effect = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-head')
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

describe('mjs_head.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS <@head> : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_HEAD), false, 'aucune source ne pose <@head> : mjs_head.ts ne doit pas être bundlé')
  })

  it("runtime:'core' sans usage : ABSENT (cas du banc js-framework-benchmark)", async function () {
    const { outDir } = await buildProject({ runtime: 'core' }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_HEAD), false)
  })

  it('composant avec <@head> à contenu : PRÉSENT, et mjs_effect.ts AUSSI (µeffect jamais cité)', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<@head>', '<title>Bonjour</title>', '</@head>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_HEAD), '<@head> doit être détecté')
    assert.ok(core.includes(MARK_EFFECT), '<@head> émet son propre µeffect => en silence : mjs_effect.ts doit suivre')
  })

  // comportement changé DÉLIBÉRÉMENT (amélioration, pas régression) : cette forme
  // (<@head> SANS contenu, juste un écouteur) compile en `document.head.addEventListener(…)`
  // DOM natif direct — AUCUN appel à `µ._setHead` (vérifié sur la sortie compilée). Le
  // composant ne dépend donc PAS de mjs_head.ts pour fonctionner : l'ancien "sur-inclusion
  // acceptée" venait du scan TEXTUEL (voyait `<@head` dans le source, sans distinguer
  // contenu/écouteur) — le scan sur le CODE COMPILÉ ne fait plus ce faux positif inutile,
  // sans jamais risquer de faux négatif (le VRAI signal, contenu injecté, reste couvert par
  // le test précédent).
  it('<@head @event={...}/> SANS contenu (forme écouteur, DOM natif direct) : ABSENT — précision gagnée par le scan compilé', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<@head @click={() => 1}/>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_HEAD), false, 'aucun µ._setHead dans la sortie compilée : mjs_head.ts non nécessaire ici')
  })

  it("détection insensible à la casse (<@Head>)", async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<@Head>', '<title>Bonjour</title>', '</@Head>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_HEAD))
  })

  it("runtime:['head'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['head'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_HEAD))
  })
})
