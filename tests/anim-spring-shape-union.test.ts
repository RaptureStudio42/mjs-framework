// µ.spring composite (objet/tableau) : union des
// clés/index (courant ∪ cible) au lieu de boucler seulement sur `current`.
//
// AVANT :
// - clé présente SEULEMENT dans la cible : n'anime JAMAIS (absente de
//   `current` toute l'animation), apparaît d'un coup à la dernière frame.
// - clé ABSENTE de la cible : `tgt[k]` undefined → NaN interne → filet
//   anti-divergence global fige TOUT le ressort en 1 frame (même les axes
//   valides), la clé disparaît de `current`.
// - tableau de longueur différente : troncature/complétion silencieuse.
//
// APRÈS : chaque clé/index suit sa PROPRE règle — absente de la cible = garde
// sa valeur courante (figée, n'empêche pas les autres axes) ; absente de
// current = apparaît directement à la valeur cible (sans animer CET axe) ;
// différence de forme = un µ.warn UNIQUE (pas un par frame).

import assert from 'node:assert/strict'

// µ COMPLET posé par CE fichier — cf. le commentaire détaillé
// dans anim-transition-error-handling.test.ts : le `||` seul ne protège que
// le CHARGEMENT, pas l'EXÉCUTION (un fichier comme ujs-hashchange-query-refresh
// écrase `globalThis.µ` EN COURS DE TEST) ; `mjs_spring.ts` relit `µ` en GLOBAL À
// CHAQUE APPEL. before()/after() de chaque describe() ci-dessous réaffirment donc
// notre `µ` juste avant nos tests et restaurent après.
;(globalThis as any).µ = (globalThis as any).µ || { _mjs_interpolatorSet: new WeakSet(), Ticker: { add() {} } }
await import('../src/runtime/mjs_spring.js')
const µ = (globalThis as any).µ

function settle(s: any, max = 5000) { let i = 0; while (i++ < max && s._mjs_step()) {} return i }

describe('µ.spring composite — union courant∪cible', () => {
  let __muBackup: any
  before(() => { __muBackup = (globalThis as any).µ; (globalThis as any).µ = µ })
  after(() => { (globalThis as any).µ = __muBackup })

  let warned: any[] = []
  beforeEach(() => { warned = []; µ.warn = (...a: any[]) => warned.push(a) })

  it('clé présente SEULEMENT dans la cible : apparaît DÈS la 1re frame (pas de undefined, pas de pop tardif)', () => {
    const s = µ.spring({ x: 0 })
    s.value = { x: 10, y: 5 }
    s._mjs_step() // une seule frame
    assert.equal((s.current as any).y, 5, "'y' (absent de current) doit apparaître directement à sa valeur cible, dès la 1re frame")
    assert.notEqual((s.current as any).x, 10, "'x' anime normalement (ne doit pas sauter direct à la cible)")
    settle(s)
    assert.deepEqual(s.current, { x: 10, y: 5 }, 'au settle, les deux axes sont à la cible')
  })

  it('clé ABSENTE de la cible : garde sa valeur courante, N\'EMPÊCHE PAS les autres axes d\'animer', () => {
    const s = µ.spring({ x: 0, y: 0 })
    s.value = { x: 10 } // pas de y
    const firstStep = s._mjs_step()
    assert.equal(firstStep, true, "le ressort ne doit PAS se figer en 1 frame — 'x' est une cible valide qui doit encore animer")
    assert.equal((s.current as any).y, 0, "'y' (absent de la cible) garde sa valeur courante, ne devient pas NaN ni undefined")
    assert.ok(Object.prototype.hasOwnProperty.call(s.current, 'y'), "'y' reste une clé présente dans current")
    const iterations = settle(s)
    assert.ok(iterations > 1, `'x' doit converger sur PLUSIEURS frames comme un ressort normal (obtenu : ${iterations})`)
    assert.ok(Math.abs((s.current as any).x - 10) < 0.5, `x doit converger vers 10 (obtenu ${(s.current as any).x})`)
    assert.equal((s.current as any).y, 0, "'y' reste figé à sa valeur d'origine après settle complet de x")
  })

  it('tableau, cible plus COURTE : le surplus est CONSERVÉ (pas tronqué)', () => {
    const s = µ.spring([0, 0, 0])
    s.value = [10, 20]
    const iterations = settle(s)
    assert.ok(iterations > 1, `[0] et [1] doivent converger sur plusieurs frames (obtenu ${iterations})`)
    assert.equal(s.current.length, 3, 'le 3e élément ne doit PAS être tronqué')
    assert.ok(Math.abs(s.current[0] - 10) < 0.5 && Math.abs(s.current[1] - 20) < 0.5, JSON.stringify(s.current))
    assert.equal(s.current[2], 0, 'le 3e élément (absent de la cible) garde sa valeur courante')
  })

  it('tableau, cible plus LONGUE : le nouvel index apparaît direct (sans animer), les autres animent', () => {
    const s = µ.spring([0, 0])
    s.value = [10, 20, 30]
    s._mjs_step()
    assert.equal(s.current[2], 30, "l'index 2 (absent de current) apparaît direct à sa valeur cible")
    assert.notEqual(s.current[0], 10, 'les index déjà présents animent normalement')
  })

  it('différence de forme (objet) : µ.warn UNIQUE, pas un par frame', () => {
    const s = µ.spring({ x: 0, y: 0 })
    s.value = { x: 10 } // forme différente : 1 clé en moins
    assert.equal(warned.length, 1, 'un seul warn au moment du set, pas un par frame')
    settle(s)
    assert.equal(warned.length, 1, 'toujours 1 seul warn après un settle complet (plusieurs dizaines de frames)')
  })

  it('différence de forme (tableau) : µ.warn UNIQUE', () => {
    const s = µ.spring([0, 0, 0])
    s.value = [10, 20]
    assert.equal(warned.length, 1, 'un seul warn au moment du set')
    settle(s)
    assert.equal(warned.length, 1, 'toujours 1 seul warn après settle complet')
  })

  it('même forme : AUCUN warn (pas de faux positif)', () => {
    const s = µ.spring({ x: 0, y: 0 })
    s.value = { x: 10, y: 20 }
    settle(s)
    assert.equal(warned.length, 0, 'les formes identiques ne doivent jamais déclencher de warn')
  })
})

// bascule de TYPE (objet/tableau <-> scalaire), RÉGRESSION du fix
// union courant∪cible ci-dessus : une clé de `cur` (objet/tableau) est TOUJOURS
// "absente" d'une cible scalaire (pas de clé sur un nombre) → chaque clé prenait
// la branche "figée" (curHas && !tgtHas), `ctx.settled` ne passait JAMAIS à
// false, `_mjs_step` rendait `false` dès la 1re frame (Ticker éjecte la tâche) SANS
// que `current` ait bougé d'un iota, et sans le moindre warn. AVANT ce fix union
// (l'ancien code, cf. old-runtime/mjs_spring.OLD.ts), le mélange scalaire/objet
// produisait un NaN qui déclenchait le filet anti-divergence global (`this.current
// = this.target`) → convergence INSTANTANÉE. Le nouveau code ne doit PAS faire
// PIRE que l'ancien (silencieux + figé à vie est pire qu'un snap instantané).
describe('µ.spring — bascule de TYPE (objet/tableau <-> scalaire)', () => {
  let __muBackup: any
  before(() => { __muBackup = (globalThis as any).µ; (globalThis as any).µ = µ })
  after(() => { (globalThis as any).µ = __muBackup })

  let warned: any[] = []
  beforeEach(() => { warned = []; µ.warn = (...a: any[]) => warned.push(a) })

  it('objet -> scalaire : ne reste plus bloqué à vie (RÉGRESSION confirmée), 1 warn, converge vers la cible', () => {
    const s = µ.spring({ x: 0, y: 0 })
    s.value = 10
    assert.equal(typeof s.current, 'number', 'current doit être reformé en NOMBRE dès le set, plus un objet figé')
    const iterations = settle(s)
    assert.ok(iterations > 1, `doit converger sur plusieurs frames, pas se figer en 1 (obtenu ${iterations})`)
    assert.equal(s.current, 10, 'converge vers la cible scalaire (AVANT fix : restait {x:0,y:0} pour toujours)')
    assert.equal(warned.length, 1, 'un warn de bascule de forme, une seule fois')
  })

  it('tableau -> scalaire : même correctif, converge vers la cible', () => {
    const s = µ.spring([1, 2, 3])
    s.value = 99
    assert.equal(typeof s.current, 'number', 'current doit être reformé en NOMBRE dès le set')
    const iterations = settle(s)
    assert.ok(iterations > 1, `doit converger sur plusieurs frames (obtenu ${iterations})`)
    assert.equal(s.current, 99, 'converge vers la cible scalaire (AVANT fix : restait [1,2,3] pour toujours)')
    assert.equal(warned.length, 1, 'un warn de bascule de forme')
  })

  it('scalaire -> objet : continue de converger (non-régression), current jamais corrompu par une coercion JS parasite', () => {
    const s = µ.spring(0)
    s.value = { x: 10, y: 20 }
    s._mjs_step() // dès le tout premier pas, current doit être dans la nouvelle forme
    assert.equal(typeof s.current, 'object', 'current doit rester/devenir un objet, jamais une chaîne de coercion ("[object Object]NaN")')
    const iterations = settle(s)
    assert.ok(iterations >= 1)
    assert.deepEqual(s.current, { x: 10, y: 20 })
  })
})

// Une bascule de NATURE de conteneur (objet
// plat <-> tableau, PAS scalaire<->composite ci-dessus) n'était détectée QUE par `_mjsShapeDiffers`
// (curIsArr !== tgtIsArr => "differs"), qui se contente de prévenir SANS reformer `current`/
// `velocity`. objet -> tableau : `_mjsSpringStep` prend la branche OBJET (cur n'est pas un Array),
// fusionne les clés nommées de `cur` et les index de `tgt` (for...in sur un tableau) dans UN SEUL
// objet plat -> hybride non-Array (`{x:0,y:0,'0':1,'1':2,'2':3}`). tableau
// -> objet : `_mjsSpringStep` prend la branche ARRAY (cur EST un Array), `Array.isArray(tgt)` faux
// => chaque index reste "figé" pour toujours, les clés de la cible objet ne sont jamais lues —
// ressort mort en silence (aucun warn de PLUS que le 1 déjà posé au set, mais 0 convergence).
describe('µ.spring — bascule de NATURE de conteneur (objet <-> tableau)', () => {
  let __muBackup: any
  before(() => { __muBackup = (globalThis as any).µ; (globalThis as any).µ = µ })
  after(() => { (globalThis as any).µ = __muBackup })

  let warned: any[] = []
  beforeEach(() => { warned = []; µ.warn = (...a: any[]) => warned.push(a) })

  it('objet -> tableau : current redevient un VRAI Array dès le set (plus d\'hybride), 1 warn, converge', () => {
    const s = µ.spring({ x: 0, y: 0 })
    s.value = [1, 2, 3]
    assert.ok(Array.isArray(s.current), 'current doit être reformé en TABLEAU dès le set, plus un hybride objet+index')
    const iterations = settle(s)
    assert.ok(iterations > 1, `doit converger sur plusieurs frames, pas se figer en 1 (obtenu ${iterations})`)
    assert.deepEqual(s.current, [1, 2, 3], 'converge vers la cible tableau')
    assert.equal(warned.length, 1, 'un seul warn de bascule de nature')
  })

  it('tableau -> objet : current redevient un objet PLAT dès le set (plus figé à vie), converge vers {a, b}', () => {
    const s = µ.spring([1, 2, 3])
    s.value = { a: 10, b: 20 }
    assert.equal(Array.isArray(s.current), false, 'current doit être reformé en OBJET dès le set, plus un tableau figé')
    const iterations = settle(s)
    assert.ok(iterations > 1, `doit converger sur plusieurs frames, pas se figer en 1 (obtenu ${iterations})`)
    assert.deepEqual(s.current, { a: 10, b: 20 }, 'converge vers la cible objet (AVANT fix : restait [1,2,3] pour toujours)')
    assert.equal(warned.length, 1, 'un seul warn de bascule de nature')
  })
})
