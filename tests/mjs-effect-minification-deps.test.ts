// Test de régression :
// `µ.effect` (mjs_runes.ts) calculait ses dépendances réactives en scannant
// `fn.toString()` avec une regex littérale `$.<var>`. Cassé dès que le code
// est minifié : esbuild renomme le PARAMÈTRE local `$` (`function($){}` →
// `function(n){}`, `minifyIdentifiers` fait partie de `minify:true`) SANS
// toucher aux noms de PROPRIÉTÉ (`mangleProps` restreint à `/^_mjs_/`,
// bundler/minify.ts) — le texte minifié contient `n.count`, plus jamais
// `$.count` : la regex ne matchait plus RIEN. `staticVars` restait TOUJOURS
// vide en prod → chaque `µeffect` basculait sur le mode fail-open "pas de
// deps connues → fire à CHAQUE mutation, peu importe la var" (_mjs_runEffectsV2,
// mjs_element.ts) — silencieux, pas un crash, mais un effect à side-effects
// (requête réseau, log, animation...) se déclenchait bien plus souvent en
// prod qu'en dev.
//
// Fix : generator/effect-deps.ts détecte chaque `µ.effect(callback)` en AST
// (avant minification) et injecte la liste des `$.xxx` lus comme 2e argument
// LITTÉRAL (des strings, jamais renommées) : `µ.effect(fn, ["count"])`.
// mjs_runes.ts utilise ce précalcul s'il est fourni, fallback fn.toString()
// sinon (rétrocompat µ.effect appelé hors pipeline compilateur).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { annotateEffectDeps } from '../src/generator/effect-deps.js'
import { stripEsm, fileToId, ssrScopeFile } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

describe('generator/effect-deps — annotateEffectDeps (unitaire, AST)', function () {
  it('injecte la liste des $.xxx lus comme 2e argument', () => {
    const out = annotateEffectDeps(`µ.effect(function() { return console.log($.count, $.label); });`)
    assert.match(out, /µ\.effect\(function\(\) \{ return console\.log\(\$\.count, \$\.label\); \}, \["count", "label"\]\);/)
  })

  it('dédoublonne les refs répétées à la même var', () => {
    const out = annotateEffectDeps(`µ.effect(function() { $.count; $.count; return $.count; });`)
    assert.match(out, /,\s*\["count"\]\)/)
  })

  it("aucune lecture $. → tableau vide (pas d'erreur, pas de faux positif)", () => {
    const out = annotateEffectDeps(`µ.effect(function() { return console.log('static'); });`)
    assert.match(out, /,\s*\[\]\)/)
  })

  it('forme fléchée (=>) reconnue comme forme fonction (Civet µeffect =>)', () => {
    const out = annotateEffectDeps(`µ.effect(() => { return $.x + 1; });`)
    assert.match(out, /,\s*\["x"\]\)/)
  })

  it("notation crochet à clé LITTÉRALE ($['count']) comptée comme la notation point", () => {
    const out = annotateEffectDeps(`µ.effect(function() { return $['count']; });`)
    assert.match(out, /,\s*\["count"\]\)/)
  })

  it('clé DYNAMIQUE ($[varName]) ignorée (ni crash, ni faux nom de var)', () => {
    const out = annotateEffectDeps(`µ.effect(function() { var k = 'count'; return $[k]; });`)
    assert.match(out, /,\s*\[\]\)/)
  })

  it('scan en profondeur : $. référencé dans une fonction IMBRIQUÉE toujours détecté (même portée que fn.toString())', () => {
    const out = annotateEffectDeps(`µ.effect(function() { var f = function() { return $.deep; }; return f(); });`)
    assert.match(out, /,\s*\["deep"\]\)/)
  })

  it("appel qui n'est PAS µ.effect (autre objet) : jamais touché", () => {
    const src = `foo.effect(function() { return $.count; });`
    assert.equal(annotateEffectDeps(src), src)
  })

  it('µ.effect déjà à 2 arguments (re-passe) : pas de 3e argument ajouté', () => {
    const src = `µ.effect(function() { return $.count; }, ["count"]);`
    assert.equal(annotateEffectDeps(src), src)
  })

  it("1er argument qui n'est pas une fonction littérale (référence indirecte) : laissé intact, pas de crash", () => {
    const src = `µ.effect(monHandler);`
    assert.equal(annotateEffectDeps(src), src)
  })

  it('JS invalide → retourne tel quel', () => {
    const src = `this is not valid !!!`
    assert.equal(annotateEffectDeps(src), src)
  })

  it("pas de 'µ.effect(' dans la source → no-op rapide (retourne le même contenu)", () => {
    const src = `const x = 1;`
    assert.equal(annotateEffectDeps(src), src)
  })
})

describe('µ.effect — survit à la minification (pipeline réel, forceMinify)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildAndMount(forceMinify: boolean) {
    const root = mjsTmp('effect-min')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'em.mjs'), `
<script lang="coffee">
$a = 0
$b = 0

µeffect ->
  _ = $a
  window.__emRuns = (window.__emRuns or 0) + 1
  return
</script>
<p class="o">{$a}-{$b}</p>
`)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js'), forceMinify })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^em-/.test(f))!
    const compCode = readFileSync(join(outDir, compFile), 'utf-8')

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    // BUG D'INTÉGRATION — l'ancien duplicata maison ci-dessous (flat
    // concat SANS portée par fichier) collisionnait en prod dès que le core,
    // indépendamment minifié, réutilisait par COÏNCIDENCE le même alias local
    // court qu'`em` (`const r = …` des deux côtés à la fois, ex.) — latent,
    // révélé par l'ajout de code ailleurs dans le core (mjs_i18n.ts) qui a
    // suffi à redistribuer les noms courts d'esbuild. Fix : réutilise
    // `ssrScopeFile` (renderToString.ts, exportée pour l'occasion) — CHAQUE
    // fichier compilé dans sa PROPRE IIFE (portée réelle façon ESM), plus
    // aucune collision possible entre alias locaux de fichiers différents.
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
    const id = fileToId(compFile)
    const { code: scopedCompCode } = ssrScopeFile(compCode, id, () => null)
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${scopedCompCode}`)

    document.body.innerHTML = '<mjs-em></mjs-em>'
    await new Promise(r => setTimeout(r, 80))
    const flush = () => new Promise(r => setTimeout(r, 30))

    return { win, document, el: document.body.firstElementChild, compCode, flush }
  }

  it('DEV (pas de minification) : cas nominal — effect ne re-tourne QUE sur $a, pas sur $b', async function () {
    const { win, el, flush } = await buildAndMount(false)
    assert.equal(win.__emRuns, 1, 'effect tourne 1x au mount')
    el._set('b', 9)
    await flush()
    assert.equal(win.__emRuns, 1, '$b (non lu) ne re-déclenche pas l\'effect')
    el._set('a', 5)
    await flush()
    assert.equal(win.__emRuns, 2, '$a (lu) re-déclenche l\'effect')
    win.close?.()
  })

  it("PROD (forceMinify) : le bundle contient bien la liste littérale des deps (survit au renommage de $)", async function () {
    const { compCode, win } = await buildAndMount(true)
    // $ a été renommé (mangle des identifiers) : la variable d'origine n'apparaît
    // plus littéralement, mais la liste de deps précalculée si.
    assert.doesNotMatch(compCode, /\$\.a\b/, 'contrôle : $ doit bien avoir été renommé par esbuild')
    assert.match(compCode, /\.effect\(function\(\)\{[^}]*\},\["a"\]\)/,
      "le 2e argument littéral ['a'] doit survivre intact dans le bundle minifié")
    win.close?.()
  })

  it("PROD (forceMinify) : AVANT le fix, staticVars vide → fire-always → $b (non lu) aurait AUSSI re-déclenché l'effect. Après fix : comportement identique au dev", async function () {
    const { win, el, flush } = await buildAndMount(true)
    assert.equal(win.__emRuns, 1, 'effect tourne 1x au mount')
    el._set('b', 9)
    await flush()
    assert.equal(win.__emRuns, 1,
      "AVANT le fix : staticVars=[] en minifié → mode fail-open → $b aurait AUSSI fait re-tourner l'effect")
    el._set('a', 5)
    await flush()
    assert.equal(win.__emRuns, 2, '$a (lu) re-déclenche toujours l\'effect')
    win.close?.()
  })
})
