// PARITÉ GRAMMAIRE ↔ COMPILATEUR pour la directive `@viewTransition` (et son alias `@vt`).
//
// Même patron que `vscode-grammar-routes-parity.test.ts`, une différence près qui commande tout :
// une ligne de `<routes>` a UN sens, alors qu'une écriture `@viewTransition` en a QUATRE selon la
// balise qui la porte — `<style>` et `<@view>` attendent un PRÉRÉGLAGE (parmi 13 bases), une balise
// ordinaire attend un nom de MORPH libre, et `<a>` relève d'un autre mécanisme (`@pageTransition`).
// Le nom lui-même n'est vérifié NULLE PART : `µ._vtPresets` s'enrichit
// au runtime, un préréglage maison est donc indiscernable d'une faute de frappe à la compilation.
// La grammaire TextMate, elle, colore un attribut sans savoir dans quelle balise il est posé.
//
// D'où le contrat, plus étroit que celui des routes mais VÉRIFIABLE :
//   A. SOLIDITÉ — tout ce que la grammaire peint en `invalid.…` est refusé par le compilateur dans
//      les QUATRE positions. C'est l'invariant dur : une couleur qui ment une fois se fait ignorer
//      les suivantes.
//   B. MUTISME ASSUMÉ — l'inverse n'est pas exigé. Une écriture refusée partout mais que la
//      grammaire ne sait pas juger sans lire la mini-grammaire des options reste MUETTE, et elle
//      est nommée ci-dessous (`TOLERE_MUET`) plutôt que laissée au hasard.
//   C. UNE SEULE COULEUR — toute forme VALIDE de la directive porte le même scope. Avant ce
//      durcissement elle en portait trois, et la forme fautive `="cube"` était peinte en gestionnaire
//      d'événement : plus vive que la forme juste.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transpile } from '../src/index.js'

const require   = createRequire(import.meta.url)
const vsctm     = require('vscode-textmate')
const oniguruma = require('vscode-oniguruma')

const __dirname = dirname(fileURLToPath(import.meta.url))
const GRAMMAIRE = join(__dirname, '..', 'editors', 'vscode', 'syntaxes', 'modularjs.tmLanguage.json')
const ONIG_WASM = require.resolve('vscode-oniguruma/release/onig.wasm')

let tokenise: (src: string) => { txt: string, scopes: string[] }[]

before(async () => {
  await oniguruma.loadWASM(readFileSync(ONIG_WASM).buffer)
  const registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (s: string[]) => new oniguruma.OnigScanner(s),
      createOnigString:  (s: string)   => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scope: string) => scope === 'text.html.modularjs'
      ? vsctm.parseRawGrammar(readFileSync(GRAMMAIRE, 'utf-8'), 'modularjs.tmLanguage.json')
      : null,
  })
  const grammar = await registry.loadGrammar('text.html.modularjs')
  assert.ok(grammar, 'grammaire text.html.modularjs introuvable')
  tokenise = (src) => {
    let state = vsctm.INITIAL
    return src.split('\n').flatMap((ligne) => {
      const r = grammar.tokenizeLine(ligne, state)
      state = r.ruleStack
      return r.tokens.map((t: { startIndex: number, endIndex: number, scopes: string[] }) =>
        ({ txt: ligne.slice(t.startIndex, t.endIndex), scopes: t.scopes }))
    })
  }
})

// LES QUATRE POSITIONS où la directive peut s'écrire — c'est la liste qui donne son sens au « refusé
// PARTOUT » de la solidité. `<a>` y est parce que `@vt` y avait une vie propre (renommé
// `@pageTransition`) : l'oublier laisserait passer une couleur rouge sur une écriture licite.
const POSITIONS: [string, (attr: string) => string][] = [
  ['<style>', (a) => `<style ${a}></style>\n<p>x</p>`],
  ['<@view>', (a) => `<@view main ${a}>`],
  ['balise',  (a) => `<div ${a}></div>`],
  ['<a>',     (a) => `<a href="/x" ${a}>y</a>`],
]

const aDuRouge = (src: string) => tokenise(src).some(t => t.scopes.some(s => s.startsWith('invalid.')))
const scopesDe = (src: string, txt: string) => tokenise(src).filter(t => t.txt === txt).flatMap(t => t.scopes)

/** dans combien des quatre positions le COMPILATEUR refuse-t-il cette écriture ? */
async function positionsRefusees(attr: string, etiquette: string): Promise<string[]> {
  const refusees: string[] = []
  for (const [nom, envelope] of POSITIONS) {
    try { await transpile(envelope(attr), { moduleName: `vtp-${etiquette}-${nom.replace(/\W/g, '')}` }) }
    catch { refusees.push(nom) }
  }
  return refusees
}

// ---------------------------------------------------------------------------
// LE CORPUS — une écriture par forme, telle qu'elle se tape dans un vrai composant.
// ---------------------------------------------------------------------------
const VALIDES = [
  '@viewTransition',                    // nue — active la transition avec héritage (<style>)
  '@viewTransition.fade',               // préréglage seul
  '@viewTransition.none',               // sentinel « coupe »
  '@viewTransition.cube={ dir: left }', // préréglage + options
  '@viewTransition.hero',               // nom de MORPH libre sur une balise ordinaire
  '@viewTransition.diamant',            // préréglage MAISON (µ._vtPresets), inconnu du compilateur
]

const ROUGES_ATTENDUS = [
  '@viewTransition="cube"',
  "@viewTransition='cube'",
  '@viewTransition={maRoute}',
  '@viewTransition{$featured}="hero"',
  '@vt="cube"',
  '@vt{$featured}="hero"',
  '@viewTransition.cube:left',
  '@viewTransition.turn:right={ p: 3 }',
]

// Refusé aux quatre positions, et pourtant MUET — assumé : la grammaire ne relit pas la
// mini-grammaire des options (`parseVtValue`), et ne saura donc jamais dire d'un `duraction:`
// qu'il est fautif. Peindre au jugé serait pire que se taire.
const TOLERE_MUET = [
  '@viewTransition.cube={ duraction: 600 }',   // clé d'option inconnue
  '@viewTransition.cube={ priority: -1 }',     // priorité négative
]

// Refusé SEULEMENT à certaines positions — hors contrat, la grammaire n'a pas le contexte de balise.
const HORS_CONTRAT = [
  '@vt.fade',                    // alias retiré sur <style> uniquement
]

describe('parité grammaire ↔ compilateur — @viewTransition', function () {
  this.timeout(120000)

  it('A. SOLIDITÉ — tout ce qui est peint en rouge est refusé aux QUATRE positions', async () => {
    for (const attr of ROUGES_ATTENDUS) {
      const refusees = await positionsRefusees(attr, 'rouge')
      assert.equal(refusees.length, POSITIONS.length, `« ${attr} » est peint en rouge mais n'est refusé que par ${refusees.join(', ') || 'aucune position'}`)
    }
  })

  it('A bis. le rouge tombe bien, aux quatre positions, sur ces écritures', () => {
    for (const attr of ROUGES_ATTENDUS) {
      for (const [nom, envelope] of POSITIONS) {
        assert.ok(aDuRouge(envelope(attr)), `« ${attr} » attendu EN ROUGE dans ${nom}`)
      }
    }
  })

  it('B. aucune écriture VALIDE n\'est peinte en rouge, à aucune position', () => {
    for (const attr of [...VALIDES, ...HORS_CONTRAT, ...TOLERE_MUET]) {
      for (const [nom, envelope] of POSITIONS) {
        assert.ok(!aDuRouge(envelope(attr)), `« ${attr} » ne doit PAS être peint en rouge dans ${nom} (le compilateur ne le refuse pas partout)`)
      }
    }
  })

  it('B bis. les formes valides le sont vraiment — chacune passe au moins une position', async () => {
    for (const attr of VALIDES) {
      const refusees = await positionsRefusees(attr, 'valide')
      assert.ok(refusees.length < POSITIONS.length, `« ${attr} » est censée être valide quelque part, et les quatre positions la refusent`)
    }
  })

  it('C. UNE SEULE COULEUR — toute forme valide porte le scope ModularJS, jamais celui des événements', () => {
    for (const attr of VALIDES) {
      for (const [nom, envelope] of POSITIONS) {
        const scopes = scopesDe(envelope(attr), 'viewTransition')
        assert.ok(scopes.includes('entity.other.attribute-name.modularjs'), `« ${attr} » dans ${nom} : scope ModularJS attendu, reçu ${JSON.stringify(scopes)}`)
        assert.ok(!scopes.includes('entity.other.attribute-name.event.modularjs'), `« ${attr} » dans ${nom} : peinte en GESTIONNAIRE D'ÉVÉNEMENT`)
        assert.ok(!scopes.includes('entity.other.attribute-name.html'), `« ${attr} » dans ${nom} : peinte en attribut HTML ordinaire`)
      }
    }
  })

  it('C bis. la forme FAUTIVE n\'est plus peinte plus vive que la juste', () => {
    const fautive = scopesDe('<style @viewTransition="cube"></style>', 'viewTransition')
    assert.ok(!fautive.includes('entity.other.attribute-name.event.modularjs'), '@viewTransition="cube" garde le scope des gestionnaires d\'événement')
  })
})
