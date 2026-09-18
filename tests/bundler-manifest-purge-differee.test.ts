// writeHashed() appelle cleanupOldHashes() (donc
// unlinkSync de l'ancien fichier haché d'UN composant) DÈS que CE composant recompile ;
// writeManifest() (qui republie la nouvelle URL) n'arrive qu'à la TOUTE FIN de compile().
// Fenêtre : le manifeste ENCORE SUR DISQUE (celui qu'un navigateur/CDN a déjà chargé) continue de
// nommer un fichier qui vient d'être supprimé — 404 le temps du reste du build.
//
// Correctif : cleanupOldHashes() met désormais la suppression EN ATTENTE (pendingHashCleanup),
// purgée pour de bon SEULEMENT après que writeManifest() ait réussi (fin de compile()) — jamais
// avant.
//
// fixture ADAPTÉE (assertion de fond INCHANGÉE) : `bundler.compileMjs()` appelé
// DIRECTEMENT, hors d'un compile() complet, ne peut PLUS reproduire un état « mi-compile » —
// TOUTE écriture disque (writeHashed) passe désormais par l'émission
// topologique de la phase C de compile(), jamais par un appel isolé à compileMjs() (qui rend
// un REPÈRE provisoire, jamais un chemin réel). La
// fenêtre transitoire (fichier v1 encore là, manifeste pas encore republié) est donc
// observée EN ESPIONNANT writeManifest() PENDANT un unique compile() — même propriété
// vérifiée, sur le point d'observation qui reste possible.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — purge des anciens hashes DIFFÉRÉE après writeManifest()', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("le fichier haché PRÉCÉDENT reste sur disque jusqu'à l'instant où writeManifest() republie la nouvelle URL, PUIS disparaît", async function () {
    const { srcDir, outDir, manifest } = makeProject('purge-differee')
    writeFileSync(join(srcDir, 'home.mjs'), '<div>v1</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const urlV1  = stats1.manifest['home'] as string
    const fileV1 = join(outDir, urlV1.split('/').pop()!)
    assert.ok(existsSync(fileV1), 'setup : le fichier v1 doit exister après le 1er build')

    // édite le composant — le 2e compile() va recompiler 'home', écrire le nouveau fichier
    // (cleanupOldHashes met v1 EN ATTENTE, pas encore supprimé), PUIS republier bundle.js.
    writeFileSync(join(srcDir, 'home.mjs'), '<div>v2 bien plus long pour changer le hash</div>')

    // Espion posé juste AVANT que writeManifest() ne s'exécute réellement (compile(),
    // section « 4. Manifest entrypoint ») : capture l'état du disque à l'instant précis où
    // le nouveau composant est déjà écrit (étape précédente de compile()) mais où bundle.js
    // porte ENCORE l'ancienne URL — la fenêtre que ce test protège.
    let v1ExistedJustBeforeManifestRepublished: boolean | undefined
    let manifestJustBeforeRepublish: string | undefined
    const originalWriteManifest = (bundler as any).writeManifest.bind(bundler)
    ;(bundler as any).writeManifest = function (...args: unknown[]) {
      v1ExistedJustBeforeManifestRepublished = existsSync(fileV1)
      manifestJustBeforeRepublish = readFileSync(manifest, 'utf-8')
      return originalWriteManifest(...args)
    }

    const stats2 = await bundler.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))
    const urlV2 = stats2.manifest['home'] as string
    assert.notEqual(urlV2, urlV1, 'le hash doit changer (contenu différent)')

    assert.equal(v1ExistedJustBeforeManifestRepublished, true,
      "AVANT le fix : cleanupOldHashes() supprimait l'ancien fichier haché DÈS la recompilation de CE composant, alors que le manifeste public (bundle.js) référençait encore cette URL — 404 pour toute requête arrivée pendant le reste du build")
    // le manifeste publie des chemins COMPACTS (préfixe commun factorisé une fois, cf.
    // writeManifest) : on y cherche donc le nom du fichier, pas l'URL entière.
    assert.ok(manifestJustBeforeRepublish?.includes(urlV1.split('/').pop()!),
      'juste avant que writeManifest() ne republie, bundle.js devait ENCORE référencer v1 (pas prématurément retiré)')

    // la purge différée a eu lieu APRÈS writeManifest() (flushPendingHashCleanup, fin de ce
    // même compile()) : v1 doit maintenant avoir disparu, et bundle.js référencer v2.
    assert.ok(!existsSync(fileV1), 'la purge différée doit avoir eu lieu une fois le nouveau manifeste publié')
    const manifestNow = readFileSync(manifest, 'utf-8')
    assert.doesNotMatch(manifestNow, new RegExp(urlV1.split('/').pop()!.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')), 'le manifeste ne doit plus référencer v1')
    assert.ok(manifestNow.includes(urlV2.split('/').pop()!), 'le manifeste doit référencer v2')

    await bundler.close()
  })
})
