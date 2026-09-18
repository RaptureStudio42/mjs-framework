// Identifiant de build GLOBAL au manifest (protocole de navigation).
// AVANT : seul le hash PAR asset existait (writeHashed, md5 8 hex par fichier émis) —
// aucun identifiant d'ENSEMBLE, donc rien pour détecter côté client qu'une nouvelle
// version du site a été déployée (protocole de navigation). Fix : `µ.version` dérivé
// du CONTENU assemblé du manifest (déterministe, jamais une horloge), reflété sur
// `bundler.lastBuildId`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// cascade de modules : la ligne vit désormais dans le corps indenté du `.then()` du
// manifeste (cf. writeManifest, bundler/index.ts) — `\s*` en tête tolère l'indentation.
const VERSION_RE = /^\s*µ\.version = "([0-9a-f]{8})";$/m

describe('bundler — writeManifest : identifiant de build GLOBAL (µ.version)', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un build écrit µ.version (8 hex) dans le manifest et bundler.lastBuildId le reflète', async function () {
    const root = mjsTmp('manifest-buildid')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const content = readFileSync(bundler.manifestPath, 'utf-8')
    const match = content.match(VERSION_RE)
    assert.ok(match, `manifest sans ligne µ.version :\n${content}`)
    assert.equal(bundler.lastBuildId, match![1], 'bundler.lastBuildId doit refléter la ligne µ.version écrite')

    await bundler.close()
  })

  it('un re-build SANS AUCUN changement produit le MÊME id (dérivé du contenu, pas d\'une horloge)', async function () {
    const root = mjsTmp('manifest-buildid-stable')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    await bundler.compile()
    const idAfterFirst = bundler.lastBuildId
    assert.ok(idAfterFirst, 'un id doit avoir été calculé au 1er build')

    await bundler.compile()
    const idAfterSecond = bundler.lastBuildId

    assert.equal(idAfterSecond, idAfterFirst, 'même build (aucun changement) → même id')

    await bundler.close()
  })

  it('modifier un composant change l\'id de build', async function () {
    const root = mjsTmp('manifest-buildid-change')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    await bundler.compile()
    const idBefore = bundler.lastBuildId

    // Ajoute un 2e composant : le manifest (µ.paths) change réellement → id différent.
    writeFileSync(join(srcDir, 'autre.mjs'), '<p>autre</p>')
    await bundler.compile()
    const idAfter = bundler.lastBuildId

    assert.notEqual(idAfter, idBefore, 'un asset qui change doit changer l\'id de build')

    await bundler.close()
  })

  it('la ligne µ.version vient toujours APRÈS µ.paths (ordre stable)', async function () {
    const root = mjsTmp('manifest-buildid-order')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    await bundler.compile()

    const content = readFileSync(bundler.manifestPath, 'utf-8')
    const pathsIdx = content.indexOf('µ.paths = ')
    const versionIdx = content.indexOf('µ.version = ')
    assert.ok(pathsIdx >= 0, 'µ.paths absent du manifest')
    assert.ok(versionIdx >= 0, 'µ.version absent du manifest')
    assert.ok(versionIdx > pathsIdx, 'µ.version doit venir APRÈS µ.paths')

    await bundler.close()
  })
})
