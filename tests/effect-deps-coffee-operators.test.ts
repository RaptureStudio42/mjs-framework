// Test de régression — getEffectVars doit reconnaître les deps dans des
// expressions Coffee/Civet contenant `or` / `and` / `not` / `is`.
//
// Bug vécu (tuto blocs-key) : `messages[$i] or ''` était stockée telle quelle
// dans batchVarsCache → acorn.parse échoue silencieusement (`or` n'est pas
// du JS valide) → analyzeSnippet retourne `[]` → l'effect `_mjs_updText` finit
// en `mountOnly` au lieu d'être re-fired sur mutation de `$.i`.
// → Le texte interpolé restait figé sur sa valeur initiale (`''` car $i=-1).
//
// Fix : `getEffectVars` passe le snippet par `cleanJs` après `tokenize` pour
// que les idiomes Coffee soient convertis en JS standard avant l'AST parse.
// Bonus : reset `mountOnlyEffects` entre pre-pass et real pass.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'
import { compile } from '../src/generator/index.js'
import { Analyzer } from '../src/analyzer/index.js'

describe('compile — getEffectVars supporte les opérateurs Coffee/Civet', function () {
  it('`messages[$i] or ""` enregistre l\'effect dans effectsByVar.i (pas mountOnly)', function () {
    const html = `{key $i}<p>{messages[$i] or ''}</p>{end}`
    const script = `var $i = -1; var messages = ['a', 'b'];`
    const a = new Analyzer(script, [])
    a.autoDeclareFromTemplate(html)
    const [, , , , effectsByVar, , mountOnlyEffects] = compile(html, { analyzer: a })

    assert.ok(effectsByVar.has('i'),
      `effectsByVar doit contenir une entrée pour 'i'. effectsByVar=${JSON.stringify([...effectsByVar])}`)
    const iEffects = effectsByVar.get('i')!
    assert.equal(iEffects.length, 1, '1 effect text doit être tracké pour i')
    assert.match(iEffects[0], /_mjs_updText\('t\d+',\s*messages\[\$\.i\]\s*\|\|\s*''\)/,
      `l'effect doit être le _mjs_updText avec messages[$.i] || ''. got: ${iEffects[0]}`)
    assert.equal(mountOnlyEffects.length, 0,
      `aucun effect ne doit être mountOnly (sinon il ne re-tire pas à mutation de $.i). got: ${JSON.stringify(mountOnlyEffects)}`)
  })

  it('`$a and $b` track les deux deps', function () {
    const html = `<div>{$a and $b}</div>`
    const a = new Analyzer('', [])
    a.autoDeclareFromTemplate('{$a}{$b}')
    const [, , , , effectsByVar] = compile(html, { analyzer: a })
    assert.ok(effectsByVar.has('a'), `dep 'a' attendue`)
    assert.ok(effectsByVar.has('b'), `dep 'b' attendue`)
  })

  it('`not $cond` track la dep `cond`', function () {
    const html = `<div>{not $cond}</div>`
    const a = new Analyzer('', [])
    a.autoDeclareFromTemplate('{$cond}')
    const [, , , , effectsByVar] = compile(html, { analyzer: a })
    assert.ok(effectsByVar.has('cond'), `dep 'cond' attendue`)
  })
})

describe('compile — interpolation dans {key} re-fire sur mutation de la dep', function () {
  it('le bundle complet enregistre l\'effect t* dans effectsByVar.i', async function () {
    const src = `<script lang="coffee">
$i = -1
messages = ['x', 'y']
</script>
{key $i}<p>{messages[$i] or ''}</p>{end}`
    const r = await transpile(src, { moduleName: 'dbg' })
    const out = r.output
    // _mjs_effectsByVar doit référencer un index de _mjs_eff pour 'i'.
    assert.match(out, /_mjs_effectsByVar\s*=\s*\{\s*"i"\s*:\s*\[\s*_mjs_eff\[\d+\]\s*\]\s*\}/,
      `_mjs_effectsByVar doit pointer vers un effect pour 'i'. bundle excerpt:\n${
        out.match(/_mjs_effectsByVar[\s\S]{0,200}/)?.[0] ?? '(not found)'
      }`)
  })
})
