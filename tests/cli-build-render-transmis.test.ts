// `mjs build` doit transmettre le bloc `render` de mjs.config.json au compilateur : c'est lui qui
// décide si le module d'hydratation (`mjs_hydrate.ts`, modes `ssr:markers`/`ssr:positional`/
// `ssr:diff`) est joint au cœur. Résolu par resolveBundlerOpts() mais absent du littéral
// `new Bundler({...})` de cli.ts, il restait mort : le module manquait à toute construction faite
// par la CLI, alors que l'API le joignait — même piège structurel que `js`/`css`/`csp`.
//
// Test par un VRAI sous-processus (cli.ts exécute `run(process.argv)` à son chargement), sur une
// fixture minimale, construction de développement (le marqueur survit tel quel).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot        = join(dirname(fileURLToPath(import.meta.url)), '..')
const MARQUE_HYDRATE  = 'µ.Element.prototype._mjs_hydrateA = function'

function fixture(render: any): string {
  const root = mjsTmp('cli-render')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), '<script>\n$titre = \'Accueil\'\n</script>\n<h1 class="t">{$titre}</h1>\n')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'public/modularjs', render }, null, 2))
  return root
}

function construire(root: string): string {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], { cwd: repoRoot, encoding: 'utf-8' })
  assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
  const outDir   = join(root, 'public', 'modularjs')
  const coreFile = readdirSync(outDir).find(f => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe("cli.ts — 'mjs build' transmet le bloc render au compilateur", function () {
  this.timeout(60000)

  it("render.default: 'prerender' : le module d'hydratation est ABSENT du cœur", () => {
    const coeur = construire(fixture({ default: 'prerender', routes: { '/': { component: 'mjs-home' } } }))
    assert.equal(coeur.includes(MARQUE_HYDRATE), false)
  })

  it("render.default: 'ssr:markers' : le module d'hydratation est PRÉSENT dans le cœur", () => {
    const coeur = construire(fixture({ default: 'ssr:markers', routes: { '/': { component: 'mjs-home' } } }))
    assert.equal(coeur.includes(MARQUE_HYDRATE), true)
  })
})
