// le codegen du spread `<div {...expr}>` émettait
// `const o = <expr>` — si `expr` référence une variable nommée `o` (item de boucle
// `{for o in …}`, ou var locale `o`), on obtenait littéralement `const o = o` dans
// une closure d'effet exécutée au mount → `ReferenceError: Cannot access 'o' before
// initialization` (TDZ). Même famille de bug que pour `startNode` ailleurs dans le compilateur. Corrigé en
// renommant le binding interne du spread en `_mjs_spd` (préfixe réservé).

import assert from 'node:assert/strict'
import { transpile } from '../src/index.js'

describe('spread {...o} — pas de collision TDZ sur le binding interne', () => {
  it('{for o in $options}<div {...o}> ne génère jamais `const o = o`', async () => {
    const r = await transpile('{for o in $options}<div {...o}>x</div>{end}', { moduleName: 't', defaultScriptLang: 'js' })
    assert.ok(!/\bconst o = o\b/.test(r.output), 'ne doit pas émettre `const o = o` (crash TDZ au mount)')
    assert.ok(r.output.includes('_mjs_spd'), 'le binding interne du spread doit être le nom réservé _mjs_spd')
  })

  it('spread d\'une expression membre `{...o.props}` reste correct', async () => {
    const r = await transpile('{for o in $rows}<div {...o.props}>x</div>{end}', { moduleName: 't', defaultScriptLang: 'js' })
    assert.ok(!/\bconst o = o\b/.test(r.output))
    assert.ok(r.output.includes('_mjs_spd = o.props') || r.output.includes('_mjs_spd=o.props'),
      'le RHS utilisateur (o.props) est préservé, seul le binding est renommé')
  })
})

// Même fil-rouge : les temps internes __v / __s du texte interpolé / @html / @class
// (compile.ts, attributes/index.ts) émettaient `const __v = __v` pour un item `{for}`
// nommé `__v`/`__s` → TDZ. Renommés en _mjs_tv / _mjs_ts (préfixe réservé).
describe('temps internes __v/__s — pas de collision TDZ', () => {
  it('{for __v in $items}{__v} ne génère pas `const __v = __v`', async () => {
    const r = await transpile('{for __v in $items}<span>{__v}</span>{end}', { moduleName: 't', defaultScriptLang: 'js' })
    assert.ok(!/\bconst __v = __v\b/.test(r.output), 'texte interpolé : pas de collision')
  })
  it('{for __v in $items}<div @class{on}={__v}> ne collisionne pas', async () => {
    const r = await transpile('{for __v in $items}<div @class{on}={__v}>x</div>{end}', { moduleName: 't', defaultScriptLang: 'js' })
    assert.ok(!/\bconst __v = !!\(__v\)/.test(r.output), '@class : pas de collision')
  })
})
