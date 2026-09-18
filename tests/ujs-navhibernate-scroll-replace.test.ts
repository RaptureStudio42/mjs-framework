// µ._mjs_navHibernate(zone, path) : la garde combinée `if (!zone || path == null ||
// !µ.pageCache || …) { return; }` sortait AVANT µ._mjs_saveScroll — pour la politique 'no-cache', le
// code prenait pourtant explicitement soin d'appeler µ._mjs_saveScroll AVANT son propre `return`
// (commentaire du fichier) : « refuser la mise en cache DOM n'a aucune raison de
// sacrifier aussi le confort du retour au bon endroit ». Le MÊME raisonnement s'applique quand
// `zone === null` — page quittée montée en `method:'replace'` (µ._mjs_navCacheZone() rend alors null,
// cf. mjs_ujs.ts:500-504) — mais la garde en tête rendait ce cas structurellement inatteignable :
// seule différence entre les deux scénarios.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// µ._mjs_navHibernate n'a pas de marqueur individuel : il vit dans le grand bloc 'helpers-navigation'
// (même extraction que tests/ujs-nav-cache-policy.test.ts et tests/ujs-preloadcache-unbounded.test.ts).
function installHelpers(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, document, window)
}

function makeZone(): any {
  return { childNodes: [] }
}

function makeEventDoc(): any {
  const listeners: Array<(e: any) => void> = []
  return {
    addEventListener(_type: string, fn: (e: any) => void) { listeners.push(fn) },
    dispatchEvent(e: any) { listeners.forEach((fn) => fn(e)); return true },
  }
}

function makeMu(overrides: any = {}) {
  return Object.assign({ warn() {}, error() {}, log() {} }, overrides)
}

describe("mjs_ujs — µ._mjs_navHibernate : le scroll est sauvegardé même SANS zone hibernable (method:'replace')", function () {
  it("zone === null (comme après µ._mjs_navCacheZone() sur une page montée en 'replace'), policy 'cache-first' : µ._mjs_saveScroll(path) appelé quand même, aucune entrée pageCache créée", function () {
    const savedCalls: string[] = []
    const µ: any = makeMu({ _mjs_navCachePolicy: 'cache-first', pageCache: new Map(), _mjs_saveScroll: (p: string) => savedCalls.push(p) })
    installHelpers(µ, makeEventDoc(), {})

    µ._mjs_navHibernate(null, '/page-b')

    assert.deepEqual(savedCalls, ['/page-b'], "AVANT le fix : _mjs_saveScroll n'était JAMAIS appelé quand zone est null — la position de scroll de la page quittée était perdue")
    assert.equal(µ.pageCache.size, 0, 'aucune entrée pageCache : zone === null, rien à archiver')
  })

  it("zone === null, policy 'no-cache' (les deux causes de sortie anticipée cumulées) : µ._mjs_saveScroll(path) appelé quand même", function () {
    const savedCalls: string[] = []
    const µ: any = makeMu({ _mjs_navCachePolicy: 'no-cache', pageCache: new Map(), _mjs_saveScroll: (p: string) => savedCalls.push(p) })
    installHelpers(µ, makeEventDoc(), {})

    µ._mjs_navHibernate(null, '/page-c')

    assert.deepEqual(savedCalls, ['/page-c'])
  })

  it("path == null : µ._mjs_saveScroll n'est PAS appelé (rien à enregistrer, comportement inchangé)", function () {
    const savedCalls: string[] = []
    const µ: any = makeMu({ _mjs_navCachePolicy: 'cache-first', pageCache: new Map(), _mjs_saveScroll: (p: string) => savedCalls.push(p) })
    installHelpers(µ, makeEventDoc(), {})

    µ._mjs_navHibernate(null, null)

    assert.deepEqual(savedCalls, [])
  })

  it("contre-épreuve — zone RÉELLE, policy 'cache-first' : µ._mjs_saveScroll appelé EXACTEMENT une fois (pas de doublon introduit par le déplacement)", function () {
    const savedCalls: string[] = []
    const µ: any = makeMu({ _mjs_navCachePolicy: 'cache-first', pageCache: new Map(), _mjs_saveScroll: (p: string) => savedCalls.push(p) })
    installHelpers(µ, makeEventDoc(), {})

    µ._mjs_navHibernate(makeZone(), '/page-a')

    assert.deepEqual(savedCalls, ['/page-a'], 'un seul appel, pas deux')
    assert.equal(µ.pageCache.has('/page-a'), true, 'zone réelle : entrée pageCache créée normalement')
  })
})
