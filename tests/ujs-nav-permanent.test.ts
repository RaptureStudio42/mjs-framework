// Élément `mjs-permanent` : un nœud qui porte cet attribut ET un `id` traverse une navigation
// SANS être recréé (lecteur audio, chat, panneau à défilement propre). Couvre :
//   1. µ._mjs_navFindById/µ._mjs_navFindByIdIn — appariement par id, racine ET descendant.
//   2. µ._mjs_navWarnPermanentNoId — un avertissement par élément (drapeau porté par le nœud).
//   3. µ._mjs_navTransplantPermanents (+ wiring µ._mjs_navInstallNodes) — 'update'/'replace' transplantent
//      AVANT l'installation, 'append' ne transplante rien, racine du tableau `nodes` couverte.
//   4. Cache-hit (popstate, retour arrière) : le permanent vivant rejoint l'arbre archivé restauré.
//   5. Synchronicité (piège 1) : un transplant ne fait JAMAIS courir le composant vers sa destruction
//      différée (mjs_element.ts) — vérifié avec de VRAIS Custom Elements (happy-dom), pas supposé.
//
// Méthode : mêmes techniques d'extraction que les fichiers voisins (tests/ujs-nav-cache-policy.test.ts,
// tests/ujs-popstate-anchor-clears-views.test.ts) — lecture de la SOURCE réelle, `new Function`, pas de
// compilation. Le point 5 sort de ce patron (nœuds FAKE insuffisants pour observer connectedCallback/
// disconnectedCallback réels) : `happy-dom` fournit de VRAIS Custom Elements, comme
// tests/lifecycle-reconnect-dead-flag.test.ts pour le même sujet côté mjs_element.ts.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'
import { assertAbsent } from './helpers/dom-assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// Même bloc « helpers de zone de navigation » que les fichiers voisins
// (µ._mjs_navMountZone → µ._mjs_navRequest, contigus) : µ._mjs_navTransplantPermanents et ses dépendances
// y vivent désormais aussi, juste avant µ._mjs_navInstallNodes.
function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, document, window)
}
function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}
function makePopstateHandler(µ: any, win: any, doc: any) {
  installHelpers(µ, doc, win)
  const body = extractPopstateBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', body)
}

// Nœud FAKE : `.id`, `.children`/`.childNodes`, `mjs-permanent` via `matches`/`querySelectorAll`
// (ce que µ._mjs_navTransplantPermanents touche réellement), `replaceWith`/`replaceChildren`/`appendChild`.
function makeEl(tag: string, opts: { id?: string, permanent?: boolean } = {}): any {
  const el: any = {
    tag, id: opts.id || '', nodeType: 1, parentNode: null as any, children: [] as any[],
    _attrs: opts.permanent ? { 'mjs-permanent': '' } : {},
    get childNodes() { return el.children.slice() },
    matches(sel: string) { return sel === '[mjs-permanent]' && Object.prototype.hasOwnProperty.call(el._attrs, 'mjs-permanent') },
    querySelectorAll(sel: string) {
      const out: any[] = []
      const walk = (n: any) => { for (const c of n.children) { if (c.matches && c.matches(sel)) { out.push(c) }; walk(c) } }
      walk(el)
      return out
    },
    appendChild(c: any) { el.children.push(c); c.parentNode = el; return c },
    replaceChildren(...nodes: any[]) {
      el.children.forEach((c: any) => { c.parentNode = null })
      el.children = nodes.slice()
      el.children.forEach((c: any) => { c.parentNode = el })
    },
    // no-op DOM si `el` est une racine SANS parent — même comportement que le `ChildNode.replaceWith`
    // natif (spec : « If parent is null, then return » — l'appelant ne peut compter que sur le retour).
    replaceWith(...repl: any[]) {
      if (!el.parentNode) { return }
      const parent = el.parentNode
      const idx = parent.children.indexOf(el)
      if (idx === -1) { return }
      parent.children.splice(idx, 1, ...repl)
      repl.forEach((n: any) => { n.parentNode = parent })
      el.parentNode = null
    },
  }
  return el
}

function baseMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}

describe('mjs_ujs — µ._mjs_navFindById / µ._mjs_navFindByIdIn : appariement par id', function () {
  it('id présent à la RACINE d\'un des nœuds du tableau : trouvé directement', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const racine = makeEl('div', { id: 'radio' })
    assert.equal(µ._mjs_navFindById([makeEl('header'), racine], 'radio'), racine)
  })

  it('id présent en DESCENDANT (pas la racine elle-même) : trouvé par parcours récursif', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const cible = makeEl('span', { id: 'radio' })
    const main = makeEl('main')
    main.appendChild(makeEl('p'))
    main.appendChild(cible)
    assert.equal(µ._mjs_navFindById([makeEl('header'), main], 'radio'), cible)
  })

  it('id absent partout : null, aucune erreur', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    assert.equal(µ._mjs_navFindById([makeEl('header'), makeEl('main')], 'radio'), null)
  })
})

describe('mjs_ujs — µ._mjs_navWarnPermanentNoId : un avertissement par élément', function () {
  it('sans id : averti UNE FOIS, même appelé plusieurs fois sur le même élément', function () {
    const warns: string[] = []
    const µ: any = baseMu({ warn: (m: string) => warns.push(m) })
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const el = makeEl('mjs-x', { permanent: true })
    µ._mjs_navWarnPermanentNoId(el)
    µ._mjs_navWarnPermanentNoId(el)
    µ._mjs_navWarnPermanentNoId(el)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /mjs-permanent/)
    assert.match(warns[0], /id/)
  })

  it('deux éléments distincts : un avertissement CHACUN (drapeau porté par le nœud)', function () {
    const warns: string[] = []
    const µ: any = baseMu({ warn: (m: string) => warns.push(m) })
    installHelpers(µ, { body: makeEl('other-body') }, {})
    µ._mjs_navWarnPermanentNoId(makeEl('mjs-x', { permanent: true }))
    µ._mjs_navWarnPermanentNoId(makeEl('mjs-y', { permanent: true }))
    assert.equal(warns.length, 2)
  })
})

describe('mjs_ujs — µ._mjs_navTransplantPermanents : transplant avant installation', function () {
  it('permanent apparié (descendant) : le nœud vivant est le MÊME objet après échange, l\'entrant a disparu', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const vivant = makeEl('mjs-audio', { id: 'radio', permanent: true })
    const zone = makeEl('body')
    zone.appendChild(makeEl('p'))
    zone.appendChild(vivant)
    const main = makeEl('main')
    const entrant = makeEl('mjs-audio-placeholder', { id: 'radio' })
    main.appendChild(entrant)
    const nodes = [makeEl('header'), main]

    µ._mjs_navInstallNodes({ zone }, nodes, 'update', undefined)

    assert.equal(main.children.indexOf(vivant) !== -1, true, 'le vivant a pris la place de l\'entrant, DANS main (identité)')
    assert.equal(main.children.indexOf(entrant), -1, 'l\'entrant a disparu de main')
    assert.deepEqual(zone.children, nodes, 'zone vidée puis remplie par nodes (µ._mjs_zoneFill), main y figure toujours')
  })

  it('permanent SANS homologue dans l\'arrivant : il part avec l\'ancien contenu, aucune erreur', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const vivant = makeEl('mjs-audio', { id: 'radio', permanent: true })
    const zone = makeEl('body')
    zone.appendChild(vivant)
    const nodes = [makeEl('header'), makeEl('main')] // aucun id 'radio' nulle part

    assert.doesNotThrow(() => µ._mjs_navInstallNodes({ zone }, nodes, 'update', undefined))
    assert.equal(zone.children.indexOf(vivant), -1, 'le vivant est parti avec l\'ancien contenu, jamais transplanté')
    assert.deepEqual(zone.children, nodes)
  })

  it('permanent SANS id, rencontré au fil de DEUX transplants du même nœud : un seul avertissement', function () {
    const warns: string[] = []
    const µ: any = baseMu({ warn: (m: string) => warns.push(m) })
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const zone = makeEl('body')
    const sansId = makeEl('mjs-x', { permanent: true }) // pas de id
    zone.appendChild(sansId)

    µ._mjs_navTransplantPermanents(zone, [makeEl('div')])
    µ._mjs_navTransplantPermanents(zone, [makeEl('div')])

    assert.equal(warns.length, 1, 'le drapeau est porté par le nœud lui-même, pas remis à zéro entre deux navigations')
  })

  it("mode 'append' : µ._mjs_navTransplantPermanents n'est même pas appelé (rien n'est retiré, rien à transplanter)", function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const calls: any[] = []
    µ._mjs_navTransplantPermanents = (zone: any, nodes: any) => calls.push([zone, nodes])
    const zone = makeEl('body')
    µ._mjs_navInstallNodes({ zone }, [makeEl('div')], 'append', undefined)
    assert.equal(calls.length, 0)
  })

  it('permanent apparié à la RACINE du tableau `nodes` (pas seulement en descendant)', function () {
    const µ: any = baseMu()
    installHelpers(µ, { body: makeEl('other-body') }, {})
    const vivant = makeEl('mjs-audio', { id: 'radio', permanent: true })
    const zone = makeEl('body')
    zone.appendChild(vivant)
    const entrantRacine = makeEl('mjs-audio-placeholder', { id: 'radio' }) // racine du tableau, SANS parent
    const nodes = [makeEl('header'), entrantRacine]

    µ._mjs_navTransplantPermanents(zone, nodes)

    assert.equal(nodes[1], vivant, "l'ENTRÉE du tableau elle-même est remplacée (replaceWith seul est un no-op DOM sur une racine sans parent)")
    assert.equal(nodes.indexOf(entrantRacine), -1)
  })

  it("mode 'replace' (contenant détachable, ≠ body) : le transplant a lieu AVANT que le contenant ne cède sa place", function () {
    const µ: any = baseMu()
    const bodyMarker = makeEl('other-body')
    installHelpers(µ, { body: bodyMarker }, {})
    const vivant = makeEl('mjs-audio', { id: 'radio', permanent: true })
    const slot = makeEl('slot-page')
    const host = makeEl('body') // parent du slot, distinct de bodyMarker (le document.body du harnais)
    host.appendChild(slot)
    slot.appendChild(vivant)
    const entrant = makeEl('mjs-page', { id: 'radio' }) // racine du module installé, porte lui-même l'id ciblé
    const footer = makeEl('footer')
    const nodes = [entrant, footer]

    µ._mjs_navInstallNodes({ zone: slot }, nodes, 'replace', undefined)

    assert.equal(host.children.length, 2)
    assert.equal(host.children[0], vivant, "le vivant a remplacé l'entrant à la racine du module installé")
    assert.equal(host.children[1], footer)
    assertAbsent(slot.parentNode, 'le contenant a bien cédé sa place')
  })
})

describe('mjs_ujs — popstate, cache-hit : le permanent vivant rejoint l\'arbre archivé restauré', function () {
  it('retour arrière vers une page en cache : le nœud vivant (pas le placeholder archivé) est dans l\'arbre restauré', function () {
    const vivant = makeEl('mjs-audio', { id: 'radio', permanent: true })
    const currentRoot = makeEl('body')
    currentRoot.appendChild(makeEl('p')) // contenu quelconque de la page C, quittée
    currentRoot.appendChild(vivant)

    const entrantArchive = makeEl('mjs-page-b', { id: 'radio' }) // photographie archivée de B (autre objet, même id)
    const µ: any = baseMu({
      _mjs_lastUjsPath: '/c',
      _mjs_navSeq: 0,
      pageCache: new Map([['/b', [entrantArchive]]]),
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      Router: { navigate() {} },
    })
    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    const doc: any = { body: currentRoot }
    const handler = makePopstateHandler(µ, win, doc)

    handler({}, µ, win, doc, undefined)

    assert.equal(currentRoot.children.indexOf(vivant) !== -1, true, 'le permanent vivant est bien dans l\'arbre restauré')
    assert.equal(currentRoot.children.indexOf(entrantArchive), -1, 'le placeholder archivé (autre objet) a disparu')
  })
})

describe('mjs_ujs — µ._mjs_navTransplantPermanents : SYNCHRONE, même tick que l\'installation (piège 1)', function () {
  it('un composant transplanté n\'est JAMAIS marqué détruit par le passage transitoire par un état déconnecté (Custom Elements réels, happy-dom)', async function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document

    let mounts = 0
    let destroyed = false
    class Perm extends win.HTMLElement {
      connectedCallback() {
        this._mjs_dead = false
        if (!this._mjs_mjsInitialized) { this._mjs_mjsInitialized = true; mounts++ } // patron mjs_element.ts
      }
      disconnectedCallback() {
        this._mjs_dead = true // patron mjs_element.ts (inconditionnel)
        // patron mjs_element.ts : destruction DIFFÉRÉE en microtask, sautée si le nœud
        // est reconnecté (ou en cache de pages) au réveil de cette microtask.
        queueMicrotask(() => {
          if (this.isConnected) { return }
          if (this._mjs_page_cached) { return }
          destroyed = true
        })
      }
    }
    win.customElements.define('mjs-perm', Perm)

    const µ: any = baseMu()
    installHelpers(µ, document, win)

    const zone: any = document.createElement('div')
    document.body.appendChild(zone)
    const vivant: any = document.createElement('mjs-perm')
    vivant.id = 'radio'
    vivant.setAttribute('mjs-permanent', '')
    zone.appendChild(vivant)
    assert.equal(mounts, 1, 'monté une 1re fois')
    assert.equal(vivant._mjs_dead, false)

    // `nodes` qui arrive : `wrapper` DÉTACHÉ (pas encore inséré dans le document), `entrant` un de ses
    // DESCENDANTS — scénario réaliste de µ._mjs_navInstallNodes ('update' : newRoot.childNodes).
    const wrapper: any = document.createElement('div')
    const entrant: any = document.createElement('div')
    entrant.id = 'radio'
    wrapper.appendChild(entrant)
    const nodes = [wrapper]

    µ._mjs_navTransplantPermanents(zone, nodes)

    // À CET INSTANT : le vivant a quitté `zone` (disconnectedCallback a tiré, `_mjs_dead=true` un
    // instant) pour rejoindre `wrapper`, TOUJOURS détaché du document (pas encore installé).
    assert.equal(vivant.parentNode, wrapper, 'transplanté dans le nouvel arbre, à la place de son homologue')
    assert.equal(vivant.isConnected, false, 'transitoirement détaché — le nouvel arbre n\'est pas encore dans le document')

    // Installation (même tick, AUCUN await entre le transplant et cette ligne) — comme µ._mjs_zoneFill.
    zone.replaceChildren(...nodes)

    assert.equal(vivant.isConnected, true, 'réinstallé dans le document, même tick')
    assert.equal(vivant._mjs_dead, false, 'jamais resté marqué mort : reconnecté avant la fin du tick')
    assert.equal(mounts, 1, 'PAS un second montage (_mjs_mjsInitialized bloque le remontage, comme mjs_element.ts)')

    await new Promise((r) => setTimeout(r, 10)) // laisse tourner la microtask de disconnectedCallback
    assert.equal(destroyed, false, 'le composant transplanté n\'a JAMAIS été détruit par cet aller-retour synchrone')

    win.close?.()
  })
})
