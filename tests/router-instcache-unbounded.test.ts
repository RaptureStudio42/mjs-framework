// Test de régression — `_mjs_injectView` (mjs_router.ts) créait le cache de
// vues hibernées PAR COMPOSANT (`instCache`, keyé par `<targetId>-<moduleName>`)
// via un `new Map()` SANS BORNE — une session SPA longue durée qui affiche,
// l'un après l'autre dans le MÊME `<@view>`, de nombreux composants routés
// DISTINCTS accumule un ARBRE DOM COMPLET hiberné par entrée, POUR TOUJOURS —
// même dérive mémoire que `pageCache`/`_mjs_scrollPos`/`_mjs_preloadCache` (déjà
// bornés en LRU ailleurs dans mjs_ujs.ts). `µ._mjs_destroyEvictedTree`
// (mjs_page_cache.ts) mentionne DÉJÀ explicitement "vues du routeur" dans son PROPRE
// commentaire comme consommateur visé — jamais câblé jusqu'à ce fix.
//
// Fix : `instCache` devient un `µ.LRUCache(10)` (même borne que `pageCache`),
// avec `onEvict` déclenchant `µ._mjs_destroyEvictedTree` sur l'élément évincé
// (relance les teardowns différés par l'hibernation — sinon chaque timer posé
// en `@mount` d'une vue évincée fuyait à vie).
//
// Méthode : charge mjs_init.ts + mjs_page_cache.ts (pour la VRAIE
// µ.LRUCache/_mjs_destroyEvictedTree, pas une réimplémentation — DÉTACHÉS du cœur, cf.
// bundler/index.ts) PUIS mjs_router.ts dans le MÊME contexte `µ`, via
// `new Function` (même précédent que runtime.test.ts) — un DOM happy-dom réel
// fournit `document.createElement`/`querySelector` sans avoir à les simuler.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const initSrc = readFileSync(join(__dirname, '../src/runtime/mjs_init.ts'), 'utf-8')
  .replace(/export\s*\{[^}]*\}/, '')
const pageCacheSrc = readFileSync(join(__dirname, '../src/runtime/mjs_page_cache.ts'), 'utf-8')
const routerSrc = readFileSync(join(__dirname, '../src/runtime/mjs_router.ts'), 'utf-8')

function loadRouter(win: any) {
  const sandbox = `
    ${initSrc}
    ${pageCacheSrc}
    ${routerSrc}
    return µ;
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function('window', 'document', 'customElements', 'HTMLElement', 'CSSStyleSheet', sandbox)(
    win, win.document, win.customElements, win.HTMLElement, win.CSSStyleSheet,
  )
}

describe('mjs_router.ts — instCache borné en LRU (hibernation sans borne)', function () {
  it('instCache est bien une µ.LRUCache (pas une Map nue) après le 1er _mjs_injectView', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    const document = win.document

    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'slot1'
    comp._shadow = comp // simplifie : querySelector direct sur comp
    comp.appendChild(view)

    µ.Router._mjs_injectView(comp, 'slot1', 'page-a', '/a')
    const instCache = µ.Router.cache.get(comp)
    assert.ok(instCache instanceof µ.LRUCache, 'AVANT le fix : new Map() nue, jamais bornée')
    assert.equal(instCache.maxSize, 10, 'même borne que pageCache (10)')

    win.close?.()
  })

  it('12 composants routés DISTINCTS dans le même slot : le cache reste plafonné à 10 (pas 12)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    const document = win.document

    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'slot1'
    comp._shadow = comp
    comp.appendChild(view)

    for (let i = 0; i < 12; i++) {
      µ.Router._mjs_injectView(comp, 'slot1', `page-${i}`, `/p${i}`)
    }
    const instCache = µ.Router.cache.get(comp)
    assert.equal(instCache.size, 10,
      'AVANT le fix : 12 entrées accumulées à vie (un arbre DOM complet par page jamais visitée deux fois)')

    win.close?.()
  })

  it("l'éviction déclenche bien µ._mjs_destroyEvictedTree sur l'élément hiberné sorti du cache", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    const document = win.document

    const destroyed: any[] = []
    const realDestroy = µ._mjs_destroyEvictedTree
    µ._mjs_destroyEvictedTree = (el: any) => { destroyed.push(el); return realDestroy(el); }

    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'slot1'
    comp._shadow = comp
    comp.appendChild(view)

    for (let i = 0; i < 11; i++) {
      µ.Router._mjs_injectView(comp, 'slot1', `page-${i}`, `/p${i}`)
    }
    assert.equal(destroyed.length, 1,
      "AVANT le fix : Map nue, aucun onEvict, aucun teardown jamais relancé pour les vues abandonnées")
    assert.equal(destroyed[0].tagName.toLowerCase(), 'mjs-page-0', "la PREMIÈRE page injectée (la plus ancienne) doit être celle évincée")

    win.close?.()
  })

  it('cas nominal : re-visiter un composant DÉJÀ en cache le restaure (comportement inchangé, pas de régression)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    const document = win.document

    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'slot1'
    comp._shadow = comp
    comp.appendChild(view)

    µ.Router._mjs_injectView(comp, 'slot1', 'page-a', '/a')
    const firstEl = view.firstElementChild
    µ.Router._mjs_injectView(comp, 'slot1', 'page-b', '/b')
    µ.Router._mjs_injectView(comp, 'slot1', 'page-a', '/a-again')
    const restoredEl = view.firstElementChild

    assert.equal(restoredEl, firstEl, "la MÊME instance DOM doit être restaurée depuis le cache (pas recréée)")
    win.close?.()
  })
})
