// directive @callback (µ._mjs_navCallbackClimb/µ._mjs_navRunCallback, mjs_ujs.ts). Sur SUCCÈS
// de navigation SEULEMENT (fiche nominale appliquée ET method:'none' — jamais 422, jamais échec
// transport, jamais popstate) : remonte de l'élément porteur de `mjs-callback` (lui-même ou son
// plus proche ancêtre via `closest`) vers le premier nœud (lui compris) qui définit une méthode de
// CE nom, et l'appelle avec `{path, url, status, via}`.
//
// Même motif d'isolation que tests/ujs-nav-flash.test.ts/ujs-nav-json.test.ts (extraction du bloc
// helpers (voir en-têtes des fichiers), `new Function`, jamais d'exécution réelle du module).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}

class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}

// élément minimal — seuls `parentNode`/`getRootNode().host` (climb) et `closest('[mjs-callback]')`
// (recherche du porteur) sont exercés par µ._mjs_navRunCallback/µ._mjs_navCallbackClimb.
function makeEl(tag: string, attrs: Record<string, string> = {}, extra: any = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  const el: any = Object.assign({
    tagName: tag.toUpperCase(),
    isConnected: true,
    parentNode: null,
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
    closest(sel: string) {
      const m = sel.match(/^\[([a-zA-Z-]+)\]$/)
      if (!m) { return null }
      let n: any = el
      while (n) {
        if (typeof n.hasAttribute === 'function' && n.hasAttribute(m[1])) { return n }
        n = n.parentNode || (n.getRootNode ? n.getRootNode().host : null)
      }
      return null
    },
  }, extra)
  return el
}

function baseDocWin() {
  const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
  const doc: any = { body: bodyZone, createElement: (tag: string) => ({ tag }) }
  const win: any = { history: { pushState() {} }, location: { assign() { throw new Error('ne doit pas recharger') } } }
  return { doc, win }
}
function baseMu(extra: any = {}) {
  return Object.assign({
    paths: { p: 'x.js' }, version: 'v1',
    _mjs_resSet() {}, _mjs_resMerge() {},
    Router: { navigate() {} },
    warn() {}, error() {}, log() {},
  }, extra)
}

describe('mjs_ujs — directive @callback', function () {

  describe('remontée unitaire — µ._mjs_navCallbackClimb', function () {
    it('(1) trouve la méthode sur le nœud de départ lui-même', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const calls: any[] = []
      const el = makeEl('button', {}, { onSaved: (d: any) => calls.push(d) })

      const target = µ._mjs_navCallbackClimb(el, 'onSaved')
      assert.equal(target, el)
    })

    it('(2) remonte via parentNode jusqu\'à un ancêtre porteur de la méthode', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const grandparent: any = { tagName: 'MJS-FORM', onSaved() {} }
      const parent: any = { tagName: 'DIV', parentNode: grandparent }
      const el = makeEl('button', {}, { parentNode: parent })

      const target = µ._mjs_navCallbackClimb(el, 'onSaved')
      assert.equal(target, grandparent)
    })

    it('(3) traverse un host shadow simulé (parentNode absent, getRootNode().host présent)', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const host: any = { tagName: 'MJS-HOST', onSaved() {} }
      const shadowRoot: any = { host }
      const el = makeEl('button', {}, { parentNode: null, getRootNode: () => shadowRoot })

      const target = µ._mjs_navCallbackClimb(el, 'onSaved')
      assert.equal(target, host)
    })

    it("(4) méthode introuvable ≤50 sauts : renvoie null (jamais d'exception)", function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const el = makeEl('button')

      assert.equal(µ._mjs_navCallbackClimb(el, 'inconnue'), null)
    })
  })

  describe('µ._mjs_navRunCallback — garde isConnected + porteur + avertissement', function () {
    it('(5) originEl absent (null) : no-op silencieux', function () {
      const { doc, win } = baseDocWin()
      const warnCalls: any[] = []
      const µ = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
      installHelpers(µ, doc, win)

      assert.doesNotThrow(() => µ._mjs_navRunCallback(null, { path: '/x', url: '/x', status: 200, via: 'link' }))
      assert.equal(warnCalls.length, 0)
    })

    it('(6) originEl.isConnected = false : rappel IGNORÉ, aucun appel', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const calls: any[] = []
      const el = makeEl('button', { 'mjs-callback': 'onSaved' }, { isConnected: false, onSaved: (d: any) => calls.push(d) })

      µ._mjs_navRunCallback(el, { path: '/x', url: '/x', status: 200, via: 'link' })
      assert.equal(calls.length, 0)
    })

    it("(7) aucun élément ne porte mjs-callback (ni soi ni ancêtre) : no-op, aucun warn", function () {
      const { doc, win } = baseDocWin()
      const warnCalls: any[] = []
      const µ = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
      installHelpers(µ, doc, win)
      const el = makeEl('a')

      µ._mjs_navRunCallback(el, { path: '/x', url: '/x', status: 200, via: 'link' })
      assert.equal(warnCalls.length, 0)
    })

    it('(8) attribut PORTÉ PAR UN ANCÊTRE (pas originEl lui-même) : closest le trouve, méthode appelée', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const calls: any[] = []
      const form: any = { tagName: 'FORM', isConnected: true, onSaved: (d: any) => calls.push(d),
        hasAttribute(n: string) { return n === 'mjs-callback' }, getAttribute(n: string) { return n === 'mjs-callback' ? 'onSaved' : null } }
      const btn = makeEl('button', {}, { parentNode: form })

      µ._mjs_navRunCallback(btn, { path: '/p', url: '/p', status: 200, via: 'form' })
      assert.equal(calls.length, 1)
    })

    it('(9) méthode introuvable : µ.warn explicite (nom de méthode + tag de l\'élément)', function () {
      const { doc, win } = baseDocWin()
      const warnCalls: any[] = []
      const µ = baseMu({ warn: (...a: any[]) => warnCalls.push(a) })
      installHelpers(µ, doc, win)
      const el = makeEl('button', { 'mjs-callback': 'inexistante' })

      µ._mjs_navRunCallback(el, { path: '/p', url: '/p', status: 200, via: 'link' })
      assert.equal(warnCalls.length, 1)
      assert.match(warnCalls[0][0], /inexistante/)
      assert.match(warnCalls[0][0], /button/)
    })

    it('(10) payload exact transmis : {path, url, status, via}', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const calls: any[] = []
      const el = makeEl('a', { 'mjs-callback': 'onDone' }, { onDone: (d: any) => calls.push(d) })

      µ._mjs_navRunCallback(el, { path: '/produits/42', url: '/produits/42', status: 200, via: 'method' })
      assert.deepEqual(calls, [{ path: '/produits/42', url: '/produits/42', status: 200, via: 'method' }])
    })
  })

  describe('intégration — succès SEULEMENT (nominal + none), jamais 422/transport/popstate', function () {
    it('(11) nominal (fiche appliquée) : appelé APRÈS installation, via=\'link\' propagé', function () {
      const { doc, win } = baseDocWin()
      const calls: any[] = []
      const link = makeEl('a', { 'mjs-callback': 'onSaved' }, { onSaved: (d: any) => calls.push(d) })
      const µ = baseMu()
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { id: 1 }, url: '/p/1', title: null, version: 'v1' }, '/p/1', { push: true, el: link, via: 'link' })

      assert.equal(calls.length, 1)
      assert.equal(calls[0].path, '/p/1')
      assert.equal(calls[0].status, 200)
      assert.equal(calls[0].via, 'link')
    })

    it("(12) method:'none' : appelé APRÈS µ._mjs_resMerge (état déjà à jour)", function () {
      const { doc, win } = baseDocWin()
      const order: string[] = []
      const link = makeEl('a', { 'mjs-callback': 'onSaved' }, { onSaved: () => order.push('callback') })
      const µ = baseMu({ _mjs_resMerge: () => order.push('resMerge') })
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: null, method: 'none', props: { count: 1 }, url: '/p' }, '/p', { push: false, el: link })

      assert.deepEqual(order, ['resMerge', 'callback'])
    })

    it('(13) JAMAIS sur un 422 (même avec attribut + méthode présents)', function () {
      const calls: any[] = []
      let capturedError: any
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const form = makeEl('form', { 'mjs-callback': 'onSaved' }, { onSaved: (d: any) => calls.push(d) })
      const µ = baseMu({
        realTarget: (e: any) => e.target, _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      })
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { el: form })
      capturedError({ status: 422, body: { module: 'mjs-new-post', props: { errors: { title: 'requis' } }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })

      assert.equal(calls.length, 0, 'un 422 est un REFUS, jamais un succès : aucun rappel')
    })

    it('(14) JAMAIS sur un échec transport (même avec attribut + méthode présents)', function () {
      const calls: any[] = []
      let capturedError: any
      // `alert` : le veilleur (µ._mjs_navFlashShow, hors périmètre de CE test) affiche quand
      // même un message d'échec transport en repli 'popup' sans µ.modal — non testé ici,
      // juste neutralisé pour ne pas planter sur un window.alert absent.
      const win: any = { alert() {}, location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const form = makeEl('form', { 'mjs-callback': 'onSaved' }, { onSaved: (d: any) => calls.push(d) })
      const µ = baseMu({
        realTarget: (e: any) => e.target, _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      })
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { el: form })
      capturedError({ status: 500, body: 'boom', url: 'http://x/posts' })

      assert.equal(calls.length, 0)
    })

    it('(15) JAMAIS au popstate (aucun élément d\'origine transmis, opts.el absent)', function () {
      const { doc, win } = baseDocWin()
      const calls: any[] = []
      // même méthode existerait sur µ lui-même : aucun élément d'origine → µ._mjs_navRunCallback
      // reçoit `null`, no-op structurel (cf. tests unitaires (5) plus haut).
      const µ = baseMu()
      installHelpers(µ, doc, win)
      const spyCalls: any[] = []
      µ._mjs_navRunCallback = (...a: any[]) => spyCalls.push(a)

      // popstate : mêmes opts que µ._ujsOnPopstate (via 'popstate'), sans `el`.
      µ._mjs_navApplyJson({ module: 'mjs-p', props: { id: 1 }, url: '/p/1', title: null, version: 'v1' }, '/p/1', { push: false, via: 'popstate' })

      assert.equal(spyCalls.length, 1, 'la fonction tourne quand même')
      assert.equal(spyCalls[0][0], null, 'mais originEl vaut null : rien à notifier en aval')
      assert.equal(calls.length, 0)
    })
  })

  // DÉFAUT — `target[nom](detail)` tournait SANS GARDE. Un @callback qui lève traversait
  // `_mjs_navApplyJson` : le swap DOM avait déjà eu lieu, mais `µ.Router.navigate()` et l'événement
  // `mjs:load` — le point d'accroche que la doc recommande pour l'analytique — ne partaient
  // JAMAIS. Le code voisin (`mjs_socket.ts::_dispatch`) protège déjà chaque handler un par un ;
  // ce code neuf ne suivait pas la convention.
  describe('un @callback qui LÈVE ne fait pas dérailler la navigation', function () {
    it("l'exception est journalisée, jamais propagée hors de µ._mjs_navRunCallback", function () {
      const { doc, win } = baseDocWin()
      const erreurs: any[] = []
      const µ = baseMu({ error: (...a: any[]) => erreurs.push(a) })
      installHelpers(µ, doc, win)
      const el = makeEl('button', { 'mjs-callback': 'onSaved' }, { onSaved() { throw new Error('boum') } })

      assert.doesNotThrow(() => µ._mjs_navRunCallback(el, { path: '/p', url: '/p', status: 200, via: 'click' }))
      assert.equal(erreurs.length, 1, "l'échec doit être DIT, jamais avalé en silence")
      assert.match(String(erreurs[0][0]), /callback/i)
    })

    it('method:none — le rappel qui lève ne bloque pas la suite de _mjs_navApplyJson', function () {
      const { doc, win } = baseDocWin()
      const µ = baseMu({ error() {} })
      installHelpers(µ, doc, win)
      const el = makeEl('button', { 'mjs-callback': 'onSaved' }, { onSaved() { throw new Error('boum') } })
      assert.doesNotThrow(() =>
        µ._mjs_navApplyJson({ method: 'none', props: { id: 1 }, url: '/p/1', version: 'v1' }, '/p/1', { push: false, via: 'click', el })
      )
    })

    it('page complète — Router.navigate() ET mjs:load partent quand même', function () {
      const { doc, win } = baseDocWin()
      const navs: any[] = []
      const emis: any[] = []
      const µ = baseMu({ error() {}, Router: { navigate: (d: any) => navs.push(d) } })
      installHelpers(µ, doc, win)
      // les espions se posent APRÈS l'installation : `installHelpers` réécrit ces clés
      µ._mjs_navMountZone = () => ({ zone: doc.body })
      µ._mjs_navInstallInZone = (zone: any) => zone
      µ._mjs_navEmit = (nom: string, detail: any) => emis.push([nom, detail])
      const el = makeEl('button', { 'mjs-callback': 'onSaved' }, { onSaved() { throw new Error('boum') } })

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { id: 1 }, url: '/p/1', title: null, version: 'v1' }, '/p/1', { push: false, via: 'click', el })

      assert.equal(navs.length, 1, 'AVANT : µ.Router.navigate() ne partait jamais')
      assert.ok(emis.some(e => e[0] === 'load'), "AVANT : l'événement mjs:load ne partait jamais")
    })
  })

})
