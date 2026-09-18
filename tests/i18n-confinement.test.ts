// i18n-confinement :
// parseI18nFile confinait à `sourceDir` (assertRealUnder(path, this.sourceDir)) alors que le
// commentaire d'assertRealUnder promet i18nDir comme racine légitime pour cet appelant — un lien
// POSÉ DANS i18n/ mais pointant vers un AUTRE fichier de sourceDir (hors i18n/) était accepté
// comme traduction légitime. Et un lien PENDANT (cible absente) posé dans i18n/ faisait lever à
// realpathSync un ENOENT Node brut, jamais catalogué. Correctifs : confinement à sourceDir/i18n
// (pas sourceDir entier) ; message catalogué nommant le chemin pour un lien pendant.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — parseI18nFile confine à i18nDir (sourceDir/i18n), pas sourceDir entier', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('i18n/fr.yml → symlink vers sourceDir/autre.yml (DANS sourceDir, HORS i18n/) : refusé, rien publié', async function () {
    const { srcDir, outDir, manifest } = makeProject('e21-i18n-confinement-hors-i18ndir')
    mkdirSync(join(srcDir, 'i18n'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')
    writeFileSync(join(srcDir, 'autre.yml'), 'salutation: "AILLEURS-DANS-SOURCEDIR-HORS-I18N"\n')
    symlinkSync(join(srcDir, 'autre.yml'), join(srcDir, 'i18n', 'fr.yml'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, i18n: { default: 'fr' } })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : i18n/fr.yml symlink vers sourceDir/autre.yml (HORS i18n/) était accepté, assertRealUnder confinait à sourceDir entier')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /fr\.yml/, `l'erreur doit nommer le fichier fautif : ${msg}`)
    const bundleContent = existsSync(manifest) ? readFileSync(manifest, 'utf-8') : ''
    assert.ok(!bundleContent.includes('AILLEURS-DANS-SOURCEDIR-HORS-I18N'), 'le contenu hors i18n/ ne doit jamais être publié comme traduction')

    await bundler.close()
  })

  it('lien PENDANT (cible absente) dans une section i18n/fr/section.yml : message catalogué nommant le chemin, jamais un ENOENT Node brut', async function () {
    const { srcDir, outDir, manifest } = makeProject('e21-i18n-confinement-pendant')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')
    symlinkSync(join(srcDir, 'i18n', 'fr', 'nexiste-pas.yml'), join(srcDir, 'i18n', 'fr', 'section.yml'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, i18n: { default: 'fr' } })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, 'le lien pendant doit faire échouer le build')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.doesNotMatch(msg, /ENOENT/, `AVANT le fix : ENOENT Node brut, jamais catalogué -> ${msg}`)
    assert.match(msg, /section\.yml/, `l'erreur doit nommer le chemin fautif : ${msg}`)

    await bundler.close()
  })

  it('lien INTERNE à i18n/ (une section pointant vers un autre fichier DANS i18n/) reste accepté', async function () {
    const { srcDir, outDir, manifest } = makeProject('e21-i18n-confinement-interne')
    mkdirSync(join(srcDir, 'i18n', 'fr'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')
    writeFileSync(join(srcDir, 'i18n', 'fr', 'reel.yml'), 'titre: "bonjour"\n')
    symlinkSync(join(srcDir, 'i18n', 'fr', 'reel.yml'), join(srcDir, 'i18n', 'fr', 'section.yml'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, i18n: { default: 'fr' } })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un lien interne à i18n/ ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)

    await bundler.close()
  })
})
