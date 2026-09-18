// trois animations intégrées NEUVES zoom / zoomOut / volet, jumelles élément
// des préréglages de page homonymes (mjs_vt_presets.ts). Chargement du factory : lecture de la
// source + `new Function('µ', 'return (...)')`, même technique que
// tests/anim-typewriter-text-node-guard.test.ts — le fichier est une expression IIFE, pas un
// module ES exportable tel quel. Pas de happy-dom : `window` est un mock minimal
// (getComputedStyle fixe, l'argument `node` n'est jamais inspecté par l'animation elle-même),
// posé en beforeEach et retiré en afterEach.

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
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
    },
  }
  return { µMock, warns, resolved }
}

describe('animations/zoom.ts + zoomOut.ts + volet.ts', function () {
  beforeEach(function () {
    (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'none' } } }
  })

  afterEach(function () {
    delete (globalThis as any).window
  })

  describe('zoom.ts', function () {
    it('cfg par défaut : duration 450, delay 0, steps 60, css fonction, easing = cubic-bezier du préréglage de page', function () {
      const { µMock, resolved } = makeµ()
      const cfg = loadFactory('zoom', µMock)({}).intro({})
      assert.equal(cfg.duration, 450)
      assert.equal(cfg.delay, 0)
      assert.equal(cfg.steps, 60)
      assert.equal(typeof cfg.css, 'function')
      assert.ok(resolved.indexOf('cubic-bezier(0.2, 0.7, 0.3, 1)') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('css(0, 1) : départ à 55 %, opacité 0 ; css(1, 0) : échelle 1, opacité pleine ; css(0.5, 0.5) : milieu', function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('zoom', µMock)({}).intro({})
      let css = cfg.css(0, 1)
      assert.equal(css.transform, 'scale(0.55)')
      assert.equal(css.opacity, 0)
      css = cfg.css(1, 0)
      assert.equal(css.transform, 'scale(1)')
      assert.equal(css.opacity, 1)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'scale(0.775)')
      assert.equal(css.opacity, 0.5)
    })

    it('options start/duration personnalisées', function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('zoom', µMock)({ start: 0.2, duration: 900 }).intro({})
      assert.equal(cfg.css(0, 1).transform, 'scale(0.2)')
      assert.equal(cfg.duration, 900)
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform)', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'rotate(3deg)' } } }
      const { µMock } = makeµ()
      const cfg = loadFactory('zoom', µMock)({}).intro({})
      assert.equal(cfg.css(1, 0).transform, 'rotate(3deg) scale(1)')
    })

    it('easing personnalisé transmis à µ.easing.resolve', function () {
      const { µMock, resolved } = makeµ()
      loadFactory('zoom', µMock)({ easing: 'ease-in' }).intro({})
      assert.ok(resolved.indexOf('ease-in') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('intro et outro sont le MÊME setup (symétrie de rejeu WAAPI)', function () {
      const { µMock } = makeµ()
      const { intro, outro } = loadFactory('zoom', µMock)({})
      assert.equal(intro, outro)
    })
  })

  describe('zoomOut.ts', function () {
    it('css(0, 1) : départ à 145 % ; css(1, 0) : échelle 1 ; duration 450', function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('zoomOut', µMock)({}).intro({})
      assert.equal(cfg.css(0, 1).transform, 'scale(1.45)')
      assert.equal(cfg.css(1, 0).transform, 'scale(1)')
      assert.equal(cfg.duration, 450)
    })

    it('zoomOut.ts existe : loadFactory rend une fonction', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('zoomOut', µMock)
      assert.equal(typeof factory, 'function')
    })

    it('zoom_out.ts a disparu (renommé zoomOut.ts)', function () {
      assert.equal(existsSync(join(ANIM_DIR, 'zoom_out.ts')), false, 'zoom_out.ts doit disparaître (renommé zoomOut.ts)')
    })
  })

  describe('volet.ts', function () {
    it('cfg par défaut : duration 380, easing ease-out', function () {
      const { µMock, resolved } = makeµ()
      const cfg = loadFactory('volet', µMock)({}).intro({})
      assert.equal(cfg.duration, 380)
      assert.ok(resolved.indexOf('ease-out') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    })

    it("down (défaut) : css(0, 1), css(1, 0) — p=0 ne rend JAMAIS \"-0\" (String(-0) === '0'), css(0.25, 0.75)", function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({}).intro({})
      let css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateY(-100%)')
      assert.equal(css.clipPath, 'inset(100% 0 0 0)')
      css = cfg.css(1, 0)
      assert.equal(css.transform, 'translateY(0%)')
      assert.equal(css.transform.indexOf('-0'), -1, 'aucune trace de "-0" littéral dans le transform')
      assert.equal(css.clipPath, 'inset(0% 0 0 0)')
      css = cfg.css(0.25, 0.75)
      assert.equal(css.transform, 'translateY(-75%)')
      assert.equal(css.clipPath, 'inset(75% 0 0 0)')
    })

    it("{ dir: 'up' } : à t=0, translateY(100%) / inset(0 0 100% 0)", function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({ dir: 'up' }).intro({})
      const css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateY(100%)')
      assert.equal(css.clipPath, 'inset(0 0 100% 0)')
    })

    it("{ dir: 'left' } : à t=0, translateX(100%) / inset(0 100% 0 0)", function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({ dir: 'left' }).intro({})
      const css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateX(100%)')
      assert.equal(css.clipPath, 'inset(0 100% 0 0)')
    })

    it("{ direction: 'right' } (clé longue seule) : à t=0, translateX(-100%) / inset(0 0 0 100%)", function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({ direction: 'right' }).intro({})
      const css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateX(-100%)')
      assert.equal(css.clipPath, 'inset(0 0 0 100%)')
    })

    it("{ dir: 'up', direction: 'left' } : dir gagne — translateY(100%)", function () {
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({ dir: 'up', direction: 'left' }).intro({})
      assert.equal(cfg.css(0, 1).transform, 'translateY(100%)')
    })

    it("{ dir: 'diagonal' } : direction invalide — 1 warn explicite, repli 'down'", function () {
      const { µMock, warns } = makeµ()
      const cfg = loadFactory('volet', µMock)({ dir: 'diagonal' }).intro({})
      assert.equal(warns.length, 1)
      assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
      const css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateY(-100%)', 'comportement = celui de down')
      assert.equal(css.clipPath, 'inset(100% 0 0 0)', 'comportement = celui de down')
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform)', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'rotate(3deg)' } } }
      const { µMock } = makeµ()
      const cfg = loadFactory('volet', µMock)({}).intro({})
      assert.equal(cfg.css(1, 0).transform, 'rotate(3deg) translateY(0%)')
    })
  })
})
