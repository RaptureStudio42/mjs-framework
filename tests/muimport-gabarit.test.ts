// « trou du gabarit » µimport : un µimport('chemin.js')/
// mjsimport('chemin.js') niché DANS une fenêtre d'interpolation (`${…}` d'un
// template literal, `#{…}` d'une chaîne double Coffee/Civet) échappait au
// scanner manuel `rewriteMuImport` (sigils.ts) — panne MUETTE (ReferenceError
// au runtime, `µimport` jamais réécrit en `µ._mjs_import(µasset(...))`). Remède
// ACTÉ : voie AST post-Civet là où c'est possible (rewriteMuImportAst,
// nouveau — moteur SCRIPT : <script>/<script module>/modules .civet/.coffee
// autonomes) ; récursion du scanner ailleurs (rewriteMuImport lui-même,
// moteur cleanJs — generator/utils.ts). Calque le harnais de
// tests/rune-import.test.ts (même rune) ; complète aussi 2 bugs latents
// de la même famille (mapCodeSegments/parseMixedString, generator/utils.ts).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { rewriteMuImportAst } from '../src/sigils.js'
import { cleanJs, cleanJsExpr, parseMixedString } from '../src/generator/utils.js'

describe('moteur script (Civet) — bout-en-bout transpile() : le trou du gabarit est fermé', function () {
  this.timeout(8000)

  it("µimport('vendor/three.js') NU, hors toute fenêtre → réécrit (non-régression : le pipeline complet passe toujours)", async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      "µimport('vendor/three.js')",
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-civet-nu' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })

  it("µimport('vendor/three.js') niché dans ${…} d'un template literal → réécrit (LE trou du gabarit, désormais fermé)", async () => {
    const src = [
      '<script lang="civet">',
      "$url = `mod:${µimport('vendor/three.js')}`",
      '</script>',
      '<p>{$url}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-civet-window' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })

  it('alias mjsimport(...) : même réécriture bout-en-bout', async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      "mjsimport('vendor/three.js')",
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-civet-mjsimport' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })
})

describe('voie AST rewriteMuImportAst (sigils.ts) — unitaire, sur du JS déjà compilé', () => {
  it("µimport('x.js') niché dans un template IMBRIQUÉ à 2 niveaux → réécrit (acorn : la profondeur n'y change RIEN, contrairement au scanner manuel)", () => {
    const js = "const y = `a${`b${µimport('vendor/three.js')}`}`"
    const out = rewriteMuImportAst(js, '<script>')
    assert.match(out, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
    assert.match(out, /`a\$\{`b\$\{µ\._mjs_import/)
  })

  it("µimport(maVar) (argument calculé, pas un Literal) → throw rune-import-litteral-requis", () => {
    assert.throws(
      () => rewriteMuImportAst('x = µimport(maVar)', '<script>'),
      /\[ModularJS\] µimport exige un chemin littéral/
    )
  })

  it("µimport('style.css') (extension non .js) → throw rune-import-extension-js", () => {
    assert.throws(
      () => rewriteMuImportAst(`x = µimport('style.css')`, '<script>'),
      /\[ModularJS\] µimport ne charge que des modules ES « \.js » .*style\.css/
    )
  })

  it("une CHAÎNE \"µimport('x.js') est une rune\" reste INTACTE, zéro throw (pas un Identifier)", () => {
    const out = rewriteMuImportAst(`const msg = "µimport('x.js') est une rune"`, '<script>')
    assert.match(out, /"µimport\('x\.js'\) est une rune"/)
  })

  it("un COMMENTAIRE // µimport('x.js') reste INTACT, zéro throw", () => {
    const out = rewriteMuImportAst("// µimport('x.js')\nconst x = 1", '<script>')
    assert.match(out, /\/\/ µimport\('x\.js'\)/)
  })

  it('référence NUE `const f = µimport` (jamais le callee d\'un appel réécrit) → throw (avant : panne muette au runtime)', () => {
    assert.throws(
      () => rewriteMuImportAst('const f = µimport', '<script>'),
      /\[ModularJS\] µimport exige un chemin littéral/
    )
  })

  it("µimporter('x.js') (identifiant UTILISATEUR plus long) reste INTACT — pas cette rune", () => {
    const out = rewriteMuImportAst(`const x = µimporter('x.js')`, '<script>')
    assert.equal(out, `const x = µimporter('x.js')`)
  })
})

describe('moteur script (Coffee)', function () {
  this.timeout(8000)

  it("Coffee — µimport('vendor/three.js') AVEC parenthèses → réécrit", async () => {
    const src = [
      '<script lang="coffee">',
      '$x = 1',
      "µimport('vendor/three.js')",
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-coffee-parens' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })

  it("Coffee — µimport 'vendor/three.js' SANS parenthèses (bare call idiomatique Coffee) → réécrit (bonus de la voie AST : le compilateur Coffee pose lui-même les parenthèses avant que rewriteMuImportAst ne voie le JS)", async () => {
    const src = [
      '<script lang="coffee">',
      '$x = 1',
      "µimport 'vendor/three.js'",
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-coffee-bare' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })
})

describe('<script module>', function () {
  this.timeout(8000)

  it("<script module> : µimport('vendor/three.js') → réécrit (voie AST appliquée sur le moduleJs compilé)", async () => {
    const src = [
      '<script module lang="js">',
      "export const load = () => µimport('vendor/three.js')",
      '</script>',
      '<script lang="js">',
      'const x = 1',
      '</script>',
      '<p>{x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'gabarit-module' })
    assert.match(output, /µ\._mjs_import\(µasset\('vendor\/three\.js'\)\)/)
  })
})

describe('moteur cleanJs (generator/utils.ts) — récursion du scanner rewriteMuImport', () => {
  it("parseMixedString — {µimport('x.js')} (site EXPRESSION, cas pur) → réécrit (non-régression)", () => {
    const out = parseMixedString(`{µimport('x.js')}`)
    assert.equal(out, `µ._mjs_import(µasset('x.js'))`)
  })

  it("cleanJsExpr — µimport('x.js') niché dans ${…} d'un backtick À L'INTÉRIEUR de l'interpolation → réécrit", () => {
    const out = cleanJsExpr("`mod:${µimport('x.js')}`")
    assert.equal(out, "`mod:${µ._mjs_import(µasset('x.js'))}`")
  })

  it("cleanJs — µimport('x.js') niché dans #{…} d'une chaîne double (Coffee/Civet) → réécrit", () => {
    const out = cleanJs(`"mod:#{µimport('x.js')}"`, [])
    assert.equal(out, `"mod:#{µ._mjs_import(µasset('x.js'))}"`)
  })
})

describe('bugs latents de la même famille (mapCodeSegments / parseMixedString, generator/utils.ts)', () => {
  it("mapCodeSegments — un `}` littéral dans une chaîne DE LA FENÊTRE ne ferme plus la fenêtre trop tôt : $y APRÈS le piège reste bien converti en $.y", () => {
    const out = cleanJs("`hi ${fn('}') + $y}`", [])
    assert.equal(out, "`hi ${fn('}') + $.y}`")
  })

  it('parseMixedString — un antislash ÉCHAPPÉ (2 caractères) juste avant le guillemet fermant referme correctement la fenêtre (pas d\'avalement du reste du gabarit)', () => {
    const out = parseMixedString('{fn("a\\\\")} suite', [])
    assert.equal(out, '`${fn("a\\\\")} suite`')
  })
})
