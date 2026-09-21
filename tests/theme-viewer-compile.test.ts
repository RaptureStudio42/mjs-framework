// theme-viewer — le composant de l'atelier /__mjs/theme est du code LIVRÉ, servi tel quel par
// `mjs dev` et `mjs serve`, mais il n'était couvert par aucun test de compilation : les routes
// avaient les leurs, la page non.
//
// Ce qui est arrivé, faute de ce filet : le sélecteur de couleur portait `@click.stop` en forme
// NUE. Cette forme ne veut pas dire « ne fais que stopper la propagation » — elle SYNTHÉTISE un
// appel à la méthode homonyme, `click(e, el)`, qui n'existe nulle part dans le composant. Build
// vert, page qui s'affiche, et `ReferenceError: click is not defined` au premier clic sur une
// couleur : exactement le geste que l'atelier propose. La forme juste est `@click.stop={}`, dont
// le corps vide laisse les seuls modificateurs.
//
// Ce que la suite tient :
//   1. le composant compile sans erreur ;
//   2. aucun handler ne part appeler une fonction que le composant ne déclare pas.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transpile } from '../src/transpiler/index.js'

const ICI    = dirname(fileURLToPath(import.meta.url))
const SOURCE = join(ICI, '..', 'src', 'server', 'theme-viewer.mjs')

describe('theme-viewer.mjs — la page de l\'atelier compile et ses handlers existent', () => {
  let js = ''

  before(async () => {
    const src: string = readFileSync(SOURCE, 'utf8')
    const out: any    = await transpile(src, { moduleName: 'mjs-theme-viewer' })
    js = typeof out === 'string' ? out : (out.output ?? out.js ?? out.code ?? '')
  })

  it('compile en un module non vide', () => {
    // garde muette : sans ce contrôle, un `output` vide ferait passer le test suivant pour vert
    assert.ok(js.length > 10_000, `code produit trop court (${js.length} octets) — la compilation n'a rien rendu`)
  })

  it('aucun handler ne synthétise un appel vers une fonction absente du composant', () => {
    // le générateur n'émet `nom(e, el)` que pour la forme NUE d'un événement ; le nom doit alors
    // être une méthode du composant. On relit le source pour savoir ce qu'il déclare vraiment.
    const src       = readFileSync(SOURCE, 'utf8')
    const synthese  = [...js.matchAll(/return ([A-Za-z_$][\w$]*)\(e, el\)/g)].map((m) => m[1])
    const absents   = synthese.filter((nom) => {
      const declare = new RegExp(`(^|\\n)\\s*(@)?${nom}\\s*(:?=|\\()`).test(src)
      return !declare
    })
    assert.deepEqual(absents, [], `handlers qui appellent une fonction inexistante : ${absents.join(', ')}`)
  })
})
