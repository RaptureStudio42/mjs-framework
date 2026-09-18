// `i18n.default` jamais confronté aux langues RÉELLEMENT présentes dans
// sourceDir/i18n/ : un défaut sans dictionnaire compilait en silence (aucun avertissement),
// traductions absentes pour quiconque atterrit sur la langue par défaut. Avertissement SEUL (pas
// une erreur) : un projet sans AUCUN dictionnaire encore écrit doit rester silencieux.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function build(root: string): { status: number | null; out: string } {
  const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', root], { cwd: repoRoot, encoding: 'utf-8' })
  return { status: result.status, out: result.stdout + result.stderr }
}

describe("cli.ts — 'mjs build' : i18n.default sans dictionnaire réel avertit", function () {
  this.timeout(40000)

  it("i18n.default 'es' avec seul fr.yml présent : avertissement nommant 'es' et 'fr', build reste VERT", () => {
    const root = mjsTmp('cli-i18n-default-absent')
    mkdirSync(join(root, 'app', 'modularjs', 'i18n'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>x</h1>`)
    writeFileSync(join(root, 'app', 'modularjs', 'i18n', 'fr.yml'), `bonjour: "salut"\n`)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'public/modularjs', i18n: { default: 'es' },
    }, null, 2))

    const { status, out } = build(root)
    assert.equal(status, 0, `un i18n.default orphelin est un AVERTISSEMENT, pas une erreur -> ${out}`)
    assert.match(out, /i18n\.default/, `AVANT le fix : silence total -> ${out}`)
    assert.match(out, /es/)
    assert.match(out, /fr/)
  })

  it("i18n.default 'fr' avec fr.yml présent : AUCUN avertissement (non-régression)", () => {
    const root = mjsTmp('cli-i18n-default-present')
    mkdirSync(join(root, 'app', 'modularjs', 'i18n'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>x</h1>`)
    writeFileSync(join(root, 'app', 'modularjs', 'i18n', 'fr.yml'), `bonjour: "salut"\n`)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'public/modularjs', i18n: { default: 'fr' },
    }, null, 2))

    const { status, out } = build(root)
    assert.equal(status, 0)
    assert.doesNotMatch(out, /i18n\.default/)
  })

  it("i18n.default 'fr' SANS le moindre dossier i18n/ : silencieux (projet sans dictionnaire encore écrit)", () => {
    const root = mjsTmp('cli-i18n-default-sans-dossier')
    mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>x</h1>`)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'public/modularjs', i18n: { default: 'fr' },
    }, null, 2))

    const { status, out } = build(root)
    assert.equal(status, 0)
    assert.doesNotMatch(out, /i18n\.default/)
  })
})
