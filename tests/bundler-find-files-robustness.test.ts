// Test de régression : `findFiles`
// (scan récursif de sourceDir) avait 3 angles morts :
//
//   1. Symlink CASSÉ (cible inexistante) : `statSync` (qui suit les
//      symlinks) throw ENOENT — une SEULE entrée pourrie faisait planter
//      TOUT le build.
//   2. Cycle de symlinks (dossier qui se référence lui-même) : sans suivi
//      des dossiers déjà visités, la recherche descend indéfiniment → le
//      build ne se termine jamais.
//   3. `node_modules` jamais exclu de la descente récursive.
//
// Fix : `realpathSync` détecte les cycles (dossiers déjà visités, résolus
// au réel) ; un `realpathSync`/`statSync` qui échoue ignore SEULEMENT cette
// entrée ; `node_modules` explicitement exclu.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — findFiles : robustesse symlinks + exclusion node_modules', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un symlink CASSÉ dans sourceDir ne fait PAS planter tout le build (reste des fichiers compilés normalement)', async function () {
    const { srcDir, outDir, manifest } = makeProject('findfiles-broken-symlink')
    writeFileSync(join(srcDir, 'ok.mjs'), '<p>ok</p>')
    // Symlink vers une cible qui n'existe PAS.
    symlinkSync(join(srcDir, 'cible-inexistante.mjs'), join(srcDir, 'lien-casse.mjs'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0,
      `AVANT le fix : un symlink cassé faisait planter TOUT le build. errors:\n${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['ok'], "le fichier valide À CÔTÉ du lien cassé doit quand même être compilé")
    await bundler.close()
  })

  it('un CYCLE de symlinks dans sourceDir ne fait PAS boucler indéfiniment (le build se termine)', async function () {
    const { srcDir, outDir, manifest } = makeProject('findfiles-symlink-cycle')
    writeFileSync(join(srcDir, 'ok.mjs'), '<p>ok</p>')
    mkdirSync(join(srcDir, 'sub'), { recursive: true })
    // sub/loop -> srcDir (cycle : srcDir/sub/loop/sub/loop/... sans garde-fou explicite)
    symlinkSync(srcDir, join(srcDir, 'sub', 'loop'), 'dir')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['ok'], 'le build doit se terminer et compiler le fichier valide')
    // AVANT le fix (garde-fou explicite retiré) : le système d'exploitation
    // finit certes par bloquer la récursion (ELOOP/ENAMETOOLONG au bout de
    // quelques dizaines de sauts de symlink), MAIS pas assez tôt — `ok.mjs`
    // est vu PLUSIEURS FOIS sous des chemins textuellement différents
    // (`src/ok.mjs`, `src/sub/loop/ok.mjs`, `src/sub/loop/sub/loop/ok.mjs`…)
    // qui pointent tous vers le MÊME fichier réel → `checkAndClaim` les
    // traite comme des collisions de basename entre "fichiers différents"
    // et émet un faux warning, pour un projet qui n'a pourtant qu'UN SEUL
    // fichier `ok.mjs`.
    assert.ok(!stats.warnings.some(w => /Collision de basename/.test(w)),
      `AVANT le fix : le même fichier vu plusieurs fois via le cycle de symlinks déclenchait un faux warning de collision. warnings:\n${stats.warnings.join('\n')}`)
    await bundler.close()
  })

  it("un dossier node_modules dans sourceDir n'est PAS scanné (pas de faux composants issus d'une dépendance)", async function () {
    const { srcDir, outDir, manifest } = makeProject('findfiles-node-modules')
    writeFileSync(join(srcDir, 'ok.mjs'), '<p>ok</p>')
    const nm = join(srcDir, 'node_modules', 'une-dep')
    mkdirSync(nm, { recursive: true })
    writeFileSync(join(nm, 'interne.mjs'), '<p>ne doit jamais être vu</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    assert.ok(stats.manifest['ok'])
    assert.equal(stats.manifest['interne'], undefined,
      "AVANT le fix : node_modules était scanné comme n'importe quel autre dossier — un .mjs interne à une dépendance pouvait se retrouver dans le manifest")
    await bundler.close()
  })
})
