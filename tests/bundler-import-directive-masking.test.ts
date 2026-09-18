// Test de régression : extraction de la
// directive `@import name 'path'` (2 défauts liés, même regex dupliquée à 2
// endroits de src/bundler/index.ts, désormais factorisée dans
// `extractImportMatches`) :
//
//   1. Même classe de bug qu'un correctif précédent (transpiler `@preload`/
//      `@noUJS`) : la regex opérait sur le contenu BRUT, sans masquer les
//      blocs `<pre>`/`<code>` — un tuto qui AFFICHE `@import foo 'bar.civet'`
//      comme EXEMPLE DE CODE (texte de démo, pas une vraie directive) se
//      faisait quand même extraire et tenter de résoudre comme un import réel.
//   2. La classe de caractères de l'identifiant contenait `\s` (matche aussi
//      le saut de ligne) au lieu de `[ \t]` — combiné à la quantification
//      paresseuse et au flag `m`, un `@import` mal formé pouvait enjamber la
//      ligne et extraire un chemin fantaisiste depuis une ligne ultérieure
//      sans rapport.
//
// Fix : masquage `<pre>`/`<code>` (même technique que ce correctif précédent) + `\s` → `[ \t]`
// dans la classe de caractères (un `@import` ne peut plus jamais s'étendre
// au-delà de sa propre ligne).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool, extractImportMatches } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'

describe('extractImportMatches — masquage <pre>/<code> + regex non-enjambante', function () {
  it("un @import réel (hors <pre>/<code>) est bien extrait", () => {
    const matches = extractImportMatches(`@import foo 'bar.civet'\n`)
    assert.equal(matches.length, 1)
    assert.equal(matches[0][1], 'bar.civet')
  })

  it("un @import affiché comme EXEMPLE dans un <pre> n'est PAS extrait", () => {
    // `@import` doit être en DÉBUT DE LIGNE pour que la regex (`^[ \t]*@import`)
    // le considère même comme candidat — le bloc <pre>/<code> place donc la
    // directive de démo sur SA PROPRE ligne, comme un vrai tuto le ferait.
    const content = `<pre><code>\n@import foo 'bar.civet'\n</code></pre>\n<p>Du texte.</p>\n`
    const matches = extractImportMatches(content)
    assert.equal(matches.length, 0,
      "AVANT le fix : un @import affiché comme démo de code dans <pre>/<code> était extrait comme une VRAIE directive")
  })

  it("un @import réel APRÈS un bloc <pre> de démo est quand même extrait (le masquage ne mange pas le reste)", () => {
    const content = `<pre><code>\n@import demo 'exemple.civet'\n</code></pre>\n@import reel 'vrai.civet'\n`
    const matches = extractImportMatches(content)
    assert.equal(matches.length, 1)
    assert.equal(matches[0][1], 'vrai.civet')
  })

  it("un @import mal formé (pas de guillemet fermant sur sa ligne) n'enjambe plus vers une ligne ultérieure sans rapport", () => {
    // AVANT le fix : `\s` dans la classe de caractères pouvait laisser le
    // nom d'identifiant « manger » le saut de ligne et trouver le guillemet
    // fermant de la ligne SUIVANTE, extrayant 'un/chemin/sans/rapport.civet'
    // comme si c'était le path du @import (alors que ce n'en est pas un).
    const content = `@import foo bar\nconst x = 'un/chemin/sans/rapport.civet'\n`
    const matches = extractImportMatches(content)
    assert.equal(matches.length, 0,
      "AVANT le fix : le @import mal formé enjambait la ligne suivante et extrayait un chemin qui n'a rien à voir")
  })
})

describe('bundler — @import dans une démo <pre>/<code> ne casse pas le build', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("un tuto qui AFFICHE '@import x \\'y.civet\\'' comme exemple n'enregistre PAS de fausse dépendance fantôme", async function () {
    const root = mjsTmp('import-doc')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // AUCUN fichier 'exemple-inexistant.civet' n'existe. Le @import de démo
    // n'empêche pas le build de réussir dans les deux cas (rien dans la
    // sortie compilée ne référence VRAIMENT ce chemin — le texte du <pre> est
    // juste affiché tel quel) : l'assertion qui DIFFÈRE avant/après le fix
    // porte sur `partialDependents` (tracking des deps pour le watcher,
    // 2e site d'appel de extractImportMatches, cf. updatePartialDependents)
    // — AVANT le fix, ce chemin fantôme y était quand même enregistré comme
    // si tuto.mjs en dépendait réellement.
    writeFileSync(join(srcDir, 'tuto.mjs'), [
      '<p>Comment importer un module :</p>',
      '<pre><code>',
      '@import util \'exemple-inexistant.civet\'',
      '</code></pre>',
    ].join('\n'))

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const phantomPath = join(srcDir, 'exemple-inexistant.civet')
    assert.ok(!bundler.partialDependents.has(phantomPath),
      "AVANT le fix : le @import affiché comme démo était quand même tracké comme une VRAIE dépendance du tuto (watcher invaliderait tuto.mjs pour un fichier qui n'existe même pas)")
    await bundler.close()
  })
})

// directive @noUJS → mjs-no-ujs (preprocessHtml, transpiler/index.ts), même masquage
// <pre>/<code> que @noUJS/@preload/@import ci-dessus. preprocessHtml n'est pas exportée : on
// passe par transpile() et on inspecte le gabarit HTML littéral porté au `µ._mjs_cloneTpl("...")`
// émis dans `output` (même convention que regressions.test.ts/view-transition.test.ts).
describe('preprocessHtml — directive @noUJS → mjs-no-ujs', function () {
  it('@noUJS nu (casse canonique) est réécrit en mjs-no-ujs', async () => {
    const { output } = await transpile('<div @noUJS>x</div>', { moduleName: 'noujs1' })
    assert.match(output, /_mjs_cloneTpl\("<div mjs-no-ujs>x<\/div>"\)/)
  })

  it('casse insensible : @noUjs et @noujs sont aussi réécrits', async () => {
    const r1 = await transpile('<div @noUjs>x</div>', { moduleName: 'noujs2' })
    const r2 = await transpile('<div @noujs>x</div>', { moduleName: 'noujs3' })
    assert.match(r1.output, /mjs-no-ujs/)
    assert.match(r2.output, /mjs-no-ujs/)
  })

  it('tiret optionnel : @no-ujs est réécrit lui aussi', async () => {
    const { output } = await transpile('<div @no-ujs>x</div>', { moduleName: 'noujs4' })
    assert.match(output, /mjs-no-ujs/)
  })

  it("un @noUJS affiché comme EXEMPLE dans un <pre>/<code> n'est PAS réécrit (masquage)", async () => {
    const { output } = await transpile('<p>Exemple :</p>\n<pre><code>&lt;a @noUJS&gt;</code></pre>\n<div>x</div>\n', { moduleName: 'noujs5' })
    assert.doesNotMatch(output, /mjs-no-ujs/, 'AVANT le fix : un @noUJS affiché comme démo de code dans <pre>/<code> aurait été réécrit comme une VRAIE directive')
    assert.match(output, /@noUJS/, 'le texte de démo reste affiché tel quel')
  })
})
