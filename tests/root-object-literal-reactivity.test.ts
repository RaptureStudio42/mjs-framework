// Régression : `getEffectVars` (generator/
// state.ts) décomposait TOUTE expression contenant `{...}` en blocs séparés
// — pensé pour un TEMPLATE MIXTE (`"préfixe {$a} suffixe {$b}"`, où chaque
// `{...}` est syntaxiquement autonome une fois isolé). Un OBJET LITTÉRAL en
// argument d'appel, AU NIVEAU RACINE d'une interpolation (`{fmt($price,
// {currency:'EUR'})}`), se faisait extraire À TORT comme un bloc séparé :
// `[currency:'EUR', $price]` — INVALIDE en JS (un label n'est pas un élément
// de tableau) → `acorn.parse` échouait silencieusement → `$price` jamais
// détecté comme dépendance → l'effet finissait classé "mountOnly" (ne se
// re-déclenche JAMAIS quand `$price` mute).
//
// Fix : `getEffectVars` tente D'ABORD l'expression ENTIÈRE comme un bloc
// cohérent (`[${str}]` directement) ; ne tombe dans la décomposition que si
// CE parse échoue (cas mixte texte+sigil, toujours géré comme avant).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

describe('getEffectVars — objet littéral en argument, au niveau racine', function () {
  this.timeout(8000)

  it("{fmt($price, {currency:'EUR'})} : $price DOIT apparaître dans _mjs_effectsByVar (pas mountOnly)", async () => {
    const src = [
      '<script lang="coffee">',
      '$price = 10',
      "fmt = (p, opts) -> '' + p + ' ' + opts.currency",
      '</script>',
      "<p>{fmt($price, {currency:'EUR'})}</p>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rootobjlit-reg' })
    assert.match(
      output,
      /_mjs_effectsByVar\s*=\s*\{"price":/,
      "AVANT le fix : $price absent de _mjs_effectsByVar (acorn.parse échouait sur [currency:'EUR', $price], effet classé mountOnly)"
    )
  })

  it('{cx({active: $x})} (objet littéral, pattern classnames-style) : $x détecté', async () => {
    const src = [
      '<script lang="coffee">',
      '$x = true',
      "cx = (o) -> Object.keys(o).join(',')",
      '</script>',
      '<p>{cx({active: $x})}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rootobjlit-cx' })
    assert.match(output, /_mjs_effectsByVar\s*=\s*\{"x":/)
  })

  it('cas mixte texte+sigil (déjà correct avant) : pas de régression', async () => {
    const src = [
      '<script>$a = 1\n$b = 2</script>',
      '<p>prix: {$a} et {$b}</p>',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rootobjlit-mixed' })
    assert.match(output, /"a":/)
    assert.match(output, /"b":/)
  })

  it('objet littéral DANS un {for} (déjà correct — masqué par le re-render structurel) : pas de régression', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,price:5}]',
      "fmt = (p, opts) -> '' + p + opts.currency",
      '</script>',
      "<ul>{for row in $rows}<li>{fmt(row.price, {currency:'EUR'})}</li>{end}</ul>",
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rootobjlit-for' })
    assert.equal(output.length > 0, true)
  })
})
