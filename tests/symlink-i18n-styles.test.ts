// le confinement realpath couvre
// findFiles()/resolveOneAsset()/<@img src> mais PAS scanI18n()/parseI18nFile() (sourceDir/i18n/*.yml
// lu en readFileSync brut) ni bundleSharedStyles() (stylesheetsDir = sourceDir/styles par défaut,
// lui aussi readFileSync brut) — un lien posé DANS l'un de ces deux dossiers et pointant HORS de
// sourceDir/stylesheetsDir voit son contenu RÉEL publié tel quel (bundle.js pour l'i18n,
// mjs_styles-<hash>.js pour la feuille partagée) — fonctions i18nSymlink()/sassSymlink().
//
// Correctif : même confinement RÉEL (realpathSync) que findFiles()/resolveOneAsset(), même message
// catalogué 'bundler.index.symlink-hors-racine' — refus nommé, rien publié. Un lien INTERNE reste
// accepté (dernier test).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const dehors = join(root, 'dehors')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(dehors, { recursive: true })
  return { root, srcDir, dehors, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — confinement realpath étendu à i18n/styles partagées', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("scanI18n()/parseI18nFile() : sourceDir/i18n/fr.yml symlink HORS sourceDir → erreur nommée, rien publié", async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('symlink-i18n-escape')
    mkdirSync(join(srcDir, 'i18n'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')
    writeFileSync(join(dehors, 'secret.yml'), 'salutation: "SECRET-HORS-SOURCEDIR-VIA-I18N"\n')
    symlinkSync(join(dehors, 'secret.yml'), join(srcDir, 'i18n', 'fr.yml'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, i18n: { default: 'fr' } })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : sourceDir/i18n/fr.yml en symlink était lu tel quel, son contenu HORS sourceDir publié en clair dans le manifeste')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /fr\.yml/, `l'erreur doit nommer le fichier fautif : ${msg}`)

    const bundleContent = existsSync(manifest) ? readFileSync(manifest, 'utf-8') : ''
    assert.ok(!bundleContent.includes('SECRET-HORS-SOURCEDIR-VIA-I18N'),
      'AVANT le fix : le secret hors sourceDir apparaissait en clair dans bundle.js (µ._i18nData)')
    const outFiles = existsSync(outDir) ? readdirSync(outDir) : []
    for (const f of outFiles) {
      const c = readFileSync(join(outDir, f), 'utf-8').toString()
      assert.ok(!c.includes('SECRET-HORS-SOURCEDIR-VIA-I18N'), `le secret ne doit apparaître dans aucun fichier émis (trouvé dans ${f})`)
    }

    await bundler.close()
  })

  it("bundleSharedStyles() : stylesheetsDir/partage.sass symlink HORS sourceDir → erreur nommée, rien publié", async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('symlink-styles-escape')
    mkdirSync(join(srcDir, 'styles'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')
    writeFileSync(join(dehors, 'secret.sass'), '.secret\n  content: "SECRET-HORS-SOURCEDIR-VIA-SASS"\n')
    symlinkSync(join(dehors, 'secret.sass'), join(srcDir, 'styles', 'partage.sass'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, stylesheetsDir: join(srcDir, 'styles') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : stylesheetsDir/partage.sass en symlink était lu tel quel, son contenu HORS sourceDir publié dans mjs_styles-<hash>.js')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /partage\.sass/, `l'erreur doit nommer le fichier fautif : ${msg}`)

    const outFiles = existsSync(outDir) ? readdirSync(outDir) : []
    for (const f of outFiles) {
      const c = readFileSync(join(outDir, f), 'utf-8').toString()
      assert.ok(!c.includes('SECRET-HORS-SOURCEDIR-VIA-SASS'), `le secret ne doit apparaître dans aucun fichier émis (trouvé dans ${f})`)
    }

    await bundler.close()
  })

  it('un lien INTERNE (i18n ET styles pointant sous sourceDir) reste accepté — le fix ne doit pas punir un lien légitime', async function () {
    const { srcDir, outDir, manifest } = makeProject('symlink-i18n-styles-interne')
    mkdirSync(join(srcDir, 'i18n'), { recursive: true })
    mkdirSync(join(srcDir, 'styles'), { recursive: true })
    writeFileSync(join(srcDir, 'app.mjs'), '<div>x</div>')

    writeFileSync(join(srcDir, 'i18n', 'reel-fr.yml'), 'salutation: "bonjour"\n')
    symlinkSync(join(srcDir, 'i18n', 'reel-fr.yml'), join(srcDir, 'i18n', 'fr.yml'))

    writeFileSync(join(srcDir, 'styles', 'reel.sass'), '.ok\n  color: red\n')
    symlinkSync(join(srcDir, 'styles', 'reel.sass'), join(srcDir, 'styles', 'partage.sass'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest, i18n: { default: 'fr' }, stylesheetsDir: join(srcDir, 'styles') })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un symlink interne (i18n/styles) ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    // le dictionnaire ne vit plus dans le manifeste mais dans le fichier de SA langue
    // (`mjs_i18n-fr-<hash>.js`, cf. scanI18n) : c'est là qu'on vérifie qu'il est publié.
    const fichierFr = readdirSync(outDir).find(f => /^mjs_i18n-fr-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(fichierFr, `fichier de langue fr attendu dans ${outDir} : ${readdirSync(outDir).join(', ')}`)
    assert.match(readFileSync(join(outDir, fichierFr!), 'utf-8'), /bonjour/, 'le dictionnaire i18n atteint via le lien interne doit être publié normalement')
    assert.ok(readdirSync(outDir).some(f => /^mjs_styles-[a-f0-9]{8}\.js$/.test(f)), 'mjs_styles-<hash>.js doit exister (feuille partagée atteinte via lien interne)')

    await bundler.close()
  })
})
