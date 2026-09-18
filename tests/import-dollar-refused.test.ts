// `@import $counter 'chemin'` (dollar
// simple, tapé à la main) était accepté en silence, alors que le tuto (leçon
// `reactivite-universelle`) promet une erreur — seul un singleton s'importe par `µ$$X`
// (docs/14-stores.md). Il est prouvé que la garde ne peut PAS vivre dans directives.ts : la
// pré-passe 0-bis de transpiler/index.ts aplatit `µ$$X` en `$X` AVANT extraction, un `$counter`
// issu de `µ$$counter` y devient indiscernable d'un `$counter` tapé.
//
// RÉACTIVÉ : `@import $x 'chemin'` (nom à dollar simple) est
// REFUSÉ à la compilation, seul `µ$$X` importe un singleton. Le blocage précédent tenait à
// tests/transpiler.test.ts:267-273 (`@import $shared 'mod/shared'`, syntaxiquement identique à
// `@import $counter`) : ce test a migré vers `@import µ$$shared 'mod/shared'`, la contradiction
// n'existe plus — describe.skip levé, garde remise dans transpiler/index.ts telle que décrite
// ci-dessus (regex inchangée, prouvée rouge puis vert sur les 4 cas historiques + 2 cas ajoutés :
// `default $x` et un 2ᵉ nom `a $b`).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('@import $nom (dollar simple, sans µ$) → erreur', () => {
  it('@import $counter \'./s.mjs\' : erreur, message orienté vers µ$$', async () => {
    const src = `@import $counter './s.mjs'\n<script>$y = 1</script>\n<p>{$y}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'b31dollar' }),
      /µ\$\$counter/,
    )
  })

  it('@import µ$$counter \'./s.mjs\' : OK (forme correcte, non affectée)', async () => {
    const src = `@import µ$$counter './s.mjs'\n<p>{µ$$counter.value}</p>`
    const { output } = await transpile(src, { moduleName: 'b31singleton' })
    assert.match(output, /import \{ \$counter \} from/)
  })

  it('@import x \'./s.mjs\' : OK (nom sans dollar, forme historique)', async () => {
    const src = `@import x './s.mjs'\n<script>$y = 1</script>\n<p>{$y}</p>`
    const { output } = await transpile(src, { moduleName: 'b31nodollar' })
    assert.match(output, /import \{ x \} from/)
  })

  it('@import $x dans un <pre><code> (contre-exemple de doc) : OK, jamais exécuté comme du code', async () => {
    const src = `<pre><code>@import $x 'exemple'</code></pre>\n<script>$y = 1</script>\n<p>{$y}</p>`
    // pas de garde attendue : le $x du <pre><code> ne doit jamais déclencher import-nom-dollar
    const { output } = await transpile(src, { moduleName: 'b31docexample' })
    assert.match(output, /import \{ µ \} from/, 'compile normalement')
  })

  it('@import default $x \'./s.mjs\' : erreur, le nom par défaut porte aussi le dollar', async () => {
    const src = `@import default $x './s.mjs'\n<script>$y = 1</script>\n<p>{$y}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'b31default' }),
      /µ\$\$x/,
    )
  })

  it('@import a $b \'./s.mjs\' : erreur, le 2ᵉ nom porte le dollar', async () => {
    const src = `@import a $b './s.mjs'\n<script>$y = 1</script>\n<p>{$y}</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'b31secondnom' }),
      /µ\$\$b/,
    )
  })
})
