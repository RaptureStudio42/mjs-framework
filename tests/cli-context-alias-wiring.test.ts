// Régression — 2 défauts liés au
// même bloc de cli.ts :
//
//   1. [MAJEUR] `contextAlias` était résolu depuis mjs.config.json
//      (`resolveBundlerOpts` → `cfgOpts.contextAlias`) mais jamais transmis
//      au `new Bundler({...})` construit par la CLI — option totalement
//      MORTE : un projet configurant `contextAlias: true` pour utiliser
//      `mjs.X` au lieu de `µ.X` continuait à générer l'alias par défaut, sans
//      AUCUNE erreur (silencieux).
//
//   2. [MINEUR, tsc pré-existant] le littéral de repli (utilisé quand aucun
//      mjs.config.json n'est trouvé) ne déclarait pas `contextAlias`/`preload`
//      — désynchronisé du type réel de `resolveBundlerOpts()`, faisant
//      échouer `tsc --noEmit`.
//
// Ces bugs sont purement structurels (wiring d'options, pas de logique
// profonde) — vérifiés par lecture de source ciblée plutôt que par
// l'exécution complète de la CLI (aucune infrastructure de test cli.ts
// n'existe encore dans ce dépôt, et en construire une pour CE fix précis
// serait disproportionné).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CLI_SRC = readFileSync(join(__dirname, '..', 'src', 'cli.ts'), 'utf-8')
const CONFIG_SRC = readFileSync(join(__dirname, '..', 'src', 'bundler', 'config.ts'), 'utf-8')

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

describe('cli.ts — contextAlias/runtimeDir/urlPrefix transmis au Bundler (option config → build réel)', function () {
  it("le littéral passé à `new Bundler({...})` inclut contextAlias: cfgOpts.contextAlias", function () {
    const bundlerCall = extractBalanced(CLI_SRC, /new Bundler\(\{/)
    assert.match(
      bundlerCall, /contextAlias:\s*cfgOpts\.contextAlias/,
      "AVANT le fix : contextAlias était résolu depuis mjs.config.json mais jamais transmis ici — option morte en CLI",
    )
  })

  it("le littéral passé à `new Bundler({...})` inclut runtimeDir et urlPrefix (même bug que contextAlias)", function () {
    const bundlerCall = extractBalanced(CLI_SRC, /new Bundler\(\{/)
    assert.match(bundlerCall, /runtimeDir:\s*cfgOpts\.runtimeDir/, "AVANT le fix : runtimeDir validé par KNOWN_KEYS mais jamais transmis, silencieusement ignoré")
    assert.match(bundlerCall, /urlPrefix:\s*cfgOpts\.urlPrefix/, "AVANT le fix : urlPrefix documenté mais jamais transmis")
  })

  it('le littéral de repli (pas de mjs.config.json trouvé) déclare TOUTES les clés que resolveBundlerOpts() retourne', function () {
    const resolveReturn = extractBalanced(CONFIG_SRC, /export function resolveBundlerOpts[^{]*\{[\s\S]*?return \(?\{/)
    const returnKeys = [...resolveReturn.matchAll(/^\s*(\w+):/gm)].map(m => m[1])
    assert.ok(returnKeys.length > 5, `au moins quelques clés attendues, trouvé : ${returnKeys.join(',')}`)

    // Littéral de repli FLAT (aucune accolade imbriquée) : un match direct
    // suffit, pas besoin de comptage d'accolades.
    const fallbackMatch = CLI_SRC.match(/: \{ sourceDir: undefined,[^}]*\}/)
    assert.ok(fallbackMatch, "littéral de repli introuvable (structure de cli.ts a changé ?)")
    const fallbackLiteral = fallbackMatch![0]
    for (const key of returnKeys) {
      assert.match(
        fallbackLiteral, new RegExp(`\\b${key}\\s*:`),
        `AVANT le fix : le littéral de repli ne déclarait pas '${key}' — désynchronisé du type réel de resolveBundlerOpts(), tsc --noEmit échouait`,
      )
    }
  })
})
