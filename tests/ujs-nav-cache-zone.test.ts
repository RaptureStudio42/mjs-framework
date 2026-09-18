// CONTENANT COURANT du cache de pages
// (`µ._mjs_navContainer` / `µ._mjs_navCacheZone`). Le cache de pages hiberne le CONTENU
// du contenant que le dernier montage a rempli, pas les enfants de `<body>` :
// sans cet état, un montage ciblé (`target: 'main'`) aurait photographié les
// enfants de `<body>` — habillage compris — tout en ne remplaçant que le contenu
// de `<main>`. Au Précédent, le contenu revenait au mauvais endroit et le
// drapeau d'hibernation restait posé sur des nœuds VIVANTS (composants exemptés
// de destruction à vie). Un montage `method: 'replace'` n'a plus de contenant
// stable : cette page ne participe donc pas au cache (`_mjs_navCacheZone` → null).
//
// Méthode : extraction du corps SOURCE des trois fonctions par regex (même
// technique que ujs-mount-cascade / ujs-submit-*), exécutée via `new Function`
// avec un `document` FAKE minimal.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractFn(src: string, signature: string): string {
  return extractMarked(src, '_mjs_' + signature)
}

// Nœud FAKE : juste ce que _mjs_zoneFill / _mjs_navInstallInZone touchent réellement.
function makeNode(tag: string, connected = true) {
  const node: any = {
    tag,
    nodeType: 1,
    isConnected: connected,
    children: [] as any[],
    parentNode: null as any,
    get firstChild() { return this.children.length ? this.children[0] : null },
    removeChild(n: any) { this.children = this.children.filter((c: any) => c !== n); return n },
    appendChild(n: any) { this.children.push(n); return n },
    replaceWith(n: any) { this.replacedBy = n },
  }
  return node
}

function install(µ: any, doc: any) {
  new Function('µ', 'document', extractFn(UJS_SRC, 'navCacheZone'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'zoneFill'))(µ, doc)
  // µ._mjs_navInstallInZone délègue désormais à µ._mjs_navInstallNodes (méthode 'replace'/'append'/
  // 'update' PARTAGÉE avec le chemin HTML), qui elle-même s'appuie sur µ._mjs_navFirstEl (1er nœud ÉLÉMENT,
  // suivi de zone) et µ._mjs_zoneAppend/µ._mjs_navDropHibernation (branche 'append', jamais exercée par CE
  // fichier mais requise pour que la fonction existe — même défense que les autres extractions ici).
  new Function('µ', 'document', extractFn(UJS_SRC, 'navFirstEl'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navDropHibernation'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'zoneAppend'))(µ, doc)
  // µ._mjs_navInstallNodes appelle désormais aussi µ._mjs_navTransplantPermanents (modes 'replace'/
  // 'update', AVANT l'installation) ; requise pour que la fonction existe, même défense que les autres
  // extractions ici — aucun nœud de CE fichier ne porte `mjs-permanent`/`matches`/`querySelectorAll`,
  // le transplant y reste donc un no-op silencieux (boucle vide, cf. sa propre suite de tests dédiée :
  // tests/ujs-nav-permanent.test.ts).
  new Function('µ', 'document', extractFn(UJS_SRC, 'navFindByIdIn'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navFindById'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navWarnPermanentNoId'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navTransplantPermanents'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navInstallNodes'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navInstallInZone'))(µ, doc)
  new Function('µ', 'document', extractFn(UJS_SRC, 'navTrackZone'))(µ, doc)
}

describe('mjs_ujs — contenant courant du cache de pages', function () {
  it('aucun montage encore → le contenant du cache est <body>', function () {
    const body = makeNode('body')
    const µ: any = { _mjs_navContainer: null }
    install(µ, { body })
    assert.equal(µ._mjs_navCacheZone(), body)
  })

  it('montage ciblé (update dans <main>) → le cache visera <main>, PAS <body>', function () {
    const body = makeNode('body')
    const main = makeNode('main')
    main.parentNode = body
    const µ: any = { _mjs_navContainer: null }
    install(µ, { body })
    µ._mjs_navInstallInZone({ zone: main, mode: 'target', target: 'main' }, makeNode('mjs-page'), 'update')
    assert.equal(µ._mjs_navContainer, main)
    assert.equal(µ._mjs_navCacheZone(), main)
    assert.equal(main.children.length, 1, 'le contenant survit et contient le module')
    assert.equal(µ._mjs_navZone, null, "aucun suivi de zone en 'update' (le contenant n'a pas cédé sa place)")
  })

  it("montage 'replace' → plus de contenant stable, la page ne se cache pas", function () {
    const body = makeNode('body')
    const slot = makeNode('slot-page')
    slot.parentNode = body
    const module = makeNode('mjs-page')
    const µ: any = { _mjs_navContainer: null }
    install(µ, { body })
    µ._mjs_navInstallInZone({ zone: slot, mode: 'target', target: '#slot' }, module, 'replace')
    assert.equal(slot.replacedBy, module, 'le contenant a bien cédé sa place')
    assert.equal(µ._mjs_navContainer, false)
    assert.equal(µ._mjs_navCacheZone(), null, 'null = ni écriture ni lecture du cache pour cette page')
    assert.equal(µ._mjs_navZone, module, 'le module installé devient la place suivie')
  })

  it("un montage 'update' après un 'replace' réarme le cache", function () {
    const body = makeNode('body')
    const main = makeNode('main')
    main.parentNode = body
    const µ: any = { _mjs_navContainer: false }
    install(µ, { body })
    assert.equal(µ._mjs_navCacheZone(), null)
    µ._mjs_navInstallInZone({ zone: main, mode: 'target', target: 'main' }, makeNode('mjs-page'), 'update')
    assert.equal(µ._mjs_navCacheZone(), main)
  })

  it('contenant DÉTACHÉ du document → repli sur <body> (jamais un nœud mort)', function () {
    const body = makeNode('body')
    const orphan = makeNode('main', false)
    const µ: any = { _mjs_navContainer: orphan }
    install(µ, { body })
    assert.equal(µ._mjs_navCacheZone(), body)
  })

  it("'replace' visant <body> est dégradé en update → le cache reste actif sur <body>", function () {
    const body = makeNode('body')
    const µ: any = { _mjs_navContainer: null, warn: () => {}, _mjs_navReplaceBodyWarned: false }
    install(µ, { body })
    µ._mjs_navInstallInZone({ zone: body, mode: 'body', target: null }, makeNode('mjs-page'), 'replace')
    assert.equal(body.children.length, 1, '<body> garde ses enfants remplacés, il n\'est jamais remplacé lui-même')
    assert.equal(µ._mjs_navContainer, body)
    assert.equal(µ._mjs_navCacheZone(), body)
  })
})
