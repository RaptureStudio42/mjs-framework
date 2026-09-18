// Test de régression : `cli.ts:107-129`
// (`parseArgs`) ignorait SILENCIEUSEMENT tout argument non reconnu — un flag
// mal orthographié (`--minify`, qui n'existe pas ; `--otuput` typo de
// `--output`) ou une commande mal tapée (`mjs buidl`) n'avait simplement
// AUCUN effet, sans le moindre avertissement. Le dev découvre le problème
// bien plus tard en constatant que l'option "n'a pour une raison inconnue"
// pas été appliquée.
//
// Fix : un `else` final dans la boucle de `parseArgs` avertit désormais sur
// tout token non reconnu (flag ou mot-clé), sans changer le comportement
// existant pour les flags valides (aucun faux positif).
//
// Test via un VRAI SOUS-PROCESSUS (`npx tsx src/cli.ts ...`), pas un import
// direct : `cli.ts` exécute `run(process.argv.slice(2))` INCONDITIONNELLEMENT
// à son top-level (pas de garde `require.main === module`) — l'importer
// depuis un fichier de test déclencherait une VRAIE exécution CLI avec les
// argv de Mocha. `--help` est utilisé pour garder le sous-processus rapide et
// sans effet de bord : `parseArgs` tourne entièrement (donc le warning est
// bien émis), puis `run()` affiche l'USAGE et sort avant tout `Bundler`/
// compile réel.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function runCli(args: string[]) {
  return spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: repoRoot, encoding: 'utf-8' })
}

describe('cli.ts — parseArgs avertit sur flag/argument inconnu', function () {
  this.timeout(30000)

  it('un flag inconnu (--minify, inexistant) déclenche un warning explicite', function () {
    const { stderr, status } = runCli(['--help', '--minify'])
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.match(stderr, /Flag inconnu ignoré.*--minify/,
      "AVANT le fix : --minify (ou toute autre typo de flag) était silencieusement ignoré, sans AUCUN warning")
  })

  it('un argument non reconnu (commande mal orthographiée) déclenche un warning', function () {
    const { stderr, status } = runCli(['--help', 'buidl'])
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.match(stderr, /Argument non reconnu ignoré.*buidl/)
  })

  it('les flags CONNUS ne déclenchent AUCUN warning (pas de faux positif)', function () {
    const { stderr, status } = runCli(['--help', '--port', '4000', '--once', '--root', '.'])
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.doesNotMatch(stderr, /ignoré/i, `aucun warning attendu pour des flags valides. stderr:\n${stderr}`)
  })
})
