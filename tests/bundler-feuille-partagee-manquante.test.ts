// Test de régression : une feuille référencée par `@css nom`
// sans fichier `.sass`/`.scss`/`.css` correspondant dans `stylesheetsDir`
// DOIT faire échouer le build (au lieu de silencieusement traiter comme du
// CSS vide — l'ancien comportement : `bundleSharedStyles()` n'énumère que les
// fichiers PRÉSENTS sur disque, sans jamais savoir quelles feuilles ont été
// DEMANDÉES par les composants ; le composant fautif héritait d'une feuille
// vide au runtime, avec un simple avertissement `Orphelin CSS local`, jamais
// un échec de build).
//
// Câblage : `sharedCssNames` (calculé par composant DANS LE WORKER) est
// désormais projeté au process maître (worker.ts, comme usedAnimations),
// accumulé dans `Bundler.requestedSharedSheets`, et validé par
// `validateSharedSheets()` (jumeau structurel de `compileUsedAnimations()`,
// mais THROW au lieu d'un simple warning) — appelée juste avant
// `bundleSharedStyles()` (étape 2c de `compile()`).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, unlinkSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

function makeProject(prefix: string) {
  const root = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const stylesDir = join(root, 'styles')
  mkdirSync(srcDir, { recursive: true })
  mkdirSync(stylesDir, { recursive: true })
  return { root, srcDir, stylesDir, outDir: join(root, 'out'), manifest: join(root, 'bundle.js') }
}

describe('bundler — @css feuille partagée absente fait ÉCHOUER le build (crash-si-feuille-absente)', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("`@css tema-manquant` sans fichier correspondant → stats.errors non vide, nommant la feuille partagée", async function () {
    const p = makeProject('css-theme-missing')
    writeFileSync(join(p.srcDir, 'comp.mjs'), [
      '<style @css="tema-manquant"></style>',
      '<script lang="coffee">$x = 0</script>',
      '<p>{$x}</p>',
    ].join('\n'))

    const bundler = new Bundler({
      sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : une feuille @css absente compilait avec succès, le composant héritant silencieusement d'une feuille vide")
    assert.ok(stats.errors.some(e => /tema-manquant/.test(e.message)),
      `l'erreur doit nommer la feuille manquante. errors:\n${stats.errors.map(e => e.message).join('\n')}`)
    await bundler.close()
  })

  it('`@css theme1 theme2` (multi-feuilles) : SEUL le manquant est nommé, le présent ne pollue pas le message', async function () {
    const p = makeProject('css-theme-partial')
    writeFileSync(join(p.stylesDir, 'theme1.sass'), '.t\n  color: red\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), [
      '<style @css="theme1 theme2-absent"></style>',
      '<script lang="coffee">$x = 0</script>',
      '<p>{$x}</p>',
    ].join('\n'))

    const bundler = new Bundler({
      sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0)
    assert.ok(stats.errors.some(e => /theme2-absent/.test(e.message)))
    assert.ok(!stats.errors.some(e => /\btheme1\b.*introuvable|introuvable.*\btheme1\b/.test(e.message)),
      `theme1 (présent) ne doit pas être cité comme manquant. errors:\n${stats.errors.map(e => e.message).join('\n')}`)
    await bundler.close()
  })

  it('`@css` avec TOUTES les feuilles présentes (mono et multi-noms) → build normal, inchangé (pas de régression)', async function () {
    const p = makeProject('css-theme-ok')
    writeFileSync(join(p.stylesDir, 'base.sass'), '.b\n  color: red\n')
    writeFileSync(join(p.stylesDir, 'typo.scss'), '.ty { color: blue; }')
    writeFileSync(join(p.srcDir, 'comp.mjs'), [
      '<style @css="base typo"></style>',
      '<script lang="coffee">$x = 0</script>',
      '<p>{$x}</p>',
    ].join('\n'))

    const bundler = new Bundler({
      sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir,
    })
    const stats = await bundler.compile()

    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })

  it("aucun `@css` dans le projet → validateSharedSheets() no-op, aucune régression sur un projet sans feuilles partagées", async function () {
    const p = makeProject('css-theme-none')
    writeFileSync(join(p.srcDir, 'comp.mjs'), '<p>ok</p>')

    const bundler = new Bundler({
      sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir,
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })

  it("rebuild incrémental (cache-hit) : un composant INCHANGÉ garde sa feuille @css sous surveillance même si le fichier de la feuille disparaît ENTRE-TEMPS", async function () {
    const p = makeProject('css-theme-cache')
    writeFileSync(join(p.stylesDir, 'base.sass'), '.b\n  color: red\n')
    writeFileSync(join(p.srcDir, 'comp.mjs'), [
      '<style @css="base"></style>',
      '<script lang="coffee">$x = 0</script>',
      '<p>{$x}</p>',
    ].join('\n'))
    writeFileSync(join(p.srcDir, 'autre.mjs'), '<p>ok</p>')  // force un 2e fichier, non touché au rebuild

    const bundler = new Bundler({
      sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: p.manifest, stylesheetsDir: p.stylesDir,
    })
    const stats1 = await bundler.compile()
    assert.equal(stats1.errors.length, 0, stats1.errors.map(e => e.message).join('\n'))

    // La feuille disparaît du disque — comp.mjs, LUI, reste INCHANGÉ (cache hit
    // garanti au recompile : même contenu, même coreHashedPath, sortie encore
    // sur disque). Seul autre.mjs change, pour déclencher un recompile
    // incrémental réaliste (comme `mjs dev`).
    unlinkSync(join(p.stylesDir, 'base.sass'))
    writeFileSync(join(p.srcDir, 'autre.mjs'), '<p>ok2</p>')
    const stats2 = await bundler.compile()
    assert.ok(stats2.errors.length > 0,
      "AVANT le fix (chemin cache-hit) : comp.mjs en cache hit disparaissait de requestedSharedSheets → 'base' absent n'était plus détecté au rebuild incrémental")
    assert.ok(stats2.errors.some(e => /\bbase\b/.test(e.message)),
      `errors:\n${stats2.errors.map(e => e.message).join('\n')}`)
    await bundler.close()
  })
})
