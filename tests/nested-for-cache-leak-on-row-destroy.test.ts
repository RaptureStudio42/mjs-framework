// Régression — fuite mémoire non bornée
// des caches de `{for}` imbriqués.
//
// `_mjs_reconcileList` pose `_mjs_list_cache[cacheId]` / `_mjs_list_order[cacheId]` /
// `_mjs_list_anchor[cacheId]` (mjs_element.ts ~2523) pour CHAQUE `{for}` imbriqué
// rencontré, où `cacheId` embarque la clé/l'id de la ROW EXTÉRIEURE qui le
// contient (compile.ts `uniqueCacheId`). Quand cette row est supprimée de la
// liste extérieure, rien ne purgeait ces 3 tables : chaque row qui a un jour
// existé (avec un `{for}` imbriqué dedans) laissait une entrée À VIE sur
// `this`, même après suppression complète de la liste extérieure — fuite
// mémoire non bornée sur la durée de vie du composant (chat qui scrolle,
// todo-list avec suppressions répétées, etc.).
//
// Fix : `_mjs_destroyNodeAndChildren` (mjs_element.ts) — seul point de passage
// commun à TOUS les chemins de destruction réelle d'une row, y compris les 2
// fast-paths qui ne parcourent aucun descendant — appelle désormais
// `_mjs_mjsPurgeNestedListCaches(node)` qui purge toute entrée dont l'ancre est
// contenue dans le sous-arbre qui disparaît (`node.contains(anchor)`, gère
// n'importe quelle profondeur d'imbrication en une seule passe).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// `{for i, row in $rows by id}` (row EXTÉRIEURE keyée) contenant
// `{for k in row.kids}` (liste INTÉRIEURE) — exactement le motif qui déclenche
// le calcul de `uniqueCacheId` (compile.ts) suffixé par la clé de la row.
const COMPONENT = `
<script lang="coffee">
$rows = [
  { id: 1, kids: ['a', 'b'] }
  { id: 2, kids: ['c', 'd'] }
  { id: 3, kids: ['e', 'f'] }
]
removeRow = (idx) -> $rows.splice(idx, 1)
</script>
<div>
  {for i, row in $rows by id}
    <section>
      <button @click={removeRow(i)}>del</button>
      {for k in row.kids}<li>{k}</li>{end}
    </section>
  {end}
</div>
`

describe('runtime — {for} imbriqué : purge des caches à la destruction d\'une row (fuite mémoire)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('supprimer une row purge SES entrées _mjs_list_cache/_mjs_list_order/_mjs_list_anchor (pas de fuite)', async function () {
    const root = mjsTmp('leak')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'leaky.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^leaky-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    document.body.innerHTML = '<mjs-leaky></mjs-leaky>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b', 'c', 'd', 'e', 'f'],
      '3 rows × 2 kids au départ',
    )

    // Le {for} imbriqué a dû créer une entrée de cache par row.
    assert.ok(el._mjs_list_anchor, '_mjs_list_anchor doit exister (au moins 1 {for} imbriqué a tourné)')
    const anchorKeysBefore = Object.keys(el._mjs_list_anchor)
    assert.ok(
      anchorKeysBefore.length >= 3,
      `au moins 3 cacheId imbriqués (un par row) attendus, trouvé ${anchorKeysBefore.length}: ${anchorKeysBefore.join(',')}`,
    )

    // Supprime la row du milieu (id=2, index 1).
    el._shadow.querySelectorAll('section button')[1]
      .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b', 'e', 'f'],
      'row du milieu supprimée → ses <li> disparaissent, les 2 autres rows restent intactes',
    )

    // AVANT le fix : les 3 entrées originales restaient TOUTES dans
    // _mjs_list_anchor/_mjs_list_cache/_mjs_list_order (aucune purge) → la table ne
    // rétrécit JAMAIS, même après suppression complète de la row et de son
    // {for} imbriqué. Après fix : l'entrée de la row supprimée disparaît.
    const anchorKeysAfter = Object.keys(el._mjs_list_anchor)
    assert.equal(
      anchorKeysAfter.length,
      anchorKeysBefore.length - 1,
      `AVANT le fix : les ${anchorKeysBefore.length} entrées restaient toutes présentes après suppression d'une row (fuite non bornée) ; ` +
      `après fix : ${anchorKeysBefore.length - 1} attendues, trouvé ${anchorKeysAfter.length}`,
    )
    // _mjs_list_cache/_mjs_list_order doivent suivre EXACTEMENT la même purge (mêmes
    // clés, posées/purgées ensemble par le même code).
    assert.equal(Object.keys(el._mjs_list_cache).length, anchorKeysAfter.length, '_mjs_list_cache purgé en même temps que _mjs_list_anchor')
    assert.equal(Object.keys(el._mjs_list_order).length, anchorKeysAfter.length, '_mjs_list_order purgé en même temps que _mjs_list_anchor')

    win.close?.()
  })
})
