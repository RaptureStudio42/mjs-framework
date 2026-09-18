// les écritures PAR MOTIF sur `$$` passent
// par `µ._storeSet`/`_mjs_storeDeepSet` comme les écritures simples (path-tracker.ts,
// visiteur AssignmentExpression). Verrouille bout-en-bout (composant COMPILÉ +
// monté, happy-dom) la panne réelle — repro exacte du harnais
// de diagnostic : `delete $$a` PUIS, dans le MÊME
// handler, `[$$a, $$b] = [$$b, $$a]` — AVANT le correctif, l'accesseur de `a`
// venait d'être supprimé, la lecture RHS `µ.store.a` rendait `undefined`, ce
// `undefined` s'écrivait dans `b` (notifié : `b` perdait sa valeur en silence)
// et `a` redevenait une propriété PLATE (plus jamais notifiée). Mesuré (harnais,
// AVANT correctif) : DOM affiché `-` après clic, descripteur de `µ.store.a`
// `{"value":2,...}` (plat, plus d'accesseur).

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

// Compile UN composant et le monte dans une fenêtre happy-dom — même mécanique
// que le harnais de diagnostic (compile → eval mjs_core + composant →
// <mjs-nom> dans le DOM → attend le montage) et que mountMulti de
// store-static-dispatch.test.ts (dont ce fichier reprend aussi le style).
async function mount(name: string, source: string) {
  const root   = mjsTmp('pattern-write')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)

  document.body.insertAdjacentHTML('beforeend', `<mjs-${name}></mjs-${name}>`)
  const el = document.body.querySelector(`mjs-${name}`)
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

describe('écriture par motif sur le store — bout-en-bout (composant compilé)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('delete $$a PUIS [$$a, $$b] = [$$b, $$a] dans le MÊME handler : échange notifié, accesseur de a RESTAURÉ', async () => {
    const { window, el } = await mount('wipeswap', [
      '<script>',
      '$$a = 1',
      '$$b = 2',
      'wipeThenSwap = ->',
      '  delete $$a',
      '  [$$a, $$b] = [$$b, $$a]',
      '</script>',
      '<button class="go" @click={wipeThenSwap()}>{$$a}-{$$b}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '1-2', 'AVANT clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))

    // mesuré (harnais, AVANT correctif) : DOM affiché "-" (les DEUX
    // slots vides, notification de `a` jamais partie) ; APRÈS correctif : "2-"
    // (l'échange est mathématiquement `a←ancien b=2, b←ancien a=undefined` — la
    // valeur de `b` est `undefined` dans LES DEUX cas, ça n'est PAS ce qui
    // distingue rouge de vert ; ce qui distingue : `a` est bien NOTIFIÉ → DOM à
    // jour, et son accesseur est RESTAURÉ, pas juste sa valeur brute).
    assert.equal(txt(), '2-', 'APRÈS clic : a notifié et affiché (mesuré AVANT correctif : "-", notification jamais partie)')
    assert.equal(window.µ._mjs_storeRaw.a, 2, 'a écrit via µ._storeSet (valeur RAW présente, pas seulement posée sur une propriété plate)')
    const descA = Object.getOwnPropertyDescriptor(window.µ.store, 'a')
    assert.equal(typeof descA?.set, 'function', 'a redevient un ACCESSEUR (avant fix : propriété plate {value:2}, plus jamais notifiée)')
  })

  it('témoin : échange SIMPLE sans delete reste notifié (déjà vert avant ce correctif)', async () => {
    const { el } = await mount('plainswap', [
      '<script>',
      '$$a = 1',
      '$$b = 2',
      'swap = -> [$$a, $$b] = [$$b, $$a]',
      '</script>',
      '<button class="go" @click={swap()}>{$$a}-{$$b}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '1-2')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '2-1', 'échange notifié : accesseur natif encore vivant (jamais supprimé), le trap set suffisait déjà')
  })

  // un trou distinct : le motif écrit DIRECTEMENT dans un handler (pas via une fonction du <script>)
  // ne compilait pas — `$$a` en handler réécrit en `µ.store.a` (pas en pointillé sigil), Pass 4 le prenait pour un nom
  // nu et le promouvait `.=` → Civet émettait `let [µ.store.a, µ.store.b] = […]`, JS invalide (échec au bundler).
  it('motif store DIRECT dans le handler (@click={[$$a, $$b] = [$$b, $$a]}) : échange notifié, µ.store.a/b corrects', async () => {
    const { window, el } = await mount('directswap', [
      '<script>',
      '$$a = 1',
      '$$b = 2',
      '</script>',
      '<button class="go" @click={[$$a, $$b] = [$$b, $$a]}>{$$a}-{$$b}</button>',
    ].join('\n'))
    const txt = () => el._shadow.textContent.trim()
    assert.equal(txt(), '1-2', 'AVANT clic')

    el._shadow.querySelector('.go').click()
    await new Promise(r => setTimeout(r, 80))
    assert.equal(txt(), '2-1', 'APRÈS clic : échange direct dans le handler, notifié')
    assert.equal(window.µ.store.a, 2, 'µ.store.a correct')
    assert.equal(window.µ.store.b, 1, 'µ.store.b correct')
  })
})
