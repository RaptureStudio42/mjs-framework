// Pass 1 (`applyCivetDialectSugar`, src/transpiler/index.ts) — un `#` DANS un littéral regex n'est
// jamais un commentaire. Avant le fix, la boucle
// caractère-par-caractère de la Pass 1 ne connaissait pas les littéraux regex : `re = /#\d/` voyait
// son `#` (suivi de `\`, non alphanumérique) converti comme un commentaire Coffee ordinaire →
// `re = ///\d/` — échec de compilation, bruyant mais FAUX (`/#\d/` est un regex légitime). Modèle :
// `transformCodeOnly` (même fichier), qui teste `//`, `/*` PUIS `ouvreUneRegex`/`scanRegexLiteral`.

import assert from 'node:assert/strict'
import { transpile, applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('Pass 1 — # dans un littéral regex, jamais un commentaire', () => {
  it('(a) re = /#\\d/ : le littéral reste intact, jamais avalé en commentaire ; transpile() réussit (ROUGE avant fix)', async () => {
    const out = applyMjsSugarToScript('re = /#\\d/', 'civet')
    assert.match(out, /\/#\\d\//, 'le littéral /#\\d/ ressort intact de la Pass 1')
    assert.doesNotMatch(out, /\/\/\/\\d\//, 'jamais réécrit ///\\d/ (le # interne avalé en commentaire jusqu\'à la fin de ligne)')

    const src = '<script>\n  re = /#\\d/\n</script>\n<p>x</p>\n'
    const { output } = await transpile(src, { moduleName: 'card' })
    assert.match(output, /µ\._def\(/, 'transpile() résout sans échec de compilation sur le regex #')
  })

  it('(b) x = 1 # vrai commentaire : toujours converti en // (non-régression)', () => {
    const out = applyMjsSugarToScript('x = 1 # vrai commentaire', 'civet')
    assert.match(out, /\/\/ vrai commentaire/)
    assert.doesNotMatch(out, /#\s*vrai/)
  })

  it("(c) s = '#fff' : # dans une chaîne, intact (non-régression)", () => {
    const out = applyMjsSugarToScript("s = '#fff'", 'civet')
    assert.match(out, /'#fff'/)
  })

  it('(d) n = a / b # c : division intacte, # c converti en commentaire (non-régression)', () => {
    const out = applyMjsSugarToScript('n = a / b # c', 'civet')
    assert.match(out, /a \/ b/, 'la division survit, jamais prise pour une regex')
    assert.match(out, /\/\/ c/, 'le commentaire de fin de ligne est bien converti')
    assert.doesNotMatch(out, /#\s*c/)
  })
})
