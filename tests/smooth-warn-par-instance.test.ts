// avertissement échantillon non fini PAR INSTANCE (mjs_smooth.ts ~82-87) :
// `_smoothWarnedNonFinite` était une var de MODULE partagée entre TOUS les flux lissés — après un
// 1er avertissement, un 2e flux lissé DISTINCT recevant lui aussi un échantillon non fini restait
// silencieux À VIE. Modèle : tests/smooth-nonfinite.test.ts (sandbox new Function('µ',
// runtimeSrc)(µ)) — adapté ici pour capturer PLUSIEURS tâches (une par flux µ.smooth()).
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runtimeSrc = readFileSync(join(__dirname, '../src/runtime/mjs_smooth.ts'), 'utf8')

function makeMu(warnSpy?: (m: any) => void): { µ: any; tasks: any[] } {
  const tasks: any[] = []
  const µ: any = {
    state: (init: any) => Object.assign({}, init),
    warn: warnSpy || (() => {}),
    Ticker: { _mjs_tasks: new Set<any>(), add: (t: any) => { tasks.push(t); µ.Ticker._mjs_tasks.add(t) } },
  }
  new Function('µ', runtimeSrc)(µ)
  return { µ, tasks }
}

describe('µ.smooth — avertissement échantillon non fini PAR INSTANCE', () => {
  it('2 flux lissés DISTINCTS, chacun reçoit un échantillon non fini → CHACUN avertit une fois', () => {
    const warnings: any[] = []
    const { µ, tasks } = makeMu((m) => warnings.push(m))

    const source1: any = { a: { x: 0, y: 0 } }
    const out1 = µ.smooth(source1, { retard: 5 })
    const task1 = tasks[0]
    task1._mjs_step(0)
    source1.a = { x: Infinity, y: 1 }
    task1._mjs_step(10)
    assert.equal(warnings.length, 1, 'le 1er flux avertit bien une fois')

    const source2: any = { b: { x: 0, y: 0 } }
    const out2 = µ.smooth(source2, { retard: 5 })
    const task2 = tasks[1]
    task2._mjs_step(0)
    source2.b = { x: NaN, y: 1 }
    task2._mjs_step(10)
    assert.equal(warnings.length, 2, `PROUVÉ : le 2e flux, DISTINCT, avertit lui aussi une fois — warnings=${warnings.length} (AVANT le fix : restait à 1, silencieux à vie)`)

    out1.dispose(); out2.dispose()
  })

  it('un SEUL flux reçevant plusieurs échantillons non finis consécutifs : toujours une seule alerte (non-régression)', () => {
    const warnings: any[] = []
    const { µ, tasks } = makeMu((m) => warnings.push(m))
    const source: any = { a: { x: 0, y: 0 } }
    const out = µ.smooth(source, { retard: 5 })
    const task = tasks[0]
    task._mjs_step(0)
    for (let i = 1; i <= 5; i++) { source.a = { x: Infinity, y: i }; task._mjs_step(i * 10) }
    assert.equal(warnings.length, 1, `PROUVÉ : un seul µ.warn malgré 5 échantillons non finis sur le MÊME flux — warnings=${warnings.length}`)
    out.dispose()
  })
})
