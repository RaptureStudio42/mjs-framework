// Test runtime — `{if x?.y} … {x.y.z} … {end}` ne doit PAS planter au montage.
//
// Bug (POC navigateur) : l'expression interne d'un `{if}`
// (`{@x.y.z}` ci-dessous) était dupliquée à DEUX endroits du JS généré — une
// copie GARDÉE dans `_mjs_renderStruct` (via `branchExecBlock`), une copie NUE
// injectée dans `_mjs_effectsAll`/`_mjs_effectsByVar` (cf. `registerEffect`,
// generator/state.ts). Au montage, la copie nue évalue `x.y.z` même si
// `x?.y` est faux → `Cannot read properties of null` → crash-boundary
// « Fatal Error ». Repro EXACTE au POC navigateur (composant 8 lignes) :
//   <script>
//     @x = null
//   </script>
//   {if @x?.y}
//     <p>{@x.y.z}</p>
//   {end}
//
// Fix : `state.effectGuardStack` (compileIf, generator/compile.ts) fait
// porter la MÊME garde de branche (`this._old_ifN === i`) aux deux copies.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

/** Compile UN composant (fichier `${fileBase}.mjs`) et le monte dans une
 * fenêtre happy-dom fraîche. Retourne `{ win, document, el }`. */
async function compileAndMount(fileBase: string, source: string, tagName: string) {
  const root = mjsTmp(`ifoc-${fileBase}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${fileBase}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${fileBase}-`).test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

  document.body.innerHTML = `<${tagName}></${tagName}>`
  const el: any = document.body.firstElementChild
  await new Promise((r) => setTimeout(r, 80))
  return { win, document, el }
}

describe('runtime — {if x?.y} … {x.y.z} … {end} ne plante pas au montage', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('repro EXACTE (POC, sigil @) : @x=null au montage, aucun crash', async () => {
    const COMPONENT = `<script>
  @x = null
</script>
{if @x?.y}
  <p>{@x.y.z}</p>
{end}
`
    const { win, el } = await compileAndMount('ocexact', COMPONENT, 'mjs-ocexact')
    assert.equal(el._mjs_has_crashed, undefined, 'le composant ne doit pas avoir crashé au montage')
    assert.equal(el._shadow.querySelectorAll('.mjs-fatal-error').length, 0, 'pas de crash-boundary Fatal Error')
    assert.equal(el._shadow.querySelectorAll('p').length, 0, 'x=null → branche fermée → aucun <p>')
    win.close?.()
  })

  it('réactivité complète (sigil $) : null → peuplé → z change → null, aucun crash à aucune étape', async () => {
    const COMPONENT = `
<script>
$x = null
openIt = -> $x = { y: { z: 'ok' } }
bumpIt = -> $x = { y: { z: 'updated' } }
closeIt = -> $x = null
</script>
<div>
  <button class="open" @click={openIt()}>open</button>
  <button class="bump" @click={bumpIt()}>bump</button>
  <button class="close" @click={closeIt()}>close</button>
  {if $x?.y}
    <p>{$x.y.z}</p>
  {end}
</div>
`
    const { win, el } = await compileAndMount('ocreactive', COMPONENT, 'mjs-ocreactive')
    const click = (sel: string) => el._shadow.querySelector(sel)
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    const p = () => el._shadow.querySelector('p')

    assert.equal(el._mjs_has_crashed, undefined, 'aucun crash au montage (x=null)')
    assert.equal(p(), null, 'x=null → aucun <p> au montage')

    click('.open')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._mjs_has_crashed, undefined, 'aucun crash à l\'ouverture')
    assert.ok(p(), 'x devient {y:{z:"ok"}} → le <p> apparaît')
    assert.equal(p().textContent, 'ok')

    click('.bump')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(p().textContent, 'updated', 'z change → re-rendu')

    click('.close')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._mjs_has_crashed, undefined, 'aucun crash à la fermeture')
    assert.equal(p(), null, 'x repasse à null → le <p> disparaît sans erreur')

    win.close?.()
  })

  it('{if} imbriqué dans {for} avec le même motif : aucun composant ne plante', async () => {
    const COMPONENT = `
<script>
$rows = [
  { data: null }
  { data: { y: { z: 'row-b' } } }
]
</script>
<div>
  {for row in $rows}
    <section>
      {if row.data?.y}
        <p>{row.data.y.z}</p>
      {end}
    </section>
  {end}
</div>
`
    const { win, el } = await compileAndMount('ocfor', COMPONENT, 'mjs-ocfor')
    assert.equal(el._mjs_has_crashed, undefined, 'aucun crash au montage')
    assert.equal(el._shadow.querySelectorAll('.mjs-fatal-error').length, 0)
    const ps = el._shadow.querySelectorAll('p')
    assert.equal(ps.length, 1, 'seule la row avec data non-null rend un <p>')
    assert.equal(ps[0].textContent, 'row-b')
    win.close?.()
  })
})
