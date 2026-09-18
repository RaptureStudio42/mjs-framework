// dans un store µ.state
// (`$$` / `µ.state()`), les collections natives (Array/Map/Set) étaient retournées
// BRUTES par `_wrap` → `$$todos.push(x)` / `$$m.set(k,v)` / `$$s.add(x)` — l'op la
// plus naturelle du store documenté — mutaient SANS notifier : aucun re-render.
// Asymétrie avec `µ.Store` (qui wrappe déjà les mutateurs) et avec l'état LOCAL
// (`_mjs_wrapDeep`). Fix : `_wrap` proxifie les collections avec mutateurs notifiants
// (clé racine + sentinelle `µ._mjs_STRUCT`), aligné sur `µ.Store._mjs_buildProxy`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`coll-${name}`)
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

describe('µ.state — collections natives réactives (push/add/set notifient)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('`store.arr.push(x)` re-rend un lecteur de `.length` (le cas documenté $$todos.push)', async () => {
    const src = [
      '<script>',
      '@todos = µ.state({list: []})',
      '</script>',
      '<p class="n">{@todos.list.length}</p>',
    ].join('\n')
    const { el } = await mount('collpush', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '0', 'longueur initiale = 0')

    el.todos.list.push('a')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), '1', 'AVANT le fix : push mutait le tableau BRUT sans notifier → figé à 0')

    el.todos.list.push('b', 'c')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), '3', 'push multiple re-rend aussi')

    el.todos.list.splice(0, 1)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), '2', 'splice (mutateur) re-rend')
  })

  it('`store.set.add(x)` re-rend un lecteur de `.size`', async () => {
    const src = [
      '<script>',
      '@bag = µ.state({tags: new Set()})',
      '</script>',
      '<p class="s">{@bag.tags.size}</p>',
    ].join('\n')
    const { el } = await mount('colladd', src)
    const s = () => el._shadow.querySelector('.s').textContent.trim()
    assert.equal(s(), '0', 'taille initiale = 0')

    el.bag.tags.add('x')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(s(), '1', 'Set.add doit notifier')

    el.bag.tags.add('y')
    el.bag.tags.add('x') // doublon → pas de nouvelle entrée
    await new Promise(r => setTimeout(r, 60))
    assert.equal(s(), '2', 'add d\'un doublon ne change pas la taille')
  })

  it('`µ.raw(arr)` dans un store reste BRUT (contrat µ.raw respecté, lecture OK)', async () => {
    const src = [
      '<script lang="coffee">',
      '@st = µ.state({data: µ.raw([1, 2, 3])})',
      '</script>',
      '<p class="len">{@st.data.length}</p>',
    ].join('\n')
    const { el } = await mount('collraw', src)
    assert.ok(el._shadow, 'monte sans crash avec une collection µ.raw dans le store')
    assert.equal(el._shadow.querySelector('.len').textContent.trim(), '3',
      'une collection µ.raw reste lisible (retournée brute, pas proxifiée)')
  })
})
