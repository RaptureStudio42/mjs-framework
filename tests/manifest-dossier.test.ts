// manifest-dossier — --manifest = dossier existant : `checkWritablePath` (cli.ts) n'appliquait `mustBeDir` qu'à `--output` ;
// `--manifest` pointant vers un dossier déjà présent passait la garde d'écriture puis explosait
// en PLEINE compilation (EISDIR Node brut, une partie de outputDir déjà écrite au moment du
// plantage — 2 fichiers réellement produits avant l'échec, constaté). Contrainte symétrique :
// `--manifest` DOIT être un fichier, refusé AVANT toute compilation si un dossier occupe déjà ce
// chemin, message catalogue nommant la clé et le chemin.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureProject(): string {
  const root = mjsTmp('e21-manifest-dossier')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>Accueil</h1>`)
  return root
}

describe("cli.ts — 'mjs build --manifest' vers un DOSSIER existant : message catalogue, jamais d'EISDIR brut, aucune écriture partielle", function () {
  this.timeout(40000)

  it('--manifest = dossier existant : code ≠ 0, message catalogue nommant la clé et le chemin, AUCUNE stack Node, outputDir jamais créé', () => {
    const projectRoot = fixtureProject()
    const manifestDir = join(projectRoot, 'manifest-est-un-dossier')
    mkdirSync(manifestDir, { recursive: true })
    const outputDir = join(projectRoot, 'out')
    const result = spawnSync('npx', [
      'tsx', 'src/cli.ts', 'build',
      '--root', projectRoot,
      '--output', outputDir,
      '--manifest', manifestDir,
      '--once',
    ], { cwd: repoRoot, encoding: 'utf-8' })

    assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
    assert.match(result.stderr, /manifestPath/, `doit nommer la clé -> ${result.stderr}`)
    assert.match(result.stderr, /manifest-est-un-dossier/, 'doit nommer le chemin fautif')
    assert.doesNotMatch(result.stderr, /EISDIR/, `AVANT le fix : EISDIR Node brut -> ${result.stderr}`)
    assert.doesNotMatch(result.stderr, /errno:/, "AVANT le fix : objet Error Node imprimé tel quel (errno/syscall/code)")
    assert.ok(!existsSync(outputDir), 'AVANT le fix : le build écrivait déjà des fichiers dans outputDir avant de tomber sur EISDIR — refusé AVANT toute compilation désormais')
  })

  it('non-régression : --manifest vers un FICHIER (chemin normal) reste vert', () => {
    const projectRoot = fixtureProject()
    const result = spawnSync('npx', [
      'tsx', 'src/cli.ts', 'build',
      '--root', projectRoot,
      '--manifest', join(projectRoot, 'out', 'bundle.js'),
      '--once',
    ], { cwd: repoRoot, encoding: 'utf-8' })
    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
    assert.ok(existsSync(join(projectRoot, 'out', 'bundle.js')))
  })
})
