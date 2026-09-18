// Test de régression : `cli/init.ts:103-108`
// affichait des hints de fin de scaffold ERRONÉS :
//   1. `./bin/mjs dev` — n'existe QUE dans le dépôt source de ModularJS ;
//      un projet consommateur invoque le CLI via `npx mjs` (bin exposé par
//      package.json), jamais un chemin relatif littéral inexistant dans le
//      projet scaffoldé.
//   2. `<script src="/assets/javascripts/bundle_modular.js">` — convention
//      Rails/Sprockets d'une version antérieure, SANS RAPPORT avec le
//      `mjs.config.json` fraîchement scaffoldé juste au-dessus
//      (`outputDir: "public/modularjs"` → servi à `/modularjs/bundle.js`) —
//      un dev qui copie-colle cette ligne obtient un 404 immédiat.
//
// Fix : hints corrigés (`npx mjs dev`, `/modularjs/bundle.js`).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { runInit } from '../src/cli/init.js'
import { Bundler } from '../src/bundler/index.js'

function captureLogs(fn: () => void): string[] {
  const lines: string[] = []
  const original = console.log
  console.log = (...args: any[]) => { lines.push(args.join(' ')) }
  try { fn() } finally { console.log = original }
  return lines
}

describe('cli/init.ts — hints de fin de scaffold cohérents avec le projet généré', function () {
  it("le hint de démarrage utilise 'npx mjs', pas un chemin ./bin/mjs inexistant dans le projet scaffoldé", function () {
    const root = mjsTmp('init-hints')
    const lines = captureLogs(() => runInit(root))
    const joined = lines.join('\n')

    assert.doesNotMatch(joined, /\.\/bin\/mjs/,
      "AVANT le fix : `./bin/mjs dev` était affiché — ce chemin n'existe QUE dans le dépôt ModularJS lui-même, jamais dans un projet qui installe le package")
    assert.match(joined, /npx mjs dev/, "le hint doit utiliser l'invocation documentée (README) 'npx mjs dev'")
  })

  it('le hint du <script> pointe vers le VRAI chemin servi, dérivé du mjs.config.json scaffoldé (pas une convention Rails obsolète)', function () {
    const root = mjsTmp('init-hints-url')
    const lines = captureLogs(() => runInit(root))
    const joined = lines.join('\n')

    assert.doesNotMatch(joined, /assets\/javascripts\/bundle_modular\.js/,
      "AVANT le fix : `/assets/javascripts/bundle_modular.js` (convention Rails/Sprockets d'une version antérieure) était affiché, sans rapport avec le scaffold actuel — 404 garanti")

    // Dérive le chemin RÉELLEMENT servi à partir du mjs.config.json que
    // runInit vient d'écrire — pas une valeur recopiée à la main, pour que
    // ce test reste vrai même si le scaffold par défaut change plus tard.
    const config = JSON.parse(readFileSync(join(root, 'mjs.config.json'), 'utf-8'))
    const bundler = new Bundler({ outputDir: join(root, config.outputDir), manifestPath: join(root, config.manifestPath) })
    const expectedUrl = `${bundler.urlPrefix}/bundle.js`

    assert.ok(joined.includes(expectedUrl),
      `le hint doit citer le chemin réel dérivé du scaffold (${expectedUrl}). sortie:\n${joined}`)
  })
})
