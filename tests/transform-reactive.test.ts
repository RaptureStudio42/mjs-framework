// Tests de la transformation reactive ($.x = y → µ._set).

import assert from 'node:assert/strict'
import * as acorn from 'acorn'
import { transformReactiveWrites } from '../src/generator/transform-reactive.js'

describe('transformReactiveWrites', () => {

  it('transforme $.x = y en µ._set(this, "x", y)', () => {
    const out = transformReactiveWrites(`$.count = 5;`)
    assert.match(out, /µ\._set\(_mjsThis, 'count', 5\)/)
  })

  it('transforme $.x = expr complexe', () => {
    const out = transformReactiveWrites(`$.total = $.a + $.b * 2;`)
    assert.match(out, /µ\._set\(_mjsThis, 'total', \$\.a \+ \$\.b \* 2\)/)
  })

  it('ne touche PAS les lectures de $.x', () => {
    const out = transformReactiveWrites(`const x = $.count + 1;`)
    assert.match(out, /const x = \$\.count \+ 1/)
  })

  it('compound += devient µ._set avec addition', () => {
    const out = transformReactiveWrites(`$.count += 1;`)
    assert.match(out, /µ\._set\(_mjsThis, 'count', \$\.count \+ \(1\)\)/)
  })

  it('compound -= devient µ._set avec soustraction', () => {
    const out = transformReactiveWrites(`$.count -= 5;`)
    assert.match(out, /µ\._set\(_mjsThis, 'count', \$\.count - \(5\)\)/)
  })

  it('compound ??= devient µ._set conditionnel', () => {
    const out = transformReactiveWrites(`$.x ??= 'default';`)
    assert.match(out, /µ\._set\(_mjsThis, 'x', \$\.x \?\? \('default'\)\)/)
  })

  it('UpdateExpression $.x++ (post) preserve l\'ancienne valeur', () => {
    const out = transformReactiveWrites(`const old = $.count++;`)
    assert.match(out, /_v => \(µ\._set\(_mjsThis, 'count', _v \+ 1\), _v\)/)
  })

  it('UpdateExpression ++$.x (pre) retourne nouvelle valeur', () => {
    const out = transformReactiveWrites(`const fresh = ++$.count;`)
    assert.match(out, /\(µ\._set\(_mjsThis, 'count', \$\.count \+ 1\), \$\.count\)/)
  })

  // ASI — en position STATEMENT, la valeur de retour du `--` est
  // ignorée par définition : on émet la forme directe, qui n'ouvre pas sur une
  // parenthèse (le JS produit ne porte pas de `;` — une ligne commençant par
  // `(` était lue comme un APPEL de la ligne précédente). La forme fidèle
  // reste testée juste au-dessus, là où la valeur est réellement consommée.
  // Détail complet : tests/reactive-increment-asi.test.ts
  it('--$.count en STATEMENT : forme directe, aucune parenthèse ouvrante', () => {
    const out = transformReactiveWrites(`$.count--;`)
    assert.match(out, /µ\._set\(_mjsThis, 'count', \$\.count - 1\)/)
    assert.ok(!out.trimStart().startsWith('('), out)
  })

  it('--$.count avec valeur CONSOMMÉE : forme fidèle (ancienne valeur)', () => {
    const out = transformReactiveWrites(`const old = $.count--;`)
    assert.match(out, /_v => \(µ\._set\(_mjsThis, 'count', _v - 1\), _v\)/)
  })

  it('computed wrap `{ _mjs_c: true, f: ... }` devient _mjs_setComputed', () => {
    const src = `$.derived = { _mjs_c: true, f: () => $.count * 2 };`
    const out = transformReactiveWrites(src)
    assert.match(out, /µ\._mjs_setComputed\(_mjsThis, 'derived', \(\) => \$\.count \* 2\)/)
  })

  it('multiples assignations sur la même ligne', () => {
    const out = transformReactiveWrites(`$.a = 1; $.b = 2; $.c = 3;`)
    assert.match(out, /µ\._set\(_mjsThis, 'a', 1\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'b', 2\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'c', 3\)/)
  })

  // assignation en position EXPRESSION : `µ._set`
  // retourne TOUJOURS `true` → la valeur d'une chaîne d'assignation / d'un
  // argument devenait `true` (au lieu de la valeur assignée). En position
  // STATEMENT (valeur ignorée) on garde la forme directe la plus légère.
  it('assignation STATEMENT : forme directe (pas d\'IIFE)', () => {
    const out = transformReactiveWrites(`$.x = 5;`)
    assert.equal(out, `µ._set(_mjsThis, 'x', 5);`)
  })

  it('assignation CHAÎNÉE `$a = $b = v` : la valeur se propage (pas `true`)', () => {
    const out = transformReactiveWrites(`$.loading = $.error = false`)
    // exécution réelle : les DEUX doivent finir à false (avant : loading=true).
    const $: any = { loading: true, error: true }
    const µ: any = { _set: (o: any, k: string, v: any) => { o[k] = v; return true } }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('µ', '_mjsThis', '$', out)(µ, $, $)
    assert.equal($.error, false, 'error assigné directement')
    assert.equal($.loading, false, 'AVANT le fix : loading=true (valeur de retour de _set)')
  })

  it('assignation comme ARGUMENT `notify($x = 5)` : passe 5, pas `true`', () => {
    const out = transformReactiveWrites(`notify($.x = 5)`)
    let got: any
    const $: any = { x: 0 }
    const µ: any = { _set: (o: any, k: string, v: any) => { o[k] = v; return true } }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    new Function('µ', '_mjsThis', '$', 'notify', out)(µ, $, $, (v: any) => { got = v })
    assert.equal(got, 5, 'AVANT le fix : notify(true)')
    assert.equal($.x, 5, 'l\'effet de bord (assignation) a bien eu lieu')
  })

  it('ne touche pas les autres MemberExpression', () => {
    const out = transformReactiveWrites(`obj.foo = 1; this.bar = 2;`)
    assert.equal(out, `obj.foo = 1; this.bar = 2;`)
  })

  it('garde le code intact si pas de $. dedans', () => {
    const src = `const x = 1; foo(x);`
    assert.equal(transformReactiveWrites(src), src)
  })

  it('transforme dans une fonction', () => {
    const out = transformReactiveWrites(`function inc() { $.count = $.count + 1; }`)
    assert.match(out, /µ\._set\(_mjsThis, 'count', \$\.count \+ 1\)/)
  })

  it('skip gracieusement si JS invalide', () => {
    const src = `this is not js !!!`
    assert.equal(transformReactiveWrites(src), src)
  })

  // résidu de parenthèses fermantes : acorn ne
  // matérialise pas les parens du source en nœud AST, node.right reste borné
  // à l'expression réelle jamais aux parenthèses qui l'entourent ; les 3
  // chemins d'assignation fermaient par appendLeft SANS écraser ce résidu de
  // `)` → excès de fermantes dans le JS émis (build refusé, esm-check)
  describe('résidu de parenthèses fermantes (RHS parenthésé)', () => {
    it('assignation simple, RHS entre parenthèses (1 niveau)', () => {
      const out = transformReactiveWrites(`$.x = ($.a ? 1 : 2);`)
      assert.equal(out, `µ._set(_mjsThis, 'x', $.a ? 1 : 2);`)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('assignation simple, RHS double-parenthésé (2 niveaux) : même résultat', () => {
      const out = transformReactiveWrites(`$.x = (($.a ? 1 : 2));`)
      assert.equal(out, `µ._set(_mjsThis, 'x', $.a ? 1 : 2);`)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('chemin VALUE_CONSUMING (`notify(...)`), RHS parenthésé', () => {
      const out = transformReactiveWrites(`notify($.x = ($.a))`)
      assert.equal(out, `notify(((_v) => (µ._set(_mjsThis, 'x', _v), _v))($.a))`)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('compound `+=`, RHS parenthésé', () => {
      const out = transformReactiveWrites(`$.x += ($.a);`)
      assert.equal(out, `µ._set(_mjsThis, 'x', $.x + ($.a));`)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })

    it('dans une fonction, `return` (chemin direct, PAS value-consuming), RHS double-parenthésé', () => {
      const out = transformReactiveWrites(`function pick() { return $.x = (($.a ? $.b : $.c)) }`)
      assert.equal(out, `function pick() { return µ._set(_mjsThis, 'x', $.a ? $.b : $.c) }`)
      assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
    })
  })
})

describe('écriture par destructuration sur l\'état', () => {

  // une AssignmentExpression dont `left` est un
  // ArrayPattern/ObjectPattern échappait à la garde MemberExpression : l'état
  // s'écrivait NU dans `_state` (aucun `_set`, aucune invalidation), le DOM ne
  // bougeait jamais, zéro erreur. `[$.a, $.b] = [$.b, $.a]` (échange, forme
  // Civet `[$a, $b] = [$b, $a]`) est le cas d'usage réel.

  it('tableau : [$.a, $.b] = [$.b, $.a] émet les deux _set, forme void, parse OK', () => {
    const out = transformReactiveWrites(`[$.a, $.b] = [$.b, $.a];`)
    assert.match(out, /µ\._set\(_mjsThis, 'a', _mjsD0\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'b', _mjsD1\)/)
    assert.ok(out.startsWith('void ((_mjsR)'), out)
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('objet : ({a: $.a, b: $.b} = o) émet les deux _set, parse OK', () => {
    const out = transformReactiveWrites(`({a: $.a, b: $.b} = o);`)
    assert.match(out, /µ\._set\(_mjsThis, 'a', _mjsD0\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'b', _mjsD1\)/)
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('position VALEUR (return) : pas de void, la valeur du motif se propage', () => {
    const out = transformReactiveWrites(`function f() { return [$.a, $.b] = [$.b, $.a] }`)
    assert.ok(!out.includes('void ('), out)
    assert.match(out, /return _mjsR/)
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('motif mixte : seule la cible $.a est réécrite, `local` reste dans le motif', () => {
    const out = transformReactiveWrites(`[$.a, local] = pair;`)
    assert.match(out, /µ\._set\(_mjsThis, 'a', _mjsD0\)/)
    assert.match(out, /\[_mjsD0, local\] = _mjsR/)
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('motif sans état : sortie strictement identique à l\'entrée', () => {
    const src = `[a, b] = [b, a];`
    assert.equal(transformReactiveWrites(src), src)
  })

  it('imbrication + défaut + rest : les trois cibles sont réécrites, parse OK', () => {
    const out = transformReactiveWrites(`[[$.a], $.b = 1, ...$.rest] = xs;`)
    assert.match(out, /µ\._set\(_mjsThis, 'a', _mjsD0\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'b', _mjsD1\)/)
    assert.match(out, /µ\._set\(_mjsThis, 'rest', _mjsD2\)/)
    assert.doesNotThrow(() => acorn.parse(out, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('preuve d\'exécution : l\'échange [$.a, $.b] = [$.b, $.a] échange bien les valeurs via µ._set', () => {
    const out = transformReactiveWrites(`[$.a, $.b] = [$.b, $.a];`)
    const calls: [string, unknown][] = []
    const $: any = { a: 1, b: 2 }
    const µ: any = { _set: (_t: any, k: string, v: any) => { calls.push([k, v]); $[k] = v; return true } }
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const run = new Function('µ', '$', '_mjsThis', out + '; return $')
    run(µ, $, {})
    assert.equal($.a, 2)
    assert.equal($.b, 1)
    assert.deepEqual(calls, [['a', 2], ['b', 1]])
  })
})
