// Test neuf — accessibilité : un `aria-*` à `false` doit rester PRÉSENT
// (valeur littérale "false", utile au lecteur d'écran) au lieu d'être retiré.
// Seuls `null`/`undefined` retirent encore un `aria-*` (absence voulue) ; le
// comportement générique non-aria (`data-*`, `title`…) reste inchangé. Patron
// de montage calqué sur tests/attribute-for-divergence.test.ts (bundler réel,
// happy-dom).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`ariaattr-${name}`)
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

describe('aria-* à false : présent, valeur "false"', function () {
  this.timeout(40000)
  let el: any

  before(async () => {
    const src = [
      '<script lang="coffee">',
      '$expandedFalse = false',
      '$selectedFalse = false',
      '$labelNull = null',
      '$hiddenUndef = undefined',
      '$dataXFalse = false',
      '$titleFalse = false',
      '$expandedTrue = true',
      '</script>',
      '<div id="p1" aria-expanded={$expandedFalse}></div>',
      '<div id="p2" aria-selected={$selectedFalse}></div>',
      '<div id="p3" aria-label={$labelNull}></div>',
      '<div id="p4" aria-hidden={$hiddenUndef}></div>',
      '<div id="p5" data-x={$dataXFalse}></div>',
      '<div id="p6" title={$titleFalse}></div>',
      '<div id="p7" aria-expanded={$expandedTrue}></div>'
    ].join('\n')
    const mounted = await mount('ariaattrfalse', src)
    el = mounted.el
  })

  after(async () => { await terminateSharedWorkerPool() })

  const probe = (id: string) => el._shadow.querySelector(`#${id}`)

  it('aria-expanded={false} : attribut PRÉSENT, valeur "false" (pas retiré)', () => {
    assert.equal(probe('p1').getAttribute('aria-expanded'), 'false')
  })

  it('aria-selected à false : valeur "false"', () => {
    assert.equal(probe('p2').getAttribute('aria-selected'), 'false')
  })

  it('aria-label={null} : attribut RETIRÉ (absence voulue)', () => {
    assert.equal(probe('p3').hasAttribute('aria-label'), false)
  })

  it('aria-hidden={undefined} : attribut RETIRÉ', () => {
    assert.equal(probe('p4').hasAttribute('aria-hidden'), false)
  })

  it('data-x={false} : attribut RETIRÉ (comportement générique non-aria inchangé)', () => {
    assert.equal(probe('p5').hasAttribute('data-x'), false)
  })

  it('title={false} : attribut RETIRÉ (non-aria inchangé)', () => {
    assert.equal(probe('p6').hasAttribute('title'), false)
  })

  it('aria-expanded={true} : valeur "true" (String(val) existant, inchangé)', () => {
    assert.equal(probe('p7').getAttribute('aria-expanded'), 'true')
  })
})
