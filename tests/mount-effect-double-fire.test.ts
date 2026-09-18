// Double-fire d'un µeffect AU MOUNT (bug préexistant) —
// REVERT après 2 tentatives de fix each ayant introduit une
// RÉGRESSION DE CORRECTION pire que le bug d'origine :
//   - 1er correctif (garde aveugle sur `_mjs_lastMutedVars.add(k)`) : un lecteur déclaré AVANT
//     son écrivain restait figé sur sa valeur PÉRIMÉE du 1er passage, pour
//     toujours (silencieux, jamais rattrapé).
//   - 2e correctif, « fix bis » (reprise ciblée `_mjs_mount_ran_effects` /
//     `_mjs_mount_stale_effects`, round-robin borné) : corrigeait le 1er mais
//     ouvrait un triple-fire avec propagation d'une valeur INTERMÉDIAIRE
//     fausse en aval dans une topologie « relais désordonné » (lecteur/
//     écrivain entremêlés sur plusieurs niveaux).
//
// DÉCISION : on abandonne le fix, on revient au comportement D'ORIGINE
// (mécanisme préexistant : le slow-path de `_mjs_invalidate` marque
// inconditionnellement `_mjs_lastMutedVars`, et une écriture nested pendant la
// passe fullRender reprogramme une passe `_mjs_runEffectsV2` complémentaire via
// `queueMicrotask`). PROPRIÉTÉ GARANTIE et seule testée ici : l'ÉTAT FINAL vu
// par chaque effet/binding est TOUJOURS CORRECT, dans TOUS les ordres de
// déclaration (normal, inversé, relais désordonné, chaînes à 3-4 niveaux).
// SEUL DÉFAUT ASSUMÉ (limite connue, statu quo stable depuis des mois) : un
// µeffect non idempotent peut tirer 2× (voire plus, cf. topologies à 3+
// niveaux) au mount avant de se stabiliser sur l'état final. Les tests
// ci-dessous n'assertent donc PLUS de compte de runs exact — seulement la
// valeur finale, et pour mémoire (`console.log`/commentaire) le fait que le
// run-count peut dépasser 1.

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

describe('mount-effect-double-fire — comportement d\'ORIGINE assumé (revert)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildAndMount(name: string, src: string) {
    const root = mjsTmp(`mefd-${name}`)
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

  it('a. ordre normal : écrivain avant lecteur — valeur finale correcte', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0

µeffect ->
  $b = $a + 1
  return

µeffect ->
  _ = $b
  window.__aRuns = (window.__aRuns or 0) + 1
  window.__aVal = $b
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('a-chain2', src)
    assert.equal(win.__aVal, 1, 'valeur finale correcte ($b = $a+1 = 1)')
    assert.ok(win.__aRuns >= 1, 'au moins 1 run (double-fire d\'origine possible, non asserté strictement)')
  })

  it('b. écrivain → lecteur + bloc struct {if $k} intermédiaire : contenu conditionnel correct', async () => {
    const src = `
<script lang="coffee">
$a = 0
$k = false
$inner = 0

µeffect ->
  _ = $a
  $k = true
  return

µeffect ->
  if $k
    $inner = 42
  return

µeffect ->
  _ = $inner
  window.__bRuns = (window.__bRuns or 0) + 1
  window.__bVal = $inner
  return
</script>
{if $k}
  <p class="inner">{$inner}</p>
{end}
`
    const { win, el } = await buildAndMount('b-struct', src)
    assert.equal(win.__bVal, 42, 'valeur finale correcte ($inner = 42)')
    const node = el._shadow.querySelector('p.inner')
    assert.ok(node, 'le bloc {if $k} devenu vrai PENDANT le mount doit avoir peint son contenu')
    assert.equal(node.textContent.trim(), '42', 'le nœud struct nouvellement visible doit afficher l\'état FINAL')
    assert.ok(win.__bRuns >= 1, 'au moins 1 run (double-fire d\'origine possible, non asserté strictement)')
  })

  it('c. chaîne 4 niveaux, ordre normal : leaf finit sur la valeur correcte au bout de la chaîne', async () => {
    const src = `
<script lang="coffee">
$f0 = 0

µeffect ->
  _ = $f0
  $f1 = 1
  return

µeffect ->
  _ = $f1
  $f2 = 2
  return

µeffect ->
  _ = $f2
  $f3 = 3
  return

µeffect ->
  _ = $f3
  window.__cRuns = (window.__cRuns or 0) + 1
  window.__cVal = $f3
  return
</script>
<span class="o">{$f0}</span>
`
    const { win } = await buildAndMount('c-chain4', src)
    assert.equal(win.__cVal, 3, 'valeur finale correcte au bout de la chaîne')
    assert.ok(win.__cRuns >= 1, 'au moins 1 run (double-fire d\'origine possible, non asserté strictement)')
  })

  it('d. NON-RÉGRESSION : cascade post-mount (mutation externe) inchangée, valeur finale correcte', async () => {
    const src = `
<script lang="coffee">
$b1 = 0
$b1_derived = -1

µeffect ->
  _ = $b1
  if $b1 > 0
    $b1_derived = $b1 * 10
  return

µeffect ->
  _ = $b1_derived
  window.__dRuns = (window.__dRuns or 0) + 1
  window.__dVal = $b1_derived
  return
</script>
<span class="o">{$b1}</span>
`
    const { win, el } = await buildAndMount('d-postmount', src)
    const mountRuns = win.__dRuns
    el._set('b1', 5)
    await sleep(60)
    assert.equal(win.__dRuns, mountRuns + 1, 'la cascade post-mount (hors fullRender, mécanisme _mjs_ue_pending coalescé) ajoute EXACTEMENT 1 run — comportement inchangé (hors mount)')
    assert.equal(win.__dVal, 50, 'valeur finale correcte après la cascade post-mount (5 * 10)')
  })

  it('e. cleanup toujours apparié (setup→cleanup→setup au re-run légitime), pas de fuite au mount ni post-mount', async () => {
    const src = `
<script lang="coffee">
$a = 0
$b = 0

µeffect ->
  $b = $a + 1
  return

µeffect ->
  _ = $b
  window.__eSetups = (window.__eSetups or 0) + 1
  window.__eCleanups = window.__eCleanups or 0
  cleanupFn = ->
    window.__eCleanups += 1
    return
  cleanupFn
</script>
<span class="o">{$a}</span>
`
    const { win, el } = await buildAndMount('e-cleanup', src)
    // au mount, setups peut dépasser 1 (double-fire d'origine) mais reste toujours
    // strictement en avance d'exactement 1 sur cleanups (appariement correct,
    // jamais de cleanup fantôme ni de setup sans cleanup préalable).
    assert.equal(win.__eSetups - win.__eCleanups, 1, 'appariement setup/cleanup correct au mount (pas de fuite)')
    const mountSetups = win.__eSetups
    const mountCleanups = win.__eCleanups
    el._set('a', 5)
    await sleep(60)
    assert.equal(win.__eCleanups, mountCleanups + 1, 'cleanup tourne exactement 1x avant le re-setup post-mount')
    assert.equal(win.__eSetups, mountSetups + 1, 'setup re-tire exactement 1x sur la mutation post-mount (pas de fuite)')
  })

  it('f. computeds chaînés : valeur finale correcte, jamais périmée', async () => {
    const src = `
<script lang="coffee">
$a = 0
$raw = 0

µeffect ->
  $raw = $a + 1
  return

$derived = $raw * 10

µeffect ->
  _ = $derived
  window.__fRuns = (window.__fRuns or 0) + 1
  window.__fVal = $derived
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('f-computed', src)
    assert.equal(win.__fVal, 10, 'computed chaîné : valeur finale correcte (raw=1, derived=raw*10=10), jamais périmée')
    assert.ok(win.__fRuns >= 1, 'au moins 1 run (double-fire d\'origine possible, non asserté strictement)')
  })

  it('g. ordre INVERSÉ — reader déclaré AVANT le writer : valeur finale correcte (pas de figé)', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = 0

µeffect ->
  _ = $b
  window.__gRuns = (window.__gRuns or 0) + 1
  window.__gVal = $b
  return

µeffect ->
  $b = $a * 10
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('g-reversed', src)
    assert.equal(win.__gVal, 10, 'le reader (déclaré avant le writer) doit finir sur la valeur FRAÎCHE (10), jamais figé sur la valeur périmée (0) — c\'est le point qui compte, pas le run-count')
    assert.ok(win.__gRuns >= 1, 'au moins 1 run')
  })

  it('h. chaîne 3 niveaux, ordre NORMAL (écrivains avant le lecteur) : valeur finale correcte', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = 0
$c = 0

µeffect ->
  $b = $a * 10
  return

µeffect ->
  $c = $b * 10
  return

µeffect ->
  _ = $c
  window.__hRuns = (window.__hRuns or 0) + 1
  window.__hVal = $c
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('h-chain3-normal', src)
    assert.equal(win.__hVal, 100, 'valeur finale correcte (a=1 → b=10 → c=100)')
    assert.ok(win.__hRuns >= 1, 'au moins 1 run (double-fire d\'origine possible, non asserté strictement)')
  })

  it('i. chaîne 3 niveaux, ordre INVERSE (leaf déclaré avant les 3 écrivains) : valeur finale correcte', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = 0
$c = 0
$d = 0

µeffect ->
  _ = $d
  window.__iRuns = (window.__iRuns or 0) + 1
  window.__iVal = $d
  return

µeffect ->
  $b = $a * 10
  return

µeffect ->
  $c = $b * 10
  return

µeffect ->
  $d = $c * 10
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('i-chain3-reversed', src)
    assert.equal(win.__iVal, 1000, 'valeur finale correcte au bout de la chaîne à 3 écrivains (a=1→b=10→c=100→d=1000), jamais périmée — c\'est le point qui compte, pas le run-count')
    assert.ok(win.__iRuns >= 1, 'au moins 1 run')
  })

  it('j. RELAIS DÉSORDONNÉ — lecteur1(avant) → écrivain → lecteur2(après) : les deux lecteurs finissent sur la valeur correcte', async () => {
    const src = `
<script lang="coffee">
$a = 1
$b = 0

µeffect ->
  _ = $b
  window.__jR1 = (window.__jR1 or 0) + 1
  window.__jV1 = $b
  return

µeffect ->
  $b = $a * 10
  return

µeffect ->
  _ = $b
  window.__jR2 = (window.__jR2 or 0) + 1
  window.__jV2 = $b
  return
</script>
<span class="o">{$a}</span>
`
    const { win } = await buildAndMount('j-mixed', src)
    assert.equal(win.__jV1, 10, 'lecteur1 (déclaré avant l\'écrivain) doit finir sur la valeur correcte')
    assert.equal(win.__jV2, 10, 'lecteur2 (déclaré après l\'écrivain) doit finir sur la valeur correcte')
    assert.ok(win.__jR1 >= 1 && win.__jR2 >= 1, 'les deux lecteurs tirent au moins 1 fois')
  })
})
