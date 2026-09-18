// Tests neufs — µ.modal.fire(options) (mjs_modal.ts) : inputs text/textarea/select/checkbox,
// inputValidator (message d'erreur si non-null, bloque la fermeture) et preConfirm (peut
// transformer la valeur finale ou annuler en renvoyant `false`). Même méthode que
// mjs-modal-fire.test.ts (cf. son en-tête).

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
function confirmBtn(document: any): any {
  return box(document).querySelector('.mjs-modal-confirm')
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mjs_modal — inputs (text/textarea/select/checkbox)', function () {
  it("input:'text' — <input type=text>, valeur initiale (inputValue), placeholder (inputPlaceholder)", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'text', inputValue: 'salut', inputPlaceholder: 'ton nom' })
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.tagName, 'INPUT')
    assert.equal(el.type, 'text')
    assert.ok(el.classList.contains('mjs-modal-text'))
    assert.equal(el.value, 'salut')
    assert.equal(el.getAttribute('placeholder'), 'ton nom')
  })

  it("input:'textarea' — <textarea>, valeur initiale", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'textarea', inputValue: 'un texte plus long' })
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.tagName, 'TEXTAREA')
    assert.ok(el.classList.contains('mjs-modal-textarea'))
    assert.equal(el.value, 'un texte plus long')
  })

  it("input:'select' — <option> depuis inputOptions (objet {valeur:libellé}), valeur initiale", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'select', inputOptions: { a: 'Alpha', b: 'Beta' }, inputValue: 'b' })
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.tagName, 'SELECT')
    const opts = Array.from(el.querySelectorAll('option')) as any[]
    assert.deepEqual(opts.map((o) => [o.value, o.textContent]), [['a', 'Alpha'], ['b', 'Beta']])
    assert.equal(el.value, 'b')
  })

  it("input:'select' — inputOptions en Map (ordre d'insertion préservé)", function () {
    const { document, µ } = loadModal()
    const opts = new Map([['x', 'Xray'], ['y', 'Yankee']])
    µ.modal.fire({ input: 'select', inputOptions: opts })
    const el = box(document).querySelector('.mjs-modal-input')
    const rendered = Array.from(el.querySelectorAll('option')) as any[]
    assert.deepEqual(rendered.map((o) => [o.value, o.textContent]), [['x', 'Xray'], ['y', 'Yankee']])
  })

  it("input:'select' — faux Map-like (.get/.keys, PAS de Symbol.iterator) : ERREUR SYNCHRONE nommée, jamais un rejet de promesse", async function () {
    const { µ } = loadModal()
    // Historique de ce cas. Objet qui satisfait l'ANCIEN test à 2 conditions (.get et .keys sont
    // des fonctions) mais n'est PAS une vraie Map : pas de Symbol.iterator, .keys() renvoie null.
    //  · auparavant : détecté Map-like → Array.from(null) levait dans l'executor de
    //    `new Promise(...)` → REJET (violation du contrat) ;
    //  · puis (Symbol.iterator exigé) : plus détecté Map-like → repli Object.keys, les clés
    //    propres `get`/`keys` devenaient des <option> dont le libellé était le CODE SOURCE des
    //    deux fonctions — plus de rejet, mais un rendu absurde tenu pour normal ;
    //  · aujourd'hui (validation en amont) : des libellés qui sont des fonctions sont un appel
    //    malformé — erreur SYNCHRONE, nommée, levée avant que la promesse n'existe.
    const fakeMapLike = { get: (k: string) => 'valeur-' + k, keys: () => null as any }
    assert.throws(
      () => µ.modal.fire({ input: 'select', inputOptions: fakeMapLike }),
      /µ\.modal\.fire.*inputOptions.*function/s,
      "un libellé d'option qui est une fonction doit lever, en nommant l'option fautive",
    )
    // Aucune promesse n'a été créée : il ne peut donc y avoir ni rejet, ni rejet non traité.
    await wait(20)
  })

  it("input:'select' — VRAI faux-ami Map (les 3 signes, dont Symbol.iterator, mais keys() non parcourable) : erreur synchrone, plus de rejet", async function () {
    const { µ } = loadModal()
    // Le trou résiduel exact : un objet qui imite les TROIS signes de
    // la détection Map (get, keys, Symbol.iterator) tout en renvoyant un `keys()` non itérable.
    // Il passait la détection, puis Array.from levait DANS l'executor → rejet de promesse.
    // Désormais l'échec est nommé et synchrone.
    const faux: any = { get: (k: string) => 'v-' + k, keys: () => null, [Symbol.iterator]: function* () {} }
    assert.throws(
      () => µ.modal.fire({ input: 'select', inputOptions: faux }),
      /ressemble à une Map.*keys\(\).*parcourable/s,
      'le message doit dire précisément ce qui cloche, pas une pile opaque venue du runtime',
    )
    await wait(20)
  })

  it("input:'checkbox' — <input type=checkbox>, checked reflète inputValue", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'checkbox', inputValue: true })
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.tagName, 'INPUT')
    assert.equal(el.type, 'checkbox')
    assert.ok(el.classList.contains('mjs-modal-checkbox'))
    assert.equal(el.checked, true)
  })

  it("input:'checkbox' sans inputValue — décoché par défaut", function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ input: 'checkbox' })
    assert.equal(box(document).querySelector('.mjs-modal-input').checked, false)
  })

  it("input non reconnu (typo) : repli sur 'text', jamais un crash", function () {
    const { document, µ } = loadModal()
    assert.doesNotThrow(() => { µ.modal.fire({ input: 'bogus' as any }) })
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.type, 'text')
  })

  it('sans options.input : aucun élément .mjs-modal-input-container/.mjs-modal-input', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: 'x' })
    assertAbsent(box(document).querySelector('.mjs-modal-input-container'))
    assertAbsent(box(document).querySelector('.mjs-modal-input'))
  })

  it('résultat CONFIRM sans validator/preConfirm : value = la valeur COURANTE de l\'input (texte)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'text', inputValue: 'brouillon' })
    box(document).querySelector('.mjs-modal-input').value = 'valeur finale'
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.isConfirmed, true)
    assert.equal(r.value, 'valeur finale')
  })

  it('résultat CONFIRM checkbox : value = booléen (pas une chaîne)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'checkbox' })
    box(document).querySelector('.mjs-modal-input').checked = true
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.value, true)
    assert.equal(typeof r.value, 'boolean')
  })
})

describe('mjs_modal — inputValidator(value) : message si non-null (bloque), null/undefined (passe)', function () {
  it('validator retourne une chaîne (erreur) : la modale reste ouverte, message affiché, boutons ré-activés', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const calls: any[] = []
    const p = µ.modal.fire({ input: 'text', inputValue: '', inputValidator: (v: any) => { calls.push(v); return v ? null : 'Valeur requise' } })
    p.then(() => { settled = true })
    confirmBtn(document).click()
    await wait(20)
    assert.equal(settled, false, 'ne doit PAS se fermer')
    assert.deepEqual(calls, [''])
    const msgEl = box(document).querySelector('.mjs-modal-validation-message')
    assert.equal(msgEl.hidden, false)
    assert.equal(msgEl.textContent, 'Valeur requise')
    assert.equal(confirmBtn(document).disabled, false, 'ré-activé après échec de validation')
  })

  it('corrige la valeur puis reclique confirm : validator repasse null → ferme normalement, message caché', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'text', inputValue: '', inputValidator: (v: any) => (v ? null : 'Valeur requise') })
    confirmBtn(document).click()
    await wait(10)
    box(document).querySelector('.mjs-modal-input').value = 'ok'
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.isConfirmed, true)
    assert.equal(r.value, 'ok')
  })

  it('validator retourne null : passe directement (aucun message affiché)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'text', inputValue: 'x', inputValidator: () => null })
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.isConfirmed, true)
    const msgEl = box(document) // déjà retiré du DOM après fermeture
    assert.equal(msgEl, null)
  })

  it('validator ASYNCHRONE (Promise<string|null>) : awaited, boutons désactivés PENDANT la résolution', async function () {
    const { document, µ } = loadModal()
    let resolveValidator: (v: string | null) => void = null as any
    const pending = new Promise<string | null>((r) => { resolveValidator = r })
    const p = µ.modal.fire({ input: 'text', inputValue: 'x', inputValidator: () => pending })
    confirmBtn(document).click()
    assert.equal(confirmBtn(document).disabled, true, 'désactivé PENDANT la résolution asynchrone')
    resolveValidator(null)
    const r = await p
    assert.equal(r.isConfirmed, true)
  })

  it('validator qui REJETTE (throw/Promise rejetée) : reste ouverte, message affiché depuis err.message, µ.error tracé', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const errCalls: any[] = []
    µ.error = (...a: any[]) => errCalls.push(a)
    const p = µ.modal.fire({ input: 'text', inputValue: 'x', inputValidator: () => Promise.reject(new Error('boom')) })
    p.then(() => { settled = true })
    confirmBtn(document).click()
    await wait(20)
    assert.equal(settled, false)
    assert.equal(errCalls.length, 1)
    const msgEl = box(document).querySelector('.mjs-modal-validation-message')
    assert.equal(msgEl.hidden, false)
    assert.equal(msgEl.textContent, 'boom')
  })
})

describe('mjs_modal — preConfirm(value) : transforme la valeur finale ou annule en renvoyant false', function () {
  it("preConfirm retourne une valeur : REMPLACE la valeur brute de l'input dans le résultat", async function () {
    const { document, µ } = loadModal()
    const calls: any[] = []
    const p = µ.modal.fire({ input: 'text', inputValue: 'brut', preConfirm: (v: any) => { calls.push(v); return { transformed: v.toUpperCase() } } })
    confirmBtn(document).click()
    const r = await p
    assert.deepEqual(calls, ['brut'])
    assert.equal(r.isConfirmed, true)
    assert.deepEqual(r.value, { transformed: 'BRUT' })
  })

  it('preConfirm retourne undefined : la valeur BRUTE (input) est conservée', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ input: 'text', inputValue: 'brut', preConfirm: () => undefined })
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.value, 'brut')
  })

  it('preConfirm retourne false : ANNULE la fermeture, la modale reste ouverte', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const p = µ.modal.fire({ text: 'x', preConfirm: () => false })
    p.then(() => { settled = true })
    confirmBtn(document).click()
    await wait(20)
    assert.equal(settled, false)
    assert.ok(box(document))
    assert.equal(confirmBtn(document).disabled, false, 'ré-activé après annulation par preConfirm')
  })

  it('preConfirm ASYNCHRONE (Promise) : awaited, valeur résolue utilisée', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', preConfirm: () => new Promise((r) => setTimeout(() => r('async-value'), 5)) })
    confirmBtn(document).click()
    const r = await p
    assert.equal(r.isConfirmed, true)
    assert.equal(r.value, 'async-value')
  })

  it('preConfirm qui REJETTE : reste ouverte, message affiché, µ.error tracé', async function () {
    const { document, µ } = loadModal()
    let settled = false
    const errCalls: any[] = []
    const p0 = µ.modal.fire({ text: 'x', preConfirm: () => Promise.reject(new Error('échec réseau')) })
    µ.error = (...a: any[]) => errCalls.push(a)
    p0.then(() => { settled = true })
    confirmBtn(document).click()
    await wait(20)
    assert.equal(settled, false)
    assert.equal(errCalls.length, 1)
    assert.equal(box(document).querySelector('.mjs-modal-validation-message').textContent, 'échec réseau')
  })

  it('inputValidator PUIS preConfirm : preConfirm ne tourne QUE si le validator est passé (null)', async function () {
    const { document, µ } = loadModal()
    const preCalls: any[] = []
    const p = µ.modal.fire({
      input: 'text', inputValue: '',
      inputValidator: (v: any) => (v ? null : 'requis'),
      preConfirm: (v: any) => { preCalls.push(v); return v; },
    })
    confirmBtn(document).click()
    await wait(20)
    assert.deepEqual(preCalls, [], 'preConfirm ne doit PAS avoir tourné : le validator a bloqué')
    assert.ok(box(document), 'reste ouverte')

    box(document).querySelector('.mjs-modal-input').value = 'ok'
    confirmBtn(document).click()
    const r = await p
    assert.deepEqual(preCalls, ['ok'])
    assert.equal(r.value, 'ok')
  })
})

describe('mjs_modal — deny/cancel ne déclenchent JAMAIS inputValidator/preConfirm', function () {
  it('deny : fermeture immédiate, validator/preConfirm jamais appelés', async function () {
    const { document, µ } = loadModal()
    const validatorCalls: any[] = []
    const preConfirmCalls: any[] = []
    const p = µ.modal.fire({
      input: 'text', showDenyButton: true,
      inputValidator: (v: any) => { validatorCalls.push(v); return 'toujours en erreur'; },
      preConfirm: (v: any) => { preConfirmCalls.push(v); return v; },
    })
    box(document).querySelector('.mjs-modal-deny').click()
    const r = await p
    assert.equal(r.isDenied, true)
    assert.deepEqual(validatorCalls, [])
    assert.deepEqual(preConfirmCalls, [])
  })

  it('cancel : fermeture immédiate, validator/preConfirm jamais appelés', async function () {
    const { document, µ } = loadModal()
    const validatorCalls: any[] = []
    const p = µ.modal.fire({
      input: 'text', showCancelButton: true,
      inputValidator: (v: any) => { validatorCalls.push(v); return 'toujours en erreur'; },
    })
    box(document).querySelector('.mjs-modal-cancel').click()
    const r = await p
    assert.equal(r.isDismissed, true)
    assert.equal(r.dismiss, 'cancel')
    assert.deepEqual(validatorCalls, [])
  })
})
