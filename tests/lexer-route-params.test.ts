import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'

// Sigil `&id` → `µ.url.params.id` : param de route en lecture réactive, sans
// injection d'attribut DOM (donc SANS collision avec un attribut natif `id`).
// Désambiguïsation robuste vs ET-binaire `&` / `&&` et entités HTML `&amp;`.
describe('lexer — &id → µ.url.params.id (param de route)', function () {
  const t = (s: string) => tokenize(s)

  describe('formes PARAM (converties)', function () {
    it('en début de flux', () => assert.equal(t('&id'), 'µ.url.params.id'))
    it('dans une interpolation', () => assert.equal(t('{&id}'), '{µ.url.params.id}'))
    it('après un =', () => assert.equal(t('x = &id'), 'x = µ.url.params.id'))
    it('après une (', () => assert.equal(t('f(&id)'), 'f(µ.url.params.id)'))
    it('après un mot-clé + espace', () => assert.equal(t('return &id'), 'return µ.url.params.id'))
    it('dans un tableau', () => assert.equal(t('[&a, &b]'), '[µ.url.params.a, µ.url.params.b]'))
    it('identifiant avec _ et chiffres', () => assert.equal(t('&slug_2'), 'µ.url.params.slug_2'))
    it('après une virgule', () => assert.equal(t('fn(x, &id)'), 'fn(x, µ.url.params.id)'))
    it('après un ternaire ?', () => assert.equal(t('ok ? &id : 0'), 'ok ? µ.url.params.id : 0'))
  })

  describe('ET-binaire / logique (INCHANGÉS)', function () {
    it('a & b (espaces)', () => assert.equal(t('a & b'), 'a & b'))
    it('a&b (lettres collées)', () => assert.equal(t('a&b'), 'a&b'))
    it('a&&b (ET logique)', () => assert.equal(t('a&&b'), 'a&&b'))
    it('a && b', () => assert.equal(t('a && b'), 'a && b'))
    it('flags & MASK', () => assert.equal(t('flags & MASK'), 'flags & MASK'))
    it('count&2 (chiffre après)', () => assert.equal(t('count&2'), 'count&2'))
    it('x&id (opérande avant)', () => assert.equal(t('x&id'), 'x&id'))
    it(') avant → opérande', () => assert.equal(t('f()&id'), 'f()&id'))
  })

  describe('entités HTML (INCHANGÉES)', function () {
    it('&amp;', () => assert.equal(t('&amp;'), '&amp;'))
    it('&lt; après espace', () => assert.equal(t('p &lt; q'), 'p &lt; q'))
    it('&#123; (entité numérique)', () => assert.equal(t('&#123;'), '&#123;'))
  })

  describe('cas limites', function () {
    it("member-access obj.&id → laissé (pas un param)", () => assert.equal(t('obj.&id'), 'obj.&id'))
    it('&$x reste une erreur explicite (vault retiré)', function () {
      assert.throws(() => t('&$foo'), /vault.*retiré|&\$/)
    })
  })

  // Le chemin GÉNÉRATEUR (cleanJs) traite les interpolations de template
  // `{&id}` — il DOIT appliquer la même conversion/désambiguïsation que le
  // lexer, sinon `{&id}` sort littéral (bug historique corrigé).
  describe('générateur — cleanJs applique la même règle', function () {
    it('convertit le param', () => assert.equal(cleanJs('&id'), 'µ.url.params.id'))
    it('dans une expression', () => assert.equal(cleanJs('&id + 1'), 'µ.url.params.id + 1'))
    it('préserve le ET-binaire', () => assert.equal(cleanJs('a & b'), 'a & b'))
    it('préserve le ET logique', () => assert.equal(cleanJs('a&&b'), 'a&&b'))
    it('préserve les entités', () => assert.equal(cleanJs('&amp;'), '&amp;'))
    it('laisse le member-access', () => assert.equal(cleanJs('obj.&id'), 'obj.&id'))
  })
})
