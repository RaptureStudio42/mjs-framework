// Régression — leçon `passing-snippets` du tuto, page MORTE au
// montage : « Cannot read properties of null (reading 'nextSibling') ».
//
// Cause : le parseur HTML des navigateurs enveloppe tout `<tr>` enfant direct
// d'un `<table>` dans un `<tbody>` qu'il fabrique lui-même (mode d'insertion
// « in table »). Le mini-parser compile-time de paths.ts, lui, ne le faisait
// pas : ses chemins de nœuds sautaient donc un niveau, et la factory générée
// déréférençait un null au premier montage.
//
// La suite de tests était AVEUGLE à ce cas : happy-dom n'insère PAS le tbody
// implicite (`template.innerHTML = '<table><tr>…'` → firstChild = TR), un test
// de montage passe donc avec ou sans le correctif. La preuve tient ici, sur les
// chemins eux-mêmes.

import assert from 'node:assert/strict'
import { extractPaths, generateCreateFnBody } from '../src/generator/paths.js'

describe('paths.ts — <tbody> implicite (parité avec le parseur du navigateur)', () => {

  it('<tr> enfant direct de <table> : tbody émis ET compté dans le chemin', () => {
    const html = "<table><tr><td><span mjs-id='a'></span></td></tr><tr><td><span mjs-id='b'></span></td></tr></table>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<table><tbody><tr><td><span></span></td></tr><tr><td><span></span></td></tr></tbody></table>')
    assert.deepEqual(r.paths['a'], [0, 0, 0, 0, 0], 'table(0) > tbody(0) > tr(0) > td(0) > span(0)')
    assert.deepEqual(r.paths['b'], [0, 0, 1, 0, 0], 'la 2e ligne est le 2e enfant du MÊME tbody')
  })

  it('<tbody> explicite : aucune insertion en double', () => {
    const html = "<table><tbody><tr><td><span mjs-id='a'></span></td></tr></tbody></table>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<table><tbody><tr><td><span></span></td></tr></tbody></table>')
    assert.deepEqual(r.paths['a'], [0, 0, 0, 0, 0])
  })

  it('<thead> explicite puis <tr> nu : le tr nu prend son propre tbody', () => {
    const html = "<table><thead><tr><th><span mjs-id='h'></span></th></tr></thead><tr><td><span mjs-id='a'></span></td></tr></table>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<table><thead><tr><th><span></span></th></tr></thead><tbody><tr><td><span></span></td></tr></tbody></table>')
    assert.deepEqual(r.paths['h'], [0, 0, 0, 0, 0], 'thead = 1er enfant de table')
    assert.deepEqual(r.paths['a'], [0, 1, 0, 0, 0], 'le tbody implicite est le 2e enfant de table')
  })

  it('<td> sans <tr> : tbody ET tr implicites, comme le navigateur', () => {
    const html = "<table><td><span mjs-id='a'></span></td></table>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<table><tbody><tr><td><span></span></td></tr></tbody></table>')
    assert.deepEqual(r.paths['a'], [0, 0, 0, 0, 0])
  })

  it('un <tbody> explicite APRÈS des <tr> nus referme le tbody implicite', () => {
    const html = "<table><tr><td><span mjs-id='a'></span></td></tr><tbody><tr><td><span mjs-id='b'></span></td></tr></tbody></table>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<table><tbody><tr><td><span></span></td></tr></tbody><tbody><tr><td><span></span></td></tr></tbody></table>')
    assert.deepEqual(r.paths['a'], [0, 0, 0, 0, 0])
    assert.deepEqual(r.paths['b'], [0, 1, 0, 0, 0])
  })

  it('mode clone : la navigation générée traverse bien le tbody', () => {
    const html = "<table><tr><td><span mjs-id='a'></span></td></tr><tr><td><span mjs-id='b'></span></td></tr></table>"
    const info = generateCreateFnBody(html, { forceClone: true, keepRefs: new Set(['a', 'b']) })
    assert.match(info.tplHtml ?? '', /<table><tbody>/, 'le template cloné porte le tbody')
    // 5 niveaux de descente pour chaque ref : table > tbody > tr > td > span
    const nav = info.body.split('\n').filter(l => l.includes('firstChild') || l.includes('childNodes'))
    assert.ok(nav.length > 0, 'aucune navigation émise')
  })

  it('mode impératif : le tbody est créé aussi (même DOM que le navigateur)', () => {
    const html = "<table><tr><td>${x}</td></tr></table>"
    const info = generateCreateFnBody(html)
    assert.match(info.body, /createElement\("tbody"\)|createElement\('tbody'\)/, 'tbody absent du DOM impératif')
  })

  it('hors table : rien ne change', () => {
    const html = "<div><span mjs-id='a'></span></div>"
    const r = extractPaths(html)
    assert.equal(r.cleanHtml, '<div><span></span></div>')
    assert.deepEqual(r.paths['a'], [0, 0])
  })
})
