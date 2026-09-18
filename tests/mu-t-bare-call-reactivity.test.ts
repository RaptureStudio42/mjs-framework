// `{µt 'clé', { x: $v }}` SANS parenthèses perdait
// la réactivité EN SILENCE. Cause : `getEffectVars` (generator/state.ts) tente
// d'abord l'expression ENTIÈRE via acorn (JS pur, pas Civet) — un appel Civet
// SANS parenthèses (sucre `foo a, b` → `foo(a, b)`, jamais compris par acorn nu)
// fait ÉCHOUER cette tentative, et la décomposition de secours (pensée pour un
// template texte+sigil du type "préfixe {$a} suffixe {$b}") extrayait alors le
// CONTENU du bloc `{ x: $v }` SANS ses accolades — `x: $v`, un LABEL invalide
// comme élément de tableau — `acorn.parse` échouait à son tour, `analyzeSnippet`
// (analyzer/index.ts) rendait `[]` (catch silencieux) : `$v` jamais détecté comme
// dépendance, l'interpolation classée "mountOnly" (jamais re-rendue). Avec
// parenthèses, la tentative « whole » réussit directement (acorn comprend
// `µ.t('clé', {…})`) — jamais touchée par ce bug ; testé ici en non-régression.
//
// Fix : generator/state.ts, getEffectVars — quand un bloc `{...}` de la
// décomposition ne parse PAS comme élément de tableau NU (`x: $v` invalide), on
// retente EN GARDANT ses accolades (`{ x: $v }`, objet littéral valide) —
// désambiguïsation par ESSAI RÉEL (acorn), pas par heuristique de forme.
//
// Chaque test MONTE le composant et MUTE la variable (`el._set`) — la preuve est
// le RENDU qui change, pas la seule présence d'une clé dans `_mjs_effectsByVar`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'
import { i18nBootLines } from './helpers/i18n-eval.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// catalogue i18n PARTAGÉ par tous les cas — racine seule, aucune section (donc
// aucun fetch à stubber : les 3 clés sont embarquées telles quelles dans le manifeste).
function seedI18n(srcDir: string): void {
  mkdirSync(join(srcDir, 'i18n'), { recursive: true })
  writeFileSync(join(srcDir, 'i18n', 'fr.yml'), [
    "simple: 'Bonjour %{name}'",
    "deux: 'A=%{a} B=%{b}'",
    "fixe: 'Texte fixe'",
  ].join('\n'))
}

async function mount(name: string, source: string) {
  const root   = mjsTmp(`mut-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  seedI18n(srcDir)
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const manifestPath = join(root, 'bundle.js')
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath, i18n: { default: 'fr' } })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  // `µ._i18nData` est posé par le MANIFESTE (bundle.js), pas par core/comp —
  // sans cette ligne le composant voit le fallback inerte (root vide) et
  // `µt(...)` ne rend jamais que le placeholder, quelle que soit la forme
  // testée (cf. tests/i18n-e2e.test.ts, même extraction).
  const i18nDataStmt = i18nBootLines(manifestPath, outDir)
  assert.ok(i18nDataStmt, 'µ._i18nData doit être émis dans le manifeste')

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile, 'core et composant doivent être compilés')
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${i18nDataStmt}\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { el }
}

describe('µt sans parenthèses — réactivité', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("variable simple, SANS parenthèses : {µt 'simple', { name: $name }}", async () => {
    const src = [
      '<script>',
      "$name = 'Ada'",
      '</script>',
      '<p class="o">{µt \'simple\', { name: $name }}</p>',
    ].join('\n')
    const { el } = await mount('mtsimple', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'Bonjour Ada', 'rendu initial')
    el._set('name', 'Bob')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'Bonjour Bob', "AVANT le fix : figé sur 'Bonjour Ada', _mjs_effectsByVar vide (mountOnly à tort)")
  })

  it("variable simple, AVEC parenthèses (non-régression) : {µt('simple', { name: $name })}", async () => {
    const src = [
      '<script>',
      "$name = 'Ada'",
      '</script>',
      '<p class="o">{µt(\'simple\', { name: $name })}</p>',
    ].join('\n')
    const { el } = await mount('mtparens', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'Bonjour Ada', 'rendu initial')
    el._set('name', 'Bob')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'Bonjour Bob', 'la forme parenthésée doit rester réactive (non-régression)')
  })

  it("propriété ($obj.x), SANS parenthèses : {µt 'simple', { name: $obj.x }}", async () => {
    const src = [
      '<script>',
      "$obj = { x: 'Ada' }",
      '</script>',
      '<p class="o">{µt \'simple\', { name: $obj.x }}</p>',
    ].join('\n')
    const { el } = await mount('mtprop', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'Bonjour Ada', 'rendu initial')
    el._set('obj', { x: 'Bob' })
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'Bonjour Bob', 'AVANT le fix : $obj.x hors de portée, jamais re-rendu')
  })

  it("deux variables dans le même appel, SANS parenthèses : {µt 'deux', { a: $a, b: $b }}", async () => {
    const src = [
      '<script>',
      "$a = '1'",
      "$b = '2'",
      '</script>',
      '<p class="o">{µt \'deux\', { a: $a, b: $b }}</p>',
    ].join('\n')
    const { el } = await mount('mtdeux', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'A=1 B=2', 'rendu initial')
    el._set('a', '9')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'A=9 B=2', 'la 1re variable doit être réactive')
    el._set('b', '8')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'A=9 B=8', 'la 2e variable doit AUSSI être réactive')
  })

  it("appel imbriqué dans une expression (ternaire), SANS parenthèses", async () => {
    const src = [
      '<script>',
      '$show = true',
      "$name = 'Ada'",
      '</script>',
      '<p class="o">{$show ? µt \'simple\', { name: $name } : \'rien\'}</p>',
    ].join('\n')
    const { el } = await mount('mtternaire', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'Bonjour Ada', 'rendu initial')
    el._set('name', 'Bob')
    await new Promise(r => setTimeout(r, 80))
    assert.equal(p.textContent.trim(), 'Bonjour Bob', 'AVANT le fix : imbriqué dans le ternaire, même décomposition défaillante')
  })

  it("forme SANS second argument (non-régression) : {µt 'fixe'}", async () => {
    const src = [
      '<script>',
      '</script>',
      '<p class="o">{µt \'fixe\'}</p>',
    ].join('\n')
    const { el } = await mount('mtfixe', src)
    const p = el._shadow.querySelector('p.o')
    assert.equal(p.textContent.trim(), 'Texte fixe', 'forme sans vars : ne doit pas être cassée par le fix')
  })
})
