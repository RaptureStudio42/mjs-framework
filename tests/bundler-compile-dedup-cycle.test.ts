// Test de régression — dédup des compiles concurrents + détection de cycle
// pour `compileMjs`/`compileScriptModule` (compileWithDedup).
//
// Deux bugs distincts corrigés ici :
//
//   1. COURSE — `compileMjs` (.mjs) n'avait AUCUNE dédup (contrairement à
//      `compileScriptModule`, qui en avait déjà une) : le scan principal ET
//      une résolution µasset()/@import imbriquée pouvaient compiler le MÊME
//      fichier chacun de leur côté → deux hashes pour le même fichier → le
//      second écrase le premier sur disque → référence pendante, 404 au
//      chargement, build vert.
//
//   2. CYCLE — une référence circulaire @import/µasset (A → B → A) sans
//      détection : récursion infinie pour `.mjs` (aucune dédup avant le
//      fix), ou interblocage SILENCIEUX pour `.civet`/`.coffee` (l'ancienne
//      dédup naïve renvoyait une promesse déjà en vol qui ne pouvait jamais
//      résoudre, puisqu'elle dépend transitivement d'elle-même).
//
// Fix : `AsyncLocalStorage` trace la chaîne de résolution en cours (chemin
// direct, détecté immédiatement, cf. 3ᵉ test) + un filet de sécurité par
// timeout pour le cas résiduel de 2 fichiers CHACUN indépendamment
// top-level qui se réfèrent mutuellement — chacun a sa PROPRE chaîne
// racine, invisible à l'autre (cf. commentaire détaillé sur
// `compileWithDedup` dans src/bundler/index.ts, et le 4ᵉ test ci-dessous).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — dédup + cycle des compiles concurrents (compileWithDedup)', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  // NOTE méthodo : `compileMjs`/`compileScriptModule` sont des méthodes
  // `async` — un appel à une fonction `async` produit TOUJOURS un NOUVEAU
  // objet Promise "externe" (sémantique JS standard), même quand le travail
  // RÉEL est déduppliqué en interne. Comparer `p1 === p2` par référence
  // teste donc le mauvais niveau et échoue TOUJOURS, fix ou pas. Le bon test
  // : instrumenter `_compileMjsInner`/`_compileScriptModuleInner` (le
  // travail RÉEL, derrière la dédup) et vérifier qu'il ne tourne qu'UNE
  // SEULE fois pour 2 appels concurrents sur le même fichier.

  it('compileMjs — deux appels concurrents pour le MÊME fichier ne déclenchent qu\'UN SEUL compile réel (dédup)', async function () {
    const { srcDir, outDir, manifest } = makeProject('dedup-mjs')
    const filePath = join(srcDir, 'solo.mjs')
    writeFileSync(filePath, '<p>hello</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    // Setup minimal normalement fait par compile() (runtime + outputDir) —
    // nécessaire pour appeler compileMjs() directement, hors pipeline complet.
    mkdirSync(outDir, { recursive: true })
    bundler.coreHashedPath = await bundler.bundleRuntime()

    let callCount = 0
    const original = (bundler as any)._compileMjsInner.bind(bundler)
    ;(bundler as any)._compileMjsInner = async (fp: string) => { callCount++; return original(fp) }

    // Évaluation de l'array AVANT Promise.all : les 2 appels démarrent
    // SYNCHRONEMENT l'un après l'autre (JS mono-thread) — le 2ᵉ trouve donc
    // à coup sûr le 1ᵉʳ déjà enregistré dans compileInFlight, sans race.
    const [hash1, hash2] = await Promise.all([bundler.compileMjs(filePath), bundler.compileMjs(filePath)])
    assert.equal(callCount, 1,
      "AVANT le fix : compileMjs n'avait AUCUNE dédup — chaque appel relançait un _compileMjsInner indépendant (2 compiles réels, 2 hashes possibles)")
    assert.equal(hash1, hash2)
    await bundler.close()
  })

  it('compileScriptModule — deux appels concurrents pour le MÊME fichier .civet ne déclenchent qu\'UN SEUL compile réel (dédup)', async function () {
    const { srcDir, outDir, manifest } = makeProject('dedup-civet')
    const filePath = join(srcDir, 'solo.civet')
    writeFileSync(filePath, 'value = 42\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    mkdirSync(outDir, { recursive: true })
    bundler.coreHashedPath = await bundler.bundleRuntime()

    let callCount = 0
    const original = (bundler as any)._compileScriptModuleInner.bind(bundler)
    ;(bundler as any)._compileScriptModuleInner = async (fp: string, ext: string) => { callCount++; return original(fp, ext) }

    const [hash1, hash2] = await Promise.all([
      bundler.compileScriptModule(filePath, '.civet'),
      bundler.compileScriptModule(filePath, '.civet'),
    ])
    assert.equal(callCount, 1, 'les deux appels concurrents ne doivent déclencher qu\'un seul compile réel (dédup préexistante, non régressée par le refactor partagé)')
    assert.equal(hash1, hash2)
    await bundler.close()
  })

  it("cycle .mjs → partial (_helper.mjs, référencé via µasset) → erreur explicite immédiate, pas de récursion infinie", async function () {
    const { srcDir, outDir, manifest } = makeProject('cycle-partial')
    // `_helper.mjs` (préfixe `_`) est un PARTIAL : exclu du scan top-level
    // (cf. bundler/index.ts, filtre `mjsFiles`) — seul `a.mjs` est compilé
    // par la boucle principale ; `_helper.mjs` n'est atteint QUE via la
    // résolution µasset() imbriquée. Isole le cas « cycle détectable dans
    // une SEULE chaîne de résolution » (le test suivant couvre l'autre cas,
    // non détectable par la chaîne seule).
    writeFileSync(join(srcDir, 'a.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('_helper.mjs')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))
    writeFileSync(join(srcDir, '_helper.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('a.mjs')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : récursion infinie (compileMjs sans dédup ni détection de cycle) → stack overflow ou hang, jamais une erreur propre')
    assert.match(
      stats.errors.map(e => e.message).join('\n'),
      /Cycle @import\/µasset détecté/,
      `un message de cycle explicite est attendu. errors:\n${stats.errors.map(e => e.message).join('\n')}`,
    )
    await bundler.close()
  })

  it('cycle entre 2 fichiers .civet TOUS DEUX top-level → filet de sécurité (timeout) déclenché, pas de hang éternel', async function () {
    const { srcDir, outDir, manifest } = makeProject('cycle-toplevel')
    // Contrairement au test précédent, ICI les deux fichiers sont
    // indépendamment top-level (aucun préfixe `_` : `.civet` n'a pas de
    // mécanisme de partial) : le scan principal lance compileScriptModule
    // pour CHACUN séparément, CHACUN avec sa PROPRE chaîne racine — la
    // détection par chaîne ne voit donc PAS ce cycle (elle ne regarde que
    // l'historique de la chaîne courante). Seul le filet de sécurité par
    // timeout de compileWithDedup le rattrape.
    writeFileSync(join(srcDir, 'a.civet'), "path = µasset('b.civet')\n")
    writeFileSync(join(srcDir, 'b.civet'), "path = µasset('a.civet')\n")

    // Timeout court pour garder le test rapide (défaut prod : 12000ms).
    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: outDir, manifestPath: manifest,
      dedupWaitTimeoutMs: 300,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix (filet de sécurité) : interblocage SILENCIEUX et ÉTERNEL — jamais une erreur, jamais une fin de build')
    assert.match(
      stats.errors.map(e => e.message).join('\n'),
      /bloquée depuis.*probable dépendance circulaire/,
      `un message de timeout/cycle est attendu. errors:\n${stats.errors.map(e => e.message).join('\n')}`,
    )
    await bundler.close()
  })

  it('deux fichiers top-level référencent tous deux un TROISIÈME fichier (non cyclique) → aucune erreur, dédup transparente', async function () {
    const { srcDir, outDir, manifest } = makeProject('dedup-shared')
    writeFileSync(join(srcDir, 'shared.civet'), 'value = 42\n')
    writeFileSync(join(srcDir, 'user1.civet'), "x = µasset('shared.civet')\n")
    writeFileSync(join(srcDir, 'user2.civet'), "y = µasset('shared.civet')\n")

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const sharedFiles = readdirSync(outDir).filter(f => /^shared-/.test(f))
    assert.equal(sharedFiles.length, 1,
      `un seul fichier compilé attendu pour 'shared.civet' — pas une copie par référence. trouvé: ${sharedFiles.join(', ')}`)
    await bundler.close()
  })
})
