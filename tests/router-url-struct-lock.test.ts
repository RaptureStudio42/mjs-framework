// Verrou de non-régression : `µurl` en bloc structurel.
//
// POURQUOI ce test existe : `µurl` n'entre JAMAIS dans
// `_mjs_renderStructVars` (le câblage compile-time — cf. src/transpiler/template.ts,
// `_mjsThis._mjs_renderStructVars = [[STRUCT_VARS]]` — ne connaît QUE les variables `$` du
// store, jamais `µurl`, vérifiable par inspection du JS émis). Et POURTANT un
// `{if µurl.path is '/a'}` se re-rend correctement à la navigation : `µ.url` reste un
// objet réactif `µ.state({})` À PART (mjs_router.ts ~96, PAS statisé comme `$$`) — toute
// lecture d'un de ses champs PENDANT un rendu enregistre une dépendance UNIVERSELLE (le
// filet de sécurité du Proxy), et l'écriture PAR CHAMP dans `_mjs_updateUrlStore`
// (mjs_router.ts ~131-134) déclenche `_mjs_invalidate('_awaits_')` → rendu complet
// (mjs_element.ts ~1908). Un canal TOTALEMENT INDÉPENDANT de `_mjs_renderStructVars`.
//
// Ce test FIGE ce comportement : un futur refactor « zéro-Proxy » qui statiserait
// `µ.url` SANS canal d'abonnement dédié CASSERAIT les 3 cas ci-dessous EN SILENCE
// (plus aucun re-rendu à la navigation) — c'est le signal que ce verrou existe pour
// donner.
//
// Harnais calqué sur tests/runtime-e2e.test.ts (seul test qui compile un VRAI composant
// via Bundler puis le monte dans une fenêtre happy-dom réelle, `runtime` par défaut
// 'all' → mjs_router.ts est inclus dans mjs_core-*.js sans configuration particulière,
// cf. resolveRuntimeFiles) : compile en tmpdir, strip ESM (happy-dom n'a pas de loader
// module), eval dans le contexte window, montage par innerHTML, updates via window.eval.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

// Strip ESM syntax pour eval — happy-dom n'a pas de loader module (copié tel quel de
// runtime-e2e.test.ts, même contrainte).
const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('routeur — µurl en bloc structurel : verrou de non-régression', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it("{if µurl.path is '/a'} (direct), {if @same(µurl.path)} (via méthode) et <p>{µurl.path}</p> (texte témoin) suivent tous la navigation", async function () {
    this.timeout(30000)

    const root = mjsTmp('url-struct-lock')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })

    writeFileSync(join(srcDir, 'url-struct.mjs'), `
<script lang="coffee">
@same = (p) ->
  p is '/a'
</script>
{if µurl.path is '/a'}
<b class="ok">A</b>
{end}
{if @same(µurl.path)}
<b class="ok2">A2</b>
{end}
<p class="path">{µurl.path}</p>
`)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, `${stats.errors.map(e => e.message).join('\n')}`)

    const window = new Window({ url: 'http://localhost/' })
    const document: any = window.document

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^url-struct-/.test(f))
    assert.ok(coreFile && compFile, 'core et url-struct doivent être compilés')

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

    try {
      window.eval(`
        ${coreCode}
        globalThis.µ = µ;
        ${compCode}
      `)
    } catch (e: any) {
      throw new Error(`Eval bundle dans happy-dom : ${e.message}`)
    }

    const tag = 'mjs-url-struct'
    assert.ok(window.customElements.get(tag), `${tag} doit être enregistré`)

    document.body.innerHTML = `<${tag}></${tag}>`
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 50))

    // état initial ('/', boot snapshot de µ.url — cf. mjs_router.ts fin de fichier) :
    // les 2 blocs absents, le témoin affiche '/'.
    assertAbsent(el._shadow?.querySelector('.ok'), "départ à '/' : bloc direct absent")
    assertAbsent(el._shadow?.querySelector('.ok2'), "départ à '/' : bloc via méthode absent")
    assert.match(el._shadow?.querySelector('.path')?.textContent ?? '', /^\/$/, "témoin texte affiche '/'")

    // navigation vers /a (µ.Router.to, API publique) : les 2 blocs apparaissent, le
    // témoin suit — LA preuve que la dépendance universelle du Proxy µ.state suffit,
    // sans que µurl figure dans _mjs_renderStructVars.
    window.eval(`µ.Router.to('/a');`)
    await new Promise(r => setTimeout(r, 50))
    assert.ok(el._shadow?.querySelector('.ok'), "1. {if µurl.path is '/a'} apparaît après navigation vers /a")
    assert.ok(el._shadow?.querySelector('.ok2'), '2. {if @same(µurl.path)} (via méthode) apparaît aussi')
    assert.match(el._shadow?.querySelector('.path')?.textContent ?? '', /^\/a$/, "3. témoin texte suit vers '/a'")

    // navigation vers /b : les 2 blocs disparaissent de nouveau, le témoin suit.
    window.eval(`µ.Router.to('/b');`)
    await new Promise(r => setTimeout(r, 50))
    assertAbsent(el._shadow?.querySelector('.ok'), '1. disparaît en repassant à /b')
    assertAbsent(el._shadow?.querySelector('.ok2'), '2. disparaît aussi (via méthode)')
    assert.match(el._shadow?.querySelector('.path')?.textContent ?? '', /^\/b$/, "3. témoin texte suit vers '/b'")

    window.close?.()
  })
})
