// Régression — divergence root vs
// `{for}` dans generator/attributes/index.ts : le chemin racine passait par
// `this._mjs_updAttr` (→ props booléennes, retrait sur null/false, filtre XSS
// `µ._mjs_safeAttr`), la boucle `{for}` émettait un `setAttribute`/`String()`
// BRUT, sans aucune de ces garanties. Deux bugs concrets :
//
//   1. `title="prix : {$prefix}"` dans un `{for}` : l'update visait
//      `this._mjs_nodes[id]` (TOUJOURS undefined en boucle — les refs de row
//      vivent dans `__nodes`) → no-op silencieux sur TOUTES les rows.
//   2. `disabled={item.locked}` avec `locked=false` : `setAttribute('disabled',
//      String(false))` → `disabled="false"` = TOUJOURS désactivé (présence
//      d'attribut, peu importe la valeur).
//
// Fix : `µ._mjs_updAttrNode(node, name, val)` factorise la logique EXACTE de
// `_mjs_updAttr` (root), appelée désormais aussi bien au root qu'en `{for}`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`attrfor-${name}`)
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
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, document, el }
}

describe('attributs dynamiques en {for} — parité avec le root', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("attribut interpolé contenant un `$var` dans un {for} : n'est plus perdu (CRITIQUE)", async () => {
    const src = [
      '<script lang="coffee">',
      '$prefix = "Prix"',
      '$rows = [{id:1,label:"a"},{id:2,label:"b"}]',
      '</script>',
      '<ul>{for row in $rows}<li title="{$prefix} : {row.label}">{row.label}</li>{end}</ul>',
    ].join('\n')
    const { el } = await mount('attrforvar', src)
    const items = el._shadow.querySelectorAll('li')
    assert.equal(items.length, 2)
    assert.equal(items[0].getAttribute('title'), 'Prix : a', "AVANT le fix : title vide (this._mjs_nodes[id] undefined en boucle)")
    assert.equal(items[1].getAttribute('title'), 'Prix : b')
  })

  it('booléen dynamique `disabled={item.locked}` avec locked=false : attribut RETIRÉ (CRITIQUE)', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,locked:false},{id:2,locked:true}]',
      '</script>',
      '<ul>{for row in $rows}<li><button disabled={row.locked}>x</button></li>{end}</ul>',
    ].join('\n')
    const { el } = await mount('attrforbool', src)
    const buttons = el._shadow.querySelectorAll('button')
    assert.equal(buttons.length, 2)
    assert.equal(buttons[0].disabled, false, "AVANT le fix : disabled=\"false\" (string) = TOUJOURS désactivé (bug)")
    assert.equal(buttons[1].disabled, true)
  })

  it('valeur `null`/`undefined` dynamique en {for} : attribut RETIRÉ, pas la chaîne littérale "null"', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,ttl:null},{id:2,ttl:"5"}]',
      '</script>',
      '<ul>{for row in $rows}<li data-ttl={row.ttl}>x</li>{end}</ul>',
    ].join('\n')
    const { el } = await mount('attrfornull', src)
    const items = el._shadow.querySelectorAll('li')
    assert.equal(items[0].hasAttribute('data-ttl'), false, "AVANT le fix : data-ttl=\"null\" (chaîne littérale)")
    assert.equal(items[1].getAttribute('data-ttl'), '5')
  })

  it('cas nominal (attribut statique + dynamique sans $, déjà testé ailleurs) : pas de régression', async () => {
    const src = [
      '<script lang="coffee">$rows = [{id:1,cls:"a"}]</script>',
      '<ul>{for row in $rows}<li class={row.cls}>x</li>{end}</ul>',
    ].join('\n')
    const { el } = await mount('attrfornominal', src)
    assert.equal(el._shadow.querySelector('li').getAttribute('class'), 'a')
  })
})
