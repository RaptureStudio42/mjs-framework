// mjs_layout_variant.ts — tail de `_mjs_applyLayout` (variants nommés `layout="x"`/`template="x"`),
// DÉTACHÉ du cœur (mjs_element.ts en portait ce code) : DÉTECTÉ PAR LA DÉCLARATION `<style name>`
// (ou un fichier `<module>.<nom>.css` déposé dans le dossier de sortie) et par les mots
// `layout=`/`template=` (faux positif accepté) — la demande peut venir d'une page hors build. Le
// reste de `_mjs_applyLayout` (adoption des feuilles shield/reset/thème/héritées/base) reste cœur.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_LAYOUT_VARIANT = 'µ.Element.prototype._mjs_applyLayoutVariant = async function'

async function buildProject(cfgExtra: any, files: Record<string, string>, outFiles: Record<string, string> = {}): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-layout-variant')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  mkdirSync(outDir, { recursive: true })
  for (const [name, content] of Object.entries(outFiles)) writeFileSync(join(outDir, name), content)
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

describe('mjs_layout_variant.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS layout= ni template= : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(MARK_LAYOUT_VARIANT), false)
  })

  it('attribut layout="x" littéral : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<p layout="bandeau">x</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })

  it('attribut template="x" (forme dépréciée) : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<p template="bandeau">x</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })

  it('prop calculée layout={expr} : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$nom = \'bandeau\'', '</script>', '<p layout={$nom}>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })

  it('<style name="x"> déclaré, layout= jamais écrit dans les sources (page hôte) : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'carte.mjs': ['<p class="t">x</p>', '<style lang="sass" name="banner">', '.t', '  color: green', '</style>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })

  it('fichier de variant déposé à la main dans le dossier de sortie (<module>.<nom>.css) : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'carte.mjs': '<p>x</p>\n' }, { 'carte.compact.css': '.t{color:green}' })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })

  it('demandé explicitement (runtime: [..., "layout_variant"]) même sans usage : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['layout_variant'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_LAYOUT_VARIANT))
  })
})
