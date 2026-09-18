// `target`/`method` voyagent désormais aussi sur le chemin HTML (le
// serveur les pose en en-têtes `X-MJS-Target`/`X-MJS-Method`, lus par mjs_ajax.ts et exposés en 4e
// argument des callbacks success/error sous forme d'objet `{version, target, method}` — contrat
// isolé, cf. tests/ujs-submit-prg-redirect.test.ts). Ce fichier couvre, sur les 3 sites de swap HTML
// (clic cross-page, popstate, submit) :
//   5. en-têtes présents et RÉSOLUS (des deux côtés, page ET réponse) : contenu remplacé DANS la
//      cible, l'habillage autour (jamais dans la cible) reste INTACT — même élément, jamais recréé.
//   6. `X-MJS-Target` pointant un sélecteur INTROUVABLE dans la page COURANTE : repli sur <body> +
//      avertissement (µ._mjs_navMountZone lui-même est déjà couvert isolément par
//      tests/ujs-mount-cascade.test.ts — ce test-ci prouve juste que le chemin HTML l'atteint bien,
//      avec un `target` réel au lieu du `null` d'avant ce correctif).
//
// Méthode : mêmes techniques d'extraction que les fichiers voisins (bloc helpers +
// corps de handler par regex/comptage d'accolades, exécutés via `new Function`). Le 4e argument des
// callbacks simule directement l'objet `nav` déjà décodé par mjs_ajax.ts (son décodage lui-même est
// hors périmètre ici).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractClickBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnClick')
}
function extractSubmitBody(src: string): string {
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}

// Nœud FAKE réaliste, cf. tests/ujs-nav-method-append.test.ts (même forme, `nodeType: 1` requis).
function makeNode(tag: string, id = ''): any {
  const node: any = {
    tag, id, nodeType: 1, isConnected: true, children: [] as any[], parentNode: null as any,
    get firstChild() { return node.children.length ? node.children[0] : null },
    get childNodes() { return node.children.slice() },
    removeChild(n: any) { node.children = node.children.filter((c: any) => c !== n); n.parentNode = null; return n },
    appendChild(n: any) { node.children.push(n); n.parentNode = node; return n },
    replaceChildren(...nodes: any[]) {
      node.children.forEach((c: any) => { c.parentNode = null })
      node.children = nodes.slice()
      node.children.forEach((c: any) => { c.parentNode = node })
    },
    replaceWith(...nodes: any[]) { node.replacedBy = nodes },
    querySelector(sel: string): any {
      const wantId = sel.replace(/^#/, '')
      const walk = (n: any): any => {
        if (n.id === wantId) { return n }
        for (const c of n.children) { const found = walk(c); if (found) { return found } }
        return null
      }
      return walk(node)
    },
  }
  return node
}
function makeDoc(body: any) {
  return { body, querySelector: (sel: string) => body.querySelector(sel), createElement: (tag: string) => makeNode(tag) }
}
// Gabarit body → <header> (HABILLAGE, jamais dans la cible) + <main id="content"> (la CIBLE) — un
// jeu par « côté » (page live / réponse parsée) pour obtenir des instances DISTINCTES, comme un vrai
// aller-retour réseau. `innerTag` : contenu initial de #content pour ce côté.
function makeSkinnedDoc(innerTag: string) {
  const body = makeNode('body')
  const header = makeNode('header')
  const main = makeNode('main', 'content')
  main.appendChild(makeNode(innerTag))
  body.appendChild(header)
  body.appendChild(main)
  return { doc: makeDoc(body), body, header, main }
}
function makeCrossLink(pathname: string, href: string) {
  return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname, search: '', hash: '', href, closest: function (this: any) { return this } }
}
function makeClickEvent(link: any) {
  return { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false, composedPath: () => [link], target: link }
}

describe('mjs_ujs — X-MJS-Target/X-MJS-Method en mode HTML : contenu remplacé DANS la cible, habillage intact', function () {
  it('clic cross-page : target résolu des deux côtés — seul #content change, <header> ne bouge pas', function () {
    const live = makeSkinnedDoc('page-a')
    const resp = makeSkinnedDoc('ignoré') // côté RÉPONSE : gabarit jumeau, DOMParser le renverra tel quel
    const newInner = makeNode('page-b')
    resp.main.replaceChildren(newInner) // simule le contenu RÉEL renvoyé par le serveur dans sa cible

    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' }, history: { pushState() {} }, scrollTo() {} }
    let capturedCb: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      Router: { navigate() {} },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, live.doc, win)
    class DP { parseFromString() { return resp.doc } }
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, live.doc, DP)

    assert.ok(typeof capturedCb === 'function', '_mjs_ajaxGet doit avoir été appelé (fetch cross-page)')
    capturedCb('<html>ignoré : DP renvoie directement resp.doc</html>', 'http://x/b', undefined, { version: null, target: '#content', method: 'update' })

    assert.deepEqual(live.main.children, [newInner], 'le CONTENU de #content a bien été remplacé (method update)')
    assert.equal(live.body.children[0], live.header, "l'habillage (<header>) n'a pas bougé : toujours le même objet, en tête")
    assert.equal(live.body.children[1], live.main, '#content lui-même survit (jamais remplacé, seul son contenu change)')
  })

  it("popstate (cache miss réseau) : target résolu — seul #content change, <header> ne bouge pas", function () {
    const live = makeSkinnedDoc('page-b')
    const resp = makeSkinnedDoc('ignoré')
    const newInner = makeNode('page-a-restored')
    resp.main.replaceChildren(newInner)

    const win: any = { location: { pathname: '/a', search: '', hash: '' } }
    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/b', _mjs_navSeq: 0,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {}, warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      Router: { navigate() {} },
    }
    installHelpers(µ, live.doc, win)
    class DP { parseFromString() { return resp.doc } }
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractPopstateBody(UJS_SRC))
    handler({}, µ, win, live.doc, DP)

    assert.ok(typeof capturedSuccess === 'function', 'cache miss ⇒ fetch réseau attendu')
    capturedSuccess('<html>ignoré</html>', 'http://x/a', undefined, { version: null, target: '#content', method: 'update' })

    assert.deepEqual(live.main.children, [newInner], 'le CONTENU de #content a bien été remplacé')
    assert.equal(live.body.children[0], live.header, "l'habillage (<header>) survit au popstate")
  })

  it("submit (formulaire GET) : target résolu — seul #content change, <header> ne bouge pas", function () {
    const live = makeSkinnedDoc('resultats-anciens')
    const resp = makeSkinnedDoc('ignoré')
    const newInner = makeNode('resultats-neufs')
    resp.main.replaceChildren(newInner)

    const win: any = { location: { href: 'http://x/search', origin: 'http://x' }, history: { pushState() {} } }
    let capturedSuccess: any
    const µ: any = {
      log() {}, warn() {}, error() {}, realTarget: (e: any) => e.target, _mjs_navSeq: 0,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
      _mjs_lastUjsPath: '/search', pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
    }
    installHelpers(µ, live.doc, win)
    // FakeFormData : le vrai constructeur Node (undici) exige un <form> RÉEL (introspecte .elements) —
    // même motif que tests/ujs-submit-prg-redirect.test.ts/ujs-submit-urlencoded.test.ts.
    class FakeFormData {
      private map = new Map<string, any>()
      append(k: string, v: any) { this.map.set(k, v) }
      get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
      *[Symbol.iterator]() { yield* this.map }
    }
    class DP { parseFromString() { return resp.doc } }
    // `_mjs_navDispatch` crée son propre `new DOMParser()` DANS `done` (fermeture liée à SON installation,
    // pas à celle du handler submit) : DP doit être fourni ICI aussi, pas seulement au submitHandler.
    new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, live.doc, FakeFormData, URL, DP)
    const submitHandler = new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractSubmitBody(UJS_SRC))
    const form: any = { hasAttribute: () => false, getAttribute: (k: string) => (k === 'action' ? '/search' : k === 'method' ? 'GET' : null), target: '', action: 'http://x/search', closest: function (this: any) { return this } }
    const e = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, submitter: null, composedPath: () => [form], target: form }
    submitHandler(e, µ, win, live.doc, FakeFormData, URL, DP)

    assert.ok(typeof capturedSuccess === 'function', 'µ._mjs_ajaxRequest doit avoir été appelé avec un callback success')
    capturedSuccess('<html>ignoré</html>', 'http://x/search', undefined, { version: null, target: '#content', method: 'update' })

    assert.deepEqual(live.main.children, [newInner], 'le CONTENU de #content a bien été remplacé')
    assert.equal(live.body.children[0], live.header, "l'habillage (<header>) survit à la soumission")
  })
})

describe('mjs_ujs — X-MJS-Target introuvable dans la page COURANTE : repli <body> + avertissement', function () {
  it('clic cross-page : #content absent de la page live → contenu remplacé dans <body> entier, avertissement une fois', function () {
    const liveBody = makeNode('body')
    liveBody.appendChild(makeNode('ancien-contenu'))
    const liveDoc = makeDoc(liveBody)
    // côté réponse : même absence de #content (repli <body> aussi, cohérent — le point testé ici est
    // l'avertissement côté page COURANTE, pas la résolution côté réponse).
    const respBody = makeNode('body')
    const newInner = makeNode('nouveau-contenu')
    respBody.appendChild(newInner)

    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' }, history: { pushState() {} }, scrollTo() {} }
    const warnCalls: any[] = []
    let capturedCb: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      Router: { navigate() {} },
      warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
    }
    installHelpers(µ, liveDoc, win)
    class DP { parseFromString() { return makeDoc(respBody) } }
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, liveDoc, DP)

    assert.ok(typeof capturedCb === 'function')
    capturedCb('<html>ignoré</html>', 'http://x/b', undefined, { version: null, target: '#content', method: 'update' })

    assert.deepEqual(liveBody.children, [newInner], "repli <body> : contenu remplacé dans <body> entier (cible introuvable)")
    assert.equal(warnCalls.length, 1, "avertissement 'cible introuvable' émis une fois")
    assert.match(warnCalls[0][0], /#content/)
    assert.match(warnCalls[0][0], /introuvable/)

    // 2e navigation, MÊME sélecteur introuvable : pas de 2e avertissement (une fois par sélecteur distinct).
    let capturedCb2: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb2 = cb }
    handler(makeClickEvent(makeCrossLink('/c', 'http://x/c')), µ, win, liveDoc, DP)
    capturedCb2('<html>ignoré</html>', 'http://x/c', undefined, { version: null, target: '#content', method: 'update' })
    assert.equal(warnCalls.length, 1, "2e navigation, MÊME sélecteur '#content' introuvable : PAS un 2e avertissement")
  })
})

// Cible présente dans la PAGE mais ABSENTE de la RÉPONSE (gabarit différent : page de
// connexion, page legacy…). Sans résolution croisée, le <body> ENTIER de la réponse (son propre
// habillage compris) atterrissait DANS la cible : chrome imbriqué, page cassée, et en SILENCE
// (µ._mjs_navMountZone n'avertit jamais pour un document parsé hors-document). µ._mjs_navResolveZones
// dégrade les DEUX côtés sur <body> et avertit une fois par sélecteur.
describe('mjs_ujs — X-MJS-Target absent de la RÉPONSE : repli <body> des deux côtés + avertissement', function () {
  it('clic cross-page : le <body> de la réponse ne se retrouve JAMAIS imbriqué dans la cible', function () {
    const live = makeSkinnedDoc('page-a') // page live : <header> + <main id="content">
    const respBody = makeNode('body')     // réponse : AUCUN #content, un gabarit à elle
    const respHeader = makeNode('autre-header')
    const respMain = makeNode('autre-contenu')
    respBody.appendChild(respHeader)
    respBody.appendChild(respMain)

    const win: any = { location: { pathname: '/a', search: '', origin: 'http://x', href: 'http://x/a', hash: '' }, history: { pushState() {} }, scrollTo() {} }
    const warnCalls: any[] = []
    let capturedCb: any
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/a',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, cb: any) => { capturedCb = cb },
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      Router: { navigate() {} },
      warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
    }
    installHelpers(µ, live.doc, win)
    class DP { parseFromString() { return makeDoc(respBody) } }
    const handler = new Function('e', 'µ', 'window', 'document', 'DOMParser', extractClickBody(UJS_SRC))
    handler(makeClickEvent(makeCrossLink('/b', 'http://x/b')), µ, win, live.doc, DP)

    assert.ok(typeof capturedCb === 'function')
    capturedCb('<html>ignoré</html>', 'http://x/b', undefined, { version: null, target: '#content', method: 'update' })

    assert.deepEqual(live.body.children, [respHeader, respMain], 'repli <body> des DEUX côtés : le corps reçu remplace le corps courant, à plat')
    assert.equal(live.main.children.indexOf(respHeader), -1, "la cible n'a PAS reçu l'habillage de la réponse (jamais gavée du corps entier)")
    assert.equal(live.main.children.indexOf(respMain), -1, "la cible n'a PAS reçu le contenu de la réponse (le corps entier a remplacé le corps entier)")
    assert.equal(warnCalls.length, 1, 'un seul avertissement (le côté réponse), pas deux')
    assert.match(warnCalls[0][0], /#content/)
    assert.match(warnCalls[0][0], /reçue/)

    // 2e navigation, MÊME sélecteur absent de la réponse : pas de 2e avertissement.
    let capturedCb2: any
    µ._mjs_ajaxGet = (_u: string, cb: any) => { capturedCb2 = cb }
    handler(makeClickEvent(makeCrossLink('/c', 'http://x/c')), µ, win, live.doc, DP)
    capturedCb2('<html>ignoré</html>', 'http://x/c', undefined, { version: null, target: '#content', method: 'update' })
    assert.equal(warnCalls.length, 1, "2e navigation, MÊME sélecteur absent de la réponse : PAS un 2e avertissement")
  })
})
