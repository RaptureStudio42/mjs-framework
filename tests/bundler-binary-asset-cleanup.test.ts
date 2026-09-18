// Test de régression : la copie
// d'assets binaires (webp/png/etc., dans `resolveOneAsset`) ne nettoyait
// JAMAIS les anciennes versions du même basename — contrairement au JS
// compilé (`writeHashed`, qui purge déjà ses anciennes versions à chaque
// écriture). Un asset binaire réédité au fil du temps (logo.png changé à
// plusieurs reprises) laissait CHAQUE ancienne version `logo-<hash>.png`
// s'accumuler indéfiniment dans outputDir.
//
// Fix : logique de nettoyage factorisée (`cleanupOldHashes`, DUPLIQUÉE 2
// fois dans writeHashed() lui-même avant ce fix) et appliquée aussi à la
// copie binaire.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — copie binaire : nettoyage des anciennes versions du même asset', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("un asset binaire réédité (contenu différent → hash différent) ne laisse PAS l'ancienne version dans outputDir", async function () {
    const root = mjsTmp('binary-cleanup')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      "  path = µasset('logo.png')",
      '</script>',
      '<p>{path}</p>',
    ].join('\n'))
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([1, 2, 3]))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))
    const logosAfterFirst = readdirSync(outDir).filter(f => f.startsWith('logo-'))
    assert.equal(logosAfterFirst.length, 1, `un seul logo attendu après le 1er build. trouvé: ${logosAfterFirst.join(', ')}`)

    // Édition de l'asset : contenu différent → hash différent. Nouvelle
    // instance de Bundler pour le 2e compile — on isole ainsi PROPREMENT la
    // ré-invocation de resolveOneAsset('logo.png') quel que soit l'état du
    // cache. (Désormais, un MÊME bundler
    // ré-invaliderait AUSSI comp.mjs — le hash de cache dépend désormais du
    // contenu des assets µasset() ; cf. bundler-import-deps.test.ts. La 2e
    // instance reste le moyen le plus net de cibler UNIQUEMENT le nettoyage.)
    writeFileSync(join(srcDir, 'logo.png'), Buffer.from([9, 9, 9, 9, 9]))
    const bundler2 = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats2 = await bundler2.compile()
    assert.equal(stats2.errors.length, 0, stats2.errors.map(e => e.message).join('\n'))

    const logosAfterSecond = readdirSync(outDir).filter(f => f.startsWith('logo-'))
    assert.equal(logosAfterSecond.length, 1,
      `AVANT le fix : l'ancienne version restait à côté de la nouvelle, s'accumulant indéfiniment. trouvé: ${logosAfterSecond.join(', ')}`)
    assert.notEqual(logosAfterSecond[0], logosAfterFirst[0], 'le hash doit avoir changé (contenu différent)')

    await bundler.close()
    await bundler2.close()
  })
})
