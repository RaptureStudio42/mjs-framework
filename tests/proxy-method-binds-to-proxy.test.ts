// Test de régression — quand une instance de classe est assignée à `$X`, les
// méthodes appelées via `$X.method()` doivent voir `this = proxy` (pas `this
// = raw target`). Sinon, les mutations `this.x = y` à l'intérieur des méthodes
// ne passent pas par le proxy `set` handler → pas de `_mjs_notifyMutation` → pas
// de re-render.
//
// Cas vécu (tuto classes-reactives) : `class Box { embiggen(n) { @width += n }`
// appelée via `$box.embiggen(10)`. Avant le fix, `val.bind(obj)` bind sur
// l'objet brut → `@width = ...` mute en silence → le bouton "Agrandir" ne
// fait rien visuellement.
//
// Fix : `val.bind(proxy)` via forward declaration de `proxy` dans `_mjs_wrapDeep`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const COMPONENT = `
<script>
class Counter {
  constructor(start) { this.value = start; }
  inc(amount) { this.value += amount; }
}
$c = new Counter(10);
</script>

<button @click={$c.inc(5)}>inc</button>
<span class="v">{$c.value}</span>
`

describe('runtime — méthode de classe appelée via $.X.method() voit this=proxy', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('this.x = y dans une méthode déclenche le re-render du binding', async function () {
    const root = mjsTmp('classmethod')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'cm.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'b.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^cm-/.test(f))
    assert.ok(coreFile && compFile)

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<mjs-cm></mjs-cm>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const vSpan = () => el._shadow.querySelector('.v')
    assert.equal(vSpan().textContent, '10', 'valeur initiale = 10')

    el._shadow.querySelector('button').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))

    assert.equal(vSpan().textContent, '15',
      "BUG : appel de méthode `$c.inc(5)` doit muter $c.value via le proxy et re-render le binding. " +
      "Si this dans inc() est l'objet brut au lieu du proxy, la mutation `@value += amount` ne déclenche pas _mjs_notifyMutation.")

    win.close?.()
  })
})
