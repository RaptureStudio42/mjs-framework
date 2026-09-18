// Tests neufs — µ.config.notifyPosition (mjs_init.ts) : 8 préréglages + placement libre par
// objet de longueurs CSS, sur le conteneur PARTAGÉ des toasts (.mjs-toasts, mjs_modal.ts). Valeur
// inconnue → µ.warn + repli 'top-right' ; relue à CHAQUE affichage réel (comme µ.config.notifyMax,
// cf. mjs-modal-notify-queue.test.ts) — un changement à chaud déplace le conteneur COURANT. Même
// méthode que mjs-modal-notify.test.ts (cf. son en-tête) : chargement direct des sources runtime,
// pas de Bundler.

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
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

function container(document: any): any {
  return document.body.querySelector('.mjs-toasts')
}

// classes mjs-toasts-* portées par le conteneur (hors la classe de base mjs-toasts elle-même).
function positionClasses(el: any): string[] {
  return Array.from(el.classList as string[]).filter((c: string) => c.indexOf('mjs-toasts-') === 0)
}

const PRESETS = ['top-right', 'top-left', 'bottom-right', 'bottom-left', 'quarter-top-right', 'quarter-top-left', 'quarter-bottom-right', 'quarter-bottom-left']

describe('mjs_modal — µ.config.notifyPosition', function () {
  it("défaut (config non touchée) : conteneur en classe 'mjs-toasts-top-right'", function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x')
    assert.deepEqual(positionClasses(container(document)), ['mjs-toasts-top-right'])
  })

  for (const preset of PRESETS) {
    it(`préréglage '${preset}' : conteneur en classe mjs-toasts-${preset} (une SEULE classe de position)`, function () {
      const { document, µ } = loadModal()
      µ.config.notifyPosition = preset
      µ.modal.notify('x')
      assert.deepEqual(positionClasses(container(document)), ['mjs-toasts-' + preset])
    })
  }

  it("objet de longueurs CSS { top, right } : classe mjs-toasts-custom + custom properties --mjs-toasts-top/--mjs-toasts-right posées, bottom/left ABSENTES", function () {
    const { document, µ } = loadModal()
    µ.config.notifyPosition = { top: '80px', right: '12px' }
    µ.modal.notify('x')
    const el = container(document)
    assert.deepEqual(positionClasses(el), ['mjs-toasts-custom'])
    assert.equal(el.style.getPropertyValue('--mjs-toasts-top').trim(), '80px')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-right').trim(), '12px')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-bottom'), '', 'bottom absent de l\'objet → pas de custom property')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-left'), '', 'left absent de l\'objet → pas de custom property')
  })

  it('objet de longueurs CSS — style JAMAIS littéral en dur : uniquement des custom properties --mjs-toasts-*, aucun top/right/bottom/left direct sur .style', function () {
    const { document, µ } = loadModal()
    µ.config.notifyPosition = { bottom: '5%', left: '20px' }
    µ.modal.notify('x')
    const el = container(document)
    assert.equal(el.style.top, '', 'jamais de style.top direct')
    assert.equal(el.style.left, '', 'jamais de style.left direct')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-bottom').trim(), '5%')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-left').trim(), '20px')
  })

  it("valeur inconnue (chaîne non préréglée) : µ.warn appelé, repli 'top-right'", function () {
    const { document, µ } = loadModal()
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.config.notifyPosition = 'diagonal'
    µ.modal.notify('x')
    assert.deepEqual(positionClasses(container(document)), ['mjs-toasts-top-right'])
    assert.equal(warned.length, 1, 'µ.warn doit être appelé exactement une fois par affichage sur une valeur invalide')
  })

  it('valeur inconnue (type incorrect — nombre) : µ.warn appelé, repli top-right', function () {
    const { document, µ } = loadModal()
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.config.notifyPosition = 42
    µ.modal.notify('x')
    assert.deepEqual(positionClasses(container(document)), ['mjs-toasts-top-right'])
    assert.equal(warned.length, 1)
  })

  it('valeur inconnue (null) : traité comme invalide (PAS un objet de placement libre), µ.warn + repli top-right', function () {
    const { document, µ } = loadModal()
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.config.notifyPosition = null
    µ.modal.notify('x')
    assert.deepEqual(positionClasses(container(document)), ['mjs-toasts-top-right'])
    assert.equal(warned.length, 1)
  })

  it('relecture À CHAUD : changer notifyPosition entre deux notify() déplace le conteneur COURANT (déjà affiché) — pas de recréation, pas de perte des toasts existants', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('un')
    const el = container(document)
    assert.deepEqual(positionClasses(el), ['mjs-toasts-top-right'])

    µ.config.notifyPosition = 'bottom-left'
    µ.modal.notify('deux')

    assert.equal(container(document), el, 'même nœud conteneur — jamais recréé')
    assert.deepEqual(positionClasses(el), ['mjs-toasts-bottom-left'], "le conteneur COURANT (avec le 1er toast dedans) a suivi le changement de position")
    assert.equal(el.querySelectorAll('.mjs-toast').length, 2, 'les deux toasts sont toujours là, rien perdu au changement de position')
  })

  it('relecture À CHAUD sur un placement objet : les anciennes custom properties disparaissent quand la nouvelle position ne les fournit plus', function () {
    const { document, µ } = loadModal()
    µ.config.notifyPosition = { top: '10px', left: '5px' }
    µ.modal.notify('un')
    const el = container(document)
    assert.equal(el.style.getPropertyValue('--mjs-toasts-top').trim(), '10px')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-left').trim(), '5px')

    µ.config.notifyPosition = { bottom: '10px' }
    µ.modal.notify('deux')

    assert.equal(el.style.getPropertyValue('--mjs-toasts-top'), '', 'top retiré — plus dans le nouvel objet')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-left'), '', 'left retiré — plus dans le nouvel objet')
    assert.equal(el.style.getPropertyValue('--mjs-toasts-bottom').trim(), '10px')
  })

  it('un toast mis EN FILE (plafond notifyMax atteint) applique la position au moment de son AFFICHAGE RÉEL, pas à la création', function () {
    const { document, µ } = loadModal()
    µ.config.notifyMax = 1
    const h1 = µ.modal.notify('un', { duration: 0 })
    const el = container(document)
    assert.deepEqual(positionClasses(el), ['mjs-toasts-top-right'])

    // changement de position PENDANT que le 2e toast est encore en file (plafond atteint)
    µ.config.notifyPosition = 'quarter-bottom-right'
    µ.modal.notify('deux', { duration: 0 })
    assert.deepEqual(positionClasses(el), ['mjs-toasts-top-right'], 'le conteneur ne bouge PAS tant que le 2e toast est en file (pas encore affiché)')

    h1.close() // libère une place → drain → le 2e toast s'affiche VRAIMENT ici
    assert.deepEqual(positionClasses(el), ['mjs-toasts-quarter-bottom-right'], "au DRAIN, le 2e toast s'affiche réellement — la position à chaud s'applique enfin")
  })
})
