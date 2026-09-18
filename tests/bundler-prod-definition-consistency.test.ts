// Test de régression : 2 définitions
// DIVERGENTES de "build de prod" coexistaient dans le bundler —
// `shouldEmitSourceMap()` considérait `forceMinify || NODE_ENV==='production'`,
// mais l'exposition de `window.µ` dans `writeManifest()` ne regardait QUE
// `NODE_ENV`. Un projet avec `forceMinify: true` (mjs.config.json
// `"minify": true`, ou `mjs build --minify`) sans jamais poser
// `NODE_ENV=production` (scénario courant en CI/local) obtenait une sortie
// MINIFIÉE (props `_mjs_*` manglées) qui exposait QUAND MÊME `window.µ`.
//
// Fix : `isProd()` — définition canonique unique, utilisée par les deux.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — définition unique de "prod" (isProd) : forceMinify sans NODE_ENV=production', function () {
  this.timeout(15000)
  let originalNodeEnv: string | undefined

  before(() => { originalNodeEnv = process.env.NODE_ENV })
  afterEach(() => {
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV
    else process.env.NODE_ENV = originalNodeEnv
  })

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("forceMinify:true SANS NODE_ENV=production → window.µ n'est PAS exposé (cohérent avec la sortie minifiée)", async function () {
    delete process.env.NODE_ENV  // surtout PAS 'production' — ni undefined ne doit compter comme prod ici
    const root = mjsTmp('prod-def')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hello.mjs'), '<p>hi</p>')

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js'),
      forceMinify: true,
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const manifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
    assert.doesNotMatch(manifest, /window\.µ\s*=\s*µ/,
      "AVANT le fix : window.µ était exposé dès que NODE_ENV n'est pas EXACTEMENT 'production', même avec forceMinify:true (sortie minifiée qui se comporte comme la prod)")
    await bundler.close()
  })

  it('sans forceMinify ET sans NODE_ENV=production (dev normal) → window.µ EST exposé (pas de régression)', async function () {
    delete process.env.NODE_ENV
    const root = mjsTmp('prod-def-dev')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hello.mjs'), '<p>hi</p>')

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

    const manifest = readFileSync(join(root, 'bundle.js'), 'utf-8')
    assert.match(manifest, /window\.µ\s*=\s*µ/, 'en dev normal, window.µ doit rester exposé (debug console)')
    await bundler.close()
  })
})
