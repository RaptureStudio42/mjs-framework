// Après un writeManifest() en ÉCHEC (v1 mis en
// attente dans pendingHashCleanup, jamais flushé — comportement voulu, cf. commentaire de
// cleanupOldHashes), le TOUT PROCHAIN compile() réinitialisait pendingHashCleanup = [] EN TÊTE de
// méthode, AVANT même de savoir si CE compile() allait réussir — l'orphelin v1 (posé par l'échec
// précédent) était donc OUBLIÉ, jamais requalifié : si ce compile() suivant réussit mais en
// CACHE-HIT total (le composant fautif n'a pas changé de contenu depuis l'échec), aucun nouveau
// cleanupOldHashes() ne le redécouvre — v1 survit jusqu'au PROCHAIN vrai changement de contenu
// (coïncidence, pas une garantie).
//
// Cible normative : la file pendingHashCleanup doit être vidée (flushPendingHashCleanup)
// au PREMIER writeManifest() réussi qui suit, cache-hit ou non — jamais oubliée en route.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  // manifestPath dans un dossier À PART (pas outDir) : rmSync/mkdirSync dessus (pour simuler
  // l'échec EISDIR de writeManifest) ne perturbent jamais outDir ni son contenu.
  return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — purge différée × cache-hit : pendingHashCleanup ne doit pas s\'oublier', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("writeManifest() échoue (v1 mis en attente) → build SUIVANT réussi mais CACHE-HIT total → v1 doit disparaître à CE build-là, pas au suivant", async function () {
    const { srcDir, outDir, manifest } = makeProject('purge-differee-cache-hit')
    writeFileSync(join(srcDir, 'home.mjs'), '<div>v1</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const urlV1  = stats1.manifest['home'] as string
    const fileV1 = join(outDir, urlV1.split('/').pop()!)
    assert.ok(existsSync(fileV1), 'setup : v1 doit exister après le 1er build')

    // édite → v2, PUIS rend manifestPath injoignable (un DOSSIER à la place du fichier) →
    // writeManifest() doit échouer (EISDIR) : v1 mis en attente, JAMAIS flushé.
    writeFileSync(join(srcDir, 'home.mjs'), '<div>v2 bien plus long pour changer le hash a nouveau ici</div>')
    rmSync(manifest, { force: true })
    mkdirSync(manifest, { recursive: true })

    const stats2 = await bundler.compile()
    assert.ok(stats2.errors.length > 0, 'setup : writeManifest() doit avoir échoué (manifestPath = dossier)')
    assert.ok(existsSync(fileV1), 'setup : v1 doit survivre — writeManifest a échoué, flush jamais appelé')

    // répare manifestPath, mais NE CHANGE PAS le contenu de home.mjs (encore 'v2') : ce build
    // DOIT être un cache-hit TOTAL pour 'home' (aucun nouveau cleanupOldHashes ne le concerne).
    rmSync(manifest, { recursive: true, force: true })
    const stats3 = await bundler.compile()
    assert.equal(stats3.errors.length, 0, `build3 (manifestPath réparé) doit réussir : ${stats3.errors.map(e => e.message).join('\n')}`)
    assert.ok((bundler as any).cacheHitsThisCompile > 0, 'setup : build3 doit être un cache-hit (home inchangé depuis v2)')

    assert.ok(!existsSync(fileV1),
      "AVANT le fix : pendingHashCleanup était réinitialisé EN TÊTE de compile() (build3), AVANT que build3 ne sache s'il réussirait — l'orphelin v1 (posé par l'échec de build2) restait sur disque malgré le writeManifest() RÉUSSI de build3")

    await bundler.close()
  })
})
