// Test de régression — `{if}` re-activate + `{for}` avec items animés.
// Cas vécu sur le tuto transitions-globales (validé via playwright en
// repro manuel, voir /tmp/repro-full.mjs).
//
// Bug enchaîné :
//   1. `_mjs_reconcileList` LIS path appelait `updateFn` (incl. bindingTransition)
//      pendant que les nodes étaient encore dans un fragment temporaire
//      `__frag`, pas dans le parent réel → isConnected=false dans le binding.
//   2. Le fast path `allStays` (keys old/new identiques) skipait toute
//      insertion DOM. Mais quand les entries DEAD étaient invalidées (fresh
//      nodes recréés pour les mêmes keys), `allStays` voyait `oldKeys===newKeys`
//      et croyait à tort que les nodes étaient déjà en place → fresh nodes
//      JAMAIS attachés au DOM → `getComputedStyle` strings vides → kf à 0 →
//      animation invisible.
//
// Correctifs couverts ici (test structural sur le source) :
//   1. Le LIS path doit appliquer updateFn APRÈS l'insertion (Pass 2 séparée).
//   2. `__invalidatedIdx` track les keys re-créées (cache.delete + fresh).
//   3. `allStays` est désactivé si invalidations.
//   4. `oldPosArr` force -1 pour les invalidations → LIS les insère.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
// `_mjs_reconcileList` a quitté mjs_element.ts pour mjs_for.ts (détachement du bloc `{for}`,
// embarqué seulement si le projet en écrit) : le test structural suit la méthode.
const forSrc = readFileSync(join(here, '..', 'src', 'runtime', 'mjs_for.ts'), 'utf-8')

describe('runtime — _mjs_reconcileList ré-attache les fresh nodes après outro complète', function () {
  it('track les invalidations DEAD via __invalidatedIdx', function () {
    assert.match(forSrc, /const\s+__invalidatedIdx\s*=\s*new\s+Set\s*\(\s*\)/,
      "déclaration de __invalidatedIdx attendue dans _mjs_reconcileList")
    // Doit être add()-é à l'endroit où une entry DEAD est purgée. Le tracking
    // doit suivre immédiatement `cache.delete(key)` qui invalide l'entry.
    assert.match(forSrc,
      /cache\.delete\s*\(\s*key\s*\)\s*;[\s\S]{0,200}?__invalidatedIdx\.add\s*\(\s*__loopIdx\s*\)/,
      "__invalidatedIdx.add(__loopIdx) doit suivre cache.delete(key) dans la branche DEAD")
  })

  it('désactive le fast path allStays quand des invalidations sont présentes', function () {
    assert.match(forSrc,
      /let\s+allStays\s*=\s*__invalidatedIdx\.size\s*===\s*0\s*&&/,
      "allStays doit checker __invalidatedIdx.size === 0 en premier")
  })

  it('LIS path force oldPosArr[i] = -1 pour les invalidations', function () {
    assert.match(forSrc,
      /oldPosArr\s*=\s*newEntries\.map\(\s*\(\s*e\s*,\s*__mi\s*\)\s*=>\s*\{[\s\S]{0,300}?__invalidatedIdx\.has\s*\(\s*__mi\s*\)/,
      "oldPosArr.map doit retourner -1 pour les entries dans __invalidatedIdx")
  })

  it('LIS path : updateFn appelé APRÈS insertion (Pass 2 séparée)', function () {
    // Marqueurs des 2 passes documentés dans les commentaires + structure.
    assert.match(forSrc, /PASS 1 — placement DOM/, "marqueur PASS 1 attendu")
    assert.match(forSrc, /PASS 2 — bindings/, "marqueur PASS 2 attendu")
    // Vérifier l'ordre : PASS 1 avant PASS 2 dans le source.
    const p1 = forSrc.indexOf('PASS 1 — placement DOM')
    const p2 = forSrc.indexOf('PASS 2 — bindings')
    assert.ok(p1 > 0 && p2 > p1, "PASS 1 doit précéder PASS 2 dans le source")
    // Dans la fenêtre PASS 1 → PASS 2, aucun appel updateFn ne doit traîner.
    const pass1Window = forSrc.slice(p1, p2)
    assert.doesNotMatch(pass1Window, /entry\._mjs_updFn\s*\(|updateFn\s*\(/,
      "PASS 1 ne doit PAS contenir d'appel updateFn — sinon les bindings tirent sur fragment temporaire")
  })
})
