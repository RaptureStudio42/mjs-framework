import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { applyMjsSugarToScript } from '../src/transpiler/index.ts'

// Sucre µmodal → µ.modal : même allowlist EXACTE que µurl/µnav/µres/µt (sigils.ts,
// MU_SHORT_GLOBALS) — aucune nuance de plus, cf. mu-short-globals.test.ts. µmodal.success(…)
// compile en µ.modal.success(…) dans les DEUX moteurs (lexer pour les scripts, cleanJs pour les
// interpolations/handlers).
describe('sucre µmodal — namespace modal en forme courte', function () {
  describe('lexer (scripts)', function () {
    it('µmodal → µ.modal', () => assert.equal(tokenize('µmodal'), 'µ.modal'))
    it("appel de méthode : µmodal.success('x') → µ.modal.success('x')", () =>
      assert.equal(tokenize("µmodal.success('x')"), "µ.modal.success('x')"))
    it('idempotent sur la forme pointée', () => assert.equal(tokenize('µ.modal.success'), 'µ.modal.success'))
    it('identifiant plus long intact (µmodalFoo)', () => assert.equal(tokenize('µmodalFoo'), 'µmodalFoo'))
    it('µurl reste intact malgré µmodal (allowlists disjointes, même liste)', () =>
      assert.equal(tokenize('µmodal.success is µurl.path'), 'µ.modal.success is µ.url.path'))
  })

  describe('cleanJs (interpolations/handlers)', function () {
    it("µmodal.success('x') → µ.modal.success('x')", () =>
      assert.equal(cleanJs("µmodal.success('x')"), "µ.modal.success('x')"))
    it('idempotent sur la forme pointée', () => assert.equal(cleanJs('µ.modal.wait'), 'µ.modal.wait'))
    // ALIGNÉ sur le script (comportement PRÉEXISTANT, vérifié via transpile() :
    // `a = µmodalFoo` compile déjà en `a = µ.modalFoo`) — cleanJs porte désormais le
    // même sucre universel µfoo → µ.foo (sigils.ts, MU_UNIVERSAL_BODY, audit des runes
    // manquantes en expression HTML) ; même détail que tests/sigil-res.test.ts
    // (µresult/µresume/µresFoo).
    it('identifiant plus long, ALIGNÉ sur le script (µmodalFoo → µ.modalFoo)', () => assert.equal(cleanJs('µmodalFoo'), 'µ.modalFoo'))
  })

  // le sucre universel µfoo → µ.foo (applyMjsSugarToScript) tourne AVANT le lexer : µmodal n'est
  // PAS une rune à compilation lexer dédiée (contrairement à µread/µmount/µlang) — elle doit
  // rester routée normalement par les DEUX passes, comme µurl/µnav (cf. mu-short-globals.test.ts).
  describe('sucre universel — pipeline complet', function () {
    it("µmodal.success('x') non pointé, pipeline complet (sucre puis lexer)", () => {
      assert.equal(tokenize(applyMjsSugarToScript("µmodal.success('x')")), "µ.modal.success('x')")
    })
  })
})

// Sucre µsound → µ.sound : même allowlist MU_SHORT_GLOBALS que µmodal ci-dessus (sigils.ts)
// — appel PUBLIC de la couche sonore (µ.sound(type, override), mjs_modal.ts). Forme appelée avec
// parenthèses ET forme Civet sans parenthèses (appel PAR ESPACE) compilent TOUTES LES DEUX en
// µ.sound(…), sur les DEUX moteurs — même sucre trivial que µmodal, aucune nuance de plus.
describe('sucre µsound — signature sonore en forme courte', function () {
  describe('lexer (scripts)', function () {
    it("appel parenthésé : µsound('success') → µ.sound('success')", () =>
      assert.equal(tokenize("µsound('success')"), "µ.sound('success')"))
    it("appel Civet SANS parenthèses : µsound 'success' → µ.sound 'success'", () =>
      assert.equal(tokenize("µsound 'success'"), "µ.sound 'success'"))
    it('idempotent sur la forme pointée', () => assert.equal(tokenize("µ.sound('success')"), "µ.sound('success')"))
    it('identifiant plus long intact (µsoundFoo)', () => assert.equal(tokenize('µsoundFoo'), 'µsoundFoo'))
    it('µmodal reste intact malgré µsound (allowlists disjointes, même liste)', () =>
      assert.equal(tokenize("µsound('x') is µmodal.wait"), "µ.sound('x') is µ.modal.wait"))
  })

  describe('cleanJs (interpolations/handlers)', function () {
    it("appel parenthésé : µsound('success') → µ.sound('success')", () =>
      assert.equal(cleanJs("µsound('success')"), "µ.sound('success')"))
    it("appel Civet SANS parenthèses : µsound 'success' → µ.sound 'success'", () =>
      assert.equal(cleanJs("µsound 'success'"), "µ.sound 'success'"))
    it('idempotent sur la forme pointée', () => assert.equal(cleanJs('µ.sound()'), 'µ.sound()'))
    // ALIGNÉ sur le script — même détail que µmodalFoo ci-dessus.
    it('identifiant plus long, ALIGNÉ sur le script (µsoundFoo → µ.soundFoo)', () => assert.equal(cleanJs('µsoundFoo'), 'µ.soundFoo'))
  })

  describe('sucre universel — pipeline complet', function () {
    it("µsound('success') non pointé, pipeline complet (sucre puis lexer)", () => {
      assert.equal(tokenize(applyMjsSugarToScript("µsound('success')")), "µ.sound('success')")
    })
  })
})
