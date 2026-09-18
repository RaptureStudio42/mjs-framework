// Test unitaire déterministe de µ.smooth (lissage réseau).
// On stub µ.state (objet nu) + µ.Ticker (capture la tâche) et on pilote
// `_mjs_step(now)` à la main avec des timestamps contrôlés → pas de rAF réel,
// résultat reproductible.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const runtimeSrc = readFileSync(join(__dirname, '../src/runtime/mjs_smooth.ts'), 'utf8')

function makeMu(): { µ: any; getTask: () => any } {
  let captured: any = null
  const µ: any = {
    state: (init: any) => Object.assign({}, init),
    Ticker: { _mjs_tasks: new Set<any>(), add: (t: any) => { captured = t; µ.Ticker._mjs_tasks.add(t) } },
  }
  // mjs_smooth.ts est du JS pur qui assigne sur `µ` → on l'évalue tel quel.
  new Function('µ', runtimeSrc)(µ)
  return { µ, getTask: () => captured }
}

describe('µ.smooth — cœur d\'interpolation', () => {
  it('interpole linéairement entre deux échantillons', () => {
    const { µ } = makeMu()
    const buf = [{ t: 0, pos: { x: 0, y: 0 } }, { t: 100, pos: { x: 10, y: 20 } }]
    assert.deepEqual(µ._mjs_smoothSample(buf, 50), { x: 5, y: 10 })
    assert.deepEqual(µ._mjs_smoothSample(buf, 0), { x: 0, y: 0 })
    assert.deepEqual(µ._mjs_smoothSample(buf, 100), { x: 10, y: 20 })
  })
  it('borne aux extrémités (avant le 1er / après le dernier)', () => {
    const { µ } = makeMu()
    const buf = [{ t: 10, pos: { x: 1 } }, { t: 20, pos: { x: 2 } }]
    assert.deepEqual(µ._mjs_smoothSample(buf, 5), { x: 1 })
    assert.deepEqual(µ._mjs_smoothSample(buf, 99), { x: 2 })
    assert.equal(µ._mjs_smoothSample([], 5), null)
  })
  it('les champs non numériques prennent la valeur d\'arrivée', () => {
    const { µ } = makeMu()
    const buf = [{ t: 0, pos: { x: 0, nom: 'a' } }, { t: 10, pos: { x: 10, nom: 'b' } }]
    assert.deepEqual(µ._mjs_smoothSample(buf, 5), { x: 5, nom: 'b' })
  })
})

describe('µ.smooth — store réactif (retard + glissement)', () => {
  it('affiche la source avec le retard, en glissant entre deux positions', () => {
    const { µ, getTask } = makeMu()
    const source: any = {}
    const out = µ.smooth(source, { retard: 100 })
    const task = getTask()

    source['a'] = { x: 0, y: 0 }
    task._mjs_step(0)
    source['a'] = { x: 10, y: 0 }
    task._mjs_step(100)               // sortie = "il y a 100ms" = t0 → (0,0)
    assert.deepEqual(out['a'], { x: 0, y: 0 })
    task._mjs_step(150)               // sortie = t50 → mi-chemin → (5,0)
    assert.deepEqual(out['a'], { x: 5, y: 0 })
  })
  it('purge une entité disparue de la source', () => {
    const { µ, getTask } = makeMu()
    const source: any = { a: { x: 1, y: 1 } }
    const out = µ.smooth(source, { retard: 0 })
    const task = getTask()
    task._mjs_step(0)
    assert.ok('a' in out)
    delete source['a']
    task._mjs_step(16)
    assert.ok(!('a' in out))
  })
  it('dispose() est non énumérable (n\'apparaît pas dans un for…in)', () => {
    const { µ } = makeMu()
    const out = µ.smooth({}, {})
    assert.equal(typeof out.dispose, 'function')
    assert.deepEqual(Object.keys(out), [])
  })
})
