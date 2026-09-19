// `mjs --version` / `-v` n'existait PAS : le flag tombait dans le `else` final de `parseArgs`
// (« ⚠️ Flag inconnu ignoré »), puis `run()` enchaînait sur un BUILD complet. Sur un paquet
// public, c'est la première commande que tape un inconnu — elle répondait par un avertissement
// et une compilation non demandée.
//
// Test par VRAI SOUS-PROCESSUS (même motif que cli-unknown-flag-warning.test.ts) : `cli.ts`
// appelle `run(process.argv.slice(2))` à son top-level, sans garde `require.main` — l'importer
// depuis un fichier de test déclencherait une vraie exécution CLI avec les argv de Mocha.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'

const repoRoot        = join(dirname(fileURLToPath(import.meta.url)), '..')
const expectedVersion = JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf-8')).version as string

// binaire tsx du dépôt en chemin ABSOLU, pas `npx` : le dernier test tourne depuis un dossier
// VIDE, où npx n'aurait aucun node_modules à résoudre
function runCli(args: string[], cwd: string = repoRoot) {
  const tsx = join(repoRoot, 'node_modules', '.bin', 'tsx')
  return spawnSync(tsx, [join(repoRoot, 'src', 'cli.ts'), ...args], { cwd, encoding: 'utf-8', timeout: 60000 })
}

describe('cli.ts — `mjs --version` / `-v`', function () {
  this.timeout(60000)

  it('`--version` imprime la version du package.json et sort en 0', () => {
    const { stdout, stderr, status } = runCli(['--version'])
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.equal(stdout.trim(), `mjs ${expectedVersion}`)
    assert.doesNotMatch(stderr, /inconnu/i, 'AVANT : « Flag inconnu ignoré », puis un build')
  })

  it('`-v` fait exactement la même chose', () => {
    const { stdout, stderr, status } = runCli(['-v'])
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.equal(stdout.trim(), `mjs ${expectedVersion}`)
    assert.doesNotMatch(stderr, /inconnu/i)
  })

  it('répond depuis un dossier VIDE, sans mjs.config.json, et n\'y écrit RIEN', () => {
    const emptyDir = mjsTmp('version-dossier-vide')
    const { stdout, stderr, status } = runCli(['--version'], emptyDir)
    assert.equal(status, 0, `stderr:\n${stderr}`)
    assert.equal(stdout.trim(), `mjs ${expectedVersion}`)
    assert.deepEqual(readdirSync(emptyDir), [],
      'la version répond AVANT le chdir, la config et le Bundler — aucun fichier produit')
  })

  it('l\'USAGE annonce -v/--version et -h/--help', () => {
    const { stdout, status } = runCli(['--help'])
    assert.equal(status, 0)
    assert.match(stdout, /^\s+-v, --version\s+Affiche la version de mjs et sort$/m)
    assert.match(stdout, /^\s+-h, --help\s+Affiche cette aide et sort$/m)
  })
})
