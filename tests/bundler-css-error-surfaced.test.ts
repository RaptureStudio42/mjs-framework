// Test de régression —
// motif dominant (« erreur avalée → build vert ») : une
// erreur de syntaxe SASS/SCSS dans un `<style>` de composant, OU dans un
// stylesheet PARTAGÉ, était catchée par `compileCss` et transformée en CSS
// VIDE + `console.error` — le build rapportait un SUCCÈS complet
// (`stats.errors` vide) alors que le composant concerné rend SANS AUCUN
// STYLE en prod.
//
// Fix : `compileCss` ne catch plus (throw). Côté composant (worker), l'infra
// worker→master DÉJÀ en place remonte l'erreur dans `stats.errors` SANS
// changement supplémentaire. Côté styles PARTAGÉS (`bundleSharedStyles`,
// master), chaque fichier est isolé — un fichier cassé n'empêche PAS les
// AUTRES d'être compilés, l'erreur est levée à la fin (remontée par le
// try/catch déjà en place chez le caller de compile()).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('bundler — erreur SASS/SCSS remontée dans stats.errors (pas de build vert silencieux)', function () {
  this.timeout(20000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('un <style lang="scss"> cassé DANS UN COMPOSANT → stats.errors non vide', async function () {
    const root = mjsTmp('css-comp-err')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      '</script>',
      '<p class="x">contenu</p>',
      '<style lang="scss">',
      '.x { color: #{ }',   // interpolation jamais refermée → erreur SASS certaine
      '</style>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : une erreur SASS dans le <style> d'un composant était avalée (CSS vide + console.error) — le composant compilait avec SUCCÈS, sans style, silencieusement")
    await bundler.close()
  })

  it("un stylesheet PARTAGÉ cassé n'empêche PAS les AUTRES stylesheets partagés d'être compilés (isolation par fichier)", async function () {
    const root = mjsTmp('css-shared-err')
    const srcDir = join(root, 'src')
    const stylesDir = join(root, 'styles')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), '<p>ok</p>')
    writeFileSync(join(stylesDir, 'casse.scss'), '.x { color: #{ }')
    writeFileSync(join(stylesDir, 'valide.scss'), '.valide-marqueur { color: red; }')

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js'), stylesheetsDir: stylesDir,
    })
    const stats = await bundler.compile()

    assert.ok(stats.errors.length > 0,
      "AVANT le fix : une erreur SASS dans un stylesheet PARTAGÉ était avalée, aucune trace dans stats.errors")
    assert.ok(stats.errors.some(e => /casse\.scss/.test(e.message)), `l'erreur doit nommer le fichier fautif. errors:\n${stats.errors.map(e => e.message).join('\n')}`)

    // Le fichier VALIDE, à côté du cassé, doit quand même être compilé et
    // écrit — un stylesheet cassé ne doit pas priver les autres.
    const stylesFile = readdirSync(join(root, 'out')).find((f) => /^mjs_styles-/.test(f))!
    const manifestJs = readFileSync(join(root, 'out', stylesFile), 'utf-8')
    assert.match(manifestJs, /valide-marqueur/, "le stylesheet VALIDE doit être présent malgré l'échec du voisin cassé")

    await bundler.close()
  })

  it('aucune erreur SASS → build normal, inchangé (pas de régression)', async function () {
    const root = mjsTmp('css-ok')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), [
      '<script lang="coffee">',
      '</script>',
      '<p class="x">contenu</p>',
      '<style lang="scss">',
      '.x { color: red; }',
      '</style>',
    ].join('\n'))

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: join(root, 'out'), manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    await bundler.close()
  })
})
