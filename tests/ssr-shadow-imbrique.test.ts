// SSR — sérialisation RÉCURSIVE du shadow DOM. `el._shadow.innerHTML` (natif) est le
// getter DOM STANDARD, qui par définition (encapsulation Shadow DOM) ne traverse JAMAIS le shadow
// d'un DESCENDANT — un `<@sous-composant>`, même immédiat (1er niveau de composition), sortait
// comme une balise strictement VIDE dans le HTML servi (perte totale de SEO/1er-paint pour tout ce
// qui est composé). `serializeShadow` (renderToString.ts) walk récursivement : chaque descendant
// qui porte SON PROPRE `_shadow` réinjecte son `<template shadowrootmode>` + son `<style>` + son
// contenu, récursivement.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — sérialisation récursive du shadow imbriqué', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('parent → enfant → petit-enfant, chacun avec un <style> et du texte : les 3 templates imbriqués sont dans le HTML', async function () {
    const root = mjsTmp('shadow-3niveaux')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'leaf.mjs'), `
<p class="leaf">LEAF-TEXTE</p>
<style>
  .leaf
    color: seagreen
</style>
`)
    writeFileSync(join(srcDir, 'inner.mjs'), `
<div class="inner-wrap">
  <p class="inner-marker">INNER-TEXTE</p>
  <@leaf>
</div>
<style>
  .inner-marker
    color: royalblue
</style>
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="outer-wrap">
  <p class="outer-marker">OUTER-TEXTE</p>
  <@inner>
</div>
<style>
  .outer-marker
    color: tomato
</style>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    assert.match(res.html, /OUTER-TEXTE/, 'niveau 1 (racine) : toujours présent')
    assert.match(res.html, /INNER-TEXTE/, 'niveau 2 (enfant) : doit maintenant apparaître')
    assert.match(res.html, /LEAF-TEXTE/, 'niveau 3 (petit-enfant) : doit maintenant apparaître')

    const nbTemplates = (res.html.match(/<template shadowrootmode=/g) || []).length
    assert.equal(nbTemplates, 3, `3 <template shadowrootmode> imbriqués attendus (racine + 2 sous-composants) — HTML : ${res.html}`)

    // couleur en substring littérale OU en hex minifié (le compilateur SASS garde la forme la
    // plus COURTE des deux — « seagreen »/« royalblue » ressortent en hex, « tomato » reste mot).
    assert.match(res.html, /\.leaf\{color:(seagreen|#2e8b57)\}/, 'le <style> du petit-enfant (leaf) doit être ré-injecté')
    assert.match(res.html, /\.inner-marker\{color:(royalblue|#4169e1)\}/, "le <style> de l'enfant (inner) doit être ré-injecté")
    assert.match(res.html, /\.outer-marker\{color:(tomato|#ff6347)\}/, 'le <style> de la racine (outer) reste inline comme avant')

    // Chaque sous-composant porte bien SON PROPRE <template>, imbriqué DANS sa propre balise —
    // pas 3 templates à plat au même niveau.
    assert.match(res.html, /<mjs-inner[^>]*><template shadowrootmode="open">/, "<mjs-inner> doit porter SON PROPRE <template> directement à l'intérieur")
    assert.match(res.html, /<mjs-leaf[^>]*><template shadowrootmode="open">/, "<mjs-leaf> doit porter SON PROPRE <template> directement à l'intérieur")
  })

  it('un <@sous-composant> dans un {for} : chaque instance sérialise SON PROPRE contenu (pas de confusion entre instances)', async function () {
    const root = mjsTmp('shadow-for')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'item.mjs'), `
<li class="item">Item-{$label}</li>
<style>
  .item
    color: darkorange
</style>
`)
    writeFileSync(join(srcDir, 'list.mjs'), `
<script lang="coffee">
$items = ['a', 'b', 'c']
</script>
<ul class="list">
{for x in $items}
  <@item label={x}>
{end}
</ul>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-list' })

    assert.match(res.html, /Item-a/, "1ère instance du {for} doit être sérialisée")
    assert.match(res.html, /Item-b/, "2ème instance du {for} doit être sérialisée")
    assert.match(res.html, /Item-c/, "3ème instance du {for} doit être sérialisée")

    const nbItemTags = (res.html.match(/<mjs-item\b/g) || []).length
    assert.equal(nbItemTags, 3, `3 <mjs-item> attendus (un par entrée de $items) — HTML : ${res.html}`)
    const nbNestedTemplates = (res.html.match(/<template shadowrootmode=/g) || []).length
    assert.equal(nbNestedTemplates, 4, `4 templates attendus (racine <mjs-list> + 3 <mjs-item>) — HTML : ${res.html}`)
  })
})
