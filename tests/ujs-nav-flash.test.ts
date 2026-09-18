// Veilleur central flash/error (µ._mjs_navFlash/µ._mjs_navFlashPolicy/µ._mjs_navFlashShow,
// mjs_ujs.ts). Consommation de props.flash/props.error AUX 4 points où un sac de props serveur
// entre au magasin (nominal/none/422/1er chargement) + politique d'affichage (mjs-flash par
// élément > µ.config.flash global, défaut 'popup') + repli modal absent + échec transport.
//
// Même motif d'isolation que tests/ujs-nav-json.test.ts (extraction du bloc helpers,
// µ._mjs_navMountZone → µ._mjs_navRequest, contigus dans le fichier — µ._mjs_navFlash* et µ._mjs_navRunCallback*
// y vivent aussi, juste avant µ._mjs_navApplyJson) : `new Function`, jamais d'exécution
// réelle du module (mjs_ujs.ts attache des listeners PERMANENTS à document/window dès l'import).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const GLOBALS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')

// Bloc des helpers — µ._mjs_navMountZone, µ._mjs_navFlash*, µ._mjs_navRunCallback*,
// µ._mjs_navApplyJson, µ._mjs_navRequest : contigus dans le fichier, extraits EN UNE FOIS jusqu'au
// bandeau TRANSITIONS DE PAGE qui les suit immédiatement (même bornes que ujs-nav-json.test.ts).
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}

// bloc try/catch boot (mjs_store_globals.ts) — pas une affectation de fonction, bloc marqué
// tel quel (cf. tests/helpers/extract-marked.ts).
function extractBootResBlock(src: string): string {
  return extractMarked(src, 'boot-res')
}

class FakeFormData {
  private map = new Map<string, any>()
  constructor(_form?: any) {}
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
}

function makeEl(tag: string, attrs: Record<string, string> = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  return {
    tagName: tag.toUpperCase(),
    isConnected: true,
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
  }
}

function baseDocWin() {
  const bodyZone: any = { filled: null as any, replaceChildren(...nodes: any[]) { this.filled = nodes } }
  const doc: any = { body: bodyZone, createElement: (tag: string) => ({ tag }) }
  const win: any = { history: { pushState() {} }, location: { assign() { throw new Error('ne doit pas recharger') } } }
  return { doc, win, bodyZone }
}

// monkey-patch temporaire de console.info/console.error (globals réels, pas passés au harnais) —
// restauré en fin de test, jamais laissé fuiter vers le test suivant.
function spyConsole() {
  const info: any[] = [], error: any[] = []
  const origInfo = console.info, origError = console.error
  console.info = (...a: any[]) => { info.push(a) }
  console.error = (...a: any[]) => { error.push(a) }
  return { info, error, restore() { console.info = origInfo; console.error = origError } }
}

describe('mjs_ujs — veilleur flash/error', function () {

  describe('consommation (props.flash/props.error retirés AVANT le magasin, props.errors intact)', function () {
    it('(1) nominal (µ._mjs_resSet) : flash retiré du sac, affiché en popup (µ.modal.notify)', function () {
      const resSetCalls: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { produit: 'xxx.js' }, version: 'v1',
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify: (msg: string, o: any) => notifyCalls.push([msg, o]), error() {}, fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-produit', props: { id: '42', flash: 'Créé !' }, url: '/p/42', title: null, version: 'v1' }, '/p/42', { push: true })

      assert.deepEqual(resSetCalls, [{ id: '42' }], 'flash retiré du sac AVANT µ._mjs_resSet')
      assert.deepEqual(notifyCalls, [['Créé !', { type: 'success' }]])
    })

    it('(2) none (µ._mjs_resMerge) : error retiré du sac, affiché via µ.modal.error', function () {
      const mergeCalls: any[] = []
      const errorCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        _mjs_resMerge: (p: any) => mergeCalls.push(p),
        modal: { notify() {}, error: (msg: string) => errorCalls.push(msg), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      // method:'none' court-circuite AVANT la résolution de json.module (cf. bandeau µ._mjs_navApplyJson) :
      // `module` peut valoir n'importe quoi, y compris null, sans tomber dans la branche 404.
      µ._mjs_navApplyJson({ module: null, method: 'none', props: { count: 3, error: 'Quota dépassé' }, url: '/p/42' }, '/p/42', { push: false })

      assert.deepEqual(mergeCalls, [{ count: 3 }], 'error retiré du sac AVANT µ._mjs_resMerge')
      assert.deepEqual(errorCalls, ['Quota dépassé'])
    })

    it('(3) 422 (µ._mjs_resMerge via fail) : flash retiré du sac avant fusion', function () {
      const mergeCalls: any[] = []
      let capturedError: any
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
        _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        _mjs_resMerge: (p: any) => mergeCalls.push(p),
        modal: { notify() {}, error() {}, fire() {} },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
      capturedError({ status: 422, body: { module: 'mjs-new-post', props: { errors: { title: 'requis' }, flash: 'Presque !' }, url: 'http://x/posts', title: null, version: 'v1' }, url: 'http://x/posts' })

      assert.deepEqual(mergeCalls, [{ errors: { title: 'requis' } }], 'flash retiré, errors (pluriel) intact')
    })

    it('(4) props.errors (pluriel, PAR CHAMP) ne doit JAMAIS être touché par le veilleur', function () {
      const resSetCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { produit: 'xxx.js' }, version: 'v1',
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify() {}, error() {}, fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-produit', props: { errors: { name: 'requis' }, flash: 'ok' }, url: '/p/42', title: null, version: 'v1' }, '/p/42', { push: true })

      assert.deepEqual(resSetCalls, [{ errors: { name: 'requis' } }], 'errors survit, flash seul est parti')
    })

    it('(5) sans flash NI error : inerte — µ._mjs_resSet reçoit le sac intact, aucun affichage', function () {
      const resSetCalls: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { produit: 'xxx.js' }, version: 'v1',
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error-call']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-produit', props: { id: '1', name: 'x' }, url: '/p/1', title: null, version: 'v1' }, '/p/1', { push: true })

      assert.deepEqual(resSetCalls, [{ id: '1', name: 'x' }])
      assert.equal(notifyCalls.length, 0, 'aucun appel modal sans flash/error')
    })
  })

  describe('politique — défaut popup, config console/fonction/false, priorité élément > global', function () {
    it('(6) défaut (aucune config, aucun attribut) : flash → notify, error → modal.error', function () {
      const notifyCalls: any[] = []
      const errorCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: (m: string) => errorCalls.push(m), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok', error: 'oups' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })

      assert.deepEqual(notifyCalls, [['ok', { type: 'success' }]])
      assert.deepEqual(errorCalls, ['oups'])
    })

    it("(7) µ.config.flash = 'console' : console.info/console.error, modal jamais consulté", function () {
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1', config: { flash: 'console' },
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const spy = spyConsole()
      try {
        µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok', error: 'oups' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })
        assert.deepEqual(spy.info, [['ok']])
        assert.deepEqual(spy.error, [['oups']])
        assert.equal(notifyCalls.length, 0, 'µ.modal jamais consulté en politique console')
      } finally { spy.restore() }
    })

    it('(8) µ.config.flash = fonction custom : reçoit (type, message), aucun modal/console', function () {
      const custom: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        config: { flash: (type: string, message: string) => custom.push([type, message]) },
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })

      assert.deepEqual(custom, [['flash', 'ok']])
      assert.equal(notifyCalls.length, 0)
    })

    it('(9) µ.config.flash = false : veilleur COUPÉ — clés NON consommées, µres intact, aucun affichage', function () {
      const resSetCalls: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1', config: { flash: false },
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { id: 1, flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })

      assert.deepEqual(resSetCalls, [{ id: 1, flash: 'ok' }], 'flash NON retiré : µ._mjs_resSet reçoit le sac COMPLET')
      assert.equal(notifyCalls.length, 0)
    })

    it("(10) attribut mjs-flash='silent' PAR ÉLÉMENT : consommé, rien d'affiché — même avec config popup (défaut)", function () {
      const resSetCalls: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const link = makeEl('a', { 'mjs-flash': 'silent' })

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true, el: link })

      assert.deepEqual(resSetCalls, [{}], 'flash quand même retiré (silent = affiché nulle part, pas "non consommé")')
      assert.equal(notifyCalls.length, 0)
    })

    it("(11) attribut mjs-flash='console' PAR ÉLÉMENT gagne sur µ.config.flash='popup' (priorité élément > global)", function () {
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1', config: { flash: 'popup' },
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const spy = spyConsole()
      try {
        const link = makeEl('a', { 'mjs-flash': 'console' })
        µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true, el: link })
        assert.deepEqual(spy.info, [['ok']])
        assert.equal(notifyCalls.length, 0, 'modal jamais consulté : attribut élément gagne')
      } finally { spy.restore() }
    })

    it("(12) attribut mjs-flash='popup' PAR ÉLÉMENT gagne sur µ.config.flash='console' (priorité élément > global)", function () {
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1', config: { flash: 'console' },
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const spy = spyConsole()
      try {
        const link = makeEl('a', { 'mjs-flash': 'popup' })
        µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true, el: link })
        assert.deepEqual(notifyCalls, [['ok', { type: 'success' }]])
        assert.equal(spy.info.length, 0, 'console jamais consulté : attribut élément gagne')
      } finally { spy.restore() }
    })

    it('(13) valeur mjs-flash inconnue : µ.warn UNE fois + repli politique globale', function () {
      const notifyCalls: any[] = []
      const warnCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        _mjs_resSet() {},
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const link = makeEl('a', { 'mjs-flash': 'nimportequoi' })

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'un' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true, el: link })
      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'deux' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true, el: link })

      assert.equal(warnCalls.length, 1, 'un seul avertissement malgré 2 navigations avec la même valeur invalide')
      assert.deepEqual(notifyCalls, [['un', { type: 'success' }], ['deux', { type: 'success' }]], 'repli politique globale (popup, défaut) appliqué les 2 fois')
    })
  })

  describe('module modal absent — repli alert/console + un seul avertissement par session', function () {
    it('(14) popup + modal absent : error → window.alert, flash → console.info, 1 SEUL µ.warn pour les 2', function () {
      const alertCalls: any[] = []
      const warnCalls: any[] = []
      const { doc, win } = baseDocWin()
      ;(win as any).alert = (m: string) => alertCalls.push(m)
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        _mjs_resSet() {},
        Router: { navigate() {} },
        // PAS de µ.modal sur ce µ
        warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const spy = spyConsole()
      try {
        µ._mjs_navApplyJson({ module: 'mjs-p', props: { error: 'panne' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })
        µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: true })

        assert.deepEqual(alertCalls, ['panne'])
        assert.deepEqual(spy.info, [['ok']])
        assert.equal(warnCalls.length, 1, 'un seul avertissement « module modal absent » pour toute la session')
        assert.match(warnCalls[0][0], /modal/)
      } finally { spy.restore() }
    })
  })

  describe('échec transport (fail générique de µ._mjs_navDispatch)', function () {
    it('(15) affiche EN PLUS du warn console existant, statut entre parenthèses quand disponible', function () {
      const warnCalls: any[] = []
      const errorCalls: any[] = []
      let capturedError: any
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const µ: any = {
        log() {}, error() {}, realTarget: (e: any) => e.target,
        warn: (...a: any[]) => warnCalls.push(a),
        _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        _mjs_resMerge() {},
        modal: { notify() {}, error: (m: string) => errorCalls.push(m), fire() {} },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
      capturedError({ status: 500, body: 'Internal Server Error', url: 'http://x/posts' })

      assert.equal(warnCalls.length, 1, 'le warn console existant reste posé')
      assert.equal(errorCalls.length, 1)
      assert.match(errorCalls[0], /Échec de l'envoi/)
      assert.match(errorCalls[0], /\(500\)/, 'statut entre parenthèses quand disponible')
    })

    it('(16) échec SANS statut (réseau pur) : pas de parenthèses', function () {
      const errorCalls: any[] = []
      let capturedError: any
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
        _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        _mjs_resMerge() {},
        modal: { notify() {}, error: (m: string) => errorCalls.push(m), fire() {} },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
      capturedError({})

      assert.equal(errorCalls.length, 1)
      assert.match(errorCalls[0], /Échec de l'envoi/)
      assert.doesNotMatch(errorCalls[0], /\(/, "aucune parenthèse quand le statut n'est pas disponible")
    })

    it("(17) échec transport respecte @flash='silent' PAR ÉLÉMENT : rien affiché", function () {
      const errorCalls: any[] = []
      let capturedError: any
      const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
      const doc: any = { getElementById: () => ({ replaceWith() {} }), createElement: () => ({}) }
      const µ: any = {
        log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target,
        _mjs_navSeq: 0,
        _mjs_ajaxRequest: (opts: any) => { capturedError = opts.error; return Promise.resolve() },
        _mjs_resMerge() {},
        modal: { notify() {}, error: (m: string) => errorCalls.push(m), fire() {} },
        pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      }
      installHelpers(µ, doc, win)
      new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, URL, class {})
      const form = makeEl('form', { 'mjs-flash': 'silent' })

      µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), { el: form })
      capturedError({ status: 500, body: 'boom', url: 'http://x/posts' })

      assert.equal(errorCalls.length, 0, "aucun affichage : politique 'silent' de l'élément d'origine respectée")
    })
  })

  describe('1er chargement (boot mjs_store_globals.ts) — garde d\'existence', function () {
    it('(18) µ._mjs_navFlash présent : consomme flash AVANT µ._mjs_resSet, affiche selon la politique', function () {
      const resSetCalls: any[] = []
      const { doc: helperDoc, win } = baseDocWin()
      const µ: any = {
        paths: {}, version: 'v1', config: { flash: 'console' },
        Router: { navigate() {} },
        modal: { notify() {}, error() {}, fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, helperDoc, win) // pose la VRAIE µ._mjs_navFlash (+ dépendances)
      µ._mjs_resSet = (p: any) => resSetCalls.push(p)

      const scriptEl = { textContent: JSON.stringify({ panier: 3, flash: 'Bienvenue !' }) }
      const bootDoc: any = { getElementById: (id: string) => (id === '__mjs_res' ? scriptEl : null) }
      const spy = spyConsole()
      try {
        new Function('document', 'µ', extractBootResBlock(GLOBALS_SRC))(bootDoc, µ)
        assert.deepEqual(resSetCalls, [{ panier: 3 }], 'flash retiré AVANT µ._mjs_resSet, même au tout premier chargement')
        assert.deepEqual(spy.info, [['Bienvenue !']])
      } finally { spy.restore() }
    })

    it("(19) µ._mjs_navFlash ABSENT (module 'ujs' tree-shaké) : boot ne crashe pas, µ._mjs_resSet reçoit le sac tel quel", function () {
      const resSetCalls: any[] = []
      const µ: any = { warn() {}, _mjs_resSet: (p: any) => resSetCalls.push(p) } // PAS de µ._mjs_navFlash

      const scriptEl = { textContent: JSON.stringify({ panier: 3, flash: 'Bienvenue !' }) }
      const bootDoc: any = { getElementById: (id: string) => (id === '__mjs_res' ? scriptEl : null) }

      assert.doesNotThrow(() => {
        new Function('document', 'µ', extractBootResBlock(GLOBALS_SRC))(bootDoc, µ)
      })
      assert.deepEqual(resSetCalls, [{ panier: 3, flash: 'Bienvenue !' }], 'sans µ._mjs_navFlash, la clé flash atterrit telle quelle dans µ.res')
    })
  })

  // µ._mjs_ujsOnClick (handler de clic réel, mjs_ujs.ts:1754) hors du bloc extrait par
  // extractHelpersBlock (bandeau TRANSITIONS DE PAGE l'exclut) et dépend de µ._mjs_ajaxGet + de la
  // résolution DOM complète du lien (closest/modificateurs/mjs-method/cache…) — hors de portée de
  // ce harnais (cf. bandeau du fichier, ligne 9). Repli : opts RECONSTITUÉS à l'identique de la
  // forme réelle du call-site :2053 (push/vtLink/via/el), qui oubliait `el` avant ce correctif.
  describe('call-site :2053 (clic sur lien ORDINAIRE recevant du JSON) — opts.el désormais transmis', function () {
    it("(20) mjs-flash='silent' sur le lien cliqué respecté (opts reconstitués push/vtLink/via/el)", function () {
      const resSetCalls: any[] = []
      const notifyCalls: any[] = []
      const { doc, win } = baseDocWin()
      const µ: any = {
        paths: { p: 'x.js' }, version: 'v1',
        _mjs_resSet: (p: any) => resSetCalls.push(p),
        Router: { navigate() {} },
        modal: { notify: (...a: any[]) => notifyCalls.push(a), error: () => notifyCalls.push(['error']), fire() {} },
        warn() {}, error() {}, log() {},
      }
      installHelpers(µ, doc, win)
      const link = makeEl('a', { 'mjs-flash': 'silent' })

      µ._mjs_navApplyJson({ module: 'mjs-p', props: { flash: 'ok' }, url: '/p', title: null, version: 'v1' }, '/p', { push: false, vtLink: link, via: 'link', el: link })

      assert.deepEqual(resSetCalls, [{}], 'flash quand même retiré du sac')
      assert.equal(notifyCalls.length, 0, "aucun affichage : mjs-flash='silent' du lien cliqué respecté")
    })
  })
})
