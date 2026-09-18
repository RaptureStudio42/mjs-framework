// mort de la boucle two-way objet/tableau inter-composants.
// Trois pièces se répondaient : le code généré compare par RÉFÉRENCE
// (attributes/index.ts, bindingComponent — INCHANGÉ par ce fix, le runtime
// absorbe tout) ; `_mjs_wrapDeep` (mjs_element.ts) ne reconnaissait pas l'enveloppe
// d'un AUTRE composant/rune/store et la ré-enveloppait (Proxy-de-Proxy,
// identité neuve à chaque frontière) ; `_mjs_notifyMutation` redispatchait sans
// comparer. Fix : « reconnaissance des enveloppes » (µ._mjs_RAW/µ._mjs_toRaw partagé
// entre TOUS les filets réactifs) + ÉPOQUE de mutation par objet brut
// (WeakMap globale, µ._mjs_epochs/µ._mjs_bumpEpoch) pour distinguer un écho pur d'une
// mutation réelle, SANS jamais comparer de contenu (O(1) par set).
//
// Patron de fixtures calqué sur tests/ssr-nested-await-settle.test.ts (2+
// fichiers .mjs compilés ensemble par le vrai Bundler, évalués dans une vraie
// Window happy-dom) et tests/core-select.test.ts (compteur d'appels via
// monkey-patch de prototype). Toutes les mesures de « boucle tuée » sont des
// BORNES (nombre d'appels `_set` après stabilisation), jamais un seuil de
// timing serré — l'ancien code ne débordait pas la pile (la ping-pong passe
// par `queueMicrotask`, pas par un dispatchEvent réentrant synchrone borné) :
// il gonflait indéfiniment le compteur, ce que ces bornes détectent.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function settle(ms = 80): Promise<void> {
  await new Promise((r) => setTimeout(r, ms))
}

// Compile TOUS les modules .mjs fournis EN UNE FOIS (un seul Bundler.compile,
// réutilisé par tous les describe ci-dessous — chaque describe ne fait que
// MONTER un sous-ensemble dans sa propre Window fraîche).
async function compileAll(sources: Record<string, string>) {
  const root = mjsTmp('loop')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(sources)) writeFileSync(join(srcDir, `${name}.mjs`), src)
  // `runtime: ['deep']` : plusieurs tests ci-dessous appellent µ._mjs_deepSet/_mjs_deepCall
  // DIRECTEMENT sur le cœur monté (robustesse interne, hors tout composant compilé) — aucune
  // des fixtures n'émet elle-même `._mjs_deepSet(`/`._mjs_deepCall(` (elles ne mutent qu'en two-way,
  // jamais par `$obj.x = v`/`$arr.push(v)`), le scan ne détecterait donc jamais 'deep' tout
  // seul (mjs_deep.ts détaché de mjs_init.ts, joint à l'usage) — même motif que
  // ssr-bench.test.ts → runtime: ['hydrate'].
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['deep'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  assert.ok(coreFile, 'mjs_core doit avoir été compilé')
  return { outDir, files, coreFile, bundler }
}

// Monte un sous-ensemble de modules déjà compilés dans une Window happy-dom
// FRAÎCHE, instrumente `_set`/`_mjs_notifyMutation` sur µ.Element.prototype (compteur
// cumulatif), monte `rootTag`.
function mountWindow(outDir: string, files: string[], coreFile: string, moduleNames: string[], rootTag: string) {
  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const code = [
    stripEsm(readFileSync(join(outDir, coreFile), 'utf-8')),
    'globalThis.µ = µ;',
    ...moduleNames.map((n) => {
      const f = files.find((ff) => new RegExp(`^${n}-`).test(ff))
      assert.ok(f, `module compilé introuvable pour ${n}`)
      return stripEsm(readFileSync(join(outDir, f!), 'utf-8'))
    }),
  ].join('\n')
  win.eval(code)
  const counter = { set: 0, notify: 0 }
  const proto = win.eval('µ.Element.prototype')
  const origSet = proto._set
  const origNotify = proto._mjs_notifyMutation
  proto._set = function (k: string, v: any) {
    counter.set++
    // Garde-fou de sonde (PAS l'assertion elle-même) : sur l'ancien code, le
    // ping-pong grossit sans borne — ce cap évite qu'un run rouge n'échappe
    // au harnais Mocha (timeout) en consommant la mémoire indéfiniment.
    if (counter.set > 5000) throw new Error(`plafond de sonde dépassé (${counter.set} _set) : boucle two-way toujours active`)
    return origSet.call(this, k, v)
  }
  proto._mjs_notifyMutation = function (k: string, old: any) {
    counter.notify++
    return origNotify.call(this, k, old)
  }
  document.body.innerHTML = `<${rootTag}></${rootTag}>`
  return { win, document, counter }
}

// ============================================================================
// Sources des fixtures
// ============================================================================

// Fixture 1 — parent/enfant, tableau + primitive en two-way.
const PC_PARENT = [
  '<script lang="coffee">',
  "$arr = [1, 2, 3]",
  "$label = 'x'",
  '</script>',
  '<mjs-t198pcchild items=!{$arr} label=!{$label}></mjs-t198pcchild>',
].join('\n')
const PC_CHILD = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $items}<span class="it">{x}</span>{end}',
  '<span class="lbl">{$label}</span>',
].join('\n')

// Fixture 2 — chaîne A→B→C, même tableau relayé two-way sur 2 frontières.
const CHAIN_A = [
  '<script lang="coffee">',
  '$arr = [1, 2, 3]',
  '</script>',
  '<mjs-t198chainb items=!{$arr}></mjs-t198chainb>',
].join('\n')
const CHAIN_B = [
  '<script lang="coffee">',
  '</script>',
  '<mjs-t198chainc items=!{$items}></mjs-t198chainc>',
].join('\n')
const CHAIN_C = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $items}<span class="it">{x}</span>{end}',
].join('\n')

// Fixture 3 — deux enfants FRÈRES liés au MÊME tableau parent.
const SIB_PARENT = [
  '<script lang="coffee">',
  '$arr = [1, 2, 3]',
  '</script>',
  '<mjs-t198siba itemsA=!{$arr}></mjs-t198siba>',
  '<mjs-t198sibb itemsB=!{$arr}></mjs-t198sibb>',
].join('\n')
const SIB_A = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $itemsA}<span class="it">{x}</span>{end}',
].join('\n')
const SIB_B = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $itemsB}<span class="it">{x}</span>{end}',
].join('\n')

// Fixture 4 — objet issu de µ.state (runes) passé en liaison two-way (T-c).
const RUNE_PARENT = [
  '<script lang="coffee">',
  '@game = µ.state({list: [1, 2, 3]})',
  '$arr = @game.list',
  '</script>',
  '<mjs-t198runechild items=!{$arr}></mjs-t198runechild>',
].join('\n')
const RUNE_CHILD = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $items}<span class="it">{x}</span>{end}',
].join('\n')

// Fixture 5 — clé de µ.Store passée en liaison two-way (T-c).
const STORE_PARENT = [
  '<script lang="coffee">',
  '@store = new µStore({list: [1, 2, 3]})',
  '$arr = @store.data.list',
  '</script>',
  '<mjs-t198storechild items=!{$arr}></mjs-t198storechild>',
].join('\n')
const STORE_CHILD = [
  '<script lang="coffee">',
  '</script>',
  '{for x in $items}<span class="it">{x}</span>{end}',
].join('\n')

describe('mort de la boucle two-way objet/tableau inter-composants (reconnaissance des enveloppes + époques)', function () {
  this.timeout(90000)

  let compiled: { outDir: string; files: string[]; coreFile: string; bundler: Bundler }

  before(async () => {
    compiled = await compileAll({
      t198pcparent: PC_PARENT,
      t198pcchild: PC_CHILD,
      t198chaina: CHAIN_A,
      t198chainb: CHAIN_B,
      t198chainc: CHAIN_C,
      t198sibparent: SIB_PARENT,
      t198siba: SIB_A,
      t198sibb: SIB_B,
      t198runeparent: RUNE_PARENT,
      t198runechild: RUNE_CHILD,
      t198storeparent: STORE_PARENT,
      t198storechild: STORE_CHILD,
    })
  })

  after(async () => {
    await compiled.bundler.close()
    await terminateSharedWorkerPool()
  })

  // ==========================================================================
  describe('parent/enfant liés par items=!{$arr} (+ primitive label=!{$label})', function () {
    let ctx: { win: any; document: any; counter: { set: number; notify: number } }

    before(async () => {
      ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198pcchild', 't198pcparent'], 'mjs-t198pcparent')
      await settle()
    })

    const parentEl = () => ctx.document.body.firstElementChild
    const childEl = () => parentEl()._shadow.querySelector('mjs-t198pcchild')

    it('le compteur de _set SE STABILISE après le mount (pas de croissance sur les ticks suivants)', async () => {
      const mid = ctx.counter.set
      await settle(300)
      const after = ctx.counter.set
      assert.ok(after - mid <= 2, `croissance après stabilisation attendue quasi nulle (mid=${mid}, after=${after}) — l'ancien code grossissait sans borne (500+ observés en sonde manuelle sur 200ms)`)
      assert.ok(after <= 20, `total borné attendu ≤20 après mount+300ms (obtenu ${after})`)
    })

    it('reconnaissance des enveloppes : parent et enfant finissent par lire le MÊME objet brut (µ._mjs_RAW), pas un Proxy-de-Proxy', () => {
      const RAW = ctx.win.eval('µ._mjs_RAW')
      assert.equal(childEl()._state.items[RAW], parentEl()._state.arr[RAW],
        'le brut sous le Proxy enfant doit être IDENTIQUE au brut sous le Proxy parent')
      assert.deepEqual(Array.from(childEl()._state.items), [1, 2, 3])
    })

    it('primitive (label) : two-way toujours fonctionnel, fast-path non affecté', () => {
      assert.equal(childEl()._shadow.querySelector('.lbl').textContent, 'x')
    })

    it('mutation profonde côté ENFANT ($items.push) → le PARENT re-rend, sans emballement', async () => {
      const before = ctx.counter.set
      childEl()._state.items.push(4)
      await settle()
      assert.deepEqual(Array.from(parentEl()._state.arr), [1, 2, 3, 4], 'le parent doit voir la mutation enfant')
      assert.equal(childEl()._shadow.querySelectorAll('.it').length, 4, 'le DOM enfant doit refléter le push')
      const delta = ctx.counter.set - before
      assert.ok(delta <= 8, `pas d'emballement après mutation enfant (delta _set=${delta})`)
    })

    it('mutation profonde côté PARENT ($arr.push) → l\'ENFANT re-rend, sans emballement', async () => {
      const before = ctx.counter.set
      parentEl()._state.arr.push(5)
      await settle()
      assert.deepEqual(Array.from(childEl()._state.items), [1, 2, 3, 4, 5], "l'enfant doit voir la mutation parent")
      assert.equal(childEl()._shadow.querySelectorAll('.it').length, 5, 'le DOM enfant doit refléter le push parent')
      const delta = ctx.counter.set - before
      assert.ok(delta <= 8, `pas d'emballement après mutation parent (delta _set=${delta})`)
    })

    it('remplacement d\'IDENTITÉ (nouveau tableau, pas une mutation) propagé sans boucle', async () => {
      const before = ctx.counter.set
      parentEl()._set('arr', [9, 9, 9])
      await settle()
      assert.deepEqual(Array.from(childEl()._state.items), [9, 9, 9], "l'enfant doit adopter le nouveau tableau")
      assert.equal(childEl()._shadow.querySelectorAll('.it').length, 3)
      const delta = ctx.counter.set - before
      assert.ok(delta <= 8, `pas d'emballement après remplacement d'identité (delta _set=${delta})`)
    })

    it('coût CONSTANT par mutation (O(1), aucune comparaison de contenu) : 30 push consécutifs ne font pas grossir le coût par push', async () => {
      const deltas: number[] = []
      for (let i = 0; i < 30; i++) {
        const before = ctx.counter.set
        childEl()._state.items.push(i)
        await settle(15)
        deltas.push(ctx.counter.set - before)
      }
      const max = Math.max(...deltas)
      const min = Math.min(...deltas)
      assert.ok(max <= 8, `coût max par push attendu borné (obtenu ${max}) — deltas=${deltas.join(',')}`)
      // O(1) : le coût du DERNIER push (tableau à ~33 éléments) ne doit pas
      // dépasser le coût du PREMIER (tableau à ~3 éléments) — aucune comparaison
      // de contenu ne doit faire grossir le travail avec la taille du tableau.
      assert.ok(deltas[deltas.length - 1] <= deltas[0] + 2,
        `le coût par push ne doit pas croître avec la taille du tableau (premier=${deltas[0]}, dernier=${deltas[deltas.length - 1]})`)
      assert.equal(min, max, 'coût par push STRICTEMENT constant sur cette fixture (aucune variation observée en sonde manuelle)')
    })
  })

  // ==========================================================================
  describe('chaîne A→B→C (même tableau relayé two-way sur 2 frontières)', function () {
    let ctx: { win: any; document: any; counter: { set: number; notify: number } }

    before(async () => {
      ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198chainc', 't198chainb', 't198chaina'], 'mjs-t198chaina')
      await settle()
    })

    const aEl = () => ctx.document.body.firstElementChild
    const bEl = () => aEl()._shadow.querySelector('mjs-t198chainb')
    const cEl = () => bEl()._shadow.querySelector('mjs-t198chainc')

    it('mount : A, B, C convergent sur le même contenu, compteur borné', () => {
      assert.deepEqual(Array.from(aEl()._state.arr), [1, 2, 3])
      assert.deepEqual(Array.from(bEl()._state.items), [1, 2, 3])
      assert.deepEqual(Array.from(cEl()._state.items), [1, 2, 3])
      assert.ok(ctx.counter.set <= 20, `mount borné (obtenu ${ctx.counter.set})`)
    })

    it('une mutation en C REMONTE jusqu\'à A à travers B, sans boucle', async () => {
      const before = ctx.counter.set
      cEl()._state.items.push(99)
      await settle(150)
      assert.deepEqual(Array.from(aEl()._state.arr), [1, 2, 3, 99], 'A (racine) doit recevoir la mutation de C')
      assert.deepEqual(Array.from(bEl()._state.items), [1, 2, 3, 99])
      assert.equal(cEl()._shadow.querySelectorAll('.it').length, 4)
      const delta = ctx.counter.set - before
      assert.ok(delta <= 12, `pas de boucle sur la chaîne à 2 frontières (delta _set=${delta})`)
      const mid = ctx.counter.set
      await settle(200)
      assert.ok(ctx.counter.set - mid <= 2, 'stabilisation confirmée après la propagation')
    })
  })

  // ==========================================================================
  describe('deux enfants FRÈRES liés au même tableau parent', function () {
    let ctx: { win: any; document: any; counter: { set: number; notify: number } }

    before(async () => {
      ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198sibparent', 't198siba', 't198sibb'], 'mjs-t198sibparent')
      await settle()
    })

    const pEl = () => ctx.document.body.firstElementChild
    const aEl = () => pEl()._shadow.querySelector('mjs-t198siba')
    const bEl = () => pEl()._shadow.querySelector('mjs-t198sibb')

    it('mount : parent + 2 enfants convergent, compteur borné', () => {
      assert.deepEqual(Array.from(pEl()._state.arr), [1, 2, 3])
      assert.deepEqual(Array.from(aEl()._state.itemsA), [1, 2, 3])
      assert.deepEqual(Array.from(bEl()._state.itemsB), [1, 2, 3])
      assert.ok(ctx.counter.set <= 20, `mount borné (obtenu ${ctx.counter.set})`)
    })

    it('mutation chez le frère A → le frère B re-rend AUSSI (via le parent), sans boucle', async () => {
      const before = ctx.counter.set
      aEl()._state.itemsA.push(77)
      await settle(150)
      assert.deepEqual(Array.from(pEl()._state.arr), [1, 2, 3, 77])
      assert.deepEqual(Array.from(bEl()._state.itemsB), [1, 2, 3, 77], 'le frère B doit voir la mutation faite chez A')
      assert.equal(bEl()._shadow.querySelectorAll('.it').length, 4)
      const delta = ctx.counter.set - before
      assert.ok(delta <= 12, `pas de boucle entre les 2 frères (delta _set=${delta})`)
      const mid = ctx.counter.set
      await settle(200)
      assert.ok(ctx.counter.set - mid <= 2, 'stabilisation confirmée après la propagation croisée')
    })
  })

  // ==========================================================================
  describe('T-c — runes/store : pas de double-enveloppe, mutation traverse', function () {
    it('µ.state (rune) : $arr = @game.list lié two-way à un enfant — enfant voit le BRUT partagé, mutation traverse dans les 2 sens', async () => {
      const ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198runechild', 't198runeparent'], 'mjs-t198runeparent')
      await settle()
      const parentEl = ctx.document.body.firstElementChild
      const childEl = parentEl._shadow.querySelector('mjs-t198runechild')
      const RAW = ctx.win.eval('µ._mjs_RAW')

      assert.equal(childEl._state.items[RAW], parentEl.game.list[RAW],
        "l'enfant doit voir le MÊME brut que la rune — pas de Proxy-de-Proxy")
      assert.deepEqual(Array.from(childEl._state.items), [1, 2, 3])
      assert.ok(ctx.counter.set <= 20, `mount borné (obtenu ${ctx.counter.set})`)

      // mutation côté ENFANT → doit remonter jusqu'à la rune elle-même.
      let before = ctx.counter.set
      childEl._state.items.push(4)
      await settle()
      assert.deepEqual(Array.from(parentEl.game.list), [1, 2, 3, 4], 'la rune elle-même doit refléter la mutation enfant')
      assert.deepEqual(Array.from(parentEl._state.arr), [1, 2, 3, 4])
      assert.ok(ctx.counter.set - before <= 8, `pas d'emballement (delta=${ctx.counter.set - before})`)

      // mutation DIRECTE sur la rune (hors du var lié $arr) → doit redescendre à l'enfant.
      before = ctx.counter.set
      parentEl.game.list.push(5)
      await settle(150)
      assert.deepEqual(Array.from(childEl._state.items), [1, 2, 3, 4, 5], "l'enfant doit voir la mutation directe sur la rune")
      assert.ok(ctx.counter.set - before <= 8, `pas d'emballement sur mutation rune directe (delta=${ctx.counter.set - before})`)

      ctx.win.close?.()
    })

    it('µ.Store (new µStore) : $arr = @store.data.list lié two-way à un enfant — enfant voit le BRUT partagé, mutation traverse', async () => {
      const ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198storechild', 't198storeparent'], 'mjs-t198storeparent')
      await settle()
      const parentEl = ctx.document.body.firstElementChild
      const childEl = parentEl._shadow.querySelector('mjs-t198storechild')
      const RAW = ctx.win.eval('µ._mjs_RAW')

      assert.equal(childEl._state.items[RAW], parentEl.store.data.list[RAW],
        "l'enfant doit voir le MÊME brut que le store — pas de Proxy-de-Proxy")
      assert.deepEqual(Array.from(childEl._state.items), [1, 2, 3])
      assert.ok(ctx.counter.set <= 20, `mount borné (obtenu ${ctx.counter.set})`)

      const before = ctx.counter.set
      childEl._state.items.push(4)
      await settle()
      assert.deepEqual(Array.from(parentEl.store.data.list), [1, 2, 3, 4], 'le store lui-même doit refléter la mutation enfant')
      assert.deepEqual(Array.from(parentEl._state.arr), [1, 2, 3, 4])
      assert.ok(ctx.counter.set - before <= 8, `pas d'emballement (delta=${ctx.counter.set - before})`)

      ctx.win.close?.()
    })
  })

  // ==========================================================================
  // µ._mjs_toRaw UNIFORMISÉ : 7 sites déballaient encore 1 SEUL niveau
  // (`(v != null && v[µ._mjs_RAW]) || v`, sans boucle) au lieu d'appeler µ._mjs_toRaw
  // (mjs_element.ts:334/516, mjs_runes.ts:309/382, mjs_init.ts:486/512/543).
  // En régime normal les enveloppes ne s'empilent JAMAIS (chaque point d'entrée
  // — _mjs_wrapDeep/_wrap/_mjs_buildProxy — se re-normalise déjà tout seul via µ._mjs_toRaw,
  // voir plus haut) : ces 4 cas FABRIQUENT donc à la main une valeur
  // enveloppée 2× (deux objets qui répondent chacun à µ._mjs_RAW, empilés) pour
  // couvrir la ROBUSTESSE si un pair transmettait malgré tout une telle valeur.
  // Lecture BRUTE (`[µ._mjs_RAW]` direct sur la cible STOCKÉE) — jamais via
  // l'accesseur normal, qui re-wrap tout seul à la lecture et masquerait un
  // déballage resté partiel côté ÉCRITURE.
  describe('µ._mjs_toRaw uniformisé : déballage BOUCLÉ (pas 1 niveau) sur 4 chemins', function () {
    let ctx: { win: any; document: any; counter: { set: number; notify: number } }
    let µR: any

    before(async () => {
      ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198pcchild', 't198pcparent'], 'mjs-t198pcparent')
      await settle()
      µR = ctx.win.eval('µ')
    })

    it('_mjs_deepSet (mjs_init.ts:486) — conteneur doublement enveloppé : la navigation atteint le VRAI brut', () => {
      const RAW = µR._mjs_RAW
      const trueRaw: any = { a: { b: 1 } }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: trueRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const el: any = ctx.document.body.firstElementChild
      el._state.__t208deep = wrap2
      µR._mjs_deepSet(el, ['__t208deep', 'a', 'b'], 99)
      assert.equal(trueRaw.a.b, 99, "la mutation profonde doit atteindre le conteneur VRAIMENT brut (2 niveaux de déballage), pas un wrapper orphelin")
    })

    it('_mjs_wrapDeep — set trap (mjs_element.ts:516) — valeur doublement enveloppée assignée : identité STOCKÉE = brut', () => {
      const RAW = µR._mjs_RAW
      const innerRaw: any = { hello: 'brut' }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: innerRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const el: any = ctx.document.body.firstElementChild
      const container: any = el._mjs_wrapDeep({ x: null }, '__t208wd')
      container.x = wrap2
      assert.equal(container[RAW].x, innerRaw, 'le set trap de _mjs_wrapDeep doit stocker le BRUT en interne (lecture directe [µ._mjs_RAW], sans repasser par le get qui re-normalise tout seul)')
    })

    it('µ.state — set trap NESTED/« store » (mjs_runes.ts:309) — sous-objet imbriqué, valeur doublement enveloppée : identité STOCKÉE = brut', () => {
      const RAW = µR._mjs_RAW
      const innerRaw: any = { z: 'brut' }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: innerRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const s: any = µR.state({ nested: { y: 1 } })
      s.nested.y = wrap2
      assert.equal(s.nested[RAW].y, innerRaw, 'le set trap du sous-objet µ.state doit stocker le BRUT, pas un wrapper résiduel')
    })

    it('µ.state — set trap RACINE/« runes » (mjs_runes.ts) — clé top-level, valeur doublement enveloppée : identité STOCKÉE = brut', () => {
      const RAW = µR._mjs_RAW
      const innerRaw: any = { w: 'brut' }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: innerRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const s: any = µR.state({ root: null })
      s.root = wrap2
      assert.equal(s[RAW].root, innerRaw, 'le set trap RACINE de µ.state doit stocker le BRUT, pas un wrapper résiduel')
    })
  })

  // ==========================================================================
  // dernier reste du travail « déballer partout avec µ._mjs_toRaw » : le
  // bloc ci-dessus couvrait le CONTENEUR de navigation (`o = µ._mjs_toRaw(o)`)
  // dans _mjs_deepSet/_mjs_deepCall, mais jamais la VALEUR écrite ni les ARGUMENTS
  // passés à une méthode mutative — une valeur doublement enveloppée par
  // `$obj.a.b = valeur` ou `$arr.push(valeur)` restait stockée telle quelle.
  describe('µ._mjs_deepSet/µ._mjs_deepCall déballent aussi la VALEUR/les ARGUMENTS (pas seulement le conteneur)', function () {
    let ctx: { win: any; document: any; counter: { set: number; notify: number } }
    let µR: any

    before(async () => {
      ctx = mountWindow(compiled.outDir, compiled.files, compiled.coreFile, ['t198pcchild', 't198pcparent'], 'mjs-t198pcparent')
      await settle()
      µR = ctx.win.eval('µ')
    })

    it('_mjs_deepSet — VALEUR doublement enveloppée : l\'objet stocké est le VRAI brut (identité stricte, pas l\'enveloppe)', () => {
      const RAW = µR._mjs_RAW
      const trueRaw: any = { hello: 'brut' }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: trueRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const el: any = ctx.document.body.firstElementChild
      el._state.__t224set = { a: null }
      µR._mjs_deepSet(el, ['__t224set', 'a'], wrap2)
      assert.equal(el._state.__t224set.a, trueRaw, 'la valeur stockée doit être le VRAI brut (2 niveaux de déballage), pas l\'enveloppe reçue')
    })

    it('_mjs_deepCall — argument doublement enveloppé (arr.push) : l\'élément poussé est le VRAI brut', () => {
      const RAW = µR._mjs_RAW
      const trueRaw: any = { pushed: true }
      const wrap1: any = {}; Object.defineProperty(wrap1, RAW, { value: trueRaw })
      const wrap2: any = {}; Object.defineProperty(wrap2, RAW, { value: wrap1 })
      const el: any = ctx.document.body.firstElementChild
      el._state.__t224arr = []
      µR._mjs_deepCall(el, ['__t224arr'], 'push', [wrap2])
      assert.equal(el._state.__t224arr[0], trueRaw, 'l\'élément poussé doit être le VRAI brut, pas l\'enveloppe')
    })

    it('_mjs_deepCall — plusieurs arguments mêlés (brut enveloppé/primitive/null) : chacun traité indépendamment', () => {
      const RAW = µR._mjs_RAW
      const trueRaw: any = { pushed: 2 }
      const wrap: any = {}; Object.defineProperty(wrap, RAW, { value: trueRaw })
      const el: any = ctx.document.body.firstElementChild
      el._state.__t224arr2 = []
      µR._mjs_deepCall(el, ['__t224arr2'], 'push', [42, null, wrap])
      assert.deepEqual(el._state.__t224arr2.slice(0, 2), [42, null], 'primitive et null traversent SANS modification')
      assert.equal(el._state.__t224arr2[2], trueRaw, 'l\'objet enveloppé, lui, ressort déballé')
    })

    it('_mjs_deepSet — valeur primitive et null traversent inchangés (µ._mjs_toRaw neutre sur le non-objet)', () => {
      const el: any = ctx.document.body.firstElementChild
      el._state.__t224prim = { a: 'x', b: 'y' }
      µR._mjs_deepSet(el, ['__t224prim', 'a'], 42)
      µR._mjs_deepSet(el, ['__t224prim', 'b'], null)
      assert.equal(el._state.__t224prim.a, 42)
      assert.equal(el._state.__t224prim.b, null)
    })

    it('_mjs_deepSet — écho (même brut ré-enveloppé) : la garde d\'égalité s\'applique APRÈS déballage, zéro notification fantôme', () => {
      const RAW = µR._mjs_RAW
      const el: any = ctx.document.body.firstElementChild
      const shared: any = { z: 'brut' }
      el._state.__t224echo = { a: shared }
      const before = ctx.counter.notify
      const wrapEcho: any = {}; Object.defineProperty(wrapEcho, RAW, { value: shared })
      µR._mjs_deepSet(el, ['__t224echo', 'a'], wrapEcho)
      assert.equal(el._state.__t224echo.a, shared, 'le brut stocké reste le même objet')
      assert.equal(ctx.counter.notify, before, 'un écho (même brut réenveloppé) ne doit déclencher AUCUNE notification — sinon re-rendu fantôme/boucle')
    })
  })
})
