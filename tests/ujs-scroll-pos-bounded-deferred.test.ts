// Régression : 2 défauts sur le même
// mécanisme (`µ._mjs_scrollPos` / `_mjs_restoreScroll`) :
//
//   1. `µ._mjs_scrollPos` était une Map SANS BORNE — une session SPA longue durée
//      qui visite de nombreuses URLs distinctes (back/forward, pagination)
//      accumulait une entrée par page, POUR TOUJOURS. Fix : LRUCache(50) au
//      lieu de `new Map()` (50 : entrées minuscules, juste 2 nombres/page).
//
//   2. `_mjs_restoreScroll` appelait `window.scrollTo(x, y)` SYNCHRONEMENT, juste
//      après l'insertion du nouvel arbre DOM — si ses composants n'ont pas
//      fini leur rendu initial (cache-miss réseau surtout), la page n'a pas
//      encore sa hauteur finale et `scrollTo` se fait CLAMPER à une position
//      trop basse. Fix : report d'une frame via `requestAnimationFrame`
//      (même idiome que `_mjs_scanEager` dans le même fichier), avec repli
//      synchrone si `requestAnimationFrame` est indisponible.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')

function extractLRUCacheStatement(src: string): string {
  return extractMarked(src, 'LRUCache')
}

function extractStatement(src: string, name: string): string {
  return extractMarked(src, name)
}

describe('mjs_ujs — µ._mjs_scrollPos est borné (LRU, pas une Map illimitée)', function () {
  function makeScrollPos(): any {
    const µ: any = { warn() {} }
    new Function('µ', extractLRUCacheStatement(PAGE_CACHE_SRC) + '\n' + extractMarked(UJS_SRC, '_mjs_scrollPos'))(µ)
    return µ._mjs_scrollPos
  }

  it("accepte plus de 50 entrées SANS dépasser 50 (éviction, pas de fuite non bornée)", function () {
    const cache = makeScrollPos()
    for (let i = 0; i < 70; i++) { cache.set(`/page-${i}`, [0, i]) }
    assert.equal(cache.size, 50, "AVANT le fix : Map brute, aurait accepté les 70 entrées sans jamais évincer")
  })

  it('has()/get()/set() : API compatible avec _mjs_saveScroll/_mjs_restoreScroll', function () {
    const cache = makeScrollPos()
    cache.set('/x', [1, 2])
    assert.deepEqual(cache.get('/x'), [1, 2])
    assert.equal(cache.get('/jamais-visite'), undefined)
  })
})

describe("mjs_ujs — _mjs_restoreScroll diffère window.scrollTo d'une frame (évite le clamp pré-rendu)", function () {
  function extractRestoreScroll(): string {
    return extractStatement(UJS_SRC, '_mjs_restoreScroll')
  }

  it("ne scrolle PAS synchroneement : window.scrollTo attend le prochain requestAnimationFrame", function () {
    const scrollCalls: any[] = []
    const fakeWindow = { scrollTo: (x: number, y: number) => scrollCalls.push([x, y]) }
    const rafCallbacks: any[] = []
    const fakeRaf = (cb: any) => { rafCallbacks.push(cb); return 1 }
    const µ: any = { _mjs_scrollPos: new Map([['/x', [10, 200]]]) }
    new Function('µ', 'requestAnimationFrame', 'window', extractRestoreScroll())(µ, fakeRaf, fakeWindow)

    µ._mjs_restoreScroll('/x')
    assert.equal(scrollCalls.length, 0, "AVANT le fix : scrollTo partait immédiatement, avant que le contenu inséré n'ait fini de se peindre")
    assert.equal(rafCallbacks.length, 1, 'un requestAnimationFrame doit avoir été programmé')

    rafCallbacks[0]()
    assert.deepEqual(scrollCalls[0], [10, 200])
  })

  it('sans requestAnimationFrame disponible (repli) : scrollTo part immédiatement', function () {
    const scrollCalls: any[] = []
    const fakeWindow = { scrollTo: (x: number, y: number) => scrollCalls.push([x, y]) }
    const µ: any = { _mjs_scrollPos: new Map([['/x', [5, 50]]]) }
    // Pas de paramètre requestAnimationFrame du tout : `typeof requestAnimationFrame`
    // doit rester sûr (pas de ReferenceError) et retomber sur l'appel synchrone.
    new Function('µ', 'window', extractRestoreScroll())(µ, fakeWindow)

    µ._mjs_restoreScroll('/x')
    assert.deepEqual(scrollCalls[0], [5, 50])
  })

  it('chemin jamais sauvegardé : scrolle en (0,0) (comportement inchangé)', function () {
    const scrollCalls: any[] = []
    const fakeWindow = { scrollTo: (x: number, y: number) => scrollCalls.push([x, y]) }
    const rafCallbacks: any[] = []
    const fakeRaf = (cb: any) => rafCallbacks.push(cb)
    const µ: any = { _mjs_scrollPos: new Map() }
    new Function('µ', 'requestAnimationFrame', 'window', extractRestoreScroll())(µ, fakeRaf, fakeWindow)

    µ._mjs_restoreScroll('/jamais-visite')
    rafCallbacks[0]()
    assert.deepEqual(scrollCalls[0], [0, 0])
  })
})
