// `_mjs_tryReviveDying` (mjs_element.ts, revival {if}/{key}/{await}) nettoie
// `_mjs_dying`/`_mjs_dead` et appelle `µ._mjs_unfixPosition` sur le noeud ressuscité, mais laissait
// `_mjs_pairedWith` (l'accroche d'appariement posée par `_mjs_updKey`/`_mjs_updIf`, lue par les
// sorties reveal/flip/cube/turn) PÉRIMÉE dessus : le noeud ressuscité restait « apparié » à un
// fragment neuf qui n'existe plus. Fix : `_mjs_tryReviveDying` efface aussi `_mjs_pairedWith`, au
// même endroit que l'appel à `µ._mjs_unfixPosition`.
//
// Appel DIRECT de `µ.Element.prototype._mjs_tryReviveDying` (même stratégie que
// tests/fix-position-revival-cleanup.test.ts pour `_mjs_updList`) : déterministe, sans course avec
// une vraie transition asynchrone.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('_mjs_tryReviveDying efface _mjs_pairedWith sur le noeud ressuscité', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('accroche périmée nettoyée EN MÊME TEMPS que _mjs_dying/_mjs_dead et µ._mjs_unfixPosition', async () => {
    const root = mjsTmp('revive-pairing')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub.mjs'), '<p>stub</p>')

    // `runtime: ['if']` : le stub n'écrit aucun `{if}` lui-même (le scan ne détecterait donc
    // pas mjs_if.ts, où vit `_mjs_tryReviveDying` depuis son détachement de mjs_element.ts).
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['if'] })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile)
    window.eval(stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')))
    window.eval('globalThis.µ = µ;')

    const result = window.eval(`
      (() => {
        const parent = document.createElement('div')
        document.body.appendChild(parent)
        const startNode = document.createComment('s')
        const endNode = document.createComment('e')
        const dyingNode = document.createElement('div')
        dyingNode._mjs_dying = true
        parent.appendChild(startNode)
        parent.appendChild(dyingNode)
        parent.appendChild(endNode)

        // accroche posée par un _mjs_updKey/_mjs_updIf antérieur — pointe vers un fragment
        // neuf déjà disparu, comme si le node avait d'abord été apparié puis PAS détruit
        const stalePartner = document.createElement('span')
        dyingNode._mjs_pairedWith = stalePartner

        const fakeThis = Object.create(µ.Element.prototype)

        const tplFn = () => {
          const frag = document.createDocumentFragment()
          const div = document.createElement('div')
          frag.appendChild(div)
          return { fragment: frag, refs: {}, updateFn: () => {} }
        }

        const revived = µ.Element.prototype._mjs_tryReviveDying.call(fakeThis, startNode, endNode, tplFn)

        return JSON.stringify({
          revived,
          dying: !!dyingNode._mjs_dying,
          dead: !!dyingNode._mjs_dead,
          pairedWithCleared: dyingNode._mjs_pairedWith === undefined,
        })
      })()
    `)
    const parsed = JSON.parse(result)

    assert.equal(parsed.revived, true, 'la structure matche (1 div dying ↔ 1 div neuve dans tplFn) : revival attendu')
    assert.equal(parsed.dying, false, '_mjs_dying nettoyé (comportement déjà correct)')
    assert.equal(parsed.dead, false, '_mjs_dead nettoyé (comportement déjà correct)')
    assert.equal(parsed.pairedWithCleared, true, "AVANT le fix : _mjs_pairedWith restait périmé sur le noeud ressuscité")

    window.close?.()
  })
})
