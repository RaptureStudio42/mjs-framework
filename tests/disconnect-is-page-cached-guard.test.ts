// disconnectedCallback() (mjs_element.ts) appelle µ._mjs_isPageCached(__self) dans la microtâche de
// destruction DIFFÉRÉE, SANS garde. `_mjs_isPageCached` vit dans mjs_init.ts — un des 4 fichiers du
// CŒUR STRICT (jamais retirés, quels que soient `runtime`/les faits détectés) : contrairement à
// `_mjs_storeSubscribe`/`_mjs_storeUnsubscribe` (module optionnel `vault`, cf. tests/disconnect-store-
// globals-guard.test.ts), il n'y a PAS de vrai risque de plantage aujourd'hui. Garde défensive
// posée quand même, même patron que µ._mjs_cleanupUniversalDeps (tests/disconnect-cleanup-universal-
// deps-guard.test.ts) : absence SIMULÉE par retrait après montage, pas une config réelle — un
// prérequis de robustesse si un cœur futur s'en passait, jamais un changement de comportement
// observable aujourd'hui.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
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

async function loadHarness() {
  const root = mjsTmp('disco-pagecached-guard')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  // hook µdestroy : pose `_mjs_hooks.destroy`, condition qui déclenche la destruction
  // DIFFÉRÉE (queueMicrotask) dans disconnectedCallback — c'est ce chemin qui appelle
  // µ._mjs_isPageCached.
  writeFileSync(join(srcDir, 'discog.mjs'), [
    '<script lang="coffee">',
    'µdestroy -> window.__destroyed = true',
    '</script>',
    '<p>x</p>',
  ].join('\n'))

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => /^discog-/.test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')

  win.eval(`
    ${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}
    globalThis.µ = µ;
    ${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}
  `)
  assert.equal(typeof win.µ._mjs_isPageCached, 'function', 'préalable : mjs_init.ts est cœur strict, toujours présent')
  return { win, document }
}

function mount(document: any, tag: string): any {
  document.body.innerHTML = `<${tag}></${tag}>`
  return document.body.firstElementChild
}

describe('mjs_element.ts — la destruction différée tolère µ._mjs_isPageCached absent (garde défensive)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('µ._mjs_isPageCached ABSENTE (simulé) : aucune exception dans la microtâche, la destruction tourne quand même', async function () {
    const { win, document } = await loadHarness()
    const el = mount(document, 'mjs-discog')
    await new Promise((r) => setTimeout(r, 20))

    delete win.µ._mjs_isPageCached
    el.remove()  // déconnecte pour de bon (isConnected devient false) : arme la microtâche de destruction

    let leve: unknown = null
    await new Promise<void>((resolve) => {
      queueMicrotask(() => {
        setTimeout(() => resolve(), 20)  // laisse la microtâche interne de disconnectedCallback tourner
      })
    }).catch((e) => { leve = e })

    assert.equal(leve, null, 'la microtâche de destruction différée ne doit jamais planter sans µ._mjs_isPageCached')
    assert.equal(win.__destroyed, true, 'µdestroy doit quand même tourner (la garde ne coupe QUE _mjs_isPageCached)')

    win.close?.()
  })

  it('cas normal : présente, elle est bien APPELÉE — la garde ne coupe jamais un appel réel', async function () {
    const { win, document } = await loadHarness()
    let calls = 0
    const orig = win.µ._mjs_isPageCached
    win.µ._mjs_isPageCached = function (...args: any[]) { calls++; return orig.apply(this, args) }

    const el = mount(document, 'mjs-discog')
    await new Promise((r) => setTimeout(r, 20))
    el.remove()
    await new Promise((r) => setTimeout(r, 40))

    assert.equal(calls, 1, '_mjs_isPageCached doit être appelée dans la microtâche de destruction dès qu\'elle existe')
    assert.equal(win.__destroyed, true)

    win.close?.()
  })
})
