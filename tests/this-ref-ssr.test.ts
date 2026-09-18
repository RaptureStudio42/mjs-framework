// SSR : un composant avec une ref `@this` (sans `$`) et des écritures de ref se
// rend côté serveur sans crash. Les écritures de ref vivent dans `µmount`
// (client-only) ; le rendu serveur ne les exécute pas, et le markup réactif
// (les vraies variables `$`) est bien pré-rendu.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR : ref @this (sans $) + écriture de ref se rend sans crash', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('renderToString ne plante pas et pré-rend le markup réactif', async () => {
    const root = mjsTmp('ssr-ref')
    const srcDir = join(root, 'src'), outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hudssr.mjs'), `
<script lang="coffee">
bar = null
$label = 'PV'
µmount ->
  bar.style.width = '50%'
  bar.className = 'on'
</script>
<span class="l">{$label}</span>
<div class="bar" @this=!{bar}></div>
`)
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html } = await renderer.renderToString('mjs-hudssr')
    await renderer.close()
    assert.match(html, /shadowrootmode="open"/, 'le HTML serveur contient un DSD')
    assert.match(html, /PV/, 'le label réactif est pré-rendu côté serveur')
  })
})
