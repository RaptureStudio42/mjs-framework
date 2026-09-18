// Trouvaille latente — `mjs serve` (commande RÉELLEMENT
// implémentée, cli.ts case 'serve') était ABSENTE de la constante USAGE
// (section Commands) : `mjs --help` ne la listait jamais, alors que `init`/
// `build`/`dev`/`check`/`ws` y figurent tous. Un dev tapant `mjs --help` ne
// découvrait donc jamais l'existence de la commande.
//
// Test via un VRAI SOUS-PROCESSUS (même motif que cli-unknown-flag-warning.
// test.ts) : `cli.ts` exécute `run(process.argv.slice(2))` INCONDITIONNELLEMENT
// à son top-level — l'importer depuis un fichier de test déclencherait une
// VRAIE exécution CLI. `--help` garde le sous-processus rapide et sans effet
// de bord (affiche l'USAGE, sort avant tout Bundler/compile réel).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function runCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: repoRoot, encoding: 'utf-8' })
}

describe('cli.ts — USAGE (--help) liste bien `mjs serve`', function () {
  this.timeout(30000)

  it('`mjs --help` liste la commande serve, aux côtés de init/build/dev/check/ws', () => {
    const { stdout, status } = runCli(['--help'])
    assert.equal(status, 0)
    assert.match(stdout, /^\s+mjs serve\s+Sert le rendu SSR\/prérendu par requête/m,
      "AVANT le fix : `mjs serve` (commande pourtant implémentée, cli.ts case 'serve') était absente de l'USAGE")
    for (const cmd of ['init', 'build', 'dev', 'check', 'ws', 'serveur']) {
      assert.match(stdout, new RegExp(`^\\s+mjs ${cmd}\\s`, 'm'), `mjs ${cmd} doit rester listé (non-régression)`)
    }
  })
})
