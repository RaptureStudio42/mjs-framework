// Cœur d'un projet qui n'utilise AUCUNE des briques jointes à l'usage : frontière `<@failed>`
// (repli, propagation, limite de réessai), interpolation brute `{{…}}` (`_mjs_updHtml`), slots
// indexés (`_mjs_injectSlots`), attente des feuilles différées (`css: 'lazy'`) et gel i18n à la
// connexion. Le cœur MINIFIÉ ne doit plus en porter le code — chaque brique est cherchée par un
// littéral qui survit à la minification (chaîne, nom de méthode que le minifieur ne renomme
// pas) — et l'appli construite doit se monter sans la moindre erreur.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const FILES: Record<string, string> = {
  'panneau.mjs': [
    '<script>',
    '$items = [\'a\', \'b\']',
    '$open = true',
    '</script>',
    '<h1 class="titre">Panneau</h1>',
    '{if $open}<ul>{for it in $items}<li><@ligne label={it}></li>{end}</ul>{end}'
  ].join('\n'),
  'ligne.mjs': ['<script>', '$label = \'\'', '</script>', '<span class="l">{$label}</span>'].join('\n')
}

// sortie minifiée rejouée en script classique : l'export final du cœur devient `globalThis.µ`,
// l'import de chaque composant une lecture de ce global, et chaque composant vit dans sa propre
// fonction (le minifieur réutilise les mêmes noms courts d'un fichier à l'autre)
function coreAsScript(code: string): string {
  const at    = code.lastIndexOf('export{')
  const names = code.slice(at + 'export{'.length, code.indexOf('}', at)).split(',').map((s) => s.trim().split(/\s+as\s+/))
  const alias = names.find(([, exported]) => exported === 'µ' || exported === '\\u00B5')
  assert.ok(alias, 'le cœur minifié doit exporter µ')
  return code.slice(0, at).replace(/import\.meta\.url/g, "'http://localhost/'") +'\nglobalThis.µ = '+ alias![0] +';'
}

function componentAsScript(code: string): string {
  const body = code
    .replace(/import\s*\{\s*(?:µ|\\u00B5)\s+as\s+([\w$]+)\s*\}\s*from\s*"[^"]*";?/, 'var $1 = globalThis.µ;')
    .replace(/export\s*\{[^}]*\}\s*;?/, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  return '(function(){\n'+ body +'\n})();'
}

describe('cœur minifié d\'un projet sans aucune brique jointe à l\'usage', function () {
  this.timeout(60000)
  let outDir = ''
  let core   = ''

  before(async function () {
    const root   = mjsTmp('lean-core')
    const srcDir = join(root, 'app/modularjs')
    outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    for (const [name, content] of Object.entries(FILES)) writeFileSync(join(srcDir, name), content)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', runtime: [], minify: true }))
    const found = findConfig(root)
    assert.ok(found, 'mjs.config.json doit être trouvé')
    const bundler = new Bundler(resolveBundlerOpts(found!.config, found!.configDir) as any)
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const coreFile = readdirSync(outDir).find((f) => /^mjs_core-[a-f0-9]{8}\.js$/.test(f))
    assert.ok(coreFile, 'mjs_core-*.js doit exister')
    core = readFileSync(join(outDir, coreFile!), 'utf-8')
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('le cœur est bien minifié (sinon les recherches de littéraux ci-dessous ne prouvent rien)', function () {
    assert.equal(core.includes('µ.Element = class Element'), false)
    assert.ok(core.split('\n').length < 20, 'un cœur minifié tient en quelques lignes')
  })

  it('frontière <@failed> absente : ni repli, ni propagation, ni boutons [mjs-reset]', function () {
    assert.equal(core.includes('[mjs-reset]'), false)
  })

  it('interpolation brute {{…}} absente : aucune méthode _mjs_updHtml', function () {
    assert.equal(core.includes('_mjs_updHtml'), false)
  })

  it('slots indexés absents : ni _mjs_injectSlots, ni recherche du slot par défaut', function () {
    assert.equal(core.includes('_mjs_injectSlots'), false)
    assert.equal(core.includes('slot:not([name])'), false)
  })

  // seul l'appel gardé `µ._mjs_lazyCssWait && µ._mjs_lazyCssWait(…)` reste dans _mjs_applyLayout
  it("attente des feuilles différées absente (css par défaut) : aucun appel à _mjs_fetchLazyCss", function () {
    assert.equal(core.includes('_mjs_fetchLazyCss'), false)
  })

  // seul l'appel gardé `µ.i18n._mjs_connect(this)` reste dans connectedCallback
  it('gel i18n à la connexion absent (aucun i18n configuré) : aucun appel à µ.i18n._mjs_i18nMount', function () {
    assert.equal(core.includes('._mjs_i18nMount('), false)
  })

  it("l'appli construite se monte sans erreur", async function () {
    const win: any = new Window({ url: 'http://localhost/' })
    const out      = readdirSync(outDir)
    const scripts  = [coreAsScript(core), 'window.__errors = []; µ.error = function() { window.__errors.push(Array.prototype.slice.call(arguments).join(\' \')); };']
    for (const name of Object.keys(FILES)) {
      const file = out.find((f) => new RegExp('^'+ name.replace('.mjs', '') +'-[a-f0-9]{8}\\.js$').test(f))
      assert.ok(file, `composant ${name} introuvable dans : ${out.join(', ')}`)
      scripts.push(componentAsScript(readFileSync(join(outDir, file!), 'utf-8')))
    }
    win.eval(scripts.join('\n'))
    win.document.body.innerHTML = '<mjs-panneau></mjs-panneau>'
    await new Promise((r) => setTimeout(r, 160))
    const el: any = win.document.body.firstElementChild
    assert.equal(el.classList.contains('mjs-error'), false, 'le panneau ne doit pas planter')
    assert.equal(el._shadow.querySelector('.titre')?.textContent, 'Panneau')
    const labels = Array.from(el._shadow.querySelectorAll('mjs-ligne')).map((l: any) => l._shadow.querySelector('.l')?.textContent)
    assert.deepEqual(labels, ['a', 'b'], 'le {for} rend une ligne par élément, chacune reçoit sa prop')
    assert.equal(el._shadow.querySelectorAll('.mjs-fatal-error').length, 0)
    // tableau né dans le royaume de la fenêtre : comparé par sa longueur, jamais par deepEqual
    assert.equal(win.__errors.length, 0, `aucune erreur attendue : ${JSON.stringify(win.__errors)}`)
    win.close?.()
  })
})
