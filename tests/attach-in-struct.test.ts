// Test runtime — `@attach` posé sur un nœud créé par un bloc structurel
// (`{key}` / `{if}` / `{for}`).
//
// Bug : `_mjs_effectsAll` tournait AVANT `_mjs_renderStruct` au mount → quand l'effect
// d'un `@attach` posé sur un nœud DANS un `{key}` (par ex.) lisait
// `this._mjs_nodes.aN`, la struct n'avait pas encore mergé ses refs dans
// `_mjs_nodes` → undefined → effect no-op silencieux → factory jamais exécutée,
// hook `µmount` du composant attaché jamais appelé.
//
// Fix : `_mjs_renderStruct` tourne AVANT `_mjs_effectsAll` au mount, donc les refs
// des nœuds créés par les blocs struct sont dispos quand les effects tirent.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const COMPONENT = `
<script lang="coffee">
$tick = 0

setupCounter = (_node) ->
  _node.dataset.attached = 'yes'
  globalThis.__attachRuns ?= 0
  globalThis.__attachRuns += 1
  ->
    globalThis.__cleanupRuns ?= 0
    globalThis.__cleanupRuns += 1
</script>

<button @click={$tick = $tick + 1}>tick</button>

{key $tick}
  <div class="target" @attach={setupCounter}></div>
{end}
`

describe('runtime — @attach sur un nœud créé par un bloc struct', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('@attach dans un {key} tire au mount ET à chaque re-rendu du bloc', async function () {
    const root = mjsTmp('attach-struct')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'attk.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^attk-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<mjs-attk></mjs-attk>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 100))

    // Mount : la struct a rendu le .target, et l'attach a tourné dessus.
    const target0 = el._shadow.querySelector('.target')
    assert.ok(target0, '.target doit exister après mount')
    assert.equal(target0.dataset.attached, 'yes',
      "l'attach factory doit avoir tourné sur le nœud — `data-attached=\"yes\"` posé")
    assert.equal(win.__attachRuns, 1, '1 attach run après mount')

    // Click tick → {key} re-rendu → ancien teardown + nouveau setup.
    el._shadow.querySelector('button').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    const target1 = el._shadow.querySelector('.target')
    assert.ok(target1, '.target doit exister après tick')
    assert.equal(target1.dataset.attached, 'yes', "nouveau .target a aussi `data-attached='yes'`")
    assert.equal(win.__attachRuns, 2, 'attach run 2× après 1 tick')
    assert.equal(win.__cleanupRuns, 1, 'le cleanup du 1er attach a tourné')

    win.close?.()
  })

  // --------------------------------------------------------------------------
  // Bug séparé : un `@attach={tooltip($content)}` où l'expression lit une var
  // réactive doit re-tirer quand `$content` change. Sinon le tooltip reste
  // figé sur la valeur initiale alors que l'utilisateur tape dans l'input
  // (cas vécu sur le tuto attachment-factories après un fix antérieur qui
  // avait retiré l'enregistrement réactif).
  // --------------------------------------------------------------------------
  it('@attach avec dep réactive re-tire à chaque mutation de la dep', async function () {
    const root = mjsTmp('attach-reactive')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tlt.mjs'), `
<script lang="coffee">
$msg = 'hello'

setTip = (text) -> (_node) ->
  _node.dataset.tip = text
  -> null
</script>

<button @click={$msg = 'changed'}>mute</button>
<div class="t" @attach={setTip($msg)}></div>
`)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^tlt-/.test(f))
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

    document.body.innerHTML = '<mjs-tlt></mjs-tlt>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    // Mount : data-tip = valeur initiale.
    assert.equal(el._shadow.querySelector('.t').dataset.tip, 'hello',
      'au mount, l\'attach pose la valeur initiale')

    // Mutation de $msg via le bouton → l'attach doit re-tirer.
    el._shadow.querySelector('button').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    assert.equal(el._shadow.querySelector('.t').dataset.tip, 'changed',
      'après mutation de la dep réactive, l\'attach re-tire avec la nouvelle valeur')

    win.close?.()
  })
})
