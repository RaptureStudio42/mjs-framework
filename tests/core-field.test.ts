// module cœur `field` (<@field>, tag réel <mjs-field>) : label lié au champ
// slotté (for=id généré ou id existant conservé), aide masquée en erreur, réactivité sur µres
// (µ.res, cf. tests/nav-res-struct-lock.test.ts pour le mécanisme de dépendance universelle),
// 3 états (neutre / erreur / succès), message d'erreur toujours en texte (jamais interprété).
// Patron build+happy-dom calqué sur tests/mjs-modal-bundler-integration.test.ts:62-85 et
// tests/nav-res-struct-lock.test.ts (µ._mjs_resMerge pour simuler une réponse serveur 422).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function buildAndMount(hostSource: string): Promise<{ window: any; document: any; hote: any; errCalls: any[][] }> {
  const root = mjsTmp('field')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hote.mjs'), hostSource)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const files = readdirSync(outDir)
  const pick = (re: RegExp) => {
    const f = files.find((f) => re.test(f))
    assert.ok(f, `chunk attendu ${re} parmi ${files.join(', ')}`)
    return f!
  }
  const code = [pick(/^mjs_core-/), pick(/^field-/), pick(/^hote-/)]
    .map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8')))
    .join('\n')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  window.eval(`
    ${code}
    globalThis.µ = µ;
    globalThis.__errCalls = [];
    µ.error = function(...a) { globalThis.__errCalls.push(a); };
  `)
  document.body.innerHTML = '<mjs-hote></mjs-hote>'
  await new Promise((r) => setTimeout(r, 80))
  const hote = document.body.querySelector('mjs-hote')
  const errCalls = window.eval('globalThis.__errCalls')
  return { window, document, hote, errCalls }
}

const HOST_BASE = [
  '<form>',
  '  <@field name="email" label="Adresse e-mail" help="Jamais partagée">',
  '    <input type="email" name="email">',
  '  </@field>',
  '</form>',
].join('\n')

describe('mjs-field — construction, name requis', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('build vert, tag <mjs-field> réécrit dans le gabarit hôte', async () => {
    const root = mjsTmp('field-build')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), HOST_BASE)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(stats.manifest['field'], 'manifeste doit exposer field')
    const files = readdirSync(outDir)
    const hote = files.find((f) => /^hote-/.test(f))!
    assert.match(readFileSync(join(outDir, hote), 'utf-8'), /<mjs-field\b/)
  })

  it('name nulle part (ni enveloppe, ni champ) → µ.error signalé au montage', async () => {
    const { errCalls } = await buildAndMount([
      '<@field label="Sans name">',
      '  <input type="text">',
      '</@field>',
    ].join('\n'))
    assert.ok(errCalls.length >= 1, 'µ.error doit être appelé')
    assert.match(String(errCalls[0][0]), /name/)
  })

  it('name fourni → aucun µ.error', async () => {
    const { errCalls } = await buildAndMount(HOST_BASE)
    assert.equal(errCalls.length, 0)
  })
})

describe('mjs-field — label lié au champ slotté (for/id)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('champ slotté SANS id → un id est généré et le label pointe dessus', async () => {
    const { hote } = await buildAndMount(HOST_BASE)
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const input = fieldEl.querySelector('input')
    const label = fieldEl._shadow.querySelector('label')
    assert.ok(input.id, 'un id doit avoir été posé sur le champ slotté')
    assert.equal(label.getAttribute('for'), input.id, 'le for du label doit référencer cet id')
  })

  it('champ slotté AVEC id déjà présent → id conservé (pas écrasé)', async () => {
    const HOST = [
      '<@field name="pseudo" label="Pseudo">',
      '  <input name="pseudo" id="pseudo-perso">',
      '</@field>',
    ].join('\n')
    const { hote } = await buildAndMount(HOST)
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const input = fieldEl.querySelector('input')
    const label = fieldEl._shadow.querySelector('label')
    assert.equal(input.id, 'pseudo-perso')
    assert.equal(label.getAttribute('for'), 'pseudo-perso')
  })

  it('pas de label fourni → aucun <label> rendu', async () => {
    const HOST = [
      '<@field name="x">',
      '  <input name="x">',
      '</@field>',
    ].join('\n')
    const { hote } = await buildAndMount(HOST)
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assertAbsent(fieldEl._shadow.querySelector('label'))
  })
})

describe('mjs-field — état initial neutre', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('au montage, sans réponse serveur : ni erreur ni succès, aide visible', async () => {
    const { hote } = await buildAndMount(HOST_BASE)
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const box = fieldEl._shadow.querySelector('.field')
    assert.equal(box.classList.contains('has-error'), false)
    assert.equal(box.classList.contains('has-ok'), false)
    assertAbsent(fieldEl._shadow.querySelector('.error'))
    assertAbsent(fieldEl._shadow.querySelector('.ok'))
    const help = fieldEl._shadow.querySelector('.help')
    assert.ok(help, 'aide doit être dans le DOM')
    assert.equal(help.textContent, 'Jamais partagée')
  })
})

describe('mjs-field — réactivité sur µres.errors', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('µres.errors.email posé → classe has-error + message affiché (part=error)', async () => {
    const { window, hote } = await buildAndMount(HOST_BASE)
    window.eval(`µ._mjs_resMerge({errors: {email: 'format invalide'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const box = fieldEl._shadow.querySelector('.field')
    assert.ok(box.classList.contains('has-error'))
    const errorEl = fieldEl._shadow.querySelector('[part=error]')
    assert.ok(errorEl)
    assert.equal(errorEl.textContent, 'format invalide')
    window.close?.()
  })

  it('aide masquée en état erreur (classe has-error posée, aide toujours présente dans le DOM)', async () => {
    const { window, hote } = await buildAndMount(HOST_BASE)
    window.eval(`µ._mjs_resMerge({errors: {email: 'requis'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.ok(fieldEl._shadow.querySelector('.field').classList.contains('has-error'))
    assert.ok(fieldEl._shadow.querySelector('.help'), 'aide reste dans le DOM (masquée par CSS, pas retirée)')
    window.close?.()
  })

  it('message d\'erreur contenant du balisage reste TEXTE littéral (jamais interprété)', async () => {
    const { window, hote } = await buildAndMount(HOST_BASE)
    window.eval(`µ._mjs_resMerge({errors: {email: '<b>mal formé</b>'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const errorEl = fieldEl._shadow.querySelector('[part=error]')
    assert.equal(errorEl.textContent, '<b>mal formé</b>')
    assertAbsent(errorEl.querySelector('b'), 'aucun élément <b> ne doit être créé')
    window.close?.()
  })

  it('erreur en tableau → premier élément affiché', async () => {
    const { window, hote } = await buildAndMount(HOST_BASE)
    window.eval(`µ._mjs_resMerge({errors: {email: ['trop court', 'autre problème']}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.equal(fieldEl._shadow.querySelector('[part=error]').textContent, 'trop court')
    window.close?.()
  })

  it('erreur retirée à la réponse suivante → classe has-ok + part=ok présent (ok-label absent → texte vide)', async () => {
    const { window, hote } = await buildAndMount(HOST_BASE)
    window.eval(`µ._mjs_resMerge({errors: {email: 'requis'}});`)
    await new Promise((r) => setTimeout(r, 80))
    window.eval(`µ._mjs_resMerge({errors: {}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    const box = fieldEl._shadow.querySelector('.field')
    assert.equal(box.classList.contains('has-error'), false)
    assert.ok(box.classList.contains('has-ok'))
    const okEl = fieldEl._shadow.querySelector('[part=ok]')
    assert.ok(okEl, 'part ok doit être exposée même sans texte')
    assert.equal(okEl.textContent, '')
    window.close?.()
  })

  it('ok-label fourni → texte affiché dans part=ok à l\'état succès', async () => {
    const HOST = [
      '<@field name="email" label="E-mail" ok-label="Adresse valide">',
      '  <input type="email" name="email">',
      '</@field>',
    ].join('\n')
    const { window, hote } = await buildAndMount(HOST)
    window.eval(`µ._mjs_resMerge({errors: {email: 'requis'}});`)
    await new Promise((r) => setTimeout(r, 80))
    window.eval(`µ._mjs_resMerge({errors: {}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.equal(fieldEl._shadow.querySelector('[part=ok]').textContent, 'Adresse valide')
    window.close?.()
  })

  it('champ jamais en erreur : une soumission qui échoue pour un AUTRE champ le fait quand même passer en succès', async () => {
    const HOST = [
      '<@field name="pseudo" label="Pseudo">',
      '  <input name="pseudo">',
      '</@field>',
      '<@field name="email" label="E-mail">',
      '  <input type="email" name="email">',
      '</@field>',
    ].join('\n')
    const { window, hote } = await buildAndMount(HOST)
    window.eval(`µ._mjs_resMerge({errors: {email: 'requis'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fields = hote._shadow.querySelectorAll('mjs-field')
    const pseudoField = Array.from(fields).find((f: any) => f.getAttribute('name') === 'pseudo') as any
    const emailField = Array.from(fields).find((f: any) => f.getAttribute('name') === 'email') as any
    assert.ok(pseudoField._shadow.querySelector('.field').classList.contains('has-ok'), 'pseudo n\'a jamais eu d\'erreur mais la soumission a eu lieu : succès')
    assert.ok(emailField._shadow.querySelector('.field').classList.contains('has-error'))
    window.close?.()
  })
})

// `name` écrit DEUX FOIS pour rien : le champ
// enveloppé porte déjà le sien (sans lui, aucun formulaire ne le ramasse), et
// `<@field>` n'a qu'un seul enfant projeté — c'est forcément celui-là. `name`
// devient donc FACULTATIF sur l'enveloppe : à défaut, elle lit celui du champ.
// Un `name` explicite reste prioritaire (clé serveur qui diffère du champ, par
// exemple `user[email]` côté formulaire et `email` côté sac d'erreurs).
describe('mjs-field — `name` déduit du champ enveloppé', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('aucun name sur <@field> mais un name sur le champ : aucune erreur signalée', async () => {
    const { errCalls } = await buildAndMount([
      '<@field label="Adresse e-mail">',
      '  <input type="email" name="email">',
      '</@field>',
    ].join('\n'))
    assert.equal(errCalls.length, 0, 'le name du champ suffit, rien à signaler')
  })

  it('le name déduit sert vraiment de clé dans µres.errors', async () => {
    const { window, hote } = await buildAndMount([
      '<@field label="Adresse e-mail" help="Jamais partagée">',
      '  <input type="email" name="email">',
      '</@field>',
    ].join('\n'))
    window.eval(`µ._mjs_resMerge({errors: {email: 'format invalide'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.ok(fieldEl._shadow.querySelector('.field').classList.contains('has-error'))
    assert.equal(fieldEl._shadow.querySelector('[part=error]').textContent, 'format invalide')
    window.close?.()
  })

  it('name EXPLICITE sur <@field> : il gagne sur celui du champ', async () => {
    const { window, hote } = await buildAndMount([
      '<@field name="email" label="Adresse e-mail">',
      '  <input type="email" name="user[email]">',
      '</@field>',
    ].join('\n'))
    window.eval(`µ._mjs_resMerge({errors: {email: 'format invalide'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.ok(fieldEl._shadow.querySelector('.field').classList.contains('has-error'), 'la clé lue est celle de l\'enveloppe')
    assert.equal(fieldEl._shadow.querySelector('[part=error]').textContent, 'format invalide')
    window.close?.()
  })

  it('champ enveloppé dans un conteneur : le name est trouvé un cran plus bas', async () => {
    const { window, hote } = await buildAndMount([
      '<@field label="Pseudo">',
      '  <div class="wrap"><input name="pseudo"></div>',
      '</@field>',
    ].join('\n'))
    window.eval(`µ._mjs_resMerge({errors: {pseudo: 'déjà pris'}});`)
    await new Promise((r) => setTimeout(r, 80))
    const fieldEl = hote._shadow.querySelector('mjs-field')
    assert.equal(fieldEl._shadow.querySelector('[part=error]').textContent, 'déjà pris')
    window.close?.()
  })
})
