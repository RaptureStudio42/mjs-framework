// Test de régression : `mjs check`
// prétendait (commentaire source) faire une "compilation à blanc" (dry-run)
// pour juste vérifier la config et lister les composants — FAUX,
// `bundler.compile()` est le MÊME compile RÉEL que `mjs build` : il écrit
// tout autant les fichiers hashés + le manifest dans outputDir/manifestPath.
// Un dev qui lance `mjs check` en pensant faire une simple vérification
// READ-ONLY écrase en réalité sa sortie compilée sans le savoir.
//
// Fix : avertissement explicite avant de compiler (pas de dry-run
// implémenté — refactor disproportionné pour ce cas ; l'important est que
// l'utilisateur ne soit plus surpris par l'écriture réelle).
//
// Test via un VRAI SOUS-PROCESSUS (cli.ts exécute `run(process.argv)`
// inconditionnellement à son top-level, l'importer directement serait
// dangereux).

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

describe("cli.ts — 'mjs check' avertit qu'il compile réellement (pas un dry-run)", function () {
  this.timeout(20000)

  it("affiche un avertissement explicite ET écrit réellement les fichiers compilés", () => {
    const projectRoot = mjsTmp('check')
    mkdirSync(join(projectRoot, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(projectRoot, 'app', 'modularjs', 'hello.mjs'), '<p>hi</p>')

    const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'check', '--root', projectRoot], {
      cwd: repoRoot, encoding: 'utf-8',
    })

    assert.equal(result.status, 0, `stderr:\n${result.stderr}`)
    assert.match(result.stdout, /compile réellement/,
      "AVANT le fix : le commentaire source prétendait une compilation à blanc, mais AUCUN avertissement n'était affiché à l'utilisateur — surprise garantie en découvrant l'outputDir écrasé")

    const outFiles = readdirSync(join(projectRoot, 'public', 'modularjs'))
    assert.ok(outFiles.some(f => f.startsWith('hello-')),
      "confirme que 'check' écrit RÉELLEMENT les fichiers compilés (comportement pré-existant, maintenant honnêtement annoncé)")
  })
})
