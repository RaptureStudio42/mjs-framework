// writeManifest — ORDRE STABLE des clés de `µ.paths`.
//
// AVANT : les modules cœur entraient au manifeste dans l'ordre d'ARRIVÉE des
// compilations PARALLÈLES (chaque fichier terminé annonce ce qu'il réclame, autant de
// compilations simultanées que la machine a de cœurs) — deux builds du MÊME code
// produisaient un `µ.paths` identique au contenu près mais PERMUTÉ, d'où un diff git
// bruyant à chaque build sur une ligne de 90 000 caractères. Aucun effet fonctionnel
// (on cherche au manifeste par NOM, jamais par rang), mais le bruit masquerait un vrai
// changement le jour où il y en aurait un. Fix : tri par point de code à l'écriture.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

/** Extrait les clés de la ligne `const µPaths = {...};` du manifeste (cascade de modules :
 *  `µ.paths = µPaths;` référence ce même objet plus loin, plus de JSON littéral à CETTE
 *  ligne-là — cf. writeManifest, bundler/index.ts), dans leur ordre d'écriture. */
function manifestKeys(manifestPath: string): string[] {
  const line = readFileSync(manifestPath, 'utf-8').split('\n').find(l => l.startsWith('const µPaths = '))
  assert.ok(line, 'manifeste sans ligne const µPaths')
  return Object.keys(JSON.parse(line!.slice('const µPaths = '.length).replace(/;$/, '')))
}

describe('bundler — writeManifest : ordre STABLE des clés de µ.paths', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('les clés sont triées, quel que soit l\'ordre de création des fichiers', async function () {
    const root   = mjsTmp('paths-ordre')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // créés VOLONTAIREMENT dans le désordre : sans tri, l'ordre d'écriture suit la
    // découverte des fichiers, pas l'alphabet
    writeFileSync(join(srcDir, 'zeta.mjs'), '<p>z</p>')
    writeFileSync(join(srcDir, 'alpha.mjs'), '<p>a</p>')
    writeFileSync(join(srcDir, 'mid.mjs'), '<p>m</p>')
    writeFileSync(join(srcDir, 'beta.mjs'), '<p>b</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const keys   = manifestKeys(bundler.manifestPath)
    const sorted = [...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    assert.deepEqual(keys, sorted, `clés de µ.paths non triées :\n${keys.join(', ')}`)

    await bundler.close()
  })

  it('les MODULES CŒUR réclamés par plusieurs composants sortent triés eux aussi (c\'est eux qui permutaient)', async function () {
    const root   = mjsTmp('paths-ordre-coeur')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // un composant par module cœur, chacun compilé en parallèle : c'est l'ordre
    // d'arrivée de cette course qui décidait du rang de switch/checkbox/radio
    writeFileSync(join(srcDir, 'page-switch.mjs'), '<@switch></@switch>')
    writeFileSync(join(srcDir, 'page-checkbox.mjs'), '<@checkbox></@checkbox>')
    writeFileSync(join(srcDir, 'page-radio.mjs'), '<@radio></@radio>')
    writeFileSync(join(srcDir, 'page-field.mjs'), '<@field></@field>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const keys = manifestKeys(bundler.manifestPath)
    assert.ok(keys.includes('switch') && keys.includes('checkbox') && keys.includes('radio'), `modules cœur absents du manifeste :\n${keys.join(', ')}`)
    const sorted = [...keys].sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
    assert.deepEqual(keys, sorted, `clés de µ.paths non triées :\n${keys.join(', ')}`)

    await bundler.close()
  })

  // RÉGRESSION trouvée en écrivant le test ci-dessus : `Bundler.watch()` (donc tout
  // `mjs dev`) garde la MÊME instance toute la session. Au 2e compile, les composants
  // inchangés sortaient du cache SANS repasser par _compileMjsInner — donc sans
  // redéposer leurs références `<@nom>`. resolveTagShortcuts() ne voyait plus personne
  // réclamer les modules cœur : ils quittaient `µ.paths` et leur balise 404ait en
  // silence jusqu'au redémarrage. Invisible en `mjs build` (cache froid par process).
  it('deux builds successifs écrivent la MÊME ligne µ.paths, octet pour octet (les modules cœur survivent au rebuild incrémental)', async function () {
    const root   = mjsTmp('paths-ordre-rebuild')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'page-switch.mjs'), '<@switch></@switch>')
    writeFileSync(join(srcDir, 'page-checkbox.mjs'), '<@checkbox></@checkbox>')
    writeFileSync(join(srcDir, 'page-radio.mjs'), '<@radio></@radio>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    await bundler.compile()
    const first = manifestKeys(bundler.manifestPath).join('|')
    await bundler.compile()
    const second = manifestKeys(bundler.manifestPath).join('|')

    assert.equal(second, first, 'même code, deux builds → µ.paths doit être identique')
    for (const core of ['switch', 'checkbox', 'radio']) {
      assert.ok(second.split('|').includes(core), `module cœur « ${core} » disparu de µ.paths au 2e compile :\n${second}`)
    }

    await bundler.close()
  })
})
