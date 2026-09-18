// animations/iris.ts et animations/swipe.ts (built-in NEUVES) : iris est un rond qui
// s'ouvre au centre, swipe un front dégradé qui balaie l'élément et le révèle derrière lui. Ce
// sont les jumeaux « sur un élément » des rideaux de page iris/swipe de mjs_vt_presets.ts (là-bas
// un calque noir couvre l'écran puis révèle ; ici l'élément est révélé à travers un masque, sans
// calque, sans noir).
//
// Chargement du factory : lecture de la source + `new Function('µ', 'return (...)')`, même
// technique que anim-typewriter-text-node-guard.test.ts — le fichier est une expression IIFE,
// pas un module ES exportable tel quel. Pas de happy-dom nécessaire : setup(node) ne lit rien du
// nœud, node = {}.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const IRIS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', 'iris.ts'), 'utf-8')
const SWIPE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', 'swipe.ts'), 'utf-8')

function loadFactory(src: string, µMock: any) {
  return new Function('µ', 'return (' + src.trim().replace(/;\s*$/, '') + ')')(µMock)
}

function makeµMock() {
  const warns: string[] = []
  const resolved: any[] = []
  const µMock = {
    warn: function (m: any) { warns.push(String(m)) },
    easing: {
      resolve: function (e: any) { resolved.push(e); return typeof e === 'function' ? e : function (t: number) { return t } },
      linear: function (t: number) { return t },
    },
  }
  return { µMock, warns, resolved }
}

describe('animations/iris.ts — rond qui s\'ouvre au centre', function () {
  it('cfg par défaut : duration 380, delay 0, steps 60, easing résolu avec \'ease-out\'', function () {
    const { µMock, resolved } = makeµMock()
    const factory = loadFactory(IRIS_SRC, µMock)
    const { intro } = factory({})
    const cfg = intro({})
    assert.equal(cfg.duration, 380)
    assert.equal(cfg.delay, 0)
    assert.equal(cfg.steps, 60)
    assert.ok(resolved.includes('ease-out'), `resolved doit contenir 'ease-out' (obtenu ${JSON.stringify(resolved)})`)
  })

  it('css(t, u) : cercle 0% à t=0 (caché), 72% à t=1 (visible), 36% à mi-course', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(IRIS_SRC, µMock)
    const { intro } = factory({})
    const cfg = intro({})
    assert.equal(cfg.css(0, 1).clipPath, 'circle(0% at 50% 50%)')
    assert.equal(cfg.css(1, 0).clipPath, 'circle(72% at 50% 50%)')
    assert.equal(cfg.css(0.5, 0.5).clipPath, 'circle(36% at 50% 50%)')
  })

  it('options : duration et easing personnalisés remontent bien dans le cfg', function () {
    const { µMock, resolved } = makeµMock()
    const factory = loadFactory(IRIS_SRC, µMock)
    const { intro } = factory({ duration: 800, easing: 'linear' })
    const cfg = intro({})
    assert.equal(cfg.duration, 800)
    assert.ok(resolved.includes('linear'), `resolved doit contenir 'linear' (obtenu ${JSON.stringify(resolved)})`)
  })

  it('intro === outro : le runtime rejoue la même css(t, u) en sens inverse pour la sortie', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(IRIS_SRC, µMock)
    const { intro, outro } = factory({})
    assert.equal(intro, outro)
  })
})

describe('animations/swipe.ts — front dégradé qui balaie l\'élément', function () {
  it('direction par défaut (right) : duration 320, maskPosition/maskImage/maskSize/maskRepeat corrects', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({})
    const cfg = intro({})
    assert.equal(cfg.duration, 320)
    const atStart = cfg.css(0, 1)
    const atEnd = cfg.css(1, 0)
    const atMid = cfg.css(0.25, 0.75)
    assert.equal(atStart.maskPosition, '100% 0%')
    assert.equal(atEnd.maskPosition, '0% 0%')
    assert.equal(atMid.maskPosition, '75% 0%')
    assert.equal(atStart.maskImage, 'linear-gradient(to right, #000 0%, #000 59.33%, transparent 66.66%, transparent 100%)')
    assert.equal(atEnd.maskImage, atStart.maskImage, 'maskImage identique à t=0 et t=1 — seule la position bouge')
    assert.equal(atStart.maskSize, '300% 100%')
    assert.equal(atStart.maskRepeat, 'no-repeat')
  })

  it('{ dir: \'left\' } : sens et gradient inversés', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({ dir: 'left' })
    const cfg = intro({})
    assert.equal(cfg.css(0, 1).maskPosition, '0% 0%')
    assert.equal(cfg.css(1, 0).maskPosition, '100% 0%')
    assert.ok(cfg.css(0, 1).maskImage.startsWith('linear-gradient(to left,'))
  })

  it('{ direction: \'down\' } (clé longue, pas de dir) : axe vertical', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({ direction: 'down' })
    const cfg = intro({})
    assert.equal(cfg.css(0, 1).maskSize, '100% 300%')
    assert.equal(cfg.css(0, 1).maskPosition, '0% 100%')
    assert.equal(cfg.css(1, 0).maskPosition, '0% 0%')
  })

  it('{ dir: \'up\' } : axe vertical, sens inverse de down', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({ dir: 'up' })
    const cfg = intro({})
    assert.equal(cfg.css(0, 1).maskPosition, '0% 0%')
    assert.equal(cfg.css(1, 0).maskPosition, '0% 100%')
  })

  it('{ dir: \'up\', direction: \'left\' } : les deux clés présentes, dir gagne', function () {
    const { µMock } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({ dir: 'up', direction: 'left' })
    const cfg = intro({})
    assert.ok(cfg.css(0, 1).maskImage.startsWith('linear-gradient(to top,'), 'dir doit gagner sur direction')
  })

  it('{ dir: \'diagonal\' } : direction invalide — 1 warn, repli sur right', function () {
    const { µMock, warns } = makeµMock()
    const factory = loadFactory(SWIPE_SRC, µMock)
    const { intro } = factory({ dir: 'diagonal' })
    const cfg = intro({})
    assert.equal(warns.length, 1)
    assert.match(warns[0], /direction invalide 'diagonal'/)
    assert.equal(cfg.css(0, 1).maskPosition, '100% 0%', 'comportement de right : repli appliqué')
  })
})
