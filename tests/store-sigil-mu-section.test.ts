// Test de régression — sigil store `µ$$X` / `$$X` (on double le `$` de la
// variable réactive). UNIQUE sigil store : l'ancien `µ§` a été RETIRÉ.
// Alias visuel de `µ$X` qui signale au lecteur que la variable fait office de
// source de vérité partagée. Même mécanisme runtime, sigil distinct (double `$`).
//
// Validations couvertes :
//   - `export µ$$X = expr` dans un module est transformé en `export µ$X = expr`
//     puis route via le sucre store universel existant.
//   - `µ$$X` (lecture) est transformé en `$X`, SI `X` a été déclaré `export
//     µ$$X` dans ce même source (applyMjsSugarToScript recrée sa propre
//     garantie « nom connu », ce chemin ne passant pas par la pré-passe 0-bis
//     de transpile() qui connaît les `@import`).
//   - `µ§` n'est PLUS reconnu (retiré) — garde-fou contre un retour silencieux.

import assert from 'node:assert/strict'
import { applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('compile — sigil store µ$$ / $$ (ex-µ§ retiré)', function () {
  it('`µ$$X` (lecture) est aliasé en `$X` (nom déclaré `export µ$$X` dans la même source)', function () {
    const out = applyMjsSugarToScript(`export µ$$count = { value: 0 }\n<button @click={µ$$count.value++}>{µ$$count.value}</button>`)
    assert.match(out, /\$count\.value\+\+/, "$count.value++ attendu")
    assert.doesNotMatch(out, /µ\$\$/, "plus aucun µ$$ ne doit subsister")
  })

  it('`µ$$X` SANS déclaration `export µ$$X` dans la même source → erreur singleton-sans-import', function () {
    assert.throws(
      () => applyMjsSugarToScript(`<button @click={µ$$count.value++}>{µ$$count.value}</button>`),
      /« µ\$\$count » utilisé sans/
    )
  })

  it('`export µ$$X = expr` enchaîne sur le sucre store universel', function () {
    const out = applyMjsSugarToScript(`export µ$$count = { value: 0 }`)
    assert.match(out, /µ_state\.count\s*\?=\s*µ\.state\(\{\s*value:\s*0\s*\}\)/,
      "µ_state.count ?= µ.state(...) attendu après expansion du sucre")
    assert.match(out, /export\s+\$count\s*=\s*µ_state\.count/,
      "export $count = µ_state.count attendu")
  })

  it('`µ§` retiré : laissé tel quel (n\'est plus un sigil store)', function () {
    assert.equal(applyMjsSugarToScript('µ§count.value'), 'µ§count.value')
  })
})
