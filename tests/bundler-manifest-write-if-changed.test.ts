// Test de régression : `writeManifest()`
// écrivait INCONDITIONNELLEMENT à chaque compile, même si le contenu généré
// est BYTE-POUR-BYTE identique à ce qui est déjà sur disque. Sous `watch()`,
// si `manifestPath` est configuré SOUS `sourceDir` (par erreur, ou par
// nécessité selon l'hébergement), cette écriture-sans-changement touche
// quand même le fichier (nouveau mtime) → le watcher la détecte comme une
// modification → redéclenche compile() → réécrit le manifest à l'identique
// → boucle de recompilation infinie.
//
// Fix : lit le contenu existant et skip l'écriture si identique.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — writeManifest : écriture SEULEMENT si le contenu change', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un 2e compile SANS AUCUN changement ne touche PAS le manifest (même mtime)', async function () {
    const root = mjsTmp('manifest-nochange')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const mtimeAfterFirst = statSync(bundler.manifestPath).mtimeMs

    // Petite pause pour garantir une résolution mtime observable SI une
    // écriture avait lieu (certains filesystems ont une granularité large).
    await new Promise(r => setTimeout(r, 30))

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const mtimeAfterSecond = statSync(bundler.manifestPath).mtimeMs

    assert.equal(mtimeAfterSecond, mtimeAfterFirst,
      "AVANT le fix : le manifest était réécrit inconditionnellement même sans AUCUN changement — sous watch(), si manifestPath est sous sourceDir, ce toucher redéclenche le watcher indéfiniment")

    await bundler.close()
  })

  it('un compile qui change réellement le manifest le réécrit bien (pas de régression)', async function () {
    const root = mjsTmp('manifest-change')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    await bundler.compile()
    const mtimeAfterFirst = statSync(bundler.manifestPath).mtimeMs
    await new Promise(r => setTimeout(r, 30))

    // Ajoute un 2e composant : le manifest (µ.paths) change réellement.
    writeFileSync(join(srcDir, 'autre.mjs'), '<p>autre</p>')
    await bundler.compile()
    const mtimeAfterSecond = statSync(bundler.manifestPath).mtimeMs

    assert.notEqual(mtimeAfterSecond, mtimeAfterFirst, 'le manifest doit être réécrit quand son contenu change réellement')
    await bundler.close()
  })
})
