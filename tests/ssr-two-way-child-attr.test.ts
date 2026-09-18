// SSR — une liaison two-way `prop=!{$var}` vers un COMPOSANT enfant (pas un input natif)
// passe par `node._set(...)` (bindingComponent, generator/attributes/index.ts) — pose l'état en
// JS pur, jamais reflété comme attribut HTML. Côté serveur, `serializeShadow` ne capture que les
// attributs réels : la valeur two-way disparaissait donc du HTML prérendu, et l'enfant reconstruit
// à froid côté client (hydratation) démarrait avec sa valeur PAR DÉFAUT
// (`<@color value=!{$panel} editable>`, prop toujours vide au prérendu).
// Correctif : `updateLogic` pose AUSSI l'attribut quand `µ._isServer`, sans toucher le chemin client.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — liaison two-way vers un composant enfant', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@child value=!{$x}> avec $x non vide au setup : le HTML prérendu porte value="..." sur le composant enfant', async function () {
    const root = mjsTmp('ssr-two-way-child-attr')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'child.mjs'), `
<script>
  $value = ''
</script>

<span class="v">{$value}</span>
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<script>
  $panel = '#111a2e'
</script>

<div class="outer">
  <@child value=!{$panel}>
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    assert.match(res.html, /<mjs-child[^>]*value="#111a2e"/,
      `l'attribut value doit porter la valeur two-way dans le HTML prérendu — HTML : ${res.html}`)
  })
})
