// Test runtime — directive `{const NOM = EXPR}` dans un `{for}`.
//
// `{const}` (≡ `{@const}` Svelte) déclare une constante LOCALE non affichée,
// réutilisable par les interpolations suivantes du même bloc. Doit :
//   1. rendre la valeur calculée par item (`{total}` lit le `const total`) ;
//   2. rester réactif quand un `$x` de l'EXPR mute (recalcul via _mjs_renderStruct).
//
// Harnais : compile+monte en happy-dom (calqué sur nested-for-in-if.test.ts).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function buildAndMount(tag: string, component: string) {
  const root = mjsTmp('const')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${tag}.mjs`), component)

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
  const compFile = files.find((f: string) => new RegExp(`^${tag}-`).test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

  document.body.innerHTML = `<mjs-${tag}></mjs-${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { win, el }
}

describe('runtime — {const} dans {for}', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('rend les valeurs calculées par item via {const}', async function () {
    const COMP = `
<script lang="coffee">
$items = [
  { a: 1, b: 2 }
  { a: 10, b: 5 }
  { a: 100, b: 7 }
]
</script>
<ul>
  {for it in $items}{const d = it.a + it.b}<li>{d}</li>{end}
</ul>
`
    const { win, el } = await buildAndMount('cstsum', COMP)
    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent.trim()),
      ['3', '15', '107'],
      'chaque <li> rend it.a + it.b via le {const}',
    )
    win.close?.()
  })

  it('réutilise un {const} dans plusieurs interpolations + reste réactif sur $x', async function () {
    const COMP = `
<script lang="coffee">
$rows = [
  { prix: 2, qte: 3 }
  { prix: 5, qte: 4 }
]
$tax = 1
bump = -> $tax = 2
</script>
<button @click={bump}>bump</button>
<table>
  {for r in $rows}{const ttc = r.prix * r.qte * $tax}<tr><td class="a">{ttc}</td><td class="b">{ttc}</td></tr>{end}
</table>
`
    const { win, el } = await buildAndMount('cstttc', COMP)
    const colA = () => [...el._shadow.querySelectorAll('td.a')].map((n: any) => n.textContent.trim())
    const colB = () => [...el._shadow.querySelectorAll('td.b')].map((n: any) => n.textContent.trim())

    // $tax = 1 → 2*3=6, 5*4=20. Les deux colonnes lisent le MÊME const ttc.
    assert.deepEqual(colA(), ['6', '20'], 'col A initiale')
    assert.deepEqual(colB(), ['6', '20'], 'col B initiale (même const)')

    // Mute $tax → 2 : l'EXPR du const dépend de $tax → recalcul attendu.
    el._shadow.querySelector('button')
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(colA(), ['12', '40'], 'col A après bump $tax=2')
    assert.deepEqual(colB(), ['12', '40'], 'col B après bump $tax=2')

    win.close?.()
  })
})
