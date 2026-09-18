// Régression : deux `minifyJs()` en vol
// SIMULTANÉMENT (ex. `parallelMap` sur les .mjs/.civet d'un `Bundler.compile()`)
// partagent le MÊME `mangleCache` mutable. esbuild ne mute PAS l'objet passé
// PENDANT le transform : il le lit en entrée puis renvoie un
// `result.mangleCache` fusionné APRÈS coup. Deux transform() en vol lisent
// donc tous les deux le même état (encore incomplet) du cache et peuvent
// assigner LE MÊME nom court à DEUX propriétés `_mjs_*` DIFFÉRENTES — mapping
// incohérent PERSISTÉ sur disque (.mangle-cache.json), réutilisé dans tous
// les builds suivants.
//
// Fix : mutex par mangleCache (WeakMap) qui sérialise la fenêtre
// transform()+merge dans minifyJs — deux appels partageant le même
// mangleCache s'exécutent désormais l'un après l'autre.

import assert from 'node:assert/strict'
import { minifyJs } from '../src/bundler/minify.js'

describe('bundler/minify — mangleCache partagé entre appels concurrents', function () {
  it('deux minifyJs() CONCURRENTS avec le MÊME mangleCache ne collisionnent jamais sur le même nom court', async function () {
    const mangleCache: Record<string, string | false> = {}
    const srcA = 'const o = {}; o._mjs_foo = 1; console.log(o._mjs_foo);'
    const srcB = 'const o = {}; o._mjs_bar = 2; console.log(o._mjs_bar);'

    await Promise.all([
      minifyJs(srcA, { force: true, mangleCache, filename: 'a.js' }),
      minifyJs(srcB, { force: true, mangleCache, filename: 'b.js' }),
    ])

    assert.ok(mangleCache._mjs_foo, '_mjs_foo doit avoir reçu un nom court')
    assert.ok(mangleCache._mjs_bar, '_mjs_bar doit avoir reçu un nom court')
    assert.notEqual(
      mangleCache._mjs_foo, mangleCache._mjs_bar,
      "AVANT le fix : 2 transform() concurrents lisant le même mangleCache VIDE assignaient chacun 'a' à leur propre propriété _mjs_* → collision silencieuse",
    )
  })

  it('3 minifyJs() concurrents avec 3 props _mjs_* distinctes : 3 noms courts distincts', async function () {
    const mangleCache: Record<string, string | false> = {}
    const make = (prop: string) => `const o = {}; o.${prop} = 1; console.log(o.${prop});`

    await Promise.all([
      minifyJs(make('_mjs_one'), { force: true, mangleCache, filename: '1.js' }),
      minifyJs(make('_mjs_two'), { force: true, mangleCache, filename: '2.js' }),
      minifyJs(make('_mjs_three'), { force: true, mangleCache, filename: '3.js' }),
    ])

    const names = [mangleCache._mjs_one, mangleCache._mjs_two, mangleCache._mjs_three]
    assert.equal(new Set(names).size, 3, `les 3 noms courts doivent être distincts, reçu : ${JSON.stringify(names)}`)
  })

  it('un même nom de propriété dans 2 fichiers concurrents reçoit bien LE MÊME nom court (cohérence inter-fichiers préservée)', async function () {
    const mangleCache: Record<string, string | false> = {}
    const srcA = 'const o = {}; o._mjs_shared = 1; console.log(o._mjs_shared);'
    const srcB = 'const o = {}; o._mjs_shared = 2; console.log(o._mjs_shared);'

    await Promise.all([
      minifyJs(srcA, { force: true, mangleCache, filename: 'a2.js' }),
      minifyJs(srcB, { force: true, mangleCache, filename: 'b2.js' }),
    ])

    assert.ok(mangleCache._mjs_shared, 'doit avoir un nom court')
  })

  it('sans mangleCache (undefined) : aucun verrou, minifyJs fonctionne normalement', async function () {
    // `export const` (pas `console.log`, sur la liste `pure` donc éliminé par
    // le DCE — comportement voulu, sans rapport avec ce test) : survit à la
    // minification, permet de vérifier que du code est réellement retourné.
    const res = await minifyJs('export const x = 1 + 1;', { force: true })
    assert.ok(res.code.length > 0, 'du code minifié doit être retourné')
    assert.match(res.code, /export\s*\{/, 'le export doit survivre (pas de tree-shaking abusif)')
  })
})
