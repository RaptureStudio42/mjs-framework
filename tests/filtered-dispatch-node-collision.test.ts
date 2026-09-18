// Régression : la « filtered dispatch »
// (@class{cond}, data-X={cond}, @style.X={cond}) indexe ses Maps runtime par
// `filterKey` dérivé UNIQUEMENT de (var externe, classe/attr/prop) — PAS du
// nœud. Deux éléments DIFFÉRENTS d'une même row partageant le même couple
// (ex. 2 `<td>` voisins avec `@class{item.id === $sel}="hot"`) partageaient
// la MÊME Map runtime, clée par l'item de la row : le second nœud enregistré
// écrasait l'entrée du premier → seul le DERNIER nœud réagissait au
// changement de sélection, le premier restait figé sur son état initial.
// Fix : `env.lid` (id unique par occurrence dans le template) intégré à
// `filterKey` pour @class, attribut générique (data-X) et @style.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`fdnc-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile)
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, document, el }
}

describe('filtered dispatch — 2 nœuds d\'une même row, même couple (var, classe/attr/prop)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('@class{item.id===$sel} sur 2 <td> voisins : LES DEUX réagissent au changement de sélection', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1},{id:2}]',
      '$sel = 1',
      '</script>',
      '<table><tbody>',
      '{for row in $rows}',
      '<tr>',
      '<td class="a" @class{row.id === $sel}="hot">a</td>',
      '<td class="b" @class{row.id === $sel}="hot">b</td>',
      '</tr>',
      '{end}',
      '</tbody></table>',
    ].join('\n')
    const { window, el } = await mount('fdncclass', src)
    const rows = el._shadow.querySelectorAll('tr')
    assert.equal(rows.length, 2)
    // Row 1 (id=1===sel) : LES DEUX <td> doivent avoir la classe "hot".
    assert.equal(rows[0].querySelector('.a').classList.contains('hot'), true)
    assert.equal(rows[0].querySelector('.b').classList.contains('hot'), true, "AVANT le fix : le 2e <td> (b) n'aurait jamais réagi (Map partagée écrasée)")

    // Change la sélection vers row 2.
    window.eval(`µ._set(document.querySelector('mjs-fdncclass'), 'sel', 2);`)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(rows[0].querySelector('.a').classList.contains('hot'), false)
    assert.equal(rows[0].querySelector('.b').classList.contains('hot'), false, "le 2e <td> doit aussi se DÉSACTIVER (sinon figé sur l'état initial)")
    assert.equal(rows[1].querySelector('.a').classList.contains('hot'), true)
    assert.equal(rows[1].querySelector('.b').classList.contains('hot'), true)
  })

  it('@style.color{item.id===$sel} sur 2 nœuds voisins : LES DEUX réagissent', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1},{id:2}]',
      '$sel = 1',
      '</script>',
      '<div>',
      '{for row in $rows}',
      "<span class=\"a\" @style.color={row.id === $sel ? 'red' : ''}></span>",
      "<span class=\"b\" @style.color={row.id === $sel ? 'red' : ''}></span>",
      '{end}',
      '</div>',
    ].join('\n')
    const { window, el } = await mount('fdncstyle', src)
    const as = el._shadow.querySelectorAll('.a')
    const bs = el._shadow.querySelectorAll('.b')
    assert.equal(as[0].style.color, 'red')
    assert.equal(bs[0].style.color, 'red', "AVANT le fix : .b n'aurait jamais réagi")

    window.eval(`µ._set(document.querySelector('mjs-fdncstyle'), 'sel', 2);`)
    await new Promise(r => setTimeout(r, 80))
    assert.equal(as[0].style.color, '')
    assert.equal(bs[0].style.color, '', "le 2e nœud doit aussi perdre la couleur")
    assert.equal(as[1].style.color, 'red')
    assert.equal(bs[1].style.color, 'red')
  })
})
