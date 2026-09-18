// i18n-default-vide — `readI18nLanguages`
// (cli.ts) ne vérifiait que la PRÉSENCE du dictionnaire (fichier `<langue>.{yml,yaml,json}`
// trouvé par `readdirSync`) — un `fr.yml` VIDE (0 octet, ou `{}`) avec `i18n.default: 'fr'` comptait
// donc `fr` comme « langue trouvée », taisant l'avertissement juste après (aucune traduction réelle
// dedans). Le contenu est désormais chargé (YAML/JSON, mêmes formats que le bundler) : une langue
// SANS AUCUNE clé n'est plus comptée « présente » — cf. tests/cli-i18n-default-sans-dictionnaire.test.ts
// pour le comportement de base (fichier PRÉSENT et non vide), inchangé.

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

describe("cli.ts — 'mjs build' : i18n.default avec un dictionnaire PRÉSENT mais VIDE avertit", function () {
  this.timeout(40000)

  it("fr.yml à 0 octet, i18n.default:'fr' : avertissement (AVANT le fix : silence, 'fr' compté présent)", () => {
    const root = mjsTmp('i18n-vide-0octet')
    mkdirSync(join(root, 'app', 'modularjs', 'i18n'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>x</h1>`)
    writeFileSync(join(root, 'app', 'modularjs', 'i18n', 'fr.yml'), '')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'public/modularjs', i18n: { default: 'fr' },
    }, null, 2))

    const { status, out } = build(root)
    assert.equal(status, 0, `un dictionnaire vide reste un AVERTISSEMENT, pas une erreur -> ${out}`)
    assert.match(out, /i18n\.default/, `AVANT le fix : silence total -> ${out}`)
  })

  it("fr.yml contenant '{}' (objet vide), i18n.default:'fr' : avertissement", () => {
    const root = mjsTmp('i18n-vide-objet')
    mkdirSync(join(root, 'app', 'modularjs', 'i18n'), { recursive: true })
    writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `<h1>x</h1>`)
    writeFileSync(join(root, 'app', 'modularjs', 'i18n', 'fr.yml'), '{}\n')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'public/modularjs', i18n: { default: 'fr' },
    }, null, 2))

    const { status, out } = build(root)
    assert.equal(status, 0)
    assert.match(out, /i18n\.default/, `AVANT le fix : silence total -> ${out}`)
  })

  it("fr.yml avec au moins une clé, i18n.default:'fr' : AUCUN avertissement (non-régression)", () => {
    const root = mjsTmp('i18n-non-vide')
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
})
