// Régression — un handler `@event={…}`
// MULTI-LIGNES sur une macro globale (<@window>/<@document>/<@body>/<@head>)
// voyait son indentation détruite par un `.trim()` PAR LIGNE dans
// `parseListeners` (macros.ts) : toutes les lignes retombaient au même
// niveau (2 espaces). En Civet/Coffee (sensible à l'indentation), un `if`
// suivi d'une ligne au MÊME niveau se retrouve avec un corps VIDE, et la
// ligne suivante s'exécute INCONDITIONNELLEMENT — corruption silencieuse de
// la logique utilisateur, sans la moindre erreur de compilation.
//
// Fix : `dedent()` du corps BRUT (avant tout trim) + réindentation uniforme,
// identique à l'algorithme déjà utilisé pour les handlers inline
// (generator/attributes/index.ts).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('macro globale — handler multi-lignes préserve l\'indentation', function () {
  this.timeout(8000)

  it('if postfix structuré : la mutation reste À L\'INTÉRIEUR du if (pas inconditionnelle)', async () => {
    const src = [
      '<script>$open = true</script>',
      "<@window @keydown={\n  if e.key is 'Escape'\n    $open = false\n} />",
      '<p>{$open}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-macro-if-nested' })
    // La mutation de $open doit apparaître DANS le bloc `{ }` du if, pas
    // juste après (au même niveau que le if lui-même).
    assert.match(
      output,
      /if\s*\(e\.key\s*===\s*'Escape'\)\s*\{\s*return µ\._set\(_mjsThis,\s*'open',\s*false\)\s*\}/,
      'la mutation $open=false doit être nichée dans le corps du if, pas exécutée inconditionnellement à chaque keydown'
    )
  })

  it('deux instructions SŒURS (même niveau) : les deux sont émises, aucune avalée', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '<@window @keydown={\n  $a = 10\n  $b = 20\n} />',
      '<p>{$a} {$b}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-macro-siblings' })
    assert.match(output, /µ\._set\(_mjsThis,\s*'a',\s*10\)/, 'première instruction sœur présente')
    assert.match(output, /µ\._set\(_mjsThis,\s*'b',\s*20\)/, 'deuxième instruction sœur présente (ne doit pas être avalée par un if fantôme)')
  })

  it('handler mono-ligne (cas nominal) reste inchangé', async () => {
    const src = [
      '<script>$n = 0</script>',
      '<@window @keydown={$n = $n + 1} />',
      '<p>{$n}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-macro-oneline' })
    assert.match(output, /µ\._mjs_deepSet|_mjsThis\._state\.n|µ\._set\(_mjsThis,\s*'n'/)
  })

  it('handler référence nue AVEC accolades ({onKey}) reste auto-appelé (e)', async () => {
    const src = [
      '<script>\n  $count = 0\n  onKey = -> $count = $count + 1\n</script>',
      '<@window @keydown={onKey} />',
      '<p>{$count}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-macro-bare-ref' })
    assert.match(output, /onKey\(e\)/, 'la référence nue doit être auto-appelée avec (e), pas juste `return onKey` (régression possible si le rawBody écrase la réécriture)')
  })

  it('forme abrégée SANS accolades (@keydown=onKey, valeur brute non-macro) reste inchangée', async () => {
    // Forme "nom d'event nu sans valeur" : `handler = ev + '(e)'` littéral
    // (ex. <@document @selectionchange> sans valeur du tout).
    const src = [
      '<script>$n = 0</script>',
      '<@document @selectionchange />',
      '<p>{$n}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-macro-noval' })
    assert.match(output, /selectionchange\(e\)/)
  })
})
