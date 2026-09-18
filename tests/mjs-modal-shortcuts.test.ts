// Tests neufs — 4 raccourcis µ.modal.success/error/info/warn(arg) (mjs_modal.ts).
// Défauts exacts (icon, timer, showConfirmButton), arg chaîne → {text: arg}, arg objet →
// fusionné PAR-DESSUS les défauts (l'objet gagne), chacun rend la promesse de fire() telle
// quelle. Même méthode que mjs-modal-fire.test.ts (cf. son en-tête).

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

// success/info/warn = { icon: <type>, timer: 2000, showConfirmButton: false } (warn → 'warning') ;
// error = { icon: 'error' } (bloquante, bouton OK, pas de timer).
const CASES = [
  { name: 'success', icon: 'success', timer: 2000 },
  { name: 'info', icon: 'info', timer: 2000 },
  { name: 'warn', icon: 'warning', timer: 2000 },
  { name: 'error', icon: 'error', timer: null as number | null },
]

describe('mjs_modal — 4 raccourcis success/error/info/warn', function () {
  for (const c of CASES) {
    describe(`µ.modal.${c.name}`, function () {
      it(`défauts exacts : icon '${c.icon}', showConfirmButton ${c.timer === null ? 'true (bouton présent)' : 'false (bouton absent)'}`, function () {
        const { document, µ } = loadModal()
        ;(µ.modal as any)[c.name]()
        const b = box(document)
        assert.ok(b.querySelector('.mjs-modal-icon-' + c.icon), `icône ${c.icon} attendue`)
        assert.equal(!!b.querySelector('.mjs-modal-confirm'), c.timer === null)
      })

      it(`défaut du timer : ${c.timer === null ? 'ABSENT (bloquante, aucun setTimeout programmé)' : c.timer + 'ms'} (setTimeout intercepté, aucune attente réelle)`, function () {
        const { window, µ } = loadModal()
        const delays: any[] = []
        const orig = window.setTimeout
        window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
        try {
          ;(µ.modal as any)[c.name]()
        } finally {
          window.setTimeout = orig
        }
        if (c.timer === null) { assert.equal(delays.length, 0, 'error : bloquante, aucun timer par défaut') }
        else { assert.ok(delays.includes(c.timer), `timer ${c.timer}ms attendu parmi ${JSON.stringify(delays)}`) }
      })

      it('arg chaîne → {text: arg}', function () {
        const { document, µ } = loadModal()
        ;(µ.modal as any)[c.name]('un message')
        assert.equal(box(document).querySelector('.mjs-modal-content').textContent, 'un message')
      })

      it("arg objet → fusionné PAR-DESSUS les défauts (l'objet gagne)", function () {
        const { document, µ } = loadModal()
        ;(µ.modal as any)[c.name]({ text: 'perso', icon: 'question', showConfirmButton: true })
        const b = box(document)
        assert.equal(b.querySelector('.mjs-modal-content').textContent, 'perso')
        assert.ok(b.querySelector('.mjs-modal-icon-question'), "icon overridé par l'objet")
        assert.ok(b.querySelector('.mjs-modal-confirm'), "showConfirmButton overridé par l'objet")
      })

      it('rend la promesse de fire() telle quelle (fermable par ESC comme toute modale)', async function () {
        const { window, document, µ } = loadModal()
        const p = (µ.modal as any)[c.name]('x')
        assert.equal(typeof p.then, 'function', 'doit renvoyer une promesse')
        document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
        const r = await p
        assert.equal(r.isDismissed, true)
        assert.equal(r.dismiss, 'esc')
      })
    })
  }

  it('µ.modal.error() — seul raccourci bloquant : clic OK résout isConfirmed:true (comme fire() nu)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.error('boom')
    box(document).querySelector('.mjs-modal-confirm').click()
    const r = await p
    assert.equal(r.isConfirmed, true)
  })

  it("µ.modal.warn() pose bien l'icône 'warning' (pas 'warn', qui n'existe pas dans __modalIcons)", function () {
    const { document, µ } = loadModal()
    µ.modal.warn('attention')
    assert.ok(box(document).querySelector('.mjs-modal-icon-warning'))
    assertAbsent(box(document).querySelector('.mjs-modal-icon-warn'))
  })
})
