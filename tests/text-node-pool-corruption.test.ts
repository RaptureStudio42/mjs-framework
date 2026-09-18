// `µ._mjs_recycleTextLeaves` (le SEUL chemin réellement
// emprunté au destroy — cf. mjs_element.ts `_mjs_destroyNodeAndChildren`, fast
// path `_mjs_noDestroyHooks`) poussait les text nodes dans `µ._mjs_textPool`
// SANS poser `_mjs_pooled = true`. Seul `µ._mjs_releaseTextNode` (CODE MORT,
// aucun appelant dans tout src/) posait ce flag. Résultat : la garde
// anti-écriture-périmée de `_mjs_updText`/`_mjs_updHtml` (`if (node._mjs_pooled)
// return`) était TOUJOURS inerte pour les nœuds recyclés par ce chemin —
// un nœud rendu au pool puis réattribué par `µ._mjs_getTextNode` à un AUTRE
// composant pouvait recevoir une écriture visuelle en provenance du
// composant D'ORIGINE.
//
// Fix : `_mjs_recycleTextLeaves` pose désormais `c._mjs_pooled = true` (miroir
// exact de `_mjs_releaseTextNode`), rétablissant l'invariant que `µ._mjs_getTextNode`
// (qui pose `_mjs_pooled = false` à la ré-attribution) attend déjà.
//
// NB — durcissement complémentaire NON fait ici (documenté, pas oublié) :
// `this._mjs_nodes[id]` du composant d'origine n'est jamais explicitement purgé
// à la fermeture d'un bloc {if}/{for} (seulement écrasé à la RÉOUVERTURE) —
// fenêtre résiduelle étroite si un effect mute PENDANT qu'un nœud recyclé
// est déjà réutilisé ailleurs.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

async function bundleAndLoad(name: string, source: string) {
  const root = mjsTmp(`txp-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  // `runtime: ['textpool']` : la fixture ({if}/<p>{$msg}</p>) n'émet jamais `._mjs_getTextNode(`
  // littéralement (réservé au mode IMPÉRATIF du générateur, cf. generator/paths.ts) — sans lui le
  // scan ne détecte jamais 'textpool' (mjs_textpool.ts détaché de mjs_init.ts, joint à l'usage) et
  // `_mjs_recycleTextLeaves`/`_mjs_textPool` restent absents (appel gardé, silencieusement inerte côté
  // mjs_element.ts), ce que ce test veut précisément vérifier actif.
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['textpool'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile)

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  return { window, document }
}

describe('pool de text nodes — flag _mjs_pooled effectivement posé au recyclage', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('µ._mjs_recycleTextLeaves pose bien _mjs_pooled = true (garde anti-corruption active)', async () => {
    const src = ['<script>$show = true\n$msg = "hello"</script>', '{if $show}<p>{$msg}</p>{end}'].join('\n')
    const { window, document } = await bundleAndLoad('txpflag', src)
    document.body.innerHTML = '<mjs-txpflag></mjs-txpflag>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    // Récupère le text node AVANT fermeture du bloc, pour vérifier son flag
    // après recyclage (accès direct à l'implémentation — légitime pour un
    // test de régression ciblant précisément ce mécanisme interne).
    const p = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit exister au mount')
    const textNode = p.firstChild
    assert.ok(textNode, 'le text node doit exister')
    assert.notEqual((textNode as any)._mjs_pooled, true, 'AVANT fermeture : le nœud est actif, pas encore pooled')

    // Ferme le bloc {if} : $show passe à false → le <p> (et son text node)
    // sont détruits via le fast path `_mjs_noDestroyHooks` → `_mjs_recycleTextLeaves`.
    window.eval(`µ._set(document.querySelector('mjs-txpflag'), 'show', false);`)
    await new Promise(r => setTimeout(r, 80))

    assert.equal(
      (textNode as any)._mjs_pooled,
      true,
      'APRÈS recyclage : le flag _mjs_pooled DOIT être posé (avant le fix : jamais posé par ce chemin → garde anti-corruption inerte)'
    )
  })

  it("un nœud recyclé puis réattribué (µ._mjs_getTextNode) a son flag correctement remis à false", async () => {
    const src = ['<script>$show = true</script>', '{if $show}<p>x</p>{end}'].join('\n')
    const { window, document } = await bundleAndLoad('txpreuse', src)
    document.body.innerHTML = '<mjs-txpreuse></mjs-txpreuse>'
    await new Promise(r => setTimeout(r, 80))

    window.eval(`µ._set(document.querySelector('mjs-txpreuse'), 'show', false);`)
    await new Promise(r => setTimeout(r, 80))

    // Le pool contient au moins 1 nœud flaggé pooled=true après ce recyclage.
    const poolState = window.eval(`µ._mjs_textPool.map(n => n._mjs_pooled)`)
    assert.ok(poolState.length > 0, 'le pool doit contenir au moins un nœud recyclé')
    assert.ok(poolState.every((v: boolean) => v === true), 'tous les nœuds du pool doivent être flaggés pooled=true')

    // Réattribution : µ._mjs_getTextNode doit remettre le flag à false.
    const reused = window.eval(`(() => { const n = µ._mjs_getTextNode('reused'); return n._mjs_pooled; })()`)
    assert.equal(reused, false, 'µ._mjs_getTextNode doit remettre _mjs_pooled à false à la réattribution')
  })
})
