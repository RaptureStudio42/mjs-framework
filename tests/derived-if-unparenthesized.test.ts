// Test end-to-end — `$x = if … then … else …` SANS
// parenthèses, AU TOP-LEVEL, compile chez Civet en 3 statements séparés dont
// le RHS final est un identifiant NU (`ref`) — jamais reconnu comme derived
// par l'analyzer avant ce correctif (instantané figé à vie, en silence). La
// forme PARENTHÉSÉE, elle, passe déjà par le chemin normal mais souffrait d'un
// résidu de parenthèses fermantes côté transform-reactive.ts,
// surtout visible dans une méthode. Les deux scénarios sont couverts ici, à
// travers le VRAI pipeline de compilation (Bundler), calqué sur le harnais de
// tests/reactive-increment-asi.test.ts — sans le volet happy-dom/clic, les
// deux assertions demandées (contenu du JS émis, parseabilité acorn) étant
// purement statiques.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('dérivée if/else — bout-en-bout (bundler réel)', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('`$display = if $sel then $selTasks else $visible` (SANS parenthèses, top-level) : µ._mjs_setComputed émis', async () => {
    const COMPONENT = `
<script>
$sel = true
$selTasks = 'taches'
$visible = 'rien'
$display = if $sel then $selTasks else $visible
</script>
<p class="o">{$display}</p>
`
    const root   = mjsTmp('derived-if')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dif.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files    = readdirSync(outDir)
    const compFile = files.find((f: string) => /^dif-/.test(f))!
    const compCode = stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))

    assert.match(compCode, /µ\._mjs_setComputed\(_mjsThis, 'display'/,
      'la forme SANS parenthèses doit converger vers le même wrap computed que la forme parenthésée')
    assert.doesNotThrow(() => acorn.parse(compCode, { ecmaVersion: 'latest', sourceType: 'module' }))
  })

  it('méthode `@pick = ->` avec `$display = (if $sel then $a else $b)` (parenthésé) : compile sans erreur, JS parseable (plus de `)))`)', async () => {
    const COMPONENT = `
<script>
$sel = true
$a = 'x'
$b = 'y'
@pick = ->
  $display = (if $sel then $a else $b)
</script>
<p class="o">{$display}</p>
<button class="go" @click={@pick()}>choisir</button>
`
    const root   = mjsTmp('derived-if-meth')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'difm.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files    = readdirSync(outDir)
    const compFile = files.find((f: string) => /^difm-/.test(f))!
    const compCode = stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))

    assert.doesNotMatch(compCode, /\)\)\)/, 'plus de résidu de parenthèses fermantes')
    assert.doesNotThrow(() => acorn.parse(compCode, { ecmaVersion: 'latest', sourceType: 'module' }),
      'le JS émis doit parser à l\'acorn — la preuve concrète que le résidu de `)))` a disparu')
  })
})
