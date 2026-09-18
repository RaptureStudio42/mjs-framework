// un nombre réseau hors intervalle IEEE754 (`1e309`) traverse JSON.parse sans lever et devient
// `Infinity` — deux échantillons Infinity encadrant la cible affichée produisaient un NaN dans
// `_mjs_smoothLerp` (Infinity - Infinity), propagé tel quel dans le store réactif affiché à l'appli.
// `_mjs_smoothEq` traitait par ailleurs NaN comme « toujours différent » (`NaN !== NaN`),
// cassant la déduplication d'échantillons (churn de tampon).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runtimeSrc = readFileSync(join(__dirname, '../src/runtime/mjs_smooth.ts'), 'utf8')

function makeMu(warnSpy?: (m: any) => void): { µ: any; getTask: () => any } {
  let captured: any = null
  const µ: any = {
    state: (init: any) => Object.assign({}, init),
    warn: warnSpy || (() => {}),
    Ticker: { _mjs_tasks: new Set<any>(), add: (t: any) => { captured = t; µ.Ticker._mjs_tasks.add(t) } },
  }
  new Function('µ', runtimeSrc)(µ)
  return { µ, getTask: () => captured }
}

// ============================================================================================
// _mjs_smoothEq : Object.is au lieu de !==
// ============================================================================================

describe('µ._mjs_smoothEq — Object.is (NaN reconnu « identique »)', () => {
  it('_mjs_smoothEq({x:NaN},{x:NaN}) → true (AVANT le fix : false, cassait la déduplication)', () => {
    const { µ } = makeMu()
    assert.equal(µ._mjs_smoothEq({ x: NaN }, { x: NaN }), true)
  })

  it('_mjs_smoothEq inchangé sur des valeurs finies normales (non-régression)', () => {
    const { µ } = makeMu()
    assert.equal(µ._mjs_smoothEq({ x: 1, y: 2 }, { x: 1, y: 2 }), true)
    assert.equal(µ._mjs_smoothEq({ x: 1 }, { x: 2 }), false)
  })

  it('+0/-0 : Object.is les distingue (comportement JS standard, assumé)', () => {
    const { µ } = makeMu()
    assert.equal(µ._mjs_smoothEq({ x: 0 }, { x: -0 }), false)
  })
})

// ============================================================================================
// échantillon non fini jamais retenu dans le tampon (Infinity/NaN)
// ============================================================================================

describe('µ.smooth — échantillon non fini (Infinity/NaN) jamais retenu, averti une fois', () => {
  it("JSON.parse('{\"x\":1e309}').x devient Infinity — rappel du terrain (ne teste rien du fichier, juste le contexte)", () => {
    assert.equal(JSON.parse('{"x":1e309}').x, Infinity)
  })

  it('2 échantillons Infinity consécutifs encadrant la cible → jamais de NaN dans le store affiché (AVANT le fix : NaN)', () => {
    const { µ, getTask } = makeMu()
    const source: any = { a: { x: 0, y: 0 } }
    const out = µ.smooth(source, { retard: 5 })
    const task = getTask()
    task._mjs_step(0)
    source.a = JSON.parse('{"x":1e309,"y":1}')   // delta réseau extrême → Infinity
    task._mjs_step(10)
    source.a = { x: Infinity, y: 2 }              // 2e échantillon Infinity encadre la cible
    task._mjs_step(20)
    assert.ok(!Number.isNaN(out.a.x), `PROUVÉ : plus de NaN dans le store affiché — out.a=${JSON.stringify(out.a)}`)
    assert.equal(out.a.x, 0, "les 2 échantillons Infinity filtrés à l'entrée : la dernière position FINIE connue reste affichée telle quelle")
    out.dispose()
  })

  it('µ.warn appelé UNE SEULE fois malgré plusieurs échantillons non finis consécutifs', () => {
    const warnings: any[] = []
    const { µ, getTask } = makeMu((m) => warnings.push(m))
    const source: any = { a: { x: 0, y: 0 } }
    µ.smooth(source, { retard: 5 })
    const task = getTask()
    task._mjs_step(0)
    for (let i = 1; i <= 5; i++) { source.a = { x: Infinity, y: i }; task._mjs_step(i * 10) }
    assert.equal(warnings.length, 1, `PROUVÉ : un seul µ.warn malgré 5 échantillons non finis — warnings=${warnings.length}`)
  })

  it('un champ NaN isolé (pas Infinity) est également écarté (isFinite(NaN) === false)', () => {
    const { µ, getTask } = makeMu()
    const source: any = { a: { x: 0, y: 0 } }
    const out = µ.smooth(source, { retard: 5 })
    const task = getTask()
    task._mjs_step(0)
    source.a = { x: NaN, y: 3 }
    task._mjs_step(10)
    assert.ok(!Number.isNaN(out.a.x), `l'échantillon NaN ne doit jamais entrer dans le tampon — out.a=${JSON.stringify(out.a)}`)
    out.dispose()
  })

  it('un échantillon fini APRÈS un échantillon non fini reprend un lissage normal (le tampon repart proprement)', () => {
    const { µ, getTask } = makeMu()
    const source: any = { a: { x: 0, y: 0 } }
    const out = µ.smooth(source, { retard: 5 })
    const task = getTask()
    task._mjs_step(0)
    source.a = { x: Infinity, y: 1 }
    task._mjs_step(10)
    source.a = { x: 42, y: 2 }
    task._mjs_step(30)
    task._mjs_step(200)   // « now » bien au-delà de retard+dernier échantillon → cible EXACTE, plus d'interpolation
    assert.equal(out.a.x, 42, `l'échantillon fini qui suit doit être affiché normalement — out.a=${JSON.stringify(out.a)}`)
    out.dispose()
  })
})
