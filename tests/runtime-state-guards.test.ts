// Cœur réactif : un `describe` par point.
//
// µderived + await : correctif dans src/lexer/index.ts (RE_MU_DERIVED_STMT) —
// voir `describe` dédié en fin de fichier.
// µ._mjs_deepDelete ignorait µraw (symétrique de µ._mjs_deepSet/µ._mjs_deepCall) : correctif dans
// src/runtime/mjs_init.ts, juste après `_mjs_deepCall`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'
import { getAdapter } from '../src/languages/index.js'
import { tokenize } from '../src/lexer/index.js'

// copie de tests/state-collection-reactivity.test.ts:16-40 (recette de montage imposée).
async function mount(name: string, source: string) {
  const root = mjsTmp(`state-guards-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el, document }
}

// Variante : patche `µ.warn` APRÈS l'enregistrement du custom element mais AVANT
// son instanciation (`innerHTML`), pour capturer les avertissements émis au montage —
// `µminmax` s'appelle au setup du `<script>`, donc à la connexion de l'élément.
async function mountCapturingWarn(name: string, source: string) {
  const root = mjsTmp(`state-guards-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')))
  window.eval('globalThis.µ = µ; globalThis.__mjsWarnCalls = []; var __origWarn = µ.warn; µ.warn = function(...a) { globalThis.__mjsWarnCalls.push(String(a[0])); return __origWarn.apply(µ, a); };')
  window.eval(stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')))
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  const warnCalls: string[] = window.__mjsWarnCalls
  return { window, el, document, warnCalls }
}

describe('µ.state() : écriture DIRECTE sur une collection (Array) notifie', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('arr.length=0, arr[0]=99, arr[10]=\'x\' et delete arr[10] notifient tous', async () => {
    const src = [
      '<script>',
      '@st = µstate({arr: [1, 2, 3]})',
      '</script>',
      '<p class="len">{@st.arr.length}</p>',
      '<p class="i0">{@st.arr[0]}</p>',
      '<p class="i10">{@st.arr[10]}</p>',
    ].join('\n')
    const { el } = await mount('rawidxarr', src)
    const len = () => el._shadow.querySelector('.len').textContent.trim()
    const i0 = () => el._shadow.querySelector('.i0').textContent.trim()
    const i10 = () => el._shadow.querySelector('.i10').textContent.trim()

    assert.equal(len(), '3', 'longueur initiale')
    assert.equal(i0(), '1', 'index 0 initial')

    el.st.arr.length = 0
    await new Promise(r => setTimeout(r, 60))
    assert.equal(len(), '0', 'AVANT le fix : `arr.length=0` mutait le brut sans notifier → figé à 3')

    el.st.arr[0] = 99
    await new Promise(r => setTimeout(r, 60))
    assert.equal(i0(), '99', 'AVANT le fix : `arr[0]=99` mutait le brut sans notifier')
    assert.equal(len(), '1', 'écrire un index sur un tableau vide relève sa longueur (natif)')

    el.st.arr[10] = 'x'
    await new Promise(r => setTimeout(r, 60))
    assert.equal(i10(), 'x', '`arr[10]=x` doit notifier')
    assert.equal(len(), '11', 'longueur relevée à 11 (index 10 + 1)')

    delete el.st.arr[10]
    await new Promise(r => setTimeout(r, 60))
    assert.equal(i10(), '', '`delete arr[10]` doit notifier (retour à undefined affiché vide)')
    assert.equal(len(), '11', 'delete ne raccourcit pas un Array (trou), longueur inchangée')
  })

  it('témoins non-régression : push/sort (mutateurs déjà notifiants) restent corrects', async () => {
    const src = [
      '<script>',
      '@st = µstate({arr: [3, 1, 2]})',
      '</script>',
      '<p class="len">{@st.arr.length}</p>',
      '<p class="i0">{@st.arr[0]}</p>',
    ].join('\n')
    const { el } = await mount('rawidxwitness', src)
    const len = () => el._shadow.querySelector('.len').textContent.trim()
    const i0 = () => el._shadow.querySelector('.i0').textContent.trim()

    el.st.arr.push(4)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(len(), '4', 'push doit toujours notifier (non-régression)')

    el.st.arr.sort()
    await new Promise(r => setTimeout(r, 60))
    assert.equal(i0(), '1', 'sort doit toujours notifier (non-régression, [3,1,2,4] triés → 1 en tête)')
  })

  // Singleton µ$$X (bâti sur µ.state, mêmes traps `coll`) : PAS de test monté séparé.
  // `mount()` (ci-dessus, copié de state-collection-reactivity.test.ts) charge un SEUL
  // fichier composant compilé (`stripEsm` retire toute ligne `import`/`export`) — un
  // singleton exige un module SÉPARÉ (`export µ$$X = …` dans un fichier, `@import µ$$X
  // '…'` dans le composant), donc un `import` réel entre 2 fichiers compilés, que cette
  // recette ne sait pas résoudre (vérifié : tests/import-singleton-consume.test.ts,
  // seul test existant sur `@import µ$$X`, ne fait QUE du `transpile()` compile-only,
  // ne monte jamais). Construire un montage 2-fichiers réel (vrai `import()` ESM sous
  // happy-dom) sortirait du « simple à monter » — non fait, limite connue.
  // Le fix vit dans `_wrap` de `µ.state`, fonction UNIQUE et PARTAGÉE (le compilateur
  // réduit `export µ$$X = {...}` en `µ.state(...)`, mêmes traps `coll` ci-dessus) : les
  // 2 tests montés au-dessus exercent donc déjà le chemin de code dont profite le
  // singleton, sans code séparé à côté.
})

describe('µminmax : bornes inversées avertissent', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('min > max sur 2 variables → exactement 1 avertissement (dédup par COUPLE min/max)', async () => {
    const src = [
      '<script>',
      '$a = 50',
      '$b = 50',
      'µminmax $a, 100, 0',
      'µminmax $b, 100, 0',
      '</script>',
      '<p class="a">{$a}</p>',
      '<p class="b">{$b}</p>',
    ].join('\n')
    const { warnCalls } = await mountCapturingWarn('minmaxinv', src)
    assert.equal(warnCalls.length, 1, `attendu exactement 1 avertissement, reçu ${warnCalls.length} : ${JSON.stringify(warnCalls)}`)
    assert.equal(warnCalls[0], '[ModularJS] µminmax : bornes inversées (min 100 > max 0)')
  })

  it('bornes normales (min < max) → aucun avertissement', async () => {
    const src = [
      '<script>',
      '$c = 50',
      'µminmax $c, 0, 100',
      '</script>',
      '<p class="c">{$c}</p>',
    ].join('\n')
    const { warnCalls } = await mountCapturingWarn('minmaxok', src)
    assert.equal(warnCalls.length, 0, `aucun avertissement attendu, reçu : ${JSON.stringify(warnCalls)}`)
  })
})

describe('µraw ignoré par µ._mjs_deepSet/µ._mjs_deepCall : corrigé', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('push()/écriture indexée sur un µraw ne re-rendent PAS ; témoin réactif change ; réaffectation force', async () => {
    const src = [
      '<script>',
      '$prices = µraw([10, 20, 30])',
      '$reactive = [10, 20, 30]',
      '',
      'pushRaw = -> $prices.push(99)',
      'setIndexRaw = -> $prices[0] = 0',
      'pushReactive = -> $reactive.push(99)',
      'forceRaw = -> $prices = µraw([...$prices, 77])',
      '</script>',
      '<p class="n">{$prices.length}</p>',
      '<p class="p0">{$prices[0]}</p>',
      '<p class="r">{$reactive.length}</p>',
      '<button class="a" @click={pushRaw()}>push</button>',
      '<button class="b" @click={setIndexRaw()}>set0</button>',
      '<button class="c" @click={pushReactive()}>pushr</button>',
      '<button class="d" @click={forceRaw()}>force</button>',
    ].join('\n')
    const { el, window } = await mount('rawdeepset', src)
    const click = (sel: string) => el._shadow.querySelector(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    const p0 = () => el._shadow.querySelector('.p0').textContent.trim()
    const r = () => el._shadow.querySelector('.r').textContent.trim()

    assert.equal(n(), '3', 'longueur µraw initiale')
    assert.equal(p0(), '10', 'index 0 µraw initial')
    assert.equal(r(), '3', 'longueur témoin réactif initiale')

    click('.a')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(n(), '3', 'AVANT le fix : $prices.push(99) sur un µraw re-rendait — doit rester figé à 3')

    click('.b')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(p0(), '10', 'AVANT le fix : $prices[0]=0 sur un µraw re-rendait — doit rester figé à 10')

    click('.c')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(r(), '4', 'témoin réactif ($reactive, sans µraw) doit re-rendre normalement')

    click('.d')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(n(), '5', 'réaffectation `$prices = µraw([...$prices, 77])` force le re-rendu : les 2 mutations muettes + le nouvel élément sont enfin visibles (3 → +push 99 → +set[0]=0 → +77 = 5 éléments)')
    assert.equal(p0(), '0', 'la mutation muette $prices[0]=0 avait bien eu lieu sous le capot, révélée par la réaffectation')
  })
})

describe('µraw ignoré par µ._mjs_deepDelete : corrigé (symétrique du cas µ._mjs_deepSet/µ._mjs_deepCall)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('delete sur un µraw ne re-rend PAS ; témoin réactif change normalement', async () => {
    const src = [
      '<script>',
      '$m = µraw({a: 1, b: 2})',
      '$n = {a: 1, b: 2}',
      '',
      'effacerM = -> delete $m.a',
      'effacerN = -> delete $n.a',
      '</script>',
      '<p class="m">{Object.keys($m).length}</p>',
      '<p class="n">{Object.keys($n).length}</p>',
      '<button class="a" @click={effacerM()}>effacer m</button>',
      '<button class="b" @click={effacerN()}>effacer n</button>',
    ].join('\n')
    const { el, window } = await mount('rawdeepdelete', src)
    const click = (sel: string) => el._shadow.querySelector(sel).dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    const m = () => el._shadow.querySelector('.m').textContent.trim()
    const n = () => el._shadow.querySelector('.n').textContent.trim()

    assert.equal(m(), '2', 'longueur µraw initiale')
    assert.equal(n(), '2', 'longueur témoin réactif initiale')

    click('.a')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(m(), '2', 'AVANT le fix : delete $m.a sur un µraw re-rendait — doit rester figé à 2')

    click('.b')
    await new Promise(res => setTimeout(res, 60))
    assert.equal(n(), '1', 'témoin réactif ($n, sans µraw) doit re-rendre normalement après delete')
  })
})

describe('Coffee : le message d\'erreur garde sa position', function () {
  it('script coffee cassé → le message contient la ligne (1:) et le motif (missing ")', async () => {
    await assert.rejects(
      () => Promise.resolve(getAdapter('coffee').compileToJs('$c = "non fermee', { fileName: 'x' })),
      (err: any) => {
        // AVANT le fix : `.message` = `missing "` seul, aucune ligne/colonne.
        assert.match(err.message, /1:/, 'la ligne (1:) doit survivre dans le message final')
        assert.match(err.message, /missing "/, 'le motif original doit rester présent')
        return true
      }
    )
  })

  it('script coffee valide compile toujours (comportement inchangé)', async () => {
    const res = await getAdapter('coffee').compileToJs('$a = 1', { fileName: 'ok.coffee' })
    assert.ok(res.code.length > 0, 'un script valide doit toujours produire du JS')
  })
})

describe('µderived + await : refusé à la compilation', () => {
  // La grammaire complète (parsing `$var = expr, deps`, capture du
  // corps, et le point où l'erreur se lève) vit dans `src/lexer/index.ts:31-33`
  // (RE_MU_DERIVED_STMT) et le `code.replace(RE_MU_DERIVED_STMT, ...)` qui construit
  // `realExpr`. `realExpr`
  // est lu sur la vue déjà MASQUÉE par `maskInert` (chaînes/commentaires remplacés par
  // des jetons NUL avant cette passe, restaurés après) : un `await` DANS une chaîne
  // n'y apparaît donc jamais littéralement — `/\bawait\b/` sur `realExpr` suffit.
  it('µderived $total = await f($x), $x → lève transpiler.derived-await-interdit', () => {
    assert.throws(() => tokenize('µderived $total = await f($x), $x'), /synchrone/,
      'un µderived est synchrone : await interdit dans son corps')
  })

  it('µderived $y = $x + 1, $x → OK (aucun await, dérivé ordinaire à dépendance forcée)', () => {
    assert.equal(tokenize('µderived $y = $x + 1, $x'), '$.y = µ._mjs_forceDeps($.x + 1, $.x)')
  })

  it('µderived $z = g(\'await\'), $x → OK (« await » dans une chaîne, pas le mot-clé)', () => {
    assert.equal(tokenize('µderived $z = g(\'await\'), $x'), '$.z = µ._mjs_forceDeps(g(\'await\'), $.x)')
  })
})

// Les traps `set`/`deleteProperty`
// du proxy `coll` (Array/Map/Set/Date de `_wrap`, mjs_runes.ts) : (1) __proto__/constructor
// passaient sans garde ni avertissement (remplacement du prototype de l'INSTANCE, cf. µ._mjs_guardPath
// mjs_init.ts, _mjs_wrapDeep mjs_element.ts, µ.Store mjs_store.ts — tous filtrent déjà cette famille de
// clés) ; (2)/(3) `true` en dur au lieu du résultat RÉEL de Reflect.set/Reflect.deleteProperty violait
// l'invariant Proxy sur une prop non-configurable/non-writable (Object.freeze, `delete arr.length`) ;
// (4) un élément OBJET d'une collection (`st.list[0]`) restait BRUT (le get trap de `coll` ne rappelait
// jamais `_wrap`, contrairement à `nested` juste en dessous) → mutation muette.
describe('proxy `coll` (Array/Map/Set/Date) : garde proto-pollution, invariants Proxy, réactivité imbriquée', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('__proto__/constructor sur un élément coll : refusés + avertis, le brut garde son vrai prototype, push reste utilisable', async () => {
    const src = [
      '<script>',
      '@st = µstate({arr: [1, 2, 3]})',
      '</script>',
      '<p class="len">{@st.arr.length}</p>',
    ].join('\n')
    const { el, window } = await mount('f9proto', src)
    const len = () => el._shadow.querySelector('.len').textContent.trim()
    const RAW = window.µ._mjs_RAW
    const warnCalls: string[] = []
    const origWarn = window.µ.warn
    window.µ.warn = (...a: any[]) => { warnCalls.push(String(a[0])); return origWarn.apply(window.µ, a) }

    el.st.arr['__proto__'] = { polluted: 42 }
    el.st.arr['constructor'] = 'evil'
    window.µ.warn = origWarn

    assert.equal(warnCalls.length, 2, `AVANT le fix : ces 2 clés passaient SANS avertissement, reçu ${warnCalls.length} : ${JSON.stringify(warnCalls)}`)
    assert.match(warnCalls[0], /clé refusée.*__proto__/, 'avertissement __proto__ absent/mal formé')
    assert.match(warnCalls[1], /clé refusée.*constructor/, 'avertissement constructor absent/mal formé')
    assert.equal(typeof el.st.arr.push, 'function', 'AVANT le fix : `__proto__` remplaçait le prototype de l\'INSTANCE → push disparaissait')
    assert.equal(Object.getPrototypeOf(el.st.arr[RAW]), window.Array.prototype, 'le brut doit garder Array.prototype (pas de pollution d\'instance)')

    el.st.arr.push(4)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(len(), '4', 'push doit toujours fonctionner après la tentative de pollution')
  })

  it('Object.freeze(arr) puis écriture sur un index gelé : pas de violation d\'invariant Proxy (« truish »), DOM inchangé', async () => {
    const src = [
      '<script>',
      '@st = µstate({arr: [1, 2, 3]})',
      '</script>',
      '<p class="i0">{@st.arr[0]}</p>',
    ].join('\n')
    const { el } = await mount('f9freeze', src)
    const i0 = () => el._shadow.querySelector('.i0').textContent.trim()
    assert.equal(i0(), '1', 'valeur initiale')

    Object.freeze(el.st.arr)
    let threw: string | null = null
    try { el.st.arr[0] = 999 } catch (e: any) { threw = e.message }
    // AVANT le fix : « trap returned truish for property '0' which exists... non-configurable and
    // non-writable » (invariant Proxy violé par le `true` en dur). APRÈS le fix : le trap rapporte le
    // résultat RÉEL de Reflect.set — en mode strict la SEULE exception qui peut subsister est la
    // TypeError standard « falsish »/« read only », symétrique d'un tableau natif gelé (jamais évitable
    // en JS, proxy ou pas) — jamais la version « truish » (mensonge du trap).
    assert.ok(!threw || !/truish/.test(threw), `pas de violation d'invariant Proxy attendue, reçu : ${threw}`)

    await new Promise(r => setTimeout(r, 60))
    assert.equal(i0(), '1', 'DOM inchangé : l\'élément gelé garde sa valeur d\'origine')
  })

  it('delete arr.length (non-configurable, natif) : pas de violation d\'invariant Proxy, DOM inchangé', async () => {
    const src = [
      '<script>',
      '@st = µstate({arr: [1, 2, 3]})',
      '</script>',
      '<p class="len">{@st.arr.length}</p>',
    ].join('\n')
    const { el } = await mount('f9dellen', src)
    const len = () => el._shadow.querySelector('.len').textContent.trim()
    assert.equal(len(), '3', 'longueur initiale')

    let threw: string | null = null
    try { delete el.st.arr.length } catch (e: any) { threw = e.message }
    // AVANT le fix : « trap returned truish for property 'length' which is non-configurable in the
    // proxy target » — même famille que le `set` ci-dessus.
    assert.ok(!threw || !/truish/.test(threw), `pas de violation d'invariant Proxy attendue, reçu : ${threw}`)

    await new Promise(r => setTimeout(r, 60))
    assert.equal(len(), '3', 'DOM inchangé : Array natif refuse toujours `delete length` (non-configurable)')
  })

  it('objet imbriqué DANS un élément de collection (st.list[0].x=999) : devient réactif, identité stable', async () => {
    const src = [
      '<script>',
      '@st = µstate({list: [{x: 1}]})',
      '</script>',
      '<p class="x">{@st.list[0].x}</p>',
    ].join('\n')
    const { el } = await mount('f9nested', src)
    const x = () => el._shadow.querySelector('.x').textContent.trim()
    assert.equal(x(), '1', 'valeur initiale')
    assert.ok(el.st.list[0] === el.st.list[0], 'identité de proxy stable (cache _wrap partagé, même rootKey)')

    el.st.list[0].x = 999
    await new Promise(r => setTimeout(r, 60))
    assert.equal(x(), '999', 'AVANT le fix : le get trap de `coll` ne rappelait jamais `_wrap` sur ses valeurs (contrairement à `nested`) → mutation muette')
  })
})

// La MÊME lacune que pour `coll` ci-dessus, un cran plus haut : le proxy `nested` (objets PLATS, juste en
// dessous de `coll` dans le même `_wrap`, mjs_runes.ts) n'avait NI la garde proto-pollution ni le
// résultat RÉEL de Reflect.set/Reflect.deleteProperty — `st.obj['__proto__'] = {...}` remplaçait le
// prototype de l'objet BRUT sans le moindre avertissement, et une écriture sur une propriété gelée/
// non-configurable violait l'invariant Proxy.
describe('proxy `nested` (objets plats) : garde proto-pollution, invariants Proxy, réactivité intacte', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('__proto__/constructor sur `st.obj` : refusés + avertis, le brut garde son vrai prototype, témoin réactif intact', async () => {
    const src = [
      '<script>',
      '@st = µstate({obj: {a: 1}})',
      '</script>',
      '<p class="av">{@st.obj.a}</p>',
    ].join('\n')
    const { el, window } = await mount('f10proto', src)
    const av = () => el._shadow.querySelector('.av').textContent.trim()
    const RAW = window.µ._mjs_RAW
    const warnCalls: string[] = []
    const origWarn = window.µ.warn
    window.µ.warn = (...a: any[]) => { warnCalls.push(String(a[0])); return origWarn.apply(window.µ, a) }

    el.st.obj['__proto__'] = { p: 1 }
    el.st.obj['constructor'] = 'evil'
    window.µ.warn = origWarn

    assert.equal(warnCalls.length, 2, `AVANT le fix : ces 2 clés passaient SANS avertissement sur \`nested\`, reçu ${warnCalls.length} : ${JSON.stringify(warnCalls)}`)
    assert.match(warnCalls[0], /clé refusée.*__proto__/, 'avertissement __proto__ absent/mal formé')
    assert.match(warnCalls[1], /clé refusée.*constructor/, 'avertissement constructor absent/mal formé')
    assert.equal(Object.getPrototypeOf(el.st.obj[RAW]), window.Object.prototype, 'AVANT le fix : `__proto__` remplaçait le prototype de l\'objet BRUT')
    assert.equal(window.eval('({}).p'), undefined, 'contrôle croisé : Object.prototype PARTAGÉ du realm reste intact (pas de pollution qui fuit vers un autre objet)')

    el.st.obj.a = 2
    await new Promise(r => setTimeout(r, 60))
    assert.equal(av(), '2', 'témoin réactif : une écriture normale doit continuer à notifier après la tentative de pollution')
  })

  it('Object.freeze(obj) puis écriture sur une propriété gelée : pas de violation d\'invariant Proxy (« truish »), DOM inchangé', async () => {
    const src = [
      '<script>',
      '@st = µstate({obj: {a: 1}})',
      '</script>',
      '<p class="av">{@st.obj.a}</p>',
    ].join('\n')
    const { el } = await mount('f10freeze', src)
    const av = () => el._shadow.querySelector('.av').textContent.trim()
    assert.equal(av(), '1', 'valeur initiale')

    Object.freeze(el.st.obj)
    let threw: string | null = null
    try { el.st.obj.a = 999 } catch (e: any) { threw = e.message }
    // AVANT le fix : `nested` retournait `true` en dur dans `set`, sans jamais rapporter le résultat
    // RÉEL de l'écriture sur un objet gelé → « trap returned truish… » (invariant Proxy violé), même
    // famille que le fix posé sur `coll` ci-dessus.
    assert.ok(!threw || !/truish/.test(threw), `pas de violation d'invariant Proxy attendue, reçu : ${threw}`)

    await new Promise(r => setTimeout(r, 60))
    assert.equal(av(), '1', 'DOM inchangé : l\'objet gelé garde sa valeur d\'origine')
  })

  it('delete el.st.obj.a : notifie (clé retirée, Object.keys recompte)', async () => {
    const src = [
      '<script>',
      '@st = µstate({obj: {a: 1, b: 2}})',
      '</script>',
      '<p class="n">{Object.keys(@st.obj).length}</p>',
    ].join('\n')
    const { el } = await mount('f10delete', src)
    const n = () => el._shadow.querySelector('.n').textContent.trim()
    assert.equal(n(), '2', 'longueur initiale')

    delete el.st.obj.a
    await new Promise(r => setTimeout(r, 60))
    assert.equal(n(), '1', 'la suppression doit notifier : Object.keys recompte à 1')
  })
})
