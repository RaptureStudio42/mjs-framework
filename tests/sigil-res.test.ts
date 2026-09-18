import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { applyMjsSugarToScript } from '../src/transpiler/index.ts'

// sucre µres → µ.res : sac de props serveur (protocole de navigation
// JSON, docs/21-navigation.md). Même allowlist EXACTE que µurl/µnav/µserver
// (sigils.ts, MU_SHORT_GLOBALS) — aucune nuance de plus, cf. mu-short-globals.test.ts.
describe('sucre µres — sac de props serveur', function () {
  describe('lexer (scripts)', function () {
    it('µres → µ.res', () => assert.equal(tokenize('µres'), 'µ.res'))
    it('champs profonds : µres.user → µ.res.user', () =>
      assert.equal(tokenize('µres.user'), 'µ.res.user'))
    it('idempotent sur la forme pointée', () => assert.equal(tokenize('µ.res.user'), 'µ.res.user'))
    it('identifiant plus long intact (µresult)', () => assert.equal(tokenize('µresult'), 'µresult'))
    it('identifiant plus long intact (µresume)', () => assert.equal(tokenize('µresume'), 'µresume'))
    it('identifiant plus long intact (µresFoo)', () => assert.equal(tokenize('µresFoo'), 'µresFoo'))
    it('µurl reste intact malgré µres (allowlists disjointes, même liste)', () =>
      assert.equal(tokenize('µres.user is µurl.path'), 'µ.res.user is µ.url.path'))
  })

  describe('cleanJs (interpolations/handlers)', function () {
    it('µres.user → µ.res.user', () => assert.equal(cleanJs('µres.user'), 'µ.res.user'))
    it('{µres.user} — usage cible en interpolation de texte', () =>
      assert.equal(cleanJs('µres.user.name'), 'µ.res.user.name'))
    it('idempotent sur la forme pointée', () => assert.equal(cleanJs('µ.res.user'), 'µ.res.user'))
    // ancien témoin (µresult/µresume/µresFoo restaient LITTÉRAUX) : cleanJs n'avait
    // alors NI filet générique pour une rune minuscule hors liste blanche — absence
    // de sucre, pas une garde de longueur voulue. cleanJs porte désormais le MÊME
    // sucre universel µfoo → µ.foo que le script (sigils.ts, MU_UNIVERSAL_BODY,
    // audit des runes manquantes en expression HTML) : ces trois identifiants sont
    // pointés eux aussi, exactement comme le script les pointe déjà (vérifié via
    // transpile() sur un vrai <script> — cf. describe 'sucre universel — pipeline
    // complet' plus bas, même comportement délibérément greedy).
    it('identifiant plus long, ALIGNÉ sur le script (µresult → µ.result)', () => assert.equal(cleanJs('µresult'), 'µ.result'))
    it('identifiant plus long, ALIGNÉ sur le script (µresume → µ.resume)', () => assert.equal(cleanJs('µresume'), 'µ.resume'))
    it('identifiant plus long, ALIGNÉ sur le script (µresFoo → µ.resFoo)', () => assert.equal(cleanJs('µresFoo'), 'µ.resFoo'))
    it('µres.errors (usage cible : {if µres.errors}{µres.errors.email}{end})', () =>
      assert.equal(cleanJs('µres.errors.email'), 'µ.res.errors.email'))
  })

  // le sucre universel µfoo → µ.foo (applyMjsSugarToScript) tourne AVANT le
  // lexer : µres n'est PAS une rune à compilation lexer dédiée (contrairement
  // à µread/µmount/µlang) — elle doit rester routée normalement par les DEUX
  // passes, comme µurl/µnav (cf. mu-short-globals.test.ts). NB : la protection
  // « identifiant plus long intact » (µresult, describe 'lexer (scripts)'
  // ci-dessus) est fournie par le LEXER lui-même (MU_SHORT_BODY, lookahead) EN
  // ISOLATION (tokenize() appelé SEUL, sans le sucre universel en amont) — un
  // chemin qui n'existe PAS dans le vrai pipeline (applyMjsSugarToScript tourne
  // TOUJOURS avant tokenize, cf. transpiler/index.ts). Le sucre universel LUI-MÊME
  // reste délibérément greedy pour TOUTE l'allowlist MU_SHORT_GLOBALS (vérifié
  // empiriquement : µurlFoo/µserverFoo/µnavFoo/µresult/µresume → µ.urlFoo/
  // µ.serverFoo/µ.navFoo/µ.result/µ.resume par ce même sucre, dans le VRAI pipeline
  // — comportement PRÉEXISTANT, pas une régression de cette rune ; cleanJs suit
  // maintenant la même règle, cf. describe 'cleanJs' ci-dessus).
  describe('sucre universel — pipeline complet', function () {
    it('µres non pointé, pipeline complet (sucre puis lexer)', () => {
      assert.equal(tokenize(applyMjsSugarToScript('µres.user')), 'µ.res.user')
    })
  })
})
