// Test de régression — 2 défauts liés
// sur `watch()` :
//
//   1. `stylesheetsDir` (styles partagés @css) et les deps du manifest
//      externe (`#= require`, souvent HORS sourceDir) n'étaient JAMAIS
//      surveillés — les éditer ne déclenchait AUCUNE recompilation.
//   2. Le CALLER (cli.ts) faisait `await bundler.compile()` (build initial)
//      PUIS SEULEMENT `await bundler.watch()` : fenêtre entre les deux où
//      AUCUN watcher n'existe encore. Un fichier modifié PENDANT le build
//      initial (réaliste sur un gros projet, où ce build peut prendre
//      plusieurs secondes) ne déclenchait alors aucune recompilation,
//      silencieusement, jusqu'à une PROCHAINE édition.
//
// Fix : (1) `stylesheetsDir` ajouté aux chemins surveillés ; les deps du
// manifest externe (`externalManifestDeps`, calculées à chaque compile) sont
// ajoutées dynamiquement au watcher après coup. (2) `watch()` effectue
// lui-même le build initial, en PREMIER (watcher déjà armé), via LA MÊME
// file `inFlight` que les recompiles — un changement survenant PENDANT le
// build initial est mis en attente (pas perdu).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

function waitForEvent(events: string[], predicate: (e: string) => boolean, timeoutMs: number): Promise<void> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const check = () => {
      if (events.some(predicate)) return resolve()
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout après ${timeoutMs}ms, events reçus: ${JSON.stringify(events)}`))
      setTimeout(check, 30)
    }
    check()
  })
}

describe('bundler — watch() : couverture stylesheetsDir + pas de fenêtre de perte au build initial', function () {
  this.timeout(30000) // fs.watch/chokidar peut être lent sous forte charge (suite complète)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('éditer un style partagé (stylesheetsDir) déclenche une recompilation (AVANT : non surveillé)', async function () {
    const { srcDir, stylesDir, outDir, manifest } = makeProject('watch-styles')
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')
    writeFileSync(join(stylesDir, 'shared.scss'), '.a { color: red; }')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, stylesheetsDir: stylesDir })
    const events: string[] = []
    const watchDone = bundler.watch({ onRecompile: (p) => events.push(p) })
    await watchDone  // résout après le build initial (cf. fix)
    assert.ok(events.includes('<initial>'))

    writeFileSync(join(stylesDir, 'shared.scss'), '.a { color: blue; }')
    await waitForEvent(events, e => e.includes('shared.scss'), 15000)
  })

  it('éditer un fichier référencé par le manifest externe (#= require, hors sourceDir) déclenche une recompilation', async function () {
    const { root, srcDir, outDir, manifest } = makeProject('watch-external')
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')
    // Manifest externe HORS sourceDir, référençant un fichier lui aussi HORS
    // sourceDir via `#= require` — AVANT le fix, ni l'un ni l'autre n'était
    // surveillé.
    const manifestExternal = join(root, 'manifest.coffee')
    writeFileSync(join(root, 'util.coffee'), 'value = 1\n')
    writeFileSync(manifestExternal, '#= require util.coffee\n')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, manifestExternal })
    const events: string[] = []
    const watchDone = bundler.watch({ onRecompile: (p) => events.push(p) })
    await watchDone
    assert.ok(bundler.externalManifestDeps.size > 0, 'les deps du manifest externe doivent être trackées après le build initial')

    // `watcher.add(...)` (appelé dynamiquement après le build initial, cf.
    // fix) a besoin d'un court instant pour que chokidar termine son scan
    // du chemin nouvellement ajouté — contrairement à sourceDir/runtimeDir/
    // stylesheetsDir (passés dès la création du watcher, qui ont TOUTE la
    // durée du build initial pour être prêts).
    await new Promise(r => setTimeout(r, 300))
    writeFileSync(join(root, 'util.coffee'), 'value = 2\n')
    await waitForEvent(events, e => e.includes('util.coffee'), 15000)
  })

  it("le build initial n'ignore pas un changement survenant PENDANT lui-même (fenêtre de course fermée)", async function () {
    const { srcDir, outDir, manifest } = makeProject('watch-race')
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>v1</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    // Ralentit ARTIFICIELLEMENT le compile (build initial ET recompiles) pour
    // élargir la fenêtre de course de façon fiable, sans dépendre d'un
    // timing précis sur un vrai gros projet.
    const origCompile = bundler.compile.bind(bundler)
    bundler.compile = async () => {
      await new Promise(r => setTimeout(r, 400))
      return origCompile()
    }

    const events: string[] = []
    const watchDone = bundler.watch({ onRecompile: (p) => events.push(p) })
    // Édite un fichier PENDANT que le build initial (ralenti à 400ms) tourne
    // encore — AVANT le fix, le watcher n'existait pas encore à ce moment
    // (créé seulement APRÈS le build initial par le caller) : cet événement
    // aurait été purement et simplement perdu.
    setTimeout(() => writeFileSync(join(srcDir, 'comp.mjs'), '<p>v2</p>'), 60)

    await watchDone
    assert.ok(events.includes('<initial>'))
    await waitForEvent(events, e => e.includes('comp.mjs'), 15000)
  })
})
