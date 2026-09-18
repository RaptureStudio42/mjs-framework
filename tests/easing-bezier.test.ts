// µ.easing.bezier(x1, y1, x2, y2) + µ.easing.resolve('cubic-bezier(...)').
// Chargement du runtime = mécanisme de csp-runtime.test.ts (l.22-50) : EASING_SRC lu une fois,
// document/CSSStyleSheet posés sur globalThis AVANT `new Function('µ', EASING_SRC)(µ)` (le module
// entier s'évalue, `ensureSheet` y fait référence même si ces tests ne l'appellent pas), retirés en
// afterEach pour ne pas polluer les fichiers suivants dans le même run mocha.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(__dirname, '..', 'src', 'runtime')
const EASING_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_easing.ts'), 'utf-8')

describe('µ.easing.bezier + resolve(cubic-bezier)', function () {
  afterEach(() => {
    const g: any = globalThis
    delete g.document
    delete g.CSSStyleSheet
  })

  function load(win: any) {
    const g: any = globalThis
    g.document = win.document
    g.CSSStyleSheet = win.CSSStyleSheet
    const warns: string[] = []
    const µ: any = { log() {}, warn(m: any) { warns.push(String(m)) }, error() {}, anim: {}, _csp: false, debug: true }
    new Function('µ', EASING_SRC)(µ)
    return { µ, warns }
  }

  it('bezier(0, 0, 1, 1) : droite — identité en 0.3, bornes 0/1, clamp hors [0,1]', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    const fn = µ.easing.bezier(0, 0, 1, 1)
    assert.ok(Math.abs(fn(0.3) - 0.3) < 1e-3, `attendu ≈ 0.3, reçu ${fn(0.3)}`)
    assert.equal(fn(0), 0)
    assert.equal(fn(1), 1)
    assert.equal(fn(-0.5), 0, 't < 0 clampé à 0')
    assert.equal(fn(1.5), 1, 't > 1 clampé à 1')
  })

  it('bezier(0.42, 0, 1, 1) en 0.5 : courbe ease-in CSS (≈ 0.3153)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    const fn = µ.easing.bezier(0.42, 0, 1, 1)
    assert.ok(Math.abs(fn(0.5) - 0.3153) < 0.01, `attendu ≈ 0.3153, reçu ${fn(0.5)}`)
  })

  it('bezier(0.2, 0.7, 0.3, 1) en 0.5 : entre 0.85 et 0.95', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    const y = µ.easing.bezier(0.2, 0.7, 0.3, 1)(0.5)
    assert.ok(y > 0.85 && y < 0.95, `attendu entre 0.85 et 0.95, reçu ${y}`)
  })

  it("resolve('cubic-bezier(0.42, 0, 1, 1)') : fonction, ≈ 0.3153 en 0.5", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    const fn = µ.easing.resolve('cubic-bezier(0.42, 0, 1, 1)')
    assert.equal(typeof fn, 'function')
    assert.ok(Math.abs(fn(0.5) - 0.3153) < 0.01, `attendu ≈ 0.3153, reçu ${fn(0.5)}`)
  })

  it("resolve('cubic-bezier(.2,.7,.3,1)') : nombres à point initial, sans espaces — même plage", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    const fn = µ.easing.resolve('cubic-bezier(.2,.7,.3,1)')
    assert.equal(typeof fn, 'function')
    const y = fn(0.5)
    assert.ok(y > 0.85 && y < 0.95, `attendu entre 0.85 et 0.95, reçu ${y}`)
  })

  it("resolve('cubic-bezier(2, 0, 1, 1)') : x1 hors [0,1], invalide en CSS — repli cubicOut + avertissement", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ, warns } = load(win)
    const fn = µ.easing.resolve('cubic-bezier(2, 0, 1, 1)')
    assert.equal(fn, µ.easing.cubicOut)
    assert.equal(warns.length, 1)
    assert.match(warns[0], /cubic-bezier/)
  })

  it("resolve('ease-out') et resolve('linear') : chaînes CSS courantes inchangées", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ } = load(win)
    assert.equal(µ.easing.resolve('ease-out'), µ.easing.cubicOut)
    assert.equal(µ.easing.resolve('linear'), µ.easing.linear)
  })

  it("resolve('bidule') : chaîne inconnue — repli cubicOut + avertissement (inchangé)", () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const { µ, warns } = load(win)
    const fn = µ.easing.resolve('bidule')
    assert.equal(fn, µ.easing.cubicOut)
    assert.equal(warns.length, 1)
  })
})
