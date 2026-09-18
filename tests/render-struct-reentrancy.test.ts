// Test runtime — garde de réentrance de `_mjs_renderStruct`.
//
// Bug : le chemin batch de `_mjs_invalidate` appelait `_mjs_renderStruct()` sans
// garde. Si une var structurelle mutait PENDANT ce rendu (ex. l'interpolation
// d'un item de `{for}` qui écrit un `$`), le chemin sync re-rentrait
// `_mjs_renderStruct` → la liste se reconstruisait en double (chaque item rendu
// deux fois).
//
// Fix : flag `_mjs_inRenderStruct` — un appel imbriqué est ignoré, le flush
// microtask suivant rejoue proprement.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// Le composant : `{for}` dont l'interpolation d'item appelle `stamp`, qui
// écrit `$tag`. `$tag` pilote un `{if}` → c'est une var structurelle. Sa
// mutation pendant le rendu du `{for}` provoque la réentrance.
const COMPONENT = `
<script lang="coffee">
$items = [1, 2, 3]
$tag = ''
stamp = (x) ->
  $tag = 'seen'
  x
</script>
<ul>
  {for x in $items}<li>{stamp(x)}</li>{end}
</ul>
{if $tag}<p class="flag">{$tag}</p>{end}
`

describe('runtime — garde de réentrance _mjs_renderStruct', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un `{for}` dont l\'item mute une var structurelle ne se rend PAS en double', async function () {
    const root = mjsTmp('reentry')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'reentry.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^reentry-/.test(f))
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

    document.body.innerHTML = '<mjs-reentry></mjs-reentry>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const lis = el._shadow.querySelectorAll('li')
    // 3 items dans `$items` → exactement 3 `<li>`. Sans la garde, la
    // réentrance de `_mjs_renderStruct` en produisait 6.
    assert.equal(lis.length, 3, `le {for} doit rendre 3 <li>, pas ${lis.length} (réentrance)`)
    assert.deepEqual(
      [...lis].map((n: any) => n.textContent.trim()),
      ['1', '2', '3'],
      'contenu des items correct, sans duplication',
    )

    win.close?.()
  })
})
