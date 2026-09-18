// Régression — le fix anti-fuite
// `_mjs_mjsPurgeNestedListCaches` purgeait les caches de {for} imbriqués en TÊTE de
// `_mjs_destroyNodeAndChildren`, AVANT même que le nœud ne soit seulement marqué
// `_mjs_dying` (outro en cours). Or un nœud dying peut être RESSUSCITÉ
// (`_mjs_tryReviveDying`). Le sous-arbre revivait avec ses <li> toujours dans le
// DOM, mais le cache du {for} imbriqué avait été détruit → le `_mjs_updList`
// suivant repartait d'un cache vide (anchor !== startNode) → fresh-create →
// APPEND des rows À CÔTÉ des anciennes = duplication permanente.
//
// Fix : ne purger qu'aux points de mort DÉFINITIVE de `_mjs_destroyNodeAndChildren`
// (via `_mjs_mjsPurgeSubtreeState`), jamais quand le nœud est seulement dying.
//
// Ce test reproduit le scénario exact : {if $show} contenant
// <section @out.fade> avec un {for} imbriqué. `µ._mjs_playTransition` est stubbée
// en promesse jamais résolue → la section reste `_mjs_dying` pendant toute la
// fenêtre du test ; on toggle OFF puis ON (revive) et on vérifie qu'il n'y a
// PAS de duplication des <li>.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
$show = yes
$kids = ['a', 'b']
toggle = -> $show = not $show
</script>
<div>
  {if $show}
    <section @out.fade>
      {for k in $kids}<li>{k}</li>{end}
    </section>
  {end}
</div>
`

describe('runtime — {for} imbriqué : revive d\'un {if} pendant l\'outro (pas de duplication)', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('re-toggle pendant l\'outro : les <li> du {for} imbriqué ne se dupliquent PAS', async function () {
    const root = mjsTmp('revive-outro')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'reviver.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^reviver-/.test(f))
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

    // `fade` est tree-shaké hors du bundle isolé du test → on stubbe `µ.anim.fade`.
    // Le codegen `@out.fade` lit `out_cfg.outro` pour poser `node._mjs_outro`, il
    // faut donc une clé `.outro` truthy (le contenu importe peu : `_mjs_playTransition`
    // est stubbée juste après).
    win.eval(`µ.anim = µ.anim || {}; µ.anim.fade = function(){ return { outro: { duration: 200, css: function(t){ return 'opacity:'+t } } }; };`)
    // Outro contrôlée : promesse jamais résolue → la section reste _mjs_dying
    // pendant toute la fenêtre du test (fenêtre de revive déterministe).
    win.eval(`µ._mjs_playTransition = function() { return new Promise(function(){}); };`)

    document.body.innerHTML = '<mjs-reviver></mjs-reviver>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b'],
      'état initial : 2 <li>',
    )

    // 1. toggle OFF — la section part en outro (dying, reste dans le DOM car la
    //    transition ne se résout jamais).
    el._set('show', false)
    await new Promise(r => setTimeout(r, 40))
    const sec: any = el._shadow.querySelector('section')
    assert.ok(sec && sec._mjs_dying, 'la section doit être en outro (dying) pendant le stub de transition')

    // 2. toggle ON pendant l'outro — revive attendu du sous-arbre + son {for}.
    el._set('show', true)
    await new Promise(r => setTimeout(r, 60))

    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b'],
      'après revive : PAS de duplication (avant fix : ["a","b","a","b"])',
    )

    // 3. et une mutation ultérieure du {for} imbriqué reste saine (pas de
    //    corruption persistante type ["a","b","a","b","c"]).
    el._set('kids', ['a', 'b', 'c'])
    await new Promise(r => setTimeout(r, 40))
    assert.deepEqual(
      [...el._shadow.querySelectorAll('li')].map((n: any) => n.textContent),
      ['a', 'b', 'c'],
      'push kid après revive : liste cohérente',
    )

    win.close?.()
  })
})
