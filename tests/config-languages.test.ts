// mjs.config.json — clé `languages`.
// La clé existe, se valide, et circule jusqu'au
// transpiler (`templateLang`, défaut 'civet' appliqué là-bas, point unique) —
// AUCUNE brique de compilation ne la consomme encore (handlers/interpolations
// en Civet : pas encore branchés). Ce test couvre : résolution/rétrocompat
// `defaultScriptLang` ↔ `languages.script`, validation stricte (objet/clé/
// valeur), et le câblage CLI (même piège que contextAlias/maxStateVars :
// résolu par resolveBundlerOpts() mais MORT si pas transmis à `new Bundler`).

import assert from 'node:assert/strict'
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_SRC = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8')

// même utilitaire que cli-context-alias-wiring.test.ts (comptage d'accolades) —
// extrait le contenu du littéral `new Bundler({...})` de cli.ts.
function extractBalanced(src: string, headRe: RegExp): string {
  const m = src.match(headRe)
  assert.ok(m, `motif introuvable : ${headRe}`)
  const start = m!.index! + m![0].length - 1 // position du '{' ouvrant
  let depth = 1, i = start + 1
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++
    else if (src[i] === '}') depth--
    i++
  }
  return src.slice(start, i)
}

// écrit un mjs.config.json dans un dossier temp frais, retourne le dossier.
function writeConfig(config: Record<string, unknown>): string {
  const root = mjsTmp('cfg-languages')
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify(config))
  return root
}

describe('mjs.config.json — clé `languages` (résolution + rétrocompat defaultScriptLang)', () => {
  it("(a) config sans languages → templateLang absent (undefined), défaut 'civet' appliqué côté transpiler seulement", () => {
    const root = writeConfig({})
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.templateLang, undefined)
    assert.equal(opts.defaultScriptLang, undefined)
  })

  it("(b) languages.template: 'js' est transmis tel quel (resolveBundlerOpts n'applique aucun défaut)", () => {
    const root = writeConfig({ languages: { template: 'js' } })
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.templateLang, 'js')
  })

  it("(c) languages.script: 'ts' prime et remplit le champ script (defaultScriptLang) des opts résolues", () => {
    const root = writeConfig({ languages: { script: 'ts' } })
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.defaultScriptLang, 'ts')
  })

  it("(d) defaultScriptLang: 'coffee' seul reste accepté (rétrocompat totale, sans languages)", () => {
    const root = writeConfig({ defaultScriptLang: 'coffee' })
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.defaultScriptLang, 'coffee')
  })

  it('(e) defaultScriptLang et languages.script posés ÉGAUX → OK, languages.script prime (même valeur au final)', () => {
    const root = writeConfig({ defaultScriptLang: 'civet', languages: { script: 'civet' } })
    const found = findConfig(root)
    assert.ok(found)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.defaultScriptLang, 'civet')
  })

  it('(f) defaultScriptLang et languages.script posés DIFFÉRENTS → throw (garde une seule des deux clés)', () => {
    const root = writeConfig({ defaultScriptLang: 'civet', languages: { script: 'ts' } })
    assert.throws(() => findConfig(root), /garde une seule des deux clés/)
  })

  it('(g) sous-clé inconnue dans languages → throw avec la liste des clés admises', () => {
    const root = writeConfig({ languages: { scriptz: 'civet' } })
    assert.throws(() => findConfig(root), /languages\.scriptz : clé inconnue[\s\S]*Clés valides : script, template/)
  })

  it("(h) languages.template: 'coffee' (valeur interdite pour template) → throw listant civet|js", () => {
    const root = writeConfig({ languages: { template: 'coffee' } })
    assert.throws(() => findConfig(root), /languages\.template invalide[\s\S]*Valeurs valides : civet, js/)
  })

  it('(i) languages non-objet → throw', () => {
    const root = writeConfig({ languages: 'civet' })
    assert.throws(() => findConfig(root), /'languages' doit être un objet/)
  })
})

describe('cli.ts — templateLang transmis au Bundler (même câblage que contextAlias/maxStateVars)', () => {
  it('le littéral passé à `new Bundler({...})` inclut templateLang: cfgOpts.templateLang', () => {
    const bundlerCall = extractBalanced(CLI_SRC, /new Bundler\(\{/)
    assert.match(
      bundlerCall, /templateLang:\s*cfgOpts\.templateLang/,
      'templateLang doit être transmis au Bundler construit par la CLI — sinon option MORTE, même piège que contextAlias/maxStateVars',
    )
  })

  it('le littéral de repli (pas de mjs.config.json trouvé) déclare templateLang', () => {
    const fallbackMatch = CLI_SRC.match(/: \{ sourceDir: undefined,[^}]*\}/)
    assert.ok(fallbackMatch, 'littéral de repli introuvable (structure de cli.ts a changé ?)')
    assert.match(
      fallbackMatch![0], /\btemplateLang\s*:/,
      'littéral de repli désynchronisé du type réel de resolveBundlerOpts() — tsc --noEmit échouerait',
    )
  })
})
