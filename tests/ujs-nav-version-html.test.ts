// Garde de VERSION DE BUILD sur les réponses
// HTML. Le chemin JSON compare `json.version` à `µ.version` ; le chemin HTML
// (serveur qui ne parle pas le protocole) compare l'en-tête de réponse
// `X-MJS-Version`, exposé par `_request` (mjs_ajax.ts) en 4ᵉ argument de
// `success`. Trois sites portent cette garde : le refetch du popstate, le clic,
// et la soumission (`_mjs_navDispatch.done`). Le troisième était le seul couvert par
// un test (ujs-submit-prg-redirect) : neutraliser les deux autres ne faisait
// rougir AUCUN test — un trou de couverture.
// Ce fichier couvre les deux sites restants.
//
// Règle testée : version différente ⇒ `window.location.assign(destination
// finale)` et RIEN d'autre — aucun swap de DOM, la réponse n'est même pas
// parsée (monter du neuf avec l'ancien JS est un terrain miné : formes de
// compilation potentiellement incompatibles).
//
// Méthode : extraction du corps SOURCE des handlers + du bloc helpers de zone
// via `new Function` (même technique que ujs-popstate-fetch-stale-zone et
// ujs-click-crosspage-no-approot), mocks contrôlés.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractBody(src: string, name: string): string {
  return extractMarkedBody(src, name)
}

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

// DOMParser qui JETTE : preuve qu'on est sorti AVANT tout parsing de la réponse.
class DPInterdit {
  parseFromString(): any { throw new Error('ne doit jamais parser : version différente, sortie avant tout swap') }
}

function makeZone(children: any[] = []) {
  return {
    tag: 'body', nodeType: 1, isConnected: true, children,
    get childNodes() { return this.children },
    replaceChildren(...nodes: any[]) { this.children = nodes },
  }
}

describe('mjs_ujs — version de build lue sur les réponses HTML (popstate et clic)', function () {
  it('popstate, refetch réseau : en-tête de version DIFFÉRENT ⇒ rechargement complet, aucun swap', function () {
    const assignCalls: string[] = []
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const win: any = {
      location: { pathname: '/b', search: '', hash: '', assign: (u: string) => assignCalls.push(u) },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0, version: 'v2', _mjs_navContainer: null,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
    }
    new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser',
      extractBody(UJS_SRC, 'popstate-listener'))

    handler({}, µ, win, doc, DPInterdit)
    assert.ok(typeof capturedSuccess === 'function', 'cache miss ⇒ un fetch réseau doit partir')
    capturedSuccess('<html><body>page servie par un build plus récent</body></html>', 'http://x/b', undefined, { version: 'v1-different', target: null, method: null })

    assert.deepEqual(assignCalls, ['http://x/b'], 'version différente ⇒ location.assign vers la destination finale')
    assert.deepEqual(zone.children, [oldContent], 'AUCUN swap : le contenu affiché reste celui d\'avant')
  })

  it("popstate, refetch réseau : en-tête ABSENT (serveur tiers muet) ⇒ navigation normale", function () {
    const assignCalls: string[] = []
    const fetched: any = { tag: 'neuf', nodeType: 1 }
    const zone = makeZone([{ tag: 'ancien', nodeType: 1 }])
    const win: any = {
      location: { pathname: '/b', search: '', hash: '', assign: (u: string) => assignCalls.push(u) },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0, version: 'v2', _mjs_navContainer: null,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
    }
    new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser',
      extractBody(UJS_SRC, 'popstate-listener'))
    class DP { parseFromString() { return { body: { childNodes: [fetched] } } } }

    handler({}, µ, win, doc, DP)
    capturedSuccess('<html><body>neuf</body></html>', 'http://x/b') // 3 arguments : aucun en-tête de version

    assert.deepEqual(assignCalls, [], 'aucun rechargement : rien à comparer')
    assert.deepEqual(zone.children, [fetched], 'swap normal (aucune régression pour un serveur qui ignore l\'en-tête)')
  })

  it('clic, réponse réseau : en-tête de version DIFFÉRENT ⇒ rechargement complet, aucun swap', function () {
    const assignCalls: string[] = []
    const oldContent: any = { tag: 'ancien', nodeType: 1 }
    const zone = makeZone([oldContent])
    const win: any = {
      location: { pathname: '/a', search: '', hash: '', origin: 'http://x', href: 'http://x/a', assign: (u: string) => assignCalls.push(u) },
      history: { pushState() {} },
    }
    const doc: any = { body: zone }
    let capturedSuccess: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a', version: 'v2', _mjs_navContainer: null,
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxGet: (_url: string, success: any) => { capturedSuccess = success },
    }
    new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser',
      extractBody(UJS_SRC, '_mjs_ujsOnClick'))
    const link: any = {
      hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:',
      pathname: '/b', search: '', hash: '', href: 'http://x/b', closest: function (this: any) { return this },
    }
    const e: any = {
      defaultPrevented: false, preventDefault() { this.defaultPrevented = true },
      button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      composedPath: () => [link], target: link,
    }

    handler(e, µ, win, doc, DPInterdit)
    assert.ok(typeof capturedSuccess === 'function', 'le clic doit avoir lancé un fetch')
    capturedSuccess('<html><body>page servie par un build plus récent</body></html>', 'http://x/b', undefined, { version: 'v1-different', target: null, method: null })

    assert.deepEqual(assignCalls, ['http://x/b'], 'version différente ⇒ location.assign vers la destination finale')
    assert.deepEqual(zone.children, [oldContent], 'AUCUN swap : le contenu affiché reste celui d\'avant')
  })
})
