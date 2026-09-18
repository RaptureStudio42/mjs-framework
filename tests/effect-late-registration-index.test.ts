// Régression : `_mjs_varHasUserEffect`
// (mjs_element) MÉMOÏSE `_mjs_userEffectVars` au 1er accès et ne le recalcule jamais.
// Un `µ.effect` enregistré APRÈS (hook `µmount`, ou effet créé depuis un autre
// effet) n'entrait donc jamais dans l'index → l'ultra fast-path no-op de
// `_mjs_invalidate` concluait « aucun effet ne lit cette var » et l'effet tardif ne
// se déclenchait JAMAIS. Fix (mjs_runes `µ.effect`) : invalider `_mjs_userEffectVars`
// (`= undefined`) à chaque enregistrement → il est reconstruit (incluant le
// nouvel effet) au prochain `_mjs_varHasUserEffect`.
//
// Reproduction DÉTERMINISTE (indépendante des aléas du chemin de mount) : on
// force la mémoïsation à la main (`el._mjs_varHasUserEffect('a')`), PUIS on enregistre
// un effet tardif lisant une var `$b` NON rendue (aucun binding/struct → sans le
// fix, le fast-path no-op l'ignore), PUIS on mute `$b`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('µ.effect — un effet enregistré TARDIVEMENT entre bien dans l\'index', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('un µeffect lisant $b, enregistré APRÈS la mémoïsation, se déclenche quand $b change', async () => {
    // $b est déclaré mais JAMAIS rendu → aucun binding/struct sur 'b' : sa seule
    // raison de re-render est un effet utilisateur qui le lit.
    const src = [
      '<script lang="coffee">',
      '$a = 0',
      '$b = 0',
      'µeffect ->',
      '  _ = $a',
      '  return',
      '</script>',
      '<p class="o">{$a}</p>',
    ].join('\n')

    const root = mjsTmp('latefx')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'latefx.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^latefx-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-latefx></mjs-latefx>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))
    const µ: any = win.eval('µ')

    // 1. Forcer la mémoïsation de `_mjs_userEffectVars` (à partir du SEUL effet
    //    d'init, qui lit 'a') → l'index vaut {'a'}, 'b' n'y est pas.
    el._mjs_varHasUserEffect('a')
    assert.ok(el._mjs_userEffectVars && el._mjs_userEffectVars.has && el._mjs_userEffectVars.has('a'),
      'sanity : après le 1er accès, _mjs_userEffectVars est mémoïsé et contient a')
    assert.equal(el._mjs_userEffectVars.has('b'), false, 'sanity : b n\'est pas encore dans l\'index')

    // 2. Enregistrer un effet TARDIF lisant $b (précomputedVars ['b']). Les
    //    effets sont appelés `fn()` sans `this` → on ferme sur `el` (comme le
    //    code compilé qui capture le composant dans sa closure).
    µ._mjs_pushComponent(el)
    µ.effect(function () { el.__lateRuns = (el.__lateRuns || 0) + 1 }, ['b'])
    µ._mjs_popComponent()

    // Le fix invalide l'index à l'enregistrement.
    assert.equal(el._mjs_userEffectVars, undefined,
      'AVANT le fix : _mjs_userEffectVars restait figé à {a} — l\'effet tardif n\'y entrait jamais')

    // 3. Muter $b → l'effet tardif DOIT tourner (sinon fast-path no-op).
    assert.equal(el.__lateRuns, undefined, 'pas encore exécuté avant la mutation')
    el._set('b', 1)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(el.__lateRuns, 1,
      'AVANT le fix : $b change mais l\'effet tardif ne fire jamais (index périmé → no-op)')

    // Régression inverse : muter $a fait toujours tourner l\'effet d\'init (pas cassé).
    el._set('b', 2)
    await new Promise(r => setTimeout(r, 40))
    assert.equal(el.__lateRuns, 2, 'une 2e mutation de $b re-déclenche l\'effet tardif')

    win.close?.()
  })
})
