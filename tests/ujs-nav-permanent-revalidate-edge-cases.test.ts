// Défauts et trous de couverture. Un fichier dédié
// plutôt que des ajouts éparpillés : chacun de ces cas vient d'un sabotage resté VERT ou d'une perte
// de nœuds prouvée sur un vrai DOM, et doit rester nommément traçable.
//   1. `mjs-permanent` IMBRIQUÉ dans un autre permanent — l'ancêtre transplanté emmène son descendant,
//      qui se retrouvait ensuite lui-même comme homologue : `n.replaceWith(n)` le SORTAIT du document
//      sans jamais l'y remettre (perte silencieuse, prouvée sur happy-dom).
//   2. `id` DUPLIQUÉ entre deux permanents vivants — le second évinçait le premier, déjà transplanté.
//   3. Transplant dans µ._mjs_navRevalidate — le rafraîchissement de FOND est un 3e site de vidage.
//   4. µ._mjs_navRevalidate et la REDIRECTION — `fetch` suit un 302 : sans garde, le contenu d'une AUTRE
//      page (page de connexion sur session expirée) atterrissait dans le contenant courant, en silence.
//   5. µ._mjs_navRevalidate et l'entrée de cache PÉRIMÉE laissée derrière lui.
//   6. Validation de `render.cache` (mjs.config.json) — aucun test ne la couvrait.
//
// Méthode : happy-dom (VRAI DOM) pour 1-2, seul moyen d'observer ce que `replaceWith` fait réellement —
// un nœud FAKE ne reproduit pas ce comportement. Extraction depuis la SOURCE pour le reste, comme les
// fichiers voisins (tests/ujs-nav-cache-policy.test.ts, tests/ujs-nav-permanent.test.ts).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { writeFileSync } from 'node:fs'
import { Window } from 'happy-dom'
import { findConfig } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}

describe('mjs-permanent — cas limites', function () {
  function setup() {
    const win: any = new Window({ url: 'http://x/' })
    const doc = win.document
    const warns: string[] = []
    const µ: any = { warn: (m: string) => warns.push(m), version: null }
    new Function('µ', 'document', 'window', extractHelpersBlock())(µ, doc, win)
    return { win, doc, µ, warns }
  }

  it("permanent IMBRIQUÉ dans un permanent : les DEUX survivent, aucun ne quitte le document", function () {
    const { doc, µ } = setup()
    doc.body.innerHTML = '<main><div id="outer" mjs-permanent><span id="inner" mjs-permanent>vivant</span></div></main>'
    const zone = doc.querySelector('main')
    const outerLive = doc.getElementById('outer')
    const innerLive = doc.getElementById('inner')

    const incoming = doc.createElement('div')
    incoming.innerHTML = '<div id="outer" mjs-permanent><span id="inner" mjs-permanent>neuf</span></div><p>reste</p>'
    const nodes = Array.prototype.slice.call(incoming.childNodes)
    µ._mjs_navTransplantPermanents(zone, nodes)
    zone.replaceChildren(...nodes)

    assert.equal(doc.getElementById('outer'), outerLive, 'le permanent extérieur est le nœud VIVANT')
    assert.equal(doc.getElementById('inner'), innerLive, "le permanent intérieur est le nœud VIVANT, pas celui de la page reçue")
    assert.equal(innerLive.textContent, 'vivant')
    assert.ok(doc.body.contains(innerLive), "le permanent intérieur n'a PAS quitté le document")
    assert.equal(innerLive.parentNode, outerLive, 'il est resté dans son ancêtre permanent')
  })

  it("permanent imbriqué : aucun avertissement (ce n'est ni une erreur ni un id manquant)", function () {
    const { doc, µ, warns } = setup()
    doc.body.innerHTML = '<main><div id="outer" mjs-permanent><span id="inner" mjs-permanent></span></div></main>'
    const incoming = doc.createElement('div')
    incoming.innerHTML = '<div id="outer" mjs-permanent><span id="inner" mjs-permanent></span></div>'
    µ._mjs_navTransplantPermanents(doc.querySelector('main'), Array.prototype.slice.call(incoming.childNodes))

    assert.deepEqual(warns, [])
  })

  it("deux permanents vivants de MÊME id : le premier survit, le second part avec la page — et MJS le dit", function () {
    const { doc, µ, warns } = setup()
    doc.body.innerHTML = '<main><div id="dup" mjs-permanent>A</div><div id="dup" mjs-permanent>B</div></main>'
    const zone = doc.querySelector('main')
    const premier = zone.children[0]
    const second = zone.children[1]

    const incoming = doc.createElement('div')
    incoming.innerHTML = '<div id="dup" mjs-permanent>neuf</div>'
    const nodes = Array.prototype.slice.call(incoming.childNodes)
    µ._mjs_navTransplantPermanents(zone, nodes)
    zone.replaceChildren(...nodes)

    assert.ok(doc.body.contains(premier), "le premier permanent est resté dans le document (avant : évincé en silence)")
    assert.equal(premier.textContent, 'A')
    assert.equal(doc.body.contains(second), false, 'le second part avec la page quittée : un seul peut traverser')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /id 'dup' porté par PLUSIEURS éléments/)
  })

  it("id dupliqué : l'avertissement ne sort qu'UNE FOIS par id, même sur deux navigations", function () {
    const { doc, µ, warns } = setup()
    for (let n = 0; n < 2; n++) {
      doc.body.innerHTML = '<main><div id="dup" mjs-permanent>A</div><div id="dup" mjs-permanent>B</div></main>'
      const incoming = doc.createElement('div')
      incoming.innerHTML = '<div id="dup" mjs-permanent>neuf</div>'
      µ._mjs_navTransplantPermanents(doc.querySelector('main'), Array.prototype.slice.call(incoming.childNodes))
    }
    assert.equal(warns.length, 1)
  })
})

describe('µ._mjs_navRevalidate — trous de couverture', function () {
  // Harnais minimal : µ._mjs_ajaxRequest remplacé par un espion qui rend la main sur la réponse fournie.
  function setupRevalidate(opts: { html: string, finalUrl?: string, navHeaders?: any }) {
    const win: any = new Window({ url: 'http://x/liste' })
    const doc = win.document
    const µ: any = { warn() {}, version: null, _mjs_navSeq: 1 }
    new Function('µ', 'document', 'window', extractHelpersBlock())(µ, doc, win)
    // µ._mjs_navRevalidate a besoin de DOMParser (global navigateur) : ré-extraction ciblée avec injection.
    new Function('µ', 'window', 'document', 'DOMParser', extractMarked(UJS_SRC, '_mjs_navRevalidate'))(µ, win, doc, win.DOMParser)
    const deleted: string[] = []
    µ.pageCache = { delete: (p: string) => { deleted.push(p); return true } }
    µ._mjs_ajaxRequest = function (o: any) { o.success(opts.html, opts.finalUrl === undefined ? o.url : opts.finalUrl, void 0, opts.navHeaders || {}) }
    return { win, doc, µ, deleted }
  }

  // Contenant = `<body>` des DEUX côtés (aucun `target` posé) : la seule configuration où le contenu
  // reçu et le contenu affiché sont directement comparables, c'est-à-dire celle que µ._mjs_navRevalidate
  // compare réellement (`newRoot.innerHTML !== zone.innerHTML`).
  it('le permanent survit à un rafraîchissement de FOND (3e site de vidage, sabotage resté vert avant ce correctif)', function () {
    const { doc, µ } = setupRevalidate({ html: '<html><body><div id="player" mjs-permanent>neuf</div><p>b</p></body></html>' })
    doc.body.innerHTML = '<div id="player" mjs-permanent>vivant</div><p>a</p>'
    const live = doc.getElementById('player')

    µ._mjs_navRevalidate(doc.body, '/liste')

    assert.equal(doc.getElementById('player'), live, 'le nœud VIVANT est toujours celui du document')
    assert.equal(live.textContent, 'vivant', "il n'a pas été recréé depuis la réponse de fond")
    assert.equal(doc.body.querySelector('p').textContent, 'b', 'le reste du contenant a bien été rafraîchi')
  })

  it("réponse REDIRIGÉE vers une autre page (session expirée) : le contenu affiché n'est PAS remplacé", function () {
    const { doc, µ } = setupRevalidate({ html: '<html><body><h1>Connexion</h1></body></html>', finalUrl: 'http://x/login' })
    doc.body.innerHTML = '<p>ma liste</p>'

    µ._mjs_navRevalidate(doc.body, '/liste')

    assert.equal(doc.body.innerHTML, '<p>ma liste</p>', "le contenu d'une AUTRE URL ne s'installe jamais en douce")
  })

  it('redirection vers la MÊME page : le swap a bien lieu (la garde ne bloque que les AUTRES URL)', function () {
    const { doc, µ } = setupRevalidate({ html: '<html><body><p>frais</p></body></html>', finalUrl: 'http://x/liste' })
    doc.body.innerHTML = '<p>vieux</p>'

    µ._mjs_navRevalidate(doc.body, '/liste')

    assert.equal(doc.body.innerHTML, '<p>frais</p>')
  })

  it("après un swap de fond, l'entrée de cache PÉRIMÉE de ce chemin est retirée (elle pointait des nœuds détachés)", function () {
    const { doc, µ, deleted } = setupRevalidate({ html: '<html><body><p>frais</p></body></html>' })
    doc.body.innerHTML = '<p>vieux</p>'

    µ._mjs_navRevalidate(doc.body, '/liste')

    assert.deepEqual(deleted, ['/liste'])
  })

  it('contenu IDENTIQUE : ni swap ni purge de cache (aucun effet de bord sur un rafraîchissement pour rien)', function () {
    const { doc, µ, deleted } = setupRevalidate({ html: '<html><body><p>pareil</p></body></html>' })
    doc.body.innerHTML = '<p>pareil</p>'

    µ._mjs_navRevalidate(doc.body, '/liste')

    assert.deepEqual(deleted, [])
  })
})

describe('render.cache — validation de la configuration (aucun test ne la couvrait)', function () {
  function writeCfg(render: any) {
    const root = mjsTmp('cfg-cache')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'src', outputDir: 'out', manifestPath: 'b.js', render }))
    return root
  }

  it('les 3 valeurs valides passent', function () {
    for (const cache of ['cache-first', 'revalidate', 'no-cache']) {
      assert.doesNotThrow(() => findConfig(writeCfg({ cache })), `${cache} devrait être accepté`)
    }
  })

  it('render.cache absent : accepté (la clé est facultative)', function () {
    assert.doesNotThrow(() => findConfig(writeCfg({})))
  })

  it('valeur inconnue : rejetée, et le message nomme la valeur fautive', function () {
    assert.throws(() => findConfig(writeCfg({ cache: 'toujours' })), /toujours/)
  })
})
