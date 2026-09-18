// Test de régression — dans le fast path de `_mjs_invalidate`, struct DOIT
// tirer AVANT les effects. Sinon, si la var muée pilote un bloc `{key}` /
// `{if}` / `{for}`, l'effect `_mjs_updText` mute l'ANCIEN node (jeté juste après)
// et le FRESH node créé par struct reste vide.
//
// Cas vécu (tuto blocs-key) : `messages[$i] or ''` dans un `{key $i}`. Au
// mount, le `<p>` contient un text node t3 vide (car $i=-1). Le setInterval
// mute $i=0. Le fast path `_mjs_invalidate` faisait :
//   1) effects → _mjs_updText('t3', 'reticulating splines...') sur l'ANCIEN t3.
//   2) struct → _mjs_updKey crée NEW <p> avec NEW t3 vide. NEW t3 remplace
//      l'ancien dans this._mjs_nodes.
// L'animation `@in.typewriter` capture alors `text = node.textContent` du
// NEW <p>, qui est vide (juste whitespace) → l'anim joue '' vers ''.
//
// Fix : invalider le fast path → struct AVANT effects (cf. la microtask
// normale ligne ~1143 qui faisait déjà ça).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const elementSrc = readFileSync(join(here, '..', 'src', 'runtime', 'mjs_element.ts'), 'utf-8')

describe('runtime — _mjs_invalidate fast path : struct AVANT effects', function () {
  it('dans le fast path, _mjs_safeRenderStruct est appelé AVANT la boucle de tir des effects', function () {
    // On localise le fast path : c'est le bloc dans `_mjs_invalidate` qui contient
    // à la fois `_mjs_safeRenderStruct()` et la boucle `__list[__i].call(this)`.
    // On le délimite via les marqueurs `µ._mjs_inEffect = true` et `µ._mjs_inEffect = false`.
    const fastPath = elementSrc.match(
      /µ\._mjs_inEffect\s*=\s*true;[\s\S]*?µ\._mjs_inEffect\s*=\s*false;/
    )
    assert.ok(fastPath, 'fast path bloc retrouvé via µ._mjs_inEffect markers')

    const code = fastPath![0]
    const structIdx = code.indexOf('_mjs_safeRenderStruct()')
    const effectsIdx = code.indexOf('__list[__i].call(this)')
    assert.ok(structIdx > 0, `_mjs_safeRenderStruct() doit être présent dans le fast path. excerpt:\n${code.slice(0, 300)}`)
    assert.ok(effectsIdx > 0, `boucle __list[__i].call(this) doit être présente dans le fast path`)
    assert.ok(structIdx < effectsIdx,
      `_mjs_safeRenderStruct() (pos ${structIdx}) DOIT précéder la boucle d'effects (pos ${effectsIdx}) dans le fast path. ` +
      `Sinon les effects mutent des nodes jetés par struct au tick suivant.`)
  })
})
