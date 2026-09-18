// Piège ASI : `(this ?? _mjsThis)` ouvre par une parenthèse. JavaScript n'insère PAS
// de point-virgule devant `(` — la ligne précédente et celle-ci se collent, et un
// appel fantôme apparaît. Plusieurs pages réelles en sont mortes avant le correctif.

import assert from 'node:assert/strict'
import { rebindDetachedThis } from '../src/generator/this-rebinding.js'

describe('rebindDetachedThis — ASI', () => {

  it('deux affectations consécutives : la 2e reste UNE instruction (pas un appel fantôme)', () => {
    const out = rebindDetachedThis(`let mount = function() {\n  this.game = build()\n  this.view = wrap(this.game)\n}`)
    assert.match(out, /build\(\)\s*\n\s*;\(this \?\? _mjsThis\)\.view/, 'le `;` de tête manque : `build()(this ?? …)` = TypeError')
  })

  it('le code réécrit s\'EXÉCUTE : deux membres posés, aucun appel fantôme', () => {
    const out = rebindDetachedThis(`let mount = function() {\n  this.a = build()\n  this.b = build()\n}`)
    const hote: any = {}
    let appels = 0
    const build = () => { appels++; return { ok: true } }
    new Function('_mjsThis', 'build', out + '\nmount.call(_mjsThis)')(hote, build)
    assert.equal(appels, 2, 'build appelé deux fois, jamais comme fonction retournée')
    assert.deepEqual([hote.a?.ok, hote.b?.ok], [true, true])
  })

  it('corps d\'un `if` SANS accolades : PAS de `;` de tête (il couperait la branche)', () => {
    const out = rebindDetachedThis(`let f = function(c) {\n  if (c) this.x = 1\n  return this.x\n}`)
    assert.doesNotMatch(out, /if \(c\) ;/, 'un `;` ici vide la branche et rend l\'affectation inconditionnelle')
    const vrai: any = {}, faux: any = {}
    const f1 = new Function('_mjsThis', out + '\nreturn f')(vrai)
    f1.call(vrai, true)
    const f2 = new Function('_mjsThis', out + '\nreturn f')(faux)
    f2.call(faux, false)
    assert.equal(vrai.x, 1)
    assert.equal(faux.x, undefined, 'la branche fausse ne doit RIEN écrire')
  })

  it('`this` qui n\'ouvre pas l\'instruction : pas de `;` parasite', () => {
    const out = rebindDetachedThis(`let f = function() {\n  let v = 1\n  return this.x + v\n}`)
    assert.doesNotMatch(out, /return ;/)
    assert.match(out, /return \(this \?\? _mjsThis\)\.x \+ v/)
  })
})
