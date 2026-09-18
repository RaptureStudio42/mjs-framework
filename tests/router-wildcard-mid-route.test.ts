// `*` catch-all AU MILIEU d'une route, forme `@routes` (script) : `validateRoutePath`
// (transpiler/sections.ts:175) refuse ce motif à la compilation pour un bloc `<routes>`, mais
// la table `@routes` calculée en script n'est JAMAIS validée — `_matchSegs` (mjs_router.ts)
// absorbe tout le reste du chemin dès le `*`, quelle que soit sa position : `/a/*/b` matche
// `/a/zzz` (SANS `/b` final), le segment `/b` n'est plus jamais lu, en silence.
//
// Correctif RUNTIME (mjs_router.ts, register) : un motif dont le `*` n'est pas le dernier
// segment est REFUSÉ par une erreur explicite, même voie que le nom de variant de style inconnu
// (mjs_element.ts::_mjs_applyLayout) — `_mjs_catchError` remonte à la boundary `<@failed>` la plus
// proche ou affiche le panneau fatal.
//
// Pipeline RÉEL (Bundler → mjs_core + composants COMPILÉS puis MONTÉS dans happy-dom, patron
// tests/mjs-layout-runtime.test.ts / tests/ujs-shadow-confirm.test.ts) — jamais une copie
// recodée à la main de `_matchSegs`/`register`.

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

// compile `files` (nom → source) dans un dossier temp isolé (`mjsTmp`, purgé par le balai
// global), charge core + composants dans une Window happy-dom FRAÎCHE, monte `<tag>` à `hash`.
async function loadAndMount(prefix: string, files: Record<string, string>, tag: string, hash: string) {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for(const name in files) { writeFileSync(join(srcDir, name), files[name]) }

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, 'compile sans erreur : '+ stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/#'+ hash })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const read = (re: RegExp) => stripEsm(readFileSync(join(outDir, outFiles.find(f => re.test(f))!), 'utf-8'))
  const compBundles = Object.keys(files)
    .filter(name => name.endsWith('.mjs') && !/^shell/.test(name))
    .map(name => read(new RegExp('^'+ name.replace('.mjs', '') +'-')))
  window.eval([read(/^mjs_core-/), 'globalThis.µ = µ;', ...compBundles, read(/^shell-/)].join('\n'))

  document.body.innerHTML = `<${tag}></${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise((r) => setTimeout(r, 100))
  return { window, document, el }
}

describe('mjs_router — `*` catch-all pas en dernière position, forme @routes (script)', function() {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it("@routes = {'/a/*/b': 'mid-page', '/*': 'fallback'} : le composant CRASHE au montage (système d'erreur MJS), nomme le composant et le motif", async () => {
    const files = {
      'shell.page.mjs': [
        '<script>',
        '  @routes =',
        "    'main':",
        "      '/a/*/b': 'mid-page'",
        "      '/*':     'catchall-page'",
        '</script>',
        '<@view main>',
      ].join('\n'),
      'mid-page.mjs': '<p>MID</p>',
      'catchall-page.mjs': '<p>CATCHALL</p>',
    }
    const { el } = await loadAndMount('router-wildcard-bad', files, 'mjs-shell', '/a/foo')
    assert.equal(el._mjs_has_crashed, true, 'le composant doit être passé par _mjs_catchError (route @routes mal formée)')
    assert.ok(el.classList.contains('mjs-error'), 'la classe mjs-error doit être posée')
    const panneau = el._shadow.querySelector('.mjs-fatal-error')
    assert.ok(panneau, 'sans boundary <@failed>, le panneau fatal doit être affiché')
    assert.match(panneau.textContent, /mjs-shell/, 'le tag du composant doit apparaître dans le message')
    assert.match(panneau.textContent, /a\/\*\/b/, 'le motif fautif doit apparaître dans le message')
  })

  it("@routes = {'/a/*': 'tail-page', '/*': 'fallback'} (catch-all bien formé, EN DERNIÈRE position) : continue de marcher, aucun crash", async () => {
    const files = {
      'shell.page.mjs': [
        '<script>',
        '  @routes =',
        "    'main':",
        "      '/a/*':  'tail-page'",
        "      '/*':    'catchall-page'",
        '</script>',
        '<@view main>',
      ].join('\n'),
      'tail-page.mjs': '<p>TAIL</p>',
      'catchall-page.mjs': '<p>CATCHALL</p>',
    }
    const { el } = await loadAndMount('router-wildcard-good', files, 'mjs-shell', '/a/foo/bar')
    assert.equal(el._mjs_has_crashed, undefined, 'un catch-all bien formé ne doit jamais crasher le composant')
    const mounted = el._shadow.querySelector('metamjs-view#main')?.firstElementChild?.tagName
    assert.equal(mounted, 'MJS-TAIL-PAGE', "'/a/*' doit toujours matcher '/a/foo/bar' normalement")
  })
})
