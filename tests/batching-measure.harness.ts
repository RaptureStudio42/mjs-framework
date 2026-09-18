// Harnais de MESURE (pas un test de non-régression) — quantifie le comportement
// de batching du moteur réactif V2 : combien de fois les µeffect utilisateur et
// les bindings DOM (_mjs_updText/_mjs_updAttr) tournent pour une salve d'écritures dans
// le même tick synchrone, vs une salve étalée sur plusieurs microtâches.
// Extension volontairement SANS `.test.ts` : ne doit PAS être ramassé par `npm test`.
// Relance : npx mocha tests/batching-measure.harness.ts --extension ts --require tsx/esm --exit

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms))

// monkey-patch posé APRÈS le core, AVANT le composant — hérité par la classe
// composant (`extends µ.Element`) sans toucher au framework sur disque.
const INSTRUMENT = `
(function () {
  var proto = µ.Element.prototype;
  window.__updText = 0;
  window.__updAttr = 0;
  window.__invalidate = 0;
  var origUpdText = proto._mjs_updText;
  proto._mjs_updText = function () {
    window.__updText++;
    return origUpdText.apply(this, arguments);
  };
  var origUpdAttr = proto._mjs_updAttr;
  proto._mjs_updAttr = function () {
    window.__updAttr++;
    return origUpdAttr.apply(this, arguments);
  };
  var origInvalidate = proto._mjs_invalidate;
  proto._mjs_invalidate = function () {
    window.__invalidate++;
    return origInvalidate.apply(this, arguments);
  };
})();
`

// compile un composant .mjs inline vers un tmpdir puis monte dans une Window happy-dom
// instrumentée ; retourne l'élément monté + la window pour lire les compteurs.
async function buildAndMount(name: string, src: string) {
  const root = mjsTmp(`batchmeasure-${name}`)
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
  win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;`)
  win.eval(INSTRUMENT)
  win.eval(stripEsm(readFileSync(join(outDir, compFile), 'utf-8')))
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  await sleep(80)
  // le mount fait ses propres passes : on remet les compteurs à zéro AVANT la salve mesurée
  win.__updText = 0
  win.__updAttr = 0
  win.__invalidate = 0
  win.__runs = 0
  return { win, document, el: document.body.firstElementChild }
}

function report(scenario: string, win: any) {
  const line = `MEASURE ${scenario} | effectRuns=${win.__runs || 0} updText=${win.__updText || 0} updAttr=${win.__updAttr || 0} invalidate=${win.__invalidate || 0}`
  console.log(line)
  return line
}

describe('MESURE — batching moteur réactif V2 (fast-path vs coalescence microtâche)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('3 écritures même tick, effet multi-racines, AVEC binding template', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0
$c = 0

µeffect ->
  _ = $a
  _ = $b
  _ = $c
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('s1bind', src)
    el._set('a', 1)
    el._set('b', 1)
    el._set('c', 1)
    await sleep(40)
    report('S1-avec-binding', win)
    assert.ok(win.__runs >= 1, 'S1 : effect doit au moins tourner une fois')
  })

  it('3 écritures même tick, effet multi-racines, SANS binding template', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0
$c = 0

µeffect ->
  _ = $a
  _ = $b
  _ = $c
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">statique</p>
`
    const { win, el } = await buildAndMount('s2nobind', src)
    el._set('a', 1)
    el._set('b', 1)
    el._set('c', 1)
    await sleep(40)
    report('S2-sans-binding', win)
    assert.ok(win.__runs >= 1, 'S2 : effect doit au moins tourner une fois')
  })

  it('5 écritures même variable, même tick', async () => {
    const src = `
<script lang="coffee">
$a = 1

µeffect ->
  _ = $a
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('s3samevar', src)
    for (let i = 1; i <= 5; i++) el._set('a', i)
    await sleep(40)
    report('S3-cinq-ecritures-meme-var', win)
    assert.ok(win.__runs >= 1, 'S3 : effect doit au moins tourner une fois')
    assert.ok(win.__updText >= 1, 'S3 : updText doit au moins tourner une fois')
  })

  it('computeds chaînés, UNE écriture sur la racine', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = $a * 2
$c = $b + 1

µeffect ->
  _ = $c
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`
    const { win, el } = await buildAndMount('s4achain', src)
    el._set('a', 5)
    await sleep(40)
    report('S4a-computed-1-ecriture', win)
    assert.ok(win.__runs >= 1, 'S4a : effect doit au moins tourner une fois')
  })

  it('computeds chaînés, DEUX écritures même tick sur la racine', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = $a * 2
$c = $b + 1

µeffect ->
  _ = $c
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`
    const { win, el } = await buildAndMount('s4bchain', src)
    el._set('a', 6)
    el._set('a', 7)
    await sleep(40)
    report('S4b-computed-2-ecritures', win)
    assert.ok(win.__runs >= 1, 'S4b : effect doit au moins tourner une fois')
  })

  it('cascade inter-effets (effet 1 écrit b, effet 2 lit a ET b)', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0

µeffect ->
  $b = $a * 10
  return

µeffect ->
  _ = $a
  _ = $b
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('s5cascade', src)
    el._set('a', 1)
    await sleep(60)
    report('S5-cascade-inter-effets', win)
    assert.ok(win.__runs >= 1, 'S5 : effect 2 doit au moins tourner une fois')
  })

  it('salve étalée sur plusieurs microtâches', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0
$c = 0

µeffect ->
  _ = $a
  _ = $b
  _ = $c
  window.__runs = (window.__runs or 0) + 1
  return
</script>
<p class="o">{$a}</p>
`
    const { win, el } = await buildAndMount('s6spread', src)
    el._set('a', 1)
    await Promise.resolve()
    el._set('b', 1)
    await Promise.resolve()
    el._set('c', 1)
    await sleep(40)
    report('S6-salve-etalee', win)
    assert.ok(win.__runs >= 1, 'S6 : effect doit au moins tourner une fois')
  })
})
