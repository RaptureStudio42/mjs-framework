// Test de régression — annotateEffectDeps ne voyait que les `$.xxx` lus au premier niveau du
// callback (+ methodReads pour `this.m()`/`_mjsThis.m()`) : une lecture cachée dans une
// fonction PLATE du même script (`helper = function() { return $.b + 1 }` appelée depuis
// l'effect) restait invisible. Comme la liste rendue N'ÉTAIT PAS VIDE (elle contenait déjà
// "a"), le filet runtime « aucune dep connue → fire à chaque mutation » se désactivait : `$b`
// changeait, l'effet ne rejouait jamais. Avec le helper SEUL la liste
// était vide et le filet jouait encore — c'est le MÉLANGE qui tuait.
//
// Fix : les fonctions top-level du module compilé (déclaration, affectation de variable,
// affectation nue après un `let` séparé) sont résolues par leur nom et parcourues
// TRANSITIVEMENT (même `$`, liaison locale du module — une lecture `$.x` ne peut apparaître que
// dans ce module), position appel ET position valeur, garde de cycle par `seen`.

import assert from 'node:assert/strict'
import { annotateEffectDeps } from '../src/generator/effect-deps.js'
import { transpile } from '../src/transpiler/index.js'

describe('generator/effect-deps — fonctions plates du module suivies transitivement', function () {
  it('ROUGE (cas du défaut) — helper plate + lecture directe : la liste contient "a" ET "b"', () => {
    const src = `let helper = function() { return $.b + 1 }
µ.effect(function() { $.a; return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["a",\s*"b"\]\)/, `deps attendues ["a","b"]. got:\n${out}`)
  })

  it('helper seul (aucune lecture directe dans le callback) : la liste contient "b"', () => {
    const src = `let helper = function() { return $.b + 1 }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["b"\]\)/, `deps attendues ["b"]. got:\n${out}`)
  })

  it('chaîne helper → helper2 → $.c : la lecture transitive remonte', () => {
    const src = `let helper2 = function() { return $.c }
let helper = function() { return helper2() }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["c"\]\)/, `deps attendues ["c"]. got:\n${out}`)
  })

  it('récursion mutuelle helper ↔ helper2 (l\'un lit $.d) : termine, contient "d"', () => {
    const src = `let helper = function() { return helper2() }
let helper2 = function() { if ($.d) { return helper() } return $.d }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["d"\]\)/, `deps attendues ["d"], doit terminer sans boucle infinie. got:\n${out}`)
  })

  it('position VALEUR : list.forEach(helper) résout aussi les lectures de helper', () => {
    const src = `let helper = function() { return $.e }
µ.effect(function() { list.forEach(helper) })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["e"\]\)/, `deps attendues ["e"]. got:\n${out}`)
  })

  it('aucune fuite : membre d\'un autre objet, clé d\'objet, appel externe — rien d\'ajouté, pas de crash', () => {
    const src = `let helper = function() { return $.f }
µ.effect(function() { obj.helper(); var o = { helper: 1 }; console.log() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\[\]\)/, `deps attendues [] (aucune fuite). got:\n${out}`)
  })

  it('helper déclarée à l\'INTÉRIEUR d\'une autre fonction top-level (pas dans ast.body) : non résolue', () => {
    const src = `function outer() { let helper = function() { return $.g }; return helper }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\[\]\)/, `deps attendues [] (helper locale à outer, invisible au top-level). got:\n${out}`)
  })

  it('forme FunctionDeclaration top-level : function helper() { return $.d }', () => {
    const src = `function helper() { return $.d }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["d"\]\)/, `deps attendues ["d"]. got:\n${out}`)
  })

  it('forme affectation top-level après let séparé : helper = () => $.e', () => {
    const src = `let helper;
helper = () => $.e
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\["e"\]\)/, `deps attendues ["e"]. got:\n${out}`)
  })

  it('$$ (store) lu dans un helper : exclu, même comportement qu\'aujourd\'hui pour une lecture directe', () => {
    const src = `let helper = function() { return µ.store.x }
µ.effect(function() { return helper() })`
    const out = annotateEffectDeps(src)
    assert.match(out, /,\s*\[\]\)/, `deps attendues [] ($$ exclu). got:\n${out}`)
  })

  it('bout en bout via transpile : composant avec helper plate → µ.effect(..., ["a", "b"])', async () => {
    const src = `<script>
  $a = 1
  $b = 2
  helper = -> $b + 1
  µeffect ->
    $a
    helper()
</script>
<p>{$a}</p>`
    const { output } = await transpile(src, { moduleName: 'effect-deps-plain-fn' })
    assert.match(output, /µ\.effect\(function\(\) \{[\s\S]*?\},\s*\["a",\s*"b"\]\)/,
      `sortie attendue avec deps ["a","b"]. got:\n${output}`)
  })
})
