// Tests neufs — µ.modal.fire(options) (mjs_modal.ts) : focus trap (Tab/Shift+Tab bouclent DANS
// la boîte tant qu'elle est ouverte) + focus initial (input si présent, sinon le bouton confirm)
// + retour de focus à la fermeture (élément actif AVANT ouverture, {preventScroll:true}). Même
// méthode que mjs-modal-fire.test.ts (cf. son en-tête). NB réalm : les objets `{preventScroll:true}`
// passés à `.focus()` sont créés DANS le réalm happy-dom (code exécuté via window.eval) — un
// `assert.deepEqual` contre un littéral Node échoue sur l'identité de prototype malgré une
// structure identique ("same structure but are not reference-equal") ; on compare donc le champ
// `preventScroll` directement plutôt que l'objet entier.

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
function tab(window: any, document: any, shiftKey = false): void {
  const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey, bubbles: true, cancelable: true })
  document.dispatchEvent(ev)
}
function spyFocus(el: any): any[] {
  const calls: any[] = []
  const orig = el.focus.bind(el)
  el.focus = function (opts?: any) { calls.push(opts); return orig(opts) }
  return calls
}

describe('mjs_modal — focus initial (au montage)', function () {
  it("sans input : le bouton CONFIRM reçoit le focus initial", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showCancelButton: true })
    assert.equal(document.activeElement, box(document).querySelector('.mjs-modal-confirm'))
  })

  it("avec input : l'INPUT reçoit le focus initial (pas le bouton confirm)", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'text' })
    assert.equal(document.activeElement, box(document).querySelector('.mjs-modal-input'))
  })

  it('le focus initial est posé avec {preventScroll:true} — espionne HTMLElement.prototype.focus le temps du fire()', function () {
    const { window, µ } = loadModal()
    const calls: any[] = []
    const proto = window.HTMLElement.prototype
    const orig = proto.focus
    proto.focus = function (opts?: any) { calls.push(opts); return orig.call(this, opts) }
    try {
      µ.modal.fire({ text: 'x' })
    } finally {
      proto.focus = orig
    }
    assert.equal(calls.length, 1, 'un seul focus() programmatique au montage')
    assert.equal(calls[0].preventScroll, true) // cf. note de réalm en tête de fichier (deepEqual cross-realm)
  })
})

describe('mjs_modal — focus trap (Tab/Shift+Tab bouclent DANS la boîte)', function () {
  it('Tab depuis le DERNIER élément focusable (cancel) revient au PREMIER (confirm)', function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showCancelButton: true })
    const b = box(document)
    const confirmEl = b.querySelector('.mjs-modal-confirm')
    const cancelEl = b.querySelector('.mjs-modal-cancel')
    cancelEl.focus()
    assert.equal(document.activeElement, cancelEl)
    tab(window, document, false)
    assert.equal(document.activeElement, confirmEl, 'Tab depuis le dernier doit boucler vers le premier')
  })

  it('Shift+Tab depuis le PREMIER élément focusable (confirm) revient au DERNIER (cancel)', function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showCancelButton: true })
    const b = box(document)
    const confirmEl = b.querySelector('.mjs-modal-confirm')
    const cancelEl = b.querySelector('.mjs-modal-cancel')
    confirmEl.focus()
    tab(window, document, true)
    assert.equal(document.activeElement, cancelEl, 'Shift+Tab depuis le premier doit boucler vers le dernier')
  })

  it('Tab au MILIEU (deny, avec confirm+deny+cancel) : navigation normale, PAS de saut forcé', function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ text: 'x', showCancelButton: true, showDenyButton: true })
    const denyEl = box(document).querySelector('.mjs-modal-deny')
    denyEl.focus()
    const ev = new window.KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true })
    document.dispatchEvent(ev)
    // Le trap n'intervient QU'aux bornes (premier/dernier) — au milieu, e.preventDefault() n'est
    // pas appelé et le focus reste où le navigateur l'aurait naturellement laissé (notre fake
    // dispatch ne simule pas la tabulation native elle-même, seulement l'INTERCEPTION du trap) :
    // on vérifie donc l'ABSENCE d'intervention plutôt qu'une destination précise.
    assert.equal(ev.defaultPrevented, false, 'pas de preventDefault au milieu de la liste')
  })

  it('un seul élément focusable (confirm seul) : Tab reste dessus (preventDefault, pas de fuite hors de la boîte)', function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ text: 'x' })
    const confirmEl = box(document).querySelector('.mjs-modal-confirm')
    assert.equal(document.activeElement, confirmEl)
    tab(window, document, false)
    assert.equal(document.activeElement, confirmEl, 'reste sur l\'unique élément focusable')
  })

  it('focus détourné HORS de la boîte pendant que la modale est ouverte : le Tab suivant ramène DANS la boîte', function () {
    const { window, document, µ } = loadModal()
    const outsideBtn = document.createElement('button')
    outsideBtn.textContent = 'dehors'
    document.body.appendChild(outsideBtn)
    µ.modal.fire({ text: 'x' })
    outsideBtn.focus() // simule un focus qui aurait échappé au trap (ex. script tiers)
    assert.equal(document.activeElement, outsideBtn)
    tab(window, document, false)
    assert.equal(document.activeElement, box(document).querySelector('.mjs-modal-confirm'), 'ramené DANS la boîte')
  })

  it('inputValidator affiche un message d\'erreur (nouvel élément) : le trap le prend en compte au Tab suivant sans planter', async function () {
    const { window, document, µ } = loadModal()
    µ.modal.fire({ input: 'text', inputValue: '', inputValidator: () => 'requis' })
    const confirmEl = box(document).querySelector('.mjs-modal-confirm')
    confirmEl.click()
    await new Promise((r) => setTimeout(r, 20))
    assert.doesNotThrow(() => { tab(window, document, false) })
  })
})

describe('mjs_modal — retour de focus à la fermeture', function () {
  it("l'élément focusé AVANT ouverture reprend le focus à la fermeture (confirm), avec {preventScroll:true}", async function () {
    const { document, µ } = loadModal()
    const trigger = document.createElement('button')
    trigger.textContent = 'ouvrir'
    document.body.appendChild(trigger)
    trigger.focus()
    assert.equal(document.activeElement, trigger)
    const calls = spyFocus(trigger)

    const p = µ.modal.fire({ text: 'x' })
    assert.notEqual(document.activeElement, trigger, 'le focus doit avoir quitté trigger pendant que la modale est ouverte')
    box(document).querySelector('.mjs-modal-confirm').click()
    await p

    assert.equal(document.activeElement, trigger, 'le focus doit revenir sur trigger')
    assert.equal(calls.length, 1)
    assert.equal(calls[0].preventScroll, true) // cf. note de réalm en tête de fichier (deepEqual cross-realm)
  })

  it('retour de focus aussi sur DENY/CANCEL/ESC/BACKDROP/TIMER (pas seulement confirm)', async function () {
    const { window, document, µ } = loadModal()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)

    trigger.focus()
    let p = µ.modal.fire({ text: 'x', showDenyButton: true })
    box(document).querySelector('.mjs-modal-deny').click()
    await p
    assert.equal(document.activeElement, trigger, 'deny')

    trigger.focus()
    p = µ.modal.fire({ text: 'x', showCancelButton: true })
    box(document).querySelector('.mjs-modal-cancel').click()
    await p
    assert.equal(document.activeElement, trigger, 'cancel')

    trigger.focus()
    p = µ.modal.fire({ text: 'x' })
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await p
    assert.equal(document.activeElement, trigger, 'esc')

    trigger.focus()
    p = µ.modal.fire({ text: 'x' })
    document.body.querySelector('.mjs-modal-backdrop').dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await p
    assert.equal(document.activeElement, trigger, 'backdrop')

    trigger.focus()
    p = µ.modal.fire({ text: 'x', timer: 10 })
    await p
    assert.equal(document.activeElement, trigger, 'timer')
  })

  it("aucun élément focusé avant ouverture (document.activeElement = body) : la fermeture ne plante pas", async function () {
    const { document, µ } = loadModal()
    assert.doesNotThrow(() => { document.body.focus && document.body.focus() })
    const p = µ.modal.fire({ text: 'x' })
    await assert.doesNotReject((async () => {
      box(document).querySelector('.mjs-modal-confirm').click()
      return p
    })())
  })

  it("l'élément focusé AVANT ouverture est retiré du DOM PENDANT que la modale est ouverte (ex. re-render appli) : cleanup() ne plante pas, focus() sur un nœud détaché est un no-op silencieux", async function () {
    const { document, µ } = loadModal()
    const trigger = document.createElement('button')
    document.body.appendChild(trigger)
    trigger.focus()
    assert.equal(document.activeElement, trigger)

    const p = µ.modal.fire({ text: 'x' })
    trigger.remove()
    assert.equal(trigger.isConnected, false, 'précondition : bien détaché avant la fermeture')

    await assert.doesNotReject((async () => {
      box(document).querySelector('.mjs-modal-confirm').click()
      return p
    })())
    // focus() sur un nœud détaché est un no-op (spec HTML, reproduit par happy-dom) : le focus
    // retombe sur body, jamais un crash faute de vérifier isConnected avant l'appel.
    assert.equal(document.activeElement, document.body)
  })
})
