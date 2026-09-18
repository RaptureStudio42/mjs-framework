// `µ.smooth` (mjs_smooth.ts)
// n'avait AUCUN moyen de lier sa tâche `µ.Ticker` au cycle de vie d'un
// composant — contrairement à µspring/µ.interpolate qui s'arrêtent
// NATURELLEMENT en se stabilisant (`_mjs_step` retourne `false`, `µ.Ticker`
// retire la tâche lui-même), le `_mjs_step` de `µ.smooth` retourne TOUJOURS
// `true` (flux réseau continu par design, pas de notion de "stabilisé") →
// sans `.dispose()` explicite, la boucle rAF tourne À VIE, même si le
// composant qui a créé `$$fluide` est détruit depuis longtemps.
//
// Fix : nouvelle option `opts.owner` — si fournie (typiquement `this`/`@` du
// composant appelant), enregistre le dispose via `_mjs_onDestroy` (mjs_element.ts),
// l'API interne DÉJÀ prévue pour ce cas exact ("équivalent onCleanup de
// Solid"), déjà présente mais SANS AUCUN appelant avant ce fix. Sans `owner`
// (comportement pré-existant), rien ne change : dispose() reste manuel.
//
// Même technique que tests/smooth.test.ts (déjà établi, fonctionne bien) :
// `mjs_smooth.ts` est du JS pur assigné sur `µ` (pas un module ESM autonome)
// → `new Function('µ', source)(µ)`. `µ.Ticker` est un fake minimal (pas de
// vrai rAF), `_mjs_step` piloté à la main.

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
  new Function('µ', runtimeSrc)(µ)
  return { µ, getTask: () => captured }
}

function makeFakeOwner() {
  const cbs: Array<() => void> = []
  return {
    _mjs_onDestroy(fn: () => void) { cbs.push(fn); return fn },
    _destroyAll() { cbs.forEach(fn => fn()) }, // simule le teardown réel (disconnectedCallback)
  }
}

describe('µ.smooth — auto-dispose via opts.owner (fuite rAF à vie sinon)', function () {
  it("owner fourni : _mjs_onDestroy est appelé — détruire le owner dispose la tâche Ticker", function () {
    const { µ, getTask } = makeMu()
    const owner = makeFakeOwner()
    const source: any = { a: { x: 1, y: 1 } }

    const out = µ.smooth(source, { retard: 0, owner })
    const task = getTask()

    assert.equal(µ.Ticker._mjs_tasks.has(task), true, 'la tâche est bien active avant destruction du owner')
    task._mjs_step(0)
    assert.ok('a' in out, 'fonctionne normalement tant que le owner est vivant')

    // Simule la destruction RÉELLE du composant (disconnectedCallback → tous
    // les callbacks _mjs_onDestroy enregistrés sont invoqués).
    owner._destroyAll()

    assert.equal(
      µ.Ticker._mjs_tasks.has(task), false,
      "AVANT le fix : rien ne retirait la tâche du Ticker à la destruction du composant créateur → boucle rAF à vie",
    )

    // `_mjs_step` doit désormais refléter `live=false` (retourne false — cf.
    // mjs_smooth.ts ligne ~76 `if (!live) { return false; }`), même si un
    // appelant externe le rappelait malgré tout après coup.
    assert.equal(task._mjs_step(1000), false, "le flag `live` est bien retombé à false après dispose via owner")
  })

  it("sans owner (comportement pré-existant) : aucun _mjs_onDestroy n'est appelé, dispose() manuel toujours nécessaire", function () {
    const { µ, getTask } = makeMu()
    const source: any = {}
    const out = µ.smooth(source, { retard: 0 }) // pas de owner
    const task = getTask()

    assert.equal(µ.Ticker._mjs_tasks.has(task), true)
    // Rien ne dispose automatiquement — comportement inchangé.
    assert.equal(µ.Ticker._mjs_tasks.has(task), true, 'toujours actif (pas de owner = pas d\'auto-dispose, comme avant ce fix)')
    out.dispose()
    assert.equal(µ.Ticker._mjs_tasks.has(task), false, 'dispose() manuel fonctionne toujours (API pré-existante inchangée)')
  })

  it("owner fourni SANS _mjs_onDestroy (objet quelconque) : pas de crash, dégrade gracieusement vers le comportement manuel", function () {
    const { µ } = makeMu()
    const source: any = {}
    assert.doesNotThrow(() => µ.smooth(source, { retard: 0, owner: {} }))
    assert.doesNotThrow(() => µ.smooth(source, { retard: 0, owner: null }))
  })
})
