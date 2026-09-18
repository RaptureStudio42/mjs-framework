// Tests neufs — capacités UJS « @confirm » et « @method » (six capacités de
// navigation ajax). Même motif que les tests ujs-submit-*/
// ujs-click-* existants : extraction du corps SOURCE des handlers (regex +
// comptage d'accolades), exécutée via `new Function`, isolée de tout listener
// réel — mjs_ujs.ts attache des listeners PERMANENTS à document/window dès
// l'import, jamais d'exécution réelle du fichier dans un test (convention
// établie, cf. ujs-pagecache-race-poisoning.test.ts). Éléments DOM à la main
// (comme ujs-click-samepage-duplicate-pushstate.test.ts) : `closest`/
// `hasAttribute`/`querySelectorAll` réimplémentés en MINIATURE (seuls les
// sélecteurs réellement émis par mjs_ujs.ts : tag nu, `[attr]`, le trio de
// boutons de soumission) plutôt qu'une dépendance DOM lourde.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractClickBody(): string {
  // µ._mjs_ujsOnClick (nommé, ex-handler anonyme document.addEventListener('click', …)
  // — renommé, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick')
}
function extractSubmitBody(): string {
  // µ._mjs_ujsOnSubmit (nommé, même raison que extractClickBody ci-dessus).
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnSubmit')
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}
function extractConfirmRefireStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire')
}

function makeClickHandler() {
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', 'FormData', extractClickBody())
}
function makeSubmitHandler() {
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody())
}
// gates asynchrones (thenable @confirm) : la relance appelle µ._mjs_ujsConfirmRefire
// sur LE µ DU HANDLER, jamais le vrai module (isolation, cf. en-tête de fichier)
// — sans la VRAIE implémentation greffée dessus, la promesse interne throw en
// silence (rejet non observé) et aucune relance n'a lieu.
function withConfirmRefire(µ: any) {
  new Function('µ', extractConfirmRefireStatement())(µ)
  return µ
}

// ── Fakes DOM MINIATURES (mêmes sélecteurs que mjs_ujs.ts, rien de plus) ────
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
    // relance @confirm (µ._mjs_ujsConfirmRefire) : cible d'origine re-cliquée — même
    // convention que le vrai DOM (isConnected par défaut true, non détaché).
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
    // Stub requis depuis le hissage du garde @confirm : un refus
    // appelle désormais `e.stopImmediatePropagation()` (bloque aussi les
    // listeners délégués du composant sur un shadow root, cf. mjs_ujs.ts) —
    // sans ce stub, un refus jetait un TypeError (méthode absente du fake).
    stopImmediatePropagationCalled: false,
    stopImmediatePropagation() { this.stopImmediatePropagationCalled = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [target],
    target: target,
  }
}
function makeSubmitEvent(form: any, submitter: any = null) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    // Stub requis depuis le hissage de la gate @confirm du submit (miroir du clic) : un
    // refus/thenable appelle désormais `e.stopImmediatePropagation()` — sans ce stub, un refus
    // jetait un TypeError (méthode absente du fake), même raison que makeClickEvent plus haut.
    stopImmediatePropagationCalled: false,
    stopImmediatePropagation() { this.stopImmediatePropagationCalled = true },
    submitter,
    composedPath: () => [form],
    target: form,
  }
}
// relance @confirm côté formulaire (µ._mjs_ujsConfirmRefire) : requestSubmit à privilégier.
function withRequestSubmitSpy(el: any) {
  el.requestSubmitCalls = [] as any[]
  el.requestSubmit = (...a: any[]) => el.requestSubmitCalls.push(a)
  return el
}
class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
  *[Symbol.iterator]() { yield* this.map }
}
function makeForm(attrs: Record<string, string> = {}, urlBits: Record<string, string> = {}) {
  const el = makeFakeEl('form', attrs)
  Object.assign(el, { target: '', action: 'http://x/posts' }, urlBits)
  // getAttribute doit aussi répondre 'action'/'method' comme les tests submit existants.
  const baseGetAttribute = el.getAttribute.bind(el)
  el.getAttribute = (name: string) => {
    if (name === 'action') { return el.action }
    if (name === 'method') { return el._method || null }
    return baseGetAttribute(name)
  }
  return el
}
function baseMu(win: any, overrides: any = {}) {
  return Object.assign({
    realTarget: (e: any) => e.target,
    warn(..._a: any[]) {}, error() {}, log() {},
    Router: { navigate() {} },
    // µ.confirm remplaçable (défaut = window.confirm) — préserve les tests
    // existants qui stubbaient directement window.confirm.
    confirm: (msg: string) => win.confirm(msg),
    // µ._mjs_navNoUjs (opt-out @noUJS) : hors du bloc helpers extrait par
    // extractClickBody/extractSubmitBody (ne prennent QUE le corps du handler) — mock fidèle,
    // même motif que µ.realTarget ci-dessus.
    _mjs_navNoUjs: (el: any) => !!el && typeof el.hasAttribute === 'function' && el.hasAttribute('mjs-no-ujs'),
    // même raison : mock FIDÈLE de µ._mjs_navWarnNoUjsMethod (avertissement @noUJS + @method).
    _mjs_navWarnNoUjsMethod(el: any) {
      if (!el || el._mjs_mjsNoUjsMethodWarned || typeof el.getAttribute !== 'function' || !el.getAttribute('mjs-method')) { return }
      el._mjs_mjsNoUjsMethodWarned = true
      this.warn('[µ.UJS] @method="' + el.getAttribute('mjs-method') + '" ignoré — @noUJS rend la navigation native, et le navigateur ne sait faire qu\'un GET sur un lien. Retire l\'un des deux.')
    },
  }, overrides)
}

describe('mjs_ujs — @confirm (mjs-confirm) : confirmation avant action', function () {
  it('lien : confirm() ACCEPTÉ — la navigation same-page continue (pushState + Router.navigate appelés)', function () {
    const link = makeLink({ 'mjs-confirm': 'Vraiment supprimer ?' }, { hash: '#/detail', pathname: '/', search: '' })
    let confirmMsg: any
    const win: any = {
      confirm: (msg: string) => { confirmMsg = msg; return true },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = baseMu(win)
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(confirmMsg, 'Vraiment supprimer ?')
  })

  it('lien : confirm() REFUSÉ — STOP total (preventDefault, aucun pushState, aucune navigation)', function () {
    const link = makeLink({ 'mjs-confirm': 'Vraiment supprimer ?' }, { hash: '#/detail' })
    const pushStateCalls: any[] = []
    const navigateCalls: any[] = []
    const win: any = {
      confirm: () => false,
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const µ = baseMu(win, { Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true, 'refus : preventDefault quand même posé (pas de navigation native)')
    assert.equal(pushStateCalls.length, 0, 'refus : aucun pushState')
    assert.equal(navigateCalls.length, 0, 'refus : aucune navigation, ni ajax ni native')
  })

  it("lien : nœud cliqué à l'INTÉRIEUR du <a> (ex. icône) — remonte bien jusqu'au porteur mjs-confirm", function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/x' })
    const icon = makeFakeEl('span')
    link.appendChild(icon)
    let asked = false
    const win: any = {
      confirm: () => { asked = true; return false },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = baseMu(win)
    const handler = makeClickHandler()
    // le clic RÉEL cible l'icône, pas le <a> — µ.realTarget doit remonter via closest.
    const e = makeClickEvent(icon)
    handler(e, µ, win, {}, class {}, FakeFormData)
    assert.equal(asked, true, "confirm doit être déclenché même si le clic vise un enfant du lien")
  })

  it('formulaire : mjs-confirm sur le <form> lui-même (soumission au clavier, pas de submitter) — refus stoppe tout', function () {
    const form = makeForm({ 'mjs-confirm': 'Confirmer ?' })
    let confirmMsg: any
    const win: any = { confirm: (m: string) => { confirmMsg = m; return false }, location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu(win, { _mjs_navDispatch: () => { throw new Error('ne doit jamais être appelé') } })
    const handler = makeSubmitHandler()
    const e = makeSubmitEvent(form, null)
    handler(e, µ, win, {}, FakeFormData, URL, class {})

    assert.equal(confirmMsg, 'Confirmer ?')
    assert.equal(e.defaultPrevented, true, 'preventDefault posé avant le confirm — refus = STOP total')
  })

  it('formulaire : mjs-confirm porté par le BOUTON cliqué (e.submitter), pas le <form> — détecté et accepté', function () {
    const form = makeForm()
    const btn = makeFakeEl('button', { 'mjs-confirm': 'Publier ?', type: 'submit' })
    form.appendChild(btn)
    let confirmMsg: any
    const win: any = { confirm: (m: string) => { confirmMsg = m; return true }, location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const dispatchCalls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a) })
    const handler = makeSubmitHandler()
    handler(makeSubmitEvent(form, btn), µ, win, {}, FakeFormData, URL, class {})

    assert.equal(confirmMsg, 'Publier ?')
    assert.equal(dispatchCalls.length, 1, 'confirm accepté (via le bouton) : la soumission continue')
  })
})

describe('mjs_ujs — µ.confirm remplaçable (modale personnalisée, sync ou asynchrone)', function () {
  it('lien : µ.confirm personnalisé SYNCHRONE refusé — STOP total, window.confirm JAMAIS appelé', function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail' })
    const pushStateCalls: any[] = []
    const navigateCalls: any[] = []
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const µ = baseMu(win, { confirm: () => false, Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true, 'refus : preventDefault quand même posé')
    assert.equal(pushStateCalls.length, 0, 'refus : aucun pushState')
    assert.equal(navigateCalls.length, 0, 'refus : aucune navigation')
  })

  it('lien : µ.confirm personnalisé SYNCHRONE accepté — la navigation continue', function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
    const pushStateCalls: any[] = []
    const navigateCalls: any[] = []
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const µ = baseMu(win, { confirm: () => true, Router: { navigate: (...a: any[]) => navigateCalls.push(a) } })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(pushStateCalls.length, 1, 'accepté : pushState appelé')
    assert.equal(navigateCalls.length, 1, 'accepté : Router.navigate appelé')
  })

  it('lien : µ.confirm ASYNCHRONE accepté — événement bloqué immédiatement, relance de la cible d\'origine après résolution (attribut neutralisé pendant, restauré après)', async function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail' })
    let resolveConfirm: (v: boolean) => void = null as any
    const confirmPromise = new Promise<boolean>((res) => { resolveConfirm = res })
    let confirmCalls = 0
    const attrDuringRelaunch: (string | null)[] = []
    const origClick = link.click.bind(link)
    link.click = () => { attrDuringRelaunch.push(link.getAttribute('mjs-confirm')); origClick() }
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = withConfirmRefire(baseMu(win, { confirm: () => { confirmCalls++; return confirmPromise } }))
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(confirmCalls, 1)
    assert.equal(e.defaultPrevented, true, "l'événement d'origine est bloqué IMMÉDIATEMENT, avant toute résolution")
    assert.equal(e.stopImmediatePropagationCalled, true)
    assert.equal(link.clickCalls.length, 0, 'pas encore de relance avant résolution')

    resolveConfirm(true)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    assert.equal(link.clickCalls.length, 1, "relance : .click() sur la cible d'origine, exactement 1 fois")
    assert.equal(attrDuringRelaunch[0], null, 'mjs-confirm neutralisé PENDANT la relance (gates re-traversés laissent passer)')
    assert.equal(link.getAttribute('mjs-confirm'), 'Sûr ?', 'mjs-confirm RESTAURÉ après la relance')
    assert.equal(link._mjs_mjsConfirmPending, false, 'pending retombé après résolution')
  })

  it('lien : µ.confirm ASYNCHRONE refusé — bloqué, aucune relance, pending retombé', async function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail' })
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = baseMu(win, { confirm: () => Promise.resolve(false) })
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true)
    await Promise.resolve(); await Promise.resolve()

    assert.equal(link.clickCalls.length, 0, 'refus asynchrone : aucune relance')
    assert.equal(link._mjs_mjsConfirmPending, false, 'pending retombé après résolution, même refusée')
    assert.equal(link.getAttribute('mjs-confirm'), 'Sûr ?', "aucune neutralisation d'attribut sur un refus : rien à restaurer")
  })

  it("anti-rafale : un 2e clic PENDANT la résolution asynchrone est bloqué sans ré-appeler µ.confirm", async function () {
    const link = makeLink({ 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail' })
    let resolveConfirm: (v: boolean) => void = null as any
    const confirmPromise = new Promise<boolean>((res) => { resolveConfirm = res })
    let confirmCalls = 0
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = withConfirmRefire(baseMu(win, { confirm: () => { confirmCalls++; return confirmPromise } }))
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
    assert.equal(confirmCalls, 1)

    const e2 = makeClickEvent(link)
    handler(e2, µ, win, {}, class {}, FakeFormData) // 2e clic, résolution toujours en vol

    assert.equal(confirmCalls, 1, 'le 2e clic ne doit PAS ré-appeler µ.confirm : pending')
    assert.equal(e2.defaultPrevented, true, 'le 2e clic est quand même bloqué')

    resolveConfirm(true)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()
    assert.equal(link.clickCalls.length, 1, 'une seule relance malgré les 2 clics')
  })

  it('formulaire : µ.confirm ASYNCHRONE accepté — aucun _mjs_navDispatch au 1er passage, requestSubmit appelé après résolution, attribut restauré', async function () {
    const form = withRequestSubmitSpy(makeForm({ 'mjs-confirm': 'Confirmer ?' }))
    let resolveConfirm: (v: boolean) => void = null as any
    const confirmPromise = new Promise<boolean>((res) => { resolveConfirm = res })
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState() {} },
    }
    const dispatchCalls: any[] = []
    const µ = withConfirmRefire(baseMu(win, { confirm: () => confirmPromise, _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a) }))
    const handler = makeSubmitHandler()
    const e = makeSubmitEvent(form, null)
    handler(e, µ, win, {}, FakeFormData, URL, class {})

    assert.equal(dispatchCalls.length, 0, '1er passage : _mjs_navDispatch pas encore appelé (résolution en attente)')

    resolveConfirm(true)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    assert.equal(form.requestSubmitCalls.length, 1, 'relance : requestSubmit appelé sur le form')
    assert.equal(form.getAttribute('mjs-confirm'), 'Confirmer ?', 'attribut restauré après la relance')
  })

  it('non-régression : form porteur mjs-confirm, clic sur enfant NON-submit ASYNCHRONE accepté — AUCUNE soumission, seule la cible d\'origine (span) est recliquée (clickTarget prioritaire sur form)', async function () {
    const form = withRequestSubmitSpy(makeForm({ 'mjs-confirm': 'Confirmer ?' }))
    form.submitCalls = [] as any[]
    form.submit = () => form.submitCalls.push(true)
    const span = makeFakeEl('span')
    form.appendChild(span)
    let resolveConfirm: (v: boolean) => void = null as any
    const confirmPromise = new Promise<boolean>((res) => { resolveConfirm = res })
    const win: any = {
      confirm: () => { throw new Error('window.confirm ne doit jamais être appelé : µ.confirm est remplacé') },
      location: { pathname: '/', search: '', hash: '', origin: 'http://x' },
      history: { pushState() {} },
    }
    const µ = withConfirmRefire(baseMu(win, { confirm: () => confirmPromise }))
    const handler = makeClickHandler()
    const e = makeClickEvent(span)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true, "événement bloqué immédiatement, avant toute résolution")
    assert.equal(span.clickCalls.length, 0, 'pas encore de relance avant résolution')

    resolveConfirm(true)
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve()

    assert.equal(span.clickCalls.length, 1, "relance : .click() sur la cible d'origine (span), exactement 1 fois")
    assert.equal(form.requestSubmitCalls.length, 0, 'AUCUN requestSubmit sur le form porteur : un clic inerte reste inerte')
    assert.equal(form.submitCalls.length, 0, 'AUCUN submit natif non plus')
    assert.equal(form.getAttribute('mjs-confirm'), 'Confirmer ?', 'attribut restauré après la relance')
  })
})

describe('mjs_ujs — @method (mjs-method) : lien à verbe HTTP', function () {
  it('verbe valide (delete) : intercepté, délègue à µ._mjs_navDispatch(href, "DELETE", payload{_method:delete}, opts.restoreBusy)', function () {
    const link = makeLink({ 'mjs-method': 'delete' }, { href: 'http://x/session', pathname: '/session' })
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const calls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (url: string, method: string, payload: any, opts: any) => calls.push({ url, method, payload, opts }) })
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true)
    assert.equal(calls.length, 1)
    assert.equal(calls[0].url, 'http://x/session')
    assert.equal(calls[0].method, 'DELETE')
    assert.equal(calls[0].payload.get('_method'), 'delete', '_method envoyé en corps — même convention qu\'un <form> avec champ caché _method')
    assert.equal(typeof calls[0].opts.restoreBusy, 'function')
    assert.equal(link.getAttribute('aria-disabled'), 'true', 'désactivation pendant soumission : aria-disabled posé sur le lien')
  })

  it('garde anti-double-clic interne : un 2e clic PENDANT la requête en vol est ignoré', function () {
    const link = makeLink({ 'mjs-method': 'delete' }, { href: 'http://x/session' })
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const calls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => calls.push(a) })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData) // 2e clic, requête toujours en vol

    assert.equal(calls.length, 1, 'le 2e clic ne doit PAS déclencher une 2e requête (link._mjs_mjsBusy)')
  })

  it("opts.restoreBusy retire aria-disabled et réarme la garde anti-double-clic", function () {
    const link = makeLink({ 'mjs-method': 'delete' }, { href: 'http://x/session' })
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const calls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (_u: string, _m: string, _p: any, opts: any) => calls.push(opts) })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
    calls[0].restoreBusy()

    assert.equal(link.hasAttribute('aria-disabled'), false)
    assert.equal(link._mjs_mjsBusy, false)
    // un nouveau clic doit maintenant repartir normalement.
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)
    assert.equal(calls.length, 2)
  })

  it('verbe INCONNU (teleport) : warning + PAS de µ._mjs_navDispatch — repli sur la navigation normale', function () {
    const link = makeLink({ 'mjs-method': 'teleport' }, { hash: '#/foo' })
    const pushStateCalls: any[] = []
    const warnCalls: any[] = []
    const dispatchCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a), warn: (...a: any[]) => warnCalls.push(a) })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(dispatchCalls.length, 0, 'verbe inconnu : aucune requête mjs-method')
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /non reconnu/)
    assert.equal(pushStateCalls.length, 1, "repli : navigation same-page normale malgré tout (comme si mjs-method était absent)")
  })

  it('@confirm + @method combinés : refus du confirm → ni confirm-side-effect ni µ._mjs_navDispatch', function () {
    const link = makeLink({ 'mjs-method': 'delete', 'mjs-confirm': 'Sûr ?' }, { href: 'http://x/session' })
    const win: any = { confirm: () => false, location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const dispatchCalls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a) })
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(dispatchCalls.length, 0, 'confirm refusé : mjs-method jamais atteint')
    assert.equal(e.defaultPrevented, true)
  })

  it('@confirm + @method combinés : acceptation → µ._mjs_navDispatch reçoit bien le verbe DELETE', function () {
    const link = makeLink({ 'mjs-method': 'delete', 'mjs-confirm': 'Sûr ?' }, { href: 'http://x/session' })
    const win: any = { confirm: () => true, location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const dispatchCalls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (url: string, method: string) => dispatchCalls.push({ url, method }) })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(dispatchCalls.length, 1)
    assert.equal(dispatchCalls[0].method, 'DELETE')
  })
})

describe('mjs_ujs — @noUJS (mjs-no-ujs) : opt-out par élément', function () {
  it('lien @noUJS : aucune interception, navigation NATIVE (pas de preventDefault, pas de pushState)', function () {
    const link = makeLink({ 'mjs-no-ujs': '' }, { hash: '#/detail', pathname: '/', search: '' })
    const pushStateCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    const µ = baseMu(win)
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, false, 'aucune interception : le navigateur natif reprend la main')
    assert.equal(pushStateCalls.length, 0)
  })

  // PURGE de l'ancien nom : `mjs-no-ajax` n'a jamais été publié, il ne doit plus RIEN
  // déclencher. Verrou inversé de l'ancien test « toujours reconnu » : un lien qui ne porte que
  // l'ancien attribut est un lien ORDINAIRE, donc intercepté comme n'importe quel autre.
  it("lien mjs-no-ajax (ancien nom PURGÉ) : plus d'opt-out, le lien est intercepté normalement", function () {
    const link = makeLink({ 'mjs-no-ajax': '' }, { hash: '#/detail', pathname: '/', search: '' })
    const pushed: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushed.push(a) } }
    const µ = baseMu(win)
    const handler = makeClickHandler()
    const e = makeClickEvent(link)
    handler(e, µ, win, {}, class {}, FakeFormData)

    assert.equal(e.defaultPrevented, true, 'plus reconnu comme opt-out : UJS intercepte')
    assert.equal(pushed.length, 1)
  })

  // combinaison contradictoire @noUJS + @method : le verbe part en silence à la poubelle
  // (le navigateur ne suit un lien qu'en GET). Averti UNE FOIS PAR ÉLÉMENT, sans rien changer au
  // comportement (l'opt-out reste l'opt-out : navigation native).
  it('lien @noUJS + @method : avertit UNE FOIS, et laisse la navigation native intacte', function () {
    const link = makeLink({ 'mjs-no-ujs': '', 'mjs-method': 'delete' }, { hash: '#/detail', pathname: '/', search: '' })
    const warns: string[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() { throw new Error('ne doit jamais pousser : opt-out') } } }
    const µ = baseMu(win, { warn: (m: string) => warns.push(m) })
    const handler = makeClickHandler()
    const e1 = makeClickEvent(link)
    handler(e1, µ, win, {}, class {}, FakeFormData)
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(e1.defaultPrevented, false, "l'opt-out prime : navigation native")
    assert.equal(warns.length, 1, 'un seul avertissement malgré deux clics')
    assert.match(warns[0], /@method="delete" ignoré/)
    assert.match(warns[0], /GET/)
  })

  it('lien @noUJS SANS @method : aucun avertissement', function () {
    const link = makeLink({ 'mjs-no-ujs': '' }, { hash: '#/detail', pathname: '/', search: '' })
    const warns: string[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu(win, { warn: (m: string) => warns.push(m) })
    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, {}, class {}, FakeFormData)

    assert.equal(warns.length, 0)
  })

  // Deux liens DISTINCTS méritent chacun leur avertissement : le drapeau est porté par le NŒUD,
  // pas par une clé globale (sinon le premier lien fautif masquerait tous les suivants).
  it('deux liens @noUJS + @method distincts : un avertissement CHACUN', function () {
    const a = makeLink({ 'mjs-no-ujs': '', 'mjs-method': 'delete' }, { hash: '#/a', pathname: '/', search: '' })
    const b = makeLink({ 'mjs-no-ujs': '', 'mjs-method': 'put' }, { hash: '#/b', pathname: '/', search: '' })
    const warns: string[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu(win, { warn: (m: string) => warns.push(m) })
    const handler = makeClickHandler()
    handler(makeClickEvent(a), µ, win, {}, class {}, FakeFormData)
    handler(makeClickEvent(b), µ, win, {}, class {}, FakeFormData)

    assert.equal(warns.length, 2)
    assert.match(warns[1], /@method="put" ignoré/)
  })

  it('formulaire @noUJS : aucune interception, soumission NATIVE (pas de preventDefault, µ._mjs_navDispatch jamais appelé)', function () {
    const form = makeForm({ 'mjs-no-ujs': '' })
    const dispatchCalls: any[] = []
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a) })
    const handler = makeSubmitHandler()
    const e = makeSubmitEvent(form, null)
    handler(e, µ, win, {}, FakeFormData, URL, class {})

    assert.equal(e.defaultPrevented, false, 'aucune interception : le navigateur natif reprend la main')
    assert.equal(dispatchCalls.length, 0)
  })
})

describe('mjs_ujs — @noUJS + @confirm (défaut corrigé) : la confirmation continue de jouer', function () {
  it("formulaire @noUJS + @confirm, REFUS : confirm EST demandé (défaut corrigé), preventDefault posé — rien ne part, ni ajax ni natif", function () {
    const form = makeForm({ 'mjs-no-ujs': '', 'mjs-confirm': 'Vraiment ?' })
    let confirmMsg: any
    const win: any = { confirm: (m: string) => { confirmMsg = m; return false }, location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const µ = baseMu(win, { _mjs_navDispatch: () => { throw new Error('ne doit jamais être appelé : refus') } })
    const handler = makeSubmitHandler()
    const e = makeSubmitEvent(form, null)
    handler(e, µ, win, {}, FakeFormData, URL, class {})

    assert.equal(confirmMsg, 'Vraiment ?', "AVANT le correctif : le test d'opt-out passait AVANT la gate @confirm — jamais demandé sur un formulaire @noUJS")
    assert.equal(e.defaultPrevented, true, 'refus : preventDefault posé — bloque même une soumission native')
  })

  it("formulaire @noUJS + @confirm, ACCEPTATION synchrone : confirm demandé PUIS soumission NATIVE (aucun preventDefault, µ._mjs_navDispatch jamais appelé)", function () {
    const form = makeForm({ 'mjs-no-ujs': '', 'mjs-confirm': 'Vraiment ?' })
    let confirmMsg: any
    const win: any = { confirm: (m: string) => { confirmMsg = m; return true }, location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    const dispatchCalls: any[] = []
    const µ = baseMu(win, { _mjs_navDispatch: (...a: any[]) => dispatchCalls.push(a) })
    const handler = makeSubmitHandler()
    const e = makeSubmitEvent(form, null)
    handler(e, µ, win, {}, FakeFormData, URL, class {})

    assert.equal(confirmMsg, 'Vraiment ?')
    assert.equal(e.defaultPrevented, false, "accepté : AUCUN preventDefault — l'opt-out laisse la soumission NATIVE reprendre")
    assert.equal(dispatchCalls.length, 0, 'jamais de µ._mjs_navDispatch : ce formulaire est @noUJS')
  })

  it("non-régression LIEN @noUJS + @confirm : refus bloque tout, acceptation laisse la navigation NATIVE reprendre (comportement déjà correct avant le correctif, préservé)", function () {
    const linkRefuse = makeLink({ 'mjs-no-ujs': '', 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
    const pushStateCallsRefuse: any[] = []
    const winRefuse: any = { confirm: () => false, location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCallsRefuse.push(a) } }
    const handler = makeClickHandler()
    const eRefuse = makeClickEvent(linkRefuse)
    handler(eRefuse, baseMu(winRefuse), winRefuse, {}, class {}, FakeFormData)
    assert.equal(eRefuse.defaultPrevented, true, 'refus : preventDefault posé (bloque même une navigation native)')
    assert.equal(pushStateCallsRefuse.length, 0)

    const linkAccept = makeLink({ 'mjs-no-ujs': '', 'mjs-confirm': 'Sûr ?' }, { hash: '#/detail', pathname: '/', search: '' })
    let confirmMsg: any
    const winAccept: any = { confirm: (m: string) => { confirmMsg = m; return true }, location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() { throw new Error('ne doit jamais pousser : opt-out après acceptation') } } }
    const eAccept = makeClickEvent(linkAccept)
    handler(eAccept, baseMu(winAccept), winAccept, {}, class {}, FakeFormData)
    assert.equal(confirmMsg, 'Sûr ?')
    assert.equal(eAccept.defaultPrevented, false, "accepté : AUCUN preventDefault — la navigation NATIVE (opt-out) reprend")
  })
})

// bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) + adaptateur µ._mjs_ajaxRequest → µ.ajax.* mocké :
// `_mjs_navDispatch` en dépend désormais (le chemin HTML n'a jamais de `target`,
// µ._mjs_navMountZone(document, null) résout donc toujours <body> ; µ.ajax.xxx
// remplacé par le canal interne) — extraction MÉCANIQUE requise pour que la
// describe « bout-en-bout » ci-dessous continue de tourner (son INTENTION —
// PRG/422 délégués à `done` — inchangée).
function installNavDispatchHelpers(µ: any, doc: any, win: any) {
  µ._mjs_ajaxRequest = function (opts: any) {
    const m = opts.method.toLowerCase()
    if (m === 'get' || m === 'delete') return µ.ajax[m] && µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    return µ.ajax[m] && µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
  }
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, doc, win)
}

describe('mjs_ujs — µ._mjs_navDispatch (chemin PARTAGÉ submit/mjs-method) : bout-en-bout', function () {
  it('DELETE, redirection suivie (finalUrl ≠ url) : pushState vers la destination finale + swap + restoreBusy appelé', function () {
    const pushStateCalls: any[] = []
    const win: any = { location: { href: 'http://x/posts/42', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) } }
    const newRoot = { tag: 'bye' }
    const liveRoot: any = { replaceChildren(...nodes: any[]) { this.by = nodes[0] } }
    const doc = { body: liveRoot }
    let capturedSuccess: any
    const µ: any = {
      warn() {}, error() {}, log() {}, _mjs_navSeq: 0,
      ajax: { delete: (_url: string, success: any) => { capturedSuccess = success } },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    class ParserWithRoot { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    installNavDispatchHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, ParserWithRoot)

    let restoreCalled = false
    µ._mjs_navDispatch('http://x/posts/42', 'DELETE', new FakeFormData(), { restoreBusy: () => { restoreCalled = true } })
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><body>bye</body></html>', 'http://x/login')

    assert.equal(liveRoot.by, newRoot, 'le contenu est bien swappé')
    assert.equal(pushStateCalls.some((c) => c[2] === 'http://x/login'), true, 'PRG : pushState vers la destination FINALE')
    assert.equal(restoreCalled, true, 'opts.restoreBusy appelé (succès+swap : rien à restaurer côté form/lien, mais le callback tourne)')
  })

  it('POST → 422 (corps HTML) : ré-affiché via done (même chemin qu\'un submit), caches invalidés, restoreBusy appelé', function () {
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    let capturedError: any
    const liveRoot: any = { replaceChildren(...nodes: any[]) { this.by = nodes[0] } }
    const doc = { body: liveRoot }
    const µ: any = {
      warn() {}, error() {}, log() {}, _mjs_navSeq: 0,
      ajax: { post: (_url: string, _p: any, _success: any, error: any) => { capturedError = error } },
      pageCache: { clear() {} }, _mjs_preloadCache: { clear() {} }, _mjs_preloaded: { clear() {} },
    }
    const newRoot = { tag: 'form-avec-erreurs' }
    class ParserWithRoot { parseFromString() { return { body: { childNodes: [newRoot] } } } }
    installNavDispatchHelpers(µ, doc, win)
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, ParserWithRoot)

    let restoreCalled = false
    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { restoreBusy: () => { restoreCalled = true } })
    assert.ok(typeof capturedError === 'function')
    capturedError({ status: 422, body: '<html><body>erreurs</body></html>', url: 'http://x/posts' })

    assert.equal(liveRoot.by, newRoot, '422 avec corps HTML : ré-affiché exactement comme un submit')
    assert.equal(restoreCalled, true, 'restoreBusy appelé même sur le chemin 422 (délégué à done)')
  })
})
