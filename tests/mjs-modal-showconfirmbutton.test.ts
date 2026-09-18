// Tests neufs — µ.modal.fire(options) (mjs_modal.ts) : option `showConfirmButton`.
// Défaut true (bouton confirm créé, comportement historique inchangé) ; `false` retire le
// bouton — la modale reste fermable par backdrop/esc/timer, et le focus initial tombe sur la
// boîte elle-même (tabindex="-1") au lieu du bouton absent, sans planter le piège à focus. Même
// méthode que mjs-modal-fire.test.ts (cf. son en-tête).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { assertAbsent } from './helpers/dom-assert.js'

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

function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}
function backdropEl(document: any): any {
  return document.body.querySelector('.mjs-modal-backdrop')
}
function tab(window: any, document: any): void {
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true })
  document.dispatchEvent(ev)
}
describe('mjs_modal — showConfirmButton (défaut true)', function () {
  it('défaut (absent) : bouton confirm présent — comportement historique inchangé', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x' })
    assert.ok(box(document).querySelector('.mjs-modal-confirm'), 'confirm présent par défaut')
  })

  it('showConfirmButton:true explicite — comportement identique au défaut', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: true })
    assert.ok(box(document).querySelector('.mjs-modal-confirm'))
  })

  it('showConfirmButton:false SEUL (sans deny/cancel) : zéro bouton dans .mjs-modal-actions', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: false })
    const b = box(document)
    assertAbsent(b.querySelector('.mjs-modal-confirm'))
    assert.equal(b.querySelectorAll('.mjs-modal-actions .mjs-modal-btn').length, 0)
  })

  it('showConfirmButton:false + showDenyButton/showCancelButton:true : confirm absent, deny+cancel présents (ordre deny→cancel préservé)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: false, showDenyButton: true, showCancelButton: true })
    const btns = Array.from(box(document).querySelectorAll('.mjs-modal-actions .mjs-modal-btn')) as any[]
    assert.equal(btns.length, 2)
    assert.ok(btns[0].classList.contains('mjs-modal-deny'))
    assert.ok(btns[1].classList.contains('mjs-modal-cancel'))
  })

  it('showConfirmButton:false, zéro bouton, zéro input : le focus initial tombe sur la boîte elle-même (tabindex="-1")', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: false })
    const b = box(document)
    assert.equal(document.activeElement, b, 'la boîte reçoit le focus, faute de bouton/input')
    assert.equal(b.getAttribute('tabindex'), '-1')
  })

  it('showConfirmButton:false + showCancelButton:true : le focus initial tombe QUAND MÊME sur la boîte (pas sur cancel — même règle que "confirm ou rien" qu\'auparavant)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: false, showCancelButton: true })
    assert.equal(document.activeElement, box(document))
  })

  it('showConfirmButton:false, zéro bouton : le piège à focus (Tab) ne plante PAS — reste sur la boîte', function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showConfirmButton: false })
    assert.doesNotThrow(() => { tab(window, document) })
    assert.equal(document.activeElement, box(document), 'aucun élément focusable dans la boîte : Tab neutralisé')
  })

  it('showConfirmButton:false : fermeture par ESC toujours active (dismiss:\'esc\')', async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', showConfirmButton: false })
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    const r = await p
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'esc')
    assert.equal(box(document), null)
  })

  it('showConfirmButton:false : fermeture par clic backdrop toujours active (dismiss:\'backdrop\')', async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', showConfirmButton: false })
    backdropEl(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const r = await p
    assert.equal(r.dismiss, 'backdrop')
  })

  it('showConfirmButton:false : fermeture par timer toujours active (dismiss:\'timer\')', async function () {
    const { document: _document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', showConfirmButton: false, timer: 10 })
    const r = await p
    assert.equal(r.dismiss, 'timer')
  })

  it('showConfirmButton:false avec un input présent : le focus initial reste sur l\'input (priorité inchangée)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'text', showConfirmButton: false })
    assert.equal(document.activeElement, box(document).querySelector('.mjs-modal-input'))
  })

  it('showConfirmButton:false avec un input + inputValidator présents : fermable par ESC sans jamais passer par le bouton (confirmBtn absent, onConfirm inatteignable)', async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'text', showConfirmButton: false, inputValidator: () => 'requis' })
    assert.doesNotThrow(() => {
      document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    })
    const r = await p
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'esc')
  })
})
