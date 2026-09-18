// quatre animations élément NEUVES appariées (entrée ≠ sortie) — ici cube et
// flip, jumelles élément des préréglages de page homonymes (mjs_vt_presets.ts). Même technique
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

describe('animations/cube.ts + flip.ts', function () {
  beforeEach(function () {
    (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'none' } } }
  })

  afterEach(function () {
    delete (globalThis as any).window
  })

  describe('cube.ts', function () {
    it('cfg par défaut (intro et outro) : duration 600, delay 0, steps 60, css fonction, easing cubic-bezier partagé', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('cube', µMock)({})
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
      assert.equal(resolved.filter(function (r) { return r === 'cubic-bezier(.45,.05,.55,.95)' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('intro et outro sont deux setups DISTINCTS, tous deux marqués _isCfgFactory', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('cube', µMock)({})
      assert.notEqual(factory.intro, factory.outro)
      assert.equal(factory.intro._isCfgFactory, true)
      assert.equal(factory.outro._isCfgFactory, true)
    })

    it("table de direction (clé 'direction' seule) : entrée à t=0 et sortie à u=1, quatre valeurs", function () {
      const table = [
        { dir: 'left', entry: 'perspective(1600px) rotateY(90deg)', exit: 'perspective(1600px) rotateY(-90deg)' },
        { dir: 'right', entry: 'perspective(1600px) rotateY(-90deg)', exit: 'perspective(1600px) rotateY(90deg)' },
        { dir: 'up', entry: 'perspective(1600px) rotateX(-90deg)', exit: 'perspective(1600px) rotateX(90deg)' },
        { dir: 'down', entry: 'perspective(1600px) rotateX(90deg)', exit: 'perspective(1600px) rotateX(-90deg)' },
      ]
      const node = makeNode()
      table.forEach(function (row) {
        const { µMock } = makeµ()
        const factory = loadFactory('cube', µMock)({ direction: row.dir })
        assert.equal(factory.intro(node).css(0, 1).transform, row.entry, `entrée ${row.dir}`)
        assert.equal(factory.outro(node).css(0, 1).transform, row.exit, `sortie ${row.dir}`)
      })
    })

    it("{ dir: 'right', direction: 'up' } : dir gagne (axe Y, pas X)", function () {
      const { µMock } = makeµ()
      const factory = loadFactory('cube', µMock)({ dir: 'right', direction: 'up' })
      const node = makeNode()
      assert.equal(factory.intro(node).css(0, 1).transform, 'perspective(1600px) rotateY(-90deg)', 'right = rotateY (pas rotateX de up)')
    })

    it("direction invalide 'diagonal' : exactement 1 warn, repli 'left'", function () {
      const { µMock, warns } = makeµ()
      const factory = loadFactory('cube', µMock)({ dir: 'diagonal' })
      assert.equal(warns.length, 1)
      assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
      assert.ok(warns[0].indexOf("repli 'left'") !== -1, warns[0])
      const node = makeNode()
      assert.equal(factory.intro(node).css(0, 1).transform, 'perspective(1600px) rotateY(90deg)', 'comportement = celui de left (défaut)')
    })

    it('entrée : transform/filter/backfaceVisibility/transformOrigin exacts à t=0, 0.5, 1 (dir défaut left)', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('cube', µMock)({})
      const node = makeNode()
      const cfg = factory.intro(node)
      let css = cfg.css(0, 1)
      assert.equal(css.transform, 'perspective(1600px) rotateY(90deg)')
      assert.equal(css.filter, 'brightness(0.35)')
      assert.equal(css.backfaceVisibility, 'hidden')
      assert.equal(css.transformOrigin, '50% 50% -100px')
      assert.equal(css.zIndex, undefined)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'perspective(1600px) rotateY(45deg)')
      assert.equal(css.filter, 'brightness(0.675)')
      css = cfg.css(1, 0)
      assert.equal(css.transform, 'perspective(1600px) rotateY(0deg)')
      assert.equal(css.filter, 'brightness(1)')
    })

    it('sortie : transform/filter exacts à u=0, 0.5, 1 (dir défaut left), jamais "-0"', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('cube', µMock)({})
      const node = makeNode()
      const cfg = factory.outro(node)
      let css = cfg.css(1, 0)
      assert.equal(css.transform, 'perspective(1600px) rotateY(0deg)')
      assert.equal(css.transform.indexOf('-0'), -1)
      assert.equal(css.filter, 'brightness(1)')
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'perspective(1600px) rotateY(-45deg)')
      assert.equal(css.filter, 'brightness(0.675)')
      css = cfg.css(0, 1)
      assert.equal(css.transform, 'perspective(1600px) rotateY(-90deg)')
      assert.equal(css.filter, 'brightness(0.35)')
      assert.equal(css.backfaceVisibility, 'hidden')
      assert.equal(css.transformOrigin, '50% 50% -100px')
    })

    it('easing personnalisé résolu pour les deux faces', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('cube', µMock)({ easing: 'ease-in' })
      const node = makeNode()
      factory.intro(node)
      factory.outro(node)
      assert.equal(resolved.filter(function (r) { return r === 'ease-in' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform), entrée et sortie', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'translateX(5px)' } } }
      const { µMock } = makeµ()
      const factory = loadFactory('cube', µMock)({})
      const node = makeNode()
      assert.equal(factory.intro(node).css(1, 0).transform, 'translateX(5px) perspective(1600px) rotateY(0deg)')
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateX(5px) perspective(1600px) rotateY(-90deg)')
    })

    it('épinglage : setupOut relie µ._mjs_fixPosition seulement si _mjs_pairedWith + isConnected, jamais depuis setupIn', async function () {
      const node = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock, fixCalls } = makeµ()
      loadFactory('cube', µMock)({}).outro(node)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls.length, 1)
      assert.equal(fixCalls[0], node)

      const nodeNoPair = makeNode()
      const { µMock: µMock2, fixCalls: fixCalls2 } = makeµ()
      loadFactory('cube', µMock2)({}).outro(nodeNoPair)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls2.length, 0)

      const nodeDetached = { offsetWidth: 200, offsetHeight: 100, isConnected: false, _mjs_pairedWith: {} }
      const { µMock: µMock3, fixCalls: fixCalls3 } = makeµ()
      loadFactory('cube', µMock3)({}).outro(nodeDetached)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls3.length, 0)

      const nodeIn = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock: µMock4, fixCalls: fixCalls4 } = makeµ()
      loadFactory('cube', µMock4)({}).intro(nodeIn)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls4.length, 0)
    })
  })

  describe('flip.ts', function () {
    it('cfg par défaut (intro et outro) : duration 550, delay 0, steps 60, css fonction, easing ease-in-out partagé', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('flip', µMock)({})
      const node = makeNode()
      const cfgIn = factory.intro(node)
      const cfgOut = factory.outro(node)
      assert.equal(cfgIn.duration, 550)
      assert.equal(cfgIn.delay, 0)
      assert.equal(cfgIn.steps, 60)
      assert.equal(typeof cfgIn.css, 'function')
      assert.equal(cfgOut.duration, 550)
      assert.equal(cfgOut.delay, 0)
      assert.equal(cfgOut.steps, 60)
      assert.equal(typeof cfgOut.css, 'function')
      assert.equal(resolved.filter(function (r) { return r === 'ease-in-out' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('intro et outro sont deux setups DISTINCTS, tous deux marqués _isCfgFactory', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('flip', µMock)({})
      assert.notEqual(factory.intro, factory.outro)
      assert.equal(factory.intro._isCfgFactory, true)
      assert.equal(factory.outro._isCfgFactory, true)
    })

    it("table de direction (clé 'direction' seule) : entrée à t=0 et sortie à u=1, quatre valeurs", function () {
      const table = [
        { dir: 'left', entry: 'perspective(1200px) rotateY(90deg)', exit: 'perspective(1200px) rotateY(-90deg)' },
        { dir: 'right', entry: 'perspective(1200px) rotateY(-90deg)', exit: 'perspective(1200px) rotateY(90deg)' },
        { dir: 'up', entry: 'perspective(1200px) rotateX(-90deg)', exit: 'perspective(1200px) rotateX(90deg)' },
        { dir: 'down', entry: 'perspective(1200px) rotateX(90deg)', exit: 'perspective(1200px) rotateX(-90deg)' },
      ]
      const node = makeNode()
      table.forEach(function (row) {
        const { µMock } = makeµ()
        const factory = loadFactory('flip', µMock)({ direction: row.dir })
        assert.equal(factory.intro(node).css(0, 1).transform, row.entry, `entrée ${row.dir}`)
        assert.equal(factory.outro(node).css(0, 1).transform, row.exit, `sortie ${row.dir}`)
      })
    })

    it("{ dir: 'right', direction: 'up' } : dir gagne (axe Y, pas X)", function () {
      const { µMock } = makeµ()
      const factory = loadFactory('flip', µMock)({ dir: 'right', direction: 'up' })
      const node = makeNode()
      assert.equal(factory.intro(node).css(0, 1).transform, 'perspective(1200px) rotateY(-90deg)', 'right = rotateY (pas rotateX de up)')
    })

    it("direction invalide 'diagonal' : exactement 1 warn, repli 'left'", function () {
      const { µMock, warns } = makeµ()
      const factory = loadFactory('flip', µMock)({ dir: 'diagonal' })
      assert.equal(warns.length, 1)
      assert.ok(warns[0].indexOf("direction invalide 'diagonal'") !== -1, warns[0])
      assert.ok(warns[0].indexOf("repli 'left'") !== -1, warns[0])
      const node = makeNode()
      assert.equal(factory.intro(node).css(0, 1).transform, 'perspective(1200px) rotateY(90deg)', 'comportement = celui de left (défaut)')
    })

    it('entrée : transform exact à t=0, 0.5, 1 (dir défaut left), backface et origin constants, sans filter ni zIndex', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('flip', µMock)({})
      const node = makeNode()
      const cfg = factory.intro(node)
      let css = cfg.css(0, 1)
      assert.equal(css.transform, 'perspective(1200px) rotateY(90deg)')
      assert.equal(css.backfaceVisibility, 'hidden')
      assert.equal(css.transformOrigin, '50% 50%')
      assert.equal(css.filter, undefined)
      assert.equal(css.zIndex, undefined)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'perspective(1200px) rotateY(90deg)', 'à t=0.5, encore la face cachée (90deg)')
      css = cfg.css(1, 0)
      assert.equal(css.transform, 'perspective(1200px) rotateY(0deg)')
    })

    it('sortie : transform exact à u=0, 0.5, 1 (dir défaut left), jamais "-0"', function () {
      const { µMock } = makeµ()
      const factory = loadFactory('flip', µMock)({})
      const node = makeNode()
      const cfg = factory.outro(node)
      let css = cfg.css(1, 0)
      assert.equal(css.transform, 'perspective(1200px) rotateY(0deg)')
      assert.equal(css.transform.indexOf('-0'), -1)
      css = cfg.css(0.5, 0.5)
      assert.equal(css.transform, 'perspective(1200px) rotateY(-90deg)')
      css = cfg.css(0, 1)
      assert.equal(css.transform, 'perspective(1200px) rotateY(-90deg)', 'à u=1, la face est déjà retournée (-90deg)')
      assert.equal(css.backfaceVisibility, 'hidden')
      assert.equal(css.transformOrigin, '50% 50%')
    })

    it('easing personnalisé résolu pour les deux faces', function () {
      const { µMock, resolved } = makeµ()
      const factory = loadFactory('flip', µMock)({ easing: 'linear' })
      const node = makeNode()
      factory.intro(node)
      factory.outro(node)
      assert.equal(resolved.filter(function (r) { return r === 'linear' }).length, 2, `resolved = ${JSON.stringify(resolved)}`)
    })

    it('préfixe un transform déjà posé sur le nœud (baseTransform), entrée et sortie', function () {
      (globalThis as any).window = { getComputedStyle: function () { return { opacity: '1', transform: 'translateX(5px)' } } }
      const { µMock } = makeµ()
      const factory = loadFactory('flip', µMock)({})
      const node = makeNode()
      assert.equal(factory.intro(node).css(1, 0).transform, 'translateX(5px) perspective(1200px) rotateY(0deg)')
      assert.equal(factory.outro(node).css(0, 1).transform, 'translateX(5px) perspective(1200px) rotateY(-90deg)')
    })

    it('épinglage : setupOut relie µ._mjs_fixPosition seulement si _mjs_pairedWith + isConnected, jamais depuis setupIn', async function () {
      const node = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock, fixCalls } = makeµ()
      loadFactory('flip', µMock)({}).outro(node)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls.length, 1)
      assert.equal(fixCalls[0], node)

      const nodeNoPair = makeNode()
      const { µMock: µMock2, fixCalls: fixCalls2 } = makeµ()
      loadFactory('flip', µMock2)({}).outro(nodeNoPair)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls2.length, 0)

      const nodeDetached = { offsetWidth: 200, offsetHeight: 100, isConnected: false, _mjs_pairedWith: {} }
      const { µMock: µMock3, fixCalls: fixCalls3 } = makeµ()
      loadFactory('flip', µMock3)({}).outro(nodeDetached)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls3.length, 0)

      const nodeIn = { offsetWidth: 200, offsetHeight: 100, isConnected: true, _mjs_pairedWith: {} }
      const { µMock: µMock4, fixCalls: fixCalls4 } = makeµ()
      loadFactory('flip', µMock4)({}).intro(nodeIn)
      await Promise.resolve(); await Promise.resolve()
      assert.equal(fixCalls4.length, 0)
    })
  })
})
