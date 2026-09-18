// un SVG contenant un <script>, un attribut on*=
// ou javascript: est copié VERBATIM par resolveOneAsset() (branche « Binaires », aucune
// inspection de contenu) — que ce soit référencé via µasset() OU via µimage() (qui délègue à
// resolveOneAsset() puis renvoie tel quel pour l'extension .svg). Le fichier écrit sous outputDir
// est servi depuis la MÊME origine que le reste du site : exécutable au chargement direct de
// l'URL du SVG, ou via <object>/<iframe>. Aucun avertissement de build.
//
// Correctif : refus explicite au build (catalogue, nommant le fichier et le motif trouvé) — rien
// écrit dans outputDir. Un SVG propre continue d'être copié normalement.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  return { srcDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — SVG avec script embarqué refusé au build', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("µasset('icone.svg') sur un SVG avec <script> → erreur nommée, rien copié dans outputDir", async function () {
    const { srcDir, outDir, manifest } = makeProject('svg-script-asset')
    const svgMalveillant = '<svg xmlns="http://www.w3.org/2000/svg"><script>window.__pwned = true</script><rect width="10" height="10"/></svg>'
    writeFileSync(join(srcDir, 'icone.svg'), svgMalveillant)
    writeFileSync(join(srcDir, 'app.mjs'), `<div>{µasset('icone.svg')}</div>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : le SVG avec <script> était copié tel quel dans outputDir, 0 erreur, 0 avertissement")
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /icone\.svg/, `l'erreur doit nommer le fichier : ${msg}`)
    assert.match(msg, /script/i, `l'erreur doit nommer le motif trouvé : ${msg}`)
    assert.ok(!readdirSync(outDir).some(f => /^icone-/.test(f)),
      'AVANT le fix : icone-<hash>.svg (avec son <script>) était réellement écrit dans outputDir')

    await bundler.close()
  })

  it("µimage('icone.svg') sur un SVG avec attribut onload= → erreur nommée, rien copié", async function () {
    const { srcDir, outDir, manifest } = makeProject('svg-script-image')
    const svgMalveillant = '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"><rect width="10" height="10"/></svg>'
    writeFileSync(join(srcDir, 'icone.svg'), svgMalveillant)
    writeFileSync(join(srcDir, 'app.mjs'), `<script>\n  logo = µimage('icone.svg')\n</script>\n<p>x</p>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : le SVG avec onload= était copié tel quel via µimage(), 0 erreur")
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /icone\.svg/, `l'erreur doit nommer le fichier : ${msg}`)
    assert.ok(!readdirSync(outDir).some(f => /^icone-/.test(f)),
      'AVANT le fix : icone-<hash>.svg (avec onload=) était réellement écrit dans outputDir')

    await bundler.close()
  })

  it('un SVG PROPRE (sans script/on*=/javascript:) continue à être copié normalement', async function () {
    const { srcDir, outDir, manifest } = makeProject('svg-propre')
    writeFileSync(join(srcDir, 'icone.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10" fill="lemon"/></svg>')
    writeFileSync(join(srcDir, 'app.mjs'), `<div>{µasset('icone.svg')}</div>`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un SVG propre ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(readdirSync(outDir).some(f => /^icone-[a-f0-9]{8}\.svg$/.test(f)), 'icone-<hash>.svg doit être écrit normalement')

    await bundler.close()
  })
})
