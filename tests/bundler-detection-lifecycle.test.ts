// mjs_lifecycle.ts — crochets de cycle de vie en runes (µmount/µawake/µsleep/µdestroy/
// µurlChange/µfailed nu), DÉTACHÉS du cœur (mjs_element.ts en portait ces méthodes) : détecté
// DIRECTEMENT (runes, ET balises globales <@window>/<@document>/<@body>/<@html>/<@head> dont le
// code émis s'attache par `@_mjs_hook 'awake'`/`'sleep'`), OU FORCÉ par `every` (µ.every appelle
// _mjs_onDestroy/_mjs_onSleep/_mjs_onAwake sans garde), par `interpolate` (propriétaire implicite, purge
// immédiate à la destruction), par `smooth`/`socket` (option `owner`) et par le cache de pages
// (l'éviction appelle _mjs_runDestroyCallbacks) : leurs gardes typeof évitent le crash, pas la fuite.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { mjsTmp } from './helpers/tmp.js'

const MARK_LIFECYCLE = 'µ.Element.prototype._mjs_hook = function'

async function buildProject(cfgExtra: any, files: Record<string, string>): Promise<{ outDir: string }> {
  const root = mjsTmp('detect-lifecycle')
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

describe('mjs_lifecycle.ts — détaché du cœur, build RÉEL', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it('composant SANS aucun hook, SANS every : ABSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.equal(coreContent(outDir).includes(MARK_LIFECYCLE), false)
  })

  it('µmount -> seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µmount ->', '  null', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  it('µdestroy -> seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µdestroy ->', '  null', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  it('µurlChange (path, params) -> seul : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µurlChange (path, params) ->', '  null', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  it('µfailed (err, reset) -> NU, SANS <@failed> : PRÉSENT (compile bien vers _mjs_hook)', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µfailed (err, reset) ->', '  null', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  it('<@failed> SEULE (balise, pas la rune nue) : mjs_lifecycle.ts ABSENT — mjs_failed.ts seul suffit', async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<p>x</p>', '<@failed err reset>', '  <p>Oups {err.message}</p>', '</@failed>'].join('\n'),
    })
    assert.equal(coreContent(outDir).includes(MARK_LIFECYCLE), false)
  })

  it("µevery seul (aucun hook direct) : PRÉSENT quand même — µ.every appelle _mjs_onDestroy sans garde", async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', 'µmount ->', '  µevery 1000, ->', '    null', '</script>', '<p>x</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  it("µinterpolate seul (sans every, sans hook direct) : PRÉSENT — le composant propriétaire doit être purgé dès sa destruction", async function () {
    const { outDir } = await buildProject({ runtime: [] }, {
      'hop.mjs': ['<script>', '$x = µinterpolate(0, 10)', '</script>', '<p>{$x.value}</p>'].join('\n'),
    })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })

  for (const [tag, source] of [
    ['<@window @keydown>', ['<script>', 'onkeydown = (event)->', '  null', '</script>', '<@window @keydown={onkeydown}>', '<p>x</p>']],
    ['<@document @click>', ['<script>', 'onclick = (event)->', '  null', '</script>', '<@document @click={onclick}>', '<p>x</p>']],
    ['<@body @class{…}>', ['<script>', '$open = true', '</script>', '<@body @class{$open}="no-scroll">', '<p>x</p>']],
    ['<@html @class{…}>', ['<script>', '$dark = true', '</script>', '<@html @class{$dark}="dark">', '<p>x</p>']],
    ['<@head> avec contenu', ['<@head>', '  <meta name="x" content="y">', '</@head>', '<p>x</p>']],
  ] as [string, string[]][]) {
    it(`${tag} sans aucune rune : PRÉSENT — le code émis s'attache par @_mjs_hook`, async function () {
      const { outDir } = await buildProject({ runtime: [] }, { 'hop.mjs': source.join('\n') })
      assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
    })
  }

  for (const module of ['smooth', 'socket', 'router', 'ujs', 'modal']) {
    it(`runtime: ['${module}'] sans hook : PRÉSENT (forcé)`, async function () {
      const { outDir } = await buildProject({ runtime: [module] }, { 'hop.mjs': '<p>x</p>\n' })
      assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
    })
  }

  it('demandé explicitement (runtime: [..., "lifecycle"]) même sans usage : PRÉSENT', async function () {
    const { outDir } = await buildProject({ runtime: ['lifecycle'] }, { 'hop.mjs': '<p>x</p>\n' })
    assert.ok(coreContent(outDir).includes(MARK_LIFECYCLE))
  })
})
