// --output/--manifest acceptés sans validation ; un EACCES en écriture
// tombait tout en bas de cli.ts (handler générique), stack Node BRUTE (seule exception du
// fichier au catalogue). Le chemin cible est désormais vérifié (plus proche ancêtre EXISTANT
// accessible en écriture) AVANT toute compilation, message catalogue nommé.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, chmodSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureProject(): string {
  const root = mjsTmp('cli-output-validation')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>Accueil</h1>`)
  return root
}

describe("cli.ts — 'mjs build --output' vers un dossier NON INSCRIPTIBLE : message catalogue, jamais de stack brute", function () {
  this.timeout(40000)

  it('dossier existant mais en LECTURE SEULE : code ≠ 0, message catalogue nommant le chemin, AUCUNE stack Node', () => {
    const projectRoot = fixtureProject()
    const base = mjsTmp('cli-output-validation-readonly-base')
    const readonlyDir = join(base, 'interdit')
    mkdirSync(readonlyDir, { recursive: true })
    chmodSync(readonlyDir, 0o555)
    try {
      const result = spawnSync('npx', [
        'tsx', 'src/cli.ts', 'build',
        '--root', projectRoot,
        '--output', join(readonlyDir, 'out'),
      ], { cwd: repoRoot, encoding: 'utf-8' })

      assert.notEqual(result.status, 0, `stdout:\n${result.stdout}\nstderr:\n${result.stderr}`)
      assert.match(result.stderr, /outputDir/, `AVANT le fix : aucun message nommant la clé -> ${result.stderr}`)
      assert.match(result.stderr, /interdit/, 'doit nommer le chemin non inscriptible')
      assert.doesNotMatch(result.stderr, /at mkdirSync/, 'AVANT le fix : stack Node BRUTE (« at mkdirSync », « at Bundler.compile »…)')
      assert.doesNotMatch(result.stderr, /errno:/, 'AVANT le fix : objet Error Node imprimé tel quel (errno/syscall/code)')
    } finally {
      chmodSync(readonlyDir, 0o755)
    }
  })

  it('non-régression : --output vers un dossier normal (inscriptible) reste vert', () => {
    const projectRoot = fixtureProject()
    const redirectDir = mjsTmp('cli-output-validation-ok')
    const result = spawnSync('npx', [
      'tsx', 'src/cli.ts', 'build',
      '--root', projectRoot,
      '--output', join(redirectDir, 'out'),
    ], { cwd: repoRoot, encoding: 'utf-8' })
    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)
    assert.ok(existsSync(join(redirectDir, 'out')))
  })
})
