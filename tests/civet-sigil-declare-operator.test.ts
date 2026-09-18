// Test de régression — crash découvert par test réel : dans un
// <script lang="civet">, `$nom := 'monde'` (un symbole $ combiné à l'opérateur
// de DÉCLARATION Civet `:=`) faisait CRASHER l'analyzer avec un message
// cryptique et non localisé : `[analyzer] parse error: Unexpected token (2:7)`.
//
// Cause racine (tracée via transpileFile, pipeline réel) : le lexer réécrit
// tout `$xxx` bare en accès membre `$.xxx` (règle 3.8, sucre state — src/lexer/
// index.ts) AVANT la compilation Civet elle-même (ordre nécessaire par
// ailleurs, cf. commentaire "7. Pipeline pré-compilation" de transpiler/
// index.ts). `$nom := 'monde'` devient donc `$.nom := 'monde'` — que Civet
// compile SANS broncher en `const $.nom = 'monde'` (cible non-identifiant d'un
// `const` : JS invalide, mais Civet ne valide pas cette contrainte). Le vrai
// crash n'arrive qu'ENSUITE, loin de la vraie faute : l'Analyzer MJS (src/
// analyzer/index.ts) re-parse ce JS via acorn pour extraire les state vars, et
// acorn refuse `const $.nom = ...` avec un « Unexpected token » brut.
//
// DÉCISION DE CONCEPTION (imposée) : `:=` n'est PAS supporté sur les symboles
// $ — la seule syntaxe valide est `$x = valeur` (auto-déclaration, cf. règle
// 3.8). Fix : garde-fou dans le lexer (règle 3.8-pré, src/lexer/index.ts),
// posé AVANT la réécriture `$.xxx` qui rend le motif méconnaissable en aval —
// throw une erreur de compilation MJS propre et pédagogique (même mécanique et
// même format que les précédents existants : import ES classique interdit,
// anciennes formes @mount ->/@viewTransition) au lieu de laisser dégénérer
// jusqu'au crash acorn.
//
// Portée du garde-fou : seulement quand `$xxx` serait RÉELLEMENT réécrit par la
// règle 3.8 (donc ni en moduleMode, ni pour un $xxx ∈ externalVars — dans ces
// deux cas `$xxx` reste un identifiant Civet ordinaire, `:=` y est parfaitement
// valide, aucun risque de crash).

import assert from 'node:assert/strict'
import { tokenize } from '../src/lexer/index.js'
import { transpile } from '../src/transpiler/index.js'
import { cleanJs, cleanJsExpr } from '../src/generator/utils.js'

describe('tokenize — garde-fou `$xxx := expr` (règle 3.8-pré, unitaire)', () => {
  it("`$x := 'v'` → throw explicite MJS (au lieu de laisser passer $.x := 'v', invalide en aval)", () => {
    assert.throws(
      () => tokenize("$x := 'v'"),
      /\[ModularJS\].*:=.*symbole \$.*« \$x = 'v' »/s
    )
  })

  it('le message pédagogique reprend le VRAI nom de variable et la VRAIE valeur écrite', () => {
    assert.throws(() => tokenize('$compteur := 0'), /« \$compteur = 0 »/)
  })

  it("non-régression — `x := 'v'` SANS symbole $ reste INTACT (Civet natif, jamais concerné par le garde-fou)", () => {
    assert.doesNotThrow(() => tokenize("x := 'v'"))
    assert.equal(tokenize("x := 'v'"), "x := 'v'")
  })

  it("non-régression — `$x = 'v'` (auto-déclaration standard, sans :=) continue de réécrire en `$.x = 'v'`", () => {
    assert.equal(tokenize("$x = 'v'"), "$.x = 'v'")
  })

  it("non-régression — la snapshot MJS `$x =: expr` (opérateur INVERSE `=:`, sans rapport) reste inchangée", () => {
    assert.doesNotThrow(() => tokenize('$x = 1\n$y =: $x + 1'))
    assert.equal(tokenize('$x = 1\n$y =: $x + 1'), '$.x = 1\n$.y = µ.snap $.x + 1')
  })

  it('en moduleMode, `$xxx := expr` ne throw PAS ($xxx reste un identifiant Civet ordinaire, jamais réécrit)', () => {
    assert.doesNotThrow(() => tokenize("$x := 'v'", { moduleMode: true }))
    assert.equal(tokenize("$x := 'v'", { moduleMode: true }), "$x := 'v'")
  })

  it("un $xxx importé (externalVars) ne throw pas non plus (préservé tel quel, jamais réécrit en $.xxx)", () => {
    assert.doesNotThrow(() => tokenize("$imported := 'v'", { externalVars: ['$imported'] }))
    assert.equal(tokenize("$imported := 'v'", { externalVars: ['$imported'] }), "$imported := 'v'")
  })
})

describe('civet-sigil-declare-operator — bout-en-bout (transpile réel)', function () {
  this.timeout(8000)

  it('<script lang="civet"> avec `$nom := \'monde\'` : transpile() rejette avec l\'erreur MJS pédagogique (pas de crash analyzer cryptique)', async () => {
    const src = [
      '<script lang="civet">',
      "$nom := 'monde'",
      '</script>',
      '<p>{$nom}</p>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'sigildeclare1', defaultScriptLang: 'civet' }),
      /\[ModularJS\].*:=.*« \$nom = 'monde' »/s
    )
  })

  it("non-régression — `x := 'v'` (SANS symbole $) reste du Civet valide et compile", async () => {
    const src = [
      '<script lang="civet">',
      "x := 'v'",
      'console.log(x)',
      '</script>',
      '<p>ok</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'sigildeclare2', defaultScriptLang: 'civet' })
    assert.match(output, /µ\._def\(/)
  })

  it("non-régression — `$x = 'v'` (auto-déclaration standard) compile toujours", async () => {
    const src = [
      '<script lang="civet">',
      "$x = 'v'",
      '</script>',
      '<p>{$x}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'sigildeclare3', defaultScriptLang: 'civet' })
    assert.match(output, /\$\.x/)
    assert.match(output, /µ\._def\(/)
  })
})

// Petit frère du bug ci-dessus (repéré mais non
// traité à l'époque) — le MÊME motif `$x := expr` écrit dans une EXPRESSION DE
// TEMPLATE (handler `@click={…}`, interpolation `{…}`) ne passe PAS par
// `tokenize()` (le lexer n'agit que sur le <script>) : ces sites passent par
// le moteur cleanJs/cleanJsExpr (generator/utils.ts), qui a SA PROPRE règle
// `$x → $.x` (fonction interne `applySymbolRegex`, partagée par les deux
// fonctions exportées). Sans garde-fou jumeau, `$x := 2` dans un handler
// devenait silencieusement `$.x := 2` puis (le handler étant recompilé en
// bloc, POSITION STATEMENT, cf. transpiler/index.ts) Civet l'acceptait SANS
// broncher en `const $.x = 2` — cible non-identifiant d'un `const`, JS
// invalide, mais AUCUN throw : filé tel quel dans le bundle (`const $.x =
// 2;return $.x` dans le handler compilé, vérifié via transpileFile sur
// `@click={$x := 2}`). Fix : même garde-fou, jumeau, posé dans
// `applySymbolRegex` juste avant sa règle `$x → $.x`.
//
// Nuance vérifiée par sonde directe (@danielx/civet) : les sites EXPRESSION
// (interpolation/attribut — cleanJsExpr, toujours compilés enveloppés de
// parenthèses `(...)`) n'ont jamais pu produire de JS invalide silencieux —
// Civet y rejette DÉJÀ nativement `:=` (opérateur de DÉCLARATION, syntaxiquement
// invalide en position expression, `$` ou pas) avec un échec de parse généré
// par `compileGrammarViaCivet` (message générique « échec de compilation
// Civet »). Ce garde-fou y transforme ce rejet générique en message
// pédagogique — un confort, pas un fix de crash silencieux (qui, lui,
// n'existe que côté FRAGMENT/statement, cf. `@click=`). Par ailleurs, pour
// l'interpolation SANS exemption, un mécanisme totalement différent et déjà
// existant intercepte en PREMIER (state.ts `getEffectVars` réutilise le
// `tokenize()` du lexer pour l'analyse de dépendances AVANT tout appel à
// `cleanJsExpr` — la règle 3.8-pré du lexer y throw donc la première,
// message identique mais preview parfois polluée par le wrapping interne
// `[expr]` de `getEffectVars`, ex. « $x = 2] » — artefact PRÉEXISTANT,
// hors-zone de cette correction, cf. src/generator/state.ts).
describe('cleanJs/cleanJsExpr — garde-fou JUMEAU `$xxx := expr` en expression de template (unitaire)', () => {
  it("cleanJs — `$x := 2` (handler/fragment) → throw explicite MJS (au lieu de laisser passer $.x := 2, invalide en aval)", () => {
    assert.throws(
      () => cleanJs('$x := 2'),
      /\[ModularJS\].*:=.*symbole \$.*« \$x = 2 »/s
    )
  })

  it('cleanJs — le message pédagogique reprend le VRAI nom de variable et la VRAIE valeur écrite', () => {
    assert.throws(() => cleanJs('$compteur := 0'), /« \$compteur = 0 »/)
  })

  it("cleanJsExpr — même garde-fou (site EXPRESSION) : `$x := 2` throw le MÊME message pédagogique", () => {
    assert.throws(
      () => cleanJsExpr('$x := 2'),
      /\[ModularJS\].*:=.*symbole \$.*« \$x = 2 »/s
    )
  })

  it("non-régression — `x := 'v'` SANS symbole $ reste INTACT (Civet natif, jamais concerné par le garde-fou)", () => {
    assert.doesNotThrow(() => cleanJs("x := 'v'"))
    assert.equal(cleanJs("x := 'v'"), "x := 'v'")
  })

  it("non-régression — `$x = 2` (auto-déclaration standard, sans :=) continue de réécrire en `$.x = 2`", () => {
    assert.equal(cleanJs('$x = 2'), '$.x = 2')
  })

  it("non-régression — motif réel du generator `$x = $x + 1` (cf. tests/handlers-civet.test.ts) compile identiquement", () => {
    assert.equal(cleanJs('$x = $x + 1'), '$.x = $.x + 1')
  })

  it("non-régression — `$x += 1` (compound assignment, motif réel supporté) n'est pas affecté par le garde-fou", () => {
    assert.equal(cleanJs('$x += 1'), '$.x += 1')
  })

  it("non-régression — la snapshot MJS `$x =: expr` (opérateur INVERSE `=:`, sans rapport) reste inchangée", () => {
    assert.doesNotThrow(() => cleanJs('$x =: 2'))
    assert.equal(cleanJs('$x =: 2'), '$.x = µ.snap(2)')
  })

  it('exemption — un $xxx importé (externalVars) ne throw pas (préservé tel quel, jamais réécrit en $.xxx, `:=` y reste valide)', () => {
    assert.doesNotThrow(() => cleanJs('$imported := 2', ['$imported']))
    assert.equal(cleanJs('$imported := 2', ['$imported']), '$imported := 2')
  })
})

describe('civet-sigil-declare-operator — expressions de template (bout-en-bout, transpile réel)', function () {
  this.timeout(8000)

  it('`<button @click={$x := 2}>` : transpile() rejette avec l\'erreur MJS pédagogique (pas de JS invalide silencieux dans le bundle)', async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<button @click={$x := 2}>go</button>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'sigildeclaretpl1', defaultScriptLang: 'civet' }),
      /\[ModularJS\].*:=.*« \$x = 2 »/s
    )
  })

  it("`<p>{$x := 2}</p>` (interpolation) : transpile() rejette aussi avec un message pédagogique clair (préview parfois suffixée par l'artefact préexistant de getEffectVars, cf. commentaire de tête — non-régression sur la FAMILLE du message, pas sur son octet près)", async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<p>{$x := 2}</p>',
    ].join('\n')
    await assert.rejects(
      () => transpile(src, { moduleName: 'sigildeclaretpl2', defaultScriptLang: 'civet' }),
      /\[ModularJS\].*:=.*l'opérateur de déclaration Civet.*« \$x = 2/s
    )
  })

  it('non-régression — `@click={$x = 2}` (auto-déclaration standard) compile toujours', async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<button @click={$x = 2}>go</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'sigildeclaretpl3', defaultScriptLang: 'civet' })
    assert.match(output, /µ\._set\(_mjsThis, 'x', 2\)/)
  })

  it('non-régression — `@click={$x += 1}` (compound assignment, motif réel supporté) compile toujours', async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<button @click={$x += 1}>go</button>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'sigildeclaretpl4', defaultScriptLang: 'civet' })
    assert.match(output, /µ\._set\(_mjsThis, 'x', \$\.x \+ \(1\)\)/)
  })

  it("exemption — `@click={$imported := 2}` avec `$imported` ∈ externalVars ne throw pas (identifiant Civet ordinaire, jamais réécrit en $.imported)", async () => {
    const src = [
      '<script lang="civet">',
      '$x = 1',
      '</script>',
      '<button @click={$imported := 2}>go</button>',
    ].join('\n')
    const { output } = await transpile(src, {
      moduleName: 'sigildeclaretpl5',
      defaultScriptLang: 'civet',
      externalVars: ['$imported'],
    })
    assert.match(output, /const \$imported = 2/)
  })
})
