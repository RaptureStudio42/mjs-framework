// quatre animations élément NEUVES appariées (entrée ≠ sortie) — ici turn et
// reveal, jumelles élément des préréglages de page homonymes (mjs_vt_presets.ts). Même technique
// de chargement que bars/blocks (lecture de la source + `new Function('µ', ...)`, le fichier est
// une expression IIFE, pas un module ES). `window` simulé, nœud simulé
// `{ offsetWidth, offsetHeight, isConnected }`. `µMock` étend le patron bars/blocks avec
// `_mjs_fixPosition` (compteur d'appels + dernier nœud) pour prouver l'épinglage posé par setupOut
// en microtâche, jamais par setupIn.

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
  const fixCalls: any[] = []
  const µMock = {
    warn: function (m: any) { warns.push(String(m)) },
    easing: {
      resolve: function (e: any) { resolved.push(e); return typeof e === 'function' ? e : function (t: number) { return t } },
      linear: function (t: number) { return t },
    },
    _mjs_fixPosition: function (node: any) { fixCalls.push(node) },
  }
  return { µMock, warns, resolved, fixCalls }
}

function makeNode() {
  return { offsetWidth: 200, offsetHeight: 100, isConnected: true }
}

describe('animations/turn.ts + reveal.ts', function () {
  beforeEach(function () {
    (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'none' } } }
  })

  afterEach(function () {
    delete (globalThis as any).window
  })

  describe('turn.ts', function () {
    it('cfg par défaut (intro et outro) : duration 600, delay 0, steps 60, css fonction, easing DIFFÉRENT par face (linear / ease-in)', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('turn', µMock)({})
      const node = makeNode()
      const cfgIn = factory.intro(node)
      const cfgOut = factory.outro(node)
      assert.equal(cfgIn.duration, 600)
      assert.equal(cfgIn.delay, 0)
      assert.equal(cfgIn.steps, 60)
      assert.equal(typeof cfgIn.css, 'function')
      assert.equal(cfgOut.duration, 600)
      assert.equal(cfgOut.delay, 0)
      assert.equal(cfgOut.steps, 60)
      assert.equal(typeof cfgOut.css, 'function')
      assert.ok(resolved.indexOf('linear') !== -1, `resolved = ${JSON.stringify(resolved)}`)
      assert.ok(resolved.indexOf('ease-in') !== -1, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('intro et outro sont deux setups DISTINCTS, tous deux marqués _isCfgFactory', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('turn', µMock)({})
      assert.notEqual(factory.intro, factory.outro)
      assert.equal(factory.intro._isCfgFactory, true)
      assert.equal(factory.outro._isCfgFactory, true)
    })

    it("table de direction (clé 'direction' seule) : sortie à u=1 (transform + origin), quatre valeurs ; entrée indépendante de dir", function () {
      const table = [
        { dir: 'left', transform: 'perspective(1300px) rotateY(-160deg)', origin: 'left center' },
        { dir: 'right', transform: 'perspective(1300px) rotateY(160deg)', origin: 'right center' },
        { dir: 'up', transform: 'perspective(1300px) rotateX(160deg)', origin: 'top center' },
        { dir: 'down', transform: 'perspective(1300px) rotateX(-160deg)', origin: 'bottom center' },
      ]
      const node = makeNode()
      const entries: string[] = []
      table.forEach(function (row) {
        const { µMock } = makeµ()
        const factory = loadFactory('turn', µMock)({ direction: row.dir })
        const outCss = factory.outro(node).css(0, 1)
        assert.equal(outCss.transform, row.transform, `sortie ${row.dir}`)
        assert.equal(outCss.transformOrigin, row.origin, `origin ${row.dir}`)
        entries.push(factory.intro(node).css(0, 1).filter)
      })
      assert.equal(entries[0], entries[1], 'entrée identique quelle que soit la direction')
      assert.equal(entries[0], entries[2], 'entrée identique quelle que soit la direction')
    })

    it("{ dir: 'right', direction: 'up' } : dir gagne (axe Y 'right center', pas X 'top center')", function () {
      const { µMock } = makeµ()
      const factory = loadFactory('turn', µMock)({ dir: 'right', direction: 'up' })
      const node = makeNode()
      const css = factory.outro(node).css(0, 1)
      assert.equal(css.transform, 'perspective(1300px) rotateY(160deg)', 'right = rotateY (pas rotateX de up)')
      assert.equal(css.transformOrigin, 'right center')
    })

    it("direction invalide 'diagonal' : exactement 1 warn, repli 'left'", function () {
      const { µMock, warns } = makeµ()
      const factory = loadFactory('turn', µMock)({ dir: 'diagonal' })
      assert.equal(warns.length, 1)
      assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
      assert.ok(warns[0].indexOf("repli 'left'") !== -1, warns[0])
      const node = makeNode()
      const css = factory.outro(node).css(0, 1)
      assert.equal(css.transform, 'perspective(1300px) rotateY(-160deg)', 'comportement = celui de left (défaut)')
      assert.equal(css.transformOrigin, 'left center')
    })

    it('entrée : SEULEMENT filter, exact à t=0, 0.5, 1 ; sans transform ni zIndex ni backface ni origin', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('turn', µMock)({})
      const node = makeNode()
      const cfg = factory.intro(node)
      let css = cfg.css(0, 1)
      assert.equal(css.filter, 'brightness(0.4)')
      assert.equal(css.transform, undefined)
      assert.equal(css.zIndex, undefined)
      assert.equal(css.backfaceVisibility, undefined)
      assert.equal(css.transformOrigin, undefined)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.filter, 'brightness(0.7)')
      css = cfg.css(1, 0)
      assert.equal(css.filter, 'brightness(1)')
    })

    it('sortie : transform/transformOrigin/backfaceVisibility/zIndex exacts à u=0, 0.5, 1 (dir défaut left), jamais "-0"', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('turn', µMock)({})
      const node = makeNode()
      const cfg = factory.outro(node)
      let css = cfg.css(1, 0)
      assert.equal(css.transform, 'perspective(1300px) rotateY(0deg)')
      assert.equal(css.transform.indexOf('-0'), -1)
      assert.equal(css.transformOrigin, 'left center')
      assert.equal(css.backfaceVisibility, 'hidden')
      assert.equal(css.zIndex, 1)
      assert.equal(css.filter, undefined)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'perspective(1300px) rotateY(-80deg)')
      css = cfg.css(0, 1)
      assert.equal(css.transform, 'perspective(1300px) rotateY(-160deg)')
    })

    it('easing personnalisé résolu pour les deux faces (même si défauts différents)', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('turn', µMock)({ easing: 'ease-out' })
      const node = makeNode()
      factory.intro(node)
      factory.outro(node)
      assert.equal(resolved.filter(function (r) { return r === 'ease-out' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform), sortie seulement (entrée sans transform)', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'translateX(5px)' } } }
      const { µMock } = makeµ()
      const factory = loadFactory('turn', µMock)({})
      const node = makeNode()
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateX(5px) perspective(1300px) rotateY(-160deg)')
    })

    it('épinglage : setupOut relie µ._mjs_fixPosition seulement si _mjs_pairedWith + isConnected, jamais depuis setupIn', async function () {
      const node = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock, fixCalls } = makeµ()
      loadFactory('turn', µMock)({}).outro(node)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls.length, 1)
      assert.equal(fixCalls[0], node)

      const nodeNoPair = makeNode()
      const { µMock: µMock2, fixCalls: fixCalls2 } = makeµ()
      loadFactory('turn', µMock2)({}).outro(nodeNoPair)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls2.length, 0)

      const nodeDetached = { offsetWidth: 200, offsetHeight: 100, isConnected: false, _mjs_pairedWith: {} }
      const { µMock: µMock3, fixCalls: fixCalls3 } = makeµ()
      loadFactory('turn', µMock3)({}).outro(nodeDetached)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls3.length, 0)

      const nodeIn = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock: µMock4, fixCalls: fixCalls4 } = makeµ()
      loadFactory('turn', µMock4)({}).intro(nodeIn)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls4.length, 0)
    })
  })

  describe('reveal.ts', function () {
    it('cfg par défaut (intro et outro) : duration 380, delay 0, steps 60, css fonction, easing ease-in partagé', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('reveal', µMock)({})
      const node = makeNode()
      const cfgIn = factory.intro(node)
      const cfgOut = factory.outro(node)
      assert.equal(cfgIn.duration, 380)
      assert.equal(cfgIn.delay, 0)
      assert.equal(cfgIn.steps, 60)
      assert.equal(typeof cfgIn.css, 'function')
      assert.equal(cfgOut.duration, 380)
      assert.equal(cfgOut.delay, 0)
      assert.equal(cfgOut.steps, 60)
      assert.equal(typeof cfgOut.css, 'function')
      assert.equal(resolved.filter(function (r) { return r === 'ease-in' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('intro et outro sont deux setups DISTINCTS, tous deux marqués _isCfgFactory', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('reveal', µMock)({})
      assert.notEqual(factory.intro, factory.outro)
      assert.equal(factory.intro._isCfgFactory, true)
      assert.equal(factory.outro._isCfgFactory, true)
    })

    it("table de direction (clé 'direction' seule) : sortie à u=1, quatre valeurs ; entrée indépendante de dir", function () {
      const table = [
        { dir: 'up', transform: 'translateY(-100%)' },
        { dir: 'down', transform: 'translateY(100%)' },
        { dir: 'left', transform: 'translateX(-100%)' },
        { dir: 'right', transform: 'translateX(100%)' },
      ]
      const node = makeNode()
      const entries: string[] = []
      table.forEach(function (row) {
        const { µMock } = makeµ()
        const factory = loadFactory('reveal', µMock)({ direction: row.dir })
        assert.equal(factory.outro(node).css(0, 1).transform, row.transform, `sortie ${row.dir}`)
        entries.push(factory.intro(node).css(0, 1).transform)
      })
      assert.equal(entries[0], entries[1], 'entrée identique quelle que soit la direction')
      assert.equal(entries[0], entries[2], 'entrée identique quelle que soit la direction')
    })

    it("{ dir: 'left', direction: 'down' } : dir gagne (axe X, pas Y)", function () {
      const { µMock } = makeµ()
      const factory = loadFactory('reveal', µMock)({ dir: 'left', direction: 'down' })
      const node = makeNode()
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateX(-100%)', 'left = translateX (pas translateY de down)')
    })

    it("direction invalide 'diagonal' : exactement 1 warn, repli 'up'", function () {
      const { µMock, warns } = makeµ()
      const factory = loadFactory('reveal', µMock)({ dir: 'diagonal' })
      assert.equal(warns.length, 1)
      assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
      assert.ok(warns[0].indexOf("repli 'up'") !== -1, warns[0])
      const node = makeNode()
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateY(-100%)', 'comportement = celui de up (défaut)')
    })

    it('entrée : transform (scale) et filter (brightness) exacts à t=0, 0.5, 1 ; sans zIndex', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('reveal', µMock)({})
      const node = makeNode()
      const cfg = factory.intro(node)
      let css = cfg.css(0, 1)
      assert.equal(css.transform, 'scale(0.92)')
      assert.equal(css.filter, 'brightness(0.5)')
      assert.equal(css.zIndex, undefined)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'scale(0.96)')
      assert.equal(css.filter, 'brightness(0.75)')
      css = cfg.css(1, 0)
      assert.equal(css.transform, 'scale(1)')
      assert.equal(css.filter, 'brightness(1)')
    })

    it('sortie : transform exact à u=0, 0.5, 1 (dir défaut up), zIndex=1, jamais "-0"', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('reveal', µMock)({})
      const node = makeNode()
      const cfg = factory.outro(node)
      let css = cfg.css(1, 0)
      assert.equal(css.transform, 'translateY(0%)')
      assert.equal(css.transform.indexOf('-0'), -1)
      assert.equal(css.zIndex, 1)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'translateY(-50%)')
      css = cfg.css(0, 1)
      assert.equal(css.transform, 'translateY(-100%)')
    })

    it('easing personnalisé résolu pour les deux faces', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('reveal', µMock)({ easing: 'linear' })
      const node = makeNode()
      factory.intro(node)
      factory.outro(node)
      assert.equal(resolved.filter(function (r) { return r === 'linear' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform), entrée et sortie', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'translateX(5px)' } } }
      const { µMock } = makeµ()
      const factory = loadFactory('reveal', µMock)({})
      const node = makeNode()
      assert.equal(factory.intro(node).css(1, 0).transform, 'translateX(5px) scale(1)')
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateX(5px) translateY(-100%)')
    })

    it('épinglage : setupOut relie µ._mjs_fixPosition seulement si _mjs_pairedWith + isConnected, jamais depuis setupIn', async function () {
      const node = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock, fixCalls } = makeµ()
      loadFactory('reveal', µMock)({}).outro(node)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls.length, 1)
      assert.equal(fixCalls[0], node)

      const nodeNoPair = makeNode()
      const { µMock: µMock2, fixCalls: fixCalls2 } = makeµ()
      loadFactory('reveal', µMock2)({}).outro(nodeNoPair)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls2.length, 0)

      const nodeDetached = { offsetWidth: 200, offsetHeight: 100, isConnected: false, _mjs_pairedWith: {} }
      const { µMock: µMock3, fixCalls: fixCalls3 } = makeµ()
      loadFactory('reveal', µMock3)({}).outro(nodeDetached)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls3.length, 0)

      const nodeIn = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock: µMock4, fixCalls: fixCalls4 } = makeµ()
      loadFactory('reveal', µMock4)({}).intro(nodeIn)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls4.length, 0)
    })
  })
})
