// tests/mjs-theme-runtime.test.ts — µtheme : clé CACHÉE __mjsTheme du store $$ (même
// mécanique que __mjsLang, mjs_i18n.ts), boot attr-prioritaire > OS > défaut clair, suivi OS
// coupé à la 1re écriture applicative, validation stricte 'light'/'dark', dataset.mjsTheme =
// canal CSS répercuté. Chargement LÉGER (pas de Bundler/compile — mêmes fichiers runtime évalués
// tels quels, cf. tests/mjs-modal-notify.test.ts) : mjs_init.ts (µ, µ.config) + mjs_theme.ts
// (µ._mjs_themeSheet, détaché de mjs_init.ts) + mjs_runes.ts (µ.state, requis par µ.nav/µ.res de
// mjs_store_globals.ts) + mjs_store_globals.ts (µ.store, boot __mjsTheme). Le sucre compilateur
// µtheme → µ.store.__mjsTheme est hors périmètre ici : accès à la clé EN CLAIR.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stripEsm(s: string): string {
  return s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
}

const INIT_SRC         = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const THEME_SRC         = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_theme.ts'), 'utf-8')
const RUNES_SRC         = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_runes.ts'), 'utf-8')
const STORE_GLOBALS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_store_globals.ts'), 'utf-8')

// mock CONTRÔLABLE de matchMedia('(prefers-color-scheme: dark)') — remplace l'implémentation
// happy-dom réelle (fonctionnelle mais non pilotable : pas de vrai OS derrière un navigateur
// headless, `.matches` reste figé à false).
function installMatchMediaMock(win: any, initialMatches: boolean) {
  let changeListener: ((e: any) => void) | null = null
  const mql = {
    matches: initialMatches,
    media: '(prefers-color-scheme: dark)',
    addEventListener: (type: string, cb: any) => { if (type === 'change') changeListener = cb },
    removeEventListener: (type: string, cb: any) => { if (type === 'change' && changeListener === cb) changeListener = null },
  }
  win.matchMedia = () => mql
  return {
    trigger(matches: boolean) { mql.matches = matches; if (changeListener) changeListener({ matches }) },
    hasListener: () => changeListener !== null,
  }
}

// charge le trio runtime dans une Window happy-dom FRAÎCHE — `beforeEval` permet de poser
// dataset.mjsTheme/matchMedia AVANT l'exécution du boot (module top-level, synchrone).
function loadTheme(beforeEval?: (win: any) => void): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  if (beforeEval) beforeEval(window)
  window.eval(`${INIT_SRC}\n${THEME_SRC}\n${RUNES_SRC}\n${STORE_GLOBALS_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

describe('mjs_store_globals — µtheme runtime', function () {
  it("boot ATTR-PRIORITAIRE : dataset.mjsTheme déjà 'dark' avant boot → adopté tel quel, AUCUN appel matchMedia", function () {
    let mqlCalls = 0
    const { document, µ } = loadTheme((win) => {
      win.document.documentElement.dataset.mjsTheme = 'dark'
      const real = win.matchMedia
      win.matchMedia = (q: string) => { mqlCalls++; return real(q) }
    })
    assert.equal(µ.store.__mjsTheme, 'dark', "l'attribut posé par la page prime")
    assert.equal(document.documentElement.dataset.mjsTheme, 'dark')
    assert.equal(mqlCalls, 0, "aucune détection OS quand l'attribut est déjà une valeur valide")
  })

  it("boot ATTR-PRIORITAIRE : dataset.mjsTheme déjà 'light' avant boot → adopté tel quel", function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    assert.equal(µ.store.__mjsTheme, 'light')
    assert.equal(document.documentElement.dataset.mjsTheme, 'light')
  })

  it("boot OS : pas d'attribut posé, OS = sombre (matchMedia mocké) → __mjsTheme = 'dark', dataset répercuté", function () {
    const { document, µ } = loadTheme((win) => { installMatchMediaMock(win, true) })
    assert.equal(µ.store.__mjsTheme, 'dark')
    assert.equal(document.documentElement.dataset.mjsTheme, 'dark', "l'attribut EST le canal CSS")
  })

  it("boot OS : pas d'attribut posé, OS = clair (matchMedia mocké) → __mjsTheme = 'light'", function () {
    const { µ } = loadTheme((win) => { installMatchMediaMock(win, false) })
    assert.equal(µ.store.__mjsTheme, 'light')
  })

  it('suivi OS actif après un boot par détection OS : un changement OS (mock "change") met à jour __mjsTheme + dataset', function () {
    let mock: any
    const { document, µ } = loadTheme((win) => { mock = installMatchMediaMock(win, false) })
    assert.equal(µ.store.__mjsTheme, 'light')
    assert.ok(mock.hasListener(), 'un listener "change" doit être posé après un boot par détection OS')
    mock.trigger(true)
    assert.equal(µ.store.__mjsTheme, 'dark', 'le changement OS doit être répercuté')
    assert.equal(document.documentElement.dataset.mjsTheme, 'dark')
  })

  it('suivi OS COUPÉ DÉFINITIVEMENT à la 1re écriture applicative — un changement OS ultérieur est ignoré', function () {
    let mock: any
    const { µ } = loadTheme((win) => { mock = installMatchMediaMock(win, false) })
    assert.equal(µ.store.__mjsTheme, 'light')
    µ.store.__mjsTheme = 'dark' // écriture APPLICATIVE (µtheme = … côté app compilée)
    assert.equal(µ.store.__mjsTheme, 'dark')
    assert.equal(mock.hasListener(), false, 'le listener OS doit être retiré à la 1re écriture app')
    mock.trigger(false) // simule un retour à un OS clair — ne doit PLUS rien changer
    assert.equal(µ.store.__mjsTheme, 'dark', "un changement OS après coupure n'a plus aucun effet")
  })

  it("SSR/happy-dom : matchMedia réel non pilotable (pas de vrai OS), aucun attribut posé → repli 'light', AUCUN throw", function () {
    assert.doesNotThrow(() => {
      const { µ } = loadTheme()
      assert.equal(µ.store.__mjsTheme, 'light')
    })
  })

  it("valeur invalide (µ.store.__mjsTheme = 'purple') : µ.warn appelé, valeur IGNORÉE (reste l'ancienne)", function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.store.__mjsTheme = 'purple'
    assert.equal(µ.store.__mjsTheme, 'light', 'valeur invalide ignorée — thème inchangé')
    assert.equal(document.documentElement.dataset.mjsTheme, 'light')
    assert.equal(warned.length, 1, 'µ.warn doit être appelé exactement une fois')
  })

  it("thème déclaré par l'app (µ._themes) : µtheme = 'purple' ACCEPTÉ si présent dans µ._themes, 'inconnu' toujours refusé", function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    µ._themes = ['purple', 'or']
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.store.__mjsTheme = 'purple'
    assert.equal(µ.store.__mjsTheme, 'purple', 'purple déclaré dans µ._themes — accepté')
    assert.equal(document.documentElement.dataset.mjsTheme, 'purple')
    assert.equal(warned.length, 0, 'aucun avertissement pour un thème déclaré')
    µ.store.__mjsTheme = 'inconnu'
    assert.equal(µ.store.__mjsTheme, 'purple', "'inconnu' n'est ni light/dark ni dans µ._themes — ignoré, thème inchangé")
    assert.equal(warned.length, 1, 'µ.warn appelé pour la valeur non déclarée')
  })

  it('clé __mjsTheme NON énumérable — absente de Object.keys(µ.store)/{for k in $$}', function () {
    const { µ } = loadTheme()
    assert.equal(Object.keys(µ.store).includes('__mjsTheme'), false)
    assert.equal(Object.prototype.propertyIsEnumerable.call(µ.store, '__mjsTheme'), false)
  })

  it('dataset.mjsTheme répercuté à CHAQUE mise à jour (boot puis écritures app) — miroir bidirectionnel simple', function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    assert.equal(document.documentElement.dataset.mjsTheme, 'light')
    µ.store.__mjsTheme = 'dark'
    assert.equal(document.documentElement.dataset.mjsTheme, 'dark')
    µ.store.__mjsTheme = 'light'
    assert.equal(document.documentElement.dataset.mjsTheme, 'light')
  })

  it('même valeur RÉÉCRITE (dark → dark) : reste une écriture applicative valide, coupe quand même le suivi OS', function () {
    let mock: any
    const { µ } = loadTheme((win) => { mock = installMatchMediaMock(win, true) })
    assert.equal(µ.store.__mjsTheme, 'dark', 'précondition : boot OS sombre')
    assert.ok(mock.hasListener())
    µ.store.__mjsTheme = 'dark' // même valeur que le boot — quand même une écriture APP explicite
    assert.equal(mock.hasListener(), false, "une réécriture de la MÊME valeur coupe aussi le suivi OS (c'est une décision app explicite)")
  })

  // Chemin RÉEL du compilateur : `µtheme = v` (path-tracker.ts) se réécrit en appel DIRECT
  // `µ._storeSet('__mjsTheme', v)`, PAS en `µ.store.__mjsTheme = v` (accesseur court-circuité). Les
  // 5 cas ci-dessous passent PAR CE CHEMIN, jamais par l'accesseur — c'est le trou que ce correctif comble.

  it("chemin COMPILÉ µ._storeSet('__mjsTheme', 'purple') : µ.warn appelé, valeur du store INCHANGÉE, attribut inchangé", function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ._storeSet('__mjsTheme', 'purple')
    assert.equal(µ.store.__mjsTheme, 'light', 'valeur invalide ignorée — thème inchangé')
    assert.equal(document.documentElement.dataset.mjsTheme, 'light')
    assert.equal(warned.length, 1, 'µ.warn doit être appelé exactement une fois')
  })

  it("chemin COMPILÉ µ._storeSet('__mjsTheme', 'dark') : écriture applicative valide — un événement OS postérieur n'a plus aucun effet", function () {
    let mock: any
    const { µ } = loadTheme((win) => { mock = installMatchMediaMock(win, false) })
    assert.equal(µ.store.__mjsTheme, 'light')
    µ._storeSet('__mjsTheme', 'dark') // émis par le compilateur pour `µtheme = 'dark'`
    assert.equal(µ.store.__mjsTheme, 'dark')
    assert.equal(mock.hasListener(), false, 'le listener OS doit être retiré après une écriture compilée')
    mock.trigger(false) // retour OS clair simulé — ne doit plus rien changer
    assert.equal(µ.store.__mjsTheme, 'dark', "un changement OS après coupure n'a plus aucun effet")
  })

  it("chemin COMPILÉ µ._storeSet('__mjsTheme', même valeur) : coupe quand même le suivi (le court-circuit valeur-identique du store ne doit pas empêcher la coupure)", function () {
    let mock: any
    const { µ } = loadTheme((win) => { mock = installMatchMediaMock(win, true) })
    assert.equal(µ.store.__mjsTheme, 'dark', 'précondition : boot OS sombre')
    assert.ok(mock.hasListener())
    µ._storeSet('__mjsTheme', 'dark') // même valeur que le boot, chemin compilé
    assert.equal(mock.hasListener(), false, "coupure malgré le court-circuit valeur-identique de _storeSet")
  })

  it('écritures INTERNES (boot + listener OS, mêmes appels µ._storeSet) ne coupent JAMAIS le suivi — 2 changements OS consécutifs restent tous deux répercutés', function () {
    let mock: any
    const { µ } = loadTheme((win) => { mock = installMatchMediaMock(win, false) })
    assert.equal(µ.store.__mjsTheme, 'light')
    assert.ok(mock.hasListener(), 'listener actif après le boot — une écriture interne ne coupe pas son propre suivi')
    mock.trigger(true) // 1er changement OS, écriture INTERNE (listener)
    assert.equal(µ.store.__mjsTheme, 'dark')
    assert.ok(mock.hasListener(), "le suivi reste actif après un changement OS — ce n'est pas une écriture applicative")
    mock.trigger(false) // 2e changement OS, toujours interne, toujours répercuté
    assert.equal(µ.store.__mjsTheme, 'light')
    assert.ok(mock.hasListener(), 'toujours actif après un 2e changement OS')
  })

  it('miroir data-mjs-theme fonctionne pour les 3 voies : boot, µ._storeSet direct (chemin compilé), µ.store.__mjsTheme = … (externe)', function () {
    const { document, µ } = loadTheme((win) => { win.document.documentElement.dataset.mjsTheme = 'light' })
    assert.equal(document.documentElement.dataset.mjsTheme, 'light', 'voie 1 : boot')
    µ._storeSet('__mjsTheme', 'dark')
    assert.equal(document.documentElement.dataset.mjsTheme, 'dark', 'voie 2 : µ._storeSet direct (chemin compilé)')
    µ.store.__mjsTheme = 'light'
    assert.equal(document.documentElement.dataset.mjsTheme, 'light', 'voie 3 : accesseur externe µ.store.x = …')
  })
})

// La feuille ADOPTÉE (document.adoptedStyleSheets) l'emporte sur un <style>/<link> ordinaire
// du document à spécificité égale : ses 2 sélecteurs sont enveloppés de :where() (spécificité
// nulle) pour que le CSS applicatif (:root{…}, html{…}, une classe…) gagne toujours ; le jeu
// sombre reste prioritaire sur le clair par l'ORDRE (déclaré après, dans la même feuille).
describe('mjs_init — µ._mjs_themeSheet : spécificité neutralisée par :where()', function () {
  it('les 2 règles (clair, sombre) sont des sélecteurs :where(...) de spécificité nulle, ordre clair→sombre conservé, 8 variables de thème chacune', function () {
    const { µ } = loadTheme()
    const rules = µ._mjs_themeSheet.cssRules
    assert.equal(rules.length, 2, 'exactement 2 règles dans la feuille de thème')
    for (const rule of rules) assert.ok(rule.selectorText.startsWith(':where('), `sélecteur neutralisé attendu, reçu ${rule.selectorText}`)
    assert.equal(rules[0].selectorText, ":where(:root),:where([data-mjs-theme='light']),:where([theme='light'])", 'jeu clair — spécificité nulle, :root gardé (défaut sans attribut) + 2 sélecteurs d\'imbrication')
    assert.equal(rules[1].selectorText, ":where([data-mjs-theme='dark']),:where([theme='dark'])", 'jeu sombre — spécificité nulle, :root retiré (imbrication), déclaré après le clair (départage par ordre)')
    const THEME_VARS = ['--mjs-surface', '--mjs-fg', '--mjs-fg-muted', '--mjs-border', '--mjs-hover', '--mjs-selected', '--mjs-accent', '--mjs-shadow']
    for (const rule of rules) {
      assert.equal(rule.style.length, THEME_VARS.length, `8 variables de thème attendues dans ${rule.selectorText}`)
      for (const themeVar of THEME_VARS) assert.notEqual(rule.style.getPropertyValue(themeVar), '', `variable ${themeVar} manquante dans ${rule.selectorText}`)
    }
  })
})
