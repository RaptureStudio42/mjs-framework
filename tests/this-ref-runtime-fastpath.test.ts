// (end-to-end) — un composant qui écrit ses refs `@this` (SANS `$`) au montage :
// le compilateur émet des écritures BRUTES, donc `µ._mjs_deepSet` n'est JAMAIS appelé
// pour ces écritures, tout en mettant le DOM à jour. Contrat 100 % compile-time
// (une ref sans `$` n'est pas réactive → le path-tracker ne la voit pas).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('refs @this (sans $) — écritures brutes (end-to-end)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('les écritures de ref dans µmount sont brutes (µ._mjs_deepSet jamais appelé) mais le DOM est à jour', async function () {
    const root = mjsTmp('e2e')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hud.mjs'), `
<script lang="coffee">
bar = null
µmount ->
  bar.style.width = '42%'
  bar.className = 'on'
  bar.dataset.k = 'v'
</script>
<div class="bar" @this=!{bar}></div>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^hud-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    const µ: any = win.µ

    let deepSets = 0
    const origDeep = µ._mjs_deepSet
    µ._mjs_deepSet = (...a: any[]) => { deepSets++; return origDeep.apply(µ, a) }

    document.body.innerHTML = '<mjs-hud></mjs-hud>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const bar = el._shadow.querySelector('div') // la classe 'bar' devient 'on' après µmount
    assert.equal(bar.style.width, '42%', 'µmount a écrit la largeur (brut)')
    assert.equal(bar.className, 'on', 'µmount a écrit la classe (brut)')
    assert.equal(bar.dataset.k, 'v', 'µmount a écrit le dataset (brut)')
    assert.equal(deepSets, 0, 'µ._mjs_deepSet JAMAIS appelé : une ref sans $ est brute')

    win.close?.()
  })
})
