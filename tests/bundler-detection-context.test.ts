// mjs_context.ts — contexte de sous-arbre figé (`§`) et RÉACTIF (`§§`), DÉTACHÉ du cœur
// (mjs_element.ts en portait les 5 méthodes) : self-contained, jamais appelé par le cœur
// lui-même — détecté DIRECTEMENT par `§`, ses formes ASCII `__context.`/`__shared.` (option contextAlias)
// et les runes `µsetContext`/`µ.setContext`/`µ.getContext`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_CONTEXT = 'µ.Element.prototype._mjs_setContext = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-context')
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

describe('mjs_context.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS § ni §§ : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(MARK_CONTEXT), false)
  })

  it('§x (contexte figé) seul dans le script : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '§theme = \'sombre\'', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_CONTEXT), '§x doit embarquer mjs_context.ts')
  })

  it('contextAlias : formes ASCII __context.x / __shared.x sans aucun § : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [], contextAlias: true }, {
      'ancetre.mjs': ['<script>', '__context.theme = \'sombre\'', '</script>', '<p>x</p>'].join('\n'),
      'enfant.mjs': '<p>{__shared.theme}</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_CONTEXT), 'les formes ASCII du contexte doivent embarquer mjs_context.ts')
  })

  it('§§x (contexte réactif) seul en lecture : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<p>{§§theme}</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_CONTEXT), '§§x doit embarquer mjs_context.ts')
  })

  for (const [label, line] of [
    ['µ.setContext(…)', "µ.setContext('theme', 'sombre')"],
    ['µsetContext …', "µsetContext 'theme', 'sombre'"],
    ['µ.getContext(…)', "$t = µ.getContext('theme')"],
    ['µgetContext … (sans point, comme µsetContext)', "$t = µgetContext 'theme'"],
    ['mjs.getContext(…) (symbole ASCII)', "$t = mjs.getContext('theme')"],
  ]) {
    it(`rune ${label} sans aucun § : PRÉSENT`, async function () {
      const { outDir } = await buildProject({ runtime: [], sigil: 'mjs' }, {
        'hop.mjs': ['<script>', line, '</script>', '<p>x</p>'].join('\n'),
      })
      assert.ok(coreContent(outDir).includes(MARK_CONTEXT), `${label} doit embarquer mjs_context.ts`)
    })
  }

  it('canvas.getContext(\'2d\') (API du DOM, sans µ) : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µmount ->', "  ctx = canvas.getContext('2d')", '</script>', '<canvas @this={canvas}></canvas>'].join('\n'),
    })
    assert.equal(coreContent(outDir).includes(MARK_CONTEXT), false)
  })

  it('demandé explicitement (runtime: [..., "context"]) même sans usage : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['context'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_CONTEXT))
  })
})
