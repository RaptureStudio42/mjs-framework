// mjs_destroy_hooks.ts — chemin LENT de `_mjs_destroyNodeAndChildren` (orchestration des
// transitions/@attach/@this=!/@flip), DÉTACHÉ du cœur (mjs_element.ts en portait ce code, le
// chemin RAPIDE reste dans mjs_element.ts pour TOUT composant) : DÉTECTÉ PAR SCAN des 5 SEULS
// émetteurs compilateur de `hasDestroyHooks = true`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_DESTROY_HOOKS = 'µ.Element.prototype._mjs_destroyWithHooks = async function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-destroy-hooks')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(files)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', ...cfgExtra,
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
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

describe('mjs_destroy_hooks.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS transition/@attach/@this=!/@flip : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$show = true', '</script>', '{if $show}<p>x</p>{end}'].join('\n'),
    })
    assert.equal(coreContent(outDir).includes(MARK_DESTROY_HOOKS), false)
  })

  // fixture corrigée : `@transition={{…}}` SANS point (`.nom`) n'est PAS la syntaxe
  // MJS de la directive transition (docs/10-transitions.md : toujours `@transition.nom`,
  // `@transition.fly={ y: 200, duration: 2000 }`…) — le générateur la route comme un simple
  // écouteur DOM générique nommé « transition » (`@xxx={…}` quelconque), qui ne pose JAMAIS
  // `hasDestroyHooks`. Avec l'ancien scan TEXTUEL (regex `@transition\b`, sans exiger le
  // point), ce test passait par un FAUX POSITIF texte — révélé en scannant le code
  // COMPILÉ (qui, lui, ne ment jamais). Corrigé avec la forme documentée `@transition.fade`.
  it('@transition.fade (forme nommée SANS paramètres) seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$show = true', '</script>', '{if $show}<p @transition.fade>x</p>{end}'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })

  // même correctif de fixture : `@in.nom`/`@out.nom` (docs/10-transitions.md), jamais
  // `@in`/`@out` seuls.
  it('@in.fade / @out.fade seuls : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$show = true', '</script>', '{if $show}<p @in.fade @out.fade>x</p>{end}'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })

  it('@attach seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<p @attach={(node) => { }}>x</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })

  it('@this=!{ref} (auto-déclaré) seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': '<p @this=!{ref}>x</p>\n',
    })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })

  it('@flip seul (dans un {for}) : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$items = [1, 2, 3]', '</script>', '{for x in $items}<p @flip>{x}</p>{end}'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })

  it('demandé explicitement (runtime: [..., "destroy_hooks"]) même sans usage : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['destroy_hooks'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_DESTROY_HOOKS))
  })
})
