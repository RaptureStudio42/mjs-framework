// un état `$x` et une méthode `@x` du même nom
// occupent la MÊME propriété de l'instance. Le compilateur REFUSAIT autrefois cette cohabitation
// (croyant la collision elle-même fatale). La cause réelle est ailleurs : le
// salvage pré-upgrade de connectedCallback (mjs_element.ts) verse la MÉTHODE dans l'état avant de
// la supprimer. Le runtime épargne désormais les clés fonction homonymes — le compilateur ne
// refuse plus, il ÉMET la liste triée au gabarit (`this._mjs_state_methods = {"nom":1,…};`, collée
// en fin de `this._mjs_var_bits = […];`, cf. transpiler/template.ts).
//
// Le compilateur connaît les deux tables : la collision est détectable sans ambiguïté. Le calcul
// vit dans transpile() (src/transpiler/index.ts), JUSTE APRÈS analyzer.autoDeclareFromTemplate(html)
// — pas dans analyze() : un état né du SEUL template (jamais écrit dans <script>) n'existe qu'après
// cette auto-déclaration. Les tests compilent donc un composant COMPLET (pas analyze() en direct).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('collision état / méthode homonymes', () => {

  it('compile $x et @x du même nom, et émet la collision au gabarit', async () => {
    const src = '<script>\n$crans = 5\n@crans = ->\n  $crans + 1\n</script>\n<p>{$crans}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-basic' })
    assert.match(output, /this\._mjs_state_methods = \{"crans":1\};/, 'jeton émis avec le bon nom')
  })

  it('liste TOUTES les collisions, pas seulement la première', async () => {
    const src = '<script>\n$crans = 5\n$total = 0\n$libre = 1\n@crans = ->\n  1\n@total = ->\n  2\n</script>\n<p>{$crans}{$total}{$libre}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-list' })
    // capture ciblée du jeton (et non de tout `output`, où `_mjs_var_bits` mentionne légitimement
    // `libre` par ailleurs) : la valeur exacte prouve à la fois la présence des deux collisions
    // triées ET l'absence de `libre` dans CE dictionnaire précis.
    const clashLine = output.match(/this\._mjs_state_methods = \{[^}]*\};/)?.[0]
    assert.equal(clashLine, 'this._mjs_state_methods = {"crans":1,"total":1};', 'exactement crans+total, libre exclu')
  })

  it('laisse passer un état et une méthode de noms DIFFÉRENTS — aucun jeton émis', async () => {
    const src = '<script>\n$crans = 5\n@echelle = ->\n  $crans + 1\n</script>\n<p>{$crans}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-diff-names' })
    assert.doesNotMatch(output, /_mjs_state_methods/, 'absence totale du jeton sans collision')
  })

  it('ne confond pas une méthode avec une écriture `@x` NON-fonction, DANS une autre méthode', async () => {
    // `@crans = 1` (RHS = littéral, pas une fonction) À L'INTÉRIEUR de `poser` n'est pas une
    // déclaration de méthode du composant — même nom qu'un état existant, mais pas de collision :
    // le walker exige un RHS FunctionExpression/ArrowFunctionExpression.
    const src = '<script>\n$crans = 5\n@poser = ->\n  @crans = 1\n</script>\n<p>{$crans}</p><button @click={@poser()}>x</button>'
    const { output } = await transpile(src, { moduleName: 'clash-nested-write' })
    assert.doesNotMatch(output, /_mjs_state_methods/, 'écriture interne non-fonction : pas une collision')
  })

  it('ne se déclenche pas sur un composant sans méthode', async () => {
    const src = '<script>\n$a = 1\n$b = $a * 2\n</script>\n<p>{$b}</p>'
    await assert.doesNotReject(transpile(src, { moduleName: 'clash-no-methods' }))
  })

  // ── Cas ajoutés — la MOTIVATION du déplacement de garde ──────

  it('état né du template SEUL (jamais écrit dans <script>) → collision détectée aussi', async () => {
    // `total` n'est JAMAIS assigné via `$total = …` dans le script : à l'instant où analyze()
    // tournait (ANCIEN emplacement de la garde), stateVariables ne contenait pas encore 'total'
    // (autoDeclareFromTemplate n'a pas encore tourné) — la collision aurait été RATÉE.
    const src = '<script>\n@total = ->\n  42\n</script>\n<b>{$total}</b>'
    const { output } = await transpile(src, { moduleName: 'clash-template-only' })
    assert.match(output, /this\._mjs_state_methods = \{"total":1\};/)
  })

  it('forme `@@` (`_mjsThis.x = function…`) → collision détectée aussi', async () => {
    // Le lexer émet `@@crans = ->` en `_mjsThis.crans = function…` — la condition du patch
    // d'origine (object ThisExpression SEULEMENT) ratait cette forme.
    const src = '<script>\n$crans = 5\n@@crans = ->\n  1\n</script>\n<p>{$crans}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-doubleat' })
    assert.match(output, /this\._mjs_state_methods = \{"crans":1\};/)
  })

  it('sanité — méthode `@fmt` + état `$prix` (noms distincts) → compile SANS erreur ni jeton', async () => {
    const src = '<script>\n$prix = 10\n@fmt = ->\n  $prix + 1\n</script>\n<p>{@fmt()}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-sanity-ok' })
    assert.doesNotMatch(output, /_mjs_state_methods/)
  })

  // ── nom qui contient déjà le motif jadis utilisé pour SUGGÉRER un renommage
  // dans le message d'erreur (ce message n'existe plus, la clé catalogue devient
  // inerte) : la détection elle-même doit rester insensible à ce suffixe coïncident ──

  it('nom qui finit déjà par `Liste` (ex: $maListe/@maListe) → détection et jeton corrects malgré le suffixe coïncident', async () => {
    const src = '<script>\n$maListe = []\n@maListe = ->\n  $maListe.length\n</script>\n<p>{$maListe}</p>'
    const { output } = await transpile(src, { moduleName: 'clash-suffix-already' })
    assert.match(output, /this\._mjs_state_methods = \{"maListe":1\};/)
  })
})
