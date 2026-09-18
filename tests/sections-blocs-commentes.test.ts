// Un bloc mis en COMMENTAIRE HTML doit rester INERTE — trou constaté sur les deux
// blocs neufs du mois : `<theme>` et `<style name="…">` étaient extraits par expression régulière
// SANS masquage des commentaires. Mettre une ancienne version de côté en la commentant la
// RALLUMAIT : `themes: ["dark"]` depuis un commentaire, et — pire — si l'active portait le même
// nom, la compilation échouait sur « deux blocs <theme name="dark"> » ; seule, la version commentée
// REMPLAÇAIT silencieusement l'active. Le bloc `<routes>`, juste en dessous dans le même fichier,
// recevait déjà ce masquage (avec le commentaire qui l'explique), et `directives.ts` aussi.

import assert from 'node:assert/strict'
import { extractSections } from '../src/transpiler/sections.js'

describe('sections : un bloc en commentaire HTML est INERTE', () => {
  it('<theme> commenté : aucun thème extrait', () => {
    const src = '<div>x</div>\n<!-- ancienne version, gardée en référence :\n<theme name="dark">$$accent: black</theme>\n-->\n'
    assert.deepEqual(extractSections(src).themes.map(t => t.name), [])
  })

  it('contre-cas : le même <theme> HORS commentaire est bien extrait', () => {
    const src = '<div>x</div>\n<theme name="dark">$$accent: black</theme>\n'
    assert.deepEqual(extractSections(src).themes.map(t => t.name), ['dark'])
  })

  it('<theme> commenté + <theme> ACTIF de même nom : plus d\'erreur « theme-double »', () => {
    const src = '<div>x</div>\n<!--\n<theme name="dark">$$accent: black</theme>\n-->\n<theme name="dark">$$accent: navy</theme>\n'
    const r = extractSections(src)
    assert.deepEqual(r.themes.map(t => t.name), ['dark'])
    assert.match(r.themes[0].raw, /navy/, 'c\'est la version ACTIVE qui doit gagner, jamais la commentée')
  })

  it('<style name="…"> commenté : aucun variant extrait', () => {
    const src = '<div>x</div>\n<!--\n<style name="old">.x{color:green}</style>\n-->\n'
    assert.deepEqual(extractSections(src).layouts.map(l => l.name), [])
  })

  it('contre-cas : le même <style name> HORS commentaire est bien extrait', () => {
    const src = '<div>x</div>\n<style name="old">.x{color:green}</style>\n'
    assert.deepEqual(extractSections(src).layouts.map(l => l.name), ['old'])
  })

  it('<style> de BASE commenté : le style du composant reste vide, pas d\'erreur « style-double »', () => {
    const src = '<div>x</div>\n<!--\n<style>.a{color:red}</style>\n-->\n<style>.b{color:blue}</style>\n'
    const r = extractSections(src)
    assert.match(r.style.raw, /color:blue/)
    assert.doesNotMatch(r.style.raw, /color:red/)
  })

  it('non-régression — <routes> commenté reste inerte (masquage déjà en place)', () => {
    const src = '<div>x</div>\n<!--\n<routes target="#vue">\n/a → page-a\n</routes>\n-->\n'
    assert.deepEqual(extractSections(src).routes, [])
  })

  it('le commentaire lui-même n\'est pas consommé : il ressort dans le HTML', () => {
    const src = '<div>x</div>\n<!--\n<theme name="dark">$$accent: black</theme>\n-->\n'
    assert.match(extractSections(src).html, /<!--/, 'le commentaire doit rester dans le HTML, masqué ≠ supprimé')
  })

  // le masquage tourne sur une vue déjà « inertée » (chaînes/commentaires CSS) : une apostrophe
  // française dans du texte HTML ne doit pas décaler les plages de commentaire
  it('apostrophes françaises dans le HTML : le masquage ne dérape pas', () => {
    const src = "<p>C'est l'été, l'heure d'y aller</p>\n<!--\n<theme name=\"dark\">$$accent: black</theme>\n-->\n<theme name=\"clair\">$$accent: white</theme>\n"
    assert.deepEqual(extractSections(src).themes.map(t => t.name), ['clair'])
  })

  // un `<!--` JAMAIS refermé ne doit rien masquer (motif lazy exigeant `-->`)
  it('commentaire jamais refermé : aucun masquage, le bloc actif reste vu', () => {
    const src = '<div>x</div>\n<!-- oups, pas de fermeture\n<theme name="dark">$$accent: black</theme>\n'
    assert.deepEqual(extractSections(src).themes.map(t => t.name), ['dark'])
  })

  // le garde-fou « balise orpheline » reste STRICT sur `</script>` (l'extraction des scripts tourne
  // AVANT le masquage : un `</script>` commenté ne peut pas venir d'un bloc rendu inerte)
  it('garde orpheline : `</script>` reste refusé même en commentaire, `</style>` ne l\'est plus', () => {
    assert.throws(() => extractSections('<div>x</div>\n<!-- </script> -->\n'), /orphelin/)
    assert.doesNotThrow(() => extractSections('<div>x</div>\n<!-- </style> -->\n'))
    assert.throws(() => extractSections('<div>x</div>\n</style>\n'), /orphelin/)
  })
})
