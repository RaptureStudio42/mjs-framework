// Refs @this = variables SANS `$` → écritures BRUTES (perf).
//
// Modèle MJS : `$` = RÉACTIF. Une référence DOM (`@this`) ne doit donc PAS porter
// de `$` : on la déclare en variable simple (`orb = null`, `@this=!{orb}`). Comme
// elle n'est pas réactive, `orb.style.x = v` est une écriture DIRECTE — le
// path-tracker ne transforme QUE les chemins `$.…`, donc il ne la touche jamais :
// zéro `µ._mjs_deepSet`, zéro notify/invalidate. C'est ce que veut un nœud DOM vivant.
//
// Inversement, si on met un `$` (`@this=!{$orb}`), la ref devient réactive et
// chaque écriture passe par `µ._mjs_deepSet` (coût) — anti-pattern (le compilateur
// émet d'ailleurs un avertissement). Ces tests verrouillent les deux contrats.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { applyPathTracking } from '../src/generator/path-tracker.js'
import { mjsTmp } from './helpers/tmp.js'

async function compileComponent(src: string, tag: string): Promise<string> {
  const root = mjsTmp('ref')
  const srcDir = join(root, 'src'), outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${tag}.mjs`), src)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const f = readdirSync(outDir).find((x: string) => x.startsWith(tag + '-'))
  return readFileSync(join(outDir, f!), 'utf-8')
}

describe('refs @this sans `$` → écritures brutes', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('ref SANS `$` (recommandé) → brut, jamais de _mjs_deepSet', () => {
    it('orb.style.width = v → écriture directe (pas de _mjs_deepSet)', async () => {
      const out = await compileComponent(`
<script lang="coffee">
orb = null
paint = => orb.style.width = '7px'
</script>
<div @this=!{orb}></div>
<button @click={paint()}>go</button>
`, 'plain-style')
      assert.equal(out.includes('_mjs_deepSet'), false, 'aucun _mjs_deepSet pour une ref sans $')
      assert.match(out, /orb\.style\.width = ['"]7px['"]/, 'écriture brute conservée')
    })

    it('orb.className = v → brut', async () => {
      const out = await compileComponent(`
<script lang="coffee">
orb = null
paint = => orb.className = 'on'
</script>
<div @this=!{orb}></div>
`, 'plain-class')
      assert.equal(out.includes('_mjs_deepSet'), false)
    })

    it('orb.innerHTML = v → brut', async () => {
      const out = await compileComponent(`
<script lang="coffee">
orb = null
paint = => orb.innerHTML = html
</script>
<div @this=!{orb}></div>
`, 'plain-html')
      assert.equal(out.includes('_mjs_deepSet'), false)
    })

    it('méthode mutative orb.classList.add(x) → pas de _mjs_deepCall', async () => {
      const out = await compileComponent(`
<script lang="coffee">
orb = null
paint = => orb.classList.add('active')
</script>
<div @this=!{orb}></div>
`, 'plain-method')
      assert.equal(out.includes('_mjs_deepCall'), false)
    })
  })

  describe('ref AVEC `$` (anti-pattern) → réactif, donc _mjs_deepSet', () => {
    it('$orb.style.width = v → µ._mjs_deepSet (la ref est réactive)', async () => {
      const out = await compileComponent(`
<script lang="coffee">
$orb = null
paint = => $orb.style.width = '7px'
</script>
<div @this=!{$orb}></div>
`, 'dollar-style')
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["orb", "style", "width"\]/,
        'avec $, la ref est réactive → _mjs_deepSet (coût) : c\'est l\'anti-pattern averti à la compilation')
    })
  })

  describe('régression — l\'état réactif profond reste réactif', () => {
    it('ref brute (sans $) ET état $réactif profond côte à côte', async () => {
      const out = await compileComponent(`
<script lang="coffee">
orb = null
$cfg = { a: 0 }
bump = =>
  orb.style.top = '1px'
  $cfg.a = 5
</script>
<div @this=!{orb}></div>
<i>{$cfg.a}</i>
`, 'mixed')
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["cfg", "a"\], 5\)/, '$cfg.a profond → _mjs_deepSet (réactif)')
      assert.equal(/_mjs_deepSet\(_mjsThis, \["orb"/.test(out), false, 'orb (ref sans $) reste brut')
    })
  })

  describe('applyPathTracking — unité (worker-agnostique)', () => {
    it('chemin $réactif profond $.x.y = 1 → _mjs_deepSet', () => {
      const out = applyPathTracking(`$.x.y = 1;`)
      assert.match(out, /µ\._mjs_deepSet\(_mjsThis, \["x", "y"\], 1\)/)
    })
    it('chemin plain (sans $.) orb.style.x = v → inchangé (jamais de _mjs_deepSet)', () => {
      const out = applyPathTracking(`orb.style.color = c;`)
      assert.equal(out.includes('_mjs_deepSet'), false)
      assert.match(out, /orb\.style\.color = c/)
    })
  })
})
