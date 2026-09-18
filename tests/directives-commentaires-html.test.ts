// Directives RACINES × commentaires HTML — trou de fond bouché :
// « on traite le problème à la racine, pour TOUTES les directives d'un coup, dans la passe de
// pré-traitement ». AVANT : `extractDirectives` (transpiler/directives.ts) masquait <pre>/<code>
// mais PAS les commentaires HTML — mettre une directive de côté en la commentant la RALLUMAIT
// (formes actives : @persist, @preload, @i18n…) ou faisait échouer la compilation (formes
// RELOGÉES en attribut de <style> : @css, @display, @viewTransition, @vt), sur une ligne pourtant
// neutralisée par le développeur.

import assert from 'node:assert/strict'
import { extractDirectives } from '../src/transpiler/directives.js'

describe('directives racines : un commentaire HTML est INERTE', () => {
  // formes RELOGÉES — hors commentaire elles throw (message pédagogique vers l'attribut de <style>)
  const relogees = ['@viewTransition={x}', '@viewTransition="zoom"', '@vt="zoom"', '@css nom1 nom2', '@display inline-block']
  for (const ligne of relogees) {
    it(`\`${ligne}\` en commentaire ne fait plus échouer la compilation`, () => {
      const src = `<!-- ${ligne} -->\n<p>ok</p>\n`
      assert.doesNotThrow(() => extractDirectives(src))
      // et le commentaire ressort INTACT (masqué puis restauré, jamais consommé)
      assert.equal(extractDirectives(src).cleaned, src)
    })
    it(`contre-cas : \`${ligne}\` HORS commentaire lève toujours l'erreur`, () => {
      assert.throws(() => extractDirectives(`${ligne}\n<p>ok</p>\n`))
    })
  }

  it('@preload en commentaire : la directive n\'est PAS prise en compte', () => {
    assert.equal(extractDirectives('<!-- @preload hover -->\n<p>ok</p>\n').modulePreload, null)
    assert.equal(extractDirectives('@preload hover\n<p>ok</p>\n').modulePreload, 'hover')
  })

  it('@i18n en commentaire : aucune section de module posée', () => {
    assert.equal(extractDirectives("<!-- @i18n 'panier' -->\n<p>ok</p>\n").moduleI18nSection, null)
    assert.equal(extractDirectives("@i18n 'panier'\n<p>ok</p>\n").moduleI18nSection, 'panier')
  })

  it('@i18n DOUBLE dont une en commentaire : plus d\'erreur « i18n-double »', () => {
    assert.doesNotThrow(() => extractDirectives("@i18n 'panier'\n<!-- @i18n 'ancien' -->\n<p>ok</p>\n"))
  })

  // Le placeholder de masquage porte un NONCE : une suite
  // `\x00MASK…\x00` présente dans le SOURCE ne peut plus se faire remplacer par le contenu d'un
  // <pre>/<code>/commentaire sans rapport (corruption silencieuse, reproduite avant le correctif).
  it('un placeholder de masque LITTÉRAL dans le source n\'est jamais substitué', () => {
    const src = '<p>\x00MASK0\x00</p>\n<pre>secret</pre>\n'
    const { cleaned } = extractDirectives(src)
    assert.equal(cleaned, src)
    assert.ok(!cleaned.includes('secret</p>'), 'aucun contenu masqué ne doit atterrir dans le <p>')
  })

  // Limite ASSUMÉE, pas une régression : sans `-->`, aucun commentaire n'est reconnu — le masquage
  // ne s'applique pas et la directive reste active. On NE masque volontairement PAS jusqu'à la fin
  // du fichier (comportement HTML natif) : un `<!--` isolé neutraliserait alors EN SILENCE toutes
  // les directives suivantes, panne bien pire que l'erreur explicite qu'on obtient ici.
  it('commentaire NON FERMÉ : la directive reste active (limite documentée)', () => {
    assert.throws(() => extractDirectives('<!--\n@css nom1 nom2\n<p>ok</p>\n'))
    // le même source, commentaire FERMÉ : inerte
    assert.doesNotThrow(() => extractDirectives('<!--\n@css nom1 nom2\n-->\n<p>ok</p>\n'))
  })

  it('masques IMBRIQUÉS (<pre> dans un commentaire) : restauration complète, aucun placeholder résiduel', () => {
    const src = '<!-- exemple :\n<pre>@persist $x</pre>\n-->\n<p>ok</p>\n'
    const { cleaned } = extractDirectives(src)
    assert.equal(cleaned, src)
    assert.ok(!cleaned.includes('\x00'), 'aucun placeholder de masque ne doit fuir')
  })
})
