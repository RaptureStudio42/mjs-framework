// findMacroTagEnd — le scanner de fin de balise des macros racines (<@window>, <@document>,
// <@body>, <@html>, <@head>, <@element>, <@module>, <@failed>) traitait un backtick rencontré EN
// PROFONDEUR (dans un attribut `{…}`) comme une chaîne ORDINAIRE, refermée au PROCHAIN backtick
// littéral tout court — sans compter les niveaux `${…}`, contrairement au lexer
// (scanTemplateAt/scanInterpAt, src/lexer/index.ts). Un gabarit imbriqué dans l'interpolation
// d'un autre gabarit (`` `a${ `x}y` }b` ``) refermait donc l'attribut TROP TÔT : le `}` du texte
// "x}y" (qui aurait dû rester protégé DANS la chaîne nichée) décrémentait la profondeur `{`/`}`
// de la balise elle-même, et le scan retombait en mode normal au milieu du gabarit — trouvé en
// revue le 23/09, prouvé par exécution directe de la fonction.

import assert from 'node:assert/strict'
import { findMacroTagEnd } from '../src/transpiler/macro-tag.js'

describe('findMacroTagEnd — gabarit (backtick) imbriqué dans un attribut de macro racine', () => {
  it('un backtick niché dans l\'interpolation d\'un gabarit ne referme pas la balise en avance', () => {
    // <@window @click={ tpl = `a${ `x}y` }b` ; if (1 > 0) { z=1 } } data-x="1">RESTE
    const html = '<@window @click={ tpl = `a${ `x}y` }b` ; if (1 > 0) { z=1 } } data-x="1">RESTE'
    const from = '<@window'.length
    const end  = findMacroTagEnd(html, from)
    assert.notEqual(end, -1, 'la balise doit être reconnue comme fermée')
    assert.equal(html[end], '>', 'le caractère trouvé doit être le VRAI > final')
    assert.equal(html.slice(end + 1), 'RESTE', 'AVANT le fix : le scan retombait sur le > de "1 > 0", laissant fuir du code comme texte du document')
  })

  it('contrôle — un simple gabarit SANS imbrication, dans le même contexte, fonctionnait déjà', () => {
    const html = '<@window @click={ tpl = `bonjour` }>RESTE'
    const from = '<@window'.length
    const end  = findMacroTagEnd(html, from)
    assert.equal(html.slice(end + 1), 'RESTE')
  })
})
