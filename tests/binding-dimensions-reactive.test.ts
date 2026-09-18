// Régression — binding dimensions (`clientWidth=!{$w}`) réactif.
//
// Bug : désormais (« plus de Proxy » : `_state` est un objet ordinaire),
// les écritures state→ doivent passer par `µ._set(this, 'x', v)` qui appelle
// `_mjs_invalidate('x')`. Le générateur `bindingDimensions` émettait encore une
// assignation brute `$.w = t.clientWidth` dans l'effet ResizeObserver → le
// `_state` était bien muté mais le nœud texte `{$w}` n'était JAMAIS réinvalidé.
// Résultat visible : le tuto /dimensions affichait « x px » (valeurs vides)
// alors que le binding tournait sans erreur.
//
// Fix : `bindingDimensions` écrit désormais via `µ._set(this, 'w', …)`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// Pas de `<script>` : `$w` / `$h` sont auto-déclarés par le binding + l'interpolation
// (idiome MJS — pas de déclaration par défaut). C'est exactement le cas du tuto.
const COMPONENT = `
<div clientWidth=!{$w} clientHeight=!{$h}>
  <span class="size">{$w} x {$h}px</span>
</div>
`

async function bundleComponent(name: string): Promise<{ outDir: string; compCode: string }> {
  const root = mjsTmp('dim')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), COMPONENT)

  const bundler = new Bundler({
    sourceDir: srcDir,
    outputDir: outDir,
    manifestPath: join(root, 'bundle.js'),
  })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const compFile = readdirSync(outDir).find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(compFile, 'composant compilé présent')
  return { outDir, compCode: readFileSync(join(outDir, compFile!), 'utf-8') }
}

describe('binding dimensions — réactivité (µ._set)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('écrit via µ._set(this, …) et non une assignation brute non réactive', async () => {
    const { compCode } = await bundleComponent('dimgen')

    assert.match(
      compCode,
      /µ\._set\(this, 'w', t\.clientWidth\)/,
      'clientWidth doit écrire via µ._set(this, \'w\', …)',
    )
    assert.match(
      compCode,
      /µ\._set\(this, 'h', t\.clientHeight\)/,
      'clientHeight doit écrire via µ._set(this, \'h\', …)',
    )
    // L'ancienne assignation brute (non réactive) ne doit plus apparaître.
    assert.doesNotMatch(
      compCode,
      /\$\.w = t\.clientWidth/,
      'plus d\'assignation brute $.w = t.clientWidth',
    )
    assert.doesNotMatch(
      compCode,
      /\$\.h = t\.clientHeight/,
      'plus d\'assignation brute $.h = t.clientHeight',
    )
  })

  it('met à jour le nœud texte {$w} quand ResizeObserver rapporte une taille', async () => {
    const { outDir, compCode } = await bundleComponent('dimrun')
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    assert.ok(coreFile, 'mjs_core compilé')

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document

    // ResizeObserver mocké : on capture le callback pour le piloter à la main.
    const captured: Array<(entries: any[]) => void> = []
    win.ResizeObserver = class {
      cb: (entries: any[]) => void
      constructor(cb: (entries: any[]) => void) { this.cb = cb; captured.push(cb) }
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${stripEsm(compCode)}`)

    document.body.innerHTML = '<mjs-dimrun></mjs-dimrun>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))

    const div: any = el._shadow.querySelector('div')
    assert.ok(div, 'div présent dans le shadow')

    // Simule une taille mesurée puis déclenche le callback ResizeObserver.
    Object.defineProperty(div, 'clientWidth', { value: 250, configurable: true })
    Object.defineProperty(div, 'clientHeight', { value: 120, configurable: true })
    for (const cb of captured) cb([{ target: div }])
    await new Promise(r => setTimeout(r, 60))

    const size = el._shadow.querySelector('.size')
    assert.equal(
      size.textContent.trim(),
      '250 x 120px',
      `le nœud texte doit refléter les dimensions invalidées (reçu : "${size.textContent.trim()}")`,
    )

    win.close?.()
  })
})
