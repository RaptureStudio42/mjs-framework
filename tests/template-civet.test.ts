// Interpolations `{…}` du template : les sites EXPRESSION (interpolation texte, valeur d'attribut,
// condition {if}/{elsif}/@class{}/@style{}/@flip{}, itérable {for}, expression
// {key}/{const}/{await}) passent par une VRAIE compilation Civet SYNCHRONE
// quand `templateLang === 'civet'` (le défaut) — cf. generator/utils.ts
// (cleanJsExpr, compileGrammarViaCivet). Le repli `templateLang: 'js'` garde
// le chemin regex historique (cleanJs), INCHANGÉ — aucune régression attendue.
//
// Les sites FRAGMENT (têtes de {for}, corps de handlers déjà batchés en
// Civet/Coffee — cf. handlers-civet.test.ts —, callbacks @transition,
// heuristiques de détection filtered) restent sur le chemin regex QUEL QUE
// SOIT templateLang : hors périmètre ici, non testés.

import assert from 'node:assert/strict'
import * as acorn from 'acorn'
import { transpile } from '../src/transpiler/index.js'
import { _civetExprCacheMisses } from '../src/generator/utils.js'

describe('template {…} — Civet par défaut', () => {
  it('(a) ternaire ESPACÉ compile, la sortie contient le ternaire ET `===` (drift == → === assumé, attesté)', async () => {
    const { output } = await transpile(
      `<p>{$n == 1 ? 'clic' : 'clics'}</p>`,
      { moduleName: 'tc-ternaire-drift' }
    )
    assert.match(output, /\$\.n === 1 \? 'clic' : 'clics'/, 'le ternaire doit survivre ET `==` doit devenir `===` (drift civet assumé, cf. parseOptions.coffeeEq)')
  })

  it("(b) `$todos.filter (t) -> not t.done` (flèche Coffee + not) compile via Civet", async () => {
    const { output } = await transpile(
      `<script>$todos = [{done:true},{done:false}]</script><p>{$todos.filter (t) -> not t.done}</p>`,
      { moduleName: 'tc-filter-not' }
    )
    assert.match(output, /\$\.todos\.filter\(function\(t\) \{ return !t\.done \}\)/, 'flèche Coffee → function(), `not` → `!`, tout compilé nativement par Civet')
  })

  it("(c) ternaire COLLÉ `a?'b':'c'` (+ variante numérique `a?1:2`) : throw avec l'erreur orientante « échec de compilation Civet » + indice « ajoute des espaces »", async () => {
    await assert.rejects(
      transpile(`<p>{$ok?'a':'b'}</p>`, { moduleName: 'tc-ternaire-colle' }),
      (err: any) => {
        assert.match(err.message, /\[ModularJS\] interpolation : échec de compilation Civet/, 'préfixe orientant attendu')
        assert.match(err.message, /« tc-ternaire-colle »/, 'nom du module cité (best-effort, cf. state.moduleName)')
        assert.match(err.message, /« \$ok\?'a':'b' »/, "l'expression source (avant toute passe) est citée telle qu'écrite par l'utilisateur")
        assert.match(err.message, /ajoute des espaces.*a \?\? b/s, 'indice ternaire collé + équivalence ?? attendus (même schéma que les handlers)')
        return true
      }
    )
    // variante numérique (isnt dans les gabarits) : même piège, même indice —
    // la normalisation isnt (mapCodeSegments) ne doit rien changer à ce comportement
    await assert.rejects(
      transpile(`<p>{$a?1:2}</p>`, { moduleName: 'tc-ternaire-colle-numerique' }),
      (err: any) => {
        assert.match(err.message, /\[ModularJS\] interpolation : échec de compilation Civet/, 'préfixe orientant attendu')
        assert.match(err.message, /ajoute des espaces.*a \?\? b/s, 'indice ternaire collé + équivalence ?? attendus')
        return true
      }
    )
  })

  it("(d) le MÊME composant en templateLang:'js' : le ternaire collé passe (JS valide, aucun throw) et `==` reste `==` (repli inchangé)", async () => {
    const { output } = await transpile(
      `<p>{$ok?'a':'b'}</p>`,
      { moduleName: 'tc-ternaire-colle-js', templateLang: 'js' }
    )
    assert.match(output, /\$\.ok\?'a':'b'/, 'un ternaire collé est du JS valide tel quel — aucune réécriture en mode js (contrairement au batch handlers, recompilé en Coffee)')

    const { output: output2 } = await transpile(
      `<p>{$n == 1 ? 'clic' : 'clics'}</p>`,
      { moduleName: 'tc-loose-eq-js', templateLang: 'js' }
    )
    assert.match(output2, /\$\.n == 1 \? 'clic' : 'clics'/, 'le repli `js` ne touche jamais `==` (pas de drift hors mode civet)')
    assert.doesNotMatch(output2, /\$\.n === 1/, '`==` ne doit PAS devenir `===` en mode js')
  })

  it('(e) {if $a > 3}/{elsif}/{for i, t in $liste by id}/{key}/{await} compilent dans les DEUX modes (aucun changement structurel)', async () => {
    const tpl = `<script>
$a = 5
$liste = [{id: 1, name: 'un'}, {id: 2, name: 'deux'}]
$promise = Promise.resolve(1)
</script>
<div>
{if $a > 3}
  <p>grand</p>
{elsif $a > 0}
  <p>petit</p>
{else}
  <p>zero</p>
{end}
{for i, t in $liste by id}
  {key t.id}<span>{t.name}</span>{end}
{end}
{await $promise}
  chargement
{success val}
  <p>{val}</p>
{error err}
  <p>{err.message}</p>
{end}
</div>`

    for (const templateLang of ['civet', 'js'] as const) {
      const { output } = await transpile(tpl, { moduleName: `tc-blocks-${templateLang}`, templateLang })
      // Sortie = module JS complet valide (mêmes garanties que snapshot-stats.mjs,
      // même neutralisation du placeholder `µ.asset(...)` résolu par le bundler).
      const cleaned = output.replace(/µ\.asset\(['"]([^'"]+)['"]\)/g, "'/__placeholder/$1'")
      assert.doesNotThrow(() => acorn.parse(cleaned, { ecmaVersion: 'latest', sourceType: 'module' }), `sortie JS invalide en templateLang:'${templateLang}'`)
      assert.match(output, /_mjs_updItemIf|_c_if\d+/, `{if}/{elsif} absent en templateLang:'${templateLang}'`)
      assert.match(output, /_mjs_updFor|_mjs_updList/, `{for} absent en templateLang:'${templateLang}'`)
      assert.match(output, /_mjs_updAwait/, `{await} absent en templateLang:'${templateLang}'`)
    }
  })

  it('(f) expression chargée en symboles `µ.url.path + $x + &id` compile en civet', async () => {
    const { output } = await transpile(
      `<p>{µ.url.path + $x + &id}</p>`,
      { moduleName: 'tc-symbols-mix' }
    )
    assert.match(output, /µ\.url\.path \+ \$\.x \+ µ\.url\.params\.id/, 'µXxx/$x/&id (passe symboles) puis compilation civet transparente de la grammaire (aucun idiome ici, mais atteste que la passe symboles est civet-valide de bout en bout)')
  })

  it("(g) cache mémo : 2 composants partageant la MÊME expression ne recompilent Civet qu'UNE fois", async () => {
    const before = _civetExprCacheMisses()
    await transpile(`<p>{if $tcCacheProbeUnique412 > 41}<b>x</b>{end}</p>`, { moduleName: 'tc-cache-a' })
    const afterFirst = _civetExprCacheMisses()
    assert.ok(afterFirst > before, 'la 1re occurrence doit compiler via Civet (cache MISS)')

    await transpile(`<p>{if $tcCacheProbeUnique412 > 41}<b>y</b>{end}</p>`, { moduleName: 'tc-cache-b' })
    const afterSecond = _civetExprCacheMisses()
    assert.equal(afterSecond, afterFirst, 'la MÊME expression dans un 2e composant doit venir du cache (aucun appel Civet supplémentaire)')
  })

  it("(h) `{...$props}` spread et `--var={$x}` (custom property) inchangés (sites EXPR, sortie stable)", async () => {
    const { output } = await transpile(
      `<script>$props = {title: 'x'}\n$x = 42</script><mjs-info {...$props} --accent={$x}></mjs-info>`,
      { moduleName: 'tc-spread-customprop' }
    )
    assert.match(output, /_mjs_spd = \$\.props/, 'spread {...$props} toujours résolu en site EXPR (jsVar = $.props)')
    // `--accent={$x}` passe par bindingStyle → expression PLEINE évaluée brute
    // (`_mjs_v = ($.x)`, null/undefined testés avant conversion) puis
    // `setProperty` la pose (chaîne `_mjs_s`, priorité détachée si `!important`).
    assert.match(output, /_mjs_v = \(\$\.x\)/, 'custom property --accent={$x} : la valeur EXPR ($.x) doit être évaluée brute dans _mjs_v')
    assert.match(output, /setProperty\('--accent', _mjs_s\)/, 'custom property --accent={$x} toujours posée via setProperty')
    const cleaned = output.replace(/µ\.asset\(['"]([^'"]+)['"]\)/g, "'/__placeholder/$1'")
    assert.doesNotThrow(() => acorn.parse(cleaned, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  // ── isnt dans les gabarits ────────────
  // `isnt` (Coffee) n'est pas compris nativement par Civet : `a isnt b` s'y
  // parse comme l'appel `a(isnt(b))` (ReferenceError silencieux au runtime,
  // 7 gabarits morts au rendu). `compileGrammarViaCivet` (generator/utils.ts)
  // normalise désormais `isnt` → `is not` AVANT compilation Civet, hors
  // chaînes/commentaires (mapCodeSegments), avec la même garde prudente que
  // `applyGrammarRegex` (`.isnt` propriété et `isnt:` clé intacts).

  it('(i) `$a isnt null` (isnt gabarit) : sortie contient `!==`, zéro `isnt(` (miscompile silencieux corrigé)', async () => {
    const { output } = await transpile(
      `<p>{$a isnt null}</p>`,
      { moduleName: 'tc-isnt-gabarit' }
    )
    assert.match(output, /\$\.a !== null/, '`isnt` doit être normalisé en `is not` puis compilé par Civet en `!==`')
    assert.doesNotMatch(output, /isnt\(/, "aucun résidu `isnt(` (l'ancien miscompile silencieux)")
  })

  it("(j) `isnt` en LITTÉRAL chaîne (`$mode is 'isnt'`) reste intact (mapCodeSegments protège les chaînes)", async () => {
    const { output } = await transpile(
      `<p>{$mode is 'isnt'}</p>`,
      { moduleName: 'tc-isnt-string' }
    )
    assert.match(output, /\$\.mode === 'isnt'/, "le littéral 'isnt' ne doit JAMAIS être réécrit en 'is not'")
  })

  it('(k) `isnt` en PROPRIÉTÉ/CLÉ (`({isnt: 1}).isnt`) reste intact — même garde que `applyGrammarRegex`', async () => {
    const { output } = await transpile(
      `<p>{({isnt: 1}).isnt}</p>`,
      { moduleName: 'tc-isnt-property' }
    )
    assert.match(output, /\(\{isnt: 1\}\)\.isnt/, 'ni la clé `isnt:` ni la propriété `.isnt` ne doivent être corrompues en `is not`')
  })

  it('(l) ternaire ESPACÉ `$a ? 1 : 2` compile toujours après la normalisation isnt (PIN : aucun refus introduit)', async () => {
    const { output } = await transpile(
      `<p>{$a ? 1 : 2}</p>`,
      { moduleName: 'tc-isnt-ternaire-pin' }
    )
    assert.match(output, /\$\.a \? 1 : 2/, 'le ternaire espacé doit rester intact, la normalisation isnt ne doit affecter aucun autre idiome')
  })

  it('(m) intégration : `{if $x isnt null}…{end}` compilé de bout en bout — `!==` présent, zéro `isnt(`', async () => {
    const tpl = `<script>
$x = 1
</script>
<div>
{if $x isnt null}
  <p>oui</p>
{end}
</div>`
    const { output } = await transpile(tpl, { moduleName: 'tc-isnt-integration' })
    assert.match(output, /\$\.x !== null/, 'la condition {if} doit compiler isnt en !==')
    assert.doesNotMatch(output, /isnt\(/, 'aucun résidu `isnt(` dans le composant compilé')
    const cleaned = output.replace(/µ\.asset\(['"]([^'"]+)['"]\)/g, "'/__placeholder/$1'")
    assert.doesNotThrow(() => acorn.parse(cleaned, { ecmaVersion: 'latest', sourceType: 'module' }), 'sortie JS invalide')
  })
})
