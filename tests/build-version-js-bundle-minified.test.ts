// readBuildVersion() (server/build-version.ts) doit lire `µ.version` même dans un manifeste
// mode `js: 'bundle'` : en dev, esbuild.build() échappe `µ` en `µ` (charset ASCII par
// défaut) — corrigé par `charset: 'utf8'` côté bundler. En production (minifié), esbuild
// renomme aussi la VARIABLE `µ` elle-même en un nom court quelconque (`n.version="…"`) : le
// sigil littéral ne survit alors nulle part dans le texte — `mjs serve`/le journal perdaient
// silencieusement la version du build. Repli sur un `footer` esbuild stable (`//# mjsVersion=…`,
// jamais renommé). Non-régression : le manifeste ÉCLATÉ (mode 'split', jamais minifié par
// writeManifest lui-même, dev ET prod) doit continuer à fonctionner à l'identique.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { readBuildVersion } from '../src/server/build-version.js'
import { mjsTmp } from './helpers/tmp.js'

function makeProject(prefix: string): { root: string; srcDir: string; manifestPath: string } {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'comp.mjs'), '<p>hi</p>\n')
  return { root, srcDir, manifestPath: join(root, 'out/bundle.js') }
}

describe('server/build-version — readBuildVersion() survit à un manifeste minifié', function () {
  this.timeout(20000)

  after(async () => { await terminateSharedWorkerPool() })

  it("js: 'bundle' + build de PRODUCTION (minifié, espaces retirés autour de =) : la version reste lisible", async function () {
    const p = makeProject('build-version-bundle-prod')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: join(p.root, 'out'), manifestPath: p.manifestPath, js: 'bundle', env: 'prod' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    assert.ok(bundler.lastBuildId, 'un id de build doit avoir été calculé')

    const version = readBuildVersion(p.manifestPath)
    assert.equal(version, bundler.lastBuildId, 'readBuildVersion() doit lire la MÊME version que bundler.lastBuildId, même minifiée')
    await bundler.close()
  })

  it("js: 'bundle' + build de DÉVELOPPEMENT (non minifié, espaces conservés) : reste lisible (non-régression)", async function () {
    const p = makeProject('build-version-bundle-dev')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: join(p.root, 'out'), manifestPath: p.manifestPath, js: 'bundle', env: 'dev' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const version = readBuildVersion(p.manifestPath)
    assert.equal(version, bundler.lastBuildId, 'readBuildVersion() doit lire la version en dev aussi')
    await bundler.close()
  })

  it("mode 'split' (défaut), dev — non-régression : readBuildVersion() inchangé", async function () {
    const p = makeProject('build-version-split-dev')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: join(p.root, 'out'), manifestPath: p.manifestPath, env: 'dev' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const version = readBuildVersion(p.manifestPath)
    assert.equal(version, bundler.lastBuildId, 'readBuildVersion() doit lire la version en split/dev')
    await bundler.close()
  })

  it("mode 'split' (défaut), production — non-régression : readBuildVersion() inchangé (writeManifest() n'est de toute façon jamais minifié)", async function () {
    const p = makeProject('build-version-split-prod')
    const bundler = new Bundler({ sourceDir: p.srcDir, outputDir: join(p.root, 'out'), manifestPath: p.manifestPath, env: 'prod' })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const version = readBuildVersion(p.manifestPath)
    assert.equal(version, bundler.lastBuildId, 'readBuildVersion() doit lire la version en split/prod')
    await bundler.close()
  })
})
