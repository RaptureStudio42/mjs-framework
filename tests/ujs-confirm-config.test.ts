// Tests — branchement de la modale @confirm PAR CONFIGURATION (µ.config.confirm,
// mjs_init.ts), consommé par le routeur par défaut de µ.confirm (mjs_ujs.ts). Portée
// STRICTEMENT le routage : false/absent/null → window.confirm natif ; true → µ.modal.fire
// (mjs_modal.ts) — µ.modal absent du build (module optionnel 'modal' non inclus) → repli natif
// + avertissement ; toute AUTRE valeur (ancien branchement 'sweetalert2'/classe-objet, RETIRÉ)
// → repli natif + un seul avertissement par session. Réassignation directe de µ.confirm par
// l'application PRIME toujours. Les gates (clic/submit) et µ._mjs_ujsConfirmRefire ne sont PAS modifiés
// ici — ils sont seulement RÉUTILISÉS (extraits tels quels, comme dans
// ujs-confirm-method.test.ts) pour prouver l'intégration bout-en-bout (relance après
// résolution, message + élément porteur transmis) plutôt que de re-tester leur propre
// sémantique déjà couverte par ce fichier voisin.
//
// Même motif d'isolation que ujs-confirm-method.test.ts/ujs-shadow-confirm.test.ts :
// extraction du corps SOURCE des blocs concernés (regex + comptage d'accolades), exécutée
// via `new Function`, jamais d'exécution réelle du module (mjs_ujs.ts attache des listeners
// PERMANENTS à document/window dès l'import).
//
// Hygiène warn-once SANS crochet de test ni afterEach : `installConfirmDefault(µ, win)`
// exécute le bloc `var _confirmCfgWarned = false; µ.confirm = function(...) {...}` dans une
// fermeture FRAÎCHE à chaque appel (nouvelle `new Function(...)` par construction) — chaque
// `it` obtient donc son propre `_confirmCfgWarned` isolé, sans jamais fuiter vers le test
// suivant. Le test « une seule fois pour deux clics » (plus bas) simule les 2 clics EN
// APPELANT `installConfirmDefault` UNE SEULE fois puis en cliquant deux fois sur la MÊME
// fermeture — c'est exactement le scénario réel (une session = un chargement de module = une
// fermeture). Plus simple et plus robuste qu'un flag exposé/réinitialisable depuis les tests.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractClickBody(): string {
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick')
}
function extractConfirmRefireStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire')
}
// bloc COMPLET du routeur par défaut : `_confirmCfgWarned` vit dans la fermeture de
// µ.confirm — l'extraire sans sa déclaration laisserait une ReferenceError à l'exécution.
function extractConfirmDefaultBlock(): string {
  return extractMarked(UJS_SRC, 'confirm-default')
}

function makeClickHandler() {
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', 'FormData', extractClickBody())
}
// installe le VRAI µ.confirm par défaut (routeur de config) sur le µ/window donnés —
// fermeture fraîche à chaque appel, cf. note d'hygiène en tête de fichier.
function installConfirmDefault(µ: any, win: any) {
  new Function('µ', 'window', extractConfirmDefaultBlock())(µ, win)
}
// relance partagée @confirm : gréffée sur LE µ du handler, jamais le vrai module
// (isolation, cf. en-tête) — nécessaire pour les scénarios thenable (Swal/classe custom).
function withConfirmRefire(µ: any) {
  new Function('µ', extractConfirmRefireStatement())(µ)
  return µ
}

// ── Fakes DOM MINIATURES (mêmes sélecteurs que mjs_ujs.ts, copiés de
// ujs-confirm-method.test.ts pour rester identiques au harnais voisin) ──────
function matchesSingle(el: any, sel: string): boolean {
  sel = sel.trim()
  const attrMatch = sel.match(/^\[([a-zA-Z-]+)\]$/)
  if (attrMatch) { return el.hasAttribute(attrMatch[1]) }
  const typeMatch = sel.match(/^([a-zA-Z]+)\[type='([a-zA-Z]+)'\]$/)
  if (typeMatch) { return el.tagName === typeMatch[1].toUpperCase() && el.getAttribute('type') === typeMatch[2] }
  const notTypeMatch = sel.match(/^([a-zA-Z]+):not\(\[type\]\)$/)
  if (notTypeMatch) { return el.tagName === notTypeMatch[1].toUpperCase() && !el.hasAttribute('type') }
  return el.tagName === sel.toUpperCase()
}
function matchesSelector(el: any, sel: string): boolean {
  return sel.split(',').some((s) => matchesSingle(el, s))
}
function makeFakeEl(tag: string, attrs: Record<string, string> = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  const el: any = {
    tagName: tag.toUpperCase(),
    parentElement: null,
    children: [] as any[],
    _shadow: null,
    focusCalls: [] as any[],
    disabled: false,
    isConnected: true,
    clickCalls: [] as any[],
    click() { this.clickCalls.push(true) },
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
    setAttribute(name: string, val: string) { attributes[name] = String(val) },
    removeAttribute(name: string) { delete attributes[name] },
    matches(sel: string) { return matchesSelector(el, sel) },
    closest(sel: string) {
      let n: any = el
      while (n) { if (matchesSelector(n, sel)) { return n } n = n.parentElement }
      return null
    },
    querySelectorAll(sel: string) {
      const out: any[] = []
      const walk = (node: any) => { for (const c of node.children) { if (matchesSelector(c, sel)) { out.push(c) } walk(c) } }
      walk(el)
      return out
    },
    appendChild(child: any) { child.parentElement = el; el.children.push(child); return child },
    focus(opts: any) { this.focusCalls.push(opts) },
  }
  return el
}
function makeLink(attrs: Record<string, string> = {}, urlBits: Record<string, string> = {}) {
  const el = makeFakeEl('a', attrs)
  Object.assign(el, {
    origin: 'http://x', target: '', protocol: 'http:',
    pathname: '/', search: '', hash: '', href: 'http://x/',
  }, urlBits)
  return el
}
function makeClickEvent(target: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagationCalled: false,
    stopImmediatePropagation() { this.stopImmediatePropagationCalled = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [target],
    target: target,
  }
}
class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
  *[Symbol.iterator]() { yield* this.map }
}
// PAS de `confirm` par défaut ici (contrairement au baseMu voisin) : chaque test installe
// le VRAI routeur via installConfirmDefault, ou réassigne µ.confirm à la main (scénario
// « prime toujours »). PAS de `config` par défaut non plus : absent tant qu'un test ne le
// fournit pas, pour exercer le garde `µ.config && …` avec un µ.config réellement `undefined`.
function baseMu(win: any, overrides: any = {}) {
  return Object.assign({
    realTarget: (e: any) => e.target,
    warn() {}, error() {}, log() {},
    Router: { navigate() {} },
    // µ._mjs_navNoUjs (opt-out @noUJS) : hors du bloc helpers extrait par
    // extractClickBody (ne prend QUE le corps du handler) — mock fidèle, même motif que
    // µ.realTarget ci-dessus.
    _mjs_navNoUjs: (el: any) => !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('mjs-no-ujs'),
    _mjs_navWarnNoUjsMethod: () => {},
  }, overrides)
}

describe('mjs_ujs — µ.config.confirm : branchement de la modale @confirm par configuration', function () {

  describe("config absente/false/null — repli window.confirm natif, comportement historique à l'octet près", function () {
    it('µ.config absent (undefined) : window.confirm reçoit le message, accepté → pushState + Router.navigate', function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      let confirmMsg: any
      const pushStateCalls: any[] = []
      const navigateCalls: any[] = []
      const win: any = {
        confirm: (msg: string) => { confirmMsg = msg; return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
      }
      const µ = baseMu(win, { Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmMsg, 'Sûr ?')
      assert.equal(pushStateCalls.length, 1, 'accepté : action déclenchée')
      assert.equal(navigateCalls.length, 1)
    })

    it('µ.config.confirm = null explicite : même repli, refusé → STOP total (aucun pushState/navigate)', function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail' })
      const pushStateCalls: any[] = []
      const navigateCalls: any[] = []
      const win: any = {
        confirm: () => false,
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
      }
      const µ = baseMu(win, { config: { confirm: null }, Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      const e = makeClickEvent(link)
      handler(e, µ, win, {}, class {}, FakeFormData)

      assert.equal(e.defaultPrevented, true, 'refus : preventDefault posé quand même')
      assert.equal(pushStateCalls.length, 0, 'refus : aucun pushState')
      assert.equal(navigateCalls.length, 0, 'refus : aucune navigation')
    })

    it('µ.config.confirm = false explicite (valeur canonique du nouveau contrat) : même repli, accepté → pushState + Router.navigate', function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      let confirmMsg: any
      const pushStateCalls: any[] = []
      const navigateCalls: any[] = []
      const win: any = {
        confirm: (msg: string) => { confirmMsg = msg; return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
      }
      const µ = baseMu(win, { config: { confirm: false }, Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmMsg, 'Sûr ?')
      assert.equal(pushStateCalls.length, 1, 'accepté : action déclenchée')
      assert.equal(navigateCalls.length, 1)
    })
  })

  describe('µ.config.confirm = true — modale maison µ.modal.fire (mjs_modal.ts)', function () {
    it('µ.modal présent, isConfirmed:true — µ.modal.fire reçoit exactement {text,icon,showCancelButton}, relance après résolution', async function () {
      const link = makeLink({ 'mjs-confirm': 'Supprimer ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const fireCalls: any[] = []
      const win: any = {
        confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.modal est présent') },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const modal = { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true, isDenied: false, isDismissed: false, value: undefined, dismiss: undefined }) } }
      const µ = withConfirmRefire(baseMu(win, { config: { confirm: true }, modal }))
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      const e = makeClickEvent(link)
      handler(e, µ, win, {}, class {}, FakeFormData)

      assert.equal(e.defaultPrevented, true, "thenable : l'événement d'origine est bloqué immédiatement")
      assert.equal(fireCalls.length, 1)
      assert.deepEqual(fireCalls[0], { text: 'Supprimer ?', icon: 'question', showCancelButton: true }, 'pas de titre ni de libellés de boutons en dur')

      await new Promise((r) => setTimeout(r, 0))
      assert.equal(link.clickCalls.length, 1, "relance : .click() sur la cible d'origine")
    })

    it('µ.modal présent, isConfirmed:false — aucune relance', async function () {
      const link = makeLink({ 'mjs-confirm': 'Supprimer ?' }, { hash: '#/detail' })
      const win: any = {
        confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.modal est présent') },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const modal = { fire: () => Promise.resolve({ isConfirmed: false, isDenied: false, isDismissed: true, value: undefined, dismiss: 'cancel' }) }
      const µ = withConfirmRefire(baseMu(win, { config: { confirm: true }, modal }))
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      const e = makeClickEvent(link)
      handler(e, µ, win, {}, class {}, FakeFormData)

      assert.equal(e.defaultPrevented, true)
      await new Promise((r) => setTimeout(r, 0))
      assert.equal(link.clickCalls.length, 0, 'refus : aucune relance')
    })

    it('µ.modal ABSENT (module runtime non inclus) : repli window.confirm, avertissement émis UNE SEULE fois pour deux clics', function () {
      const link = makeLink({ 'mjs-confirm': 'Supprimer ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const confirmCalls: string[] = []
      const warnCalls: any[] = []
      const pushStateCalls: any[] = []
      const win: any = {
        confirm: (msg: string) => { confirmCalls.push(msg); return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
      }
      const µ = baseMu(win, { config: { confirm: true }, warn: (...a: any[]) => warnCalls.push(a) }) // pas de `modal` sur ce µ
      installConfirmDefault(µ, win) // une seule installation : fermeture `_confirmCfgWarned` PARTAGÉE par les 2 clics ci-dessous
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmCalls.length, 2, 'le repli natif est redemandé à CHAQUE clic (seul le warning est one-shot)')
      assert.equal(pushStateCalls.length, 2, "les deux clics acceptés ont bien laissé passer l'action")
      assert.equal(warnCalls.length, 1, 'avertissement émis une seule fois malgré les 2 clics')
      assert.match(warnCalls[0][0], /µ\.modal/)
    })
  })

  describe("µ.config.confirm inutilisable (ancien contrat 'sweetalert2'/classe-objet, ou toute valeur ≠ true/false) — repli natif + avertissement", function () {
    it("ancienne valeur 'sweetalert2' (branchement RETIRÉ) : repli window.confirm + avertissement, même avec window.Swal présent", function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const confirmCalls: string[] = []
      const warnCalls: any[] = []
      const win: any = {
        Swal: { fire: () => { throw new Error('window.Swal ne doit plus jamais être consulté : le branchement sweetalert2 est retiré') } },
        confirm: (msg: string) => { confirmCalls.push(msg); return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const µ = baseMu(win, { config: { confirm: 'sweetalert2' }, warn: (...a: any[]) => warnCalls.push(a) })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmCalls.length, 1, 'repli natif malgré tout')
      assert.equal(warnCalls.length, 1)
      assert.match(warnCalls[0][0], /true\/false/)
    })

    it("ancienne valeur classe/objet exposant confirm(message, élément) (branchement RETIRÉ) : repli window.confirm + avertissement, la méthode confirm() n'est jamais appelée", function () {
      const link = makeLink({ 'mjs-confirm': 'Publier ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const confirmCalls: string[] = []
      const warnCalls: any[] = []
      class Modale {
        static confirm() { throw new Error("l'ancien branchement classe/objet est retiré : confirm() ne doit plus jamais être appelé") }
      }
      const win: any = {
        confirm: (msg: string) => { confirmCalls.push(msg); return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const µ = baseMu(win, { config: { confirm: Modale }, warn: (...a: any[]) => warnCalls.push(a) })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmCalls.length, 1, 'repli natif malgré tout')
      assert.equal(warnCalls.length, 1)
      assert.match(warnCalls[0][0], /true\/false/)
    })

    it('valeur scalaire (ex. 42) : repli window.confirm + avertissement', function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const confirmCalls: string[] = []
      const warnCalls: any[] = []
      const win: any = {
        confirm: (msg: string) => { confirmCalls.push(msg); return true },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const µ = baseMu(win, { config: { confirm: 42 }, warn: (...a: any[]) => warnCalls.push(a) })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(confirmCalls.length, 1, 'repli natif malgré tout')
      assert.equal(warnCalls.length, 1)
      assert.match(warnCalls[0][0], /true\/false/)
    })

    it("avertissement UNE SEULE fois même en mélangeant les anciennes formes ('sweetalert2' puis objet) sur la même fermeture", function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const warnCalls: any[] = []
      const win: any = {
        confirm: () => true,
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState() {} },
      }
      const µ = baseMu(win, { config: { confirm: 'sweetalert2' }, warn: (...a: any[]) => warnCalls.push(a) })
      installConfirmDefault(µ, win)
      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
      µ.config.confirm = { x: 1 }
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(warnCalls.length, 1, 'le warn-once porte sur la FERMETURE (une installation), pas sur la valeur précise')
    })
  })

  describe("µ.confirm réassigné directement par l'application", function () {
    it("prime TOUJOURS sur µ.config.confirm : avec confirm='sweetalert2' ET window.Swal posés, c'est la réassignation qui tourne, Swal.fire jamais touché", function () {
      const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
      const fireCalls: any[] = []
      const pushStateCalls: any[] = []
      let customCalls = 0
      const win: any = {
        Swal: { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true }) } },
        confirm: () => { throw new Error('window.confirm ne doit jamais être appelé non plus') },
        location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
        history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
      }
      const µ = baseMu(win, { config: { confirm: 'sweetalert2' } })
      installConfirmDefault(µ, win) // pose d'abord le routeur par défaut…
      µ.confirm = function(_message: string, _el: any) { customCalls++; return true } // …puis l'appli réassigne PAR-DESSUS

      const handler = makeClickHandler()
      handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

      assert.equal(customCalls, 1, "la fonction réassignée par l'appli est bien celle appelée")
      assert.equal(fireCalls.length, 0, 'Swal.fire jamais touché : la réassignation court-circuite totalement le routeur de config')
      assert.equal(pushStateCalls.length, 1, 'accepté (retour true synchrone) : action déclenchée')
    })
  })
})
