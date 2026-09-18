// Tests neufs — µ.modal.notify(message, opts) (mjs_modal.ts) : toast empilé en
// haut-droite (.mjs-toasts, créé au 1er appel puis réutilisé), message en textContent (jamais
// innerHTML), bouton ×, barre de vie animée (durée via --mjs-toast-duration), rôle ARIA par
// type, empilement indépendant (timer propre par appel). Même méthode que mjs-modal-fire.test.ts
// (cf. son en-tête) — durées de test COURTES et réelles pour les timers (pas de fake timers).

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

function container(document: any): any {
  return document.body.querySelector('.mjs-toasts')
}
function toasts(document: any): any[] {
  return Array.from(container(document)?.querySelectorAll('.mjs-toast') ?? [])
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mjs_modal — µ.modal.notify (toast)', function () {
  it('1er appel : monte .mjs-toasts dans document.body, contenant un .mjs-toast', function () {
    const { document, µ } = loadModal()
    assert.equal(container(document), null, 'précondition : rien avant le 1er appel')
    µ.modal.notify('hop')
    assert.ok(container(document), '.mjs-toasts doit être monté')
    assert.equal(toasts(document).length, 1)
  })

  it('2e appel : le MÊME conteneur est réutilisé (pas recréé)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('un')
    const first = container(document)
    µ.modal.notify('deux')
    assert.equal(container(document), first, 'même référence de nœud')
  })

  it('empilement ×2 : deux toasts INDÉPENDANTS dans le même conteneur', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('un')
    µ.modal.notify('deux')
    const list = toasts(document)
    assert.equal(list.length, 2)
    assert.equal(list[0].querySelector('.mjs-toast-message').textContent, 'un')
    assert.equal(list[1].querySelector('.mjs-toast-message').textContent, 'deux')
  })

  it('empilement ×2 : chaque toast a son PROPRE timer — fermer le premier ne touche pas le second', async function () {
    const { document, µ } = loadModal()
    const h1 = µ.modal.notify('un', { duration: 10 })
    µ.modal.notify('deux', { duration: 10000 })
    h1.close()
    assert.equal(toasts(document).length, 1, "le 1er retiré, le 2e reste (timer propre, pas d'interférence)")
    assert.equal(toasts(document)[0].querySelector('.mjs-toast-message').textContent, 'deux')
  })

  it('message en textContent — JAMAIS innerHTML (une chaîne avec balise reste du texte littéral)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('<b>hop</b>')
    const msgEl = toasts(document)[0].querySelector('.mjs-toast-message')
    assert.equal(msgEl.textContent, '<b>hop</b>')
    assertAbsent(msgEl.querySelector('b'), 'jamais interprété comme HTML')
  })

  it('close() (handle rendu) retire le toast du DOM', function () {
    const { document, µ } = loadModal()
    const handle = µ.modal.notify('x')
    assert.equal(toasts(document).length, 1)
    handle.close()
    assert.equal(toasts(document).length, 0)
  })

  it('close() est idempotent (2e appel : no-op silencieux)', function () {
    const { document, µ } = loadModal()
    const handle = µ.modal.notify('x')
    handle.close()
    assert.doesNotThrow(() => handle.close())
    assert.equal(toasts(document).length, 0)
  })

  it('bouton × (button.mjs-toast-close) retire le toast au clic', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x')
    const t = toasts(document)[0]
    const closeBtn = t.querySelector('.mjs-toast-close')
    assert.ok(closeBtn, 'bouton × doit exister')
    assert.equal(closeBtn.tagName, 'BUTTON')
    closeBtn.click()
    assert.equal(toasts(document).length, 0)
  })

  it('auto-retrait après duration (réelle, courte)', async function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { duration: 15 })
    assert.equal(toasts(document).length, 1)
    await wait(60)
    assert.equal(toasts(document).length, 0, 'retiré tout seul après le délai')
  })

  it('duration:0 — permanent : aucun retrait automatique, aucune barre de vie', async function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { duration: 0 })
    await wait(30)
    assert.equal(toasts(document).length, 1, 'toujours présent')
    assertAbsent(toasts(document)[0].querySelector('.mjs-toast-barre'), 'pas de décompte sans durée')
  })

  it('duration par défaut = 4000ms (setTimeout intercepté, aucune attente réelle)', function () {
    const { window, µ } = loadModal()
    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    try { µ.modal.notify('x') } finally { window.setTimeout = orig }
    assert.ok(delays.includes(4000), `4000ms attendu parmi ${JSON.stringify(delays)}`)
  })

  it('µ.config.notifyDuration — nouveau défaut GLOBAL respecté quand opts.duration est absent', function () {
    const { window, µ } = loadModal()
    µ.config.notifyDuration = 9000
    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    try { µ.modal.notify('x') } finally { window.setTimeout = orig }
    assert.ok(delays.includes(9000), `9000ms (config) attendu parmi ${JSON.stringify(delays)}`)
    assert.equal(delays.includes(4000), false, "l'ancien défaut 4000 ne doit plus apparaître une fois la config changée")
  })

  it('µ.config.notifyDuration — opts.duration d\'un appel précis PRIME toujours sur la config globale', function () {
    const { window, µ } = loadModal()
    µ.config.notifyDuration = 9000
    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    try { µ.modal.notify('x', { duration: 250 }) } finally { window.setTimeout = orig }
    assert.ok(delays.includes(250), `250ms (opts) attendu parmi ${JSON.stringify(delays)}`)
    assert.equal(delays.includes(9000), false, 'la config ne doit pas être utilisée quand opts.duration est fourni')
  })

  it("µ.config.notifyDuration — opts.duration:0 reste PERMANENT même si la config globale est non nulle", function () {
    const { document, µ } = loadModal()
    µ.config.notifyDuration = 9000
    µ.modal.notify('x', { duration: 0 })
    assertAbsent(toasts(document)[0].querySelector('.mjs-toast-barre'), 'duration:0 explicite reste permanent, prime sur la config')
  })

  it('µ.config.notifyDuration = 0 — défaut GLOBAL permanent quand opts.duration est absent (aucune barre de vie)', function () {
    const { document, µ } = loadModal()
    µ.config.notifyDuration = 0
    µ.modal.notify('x')
    assertAbsent(toasts(document)[0].querySelector('.mjs-toast-barre'), 'notifyDuration:0 rend le défaut global permanent, comme opts.duration:0')
  })

  it('µ.config.notifyDuration invalide (négatif) : repli silencieux sur 4000, aucun crash', function () {
    const { window, µ } = loadModal()
    µ.config.notifyDuration = -50
    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    assert.doesNotThrow(() => { try { µ.modal.notify('x') } finally { window.setTimeout = orig } })
    assert.ok(delays.includes(4000), `repli 4000 attendu parmi ${JSON.stringify(delays)}`)
  })

  it('barre de vie (i.mjs-toast-barre) présente quand duration > 0, durée posée via --mjs-toast-duration (setProperty, pas de style inline classique)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { duration: 1234 })
    const barre = toasts(document)[0].querySelector('.mjs-toast-barre')
    assert.ok(barre, 'barre de vie attendue')
    assert.equal(barre.tagName, 'I')
    assert.equal(barre.style.getPropertyValue('--mjs-toast-duration').trim(), '1234ms')
  })

  it("type par défaut = 'info' (classe mjs-toast-info, role=status + aria-live=polite)", function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x')
    const t = toasts(document)[0]
    assert.ok(t.classList.contains('mjs-toast-info'))
    assert.equal(t.getAttribute('role'), 'status')
    assert.equal(t.getAttribute('aria-live'), 'polite')
  })

  for (const type of ['success', 'warning', 'info']) {
    it(`type:'${type}' — classe mjs-toast-${type}, role="status" aria-live="polite"`, function () {
      const { document, µ } = loadModal()
      µ.modal.notify('x', { type })
      const t = toasts(document)[0]
      assert.ok(t.classList.contains('mjs-toast-' + type))
      assert.equal(t.getAttribute('role'), 'status')
      assert.equal(t.getAttribute('aria-live'), 'polite')
    })
  }

  it('type:\'error\' — classe mjs-toast-error, role="alert" (pas aria-live=polite)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { type: 'error' })
    const t = toasts(document)[0]
    assert.ok(t.classList.contains('mjs-toast-error'))
    assert.equal(t.getAttribute('role'), 'alert')
    assert.notEqual(t.getAttribute('aria-live'), 'polite')
  })

  it("type inconnu (typo) : repli silencieux sur 'info', aucun crash", function () {
    const { document, µ } = loadModal()
    assert.doesNotThrow(() => { µ.modal.notify('x', { type: 'succes' as any }) })
    assert.ok(toasts(document)[0].classList.contains('mjs-toast-info'))
  })

  it('notify(message) sans opts (undefined) : aucun crash, défauts appliqués', function () {
    const { document, µ } = loadModal()
    assert.doesNotThrow(() => { µ.modal.notify('x') })
    assert.ok(toasts(document)[0].classList.contains('mjs-toast-info'))
  })

  it('zéro style inline classique sur le message/bouton × (seule la barre porte --mjs-toast-duration via setProperty)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { duration: 500 })
    const t = toasts(document)[0]
    assert.equal(t.hasAttribute('style'), false)
    assert.equal(t.querySelector('.mjs-toast-message').hasAttribute('style'), false)
    assert.equal(t.querySelector('.mjs-toast-close').hasAttribute('style'), false)
  })
})
