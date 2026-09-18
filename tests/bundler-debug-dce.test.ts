// Lectures `µ.debug` mortes en prod — les sources du runtime lisent `µ.debug` ; en prod,
// `bundleRuntime()` remplace chaque LECTURE par l'identifiant libre `MJS_DEBUG` (les écritures
// `µ.debug = …` restent) et passe `define: { MJS_DEBUG: 'false' }` à `minifyJs` (DCE réel —
// identifiant libre, aucune déclaration locale ne le masque, contrairement à `µ.debug` derrière
// le `µ` local de mjs_init.ts) ; hors prod les sources passent telles quelles (minifyJs ne touche
// pas au texte quand il ne minifie pas).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { minifyJs } from '../src/bundler/minify.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

describe('minifyJs() — define MJS_DEBUG (option ciblée)', () => {
  // `f()` APPELÉE (effet de bord `console.log`) : une fonction jamais appelée serait éliminée
  // par le tree-shaking de `transform()` (format ESM) pour SA PROPRE raison (code mort, non
  // référencé) — un faux positif qui masquerait l'effet réel du `define` testé ici.
  const SRC = 'function f() { if (MJS_DEBUG) { console.log("trace"); } return 1; } f();'

  it('avec define: { MJS_DEBUG: "false" } (prod) : identifiant ET branche morte éliminés', async () => {
    const { code } = await minifyJs(SRC, { force: true, define: { MJS_DEBUG: 'false' } })
    assert.equal(code.includes('MJS_DEBUG'), false, 'identifiant éliminé par DCE')
    assert.equal(code.includes('trace'), false, 'branche morte éliminée avec lui')
  })

  it('SABOTAGE — sans define (force:true seul) : MJS_DEBUG et la branche survivent (prouve que l\'option ci-dessus fait le travail)', async () => {
    const { code } = await minifyJs(SRC, { force: true })
    assert.ok(code.includes('MJS_DEBUG'), 'sans le define, MJS_DEBUG est un identifiant libre non résolu — reste tel quel')
  })

  it('hors prod (force:false) : minifyJs ne touche pas au texte, MJS_DEBUG reste (substitution déléguée au bundler, PAS à minifyJs)', async () => {
    const { code } = await minifyJs(SRC, { force: false })
    assert.equal(code, SRC)
  })
})

// `env` n'est PAS une clé de mjs.config.json (l'environnement vient de la COMMANDE, jamais du
// fichier — validateConfig le refuse) : passé ICI directement à l'API Bundler (`envOpt`),
// comme `mjs build --prod`/`mjs build` le feraient en résolvant les drapeaux CLI.
async function buildProject(envOpt: 'prod' | 'dev', files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('debug-dce')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js',
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler({ ...opts, env: envOpt } as any)
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return { outDir }
}

function coreContent(outDir: string): string {
  const files = readdirSync(outDir)
  const coreFile = files.find((f) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coreFile!), 'utf-8')
}

describe('bundleRuntime() — cœur RÉEL, MJS_DEBUG jamais visible, lectures .debug retirées en prod', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("cœur de PROD (--prod) : aucune lecture .debug (hors µ.debugMode, propriété distincte), MJS_DEBUG absent", async () => {
    const { outDir } = await buildProject('prod', { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    // µ.debugMode (mjs_debug.ts) n'entre pas dans ce test : mjs_debug.ts/mjs_devinspect.ts/
    // mjs_devpanel.ts sont des modules d'INSPECTION dev-only, EXCLUS de tout cœur de prod quelle
    // que soit la config (cf. bandeau de bundleRuntime()) — absents d'office, pas par ce correctif.
    assert.equal(/\.debug\b/.test(core), false, 'aucune lecture .debug ne doit survivre en prod')
    assert.equal(core.includes('MJS_DEBUG'), false, 'MJS_DEBUG ne doit jamais apparaître dans un cœur produit')
  })

  it('cœur de DEV (défaut) : lectures µ.debug présentes (bascule console vivante), MJS_DEBUG absent', async () => {
    const { outDir } = await buildProject('dev', { 'hop.mjs': '<p>x</p>\n' })
    const core = coreContent(outDir)
    assert.ok(core.includes('if (µ.debug)'), 'µ.debug doit être lisible en dev — bascule console µ.debug = true reste vivante')
    assert.equal(core.includes('MJS_DEBUG'), false, 'MJS_DEBUG ne doit jamais apparaître dans un cœur produit, même en dev')
  })
})
