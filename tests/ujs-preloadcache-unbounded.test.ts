// Régression : `µ._mjs_preloadCache` était une
// Map SANS BORNE — une session SPA longue durée qui survole/eager-précharge
// de nombreux liens distincts (menu de navigation visité plusieurs fois,
// listing paginé avec IDs dynamiques) accumulait une entrée par URL
// préchargée, POUR TOUJOURS. Même dérive mémoire, non bornée, que celle qui
// avait justifié le passage de µ.pageCache en LRU (µ.LRUCache) — sauf que
// _mjs_preloadCache n'avait jamais reçu le même traitement.
//
// Fix : `µ._mjs_preloadCache = new µ.LRUCache(30)` au lieu de `new Map()` (30,
// pas 10 comme pageCache : entrées plus légères — texte HTML brut, pas un
// arbre DOM+composants+listeners — et souvent spéculatives). Aucun onEvict
// nécessaire : pas de teardown à lancer sur du texte, contrairement aux
// arbres hibernés de pageCache.

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

function extractPreloadCacheInit(src: string): string {
  return extractMarked(src, '_mjs_preloadCache-init')
}

function makePreloadCache(): any {
  const µ: any = { warn() {} }
  new Function('µ', extractLRUCacheStatement(PAGE_CACHE_SRC) + '\n' + extractPreloadCacheInit(UJS_SRC))(µ)
  return µ._mjs_preloadCache
}

describe("mjs_ujs — µ._mjs_preloadCache est borné (LRU, pas une Map illimitée)", function () {
  it("accepte plus de 30 entrées SANS dépasser 30 (éviction, pas de fuite non bornée)", function () {
    const cache = makePreloadCache()
    for (let i = 0; i < 45; i++) { cache.set(`/page-${i}`, `<html>${i}</html>`) }
    assert.equal(cache.size, 30, "AVANT le fix : Map brute, aurait accepté les 45 entrées sans jamais évincer")
  })

  it("évince la plus ANCIENNE entrée non ré-accédée (sémantique LRU, pas FIFO aveugle)", function () {
    const cache = makePreloadCache()
    for (let i = 0; i < 30; i++) { cache.set(`/page-${i}`, `html-${i}`) }
    cache.get('/page-0') // ré-accède la plus ancienne → la remonte en MRU
    cache.set('/page-30', 'html-30') // dépasse 30 → évince la (nouvelle) plus ancienne = /page-1
    assert.equal(cache.has('/page-0'), true, "/page-0 a été ré-accédée juste avant : ne doit PAS être évincée")
    assert.equal(cache.has('/page-1'), false, "/page-1 est maintenant la plus ancienne jamais ré-accédée : évincée")
  })

  it("has()/get()/set()/clear() : API compatible avec les call-sites existants (_mjs_ajaxGet, _mjs_preloadLink, invalidation submit)", function () {
    const cache = makePreloadCache()
    assert.equal(cache.has('/x'), false)
    cache.set('/x', 'html-x')
    assert.equal(cache.has('/x'), true)
    assert.equal(cache.get('/x'), 'html-x')
    cache.clear()
    assert.equal(cache.has('/x'), false)
    assert.equal(cache.size, 0)
  })
})
