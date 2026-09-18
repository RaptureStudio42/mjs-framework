// un nom de fichier composant hors kebab-case
// compile sans un mot. Majuscule → clé de manifeste dans la casse d'origine, mais l'autoloader
// cherche TOUJOURS en minuscules (µ.paths[tag.replace('mjs-', '')], tag lui-même toujours en
// minuscules) → composant injoignable à vie, juste un avertissement runtime jamais vu au build.
// Espace → l'enregistrement de `mjs-espace ici` lève au chargement (nom de custom element
// invalide). Correctif : même garde que .theme.mjs (THEME_FILE_NAME_RE) — refus nommé au build,
// avec une suggestion en kebab-case, pour tout basename hors [a-z0-9-].

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — nom de fichier composant hors kebab-case', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('MonComposant.mjs (majuscule) : erreur nommée, jamais un build vert avec un composant injoignable', async function () {
    const { srcDir, outDir, manifest } = makeProject('kebab-majuscule')
    writeFileSync(join(srcDir, 'MonComposant.mjs'), '<div>maj</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : MonComposant.mjs compilait à 0 erreur/0 avertissement, injoignable en silence (clé de manifeste en casse d\'origine, autoloader en minuscules)')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /MonComposant\.mjs/, `l'erreur doit nommer le fichier fautif : ${msg}`)
    assert.match(msg, /mon-composant/, `l'erreur doit proposer le nom en kebab-case : ${msg}`)
    assert.equal(stats.manifest['MonComposant'], undefined, 'aucune clé de manifeste en casse fautive')

    await bundler.close()
  })

  it("mon comp.mjs (espace) : erreur nommée, jamais un enregistrement qui lève au chargement", async function () {
    const { srcDir, outDir, manifest } = makeProject('kebab-espace')
    writeFileSync(join(srcDir, 'mon comp.mjs'), '<div>espace</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : 'mon comp.mjs' compilait à 0 erreur, l'enregistrement de `mjs-mon comp` levait seulement au CHARGEMENT du module")
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /mon comp\.mjs/, `l'erreur doit nommer le fichier fautif : ${msg}`)
    assert.match(msg, /mon-comp/, `l'erreur doit proposer le nom en kebab-case : ${msg}`)

    await bundler.close()
  })

  it('mon-comp.mjs (kebab-case propre) : compile normalement, aucune erreur', async function () {
    const { srcDir, outDir, manifest } = makeProject('kebab-ok')
    writeFileSync(join(srcDir, 'mon-comp.mjs'), '<div>ok</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un nom déjà kebab-case ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['mon-comp'], 'la clé de manifeste mon-comp doit exister')

    await bundler.close()
  })
})
