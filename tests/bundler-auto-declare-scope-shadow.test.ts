// Test de régression :
// `autoDeclareTopLevelBareAssignments` (src/bundler/index.ts) répare les
// assignations top-level bares que Civet laisse telles quelles (`foo = 1`,
// illégal en module ESM strict) en leur préfixant `var `. Pour savoir SI un
// identifiant a déjà une déclaration (et n'a donc pas besoin de `var`), la
// fonction scannait TOUTES les lignes du fichier compilé — y compris celles
// INDENTÉES (corps de fonction/bloc).
//
// Bug : une déclaration LOCALE à une fonction imbriquée (`let count = 5`
// dans `tick`) peuplait le Set `declared` au même titre qu'une déclaration
// RÉELLEMENT top-level. Si le fichier contient PAR AILLEURS une assignation
// bare top-level HOMONYME (`count = 0` en tête de fichier), la fonction
// croyait à tort que `count` était « déjà déclaré » et ne préfixait PAS
// `var` — l'assignation top-level restait bare → `ReferenceError: count is
// not defined` en strict mode ESM au chargement, alors que le build ne
// signalait RIEN (silencieux, vert).
//
// Fix : le scan de collecte des déclarations ignore désormais les lignes
// indentées — même heuristique que celle déjà utilisée pour repérer les
// assignations bare elles-mêmes (une déclaration DANS une fonction ne peut
// de toute façon jamais satisfaire le besoin d'un `var` top-level, portées
// distinctes).
//
// Note méthodo : le compilateur Civet réel infère très bien la portée dans
// la quasi-totalité des cas simples (vérifié empiriquement sur une dizaine
// de constructions) — forcer CE scénario précis via du VRAI code Civet
// compilé s'est avéré peu fiable. `autoDeclareTopLevelBareAssignments` est
// une fonction PURE, exportée pour ce test : on vérifie directement son
// contrat sur une entrée représentative de sa sortie documentée (post-Civet,
// pré-ESM), ce qui est plus précis qu'une dépendance à l'inférence de scope
// changeante d'un compilateur tiers.

import assert from 'node:assert/strict'
import { autoDeclareTopLevelBareAssignments } from '../src/bundler/index.js'

describe('bundler — autoDeclareTopLevelBareAssignments (shadowing de portée)', function () {
  it("une déclaration LOCALE à une fonction ne doit PAS masquer une assignation bare top-level homonyme", function () {
    const input = [
      'count = 0',
      'function tick() {',
      '  let count = 5',
      '  return count',
      '}',
    ].join('\n')
    const output = autoDeclareTopLevelBareAssignments(input)
    const topLine = output.split('\n')[0]
    assert.equal(topLine, 'var count = 0',
      "AVANT le fix : `let count` DANS tick() peuplait `declared` avec 'count' → la ligne top-level restait bare (`count = 0` sans `var`) → ReferenceError en strict mode ESM au chargement")
    // La déclaration locale à tick() ne doit évidemment pas être touchée.
    assert.ok(output.includes('  let count = 5'), 'la déclaration locale ne doit pas être altérée')
  })

  it("une déclaration top-level RÉELLE (avant la bare) continue d'empêcher le préfixage (pas de régression)", function () {
    const input = [
      'let foo = 1',
      'foo = 2',
    ].join('\n')
    const output = autoDeclareTopLevelBareAssignments(input)
    assert.equal(output, input, "`foo` est déjà déclaré top-level (let) — la réassignation bare ne doit PAS recevoir un second `var`")
  })

  it('plusieurs fonctions imbriquées avec des locales homonymes DIFFÉRENTES de la bare top-level : comportement inchangé', function () {
    const input = [
      'total = 0',
      'a = function() {',
      '  let x = 1',
      '  return x',
      '}',
      'b = function() {',
      '  let y = 2',
      '  return y',
      '}',
    ].join('\n')
    const output = autoDeclareTopLevelBareAssignments(input)
    const lines = output.split('\n')
    assert.equal(lines[0], 'var total = 0')
    assert.equal(lines[1], 'var a = function() {')
    assert.equal(lines[5], 'var b = function() {')
  })

  it('une assignation bare INDENTÉE (dans une fonction) reste intacte — comportement documenté, pas touché par ce fix', function () {
    const input = [
      'function helper() {',
      '  z = 42',
      '  return z',
      '}',
    ].join('\n')
    const output = autoDeclareTopLevelBareAssignments(input)
    assert.equal(output, input, 'les lignes indentées ne sont jamais préfixées, cycle ou pas — seul le TOP-LEVEL est concerné par cette fonction')
  })
})
