// Test runtime — `{for}` imbriqué dans un `{if}` lui-même dans un `{for}`.
//
// Bug : `compileFor` (Optim #5, refs en closure) pré-extrayait `const
// _nref_X = __nodes['X']` en tête du tplFn pour TOUTES les refs. Or les
// marqueurs d'un `{for}` situé dans un corps `{if}` n'existent pas au build
// (le corps est créé à la volée par `_mjs_updItemIf` quand le `{if}` s'ouvre)
// → `_nref_X` capturait `undefined`. Quand le `{if}` s'ouvrait, le `{for}`
// imbriqué n'était jamais rempli. Reproduit un menu de chapitres (chapitre
// ouvert mais sections vides).
//
// Fix : les refs hors template de base restent en lookup live `__nodes['X']`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// `{for row}` → chaque row a un `{if row.open}` contenant `{for k in row.kids}`.
const COMPONENT = `
<script lang="coffee">
$rows = [
  { open: false, kids: ['a', 'b'] }
  { open: false, kids: ['c', 'd', 'e'] }
]
toggle = (row) -> row.open = not row.open
</script>
<div>
  {for row in $rows}
    <section>
      <button @click={toggle(row)}>toggle</button>
      {if row.open}
        <ul>
          {for k in row.kids}<li>{k}</li>{end}
        </ul>
      {end}
    </section>
  {end}
</div>
`

describe('runtime — {for} imbriqué dans {if} dans {for}', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('ouvrir le {if} d\'un item de {for} remplit le {for} imbriqué dedans', async function () {
    const root = mjsTmp('nested')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'nested.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^nested-/.test(f))
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

    document.body.innerHTML = '<mjs-nested></mjs-nested>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    // Au départ : aucun {if} ouvert → aucun <li>.
    assert.equal(el._shadow.querySelectorAll('li').length, 0, 'rien d\'ouvert au départ')

    // Ouvre le 1er item.
    el._shadow.querySelectorAll('section button')[0]
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    const s0 = el._shadow.querySelectorAll('section')[0]
    assert.deepEqual(
      [...s0.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b'],
      'item 0 ouvert → son {for} imbriqué rend 2 <li>',
    )

    // Ouvre le 2e item — son {for} imbriqué a 3 enfants.
    el._shadow.querySelectorAll('section button')[1]
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    const s1 = el._shadow.querySelectorAll('section')[1]
    assert.deepEqual(
      [...s1.querySelectorAll('li')].map((n: any) => n.textContent),
      ['c', 'd', 'e'],
      'item 1 ouvert → son {for} imbriqué rend 3 <li>',
    )

    // Referme le 1er — son {for} imbriqué disparaît, l'autre reste.
    el._shadow.querySelectorAll('section button')[0]
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    assert.equal(el._shadow.querySelectorAll('section')[0].querySelectorAll('li').length, 0, 'item 0 refermé')
    assert.equal(el._shadow.querySelectorAll('section')[1].querySelectorAll('li').length, 3, 'item 1 toujours ouvert')

    win.close?.()
  })

  it('fermer puis rouvrir un {if} re-remplit le {for} interne (re-montage)', async function () {
    const root = mjsTmp('reopen')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    const COMP = `
<script lang="coffee">
$open = true
colors = ['red', 'green', 'blue']
toggle = -> $open = not $open
</script>
<div>
  <button @click={toggle}>toggle</button>
  {if $open}
    <ul>
      {for c in colors}<li>{c}</li>{end}
    </ul>
  {end}
</div>
`
    writeFileSync(join(srcDir, 'reopen.mjs'), COMP)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^reopen-/.test(f))
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

    document.body.innerHTML = '<mjs-reopen></mjs-reopen>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))
    const btn = () => el._shadow.querySelector('button')
    const liTexts = () => [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent)

    assert.deepEqual(liTexts(), ['red', 'green', 'blue'], 'ouvert au départ → 3 <li>')

    // Ferme : le {if} se démonte, le {for} interne disparaît.
    btn().dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    assert.equal(el._shadow.querySelectorAll('li').length, 0, 'fermé → 0 <li>')

    // Rouvre : le {if} se re-monte → le {for} interne DOIT re-rendre ses items
    // (bug : cache de liste périmé sur la nouvelle ancre → 0 <li>).
    btn().dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 50))
    assert.deepEqual(liTexts(), ['red', 'green', 'blue'], 'rouvert → le {for} interne re-rend ses 3 <li>')

    win.close?.()
  })
})
