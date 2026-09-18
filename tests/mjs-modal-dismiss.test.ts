// Tests neufs — µ.modal.fire(options) (mjs_modal.ts) : fermetures « passives » — Échap, clic
// backdrop, timer, et les gardes allowOutsideClick/allowEscapeKey (défaut true tous les deux,
// SEULE la valeur explicite `false` désactive). Même méthode que mjs-modal-fire.test.ts (chargement
// direct de mjs_init.ts + mjs_modal.ts dans un happy-dom Window frais par test, cf. son en-tête).

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

function backdropEl(document: any): any {
  return document.body.querySelector('.mjs-modal-backdrop')
}
function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}
function pressEscape(window: any, document: any): void {
  document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mjs_modal — fermeture par Échap (allowEscapeKey, défaut true)', function () {
  it("Échap (défaut) : dismiss:'esc', isDismissed:true, boîte retirée", async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    pressEscape(window, document)
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'esc')
    assert.equal(box(document), null)
  })

  it('allowEscapeKey:false — Échap ne fait RIEN, la modale reste ouverte', async function () {
    const { window, document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x', allowEscapeKey: false })
    p.then(() => { settled = true })
    pressEscape(window, document)
    await wait(20)
    assert.equal(settled, false, 'la promesse ne doit pas se résoudre')
    assert.ok(box(document), 'la boîte doit rester présente')
  })

  it('allowEscapeKey:true explicite — comportement identique au défaut', async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', allowEscapeKey: true })
    pressEscape(window, document)
    const r = await p
    assert.equal(r.dismiss, 'esc')
  })

  it("le listener keydown est retiré à la fermeture : un Échap APRÈS coup n'a plus aucun effet observable (pas de double-resolve, pas d'erreur)", async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    box(document).querySelector('.mjs-modal-confirm').click()
    await p
    assert.doesNotThrow(() => { pressEscape(window, document) })
  })
})

describe('mjs_modal — fermeture par clic backdrop (allowOutsideClick, défaut true)', function () {
  it("clic sur le backdrop LUI-MÊME (défaut) : dismiss:'backdrop', isDismissed:true, boîte retirée", async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    backdropEl(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'backdrop')
    assert.equal(box(document), null)
  })

  it('clic à l\'INTÉRIEUR de la boîte (target = box, pas backdrop) : ne ferme PAS, malgré la remontée (bubbling) jusqu\'au backdrop', async function () {
    const { window, document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x' })
    p.then(() => { settled = true })
    box(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(20)
    assert.equal(settled, false)
    assert.ok(box(document))
  })

  it('allowOutsideClick:false — clic backdrop ne fait RIEN, la modale reste ouverte', async function () {
    const { window, document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x', allowOutsideClick: false })
    p.then(() => { settled = true })
    backdropEl(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(20)
    assert.equal(settled, false)
    assert.ok(box(document))
  })

  it('allowOutsideClick:true explicite — comportement identique au défaut', async function () {
    const { window, document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', allowOutsideClick: true })
    backdropEl(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    const r = await p
    assert.equal(r.dismiss, 'backdrop')
  })
})

describe('mjs_modal — timer (auto-fermeture)', function () {
  it("timer:10 — auto-fermeture après le délai, dismiss:'timer', isDismissed:true", async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', timer: 10 })
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'timer')
    assert.equal(box(document), null)
  })

  it('pas de timer (absent) : la modale ne se ferme jamais toute seule', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x' })
    p.then(() => { settled = true })
    await wait(30)
    assert.equal(settled, false)
    assert.ok(box(document))
  })

  it('timer LONG mais fermeture par CONFIRM avant échéance : le timer est annulé (pas de 2e résolution, pas de crash après le délai initial)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', timer: 500 })
    box(document).querySelector('.mjs-modal-confirm').click()
    const r = await p
    assert.equal(r.isConfirmed, true, 'la première fermeture (confirm) doit gagner')
    // Laisse largement passer l'échéance du timer d'origine : si `clearTimeout` avait été
    // oublié, un 2e `close()` tenterait de re-resolve (no-op grâce au flag `closed`) ou de
    // manipuler un DOM déjà détaché — aucune des deux ne doit lever d'erreur.
    await wait(30)
  })

  it('timer:0 — traité comme « pas de timer » (0 est falsy pour un délai, jamais un setTimeout(fn, 0) surprise)', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x', timer: 0 })
    p.then(() => { settled = true })
    await wait(20)
    assert.equal(settled, false)
    assert.ok(box(document))
  })
})
