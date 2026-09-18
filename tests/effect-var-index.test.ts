// L'index par-donnée des µeffect ne doit RIEN changer au comportement :
// un µeffect qui lit $a re-tourne quand $a change, PAS quand une var non-lue ($b)
// change. (L'opti évite seulement l'alloc Set + le scan inutiles — perf, voir bench.)
// Garde-fou de non-régression du correctif du cœur réactif.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('index µeffect par-donnée : firing inchangé', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('un µeffect lisant $a re-tourne sur $a, pas sur la var non-lue $b', async function () {
    const root = mjsTmp('p3')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'p3.mjs'), `
<script lang="coffee">
$a = 0
$b = 0
µeffect ->
  _ = $a
  window.__p3runs = (window.__p3runs or 0) + 1
  return
</script>
<p class="o">{$a}-{$b}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^p3-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-p3></mjs-p3>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))
    const flush = () => new Promise(r => setTimeout(r, 30))

    assert.equal(win.__p3runs, 1, 'effect tourne 1× au mount')

    el._set('b', 9)            // var NON lue par l'effect
    await flush()
    assert.equal(win.__p3runs, 1, '$b change → effect NE re-tourne PAS')
    assert.equal(el._shadow.querySelector('.o').textContent, '0-9', 'mais le binding {$b} se met à jour')

    el._set('a', 5)            // var LUE par l'effect
    await flush()
    assert.equal(win.__p3runs, 2, '$a change → effect re-tourne')

    win.close?.()
  })
})
