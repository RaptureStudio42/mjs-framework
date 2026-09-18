// Test de régression — 2 dettes du transpiler.
//
// 1. `isnt` (Pass 2b, applyCivetDialectSugar) convertit `a isnt b` → `a is not b`
//    par un remplacement TEXTE aveugle (`\bisnt\b`) — un `isnt` utilisé comme
//    IDENTIFIANT (`isnt = 5`, `$isnt = 5`) est mangé de la même façon
//    (`$isnt = 5` → `$is not = 5`) → ParseError Civet cryptique en aval
//    (« Found: "not" »), loin de la vraie faute. Fix : garde-fou AVANT le
//    remplacement, sur les mêmes segments code-only — erreur MJS explicite.
//    L'usage OPÉRATEUR (`a isnt b`) reste, lui, intact et préservé.
//
// 2. Civet upstream compile mal un objet 100 % SPREAD en position `else`
//    d'un if/then/else inline (`x = if $c then {...$a} else {...$b}` →
//    `else {ref = ...b}`, JS invalide) : l'erreur atterrit dans l'Analyzer
//    (acorn), très en aval, avec un message brut et cryptique
//    (« [analyzer] parse error: Unexpected token … »). Fix : hint ajouté au
//    message SEULEMENT quand la source du <script> matche le motif.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('transpiler — « isnt » identifiant réservé + hint spread-only else', function () {
  this.timeout(8000)

  describe('« isnt » nu/`$isnt` — identifiant réservé', () => {
    it('`isnt = 5` → throw explicite (« isnt » + « réservé » dans le message)', async () => {
      const src = '<script>\nisnt = 5\n</script>'
      await assert.rejects(
        () => transpile(src, { moduleName: 'isntreserved1' }),
        (err: any) => {
          assert.match(err.message, /isnt/, 'le message doit citer « isnt »')
          assert.match(err.message, /réservé/, 'le message doit dire « réservé »')
          return true
        }
      )
    })

    it('`$isnt = 5` → throw idem (le `$` ne protège pas de la collision)', async () => {
      const src = '<script>\n$isnt = 5\n</script>'
      await assert.rejects(
        () => transpile(src, { moduleName: 'isntreserved2' }),
        (err: any) => {
          assert.match(err.message, /isnt/, 'le message doit citer « isnt »')
          assert.match(err.message, /réservé/, 'le message doit dire « réservé »')
          return true
        }
      )
    })

    it("non-régression — l'opérateur `a isnt b` compile SANS erreur → `!==`", async () => {
      const src = '<script>\nx := 3\ny := (x isnt 2)\n</script>'
      const { output } = await transpile(src, { moduleName: 'isntreserved3' })
      assert.match(output, /!==/, "l'opérateur isnt doit rester converti en !==")
    })
  })

  describe('hint spread-only `else` (bug Civet amont)', () => {
    it('`else {...x}` (objet 100 % spread) → throw avec hint « Object.assign »', async () => {
      const src = [
        '<script>',
        '  $c = true',
        '  $a = { x: 1 }',
        '  $b = { y: 2 }',
        '  obj = if $c then {...$a} else {...$b}',
        '</script>',
      ].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: 'isntreserved4' }),
        (err: any) => {
          assert.match(err.message, /Object\.assign/, 'le hint doit suggérer Object.assign')
          return true
        }
      )
    })

    it('contrôle — `else {b: 2}` (clé explicite, pas 100 % spread) compile sans erreur', async () => {
      const src = [
        '<script>',
        '  $c = true',
        '  obj2 = if $c then {a: 1} else {b: 2}',
        '</script>',
      ].join('\n')
      await assert.doesNotReject(() => transpile(src, { moduleName: 'isntreserved5' }))
    })
  })
})
