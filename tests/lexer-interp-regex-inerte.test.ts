// lexer — scanInterpAt (src/lexer/index.ts) ne reconnaît un `/` comme zone INERTE (donc à
// sauter sans l'interpréter) que pour `//` et `/* */` — jamais pour un littéral REGEX générique
// (`/…/`), contrairement à scanInertAt elle-même (qui, elle, délègue à ouvreUneRegex/
// scanRegexLiteral, cf. sigils.ts) et à skipInertFrom (même fichier). Un backtick DANS un
// littéral regex, à l'intérieur d'une interpolation de gabarit, est donc pris pour un VRAI début
// de gabarit imbriqué — ça décale le comptage et corrompt le texte LITTÉRAL du gabarit voisin
// (un `$foo` de simple texte affiché se fait réécrire en accès réactif `$.foo`). Trouvé en revue
// le 23/09, prouvé par exécution directe de tokenize().

import assert from 'node:assert/strict'
import { tokenize } from '../src/lexer/index.js'

describe('lexer — scanInterpAt : littéral regex non reconnu comme zone inerte', () => {
  it('un backtick DANS un regex, en interpolation, ne doit pas faire muter le texte littéral voisin du gabarit', () => {
    const src = '`texte $foo ici${ /`/.test(1) }b`'
    const out = tokenize(src)
    assert.match(out, /\$foo\b/, 'AVANT le fix : "$foo", texte LITTÉRAL du gabarit, était réécrit en "$.foo" (accès réactif)')
  })
})
