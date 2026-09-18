// Tests neufs — file FIFO des toasts (µ.config.notifyMax, mjs_init.ts) : façon « succès
// Steam », ZÉRO éviction. Plafond de toasts AFFICHÉS simultanément (défaut 5, false/0/Infinity =
// illimité) — au-delà, les nouveaux ATTENDENT EN FILE et s'affichent quand une place se libère,
// jamais un toast affiché n'est chassé. Le suivant démarre alors SA durée de vie PLEINE. La
// poignée rendue par notify() est valide DÈS L'APPEL, affiché ou pas — fermer un toast encore en
// file le retire simplement de la file, il ne s'affiche jamais. Même méthode que
// mjs-modal-notify.test.ts (cf. son en-tête) — durées de test COURTES et réelles pour les
// timers (pas de fake timers), sauf quand un setTimeout intercepté suffit à prouver le point.

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

function toasts(document: any): any[] {
  return Array.from(document.body.querySelector('.mjs-toasts')?.querySelectorAll('.mjs-toast') ?? [])
}
function messages(document: any): string[] {
  return toasts(document).map((t) => t.querySelector('.mjs-toast-message').textContent)
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mjs_modal — file FIFO des toasts (µ.config.notifyMax)', function () {
  it('plafond défaut 5 : un 6e notify() ne rejoint PAS le DOM (mis en file), 5 seulement affichés', function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 5, 'les 5 premiers sont affichés')
    const h6 = µ.modal.notify('n6', { duration: 0 })
    assert.equal(toasts(document).length, 5, 'le 6e reste en file, aucun 6e nœud dans le DOM')
    assert.equal(typeof h6.close, 'function', 'poignée valide malgré la mise en file')
  })

  it("l'expiration du 1er libère une place — le 6e (en file) s'affiche alors et démarre un timer de SA durée PLEINE (pas un reliquat)", async function () {
    const { window, document, µ } = loadModal()
    µ.modal.notify('n1', { duration: 15 })
    for (let i = 2; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 5, 'précondition : 5 affichés')

    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    µ.modal.notify('n6', { duration: 4242 })
    assert.equal(delays.includes(4242), false, 'n6 en file : aucun timer programmé tout de suite')

    await wait(30) // n1 (15ms) expire, drainage attendu
    window.setTimeout = orig

    assert.equal(toasts(document).length, 5, 'toujours 5 affichés : n1 sorti, n6 dépilé')
    assert.equal(messages(document).includes('n1'), false, 'n1 a bien expiré')
    assert.ok(messages(document).includes('n6'), 'n6 est apparu')
    assert.ok(delays.includes(4242), "le timer de n6 (SA durée pleine, 4242ms) n'a été programmé qu'à son affichage")
  })

  it('fermeture via la croix (×) d\'un toast AFFICHÉ draine aussi la file (pas seulement le timer de vie)', function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    µ.modal.notify('n6', { duration: 0 })
    assert.equal(toasts(document).length, 5)
    toasts(document)[0].querySelector('.mjs-toast-close').click()
    assert.equal(toasts(document).length, 5, 'toujours 5 affichés : n1 fermé, n6 a pris sa place')
    assert.equal(messages(document).includes('n1'), false)
    assert.ok(messages(document).includes('n6'), 'n6 dépilé par la fermeture-croix')
  })

  it('3 toasts en file : ordre FIFO strict au dépilement (a, puis b, puis c — jamais un autre ordre)', function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    µ.modal.notify('a', { duration: 0 })
    µ.modal.notify('b', { duration: 0 })
    µ.modal.notify('c', { duration: 0 })
    const order: string[] = []
    for (let i = 0; i < 3; i++) {
      toasts(document)[0].querySelector('.mjs-toast-close').click()
      const list = messages(document)
      order.push(list[list.length - 1])
    }
    assert.deepEqual(order, ['a', 'b', 'c'], "dépilement strictement dans l'ordre d'arrivée")
  })

  for (const v of [false, 0, Infinity]) {
    it('µ.config.notifyMax = ' + v + ' — illimité, 7 notify() d\'un coup → 7 affichés directement (zéro file)', function () {
      const { document, µ } = loadModal()
      µ.config.notifyMax = v
      for (let i = 1; i <= 7; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
      assert.equal(toasts(document).length, 7)
    })
  }

  it('notifyMax changé À CHAUD est respecté au PROCHAIN affichage — jamais rétroactif sur la file déjà constituée', function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) } // plafond défaut 5
    µ.modal.notify('n6', { duration: 0 }) // 6e : mis en file
    assert.equal(toasts(document).length, 5, 'précondition : 5 affichés, n6 en file')

    µ.config.notifyMax = 6
    assert.equal(toasts(document).length, 5, 'le changement de config seul ne drape rien tout seul')

    µ.modal.notify('n7', { duration: 0 }) // plafond relu ICI (6) : 5 affichés < 6 → affiché direct
    assert.equal(toasts(document).length, 6, 'n7 affiché directement grâce au nouveau plafond')
    assert.equal(messages(document).includes('n6'), false, 'n6 toujours en file, pas encore drainé')
    assert.ok(messages(document).includes('n7'), 'n7 profite du plafond relevé au prochain affichage')
  })

  it('duration:0 (permanent) OCCUPE SA PLACE indéfiniment — le plafond reste plein, un 6e reste en file sans jamais apparaître tout seul', async function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    µ.modal.notify('n6', { duration: 0 })
    await wait(30)
    assert.equal(toasts(document).length, 5, 'aucun des 5 permanents ne se retire tout seul')
    assert.equal(messages(document).includes('n6'), false, "n6 reste en file, aucune place ne s'est libérée")
  })

  it("poignée .close() d'un toast mis EN FILE est valide — fermer PENDANT l'attente = il ne s'affiche JAMAIS", function () {
    const { document, µ } = loadModal()
    for (let i = 1; i <= 5; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    const h6 = µ.modal.notify('n6', { duration: 0 })
    assert.equal(typeof h6.close, 'function', "poignée valide dès l'appel, bien que n6 soit en file")
    h6.close()
    assert.doesNotThrow(() => { h6.close() }, 'idempotent, même jamais affiché')

    toasts(document)[0].querySelector('.mjs-toast-close').click() // libère une place
    const list = toasts(document)
    assert.equal(list.length, 4, "n1 fermé, RIEN ne le remplace : n6 avait été retiré de la file par close(), pas juste sauté")
    assert.equal(messages(document).includes('n6'), false, "n6 n'apparaît jamais dans le DOM")
  })
})
