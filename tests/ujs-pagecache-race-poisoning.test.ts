// Régression : le handler de clic de
// mjs_ujs.ts calculait `currentPath` (clé utilisée pour `pageCache.set` ET
// `_mjs_saveScroll`) via `window.location.pathname + window.location.search` —
// correct dans le cas nominal, mais FAUX lors d'un DOUBLE-CLIC rapide, avant
// que le fetch du 1er clic ne résolve.
//
// `window.history.pushState` (quelques lignes plus bas dans le handler) est
// SYNCHRONE : il déplace `window.location` vers la destination du clic
// IMMÉDIATEMENT, alors que le DOM affiché (`#app-root`) ne change QUE dans le
// callback ajax (asynchrone, pas encore résolu). Un 2e clic pendant cette
// fenêtre lit donc `window.location` = destination du 1er clic (déjà
// poussée), alors que le DOM affiché est ENCORE celui de la page de départ →
// `pageCache.set(destinationDu1erClic, rootDuPointDeDépart)` : le contenu de
// la page de DÉPART se retrouve caché sous la clé de la page INTERMÉDIAIRE
// jamais réellement affichée. Poison silencieux, révélé bien plus tard (un
// retour en arrière vers cette URL restaure le MAUVAIS contenu).
//
// Fix : `currentPath` lit désormais `µ._mjs_lastUjsPath` — qui, par construction
// (cf. commentaire voisin dans le fichier), n'est mis à jour QUE quand le
// contenu change RÉELLEMENT (succès du fetch), donc reflète toujours ce qui
// est VRAIMENT affiché, contrairement à `window.location` (mutable dès le
// clic, avant tout swap DOM réel).
//
// mjs_ujs.ts attache des listeners PERMANENTS à document/window dès l'import
// (click/submit/popstate/hashchange/pointerover) — l'importer réellement dans
// un test polluerait tout le process Mocha pour les autres fichiers (risque
// déjà rencontré 2× ce tour avec des globals partagés plus anodins). Suivant
// la convention déjà établie pour ce fichier (router-hashchange.test.ts,
// router-trailing-slash.test.ts : lecture de SOURCE, jamais d'exécution), on
// combine : (1) une vérification de source ciblée sur la ligne corrigée, et
// (2) un harnais isolé qui REJOUE fidèlement la logique exacte du handler
// (mêmes variables, même séquencement pushState→cache.set→fetch async) pour
// prouver le mécanisme de la course, sans importer le fichier réel.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

describe('mjs_ujs — pageCache : currentPath au clic ne doit PAS lire window.location', function () {
  it('vérification de source : currentPath est assigné depuis µ._mjs_lastUjsPath, pas window.location', function () {
    // Isole la ligne d'assignation de `currentPath` (précède `destPath =`,
    // qui la suit immédiatement dans le handler de clic "autre page").
    const m = UJS_SRC.match(/currentPath\s*=\s*([^;]+);\s*\n\s*destPath\s*=/)
    assert.ok(m, "assignation de currentPath introuvable juste avant destPath (structure du fichier a changé ?)")
    const rhs = m![1].trim()
    assert.equal(rhs, 'µ._mjs_lastUjsPath', `AVANT le fix : "${rhs}" lisait window.location — racy lors d'un double-clic`)
  })

  // Harnais isolé : réplique la séquence EXACTE du vrai handler (pushState
  // synchrone puis résolution asynchrone du fetch, avec le garde-fou _mjs_navSeq
  // existant), paramétré par la formule de currentPath à tester.
  function simulateClickHandler(currentPathFormula: 'window.location (buggy)' | 'µ._mjs_lastUjsPath (fix)') {
    const pageCache = new Map<string, string>()
    let windowLocationPath = '/a'
    let lastUjsPath = '/a'
    let displayedContent = 'CONTENT_A'
    let navSeq = 0

    function click(destPath: string, content: string) {
      const currentRootContent = displayedContent // DOM réellement affiché AU MOMENT du clic
      const currentPath = currentPathFormula === 'window.location (buggy)' ? windowLocationPath : lastUjsPath
      windowLocationPath = destPath // pushState — SYNCHRONE, avant toute résolution réseau
      const seq = ++navSeq
      pageCache.set(currentPath, currentRootContent) // ce que le handler réel fait AU CLIC
      return {
        // Résolution DIFFÉRÉE du fetch (callback ajax) — peut arriver APRÈS un clic suivant.
        resolveFetch() {
          if (seq !== navSeq) return // navigation plus récente déjà gagnante — callback jeté
          displayedContent = content
          lastUjsPath = destPath // mis à jour SEULEMENT ici, au succès réel — inchangé par ce fix
        },
      }
    }
    return { click, pageCache, displayed: () => displayedContent }
  }

  it('AVEC window.location (comportement avant fix) : un double-clic rapide EMPOISONNE le cache', function () {
    const sim = simulateClickHandler('window.location (buggy)')
    const fetchB = sim.click('/b', 'CONTENT_B') // clic 1 : A → B (fetch en vol)
    sim.click('/c', 'CONTENT_C')                // clic 2 AVANT que B ne résolve : "actuellement" /b → C

    // À cet instant, RIEN n'a résolu : le DOM affiché est toujours celui de A.
    assert.equal(sim.displayed(), 'CONTENT_A', "aucun fetch n'a encore résolu, A est toujours affiché")

    assert.equal(
      sim.pageCache.get('/b'), 'CONTENT_A',
      "BUG reproduit : le contenu de LA PAGE DE DÉPART (A) est AUSSI caché sous la clé de la destination du 1er clic (B), jamais réellement affichée — une entrée usurpée en plus de l'entrée légitime sous /a",
    )

    fetchB.resolveFetch() // arrive tard, jeté par le garde _mjs_navSeq — sans effet
    assert.equal(sim.displayed(), 'CONTENT_A', 'la réponse tardive de B est bien jetée (garde _mjs_navSeq déjà en place)')
  })

  it('AVEC µ._mjs_lastUjsPath (fix) : le même double-clic cache correctement sous la page VRAIMENT affichée', function () {
    const sim = simulateClickHandler('µ._mjs_lastUjsPath (fix)')
    const fetchB = sim.click('/b', 'CONTENT_B')
    sim.click('/c', 'CONTENT_C')

    assert.equal(sim.pageCache.get('/a'), 'CONTENT_A', 'le contenu de A est caché sous SA PROPRE clé /a')
    assert.equal(sim.pageCache.has('/b'), false, "'/b' n'a jamais été réellement affiché → pas d'entrée usurpée pour cette clé")

    fetchB.resolveFetch()
    assert.equal(sim.displayed(), 'CONTENT_A', 'réponse tardive de B toujours jetée (comportement _mjs_navSeq inchangé par ce fix)')
  })
})
