// un lien symbolique posé DANS sourceDir et
// pointant HORS de sourceDir était suivi normalement — le fichier/dossier externe finissait
// compilé/copié et publié dans outputDir. Le confinement existant (`resolve()`/`startsWith`)
// est purement LEXICAL : il ne résout jamais un symlink, donc ne le voit jamais.
//
// 3 formes vérifiées ici (toutes prouvées rouges avant
// correctif) :
//   1. findFiles() — symlink de DOSSIER dans sourceDir, pointant vers un dossier externe.
//   2. resolveOneAsset()/µasset() — symlink de FICHIER dans sourceDir, pointant vers un fichier externe.
//   3. <@img src="…"> — même défaut, filet dédié à cette balise.
//
// Correctif : realpathSync(sourceDir) comparé au réel de la cible, aux 3 points de contrôle —
// erreur nommée (catalogue fr/en), rien écrit dans outputDir. Un symlink INTERNE (cible sous
// sourceDir) reste accepté (cf. dernier test, et le cycle de symlinks déjà couvert par
// bundler-find-files-robustness.test.ts, à ne pas régresser).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, symlinkSync, existsSync, readdirSync } from 'node:fs'
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

describe('bundler — confinement sourceDir par symlink (réel via realpathSync)', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("(1) findFiles() : un symlink de DOSSIER dans sourceDir pointant HORS de sourceDir → erreur nommée, rien publié", async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('symlink-dir-escape')
    writeFileSync(join(srcDir, 'ok.mjs'), '<div>ok</div>')
    writeFileSync(join(dehors, 'secret.mjs'), '<div>SECRET-HORS-SOURCEDIR</div>')
    symlinkSync(dehors, join(srcDir, 'lien-vers-dehors'), 'dir')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : le symlink de dossier était suivi sans un mot, secret.mjs compilait normalement')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /lien-vers-dehors/, `l'erreur doit nommer le lien : ${msg}`)
    assert.equal(stats.manifest['secret'], undefined, 'secret.mjs (hors sourceDir) ne doit JAMAIS entrer au manifeste')
    assert.ok(!readdirSync(outDir).some(f => /^secret-/.test(f)),
      "AVANT le fix : secret-<hash>.js était réellement écrit dans outputDir (servi publiquement)")

    await bundler.close()
  })

  it("(2) resolveOneAsset()/µasset() : un symlink de FICHIER dans sourceDir pointant HORS de sourceDir → erreur nommée, rien copié", async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('symlink-asset-escape')
    writeFileSync(join(dehors, 'fichier-sensible.txt'), 'CONTENU-HORS-SOURCEDIR-VIA-ASSET')
    symlinkSync(join(dehors, 'fichier-sensible.txt'), join(srcDir, 'lien.txt'))
    writeFileSync(join(srcDir, 'app.mjs'), `<div>{µasset('lien.txt')}</div>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : µasset('lien.txt') resolvait le symlink et copiait le contenu externe dans outputDir")
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /lien\.txt/, `l'erreur doit nommer le lien référencé : ${msg}`)
    assert.ok(!readdirSync(outDir).some(f => /^lien-/.test(f)),
      "AVANT le fix : lien-<hash>.txt (contenu du fichier externe) était réellement écrit dans outputDir")

    await bundler.close()
  })

  it('(3) <@img src="…"> : même défaut sur son filet dédié → erreur nommée, rien copié', async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('symlink-img-escape')
    const png1x1 = Buffer.from('89504e470d0a1a0a0000000d4948445200000001000000010802000000907753de0000000c4944415478da6360000002000155ffed7e0000000049454e44ae426082', 'hex')
    writeFileSync(join(dehors, 'photo-secrete.png'), png1x1)
    symlinkSync(join(dehors, 'photo-secrete.png'), join(srcDir, 'lien-photo.png'))
    writeFileSync(join(srcDir, 'app.mjs'), '<@img src="lien-photo.png" alt="">')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : <@img src="lien-photo.png"> copiait le contenu externe dans outputDir sans un mot')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /lien-photo\.png/, `l'erreur doit nommer le lien référencé : ${msg}`)
    assert.ok(!readdirSync(outDir).some(f => /^lien-photo-/.test(f)),
      'AVANT le fix : lien-photo-<hash>.png (contenu externe) était réellement copié dans outputDir')

    await bundler.close()
  })

  it('un symlink INTERNE (cible sous sourceDir) reste accepté — le fix ne doit PAS punir un lien légitime', async function () {
    const { srcDir, outDir, manifest } = makeProject('symlink-interne-ok')
    mkdirSync(join(srcDir, 'sub'), { recursive: true })
    writeFileSync(join(srcDir, 'sub', 'reel.mjs'), '<div>interne</div>')
    // lien de dossier VERS un sous-dossier de sourceDir (jamais hors sourceDir)
    symlinkSync(join(srcDir, 'sub'), join(srcDir, 'alias'), 'dir')
    writeFileSync(join(srcDir, 'fichier-cible.txt'), 'contenu interne legitime')
    symlinkSync(join(srcDir, 'fichier-cible.txt'), join(srcDir, 'lien-interne.txt'))
    writeFileSync(join(srcDir, 'app.mjs'), `<div>{µasset('lien-interne.txt')}</div>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un symlink interne ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['reel'], 'le composant atteint via le lien de dossier interne (alias/reel.mjs) doit compiler normalement')
    assert.ok(existsSync(join(outDir, (stats.manifest['reel'] as string).split('/').pop()!)), 'reel-<hash>.js doit exister dans outputDir')

    await bundler.close()
  })
})
