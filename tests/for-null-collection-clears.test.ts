// Régression — asymétrie `[]` vs `null`.
//
// `_mjs_updFor`/`_mjs_updList`/`_mjs_reconcileList` court-circuitaient sur `!col` AVANT
// toute destruction : `$items = null` (reset, re-fetch qui repart de null)
// laissait les anciennes rows en FANTÔMES à l'écran (et `_mjs_list_order/_mjs_list_cache`
// gardaient les vieilles clés), alors que `$items = []` vidait correctement.
// {if}, lui, détruit d'abord PUIS teste `if (!createFn) return`.
//
// Fix : collection falsy ⇒ détruire les rows entre les ancres (même walk que
// `_mjs_updIf(null)`) + réinitialiser les tables du cacheId, puis return.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
$items = ['x', 'y']
</script>
<ul>
  {for it in $items}<li>{it}</li>{end}
</ul>
`

describe('runtime — {for} collection null/undefined : vide les rows (parité {if})', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('$items = null détruit les rows ; un nouveau tableau re-rend correctement', async function () {
    const root = mjsTmp('for-null')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'lister.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^lister-/.test(f))
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

    document.body.innerHTML = '<mjs-lister></mjs-lister>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const read = () => [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent)
    assert.deepEqual(read(), ['x', 'y'], 'état initial')

    // Reset à null : les rows doivent DISPARAÎTRE (avant fix : fantômes 'x','y').
    el._set('items', null)
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(read(), [], 'collection null → rows détruites (parité {if})')

    // Re-fetch : un nouveau tableau re-rend proprement (cache réinitialisé).
    el._set('items', ['z'])
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(read(), ['z'], 'nouveau tableau après null → re-rendu correct (pas de fantôme, pas de doublon)')

    // Et via [] pour prouver la cohérence [] == null désormais.
    el._set('items', [])
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(read(), [], 'collection [] vide aussi')

    win.close?.()
  })
})
