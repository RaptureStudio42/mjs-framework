// 2 défauts PRÉ-EXISTANTS.
//
// Défaut 1 — `bindingStandard` (two-way `=!{...}`, src/generator/attributes/index.ts
// ~l.558-683) n'avait de branche que pour `ctx.type === 'root'` et `'for'` : en
// `{await}` (et tout `{if}`/`{key}` imbriqué DEDANS, transparents pour ctx.type —
// eux-mêmes ne créent PAS de nouveau ctx.type) seule l'écoute DOM→modèle était
// câblée, la lecture modèle→DOM n'était JAMAIS émise. `<input value=!{$v}>` y
// restait vide, `<select value=!{$v}>` figé sur la 1re option.
// Correctif : src/generator/attributes/index.ts (bindingStandard, nouvelle
// branche `else`) + src/generator/compile.ts (`splitDeferredUpdates`, 3 sites de
// remontage de `branchUpdates` non-racine) pour que la pose d'un `<select value>`
// attende les `<option>` d'un `{for}` imbriqué, comme cela a déjà été fait pour `value={…}`.
//
// Défaut 2 — `µ._mjs_updAttrNode` (src/runtime/mjs_element.ts ~l.38-69) : un
// `<select multiple value={tableau}>` en liaison SIMPLE (pas two-way) faisait
// `node.value = tableau` — no-op DOM natif, `.selectedOptions` restait vide.
// La sémantique multi-sélection existait déjà côté `bindingStandard` mais
// jamais ici. Correctif : branche dédiée dans `_mjs_updAttrNode`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// calque de tests/attributes-await-booleens-props.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any }> {
  const root   = mjsTmp('bind-branche')
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

// dispatche un événement RÉEL (bubbles) sur le nœud — calque de binding-event-collision.test.ts
async function fire(window: any, node: any, type: string): Promise<void> {
  node.dispatchEvent(new window.Event(type, { bubbles: true, cancelable: true, composed: true }))
  await new Promise((r) => setTimeout(r, 20))
}

// ============================================================================
// Défaut 1 — <input>/<input type="checkbox"> en {await} direct / {if} imbriqué
// dans {await} / {key} imbriqué dans {await} (les 3 seules formes qui font
// atteindre ctx.type='await' pour le contenu — {if}/{key} seuls, à la racine,
// n'introduisent PAS de nouveau ctx.type et étaient déjà corrects).
// ============================================================================

// `$p` STOCKÉ (jamais un `Promise.resolve(1)` littéral inline dans `{await …}`) —
// `compileAwait` réévalue son EXPR à chaque `_mjs_renderStruct` : un littéral y
// fabrique une promesse NEUVE à chaque passage, `_mjs_updAwait` la voit changée
// (idempotence cassée) et la branche oscille pending/success sans jamais se
// stabiliser (creusé en sondant ce fichier — le `{success}` ne montait alors
// JAMAIS). Même remède que pour <select> alimenté par {for} en {await} (attributes-await-booleens-props.test.ts).
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
  { id: 'await', label: '{await} direct',              build: tplAwaitDirect },
  { id: 'ifaw',  label: '{if} imbriqué dans {await}',  build: tplIfInAwait },
  { id: 'keyaw', label: '{key} imbriqué dans {await}',  build: tplKeyInAwait },
]

describe('<input value=!{$v}> en branche non racine', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  for (const { id, label, build } of CONTEXTS) {
    it(`${label} — valeur initiale posée, modification du modèle -> DOM suit, saisie DOM -> modèle suit`, async () => {
      const src = build(
        ["$v = 'b'"],
        '<input class="inp" value=!{$v}>',
        '<button class="setv" @click={$v = \'z\'}>set</button><b class="out">{$v}</b>',
      )
      const fileBase = `d1i-${id}`
      const { window, el } = await mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
      await tick()
      const inp = el._shadow.querySelector('.inp')
      assert.ok(inp, `${label} : input absent`)
      assert.equal(inp.value, 'b', `${label} : valeur initiale`)

      el._shadow.querySelector('.setv').click()
      await tick()
      assert.equal(inp.value, 'z', `${label} : modification du modèle -> DOM`)

      inp.value = 'saisie'
      await fire(window, inp, 'input')
      assert.equal(el._shadow.querySelector('.out').textContent, 'saisie', `${label} : saisie DOM -> modèle`)
    })
  }
})

describe('<input type="checkbox" checked=!{$c}> en branche non racine', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  for (const { id, label, build } of CONTEXTS) {
    it(`${label} — valeur initiale posée, modification du modèle -> DOM suit, saisie DOM -> modèle suit`, async () => {
      const src = build(
        ['$c = false'],
        '<input class="chk" type="checkbox" checked=!{$c}>',
        '<button class="setc" @click={$c = true}>set</button><b class="out">{$c}</b>',
      )
      const fileBase = `d1c-${id}`
      const { window, el } = await mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
      await tick()
      const chk = el._shadow.querySelector('.chk')
      assert.ok(chk, `${label} : checkbox absente`)
      assert.equal(chk.checked, false, `${label} : valeur initiale`)

      el._shadow.querySelector('.setc').click()
      await tick()
      assert.equal(chk.checked, true, `${label} : modification du modèle -> DOM`)

      chk.checked = false
      await fire(window, chk, 'change')
      assert.equal(el._shadow.querySelector('.out').textContent, 'false', `${label} : saisie DOM -> modèle`)
    })
  }
})

// ============================================================================
// Défaut 1 (suite) — <select value=!{$v}>{for}...{end}</select> : la pose doit
// attendre les <option>. `$p` stocké + bouton reload (cf. attributes-await-booleens-props.test.ts,
// cas <select> alimenté par {for} en {await}) : seul moyen d'observer une
// reconstruction de branche ({await} ne rejoue jamais son contenu tout seul).
// ============================================================================

function tplSelectAwaitDirect(scriptLines: string[], bodyHtml: string, tailHtml: string): string {
  return [
    '<script>', ...scriptLines, '</script>',
    '{await $p}{success d}',
    bodyHtml,
    '{end}',
    tailHtml,
  ].join('\n')
}

function tplSelectIfInAwait(scriptLines: string[], bodyHtml: string, tailHtml: string): string {
  return [
    '<script>', '$ok = true', ...scriptLines, '</script>',
    '{await $p}{success d}',
    '{if $ok}',
    bodyHtml,
    '{end}',
    '{end}',
    tailHtml,
  ].join('\n')
}

const SELECT_CONTEXTS = [
  { id: 'await', label: '{await} direct',             build: tplSelectAwaitDirect },
  { id: 'ifaw',  label: '{if} imbriqué dans {await}', build: tplSelectIfInAwait },
]

describe('<select value=!{$v}>{for}...{end}</select> en branche non racine', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  for (const { id, label, build } of SELECT_CONTEXTS) {
    it(`${label} — .value === $v après montage et après changement de $opts (reconstruction)`, async () => {
      const src = build(
        ["$p = Promise.resolve(1)", "$v = 'b'", "$opts = ['a','b','c']"],
        '<select class="sel" value=!{$v}>{for o in $opts}<option value={o}>{o}</option>{end}</select>',
        '<button class="reload" @click={$v = \'c\', $opts = [\'x\',\'y\',\'c\'], $p = Promise.resolve(2)}>reload</button>',
      )
      const fileBase = `d1s-${id}`
      const { el } = await mountFiles({ [`${fileBase}.mjs`]: src }, `mjs-${fileBase}`)
      await tick()
      let sel = el._shadow.querySelector('.sel')
      assert.ok(sel, `${label} : select absent`)
      assert.equal(sel.value, 'b', `${label} : valeur après montage`)

      el._shadow.querySelector('.reload').click()
      await tick()
      sel = el._shadow.querySelector('.sel')
      assert.equal(sel.value, 'c', `${label} : valeur après changement de $opts (reconstruction)`)
    })
  }
})

// ============================================================================
// Non-régression rapide — root et {for} restent inchangés (la preuve complète
// est un byte-diff du corpus, hors mocha).
// ============================================================================

describe('non-régression rapide root/{for} (two-way, hors branche)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('root <input value=!{$v}> inchangé', async () => {
    const src = ['<script>', "$v = 'b'", '</script>', '<input class="inp" value=!{$v}>'].join('\n')
    const { el } = await mountFiles({ 'nr1.mjs': src }, 'mjs-nr1')
    await tick()
    assert.equal(el._shadow.querySelector('.inp').value, 'b')
  })

  it('{for} <select value=!{row.v}> (var externe partagée) inchangé', async () => {
    const src = [
      '<script>', "$choix = 'b'", "$rows = [{ opts: ['a','b','c'] }]", '</script>',
      '{for row in $rows}<select class="sel" value=!{$choix}>{for o in row.opts}<option value={o}>{o}</option>{end}</select>{end}',
    ].join('\n')
    const { el } = await mountFiles({ 'nr2.mjs': src }, 'mjs-nr2')
    await tick()
    assert.equal(el._shadow.querySelector('.sel').value, 'b')
  })
})

// ============================================================================
// Défaut 2 — µ._mjs_updAttrNode : <select multiple value={tableau}> en liaison
// SIMPLE. Harnais calqué sur tests/runtime-easing-vt-guards.test.ts
// (makeElementSandbox : mjs_init.ts + mjs_element.ts bruts dans un
// `new Function`, stubs DOM minimaux) — `_mjs_updAttrNode` ne dépend d'aucune
// classe µ.Element, les stubs servent seulement à faire tourner le FICHIER
// entier sans lever (class Element extends HTMLElement en tête du fichier).
// Les nœuds <select>/<option> testés viennent d'un VRAI document happy-dom
// (sémantique .options/.selected réelle), passés à la fonction du sandbox.
// ============================================================================

const initSrc = readFileSync(join(__dirname, '../src/runtime/mjs_init.ts'), 'utf8')
const elemSrc = readFileSync(join(__dirname, '../src/runtime/mjs_element.ts'), 'utf8')

function makeElementSandbox(): { µ: any } {
  const sandbox = `
    class HTMLElement {
      constructor() {}
      attachShadow(opts) { return { adoptedStyleSheets: [], appendChild() {} }; }
      addEventListener() {} removeEventListener() {} dispatchEvent() {}
      getAttribute() { return null }; setAttribute() {}
    }
    class CustomEvent { constructor(name, init) { this.type = name; Object.assign(this, init || {}); } }
    class Node {}
    class CSSStyleSheet { replaceSync() {} }
    const customElements = { get: () => null, define: () => {} };
    const document = { adoptedStyleSheets: [] };
    ${initSrc.replace(/export\s*\{[^}]*\}/, '')}
    ${elemSrc}
    return { µ };
  `
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(sandbox)()
}

function makeSelect(document: any, multiple: boolean, values: string[]): any {
  const sel = document.createElement('select')
  if (multiple) sel.multiple = true
  for (const v of values) {
    const opt = document.createElement('option')
    opt.value = v
    sel.appendChild(opt)
  }
  return sel
}

describe('µ._mjs_updAttrNode : <select multiple value={tableau}> (liaison simple)', () => {
  let µ: any
  let document: any

  beforeEach(() => {
    µ = makeElementSandbox().µ
    document = new Window({ url: 'http://localhost/' }).document
  })

  it("tableau ['a','c'] -> 2 options sélectionnées", () => {
    const sel = makeSelect(document, true, ['a', 'b', 'c'])
    µ._mjs_updAttrNode(sel, 'value', ['a', 'c'])
    const selected = Array.from(sel.options).filter((o: any) => o.selected).map((o: any) => o.value)
    assert.deepEqual(selected, ['a', 'c'])
  })

  it('tableau vide -> aucune option sélectionnée', () => {
    const sel = makeSelect(document, true, ['a', 'b', 'c'])
    sel.options[0].selected = true
    µ._mjs_updAttrNode(sel, 'value', [])
    const selected = Array.from(sel.options).filter((o: any) => o.selected)
    assert.equal(selected.length, 0)
  })

  it('valeur scalaire sur <select multiple> -> comportement actuel (node.value = val)', () => {
    const sel = makeSelect(document, true, ['a', 'b', 'c'])
    µ._mjs_updAttrNode(sel, 'value', 'b')
    assert.equal(sel.value, 'b')
  })

  it('<select> simple + tableau -> inchangé (node.value = val, branche multiple jamais empruntée)', () => {
    const sel = makeSelect(document, false, ['a', 'b', 'c'])
    µ._mjs_updAttrNode(sel, 'value', ['a', 'c'])
    const selected = Array.from(sel.options).filter((o: any) => o.selected)
    assert.equal(selected.length, 0, 'aucune option cochée via la branche multiple (select non-multiple)')
  })
})
