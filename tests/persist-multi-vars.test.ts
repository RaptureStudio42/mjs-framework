// Régression : `@persist $a $b` (2+ vars
// dans la même directive, ou 2 directives @persist distinctes) émettait des
// temporaires PARTAGÉS (`_mjs_p_key`/`_mjs_p_stored`/`_mjs_p_parsed`) une fois
// PAR variable, tous dans le même scope de script → Civet refusait la
// compilation entière du composant : « Identifier '_mjs_p_key' has already
// been declared ». Fix : chaque temporaire est désormais suffixé par le nom
// de la variable persistée (`_mjs_p_key_a`, `_mjs_p_key_b`…).
//
// Le séparateur de la liste passe de la VIRGULE à
// l'ESPACE (`@persist $a $b`, plus `@persist $a, $b`) : fichier adapté à la
// nouvelle grammaire (cf. aussi le garde-fou virgule-résiduelle, tests
// dédiés en fin de fichier).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('@persist — multi-vars ne doit plus jamais casser la compilation', function () {
  this.timeout(8000)

  it('@persist $a $b (2 vars, même directive) compile sans erreur', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '@persist $a $b',
      '<p>{$a} {$b}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-persist-multi-a' })
    assert.match(output, /localStorage/, 'code persist généré')
    // Les 2 clés temporaires doivent être DISTINCTES (suffixées par var).
    assert.match(output, /_mjs_p_key_a\b/)
    assert.match(output, /_mjs_p_key_b\b/)
  })

  it('@persist $a suivi de @persist $b (2 directives distinctes) compile sans erreur', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '@persist $a',
      '@persist $b',
      '<p>{$a} {$b}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-persist-multi-b' })
    assert.match(output, /localStorage/)
  })

  it('@persist $a $b $c (3 vars) compile sans erreur, chaque var a son propre code', async () => {
    const src = [
      '<script>$a = 1\n$b = 2\n$c = 3</script>',
      '@persist $a $b $c',
      '<p>{$a} {$b} {$c}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-persist-multi-c' })
    assert.match(output, /_mjs_p_key_a\b/)
    assert.match(output, /_mjs_p_key_b\b/)
    assert.match(output, /_mjs_p_key_c\b/)
  })

  it('mix local + session, plusieurs vars chacun : aucune collision de temporaires', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '@persist $a',
      '@persist session: $b',
      '<p>{$a} {$b}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-persist-multi-d' })
    assert.match(output, /localStorage/)
    assert.match(output, /sessionStorage/)
  })

  it('cas nominal (1 seule var) reste inchangé fonctionnellement', async () => {
    const src = [
      '<script>$a = 1</script>',
      '@persist $a',
      '<p>{$a}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-persist-single' })
    assert.match(output, /localStorage/)
    assert.match(output, /_mjs_p_key_a\b/)
  })
})

// Une virgule résiduelle (ancienne écriture) reste
// COLLÉE au nom qui la précède après le split par espace (`"$a," `) : le
// garde-fou de validation existant (`^[a-zA-Z_]\w*$`, buildPersistCode) la
// rejette automatiquement, aucune nouvelle logique de détection nécessaire —
// seul le MESSAGE change (recommande l'espace, plus la virgule).
describe('@persist — virgule résiduelle (ancienne écriture) rejetée par le garde-fou de nom existant', function () {
  this.timeout(8000)

  it('@persist $a, $b (virgule, ancienne écriture) → erreur de nom invalide orientant vers l\'espace', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '@persist $a, $b',
      '<p>{$a} {$b}</p>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'mjs-persist-virgule' }),
      /n'est pas un nom de variable valide.*sépare les variables par un espace \(@persist \$a \$b\)/s,
    )
  })
})
