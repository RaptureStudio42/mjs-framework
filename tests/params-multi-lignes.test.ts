// LISTE DE PARAMÈTRES MULTI-LIGNES (angle mort).
//
// Pass 4 d'`applyMjsSugarToScript` (auto-déclaration scope-aware) n'enregistrait les PARAMÈTRES
// d'une fonction que si son groupe `(…)` tenait sur l'UNIQUE ligne finissant par `->`/`=>` : une
// liste étalée sur plusieurs lignes (`f = (\n  a,\n  b = 1\n) ->`) ne laissait voir devant la flèche
// que le `)` de fermeture, seul — aucun span, aucun paramètre enregistré. Le corps réassignait
// alors `a`/`b` comme des variables NEUVES (Civet refuse : « Identifier 'a' has already been
// declared »), et une valeur par défaut de continuation (`b = 1`) se faisait hisser en
// `.= undefined` fantôme comme une affectation de branche. Remède : `parenDeltaHorsChaines` +
// pré-passe `multiLineParams` (cf. bandeaux transpiler/index.ts).

import assert from 'node:assert/strict'
import { transpile, applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('Pass 4 — liste de paramètres MULTI-LIGNES, jamais oubliée', function () {
  it('cas 1 — fermeture `) ->` : transpile() ne jette plus, a/b restent nus dans le corps de f', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    b = 1',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /b \.= undefined/, 'aucun hissage fantôme de b (valeur par défaut confondue avec une branche)')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 2 — fermeture `) =>` : même chose que le cas 1', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    b = 1',
      '  ) =>',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /b \.= undefined/, 'aucun hissage fantôme de b')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 3 — fermeture indentée au niveau du corps : portée ouverte à l\'indentation de f, pas de `) ->`', function () {
    const input = [
      'f = (',
      '    a,',
      '    b',
      '  ) ->',
      '  a = 2',
    ].join('\n')
    const expected = [
      'f .= (',
      '    a,',
      '    b',
      '  ) ->',
      '  a = 2',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })

  it('cas 4 — paramètres déstructurés multi-lignes : a reste nu', function () {
    const input = [
      'g = ({',
      '  a,',
      '  b',
      '}) ->',
      '  a = 1',
    ].join('\n')
    const expected = [
      'g .= ({',
      '  a,',
      '  b',
      '}) ->',
      '  a = 1',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })

  it('cas 5 — valeur par défaut contenant une chaîne avec parenthèse et virgule : b reste nu, aucun hissage fantôme', function () {
    const input = [
      'h = (',
      '  a = \'x,)\',',
      '  b',
      ') ->',
      '  b = 2',
    ].join('\n')
    const expected = [
      'h .= (',
      '  a = \'x,)\',',
      '  b',
      ') ->',
      '  b = 2',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })

  it('cas 6 — non-régression mono-ligne : chemin existant STRICTEMENT inchangé', function () {
    assert.equal(applyMjsSugarToScript(['k = (a, b) ->', '  a = 1'].join('\n'), 'civet'), ['k .= (a, b) ->', '  a = 1'].join('\n'))
    assert.equal(applyMjsSugarToScript(['m = ->', '  z = 1'].join('\n'), 'civet'), ['m .= ->', '  z .= 1'].join('\n'))
  })

  it('cas 7 — appel multi-lignes SANS flèche : la région ne rend rien inerte, x reste promu', function () {
    const input = [
      'foo(',
      '  1,',
      '  2',
      ')',
      'x = 1',
    ].join('\n')
    const expected = [
      'foo(',
      '  1,',
      '  2',
      ')',
      'x .= 1',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })

  it('cas 8 — deux fonctions multi-lignes qui se suivent, puis une affectation racine : portées fermées, x promu', function () {
    const input = [
      'f = (',
      '  a',
      ') ->',
      '  a = 1',
      'g = (',
      '  b',
      ') ->',
      '  b = 2',
      'x = 3',
    ].join('\n')
    const expected = [
      'f .= (',
      '  a',
      ') ->',
      '  a = 1',
      'g .= (',
      '  b',
      ') ->',
      '  b = 2',
      'x .= 3',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })

  it('cas 9 — commentaire seul sur sa ligne de continuation : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    // n\'importe quel commentaire',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 10 — commentaire en FIN de ligne de paramètre : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a, // rien de special ici',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 11 — parenthèse non appariée DANS le commentaire : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a, // (',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 12 — commentaire Coffee `#` (converti en `//` par la Pass 1) sur sa ligne de continuation : idem cas 9', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    # n\'importe quel commentaire',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  // Cas 13-18 — les cas 9-12 ci-dessus ne couvrent que
  // le commentaire de LIGNE `//`/`#` : un commentaire de BLOC `/* … */` (mono-ligne OU multi-lignes,
  // issu d'un `###…###` Coffee) glissait encore dans `regionSrc`/`joined` et se faisait avaler par
  // `scanRegexLiteral` comme un littéral regex (refermé sur le `/` de `*/`) — pièce garbage jetée en
  // silence par `extractParamNames`. Remède : `sansCommentaires` (remplace `sansCommentaireFinal`).
  it('cas 13 — commentaire de bloc /* … */ seul sur sa ligne de continuation : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    /* commentaire bloc */',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 14 — bloc Coffee `###…###` MULTI-LIGNES (converti en /* */ par la Pass 1) sur ses propres lignes de continuation : idem cas 13', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    ###',
      '    commentaire',
      '    ###',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 15 — commentaire de bloc INLINE après le DERNIER paramètre : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    b /* rien */',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 16 — commentaire de bloc INLINE après une virgule : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a, /* rien */',
      '    b',
      '  ) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 17 — MONO-ligne, commentaire de bloc entre les paramètres : ni a ni b promus, transpile() réussit', async function () {
    const script = [
      '  f = (a, /* c */ b) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 18 — commentaire APRÈS la flèche : a non hissé, transpile() réussit', async function () {
    const script = [
      '  f = (a) -> // note',
      '    a = 2',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>ok</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    // ROUGE avant fix : le `// note` fait échouer `/(?:->|=>|then|do)\s*$/` sur la ligne brute →
    // aucune portée poussée pour f → `a` traité comme une affectation de PORTÉE RACINE, plus
    // profonde que le corps déjà fixé (celui de f lui-même) → HISSÉ (`a .= undefined` inséré avant
    // f), et non « promu en place » (`a .= 2`, seule forme que couvraient les cas 9-12).
    assert.doesNotMatch(sugar, /a \.= undefined/, 'a est un paramètre de f, jamais hissé au niveau racine')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  // CAS 19-25 — un commentaire de bloc `/* … */` qui
  // se REFERME sur la ligne `) ->` elle-même (ou qui précède du code EN TÊTE de ligne) rendait cette
  // ligne « inerte » (ancien mécanisme `wasBlank`) : le `)` de fermeture n'était jamais compté par la
  // pré-passe `multiLineParams`, `depth` ne retombait jamais à 0, la liste de paramètres disparaissait
  // — `a`/`b` hissés en `.= undefined` fantômes (cas 19-20), ou le code après un commentaire en tête
  // jamais auto-déclaré (cas 21). Remède : `blanchirCommentaires` (même longueur que la ligne source,
  // `\n` internes conservés) fournit les lignes de DÉTECTION (`lignesCode`) ; la ligne D'ORIGINE ne
  // sert plus qu'à la RÉÉCRITURE, par découpe à un index calculé sur la version blanchie — d'où les
  // cas 22-23 (commentaire CONSERVÉ dans la sortie) et 24-25 (non-régression : un commentaire/une
  // chaîne multi-lignes qui couvre la ligne entière continue de neutraliser son contenu).

  it('cas 19 — bloc /* … */ qui se REFERME SUR la ligne `) ->` : ni a ni b hissés, transpile() réussit', async function () {
    const script = [
      '  f = (',
      '    a,',
      '    b /* x',
      '    y */) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1, 9)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    // ROUGE avant fix : le commentaire refermé SUR la ligne `) ->` rendait cette ligne inerte — son
    // `)` de fermeture jamais compté par `multiLineParams`, `depth` jamais retombé à 0, la liste de
    // paramètres jamais reconnue : `a`/`b` hissés en `.= undefined` fantômes.
    assert.doesNotMatch(sugar, /a \.= undefined/, 'a est un paramètre de f, jamais hissé au niveau racine')
    assert.doesNotMatch(sugar, /b \.= undefined/, 'b est un paramètre de f, jamais hissé au niveau racine')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 20 — ouverture SUR la ligne des params, fermeture `) ->` sur la ligne suivante qui porte aussi la fin du commentaire : idem cas 19', async function () {
    const script = [
      '  f = (a, /* x',
      '  y */ b) ->',
      '    a = 2',
      '    b = 3',
      '    a + b',
      '  $y = f(1, 9)',
    ].join('\n')
    const { output } = await transpile(`<script>\n${script}\n</script>\n<p>{$y}</p>\n`, { moduleName: 'card' })
    assert.ok(output.length > 0, 'transpile() résout sans jeter « already been declared »')

    const sugar = applyMjsSugarToScript(script, 'civet')
    assert.doesNotMatch(sugar, /a \.= undefined/, 'a est un paramètre de f, jamais hissé au niveau racine')
    assert.doesNotMatch(sugar, /b \.= undefined/, 'b est un paramètre de f, jamais hissé au niveau racine')
    assert.doesNotMatch(sugar, /^\s*a \.= 2\s*$/m, 'a est un paramètre de f, jamais promu dans son corps')
    assert.doesNotMatch(sugar, /^\s*b \.= 3\s*$/m, 'b est un paramètre de f, jamais promu dans son corps')
    assert.match(sugar, /^\s*f \.= \(/m, 'f reste bien déclaré à l\'ouverture')
  })

  it('cas 21 — commentaire de bloc EN TÊTE, code sur la MÊME ligne : x reste auto-déclaré (pré-existant, hors paramètres multi-lignes)', function () {
    // ROUGE avant fix : `wasBlank` rendait TOUTE la ligne inerte dès qu'un `/*` ouvre en tête, qu'il
    // se referme ou non sur cette même ligne — `x` jamais vu par la Pass 4, jamais auto-déclaré,
    // `ReferenceError` au montage du composant.
    assert.equal(applyMjsSugarToScript('/* c */ x = 1', 'civet'), '/* c */ x .= 1')
  })

  it('cas 22 — commentaire `//` en fin de ligne : x auto-déclaré, commentaire CONSERVÉ (non-régression)', function () {
    assert.equal(applyMjsSugarToScript('x = 1 // note', 'civet'), 'x .= 1 // note')
  })

  it('cas 23 — commentaire de bloc en fin de ligne : y auto-déclaré, commentaire CONSERVÉ (non-régression)', function () {
    assert.equal(applyMjsSugarToScript('y = 2 /* bloc */', 'civet'), 'y .= 2 /* bloc */')
  })

  it('cas 24 — ligne ENTIÈREMENT à l\'intérieur d\'un bloc /* … */ multi-lignes : z jamais déclaré ni hissé (non-régression)', function () {
    const input = [
      '/*',
      'z = 3',
      '*/',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), input, 'un commentaire multi-lignes traverse la Pass 4 sans aucune réécriture')
  })

  it('cas 25 — chaîne à backticks MULTI-LIGNES contenant `w = 4` sur sa 2e ligne : w jamais touché (non-régression, inertLines chaînes)', function () {
    const input = [
      'a = `hello',
      'w = 4',
      'world`',
    ].join('\n')
    const expected = [
      'a .= `hello',
      'w = 4',
      'world`',
    ].join('\n')
    assert.equal(applyMjsSugarToScript(input, 'civet'), expected)
  })
})
