// Test end-to-end — rune µderived $var = expr, $a, $b (dépendances forcées).
//
// Bug d'origine : un computed dont la VRAIE dépendance est
// lue par une fonction SÉPARÉE (`calc()`) — jamais littéralement `$a` à droite
// du `=` — n'était JAMAIS détecté par l'analyzer (qui ne scanne que l'AST du
// RHS textuel de l'assignation, pas le corps des fonctions qu'il appelle).
// `µderived $var = expr, $a, $b` force l'enregistrement de ces deps SANS toucher au
// JS final : `µ._mjs_forceDeps(...)` n'est qu'un marqueur, posé par le lexer,
// entièrement effacé par l'analyzer avant émission du bundle (zéro artefact).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

const COMPONENT = `
<script lang="coffee">
$a = 1

calc = -> $a * 2

µderived $c = calc(), $a
</script>
<p class="o">{$c}</p>
`

describe('µderived — dépendances forcées (bout-en-bout, bundler réel + happy-dom)', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('µderived $c = calc(), $a — calc() lit $a SANS que $a apparaisse texte au RHS : le DOM se met à jour quand même', async () => {
    const root = mjsTmp('derived-fd')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dfx.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))!
    const compFile = files.find((f: string) => /^dfx-/.test(f))!
    const compCode = stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))

    // Zéro artefact : le marqueur du lexer n'a JAMAIS survécu dans le bundle.
    assert.doesNotMatch(compCode, /_mjs_forceDeps/,
      'µ._mjs_forceDeps(...) doit être entièrement effacé par l\'analyzer avant émission')

    // La dépendance FORCÉE `a` doit apparaître dans `_mjs_computedDeps.c` (closure
    // exposée par le compilateur, consommée par µ.effect/effectsByVar).
    const cdMatch = compCode.match(/this\._mjs_computedDeps = (\{[^;]*\});/)
    assert.ok(cdMatch, 'this._mjs_computedDeps = {...}; doit être émis')
    const computedDeps = JSON.parse(cdMatch![1])
    assert.ok(Array.isArray(computedDeps.c) && computedDeps.c.includes('a'),
      `_mjs_computedDeps.c doit contenir 'a' (dépendance FORCÉE, invisible texte au RHS). reçu : ${JSON.stringify(computedDeps)}`)

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-dfx></mjs-dfx>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild

    const text = () => el._shadow.querySelector('p').textContent
    assert.equal(text(), '2', 'valeur initiale : c = calc() = a*2 = 2')

    el._set('a', 5)
    await new Promise(r => setTimeout(r, 60))
    assert.equal(text(), '10',
      'sans µderived, $a n\'apparaissant pas texte au RHS de $c=, la mutation de $a ne re-déclencherait jamais le computed → DOM resterait figé à "2" (c\'est précisément le bug que la rune répare)')

    win.close?.()
  })

  it('zéro dépendance forcée : `µderived $x = $a + 1` (pas de virgule) dégénère en computed ordinaire, sortie identique à la main', async () => {
    const src = `
<script lang="coffee">
$a = 1
µderived $x = $a + 1
$xHand = $a + 1
</script>
<p class="o">{$x}-{$xHand}</p>
`
    const root = mjsTmp('derived-nodeps')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'dfnod.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files = readdirSync(outDir)
    const compFile = files.find((f: string) => /^dfnod-/.test(f))!
    const compCode = stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))

    assert.doesNotMatch(compCode, /_mjs_forceDeps/)
    // $x (via µderived, 0 dep forcée) et $xHand (écrit à la main) doivent
    // produire EXACTEMENT le même motif d'enregistrement computed — seul le
    // NOM de la var diffère, le corps de la fonction est STRICTEMENT identique
    // (le générateur convertit le marqueur `{ _mjs_c: true, f }` en un appel
    // `µ._mjs_setComputed(...)` — c'est CE texte final qui doit être byte-à-byte
    // identique entre les deux formes).
    const mX = compCode.match(/µ\._mjs_setComputed\(_mjsThis, 'x', (\(\) => \(.*?\))\);/)
    const mXHand = compCode.match(/µ\._mjs_setComputed\(_mjsThis, 'xHand', (\(\) => \(.*?\))\);/)
    assert.ok(mX && mXHand, `les deux µ._mjs_setComputed doivent être émis. bundle:\n${compCode}`)
    assert.equal(mX![1], mXHand![1],
      'µderived $x = $a + 1 (0 dep forcée) doit produire un JS STRICTEMENT identique à $xHand = $a + 1 écrit à la main')
  })
})
