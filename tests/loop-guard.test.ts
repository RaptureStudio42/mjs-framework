// Garde anti-boucle réactive.
//
// Une boucle d'effets (un µeffect qui mute sa propre dépendance) produit une
// chaîne infinie de microtasks : sans garde, l'onglet gèle définitivement.
// La garde compte les flushs par rafale de microtasks (reset par macrotask) ;
// au-delà de 10 000 elle émet UN µ.warn explicite et abandonne le flush, ce
// qui brise la chaîne et garde la page vivante.
//
// Deux contrats :
//   1. boucle infinie → le test FINIT (pas de gel), µ.warn émis, l'app répond.
//   2. cascade légitime profonde (chaîne de 2 000 mutations) → AUCUN warn.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('garde anti-boucle réactive', function () {
  this.timeout(60000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  // NB : le hook µ.warn est posé AVANT le mount du composant (la boucle démarre
  // au mount, le warn partirait sinon avant la pose du hook).
  async function compileAndMount(name: string, source: string) {
    const root = mjsTmp(`loopguard-${name}`)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), source)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
    assert.ok(coreFile && compFile, 'core et composant compilés')
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\nglobalThis.__warns = [];\nconst __ow = µ.warn; µ.warn = (...a) => { globalThis.__warns.push(a.join(' ')); };\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
    return { window, document, el: document.body.firstElementChild }
  }

  it('boucle infinie (µeffect auto-mutant) : warn + page vivante, pas de gel', async () => {
    // `$x = Math.random()` : l'effet a $x en dep statique (analyse lexicale) et
    // le mute à CHAQUE exécution → flush → re-fire → flush… chaîne infinie de
    // microtasks. Sans la garde, le setTimeout ci-dessous ne reviendrait JAMAIS
    // (gel) et mocha timeouterait à 60 s. (NB : `$x = $x + 1` simple est déjà
    // neutralisé par la mécanique _mjs_inEffect/_mjs_lastMutedVars — vérifié.)
    const { window } = await compileAndMount('loopinf', `
<script lang="coffee">
$x = 0
µeffect ->
  $x = Math.random()
</script>
<p>{$x}</p>
`)
    await new Promise(r => setTimeout(r, 400))
    const collected = (window as any).eval('globalThis.__warns || []')
    const hasLoopWarn = Array.from(collected).some((w: any) => /Boucle réactive/i.test(String(w)))
    assert.ok(hasLoopWarn, `µ.warn « Boucle réactive » attendu, reçu : ${JSON.stringify(collected).slice(0, 200)}`)
    // La page a repris la main (on est ICI, après le setTimeout) — et l'état
    // est toujours manipulable sans crash.
    ;(window as any).eval(`
      const c = document.body.firstElementChild;
      c._state.x = 123456; c._mjs_invalidate('x');
    `)
    await new Promise(r => setTimeout(r, 50))
    assert.ok(true, 'le test a repris la main après la rafale')
    window.close?.()
  })

  it('cascade légitime profonde (chaîne de 2 000 mutations) : AUCUN warn', async () => {
    const { window } = await compileAndMount('loopok', `
<script lang="coffee">
$n = 0
</script>
<p>{$n}</p>
`)
    ;(window as any).eval(`
      const __origWarn = µ.warn;
      µ.warn = (...a) => { (globalThis.__warns ??= []).push(a.join(' ')); };
      const c = document.body.firstElementChild;
      // Chaîne profonde de microtasks SANS boucle : chaque flush replanifie le
      // suivant via une mutation — 2 000 maillons puis ARRÊT naturel.
      let i = 0;
      const step = () => {
        if (i++ >= 2000) return;
        c._state.n = i; c._mjs_invalidate('n');
        queueMicrotask(step);
      };
      step();
    `)
    await new Promise(r => setTimeout(r, 400))
    const collected = (window as any).eval('globalThis.__warns || []')
    const hasLoopWarn = Array.from(collected).some((w: any) => /Boucle réactive/i.test(String(w)))
    assert.equal(hasLoopWarn, false, `aucun warn attendu sur une cascade légitime, reçu : ${JSON.stringify(collected).slice(0, 200)}`)
    const txt = (window as any).eval('document.body.firstElementChild._shadow ? document.body.firstElementChild._shadow.textContent : document.body.textContent')
    assert.match(String(txt), /2000/, 'la cascade doit avoir abouti à n=2000')
    window.close?.()
  })
})
