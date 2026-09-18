// µ.interpolate : recibler EXACTEMENT sur la valeur COURANTE
// (≠ ancienne cible) déclenchait toute la durée d'animation pour rien (60
// notifications, `current` ne bougeant jamais). Le court-circuit existant ne
// comparait `newTarget` qu'à l'ANCIENNE cible (`this.target`), jamais à
// `this.current`. Correctif : cible === valeur courante → aucune animation,
// `.current` inchangé, 0 frame.

import assert from 'node:assert/strict'

// µ COMPLET posé par CE fichier — cf. le commentaire détaillé
// dans anim-transition-error-handling.test.ts : le `||` seul ne protège que
// le CHARGEMENT, pas l'EXÉCUTION (un fichier comme ujs-hashchange-query-refresh
// écrase `globalThis.µ` EN COURS DE TEST) ; `mjs_interpolate.ts` relit `µ` en
// GLOBAL À CHAQUE APPEL. before()/after() réaffirment donc notre `µ` juste avant
// nos tests et restaurent après.
;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} }, warn() {} }
await import('../src/runtime/mjs_interpolate.js')
const µ = (globalThis as any).µ

describe('µ.interpolate — recibler sur la valeur courante', () => {
  let __muBackup: any
  before(() => { __muBackup = (globalThis as any).µ; (globalThis as any).µ = µ })
  after(() => { (globalThis as any).µ = __muBackup })

  it('re-cibler en plein vol sur current (≠ ancienne target) : 0 frame, current inchangé, pas ajouté au Ticker', () => {
    let tickerAdds = 0
    const origAdd = µ.Ticker.add
    µ.Ticker.add = (...a: any[]) => { tickerAdds++; return origAdd.apply(µ.Ticker, a) }

    const it = µ.interpolate(0, 400)
    it.value = 100 // 1re cible, on n'ira pas jusqu'au bout
    it._mjs_step(performance.now() + 50) // en vol : current != 0, != 100
    const curBefore = it.current
    tickerAdds = 0 // on ne compte qu'à partir d'ICI

    it.value = curBefore // recible EXACTEMENT sur la valeur courante

    assert.equal(tickerAdds, 0, 'aucun ajout au Ticker : rien à animer, 0 frame consommée (en usage réel, _mjs_step ne sera donc plus jamais rappelé pour ce retarget)')
    assert.equal(it.current, curBefore, 'current inchangé par le simple fait de recibrer dessus')

    µ.Ticker.add = origAdd
  })

  it('.target reflète bien la nouvelle cible (pas figé sur l\'ancienne)', () => {
    const it = µ.interpolate(0, 400)
    it.value = 100
    it._mjs_step(performance.now() + 50)
    const curBefore = it.current
    it.value = curBefore
    assert.equal(it.target, curBefore, 'target doit refléter la valeur sur laquelle on vient de recibrer')
  })

  it('cas nominal inchangé : recibler sur une valeur DIFFÉRENTE de current anime normalement', () => {
    let tickerAdds = 0
    const origAdd = µ.Ticker.add
    µ.Ticker.add = (...a: any[]) => { tickerAdds++; return origAdd.apply(µ.Ticker, a) }
    const it = µ.interpolate(0, 100)
    it.value = 100
    assert.equal(tickerAdds, 1, 'une cible réellement nouvelle continue de planifier une animation')
    it._mjs_step(performance.now() + 100)
    assert.ok(Math.abs(it.current - 100) < 1)
    µ.Ticker.add = origAdd
  })

  it('cible === ancienne cible (comportement PRÉEXISTANT, non régressé) : toujours court-circuité', () => {
    const it = µ.interpolate(10)
    let tickerAdds = 0
    const origAdd = µ.Ticker.add
    µ.Ticker.add = (...a: any[]) => { tickerAdds++; return origAdd.apply(µ.Ticker, a) }
    it.value = 10 // égal à target ET à current (jamais bougé)
    assert.equal(tickerAdds, 0)
    µ.Ticker.add = origAdd
  })

  it('reciblage sur current AVEC UN TICKER RÉEL (pas un stub add(){}) : une frame résiduelle ne fait plus dériver current, la tâche est retirée', () => {
    // Ticker RÉEL minimal (façon mjs_runes.ts) : garde les tâches dans un Set,
    // appelle _mjs_step(now) à chaque frame, éjecte une tâche dont _mjs_step() rend
    // false. Un stub add(){} ne peut PAS reproduire le glitch (aucune frame
    // résiduelle n'est jamais rejouée).
    const tasks = new Set<any>()
    const realTicker = {
      add(task: any) { tasks.add(task) },
      frame(now: number) {
        for (const t of Array.from(tasks)) {
          const alive = t._mjs_step(now)
          if (!alive) tasks.delete(t)
        }
      },
    }
    const origTicker = µ.Ticker
    const origNow = performance.now
    let now = 1000
    performance.now = () => now
    µ.Ticker = realTicker as any

    try {
      const it2 = µ.interpolate(0, 400)
      it2.value = 100
      assert.equal(tasks.size, 1, 'la tâche est bien ajoutée au Ticker réel')

      now += 50
      realTicker.frame(now) // en vol
      const curBefore = it2.current
      assert.ok(curBefore > 0 && curBefore < 100, 'en vol : ni la valeur de départ ni la cible')
      assert.equal(tasks.size, 1, 'animation pas finie : la tâche reste dans le Ticker')

      it2.value = curBefore // recible EXACTEMENT sur current — déclenche le fast-path

      now += 16 // UNE frame supplémentaire du Ticker réel
      realTicker.frame(now)
      assert.equal(it2.current, curBefore, 'current STRICTEMENT inchangé après la frame résiduelle (AVANT le fix : dérivait)')
      assert.equal(tasks.size, 0, 'la tâche précédente est retirée du Ticker — pas de frame gaspillée jusqu\'à épuisement de la durée')
    } finally {
      µ.Ticker = origTicker
      performance.now = origNow
    }
  })
})
