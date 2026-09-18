// Régression — 2 défauts liés
// (`locateRuntimeDir`/`bundleRuntime`) :
//
//   1. `locateRuntimeDir()` construisait ses chemins candidats via
//      `new URL(...).pathname` — qui renvoie le chemin PERCENT-ENCODÉ (un
//      espace devient `%20`, un accent `é` devient `%C3%A9`), PAS le chemin
//      filesystem décodé. Si ModularJS (ou son installation node_modules)
//      vit sous un chemin avec espace/accent (courant : "José Martínez",
//      "Program Files"), `existsSync(candidate)` testait une string bidon
//      qui ne correspond à AUCUN dossier réel → échouait TOUJOURS, même
//      quand le dossier existe vraiment.
//
//   2. Conséquence en cascade dans `bundleRuntime()` : un `runtimeDir` mal
//      résolu (ou une config `runtimeDir` explicite fausse) faisait sauter
//      CHAQUE fichier runtime attendu via un `continue` silencieux —
//      `mjs_core.js` s'écrivait VIDE, le build se terminait « avec succès »,
//      et l'app entière était mort-née au premier chargement (`µ` undefined
//      pour tout composant).
//
// Fix : (1) `fileURLToPath()` au lieu de `.pathname` (décode correctement).
// (2) `bundleRuntime()` throw désormais si le moindre fichier runtime
// attendu est absent — remonté dans `stats.errors`, plus de build vert.

import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject() {
  const root = mjsTmp('runtime-path')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('bundler — locateRuntimeDir() : fileURLToPath décode espace/accent (URL.pathname ne le fait pas)', () => {
  let accentRoot = ''                                                    //hors mjsTmp : le prefixe EST le sujet du test

  after(() => { try { rmSync(accentRoot, { recursive: true, force: true }) } catch { /* best-effort */ } })

  it("un dossier réel sous un chemin avec espace ET accent n'est trouvable QUE via fileURLToPath", () => {
    // Le nom du dossier temp lui-même contient un espace ET un accent —
    // reproduit fidèlement "José Martínez"/"Program Files".
    const root = accentRoot = mkdtempSync(join(tmpdir(), 'mjs runtime café-'))
    const runtimeDir = join(root, 'runtime')
    mkdirSync(runtimeDir, { recursive: true })
    writeFileSync(join(runtimeDir, 'probe.txt'), 'ok')

    const url = pathToFileURL(runtimeDir + '/')

    assert.equal(
      existsSync(url.pathname), false,
      "url.pathname reste PERCENT-ENCODÉ (%20/%C3%A9) — ne doit PAS correspondre à un chemin réel sur disque",
    )
    assert.equal(
      existsSync(fileURLToPath(url)), true,
      'AVANT le fix (locateRuntimeDir utilisait .pathname) : le dossier réel restait introuvable',
    )
  })
})

describe('bundler — bundleRuntime() : fichier runtime manquant devient une ERREUR de build', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('runtimeDir VIDE → stats.errors non vide (pas un mjs_core.js vide écrit en silence)', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    const emptyRuntimeDir = mjsTmp('empty-runtime')
    // Aucun fichier mjs_*.ts créé dedans : simule un runtimeDir mal résolu.

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: outDir, manifestPath: manifest,
      runtimeDir: emptyRuntimeDir,
    })
    const stats = await bundler.compile()

    assert.ok(
      stats.errors.length > 0,
      "AVANT le fix : un runtimeDir vide produisait un build VERT (0 erreur) avec mjs_core.js vide, app morte au premier chargement",
    )
    assert.match(stats.errors.map((e) => e.message).join('\n'), /Runtime introuvable/)
  })

  it('runtimeDir avec SEULEMENT quelques fichiers (partiel) → erreur aussi, pas juste un core incomplet silencieux', async function () {
    const { srcDir, outDir, manifest } = makeProject()
    const partialRuntimeDir = mjsTmp('partial-runtime')
    // Un SEUL fichier présent parmi la liste attendue.
    writeFileSync(join(partialRuntimeDir, 'mjs_init.ts'), '// stub')

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: outDir, manifestPath: manifest,
      runtimeDir: partialRuntimeDir,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'un runtime PARTIEL doit aussi être une erreur (pas seulement le cas 100% vide)')
    assert.match(stats.errors.map((e) => e.message).join('\n'), /Runtime introuvable/)
  })
})
