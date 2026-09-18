// cli-output-fichier : `checkWritablePath` laissait passer un
// `--output` qui est un FICHIER existant (`accessSync` réussit sur le fichier lui-même) —
// l'échec réel (`ENOTDIR`, à la première tentative d'écrire DEDANS) tombait dans le handler
// générique (cli.ts:~665), dont `FS_ERROR_CODES` ne listait ni `ENOTDIR` ni `EISDIR` : trace Node
// brute. `--output` doit désormais être un dossier ou ne pas exister (message catalogué AVANT
// toute compilation) ; `--output === --manifest` (même chemin résolu) refusé de la même façon ;
// `ENOTDIR`/`EISDIR` ajoutés à `FS_ERROR_CODES` en défense en profondeur (un chemin qui échapperait
// encore à ces deux gardes garde un message catalogué, jamais une stack brute).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureProject(): string {
  const root = mjsTmp('cli-output-fichier')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>Accueil</h1>`)
  return root
}

function run(args: string[]): { status: number | null; out: string; err: string } {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', ...args], { cwd: repoRoot, encoding: 'utf-8' })
  return { status: result.status, out: result.stdout, err: result.stderr }
}

describe("cli.ts — '--output' fichier existant / identique à '--manifest'", function () {
  this.timeout(40000)

  it('--output pointe vers un FICHIER déjà existant : code ≠ 0, message catalogué, AUCUNE trace Node brute (ENOTDIR)', () => {
    const projectRoot = fixtureProject()
    const outputFile = join(mjsTmp('cli-output-fichier-cible'), 'deja-un-fichier')
    mkdirSync(dirname(outputFile), { recursive: true })
    writeFileSync(outputFile, 'je suis un fichier, pas un dossier')

    const { status, err } = run(['build', '--root', projectRoot, '--output', outputFile])
    assert.notEqual(status, 0)
    assert.match(err, /outputDir/, `message catalogué nommant la clé attendu -> ${err}`)
    assert.match(err, /deja-un-fichier/, 'doit nommer le chemin fautif')
    assert.doesNotMatch(err, /ENOTDIR/, `AVANT le fix : trace Node brute (ENOTDIR) -> ${err}`)
    assert.doesNotMatch(err, /at readdirSync|at Bundler\./, `AVANT le fix : stack Node brute -> ${err}`)
  })

  it("--output et --manifest pointent vers le MÊME chemin : refusé, message catalogué (jamais d'écriture partielle)", () => {
    const projectRoot = fixtureProject()
    const same = join(mjsTmp('cli-output-identique'), 'meme-chemin')

    const { status, err } = run(['build', '--root', projectRoot, '--output', same, '--manifest', same])
    assert.notEqual(status, 0)
    assert.match(err, /--output et --manifest désignent le MÊME chemin/, `message catalogué attendu -> ${err}`)
    assert.doesNotMatch(err, /EISDIR/, `AVANT le fix : trace Node brute (EISDIR) -> ${err}`)
  })

  it('non-régression : --output vers un dossier normal (inexistant, inscriptible) reste vert', () => {
    const projectRoot = fixtureProject()
    const redirectDir = mjsTmp('cli-output-ok')
    const { status } = run(['build', '--root', projectRoot, '--output', join(redirectDir, 'out')])
    assert.equal(status, 0)
    assert.ok(existsSync(join(redirectDir, 'out')))
  })
})
