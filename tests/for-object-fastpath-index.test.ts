// Régression : le fast-path « allStays
// anticipé » (cas dominant d'un {for} après mutation de données à clés/
// ordre identiques) appelait `updateFn`/`_mjs_updFn` avec la POSITION NUMÉRIQUE
// (`__qi`) comme argument d'index, alors que le chemin normal utilise
// `isArray ? __i : keysArr[__i]` — pour une collection OBJET
// (`{for cle, item in $obj}`), l'index attendu est la CLÉ, pas la position.
// Toute interpolation de la variable d'index affichait donc 0,1,2… au lieu
// des clés dès qu'une mutation de données (même clés, même ordre) déclenchait
// ce fast-path.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// `by id` explicite (comme le repro exact) : sans `by`, le
// compilateur ne génère pas de keyFn compatible avec ce fast-path (vérifié
// empiriquement — la vérification `__same` échoue systématiquement avant
// d'atteindre le fast-path, ce qui masquerait le bug). `id` est un champ
// STABLE distinct du champ muté (`label`), pour que la clé ne change PAS
// pendant que la valeur affichée change.
const COMPONENT = `
<script lang="coffee">
$obj = {
  alpha: {id: "a", label: "A"}
  beta: {id: "b", label: "B"}
}
</script>
<ul>
{for cle, item in $obj by id}
  <li class="row">{cle}: {item.label}</li>
{end}
</ul>
`

describe('{for cle, item in $obj} — index correct après mutation (fast-path allStays)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("après mutation d'une valeur (mêmes clés, même ordre), `cle` reste la clé objet — pas un index numérique", async () => {
    const root = mjsTmp('forobjidx')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'forobjidx.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^forobjidx-/.test(f))
    assert.ok(coreFile && compFile)
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-forobjidx></mjs-forobjidx>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    const rowsInit = el._shadow.querySelectorAll('li.row')
    assert.equal(rowsInit.length, 2)
    assert.equal(rowsInit[0].textContent.trim(), 'alpha: A')
    assert.equal(rowsInit[1].textContent.trim(), 'beta: B')

    // Mutation : MÊMES clés, MÊME ordre, seule une valeur change — c'est
    // EXACTEMENT le cas qui déclenche le fast-path allStays (anticipé).
    window.eval(`
      const c = document.querySelector('mjs-forobjidx');
      c._state.obj.alpha.label = 'A-modifié';
      c._mjs_renderStruct();
    `)
    await new Promise((r) => setTimeout(r, 80))

    const rowsAfter = el._shadow.querySelectorAll('li.row')
    assert.equal(
      rowsAfter[0].textContent.trim(),
      'alpha: A-modifié',
      "AVANT le fix : `cle` affichait '0' (position numérique) au lieu de 'alpha' (clé objet) après ce fast-path"
    )
    assert.equal(rowsAfter[1].textContent.trim(), 'beta: B')
  })
})
