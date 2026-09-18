// Tests unitaires de rebindDetachedThis (this-rebinding.ts) — correctif auto
// `this` → `_mjsThis` dans le corps d'une flèche fine top-level NUE (cf.
// docs/18-pieges.md §11, retirée). Assertions de FORME (le JS déjà
// compilé, en entrée/sortie) — la preuve par EXÉCUTION réelle vit dans
// thin-arrow-this-autofix.test.ts (compilation + montage + clic réels).

import assert from 'node:assert/strict'
import { rebindDetachedThis } from '../src/generator/this-rebinding.js'

describe('rebindDetachedThis', () => {

  it('flèche fine assignée à un nom nu (`let save = function(){...}`) : this → (this ?? _mjsThis)', () => {
    const out = rebindDetachedThis(`let save = function() { return this._mjs_getRCtx('theme').valeur = 'x' }`)
    assert.match(out, /let save = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx\('theme'\)\.valeur = 'x' \}/)
  })

  it('même chose avec `@x` déjà lowered (this.x simple)', () => {
    const out = rebindDetachedThis(`let incrementer = function() { return this.compteur = this.compteur + 1 }`)
    assert.match(out, /\(this \?\? _mjsThis\)\.compteur = \(this \?\? _mjsThis\)\.compteur \+ 1/)
    assert.doesNotMatch(out, /this\.compteur/, 'aucun this.compteur NU (non enveloppé) ne doit subsister')
  })

  it('vraie méthode d\'instance (`this.nom = function(){...}`, forme compilée de `@nom = -> ...`) : INCHANGÉ', () => {
    const src = `this.save = function() { return this._mjs_getRCtx('theme').valeur = 'x' }`
    const out = rebindDetachedThis(src)
    assert.equal(out, src, 'aucune réécriture : this.save = ... est une vraie méthode, this dynamique correct')
  })

  it('méthode posée sur un objet QUELCONQUE (`o.draw = function(){...}`, pas this) : INCHANGÉ — objet.méthode() lie this à objet, quel que soit cet objet (régression réelle : brand-check this natif, cf. proxy-native-object-not-wrapped.test.ts)', () => {
    const src = `o.draw = function() { if (this !== o) throw new TypeError('mauvais receveur'); return 'drawn' }`
    const out = rebindDetachedThis(src)
    assert.equal(out, src, 'aucune réécriture : draw sera appelée en o.draw(), this === o naturellement')
  })

  it('flèche épaisse (ArrowFunctionExpression) top-level : INCHANGÉ', () => {
    const src = `let save = () => this._mjs_getRCtx('theme').valeur = 'x'`
    const out = rebindDetachedThis(src)
    assert.equal(out, src, 'une => capture déjà correctement this à la définition — jamais réécrite')
  })

  it('this au TOP-LEVEL (hors de toute fonction) : INCHANGÉ', () => {
    const src = `this._mjs_setRCtx('theme', {valeur: 'x'})`
    const out = rebindDetachedThis(src)
    assert.equal(out, src, 'top-level : this = composant via (function($){...}).call(this,$), toujours sûr')
  })

  it('flèche fine imbriquée DANS une flèche fine (fine-in-fine) : this réécrit dans les DEUX corps si concerné', () => {
    const out = rebindDetachedThis(
      `let outer = function() {\n  let inner = function() { return this._mjs_getRCtx('theme').valeur = 'x' }\n  return inner()\n}`
    )
    assert.match(out, /let inner = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
  })

  it('flèche fine imbriquée DANS une flèche épaisse (fine-in-thick) : la fine imbriquée reste réécrite', () => {
    const out = rebindDetachedThis(
      `let outer = () => {\n  let inner = function() { return this._mjs_getRCtx('theme').valeur = 'x' }\n  return inner()\n}`
    )
    assert.match(out, /let inner = function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
  })

  it('flèche épaisse imbriquée DANS une flèche fine (thick-in-fine) : réécrite (hérite du this dynamique de la fine englobante)', () => {
    const out = rebindDetachedThis(
      `let outer = function() {\n  let inner = () => this._mjs_getRCtx('theme').valeur = 'x'\n  return inner()\n}`
    )
    assert.match(out, /let inner = \(\) => \(this \?\? _mjsThis\)\._mjs_getRCtx/)
  })

  it('méthode de CLASSE utilisateur (MethodDefinition) : INCHANGÉ — this désigne l\'instance de la classe, pas le composant', () => {
    const src = `class Box {\n  constructor(w) {\n    this.width = w;\n  }\n}`
    const out = rebindDetachedThis(src)
    assert.equal(out, src, 'this dans un constructeur/méthode de classe reste this : objet ≠ composant')
  })

  it('méthode d\'objet littéral (shorthand) : INCHANGÉ', () => {
    const src = `const obj = { greet() { return this.name } }`
    const out = rebindDetachedThis(src)
    assert.equal(out, src)
  })

  it('propriété-fonction EXPLICITE d\'objet littéral (`{ greet: function(){...} }`, pas le raccourci) : INCHANGÉ aussi — même sémantique this que le shorthand', () => {
    const src = `const obj = { greet: function() { return this.name } }`
    const out = rebindDetachedThis(src)
    assert.equal(out, src)
  })

  it('callback anonyme passé en argument (ex. µ.effect direct) : réécrit — mais sans effet comportemental (le runtime invoque déjà via .call(this,...))', () => {
    const out = rebindDetachedThis(`µ.effect(function() { return this._mjs_getRCtx('theme').valeur })`)
    assert.match(out, /µ\.effect\(function\(\) \{ return \(this \?\? _mjsThis\)\._mjs_getRCtx/)
  })

  it('rien à faire (pas de `this` du tout) : retourne le JS INCHANGÉ (référence identique acceptable, valeur égale)', () => {
    const src = `let x = 1 + 2`
    const out = rebindDetachedThis(src)
    assert.equal(out, src)
  })

  it('JS non parsable : retourne tel quel (ne throw jamais)', () => {
    const src = `this. = ) ( invalide`
    assert.doesNotThrow(() => rebindDetachedThis(src))
  })
})
