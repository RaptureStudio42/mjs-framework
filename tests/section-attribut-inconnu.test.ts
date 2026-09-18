// Garde des balises de SECTION (<style>/<script>/<theme>/<routes>) et des directives racine.
// Ces balises n'atteignent jamais le DOM : un attribut qu'elles
// ne reconnaissent pas, ou une directive racine mal écrite (`@improt`, `@persit`), arrête
// désormais la compilation avec une suggestion quand le nom est proche (transpiler/sections.ts,
// transpiler/directives.ts). Sans rapport avec le repli `@xxx` sur un ÉLÉMENT (écouteur
// d'événement, jamais vérifié) : le texte, les méthodes de
// script (`@reload = ->`) et les règles SASS (`@media`, `@use`) restent muets.
//
// Harnais typoCheck (transpile direct, try/catch) — même famille que les autres diagnostics
// compile-time de ce dépôt.

import assert from 'node:assert/strict'
import { transpile } from '../src/transpiler/index.js'

// capture l'erreur de compilation d'un transpile, ou sa sortie si aucune erreur
async function typoCheck(src: string, moduleName: string): Promise<{ err?: any; output?: string }> {
  try {
    const { output } = await transpile(src, { moduleName })
    return { output }
  } catch (err: any) {
    return { err }
  }
}

describe('balise de section : attribut inconnu = erreur de compilation', () => {
  it('<style @dsplay="…"> : erreur, nomme @dsplay et suggère @display', async () => {
    const { err } = await typoCheck('<div>x</div>\n<style @dsplay="inline">\n  :host\n    color: red\n</style>', 'sect-style-dsplay')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@dsplay/)
    assert.match(err.message, /@display/)
  })

  it('<style @csss="…"> : erreur, suggère @css', async () => {
    const { err } = await typoCheck('<div>x</div>\n<style @csss="base">\n  :host\n    color: red\n</style>', 'sect-style-csss')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@css\b/)
  })

  it('<style @viewTransitio.fade> : erreur, suggère @viewTransition', async () => {
    const { err } = await typoCheck('<div>x</div>\n<style @viewTransitio.fade>\n  :host\n    color: red\n</style>', 'sect-style-vt-typo')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@viewTransition/)
  })

  it('<style @foo="…"> : erreur, la liste attendue énumère lang, name, @css, @display, @viewTransition', async () => {
    const { err } = await typoCheck('<div>x</div>\n<style @foo="bar">\n  :host\n    color: red\n</style>', 'sect-style-foo')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /lang, name, @css, @display, @viewTransition/)
  })

  it('<style name="big" @foo="…"> : erreur même sur un style NOMMÉ (variant)', async () => {
    const { err } = await typoCheck('<div>x</div>\n<style name="big" @foo="1">\n  :host\n    color: red\n</style>', 'sect-style-name-foo')
    assert.ok(err, 'une erreur de compilation était attendue')
  })

  it('<script modul> : erreur, suggère module', async () => {
    const { err } = await typoCheck('<script modul>\n$x = 1\n</script>\n<div>{$x}</div>', 'sect-script-modul')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /module/)
  })

  it('<script @foo> : erreur', async () => {
    const { err } = await typoCheck('<script @foo>\n$x = 1\n</script>\n<div>{$x}</div>', 'sect-script-foo')
    assert.ok(err, 'une erreur de compilation était attendue')
  })

  it('<script module lnag="js"> : erreur, suggère lang', async () => {
    const { err } = await typoCheck('<script module lnag="js">\nconst a = 1\n</script>\n<div>x</div>', 'sect-script-lnag')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /lang/)
  })

  it('<theme name="dark" @foo="…"> : erreur', async () => {
    const { err } = await typoCheck('<div>x</div>\n<theme name="dark" @foo="1">\n  $$c: red\n</theme>', 'sect-theme-foo')
    assert.ok(err, 'une erreur de compilation était attendue')
  })

  it('<routes target="main" tagret="x"> : erreur, suggère target', async () => {
    const { err } = await typoCheck('<routes target="main" tagret="x">\n  /   home\n</routes>\n<@view id="main"></@view>', 'sect-routes-tagret')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /target/)
  })
})

describe('directive racine mal écrite = erreur de compilation', () => {
  it('@improt foo \'foo\' : erreur, suggère @import', async () => {
    const { err } = await typoCheck('@improt foo \'foo\'\n<div>x</div>', 'sect-racine-improt')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@import/)
  })

  it('@persit $x : erreur, suggère @persist', async () => {
    const { err } = await typoCheck('@persit $x\n<div>x</div>', 'sect-racine-persit')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@persist/)
  })

  it('@persit session: $x : erreur, suggère @persist', async () => {
    const { err } = await typoCheck('@persit session: $x\n<div>x</div>', 'sect-racine-persit-session')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@persist/)
  })

  it('@improt default Foo "x.js" : erreur, suggère @import', async () => {
    const { err } = await typoCheck('@improt default Foo "x.js"\n<div>x</div>', 'sect-racine-improt-default')
    assert.ok(err, 'une erreur de compilation était attendue')
    assert.match(err.message, /@import/)
  })
})

describe('balise de section : formes légitimes — compilent sans erreur', () => {
  it('@matrix dans du TEXTE : muet', async () => {
    const { err, output } = await typoCheck('<p>\n  @matrix sur le réseau\n</p>', 'sect-ok-texte')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@reload = -> dans un <script> : méthode, pas une directive racine', async () => {
    const { err, output } = await typoCheck('<script>\n@reload = ->\n  1\n</script>\n<div>x</div>', 'sect-ok-methode')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@media dans un <style> : règle SASS, pas un attribut de balise', async () => {
    const { err, output } = await typoCheck('<div>x</div>\n<style>\n  @media (max-width: 600px)\n    :host\n      color: red\n</style>', 'sect-ok-media')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<style lang="css" @display="…" @css="…"> : tous les attributs permis à la fois', async () => {
    const { err, output } = await typoCheck('<div>x</div>\n<style lang="css" @display="inline-block" @css="base typo">\n:host { color: red }\n</style>', 'sect-ok-style-combo')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<style @viewTransition.zoom> : forme à modificateur', async () => {
    const { err, output } = await typoCheck('<div>x</div>\n<style @viewTransition.zoom>\n  :host\n    color: red\n</style>', 'sect-ok-vt-zoom')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<style @viewTransition.turn={ … }> : forme objet', async () => {
    const { err, output } = await typoCheck('<div>x</div>\n<style @viewTransition.turn={ direction: left, priority: 2 }>\n  :host\n    color: red\n</style>', 'sect-ok-vt-objet')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<script module lang="js"> : module avec lang explicite', async () => {
    const { err, output } = await typoCheck('<script module lang="js">\nconst a = 1\n</script>\n<div>x</div>', 'sect-ok-module-lang')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<script lang="coffee"> : script standard avec lang explicite', async () => {
    const { err, output } = await typoCheck('<script lang="coffee">\n$x = 1\n</script>\n<div>{$x}</div>', 'sect-ok-script-coffee')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<theme name="gold"> : attributs permis seuls', async () => {
    const { err, output } = await typoCheck('<div>x</div>\n<theme name="gold">\n  $$c: red\n</theme>', 'sect-ok-theme')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<@head> avec <script src> : le script du head est masqué, pas une section', async () => {
    const { err, output } = await typoCheck('<@head>\n<script src="https://example.invalid/sdk.js"></script>\n</@head>\n<div>x</div>', 'sect-ok-head-script')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@importe peu la couleur (prose, pas de cible entre guillemets) : muet', async () => {
    const { err, output } = await typoCheck('<p>\n  @importe peu la couleur\n</p>', 'sect-ok-importe-peu')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@permis de conduire (prose, pas de variable $) : muet', async () => {
    const { err, output } = await typoCheck('<p>\n  @permis de conduire\n</p>', 'sect-ok-permis')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@persil frais (prose, pas de variable $) : muet', async () => {
    const { err, output } = await typoCheck('<p>\n  @persil frais\n</p>', 'sect-ok-persil')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('@impact seul (aucun argument) : muet', async () => {
    const { err, output } = await typoCheck('<div>\n  @impact\n</div>', 'sect-ok-impact')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })

  it('<p>@importe \'x\'</p> : le @ suit <p>, pas en tête de ligne : muet', async () => {
    const { err, output } = await typoCheck('<p>@importe \'x\'</p>', 'sect-ok-importe-inline')
    assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
    assert.ok(output && output.length > 0)
  })
})
