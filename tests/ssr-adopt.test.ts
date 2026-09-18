// SSR — volet NON-RÉGRESSION (happy-dom) : sans Shadow DOM
// déclaratif, le montage client classique est strictement inchangé (le
// nouveau branchement d'adoption ne se déclenche pas).
//
// NB : l'adoption DSD elle-même (le cœur de 1b) ne peut PAS être testée en
// happy-dom — il ne parse pas le Declarative Shadow DOM (ni innerHTML, ni
// setHTMLUnsafe, ni upgrade d'éléments existants). Elle est validée en vrai
// navigateur dans `ssr-adopt-browser.test.ts` (Playwright / Chromium).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

function loadBundle(outputDir: string, window: any): void {
  const files = readdirSync(outputDir).filter(f => f.endsWith('.js'))
  const coreFile = files.find(f => /^mjs_core-/.test(f))!
  const coreCode = stripEsm(readFileSync(join(outputDir, coreFile), 'utf-8'))
  const comps = files
    .filter(f => f !== coreFile && f !== 'bundle.js')
    .map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8')))
    .join('\n')
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${comps}`)
}

describe('SSR adoption — non-régression client classique (happy-dom)', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('sans DSD : montage classique inchangé, aucune adoption', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-classic')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'plain.mjs'), `
<script lang="coffee">
$count = 0
incr = => $count = $count + 1
</script>
<button @click={incr()}>N: {$count}</button>
`)
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    await renderer.close()

    const window: any = new Window({ url: 'http://localhost/' })
    loadBundle(outDir, window)
    // Montage SANS DSD (balise nue) → chemin client classique.
    window.document.body.innerHTML = `<mjs-plain></mjs-plain>`
    const el: any = window.document.body.firstElementChild
    await new Promise(r => setTimeout(r, 50))

    assert.notEqual(el._mjs_ssrAdopt, true, 'pas d\'adoption sans DSD')
    const button = el._shadow?.querySelector('button')
    assert.ok(button, 'le composant classique se monte normalement')
    assert.match(button.textContent ?? '', /N: 0/)
    button.click()
    await new Promise(r => setTimeout(r, 50))
    assert.match(el._shadow.querySelector('button').textContent ?? '', /N: 1/,
      'interactivité classique intacte (montage non régressé)')

    window.close?.()
  })
})
