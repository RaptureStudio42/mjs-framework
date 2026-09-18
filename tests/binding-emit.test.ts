// Binding @emit.EVENT_NAME={expr} (réactif) / @emit.once.EVENT_NAME={expr} (mount only).
//
// `this._mjs_emit(eventName, data)` existe déjà côté runtime (mjs_element.ts,
// INCHANGÉ) — le générateur évalue `expr` et le rappelle à
// chaque changement de dépendance réactive (forme standard, comme n'importe
// quel `={expr}` du framework : tire une fois au montage ET se re-déclenche
// ensuite), ou UNE seule fois au montage pour `.once` (jamais ensuite).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function bundleComponent(name: string, src: string): Promise<{ outDir: string; coreCode: string; compCode: string }> {
  const root = mjsTmp('emit')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))!
  return {
    outDir,
    coreCode: stripEsm(readFileSync(join(outDir, coreFile), 'utf-8')),
    compCode: stripEsm(readFileSync(join(outDir, compFile), 'utf-8')),
  }
}

describe('binding @emit — réactif / .once', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('forme réactive : émis au montage PUIS ré-émis à chaque mutation de la dépendance', async () => {
    const src = `
<script lang="coffee">
$count = 0
</script>
<div @emit.changed={$count}>{$count}</div>
`
    const { coreCode, compCode } = await bundleComponent('efx', src)
    assert.match(compCode, /_mjs_emit\('changed', \$\.count\)/, 'code généré : appel _mjs_emit avec la bonne expr')

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-efx></mjs-efx>'
    const el: any = document.body.firstElementChild
    const received: any[] = []
    el.addEventListener('changed', (e: any) => received.push(e.data))
    await new Promise(r => setTimeout(r, 80))
    assert.deepEqual(received, [0], 'émis 1x au montage, avec la valeur initiale')

    el._set('count', 5)
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(received, [0, 5], 'ré-émis à la mutation de $count (dépendance réactive de expr)')

    win.close?.()
  })

  it('.once : émis UNE SEULE fois au montage — une mutation de la dépendance ne redéclenche PAS', async () => {
    const src = `
<script lang="coffee">
$count = 0
</script>
<div @emit.once.mounted={$count}>{$count}</div>
`
    const { coreCode, compCode } = await bundleComponent('eonce', src)
    assert.match(compCode, /_mjs_emit\('mounted', \$\.count\)/)

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-eonce></mjs-eonce>'
    const el: any = document.body.firstElementChild
    const received: any[] = []
    el.addEventListener('mounted', (e: any) => received.push(e.data))
    await new Promise(r => setTimeout(r, 80))
    assert.deepEqual(received, [0], 'émis 1x au montage')

    el._set('count', 5)
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(received, [0], '.once : la mutation de $count (dep de expr) ne redéclenche PAS un 2e appel')

    win.close?.()
  })

  it('forme dans un {for} : un émit par row, avec la valeur DE LA ROW', async () => {
    const src = `
<script lang="coffee">
items = [{ id: 1, label: 'A' }, { id: 2, label: 'B' }]
</script>
<ul>
  {for item in items}
    <li @emit.rowReady={item.label}>{item.label}</li>
  {end}
</ul>
`
    const { coreCode, compCode } = await bundleComponent('efor', src)

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-efor></mjs-efor>'
    const el: any = document.body.firstElementChild
    const received: any[] = []
    el.addEventListener('rowReady', (e: any) => received.push(e.data))
    await new Promise(r => setTimeout(r, 80))

    assert.deepEqual(received.sort(), ['A', 'B'], 'un émit par row du {for}, avec le label de CHAQUE row')

    win.close?.()
  })

  it('forme malformée (@emit.a.b.c=) : erreur de compilation explicite', async () => {
    const src = `<div @emit.a.b.c={1}></div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'emitbad' }),
      /forme d'émission non reconnue/,
    )
  })

  it('2 segments dont le 1er n\'est pas "once" (@emit.foo.bar=) : erreur de compilation explicite', async () => {
    const src = `<div @emit.foo.bar={1}></div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'emitbad2' }),
      /forme d'émission non reconnue/,
    )
  })

  it('nom d\'événement vide (@emit.=) : erreur de compilation explicite', async () => {
    const src = `<div @emit.={1}></div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'emitbad3' }),
      /forme d'émission non reconnue/,
    )
  })

  it('nom d\'événement vide + once (@emit.once.=) : erreur de compilation explicite', async () => {
    const src = `<div @emit.once.={1}></div>`
    await assert.rejects(
      () => transpile(src, { moduleName: 'emitbad4' }),
      /forme d'émission non reconnue/,
    )
  })
})
