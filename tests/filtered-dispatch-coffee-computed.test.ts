// Test de régression — le filtered dispatch des bindings `@class{cond}` /
// `@style.X{cond}` dans un `{for}` doit fonctionner :
//   1. Quand la condition utilise un opérateur Coffee/Civet (`is`, `isnt`).
//   2. Quand la var externe est un computed dérivé d'autres state vars.
//
// Cas vécu (tuto, sidebar de navigation) : `@class{$currentStep is s}="active"`
// où `$currentStep` est un computed dérivé de `$currentStepIdx`. Avant le fix,
// 2 bugs cumulés cassaient la réactivité :
//   - `detectFilteredPattern` cherchait `===` dans l'expression brute → le
//     `is` Coffee n'était pas reconnu → fallback non-filtered → pas d'effect
//     global → le `@class` ne re-tirait jamais sur mutation de la var externe.
//   - Une fois `is` reconnu, `registerEffect` n'enregistrait que pour
//     `[filt.externVar]` sans la closure transitive → mutation d'une dep du
//     computed (`$currentStepIdx`) ne réveillait pas le filtered effect.
//
// Fix :
//   - `detectFilteredPattern` / `detectFilteredValueExpr` appliquent `cleanJs`
//     avant la détection (normalise les idiomes Coffee).
//   - L'enregistrement du filtered effect passe par `getEffectVars($externVar)`
//     pour avoir la closure transitive (computed + ses deps statiques).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
items = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }, { id: 3, label: 'C' }]
$selectedIdx = 0
$selected = items[$selectedIdx]
</script>

<ul>
  {for item in items}
    <li @class{$selected is item}="active">{item.label}</li>
  {end}
</ul>
`

describe('runtime — filtered dispatch avec opérateur Coffee + computed externe', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('@class{$computed is item} re-tire à mutation d\'une dep du computed', async function () {
    const root = mjsTmp('filt-coffee')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'fc.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'b.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^fc-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

    // Compile-time : l'entrée `_mjs_filt['selected__active__…']` doit exister + effect filtered
    // doit être abonné AU MOINS à `selectedIdx` (dep transitive du computed).
    assert.match(compCode, /_mjs_filt\s*\?\?=\s*\{\}\)\[['"]selected__active__/,
      `le filtered index doit être généré pour @class{$selected is item}. bundle excerpt:\n${
        compCode.match(/_mjs_filt[^;]*/)?.[0] ?? '(rien)'
      }`)
    const ebvMatch = compCode.match(/_mjs_effectsByVar\s*=\s*\{[^}]+\}/)
    assert.ok(ebvMatch, '_mjs_effectsByVar trouvé')
    assert.match(ebvMatch![0], /"selectedIdx":\s*\[[^\]]*_mjs_eff\[\d+\]/,
      `_mjs_effectsByVar.selectedIdx doit contenir le filtered effect (closure transitive depuis $selected computed). ebv:\n${ebvMatch![0]}`)

    // Runtime : on monte le composant et on mute `selectedIdx`. La classe
    // `active` doit migrer du <li>[0] vers <li>[1].
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<mjs-fc></mjs-fc>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 100))

    const lis = () => Array.from(el._shadow.querySelectorAll('li'))
    const activeIdx = () => lis().findIndex((l: any) => l.classList.contains('active'))

    assert.equal(activeIdx(), 0, 'au mount, <li>[0] (A) est actif')

    // Mute selectedIdx → computed `selected` doit refléter items[1] → la
    // classe `active` doit migrer.
    el._set('selectedIdx', 1)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(activeIdx(), 1, 'après _set(selectedIdx, 1), <li>[1] (B) doit être actif')

    el._set('selectedIdx', 2)
    await new Promise(r => setTimeout(r, 50))
    assert.equal(activeIdx(), 2, 'après _set(selectedIdx, 2), <li>[2] (C) doit être actif')

    win.close?.()
  })
})
