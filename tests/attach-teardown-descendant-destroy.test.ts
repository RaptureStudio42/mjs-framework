// Régression : à la fermeture d'un bloc
// `{if}`/`{for}` (waitOut=false, le cas par défaut — pas de cascade
// `mjs-childtransition`), `_mjs_destroyNodeAndChildren` ne collectait QUE les
// descendants `.global` pour leur teardown — un descendant `@attach`/`@this`
// SANS `.global` (le cas courant) voyait son teardown JAMAIS appelé.
//
//   {if $show}<div><canvas @attach={startLoop}></canvas></div>{end}
//
// `startLoop` posait un `setInterval` ; sa fonction de cleanup (retournée
// par la factory) n'était jamais exécutée à la fermeture du bloc → interval
// actif sur DOM détaché, ré-accumulé à chaque réouverture/fermeture.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

const COMPONENT = `
<script lang="coffee">
$show = true

setupLoop = (_node) ->
  globalThis.__attachCount ?= 0
  globalThis.__attachCount += 1
  ->
    globalThis.__teardownCount ?= 0
    globalThis.__teardownCount += 1
</script>

<button class="toggle" @click={$show = not $show}>toggle</button>
{if $show}
  <div class="wrapper"><canvas class="target" @attach={setupLoop}></canvas></div>
{end}
`

describe('runtime — teardown @attach sur un DESCENDANT (pas .global) à la fermeture de {if}', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('le teardown du canvas descendant est appelé quand le {if} se referme', async function () {
    const root = mjsTmp('attach-td')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'atttd.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^atttd-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    win.eval(`
      globalThis.__attachCount = 0;
      globalThis.__teardownCount = 0;
      ${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}
      globalThis.µ = µ;
      ${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}
    `)

    document.body.innerHTML = '<mjs-atttd></mjs-atttd>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    assert.equal(win.eval('globalThis.__attachCount'), 1, 'le canvas doit être attaché au mount')
    assert.ok(el._shadow.querySelector('canvas.target'), 'le canvas doit exister au mount')

    // Ferme le bloc {if} (waitOut=false, chemin par défaut — PAS de cascade
    // childtransition) : c'est exactement le chemin bugué.
    el._shadow.querySelector('button.toggle').click()
    await new Promise((r) => setTimeout(r, 80))

    assertAbsent(el._shadow.querySelector('canvas.target'), 'le canvas doit être retiré du DOM')
    assert.equal(
      win.eval('globalThis.__teardownCount'),
      1,
      "AVANT le fix : le teardown du canvas (descendant non-.global) n'était JAMAIS appelé à la fermeture du {if}"
    )

    // Ré-ouvre : un nouvel attach doit se poser (pas de fuite de l'ancien).
    el._shadow.querySelector('button.toggle').click()
    await new Promise((r) => setTimeout(r, 80))
    assert.equal(win.eval('globalThis.__attachCount'), 2, 'un nouvel attach doit se poser à la réouverture')

    win.close?.()
  })
})
