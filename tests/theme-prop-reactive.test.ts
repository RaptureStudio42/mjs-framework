// tests/theme-prop-reactive.test.ts — `theme={$expr}` posé en PROP (pas en
// attribut) par le parent doit activer le thème nommé. Même patron que
// tests/layout-prop-reactive.test.ts, dont c'est le pendant : le CSS d'un thème nommé est déjà
// dans le composant, mais son sélecteur est `:where(:host([theme='gold']), mjs-x[theme='gold'])`
// — il lui faut donc l'ATTRIBUT sur l'hôte. Sans relais, `theme={$x}` posait un état et rien
// d'autre : aucune erreur, aucun style, panne MUETTE (constatée en pratique : la bascule
// theme= ne changeait rien à l'écran).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  '.t',
  '  color: $$brand',
  '</style>',
  '<theme>',
  '  $$brand: #3b82f6',
  '</theme>',
  '<theme name="gold">',
  '  $$brand: #d4af37',
  '</theme>',
].join('\n')

// Composant HOMONYME : il déclare LUI-MÊME `$theme` (un état métier, rien à voir avec le style).
// Le relais doit lui laisser la main — même garde `_mjs_var_bits` que pour `layout`.
const COMPONENT_HOMONYME = [
  '<script lang="coffee">',
  '$theme = "sombre"',
  '</script>',
  '<p class="t">{$theme}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
  '<theme name="gold">',
  '  $$brand: #d4af37',
  '</theme>',
].join('\n')

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function loadHarness(source = COMPONENT, modName = 'theme-prop-demo') {
  const root   = mjsTmp('theme-prop')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${modName}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  window.fetch = async () => ({ ok: false, status: 404 })
  const document: any = window.document

  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => f.startsWith(`${modName}-`) && f.endsWith('.js'))
  assert.ok(coreFile && compFile, `sortie du build inattendue : ${files.join(', ')}`)
  window.eval([
    stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    'globalThis.µ = µ;',
    stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
  ].join('\n'))

  const Ctor = window.customElements.get(`mjs-${modName}`)
  assert.ok(Ctor, `le composant doit être défini sous mjs-${modName}`)
  return { window, document, Ctor }
}

describe('mjs_element — theme={$expr} posé en PROP', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it("_set('theme', 'gold') pose l'attribut sur l'hôte — sinon le sélecteur du thème nommé ne matche jamais", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-theme-prop-demo></mjs-theme-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    el._set('theme', 'gold')
    assert.equal(el.getAttribute('theme'), 'gold', 'la prop theme doit se refléter en attribut')
  })

  it("_set('theme', '') retire l'attribut — retour au bloc de base", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-theme-prop-demo theme="gold"></mjs-theme-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    el._set('theme', '')
    assert.equal(el.getAttribute('theme'), null, 'une valeur vide doit retirer l\'attribut, pas poser theme=""')
  })

  it('la bascule fait un aller-retour complet', async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-theme-prop-demo></mjs-theme-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    el._set('theme', 'gold')
    assert.equal(el.getAttribute('theme'), 'gold')
    el._set('theme', '')
    assert.equal(el.getAttribute('theme'), null)
    el._set('theme', 'gold')
    assert.equal(el.getAttribute('theme'), 'gold')
  })

  it('GARDE — un composant qui déclare lui-même `$theme` garde la main, aucun attribut posé', async () => {
    const { document } = await loadHarness(COMPONENT_HOMONYME, 'theme-prop-homonyme')
    document.body.innerHTML = '<mjs-theme-prop-homonyme></mjs-theme-prop-homonyme>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    el._set('theme', 'sombre-nuit')
    assert.equal(el.getAttribute('theme'), null, 'un `$theme` métier ne doit pas partir en attribut de thème')
    assert.equal(el._state.theme, 'sombre-nuit', 'et il reste un état ordinaire')
  })

  it("TÉMOIN — l'attribut LITTÉRAL continue de marcher tel quel", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-theme-prop-demo theme="gold"></mjs-theme-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    assert.equal(el.getAttribute('theme'), 'gold')
  })
})
