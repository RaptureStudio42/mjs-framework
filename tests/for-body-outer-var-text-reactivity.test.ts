// Test de régression : une var EXTÉRIEURE au `{for}` (ni l'item ni l'index de la loop)
// interpolée en TEXTE dans le corps d'un `{for}` ne déclenchait JAMAIS de
// re-render sur sa mutation.
//
//   {for item in $items}<p>{item}:{$sharedWidth}</p>{end}
//   <button @click={$sharedWidth++}>+</button>
//
// `compile.ts` (walk(), cas 'expr', branche `ctx.loops.length > 0`) calculait
// bien `vars` (les $.xxx de l'expression) mais ne les utilisait NULLE PART :
// ni `registerEffect` (le code vit dans la closure `updateFn` DU FOR — un
// appel depuis un effect top-level lancerait un ReferenceError sur
// `__nodes`/`n<lid>`, qui n'existent que dans ce scope), ni `state.structVars`
// (le SEUL mécanisme qui fait re-tourner `_mjs_renderStruct` → `_mjs_updFor` →
// ré-applique cette interpolation). Seule l'ITÉRABLE du `{for}` lui-même
// (compileFor) y était ajoutée — `$sharedWidth` mutait bien `_state` (vérifié :
// $sharedWidth++ fonctionne) mais le texte affiché restait figé À VIE.
//
// Fix : chaque dep externe d'une interpolation en `{for}` rejoint aussi
// `state.structVars` (même traitement que le two-way binding en `{for}`,
// bindingStandard/attributes/index.ts, commentaire "#5").

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('compile.ts — var externe interpolée en TEXTE dans un {for}', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileAndMount(name: string, html: string) {
    const root = mjsTmp('forouter')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const compFile = readdirSync(outDir).find((f: string) => new RegExp(`^${name}-`).test(f))!
    const compCode = readFileSync(join(outDir, compFile), 'utf-8')
    const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(compCode)}`)
    document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))
    return { win, document, el, compCode, flush: () => new Promise(r => setTimeout(r, 40)) }
  }

  it("le bundle enregistre 'sharedWidth' dans _mjs_renderStructVars (pas seulement l'itérable 'items')", async () => {
    const { compCode } = await compileAndMount('forsv1', `
<script lang="coffee">
$items = ['a', 'b']
$sharedWidth = 0
</script>
<button class="btn" @click={$sharedWidth++}>+</button>
{for item in $items}
<p class="lbl">{item}:{$sharedWidth}</p>
{end}
`)
    const m = compCode.match(/_mjs_renderStructVars\s*=\s*(\{[^}]*\})/)
    assert.ok(m, '_mjs_renderStructVars doit être présent')
    assert.match(m![1], /sharedWidth/,
      `AVANT le fix : seul 'items' (l'itérable) y figurait — got ${m![1]}`)
  })

  it("un clic qui mute $sharedWidth met à jour le texte dans TOUTES les rows (AVANT le fix : figé à vie)", async () => {
    const { el } = await compileAndMount('forsv2', `
<script lang="coffee">
$items = ['a', 'b', 'c']
$sharedWidth = 0
</script>
<button class="btn" @click={$sharedWidth++}>+</button>
{for item in $items}
<p class="lbl">{item}:{$sharedWidth}</p>
{end}
`)
    const flush = () => new Promise(r => setTimeout(r, 40))
    let labels = [...el._shadow.querySelectorAll('.lbl')].map((n: any) => n.textContent.trim())
    assert.deepEqual(labels, ['a:0', 'b:0', 'c:0'], 'état initial')

    el._shadow.querySelector('.btn').click()
    await flush()
    labels = [...el._shadow.querySelectorAll('.lbl')].map((n: any) => n.textContent.trim())
    assert.deepEqual(labels, ['a:1', 'b:1', 'c:1'],
      "AVANT le fix : restait ['a:0','b:0','c:0'] malgré _state.sharedWidth déjà à 1")

    el._shadow.querySelector('.btn').click()
    await flush()
    labels = [...el._shadow.querySelectorAll('.lbl')].map((n: any) => n.textContent.trim())
    assert.deepEqual(labels, ['a:2', 'b:2', 'c:2'], 'un 2e clic continue de fonctionner')
  })

  it("l'item de boucle lui-même n'est PAS ajouté à structVars (getEffectVars ne renvoie que des $.xxx, pas de faux positif)", async () => {
    const { compCode } = await compileAndMount('forsv3', `
<script lang="coffee">
$items = ['a', 'b']
</script>
{for item in $items}
<p class="lbl">{item}</p>
{end}
`)
    const m = compCode.match(/_mjs_renderStructVars\s*=\s*(\{[^}]*\}|null)/)
    assert.ok(m)
    // 'items' (itérable) doit être là, mais rien d'autre (pas de clé bidon 'item').
    assert.match(m![1], /items/)
    assert.doesNotMatch(m![1], /"item"/, "'item' (le nom de boucle) ne doit jamais apparaître comme clé de structVars")
  })

  it('mutation ordinaire de la liste (push) continue de fonctionner normalement (pas de régression)', async () => {
    const { el } = await compileAndMount('forsv4', `
<script lang="coffee">
$items = ['a']
$sharedWidth = 5
</script>
{for item in $items}
<p class="lbl">{item}:{$sharedWidth}</p>
{end}
`)
    const flush = () => new Promise(r => setTimeout(r, 40))
    el._set('items', ['a', 'b'])
    await flush()
    const labels = [...el._shadow.querySelectorAll('.lbl')].map((n: any) => n.textContent.trim())
    assert.deepEqual(labels, ['a:5', 'b:5'], 'la nouvelle row voit bien la valeur courante de sharedWidth')
  })
})
