// Gardes « hors du <script> » et commentaires — µderived et hooks de cycle de vie.
//
// Trou JUMEAU de celui déjà corrigé sur µevery et µread/µwrite :
// ces deux gardes étaient posés en `.replace()` LEVANT au milieu de la chaîne de sucre,
// donc testés sur le texte brut. mapCodeSegments masque les chaînes, pas les commentaires
// — et le commentaire inline est la norme du projet : `// hook : µmount -> foo` dans un
// handler faisait ÉCHOUER LE BUILD. Ils passent maintenant par sansCommentaires, comme
// les deux autres, et sont testés AVANT la chaîne (donc a fortiori avant µ-short, dont
// l'ordre relatif comptait : µurlChange ⊃ µurl).
//
// Contre-épreuve intégrée : les cas « VRAI code » ci-dessous tombent si la neutralisation
// des commentaires devient trop large (c'est exactement la régression qu'a produite la
// première version large du correctif µread, cf. rune-read-write-parentheses.test.ts).

import { strict as assert } from 'node:assert'
import { cleanJs } from '../src/generator/utils.ts'

describe('gardes hors-script — le mot CITÉ dans un commentaire ne casse pas le build', function () {
  const cites: Array<[string, string]> = [
    ['ligne //, µderived',        '// exemple : µderived $x = 1\na = 1'],
    ['ligne //, µmount',          '// hook : µmount -> foo\na = 1'],
    ['ligne //, µurlChange',      '// on branche µurlChange ailleurs\na = 1'],
    ['bloc /* */, µdestroy',      '/* µdestroy -> stop() */\na = 1'],
    ['bloc multi-lignes, µsleep', '/* on parle\n   de µsleep ici */\na = 1'],
    ['commentaire Coffee, µawake', '# µawake -> go\na = 1']
  ]
  for (const [nom, src] of cites) {
    it(nom, () => assert.doesNotThrow(() => cleanJs(src)))
  }

  // …et le VRAI code reste refusé (contre-épreuve : ces cas passent si le garde s'aveugle)
  const refuses: Array<[string, string, RegExp]> = [
    ['µderived nu',                    'µderived $x = 1',            /µderived/],
    ['µmount nu',                      'µmount -> foo',              /µmount/],
    ['µurlChange nu',                  'µurlChange (p) -> f(p)',     /µurlChange/],
    ['µmount en commentaire de FIN',   'a = 1  // µmount -> foo',    /µmount/],
    ['µderived après un regex piégeux', 'u = /http:\\/\\//\nµderived $x = 1', /µderived/]
  ]
  for (const [nom, src, motif] of refuses) {
    it(`refusé : ${nom}`, () => assert.throws(() => cleanJs(src), motif))
  }

  it('le nom du hook est bien celui du code, pas un autre', () =>
    assert.throws(() => cleanJs('µsleep -> f()'), /µsleep/))

  it('précédé d\'un point : jamais une rune, accès de propriété intact', () => {
    assert.equal(cleanJs('obj.µmount = 1'), 'obj.µmount = 1')
  })

  // ancien témoin (`a = µmounted` restait LITTÉRAL) : cleanJs n'avait alors NI filet
  // générique pour une rune minuscule hors liste blanche — absence de sucre, pas une
  // garde de longueur voulue. cleanJs porte désormais le MÊME sucre universel
  // µfoo → µ.foo que le script (sigils.ts, MU_UNIVERSAL_BODY, audit des runes
  // manquantes en expression HTML) : la garde des hooks (MU_HOOKS_BODY, lookahead
  // alphanumérique) protège bien `µmounted` d'une confusion avec le hook `µmount`
  // (RE_MU_HOOKS_G ne le voit même pas), mais le sucre universel qui suit, LUI,
  // n'exclut que les runes réservées au lexer par une frontière de MOT (`\b`) — qui
  // n'arrête pas au milieu d'un mot compact comme "mounted" (pas de frontière entre
  // "mount" et "ed" : les deux caractères de part et d'autre sont `\w`). Vérifié
  // empiriquement : le SCRIPT fait EXACTEMENT pareil (`a = µmounted` compile déjà en
  // `a = µ.mounted` via transpile(), avant même ce correctif) — parité assumée, pas
  // une régression propre à cette garde.
  it('un identifiant qui PROLONGE le nom d\'un hook (µmounted) est ALIGNÉ sur le script (pointé)', () => {
    assert.equal(cleanJs('a = µmounted'), 'a = µ.mounted')
  })
})
