// une rune du sucre universel µfoo → µ.foo (mjs_rare_runes.ts : µraw, µsnap, µplay,
// µminmax, µinspect) écrite dans une EXPRESSION du HTML — interpolation de texte
// `{...}` ou valeur d'attribut simple `prop={...}` — n'était PAS réécrite en
// `µ.raw(...)`/`µ.snap(...)`/... : elle ressortait LITTÉRALE dans le JS final, et
// `µraw`/`µsnap`/... n'existent nulle part au runtime hors `µ.raw`/`µ.snap` →
// ReferenceError au premier rendu. Repro exacte : `weatherData={µraw(result)}` dans
// une branche `{success result}` d'un `{await}`.
//
// Le `<script>` ET les HANDLERS d'événement (`@click={...}`) échappaient déjà au bug :
// les deux passent par le moteur SCRIPT (`applyMjsSugarToScript`, transpiler/index.ts)
// dont le sucre `MU_UNIVERSAL_RE` pointe N'IMPORTE QUEL `µfoo` non réservé au lexer
// (`MU_SCRIPT_RUNES`) — SANS liste blanche. `cleanJs`/`cleanJsExpr` (generator/utils.ts,
// moteur des interpolations texte et des valeurs d'attribut SIMPLES) n'avaient qu'une
// liste blanche stricte (MU_SHORT_BODY : url/online/visible/.../t/...) et le PascalCase
// (MU_PASCAL_BODY) — aucun filet générique pour les runes minuscules hors liste.
//
// `µt`/`µlang`/`µtheme`/`µurl` (MU_SHORT_GLOBALS) fonctionnaient déjà dans une expression
// HTML — non-régression vérifiée plus bas. `µasset`/`µimage` : leur RÉSOLUTION est un
// mécanisme séparé (bundler, preResolveAssets/resolveMagicAssets) — mais le SCRIPT les
// pointait déjà (`µ.asset(`/`µ.image(`, ni l'un ni l'autre dans MU_SCRIPT_RUNES) alors
// que cleanJs les laissait littéraux : même trou que µraw/µsnap, fermé par le même
// sucre universel. Sans danger pour la résolution : ASSET_RE/ASSET_CALL_RE/
// IMAGE_CALL_RE (bundler/index.ts) acceptent déjà LES DEUX formes (`µasset(`/`µ.asset(`,
// `µimage(`/`µ.image(`) — vérifié empiriquement et prouvé ci-dessous par une résolution
// bout-en-bout au VRAI Bundler.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { cleanJs, cleanJsExpr } from '../src/generator/utils.js'
import { transpile } from '../src/transpiler/index.js'
import { scanCompiledFeatures } from '../src/bundler/features.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un ou plusieurs .mjs (bundler complet) et monte `<rootTag>` dans une fenêtre
// happy-dom fraîche — calque de tests/attributes-await-booleens-props.test.ts (mountFiles)
async function mountFiles(files: Record<string, string>, rootTag: string): Promise<{ window: any; document: any; el: any; erreurs: string[] }> {
  const root   = mjsTmp('runes-html')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, src] of Object.entries(files)) writeFileSync(join(srcDir, name), src)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))!
  const jsFiles  = outFiles.filter((f: string) => f.endsWith('.js') && f !== coreFile && f !== 'bundle.js')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))
  const compCode = jsFiles.map((f: string) => stripEsm(readFileSync(join(outDir, f), 'utf-8'))).join('\n')
  const erreurs: string[] = []
  window.addEventListener('error', (e: any) => erreurs.push('error: ' + String(e.message ?? e)))
  window.addEventListener('unhandledrejection', (e: any) => erreurs.push('unhandledrejection: ' + String(e.reason?.message ?? e.reason ?? e)))
  window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.insertAdjacentHTML('beforeend', `<${rootTag}></${rootTag}>`)
  const el = document.body.querySelector(rootTag)
  await new Promise((r) => setTimeout(r, 150))
  return { window, document, el, erreurs }
}

// runes affectées, une paire [nom, appel] par ligne — la forme parenthésée, celle du
// bug rapporté, `$x` comme argument (les 5 runes de mjs_rare_runes.ts en acceptent une)
const RUNES_MANQUANTES: Array<[nom: string, appel: string, prefixe: string]> = [
  ['µraw',     'µraw($x)',                'µ.raw('],
  ['µsnap',    'µsnap($x)',               'µ.snap('],
  ['µplay',    "µplay(@_shadow, 'anim')", 'µ.play('],
  ['µminmax',  'µminmax($x, 0, 10)',      'µ.minmax('],
  ['µinspect', 'µinspect($x)',            'µ.inspect('],
]

describe('sucre universel µfoo → µ.foo dans les expressions HTML (cleanJs/cleanJsExpr)', () => {
  for (const [nom, appel, prefixe] of RUNES_MANQUANTES) {
    it(`cleanJs (attribut/handler) : ${appel} → ${prefixe}..., jamais ${nom}( littéral`, () => {
      const out = cleanJs(appel)
      assert.equal(out.includes(prefixe), true, `attendu "${prefixe}" dans la sortie : ${out}`)
      assert.equal(out.includes(nom + '('), false, `forme littérale "${nom}(" ne doit plus survivre : ${out}`)
    })

    it(`cleanJsExpr (interpolation texte) : ${appel} → ${prefixe}..., jamais ${nom}( littéral`, () => {
      const out = cleanJsExpr(appel)
      assert.equal(out.includes(prefixe), true, `attendu "${prefixe}" dans la sortie : ${out}`)
      assert.equal(out.includes(nom + '('), false, `forme littérale "${nom}(" ne doit plus survivre : ${out}`)
    })
  }

  // µinspect/µminmax portent, en plus du préfixe, un remodelage d'arguments (comme le
  // script, transpiler/index.ts) : la clé d'état passe en CHAÎNE, jamais la valeur
  // courante — sans ce remodelage, l'appel pointé serait quand même DIFFORME au runtime.
  it("µinspect($x) → µ.inspect('x') (clé en chaîne, pas la valeur courante — cleanJs)", () => {
    assert.equal(cleanJs('µinspect($x)'), "µ.inspect('x')")
  })

  it("µminmax($x, 0, 10) → µ.minmax(_mjsThis, 'x', 0, 10) (instance + clé — cleanJs)", () => {
    assert.equal(cleanJs('µminmax($x, 0, 10)'), "µ.minmax(_mjsThis, 'x', 0, 10)")
  })

  it("µinspect($x) : la clé 'x' apparaît bien dans la version interpolation (cleanJsExpr)", () => {
    assert.match(cleanJsExpr('µinspect($x)'), /µ\.inspect\(\s*['"]x['"]\s*\)/)
  })

  it("µminmax($x, 0, 10) : instance _mjsThis + clé 'x' dans la version interpolation (cleanJsExpr)", () => {
    assert.match(cleanJsExpr('µminmax($x, 0, 10)'), /µ\.minmax\(\s*_mjsThis,\s*['"]x['"]/)
  })
})

describe('non-régression — sucre déjà fonctionnel ou hors périmètre, inchangé', () => {
  it("µt('titre') → µ.t('titre') (déjà OK, MU_SHORT_GLOBALS)", () => {
    assert.equal(cleanJs("µt('titre')"), "µ.t('titre')")
    assert.equal(cleanJsExpr("µt('titre')"), "µ.t('titre')")
  })

  it('µlang → µ.store.__mjsLang, µtheme → µ.store.__mjsTheme (déjà OK)', () => {
    assert.equal(cleanJs('µlang'), 'µ.store.__mjsLang')
    assert.equal(cleanJs('µtheme'), 'µ.store.__mjsTheme')
  })

  it('µurl.params.id → µ.url.params.id (déjà OK, MU_SHORT_GLOBALS)', () => {
    assert.equal(cleanJs('µurl.params.id'), 'µ.url.params.id')
  })

  it("µasset('x.png')/µimage('x.png') → µ.asset(/µ.image( — ALIGNÉ sur le script (déjà pointés là-bas)", () => {
    assert.equal(cleanJs("µasset('x.png')"), "µ.asset('x.png')")
    assert.equal(cleanJs("µimage('x.png')"), "µ.image('x.png')")
  })

  it('$x → $.x, §x → this._mjs_getContext(\'x\'), &id → µ.url.params.id — intacts', () => {
    assert.equal(cleanJs('$x'), '$.x')
    assert.equal(cleanJs('§x'), "this._mjs_getContext('x')")
    assert.equal(cleanJs('&id'), 'µ.url.params.id')
  })

  it('µ.raw($x) déjà pointé — idempotent, un seul point', () => {
    assert.equal(cleanJs('µ.raw($x)'), 'µ.raw($.x)')
  })
})

describe('transpile() — expression HTML NON-handler, sortie compilée', () => {
  const cas: Array<[label: string, src: string, prefixe: string, litteral: string]> = [
    ['attribut de prop enfant', '<script>\n$result = {}\n</script>\n<@child weatherData={µraw($result)}>', 'µ.raw(', 'µraw('],
    ['interpolation de texte', '<script>\n$x = 1\n</script>\n<p>{µsnap($x)}</p>', 'µ.snap(', 'µsnap('],
    ['interpolation de texte minmax', '<script>\n$x = 1\n</script>\n<p>{µminmax($x, 0, 10)}</p>', 'µ.minmax(', 'µminmax('],
    ['interpolation de texte inspect', '<script>\n$x = 1\n</script>\n<p>{µinspect($x)}</p>', 'µ.inspect(', 'µinspect('],
  ]
  for (const [label, src, prefixe, litteral] of cas) {
    it(`${label} : sortie contient ${prefixe}, jamais ${litteral}`, async () => {
      const { output } = await transpile(src, { moduleName: 'rune_html_' + prefixe.replace(/[^a-z]/gi, '') })
      assert.equal(output.includes(prefixe), true, output)
      assert.equal(output.includes(litteral), false, output)
    })
  }

  it('détection du cœur (scanCompiledFeatures) : µraw SEUL dans une expression HTML → rare_runes présent', async () => {
    const src = '<script>\n$x = 1\n</script>\n<p>{µraw($x)}</p>'
    const { output, data } = await transpile(src, { moduleName: 'rune_html_scan' })
    const used = scanCompiledFeatures(output, data)
    assert.equal(used.has('rare_runes'), true, output)
  })
})

describe('µasset/µimage dans une expression HTML — pointés (µ.asset/µ.image) SANS casser la résolution', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  it("µasset('logo.svg') en interpolation de texte : résout un VRAI chemin, aucune forme µasset(/µ.asset( ne survit", async () => {
    const root   = mjsTmp('runes-html-asset')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'logo.svg'), '<svg></svg>')
    writeFileSync(join(srcDir, 'hop.mjs'), '<p>{µasset(\'logo.svg\')}</p>')
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const compFile = files.find((f) => /^hop-/.test(f))
    assert.ok(compFile, 'hop-*.js doit exister')
    const code = readFileSync(join(outDir, compFile!), 'utf-8')
    assert.match(code, /logo-[a-f0-9]{8}\.svg/, code)
    assert.equal(code.includes('µasset('), false, code)
    assert.equal(code.includes('µ.asset('), false, code)
  })
})

describe('montage happy-dom — µraw dans {success result}, transmis en prop à un enfant', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  const PARENT = [
    '<script>',
    '  $p = Promise.resolve({ temp: 20 })',
    '</script>',
    '{await $p}{success result}',
    '<@child weatherData={µraw(result)}>',
    '{end}',
  ].join('\n')

  const CHILD = [
    '<script>',
    '  $weatherData = null',
    '</script>',
    '<p class="t">{$weatherData ? $weatherData.temp : \'vide\'}</p>',
  ].join('\n')

  it('aucune erreur "is not defined" au rendu, la valeur brute atteint le composant enfant', async () => {
    const { el, erreurs } = await mountFiles({ 'parent.mjs': PARENT, 'child.mjs': CHILD }, 'mjs-parent')
    assert.deepEqual(erreurs, [], 'aucune erreur JS au montage')
    const texte = el._shadow.querySelector('mjs-child')?._shadow?.querySelector('.t')?.textContent
    assert.equal(texte, '20')
  })
})

describe('détection du cœur (VRAI Bundler) — rune SEULE dans une expression HTML', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('µraw($x) uniquement dans {...} (aucun usage script) : mjs_core-*.js embarque mjs_rare_runes.ts', async () => {
    const root   = mjsTmp('runes-html-core')
    const srcDir = join(root, 'app/modularjs')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hop.mjs'), ['<script>', '$x = 1', '</script>', '<p>{µraw($x)}</p>'].join('\n'))
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
      sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js',
    }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f) => /^mjs_core-/.test(f))
    assert.ok(coreFile, 'mjs_core-*.js doit exister')
    const core = readFileSync(join(outDir, coreFile!), 'utf-8')
    assert.equal(core.includes('µ._mjs_import = function'), true, 'mjs_rare_runes.ts doit être dans le cœur produit')
  })
})
