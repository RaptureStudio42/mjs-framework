// Régression — `disconnectedCallback` pose
// `_mjs_dead = true` inconditionnellement (fiabilise le nettoyage paresseux),
// mais `connectedCallback` ne le remettait JAMAIS à false. Or un simple
// DÉPLACEMENT DOM (réordonnancement de {for}, `appendChild` ailleurs,
// restauration pageCache) déclenche disconnect+connect dans le MÊME tick SANS
// destruction : le composant vivant restait marqué mort → `_mjs_notifyInvalidators`
// (µspring/µinterpolate) purgeait ses liaisons (ressorts figés), un reconcile
// le traitait DEAD (recréation, perte d'état).
//
// Fix : `connectedCallback` remet `_mjs_dead = false` (+ `_mjs_dying = false`)
// en tête de (re)connexion.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('runtime — reconnexion DOM : `_mjs_dead` remis à false (composant pas marqué mort au move)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un simple appendChild ailleurs laisse `_mjs_dead` à false (composant vivant)', async function () {
    const root = mjsTmp('deadflag')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'stub.mjs'), '<p>stub {$n}</p>\n<script lang="coffee">\n$n = 1\n</script>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^stub-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = document.getElementById('a')
    const b = document.getElementById('b')
    const el: any = document.createElement('mjs-stub')
    a.appendChild(el)
    await new Promise(r => setTimeout(r, 60))

    assert.equal(el.isConnected, true, 'monté dans #a')
    assert.equal(!!el._mjs_dead, false, 'vivant au montage')

    // La disconnexion seule pose bien le flag (contrat de nettoyage paresseux).
    a.removeChild(el)
    assert.equal(el.isConnected, false, 'déconnecté')
    assert.equal(!!el._mjs_dead, true, '`_mjs_dead` posé au disconnect (fiabilise le nettoyage paresseux)')

    // Reconnexion (déplacement) → le flag DOIT repasser à false.
    b.appendChild(el)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(el.isConnected, true, 'reconnecté dans #b')
    assert.equal(!!el._mjs_dead, false, 'AVANT fix : restait true → composant vivant marqué mort ; après fix : false')
    assert.equal(!!el._mjs_dying, false, '`_mjs_dying` aussi remis à false par symétrie')
    assert.equal(el._mjs_is_mounted, true, 'toujours monté')

    win.close?.()
  })
})
