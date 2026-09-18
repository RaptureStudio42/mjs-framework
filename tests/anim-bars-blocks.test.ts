// deux animations intégrées NEUVES bars / blocks, jumelles élément des
// préréglages de page homonymes (mjs_vt_presets.ts, 8 bandes / 24 tuiles en cascade). Ici pas de
// calque noir : la région VISIBLE de l'élément est un clip-path polygon(...) dont le nombre de
// sommets reste CONSTANT d'une trame à l'autre (condition d'interpolation WAAPI). Chargement du
// factory : lecture de la source + `new Function('µ', 'return (...)')`, même technique que
// tests/anim-typewriter-text-node-guard.test.ts — le fichier est une expression IIFE, pas un
// module ES exportable tel quel. Pas de happy-dom : `setup(node)` ne lit rien du nœud pour bars,
// seulement `getBoundingClientRect()` pour blocks (un mock objet suffit).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ANIM_DIR = join(__dirname, '..', 'src', 'runtime', 'animations')

function loadFactory(name: string, µMock: any) {
  const src = readFileSync(join(ANIM_DIR, `${name}.ts`), 'utf-8')
  return new Function('µ', 'return (' + src.trim().replace(/;\s*$/, '') + ')')(µMock)
}

function makeµ() {
  const warns: string[] = []
  const resolved: any[] = []
  const µMock = {
    warn: function (m: any) { warns.push(String(m)) },
    easing: {
      resolve: function (e: any) { resolved.push(e); return typeof e === 'function' ? e : function (t: number) { return t } },
      linear: function (t: number) { return t },
      cubicIn: function (t: number) { return t * t * t },
      cubicOut: function (t: number) { return 1 - Math.pow(1 - t, 3) },
    },
  }
  return { µMock, warns, resolved }
}

// css(t,u) rend { clipPath: 'polygon(x1% y1%, x2% y2%, …)' } — extrait le tableau de points.
function points(css: string) {
  return css.slice('polygon('.length, -1).split(', ')
}

describe('animations/bars.ts — rideau de bandes en cascade (clip-path)', function () {
  it('défaut (down, count 8) : duration 640, easing linear résolu, intro === outro, 18 sommets, valeurs à t=1 et t=0', function () {
    const { µMock, resolved } = makeµ()
    const { intro, outro } = loadFactory('bars', µMock)({})
    assert.equal(intro, outro, 'intro et outro doivent être le même setup')
    const cfg = intro({})
    assert.equal(cfg.duration, 640)
    assert.ok(resolved.indexOf('linear') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    const p1 = points(cfg.css(1, 0).clipPath)
    const p0 = points(cfg.css(0, 1).clipPath)
    assert.equal(p1.length, 18)
    assert.equal(p0.length, 18)
    assert.equal(p1[0], '0% 0%')
    assert.equal(p1[1], '100% 0%')
    assert.equal(p1[2], '100% 100%')
    assert.equal(p1[3], '87.5% 100%')
    assert.equal(p1[p1.length - 1], '0% 100%')
    assert.equal(p0[2], '100% 0%')
    assert.equal(p0[3], '87.5% 0%')
    assert.equal(p0[p0.length - 1], '0% 0%')
  })

  it('t = 130 / 575 : bande 0 à mi-course (cubicIn(0.5) = 0.125 → 12.5 %), bande 7 pas commencée', function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({}).intro({})
    const t = 130 / 575
    const p = points(cfg.css(t, 1 - t).clipPath)
    assert.equal(p[2], '100% 0%', 'bande 7 pas commencée')
    assert.equal(p[p.length - 2], '12.5% 12.5%')
    assert.equal(p[p.length - 1], '0% 12.5%')
  })

  it('{ count: 4 } : 10 sommets, point[3] === \'75% 100%\' à t=1', function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({ count: 4 }).intro({})
    const p = points(cfg.css(1, 0).clipPath)
    assert.equal(p.length, 10)
    assert.equal(p[3], '75% 100%')
  })

  it("{ dir: 'up' } : à t=0 point[0] et point[2], à t=1 point[2]", function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({ dir: 'up' }).intro({})
    const p0 = points(cfg.css(0, 1).clipPath)
    const p1 = points(cfg.css(1, 0).clipPath)
    assert.equal(p0[0], '0% 100%')
    assert.equal(p0[2], '100% 100%')
    assert.equal(p1[2], '100% 0%')
  })

  it("{ direction: 'right' } : point[0], point[1], point[2] à t=1 et à t=0", function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({ direction: 'right' }).intro({})
    const p0 = points(cfg.css(0, 1).clipPath)
    const p1 = points(cfg.css(1, 0).clipPath)
    assert.equal(p1[0], '0% 0%')
    assert.equal(p1[1], '0% 100%')
    assert.equal(p1[2], '100% 100%')
    assert.equal(p0[2], '0% 100%')
  })

  it("{ dir: 'left' } : point[0] à t=1, point[2] à t=0 et à t=1", function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({ dir: 'left' }).intro({})
    const p0 = points(cfg.css(0, 1).clipPath)
    const p1 = points(cfg.css(1, 0).clipPath)
    assert.equal(p1[0], '100% 0%')
    assert.equal(p0[2], '100% 100%')
    assert.equal(p1[2], '0% 100%')
  })

  it("{ dir: 'up', direction: 'left' } : dir gagne — comportement up", function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('bars', µMock)({ dir: 'up', direction: 'left' }).intro({})
    const p0 = points(cfg.css(0, 1).clipPath)
    assert.equal(p0[0], '0% 100%', 'comportement up, pas left')
  })

  it("{ dir: 'diagonal' } : direction invalide — 1 warn explicite, repli 'down'", function () {
    const { µMock, warns } = makeµ()
    const cfg = loadFactory('bars', µMock)({ dir: 'diagonal' }).intro({})
    assert.equal(warns.length, 1)
    assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
    const p1 = points(cfg.css(1, 0).clipPath)
    assert.equal(p1[0], '0% 0%', 'comportement de down (repli)')
    assert.equal(p1[1], '100% 0%', 'comportement de down (repli)')
  })
})

describe('animations/blocks.ts — damier en vague diagonale (clip-path)', function () {
  const node = { getBoundingClientRect: function () { return { width: 600, height: 400 } } }

  it('défaut (cols 6, rows 4) : duration 620, easing linear résolu, 142 sommets à t=0, t=0.5 et t=1', function () {
    const { µMock, resolved } = makeµ()
    const cfg = loadFactory('blocks', µMock)({}).intro(node)
    assert.equal(cfg.duration, 620)
    assert.ok(resolved.indexOf('linear') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    assert.equal(points(cfg.css(0, 1).clipPath).length, 5 * 24 + 22)
    assert.equal(points(cfg.css(0.5, 0.5).clipPath).length, 5 * 24 + 22)
    assert.equal(points(cfg.css(1, 0).clipPath).length, 5 * 24 + 22)
  })

  it("à t=0 : les 5 premiers points (tuile 0,0, aire nulle = caché) valent tous '8.33% 12.5%'", function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('blocks', µMock)({}).intro(node)
    const p = points(cfg.css(0, 1).clipPath)
    for (let i = 0; i < 5; i++) assert.equal(p[i], '8.33% 12.5%', `point[${i}]`)
  })

  it('à t=1 (s = 1.02, theta = 0) : les 4 coins + retour de la tuile (0,0)', function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('blocks', µMock)({}).intro(node)
    const p = points(cfg.css(1, 0).clipPath)
    assert.equal(p[0], '-0.17% -0.25%')
    assert.equal(p[1], '16.83% -0.25%')
    assert.equal(p[2], '16.83% 25.25%')
    assert.equal(p[3], '-0.17% 25.25%')
    assert.equal(p[4], p[0])
  })

  it('à t = 200 / 560 : tuile (0,0) pas encore confondue, dernière tuile (5,3) encore confondue au centre', function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('blocks', µMock)({}).intro(node)
    const t = 200 / 560
    const p = points(cfg.css(t, 1 - t).clipPath)
    assert.notEqual(p[0], p[1], 'tuile (0,0) : coins pas confondus (p=200/240)')
    assert.equal(p[5 * 23], '91.67% 87.5%')
    assert.equal(p[5 * 23 + 1], '91.67% 87.5%')
    assert.equal(p[5 * 23 + 2], '91.67% 87.5%')
    assert.equal(p[5 * 23 + 3], '91.67% 87.5%')
    assert.equal(p[5 * 23 + 4], '91.67% 87.5%')
  })

  it('{ cols: 2, rows: 1 } : 10 sommets', function () {
    const { µMock } = makeµ()
    const cfg = loadFactory('blocks', µMock)({ cols: 2, rows: 1 }).intro(node)
    assert.equal(points(cfg.css(1, 0).clipPath).length, 10)
  })

  it('node sans getBoundingClientRect ({}) : ne lève pas, rend 142 sommets', function () {
    const { µMock } = makeµ()
    const { intro } = loadFactory('blocks', µMock)({})
    let cfg: any
    assert.doesNotThrow(() => { cfg = intro({}) })
    assert.equal(points(cfg.css(1, 0).clipPath).length, 5 * 24 + 22)
  })
})
