// <@checkbox> : prop `indeterminate` (tiret « une partie ») transmise à la case native
// cachée dans le shadow (poser la propriété sur l'hôte ne l'atteint jamais). Harnais
// build+happy-dom copié tel quel de tests/core-toggles.test.ts:1-52.

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

async function buildAndMount(hostSource: string, cores: string[]): Promise<{ window: any; document: any; hote: any; form: any }> {
  const root = mjsTmp('core-toggles')
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

describe('mjs-checkbox — indeterminate', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('a. indeterminate={$x} atteint la case native, suit les mises à jour du parent', async () => {
    const HOST = [
      '<script>',
      '  $ind = true',
      '</script>',
      '<form>',
      '  <@checkbox name="a" indeterminate={$ind}>Tout sélectionner</@checkbox>',
      '</form>',
    ].join('\n')
    const { hote } = await buildAndMount(HOST, ['checkbox'])
    const native = hote._shadow.querySelector('mjs-checkbox')._shadow.querySelector('input.native')
    assert.equal(native.indeterminate, true)

    hote._set('ind', false)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(native.indeterminate, false)

    hote._set('ind', true)
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(native.indeterminate, true)
  })

  it('b. défaut : indeterminate vaut false quand la prop est absente', async () => {
    const HOST = '<form><@checkbox name="b">x</@checkbox></form>'
    const { hote } = await buildAndMount(HOST, ['checkbox'])
    const native = hote._shadow.querySelector('mjs-checkbox')._shadow.querySelector('input.native')
    assert.equal(native.indeterminate, false)
  })

  it('c. le tiret existe dans le shadow (.box .dash) et dans le style compilé (sélecteur :indeterminate)', async () => {
    const HOST = '<form><@checkbox name="a">x</@checkbox></form>'
    const { hote } = await buildAndMount(HOST, ['checkbox'])
    const dash = hote._shadow.querySelector('mjs-checkbox')._shadow.querySelector('.box .dash')
    assert.equal(dash !== null, true)

    const root = mjsTmp('checkbox-dash-css')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), HOST)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const checkboxChunk = files.find((f) => /^checkbox-/.test(f))
    assert.ok(checkboxChunk, `chunk checkbox-*.js attendu parmi ${files.join(', ')}`)
    const code = readFileSync(join(outDir, checkboxChunk!), 'utf-8')
    assert.match(code, /input\.native:indeterminate/)
  })

  it('d. la valeur de formulaire ne dépend pas du tiret (hidden posé par checked, pas par indeterminate)', async () => {
    const HOST = '<form><@checkbox name="c" checked={true} indeterminate={true}>x</@checkbox></form>'
    const { hote } = await buildAndMount(HOST, ['checkbox'])
    const hidden = hote._shadow.querySelector('mjs-checkbox').querySelector('input[type=hidden]')
    assert.equal(hidden !== null, true)
  })
})
