// Régression : les bindings de template
// réagissent déjà aux racines d'un computed CHAÎNÉ (l'analyseur expand via
// resolveSnippetDeps). Mais un `µeffect` qui ne lit QU'UN computed chaîné
// (`$c` où c ← b ← a) ne se re-déclenchait JAMAIS quand une racine mutait :
// `generator/effect-deps.ts` ne capture que les `$.x` LITTÉRAUX du corps de
// l'effet, et `_mjs_runEffectsV2` (mjs_element.ts) compare la clé muée aux
// `staticVars` littérales — `a` n'y figure jamais si seul `$c` est lu.
//
// Fix : le compilateur émet `_mjs_computedDeps` (closure transitive DÉJÀ résolue
// par `analyzer.computedDeps`, cf. resolveDependencyGraph) sur chaque
// composant ; `µ.effect` (mjs_runes.ts) étend `staticVars` aux racines à
// L'ENREGISTREMENT — zéro coût dans les chemins chauds (_mjs_invalidate,
// _mjs_varHasUserEffect, _mjs_runEffectsV2 INCHANGÉS).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('transpiler — `_mjs_computedDeps`', function () {
  it('computed chaîné (c ← b ← a) : `_mjs_computedDeps.c` contient a ET b (closure transitive)', async () => {
    const src = [
      '<script lang="coffee">',
      '$a = 1',
      '$b = $a * 2',
      '$c = $b + 1',
      '</script>',
      '<p class="o">{$c}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'ccdeps' })
    const m = output.match(/this\._mjs_computedDeps = (\{[^;]*\});/)
    assert.ok(m, 'this._mjs_computedDeps = {...}; doit être émis')
    const dict = JSON.parse(m![1])
    assert.ok(Array.isArray(dict.c), '`c` doit avoir une entrée')
    assert.ok(dict.c.includes('a'), '`c` doit contenir `a` (closure transitive)')
    assert.ok(dict.c.includes('b'), '`c` doit contenir `b`')
  })

  it('composant SANS computed : `_mjs_computedDeps = {};` émis, rien d\'autre', async () => {
    const src = [
      '<script lang="coffee">',
      '$a = 1',
      '</script>',
      '<p class="o">{$a}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'ccnone' })
    assert.match(output, /this\._mjs_computedDeps = \{\};/)
  })
})

describe('µ.effect — expansion `_mjs_computedDeps` (unitaire, precomputedVars)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function loadCore() {
    // Bundle minimal juste pour charger le core runtime (µ) dans happy-dom —
    // le composant réel n'est pas utilisé ici, on manipule un objet nu.
    // `runtime: ['effect']` EXPLICITE : mjs_effect.ts (µ.effect) est DÉTECTÉ à l'usage
    // (cf. bundler/index.ts, scanRuntimeFeatures) — ce stub n'écrit jamais `µeffect`,
    // sans quoi µ.effect resterait absent du bundle et cette suite unitaire ne pourrait
    // pas l'appeler directement.
    const root = mjsTmp('ccdeps-unit')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub.mjs'), '<p class="o">stub</p>')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js'), runtime: ['effect'] })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;`)
    return win
  }

  it("composant simulé avec `_mjs_computedDeps = { c: ['b','a'], b: ['a'] }` : µ.effect(fn, ['c']) étend staticVars à c, b ET a", async () => {
    const win = await loadCore()
    const µ: any = win.eval('µ')
    const comp: any = { _mjs_computedDeps: { c: ['b', 'a'], b: ['a'] } }
    µ._mjs_pushComponent(comp)
    µ.effect(function () {}, ['c'])
    µ._mjs_popComponent()
    const entry = comp._mjs_effects[0]
    assert.ok(entry.staticVars.includes('c'), 'staticVars doit contenir c (var lue)')
    assert.ok(entry.staticVars.includes('b'), 'staticVars doit contenir b (racine intermédiaire)')
    assert.ok(entry.staticVars.includes('a'), 'staticVars doit contenir a (racine finale)')
    win.close?.()
  })

  it('rétrocompat : composant SANS `_mjs_computedDeps` (undefined) — µ.effect ne crashe pas, staticVars inchangées', async () => {
    const win = await loadCore()
    const µ: any = win.eval('µ')
    const comp: any = {}
    µ._mjs_pushComponent(comp)
    assert.doesNotThrow(() => µ.effect(function () {}, ['x']))
    µ._mjs_popComponent()
    const entry = comp._mjs_effects[0]
    assert.deepEqual(entry.staticVars, ['x'])
    win.close?.()
  })
})

describe('µ.effect — bout-en-bout (happy-dom, computed chaîné)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildAndMount() {
    const root = mjsTmp('ccdeps-e2e')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'ccfx.mjs'), `
<script lang="coffee">
$a = 1
$b = $a * 2
$c = $b + 1

µeffect ->
  window.__ccLastC = $c
  window.__ccRuns = (window.__ccRuns or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^ccfx-/.test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-ccfx></mjs-ccfx>'
    await new Promise(r => setTimeout(r, 80))
    return { win, document, el: document.body.firstElementChild }
  }

  it('effet ne lisant que $c : muter $a re-déclenche l\'effet, qui lit la valeur RECALCULÉE de $c', async () => {
    const { win, el } = await buildAndMount()
    assert.equal(win.__ccRuns, 1, 'effect tourne 1x au mount')
    assert.equal(win.__ccLastC, 3, 'valeur initiale : c = a*2+1 = 3')
    el._set('a', 5)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(win.__ccRuns, 2, 'la mutation de $a (racine) re-déclenche l\'effet lisant $c')
    assert.equal(win.__ccLastC, 11, 'l\'effet lit la valeur RECALCULÉE de c = 5*2+1 = 11')
    win.close?.()
  })

  it('pas de double-déclenchement : effet lisant $a ET $c — une mutation de $a = UN seul run supplémentaire', async () => {
    const root = mjsTmp('ccdeps-e2e-double')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'ccfx2.mjs'), `
<script lang="coffee">
$a = 1
$b = $a * 2
$c = $b + 1

µeffect ->
  _ = $a
  _ = $c
  window.__cc2Runs = (window.__cc2Runs or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^ccfx2-/.test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-ccfx2></mjs-ccfx2>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    assert.equal(win.__cc2Runs, 1, 'effect tourne 1x au mount')
    el._set('a', 9)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(win.__cc2Runs, 2, 'une seule mutation = un seul run supplémentaire (pas de double dispatch a+c)')
    win.close?.()
  })

  it('CONTRE-ÉPREUVE négative : sans `_mjs_computedDeps` (retiré avant l\'enregistrement de l\'effet), l\'effet ne se re-déclenche PAS', async () => {
    const root = mjsTmp('ccdeps-neg')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'ccneg.mjs'), `
<script lang="coffee">
$a = 1
$b = $a * 2
$c = $b + 1

µeffect ->
  window.__cnLastC = $c
  window.__cnRuns = (window.__cnRuns or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^ccneg-/.test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    // Charge le core, PUIS neutralise `_mjs_computedDeps` sur le prototype de la classe
    // composant AVANT que le constructeur (donc µ.effect) ne s'exécute — preuve que
    // le mécanisme testé est bien `_mjs_computedDeps`, pas un autre chemin de dispatch.
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;`)
    const rawCompCode = stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))
    const patchedCompCode = rawCompCode.replace(/this\._mjs_computedDeps = \{[^;]*\};/, 'this._mjs_computedDeps = undefined;')
    // sanity : le remplacement a bien matché quelque chose dans le code compilé
    assert.notEqual(patchedCompCode, rawCompCode,
      'sanity : le patch doit avoir trouvé this._mjs_computedDeps à neutraliser')
    win.eval(patchedCompCode)
    document.body.innerHTML = '<mjs-ccneg></mjs-ccneg>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    assert.equal(win.__cnRuns, 1, 'effect tourne 1x au mount')
    el._set('a', 5)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(win.__cnRuns, 1,
      "SANS _mjs_computedDeps : l'effet lisant seulement $c ne se re-déclenche PAS quand la racine $a mute (preuve que le mécanisme testé est bien celui-ci)")
    win.close?.()
  })

  it('chaîne passant par une clé store universelle ($c = $$dy * 2) : muter µ.store.dy re-déclenche l\'effet lisant seulement $c', async () => {
    const root = mjsTmp('ccdeps-store')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'ccstore.mjs'), `
<script lang="coffee">
$$dy = 3
$c = $$dy * 2

µeffect ->
  window.__csLastC = $c
  window.__csRuns = (window.__csRuns or 0) + 1
  return
</script>
<p class="o">{$c}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^ccstore-/.test(f))!
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-ccstore></mjs-ccstore>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(win.__csRuns, 1, 'effect tourne 1x au mount')
    assert.equal(win.__csLastC, 6, 'valeur initiale : c = dy*2 = 6')
    win.µ.store.dy = 10
    await new Promise(r => setTimeout(r, 60))
    assert.equal(win.__csRuns, 2, 'la mutation de la clé store $$dy (racine) re-déclenche l\'effet lisant $c')
    assert.equal(win.__csLastC, 20, 'l\'effet lit la valeur RECALCULÉE de c = 10*2 = 20')
    win.close?.()
  })
})
