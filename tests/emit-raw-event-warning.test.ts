// Avertissement de compilation — `µemit 'nom', e` dans un handler INLINE
// relaie l'ÉVÉNEMENT DOM reçu, pas sa charge :
// le parent lit `e.data` sur le CustomEvent émis et trouve `undefined`, zéro
// erreur nulle part. Ciblé aux handlers inline SEULEMENT : le générateur
// synthétise lui-même leur signature `(e, el) => {…}` — le nom `e` du 1er
// paramètre y est donc FIABLE, contrairement à une méthode `<script>` nommée
// par le dev. Jamais une erreur, un simple avertissement orientant vers
// `e.data`.
//
// Harnais copié de tests/attr-civet-interpolation-warning.test.ts (même
// famille de feature : avertissement console.warn compile-time via
// transpile() direct, en process).

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// espionne console.warn le temps d'un transpile, ne garde que les avertissements
// de CETTE clé (marqueur stable : `µemit` apparaît littéralement dans le message)
async function warningsFor(src: string, moduleName: string): Promise<string[]> {
  const orig = console.warn
  const caught: string[] = []
  console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.includes('µemit')) caught.push(s) }
  try { await transpile(src, { moduleName }) } finally { console.warn = orig }
  return caught
}

describe('avertissement compile-time — µemit \'nom\', e (relais événement brut) dans un handler inline', function () {
  this.timeout(30000)

  it("@click={µemit 'x', e} : EXACTEMENT 1 avertissement", async () => {
    const src = `<button @click={µemit 'x', e}>go</button>`
    const warnings = await warningsFor(src, 'rawemita')
    assert.equal(warnings.length, 1, `avertissements capturés : ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /rawemita/)
  })

  it("@click={µemit 'x', e.data} : 0 avertissement", async () => {
    const src = `<button @click={µemit 'x', e.data}>go</button>`
    const warnings = await warningsFor(src, 'rawemitb')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })

  it("@click={µemit 'x', {a: 1}} : 0 avertissement", async () => {
    const src = `<button @click={µemit 'x', {a: 1}}>go</button>`
    const warnings = await warningsFor(src, 'rawemitc')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })

  it("@click={µemit 'x'} (sans 2e argument) : 0 avertissement", async () => {
    const src = `<button @click={µemit 'x'}>go</button>`
    const warnings = await warningsFor(src, 'rawemitd')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })
})
