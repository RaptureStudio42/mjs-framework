// cast de type sur une liaison de COMPOSANT (`<mjs-x value.number=!{$n}>`).
//
// Avant : le suffixe restait collé au nom. La prop posée sur l'enfant s'appelait
// littéralement « value.number » (qu'aucun composant ne déclare) et l'événement
// écouté « mjs-bind:value.number » n'était jamais émis — l'enfant émet sur le nom
// de SA clé d'état, `value`. Liaison morte des deux côtés, compilation muette.
//
// Après : le nom est dépouillé (prop `value`, événement `mjs-bind:value`), et la
// conversion s'applique au SEUL sens montant (enfant → parent) :
// « c'est forcément le côté user qui tape qui doit être contrôlé, l'autre côté ne
// mettra pas un mauvais type si on lui donne un bon à la base ». C'est exactement
// l'asymétrie déjà en place sur une balise native (`valExtractor` porte le cast,
// `updateLogic` non).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function build(files: Record<string, string>): Promise<{ outDir: string; stats: any }> {
  const root = mjsTmp('cast-composant')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [rel, content] of Object.entries(files)) writeFileSync(join(srcDir, rel), content)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  return { outDir, stats }
}

function readComponent(outDir: string, name: string): string {
  const f = readdirSync(outDir).find((f) => new RegExp(`^${name}-[a-f0-9]{8}\\.js$`).test(f))
  assert.ok(f, `${name}-*.js doit exister dans ${outDir}`)
  return readFileSync(join(outDir, f!), 'utf-8')
}

const ENFANT = ['<script>', '  $value ?= null', '</script>', '<span>{$value}</span>'].join('\n')
const hote = (attr: string, init: string): string =>
  ['<script>', `  $n = ${init}`, '</script>', `<mjs-enfant ${attr}=!{$n}></mjs-enfant>`, '<b>{typeof $n}</b>'].join('\n')

describe('liaison de composant — cast de type sur le nom', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('compilation : le nom est dépouillé de son suffixe', () => {
    it('`value.number=!` pose la prop `value` et écoute `mjs-bind:value` (jamais « value.number »)', async () => {
      const { outDir, stats } = await build({ 'enfant.mjs': ENFANT, 'hote.mjs': hote('value.number', '0') })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const out = readComponent(outDir, 'hote')
      assert.match(out, /mjs-bind:value(?!\.)/, 'la route d\'événement doit porter le nom NU')
      assert.doesNotMatch(out, /value\.number/, 'aucune trace du nom suffixé ne doit subsister dans le bundle')
      assert.match(out, /Number\(/, 'la conversion doit être émise')
    })

    it('les quatre suffixes émettent leur conversion, et elle est SEULE dans le sens montant', async () => {
      for (const [suffixe, motif] of [['number', /Number\(/], ['int', /parseInt\(/], ['float', /parseFloat\(/], ['bool', /=== true|is true/]] as const) {
        const { outDir, stats } = await build({ 'enfant.mjs': ENFANT, 'hote.mjs': hote(`value.${suffixe}`, '0') })
        assert.equal(stats.errors.length, 0, `${suffixe} : ${stats.errors.map((e: any) => e.message).join('\n')}`)
        const out = readComponent(outDir, 'hote')
        assert.match(out, motif, `${suffixe} : la conversion doit être émise`)
        // sens descendant intact : la valeur du modèle est passée telle quelle à `_set`
        assert.match(out, /_set\('value',/, `${suffixe} : le sens parent→enfant pose la prop sans conversion`)
      }
    })

    it('sans suffixe, la sortie est INCHANGÉE (aucune régression sur les liaisons existantes)', async () => {
      const { outDir, stats } = await build({ 'enfant.mjs': ENFANT, 'hote.mjs': hote('value', '0') })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const out = readComponent(outDir, 'hote')
      assert.match(out, /mjs-bind:value/)
      assert.doesNotMatch(out, /__mjsCast/, 'aucune variable de conversion ne doit apparaître quand il n\'y a pas de cast')
    })
  })

  describe('exécution : la remontée enfant → parent convertit vraiment', () => {
    async function monte(attr: string, init: string) {
      const { outDir, stats } = await build({ 'enfant.mjs': ENFANT, 'hote.mjs': hote(attr, init) })
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const win = new Window({ url: 'http://localhost/' }) as any
      const stripEsm = (s: string): string => s
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
        .replace(/\bexport\s+default\s+/g, '')
        .replace(/\bexport\s+/g, '')
        .replace(/import\.meta\.url/g, "'http://localhost/'")
      const files = readdirSync(outDir)
      const code = ['mjs_core-', 'enfant-', 'hote-']
        .map((prefix) => files.find((f) => f.startsWith(prefix)))
        .filter((f): f is string => !!f)
        .map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8')))
        .join('\n')
      win.eval(`${code}\nglobalThis.µ = µ;`)
      win.document.body.innerHTML = '<mjs-hote></mjs-hote>'
      await new Promise((r) => setTimeout(r, 80))
      const hoteEl = win.document.body.firstElementChild
      const enfant = hoteEl._shadow.querySelector('mjs-enfant')
      return { win, hoteEl, enfant }
    }

    it('l\'enfant remonte la CHAÎNE "42" → le parent reçoit le NOMBRE 42', async () => {
      const { hoteEl, enfant } = await monte('value.number', '0')
      assert.ok(enfant, 'l\'enfant doit être monté')
      enfant._set('value', '42')
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(hoteEl._state.n, 42)
      assert.equal(typeof hoteEl._state.n, 'number', 'sans le cast, le parent recevait la chaîne "42"')
    })

    it('`.bool` : la chaîne "true" remontée devient le booléen true, "0" devient false', async () => {
      const { hoteEl, enfant } = await monte('value.bool', 'false')
      enfant._set('value', 'true')
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(hoteEl._state.n, true)
      enfant._set('value', '0')
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(hoteEl._state.n, false)
    })

    it('sens descendant : écrire un nombre côté parent le passe tel quel à l\'enfant (aucune conversion en trop)', async () => {
      const { hoteEl, enfant } = await monte('value.number', '0')
      hoteEl._set('n', 7)
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(enfant._state.value, 7)
      assert.equal(typeof enfant._state.value, 'number')
    })

    it('sans cast : la chaîne remontée reste une chaîne (contrat historique préservé)', async () => {
      const { hoteEl, enfant } = await monte('value', '0')
      enfant._set('value', '42')
      await new Promise((r) => setTimeout(r, 40))
      assert.equal(hoteEl._state.n, '42')
      assert.equal(typeof hoteEl._state.n, 'string')
    })
  })
})
