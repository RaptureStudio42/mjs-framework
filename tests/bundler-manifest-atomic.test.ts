// Régression : `writeManifest()` écrivait `bundle_modular.js` (l'entrypoint qui
// référence TOUS les bundles hashés) via un `writeFileSync` DIRECT sur le chemin final. Un crash
// pendant cette écriture (OOM-kill, coupure) laisse le manifest TRONQUÉ sur disque → site servi
// cassé (le manifest précédent, pourtant valide, est perdu). Fix : écriture dans un fichier
// temporaire PUIS `renameSync` (motif déjà en place pour writeHashed/mangleCache), extraite dans
// `writeFileAtomicAlways()` — atomique au niveau filesystem : `target` n'est jamais visible dans
// un état intermédiaire, soit l'ancien contenu reste, soit le nouveau le remplace ENTIÈREMENT.
//
// Note méthodo : mocker `renameSync`/`writeFileSync` de 'node:fs' depuis un test échoue en
// silence ici (bindings ESM nommés non réassignables, mutation de l'export par défaut non
// propagée aux imports nommés des autres modules — vérifié empiriquement). La panne de rename est
// donc induite par une VRAIE condition OS (cible = un dossier existant, pas un fichier) plutôt
// que par un mock.

import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(): { srcDir: string; outDir: string; manifest: string } {
  const root = mjsTmp('manifest-atomic')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir, manifest: join(root, 'bundle.js') }
}

describe('Bundler — writeManifest() : écriture atomique', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un 2e compile qui change réellement le manifest ne laisse AUCUN fichier .tmp-* derrière (cleanup renameSync)', async () => {
    const { srcDir, outDir, manifest } = makeProject()
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    await bundler.compile()
    const contentAfterFirst = readFileSync(manifest, 'utf-8')

    // Ajoute un 2e composant : le manifest (µ.paths) change réellement → réécriture réelle.
    writeFileSync(join(srcDir, 'autre.mjs'), '<p>autre</p>')
    await bundler.compile()
    const contentAfterSecond = readFileSync(manifest, 'utf-8')

    assert.notEqual(contentAfterSecond, contentAfterFirst, 'le manifest doit refléter le 2e compile')
    const leftovers = readdirSync(dirname(manifest)).filter(f => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'aucun fichier temporaire ne doit survivre après un renameSync réussi')

    await bundler.close()
  })

  it("writeFileAtomicAlways() écrit le contenu complet quand la cible n'existe pas encore", async () => {
    const { srcDir, outDir, manifest } = makeProject()
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    const target = join(outDir, 'manifest-frais.js')
    mkdirSync(outDir, { recursive: true })
    ;(bundler as any).writeFileAtomicAlways(target, 'µ.paths = {};')

    assert.equal(readFileSync(target, 'utf-8'), 'µ.paths = {};')
    const leftovers = readdirSync(outDir).filter(f => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'aucun fichier temporaire ne doit survivre')

    await bundler.close()
  })

  it("un crash PENDANT l'écriture (renameSync échoue) laisse le manifest PRÉCÉDENT totalement intact — jamais de troncature (AVANT le fix : writeFileSync direct aurait pu tronquer `target`)", async () => {
    const { srcDir, outDir, manifest } = makeProject()
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })

    // Cible « existante » simulant le manifest précédent : ici un DOSSIER (pas un fichier), condition
    // OS réelle qui fait échouer `renameSync` (EISDIR) sans avoir besoin de mocker 'node:fs' — la
    // cible avant l'appel contient un marqueur représentant le contenu du build précédent à protéger.
    const target = join(outDir, 'manifest-existant.js')
    mkdirSync(target, { recursive: true })
    writeFileSync(join(target, 'marqueur-ancien-build.txt'), 'contenu du manifest précédent, valide')

    assert.throws(() => {
      ;(bundler as any).writeFileAtomicAlways(target, 'µ.paths = { compromis: true };')
    }, 'le renameSync sur une cible-dossier doit échouer (EISDIR)')

    // la cible doit être RESTÉE EXACTEMENT ce qu'elle était — jamais un état intermédiaire visible
    assert.ok(existsSync(target), 'la cible doit toujours exister')
    assert.ok(readdirSync(target).includes('marqueur-ancien-build.txt'), 'le marqueur doit survivre intact')
    assert.equal(
      readFileSync(join(target, 'marqueur-ancien-build.txt'), 'utf-8'),
      'contenu du manifest précédent, valide',
      "AVANT le fix (writeFileSync direct sur `target`) : un crash à ce stade aurait pu tronquer/écraser le contenu existant — ici, la cible n'a JAMAIS été touchée",
    )

    // aucun fichier .tmp-* ne doit survivre (nettoyé dans le catch)
    const leftovers = readdirSync(outDir).filter(f => f.includes('.tmp-'))
    assert.deepEqual(leftovers, [], 'le fichier temporaire doit être nettoyé après l\'échec du renameSync')

    await bundler.close()
  })
})
