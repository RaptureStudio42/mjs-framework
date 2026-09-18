// Test de régression : preload 'on' était rejeté par la config (corrigé) mais une asymétrie de
// vocabulaire laissait µ.preload runtime forgé à 'on' inerte.
//
// `_mjs_normPreload` était appliqué au niveau ATTRIBUT (`<a @preload="on">`) et
// au niveau DIRECTIVE de module (`@preload on` en tête de fichier), mais PAS
// au niveau CONFIG (`µ.preload`, l'objet exposé au runtime par le bundler
// depuis `mjs.config.json`). `µ.preload` reste un objet JS ordinaire,
// réassignable À LA MAIN par du code applicatif, sans repasser par le
// validateur du bundler : un tel réglage forgé restait TEL QUEL, sans
// normalisation → inerte si le mot forgé ne matchait aucun comparateur.
//
// Fix : même normalisation appliquée aux 3 niveaux dans `_mjs_effectivePreload`
// ET `_mjs_maybeScanEager`, sans exception.
//
// `on` EST le nom canonique (`eager`
// disparaît de `mjs.config.json`, VALID_PRELOAD_MODES = off/hover/on) :
// `_mjs_normPreload` normalise désormais `eager` → `on` (inversion du sens
// d'origine de cette fonction), alias TOLÉRÉ pour tout attribut déjà compilé
// ou tout `µ.preload` forgé à la main qui porterait encore l'ancien mot — le
// compilateur continue d'accepter les deux orthographes au niveau directive/
// attribut, la config seule devient stricte.
//
// mjs_ujs.ts attache des listeners PERMANENTS dès l'import (convention déjà
// établie, cf. ujs-pagecache-race-poisoning.test.ts) : jamais d'exécution
// réelle du fichier entier. On extrait les fonctions RÉELLES concernées
// depuis le code source (pas une réimplémentation à la main) et on les
// exécute isolément.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// Extrait `µ.<name> = function(...) { ... };` par marqueurs (nom SANS le préfixe `_`, les
// cibles ici sont toutes des `µ._<name>`, cf. tests/helpers/extract-marked.ts).
function extractAssignedFunction(src: string, name: string): string {
  return extractMarked(src, name)
}

function loadPreloadFns(): any {
  const µ: any = {}
  const body = [
    extractAssignedFunction(UJS_SRC, '_mjs_normPreload'),
    extractAssignedFunction(UJS_SRC, '_mjs_effectivePreload'),
    extractAssignedFunction(UJS_SRC, '_mjs_maybeScanEager'),
    extractAssignedFunction(UJS_SRC, '_mjs_scanEager'),
    extractAssignedFunction(UJS_SRC, '_mjs_isPreloadableLink'),
    extractAssignedFunction(UJS_SRC, '_mjs_preloadLink'),
  ].join('\n')
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('µ', body)(µ)
  µ._mjs_preloaded = new Set()
  µ._mjs_preloadCache = new Map()
  µ._isServer = false
  return µ
}

describe('mjs_ujs.ts — préchargement : vocabulaire "on" cohérent aux 3 niveaux', () => {
  it("µ.preload forgé avec 'on' (cas normal, canonique) continue de fonctionner (pas de régression)", () => {
    const µ = loadPreloadFns()
    µ.preload = { view: 'on', page: 'off' }
    const link: any = { getAttribute: () => null, getRootNode: () => null }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'on')
  })

  it("µ.preload FORGÉ À LA MAIN avec 'eager' (refusé par mjs.config.json, mais réassignable en JS pur) : _mjs_effectivePreload le normalise en 'on'", () => {
    const µ = loadPreloadFns()
    µ.preload = { view: 'eager', page: 'off' } // jamais possible via mjs.config.json (rejeté), mais possible en JS pur
    const link: any = { getAttribute: () => null, getRootNode: () => null }
    const mode = µ._mjs_effectivePreload(link, 'view')
    assert.equal(mode, 'on',
      "sans la normalisation : renverrait 'eager' tel quel — ne matcherait plus aucun comparateur de _mjs_preloadLink (alignés sur 'on'), totalement inerte")
  })

  it("_mjs_maybeScanEager reconnaît µ.preload = { view: 'on' } ET { view: 'eager' } (alias toléré, cohérence avec _mjs_effectivePreload)", () => {
    // _mjs_maybeScanEager programme le scan via requestAnimationFrame si dispo,
    // sinon direct. Isolation EXPLICITE (pas une supposition d'ambiance) :
    // un AUTRE fichier de test (happy-dom) peut avoir laissé
    // `globalThis.requestAnimationFrame` défini avant celui-ci dans la même
    // suite complète — sans ce contrôle explicite, l'assertion synchrone
    // ci-dessous devient orderdépendante (flaky selon l'ordre des fichiers).
    const savedRaf = (globalThis as any).requestAnimationFrame
    delete (globalThis as any).requestAnimationFrame
    try {
      for (const mode of ['on', 'eager']) {
        const µ = loadPreloadFns()
        µ.preload = { view: mode }
        let scanned = false
        µ._mjs_scanEager = () => { scanned = true }
        const host: any = { _shadow: {} }
        µ._mjs_maybeScanEager(host)
        assert.equal(scanned, true, `cfg.view === '${mode}' doit déclencher le scan eager`)
      }
    } finally {
      if (savedRaf === undefined) delete (globalThis as any).requestAnimationFrame
      else (globalThis as any).requestAnimationFrame = savedRaf
    }
  })

  it("host._mjs_preload = 'on' (directive de module, DÉJÀ géré avant ce fix) continue de fonctionner (non-régression)", () => {
    const µ = loadPreloadFns()
    const link: any = { getAttribute: () => null, getRootNode: () => ({ host: { _mjs_preload: 'on' } }) }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'on')
  })

  it("host._mjs_preload = 'eager' (module compilé avec l'ancien mot) normalisé en 'on'", () => {
    const µ = loadPreloadFns()
    const link: any = { getAttribute: () => null, getRootNode: () => ({ host: { _mjs_preload: 'eager' } }) }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'on')
  })

  it("attribut @preload=\"on\" sur le lien lui-même (DÉJÀ géré avant ce fix) continue de fonctionner (non-régression)", () => {
    const µ = loadPreloadFns()
    const link: any = { getAttribute: (k: string) => k === 'data-mjs-preload' ? 'on' : null }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'on')
  })

  it("attribut @preload=\"eager\" sur le lien (ancien mot déjà compilé) normalisé en 'on'", () => {
    const µ = loadPreloadFns()
    const link: any = { getAttribute: (k: string) => k === 'data-mjs-preload' ? 'eager' : null }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'on')
  })

  it("aucune config nulle part : reste 'off' (comportement par défaut inchangé)", () => {
    const µ = loadPreloadFns()
    const link: any = { getAttribute: () => null, getRootNode: () => null }
    assert.equal(µ._mjs_effectivePreload(link, 'view'), 'off')
  })
})
