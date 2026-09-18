// Tests purs de mjs_det.ts — µ.random (mulberry32) + µ.det.sin/
// cos/atan2 (approximation polynomiale déterministe) : AUCUN réseau, AUCUN serveur — module 'schema'
// autonome (cf. sa tête de fichier), chargé SEUL via `new Function('µ', src)`, MÊME technique que
// tests/mjs-server-action.test.ts pour le client. Couvre : reproductibilité stricte de la séquence
// mulberry32 (même graine ⇒ même suite, y compris entre DEUX instanciations indépendantes du module —
// simule 2 « moteurs » séparés), bornes de .int(), erreur mesurée de µ.det.sin/cos/atan2 vs Math.*
// (précision ANNONCÉE au commentaire de tête de mjs_det.ts), déterminisme cross-appel/cross-contexte.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const detSrc = readFileSync(join(__dirname, '../src/runtime/mjs_det.ts'), 'utf8')

// mjs_det.ts ne référence AUCUNE autre clé de µ (ni .error/.warn/.state, cf. sa tête de fichier) —
// stub le plus nu possible, juste assez pour recevoir µ.random/µ.det posés dessus
function makeMu(): any {
  const µ: any = {}
  new Function('µ', detSrc)(µ)
  return µ
}

describe('mjs_det — µ.random (mulberry32) + µ.det.sin/cos/atan2', () => {
  it('a. mulberry32 : même graine ⇒ MÊME séquence, y compris entre deux instanciations INDÉPENDANTES du module (simule deux moteurs séparés)', () => {
    const µ1 = makeMu(), µ2 = makeMu()
    const r1 = µ1.random(1), r2 = µ2.random(1)
    const seq1 = Array.from({ length: 10 }, () => r1.next())
    const seq2 = Array.from({ length: 10 }, () => r2.next())
    assert.deepEqual(seq1, seq2)
    // valeur de référence FIGÉE (mulberry32(1), 1er tirage) — pin de non-régression de l'algorithme
    assert.ok(Math.abs(seq1[0] - 0.6270739405881613) < 1e-15, `1er tirage mulberry32(1) attendu ≈0.6270739405881613, reçu ${seq1[0]}`)
  })

  it("b. mulberry32 : graines DIFFÉRENTES ⇒ séquences différentes (la graine compte vraiment)", () => {
    const µ = makeMu()
    const a = µ.random(1).next()
    const b = µ.random(2).next()
    assert.notEqual(a, b)
  })

  it('c. .next() reste dans [0, 1) sur un grand échantillon, .int(min,max) est BORNÉ INCLUSIF et couvre toutes les valeurs', () => {
    const µ = makeMu()
    const rng = µ.random(2026)
    for (let i = 0; i < 2000; i++) {
      const v = rng.next()
      assert.ok(v >= 0 && v < 1, `next() hors [0,1) : ${v}`)
    }
    const rngDe = µ.random(9)
    const vus = new Set<number>()
    for (let i = 0; i < 3000; i++) {
      const v = rngDe.int(1, 6)
      assert.ok(Number.isInteger(v) && v >= 1 && v <= 6, `int(1,6) hors bornes : ${v}`)
      vus.add(v)
    }
    assert.deepEqual(Array.from(vus).sort(), [1, 2, 3, 4, 5, 6], 'un dé à 6 faces doit finir par montrer chaque face sur 3000 tirages')
  })

  it('d. µ.det.sin/cos : erreur ABSOLUE vs Math.sin/cos bornée ≤ 0.002 (précision annoncée ≈0.00163, cf. tête de mjs_det.ts) sur un balayage fin [-2π, 2π]', () => {
    const µ = makeMu()
    let maxErrSin = 0, maxErrCos = 0
    for (let deg = -720; deg <= 720; deg += 0.5) {
      const rad = deg * Math.PI / 180
      maxErrSin = Math.max(maxErrSin, Math.abs(µ.det.sin(rad) - Math.sin(rad)))
      maxErrCos = Math.max(maxErrCos, Math.abs(µ.det.cos(rad) - Math.cos(rad)))
    }
    assert.ok(maxErrSin <= 0.002, `erreur max sin ${maxErrSin} dépasse la précision annoncée`)
    assert.ok(maxErrCos <= 0.002, `erreur max cos ${maxErrCos} dépasse la précision annoncée`)
  })

  it('e. µ.det.atan2 : erreur ABSOLUE (rad) vs Math.atan2 bornée ≤ 0.002 rad (précision annoncée ≈0.0015 rad, cf. tête de mjs_det.ts), invariante d\'échelle', () => {
    const µ = makeMu()
    let maxErr = 0
    for (const radius of [0.1, 1, 5, 37]) {
      for (let deg = -180; deg <= 180; deg += 1) {
        const rad = deg * Math.PI / 180
        const y = radius * Math.sin(rad), x = radius * Math.cos(rad)
        maxErr = Math.max(maxErr, Math.abs(µ.det.atan2(y, x) - Math.atan2(y, x)))
      }
    }
    assert.ok(maxErr <= 0.002, `erreur max atan2 ${maxErr} rad dépasse la précision annoncée`)
    // cas dégénéré (0,0) — convention MÊME repli que Math.atan2(0,0) : 0, jamais NaN/throw
    assert.equal(µ.det.atan2(0, 0), 0)
  })

  it('f. déterminisme cross-appel/cross-contexte : mêmes entrées ⇒ résultats BIT-IDENTIQUES, sur des rappels répétés ET entre deux instanciations séparées du module', () => {
    const µ1 = makeMu(), µ2 = makeMu()
    const echantillons = [0, 0.7853981633974483, 2.1, -1.9, 5.5, -10]
    for (const x of echantillons) {
      // rappels répétés DANS le même contexte — fonctions pures, aucun état caché
      assert.equal(µ1.det.sin(x), µ1.det.sin(x))
      assert.equal(µ1.det.cos(x), µ1.det.cos(x))
      // deux instanciations INDÉPENDANTES du module (simule deux moteurs séparés, cf. tête de fichier)
      assert.equal(µ1.det.sin(x), µ2.det.sin(x))
      assert.equal(µ1.det.cos(x), µ2.det.cos(x))
      assert.equal(µ1.det.atan2(x, 1), µ2.det.atan2(x, 1))
    }
  })
})
