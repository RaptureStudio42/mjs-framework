// i18n v1 — CÔTÉ COMPILATEUR. Rune `µt('clé', vars)` → `µ.t(...)` ;
// directives racines `@i18n 'section'` (préfixe compile-time des clés
// RELATIVES) et `@i18nPlaceholder <mode>` (auto|key|wait, voyage en 3e
// argument LITTÉRAL de chaque appel) ; émission d'instance `_mjs_i18n =
// [section, mode]` (nouveau placeholder [[I18N_LINE]], à côté de
// [[STORE_KEYS_LINE]]) — contrat runtime figé, ce fichier ne teste QUE la
// compilation (le runtime/build sont hors périmètre).

import assert from 'node:assert/strict'
import { tokenize } from '../src/lexer/index.ts'
import { cleanJs } from '../src/generator/utils.ts'
import { transpile, parseTemplateLiteralArg, skipTemplateLiteral } from '../src/transpiler/index.ts'
import { extractDirectives } from '../src/transpiler/directives.ts'

describe('i18n — sucre µt → µ.t (sigils.ts, MU_SHORT_GLOBALS)', function () {
  it('lexer (scripts) : µt(\'clé\') → µ.t(\'clé\')', () => {
    assert.equal(tokenize("µt('resume')"), "µ.t('resume')")
  })

  // témoins CHANGÉS : `µtoggle` n'est plus un identifiant utilisateur, c'est une
  // rune du framework (bascule d'état, cf. tests/rune-toggle.test.ts) — la garde de frontière
  // qu'on prouve ici reste la même, sur deux noms toujours libres.
  it('lexer : identifiant plus long intact (µtotal, µtranslate)', () => {
    assert.equal(tokenize('µtotal()'), 'µtotal()')
    assert.equal(tokenize('µtranslate(1)'), 'µtranslate(1)')
  })

  it('lexer : les hooks (µurlChange, MU_HOOKS) restent prioritaires, aucune collision avec µt', () => {
    assert.equal(tokenize('µurlChange (p, a) ->'), "this._mjs_hook 'urlChange', (p, a) ->")
  })

  it('cleanJs (interpolations/handlers) : µt(\'clé\', vars) → µ.t(\'clé\', vars)', () => {
    assert.equal(cleanJs("µt('titre', {n: 1})"), "µ.t('titre', {n: 1})")
  })

  it('cleanJs : idempotent sur la forme déjà pointée', () => {
    assert.equal(cleanJs("µ.t('x')"), "µ.t('x')")
  })
})

describe('i18n — sucre µlang → µ.store.__mjsLang (sigils.ts MU_LANG_BODY)', function () {
  it("lexer (scripts) : µlang == 'fr' → µ.store.__mjsLang == 'fr'", () => {
    assert.equal(tokenize("µlang == 'fr'"), "µ.store.__mjsLang == 'fr'")
  })

  it("lexer (scripts) : µlang = 'en' (écriture) → µ.store.__mjsLang = 'en'", () => {
    assert.equal(tokenize("µlang = 'en'"), "µ.store.__mjsLang = 'en'")
  })

  it('lexer : identifiant plus long intact (µlangue, µlangXXX — garde de frontière)', () => {
    assert.equal(tokenize('µlangue'), 'µlangue')
    assert.equal(tokenize('µlangXXX'), 'µlangXXX')
  })

  it("cleanJs (interpolations/handlers) : {if µlang == 'en'} → µ.store.__mjsLang == 'en'", () => {
    assert.equal(cleanJs("µlang == 'en'"), "µ.store.__mjsLang == 'en'")
  })

  it("cleanJs : @click={µlang = 'fr'} → µ.store.__mjsLang = 'fr'", () => {
    assert.equal(cleanJs("µlang = 'fr'"), "µ.store.__mjsLang = 'fr'")
  })

  it('cleanJs : idempotent sur la forme déjà pointée', () => {
    assert.equal(cleanJs('µ.store.__mjsLang'), 'µ.store.__mjsLang')
  })

  it("transpile bout-en-bout : lecture µlang dans une interpolation → µ.store.__mjsLang (dépendance $$__mjsLang via l'analyzer, µ.store.x générique)", async () => {
    const src = "<p>{µlang}</p>"
    const { output } = await transpile(src, { moduleName: 'mjs-lang-read-tpl' })
    assert.match(output, /µ\.store\.__mjsLang/)
  })

  it("transpile bout-en-bout : écriture µlang = 'en' dans un handler → µ._storeSet('__mjsLang', 'en') (réécriture path-tracker existante, aucune plomberie dédiée)", async () => {
    const src = "<button @click={µlang = 'en'}>EN</button>"
    const { output } = await transpile(src, { moduleName: 'mjs-lang-write-handler' })
    assert.match(output, /µ\._storeSet\("__mjsLang", 'en'\)/)
  })
})

describe('i18n — directive @i18n (extraction)', function () {
  it("@i18n 'panier' : section extraite, retirée du source nettoyé", () => {
    const res = extractDirectives("@i18n 'panier'\n<p>hi</p>")
    assert.equal(res.moduleI18nSection, 'panier')
    assert.ok(!res.cleaned.includes('@i18n'))
  })

  it('@i18n "panier" (guillemets doubles) : accepté aussi', () => {
    const res = extractDirectives('@i18n "panier"\n<p>hi</p>')
    assert.equal(res.moduleI18nSection, 'panier')
  })

  it('absence de @i18n : moduleI18nSection null', () => {
    const res = extractDirectives('<p>hi</p>')
    assert.equal(res.moduleI18nSection, null)
  })

  it("section invalide (majuscule) : ERREUR de compilation explicite", () => {
    assert.throws(
      () => extractDirectives("@i18n 'Panier'\n<p>hi</p>"),
      /@i18n.*Panier.*n'est pas un nom de section valide/s
    )
  })

  it('section invalide (espace) : ERREUR de compilation explicite', () => {
    assert.throws(
      () => extractDirectives("@i18n 'mon panier'\n<p>hi</p>"),
      /@i18n/
    )
  })

  // 2 directives @i18n dans le même module écrasaient la
  // 1ère en silence (dernière gagnante) : erreur de compilation explicite.
  it('@i18n en DOUBLE dans le même module : ERREUR de compilation explicite', () => {
    assert.throws(
      () => extractDirectives("@i18n 'panier'\n@i18n 'compte'\n<p>hi</p>"),
      /@i18n en double.*panier.*compte/s
    )
  })
})

describe('i18n — directive @i18nPlaceholder (extraction)', function () {
  it("@i18nPlaceholder auto : accepté SANS @i18n (agit sur les clés racine)", () => {
    const res = extractDirectives('@i18nPlaceholder auto\n<p>hi</p>')
    assert.equal(res.moduleI18nPlaceholder, 'auto')
    assert.equal(res.moduleI18nSection, null)
  })

  it("@i18nPlaceholder key : accepté SANS @i18n", () => {
    const res = extractDirectives('@i18nPlaceholder key\n<p>hi</p>')
    assert.equal(res.moduleI18nPlaceholder, 'key')
  })

  it("@i18nPlaceholder wait AVEC @i18n : accepté", () => {
    const res = extractDirectives("@i18n 'panier'\n@i18nPlaceholder wait\n<p>hi</p>")
    assert.equal(res.moduleI18nPlaceholder, 'wait')
    assert.equal(res.moduleI18nSection, 'panier')
  })

  it("@i18nPlaceholder wait SANS @i18n : ERREUR explicite", () => {
    assert.throws(
      () => extractDirectives('@i18nPlaceholder wait\n<p>hi</p>'),
      /@i18nPlaceholder wait.*exige une section @i18n/s
    )
  })

  it('mode invalide : ERREUR listant les valeurs valides', () => {
    assert.throws(
      () => extractDirectives('@i18nPlaceholder yolo\n<p>hi</p>'),
      /@i18nPlaceholder.*yolo.*auto, key ou wait/s
    )
  })

  it('absence de @i18nPlaceholder : moduleI18nPlaceholder null', () => {
    const res = extractDirectives('<p>hi</p>')
    assert.equal(res.moduleI18nPlaceholder, null)
  })
})

describe('i18n — préfixage compile-time (transpile bout-en-bout)', function () {
  this.timeout(8000)

  it("@i18n 'panier' : µt('resume') → µ.t('panier.resume') dans le script", async () => {
    const src = [
      "@i18n 'panier'",
      '<script lang="civet">',
      "x := µt('resume')",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-scope-script' })
    assert.match(output, /µ\.t\('panier\.resume'\)/)
  })

  it("@i18n 'panier' : µt('titre') → µ.t('panier.titre') dans une interpolation", async () => {
    const src = [
      "@i18n 'panier'",
      "<p>{µt('titre')}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-scope-tpl' })
    assert.match(output, /µ\.t\('panier\.titre'\)/)
  })

  it("@i18n 'panier' : µt('/nav.fermer') → µ.t('nav.fermer') (chemin ABSOLU, jamais préfixé)", async () => {
    const src = [
      "@i18n 'panier'",
      "<button @click={µt('/nav.fermer')}>X</button>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-abs' })
    assert.match(output, /µ\.t\('nav\.fermer'\)/)
    assert.doesNotMatch(output, /panier\.nav\.fermer/)
  })

  it('sans @i18n : µt(\'x\') reste inchangé (pas de préfixe)', async () => {
    const src = "<p>{µt('titre')}</p>"
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-noscope' })
    assert.match(output, /µ\.t\('titre'\)/)
  })

  it('1er argument NON littéral (variable) : appel laissé INTACT, sémantique absolue', async () => {
    const src = [
      "@i18n 'panier'",
      '<script lang="civet">',
      "cle := 'resume'",
      'x := µt(cle)',
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-varkey' })
    assert.match(output, /µ\.t\(cle\)/)
  })

  it("2 arguments (vars) préservés sans @i18nPlaceholder : µt('x', {n:1}) → µ.t('x', {n:1}), pas de 3e argument", async () => {
    const src = "<p>{µt('x', {n: 1})}</p>"
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-vars-nomode' })
    assert.match(output, /µ\.t\('x', \{n: 1\}\)/)
  })

  it("@i18nPlaceholder wait : 3e argument ajouté, µt('x') → µ.t('x', undefined, 'wait')", async () => {
    const src = [
      "@i18n 'panier'",
      "@i18nPlaceholder wait",
      "<p>{µt('x')}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-wait-novars' })
    assert.match(output, /µ\.t\('panier\.x', undefined, 'wait'\)/)
  })

  it("@i18nPlaceholder auto (sans @i18n) : 3e argument ajouté, 2e argument vars préservé", async () => {
    const src = [
      '@i18nPlaceholder auto',
      "<p>{µt('/nav.fermer', {n: 3})}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-auto-vars' })
    assert.match(output, /µ\.t\('nav\.fermer', \{n: 3\}, 'auto'\)/)
  })
})

describe('i18n — émission _mjs_i18n (instance, placeholder [[I18N_LINE]])', function () {
  this.timeout(8000)

  it("@i18n seule (sans µt) : _mjs_i18n = ['panier', null]", async () => {
    const src = [
      "@i18n 'panier'",
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-emit-section-only' })
    assert.match(output, /_mjs_i18n\s*=\s*\["panier",null\]/)
  })

  it("µt seul (sans @i18n) : _mjs_i18n = [null, null]", async () => {
    const src = "<p>{µt('x')}</p>"
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-emit-mt-only' })
    assert.match(output, /_mjs_i18n\s*=\s*\[null,null\]/)
  })

  it("@i18n + @i18nPlaceholder + µt : _mjs_i18n = ['panier','wait']", async () => {
    const src = [
      "@i18n 'panier'",
      '@i18nPlaceholder wait',
      "<p>{µt('x')}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-emit-both' })
    assert.match(output, /_mjs_i18n\s*=\s*\["panier","wait"\]/)
  })

  it('ni @i18n ni µt : AUCUNE ligne _mjs_i18n émise (zéro coût)', async () => {
    const src = [
      '<script>',
      '$count = 0',
      '</script>',
      '<button @click={$count += 1}>{$count}</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-emit-none' })
    assert.doesNotMatch(output, /_mjs_i18n/)
  })
})

describe('i18n — non-régression : module sans i18n, sortie inchangée hors ajout ciblé', function () {
  this.timeout(8000)

  it('compteur simple (fixture sans µt/@i18n) : pas de µ.t(, pas de _mjs_i18n, [[I18N_LINE]] bien substitué (chaîne vide)', async () => {
    const src = [
      '<script>',
      '$count = 0',
      '</script>',
      '<button @click={$count += 1}>{$count}</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-baseline' })
    assert.doesNotMatch(output, /µ\.t\(/)
    assert.doesNotMatch(output, /_mjs_i18n/)
    assert.doesNotMatch(output, /\[\[I18N_LINE\]\]/, 'le placeholder doit toujours être substitué (même par une chaîne vide)')
  })
})

describe('i18n — clé calculée (gabarit) et µt imbriqué', function () {
  this.timeout(8000)

  it('gabarit avec slash : µt("/nav.#{$k}") → µ.t(`nav.${$.k}`), slash de tête retiré', async () => {
    const src = [
      "@i18n 'panier'",
      '<p>{µt("/nav.#{$k}")}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-tpl-slash' })
    assert.match(output, /µ\.t\(`nav\.\$\{/)
    assert.doesNotMatch(output, /µ\.t\(`\/nav/)
  })

  it('gabarit sans slash : µt("nav.#{$k}") → µ.t(`nav.${$.k}`), jamais préfixé (non-régression)', async () => {
    const src = [
      "@i18n 'panier'",
      '<p>{µt("nav.#{$k}")}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-tpl-noslash' })
    assert.match(output, /µ\.t\(`nav\.\$\{/)
    assert.doesNotMatch(output, /panier\.nav/)
  })

  it("µt imbriqué sans mode : µt('a', { x: µt('b') }) → l'intérieur est aussi préfixé", async () => {
    const src = [
      "@i18n 'panier'",
      "<p>{µt('a', { x: µt('b') })}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-nested-nomode' })
    assert.match(output, /µ\.t\('panier\.a'/)
    assert.match(output, /µ\.t\('panier\.b'\)/)
    assert.doesNotMatch(output, /µ\.t\('b'\)/)
  })

  it("µt imbriqué + @i18nPlaceholder key : l'appel niché reçoit aussi son mode, l'appel externe garde le sien", async () => {
    const src = [
      "@i18n 'panier'",
      '@i18nPlaceholder key',
      "<p>{µt('a', { x: µt('b') })}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-nested-mode' })
    assert.match(output, /µ\.t\('panier\.b', undefined, 'key'\)/)
    assert.match(output, /µ\.t\('panier\.a', \{ x: µ\.t\('panier\.b', undefined, 'key'\) \}, 'key'\)/)
  })

  it('script : µt imbriqué et gabarit à slash reçoivent le même traitement qu\'en interpolation', async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      "$label = µt('a', { x: µt('/b') })",
      '$k = 1',
      '$calc = µt("/nav.#{$k}")',
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-nested-script' })
    assert.match(output, /µ\.t\('panier\.a', \{ x: µ\.t\('b'\) \}\)/)
    assert.match(output, /µ\.t\(`nav\.\$\{/)
    assert.doesNotMatch(output, /µ\.t\(`\/nav/)
  })

  it("clé variable + niché : µt($k, { x: µt('b') }) — la clé variable reste intacte, l'intérieur est préfixé", async () => {
    const src = [
      "@i18n 'panier'",
      "<p>{µt($k, { x: µt('b') })}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-varkey-nested' })
    assert.match(output, /µ\.t\(\$\.k, \{ x: µ\.t\('panier\.b'\) \}\)/)
  })

  it('clé variable seule : µt($k) reste inchangé', async () => {
    const src = '<p>{µt($k)}</p>'
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-varkey-alone' })
    assert.match(output, /µ\.t\(\$\.k\)/)
  })
})

describe('i18n — gabarit à backtick imbriqué', function () {
  this.timeout(8000)

  it('interpolation contenant elle-même un gabarit (backtick imbriqué) : µt(`/x.${`a${$y}`}z`) → µ.t(`x.${`a${$.y}`}z`), slash de tête retiré (Civet ne compile pas ce gabarit via #{}, forme JS directe dans un script)', async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      '$y = 1',
      '$k = µt(`/x.${`a${$y}`}z`)',
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-nested-slash' })
    assert.match(output, /µ\.t\(`x\.\$\{`a\$\{/)
    assert.doesNotMatch(output, /µ\.t\(`\/x/)
  })

  it("argument suivant un gabarit à backtick imbriqué : µt(`/x.${`a`}`, { n: µt('b') }) → slash retiré, 2e argument préfixé", async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      "$k = µt(`/x.${`a`}`, { n: µt('b') })",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-nested-next-arg' })
    assert.match(output, /µ\.t\('panier\.b'\)/)
    assert.doesNotMatch(output, /µ\.t\(`\/x/)
  })

  it("virgule dans l'interpolation (sans backtick imbriqué) : µt(\"/x.#{f($a, $b)}\", { n: µt('c') }) — 2 arguments EXACTS, slash retiré, 2e argument préfixé", async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      '$a = 1',
      '$b = 2',
      'f = (x, y) -> x + y',
      '</script>',
      '<p>{µt("/x.#{f($a, $b)}", { n: µt(\'c\') })}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-comma-interp' })
    assert.match(output, /µ\.t\('panier\.c'\)/)
    assert.doesNotMatch(output, /µ\.t\(`\/x/)
    assert.match(output, /µ\.t\(`x\.\$\{[^`]*\}`, \{/)
  })

  it('non-régression : backtick ÉCHAPPÉ dans un gabarit simple → slash retiré comme avant', async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      "$k = µt(`/a\\`b`)",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-escaped' })
    assert.match(output, /µ\.t\(`a\\`b`\)/)
    assert.doesNotMatch(output, /µ\.t\(`\/a/)
  })
})


// Extrait la ligne `µ._set(_mjsThis, '<nomVar>', …)` de `output` (une
// assignation `$x = …` compile sur SA PROPRE ligne) et vérifie l'équilibre `(`/`)` dessus — sert
// à prouver que le scan de la parenthèse fermante RÉELLE d'un `µ.t(` (applyI18nPrefixing) ne
// s'arrête plus au milieu d'un gabarit sur un backtick littéral interne (avant le correctif, la
// parenthèse fermante surnuméraire retombe sur la ligne SUIVANTE, invisible à un simple
// assert.match non ancré sur cette ligne).
function ligneAssignation(output: string, nomVar: string): string | undefined {
  return output.split('\n').find(l => l.includes(`µ._set(_mjsThis, '${nomVar}',`))
}

function assertParensEquilibrees(ligne: string | undefined): void {
  assert.ok(ligne, `ligne introuvable dans output`)
  const ouvrantes = (ligne!.match(/\(/g) ?? []).length
  const fermantes = (ligne!.match(/\)/g) ?? []).length
  assert.equal(ouvrantes, fermantes, `parenthèses déséquilibrées sur : ${ligne}`)
}

describe('i18n — scan des parenthèses de µ.t et gabarit non refermé', function () {
  this.timeout(8000)

  it("backtick littéral dans une chaîne À GUILLEMETS DOUBLES de l'interpolation : µt(`/x.${ \"a`b\" }`, { n: 1 }) → parenthèses équilibrées, $after sur sa propre ligne", async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      '$k = µt(`/x.${ "a`b" }`, { n: 1 })',
      "$after = 'v'",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-dquote' })
    assert.match(output, /µ\.t\(`x\.\$\{ "a`b" \}`, \{ n: 1 \}\)/)
    assertParensEquilibrees(ligneAssignation(output, 'k'))
    assert.match(output, /µ\._set\(_mjsThis, 'after', 'v'\)/)
    assertParensEquilibrees(ligneAssignation(output, 'after'))
  })

  it("backtick littéral dans une chaîne À GUILLEMETS SIMPLES de l'interpolation : µt(`/y.${ 'c`d' }`) → parenthèses équilibrées, $after sur sa propre ligne", async () => {
    const src = [
      "@i18n 'panier'",
      '<script>',
      "$k = µt(`/y.${ 'c`d' }`)",
      "$after = 'v'",
      '</script>',
      '<p>hi</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-i18n-backtick-squote' })
    assert.match(output, /µ\.t\(`y\.\$\{ 'c`d' \}`\)/)
    assertParensEquilibrees(ligneAssignation(output, 'k'))
    assert.match(output, /µ\._set\(_mjsThis, 'after', 'v'\)/)
    assertParensEquilibrees(ligneAssignation(output, 'after'))
  })

  it('unitaire — skipTemplateLiteral/parseTemplateLiteralArg distinguent refermé et jamais refermé', () => {
    assert.equal(parseTemplateLiteralArg('`/x'), null)
    assert.deepEqual(parseTemplateLiteralArg('`/x`'), { content: '/x' })
    assert.equal(skipTemplateLiteral('`a${`b`}c`', 0), '`a${`b`}c`'.length)
  })
})
