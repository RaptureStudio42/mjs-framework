// Tests unitaires du lexer — port des tests Coffee correspondants.

import assert from 'node:assert/strict'
import { tokenize } from '../src/lexer/index.js'

describe('lexer.tokenize', () => {

  describe('$xxx → $.xxx', () => {
    it('simple var', () => {
      assert.equal(tokenize('$count'), '$.count')
    })

    it('multiple vars', () => {
      assert.equal(tokenize('$a + $b'), '$.a + $.b')
    })

    it('preserves chained dot', () => {
      assert.equal(tokenize('$user.name'), '$.user.name')
    })

    it('preserves _ in var name', () => {
      assert.equal(tokenize('$counter_max'), '$.counter_max')
    })

    it('literal in string preserved', () => {
      assert.equal(tokenize("'$count'"), "'$count'")
    })

    it('literal in template string preserved', () => {
      assert.equal(tokenize('"$count"'), '"$count"')
    })

    it('literal in heredoc preserved', () => {
      assert.equal(tokenize('"""$count"""'), '"""$count"""')
    })
  })

  describe('µread $x / µwrite $x, v → _mjsThis._state.x (accès NON réactif)', () => {
    it('µread lit le slot brut, sans poser de dépendance', () => {
      assert.equal(tokenize('µread $count'), '_mjsThis._state.count')
    })

    it('µwrite écrit le slot brut — la valeur après la virgule suit telle quelle (sans notify)', () => {
      assert.equal(tokenize('µwrite $count, 5'), '_mjsThis._state.count = 5')
    })

    it('ancienne forme `µwrite $x = v` (RETIRÉE) : ERREUR DE COMPILATION dédiée', () => {
      assert.throws(() => tokenize('µwrite $count = 5'), /µwrite écrit un symbole d'état avec une virgule/)
    })

    it('accès profond : µread $obj.key', () => {
      assert.equal(tokenize('µread $obj.key'), '_mjsThis._state.obj.key')
    })

    it('coexiste avec un $x réactif — seul µread échappe au suivi', () => {
      assert.equal(tokenize('$total + µread $cache'), '$.total + _mjsThis._state.cache')
    })

    it('littéral dans une chaîne préservé (pas de transfo)', () => {
      assert.equal(tokenize("'µread $x'"), "'µread $x'")
    })

    // Régression — le 1er caractère
    // après `$` était restreint à `[a-zA-Z]` : `µread $_secret` (underscore
    // juste après le sigil) ne matchait PAS cette règle — `µread`/`µwrite`
    // restaient des identifiants LITTÉRAUX non définis dans le JS généré
    // (ReferenceError à l'exécution).
    it('µread $_secret (underscore juste après $) : reconnu, plus laissé littéral', () => {
      assert.equal(tokenize('µread $_secret'), '_mjsThis._state._secret',
        "AVANT le fix : 'µread $._secret' — µread jamais consommé, ReferenceError à l'exécution")
    })

    it('µwrite $_secret, 5 (underscore juste après $) : reconnu', () => {
      assert.equal(tokenize('µwrite $_secret, 5'), '_mjsThis._state._secret = 5')
    })

    it('$__x n\'est PLUS un sigil brut (retiré) → règle $x standard', () => {
      assert.equal(tokenize('$__x'), '$.__x')
    })
  })

  describe('hooks de cycle de vie en runes µ (µmount & co → _mjs_hook)', () => {
    it('µmount -> : enregistre via l\'API interne unique', () => {
      assert.equal(tokenize('µmount ->'), "this._mjs_hook 'mount', ->")
    })

    it('µurlChange (path, params) -> : hook à arguments (et µurlChange ⊄ µurl)', () => {
      assert.equal(tokenize('µurlChange (path, params) ->'), "this._mjs_hook 'urlChange', (path, params) ->")
    })

    it('µfailed (err, reset) -> : error boundary script', () => {
      assert.equal(tokenize('µfailed (err, reset) ->'), "this._mjs_hook 'failed', (err, reset) ->")
    })

    it('identifiant plus long intact (µmountFoo)', () => {
      assert.equal(tokenize('µmountFoo'), 'µmountFoo')
    })

    it('ancienne forme @mount -> : ERREUR de compilation explicite', () => {
      assert.throws(() => tokenize('@mount ->'), /forme @ des hooks est retirée[\s\S]*µmount/)
    })

    it('@urlChange (path) -> : ERREUR aussi (silhouette hook à arguments)', () => {
      assert.throws(() => tokenize('@urlChange (path) ->'), /µurlChange/)
    })

    it('@mount = -> : nom LIBÉRÉ — méthode utilisateur normale', () => {
      assert.equal(tokenize('@mount = -> 1'), 'this.mount = -> 1')
    })

    it('@mount(x) : appel parenthésé normal, pas bloqué', () => {
      assert.equal(tokenize('@mount(x)'), 'this.mount(x)')
    })
  })

  describe('µderived $var = expr, $a, $b — dérivé à DÉPENDANCES FORCÉES', () => {
    it('une dépendance forcée : réduit à $.var = µ._mjs_forceDeps(expr, $a)', () => {
      assert.equal(tokenize('µderived $c = calc(), $a'), '$.c = µ._mjs_forceDeps(calc(), $.a)')
    })

    it('plusieurs dépendances forcées', () => {
      assert.equal(tokenize('µderived $c = calc(), $a, $b'), '$.c = µ._mjs_forceDeps(calc(), $.a, $.b)')
    })

    it('zéro dépendance forcée (pas de virgule) : juste le marqueur autour de expr', () => {
      assert.equal(tokenize('µderived $x = $a + 1'), '$.x = µ._mjs_forceDeps($.a + 1)')
    })

    it('identifiant plus long intact (µderivedFoo)', () => {
      assert.equal(tokenize('µderivedFoo'), 'µderivedFoo')
    })

    it('dépendance forcée invalide (pas un symbole $ nu) : ERREUR de compilation explicite', () => {
      assert.throws(() => tokenize('µderived $c = calc(), notADollar'), /dépendance forcée.*symbole \$ nu/)
    })

    it('expression vide avant la liste de deps : ERREUR de compilation explicite', () => {
      assert.throws(() => tokenize('µderived $x = , $a'), /expression manquante/)
    })
  })

  describe('$xxx =: expr (snapshot — désactive la dérivation)', () => {
    it('wraps with µ.snap', () => {
      assert.equal(
        tokenize('$activeTab =: $tabs[0]'),
        '$.activeTab = µ.snap $.tabs[0]'
      )
    })
  })

  describe('@xxx → this.xxx', () => {
    it('simple', () => {
      assert.equal(tokenize('@count'), 'this.count')
    })

    it('method call', () => {
      assert.equal(
        tokenize('@onClick = -> @count++'),
        'this.onClick = -> this.count++'
      )
    })
  })

  describe('@@xxx → _mjsThis.xxx', () => {
    it('simple', () => {
      assert.equal(tokenize('@@parent'), '_mjsThis.parent')
    })
  })

  describe('§xxx contextes', () => {
    it('getContext', () => {
      assert.equal(tokenize('§theme'), "this._mjs_getContext('theme')")
    })

    it('setContext', () => {
      assert.equal(
        tokenize('§theme = "dark"'),
        `this._mjs_setContext('theme', "dark")`
      )
    })
  })

  describe('$$xxx → µ.store.xxx (STORE GLOBAL réactif, zéro import)', () => {
    it('simple', () => {
      assert.equal(tokenize('$$users'), 'µ.store.users')
    })
    it('reste global en moduleMode', () => {
      assert.equal(tokenize('$$users', { moduleMode: true }), 'µ.store.users')
    })
    it('sur un singleton importé (`$X` ∈ externalVars) → ERREUR (se lit en µ$$X)', () => {
      assert.throws(() => tokenize('$$users', { externalVars: ['$users'] }), /µ\$\$users/)
    })
  })

  describe('§§xxx → TOUJOURS contexte réactif de sous-arbre (plus de résolution vers un singleton)', () => {
    it('même si le nom est ∈ externalVars (singleton importé ailleurs) → reste _mjs_getRCtx', () => {
      assert.equal(tokenize('§§count', { externalVars: ['$count'] }), "this._mjs_getRCtx('count')")
    })
    it('accès profond : §§count.value → _mjs_getRCtx(...).value (jamais résolu en singleton)', () => {
      assert.equal(tokenize('§§count.value', { externalVars: ['$count'] }), "this._mjs_getRCtx('count').value")
    })
    it('sans externalVars (cas courant) → contexte réactif _mjs_getRCtx', () => {
      assert.equal(tokenize('§§config'), "this._mjs_getRCtx('config')")
    })
    it('déclaration → contexte réactif _mjs_setRCtx', () => {
      assert.equal(tokenize("§§theme = 'dark'"), "this._mjs_setRCtx('theme', 'dark')")
    })
  })

  describe('externalVars', () => {
    it('preserves listed vars (forme compilée du singleton importé)', () => {
      const result = tokenize('$counter + $local', { externalVars: ['$counter'] })
      assert.equal(result, '$counter + $.local')
    })
  })

  describe('moduleMode', () => {
    it('preserves all $vars', () => {
      const result = tokenize('$min = $data * 2', { moduleMode: true })
      assert.equal(result, '$min = $data * 2')
    })
  })

  describe('no false positives', () => {
    it('does not touch foo.bar', () => {
      assert.equal(tokenize('foo.bar'), 'foo.bar')
    })
  })

  // ==========================================================================
  // Cas limites supplémentaires du lexer.
  // ==========================================================================
  describe('cas limites supplémentaires du lexer', () => {
    it('§/§§ dans le TEXTE d\'une chaîne : préservés (plus de corruption silencieuse)', () => {
      assert.equal(tokenize('x = "voir §theme et §§lang"'), 'x = "voir §theme et §§lang"')
    })

    it('setter § : un `;` DANS une chaîne du RHS ne coupe plus la capture', () => {
      assert.equal(tokenize('§msg = "Erreur; réessayez"'), 'this._mjs_setContext(\'msg\', "Erreur; réessayez")')
    })

    it('le § de CODE (hors chaîne) et celui d\'une interpolation #{…} restent tokenisés', () => {
      assert.equal(tokenize('x = §theme'), "x = this._mjs_getContext('theme')")
      assert.equal(tokenize('"#{§theme}"'), '"#{this._mjs_getContext(\'theme\')}"')
    })

    it('interpolation : un `}` littéral en chaîne ne ferme plus l\'interpolation trop tôt', () => {
      assert.equal(tokenize('x = "a #{ fn(\'}\') + $y } b"'), 'x = "a #{ fn(\'}\') + $.y } b"')
    })

    it('`&id;` en script : converti en param de route (le `;` n\'est PAS une entité)', () => {
      assert.equal(tokenize('const a = &id;'), 'const a = µ.url.params.id;')
      assert.equal(tokenize('x = a &amp; b'), 'x = a &amp; b')   // vraie entité nommée : intacte
    })

    it('sigil à chiffre en tête reste littéral (pas d\'accès membre illégal `µ.store.9lives`)', () => {
      assert.equal(tokenize('x = $$9lives'), 'x = $$9lives')
    })
  })
})
