// Régression : `{for}` dont chaque itération émet PLUSIEURS nœuds racines —
// un `<li>` PUIS un `{if}` frère écrit à côté de lui — laisse les frères du
// `{if}` dans le DOM quand l'entrée est DÉTRUITE APRÈS que sa condition ait
// basculé de faux à vrai.
//
// `entry.nodes` (mjs_element.ts `_mjs_reconcileList`) est un INSTANTANÉ pris à la
// construction de l'entrée (top-level childNodes du fragment produit par
// `tplFn`). Au premier rendu, si `{if row.tagged}` est FAUX, le fragment ne
// contient que `<li>` + les 2 marqueurs texte du `{if}` (`s-ifN`/`e-ifN`,
// toujours présents, vides) — PAS le `<span>`. Quand la condition bascule à
// VRAI sur un rendu ULTÉRIEUR (entrée réutilisée, même clé), `_mjs_updItemIf`
// insère le `<span>` comme SIBLING entre les 2 marqueurs directement dans le
// DOM vivant — sans jamais toucher `entry.nodes`, qui reste [li, markerStart,
// markerEnd]. Quand la row est ensuite supprimée, `_mjs_reconcileList` détruit
// UNIQUEMENT les nœuds de `entry.nodes` : le `<span>`, simple sibling des
// marqueurs (pas leur enfant), n'est jamais atteint → orphelin permanent.
//
// Mesure attendue (mesure réelle rapportée par une autre équipe) : nœuds en
// trop qui s'accumulent au lieu d'un compte stable après suppression.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// Clé stable (`by id`) : l'entrée est RÉUTILISÉE d'un rendu à l'autre (pas
// recréée), condition indispensable pour que `entry.nodes` reste périmé.
const COMPONENT = `
<script lang="coffee">
$rows = [
  { id: 1, label: 'a', tagged: false }
  { id: 2, label: 'b', tagged: false }
  { id: 3, label: 'c', tagged: false }
]
tagRow = (i) -> $rows[i].tagged = true
removeRow = (i) -> $rows.splice(i, 1)
rotate    = -> $rows.push($rows.shift())
</script>
<div>
  <button class="tag-btn" @click={tagRow(0)}>tag</button>
  <button class="remove-btn" @click={removeRow(0)}>remove</button>
  <button class="rotate-btn" @click={rotate()}>rotate</button>
  <ul>
    {for row in $rows by id}
      <li>{row.label}</li>
      {if row.tagged}<span class="tag">*</span>{end}
    {end}
  </ul>
</div>
`

describe('runtime — {for} sans clé, itération multi-racines (élément + {if} frère)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un {if} qui bascule de faux à vrai puis dont la row est supprimée ne laisse PAS son contenu orphelin', async function () {
    const root = mjsTmp('multiracines')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'multiroot.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^multiroot-/.test(f))
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

    document.body.innerHTML = '<mjs-multiroot></mjs-multiroot>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const countLi = () => el._shadow.querySelectorAll('li').length
    const countTag = () => el._shadow.querySelectorAll('span.tag').length

    assert.equal(countLi(), 3, 'montage : 3 <li>')
    assert.equal(countTag(), 0, 'montage : {if row.tagged} faux pour toutes les rows → 0 <span.tag>')

    // Bascule row[0].tagged à VRAI (entrée RÉUTILISÉE, même clé) → le {if}
    // insère son <span> comme sibling des marqueurs, APRÈS la capture de
    // `entry.nodes`.
    el._shadow.querySelector('button.tag-btn')
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.equal(countTag(), 1, 'après tag : 1 <span.tag> inséré pour row[0]')

    // Supprime la row taguée. Si `entry.nodes` est périmé, seuls `<li>` et
    // les marqueurs du {if} sont détruits — le <span> reste orphelin.
    el._shadow.querySelector('button.remove-btn')
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.equal(countLi(), 2, 'après suppression : 2 <li> restants')
    assert.equal(countTag(), 0, `après suppression de la row taguée : 0 <span.tag> attendu (orphelin si > 0), trouvé ${countTag()}`)

    win.close?.()
  })

  // Second trou de la MEME cause : la passe de PLACEMENT (LIS) deplace les
  // entrees survivantes en lisant elle aussi `entry.nodes`. Une entree dont le
  // `{if}` a bascule et qui doit changer de place n'emporte alors que ses
  // noeuds d'instantane — le contenu du `{if}` reste a l'ANCIENNE position,
  // visuellement detache de sa ligne. Defaut de PLACEMENT, pas d'accumulation.
  it('un {if} bascule puis dont la row est DEPLACEE suit sa ligne au lieu de rester en arriere', async function () {
    const root = mjsTmp('multiracines-move')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'multiroot.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^multiroot-/.test(f))
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

    document.body.innerHTML = '<mjs-multiroot></mjs-multiroot>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const clic = (sel: string) => el._shadow.querySelector(sel)
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))

    clic('button.tag-btn')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(el._shadow.querySelectorAll('span.tag').length, 1, 'après tag : 1 <span.tag>')

    // [a,b,c] -> [b,c,a] : la row taguée sort de la plus longue sous-suite
    // croissante, elle est donc DÉPLACÉE (pas « stays »).
    clic('button.rotate-btn')
    await new Promise(r => setTimeout(r, 120))

    const ul = el._shadow.querySelector('ul')
    const ordre = Array.from(ul.children as any).map((n: any) => n.tagName.toLowerCase() + (n.className ? '.' + n.className : '') + ':' + n.textContent)
    assert.deepEqual(ordre.filter((t: string) => t.startsWith('li')), ['li:b', 'li:c', 'li:a'], 'les 3 <li> ont bien tourné')

    const tag = el._shadow.querySelector('span.tag')
    assert.ok(tag, 'le <span.tag> existe toujours')
    // Il doit suivre SA ligne (celle de « a », passée en dernier), pas être
    // resté à l'ancienne première position.
    const precedents = []
    let __p = tag.previousSibling
    while (__p) { if (__p.nodeType === 1) precedents.push(__p.textContent); __p = __p.previousSibling }
    assert.equal(precedents[0], 'a', `le <span.tag> doit suivre le <li>a déplacé ; élément qui le précède : ${precedents[0]}`)

    win.close?.()
  })
})
