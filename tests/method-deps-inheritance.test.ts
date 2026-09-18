// Bogue observé dans un projet réel — `{@fmt()}` dans le gabarit, `@fmt` lit `$prix` :
// `$prix` change, l'écran ne bougeait pas (les lectures d'une méthode APPELÉE n'entraient dans
// aucune machinerie de dépendances). Correctif : elles entrent dans resolveSnippetDeps (template)
// ET dans annotateEffectDeps (µeffect qui appelle une méthode) — CHANGEMENT DE COMPORTEMENT VOULU
// ET ACTÉ : des gabarits qui appelaient des méthodes se mettent à se re-rendre.
//
// Harnais léger (comme tests/transpiler.test.ts) : transpile() + inspection de l'`output` — pas
// besoin de monter un vrai DOM pour vérifier QUELLES clés sont câblées dans _mjs_effectsByVar / le
// littéral de deps de µ.effect(...).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

/** Objet `_mjs_effectsByVar = {...}` extrait tel quel du JS émis (chaîne, pas parsé). */
function effectsByVarChunk(output: string): string {
  const m = output.match(/_mjs_effectsByVar\s*=\s*(\{[^;]*\})/)
  assert.ok(m, `_mjs_effectsByVar introuvable dans le JS émis :\n${output}`)
  return m![1]
}

/** Un des tableaux littéraux de chaînes (`["a", "b"]`) présents dans le JS émis contient-il
 * TOUTES les clés demandées ? Sert à retrouver le 2e argument de µ.effect(cb, [...]) sans avoir
 * à reconstruire la syntaxe exacte de l'appel (corps de callback multi-lignes, formatage…). */
function someArrayLiteralContainsAll(output: string, keys: string[]): boolean {
  const arrays = output.match(/\[\s*"[^"]*"(?:\s*,\s*"[^"]*")*\s*\]/g) ?? []
  return arrays.some(a => keys.every(k => a.includes(`"${k}"`)))
}

describe('méthodes appelées — héritage des lectures (template + µeffect)', () => {

  it('a. {@fmt()} avec @fmt lisant $prix ET $devise → les deux câblées dans _mjs_effectsByVar', async () => {
    const src = '<script>\n$prix = 10\n$devise = \'EUR\'\n@fmt = ->\n  $prix + \' \' + $devise\n</script>\n<p>{@fmt()}</p>'
    const { output } = await transpile(src, { moduleName: 'method-deps-basic' })
    const chunk = effectsByVarChunk(output)
    assert.match(chunk, /"prix"/)
    assert.match(chunk, /"devise"/)
  })

  it('b. chaîné : @a appelle @b, @b lit $x, {@a()} → "x" câblé', async () => {
    const src = '<script>\n$x = 1\n@b = ->\n  $x + 1\n@a = ->\n  @b()\n</script>\n<p>{@a()}</p>'
    const { output } = await transpile(src, { moduleName: 'method-deps-chained' })
    const chunk = effectsByVarChunk(output)
    assert.match(chunk, /"x"/)
  })

  it('c. µeffect qui appelle @fmt → le littéral de deps de µ.effect(...) contient prix ET devise', async () => {
    const src = '<script>\n$prix = 10\n$devise = \'EUR\'\n@fmt = ->\n  $prix + \' \' + $devise\nµeffect ->\n  @fmt()\n</script>\n<p>ok</p>'
    const { output } = await transpile(src, { moduleName: 'method-deps-effect' })
    assert.ok(
      someArrayLiteralContainsAll(output, ['prix', 'devise']),
      `attendu un tableau de deps contenant "prix" ET "devise" dans :\n${output}`,
    )
  })

  it('d. µeffect qui ÉCRIT $n et appelle une méthode qui LIT $n → warning effet-lit-écrit', async () => {
    const src = '<script>\n$n = 0\n@lireN = ->\n  $n\nµeffect ->\n  $n = 1\n  @lireN()\n</script>\n<p>{$n}</p>'
    const orig = console.warn
    let warned = false
    console.warn = (...a: any[]) => { if (String(a[0]).includes('boucle réactive')) warned = true }
    try {
      await transpile(src, { moduleName: 'method-deps-warn' })
    } finally {
      console.warn = orig
    }
    assert.equal(warned, true, 'le warning doit tenir compte de la lecture HÉRITÉE de @lireN')
  })

  it('e. opt-out : méthode lisant via `µread $prix` → PAS câblée (accès brut, non réactif)', async () => {
    const src = '<script>\n$prix = 10\n@fmt = ->\n  µread $prix\n</script>\n<p>{@fmt()}</p>'
    const { output } = await transpile(src, { moduleName: 'method-deps-optout' })
    const chunk = effectsByVarChunk(output)
    assert.doesNotMatch(chunk, /"prix"/, 'µread compile en µ._stateRaw.prix — invisible par construction')
  })
})
