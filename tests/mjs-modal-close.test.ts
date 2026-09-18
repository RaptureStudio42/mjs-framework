// Tests neufs — µ.modal.close(result?) (mjs_modal.ts) : fermeture
// programmatique GLOBALE de la modale COURANTE (__modalCurrentClose, posée à l'ouverture de
// fire(), nettoyée à la fermeture — une seule modale à la fois). Sans modale ouverte : no-op
// silencieux. Résout {isConfirmed:false, isDenied:false, isDismissed:true, value:undefined,
// dismiss:'close'} par défaut, ou `result` fusionné PAR-DESSUS (les clés fournies gagnent). Même
// méthode que mjs-modal-fire.test.ts (cf. son en-tête).

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

function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}

describe('mjs_modal — µ.modal.close (fermeture programmatique globale)', function () {
  it('sans modale ouverte : no-op silencieux, aucune exception', function () {
    const { µ } = loadModal()
    assert.doesNotThrow(() => { µ.modal.close() })
    assert.doesNotThrow(() => { µ.modal.close({ value: 42 }) })
  })

  it("ferme la modale ouverte, résout {isConfirmed:false, isDenied:false, isDismissed:true, value:undefined, dismiss:'close'} par défaut", async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    assert.ok(box(document), 'ouverte avant close()')
    µ.modal.close()
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDenied, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.value, undefined)
    assert.equal(r.dismiss, 'close')
    assert.equal(box(document), null, 'boîte retirée du DOM')
  })

  it('result fourni : fusionné PAR-DESSUS le défaut (value overridé, dismiss/isDismissed conservés)', async function () {
    const { µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    µ.modal.close({ value: 'saisie-recuperee' })
    const r = await p
    assert.equal(r.value, 'saisie-recuperee')
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'close')
  })

  it('result fourni : PEUT aussi overrider isConfirmed/dismiss eux-mêmes (fusion sans exception réservée)', async function () {
    const { µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    µ.modal.close({ isConfirmed: true, isDismissed: false, dismiss: undefined, value: 'ok' })
    const r = await p
    assert.equal(r.isConfirmed, true)
    assert.equal(r.isDismissed, false)
    assert.equal(r.value, 'ok')
  })

  it('après une fermeture normale (clic confirm), µ.modal.close() redevient un no-op (__modalCurrentClose nettoyé)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    box(document).querySelector('.mjs-modal-confirm').click()
    const r1 = await p
    assert.equal(r1.isConfirmed, true, 'fermée normalement par confirm')
    assert.doesNotThrow(() => { µ.modal.close() })
    assert.equal(box(document), null, 'toujours fermée, rien de cassé')
  })

  it('un 2e appel après une fermeture via µ.modal.close() lui-même : no-op silencieux (idempotent)', async function () {
    const { µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    µ.modal.close()
    await p
    assert.doesNotThrow(() => { µ.modal.close() })
  })

  it('deux modales en SÉQUENCE (jamais simultanées) : µ.modal.close() cible toujours la COURANTE', async function () {
    const { document, µ } = loadModal()
    const pA = µ.modal.fire({ text: 'A' })
    box(document).querySelector('.mjs-modal-confirm').click()
    await pA

    const pB = µ.modal.fire({ text: 'B' })
    assert.equal(box(document).querySelector('.mjs-modal-content').textContent, 'B')
    µ.modal.close()
    const rB = await pB
    assert.equal(rB.dismiss, 'close')
  })

  it('le retour de focus (cleanup) fonctionne aussi via µ.modal.close() — pas seulement les fermetures internes', async function () {
    const { document, µ } = loadModal()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    const p = µ.modal.fire({ text: 'x' })
    assert.notEqual(document.activeElement, trigger, 'focus quitte trigger pendant l\'ouverture')
    µ.modal.close()
    await p
    assert.equal(document.activeElement, trigger, 'focus revenu sur trigger')
  })

  it("fonctionne aussi avec les raccourcis (µ.modal.success ouverte, fermée par µ.modal.close())", async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.success('ok')
    assert.ok(box(document))
    µ.modal.close()
    const r = await p
    assert.equal(r.dismiss, 'close')
  })
})
