// Confiner <@include> et @import à sourceDir, même garde que les
// liens symboliques (bundler-symlink-escape.test.ts). AVANT ce correctif : un `../` répété dans
// un <@include> relatif STRICT résolvait n'importe où sur le disque, sans garde ni symlink —
// prouvé : le contenu d'un fichier hors sourceDir se retrouvait inliné tel quel dans le bundle
// émis (SECRET-CONTENT-HORS). `@import`/`µimport` passent par µasset() (resolveOneAsset, déjà
// confiné) : refusés dès avant ce correctif, tests ici en régression.

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

describe('confinement sourceDir — <@include>/@import', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('<@include ../dehors/secret> (chemin relatif STRICT hors sourceDir) → erreur nommée, rien inliné', async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('include-escape')
    writeFileSync(join(dehors, '_secret.mjs'), '<div>SECRET-CONTENT-HORS</div>')
    writeFileSync(join(srcDir, 'ok.mjs'), '<@include ../dehors/secret>\n<div>ok</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      'AVANT le fix : le chemin relatif hors sourceDir résolvait sans un mot, secret.mjs était inliné')
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /dehors\/secret|hors de sourceDir/i, `l'erreur doit nommer le chemin fautif : ${msg}`)
    for (const f of readdirSync(outDir)) {
      if (/^ok-.*\.js$/.test(f)) {
        assert.doesNotMatch(readFileSync(join(outDir, f), 'utf-8'), /SECRET-CONTENT-HORS/,
          'AVANT le fix : SECRET-CONTENT-HORS se retrouvait dans le bundle émis')
      }
    }

    await bundler.close()
  })

  it('@import \'../dehors/x.civet\' (chemin relatif hors sourceDir) → refusé, rien copié', async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('import-escape')
    writeFileSync(join(dehors, 'secret.civet'), "console.log 'SECRET-IMPORT-HORS'\n")
    writeFileSync(join(srcDir, 'ok.mjs'), "<div>ok</div>\n<script>\n@import Secret '../dehors/secret.civet'\n</script>\n")

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, "AVANT tout fix pertinent : @import '../dehors/...' aurait dû être refusé")
    assert.ok(!readdirSync(outDir).some(f => /secret/i.test(f)), 'aucun fichier lié au secret ne doit être écrit dans outputDir')

    await bundler.close()
  })

  it('µimport(\'../dehors/x.civet\') (forme nue, chemin hors sourceDir) → refusé, rien copié', async function () {
    const { srcDir, dehors, outDir, manifest } = makeProject('muimport-escape')
    writeFileSync(join(dehors, 'secret2.civet'), "console.log 'SECRET-MUIMPORT-HORS'\n")
    writeFileSync(join(srcDir, 'ok.mjs'), "<div>ok</div>\n<script>\nx = µimport('../dehors/secret2.civet')\n</script>\n")

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, "AVANT tout fix pertinent : µimport('../dehors/...') aurait dû être refusé")
    assert.ok(!readdirSync(outDir).some(f => /secret2/i.test(f)), 'aucun fichier lié au secret ne doit être écrit dans outputDir')

    await bundler.close()
  })

  it('<@include> interne (même dossier, sous-dossier, `..` restant sous sourceDir) reste accepté', async function () {
    const { srcDir, outDir, manifest } = makeProject('include-interne-ok')
    mkdirSync(join(srcDir, 'sub'), { recursive: true })
    writeFileSync(join(srcDir, 'sub', '_partial.mjs'), '<div>partial-interne</div>')
    writeFileSync(join(srcDir, 'app.mjs'), '<@include ./sub/partial>\n<div>hote</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un <@include> interne ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['app'], 'app.mjs doit compiler normalement')

    await bundler.close()
  })

  it('<@include> via lien symbolique INTERNE (cible sous sourceDir) reste accepté', async function () {
    const { srcDir, outDir, manifest } = makeProject('include-symlink-interne-ok')
    mkdirSync(join(srcDir, 'reel'), { recursive: true })
    writeFileSync(join(srcDir, 'reel', '_partial.mjs'), '<div>partial-via-lien</div>')
    symlinkSync(join(srcDir, 'reel'), join(srcDir, 'alias'), 'dir')
    writeFileSync(join(srcDir, 'app.mjs'), '<@include ./alias/partial>\n<div>hote</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un lien symbolique interne ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['app'], 'app.mjs doit compiler normalement')

    await bundler.close()
  })
})
