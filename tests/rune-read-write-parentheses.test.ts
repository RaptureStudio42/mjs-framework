// `µread($x)` ≡ `µread $x` — parenthèses OPTIONNELLES : la forme normale est avec
// parenthèses, par cohérence Civet on peut les rendre optionnelles, les deux doivent build.
//
// Avant : la forme parenthésée n'était reconnue par AUCUN des deux moteurs de sucre
// et sortait LITTÉRALE (`µread($.i)`) — `µread` n'existe nulle part au runtime, donc
// ReferenceError au premier tick avec un build VERT.
//
// `µwrite` — grammaire À VIRGULE (harmonisation : une seule
// façon d'écrire) : `µwrite $x, v` / `µwrite($x, v)`, valeur en second argument.
// L'ancienne forme `µwrite $x = v` / `µwrite($x) = v` est désormais une ERREUR DE
// COMPILATION dédiée (`rawWriteAncienneFormeError`), testée à part plus bas. `µread` ne
// change pas : pas de valeur à passer, rien à harmoniser.
//
// Corps partagés (sigils.ts) : la parité lexer ↔ cleanJs est acquise par construction.

import { strict as assert } from 'node:assert'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { transpile } from '../src/transpiler/index.js'

describe('µread / µwrite — parenthèses optionnelles', function () {
  const formes: Array<[string, string]> = [
    ['µread $i',       '_mjsThis._state.i'],
    ['µread($i)',      '_mjsThis._state.i'],
    ['µread( $i )',    '_mjsThis._state.i'],
    ['µread ($i)',     '_mjsThis._state.i'],
    ['µwrite $i, 3',   '_mjsThis._state.i = 3'],
    ['µwrite($i, 3)',  '(_mjsThis._state.i = 3)'],
    ['µread $_secret', '_mjsThis._state._secret'],
    ['µread($_secret)', '_mjsThis._state._secret'],
    ['µread $$x',      'µ._mjs_storeRaw.x'],
    ['µread($$x)',     'µ._mjs_storeRaw.x'],
    ['µwrite $$x, 1',  'µ._mjs_storeRaw.x = 1'],
    ['µwrite($$x, 1)', '(µ._mjs_storeRaw.x = 1)'],
    // valeur avec ses PROPRES parenthèses (appel imbriqué) — le corps s'arrête à la
    // virgule, aucun comptage de profondeur : la fermante d'origine referme la
    // parenthèse ouvrante FRAÎCHE émise à la place de `µwrite(`.
    ['µwrite($total, calc(a, b))', '(_mjsThis._state.total = calc(a, b))'],
    ['µwrite($$total, calc(a, b))', '(µ._mjs_storeRaw.total = calc(a, b))']
  ]

  describe('lexer (scripts)', function () {
    for (const [source, attendu] of formes) {
      it(`${source} → ${attendu}`, () => assert.equal(tokenize(source), attendu))
    }
  })

  describe('cleanJs (interpolations / handlers)', function () {
    for (const [source, attendu] of formes) {
      it(`${source} → ${attendu}`, () => assert.equal(cleanJs(source), attendu))
    }
  })

  // Ce qui survit aux deux formes est un APPEL malformé : refus BRUYANT au build,
  // plutôt qu'un identifiant littéral qui casse au navigateur.
  describe('appel malformé — refusé au build', function () {
    const fautes = ['µread(i)', 'µwrite(i, 3)', 'µread(@x)', 'µread()', 'µwrite(µread $x)']
    for (const faute of fautes) {
      it(`lexer refuse ${faute}`, () => assert.throws(() => tokenize(faute), /µread\/µwrite vise un symbole/))
      it(`cleanJs refuse ${faute}`, () => assert.throws(() => cleanJs(faute), /µread\/µwrite vise un symbole/))
    }
  })

  // Ancienne forme `µwrite $x = v` / `µwrite($x) = v` (RETIRÉE) : message dédié,
  // distinct du message générique ci-dessus — la faute est réelle et répandue,
  // elle mérite d'orienter directement vers la virgule plutôt que vers un refus générique.
  describe('ancienne forme `= v` — ERREUR DE COMPILATION dédiée', function () {
    const anciennes = ['µwrite $i = 3', 'µwrite($i) = 3', 'µwrite($$x) = 1']
    for (const ancienne of anciennes) {
      it(`lexer refuse ${ancienne}`, () =>
        assert.throws(() => tokenize(ancienne), /µwrite écrit un symbole d'état avec une virgule/))
      it(`cleanJs refuse ${ancienne}`, () =>
        assert.throws(() => cleanJs(ancienne), /µwrite écrit un symbole d'état avec une virgule/))
    }
    // `==`/`=>` ne sont PAS l'ancienne forme (garde `(?!=|>)`, même corps que µderived) —
    // ce ne sont pas des formes valides non plus, mais elles retombent sur le refus
    // générique, pas sur le message dédié à l'ancienne syntaxe.
    it('`µwrite $i ==` n\'est pas pris pour l\'ancienne forme (retombe sur le refus générique)', () =>
      assert.throws(() => tokenize('µwrite $i == 3'), /µread\/µwrite vise un symbole/))
  })

  // Coupure de ligne entre la rune et sa parenthèse : un formateur la pose tout seul, et
  // JS n'insère PAS de point-virgule devant une ligne qui commence par `(` — la forme
  // sortait donc en VRAI appel vers un global inexistant, build vert, ReferenceError au
  // montage (et échec SILENCIEUX dans un handler).
  describe('coupée par un saut de ligne', function () {
    const coupees: Array<[string, string]> = [
      ['µread\n($x)',        '_mjsThis._state.x'],
      ['µwrite\n($x, 3)',    '(_mjsThis._state.x = 3)'],
      ['µread(\n  $x\n)',    '_mjsThis._state.x'],
      ['µread(\n  $$x\n)',   'µ._mjs_storeRaw.x'],
      // virgule consommée, valeur reportée à la ligne suivante : le corps s'arrête à la
      // virgule, la ligne suivante suit tel quel (même trick que l'ancienne forme `= v`).
      ['µwrite $x,\n  3',    '_mjsThis._state.x = \n  3']
    ]
    for (const [source, attendu] of coupees) {
      it(`lexer : ${JSON.stringify(source)}`,   () => assert.equal(tokenize(source), attendu))
      it(`cleanJs : ${JSON.stringify(source)}`, () => assert.equal(cleanJs(source), attendu))
    }
    // et la forme NUE suivie d'une ligne qui commence par une parenthèse reste intacte
    it('`µread $x` puis une ligne `(…)` : la parenthèse suivante n\'est pas mangée', () =>
      assert.equal(tokenize('a = µread $x\n(f)()'), 'a = _mjsThis._state.x\n(f)()'))
    // ancienne forme parenthésée coupée par un saut de ligne : même message dédié
    it('`µwrite\\n($x) = 3` (ancienne forme coupée) refusée avec le message dédié', () =>
      assert.throws(() => tokenize('µwrite\n($x) = 3'), /µwrite écrit un symbole d'état avec une virgule/))
  })

  // Le garde est ancré sur la PARENTHÈSE, jamais sur le mot nu : cleanJs tourne aussi
  // sur des chaînes littérales (aucun masquage à ce niveau) — le mot cité dans un texte
  // d'interface ou une leçon ne doit pas faire échouer un build.
  it('le mot cité dans une chaîne passe intact', () =>
    assert.equal(cleanJs("'utilise µread pour lire sans dépendance'"), "'utilise µread pour lire sans dépendance'"))

  // …et dans un COMMENTAIRE non plus : cleanJs ne masque que les chaînes, le garde
  // faisait donc échouer un build sur du texte mort.
  it('la forme malformée CITÉE dans un commentaire ne casse pas le build', () =>
    assert.doesNotThrow(() => cleanJs('// à ne pas écrire : µread(compteur) sans le $\na = 1')))
  it('idem dans un commentaire de bloc (ancienne forme citée)', () =>
    assert.doesNotThrow(() => cleanJs('/* µwrite($x) = v est refusé */ a = 1')))
  it('idem dans un commentaire Coffee (handler en templateLang js)', () =>
    assert.doesNotThrow(() => cleanJs('# µread(compteur) est refusé\na = 1')))

  // …mais la neutralisation des commentaires ne doit JAMAIS aveugler le garde sur du VRAI
  // code. Un littéral regex finissant par un slash échappé collé au délimiteur fabrique un
  // `//` fantôme : la 1re version, qui effaçait tout `//…`, laissait alors repartir l'appel
  // malformé dans le JS émis — build vert, ReferenceError au clic.
  // Un `//` de commentaire vrai est toujours en TÊTE de ligne, jamais un regex.
  it('un littéral regex ne masque PAS la faute qui le suit', () =>
    assert.throws(() => cleanJs(String.raw`a = x.replace(/http:\/\//, µread(compteur))`), /µread\/µwrite vise un symbole/))
  it('idem avec un regex slash seul', () =>
    assert.throws(() => cleanJs(String.raw`a = /\//.test(b) + µread(compteur)`), /µread\/µwrite vise un symbole/))

  // Ce qui RESTE littéral après les deux formes est une faute, quelle qu'en soit la
  // silhouette : référence nue, ou forme coupée par un saut de ligne (`a = µread` puis
  // `$x` en dessous) — toutes deux muettes jusqu'à ce correctif.
  it('lexer : référence nue `f = µread` refusée', () =>
    assert.throws(() => tokenize('f = µread'), /µread\/µwrite vise un symbole/))
  it('lexer : forme nue coupée par un saut de ligne refusée', () =>
    assert.throws(() => tokenize('a = µread\n$x'), /µread\/µwrite vise un symbole/))
  it('cleanJs : forme nue coupée par un saut de ligne refusée', () =>
    assert.throws(() => cleanJs('a = µread\n$x'), /µread\/µwrite vise un symbole/))
  // Bloc de commentaire JAMAIS fermé : la 1re version posait un drapeau qui restait collé
  // et effaçait tout le reste du segment — garde aveugle sur des dizaines de lignes de vrai
  // code. Sans fermeture, on ne neutralise plus rien.
  it("un bloc de commentaire jamais fermé n'aveugle pas le garde", () =>
    assert.throws(() => cleanJs('a = 1\n/* jamais fermé\nb = µread(compteur)'), /µread\/µwrite vise un symbole/))
  it('un bloc de commentaire fermé plus bas neutralise seulement ses lignes', () => {
    assert.doesNotThrow(() => cleanJs('/* µread(compteur)\n   µevery 10, ->\n*/\na = 1'))
    assert.throws(() => cleanJs('/* ouvert\n*/ b = µread(compteur)'), /µread\/µwrite vise un symbole/)
  })

  // Accès MEMBRE : `obj.µread` est une propriété qui porte ce nom, pas la rune. cleanJs
  // l'excluait par lookbehind, le lexer non — divergence trouvée à la 3e passe (le garde
  // élargi levait à tort sur `obj.µwrite = 1`, et `a.µread $x` compilait en silence en
  // `a._mjsThis._state.x`). Les deux moteurs laissent maintenant la forme intacte.
  describe('accès membre — jamais la rune, parité stricte', function () {
    for (const membre of ['a.µread', 'obj.µwrite = 1', 'foo.µwrite()']) {
      it(`lexer laisse ${membre} intact`,   () => assert.equal(tokenize(membre), membre))
      it(`cleanJs laisse ${membre} intact`, () => assert.equal(cleanJs(membre), membre))
    }
    it('`a.µread $x` : même sortie des deux côtés (le $x seul retombe sur la règle générique)', () =>
      assert.equal(tokenize('a.µread $x'), cleanJs('a.µread $x')))
  })

  it('un identifiant utilisateur `µreadme` reste intact — lexer SEUL (garde MU_HOOKS/RAW_ACCESS, lookahead alphanumérique)', () => {
    assert.equal(tokenize('µreadme = 1'), 'µreadme = 1')
  })

  // cleanJs porte désormais aussi le sucre universel µfoo → µ.foo (sigils.ts,
  // MU_UNIVERSAL_BODY, audit des runes manquantes en expression HTML) : ALIGNÉ sur
  // le script, où `µreadme = 1` compile déjà en `µ.readme = 1` (règle universelle,
  // aucune exclusion pour un identifiant qui PROLONGE une rune réservée au lexer —
  // cf. tests/mu-short-globals.test.ts ligne 101, `µreadFoo → µ.readFoo`).
  it('cleanJs : `µreadme` PROLONGE `read`, ALIGNÉ sur le script (pointé, pas intact)', () => {
    assert.equal(cleanJs('µreadme = 1'), 'µ.readme = 1')
  })

  // Clé d'objet `{ µread: 1 }` : le `:` collé
  // juste derrière la rune n'est plus une forme malformée (lookahead du corps
  // partagé RAW_ACCESS_MALFORME_BODY, sigils.ts) ; le ternaire `c ? µread : x`
  // garde son espace avant le `:` et reste refusé, sans changement
  describe('µread/µwrite en clé d\'objet', function () {
    it('lexer : `{ µread: 1, µwrite: 2 }` ne lève pas, littéral intact', () => {
      const source = 'opts = { µread: 1, µwrite: 2 }'
      assert.doesNotThrow(() => tokenize(source))
      assert.match(tokenize(source), /µread: 1/)
      assert.match(tokenize(source), /µwrite: 2/)
    })

    it('cleanJs : `{ µread: 1, µwrite: 2 }` ne lève pas, littéral intact', () => {
      const source = 'opts = { µread: 1, µwrite: 2 }'
      assert.doesNotThrow(() => cleanJs(source))
      assert.match(cleanJs(source), /µread: 1/)
      assert.match(cleanJs(source), /µwrite: 2/)
    })

    it('bout en bout : `opts = { µread: 1 }` dans un composant résout sans erreur', async () => {
      const src = [
        '<script>',
        '  $x = 1',
        '  opts = { µread: 1 }',
        '</script>',
        '<p>{$x}</p>',
        ''
      ].join('\n')
      await assert.doesNotReject(() => transpile(src, { moduleName: 'mjs-rune-cle-objet' }))
    })

    it('reste refusé : déstructuration, référence nue, ternaire espacé', () => {
      const fautes = ['const { µread } = obj', 'f = µread', 'x = c ? µread : 1']
      for (const faute of fautes) {
        assert.throws(() => tokenize(faute), /µread\/µwrite vise un symbole/)
        assert.throws(() => cleanJs(faute), /µread\/µwrite vise un symbole/)
      }
    })
  })
})
