// Lint « <form> sans action ni méthode » (lint.ujsForm) — le pont UJS intercepte TOUT
// <form> (contrat conservé), même avec un
// @submit.prevent (le pont shadow capture AVANT le _mjs_bindEvents du composant, cf.
// src/runtime/mjs_ujs.ts ~2634 µ._mjs_ujsShadowAttach) : simple AVERTISSEMENT console
// (jamais bloquant), ACTIVÉ PAR DÉFAUT. Configurable par le bloc
// "lint": { "ujsForm": false } de mjs.config.json (validation stricte, même patron
// que lint.a11y).
//
// RÈGLE ZÉRO : les zones <pre>/<code> (exemples de code d'une doc) sont
// neutralisées avant analyse — sinon un site qui MONTRE du HTML dans ses exemples
// reçoit des dizaines de fausses alertes.
//
// checkUjsForm() est testée directement (fonction pure) pour les 7 cas couverts ; le
// câblage lint.ujsForm (défaut ON, false = coupe tout) est testé au niveau du
// transpiler (transpile() direct, harnais copié de tests/a11y-lint.test.ts).

import assert from 'node:assert/strict'
import { writeFileSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { checkUjsForm } from '../src/transpiler/ujs-form.js'
import { transpile } from '../src/transpiler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'

describe('checkUjsForm — contrôles unitaires (fonction pure)', () => {
  it('(a) <form> nu : avertit, cite le fichier et la bonne ligne', () => {
    const msgs = checkUjsForm('<div>\n  <form>\n    <input name="q">\n  </form>\n</div>', 'ma-page')
    assert.equal(msgs.length, 1)
    assert.match(msgs[0], /ma-page:2\b/)
    assert.match(msgs[0], /action/)
    assert.match(msgs[0], /@method/)
  })

  it('(b) <form action="/x"> : silence', () => {
    assert.deepEqual(checkUjsForm('<form action="/x"></form>', 'mod'), [])
  })

  it('action="" (littérale vide) compte comme ABSENTE : avertit quand même — le navigateur y remet l\'URL courante', () => {
    assert.equal(checkUjsForm('<form action=""></form>', 'mod').length, 1)
  })

  it('(c) <form @method="post"> : silence', () => {
    assert.deepEqual(checkUjsForm('<form @method="post"></form>', 'mod'), [])
  })

  it('<form mjs-method="post"> (forme déjà compilée, si la doc montre le HTML de sortie) : silence', () => {
    assert.deepEqual(checkUjsForm('<form mjs-method="post"></form>', 'mod'), [])
  })

  it('<form method="post"> (verbe HTML NATIF, sans action) : avertit quand même — seul @method/mjs-method vaut acquiescement, le method natif ne change rien à la trappe (l\'action manque toujours)', () => {
    assert.equal(checkUjsForm('<form method="post"></form>', 'mod').length, 1)
  })

  it('(d) <form @noUJS> : silence', () => {
    assert.deepEqual(checkUjsForm('<form @noUJS></form>', 'mod'), [])
  })

  it('(e) <form @submit.prevent={f()}> : avertit QUAND MÊME — le pont shadow capture avant _mjs_bindEvents, .prevent n\'y change rien', () => {
    assert.equal(checkUjsForm('<form @submit.prevent={f()}></form>', 'mod').length, 1)
  })

  it('(f) <form> à l\'intérieur d\'un <pre>/<code> d\'exemple : silence (RÈGLE ZÉRO)', () => {
    const html = [
      '<pre>',
      '  <form></form>',
      '</pre>',
      '<code>',
      '  <form></form>',
      '</code>',
    ].join('\n')
    assert.deepEqual(checkUjsForm(html, 'doc-exemple'), [])
  })

  it('insensible à la casse pour le nom de balise (<FORM>)', () => {
    assert.equal(checkUjsForm('<FORM></FORM>', 'mod').length, 1)
  })
})

// espionne console.warn le temps d'un transpile (motif tests/a11y-lint.test.ts)
async function warningsFor(src: string, moduleName: string, opts: Record<string, unknown> = {}): Promise<string[]> {
  const orig = console.warn
  const caught: string[] = []
  console.warn = (...a: unknown[]) => { caught.push(String(a[0])) }
  try { await transpile(src, { moduleName, ...opts }) } finally { console.warn = orig }
  return caught
}

describe('transpiler — câblage lint.ujsForm', function () {
  this.timeout(30000)

  it('défaut ON — sans AUCUNE clé lint, un <form> fautif déclenche l\'alerte', async () => {
    const w = await warningsFor('<form></form>', 'defaut-on')
    assert.ok(w.some(m => m.includes('@noUJS')), `avertissements capturés : ${JSON.stringify(w)}`)
  })

  it('@noUJS posé dans la SOURCE : silence après compilation (la directive est déjà réécrite en mjs-no-ujs quand le lint tourne)', async () => {
    const w = await warningsFor('<form @noUJS @submit={f()}></form>', 'noujs-source')
    assert.equal(w.filter(m => m.includes('@noUJS')).length, 0, `aucun avertissement attendu : ${JSON.stringify(w)}`)
  })

  it('(g) lint.ujsForm: false coupe tout, même gabarit fautif (aucun avertissement)', async () => {
    const w = await warningsFor('<form></form>', 'ujsform-off', { ujsForm: false })
    assert.equal(w.length, 0, `aucun avertissement attendu : ${JSON.stringify(w)}`)
  })
})

describe('mjs.config.json — validation du bloc lint.ujsForm', () => {
  it('accepte { lint: { ujsForm: false } } et resolveBundlerOpts le transmet', () => {
    const root = mjsTmp('cfg-ujsform')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { ujsForm: false } }))
    const found = findConfig(root)
    assert.ok(found)
    assert.equal(found!.config.lint!.ujsForm, false)
    const opts = resolveBundlerOpts(found!.config, root)
    assert.equal(opts.ujsForm, false)
  })

  it('throw sur lint.ujsForm non booléen, avec le bon message', () => {
    const root = mjsTmp('cfg-ujsform')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ lint: { ujsForm: 'oui' } }))
    assert.throws(() => findConfig(root), /lint\.ujsForm doit être un booléen/)
  })
})
