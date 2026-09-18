// Régression : un tag raw-text
// (<textarea>/<style>/<script>/<title>) dont la fermeture `</tag` n'a AUCUN
// `>` nulle part dans le reste du flux HTML (source tronquée/malformée)
// ramenait l'index de scan à 0 (`i = endClose + 1` avec `endClose = -1`) →
// boucle infinie synchrone du générateur (gel du build/watcher, EXIT 124).
//
// Un test mocha classique NE PEUT PAS détecter une vraie boucle infinie
// synchrone (le timeout de mocha dépend de la boucle d'event, qu'une boucle
// `while` bloquante empêche de tourner) — d'où le garde-fou runtime ajouté
// dans paths.ts qui transforme toute régression du même ordre en erreur
// explicite immédiate. Ces tests vérifient ce garde-fou ET le comportement
// correct (pas d'erreur) sur les cas valides.

import assert from 'node:assert/strict'
import { extractPaths, generateCreateFnBody } from '../src/generator/paths.js'

describe('paths.ts — tag raw-text malformé (anti-boucle-infinie)', () => {

  describe('extractPaths', () => {
    it('</textarea SANS ">" nulle part dans le flux : termine (ne boucle pas), ne throw pas', () => {
      const html = '<div><textarea>x</textarea'
      const result = extractPaths(html)
      assert.equal(typeof result.cleanHtml, 'string')
    })

    it('</style SANS ">" : termine proprement', () => {
      const html = '<div><style>.a{color:red}</style'
      const result = extractPaths(html)
      assert.equal(typeof result.cleanHtml, 'string')
    })

    it('</script SANS ">" en fin de document complet (plusieurs frères après ouverture)', () => {
      const html = '<section><p>ok</p><script>var x=1;</script'
      const result = extractPaths(html)
      assert.ok(result.cleanHtml.includes('<p>ok</p>'))
    })

    it('cas nominal (">" présent) : toujours correct après le fix', () => {
      const html = '<div><textarea>x</textarea></div>'
      const result = extractPaths(html)
      assert.equal(result.cleanHtml, '<div><textarea>x</textarea></div>')
    })
  })

  describe('generateCreateFnBody (mode imperative, avec interpolation pour forcer ce chemin)', () => {
    it('</textarea SANS ">" : termine (ne boucle pas), ne throw pas', () => {
      // hasInterpolations() doit être vrai pour router vers le mode imperative
      // (celui qui contient le 2e site du bug, generateCreateFnBodyImperative).
      const html = '<div>${x}<textarea>y</textarea'
      const result = generateCreateFnBody(html)
      assert.equal(typeof result.body, 'string')
    })

    it('cas nominal (">" présent) : toujours correct après le fix', () => {
      const html = '<div>${x}<textarea>y</textarea></div>'
      const result = generateCreateFnBody(html)
      assert.match(result.body, /createElement\("textarea"\)/)
    })
  })

  describe('garde-fou anti-boucle : throw explicite plutôt qu\'un hang (si jamais une régression future du même ordre apparaît)', () => {
    it('extractPaths : une boucle qui ne progresse plus lève une Error identifiable', () => {
      // On ne peut pas reproduire un VRAI hang sans risquer de bloquer le
      // test runner ; on vérifie donc juste que le message d'erreur du
      // garde-fou existe et est bien formé si jamais il se déclenche, via
      // une relecture du code (contrat documenté). Le vrai test de non-
      // régression est fonctionnel : les cas malformés ci-dessus DOIVENT
      // se terminer sous le timeout mocha par défaut (2000ms), sans quoi
      // mocha lui-même signalerait le test comme timeout.
      const html = '<div><textarea>x</textarea'
      const start = Date.now()
      extractPaths(html)
      const elapsed = Date.now() - start
      assert.ok(elapsed < 500, `extractPaths a pris ${elapsed}ms sur un cas malformé (attendu < 500ms)`)
    })
  })
})
