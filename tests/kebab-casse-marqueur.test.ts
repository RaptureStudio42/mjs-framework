// isPageFile() est sensible à la casse (`.page`
// strict) mais l'exemption de la garde kebab-case (pageAwareBaseName, `!/\.page$/i.test(base)`)
// est insensible à la casse — un marqueur mal casé (`Truc.PAGE.mjs`) n'est reconnu ni par
// isPageFile() (garde sautée) ni par la garde kebab-case (exemptée à tort) : 0 erreur, clé
// de manifeste 'Truc.PAGE' publiée telle quelle — introuvable par l'autoloader (toujours en
// minuscules), exactement le bogue d'origine que la garde kebab-case devait fermer.
// Bogue annexe : la suggestion de renommage pour un `.page` bien casé (`Truc.page.mjs`) proposait
// 'truc.mjs' — perdait le marqueur, donc la capacité <routes>/@routes du fichier d'origine.
// Correctif : exemption stricte (`.page` minuscule, identique à isPageFile) ; suggestion qui
// réintègre le marqueur .page quand il était présent (bien ou mal casé).

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

describe('bundler — marqueur .page mal casé échappait à la garde kebab-case', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("Truc.PAGE.mjs (marqueur mal casé) : refusé comme tout nom hors kebab-case, jamais une clé de manifeste 'Truc.PAGE'", async function () {
    const { srcDir, outDir, manifest } = makeProject('page-mal-case')
    writeFileSync(join(srcDir, 'Truc.PAGE.mjs'), '<div>x</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : Truc.PAGE.mjs compilait à 0 erreur — isPageFile() (sensible à la casse) ET la garde kebab-case (exemption insensible à la casse) le laissaient tous deux passer")
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /Truc\.PAGE\.mjs/, `l'erreur doit nommer le fichier fautif : ${msg}`)
    assert.equal(stats.manifest['Truc.PAGE'], undefined, "AVANT le fix : la clé de manifeste 'Truc.PAGE' était publiée — introuvable par l'autoloader (toujours en minuscules)")

    await bundler.close()
  })

  it("Truc.page.mjs (marqueur bien casé, base hors kebab) : la suggestion garde le marqueur .page", async function () {
    const { srcDir, outDir, manifest } = makeProject('page-bien-case')
    writeFileSync(join(srcDir, 'Truc.page.mjs'), '<div>x</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0, `Truc.page.mjs doit rester refusé (base "Truc" hors kebab) : ${JSON.stringify(stats.errors)}`)
    const msg = stats.errors.map(e => e.message).join('\n')
    assert.match(msg, /truc\.page\.mjs/,
      `AVANT le fix : la suggestion perdait le marqueur .page ('truc.mjs' au lieu de 'truc.page.mjs') — ${msg}`)
    assert.doesNotMatch(msg, /'truc\.mjs'/, `la suggestion ne doit plus jamais être 'truc.mjs' (perte du marqueur) : ${msg}`)

    await bundler.close()
  })

  it('truc.page.mjs (marqueur + base propres) : compile normalement', async function () {
    const { srcDir, outDir, manifest } = makeProject('page-ok')
    writeFileSync(join(srcDir, 'truc.page.mjs'), '<div>x</div>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: manifest })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `un .page.mjs propre ne doit jamais échouer : ${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(stats.manifest['truc'], 'la clé de manifeste truc doit exister (marqueur .page retiré)')

    await bundler.close()
  })
})
