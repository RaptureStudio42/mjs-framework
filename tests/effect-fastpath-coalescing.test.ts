// Régression — coalescence des µeffect user dans le
// fast-path SYNC de `_mjs_invalidate` (mjs_element.ts, ~1802-1918). AVANT le fix :
// N écritures dans le MÊME tick synchrone sur une variable bindée déclenchaient
// N exécutions du même µeffect, sur des états INTERMÉDIAIRES (mesuré : 5
// écritures → 4 runs, cf. tests/batching-measure.harness.ts, commentaire d'en-tête
// du fast-path ligne 1796-1798 documentant l'intention d'origine non respectée).
// Fix : les µeffect user sont routés vers UNE microtask coalescée (accumulation
// des vars muées dans `_mjs_ue_pending`, une seule passe `_mjs_runEffectsV2` sur l'état
// FINAL). Les bindings compilés (`_mjs_effectsByVar`, boucle __list) restent, eux,
// 100% synchrones — chemin chaud inchangé.

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

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('_mjs_invalidate — coalescence des µeffect user (fast-path sync)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildAndMount(name: string, src: string) {
    const root = mjsTmp(`fpcoal-${name}`)
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), src)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)
    document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
    await sleep(80)
    return { win, document, el: document.body.firstElementChild }
  }

  it('1. coalescence même variable : 5 écritures même tick = 1 seul run, sur l\'état FINAL', async () => {
    const src = `
<script lang="coffee">
$a = 0

µeffect ->
  _ = $a
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp1samevar', src)
    assert.equal(win.__runs, 1, 'effet tourne 1x au mount')
    win.__runs = 0
    for (let i = 1; i <= 5; i++) el._set('a', i)
    await sleep(40)
    assert.equal(win.__runs, 1, '5 écritures même tick sur la même variable = UN seul run (coalescé)')
    assert.equal(el._shadow.querySelector('p.o').textContent.trim(), '5', 'le DOM doit refléter la valeur FINALE (5)')
  })

  it('2. coalescence multi-racines : 3 écritures (a, b, c) même tick = 1 run, état FINAL', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0
$c = 0

µeffect ->
  window.__last = [$a, $b, $c]
  window.__runs2 = (window.__runs2 or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp2multi', src)
    assert.equal(win.__runs2, 1, 'effet tourne 1x au mount')
    win.__runs2 = 0
    el._set('a', 1)
    el._set('b', 2)
    el._set('c', 3)
    await sleep(40)
    assert.equal(win.__runs2, 1, '3 écritures multi-racines même tick = UN seul run (coalescé)')
    assert.deepEqual(Array.from(win.__last), [1, 2, 3], "l'effet doit lire l'état FINAL des 3 variables (jamais un état intermédiaire)")
  })

  it('3. bindings toujours synchrones : sans µeffect, `_set` met à jour le DOM immédiatement (fast-path intact)', async () => {
    const src = `
<script lang="coffee">
$a = 0
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp3syncbind', src)
    el._set('a', 42)
    // AUCUN await ici : le binding doit être déjà posé, synchrone.
    assert.equal(el._shadow.querySelector('p.o').textContent.trim(), '42', 'le fast-path des bindings reste 100% synchrone (pas de µeffect user)')
    void win
  })

  it('4. deux ticks distincts = deux runs (la coalescence ne mange pas les ticks séparés)', async () => {
    const src = `
<script lang="coffee">
$a = 0

µeffect ->
  _ = $a
  window.__runs4 = (window.__runs4 or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp4twoticks', src)
    assert.equal(win.__runs4, 1, 'effet tourne 1x au mount')
    win.__runs4 = 0
    el._set('a', 1)
    await sleep(40)
    el._set('a', 2)
    await sleep(40)
    assert.equal(win.__runs4, 2, 'deux salves séparées par un sleep = DEUX runs distincts')
  })

  it('5. cleanup exécuté entre deux runs (2 écritures en 2 ticks séparés)', async () => {
    const src = `
<script lang="coffee">
$a = 0

µeffect ->
  _ = $a
  window.__runs5 = (window.__runs5 or 0) + 1
  cleanupFn = ->
    window.__cleanups5 = (window.__cleanups5 or 0) + 1
    return
  cleanupFn
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp5cleanup', src)
    assert.equal(win.__runs5, 1, 'effet tourne 1x au mount')
    win.__cleanups5 = 0
    el._set('a', 1)
    await sleep(40)
    el._set('a', 2)
    await sleep(40)
    assert.ok(win.__cleanups5 >= 1, 'au moins 1 cleanup exécuté entre les 2 runs')
  })

  it('6. écriture imbriquée par un effet — aucun effet perdu (fix finally _mjs_ue_pending, cf. mjs_element.ts ~1901-1914)', async () => {
    // effect1 dépend de $a et ÉCRIT $b (imbriqué, sous µ._mjs_inEffect=true) ;
    // effect2 dépend UNIQUEMENT de $b. AVANT le fix : le `finally` de la
    // microtask `_mjs_ue_pending` écrasait le Set fraîchement alloué par le batch
    // imbriqué (déclenché par l'écriture de $b) avec `__prevMuted` (null) —
    // effect2 ne voyait alors JAMAIS `mutedVars.has('b')` et ne tournait plus.
    const src = `
<script lang="coffee">
$a = 0
$b = 0

µeffect ->
  $b = $a * 10
  return

µeffect ->
  _ = $b
  window.__bRuns = (window.__bRuns or 0) + 1
  window.__bVal = $b
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('fp6nestedwrite', src)
    win.__bRuns = 0
    win.__bVal = undefined
    el._set('a', 1)
    await sleep(60)
    assert.ok(win.__bRuns >= 1, "l'effet dépendant de $b (écrit par un AUTRE effet imbriqué) ne doit jamais être perdu")
    assert.equal(win.__bVal, 10, '$b doit refléter l\'état FINAL ($a * 10, soit 1 * 10)')
    assert.equal(el._shadow.querySelector('p.o').textContent.trim(), '1', 'le DOM doit refléter $a=1')
  })
})
