// dans `µ.Store` (API
// `new µStore(...)`), l'ÉNUMÉRATION RACINE (`{for k in store.data}` /
// `Object.keys(store.data)`) restait NON réactive — le trap `ownKeys` racine
// retournait `Reflect.ownKeys` sans poser aucun abonnement, et une clé racine
// LUE AVANT sa 1ʳᵉ écriture (données async) n'était jamais abonnée (la 1ʳᵉ
// écriture notifiait un Set vide). Fix : sentinelle structurelle `µ._mjs_STRUCT`
// (partagée avec µ.state) abonnée par `ownKeys` racine + notifiée par set (clé
// neuve) / delete racine ; et abonnement à la lecture d'une clé inconnue.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`enum-${name}`)
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

describe('µ.Store — énumération RACINE réactive + clé lue avant écriture', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('`Object.keys(store.data).length` re-rend à l\'AJOUT/RETRAIT d\'une clé racine', async () => {
    const src = [
      '<script lang="coffee">',
      '@box = new µStore({})',
      '</script>',
      '<p class="n">{Object.keys(@box.data).length}</p>',
    ].join('\n')
    const { window, el } = await mount('enumcount', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '0', 'aucune clé au départ')

    window.eval(`document.querySelector('mjs-enumcount').box.data.x = 1;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '1', 'AVANT le fix : ajout de clé racine ne re-rendait pas l\'énumération (ownKeys sans abonnement)')

    window.eval(`document.querySelector('mjs-enumcount').box.data.y = 2;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '2', '2e ajout re-rend')

    window.eval(`delete document.querySelector('mjs-enumcount').box.data.x;`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(n(), '1', 'retrait d\'une clé racine re-rend aussi')
  })

  it('clé racine LUE AVANT sa 1ʳᵉ écriture (données async) : la 1ʳᵉ écriture re-rend', async () => {
    const src = [
      '<script lang="coffee">',
      '@box = new µStore({})',
      '</script>',
      '<p class="v">[{@box.data.async_val}]</p>',
    ].join('\n')
    const { window, el } = await mount('enumasync', src)
    const v = () => el._shadow.querySelector('.v').textContent.trim()
    assert.equal(v(), '[]', 'clé inconnue au départ → vide')

    window.eval(`document.querySelector('mjs-enumasync').box.data.async_val = 'hi';`)
    await new Promise(r => setTimeout(r, 90))
    assert.equal(v(), '[hi]', 'AVANT le fix : lire une clé pas encore écrite n\'abonnait pas → 1ʳᵉ écriture notifiait un Set VIDE, DOM figé')
  })
})
