// Régression : clic cross-page depuis une page SANS #app-root
// (cas réel : accueils prérendus SSR — le layout ne pose aucun
// app-root) — le handler interceptait quand même : preventDefault + pushState
// + fetch, puis repli `window.location.href = destination`… no-op quand le
// lien porte un hash (`/tuto#/ton-premier-jeu-en-ligne`) : l'URL venait d'être
// poussée AU CLIC, la réassignation identique est traitée en navigation
// same-document → AUCUN rechargement, page inchangée en silence (F5 requis).
//
// Fix d'ORIGINE (mjs_ujs.ts) :
//   1. branche cross-page : pas d'#app-root dans la page courante → sortie
//      AVANT preventDefault (navigation native complète, défaut navigateur) ;
//   2. replis fetch (réponse sans #app-root / échec réseau) : `µ._mjs_hardNav`
//      force un `reload()` quand la destination EST déjà l'URL courante.
//
// SUPERSÉDÉ depuis : la branche « SWAP
// IMPOSSIBLE — pas d'#app-root → navigation native » DISPARAÎT (cascade
// #app-root → 1er enfant mjs-* → <body>, qui trouve TOUJOURS une zone). Un correctif ultérieur va
// plus loin : la cascade elle-même disparaît — le chemin HTML n'a par nature
// aucun `target` (pas de fiche), le contenant EST donc TOUJOURS <body>, sans
// recherche d'aucune sorte. Le concept même de « page SANS #app-root » n'a
// donc plus de prise : #app-root ou pas, mjs-child ou pas, le comportement est
// désormais rigoureusement IDENTIQUE (toujours <body>). Le 1er test ci-dessous
// (qui figeait la dégradation de cascade sur un mock pathologique) est réécrit
// pour figer cette réalité plus simple (cf. tests/ujs-mount-cascade.test.ts pour
// µ._mjs_navMountZone elle-même, et tests/ujs-nav-json.test.ts pour le chemin
// JSON/target-method). Le 2e test (jadis « #app-root présent ») devient une
// simple confirmation que le contenu PRÉEXISTANT de <body> ne change rien à
// l'interception (son intention d'origine — distinguer app-root présent/absent
// — n'a plus d'objet, signalé explicitement plutôt que supprimé en silence).
// Les 2 derniers tests (replis `µ._mjs_hardNav`) restent, eux, INCHANGÉS dans leur
// intention — seule leur extraction est adaptée (µ._mjs_navMountZone est désormais
// appelé par le handler, il doit exister sur le `µ` mocké).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus dans le fichier, cf. leur bandeau commun) : le handler click en
// dépend désormais (le chemin HTML n'a jamais de `target`, µ._mjs_navMountZone
// (document, null) résout donc toujours <body>) — extraction MÉCANIQUE requise
// pour que ce fichier continue de tourner. `_mjs_ajaxGet` reste MOCKÉ tel quel dans
// ce fichier (ce qu'il vérifie : preventDefault/pushState/appel-ou-non du fetch
// — jamais son contenu interne) : µ._mjs_navRequest/µ._mjs_ajaxRequest ne sont donc
// jamais exercés ici.
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function installHelpers(µ: any, doc: any, win: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
}

function makeClickHandler() {
  const body = extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick')
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', body)
}

function makeHardNav() {
  const body = extractMarkedBody(UJS_SRC, '_mjs_hardNav')
  return new Function('destination', 'window', body)
}

function makeCrossLink(pathname: string, href: string, hash = '') {
  return { hasAttribute: () => false, origin: 'http://x', target: '', protocol: 'http:', pathname, search: '', hash, href, closest: function (this: any) { return this } }
}

function makeEvent(link: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [link],
    target: link,
  }
}

describe("mjs_ujs — clic cross-page : le contenant est TOUJOURS <body> côté HTML, plus aucune cascade", function () {
  it("<body> ABSENT du mock (cas extrême, pathologique) : le clic est intercepté quand même — preventDefault + pushState + fetch", function () {
    const pushStateCalls: any[] = []
    let ajaxCalled = false
    const warnCalls: any[] = []
    const win: any = {
      location: { pathname: '/', search: '', origin: 'http://x', href: 'http://x/', hash: '' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const doc: any = {}
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: () => { ajaxCalled = true },
      Router: { navigate() {} },
      warn: (...a: any[]) => warnCalls.push(a), error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    const e = makeEvent(makeCrossLink('/tuto', 'http://x/tuto#/lecon', '#/lecon'))
    makeClickHandler()(e, µ, win, doc, class {})

    // plus de cascade à dégrader : µ._mjs_navMountZone(document, null) résout directement
    // `document.body`, qui vaut ici `undefined` (mock sans `.body`) — la navigation ne meurt
    // pas pour autant : preventDefault/pushState/fetch ne dépendent d'AUCUNE zone résolue.
    assert.equal(e.defaultPrevented, true, 'le clic reste toujours intercepté, même sans <body> exploitable')
    assert.equal(pushStateCalls.length, 1, "l'URL est poussée comme pour toute navigation interceptée")
    assert.equal(ajaxCalled, true, 'le fetch est tenté (plus de branche « rien à échanger »)')
  })

  it("<body> PRÉEXISTANT (avec du contenu) : interception SPA identique (preventDefault + pushState + fetch) — le contenu de <body> ne change RIEN (ex-test « #app-root présent », intention redéfinie : plus de distinction possible sans cascade)", function () {
    const pushStateCalls: any[] = []
    let ajaxCalled = false
    const liveRoot: any = { replaceChildren() {}, childNodes: [] as any[] }
    const win: any = {
      location: { pathname: '/', search: '', origin: 'http://x', href: 'http://x/', hash: '' },
      history: { pushState: (...a: any[]) => pushStateCalls.push(a) },
    }
    const doc: any = { body: liveRoot }
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: () => { ajaxCalled = true },
      Router: { navigate() {} },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    const e = makeEvent(makeCrossLink('/tuto', 'http://x/tuto#/lecon', '#/lecon'))
    makeClickHandler()(e, µ, win, doc, class {})
    assert.equal(e.defaultPrevented, true)
    assert.equal(pushStateCalls.length, 1)
    assert.equal(pushStateCalls[0][2], '/tuto#/lecon')
    assert.equal(ajaxCalled, true)
  })

  it('réponse fetch SANS <body> exploitable : repli via µ._mjs_hardNav (plus de location.href muet)', function () {
    let capturedCb: any
    const hardNavCalls: any[] = []
    const liveRoot: any = { replaceChildren() {}, childNodes: [] as any[] }
    const win: any = {
      location: { pathname: '/', search: '', origin: 'http://x', href: 'http://x/', hash: '' },
      history: { pushState() {} },
    }
    const doc: any = { body: liveRoot }
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, cb: any) => { capturedCb = cb },
      _mjs_hardNav: (d: string) => hardNavCalls.push(d),
      Router: { navigate() {} },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    // réponse PARSÉE sans <body> exploitable : µ._mjs_navMountZone(doc, null) résout
    // `doc.body` = undefined → la condition `newRoot && liveRoot` du handler reste
    // fausse, même repli _mjs_hardNav qu'avant.
    class DP { parseFromString() { return { body: null } } }
    makeClickHandler()(makeEvent(makeCrossLink('/tuto', 'http://x/tuto#/lecon', '#/lecon')), µ, win, doc, DP)
    assert.ok(typeof capturedCb === 'function', '_mjs_ajaxGet a bien été appelé')
    capturedCb('<html>tuto</html>', 'http://x/tuto')
    assert.deepEqual(hardNavCalls, ['http://x/tuto#/lecon'], 'le repli passe par _mjs_hardNav (reload si URL identique)')
  })

  it('échec réseau du fetch : repli via µ._mjs_hardNav aussi', function () {
    let capturedErr: any
    const hardNavCalls: any[] = []
    const liveRoot: any = { replaceChildren() {}, childNodes: [] as any[] }
    const win: any = {
      location: { pathname: '/', search: '', origin: 'http://x', href: 'http://x/', hash: '' },
      history: { pushState() {} },
    }
    const doc: any = { body: liveRoot }
    const µ: any = {
      realTarget: (e: any) => e.target, _mjs_navSeq: 0, _mjs_lastUjsPath: '/',
      pageCache: { has: () => false, get: () => null, set() {} }, _mjs_saveScroll() {},
      _mjs_ajaxGet: (_u: string, _cb: any, errCb: any) => { capturedErr = errCb },
      _mjs_hardNav: (d: string) => hardNavCalls.push(d),
      Router: { navigate() {} },
      warn() {}, error() {}, log() {},
    }
    installHelpers(µ, doc, win)
    makeClickHandler()(makeEvent(makeCrossLink('/tuto', 'http://x/tuto#/lecon', '#/lecon')), µ, win, doc, class {})
    assert.ok(typeof capturedErr === 'function', 'le callback d\'échec a bien été passé')
    capturedErr()
    assert.deepEqual(hardNavCalls, ['http://x/tuto#/lecon'])
  })
})

describe('µ._mjs_hardNav — même URL (déjà poussée au clic) → reload(), sinon location.href', function () {
  it('destination === URL courante (hash compris) : reload() — une réassignation serait un no-op same-document', function () {
    let reloads = 0
    const win: any = { location: { href: 'http://x/tuto#/lecon', reload: () => reloads++ } }
    makeHardNav()('http://x/tuto#/lecon', win)
    assert.equal(reloads, 1)
    assert.equal(win.location.href, 'http://x/tuto#/lecon')
  })

  it('destination RELATIVE égale : résolue contre location.href → reload() aussi', function () {
    let reloads = 0
    const win: any = { location: { href: 'http://x/tuto#/lecon', reload: () => reloads++ } }
    makeHardNav()('/tuto#/lecon', win)
    assert.equal(reloads, 1)
  })

  it('destination différente : navigation dure classique (location.href)', function () {
    let reloads = 0
    const win: any = { location: { href: 'http://x/', reload: () => reloads++ } }
    makeHardNav()('http://x/tuto', win)
    assert.equal(reloads, 0)
    assert.equal(win.location.href, 'http://x/tuto')
  })
})
