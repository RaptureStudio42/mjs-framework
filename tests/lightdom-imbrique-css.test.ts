// SSR — le <style> PROPRE d'un sous-composant
// `mjs-light` IMBRIQUÉ disparaît entièrement de la sérialisation. `serializeShadowHost`
// (renderToString.ts) a DEUX branches sœurs pour un hôte à shadow propre : `hasOwnShadow &&
// !isLight` réinjecte `node._mjs_baseCss` dans un <style> AVANT le contenu (l.758-759) ;
// `hasOwnShadow && isLight` (aplatissement) ne le fait JAMAIS (l.763-764 avant correctif) — le
// sous-composant perd sa feuille, ni dans le HTML ni dans `res.css` (racine). Correctif : la
// branche `isLight` inline elle aussi `_mjs_baseCss`, dédoublonnée PAR TAG dans le même shadow
// hôte (3 instances du même composant dans un `{for}` → une seule règle).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — <style> du sous-composant mjs-light imbriqué', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('<@midlight mjs-light> a son PROPRE <style> (fond gold) : la règle apparaît dans le HTML sérialisé', async function () {
    const root = mjsTmp('lightdom-imbrique-css-simple')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'leaf.mjs'), `
<p class="leaf">LEAF-SOUS-LIGHTDOM</p>
<style>
  .leaf
    color: seagreen
</style>
`)
    writeFileSync(join(srcDir, 'midlight.mjs'), `
<div class="mid-wrap">
  <p class="mid-marker">MID-LIGHTDOM-TEXTE</p>
  <@leaf>
</div>
<style>
  .mid-wrap
    background: gold
</style>
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="outer-wrap">
  <p class="outer-marker">OUTER-TEXTE</p>
  <@midlight mjs-light>
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    assert.match(res.html, /background:gold/, `la règle du sous-composant light imbriqué doit voyager avec son contenu aplati — HTML : ${res.html}`)
    assert.match(res.html, /LEAF-SOUS-LIGHTDOM/, 'le petit-enfant (leaf, shadow normal) doit toujours apparaître')
    assert.match(res.html, /color:#2e8b57/, 'le style du petit-enfant leaf doit toujours apparaître (non-régression)')
  })

  it("3 instances du MÊME sous-composant mjs-light dans un {for} : la règle n'apparaît qu'UNE FOIS", async function () {
    const root = mjsTmp('lightdom-imbrique-css-for')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'leaf.mjs'), `
<p class="leaf">{$label}</p>
<style>
  .leaf
    color: seagreen
</style>
`)
    writeFileSync(join(srcDir, 'midlight.mjs'), `
<div class="mid-wrap">
  <@leaf label={$label}>
</div>
<style>
  .mid-wrap
    background: gold
</style>
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<script lang="coffee">
$items = ['un', 'deux', 'trois']
</script>
<div class="outer-wrap">
{for item in $items}
  <@midlight mjs-light label={item}>
{end}
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    const nbHosts = (res.html.match(/<mjs-midlight/g) || []).length
    assert.equal(nbHosts, 3, `3 hôtes <mjs-midlight> attendus — HTML : ${res.html}`)
    const nbRules = (res.html.match(/background:gold/g) || []).length
    assert.equal(nbRules, 1, `la règle du sous-composant light doit être DÉDOUBLONNÉE (1 seule pour 3 instances) — HTML : ${res.html}`)
    for (const label of ['un', 'deux', 'trois']) assert.match(res.html, new RegExp(`>${label}<`), `label « ${label} » attendu`)
  })
})
