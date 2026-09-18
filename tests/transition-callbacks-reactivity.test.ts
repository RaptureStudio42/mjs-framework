// Test compile-time + runtime — les callbacks `@introstart` / `@introend` /
// `@outrostart` / `@outroend` doivent déclencher la réactivité.
//
// Bug : le code utilisateur de ces callbacks (`$status = 'X'`) finissait en
// `node._mjs_cb_X = () => { $.status = 'X'; }` dans le bundle. Sans passer
// par `transformReactiveWrites`, le `$.status = 'X'` reste une écriture
// directe sur `_state` (plain object) → aucune invalidation, aucun re-render
// du binding `{$status}` dans le template.
//
// Fix : `bindingTransition` applique `transformReactiveWrites` + `applyPathTracking`
// sur le corps des callbacks → `$.status = 'X'` devient
// `µ._set(_mjsThis, 'status', 'X')` qui appelle `_mjs_invalidate('status')`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
$visible = true
$status = 'waiting...'
</script>

<p class="st">{$status}</p>

{if $visible}
  <p class="anim"
    @transition.noop
    @introstart={$status = 'intro started'}
    @introend={$status = 'intro ended'}
    @outrostart={$status = 'outro started'}
    @outroend={$status = 'outro ended'}
  >x</p>
{end}
`

describe('runtime — callbacks @intro*/@outro* déclenchent la réactivité', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('$status assigné dans les callbacks re-render le binding `{$status}`', async function () {
    const root = mjsTmp('trans-cb')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'trc.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^trc-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

    // ----- Compile-time : aucune écriture brute `$.status = …` ne doit
    // subsister dans les définitions de callbacks. Toutes routées par `µ._set`.
    const cbDefs = compCode.match(/_mjs_cb_(?:intro|outro)(?:start|end)\s*=\s*\(\)\s*=>\s*\{[^}]*\}/g) ?? []
    assert.equal(cbDefs.length, 4, `4 définitions de callbacks attendues, trouvé ${cbDefs.length}`)
    for (const def of cbDefs) {
      assert.ok(
        !/\$\.status\s*=/.test(def),
        `un callback contient un write \`$.status = …\` non transformé :\n${def}`
      )
      assert.match(
        def,
        /µ\._set\s*\(\s*_mjsThis\s*,\s*['"]status['"]/,
        `le callback doit être transformé en µ._set(_mjsThis, 'status', …) :\n${def}`
      )
    }

    // ----- Runtime : on appelle les callbacks et on vérifie que le binding
    // `{$status}` se met à jour. On stub une anim `noop` pour que le pipeline
    // de bindingTransition s'exécute sans dépendre de la lib d'anims (tree-shake).
    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document

    win.eval(`${coreCode}\nglobalThis.µ = µ;\n`)
    // Stub anim avant que le composant s'upgrade. `noop` retourne un config
    // dont `_mjs_playTransition` ne fait rien d'observable, ce qui nous laisse
    // appeler manuellement les callbacks via les props posées sur le node.
    win.eval(`µ.anim = µ.anim || {}; µ.anim.noop = () => ({ intro: () => Promise.resolve(), outro: () => Promise.resolve() });`)
    win.eval(compCode)

    document.body.innerHTML = '<mjs-trc></mjs-trc>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 100))

    assert.ok(el._shadow, "le shadow root doit être attaché")
    const stEl = () => el._shadow.querySelector('.st')
    const animEl = () => el._shadow.querySelector('.anim')
    assert.ok(stEl(), `<.st> doit exister. shadow:\n${el._shadow.innerHTML}`)
    assert.ok(animEl(), `<.anim> doit exister. shadow:\n${el._shadow.innerHTML}`)
    assert.equal(stEl().textContent, 'waiting...', 'valeur initiale')

    // Appel manuel de chaque callback → après microtask, le DOM doit refléter
    // le nouveau $status (preuve que `_mjs_invalidate` a tiré).
    animEl()._mjs_cb_introstart()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(stEl().textContent, 'intro started',
      "introstart : sans transformReactiveWrites, ce textContent resterait 'waiting...'")

    animEl()._mjs_cb_introend()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(stEl().textContent, 'intro ended')

    animEl()._mjs_cb_outrostart()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(stEl().textContent, 'outro started')

    animEl()._mjs_cb_outroend()
    await new Promise(r => setTimeout(r, 0))
    assert.equal(stEl().textContent, 'outro ended')

    win.close?.()
  })
})
