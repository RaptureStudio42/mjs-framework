// Relevé des balises `mjs-*` d'une page prérendue (`PrerenderReport.generated[].tags`, d'où
// `bundler/startup.ts` dérive l'ensemble de démarrage du fragment) : un petit TOKENISEUR sur le HTML
// sérialisé, jamais une recherche de motif. Ce fichier tient ses cas de bord — ce que la page
// AFFICHE compte, ce qui n'est que du texte ou du contenu inerte ne compte pas.

import assert from 'node:assert/strict'
import { collectTags } from '../src/server/prerender.js'

describe('prerender — relevé des balises de la page', () => {
  it('relève les balises du document et celles d\'un `<template shadowrootmode>` (Shadow DOM déclaratif)', () => {
    const html = '<h1>a</h1><mjs-card></mjs-card><template shadowrootmode="open"><mjs-badge></mjs-badge></template>'
    assert.deepEqual(collectTags(html), ['mjs-badge', 'mjs-card'])
  })

  it('saute le contenu d\'un élément à texte brut (`<style>`, `<script>`, `<title>`, `<textarea>`)', () => {
    const html = [
      '<style>.t::after{content:"<mjs-en-style></mjs-en-style>"}</style>',
      '<script>const s = "<mjs-en-script></mjs-en-script>"</script>',
      '<title><mjs-en-titre></mjs-en-titre></title>',
      '<textarea><mjs-en-zone></mjs-en-zone></textarea>',
      '<mjs-card></mjs-card>',
    ].join('')
    assert.deepEqual(collectTags(html), ['mjs-card'])
  })

  it('saute le contenu d\'un `<noscript>` : inerte dès que le script tourne, et le script tourne toujours', () => {
    const html = '<noscript><mjs-sans-script></mjs-sans-script></noscript><mjs-card></mjs-card>'
    assert.deepEqual(collectTags(html), ['mjs-card'])
  })

  it('saute le contenu d\'un `<template>` SANS `shadowrootmode`, imbrications comprises', () => {
    const plat     = '<template><mjs-gabarit></mjs-gabarit></template><mjs-card></mjs-card>'
    const imbrique = '<template><div><template><mjs-dedans></mjs-dedans></template><mjs-gabarit></mjs-gabarit></div></template><mjs-card></mjs-card>'
    assert.deepEqual(collectTags(plat), ['mjs-card'])
    assert.deepEqual(collectTags(imbrique), ['mjs-card'])
  })

  it('un `<template shadowrootmode>` DANS un `<template>` inerte ne compte pas : son hôte n\'affiche rien', () => {
    const html = '<template><template shadowrootmode="open"><mjs-gabarit></mjs-gabarit></template></template><mjs-card></mjs-card>'
    assert.deepEqual(collectTags(html), ['mjs-card'])
  })

  it('un `<template>` non fermé ferme le relevé : tout ce qui suit est son contenu inerte', () => {
    assert.deepEqual(collectTags('<mjs-card></mjs-card><template><mjs-gabarit></mjs-gabarit>'), ['mjs-card'])
  })

  it('ne relève ni une balise citée en valeur d\'attribut, ni une balise commentée', () => {
    const html = '<div data-gabarit="<mjs-attribut></mjs-attribut>"></div><!-- <mjs-commente></mjs-commente> --><mjs-card></mjs-card>'
    assert.deepEqual(collectTags(html), ['mjs-card'])
  })

  it('`plaintext` : son contenu est sauté, et une fermeture écrite à la main rend la suite au relevé', () => {
    assert.deepEqual(collectTags('<mjs-card></mjs-card><plaintext><mjs-dedans></mjs-dedans>'), ['mjs-card'])
    assert.deepEqual(collectTags('<mjs-card></mjs-card><plaintext><mjs-dedans></mjs-dedans></plaintext><mjs-apres></mjs-apres>'), ['mjs-apres', 'mjs-card'])
  })
})
