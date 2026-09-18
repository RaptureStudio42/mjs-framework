// `mjs init` — le dossier d'exemples et l'ORDRE canonique des blocs.
//
// Ce que ce test garde : (1) le scaffold pose bien `examples/hello-world.mjs` et son
// README ; (2) les DEUX composants scaffoldés rangent leurs blocs dans l'ordre de la
// convention (script module, script, gabarit, theme, style) ; (3) ils COMPILENT — un
// exemple de démarrage cassé est pire que pas d'exemple du tout, et rien d'autre ne
// vérifiait jusqu'ici que le contenu de ces gabarits passe le compilateur.

import assert from 'node:assert/strict'
import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { runInit } from '../src/cli/init.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

/** Scaffolde dans un dossier neuf, sans polluer la sortie du lanceur de tests. */
function scaffold(prefix: string): string {
  const root     = mjsTmp(prefix)
  const original = console.log
  console.log = () => {}
  try { runInit(root) } finally { console.log = original }
  return root
}

/** Rangs des blocs de premier niveau dans l'ordre où ils apparaissent dans le fichier. */
function blockOrder(source: string): string[] {
  const found: string[] = []
  for (const line of source.split('\n')) {
    if (line.startsWith('<script module>')) found.push('script module')
    else if (line.startsWith('<script>')) found.push('script')
    else if (line.startsWith('<theme>')) found.push('theme')
    else if (line.startsWith('<style>')) found.push('style')
  }
  return found
}

describe('cli/init.ts — dossier d\'exemples et ordre des blocs', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('le scaffold crée examples/hello-world.mjs et examples/README.md', function () {
    const root = scaffold('init-exemples')
    assert.ok(existsSync(join(root, 'app/modularjs/examples/hello-world.mjs')), 'le composant d\'exemple manque')
    assert.ok(existsSync(join(root, 'app/modularjs/examples/README.md')), 'le README des exemples manque')
  })

  it('les deux composants scaffoldés suivent l\'ordre canonique des blocs', function () {
    const root    = scaffold('init-ordre')
    const exemple = readFileSync(join(root, 'app/modularjs/examples/hello-world.mjs'), 'utf-8')
    const hello   = readFileSync(join(root, 'app/modularjs/hello.mjs'), 'utf-8')

    assert.deepEqual(blockOrder(exemple), ['script module', 'script', 'theme', 'style'], 'examples/hello-world.mjs range mal ses blocs')
    assert.deepEqual(blockOrder(hello), ['script', 'theme', 'style'], 'hello.mjs range mal ses blocs')
    // le gabarit vit ENTRE le dernier </script> et le premier <theme> : on vérifie
    // qu'il y a bien du markup à cet endroit, pas après le <style>
    const lignes         = exemple.split('\n')
    const finDernierScr  = lignes.reduce((idx, l, i) => l.startsWith('</script>') ? i : idx, -1)
    const debutTheme     = lignes.findIndex(l => l.startsWith('<theme>'))
    const gabarit        = lignes.slice(finDernierScr + 1, debutTheme).join('\n')
    assert.match(gabarit, /<section class="hello">/, 'le gabarit doit venir après le script et avant le theme')
  })

  it('le projet scaffoldé compile sans une seule erreur', async function () {
    const root    = scaffold('init-compile')
    const config  = JSON.parse(readFileSync(join(root, 'mjs.config.json'), 'utf-8'))
    const bundler = new Bundler({
      sourceDir:      join(root, config.sourceDir),
      outputDir:      join(root, config.outputDir),
      manifestPath:   join(root, config.manifestPath),
      stylesheetsDir: join(root, config.stylesheetsDir),
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, `le scaffold ne compile pas :\n${stats.errors.map(e => e.message).join('\n')}`)
    assert.ok(Object.keys(stats.manifest).includes('hello-world'), `le composant d'exemple manque au manifeste :\n${Object.keys(stats.manifest).join(', ')}`)
    assert.ok(Object.keys(stats.manifest).includes('hello'), `hello manque au manifeste :\n${Object.keys(stats.manifest).join(', ')}`)

    await bundler.close()
  })
})
