// Modules cœur : spécificité CSS des styles internes (blindage anti-collision avec
// le CSS ambiant adopté dans le shadow). Lecture STATIQUE des 6 fichiers source, aucun build
// ni navigateur : vérifie que plus aucun sélecteur n'est enveloppé de :where(...) (spécificité
// nulle), que les 3 interrupteurs renforcent .native en input.native (0,1,1 — gagne à égalité
// contre input[type=checkbox]/input[type=radio] du site, la feuille du module étant adoptée
// en dernier), et que les part= exposés (support de ::part()) et les variables --mjs-* n'ont
// pas bougé pendant l'opération (comptes figés, anti-suppression accidentelle). La vraie
// preuve visuelle (fond calculé du bouton) reste au navigateur, hors périmètre de ce test.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CORE_DIR  = join(__dirname, '..', 'src', 'core-modules')

const MODULES = ['select', 'option', 'field', 'checkbox', 'radio', 'switch']
const TOGGLES = ['checkbox', 'radio', 'switch']

// comptes figés à l'état sain (select : +3 var — max-height clampé (1) et fond
// sticky de la recherche repris sur --mjs-select-panel-bg/--mjs-surface, déjà nesté ailleurs (2) ;
// checkbox : tiret indeterminate, cf. commentaires en bout de ligne) :
// select 4/31, option 0/0, field 5/6, checkbox 3/14, radio 3/9, switch 3/16
const PART_COUNT: Record<string, number>          = { select: 4, option: 0, field: 5, checkbox: 3, radio: 3, switch: 3 }
const VAR_COUNT: Record<string, number>           = { select: 32, option: 0, field: 6, checkbox: 14, radio: 9, switch: 16 } // select : +1 (--mjs-select-max, plafond de largeur de la jauge) ; checkbox : +3 (indeterminate — .dash + input.native:indeterminate ~ .box)
const INPUT_NATIVE_COUNT: Record<string, number>  = { checkbox: 4, radio: 3, switch: 3 } // checkbox : +1 (input.native:indeterminate ~ .box), radio/switch inchangés

function read(name: string): string {
  return readFileSync(join(CORE_DIR, `${name}.mjs`), 'utf-8')
}

function count(source: string, re: RegExp): number {
  return (source.match(re) || []).length
}

describe('core-modules — spécificité CSS des styles internes', () => {
  describe('aucun sélecteur enveloppé de :where( (spécificité nulle abandonnée)', () => {
    for (const name of MODULES) {
      it(`${name}.mjs ne contient aucun :where(`, () => {
        assert.doesNotMatch(read(name), /:where\(/)
      })
    }
  })

  describe('checkbox/radio/switch — .native renforcé en input.native (0,1,1 contre input[type] du site)', () => {
    for (const name of TOGGLES) {
      it(`${name}.mjs : aucun .native nu (toujours préfixé input)`, () => {
        assert.doesNotMatch(read(name), /(?<!input)\.native\b/)
      })

      it(`${name}.mjs : input.native présent exactement ${INPUT_NATIVE_COUNT[name]} fois (base, :checked${name === 'checkbox' ? ', :indeterminate' : ''}, :focus-visible)`, () => {
        const source = read(name)
        assert.equal(count(source, /input\.native\b/g), INPUT_NATIVE_COUNT[name])
        assert.match(source, /^\s*input\.native\s*$/m)
        assert.match(source, /input\.native:checked ~ /)
        if(name === 'checkbox') assert.match(source, /input\.native:indeterminate ~ /)
        assert.match(source, /input\.native:focus-visible ~ /)
      })
    }
  })

  describe('part= exposés et variables --mjs-* intacts (comptes exacts, anti-suppression accidentelle)', () => {
    for (const name of MODULES) {
      it(`${name}.mjs : ${PART_COUNT[name]} part= et ${VAR_COUNT[name]} var(--mjs-`, () => {
        const source = read(name)
        assert.equal(count(source, /part="/g), PART_COUNT[name])
        assert.equal(count(source, /var\(--mjs-/g), VAR_COUNT[name])
      })
    }
  })
})
