// mjs_failed.ts (frontière d'erreur <@failed> : repli, propagation vers l'ancêtre, limite de
// réessai, reset() par µ._mjs_resetComponent), RATTACHÉE D'OFFICE au cœur jusqu'ici, ne doit être
// embarquée QUE si le projet écrit `<@failed>` ou la rune nue `µfailed` — même règle que
// mjs_title.ts. `_mjs_catchError` (mjs_element.ts, cœur) ne délègue à `_mjs_runBoundary` QUE si la
// méthode existe : sans elle, aucun composant ne peut porter `_mjs_fallback` (posé par un
// `<@failed>` compilé ou par `µfailed (err, reset)->`), il n'y a donc rien à rendre ni d'ancêtre à
// trouver. `<@failed>` n'émet lui-même AUCUN `µeffect =>` (rendu statique après crash, cf.
// compileFailedBlock).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_FAILED   = 'µ._mjs_resetComponent = function'
const MARK_BOUNDARY = 'µ.Element.prototype._mjs_runBoundary = function'
const MARK_EFFECT   = 'µ.effect = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-failed')
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

describe('mjs_failed.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS <@failed> : ABSENT', async function () {
    const { outDir } = await buildProject({}, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_FAILED), false)
  })

  it('composant SANS <@failed> : la frontière (repli, propagation, limite de réessai) ABSENTE du cœur', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.equal(core.includes(MARK_BOUNDARY), false)
    assert.equal(core.includes('_mjs_findBoundary'), false, 'la recherche de l\'ancêtre ne sert à rien sans aucun repli dans le projet')
    assert.equal(core.includes('[mjs-reset]'), false, 'les boutons de reset d\'un repli en chaîne non plus')
  })

  it('composant avec <@failed err reset>...</@failed> : PRÉSENT, mjs_effect.ts ABSENT (rendu statique)', async function () {
    const { outDir } = await buildProject({}, {
      'hop.mjs': ['<p>{1/0}</p>', '<@failed err reset>', '<p>Erreur : {err.message}</p>', '</@failed>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FAILED), '<@failed> doit être détecté')
    assert.ok(core.includes(MARK_BOUNDARY), 'la frontière qui rend le repli doit suivre')
    assert.equal(core.includes(MARK_EFFECT), false, '<@failed> ne dépend jamais de µeffect (rendu statique après crash)')
  })

  it('µfailed en rune NUE, sans <@failed> : PRÉSENT — le reset du repli appelle µ._mjs_resetComponent', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µfailed (err, reset)->', '  "<button mjs-reset>Réessayer</button>"', '</script>', '<p>x</p>'].join('\n'),
    })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FAILED))
    assert.ok(core.includes(MARK_BOUNDARY), 'la rune nue pose elle aussi un repli à rendre')
  })

  it("runtime:['failed'] sans usage dans les sources : présent quand même (explicite gagne)", async function () {
    const { outDir } = await buildProject({ runtime: ['failed'] }, { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes(MARK_FAILED))
    assert.ok(core.includes(MARK_BOUNDARY))
  })
})
