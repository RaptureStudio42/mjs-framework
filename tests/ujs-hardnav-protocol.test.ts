// (a) µ._mjs_navApplyJson calculait
// `destOrigin` contre `window.location.href`, JAMAIS `document.baseURI` — `history.pushState` natif
// résout pourtant contre baseURI (comme fetch/µ.ajax, cf. µ._mjajaxMemeOrigine, mjs_ajax.ts) :
// un `<base href>` tiers faisait juger "même origine" une URL relative qui partait RÉELLEMENT
// ailleurs (confirmé sur Chromium réel : pushState réel lève
// SecurityError malgré le garde-fou). (b) le repli `µ._mjs_hardNav(dest)` (destination hors origine) ne
// filtrait AUCUN protocole : une destination `javascript:`/`data:`/`blob:`… y EXÉCUTAIT le script au
// lieu de naviguer — avant ce correctif, pushState levait et BLOQUAIT ; après, _mjs_hardNav EXÉCUTAIT
// (confirmé sur Chromium réel : window.__pwned posé,
// '[JS-URI-EXECUTED]' journalisé). Garde de protocole posée aux DEUX niveaux : µ._mjs_navApplyJson
// (avant tout appel à _mjs_hardNav) ET µ._mjs_hardNav lui-même (défense en profondeur — ses autres appelants,
// cf. le repli cross-page décrit juste au-dessus de _mjs_hardNav dans mjs_ujs.ts).
//
// `µ._mjs_hardNav` est ICI le VRAI (extrait, jamais stubbé) — contrairement à
// tests/ujs-crossorigin-pushstate.test.ts qui stub _mjs_hardNav et ne prouve donc que l'APPEL,
// jamais l'EFFET (angle mort des tests existants).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// µ._mjs_navApplyJson vit dans 'helpers-navigation' ; µ._mjs_finalPathFor et µ._mjs_hardNav sont 2 blocs séparés
// juste au-dessus — _mjs_hardNav RÉEL, jamais stubbé ici.
function installNav(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, '_mjs_hardNav'))(µ, document, window)
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, '_mjs_finalPathFor'))(µ, document, window)
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, document, window)
}

function makeMu(warnCalls: string[]) {
  return {
    paths: { produit: 'xxx-hash.js' },
    version: 'v1',
    _mjs_resSet: (_p: any) => {},
    Router: { navigate: () => {}, _mjs_updateUrlStore: () => {} },
    warn: (...a: any[]) => warnCalls.push(a.join(' ')),
    error: () => {},
    log: () => {},
  }
}

function spyPushState(window: any) {
  const calls: any[] = []
  const orig = window.history.pushState.bind(window.history)
  window.history.pushState = (...a: any[]) => { calls.push(a); return orig(...a) }
  return calls
}

describe('mjs_ujs — µ._mjs_navApplyJson : destOrigin contre document.baseURI + protocole non http(s) jamais vers µ._mjs_hardNav', function () {
  it('(a) url javascript: (404) : script JAMAIS exécuté, µ.warn explicite, aucun pushState, aucune navigation dure', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval('window.__pwned = 0')
    const warnCalls: string[] = []
    const µ: any = makeMu(warnCalls)
    installNav(µ, document, window)
    const pushStateCalls = spyPushState(window)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: null, props: {}, url: 'javascript:window.__pwned=1', title: null, version: 'v1' }, null, { push: true })
    })

    assert.equal(window.eval('window.__pwned'), 0, 'le script ne doit JAMAIS être exécuté')
    assert.equal(pushStateCalls.length, 0, 'jamais de pushState pour une destination hors origine')
    assert.equal(window.location.href, 'http://localhost/', "l'URL affichée ne doit pas bouger")
    assert.equal(warnCalls.length, 1, 'un seul warn attendu (repli ni pushState ni hardNav)')
  })

  it('(b) <base href> vers un tiers + url relative same-path : destOrigin suit baseURI -> repli µ._mjs_hardNav (navigation dure), jamais pushState (SecurityError natif évité)', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const base = document.createElement('base')
    base.setAttribute('href', 'https://tiers.invalid/')
    document.head.appendChild(base)
    const warnCalls: string[] = []
    const µ: any = makeMu(warnCalls)
    installNav(µ, document, window)
    const pushStateCalls = spyPushState(window)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: null, props: {}, url: '/produits/42', title: null, version: 'v1' }, null, { push: true })
    })

    assert.equal(pushStateCalls.length, 0, 'AVANT le fix : destOrigin calculé contre location.href jugeait "même origine" -> pushState tenté (SecurityError réel en vrai navigateur)')
    assert.equal(warnCalls.length, 0, 'protocole https: valide : aucun refus, juste un repli navigation dure')
    assert.notEqual(window.location.href, 'http://localhost/', 'µ._mjs_hardNav (le VRAI) a bien déplacé la localisation affichée')
  })

  it('(c) contre-épreuve : url relative SANS <base> tiers -> pushState réel a bien lieu, jamais de repli hardNav', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const warnCalls: string[] = []
    const µ: any = makeMu(warnCalls)
    installNav(µ, document, window)
    const pushStateCalls = spyPushState(window)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, null, { push: true })
    })

    assert.equal(pushStateCalls.length, 1, 'même origine : pushState réel appelé')
    assert.equal(window.location.pathname, '/produits/42', 'pushState réel a bien déplacé la localisation affichée')
    assert.equal(warnCalls.length, 0)
  })

  // `destUrl.origin` d'un `blob:` VAUT
  // l'origine qui l'a créé (spec WHATWG) -> un blob: de MÊME origine passait la branche "même
  // origine" tout droit vers `window.history.pushState`, SANS que le contrôle de protocole (posé
  // uniquement dans la branche "origine différente") ne soit jamais atteint. `pushState` natif
  // REJETTE pourtant un blob: (même "même origine") avec SecurityError non catché (confirmé sur
  // Chromium réel) — happy-dom n'implémente pas cette garde native, d'où
  // les compteurs ci-dessous (pushState/warn) plutôt qu'une exception attrapée.
  it('(d) url blob: MÊME origine (404) : protocole testé AVANT l\'origine -> jamais pushState, 1 warn', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const warnCalls: string[] = []
    const µ: any = makeMu(warnCalls)
    installNav(µ, document, window)
    const pushStateCalls = spyPushState(window)
    const blobDest = 'blob:http://localhost/11111111-2222-3333-4444-555555555555'

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: null, props: {}, url: blobDest, title: null, version: 'v1' }, null, { push: true })
    })

    assert.equal(pushStateCalls.length, 0, 'un blob: MÊME origine doit être écarté par le protocole avant même le test d\'origine')
    assert.equal(window.location.href, 'http://localhost/', "l'URL affichée ne doit pas bouger")
    assert.equal(warnCalls.length, 1, 'un seul warn attendu')
  })

  it('(e) url blob: MÊME origine, module CONNU (finalUrl non nul) : même garde sur la 2e branche (code dupliqué)', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const warnCalls: string[] = []
    const µ: any = makeMu(warnCalls)
    installNav(µ, document, window)
    const pushStateCalls = spyPushState(window)
    const blobDest = 'blob:http://localhost/22222222-3333-4444-5555-666666666666'

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: blobDest, title: null, version: 'v1' }, blobDest, { push: true })
    })

    assert.equal(pushStateCalls.length, 0, 'même garde sur la branche module connu, dest résolu via finalUrl')
    assert.equal(window.location.href, 'http://localhost/', "l'URL affichée ne doit pas bouger")
    assert.equal(warnCalls.length, 1)
  })
})

describe('mjs_ujs — µ._mjs_hardNav : garde de protocole en défense en profondeur (autres appelants de _mjs_hardNav)', function () {
  function installHardNav(µ: any, window: any) {
    new Function('µ', 'window', extractMarked(UJS_SRC, '_mjs_hardNav'))(µ, window)
  }

  it('destination javascript: -> refusée, µ.warn, location.href inchangée', function () {
    const window: any = new Window({ url: 'http://localhost/produits' })
    window.eval('window.__pwned = 0')
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')) }
    installHardNav(µ, window)

    µ._mjs_hardNav('javascript:window.__pwned=1')

    assert.equal(window.eval('window.__pwned'), 0)
    assert.equal(window.location.href, 'http://localhost/produits')
    assert.equal(warnCalls.length, 1)
  })

  it('destination data: -> refusée aussi', function () {
    const window: any = new Window({ url: 'http://localhost/produits' })
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')) }
    installHardNav(µ, window)

    µ._mjs_hardNav('data:text/html,<script>window.__pwned=1</script>')

    assert.equal(window.location.href, 'http://localhost/produits')
    assert.equal(warnCalls.length, 1)
  })

  it('contre-épreuve : destination http(s) absolue -> navigation dure classique, aucun warn', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')) }
    installHardNav(µ, window)

    µ._mjs_hardNav('http://localhost/autre')

    assert.equal(window.location.href, 'http://localhost/autre')
    assert.equal(warnCalls.length, 0)
  })

  it('contre-épreuve : URL relative résolue en http(s) -> passe, aucun warn', function () {
    const window: any = new Window({ url: 'http://localhost/dossier/' })
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')) }
    installHardNav(µ, window)

    µ._mjs_hardNav('/autre')

    assert.equal(window.location.pathname, '/autre')
    assert.equal(warnCalls.length, 0)
  })
})
