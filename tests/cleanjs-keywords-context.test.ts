import { strict as assert } from 'node:assert'
import { cleanJs, parseMixedString } from '../src/generator/utils.ts'

// Régression compilateur — 2 défauts de cleanJs :
//  Les mots-clés Coffee (is/and/or/not/isnt) étaient réécrits même en
//       position de CLÉ d'objet ou d'identifiant isolé.
//  Un setter de contexte `§x = 'literal'` / `§§x = 'literal'` (RHS chaîne)
//       cassait car mapCodeSegments isolait la chaîne avant la capture du RHS.
describe('cleanJs — mots-clés Coffee en position de clé', function () {
  it('NE transforme PAS un mot-clé en clé d\'objet', function () {
    assert.equal(cleanJs('{is: 1, not: 2}', []), '{is: 1, not: 2}')
    assert.equal(cleanJs('config({and: [1], or: [2]})', []), 'config({and: [1], or: [2]})')
  })
  it('NE transforme PAS un mot-clé en identifiant isolé', function () {
    assert.equal(cleanJs('foo(is)', []), 'foo(is)')
  })
  it('transforme TOUJOURS en position d\'opérateur', function () {
    assert.equal(cleanJs('a is b', []), 'a === b')
    assert.equal(cleanJs('a and b', []), 'a && b')
    assert.equal(cleanJs('a or b', []), 'a || b')
    assert.equal(cleanJs('a isnt b', []), 'a !== b')
    assert.match(cleanJs('not done', []), /!\s*done/)
  })
})

describe('cleanJs — setter de contexte à RHS chaîne littérale', function () {
  it('§x = \'literal\' → setContext bien formé', function () {
    assert.equal(cleanJs("§theme = 'dark'", []), "this._mjs_setContext('theme', 'dark')")
  })
  it('§§x = \'literal\' → setRCtx bien formé', function () {
    assert.equal(cleanJs("§§lang = 'fr'", []), "this._mjs_setRCtx('lang', 'fr')")
  })
  it('ne produit jamais un appel tronqué `(  )\'…\'`', function () {
    assert.doesNotMatch(cleanJs("§§lang = 'fr'", []), /,\s{2,}\)/)
    assert.doesNotMatch(cleanJs("§x = 'y'", []), /,\s{2,}\)/)
  })
  it('setters à expression et getters restent corrects', function () {
    assert.equal(cleanJs('§x = 5', []), "this._mjs_setContext('x', 5)")
    assert.equal(cleanJs('§theme', []), "this._mjs_getContext('theme')")
    assert.equal(cleanJs('§§lang', []), "this._mjs_getRCtx('lang')")
  })
  it('§§x = v TOUJOURS setRCtx, même si `$x` est un nom importé (plus de résolution vers un singleton)', function () {
    assert.equal(cleanJs('§§count = 5', ['$count']), "this._mjs_setRCtx('count', 5)")
  })
})

describe('cleanJs — $5 littéral & template literal en interpolation', function () {
  it('un $<chiffre> littéral n\'est pas transformé en variable', function () {
    assert.equal(parseMixedString('Prix $5 pour {$item}', []), '`Prix $5 pour ${$.item}`')
  })
  it('le $x d\'un template literal en interpolation est tokenisé', function () {
    assert.equal(cleanJs('`hi ${$name}`', []), '`hi ${$.name}`')
    assert.equal(cleanJs('`a ${$x} b ${$y}`', []), '`a ${$.x} b ${$.y}`')
  })
  it('le texte du template et les chaînes inertes restent intacts', function () {
    assert.equal(cleanJs('`plain and text`', []), '`plain and text`')
    assert.equal(cleanJs("'a and b'", []), "'a and b'")
  })
  it('$__x n\'est PLUS un sigil brut (retiré) — règle $x standard (µread/µwrite le remplacent)', function () {
    assert.equal(cleanJs('$__count', []), '$.__count')
  })
})
