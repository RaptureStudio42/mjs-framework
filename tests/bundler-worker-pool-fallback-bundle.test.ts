// Test de régression : `worker-pool.ts`
// `compileWorkerInMemory` codait en DUR `packages: 'external'`, y compris
// dans le cas de repli (`findCacheDir` ne trouve AUCUN `node_modules` ancêtre
// depuis `worker.ts`, écrit alors dans `os.tmpdir()/mjs-worker-cache/`).
// Avec `packages: 'external'`, les imports npm (`acorn`, `esbuild`, etc.)
// restent des `import` NON résolus dans le fichier de sortie — ils ne
// peuvent JAMAIS être résolus à l'exécution depuis `os.tmpdir()` (aucun
// node_modules accessible depuis là) → le worker CRASHE AU BOOT
// ("Cannot find module 'acorn'"). Le commentaire de `findCacheDir` promettait
// déjà d'embarquer les deps pour ce cas précis — jamais implémenté.
//
// Fix : `findCacheDir` renvoie maintenant `{ dir, bundleDeps }` ; `bundleDeps
// = true` (cas de repli) → `packages` est OMIS (PAS `'bundle'` — vérifié
// empiriquement que cette valeur n'existe pas dans l'esbuild installé,
// rejetée au runtime) — le comportement de bundling COMPLET par défaut
// d'esbuild (déjà `bundle: true`) embarque alors chaque dépendance
// directement dans le fichier de sortie, qui devient autonome.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import { _internal } from '../src/bundler/worker-pool.js'

const realWorkerTs = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bundler', 'worker.ts')
const workerPoolSrc = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'bundler', 'worker-pool.ts')

describe('worker-pool — findCacheDir : détection du cas de repli (bundleDeps)', function () {
  it('un path SOUS un node_modules réel → bundleDeps: false (deps résolues à `exécution)', () => {
    // Le vrai worker.ts du dépôt a bien un node_modules ancêtre (racine du repo).
    const { bundleDeps } = _internal.findCacheDir(realWorkerTs)
    assert.equal(bundleDeps, false)
  })

  it('un path SANS AUCUN node_modules ancêtre (répertoire temp isolé) → bundleDeps: true', () => {
    // mkdtempSync sous /tmp — aucun node_modules entre /tmp et la racine
    // filesystem (sauf environnement exotique, comme le reste du dépôt le
    // suppose déjà pour d'autres tests /tmp).
    const isolatedDir = mjsTmp('no-node-modules')
    const fakePath = join(isolatedDir, 'fake-worker.ts')
    const { dir, bundleDeps } = _internal.findCacheDir(fakePath)
    assert.equal(bundleDeps, true,
      "AVANT le fix : cette information n'existait même pas (findCacheDir renvoyait juste une string) — compileWorkerInMemory utilisait AVEUGLÉMENT packages:'external' peu importe ce cas")
    // DURCISSEMENT : le dossier de repli est
    // désormais isolé par UID (`mjs-worker-cache-<uid>`) pour éviter le hijack
    // sur tmpdir partagé — on vérifie le préfixe, pas l'égalité stricte.
    assert.ok(dir.startsWith(join(tmpdir(), 'mjs-worker-cache')),
      `le repli doit rester sous tmpdir/mjs-worker-cache*. got: ${dir}`)
  })
})

describe('worker-pool — compilation du worker réel : packages:undefined (repli) produit un bundle AUTONOME', function () {
  this.timeout(30000)

  it("packages:'external' (cas normal) laisse un import npm NON résolu dans la sortie", async () => {
    const result = await build({
      entryPoints: [realWorkerTs], bundle: true, platform: 'node', target: 'node20',
      format: 'esm', packages: 'external', write: false, logLevel: 'silent',
    })
    const code = result.outputFiles[0].text
    assert.match(code, /from *["']acorn["']/,
      "le mode 'external' (cas normal, node_modules accessible) doit laisser les imports npm tels quels")
  })

  it("packages OMIS (fix du cas de repli) embarque les deps npm — sortie autonome, chargeable depuis N'IMPORTE OÙ", async () => {
    const result = await build({
      entryPoints: [realWorkerTs], bundle: true, platform: 'node', target: 'node20',
      format: 'esm', write: false, logLevel: 'silent',
      // `packages` omis : exactement ce que compileWorkerInMemory fait
      // maintenant pour `bundleDeps: true` (cf. `packages: bundleDeps ?
      // undefined : 'external'`).
    })
    const code = result.outputFiles[0].text
    assert.doesNotMatch(code, /from *["']acorn["']/,
      "AVANT le fix : le repli utilisait AUSSI packages:'external' → cet import serait resté non résolu, crash au boot une fois chargé hors node_modules")
    assert.ok(code.length > 500_000,
      `la sortie doit être un bundle self-contained volumineux (acorn/esbuild embarqués), pas juste le code MJS. taille: ${code.length}`)
  })

  it("compileWorkerInMemory() réel (cache reset) compile toujours SANS ERREUR le worker normal (non-régression)", async () => {
    _internal.resetCompileCache()
    const outPath = await _internal.compileWorkerInMemory(realWorkerTs)
    assert.ok(outPath.endsWith('.mjs'))
  })

  // Vérification structurelle complémentaire : les 2 tests empiriques
  // ci-dessus prouvent que `packages:'external'` vs OMIS se comportent
  // différemment comme attendu, et le test `findCacheDir` prouve que
  // `bundleDeps` est correctement détecté — mais construire un SEUL test
  // qui exerce `compileWorkerInMemory` À LA FOIS avec `bundleDeps: true` ET
  // une dépendance npm réellement résolvable est CONTRADICTOIRE (si le
  // point d'entrée n'a AUCUN node_modules ancêtre, esbuild ne peut de toute
  // façon PAS résoudre `acorn` depuis là, quel que soit `packages` — la
  // panne serait la même AVANT et APRÈS ce fix, testable seulement pour la
  // configuration NORMALE ci-dessus). Cette vérification de source ferme la
  // boucle : confirme que le branchement RÉEL dans compileWorkerInMemory
  // utilise bien `bundleDeps` pour choisir entre `undefined` et `'external'`.
  it('compileWorkerInMemory (source) branche bien `packages` sur `bundleDeps` — pas un `external` figé', () => {
    const src = readFileSync(workerPoolSrc, 'utf-8')
    assert.match(src, /packages:\s*bundleDeps\s*\?\s*undefined\s*:\s*'external'/,
      "AVANT le fix : `packages: 'external'` était codé en dur, ignorant complètement bundleDeps/le cas de repli")
  })
})
