// Handlers inline — harmonisation Civet : `@click={…}`
// (et `value=!{…}`/`@group=!{…}`/etc., tous compilés via le même batch
// `_mjs_inline`) passent de CoffeeScript à Civet quand `templateLang ===
// 'civet'` (le défaut, cf. transpiler/index.ts). L'ancien chemin Coffee reste
// le repli via `templateLang: 'js'` (mode « template historique »).
//
// Seul point de divergence d'ÉMISSION entre les deux grammaires : l'existentiel
// binaire Coffee `a ? b` (reconstruction d'item dans un `{for}`, ex. `__idx_0 =
// el._mjs_idx_0 ? el.getAttribute(…)`) — Civet ne le comprend pas (« Failed to
// parse ») et Coffee ne comprend pas `??` (« unexpected ? ») ; le generator
// choisit l'opérateur via `state.templateLang` (cf. attributes/index.ts). Tout
// le reste du squelette (postfix if/unless, if/then/else, and/or/not/is,
// interpolation `#{}`) compile identiquement aux deux — vérifié par sonde
// directe sur les deux compilateurs avant d'écrire ces tests.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('handlers inline — Civet par défaut', () => {
  it('défaut (sans option) : ternaire ESPACÉ compile, la sortie contient le ternaire JS', async () => {
    const { output } = await transpile(
      `<button @click={$n = $ok ? 'x' : 'y'}>x</button>`,
      { moduleName: 'hc-ternaire' }
    )
    assert.match(output, /\$\.ok \? 'x' : 'y'/, 'le ternaire espacé doit survivre tel quel (Civet le compile nativement)')
  })

  it('unless (postfix) compile comme avant — déjà neutralisé en JS pur par cleanJs, avant même Coffee/Civet', async () => {
    const { output } = await transpile(
      `<button @click={$go() unless $blocked}>x</button>`,
      { moduleName: 'hc-unless' }
    )
    assert.match(output, /!\(\$\.blocked\)/, 'unless devient un garde !(cond)')
    assert.match(output, /\$\.go\(\)/, 'l\'appel protégé doit rester présent')
  })

  it('interpolation Coffee "#{$x}" compile comme avant (template literal JS)', async () => {
    const { output } = await transpile(
      `<button @click={$msg = "val=#{$n}"}>x</button>`,
      { moduleName: 'hc-interp' }
    )
    assert.match(output, /`val=\$\{\$\.n\}`/, 'l\'interpolation Coffee doit devenir un template literal JS')
  })

  it('postfix if compile comme avant', async () => {
    const { output } = await transpile(
      `<button @click={$go() if $ready}>x</button>`,
      { moduleName: 'hc-postfix-if' }
    )
    assert.match(output, /if\s*\(\$\.ready\)/, 'postfix if devient un if(cond) bloc')
    assert.match(output, /\$\.go\(\)/)
  })

  it('ternaire COLLÉ (a?b:c) : throw avec l\'indice « ajoute des espaces »', async () => {
    await assert.rejects(
      transpile(`<button @click={$n = $ok?'x':'y'}>x</button>`, { moduleName: 'hc-ternaire-colle' }),
      (err: any) => {
        assert.match(err.message, /\[ModularJS\] handler inline : échec de compilation Civet/, 'préfixe orientant attendu')
        assert.match(err.message, /« hc-ternaire-colle »/, 'nom du composant cité')
        assert.match(err.message, /ajoute des espaces.*a \?\? b/s, 'indice ternaire collé + équivalence ?? attendus')
        return true
      }
    )
  })

  it('templateLang: "js" : le ternaire collé retrouve le comportement HISTORIQUE Coffee (aucun throw)', async () => {
    // Comportement Coffee RÉEL (vérifié empiriquement, sonde directe sur le
    // compilateur avant d'écrire cette assertion) : `a?b:c` collé n'est PAS un
    // ternaire pour Coffee — `?` = existentiel, `b:c` = hash implicite → appel
    // conditionnel de `$ok` avec un objet `{x:'y'}` en argument. Silencieusement
    // FAUX (jamais 'x'/'y' littéraux) mais c'est le comportement ACTUEL, celui
    // que le repli 'js' doit reproduire au caractère près.
    const { output } = await transpile(
      `<button @click={$n = $ok?'x':'y'}>x</button>`,
      { moduleName: 'hc-ternaire-colle-js', templateLang: 'js' }
    )
    assert.match(output, /typeof \$\.ok === "function"/)
    assert.match(output, /'x': 'y'/)
    assert.match(output, /: void 0/)
  })

  it('templateLang: "js" : handler existant `if $a then @go() else @stop()` compile à l\'identique de l\'actuel', async () => {
    const { output } = await transpile(
      `<button @click={if $a then @go() else @stop()}>x</button>`,
      { moduleName: 'hc-if-then-else-js', templateLang: 'js' }
    )
    assert.match(output, /if\s*\(\$\.a\)/)
    assert.match(output, /this\.go\(\)/)
    assert.match(output, /this\.stop\(\)/)
  })

  it('corps multi-lignes (2 instructions sœurs) compile correctement par défaut', async () => {
    const { output } = await transpile(
      `<button @click={$n = $n + 1\n$count = $count + 1}>x</button>`,
      { moduleName: 'hc-multiline' }
    )
    assert.match(output, /µ\._set\(_mjsThis, 'n', \$\.n \+ 1\)/, 'première instruction sœur présente')
    assert.match(output, /µ\._set\(_mjsThis, 'count', \$\.count \+ 1\)/, 'deuxième instruction sœur présente (aucune avalée)')
  })

  it('corps multi-lignes : templateLang "js" compile aussi les deux instructions sœurs', async () => {
    const { output } = await transpile(
      `<button @click={$n = $n + 1\n$count = $count + 1}>x</button>`,
      { moduleName: 'hc-multiline-js', templateLang: 'js' }
    )
    assert.match(output, /µ\._set\(_mjsThis, 'n', \$\.n \+ 1\)/)
    assert.match(output, /µ\._set\(_mjsThis, 'count', \$\.count \+ 1\)/)
  })

  it('modificateur .prevent inchangé', async () => {
    const { output } = await transpile(
      `<a href="#" @click.prevent={$n = 1}>x</a>`,
      { moduleName: 'hc-prevent' }
    )
    assert.match(output, /e\.preventDefault\(\)/)
    assert.match(output, /µ\._set\(_mjsThis, 'n', 1\)/)
  })

  it('reconstruction de boucle {for} + @click compile par défaut (existentiel `??` Civet)', async () => {
    const src = [
      '<script>',
      '$items = [1,2,3]',
      '</script>',
      '<div>{for item, i in $items}<button @click={$n = item}>x</button>{end}</div>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'hc-loop' })
    assert.match(output, /_mjs_idx_0 \?\? el\.getAttribute\('data-mjs-idx-0'\)/, 'civet : existentiel `??`')
  })

  it('reconstruction de boucle {for} + @click : templateLang "js" garde l\'existentiel `?` historique', async () => {
    const src = [
      '<script>',
      '$items = [1,2,3]',
      '</script>',
      '<div>{for item, i in $items}<button @click={$n = item}>x</button>{end}</div>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'hc-loop-js', templateLang: 'js' })
    assert.match(output, /\(ref = el\._mjs_idx_0\) != null \? ref : el\.getAttribute\('data-mjs-idx-0'\)/, 'coffee : existentiel `a ? b` compilé en ternaire null-check')
  })
})
