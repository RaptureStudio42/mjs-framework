// Tests de l'intégration runtime — vérifie que `µ._set`/`_mjs_setComputed`
// fonctionnent comme attendu sans Proxy.
//
// On compile le runtime CoffeeScript en JS via le coffee adapter, puis
// on l'évalue dans un contexte minimal pour tester la sémantique réactive.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
describe('runtime µ._set / _mjs_setComputed', () => {
  let MjsTest: any
  let µ: any

  before(() => {
    // Le runtime est désormais en TS (transpilé depuis Coffee). Plain JS valide,
    // on lit directement le contenu pour l'évaluer dans le sandbox.
    const initPath = resolve('src/runtime/mjs_init.ts')
    const elemPath = resolve('src/runtime/mjs_element.ts')
    const initJs = readFileSync(initPath, 'utf-8')
    const elemJs = readFileSync(elemPath, 'utf-8')

    // Stub minimal du DOM HTMLElement / customElements pour exécuter en Node.
    // On fait un eval contrôlé qui évite les API DOM réelles.
    const sandbox = `
      class HTMLElement {
        constructor() {}
        attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
        addEventListener() {} removeEventListener() {} dispatchEvent() {}
        getAttribute() { return null }; setAttribute() {}
      }
      class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
      class CSSStyleSheet { replaceSync() {} }
      const customElements = { get: () => null, define: () => {} };
      const document = { adoptedStyleSheets: [] };
      ${initJs.replace(/export\s*\{[^}]*\}/, '')}
      ${elemJs}
      class MjsTest extends µ.Element {
        constructor() {
          super();
          this._mjs_var_bits = { count: 1, double: 1 };
          this._invalidations = [];
        }
        _mjs_invalidate(k) { this._invalidations.push(k); }
      }
      return { µ, MjsTest };
    `
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const fn = new Function(sandbox)
    const out = fn()
    MjsTest = out.MjsTest
    µ = out.µ
  })

  it('µ._set assigne et invalide', () => {
    const el = new MjsTest()
    µ._set(el, 'count', 5)
    assert.equal(el._state.count, 5)
    assert.deepEqual(el._invalidations, ['count'])
  })

  it('µ._set skip si valeur primitive identique', () => {
    const el = new MjsTest()
    µ._set(el, 'count', 5)
    el._invalidations = []
    µ._set(el, 'count', 5)  // même valeur
    assert.deepEqual(el._invalidations, [])
  })

  it('µ._set notifie sur changement primitive', () => {
    const el = new MjsTest()
    µ._set(el, 'count', 5)
    el._invalidations = []
    µ._set(el, 'count', 7)
    assert.deepEqual(el._invalidations, ['count'])
  })

  it('µ._mjs_setComputed installe un getter qui exécute fn à la lecture', () => {
    const el = new MjsTest()
    µ._set(el, 'count', 3)
    µ._mjs_setComputed(el, 'double', function () { return this.count * 2 })
    assert.equal(el._state.double, 6)
    µ._set(el, 'count', 5)
    assert.equal(el._state.double, 10)
  })

  it('détection de cycle dans _mjs_setComputed', () => {
    const el = new MjsTest()
    let warned = false
    const orig = console.warn
    console.warn = () => { warned = true }
    try {
      µ._mjs_setComputed(el, 'a', function () { return this.a + 1 })
      const _ = el._state.a // déclenche l'évaluation cyclique
      assert.equal(warned, true)
    } finally {
      console.warn = orig
    }
  })

  it('réassignation primitive override le computed', () => {
    const el = new MjsTest()
    µ._set(el, 'count', 3)
    µ._mjs_setComputed(el, 'double', function () { return this.count * 2 })
    assert.equal(el._state.double, 6)
    el._state.double = 99 // override via setter du getter computed
    assert.equal(el._state.double, 99)
  })

  it('plus de _mjs_proxyCache (suppression V2)', () => {
    const el = new MjsTest()
    assert.equal(el._mjs_proxyCache, undefined)
  })

  it('plus de _mjs_buildProxy (suppression V2)', () => {
    const el = new MjsTest()
    assert.equal(typeof el._mjs_buildProxy, 'undefined')
  })
})

describe('µ._mjs_lis (Longest Increasing Subsequence pour reorder)', () => {
  let µ: any

  before(() => {
    // Extrait la fonction `µ._mjs_lis = function(arr) { ... };` du source via regex
    // pour test isolé (évite le sandbox complet du runtime avec HTMLElement etc.).
    const initPath = resolve('src/runtime/mjs_init.ts')
    const src = readFileSync(initPath, 'utf-8')
    const m = src.match(/µ\._mjs_lis\s*=\s*function\s*\([^)]*\)\s*\{[\s\S]*?\n\};/)
    if (!m) throw new Error('Impossible d\'extraire µ._mjs_lis du source')
    const _lisFn = new Function(`${m[0]} return µ._mjs_lis;`.replace(/µ\._mjs_lis\s*=\s*/, 'const _mjs_lis = '))
    // eslint-disable-next-line no-new-func
    const factory = new Function('const µ = {}; ' + m[0] + '; return µ;')
    µ = factory()
  })

  it('liste vide retourne Set vide', () => {
    assert.equal(µ._mjs_lis([]).size, 0)
  })

  it('séquence déjà ordonnée : tous les indices restent', () => {
    const r = µ._mjs_lis([0, 1, 2, 3, 4])
    assert.equal(r.size, 5)
  })

  it('séquence inversée : 1 seul index retenu (le 1er)', () => {
    const r = µ._mjs_lis([4, 3, 2, 1, 0])
    assert.equal(r.size, 1)
  })

  it('swap au milieu : majoritairement stable', () => {
    // [0,1,2,3,4] → [0,2,1,3,4] : swap 1↔2. LIS = [0,1,3,4] (len 4)
    const r = µ._mjs_lis([0, 2, 1, 3, 4])
    assert.equal(r.size, 4)
  })

  it('reverse complet sur 10 items', () => {
    const r = µ._mjs_lis([9, 8, 7, 6, 5, 4, 3, 2, 1, 0])
    assert.equal(r.size, 1, 'reverse = 1 seul item dans LIS')
  })

  it('ignore les -1 (nouveaux items)', () => {
    // [0, -1, 1, -1, 2] : LIS = [0,1,2] aux indices 0, 2, 4
    const r = µ._mjs_lis([0, -1, 1, -1, 2])
    assert.equal(r.size, 3)
    assert.ok(r.has(0))
    assert.ok(r.has(2))
    assert.ok(r.has(4))
  })

  it('cas classique LIS [10, 22, 9, 33, 21, 50, 41, 60, 80] → len 6', () => {
    // LIS classique : longueur 6 (10, 22, 33, 50, 60, 80 par ex.)
    const r = µ._mjs_lis([10, 22, 9, 33, 21, 50, 41, 60, 80])
    assert.equal(r.size, 6)
  })
})
