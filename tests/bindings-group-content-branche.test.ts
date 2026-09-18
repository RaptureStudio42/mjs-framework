// 2 défauts PRÉ-EXISTANTS. Même classe de bug que dans
// tests/bindings-branche-non-racine.test.ts (patron repris ici), mais sur
// les fonctions SŒURES de `bindingStandard` — non touchées par le fix précédent.
//
// Défaut 1 — `bindingGroup` (`@group=!{...}`, radio/checkbox,
// src/generator/attributes/index.ts ~l.952-1007) n'avait de branche que pour
// `ctx.type === 'root'` et `'for'` : en `{await}` (et tout `{if}`/`{key}`
// imbriqué DEDANS, transparents pour ctx.type) aucune logique
// `node.checked = …` n'était émise — le sens modèle→DOM restait mort, ni au
// montage ni après mutation (le sens DOM→modèle, lui, marchait déjà).
//
// Défaut 2 — `bindingContent` (`@text=!`/`@html=!`, contenteditable,
// ~l.882-946) avait bien un `else`, mais il utilisait `__nodes['${env.lid}']`
// alors que `env.lid` n'est posé QUE si `ctx.loops.length > 0` (compile.ts
// ~l.292-295) : en `{await}` nu (sans `{for}` englobant), le code généré
// contenait littéralement `__nodes['null']` → `textContent`/`innerHTML` vide
// au montage.
//
// Correctif (les deux) : aligné sur la branche `else` déjà posée dans
// `bindingStandard` (~l.567-651) — pose initiale via `ctx.updates` +
// `__nodes[id]` (le `mjs-id` du nœud, pas `lid`), réactivité ultérieure via
// `registerEffect` + `this._mjs_nodes[id]`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// calque de tests/bindings-branche-non-racine.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any }> {
  const root   = mjsTmp('bind-grp-content')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles  = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
  const compCode = jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.insertAdjacentHTML('beforeend', `<${rootTag}></${rootTag}>`)
  const el = document.body.querySelector(rootTag)
  return { window, document, el }
}

const tick = () => new Promise((r) => setTimeout(r, 150))

// dispatche un événement RÉEL (bubbles) sur le nœud — calque de bindings-branche-non-racine.test.ts
async function fire(window: any, node: any, type: string): Promise<void> {
  node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true, composed: true }))
  await new Promise((r) => setTimeout(r, 20))
}

// `$p` STOCKÉ (jamais un `Promise.resolve(1)` littéral inline dans `{await …}`) :
// `compileAwait` réévalue son EXPR à chaque
// `_mjs_renderStruct`, un littéral y fabrique une promesse NEUVE à chaque
// passage, la branche oscille pending/success sans jamais se stabiliser.
function tplAwaitDirect(scriptLines: string[], bodyHtml: string, tailHtml: string): string {
  return [
    '<script>', '$p = Promise.resolve(1)', ...scriptLines, '</script>',
    '{await $p}{success d}',
    bodyHtml,
    '{end}',
    tailHtml,
  ].join('\n')
}

function tplIfInAwait(scriptLines: string[], bodyHtml: string, tailHtml: string): string {
  return [
    '<script>', '$p = Promise.resolve(1)', '$ok = true', ...scriptLines, '</script>',
    '{await $p}{success d}',
    '{if $ok}',
    bodyHtml,
    '{end}',
    '{end}',
    tailHtml,
  ].join('\n')
}

function tplKeyInAwait(scriptLines: string[], bodyHtml: string, tailHtml: string): string {
  return [
    '<script>', '$p = Promise.resolve(1)', '$k = 1', ...scriptLines, '</script>',
    '{await $p}{success d}',
    '{key $k}',
    bodyHtml,
    '{end}',
    '{end}',
    tailHtml,
  ].join('\n')
}

const CONTEXTS = [
  { id: 'await', label: '{await} direct',             build: tplAwaitDirect },
  { id: 'ifaw',  label: '{if} imbriqué dans {await}', build: tplIfInAwait },
  { id: 'keyaw', label: '{key} imbriqué dans {await}', build: tplKeyInAwait },
]

// ============================================================================
// Défaut 1 — radio @group=!{$choix} en {await} direct / {if} dans
// {await} / {key} dans {await}.
// ============================================================================

describe('<input type="radio" @group=!{$choix}> en branche non racine', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  for (const { id, label, build } of CONTEXTS) {
    it(`${label} — bonne radio cochée au montage, suit $choix muté, clic -> modèle`, async () => {
      const src = build(
        ["$choix = 'b'"],
        '<input class="ra" type="radio" value="a" @group=!{$choix}><input class="rb" type="radio" value="b" @group=!{$choix}>',
        '<button class="seta" @click={$choix = \'a\'}>set a</button><b class="out">{$choix}</b>',
      )
      const fileBase = `d1g-${id}`
      const { window, el } = await mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
      await tick()
      const ra = el._shadow.querySelector('.ra')
      const rb = el._shadow.querySelector('.rb')
      assert.ok(ra && rb, `${label} : radios absentes`)
      assert.equal(ra.checked, false, `${label} : ra initial`)
      assert.equal(rb.checked, true, `${label} : rb initial (pose modèle -> DOM)`)

      el._shadow.querySelector('.seta').click()
      await tick()
      assert.equal(ra.checked, true, `${label} : ra après mutation $choix`)
      assert.equal(rb.checked, false, `${label} : rb après mutation $choix`)

      rb.checked = true
      await fire(window, rb, 'change')
      assert.equal(el._shadow.querySelector('.out').textContent, 'b', `${label} : clic -> modèle`)
    })
  }
})

// ============================================================================
// Défaut 1 — checkbox groupée (tableau) @group=!{$liste} en {await} nu.
// Mutation par `.push()` via une méthode nommée (calque
// tests/snapshots/tuto__2__2-2__tuto-etat-profond-preview.input.mjs,
// `addNumber = -> $numbers.push(...)` + `@click={addNumber}` — pattern
// EXISTANT du corpus, pas un `.push()` inline dans l'attribut, jamais vu).
// ============================================================================

describe('<input type="checkbox" @group=!{$liste}> (tableau) en {await} nu', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('cochées au montage, suivent une mutation (push), clic -> tableau', async () => {
    const src = [
      '<script>', "$p = Promise.resolve(1)", "$liste = ['b']", "addA = -> $liste.push('a')", '</script>',
      '{await $p}{success d}',
      '<input class="ca" type="checkbox" value="a" @group=!{$liste}><input class="cb" type="checkbox" value="b" @group=!{$liste}>',
      '{end}',
      '<button class="addA" @click={addA}>add a</button><b class="out">{$liste.join(\',\')}</b>',
    ].join('\n')
    const { window, el } = await mountFiles({ 'd1chk.mjs': src }, 'mjs-d1chk')
    await tick()
    const ca = el._shadow.querySelector('.ca')
    const cb = el._shadow.querySelector('.cb')
    assert.ok(ca && cb, 'checkboxes absentes')
    assert.equal(ca.checked, false, 'ca initial')
    assert.equal(cb.checked, true, 'cb initial (pose modèle -> DOM)')

    el._shadow.querySelector('.addA').click()
    await tick()
    assert.equal(ca.checked, true, 'ca coché après push')
    assert.equal(cb.checked, true, 'cb reste coché après push')

    ca.checked = false
    await fire(window, ca, 'change')
    assert.equal(el._shadow.querySelector('.out').textContent, 'b', 'clic décoche ca -> tableau')
  })
})

// ============================================================================
// Défaut 2 — contenteditable @text=!{$t} en {await} nu (sans {for}
// englobant : `env.lid` absent, cas exact du trou `__nodes['null']`).
// ============================================================================

describe('contenteditable @text=!{$t} en {await} nu', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('textContent = $t au montage, suit la mutation, saisie -> modèle', async () => {
    const src = [
      '<script>', "$p = Promise.resolve(1)", "$t = 'salut'", '</script>',
      '{await $p}{success d}',
      '<div class="ce" contenteditable @text=!{$t}></div>',
      '{end}',
      '<button class="setm" @click={$t = \'monde\'}>set</button><b class="out">{$t}</b>',
    ].join('\n')
    const { window, el } = await mountFiles({ 'd2text.mjs': src }, 'mjs-d2text')
    await tick()
    const ce = el._shadow.querySelector('.ce')
    assert.ok(ce, 'div contenteditable absent')
    assert.equal(ce.textContent, 'salut', 'pose initiale')

    el._shadow.querySelector('.setm').click()
    await tick()
    assert.equal(ce.textContent, 'monde', 'mutation modèle -> DOM')

    ce.textContent = 'saisie'
    await fire(window, ce, 'input')
    assert.equal(el._shadow.querySelector('.out').textContent, 'saisie', 'saisie DOM -> modèle')
  })
})

// ============================================================================
// Défaut 2 — contenteditable @html=!{$h} en {await} nu.
// ============================================================================

describe('contenteditable @html=!{$h} en {await} nu', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('innerHTML = $h au montage, suit la mutation, saisie -> modèle', async () => {
    const src = [
      '<script>', "$p = Promise.resolve(1)", "$h = '<b>salut</b>'", '</script>',
      '{await $p}{success d}',
      '<div class="ce" contenteditable @html=!{$h}></div>',
      '{end}',
      '<button class="setm" @click={$h = \'<i>monde</i>\'}>set</button><pre class="out">{$h}</pre>',
    ].join('\n')
    const { window, el } = await mountFiles({ 'd2html.mjs': src }, 'mjs-d2html')
    await tick()
    const ce = el._shadow.querySelector('.ce')
    assert.ok(ce, 'div contenteditable absent')
    assert.equal(ce.innerHTML, '<b>salut</b>', 'pose initiale')

    el._shadow.querySelector('.setm').click()
    await tick()
    assert.equal(ce.innerHTML, '<i>monde</i>', 'mutation modèle -> DOM')

    ce.innerHTML = '<u>saisie</u>'
    await fire(window, ce, 'input')
    assert.equal(el._shadow.querySelector('.out').textContent, '<u>saisie</u>', 'saisie DOM -> modèle')
  })
})

// ============================================================================
// Non-régression rapide — root et {for} restent inchangés (sanity check
// mocha ; la preuve complète est un byte-diff du corpus, hors mocha).
// ============================================================================

describe('non-régression rapide root/{for} (@group=!, @text=!/@html=!, hors branche)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('root <input type="radio" @group=!{$choix}> inchangé', async () => {
    const src = [
      '<script>', "$choix = 'b'", '</script>',
      '<input class="ra" type="radio" value="a" @group=!{$choix}><input class="rb" type="radio" value="b" @group=!{$choix}>',
    ].join('\n')
    const { el } = await mountFiles({ 'nr1.mjs': src }, 'mjs-nr1')
    await tick()
    assert.equal(el._shadow.querySelector('.rb').checked, true)
  })

  it('{for} <input type="checkbox" @group=!{$choix}> (var externe partagée) inchangé', async () => {
    const src = [
      '<script>', "$choix = ['b']", "$opts = ['a', 'b']", '</script>',
      '{for o in $opts}<input class="chk" type="checkbox" value={o} @group=!{$choix}>{end}',
    ].join('\n')
    const { el } = await mountFiles({ 'nr2.mjs': src }, 'mjs-nr2')
    await tick()
    const boxes = el._shadow.querySelectorAll('.chk')
    assert.equal(boxes[0].checked, false, 'a non coché')
    assert.equal(boxes[1].checked, true, 'b coché (var externe partagée)')
  })

  it('root contenteditable @text=!{$t} inchangé', async () => {
    const src = ['<script>', "$t = 'salut'", '</script>', '<div class="ce" contenteditable @text=!{$t}></div>'].join('\n')
    const { el } = await mountFiles({ 'nr3.mjs': src }, 'mjs-nr3')
    await tick()
    assert.equal(el._shadow.querySelector('.ce').textContent, 'salut')
  })

  it('{for} contenteditable @text=!{row.txt} inchangé', async () => {
    const src = [
      '<script>', "$rows = [{ txt: 'ok-for' }]", '</script>',
      '{for row in $rows}<div class="ce" contenteditable @text=!{row.txt}></div>{end}',
    ].join('\n')
    const { el } = await mountFiles({ 'nr4.mjs': src }, 'mjs-nr4')
    await tick()
    assert.equal(el._shadow.querySelector('.ce').textContent, 'ok-for')
  })
})
