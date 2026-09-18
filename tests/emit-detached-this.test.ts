// µemit détaché — `this` (via l'ancien `@_mjs_emit`, Civet `@` = `this.`) n'est
// PAS toujours l'instance du composant : dans un
// objet utilisateur imbriqué (`helper = { go: -> µemit 'x' }`), `this` à
// l'intérieur de `go` vaut `helper` au moment de l'appel `helper.go()` —
// `this._mjs_emit` n'existe pas dessus, TypeError. `rebindDetachedThis` laisse
// SCIEMMENT ce cas (c'est une méthode réelle d'un objet, son `this` est
// correctement lié par la sémantique JS normale — juste pas au COMPOSANT).
// `_mjsThis` (capturé en clôture à la construction, cf. this-rebinding.ts/
// transpiler/template.ts) désigne TOUJOURS le composant, quel que soit le
// site d'appel — le remplacement `µemit` → `_mjsThis._mjs_emit` (au lieu de
// `@_mjs_emit`) ferme ce trou partout à la fois, sans dépendre de `this`.
//
// `<script module>` n'a PAS de `_mjsThis` (code partagé, aucune
// instance de composant) — µemit y est désormais une ERREUR DE COMPILATION
// explicite (transpiler.rune-emit-dans-module), plutôt qu'un ReferenceError
// runtime silencieux.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('µemit détaché — _mjsThis._mjs_emit (jamais this._mjs_emit)', function () {
  this.timeout(30000)

  it('racine du <script> : sortie contient _mjsThis._mjs_emit', async () => {
    const src = `<script lang="coffee">\nµemit 'x'\n</script>\n<p>y</p>`
    const { output } = await transpile(src, { moduleName: 'emitdetacheda' })
    assert.match(output, /_mjsThis\._mjs_emit/)
  })

  it("dans une méthode (@go = -> µemit 'x') : sortie contient _mjsThis._mjs_emit", async () => {
    const src = `<script lang="coffee">\n@go = -> µemit 'x'\n</script>\n<p>y</p>`
    const { output } = await transpile(src, { moduleName: 'emitdetachedb' })
    assert.match(output, /_mjsThis\._mjs_emit/)
  })

  it("objet utilisateur (helper = { go: -> µemit 'x' }) : _mjsThis._mjs_emit, JAMAIS this._mjs_emit (AVANT le fix : this._mjs_emit — TypeError sur helper.go())", async () => {
    const src = `<script lang="coffee">\nhelper = { go: -> µemit 'x' }\n</script>\n<p>y</p>`
    const { output } = await transpile(src, { moduleName: 'emitdetachedc' })
    assert.match(output, /_mjsThis\._mjs_emit/)
    assert.doesNotMatch(output, /this\._mjs_emit/)
  })

  it("handler inline (@click={µemit 'x'}) : sortie contient _mjsThis._mjs_emit", async () => {
    const src = `<button @click={µemit 'x'}>y</button>`
    const { output } = await transpile(src, { moduleName: 'emitdetachedd' })
    assert.match(output, /_mjsThis\._mjs_emit/)
  })

  it('<script module> contenant µemit : transpile() REJETTE (aucune instance de composant dans le module)', async () => {
    const src = `<script module>\nµemit 'x'\n</script>\n<p>y</p>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'emitdetachede' }),
      /µemit[\s\S]*<script module>/,
    )
  })
})
