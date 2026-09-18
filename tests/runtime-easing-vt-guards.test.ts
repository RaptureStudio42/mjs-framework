// 5 correctifs runtime SANS changement de contrat, un `describe`
// par item :
//   (a) mjs_easing.ts l.548-551 `_runSharedTransition` : la signature du @keyframes partagé
//       utilisait `easing.name || easing.toString().length` — `.name` vaut TOUJOURS '' (fonctions
//       posées par propriété, pas d'inférence de nom) et deux easings de MÊME longueur de source
//       (bounceIn/sineIn = 55 car., bounceInOut/circInOut = 155) collisionnent : la 2e transition
//       `.shared` rejoue l'easing de la 1re. Fix : `_hashStr(easing.toString())`.
//   (b) mjs_easing.ts l.534 (_runSharedTransition) et l.813 (_mjs_runTransition) : `steps: 0` fait
//       `i / 0 = NaN` → offsets NaN → `node.animate` lève (mode css) / CSS `NaN%` (mode shared).
//       Fix : `Math.max(1, …)` autour de la valeur résolue, aux DEUX endroits.
//   (c) mjs_vt_presets.ts l.415-427 `_mjs_vtCurtainRun` : `swap()` appelé sous le rideau noir sans
//       garde — une permutation qui lève laisse `#mjs-vt-curtain` à vie. Fix : try/catch autour du
//       seul `swap()`, la révélation continue comme avant.
//   (d) core-modules/radio.mjs l.14 : `sel = 'mjs-radio[name="' + $name + '"]'` construit par
//       concaténation — un `name` contenant `"` fait lever `querySelectorAll` (SyntaxError) dans
//       `@onChange`. Fix : échappement (`CSS.escape` ou repli regex).
//   (e) mjs_store.ts `_mjs_buildProxy` ET mjs_element.ts `_mjs_wrapDeep` : `Object.setPrototypeOf` et
//       `Object.defineProperty(…, '__proto__', …)` contournent les gardes `µ._mjs_safeKey` des traps
//       `set`/`deleteProperty`. Fix : traps `defineProperty`/`setPrototypeOf`
//       ajoutés aux DEUX endroits.
//
// Harnais calqué sur tests/runtime-dynamic-tag-script-refused.test.ts (fichiers runtime bruts, `new Function`,
// stub µ minimal) et tests/proto-pollution-set.test.ts (sandbox µ.Element pour _mjs_wrapDeep) —
// item (d) calqué sur tests/core-toggles.test.ts (bundler réel + happy-dom, seul chemin qui monte
// vraiment <mjs-radio> avec ses core-modules).
//
// Piège découvert en sondant (d) : `nativeInput.checked = true` seul lève DÉJÀ sous happy-dom (son
// PROPRE groupement natif de radios interne construit aussi un sélecteur `input[type="radio"]
// [name="…"]`, bug SANS RAPPORT avec radio.mjs) — AVANT même d'atteindre le code du composant.
// Contournement : `Object.defineProperty(native, 'checked', { value: true, … })` (bypass du setter
// natif, aucun effet de bord) puis un VRAI `dispatchEvent('change')`, qui route bien vers
// `@onChange` (délégation `_mjs_bindEvents`, mjs_element.ts) — reproduit alors exactement le
// `SyntaxError` de radio.mjs l.14. Confirmé aussi : une exception levée DANS un handler délégué ne
// remonte PAS au call-site de `dispatchEvent` (même isolation qu'un vrai navigateur) — on la
// détecte via `window.addEventListener('error', …)`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const easingSrc = readFileSync(join(__dirname, '../src/runtime/mjs_easing.ts'), 'utf8')
const vtSrc     = readFileSync(join(__dirname, '../src/runtime/mjs_vt_presets.ts'), 'utf8')
const storeSrc  = readFileSync(join(__dirname, '../src/runtime/mjs_store.ts'), 'utf8')
const elemSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_element.ts'), 'utf8')
const initSrc   = readFileSync(join(__dirname, '../src/runtime/mjs_init.ts'), 'utf8')

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// ============================================================================
// (a)(b) — harnais mjs_easing.ts (happy-dom : node.style/performance.now/addEventListener réels)
// ============================================================================

function makeEasing(): { µ: any; window: any; document: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const µ: any = { debug: false, log() {}, warn() {}, error() {} }
  new Function('µ', 'document', easingSrc)(µ, document)
  return { µ, window, document }
}

// Capte les noms de @keyframes acquis (µ.anim._mjs_acquireKeyframes) pour 2 transitions `.shared`
// dont seul l'easing diffère — restaure la fonction d'origine avant de rendre la main.
function sharedKeyframeNames(µ: any, document: any, easingA: Function, easingB: Function): string[] {
  const names: string[] = []
  const original = µ.anim._mjs_acquireKeyframes
  µ.anim._mjs_acquireKeyframes = (name: string, builder: any) => { names.push(name); return original(name, builder) }
  const nodeA: any = document.createElement('div')
  const nodeB: any = document.createElement('div')
  nodeA._mjs_anim_mode = 'shared'
  nodeB._mjs_anim_mode = 'shared'
  const cfgBase = { css: (t: number) => ({ opacity: String(t) }), duration: 300 }
  µ._mjs_runTransition(nodeA, { ...cfgBase, easing: easingA }, 'in')
  µ._mjs_runTransition(nodeB, { ...cfgBase, easing: easingB }, 'in')
  µ.anim._mjs_acquireKeyframes = original
  return names
}

describe('(a) — mjs_easing.ts _runSharedTransition : signature de @keyframes partagé (collision easing.name)', () => {
  it("sanity — easing.name vaut TOUJOURS '' (posé par propriété, pas d'inférence de nom)", () => {
    const { µ } = makeEasing()
    assert.equal(µ.easing.bounceIn.name, '')
    assert.equal(µ.easing.sineIn.name, '')
  })

  it('bounceIn vs sineIn (55 car. chacun, même longueur) : 2 noms de @keyframes DIFFÉRENTS', () => {
    const { µ, document } = makeEasing()
    const names = sharedKeyframeNames(µ, document, µ.easing.bounceIn, µ.easing.sineIn)
    assert.equal(names.length, 2, 'les 2 appels doivent avoir acquis un keyframes')
    assert.notEqual(names[0], names[1], "AVANT le fix : mêmes 55 caractères de source → même nom → la 2e transition rejoue l'easing de la 1re")
  })

  it('bounceInOut vs circInOut (155 car. chacun, même longueur) : 2 noms de @keyframes DIFFÉRENTS', () => {
    const { µ, document } = makeEasing()
    const names = sharedKeyframeNames(µ, document, µ.easing.bounceInOut, µ.easing.circInOut)
    assert.equal(names.length, 2)
    assert.notEqual(names[0], names[1], 'AVANT le fix : mêmes 155 caractères de source → même nom')
  })
})

describe('(b) — mjs_easing.ts steps:0 : offsets NaN (mode css l.813 ET mode shared l.534)', () => {
  it('mode css (_mjs_runTransition) : node.animate ne reçoit jamais de keyframe à offset NaN', async () => {
    const { µ, document } = makeEasing()
    const node: any = document.createElement('div')
    const calls: any[] = []
    // happy-dom n'implémente pas Element.prototype.animate (WAAPI) — mock minimal.
    node.animate = (kf: any) => { calls.push(kf); return { finished: Promise.resolve(), cancel() {}, effect: null } }
    const cfg = { css: (t: number) => ({ opacity: t }), steps: 0, duration: 10 }
    let threw: any = null
    try { await µ._mjs_runTransition(node, cfg, 'in') } catch (e) { threw = e }
    assert.equal(threw === null, true, 'aucune exception ne doit être levée pendant _mjs_runTransition')
    assert.ok(calls.length >= 2, "l'anim bidon anti-flash PUIS la vraie animation doivent avoir été posées")
    const real = calls[calls.length - 1]
    assert.ok(real.length >= 2, 'la vraie animation doit avoir au moins 2 keyframes (steps clampé à 1 minimum)')
    assert.equal(real.some((f: any) => Number.isNaN(f.offset)), false, "AVANT le fix : 0/0 = NaN → offset NaN sur l'unique keyframe produit")
  })

  it('mode shared (_runSharedTransition, buildKf) : le builder de keyframes ne produit jamais un offset NaN', () => {
    const { µ, document } = makeEasing()
    const node: any = document.createElement('div')
    node._mjs_anim_mode = 'shared'
    let built: any[] | null = null
    const original = µ.anim._mjs_acquireKeyframes
    µ.anim._mjs_acquireKeyframes = (_name: string, builder: any) => { built = builder(); return _name }
    const cfg = { css: (t: number) => ({ opacity: t }), steps: 0, duration: 10 }
    µ._mjs_runTransition(node, cfg, 'in')
    µ.anim._mjs_acquireKeyframes = original
    assert.ok(built, 'le builder doit avoir été invoqué')
    assert.ok((built as any[]).length >= 2, 'au moins 2 keyframes (steps clampé à 1 minimum)')
    assert.equal((built as any[]).some((f: any) => Number.isNaN(f.offset)), false, 'aucun offset NaN dans le builder du mode .shared')
  })
})

// ============================================================================
// (c) — harnais mjs_vt_presets.ts (happy-dom : document.body/head, requestAnimationFrame/setTimeout
// réels de la Window, pour que le double rAF + les 2 setTimeout internes tirent réellement)
// ============================================================================

function makeVt(): { µ: any; window: any; document: any; errorCalls: any[][] } {
  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const errorCalls: any[][] = []
  const µ: any = { _isServer: false, _csp: false, log() {}, warn() {}, error(...args: any[]) { errorCalls.push(args) } }
  new Function('µ', 'document', 'requestAnimationFrame', 'setTimeout', vtSrc)(µ, document, window.requestAnimationFrame.bind(window), window.setTimeout.bind(window))
  return { µ, window, document, errorCalls }
}

describe('(c) — mjs_vt_presets.ts _mjs_vtCurtainRun : swap() sans garde laisse le rideau à vie si la permutation lève', () => {
  it("swap() qui lève : le rideau #mjs-vt-curtain se retire quand même, µ.error averti une fois", async function () {
    this.timeout(3000)
    const { µ, document, errorCalls } = makeVt()
    const ok = µ._mjs_vtCurtainRun('iris', () => { throw new Error('boum') })
    assert.equal(ok, true, '_mjs_vtCurtainRun doit rendre true (rideau pris en charge)')
    // Piège Mocha × happy-dom : un NŒUD DOM passé à assert.equal/deepEqual
    // FIGE la suite sans message — on ne compare jamais que des booléens ici (!!node).
    assert.equal(!!document.getElementById('mjs-vt-curtain'), true, 'le rideau doit être posé juste après (phase couverture)')
    const wait = µ._mjs_vtCurtains.iris.coverMs + µ._mjs_vtCurtains.iris.revealMs + 200
    await new Promise(r => setTimeout(r, wait))
    assert.equal(!!document.getElementById('mjs-vt-curtain'), false, "AVANT le fix : le rideau reste à vie (swap() a levé, le reste du setTimeout ne s'exécute jamais)")
    assert.equal(errorCalls.length, 1, "µ.error doit avoir été averti UNE fois de l'échec de la permutation")
    assert.match(String(errorCalls[0][0]), /permutation sous rideau a levé/)
  })
})

// ============================================================================
// (d) — core-modules/radio.mjs, bundler réel (seul chemin qui monte <mjs-radio> avec ses
// core-modules, cf. tests/core-toggles.test.ts)
// ============================================================================

describe("(d) — core-modules/radio.mjs : sélecteur mjs-radio[name=…] non échappé", function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('name=\'a"b\' : cocher X ne lève pas, Y (préalablement coché) est décoché par la coordination de groupe', async () => {
    const root = mjsTmp('radio-quote')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), [
      '<form>',
      '  <@radio name=\'a"b\' value="x">X</@radio>',
      '  <@radio name=\'a"b\' value="y">Y</@radio>',
      '</form>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const pick = (re: RegExp) => { const f = files.find((f) => re.test(f)); assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`); return f! }
    const chunkFiles = [pick(/^mjs_core-/), pick(/^radio-/), pick(/^hote-/)]
    const code = chunkFiles.map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const windowErrors: any[] = []
    window.addEventListener('error', (e: any) => windowErrors.push(e))
    window.eval(`${code}\nglobalThis.µ = µ;`)
    document.body.innerHTML = '<mjs-hote></mjs-hote>'
    await new Promise((r) => setTimeout(r, 80))
    const hote: any = document.body.querySelector('mjs-hote')
    const form: any = hote._shadow.querySelector('form')
    const radios: any[] = Array.from(form.querySelectorAll('mjs-radio'))
    assert.equal(radios.length, 2, 'les 2 radios doivent être montées')
    const natives = radios.map((r) => r._shadow.querySelector('input.native'))

    // Limite de happy-dom (SANS RAPPORT avec radio.mjs), sondée : son parseur de sélecteur est
    // une regex naïve `"([^"]*)"` qui ignore l'échappement — un guillemet ÉCHAPPÉ dans une valeur
    // d'attribut entre guillemets (`[name="a\"b"]`, pourtant valide en CSS réel) lui reste
    // illisible, correctement échappé ou non. Repli TEST : si l'appel natif lève, réinterprète À
    // LA MAIN ce seul patron `tag[attr="valeur"]` (valeur pouvant contenir des `\x` échappés) —
    // vérifie le COMPORTEMENT de radio.mjs (échappement correct, round-trip), pas le moteur de
    // sélecteur de happy-dom. Un name mal échappé (AVANT le fix) ne matche pas ce patron : l'erreur
    // native d'origine est relevée telle quelle, le rouge reste un vrai rouge.
    const originalQSA = form.querySelectorAll.bind(form)
    form.querySelectorAll = (sel: string) => {
      try {
        return originalQSA(sel)
      } catch (err) {
        const m = /^([a-zA-Z][\w-]*)\[([\w-]+)="((?:\\.|[^"\\])*)"\]$/.exec(sel)
        if (!m) throw err
        const [, tag, attr, rawValue] = m
        const value = rawValue.replace(/\\(.)/g, '$1')
        return Array.from(originalQSA(tag)).filter((el: any) => el.getAttribute(attr) === value)
      }
    }

    radios[1]._set('checked', true)
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(radios[1]._state.checked, true, 'sanity — Y doit démarrer coché')

    // Contourne le setter natif `.checked` de happy-dom (AUTRE bug interne SANS RAPPORT, sondé —
    // son propre groupement de radios lève AVANT d'atteindre radio.mjs) : redéfinition directe
    // de la propriété plutôt qu'un appel au setter, puis un VRAI dispatchEvent('change').
    Object.defineProperty(natives[0], 'checked', { value: true, configurable: true, writable: true })
    let threw: any = null
    try {
      natives[0].dispatchEvent(new window.Event('change', { bubbles: true }))
    } catch (e) {
      threw = e
    }
    await new Promise((r) => setTimeout(r, 20))

    assert.equal(threw === null, true, 'dispatchEvent ne doit pas lever directement')
    assert.equal(windowErrors.length, 0, "AVANT le fix : SyntaxError sur 'mjs-radio[name=\"a\"b\"]' remonté via l'event 'error' de la fenêtre")
    assert.equal(radios[1]._state.checked, false, 'Y doit avoir été décoché par la coordination de groupe (@onChange)')
  })
})

// ============================================================================
// (e) — mjs_store.ts _mjs_buildProxy ET mjs_element.ts _mjs_wrapDeep : traps defineProperty/setPrototypeOf
// ============================================================================

function makeStore(): { µ: any; warnCalls: any[][] } {
  const warnCalls: any[][] = []
  const µ: any = {
    log() {}, error() {}, warn(...args: any[]) { warnCalls.push(args) },
    _mjs_rawSet: new Set(),
    _mjs_RAW: Symbol('mjs_raw'),
    _mjs_STRUCT: Symbol('mjs:struct'),
    _mjs_epochs: new WeakMap(),
    activeComponent: null,
  }
  µ._mjs_toRaw = function(o: any) { while (o != null && typeof o === 'object' && o[µ._mjs_RAW]) o = o[µ._mjs_RAW]; return o }
  µ._mjs_bumpEpoch = function(raw: any) { const e = (µ._mjs_epochs.get(raw) || 0) + 1; µ._mjs_epochs.set(raw, e); return e }
  µ._mjs_safeKey = function(k: any) { return k !== '__proto__' && k !== 'constructor' && k !== 'prototype' }
  new Function('µ', storeSrc)(µ)
  return { µ, warnCalls }
}

// Sandbox µ.Element calquée sur tests/proto-pollution-set.test.ts (charge mjs_init.ts +
// mjs_element.ts bruts dans un `new Function`, stubs DOM minimaux).
function makeElementSandbox(): { µ: any; MjsTest: any } {
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
    ${initSrc.replace(/export\s*\{[^}]*\}/, '')}
    ${elemSrc}
    class MjsTest extends µ.Element {
      constructor() {
        super();
        this._mjs_var_bits = { box: 1 };
        this._invalidations = [];
      }
      _mjs_invalidate(k) { this._invalidations.push(k); }
    }
    return { µ, MjsTest };
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(sandbox)()
}

// Les 4 assertions attendues, appliquées identiquement au proxy µ.Store et au proxy _mjs_wrapDeep.
function assertDefinePropertyAndSetPrototypeOfGuards(proxyLike: any, rawObj: any, label: string): void {
  assert.throws(() => Object.setPrototypeOf(proxyLike, { polluted: 1 }), TypeError, `${label} : setPrototypeOf doit lever TypeError`)
  assert.equal(proxyLike.polluted, undefined, `${label} : aucune clé polluée après setPrototypeOf`)
  assert.equal(Reflect.setPrototypeOf(proxyLike, { polluted: 2 }), false, `${label} : Reflect.setPrototypeOf doit rendre false`)

  assert.throws(() => Object.defineProperty(proxyLike, '__proto__', { value: { a: 1 }, configurable: true, writable: true, enumerable: true }), TypeError, `${label} : defineProperty('__proto__') doit lever TypeError`)
  assert.equal(({} as any).a, undefined, `${label} : Object.prototype global non pollué`)
  assert.equal(Object.getOwnPropertyNames(rawObj).includes('__proto__'), false, `${label} : l'objet brut ne doit pas porter une own-prop __proto__`)

  Object.defineProperty(proxyLike, 'ok', { value: 1, configurable: true, writable: true, enumerable: true })
  assert.equal(proxyLike.ok, 1, `${label} : une clé légitime passe toujours par defineProperty`)
}

describe('(e) — defineProperty/setPrototypeOf refusés (mjs_store.ts _mjs_buildProxy ET mjs_element.ts _mjs_wrapDeep)', () => {
  describe('µ.Store (_mjs_buildProxy, mjs_store.ts)', () => {
    it('setPrototypeOf / defineProperty(__proto__) refusés, clé légitime toujours acceptée', () => {
      const { µ } = makeStore()
      const s = new µ.Store({ a: 1 })
      const raw = µ._mjs_toRaw(s.data)
      assertDefinePropertyAndSetPrototypeOfGuards(s.data, raw, 'µ.Store')
    })

    it('non-régression — le trap `set` existant du store refuse toujours __proto__', () => {
      const { µ, warnCalls } = makeStore()
      const s = new µ.Store({ a: 1 })
      ;(s.data as any).__proto__ = { admin: true }
      assert.equal((s.data as any).admin, undefined)
      assert.ok(warnCalls.length >= 1)
    })
  })

  describe("état profond réactif d'un composant (_mjs_wrapDeep, mjs_element.ts)", () => {
    it('setPrototypeOf / defineProperty(__proto__) refusés, clé légitime toujours acceptée', () => {
      const { µ, MjsTest } = makeElementSandbox()
      const el: any = new MjsTest()
      const raw: any = { a: 1 }
      el._set('box', raw)
      const proxy = el._state.box
      assertDefinePropertyAndSetPrototypeOfGuards(proxy, raw, '_mjs_wrapDeep')
    })

    it('non-régression — le trap `set` existant de _mjs_wrapDeep refuse toujours __proto__', () => {
      const { µ, MjsTest } = makeElementSandbox()
      const el: any = new MjsTest()
      const raw: any = { a: 1 }
      el._set('box', raw)
      const proxy: any = el._state.box
      proxy['__proto__'] = { injected: 'HACKED' }
      assert.equal(raw.injected, undefined)
    })
  })
})
