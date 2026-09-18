// Test de régression — `topoSortFiles`
// (renderToString.ts, SSR) triait les fichiers compilés par dépendance
// d'import, mais un CYCLE (A importe B qui importe A, directement ou via une
// chaîne) n'a AUCUN ordre topologique valide. L'ancien code retombait
// silencieusement sur "l'ordre d'origine" pour le reste d'un cycle — mais
// chaque fichier destructure ENTIÈREMENT ses imports en TÊTE de sa propre IIFE
// (`const { fn } = _mjsF_B`), et `_mjsF_B` est un `const` NON hissé (TDZ) tant
// que l'IIFE de B n'a pas terminé — l'ordre "d'origine" pour un cycle plante
// donc À COUP SÛR à l'éval avec `ReferenceError: Cannot access '_mjsF_x'
// before initialization`, une erreur cryptique sans aucun rapport évident
// avec sa cause (contrairement au bundle CLIENT, qui supporte ce cas via les
// liaisons ESM natives/live). Fix : détecter le reste non-ordonnable et lever
// une erreur EXPLICITE nommant les fichiers concernés.
//
// Note méthode — pourquoi un test UNITAIRE plutôt qu'une reproduction bout-en-
// bout (vrai cycle entre 2 fichiers `.module.civet` réellement compilés) :
// en creusant la reproduction réaliste, découverte de DEUX limitations
// PRÉEXISTANTES, SÉPARÉES et HORS PÉRIMÈTRE de ce fix précis (documentées,
// puis LEVÉES séparément — cf. tests/module-civet-imports.test.ts) :
//   1. LEVÉE — `@import` À L'INTÉRIEUR d'un `.module.civet` n'était PAS
//      reconnu comme directive (Civet le parsait littéralement comme
//      `this.import(...)`, un appel de méthode absurde). `_compileScriptModuleInner`
//      (bundler/index.ts) passe désormais le source par `extractDirectives`,
//      exactement comme un composant `.mjs` — même canal, mêmes imports
//      résolus vers le nom haché via `resolveMagicAssets`.
//   2. LEVÉE (par REJET explicite, pas par réécriture) — un
//      `import {x} from './y.module.civet'` NATIF (pas `@import`) DANS un
//      `.module.civet` compilait tel quel, mais son PATH n'était PAS réécrit
//      vers le fichier compilé/haché correspondant → `x` undefined en prod,
//      silencieusement, même sans aucune circularité. Décision de design :
//      pas de réécriture des imports natifs — `lintNoRawImport` les rejette
//      désormais à la compilation (même garde que `<script module>` d'un
//      `.mjs`), avec un message qui oriente vers `@import nom 'chemin'`. Un
//      seul canal d'import partout.
//
// Un cycle "propre" (imports résolus normalement, juste circulaires) reste
// NON constructible aujourd'hui avec des fichiers RÉELS, MÊME maintenant que
// `@import` fonctionne dans un module : `compileWithDedup` (bundler/index.ts)
// fait échouer TOUT cycle `.civet`↔`.civet` AU MOMENT DU BUILD (détection de
// chaîne directe, ou filet de sécurité par timeout pour 2 fichiers chacun
// top-level — cf. tests/bundler-compile-dedup-cycle.test.ts) : un build
// cyclique ne peut donc JAMAIS aboutir jusqu'au SSR avec des imports résolus
// normalement. `tests/module-civet-imports.test.ts` le vérifie explicitement
// (« cycle A↔B via @import → erreur propre, pas de blocage ») — pas de
// nouveau test topoSortFiles bout-en-bout CYCLIQUE ajouté ici, ce cas précis
// reste donc structurellement hors d'atteinte. On continue de tester la
// fonction EXPORTÉE directement, avec des fixtures qui répliquent EXACTEMENT
// la forme que `createSSRRenderer` lui passe réellement (ids + Map de deps +
// Map id→nom de fichier) — chaîne LINÉAIRE (non cyclique) réelle bout-en-bout
// couverte, elle, par `tests/module-civet-imports.test.ts` (chaîne
// .mjs → .civet → .civet en SSR).

import assert from 'node:assert/strict'
import { topoSortFiles } from '../src/server/renderToString.js'

describe('SSR renderToString — topoSortFiles détecte un cycle @import au lieu de planter en TDZ à l\'éval', function () {
  it('aucune dépendance : ordre d\'entrée préservé (pas de régression)', function () {
    const out = topoSortFiles(['A', 'B', 'C'], new Map(), new Map())
    assert.deepEqual(out, ['A', 'B', 'C'])
  })

  it('chaîne linéaire simple (A dépend de B) : B avant A', function () {
    const deps = new Map([['A', ['B']], ['B', []]])
    const out = topoSortFiles(['A', 'B'], deps, new Map())
    assert.deepEqual(out, ['B', 'A'])
  })

  it('cycle direct A↔B : lève une erreur nommant les DEUX fichiers', function () {
    const deps = new Map([['idA', ['idB']], ['idB', ['idA']]])
    const idToFile = new Map([['idA', 'a.module-hash1.js'], ['idB', 'b.module-hash2.js']])
    assert.throws(
      () => topoSortFiles(['idA', 'idB'], deps, idToFile),
      (e: any) => {
        assert.match(e.message, /@import circulaire/)
        assert.match(e.message, /a\.module-hash1\.js/, 'doit nommer le premier fichier du cycle')
        assert.match(e.message, /b\.module-hash2\.js/, 'doit nommer le second fichier du cycle')
        return true
      },
    )
  })

  it('cycle indirect A→B→C→A (3 fichiers) : lève une erreur nommant les TROIS', function () {
    const deps = new Map([['idA', ['idB']], ['idB', ['idC']], ['idC', ['idA']]])
    const idToFile = new Map([['idA', 'a.js'], ['idB', 'b.js'], ['idC', 'c.js']])
    assert.throws(
      () => topoSortFiles(['idA', 'idB', 'idC'], deps, idToFile),
      (e: any) => {
        assert.match(e.message, /a\.js/)
        assert.match(e.message, /b\.js/)
        assert.match(e.message, /c\.js/)
        return true
      },
    )
  })

  it('un fichier NON cyclique mais qui DÉPEND du cycle est aussi bloqué (transitivement impossible à ordonner)', function () {
    // D dépend de A, qui est lui-même pris dans le cycle A↔B — D ne peut PAS
    // non plus être placé (son indegree ne retombe jamais à 0).
    const deps = new Map([['idA', ['idB']], ['idB', ['idA']], ['idD', ['idA']]])
    const idToFile = new Map([['idA', 'a.js'], ['idB', 'b.js'], ['idD', 'd.js']])
    assert.throws(
      () => topoSortFiles(['idA', 'idB', 'idD'], deps, idToFile),
      /d\.js/,
      'D dépend transitivement du cycle : il doit être signalé lui aussi (impossible à ordonner en pratique)',
    )
  })

  it('un cycle EN DEHORS de cet ensemble de fichiers (dépendance externe, ex. runtime) est ignoré', function () {
    // 'ext' n'est PAS dans `ids` (ex. une dépendance vers le runtime mjs_*,
    // déjà placée ailleurs) — ne doit jamais être traité comme un cycle.
    const deps = new Map([['idA', ['ext']]])
    const out = topoSortFiles(['idA'], deps, new Map())
    assert.deepEqual(out, ['idA'])
  })
})
