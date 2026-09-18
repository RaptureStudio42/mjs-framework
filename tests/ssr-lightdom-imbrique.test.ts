// SSR — un sous-composant `mjs-light`
// IMBRIQUÉ (invoqué `<@foo mjs-light>` sous un parent à shadow) recevait quand même un
// `<template shadowrootmode>` — Chromium lui attache alors un VRAI shadow au parsing
// (`midHasRealShadowRoot: true`, light DOM vide), contrairement à la promesse de docs/19-ssr.md
// (« pas de <template shadowrootmode> » pour mjs-light). Cause : `_mjs_isLight` est décidé AU
// CONSTRUCTEUR (mjs_element.ts) — happy-dom ne pose l'attribut `mjs-light` qu'APRÈS pour un
// sous-composant construit PENDANT le rendu de son parent (piège jumeau :
// tests/mjs-layout-runtime.test.ts:225) — jamais pour la RACINE (parsée via `document.body.innerHTML`,
// correctement détectée). Correctif : `serializeShadowHost` (renderToString.ts) relit l'attribut/
// `constructor.mjsLight` AU MOMENT DE SÉRIALISER (déjà posé) et aplatit le contenu réel (piégé dans
// le shadow attaché à tort) directement sous l'hôte, sans `<template>`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — sous-composant mjs-light imbriqué', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("<@child mjs-light> sous un parent à shadow, avec petit-enfant à shadow normal : aucun <template> sur l'hôte enfant, contenu en light DOM, le petit-enfant garde SON <template>", async function () {
    const root = mjsTmp('lightdom-imbrique')
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
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="outer-wrap">
  <p class="outer-marker">OUTER-TEXTE</p>
  <@midlight mjs-light>
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    assert.ok(!/<mjs-midlight[^>]*><template/.test(res.html),
      `<mjs-midlight mjs-light> ne doit porter AUCUN <template shadowrootmode> — HTML : ${res.html}`)
    // la feuille (même par défaut, `:host{display:block}`) précède désormais TOUJOURS
    // le contenu aplati (même contrat que la racine mjs-light, docs/19-ssr.md) : attente élargie.
    assert.match(res.html, /<mjs-midlight[^>]*mjs-light[^>]*>(<style>[^<]*<\/style>)?<div class="mid-wrap">/,
      "le contenu de l'enfant mjs-light doit être aplati directement sous son hôte (light DOM), précédé au plus de SA PROPRE feuille")
    assert.match(res.html, /MID-LIGHTDOM-TEXTE/, "le texte de l'enfant mjs-light doit apparaître")
    assert.match(res.html, /LEAF-SOUS-LIGHTDOM/, 'le petit-enfant (leaf, à shadow normal) doit toujours apparaître')
    assert.match(res.html, /<mjs-leaf[^>]*><template shadowrootmode="open">/,
      'le petit-enfant leaf (shadow normal, PAS mjs-light) doit garder SON PROPRE <template>')
    const nbTemplates = (res.html.match(/<template shadowrootmode=/g) || []).length
    assert.equal(nbTemplates, 2, `2 <template shadowrootmode> attendus (racine outer + leaf, PAS midlight) — HTML : ${res.html}`)
  })

  it('<@child mjs-light> SANS descendant à shadow (cas minimal) : même garde', async function () {
    const root = mjsTmp('lightdom-sans-descendant')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'midlight.mjs'), `
<div class="mid-wrap">
  <p class="mid-marker">MID-LIGHTDOM-SANS-DESCENDANT-SHADOW</p>
</div>
`)
    writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="outer-wrap">
  <p class="outer-marker">OUTER-TEXTE</p>
  <@midlight mjs-light>
</div>
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })

    assert.ok(!/<mjs-midlight[^>]*><template/.test(res.html),
      `<mjs-midlight mjs-light> ne doit porter AUCUN <template shadowrootmode> — HTML : ${res.html}`)
    assert.match(res.html, /MID-LIGHTDOM-SANS-DESCENDANT-SHADOW/)
  })
})
