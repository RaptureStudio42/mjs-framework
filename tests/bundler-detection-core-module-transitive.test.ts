// avant la refonte « cœur après composants », scanRuntimeFeatures() (balayage
// TEXTUEL, supprimé) ne scannait QUE `sourceDir` : un module CŒUR du framework
// (src/core-modules/*.mjs, ex. <@select>) qui utiliserait `<@head>`/µeffect/etc. restait
// invisible (angle mort ASSUMÉ pour title/store/interpolate, cf. tests/bundler-detection-
// store-interpolate.test.ts), comblé à l'époque par `queueCoreModuleRefs` — un 2e scan
// texte séparé, dédié aux modules cœur référencés.
//
// Ce 2e scan a disparu SANS RIEN À REMPLACER : `collectUsedFeatures()` lit le CODE COMPILÉ
// de TOUTES les unités déjà en mémoire (composants ET modules cœur transitivement
// compilés par resolveTagShortcuts() dès qu'une balise <@nom>/mjs-nom les référence,
// projet ou cœur) — la transitivité est désormais NATURELLE : un module cœur référencé
// EST une unité compilée comme une autre, son code alimente directement le signal, jusqu'au
// point fixe (une chaîne A→B→C compile A, B et C, chacun apportant ses propres signaux).
// Ici, `coreModulesDir` pointe un catalogue FABRIQUÉ (aucun module réel du dépôt n'utilise
// ces symboles aujourd'hui, cf. le test « garde anti-angle-mort » de bundler-detection-
// store-interpolate.test.ts) — seul moyen de prouver le mécanisme sans attendre qu'un vrai
// module cœur en use un jour.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_HEAD = 'µ._setHead = function'

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('collectUsedFeatures() — transitivité vers les modules cœur (src/core-modules/*.mjs) RÉFÉRENCÉS', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('projet qui n\'écrit RIEN lui-même, mais utilise un module cœur (fabriqué) qui pose <@head> : mjs_head.ts EMBARQUÉ', async function () {
    const root = mjsTmp('detect-core-module-transitif')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    const coreModulesDir = join(root, 'core-modules')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(coreModulesDir, { recursive: true })

    // module cœur FABRIQUÉ : pose <@head> — le PROJET, lui, ne cite jamais « head ».
    writeFileSync(join(coreModulesDir, 'widget.mjs'), [
      '<@head>', '<meta name="widget" content="1">', '</@head>', '<p><@slot/></p>',
    ].join('\n'))
    writeFileSync(join(srcDir, 'hop.mjs'), '<@widget>x</@widget>\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), coreModulesDir })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(coreContent(outDir).includes(MARK_HEAD), '<@widget> (module cœur) utilise <@head> : mjs_head.ts doit suivre même si "hop.mjs" ne le cite jamais')
  })

  it('même module cœur, jamais RÉFÉRENCÉ par le projet : mjs_head.ts ABSENT (transitivité, pas un scan aveugle de coreModulesDir entier)', async function () {
    const root = mjsTmp('detect-core-module-non-reference')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    const coreModulesDir = join(root, 'core-modules')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(coreModulesDir, { recursive: true })

    writeFileSync(join(coreModulesDir, 'widget.mjs'), [
      '<@head>', '<meta name="widget" content="1">', '</@head>', '<p><@slot/></p>',
    ].join('\n'))
    writeFileSync(join(srcDir, 'hop.mjs'), '<p>x</p>\n')  // ne référence PAS <@widget>

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), coreModulesDir })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.equal(coreContent(outDir).includes(MARK_HEAD), false)
  })

  it('chaîne à 2 niveaux : module cœur A référence le module cœur B qui pose <@head> : mjs_head.ts EMBARQUÉ (point fixe)', async function () {
    const root = mjsTmp('detect-core-module-transitif-2')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    const coreModulesDir = join(root, 'core-modules')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(coreModulesDir, { recursive: true })

    writeFileSync(join(coreModulesDir, 'inner.mjs'), [
      '<@head>', '<meta name="inner" content="1">', '</@head>', '<p><@slot/></p>',
    ].join('\n'))
    writeFileSync(join(coreModulesDir, 'outer.mjs'), '<p><@inner>x</@inner></p>\n')
    writeFileSync(join(srcDir, 'hop.mjs'), '<@outer/>\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), coreModulesDir })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(coreContent(outDir).includes(MARK_HEAD), 'outer → inner → <@head> : la transitivité doit aller jusqu\'au point fixe')
  })
})
