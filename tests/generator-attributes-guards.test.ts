// src/generator/attributes/index.ts. Cinq défauts couverts :
//   1 · `@style.prop={expr}`/`--var={expr}` avec null/undefined → la CSS recevait la
//       chaîne "null"/"undefined".
//   2 · `!important` embarqué dans la valeur → rejeté en entier, silencieusement.
//   3 · booléen (`MJS_BOOLEAN_PROPS`) jamais retiré sur une balise sans IDL native.
//       Réserve de périmètre : ce scénario utilise un attribut
//       PLAIN (`disabled={$d}`, one-way) — ce chemin délègue entièrement à
//       `src/runtime/mjs_element.ts` (`µ._mjs_updAttrNode`, hors périmètre ici). Le
//       correctif ici porte sur `bindingStandard` (two-way `!{…}`, seul code
//       généré par CE fichier qui écrit `node.prop = !!v`), testé via `!{…}`.
//   4 · casse incorrecte d'une directive connue (`@Confirm=`) :
//       compile SANS erreur, un `@xxx` inconnu sur un élément est un
//       écouteur d'événement, quelle que soit sa casse (repli assumé).
//   5 · la forme CONDITIONNELLE `@style.prop{cond}="valeur"` (syntaxe standard,
//       docs/09-directives-dom.md:126, docs/17-router.md:384) court-circuitait les points 1 et 2 :
//       `null`/`undefined` posait la chaîne "null" et `!important` embarqué n'était
//       jamais détaché.
//
// Harnais mount() copié de tests/state-collection-reactivity.test.ts:16-40.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function mount(name: string, source: string) {
  const root = mjsTmp(`revl1-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { window, el }
}

const flush = () => new Promise((r) => setTimeout(r, 80))

describe('generator/attributes/index.ts', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('@style/--var null-safe', () => {
    it('--accent={$c} : null retire la custom property, red la pose, 0 n\'est pas vide', async () => {
      const src = ['<script>', '$c = null', '</script>', '<div --accent={$c}>x</div>'].join('\n')
      const { el } = await mount('e1accent', src)
      const style = () => el._shadow.querySelector('div').style
      assert.equal(style().getPropertyValue('--accent'), '', 'valeur vide attendue (null)')
      assert.equal(style().cssText.includes('--accent'), false, 'custom property absente du cssText (null)')

      el._set('c', 'red')
      await flush()
      assert.equal(style().getPropertyValue('--accent'), 'red', 'valeur posée après mutation')

      el._set('c', 0)
      await flush()
      assert.equal(style().getPropertyValue('--accent'), '0', '0 est une valeur, pas une absence')
    })

    it('@style.color={$c} : undefined retire la propriété', async () => {
      const src = ['<script>', '$c = undefined', '</script>', '<div @style.color={$c}>x</div>'].join('\n')
      const { el } = await mount('e1color', src)
      const style = el._shadow.querySelector('div').style
      assert.equal(style.getPropertyValue('color'), '', 'propriété absente attendue (undefined)')
    })
  })

  describe('@style !important', () => {
    it('@style.color={$v} : \'red !important\' pose la priorité, sans suffixe la priorité reste vide', async () => {
      const src = ['<script>', "$v = 'red !important'", '</script>', '<div @style.color={$v}>x</div>'].join('\n')
      const { el } = await mount('e2important', src)
      const style = el._shadow.querySelector('div').style
      assert.equal(style.getPropertyValue('color'), 'red', 'valeur sans le suffixe')
      assert.equal(style.getPropertyPriority('color'), 'important', 'priorité important posée')

      el._set('v', 'blue')
      await flush()
      assert.equal(style.getPropertyValue('color'), 'blue')
      assert.equal(style.getPropertyPriority('color'), '', 'sans suffixe, priorité vide')
    })
  })

  describe('booléen sans IDL natif jamais retiré (two-way !{…})', () => {
    // Réserve : ce scénario (`disabled={$d}`, one-way) délègue à
    // `this._mjs_updAttr` → `µ._mjs_updAttrNode` (src/runtime/mjs_element.ts, hors
    // périmètre). Prouvé par transpile direct :
    // le code généré pour `<div disabled={$d}>` est `this._mjs_updAttr('a1','disabled',$.d)`,
    // aucune ligne de CE fichier n'y participe. Le seul code de attributes/index.ts qui
    // écrit `node.prop = !!v` (le bug décrit) est `bindingStandard`, atteint par la forme
    // two-way `!{…}` — testé ici.
    it('<div disabled=!{$d}> : retire l\'attribut sur false, le pose sur true', async () => {
      const src = ['<script>', '$d = false', '</script>', '<div disabled=!{$d}>x</div>'].join('\n')
      const { el } = await mount('e3divdisabled', src)
      const div = el._shadow.querySelector('div')
      assert.equal(div.hasAttribute('disabled'), false, 'div sans IDL native : attribut absent sur false')

      el._set('d', true)
      await flush()
      assert.equal(div.hasAttribute('disabled'), true, 'attribut posé sur true')
    })

    it('<button disabled=!{$d}> : non-régression (IDL native)', async () => {
      const src = ['<script>', '$d = false', '</script>', '<button disabled=!{$d}>x</button>'].join('\n')
      const { el } = await mount('e3btndisabled', src)
      const btn = el._shadow.querySelector('button')
      assert.equal(btn.hasAttribute('disabled'), false, 'bouton natif : attribut absent sur false')

      el._set('d', true)
      await flush()
      assert.equal(btn.hasAttribute('disabled'), true, 'attribut posé sur true (réflexion native)')
    })

    it('<button aria-expanded=!{$d} disabled=!{$d}> : non-régression combinée', async () => {
      const src = ['<script>', '$d = false', '</script>', '<button aria-expanded=!{$d} disabled=!{$d}>x</button>'].join('\n')
      const { el } = await mount('e3combo', src)
      const btn = el._shadow.querySelector('button')
      assert.equal(btn.hasAttribute('disabled'), false, 'disabled absent sur false')

      el._set('d', true)
      await flush()
      assert.equal(btn.hasAttribute('disabled'), true, 'disabled posé sur true')
      assert.equal(btn.getAttribute('aria-expanded'), 'true', 'aria-expanded non perturbé par le fix disabled')
    })
  })

  describe('casse incorrecte d\'une directive connue', () => {
    // espionne console.warn le temps d'un transpile
    async function warningsFor(src: string, moduleName: string): Promise<{ warns: string[]; output?: string; err?: any }> {
      const orig = console.warn
      const warns: string[] = []
      console.warn = (...a: unknown[]) => { warns.push(String(a[0])) }
      try {
        const { output } = await transpile(src, { moduleName })
        return { warns, output }
      } catch (err: any) {
        return { warns, err }
      } finally {
        console.warn = orig
      }
    }

    it('@Confirm="…" : compile sans erreur — un @xxx inconnu sur un élément est un écouteur, quelle que soit sa casse', async () => {
      const { err, output } = await warningsFor('<button @Confirm="Sur">y</button>', 'e4confirmcasse')
      assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
      assert.ok(output && output.length > 0)
    })

    it('@click="…" : inchangé, 0 avertissement, compile', async () => {
      const { warns, output, err } = await warningsFor('<button @click="go()">y</button>', 'e4click')
      assert.equal(err, undefined, 'aucune erreur attendue')
      assert.equal(warns.length, 0, `aucun avertissement attendu : ${JSON.stringify(warns)}`)
      assert.ok(output && output.length > 0)
    })

    it('@stlye="…" : compile sans erreur — un @xxx inconnu sur un élément est un écouteur, quelle que soit sa casse', async () => {
      const { err, output } = await warningsFor('<div @stlye="color:red">x</div>', 'e4stlye')
      assert.equal(err, undefined, `aucune erreur attendue : ${err?.message}`)
      assert.ok(output && output.length > 0)
    })
  })

  describe('@style.prop{cond}="valeur" — même protection que la forme pleine', () => {
    it('@style.color{$active}="red !important" : condition vraie pose la valeur ET la priorité, fausse retire la propriété', async () => {
      const src = ['<script>', '$active = true', '</script>', '<div @style.color{$active}="red !important">x</div>'].join('\n')
      const { el } = await mount('e5condimportant', src)
      const style = el._shadow.querySelector('div').style
      assert.equal(style.getPropertyValue('color'), 'red', 'valeur sans le suffixe')
      assert.equal(style.getPropertyPriority('color'), 'important', 'priorité important posée')

      el._set('active', false)
      await flush()
      assert.equal(style.getPropertyValue('color'), '', 'condition fausse : propriété retirée')
    })

    it('@style.font-family{$active}="{$n}" : null n\'écrit pas la chaîne "null", serif se pose normalement', async () => {
      const src = ['<script>', '$active = true', '$n = null', '</script>', '<div @style.font-family{$active}="{$n}">x</div>'].join('\n')
      const { el } = await mount('e5condnull', src)
      const style = el._shadow.querySelector('div').style
      assert.equal(style.getPropertyValue('font-family'), '', 'null : propriété absente, pas la chaîne "null"')

      el._set('n', 'serif')
      await flush()
      assert.equal(style.getPropertyValue('font-family'), 'serif', 'valeur posée après mutation')
    })

    it('@style.width{$big}="{$n}px" : mélange texte+expression, valeur composée posée normalement', async () => {
      const src = ['<script>', '$big = true', '$n = 10', '</script>', '<div @style.width{$big}="{$n}px">x</div>'].join('\n')
      const { el } = await mount('e5condmixed', src)
      const style = el._shadow.querySelector('div').style
      assert.equal(style.getPropertyValue('width'), '10px', 'texte + expression composés')
    })
  })
})
