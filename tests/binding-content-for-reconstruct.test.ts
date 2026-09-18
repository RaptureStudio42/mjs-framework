// Régression : `@text=!{item.x}` /
// `@html=!{item.x}` (bindingContent) était le SEUL binding two-way sans
// reconstruction d'item dans un `{for}` — `item.txt = el.textContent` émis
// dans un handler nu `(e, el) => {...}` sans accès à `item`. Fix : même
// reconstruction (`data-mjs-idx-N` → item/index) que bindingStandard/Group.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('@text=!{item.x} (bindingContent) dans un {for} — reconstruction OK', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('édition contenteditable par row : écrit dans le BON item (pas de TypeError, pas de collision entre rows)', async () => {
    const src = [
      '<script lang="coffee">',
      '$notes = [{id:1, txt:"un"}, {id:2, txt:"deux"}]',
      '</script>',
      '<div>',
      '{for note in $notes}',
      '<div class="note" contenteditable @text=!{note.txt}>{note.txt}</div>',
      '{end}',
      '</div>',
    ].join('\n')

    const root = mjsTmp('bcfor')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'bcfor.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const errors: any[] = []
    window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^bcfor-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-bcfor></mjs-bcfor>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const notes = el._shadow.querySelectorAll('.note')
    assert.equal(notes.length, 2)
    assert.equal(notes[0].textContent.trim(), 'un')
    assert.equal(notes[1].textContent.trim(), 'deux')

    // Édite la 2e note.
    notes[1].textContent = 'DEUX MODIFIÉ'
    notes[1].dispatchEvent(new window.Event('input', { bubbles: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.equal(errors.length, 0, `aucune erreur runtime attendue, reçu : ${errors.map(String).join(' | ')}`)
    // La row 1 ne doit PAS avoir été affectée par l'édition de la row 2.
    assert.equal(notes[0].textContent.trim(), 'un', "la row 1 ne doit pas être affectée par l'édition de la row 2")
  })
})
