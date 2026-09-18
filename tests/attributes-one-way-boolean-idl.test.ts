// liaison UNE-SENS `disabled={$d}` sur une balise SANS propriété IDL native
// (réserve de périmètre laissée par tests/generator-attributes-guards.test.ts : le
// scénario en one-way délègue entièrement à `src/runtime/mjs_element.ts`, `µ._mjs_updAttrNode`,
// corrigé ICI). Avant fix : `node[attr] = boolVal` compte sur la
// réflexion IDL native pour retirer l'attribut à `false` — sur `<div>` (aucune IDL `disabled`),
// l'assignation ne crée qu'une expando, l'attribut HTML reste posé pour toujours.
// Harnais mount() copié de tests/state-collection-reactivity.test.ts:16-40.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`onewaybool-${name}`)
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
  return { window, el }
}

const flush = () => new Promise((r) => setTimeout(r, 80))

describe('µ._mjs_updAttrNode : booléen one-way sans IDL native', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<div disabled={$d}> : retire l\'attribut sur false, le pose sur true, re-bascule juste', async () => {
    const src = ['<script>', '$d = false', '</script>', '<div disabled={$d}>x</div>'].join('\n')
    const { el } = await mount('divonewayd', src)
    const div = el._shadow.querySelector('div')
    assert.equal(div.hasAttribute('disabled'), false, 'div sans IDL native : attribut absent au départ (false)')

    el._set('d', true)
    await flush()
    assert.equal(div.hasAttribute('disabled'), true, 'attribut posé sur true')

    el._set('d', false)
    await flush()
    assert.equal(div.hasAttribute('disabled'), false, 're-bascule à false : attribut de nouveau absent')
  })

  it('<button disabled={$d}> : non-régression (IDL native, réflexion inchangée)', async () => {
    const src = ['<script>', '$d = false', '</script>', '<button disabled={$d}>x</button>'].join('\n')
    const { el } = await mount('btnonewayd', src)
    const btn = el._shadow.querySelector('button')
    assert.equal(btn.hasAttribute('disabled'), false, 'bouton natif : attribut absent sur false')

    el._set('d', true)
    await flush()
    assert.equal(btn.hasAttribute('disabled'), true, 'attribut posé sur true (réflexion native)')

    el._set('d', false)
    await flush()
    assert.equal(btn.hasAttribute('disabled'), false, 're-bascule à false : attribut retiré (réflexion native)')
  })

  it('<div hidden={$h}> : inchangé (hidden EST une IDL de HTMLElement, même sur div)', async () => {
    const src = ['<script>', '$h = false', '</script>', '<div hidden={$h}>x</div>'].join('\n')
    const { el } = await mount('divonewayh', src)
    const div = el._shadow.querySelector('div')
    assert.equal(div.hasAttribute('hidden'), false, 'attribut absent sur false')

    el._set('h', true)
    await flush()
    assert.equal(div.hasAttribute('hidden'), true, 'attribut posé sur true (réflexion native HTMLElement)')

    el._set('h', false)
    await flush()
    assert.equal(div.hasAttribute('hidden'), false, 're-bascule à false : attribut retiré (réflexion native)')
  })
})
