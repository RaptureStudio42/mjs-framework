// piège des branches — l'auto-déclaration `.=` de Pass 4 (transpiler/index.ts,
// applyCivetDialectSugar) posait la déclaration là où tombait la PREMIÈRE
// affectation, même si cette ligne est plus profonde que le corps de sa
// portée (dans une branche if/else/for/switch/when — qui ne poussent pas de
// portée). Symptôme :
//   if ok            →  if ok
//     onFailed = 1        onFailed .= 1   ← `let` SCOPÉ au bloc if
//   else                else
//     onFailed = 2        onFailed = 2    ← ReferenceError (var inexistante)
// Fix : `bodyIndent`/`insertAt` mémorisent où commence le corps de chaque
// portée ; une affectation plus profonde (ou un `if`/`unless` POSTFIX) est
// HISSÉE en tête de portée (`nom .= undefined`) au lieu d'être déclarée sur
// place — les branches restent des affectations NUES.

import assert from 'node:assert/strict'
import { applyMjsSugarToScript } from '../src/transpiler/index.js'

describe('applyMjsSugarToScript — hissage de la déclaration hors branche (piège des branches)', () => {
  it('top-level if/else : hisse en tête, branches nues', () => {
    const input = [
      'if ok',
      '  onFailed = 1',
      'else',
      '  onFailed = 2',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'onFailed .= undefined',
      'if ok',
      '  onFailed = 1',
      'else',
      '  onFailed = 2',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('dans une méthode : hisse en tête du corps (indent du corps), branches nues', () => {
    const input = [
      '@go = ->',
      '  if ok',
      '    a = 1',
      '  else',
      '    a = 2',
      '  a',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      '@go = ->',
      '  a .= undefined',
      '  if ok',
      '    a = 1',
      '  else',
      '    a = 2',
      '  a',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('if…then EN LIGNE : hisse en tête, ligne inline inchangée', () => {
    const input = [
      'if ok then x = 1',
      'x',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'x .= undefined',
      'if ok then x = 1',
      'x',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('postfix if : hisse en tête, ligne inchangée', () => {
    const input = 'x = 1 if ok'
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'x .= undefined',
      'x = 1 if ok',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('if-EXPRESSION préfixe : comportement historique inchangé, aucune insertion', () => {
    const input = 'x = if ok then 1 else 2'
    const out = applyMjsSugarToScript(input, 'civet')
    assert.equal(out, 'x .= if ok then 1 else 2')
  })

  it('switch/when/else : hisse en tête', () => {
    const input = [
      'switch v',
      '  when 1',
      "    y = 'a'",
      '  else',
      "    y = 'b'",
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'y .= undefined',
      'switch v',
      '  when 1',
      "    y = 'a'",
      '  else',
      "    y = 'b'",
    ].join('\n')
    assert.equal(out, expected)
  })

  it('destructuring en branche : hisse CHAQUE nom, ligne destructurante nue', () => {
    const input = [
      'if ok',
      '  { a, b } = f()',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'a .= undefined',
      'b .= undefined',
      'if ok',
      '  { a, b } = f()',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('déjà déclarée AVANT la branche : aucune insertion, branche nue', () => {
    const input = [
      'x .= 0',
      'if ok',
      '  x = 1',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    assert.equal(out, input)
  })

  it('template literal multi-ligne inerte : intouché, aucune insertion', () => {
    const input = [
      'msg = `hello',
      'foo = bar',
      'world`',
    ].join('\n')
    const out = applyMjsSugarToScript(input, 'civet')
    const expected = [
      'msg .= `hello',
      'foo = bar',
      'world`',
    ].join('\n')
    assert.equal(out, expected)
  })

  it('non-régression : affectation top-level simple, `.=` en place, aucune insertion', () => {
    const out = applyMjsSugarToScript('x = 1', 'civet')
    assert.equal(out, 'x .= 1')
  })
})
