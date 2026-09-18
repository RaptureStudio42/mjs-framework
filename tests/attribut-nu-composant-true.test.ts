// sur une balise de COMPOSANT, un attribut nu (`<@checkbox
// disabled>`, `<mjs-card active>`) passe désormais `true` à la compilation (`disabled='true'`
// écrit dans le gabarit, lu par `parseProp` du runtime) au lieu de la chaîne vide que `parseProp`
// ne reconnaissait pas. `title=""` (valeur écrite mais vide, chemin `type: 'static'`) reste `''`.
// Les balises HTML natives (`<button disabled>`) sont inchangées. Patrons repris de
// tests/attributes-await-booleens-props.test.ts (mountFiles, l.28-50) et tests/core-toggles.test.ts
// (buildAndMount, l.25-50, module cœur checkbox).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un ou plusieurs .mjs (bundler complet) et monte `<rootTag>` dans une fenêtre
// happy-dom fraîche — calque de tests/attributes-await-booleens-props.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any }> {
  const root   = mjsTmp('attr-nu-composant')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles  = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
  const compCode = jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.insertAdjacentHTML('beforeend', `<${rootTag}></${rootTag}>`)
  const el = document.body.querySelector(rootTag)
  return { window, document, el }
}

// module cœur (checkbox…) : calque de tests/core-toggles.test.ts (buildAndMount)
async function buildAndMount(hostSource: string, cores: string[]): Promise<{ window: any; document: any; hote: any; form: any }> {
  const root   = mjsTmp('attr-nu-core')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), hostSource)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const chunkFiles = [pick(/^mjs_core-/), ...cores.map((c) => pick(new RegExp(`^${c}-`))), pick(/^hote-/)]
  const code = chunkFiles.map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  window.eval(`${code}\nglobalThis.µ = µ;`)
  document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  const hote = document.body.querySelector('mjs-hote')
  const form = hote._shadow.querySelector('form')
  return { window, document, hote, form }
}

describe('attribut nu sur balise de composant = true', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const CHILD = [
    '<script>',
    '  $disabled = false',
    "  $title = 'x'",
    '</script>',
    '<p class="d">{typeof $disabled}:{String($disabled)}</p><p class="t">[{$title}]</p>',
  ].join('\n')

  it('a. <@child disabled title=""> : $disabled devient true (boolean), $title reste vide', async () => {
    const { el } = await mountFiles({ 'hote.mjs': '<@child disabled title="">', 'child.mjs': CHILD }, 'mjs-hote')
    await new Promise((r) => setTimeout(r, 150))
    const child = el._shadow.querySelector('mjs-child')._shadow
    assert.equal(child.querySelector('.d').textContent, 'boolean:true')
    assert.equal(child.querySelector('.t').textContent, '[]')
  })

  it("b. module cœur checkbox : <@checkbox disabled> désactive réellement l'input natif", async () => {
    const host = '<form><@checkbox name="a" disabled>Accepte</@checkbox></form>'
    const { hote } = await buildAndMount(host, ['checkbox'])
    const native = hote._shadow.querySelector('mjs-checkbox')._shadow.querySelector('input.native')
    assert.equal(native.disabled, true)
  })

  it('c. dans un {for} : chaque <@child disabled> reçoit true', async () => {
    const hote = ['<script>', '  $list = [1, 2]', '</script>', '{for n in $list}<@child disabled>{end}'].join('\n')
    const { el } = await mountFiles({ 'hote.mjs': hote, 'child.mjs': CHILD }, 'mjs-hote')
    await new Promise((r) => setTimeout(r, 150))
    const children = Array.from(el._shadow.querySelectorAll('mjs-child')) as any[]
    assert.equal(children.length, 2)
    for (const c of children) assert.equal(c._shadow.querySelector('.d').textContent, 'boolean:true')
  })

  // NB — `disabled` sur `<button>` (natif) est déjà réécrit AVANT `booleanAttr()` par
  // `MJS_NATIVE_BOOLEAN_ATTRS` (src/parser/index.ts, mécanisme PRÉEXISTANT) : type
  // `dynamic` littéral `true`, placeholder `disabled=''` posé
  // au clonage, valeur réelle posée à l'exécution par `_mjs_updAttr`. Jamais `disabled='true'`
  // littéral quoi qu'il arrive — c'est ce que ce test prouve, sans supposer la forme du
  // placeholder.
  it("d. natif inchangé : <button disabled> ne passe jamais par disabled='true' littéral", async () => {
    const { output } = await transpile('<button disabled>x</button>', { moduleName: 'nunatif' })
    assert.equal(output.includes("disabled='true'"), false)
    assert.equal(output.includes('<button disabled'), true)
  })

  it('e. exclusions : popover reste nu, disabled devient true sur la même balise composant', async () => {
    const popover  = await transpile('<@child popover>', { moduleName: 'excl1' })
    const disabled = await transpile('<@child disabled>', { moduleName: 'excl2' })
    assert.equal(popover.output.includes('<mjs-child popover'), true)
    assert.equal(popover.output.includes("popover='true'"), false)
    assert.equal(disabled.output.includes("disabled='true'"), true)
  })
})
