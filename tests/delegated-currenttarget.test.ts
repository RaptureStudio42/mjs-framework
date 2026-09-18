// Test de régression — `e.currentTarget` dans un handler d'événement DÉLÉGUÉ.
//
// Bug vécu (audio-player, seek slider) : `seekStart = (e) -> div = e.currentTarget`
// puis `div.getBoundingClientRect()` → "getBoundingClientRect is not a function".
// Cause : les events qui bubblent (pointerdown, click…) sont délégués via UN
// listener sur le shadow root ; `e.currentTarget` natif = le shadow root, pas
// l'élément portant `@click`.
//
// Fix : le wrapper de délégation expose `e.currentTarget` = l'élément matché
// (sémantique DOM standard / parité Svelte-React), en plus du 2e argument.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
check = (e) ->
  globalThis.__ctTag = e.currentTarget?.tagName
  globalThis.__ctClass = e.currentTarget?.className
</script>
<div class="target" @click={check}><span class="inner">x</span></div>
`

describe('runtime — e.currentTarget dans un handler délégué = élément matché', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('clic sur un enfant → e.currentTarget = l\'élément portant @click (pas le shadow root)', async function () {
    const root = mjsTmp('ct')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'cttest.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^cttest-/.test(f))
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

    document.body.innerHTML = '<mjs-cttest></mjs-cttest>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))

    // Clic sur l'enfant `.inner` → bubble → handler délégué sur `.target`.
    const inner = el._shadow.querySelector('.inner')
    inner.dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 20))

    assert.equal(win.__ctTag, 'DIV',
      `e.currentTarget doit être le <div class="target"> (DIV), pas le shadow root. got: ${win.__ctTag}`)
    assert.equal(win.__ctClass, 'target',
      `e.currentTarget.className doit être "target". got: ${win.__ctClass}`)

    win.close?.()
  })
})
