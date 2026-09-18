import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { applyMjsSugarToScript } from '../src/transpiler/index.ts'

// Formes courtes des globales réactives du framework : `µurl` → `µ.url`
// (+ µonline/µvisible/µready). Allowlist stricte, DEUX passes comme tout
// sigil (lexer pour les scripts, cleanJs pour les interpolations {…}) —
// cf. le précédent `&id` (lexer-route-params).
describe('sucre µurl & co — globales framework en forme courte', function () {
  describe('lexer (scripts)', function () {
    it('µurl → µ.url', () => assert.equal(tokenize('µurl.path'), 'µ.url.path'))
    it('champs profonds', () => assert.equal(tokenize('µurl.params.id'), 'µ.url.params.id'))
    it('env : µonline/µvisible/µready', () =>
      assert.equal(tokenize('µonline && µvisible && µready'), 'µ.online && µ.visible && µ.ready'))
    it('µserver → µ.server (contexte SSR/client, valeur simple — même sucre que le trio online/visible/ready)', () =>
      assert.equal(tokenize('µserver'), 'µ.server'))
    it('identifiant plus long intact (µserverFoo)', () => assert.equal(tokenize('µserverFoo'), 'µserverFoo'))
    it('idempotent sur la forme pointée', () => assert.equal(tokenize('µ.url.path'), 'µ.url.path'))
    it('identifiant plus long intact (µurlFoo)', () => assert.equal(tokenize('µurlFoo'), 'µurlFoo'))
    it('runes minuscules intactes (µeffect, µeasing)', () =>
      assert.equal(tokenize('µeffect -> µeasing.linear'), 'µeffect -> µeasing.linear'))
    it('temps réel : µsocket → µ.socket (fabrique appelée)', () =>
      assert.equal(tokenize('µsocket "wss://jeu/play"'), 'µ.socket "wss://jeu/play"'))
    it('temps réel : µsmooth → µ.smooth', () =>
      assert.equal(tokenize('µsmooth brut, { retard: 100 }'), 'µ.smooth brut, { retard: 100 }'))
    it('identifiant plus long intact (µsocketFoo)', () =>
      assert.equal(tokenize('µsocketFoo'), 'µsocketFoo'))
    it('navigation ujs : µnav → µ.nav (état réactif {active, href}, mjs_store_globals.ts)', () =>
      assert.equal(tokenize('µnav.active'), 'µ.nav.active'))
    it('identifiant plus long intact (µnavFoo)', () =>
      assert.equal(tokenize('µnavFoo'), 'µnavFoo'))
  })

  describe('cleanJs (interpolations/handlers)', function () {
    it('µurl → µ.url', () => assert.equal(cleanJs('µurl.path'), 'µ.url.path'))
    it('µserver → µ.server (usage cible : {if not µserver}…{end} — cleanJs normalise aussi "not" → "!", grammaire Coffee/Civet)', () =>
      assert.equal(cleanJs('not µserver'), '!µ.server'))
    // ALIGNÉ sur le script (règle universelle, cf. ligne 101 plus bas :
    // « PAS d'exclusion » pour un identifiant qui PROLONGE un nom court) — cleanJs
    // porte désormais le même sucre universel µfoo → µ.foo (sigils.ts,
    // MU_UNIVERSAL_BODY, audit des runes manquantes en expression HTML).
    it('identifiant plus long, ALIGNÉ sur le script (µserverFoo → µ.serverFoo)', () => assert.equal(cleanJs('µserverFoo'), 'µ.serverFoo'))
    it('µRouter → µ.Router (PascalCase, symétrie lexer §3.8b)', () =>
      assert.equal(cleanJs("µRouter.to('/x')"), "µ.Router.to('/x')"))
    it('idempotent sur les formes pointées', () =>
      assert.equal(cleanJs('µ.url.path + µ.Router.name'), 'µ.url.path + µ.Router.name'))
    // ALIGNÉ sur le script — même détail que µserverFoo ci-dessus.
    it('identifiant plus long, ALIGNÉ sur le script (µurlFoo → µ.urlFoo)', () => assert.equal(cleanJs('µurlFoo'), 'µ.urlFoo'))
    // ALIGNÉ sur le script (`µeasing` n'est ni MU_SHORT_GLOBALS ni MU_SCRIPT_RUNES —
    // le sucre universel le pointe comme n'importe quel nom inconnu ; `µ.easing`
    // EXISTE au runtime, mjs_easing.ts, l'appel reste donc fonctionnel).
    it('µeasing → µ.easing (règle universelle, comme le script)', () =>
      assert.equal(cleanJs('µeasing.linear'), 'µ.easing.linear'))
    it('temps réel : µsocket → µ.socket', () =>
      assert.equal(cleanJs('µsocket(url).state'), 'µ.socket(url).state'))
    it('temps réel : µsmooth → µ.smooth', () =>
      assert.equal(cleanJs('µsmooth(brut)'), 'µ.smooth(brut)'))
    it('navigation ujs : µnav → µ.nav (usage cible : {if µnav.active}…{end})', () =>
      assert.equal(cleanJs('µnav.active'), 'µ.nav.active'))
    // ALIGNÉ sur le script — même détail que µserverFoo ci-dessus.
    it('identifiant plus long, ALIGNÉ sur le script (µnavFoo → µ.navFoo)', () => assert.equal(cleanJs('µnavFoo'), 'µ.navFoo'))
    it('µread $x → _mjsThis._state.x (parité lexer §3.5b, non réactif)', () =>
      assert.equal(cleanJs('µread $cache'), '_mjsThis._state.cache'))
    it('µwrite $x, v → _mjsThis._state.x = v (écrit sans notify)', () =>
      assert.equal(cleanJs('µwrite $cache, 5'), '_mjsThis._state.cache = 5'))
    it('ancienne forme `µwrite $x = v` (RETIRÉE) : ERREUR DE COMPILATION dédiée', () =>
      assert.throws(() => cleanJs('µwrite $cache = 5'), /µwrite écrit un symbole d'état avec une virgule/))
    it('µread laisse le $x réactif voisin intact', () =>
      assert.equal(cleanJs('$total + µread $cache'), '$.total + _mjsThis._state.cache'))

    it('µread $_secret (underscore en tête) : reconnu, plus laissé littéral', () =>
      assert.equal(cleanJs('µread $_secret'), '_mjsThis._state._secret',
        "AVANT la source unique sigils.ts : 'µread $._secret' — µread jamais consommé, ReferenceError au runtime"))
    it('µwrite $_secret, 5 (underscore en tête) : reconnu', () =>
      assert.equal(cleanJs('µwrite $_secret, 5'), '_mjsThis._state._secret = 5'))

    it('µmount dans une interpolation : ERREUR claire (hooks = <script> seulement)', () =>
      assert.throws(() => cleanJs('µmount -> x'), /µmount[\s\S]*<script>/))

    it('µurl reste intact malgré la rune µurlChange (allowlists disjointes)', () =>
      assert.equal(cleanJs('µurl.path'), 'µ.url.path'))
  })

  // le sucre universel µfoo → µ.foo (applyMjsSugarToScript) tourne AVANT le
  // lexer : il doit laisser INTACTES les runes à compilation lexer, sinon
  // elles deviennent `µ.read`/`µ.mount` (invisibles au lexer, indéfinies au
  // runtime). Régression pipeline découverte à la migration des hooks : seuls
  // les tests unitaires du lexer (hors pipeline) passaient.
  describe('sucre universel — les runes lexer survivent au routage µfoo → µ.foo', function () {
    it('µread/µwrite non pointés (pipeline complet : sucre puis lexer)', () => {
      assert.equal(tokenize(applyMjsSugarToScript('µread $cache')), '_mjsThis._state.cache')
      assert.equal(tokenize(applyMjsSugarToScript('µwrite $cache, 5')), '_mjsThis._state.cache = 5')
    })

    it('µmount non pointé (pipeline complet → _mjs_hook)', () => {
      assert.equal(tokenize(applyMjsSugarToScript('µmount ->')), "this._mjs_hook 'mount', ->")
    })

    it('µurlChange non pointé, µurl toujours routé (µ.url)', () => {
      assert.equal(applyMjsSugarToScript('µurlChange (p, a) ->'), 'µurlChange (p, a) ->')
      assert.equal(applyMjsSugarToScript('µurl.path'), 'µ.url.path')
    })

    it('les autres runes minuscules restent routées (µraw → µ.raw, µeffect → µ.effect)', () => {
      assert.equal(applyMjsSugarToScript('µraw([1])'), 'µ.raw([1])')
      assert.equal(applyMjsSugarToScript('µeffect ->'), 'µ.effect ->')
    })

    it('identifiant plus long : PAS d\'exclusion (µreadFoo → µ.readFoo, règle universelle)', () => {
      assert.equal(applyMjsSugarToScript('µreadFoo'), 'µ.readFoo')
    })
  })
})
