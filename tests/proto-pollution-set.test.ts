// Régression SÉCURITÉ — proto-pollution.
//
// Vecteur : `<mjs-x {...$data}>` où `$data` provient d'un JSON réseau
// (`JSON.parse('{"__proto__":{...}}')` crée une own-prop énumérable
// `__proto__`). Le codegen spread itère `for (const k in o)` et appelle
// `node._set(k, v)` par entrée → `_set('__proto__', {...})`. Sans garde, le
// setter natif `__proto__` de `_state` change son [[Prototype]] → un `{$role}`
// lu via proto pollué renvoie la valeur injectée.
//
// Fix (mjs_element.ts) :
//   - `_set` : `if (!µ._mjs_safeKey(k)) return true` en tête (aligne sur le reste
//     du runtime — µ._mjs_deepSet/_mjs_guardPath, socket, vault).
//   - `_mjs_wrapDeep` set/deleteProperty traps : même garde (filet d'un alias
//     ÉCHAPPÉ `externalMerge($obj, untrusted)`).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

describe('sécurité — proto-pollution via _set / _mjs_wrapDeep (guards __proto__/constructor/prototype)', () => {
  let MjsTest: any
  let µ: any

  before(() => {
    const initJs = readFileSync(resolve('src/runtime/mjs_init.ts'), 'utf-8')
    const elemJs = readFileSync(resolve('src/runtime/mjs_element.ts'), 'utf-8')
    const sandbox = `
      class HTMLElement {
        constructor() {}
        attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
        addEventListener() {} removeEventListener() {} dispatchEvent() {}
        getAttribute() { return null }; setAttribute() {}
      }
      class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
      class Node {}
      class CSSStyleSheet { replaceSync() {} }
      const customElements = { get: () => null, define: () => {} };
      const document = { adoptedStyleSheets: [] };
      ${initJs.replace(/export\s*\{[^}]*\}/, '')}
      ${elemJs}
      class MjsTest extends µ.Element {
        constructor() {
          super();
          this._mjs_var_bits = { role: 1, box: 1 };
          this._invalidations = [];
        }
        _mjs_invalidate(k) { this._invalidations.push(k); }
      }
      return { µ, MjsTest };
    `
    // eslint-disable-next-line @typescript-eslint/no-implied-eval
    const out = new Function(sandbox)()
    MjsTest = out.MjsTest
    µ = out.µ
  })

  it('µ._mjs_safeKey bloque bien les 3 clés dangereuses (sanity)', () => {
    assert.equal(µ._mjs_safeKey('__proto__'), false)
    assert.equal(µ._mjs_safeKey('constructor'), false)
    assert.equal(µ._mjs_safeKey('prototype'), false)
    assert.equal(µ._mjs_safeKey('role'), true)
  })

  it('_set("__proto__", evil) ne change PAS le prototype de _state ni Object.prototype', () => {
    const el = new MjsTest()
    const protoBefore = Object.getPrototypeOf(el._state)
    el._set('__proto__', { injected: 'HACKED' })
    assert.equal(Object.getPrototypeOf(el._state), protoBefore, 'prototype de _state inchangé')
    assert.equal((el._state as any).injected, undefined, 'clé injectée non lisible sur _state')
    assert.equal(({} as any).injected, undefined, 'Object.prototype global non pollué')
    assert.deepEqual(el._invalidations, [], 'aucune notification (set court-circuité)')
  })

  it('_set("constructor" / "prototype", evil) sont aussi court-circuités', () => {
    const el = new MjsTest()
    el._set('constructor', { boom: 1 })
    el._set('prototype', { boom: 2 })
    assert.equal(el._state.constructor, Object, 'constructor de _state intact (Object)')
    assert.equal((el._state as any).prototype, undefined, 'aucune prop `prototype` injectée')
    assert.deepEqual(el._invalidations, [], 'aucune notification')
  })

  it('_set d\'une clé légitime fonctionne toujours (pas de régression)', () => {
    const el = new MjsTest()
    el._set('role', 'admin')
    assert.equal(el._state.role, 'admin')
    assert.deepEqual(el._invalidations, ['role'])
  })

  it('_mjs_wrapDeep set trap : `proxy.__proto__ = evil` sur un objet d\'état ne pollue pas', () => {
    const el = new MjsTest()
    const raw: any = { a: 1 }
    el._set('box', raw)
    const proxy: any = el._state.box
    const protoBefore = Object.getPrototypeOf(raw)
    // Alias échappé : du code externe fait `proxy.__proto__ = {...}`.
    proxy['__proto__'] = { injected: 'HACKED' }
    assert.equal(Object.getPrototypeOf(raw), protoBefore, 'prototype de l\'objet brut inchangé')
    assert.equal(raw.injected, undefined, 'clé injectée non présente')
    assert.equal(({} as any).injected, undefined, 'Object.prototype global non pollué')
    // Un set légitime via le proxy notifie toujours (pas de régression).
    el._invalidations = []
    proxy.a = 2
    assert.equal(raw.a, 2, 'mutation profonde légitime appliquée')
    assert.ok(el._invalidations.includes('box'), 'mutation profonde légitime notifiée')
  })

  it('_mjs_wrapDeep set trap : clé `constructor` aussi bloquée', () => {
    const el = new MjsTest()
    const raw: any = { a: 1 }
    el._set('box', raw)
    const proxy: any = el._state.box
    proxy['constructor'] = { boom: 1 }
    assert.equal(raw.constructor, Object, 'constructor de l\'objet brut intact')
  })
})
