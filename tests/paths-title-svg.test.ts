// Régression — `<title>` sous un `<svg>` : PIÈGE MUET.
//
// `title` porte deux natures selon son contexte, exactement comme `<tbody>`
// portait sa règle d'insertion implicite :
//   - sous `<head>` : texte BRUT (le titre de l'onglet, jamais analysé) ;
//   - sous `<svg>`/`<math>` : élément ORDINAIRE (le nom accessible d'un dessin,
//     spec HTML « foreign content » — le contenu y est analysé normalement).
//
// Le mini-parser de paths.ts appliquait la première règle partout : un jalon
// d'interpolation posé dans `<svg><title>{µt(…)}</title>` n'était JAMAIS recensé,
// restait tel quel dans le HTML produit, et personne ne venait le remplacer.
// Build vert, aucun avertissement — seul un lecteur d'écran voyait le défaut.
//
// `script`/`style` restent bruts SOUS `<svg>` aussi (CSS et JS y sont du texte) :
// seul `title` change de nature. `<foreignObject>` ramène au contexte HTML.

import assert from 'node:assert/strict'
import { extractPaths, generateCreateFnBody } from '../src/generator/paths.js'

describe('paths.ts — <title> sous <svg> (foreign content)', () => {

  it('jalon dans <svg><title> : RECENSÉ (élément ordinaire)', () => {
    const html = "<svg><title><mjs-t mjs-id='t'></mjs-t></title><rect mjs-id='r'></rect></svg>"
    const r = extractPaths(html)
    assert.deepEqual(r.paths['t'], [0, 0, 0], 'svg(0) > title(0) > jalon(0)')
    assert.deepEqual(r.paths['r'], [0, 1], 'le <rect> reste le 2e enfant du <svg>')
  })

  it('<title> de page (hors svg) : contenu toujours BRUT, aucun jalon recensé', () => {
    const html = "<head><title><mjs-t mjs-id='t'></mjs-t></title></head>"
    const r = extractPaths(html)
    assert.equal(r.paths['t'], undefined, 'sous <head>, le contenu de <title> reste du texte')
    assert.ok(r.cleanHtml.includes("<mjs-t mjs-id='t'>"), 'le jalon est laissé tel quel, non nettoyé')
  })

  it('<title> imbriqué profond sous <svg> : la nature suit l\'ANCÊTRE, pas le parent direct', () => {
    const html = "<svg><g><title><mjs-t mjs-id='t'></mjs-t></title></g></svg>"
    const r = extractPaths(html)
    assert.deepEqual(r.paths['t'], [0, 0, 0, 0], 'svg > g > title > jalon')
  })

  it('<style> sous <svg> : reste BRUT (du CSS, pas du HTML)', () => {
    const html = "<svg><style>.a{fill:red}</style><rect mjs-id='r'></rect></svg>"
    const r = extractPaths(html)
    assert.deepEqual(r.paths['r'], [0, 1])
    assert.ok(r.cleanHtml.includes('.a{fill:red}'), 'le CSS traverse intact')
  })

  it('<foreignObject> ramène au contexte HTML : <title> y redevient brut', () => {
    const html = "<svg><foreignObject><title><mjs-t mjs-id='t'></mjs-t></title></foreignObject></svg>"
    const r = extractPaths(html)
    assert.equal(r.paths['t'], undefined)
  })

  it('mode clone : la ref du jalon est émise et sa navigation descend DANS le <title>', () => {
    const html = "<svg><title><mjs-t mjs-id='t'></mjs-t></title></svg>"
    const info = generateCreateFnBody(html, { forceClone: true, keepRefs: new Set(['t']) })
    assert.ok(info.refIds.includes('t'), 'la ref du jalon est bien émise')
    assert.ok(info.body.includes('firstChild'), 'le corps généré descend dans les enfants')
  })

  it('mode impératif : le jalon devient un ÉLÉMENT enfant du <title>, pas du texte', () => {
    const html = "<svg><title><mjs-t mjs-id='t'></mjs-t></title></svg>"
    const info = generateCreateFnBody(html, { forceImperative: true })
    // <mjs-t> est un DESCENDANT de <svg> : createElementNS (namespace
    // SVG) s'applique aussi à lui, jamais createElement nu (cf. paths.ts,
    // foreignNamespace) — le point testé ici (élément, pas texte) reste vrai, seul
    // l'appel DOM précis change.
    assert.ok(info.body.includes('createElementNS("http://www.w3.org/2000/svg", "mjs-t")'), 'le jalon est créé comme un élément (namespace SVG)')
    assert.deepEqual(info.refIds, ['t'], 'et il est bien recensé dans les refs')
  })

  it('mode impératif, hors svg : le <title> de page garde son contenu BRUT', () => {
    const html = "<head><title><mjs-t mjs-id='t'></mjs-t></title></head>"
    const info = generateCreateFnBody(html, { forceImperative: true })
    assert.ok(!info.body.includes('createElement("mjs-t")'), 'aucun élément créé pour le jalon')
    assert.deepEqual(info.refIds, [], 'aucune ref recensée')
  })

})
