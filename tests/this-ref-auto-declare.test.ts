import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// Auto-déclaration des refs DOM `@this=!{nom}` à variable NUE (sans `$`).
//
// Le binding émet `nom = node` et le script lit `nom`, mais sans déclaration
// `nom` n'existe nulle part → ReferenceError en module strict. Le compilateur
// hisse donc `let nom;` en tête de `init`, SAUF si le script le déclare déjà
// (sinon double `let` = SyntaxError). Cf. tuto bind-this (canvas).
describe('refs @this nues — auto-déclaration `let nom`', function () {
  this.timeout(40000)

  it('@this=!{canvas} sans déclaration dans le script → `let canvas` hissé', async () => {
    const { output } = await transpile(
      `<script>
  µeffect ->
    context = canvas.getContext('2d')
    -> null
</script>
<canvas @this=!{canvas}></canvas>`,
      { moduleName: 'auto_decl', baseDir: '/tmp' },
    )
    assert.match(output, /let canvas\b/, 'canvas doit être auto-déclaré')
  })

  it('script qui déclare déjà `canvas = null` → un SEUL `let canvas` (pas de double)', async () => {
    const { output } = await transpile(
      `<script>
  canvas = null
  µeffect ->
    context = canvas.getContext('2d')
    -> null
</script>
<canvas @this=!{canvas}></canvas>`,
      { moduleName: 'no_double', baseDir: '/tmp' },
    )
    const n = (output.match(/let canvas\b/g) ?? []).length
    assert.equal(n, 1, 'pas de double déclaration')
  })

  it('faux positif évité : `let context = canvas.x` ne compte PAS comme déclaration de canvas', async () => {
    // canvas à DROITE d'un `=` ne doit pas désactiver l'auto-déclaration.
    const { output } = await transpile(
      `<script>
  µeffect ->
    ctx = canvas.getContext('2d')
    -> null
</script>
<canvas @this=!{canvas}></canvas>`,
      { moduleName: 'rhs_only', baseDir: '/tmp' },
    )
    assert.match(output, /let canvas\b/, 'canvas lu à droite d\'un = doit quand même être auto-déclaré')
  })

  it('@this=!{$ref} réactif → PAS d\'auto-déclaration `let $ref` (la réactivité gère)', async () => {
    const { output } = await transpile(
      `<script>
  µeffect -> $ref?.focus()
</script>
<input @this=!{$ref} />`,
      { moduleName: 'reactive_ref', baseDir: '/tmp' },
    )
    assert.doesNotMatch(output, /let \$ref\b/, 'une ref réactive ne doit pas être déclarée en var nue')
  })
})
