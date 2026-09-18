// Tests minification esbuild

import assert from 'node:assert/strict'
import { minifyJs, assertNoStringIndexedMjsAccess } from '../src/bundler/minify.js'

describe('minifyJs', () => {
  it('passthrough en mode dev', async () => {
    delete process.env.NODE_ENV
    const result = await minifyJs(`const  x  =  1;`)
    assert.equal(result.code, `const  x  =  1;`)
  })

  it('minifie en mode force', async () => {
    const result = await minifyJs(`const x = 1;\nconsole.log(x);`, { force: true })
    assert.notEqual(result.code, `const x = 1;\nconsole.log(x);`)
    assert.ok(result.code.length < 30)
  })

  it('drop console.log en force', async () => {
    const result = await minifyJs(`function f() { console.log('hello'); return 1; }`, { force: true })
    assert.doesNotMatch(result.code, /console\.log/)
  })

  it('strip µ.debug declarations', async () => {
    const src = `µ.debug = true;\nfunction f() { if (µ.debug) { console.log('x'); } return 42; }`
    const result = await minifyJs(src, { force: true })
    assert.doesNotMatch(result.code, /µ\.debug/)
    // L'usage `if (µ.debug)` devient `if (false)` puis DCE.
    assert.doesNotMatch(result.code, /console\.log/)
  })

  // Régression — une assignation
  // `µ.debug = ...` INLINE (pas seule sur sa ligne, donc pas couverte par la
  // 1ʳᵉ substitution `^...$`) se faisait remplacer CÔTÉ LECTURE par la 2e
  // substitution (`µ.debug` bare → `false`), produisant `false = true` —
  // syntaxe INVALIDE ("Invalid left-hand side in assignment") → esbuild
  // jetait au build.
  it("assignation µ.debug INLINE (pas seule sur sa ligne) ne casse plus le build (false = true)", async () => {
    const src = `export function f(x) { if (x) µ.debug = true; return x; }`
    await assert.doesNotReject(
      minifyJs(src, { force: true }),
      "AVANT le fix : `if (x) µ.debug = true` devenait `if (x) false = true` → esbuild transform() jetait une erreur de syntaxe",
    )
  })

  it('lecture µ.debug en comparaison (==, ===) reste bien remplacée par false (pas de régression du DCE)', async () => {
    const src = `function f() { if (µ.debug === true) { return 'debug'; } return 'prod'; }`
    const result = await minifyJs(src, { force: true })
    assert.doesNotMatch(result.code, /µ\.debug/)
    assert.doesNotMatch(result.code, /debug/, 'la branche debug doit être éliminée par DCE (false === true)')
  })

  // Régression — la regex de retrait
  // de `µ.debug = …` utilisait `[^;]+`, qui accepte les `\n`. Un `µ.debug =
  // true` SANS `;` final (Civet, langage par défaut des <script>, n'en émet
  // pas) faisait s'étendre le motif jusqu'au premier `;` trouvé PLUS BAS,
  // AVALANT tout le code intermédiaire — suppression SILENCIEUSE d'instructions
  // en prod (ou build cassé). Fix : `[^;\n]+` interdit le franchissement de ligne.
  it('µ.debug = true SANS ; (Civet) ne mange PAS les lignes de code suivantes', async () => {
    const src = `µ.debug = true\ndoWork()\nsideEffect(1)`
    const result = await minifyJs(src, { force: true })
    assert.match(result.code, /doWork/, 'doWork() doit être PRÉSERVÉ (avant le fix : avalé par la regex µ.debug sans ;)')
    assert.match(result.code, /sideEffect/, 'sideEffect(1) doit être PRÉSERVÉ (avant le fix : avalé)')
    assert.doesNotMatch(result.code, /µ\.debug/, 'la ligne µ.debug = true doit tout de même être retirée')
  })

  // Régression — la substitution bare
  // `µ.debug` → `false` opérait sur le texte brut, corrompant toute CHAÎNE /
  // TEMPLATE contenant « µ.debug » (une page de doc affichant l'API livrait
  // « false » à l'utilisateur). Fix : `define` AST d'esbuild — jamais dans une
  // chaîne.
  it('une chaîne contenant « µ.debug » n\'est PAS corrompue en prod', async () => {
    const src = `export const msg = 'Activez µ.debug pour tracer'`
    const result = await minifyJs(src, { force: true })
    assert.match(result.code, /µ\.debug|\\xB5\.debug|\\u00B5\.debug/,
      'le texte « µ.debug » DANS la chaîne doit rester intact (avant le fix : remplacé par false)')
    assert.doesNotMatch(result.code, /Activez false/, 'la chaîne ne doit pas devenir « Activez false pour tracer »')
  })

  it('un template literal contenant « µ.debug » n\'est PAS corrompu', async () => {
    const src = 'export const msg = `mettez µ.debug a true`'
    const result = await minifyJs(src, { force: true })
    assert.doesNotMatch(result.code, /mettez false a true/, 'avant le fix : « mettez false a true »')
  })

  // Régression — les assignations
  // COMPOSÉES inline (`µ.debug ||= …` / `&&=` / `+=`) produisaient
  // `false ||= …` → « Invalid left-hand side » → transform() jetait. Le
  // `define` d'esbuild laisse une CIBLE d'assignation telle quelle → aucun crash.
  it('assignation composée µ.debug ||= INLINE ne casse plus le build', async () => {
    const src = `export function f(c) { if (c) µ.debug ||= location.search.includes('debug'); return c; }`
    await assert.doesNotReject(minifyJs(src, { force: true }),
      'avant le fix : `µ.debug ||= …` devenait `false ||= …` → esbuild transform() jetait')
  })

  it('génère une source map sur demande', async () => {
    const result = await minifyJs(`const x = 1;`, { force: true, sourceMap: true })
    assert.ok(result.map, 'source map should be returned')
    assert.match(result.map!, /"version":\s*3/)
  })
})

describe('assertNoStringIndexedMjsAccess (garde-fou mangleCache)', () => {
  it('passe sur accès dotted légitime', () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `obj._mjs_raw = true; if (obj._mjs_is_interpolator) return;`, 'ok.js'
    ))
  })

  it('passe sur valeur string assignée (el.id = "_mjs_X")', () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `el.id = '_mjs_anim_keyframes';`, 'ok2.js'
    ))
  })

  it('passe sur prop d\'object literal { _mjs_c: true }', () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `return { _mjs_c: true, f: () => 1 };`, 'ok3.js'
    ))
  })

  it("attrape obj['_mjs_X']", () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`return obj['_mjs_raw'];`, 'bad1.js'),
      /accès indexé/
    )
  })

  it('attrape obj["_mjs_X"]', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`return obj["_mjs_raw"];`, 'bad2.js'),
      /accès indexé/
    )
  })

  it("attrape Object.defineProperty(*, '_mjs_X', ...)", () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(
        `Object.defineProperty(this, '_mjs_raw', { value: true });`, 'bad3.js'
      ),
      /Object\.defineProperty/
    )
  })

  it('attrape Reflect.get(*, "_mjs_X")', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(
        `Reflect.get(obj, '_mjs_raw');`, 'bad4.js'
      ),
      /Reflect/
    )
  })

  it('attrape template literal `_mjs_${X}`', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(
        'var k = "raw"; return obj[`_mjs_${k}`];', 'bad5.js'
      ),
      /template literal/
    )
  })

  it('ignore les patterns dans commentaires', () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `// Ne pas faire obj['_mjs_raw']\n/* Object.defineProperty(o, '_mjs_x', ...) */\nreturn 1;`,
      'doc.js'
    ))
  })

  // Régression — un composant dont le
  // TEXTE (démo/doc affichant un exemple de code) contient LITTÉRALEMENT
  // `"...obj['_mjs_foo']..."` comme DONNÉE (pas comme code réel) déclenchait
  // un faux-positif — seuls les commentaires étaient strippés avant ce fix,
  // pas les strings littérales.
  it("ignore le pattern à l'intérieur d'une string de DONNÉE (démo/doc, pas un vrai accès)", () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `const msg = "Ne fais pas obj['_mjs_raw'] — utilise obj._mjs_raw"; return msg;`,
      'demo.js'
    ), "AVANT le fix : le texte À L'INTÉRIEUR de cette string de données déclenchait le même throw qu'un VRAI accès indexé")
  })

  it('un VRAI accès indexé reste détecté même si une AUTRE string de donnée est présente juste avant', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(
        `const doc = "exemple : obj._mjs_raw"; return obj['_mjs_raw'];`,
        'mixed.js'
      ),
      /accès indexé/,
      'la string de doc ne doit pas masquer un VRAI accès indexé plus loin dans le même fichier',
    )
  })

  it('message d\'erreur précise filename + ligne', () => {
    try {
      assertNoStringIndexedMjsAccess(`\n\nreturn obj['_mjs_raw'];`, 'precise.js')
      assert.fail('should throw')
    } catch (e: any) {
      assert.match(e.message, /precise\.js:3/)
    }
  })

  it('intégré dans minifyJs() : throw si mangleCache + accès indirect', async () => {
    const cache: Record<string, string | false> = {}
    await assert.rejects(
      minifyJs(`return obj['_mjs_raw'];`, { force: true, mangleCache: cache, filename: 'x.js' }),
      /accès indexé/
    )
  })

  it('non-intégré dans minifyJs() sans mangleCache (passthrough OK)', async () => {
    // Sans mangleCache, le mangle de props n'est pas activé → pas de check
    const result = await minifyJs(`return obj['_mjs_raw'];`, { force: true })
    assert.ok(result.code.length > 0)
  })
})

// Ce que la garde doit voir : un fichier de cœur mêle commentaires de ligne citant du code,
// gabarits porteurs d'apostrophes, littéraux regex décrivant le motif interdit — un nettoyage par
// expressions régulières se perd dans ces contextes et blanchit du VRAI code, en silence.
describe('assertNoStringIndexedMjsAccess (lecture à états)', () => {
  it('un `/*` cité dans un commentaire de LIGNE n\'aveugle pas le code qui suit', () => {
    const source = [
      '// route de repli (`\'/*\': \'not-found-page\'`) rend le cas inatteignable',
      'return obj[\'_mjs_raw\'];',
      '/* un vrai commentaire de bloc, plus bas dans le fichier */',
    ].join('\n')
    assert.throws(() => assertNoStringIndexedMjsAccess(source, 'ligne.js'), /accès indexé/)
  })

  it('un `//` à l\'intérieur d\'une chaîne ne blanchit pas la fin de la ligne', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`var s = "a // b"; return obj['_mjs_raw'];`, 'chaine.js'),
      /accès indexé/,
    )
  })

  it('une apostrophe dans un gabarit ne décale pas les chaînes suivantes', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess('var msg = `l\'état`; return obj[\'_mjs_raw\'];', 'gabarit.js'),
      /accès indexé/,
    )
  })

  it('un guillemet dans un littéral regex ne décale pas les chaînes suivantes', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`var re = /['"]/; return obj['_mjs_raw'];`, 'regex.js'),
      /accès indexé/,
    )
  })

  it('un littéral regex qui DÉCRIT le motif interdit ne casse pas le build', () => {
    assert.doesNotThrow(() => assertNoStringIndexedMjsAccess(
      `var re = /\\['_mjs_x'\\]/; return re.source;`, 'detection.js'
    ))
  })

  it('attrape la concaténation `\'_mjs_\' + x`', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`var k = '_mjs_' + name; return obj[k];`, 'concat.js'),
      /concaténation/,
    )
  })

  it('attrape `\'_mjs_X\' in obj`', () => {
    assert.throws(
      () => assertNoStringIndexedMjsAccess(`if (!('_mjs_headTitle' in c)) c._mjs_headTitle = 1;`, 'in.js'),
      /in obj/,
    )
  })

  it('attrape le gabarit dynamique posé après un commentaire de ligne citant `/*`', () => {
    const source = [
      '// repli de route : `\'/*\'`',
      'var k = "raw";',
      'µ[`_mjs_${k}`] = 1;',
      '/* fin du cœur */',
    ].join('\n')
    assert.throws(() => assertNoStringIndexedMjsAccess(source, 'sabotage.js'), /template literal/)
  })

  it('garde le numéro de ligne exact après un commentaire de bloc et une chaîne multiligne', () => {
    const source = '/* deux\n   lignes */\nvar s = `un\ndeux`;\nreturn obj[\'_mjs_raw\'];'
    try {
      assertNoStringIndexedMjsAccess(source, 'ligne-exacte.js')
      assert.fail('should throw')
    }
    catch(e: any) {
      assert.match(e.message, /ligne-exacte\.js:5/)
    }
  })
})
