// `damping=0` était accepté
// par `_mjsClampDamping` (borne basse à 0 strict). Le déterminant de la
// matrice d'état de la récurrence Euler semi-implicite est `1-damping` : à
// damping=0, il vaut 1 → AUCUNE dissipation d'énergie → oscillation
// ENTRETENUE indéfiniment → `_mjs_step()` ne retourne JAMAIS `false` → tâche
// µ.Ticker/rAF IMMORTELLE (re-render à chaque frame, POUR TOUJOURS, même
// après destroy du composant). Fix : plancher epsilon (0.01) au lieu de 0.

import assert from 'node:assert/strict'

;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} } }
await import('../src/runtime/mjs_spring.js')
const µ = (globalThis as any).µ

// Comme spring-object.test.ts, mais avec un plafond BAS pour prouver qu'un
// ressort à damping=0 (AVANT le fix) ne s'arrêterait jamais dans cette
// fenêtre — un test qui laisserait tourner 5000 itérations ne distinguerait
// pas "converge lentement" de "ne converge jamais".
function settleOrTimeout(s: any, max = 2000): { settled: boolean; iterations: number } {
  let i = 0
  while (i < max) {
    i++
    if (!s._mjs_step()) return { settled: true, iterations: i }
  }
  return { settled: false, iterations: i }
}

describe('µ.spring — damping=0 ne doit plus jamais tourner indéfiniment', () => {
  it('damping=0 au CONSTRUCTEUR est clampé à une valeur strictement positive', () => {
    const s = µ.spring(0, 0.15, 0)
    assert.ok(s.damping > 0, `damping doit être > 0, reçu ${s.damping}`)
  })

  it('damping=0 via le SETTER est clampé à une valeur strictement positive', () => {
    const s = µ.spring(0, 0.15, 0.5)
    s.damping = 0
    assert.ok(s.damping > 0, `damping doit être > 0 après set, reçu ${s.damping}`)
  })

  it('ressort construit avec damping=0 SETTLE en temps fini (ne boucle plus indéfiniment)', () => {
    const s = µ.spring(0, 0.15, 0)
    s.value = 100
    const { settled, iterations } = settleOrTimeout(s)
    assert.ok(settled, `AVANT le fix : oscillation entretenue, jamais settled (${iterations} itérations sans converger)`)
    assert.ok(Math.abs(s.current - 100) < 1, `current doit converger vers la cible, reçu ${s.current}`)
  })

  it('ressort composite {x,y} avec damping=0 (setter) settle aussi en temps fini', () => {
    const s = µ.spring({ x: 0, y: 0 }, 0.15, 0.5)
    s.damping = 0
    s.value = { x: 50, y: -20 }
    const { settled } = settleOrTimeout(s)
    assert.ok(settled, 'AVANT le fix : le composite oscillerait indéfiniment sur chaque axe')
  })

  it('cas nominal (damping=0.8 par défaut) : toujours inchangé', () => {
    const s = µ.spring(0)
    assert.equal(s.damping, 0.8)
  })
})
