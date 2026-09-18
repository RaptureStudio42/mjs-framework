// Test de régression :
// contrairement au handler de clic sur lien (qui capture `seq = ++µ._mjs_navSeq`
// au clic et jette tout callback périmé — `if (seq !== µ._mjs_navSeq) return`),
// le handler de SUBMIT ne participait PAS au même jeton de séquence
// anti-course. Un submit lancé PUIS une navigation PLUS RÉCENTE (un 2e submit,
// ou un clic sur un lien) pendant que le 1er fetch est encore en vol : le 1er
// submit, à sa résolution (réseau plus lent, arrivée en désordre), écrasait
// quand même le DOM affiché (et l'URL, via PRG) avec son contenu PÉRIMÉ — la
// DERNIÈRE action de l'utilisateur perdait la course au lieu de la gagner.
//
// Fix : le handler submit capture désormais `seq = ++µ._mjs_navSeq` (même jeton
// PARTAGÉ que le clic) et jette le swap DOM + le PRG (pushState) si périmé.
// L'invalidation de cache reste, elle, INCONDITIONNELLE (la mutation serveur
// a bien eu lieu, qu'on affiche ou non son résultat ici).
//
// Méthode : même technique que ujs-submit-prg-redirect.test.ts — extraction
// du corps SOURCE du handler `submit` par regex, exécuté via `new Function`
// avec des fakes injectés (pas de compilation, pas de happy-dom nécessaire
// pour tester CE comportement précis).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractSubmitBody(src: string): string {
  // µ._mjs_ujsOnSubmit (nommé, ex-handler anonyme document.addEventListener('submit', …)
  // — renommé, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(src, '_mjs_ujsOnSubmit')
}

class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.get(k) }
}

// µ._mjs_navDispatch (capacités @method/désactivation/µnav/abort/focus) :
// le handler submit délègue désormais sa fin (dispatch ajax, PRG, swap — tout
// ce que CE fichier vérifie, y compris le garde-fou _mjs_navSeq/stale) à cette
// fonction PARTAGÉE avec le lien mjs-method. Extraite + installée sur le
// MÊME µ, avec les MÊMES window/document/FormData/URL/DOMParser que le
// handler lui-même.
function extractNavDispatchStatement(src: string): string {
  return extractMarked(src, '_mjs_navDispatch')
}

// Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus dans le fichier, cf. leur bandeau commun) : `_mjs_navDispatch` en dépend
// désormais (le chemin HTML n'a jamais de `target`, µ._mjs_navMountZone(document, null)
// résout donc toujours <body> ; µ.ajax.xxx remplacé par le canal interne
// µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction MÉCANIQUE requise pour que ce fichier
// continue de tourner (son INTENTION — le jeton anti-course _mjs_navSeq — est
// inchangée, cf. tête de fichier).
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function makeSubmitHandler(µ: any, win: any, doc: any, FormDataCtor: any, URLCtor: any, DOMParserCtor: any): (e: any, µ: any, win: any, doc: any) => void {
  // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ;
  // ce fichier vérifie le dispatch µ.ajax.post EXISTANT, jamais l'en-tête
  // X-MJS-Nav lui-même (hors périmètre ici) : on redirige donc simplement vers
  // le µ.ajax mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
  µ._mjs_ajaxRequest = function (opts: any) {
    const m = opts.method.toLowerCase()
    if (m === 'get' || m === 'delete') return µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    return µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
  }
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement(UJS_SRC))(µ, win, doc, FormDataCtor, URLCtor, DOMParserCtor)
  const body = extractSubmitBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', body) as any
}

function makeEvent(form: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    submitter: null,
    target: form,
  }
}

function makeForm(action: string, method: string) {
  return {
    hasAttribute: () => false,
    getAttribute: (k: string) => (k === 'action' ? action : k === 'method' ? method : null),
    target: '',
    action: `http://x${action}`,
    closest: () => makeForm(action, method),
  }
}

describe('mjs_ujs — submit ajax : jeton _mjs_navSeq anti-course', function () {
  it("un submit LENT (résout APRÈS un 2e submit plus rapide) ne doit PAS écraser le DOM/l'URL du plus récent", function () {
    const domRoots: string[] = []   // trace des remplissages (replaceChildren) successifs, dans l'ordre RÉEL
    const pushStateCalls: string[] = []
    const capturedSuccess: any[] = []

    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState: (_s: any, _t: any, url: string) => pushStateCalls.push(url) },
    }
    const µ: any = {
      log() {}, warn() {}, error() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      _mjs_lastUjsPath: '/posts',
      ajax: {
        post: (_url: string, _payload: any, success: any) => { capturedSuccess.push(success) },
      },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    // <body> "vivant" : replaceChildren trace juste QUEL contenu a été posé,
    // sans vraie arborescence DOM (pas nécessaire pour ce comportement précis).
    const liveRoot: any = { childNodes: [] as any[], replaceChildren: (...nodes: any[]) => domRoots.push(nodes[0].__label) }
    const fakeDoc: any = { body: liveRoot }
    class FakeDOMParserLabeled {
      constructor(private html: string) {}
      parseFromString(html: string) {
        return { body: { childNodes: [{ __label: html.includes('LENT') ? 'LENT' : 'RAPIDE' }] } }
      }
    }

    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParserLabeled)

    // Submit #1 ("lent") — lancé en premier, capture success #1.
    handler(makeEvent(makeForm('/posts', 'POST')), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParserLabeled)
    // Submit #2 ("rapide") — lancé APRÈS le premier (l'utilisateur re-soumet,
    // ou navigue autrement) : bump SON PROPRE seq, plus récent.
    handler(makeEvent(makeForm('/posts', 'POST')), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParserLabeled)

    assert.equal(capturedSuccess.length, 2, 'les 2 submits doivent avoir appelé µ.ajax.post')

    // Le RÉSEAU répond dans le DÉSORDRE : le 2e (rapide) arrive D'ABORD, PUIS le 1er (lent).
    capturedSuccess[1]('<html><body id="app-root">RAPIDE</body></html>', 'http://x/posts/rapide')
    capturedSuccess[0]('<html><body id="app-root">LENT</body></html>', 'http://x/posts/lent')

    assert.deepEqual(domRoots, ['RAPIDE'],
      "AVANT le fix : le submit LENT (périmé) écrasait quand même le DOM avec son contenu obsolète après le RAPIDE — domRoots aurait été ['RAPIDE', 'LENT']")
    assert.deepEqual(pushStateCalls, ['http://x/posts/rapide'],
      "AVANT le fix : le PRG du submit périmé repoussait aussi l'URL en arrière vers sa PROPRE destination (obsolète)")
    assert.equal(µ._mjs_lastUjsPath, '/posts/rapide')
  })

  it('cas nominal (un seul submit, pas de course) : swap + PRG fonctionnent normalement (pas de régression)', function () {
    const domRoots: string[] = []
    const pushStateCalls: string[] = []
    let capturedSuccess: any

    const win: any = {
      location: { href: 'http://x/posts', origin: 'http://x' },
      history: { pushState: (_s: any, _t: any, url: string) => pushStateCalls.push(url) },
    }
    const µ: any = {
      log() {}, warn() {}, error() {},
      realTarget: (e: any) => e.target,
      _mjs_navSeq: 0,
      ajax: { post: (_url: string, _payload: any, success: any) => { capturedSuccess = success } },
      pageCache: new Map(), _mjs_preloadCache: new Map(), _mjs_preloaded: new Set(),
    }
    const liveRoot: any = { childNodes: [] as any[], replaceChildren: (...nodes: any[]) => domRoots.push(nodes[0].__label) }
    const fakeDoc: any = { body: liveRoot }
    class FakeDOMParserSeul {
      parseFromString() { return { body: { childNodes: [{ __label: 'OK' }] } } }
    }

    const handler = makeSubmitHandler(µ, win, fakeDoc, FakeFormData, URL, FakeDOMParserSeul)
    handler(makeEvent(makeForm('/posts', 'POST')), µ, win, fakeDoc, FakeFormData, URL, FakeDOMParserSeul)
    capturedSuccess('<html><body id="app-root">OK</body></html>', 'http://x/posts/42')

    assert.deepEqual(domRoots, ['OK'], 'un submit seul, sans course, doit toujours swapper normalement')
    assert.deepEqual(pushStateCalls, ['http://x/posts/42'])
  })
})
