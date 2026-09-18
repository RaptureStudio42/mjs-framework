// Test de régression — deux défauts de cleanJs :
//
//   [MAJEUR, utils.ts:107] `unless` POSTFIX corrompu : cleanJs ne gérait
//   que la forme préfixe (`unless cond` → `!(cond)`). En position postfix
//   (`expr unless cond`, idiome Coffee/Civet natif "fais expr sauf si cond"),
//   seule la partie après `unless` était transformée : le préfixe intact +
//   `!(cond)` produisaient du JS juxtaposé INVALIDE — `@click={$n++ unless
//   $locked}` → `$.n++ !($.locked)` (SyntaxError). Fix : capture d'un préfixe
//   optionnel, comportement préfixe pur inchangé sinon.
//
//   La 1ʳᵉ version du fix `unless`
//   émettait un TERNAIRE avec `void` (`(cond ? void 0 : (prefix))`), VALIDE en
//   JS mais PAS en CoffeeScript : or cleanJs alimente AUSSI les inlines
//   d'événements recompilés en Coffee (Coffee n'a ni `?:` ni `void`) → tout
//   handler `@event={… unless …}` échouait à la compilation. Nouvelle forme :
//   court-circuit `(!(cond) && (prefix))` — valide en JS ET en Coffee, mêmes
//   effets en position statement (la valeur devient `false` au lieu de
//   `undefined` quand cond vrai, sans usage connu).
//
//   [MINEUR, utils.ts] snapshot `$x =: expr` non géré en interpolation :
//   le lexer gère déjà `=:` dans <script> (§3.7, désactive la dérivation
//   auto), mais cleanJs (interpolations `{...}`/`@x={...}`) l'ignorait
//   totalement — un `=:` littéral atterrissait dans le JS final (SyntaxError,
//   `=:` n'est pas un opérateur JS). Fix : même règle dans cleanJs, mais avec
//   parenthèses explicites autour de l'expression (`µ.snap(expr)`) — cleanJs
//   ne repasse PAS par Civet ensuite (contrairement au lexer), donc l'appel
//   Coffee "nu" `µ.snap expr` serait un SyntaxError direct ici.

import assert from 'node:assert/strict'
import { cleanJs } from '../src/generator/utils.js'

describe("cleanJs — `unless` postfix", () => {
  it('forme PRÉFIXE pure `unless $locked` : comportement INCHANGÉ (non-régression)', () => {
    assert.equal(cleanJs('unless $locked', []), '!($.locked)')
  })

  it("forme POSTFIX `$n++ unless $locked` : court-circuit englobant, plus de JS juxtaposé", () => {
    const out = cleanJs('$n++ unless $locked', [])
    assert.doesNotMatch(out, /\)\s*!\(/,
      "AVANT le fix : `$.n++ !($.locked)` — deux expressions juxtaposées, SyntaxError")
    // Court-circuit `(!(cond) && (prefix))` (valide en JS ET Coffee),
    // plus de ternaire `?:`/`void` (invalides en Coffee → inlines d'events cassés).
    assert.equal(out, '(!($.locked) && ($.n++))')
    assert.doesNotMatch(out, /\bvoid\b|\?/, "ni `void` ni `?` : la forme doit rester compilable en CoffeeScript")
  })

  it("exécution réelle (new Function) : verrouillé → no-op, déverrouillé → incrémente", () => {
    const out = cleanJs('$n++ unless $locked', [])
    const run = (locked: boolean) => {
      const $: any = { n: 0, locked }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('$', out)($)
      return $.n
    }
    assert.equal(run(true), 0, 'verrouillé : $n ne doit PAS incrémenter (AVANT le fix : SyntaxError, ce test ne pouvait même pas tourner)')
    assert.equal(run(false), 1, 'déverrouillé : $n doit incrémenter')
  })

  it('postfix avec préfixe = appel de fonction (pas juste `++`) : court-circuit correct', () => {
    const out = cleanJs('doSomething() unless $x > 5', [])
    assert.equal(out, '(!($.x > 5) && (doSomething()))')
  })

  it("postfix : exécution réelle avec effet de bord observable dans le préfixe", () => {
    const out = cleanJs('log.push(1) unless $skip', [])
    const run = (skip: boolean) => {
      const log: number[] = []
      const $: any = { skip }
      // eslint-disable-next-line @typescript-eslint/no-implied-eval
      new Function('$', 'log', out)($, log)
      return log
    }
    assert.deepEqual(run(true), [], 'skip=true : le préfixe ne doit PAS s\'exécuter')
    assert.deepEqual(run(false), [1], 'skip=false : le préfixe doit s\'exécuter')
  })

  it("`not`/`and`/`or`/`is` restent gérés normalement en présence de `unless` (pas d'interférence de pipeline)", () => {
    assert.equal(cleanJs('$x++ unless $a is $b', []), '(!($.a === $.b) && ($.x++))')
  })
})

describe("cleanJs — snapshot `$x =: expr`", () => {
  it("`$total =: computeTotal($items)` → assignation directe avec µ.snap(...), parenthésée", () => {
    const out = cleanJs('$total =: computeTotal($items)', [])
    assert.equal(out, '$.total = µ.snap(computeTotal($.items))')
  })

  it("AVANT le fix, `=:` restait littéral dans le JS (SyntaxError) — vérifié par exécution réelle", () => {
    const out = cleanJs('$total =: 41 + 1', [])
    const $: any = { total: 0 }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('$', 'µ', out)($, { snap: (v: any) => v })
    assert.equal($.total, 42, "AVANT le fix : `$.total =: 41 + 1` littéral → SyntaxError à l'instanciation de la Function")
  })

  it('singleton importé (externalVars) : garde `$xxx` sans le préfixer en `$.xxx`', () => {
    assert.equal(cleanJs('$total =: compute()', ['$total']), '$total = µ.snap(compute())')
  })

  it("s'arrête au `;` (ne dévore pas le reste de l'expression)", () => {
    const out = cleanJs('$total =: computeTotal(); doSomethingElse()', [])
    assert.equal(out, '$.total = µ.snap(computeTotal()); doSomethingElse()')
  })

  it('précède bien la règle générique `$x → $.x` (le nom cible lui-même est aussi transformé correctement)', () => {
    // Ici $y (la cible) ET $z (dans l'expr) doivent tous deux devenir $.y / $.z.
    assert.equal(cleanJs('$y =: $z * 2', []), '$.y = µ.snap($.z * 2)')
  })

  it('ne interfère pas avec une comparaison `=` simple sans `:` (non-régression générale)', () => {
    assert.equal(cleanJs('$x = 5', []), '$.x = 5')
  })
})
