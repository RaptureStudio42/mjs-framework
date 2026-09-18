// Avertissement de compilation — `#{…}` (interpolation Civet, réservée au
// <script>) collé dans un attribut STATIQUE. Piège :
// `title="Réservé à #{$pierre}"` ressemble à une interpolation Civet mais
// l'attribut MJS s'écrit `{…}` (sans `#`) — la regex d'interpolation d'attribut
// matche le `{…}` malgré le `#` : la valeur interpole et reste
// réactive, seul un `#` parasite s'affiche devant. Personne ne le remarque à
// la compilation aujourd'hui. AVERTISSEMENT seul (jamais une erreur : un
// attribut peut légitimement vouloir ce texte littéral) — CIBLÉ sur les
// attributs statiques uniquement, jamais les nœuds texte (une page de doc y
// montre légitimement du code Civet), jamais les valeurs déjà dynamiques `{…}`.
//
// Harnais copié de tests/lint-max-state-vars.test.ts (même famille de feature :
// avertissement console.warn compile-time via transpile() direct, en process).
// PAS le harnais Bundler+worker_threads de tests/attr-multi-interpolation-reactivity.test.ts :
// celui-ci exécute la compilation dans un thread worker séparé — son
// `console.warn` n'est pas le même objet que celui patché ici (realm distinct),
// l'interception y serait invisible.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// espionne console.warn le temps d'un transpile, ne garde que les avertissements
// de CETTE clé (marqueur stable : `#{` apparaît littéralement dans le message,
// en français comme en anglais)
async function warningsFor(src: string, moduleName: string): Promise<string[]> {
  const orig = console.warn
  const caught: string[] = []
  console.warn = (...a: unknown[]) => { const s = String(a[0]); if (s.includes('#{')) caught.push(s) }
  try { await transpile(src, { moduleName }) } finally { console.warn = orig }
  return caught
}

describe('avertissement compile-time — #{…} (interpolation Civet) dans un attribut STATIQUE', function () {
  this.timeout(30000)

  it('attribut statique fautif (title="…#{$pierre}") : EXACTEMENT 1 avertissement, module + nom d\'attribut présents', async () => {
    const src = '<b title="Réservé à #{$pierre}">x</b>'
    const warnings = await warningsFor(src, 'attrcivetwarn')
    assert.equal(warnings.length, 1, `avertissements capturés : ${JSON.stringify(warnings)}`)
    assert.match(warnings[0], /attrcivetwarn/)
    assert.match(warnings[0], /title/)
  })

  it('attribut DYNAMIQUE (title={$x}, sans guillemets) : 0 avertissement', async () => {
    const src = '<script>\n$x = 1\n</script>\n<b title={$x}>dynamique</b>'
    const warnings = await warningsFor(src, 'attrcivetwarn-dyn')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })

  it('nœud TEXTE (pas un attribut) : 0 avertissement', async () => {
    const src = '<script>\n$x = 1\n</script>\n<p>du code Civet : #{$x}</p>'
    const warnings = await warningsFor(src, 'attrcivetwarn-texte')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })

  it('attribut statique NORMAL (sans #{) : 0 avertissement', async () => {
    const src = '<b title="normal">x</b>'
    const warnings = await warningsFor(src, 'attrcivetwarn-normal')
    assert.equal(warnings.length, 0, `aucun avertissement attendu : ${JSON.stringify(warnings)}`)
  })
})
