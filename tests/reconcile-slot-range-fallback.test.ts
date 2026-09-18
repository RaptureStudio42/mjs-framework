// `Range.deleteContents()` est un NO-OP silencieux sous Gecko
// (FF151) quand les nœuds du Range sont des enfants light-DOM assignés à un
// `<slot>` ({for} slotté) — Chromium supprime bien. Le fast-path « bulk clear »
// de `_mjs_reconcileList` s'appuyait dessus sans vérifier le résultat : sous
// Firefox, un {for} qui passe à 0 items gardait ses anciennes rows à l'écran
// (repro réel : leçon tuto passing-snippets, filtre « bb » → 7 lignes fantômes).
//
// Ce harnais (happy-dom) se comporte comme Chromium (deleteContents() fonctionne
// réellement) : on ne peut donc pas reproduire le bug Gecko tel quel. On SIMULE
// le no-op en remplaçant `µ._mjs_reusableRange` par un faux Range dont
// `deleteContents()` ne fait rien — exactement le symptôme observé sous Firefox —
// et on vérifie que le repli manuel (post-condition ajoutée par le fix) nettoie
// quand même le DOM. Même motif de montage que for-null-collection-clears.test.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// `<li class="head">` AVANT le {for} : les ancres n'occupent alors PAS tout le
// conteneur (startNode.previousSibling !== null) → `_mjs_reconcileList` prend le
// chemin Range (celui du fix), pas le fast-path `textContent = ''` (réservé au
// {for} qui occupe TOUT son conteneur).
const COMPONENT = `
<script lang="coffee">
$items = ['a', 'b', 'c']
</script>
<ul>
  <li class="head">titre</li>
  {for it in $items}<li>{it}</li>{end}
</ul>
`

async function mountLister() {
  const root = mjsTmp('reconcile-range')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'lister.mjs'), COMPONENT)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => /^lister-/.test(f))
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

  document.body.innerHTML = '<mjs-lister></mjs-lister>'
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))

  const µ: any = win.µ
  // Rows dynamiques SEULEMENT (exclut le <li class="head"> statique, toujours présent).
  const read = () => [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent).filter((t: string) => t !== 'titre')
  assert.deepEqual(read(), ['a', 'b', 'c'], 'état initial')

  return { win, el, µ, read }
}

describe('runtime — _mjs_reconcileList bulk clear : repli si Range.deleteContents() est un no-op (Gecko slot)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('deleteContents() no-op simulé (Gecko FF151) : le repli manuel retire quand même toutes les rows', async function () {
    const { win, el, µ, read } = await mountLister()

    // Simule le no-op Gecko : deleteContents() ne fait STRICTEMENT rien, comme
    // observé pour des nœuds light-DOM assignés à un <slot>.
    µ._mjs_reusableRange = { setStartAfter() {}, setEndBefore() {}, deleteContents() {} }

    el._set('items', [])
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(read(), [], 'no-op Range simulé → le repli manuel doit quand même vider le {for} (AVANT le fix : 3 rows fantômes)')

    µ._mjs_reusableRange = null // propre : pas de fuite du faux Range vers un autre test
    win.close?.()
  })

  it('chemin nominal (sans faux Range) : le vidage fonctionne aussi', async function () {
    const { win, el, read } = await mountLister()

    el._set('items', [])
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(read(), [], 'Range natif (happy-dom, comportement Chromium) : vidage OK sans repli nécessaire')

    win.close?.()
  })
})
