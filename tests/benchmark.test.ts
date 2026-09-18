// Benchmark : reads/writes Proxy V1 vs accès direct V2
//
// Reproduit le pattern réactif des deux versions sur un objet jouet et mesure
// le throughput de reads + writes massifs. Le but n'est PAS un microbench
// rigoureux mais une sanity-check du gain attendu (3-6×) annoncé.
//
// Test marqué `.skip` par défaut : à exécuter manuellement avec
//   npm test -- --grep "benchmark"
// (ou retirer .skip pour intégrer en CI).

import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const ITER = 1_000_000
const __dirname = dirname(fileURLToPath(import.meta.url))

describe.skip('benchmark : Proxy V1 vs direct V2', () => {
  it('mesure le throughput reads + writes', () => {
    // -----------------
    // V1 : Proxy reactive simulé
    // -----------------
    let invalidatedV1 = 0
    const stateV1: any = { count: 0 }
    const $V1 = new Proxy(stateV1, {
      get(t, k) { return t[k as string] },
      set(t, k, v) {
        const old = t[k as string]
        if (old === v) return true
        t[k as string] = v
        invalidatedV1++
        return true
      },
    })

    const t1 = performance.now()
    for (let i = 0; i < ITER; i++) {
      $V1.count = $V1.count + 1
    }
    const v1Time = performance.now() - t1

    // -----------------
    // V2 : accès direct + µ._set
    // -----------------
    let invalidatedV2 = 0
    const stateV2: any = { count: 0 }
    const _set = (k: string, v: any) => {
      const old = stateV2[k]
      if (old === v) return true
      stateV2[k] = v
      invalidatedV2++
      return true
    }

    const t2 = performance.now()
    for (let i = 0; i < ITER; i++) {
      // Pattern V2 : reads directs, writes via _set
      _set('count', stateV2.count + 1)
    }
    const v2Time = performance.now() - t2

    const ratio = v1Time / v2Time
    // eslint-disable-next-line no-console
    console.log(`\n  V1 (Proxy)  : ${v1Time.toFixed(0)}ms (${(ITER / v1Time * 1000).toFixed(0)} ops/s)`)
    // eslint-disable-next-line no-console
    console.log(`  V2 (direct) : ${v2Time.toFixed(0)}ms (${(ITER / v2Time * 1000).toFixed(0)} ops/s)`)
    // eslint-disable-next-line no-console
    console.log(`  Ratio       : ${ratio.toFixed(2)}× plus rapide en V2`)

    assert.equal(invalidatedV1, ITER)
    assert.equal(invalidatedV2, ITER)
    assert.ok(ratio >= 1.5, `V2 devrait être au moins 1.5× plus rapide (actuel ${ratio.toFixed(2)}×)`)
  })
})

// STATISATION — même sanity-check que ci-dessus, mais sur le VRAI code du
// store global : l'ancien chemin (`µ.state`, Proxy récursif mjs_runes.ts) vs
// le nouveau (`µ.store`, accesseurs PAR CLÉ + `_storeSet`, mjs_store_globals.ts).
// Charge les DEUX fichiers runtime réels via `new Function('µ', src)(µ)` (même
// technique que tests/vault.test.ts) — pas une simulation jouet, le code
// mesuré est CELUI livré. Marqué `.skip` comme le bloc au-dessus ; à lancer
// manuellement : npx mocha tests/benchmark.test.ts --extension ts --require
// tsx/esm --exit --grep "store statisé"
describe.skip('benchmark : µ.state (ancien chemin store) vs µ.store statisé (+ _storeSet)', () => {
  it('mesure le throughput reads + writes', () => {
    // -----------------
    // Ancien chemin : µ.state (Proxy récursif, mjs_runes.ts RÉEL)
    // -----------------
    const runesSrc = readFileSync(join(__dirname, '../src/runtime/mjs_runes.ts'), 'utf-8')
    const µOld: any = {
      _mjs_initStack: [],
      _mjs_rawSet: new WeakSet(),
      _mjs_RAW: Symbol('RAW'),
      _mjs_STRUCT: Symbol('STRUCT'),
      _mjs_registerUniversalDep: () => {},
      _mjs_notifyUniversalChange: () => {},
      warn: () => {},
      error: () => {},
    }
    new Function('µ', runesSrc)(µOld)
    const oldStore = µOld.state({ count: 0 })

    const tOldRead = performance.now()
    let sinkOld = 0
    for (let i = 0; i < ITER; i++) { sinkOld += oldStore.count }
    const oldReadTime = performance.now() - tOldRead

    const tOldWrite = performance.now()
    for (let i = 0; i < ITER; i++) { oldStore.count = i }
    const oldWriteTime = performance.now() - tOldWrite

    // -----------------
    // Nouveau chemin : µ.store (accesseurs, mjs_store_globals.ts RÉEL)
    // -----------------
    const storeSrc = readFileSync(join(__dirname, '../src/runtime/mjs_store_globals.ts'), 'utf-8')
    // `state` minimal : mjs_store_globals.ts pose aussi µ.nav/µ._mjs_env via
    // µ.state({...}) (fonctionnalités hors périmètre de ce bench store $$,
    // cf. en-tête du fichier) — un stub suffit, non mesuré ici.
    const µNew: any = { warn: () => {}, state: (i: any) => i }
    new Function('µ', storeSrc)(µNew)
    µNew._storeDeclare(['count'])
    µNew.store.count = 0

    const tNewRead = performance.now()
    let sinkNew = 0
    for (let i = 0; i < ITER; i++) { sinkNew += µNew.store.count }
    const newReadTime = performance.now() - tNewRead

    // Write via l'accesseur natif (miroir du compilé `$$count = expr`,
    // top-level — l'accesseur `set` délègue à `_storeSet`).
    const tNewWriteAccessor = performance.now()
    for (let i = 0; i < ITER; i++) { µNew.store.count = i }
    const newWriteAccessorTime = performance.now() - tNewWriteAccessor

    // Write via l'API documentée `_storeSet` directement (chemin emprunté par
    // la réhydratation SSR et les écritures externes, cf. mjs_store_globals.ts).
    const tNewWriteApi = performance.now()
    for (let i = 0; i < ITER; i++) { µNew._storeSet('count', i) }
    const newWriteApiTime = performance.now() - tNewWriteApi

    const readRatio = oldReadTime / newReadTime
    const writeAccessorRatio = oldWriteTime / newWriteAccessorTime
    const writeApiRatio = oldWriteTime / newWriteApiTime

    // eslint-disable-next-line no-console
    console.log(`\n  READS  (N=${ITER.toLocaleString('fr-FR')})`)
    // eslint-disable-next-line no-console
    console.log(`    µ.state (ancien) : ${oldReadTime.toFixed(0)}ms (${(ITER / oldReadTime * 1000).toFixed(0)} ops/s)`)
    // eslint-disable-next-line no-console
    console.log(`    µ.store (nouveau): ${newReadTime.toFixed(0)}ms (${(ITER / newReadTime * 1000).toFixed(0)} ops/s)`)
    // eslint-disable-next-line no-console
    console.log(`    Ratio            : ${readRatio.toFixed(2)}× (>1 = nouveau plus rapide)`)
    // eslint-disable-next-line no-console
    console.log(`  WRITES (N=${ITER.toLocaleString('fr-FR')})`)
    // eslint-disable-next-line no-console
    console.log(`    µ.state (ancien)         : ${oldWriteTime.toFixed(0)}ms (${(ITER / oldWriteTime * 1000).toFixed(0)} ops/s)`)
    // eslint-disable-next-line no-console
    console.log(`    µ.store (accesseur natif): ${newWriteAccessorTime.toFixed(0)}ms (${(ITER / newWriteAccessorTime * 1000).toFixed(0)} ops/s) — ratio ${writeAccessorRatio.toFixed(2)}×`)
    // eslint-disable-next-line no-console
    console.log(`    µ.store (_storeSet API)  : ${newWriteApiTime.toFixed(0)}ms (${(ITER / newWriteApiTime * 1000).toFixed(0)} ops/s) — ratio ${writeApiRatio.toFixed(2)}×`)

    assert.equal(sinkOld, 0, 'sanity : les ITER reads ont bien lu la valeur INITIALE (0), écrite APRÈS')
    assert.equal(sinkNew, 0, 'sanity : idem côté nouveau chemin')
    assert.equal(oldStore.count, ITER - 1, 'µ.state : dernière écriture bien appliquée')
    assert.equal(µNew.store.count, ITER - 1, 'µ.store : dernière écriture (_storeSet) bien appliquée')
  })
})

// paths walk vs querySelectorAll
// Mesure le coût de retrouver N nodes dans un clone de template.
// **Skipped par défaut** : happy-dom (emulator Node) ne reflète pas la perf
// browser réelle (walker `childNodes[i]` lent en emulation, natif en browser).
// À mesurer via Playwright sur Chrome pour vrais chiffres.
describe.skip('benchmark : paths walk vs querySelectorAll', () => {
  it('mesure le coût de retrieve N nodes par approche', async () => {
    const { Window } = await import('happy-dom')
    const window = new Window()
    const document = window.document as any

    // Crée un template "moyen" : 20 nodes dynamiques, 5 niveaux de nesting
    const buildTemplate = () => {
      const tpl = document.createElement('template')
      const html: string[] = ['<div>']
      for (let i = 0; i < 5; i++) {
        html.push(`<section><p mjs-id='p${i}'><span mjs-id='s${i}'>`)
        for (let j = 0; j < 4; j++) {
          html.push(`<a><script type='mjs/marker' mjs-t='t${i}_${j}'></script></a>`)
        }
        html.push(`</span></p></section>`)
      }
      html.push('</div>')
      tpl.innerHTML = html.join('')
      return tpl
    }

    const N_MOUNTS = 5000  // Valeur cible pour Playwright/Chromium. Happy-dom OOM à cette taille (emulator gourmand) — ce test ne tourne donc QUE skipé.
    const tpl = buildTemplate()

    // -------- V1 : querySelectorAll markers --------
    const t1 = performance.now()
    for (let i = 0; i < N_MOUNTS; i++) {
      const clone = tpl.content.cloneNode(true) as any
      const nodes: any = {}
      // querySelectorAll [mjs-id]
      clone.querySelectorAll('[mjs-id]').forEach((el: any) => {
        nodes[el.getAttribute('mjs-id')] = el
      })
      // querySelectorAll script[mjs-t]
      clone.querySelectorAll('script[mjs-t]').forEach((meta: any) => {
        const tid = meta.getAttribute('mjs-t')
        const tn = document.createTextNode('')
        nodes[tid] = tn
        meta.parentNode.replaceChild(tn, meta)
      })
    }
    const v1Time = performance.now() - t1

    // -------- V2 : paths walk (childNodes indices) --------
    // Construit le dict de paths équivalent (à la main pour le test)
    const paths: Record<string, number[]> = {}
    // Notre HTML : <div>[section_i: p>span>(a×4)]</div>
    // childNodes du clone : [div]
    // div.childNodes : [section_0, section_1, ...]
    for (let i = 0; i < 5; i++) {
      paths[`p${i}`] = [0, i, 0]            // div → section_i → p
      paths[`s${i}`] = [0, i, 0, 0]         // → span
      for (let j = 0; j < 4; j++) {
        paths[`t${i}_${j}`] = [0, i, 0, 0, j, 0]  // → a_j → marker (à replace par textNode)
      }
    }

    const t2 = performance.now()
    for (let i = 0; i < N_MOUNTS; i++) {
      const clone = tpl.content.cloneNode(true) as any
      const nodes: any = {}
      for (const id in paths) {
        let n = clone
        for (const idx of paths[id]) n = n.childNodes[idx]
        // Pour les "t" markers, on remplace par text node
        if (id.startsWith('t')) {
          const tn = document.createTextNode('')
          n.parentNode.replaceChild(tn, n)
          nodes[id] = tn
        } else {
          nodes[id] = n
        }
      }
    }
    const v2Time = performance.now() - t2

    const ratio = v1Time / v2Time
    // eslint-disable-next-line no-console
    console.log(`\n  Mounts        : ${N_MOUNTS} (20 nodes dyn par mount)`)
    // eslint-disable-next-line no-console
    console.log(`  V1 (qSA × 2)  : ${v1Time.toFixed(0)}ms (${(v1Time / N_MOUNTS * 1000).toFixed(2)}µs/mount)`)
    // eslint-disable-next-line no-console
    console.log(`  V2 (paths)    : ${v2Time.toFixed(0)}ms (${(v2Time / N_MOUNTS * 1000).toFixed(2)}µs/mount)`)
    // eslint-disable-next-line no-console
    console.log(`  Ratio         : ${ratio.toFixed(2)}× plus rapide en V2`)

    assert.ok(ratio >= 1.0, `V2 devrait être au moins équivalent (actuel ${ratio.toFixed(2)}×)`)
  })
})
