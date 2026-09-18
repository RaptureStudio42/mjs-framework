// Régression : un commentaire Coffee `#` INLINE (après du code) doit être
// converti en `//` comme un commentaire de début de ligne. Avant le fix, seul
// le `#` en début de ligne était converti ; un `#` inline survivait jusqu'à
// Civet, qui le compile en `this.length(...)` → JS valide mais FAUX, sans
// aucune erreur (ex. `$x = 'ds'  # note` → `'ds'(this.length(note))`).

import assert from 'node:assert/strict'
import { applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('applyMjsSugarToScript — commentaires # inline', () => {
  it('convertit un # inline après du code en //', () => {
    const out = applyMjsSugarToScript("$x = 'ds'   # type choisi", 'civet')
    assert.match(out, /\/\/ type choisi/)
    assert.doesNotMatch(out, /#\s*type/)
  })

  it('convertit aussi un # en début de ligne (comportement historique)', () => {
    const out = applyMjsSugarToScript('  # pleine ligne', 'civet')
    assert.match(out, /\/\/ pleine ligne/)
  })

  it('préserve un champ privé #identifier', () => {
    const out = applyMjsSugarToScript('this.#priv = 1', 'civet')
    assert.match(out, /#priv/)
  })

  it('ne touche pas un # dans une chaîne', () => {
    const out = applyMjsSugarToScript('s = "a # b"', 'civet')
    assert.match(out, /"a # b"/)
  })

  it("préserve l'interpolation de chaîne (Coffee #{x} → template ${x}), pas commentée", () => {
    const out = applyMjsSugarToScript('m = "salut #{x}"', 'civet')
    assert.match(out, /\$\{x\}/)              // interpolation convertie en template literal
    assert.doesNotMatch(out, /\/\/.*salut/)   // surtout PAS transformée en commentaire
  })

  it('convertit un ### ... ### inline en /* ... */', () => {
    const out = applyMjsSugarToScript('x = 1 ### bloc ### + 2', 'civet')
    assert.match(out, /\/\* bloc \*\//)
  })

  it("ne produit pas de this.length pour le cas qui plantait", () => {
    const out = applyMjsSugarToScript("$newType = 'ds'   # type choisi a la creation", 'civet')
    assert.doesNotMatch(out, /this\.length/)
    assert.doesNotMatch(out, /#\s*type/)
  })

  it('laisse le code Coffee intact (lang=coffee : # reste un commentaire natif)', () => {
    const out = applyMjsSugarToScript("$x = 1 # natif", 'coffee')
    assert.match(out, /# natif/)
  })
})
