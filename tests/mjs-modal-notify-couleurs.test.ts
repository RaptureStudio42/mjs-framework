// Tests neufs — variable de thème unique --mjs-toast-color (mjs_modal.ts), posée par les classes de
// type et consommé À LA FOIS par la bordure du toast et par la barre de progression
// (.mjs-toast-barre) — corrige le bogue où la barre restait grise quel que soit le type (les
// classes .mjs-toast-<type> ne posaient QUE border-color, jamais lu par la barre). Preuve par
// getComputedStyle (happy-dom résout ici correctement la chaîne var() en jeu, vérifié à la main
// avant écriture), en plus de la lecture du texte source
// déjà couverte par mjs-modal-fire.test.ts. Même méthode d'assemblage que les fichiers voisins.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stripEsm(s: string): string {
  return s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
}

const INIT_SRC = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
// la modale lit les variables du thème embarqué (mjs_theme.ts, joint au cœur dès que la modale l'est)
const THEME_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_theme.ts'), 'utf-8')
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${THEME_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

const TYPES: Array<[string, string]> = [['success', '#2e9e5b'], ['error', '#d64545'], ['warning', '#e0a020'], ['info', '#3085d6']]

describe('mjs_modal — variable de thème --mjs-toast-color, bordure et barre teintées par type', function () {
  for (const [type, hex] of TYPES) {
    it(`type:'${type}' — la classe pose --mjs-toast-color:${hex}, la barre lit la même valeur (pas grise)`, function () {
      const { window, document, µ } = loadModal()
      µ.modal.notify('x', { type })
      const t = document.body.querySelector('.mjs-toast-' + type)
      const barre = t.querySelector('.mjs-toast-barre')
      assert.equal(window.getComputedStyle(t).getPropertyValue('--mjs-toast-color').trim(), hex, `--mjs-toast-color du toast ${type}`)
      assert.equal(window.getComputedStyle(barre).backgroundColor, hex, `la barre du type ${type} doit prendre sa couleur, pas rester grise`)
    })
  }

  it('override --mjs-toast-border sur :root teinte encore un toast SANS classe de type (repli neutre de .mjs-toast)', function () {
    const { window, document } = loadModal()
    const neutre = document.createElement('div')
    neutre.className = 'mjs-toast'
    document.body.appendChild(neutre)
    assert.equal(window.getComputedStyle(neutre).getPropertyValue('--mjs-toast-color').trim(), '#d0d0d0', 'sans override, repli neutre sur --mjs-border (thème clair)')
    document.documentElement.style.setProperty('--mjs-toast-border', '#ff00ff')
    const teinte = document.createElement('div')
    teinte.className = 'mjs-toast'
    document.body.appendChild(teinte)
    assert.equal(window.getComputedStyle(teinte).getPropertyValue('--mjs-toast-color').trim(), '#ff00ff', 'l\'override --mjs-toast-border doit encore teinter un toast sans type')
  })
})
