// Test de régression : `resolveMagicAssets`
// utilisait `result.replace(from, to)` avec `to` en STRING — la string de
// remplacement de `.replace()` est interprétée comme un PATTERN spécial
// (`$&` = tout le match, `$1`..`$9` = groupes capturés, `` $` ``/`$'` = avant/
// après le match, `$$` = `$` littéral), pas une string littérale. Si le
// `webPath` résolu (dérivé de `urlPrefix`/`outputDir`, configurables par le
// projet) contient un `$` suivi d'un caractère spécial, le texte injecté est
// SILENCIEUSEMENT corrompu.
//
// Fix : forme fonction du replacer (`.replace(from, () => to)`) — sa valeur
// de retour est utilisée telle quelle, sans interprétation de pattern.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — resolveMagicAssets : "to" non interprété comme pattern de replace()', function () {
  this.timeout(15000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("un urlPrefix contenant '$&' (pattern replace() = tout le match) n'est PAS interprété, injecté tel quel", async function () {
    const root = mjsTmp('replace-pattern')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'icon.svg'), '<svg></svg>')

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: join(root, 'out'),
      urlPrefix: '/w$&eird',
    })
    mkdirSync(bundler.outputDir, { recursive: true })

    const source = `path = µasset('icon.svg')`
    const result = await bundler.resolveMagicAssets(source)

    assert.doesNotMatch(result, /µasset\(/,
      "AVANT le fix : `$&` dans urlPrefix faisait réinjecter le TEXTE DU MATCH ENTIER (l'appel µasset(...) lui-même) à la place du webPath — le résultat contenait encore le texte source original, corrompu")
    assert.match(result, /^path = '\/w\$&eird\/icon-[a-f0-9]{8}\.svg'$/,
      `le urlPrefix '$&' doit apparaître LITTÉRALEMENT dans le webPath injecté. got: ${result}`)

    await bundler.close()
  })

  it('cas normal (urlPrefix sans caractère spécial) reste inchangé', async function () {
    const root = mjsTmp('replace-pattern-normal')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'icon.svg'), '<svg></svg>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out') })
    mkdirSync(bundler.outputDir, { recursive: true })

    const result = await bundler.resolveMagicAssets(`path = µasset('icon.svg')`)
    assert.match(result, /^path = '\/out\/icon-[a-f0-9]{8}\.svg'$/, result)

    await bundler.close()
  })
})
