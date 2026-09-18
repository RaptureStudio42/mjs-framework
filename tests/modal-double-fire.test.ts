// Tests neufs — deux µ.modal.fire() BLOQUANTS consécutifs (showConfirmButton:
// false, allowOutsideClick:false, allowEscapeKey:false — cas µ.modal.wait()-like appelé via fire()
// direct) sans fermer le premier. Contrat documenté (en-tête mjs_modal.ts) : une seule modale
// ouverte à la fois — un fire() qui arrive PAR-DESSUS ferme D'ABORD la précédente (même résultat
// que µ.modal.close(), dismiss:'close') avant d'ouvrir la sienne : jamais une promesse orpheline,
// jamais deux boîtes empilées. Même méthode que tests/mjs-modal-close.test.ts (cf. son en-tête).

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

function boxes(document: any): any[] {
  return Array.from(document.body.querySelectorAll('.mjs-modal-box'))
}

// cas µ.modal.wait()-like : AUCUN canal utilisateur ne peut fermer
const BLOQUANTE = { showConfirmButton: false, allowOutsideClick: false, allowEscapeKey: false }

describe('mjs_modal — deux fire() bloquants consécutifs', function () {
  it("le 2e fire() FERME le 1er (résolu dismiss:'close') avant d'ouvrir sa propre boîte", async function () {
    const { document, µ } = loadModal()
    const p1 = µ.modal.fire({ text: 'Modale 1', ...BLOQUANTE })
    const p2 = µ.modal.fire({ text: 'Modale 2', ...BLOQUANTE })

    const r1 = await p1
    assert.equal(r1.isConfirmed, false)
    assert.equal(r1.isDenied, false)
    assert.equal(r1.isDismissed, true)
    assert.equal(r1.dismiss, 'close')

    assert.equal(boxes(document).length, 1, 'une seule boîte reste — celle de la modale 2')
    assert.equal(boxes(document)[0].querySelector('.mjs-modal-content').textContent, 'Modale 2')

    µ.modal.close()
    const r2 = await p2
    assert.equal(r2.dismiss, 'close')
    assert.equal(boxes(document).length, 0, 'plus aucune boîte après la fermeture de la 2e')
  })

  it('jamais deux boîtes empilées, même juste après le 2e fire() (avant tout close())', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'Modale 1', ...BLOQUANTE })
    µ.modal.fire({ text: 'Modale 2', ...BLOQUANTE })
    assert.equal(boxes(document).length, 1, 'jamais deux boîtes empilées')
  })

  it('trois fire() en chaîne : chacun ferme le précédent, seul le dernier tient la scène', async function () {
    const { document, µ } = loadModal()
    const p1 = µ.modal.fire({ text: 'A', ...BLOQUANTE })
    const p2 = µ.modal.fire({ text: 'B', ...BLOQUANTE })
    const p3 = µ.modal.fire({ text: 'C', ...BLOQUANTE })

    const r1 = await p1
    const r2 = await p2
    assert.equal(r1.dismiss, 'close')
    assert.equal(r2.dismiss, 'close')
    assert.equal(boxes(document).length, 1)
    assert.equal(boxes(document)[0].querySelector('.mjs-modal-content').textContent, 'C')

    µ.modal.close()
    const r3 = await p3
    assert.equal(r3.dismiss, 'close')
  })
})
