// garde symboles réservés ($, $$, µ) : interdire à la
// compilation toute variable qui s'appellerait juste par un des symboles utilisés par MJS.
//
// Le défaut (déjà corrigé) : `paint = ($) -> $.style.color = 'red'`
// compile en `paint = function($) { return µ._mjs_deepSet(_mjsThis, ["style","color"], 'red') }` —
// la mutation voulue n'a jamais lieu ET un état `$style.color` du composant est écrit à la
// place, zéro erreur. `f = (µ) -> …` masque le runtime entier. `path-tracker.ts` ne distingue
// pas le `$`/`µ` PARAMÈTRE du `$`/`µ` FRAMEWORK — même MemberExpression `$.xxx` dans l'AST.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('garde — $, $$, µ jamais comme nom de variable', function () {
  it('paramètre $ masque l\'état du composant : rejeté, extrait cité', async function () {
    await assert.rejects(
      () => transpile("<script>\n  $style = { color: 'black' }\n  paint = ($) ->\n    $.style.color = 'red'\n</script>\n<p>{$style.color}</p>\n", { moduleName: 'card' }),
      (e: Error) => {
        assert.match(e.message, /symbole du framework/)
        assert.match(e.message, /« \$ »/)
        assert.match(e.message, /function\(\$\)/)
        return true
      },
    )
  })

  it('paramètre µ masque le runtime : rejeté, nomme µ', async function () {
    await assert.rejects(
      () => transpile('<script>\n  f = (µ) -> µ.x\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
      (e: Error) => {
        assert.match(e.message, /« µ »/)
        return true
      },
    )
  })

  describe('déclaration explicite (:=) — les trois symboles', function () {
    it('$ := 3', async function () {
      await assert.rejects(
        () => transpile("<script>\n  $ := 3\n</script>\n<p>x</p>\n", { moduleName: 'card' }),
        /« \$ »/,
      )
    })

    it('$$ := 1', async function () {
      await assert.rejects(
        () => transpile("<script>\n  $$ := 1\n</script>\n<p>x</p>\n", { moduleName: 'card' }),
        /« \$\$ »/,
      )
    })

    it('µ := 1', async function () {
      await assert.rejects(
        () => transpile('<script>\n  µ := 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        /« µ »/,
      )
    })
  })

  it('handler inline : IIFE ($) -> $.y — rejeté, section (handlers)', async function () {
    await assert.rejects(
      () => transpile('<button @click={(($) -> $.y)(e)}>x</button>\n', { moduleName: 'card' }),
      (e: Error) => {
        assert.match(e.message, /« \$ »/)
        assert.match(e.message, /\(handlers\)/)
        return true
      },
    )
  })

  it('<script module> : rejeté, section <script module>', async function () {
    await assert.rejects(
      () => transpile("<script module>\n  $ := 1\n</script>\n<script>\n  x = 1\n</script>\n<p>x</p>\n", { moduleName: 'card' }),
      (e: Error) => {
        assert.match(e.message, /« \$ »/)
        assert.match(e.message, /<script module>/)
        return true
      },
    )
  })

  it('motif de paramètre déstructuré { $ }', async function () {
    await assert.rejects(
      () => transpile('<script>\n  g = ({ $ }) -> 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
      /« \$ »/,
    )
  })

  it('for $ of list, dans une fonction', async function () {
    await assert.rejects(
      () => transpile('<script>\n  h = ->\n    list = [1, 2]\n    for $ of list\n      console.log($)\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
      /« \$ »/,
    )
  })

  it('<script lang="coffee"> : le JS émis par Coffee garde aussi le paramètre', async function () {
    await assert.rejects(
      () => transpile("<script lang=\"coffee\">\n  paint = ($) ->\n    $.style.color = 'red'\n</script>\n<p>x</p>\n", { moduleName: 'card' }),
      /« \$ »/,
    )
  })

  it('aucun faux positif — composant ordinaire', async function () {
    const src = "<script>\n  $a = 1\n  $$theme = 'x'\n  $list = [1, 2, 3]\n  µeffect ->\n    console.log($a)\n  x = µread $a\n  @go = -> µRouter.to('/x')\n</script>\n<button @click={$a++}>x</button>\n{for item in $list}<p>{item}</p>{end}\n"
    const { output } = await transpile(src, { moduleName: 'card' })
    assert.match(output, /µ\._def\(/)
  })

  it('aucun faux positif — accès membre, clé, chaîne ne sont pas des liaisons', async function () {
    const src = "<script>\n  opts = { $: 1 }\n  y = opts.$\n  s = '$'\n  z = opts.µ\n</script>\n<p>x</p>\n"
    const { output } = await transpile(src, { moduleName: 'card' })
    assert.match(output, /µ\._def\(/)
  })

  describe('variable/index de {for} nommés par un symbole', function () {
    it('{for $ in $list} : item $ rejeté, message symbole du framework', async function () {
      await assert.rejects(
        () => transpile('{for $ in $list}<p>{$}</p>{end}\n', { moduleName: 'card' }),
        (e: Error) => {
          assert.match(e.message, /symbole du framework/)
          assert.match(e.message, /« \$ »/)
          return true
        },
      )
    })

    it('{for $$ in $list} : item $$ rejeté', async function () {
      await assert.rejects(
        () => transpile('{for $$ in $list}<p>{$$}</p>{end}\n', { moduleName: 'card' }),
        /« \$\$ »/,
      )
    })

    it('{for x, $ in $list} : index $ rejeté', async function () {
      await assert.rejects(
        () => transpile('{for x, $ in $list}<p>{x}:{$}</p>{end}\n', { moduleName: 'card' }),
        /« \$ »/,
      )
    })

    it('{for µ in $list} : rejeté (classe de caractères élargie → passe par la garde symbole, message symbole du framework)', async function () {
      await assert.rejects(
        () => transpile('{for µ in $list}<p>{µ}</p>{end}\n', { moduleName: 'card' }),
        /« µ »/,
      )
    })
  })

  describe('ordre des gardes : symbole réservé AVANT « nom jamais déclaré »', function () {
    it('$ = 3 nu top-level : message symbole du framework, jamais « nom jamais déclaré »', async function () {
      await assert.rejects(
        () => transpile('<script>\n  $ = 3\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        (e: Error) => {
          assert.match(e.message, /symbole du framework/)
          assert.doesNotMatch(e.message, /nom jamais déclaré/)
          return true
        },
      )
    })

    it('µ = 3 nu top-level : message symbole du framework, jamais « nom jamais déclaré »', async function () {
      await assert.rejects(
        () => transpile('<script>\n  µ = 3\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        (e: Error) => {
          assert.match(e.message, /symbole du framework/)
          assert.doesNotMatch(e.message, /nom jamais déclaré/)
          return true
        },
      )
    })

    it('$$ = 3 nu top-level : message symbole du framework, jamais « nom jamais déclaré »', async function () {
      await assert.rejects(
        () => transpile('<script>\n  $$ = 3\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        (e: Error) => {
          assert.match(e.message, /symbole du framework/)
          assert.doesNotMatch(e.message, /nom jamais déclaré/)
          return true
        },
      )
    })
  })

  describe('témoins figés, comportement inchangé', function () {
    it('{for item in $list} et {for i, item in $list} compilent', async function () {
      const src1 = "<script>\n  $list = [1, 2, 3]\n</script>\n{for item in $list}<p>{item}</p>{end}\n"
      const { output: out1 } = await transpile(src1, { moduleName: 'card' })
      assert.match(out1, /µ\._def\(/)
      const src2 = "<script>\n  $list = [1, 2, 3]\n</script>\n{for i, item in $list}<p>{i}:{item}</p>{end}\n"
      const { output: out2 } = await transpile(src2, { moduleName: 'card' })
      assert.match(out2, /µ\._def\(/)
    })

    it('{for $item in $list} : $ PRÉFIXÉ dans un nom de boucle — compile aujourd\'hui, comportement figé sans changement', async function () {
      const src = "<script>\n  $list = [1, 2, 3]\n</script>\n{for $item in $list}<p>{$item}</p>{end}\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })
  })
})

// garde § / §§ nus. `§x`/`§§x` sont réécrits par les pré-passes des
// deux moteurs de sucre (lexer tokenize, cleanJs generator/utils.ts) — un `§`/`§§` NU (pas
// suivi d'un nom) survit à ces réécritures et atteint Civet tel quel, caractère hors alphabet
// JS : message cryptique. Même refus explicite que $/$$/µ ci-dessus, mais posé AVANT Civet
// (sigils.ts BARE_SECTION_BODY), pas via l'AST du JS compilé (§ n'y arriverait jamais).
describe('§ et §§ nus — jamais un symbole du framework sans nom', function () {
  describe('§/§§ NU (non suivi d\'un nom) : rejeté, message symbole du framework', function () {
    it('f = (§) -> 1', async function () {
      await assert.rejects(
        () => transpile('<script>\n  f = (§) -> 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        (e: Error) => {
          assert.match(e.message, /symbole du framework/)
          assert.match(e.message, /§/)
          return true
        },
      )
    })

    it('§ := 1', async function () {
      await assert.rejects(
        () => transpile('<script>\n  § := 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        /symbole du framework/,
      )
    })

    it('x = §', async function () {
      await assert.rejects(
        () => transpile('<script>\n  x = §\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        /symbole du framework/,
      )
    })

    it('§§ = 2', async function () {
      await assert.rejects(
        () => transpile('<script>\n  §§ = 2\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        /symbole du framework/,
      )
    })

    it('g = (§§) -> 1', async function () {
      await assert.rejects(
        () => transpile('<script>\n  g = (§§) -> 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
        /symbole du framework/,
      )
    })
  })

  it('handler @click={§ = 1} : rejeté (moteur cleanJs)', async function () {
    await assert.rejects(
      () => transpile('<button @click={§ = 1}>x</button>\n', { moduleName: 'card' }),
      /symbole du framework/,
    )
  })

  it('interpolation { § } : rejeté', async function () {
    await assert.rejects(
      () => transpile('<p>{ § }</p>\n', { moduleName: 'card' }),
      /symbole du framework/,
    )
  })

  it('<script module> : § := 1 rejeté', async function () {
    await assert.rejects(
      () => transpile('<script module>\n  § := 1\n</script>\n<script>\n  x = 1\n</script>\n<p>x</p>\n', { moduleName: 'card' }),
      /symbole du framework/,
    )
  })

  describe('aucun faux refus', function () {
    it('§theme (contexte figé, lecture)', async function () {
      const src = '<script>\n  x = §theme\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('§§count (contexte réactif, lecture)', async function () {
      const src = '<script>\n  y = §§count\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('§§count.x = 1 (chemin sous contexte réactif)', async function () {
      const src = '<script>\n  §§count.x = 1\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it("x = '§' (chaîne, pas le symbole)", async function () {
      const src = "<script>\n  x = '§'\n</script>\n<p>x</p>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('# un § en commentaire', async function () {
      const src = '<script>\n  # un § en commentaire\n  x = 1\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it("µt('§')", async function () {
      const src = "<p>{µt('§')}</p>\n"
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('<p>§ 12</p> (texte HTML, pas du code)', async function () {
      const { output } = await transpile('<p>§ 12</p>\n', { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    it('<code>§</code> (masqué)', async function () {
      const { output } = await transpile('<code>§</code>\n', { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })

    // `§` n'est ici qu'un CARACTÈRE d'un
    // littéral regex, jamais le symbole du framework. Couverture complète (les deux moteurs de
    // sucre, divisions, µTotal réécrit à tort…) : tests/regex-litteraux-masques.test.ts.
    it('x = /§/ (littéral regex, § protégé)', async function () {
      const src = '<script>\n  x = /§/\n</script>\n<p>x</p>\n'
      const { output } = await transpile(src, { moduleName: 'card' })
      assert.match(output, /µ\._def\(/)
    })
  })
})
