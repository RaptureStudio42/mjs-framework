// Tests neufs — gel CoffeeScript + bascule du défaut de manifeste externe vers
// Civet. Deux volets couverts (cf. src/bundler/index.ts —
// resolveDefaultManifestExternal/prepareExternalManifest (ex-bundleExternalManifest)/
// _processManifestNode — et src/languages/coffee.ts — avertissement de
// dépréciation) :
//   1. Résolution du DÉFAUT de `manifestExternal` (non configuré explicitement) :
//      'app/modularjs/manifest.civet' s'il existe, sinon repli
//      'app/modularjs/manifest.coffee' (dépréciée), sinon aucun manifeste.
//      Un `manifestExternal` explicite reste toujours respecté tel quel.
//   2. Avertissement de dépréciation à la compilation d'une VRAIE source
//      .coffee — une fois par fichier/processus, jamais sur le marqueur
//      synthétique `<moduleName>.inlines` (handlers d'événements, encodés en
//      Coffee EN INTERNE par le generator quel que soit le langage du dev).
//
// Le défaut de `manifestExternal` est un chemin relatif codé en dur, résolu
// contre `process.cwd()` (comme l'était déjà l'ancien défaut '…manifest.coffee') :
// les cas (a)/(b)/(c) ci-dessous font un `chdir`
// temporaire vers le projet temporaire pour exercer la VRAIE résolution par
// défaut, restauré dans un `finally` (mocha tourne en série, sans --parallel).
//
// Note (bruit inoffensif) : les fichiers sous `lib/` vivent DANS `sourceDir`
// (contrainte du défaut ci-dessus) — le scan `.civet`/`.coffee` autonome du
// bundler (compile(), section 3 — SANS RAPPORT avec le manifeste externe) les
// compile donc AUSSI chacun comme module ES indépendant (fichier de sortie en
// plus, parfois un 2e avertissement Coffee). Sans incidence : les assertions
// ci-dessous portent spécifiquement sur le contenu du bundle `__external`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { join, basename, resolve } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// Monte un projet temporaire minimal : `app/modularjs/` (sourceDir conventionnel,
// vide de composants — seul le manifeste externe nous intéresse ici) + `out/`.
function mkProject(): { root: string; srcDir: string; outDir: string } {
  const root = mjsTmp('manifest-civet')
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  return { root, srcDir, outDir }
}

// Contenu du bundle externe écrit par bundleExternalManifest() (fichier hashé
// `mjs_external-<hash>.js` dans outputDir) à partir du path renvoyé dans
// `stats.manifest.__external` (URL, pas un chemin disque — on ne garde que le
// basename pour rejoindre `outDir`).
function readExternalBundle(outDir: string, hashedUrl: string): string {
  return readFileSync(join(outDir, basename(hashedUrl)), 'utf-8')
}

describe('manifeste externe — défaut Civet-first / repli Coffee déprécié', function () {
  this.timeout(30000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('(a) SEULEMENT manifest.civet, aucun manifestExternal explicite → pris par défaut, bundle produit, contenu de a.civet inclus', async () => {
    const { root, srcDir, outDir } = mkProject()
    mkdirSync(join(srcDir, 'lib'), { recursive: true })
    // Manifeste racine = SEULEMENT une directive (vérifie aussi le point 3 :
    // un manifest.civet 100% directives ne doit pas planter la compilation).
    writeFileSync(join(srcDir, 'manifest.civet'), `#= require ./lib/a\n`)
    writeFileSync(join(srcDir, 'lib/a.civet'), `globalThis.__mjsMarkerA = 'MARQUEUR_CIVET_A'\n`)

    const cwdBefore = process.cwd()
    process.chdir(root)
    try {
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      try {
        assert.equal(bundler.manifestExternal, resolve('app/modularjs/manifest.civet'))
        const stats = await bundler.compile()
        assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
        assert.ok(stats.manifest.__external, 'un bundle externe doit être produit')
        const code = readExternalBundle(outDir, stats.manifest.__external)
        assert.match(code, /MARQUEUR_CIVET_A/, `le contenu compilé de a.civet doit être inclus. bundle:\n${code}`)
      } finally {
        await bundler.close()
      }
    } finally {
      process.chdir(cwdBefore)
    }
  })

  it('(b) SEULEMENT manifest.coffee (aucun .civet) → repli conservé + avertissement de dépréciation émis', async () => {
    const { root, srcDir, outDir } = mkProject()
    mkdirSync(join(srcDir, 'lib'), { recursive: true })
    writeFileSync(join(srcDir, 'manifest.coffee'), `#= require ./lib/a\n`)
    writeFileSync(join(srcDir, 'lib/a.coffee'), `globalThis.__mjsMarkerA = 'MARQUEUR_COFFEE_A'\n`)

    const warned: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }

    const cwdBefore = process.cwd()
    process.chdir(root)
    try {
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      try {
        assert.equal(bundler.manifestExternal, resolve('app/modularjs/manifest.coffee'), 'sans .civet, le repli .coffee doit rester pris')
        const stats = await bundler.compile()
        assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
        assert.ok(stats.manifest.__external, 'un bundle externe doit quand même être produit via le repli')
        const code = readExternalBundle(outDir, stats.manifest.__external)
        assert.match(code, /MARQUEUR_COFFEE_A/)

        // Un SEUL find() combinant les deux critères (pas de .find() puis
        // assert.match séparé) : le scan autonome (section 3) compile AUSSI
        // manifest.coffee lui-même comme module indépendant (il vit dans
        // sourceDir, comme lib/a.coffee — cf. note de tête de fichier) et émet
        // donc SON PROPRE avertissement de dépréciation. Selon l'ordre de
        // complétion du parallelMap, CET avertissement (qui ne cite pas
        // « a.coffee ») peut atterrir avant celui qui nous intéresse dans
        // `warned` — un .find() sur le seul texte « dépréciée » était donc
        // fragile (premier match = parfois le mauvais fichier).
        const depWarning = warned.find(w => w.includes('CoffeeScript dépréciée') && /a\.coffee/.test(w))
        assert.ok(depWarning, `avertissement de dépréciation citant a.coffee attendu. warnings captés : ${JSON.stringify(warned)}`)
      } finally {
        await bundler.close()
      }
    } finally {
      console.warn = origWarn
      process.chdir(cwdBefore)
    }
  })

  it('(c) manifest.civet ET manifest.coffee tous les deux présents → .civet gagne, le .coffee est ignoré', async () => {
    const { root, srcDir, outDir } = mkProject()
    mkdirSync(join(srcDir, 'lib'), { recursive: true })
    writeFileSync(join(srcDir, 'manifest.civet'), `#= require ./lib/civet-only\n`)
    writeFileSync(join(srcDir, 'manifest.coffee'), `#= require ./lib/coffee-only\n`)
    writeFileSync(join(srcDir, 'lib/civet-only.civet'), `globalThis.__mjsMarkerC = 'MARQUEUR_CIVET_GAGNE'\n`)
    writeFileSync(join(srcDir, 'lib/coffee-only.coffee'), `globalThis.__mjsMarkerCo = 'MARQUEUR_COFFEE_PERDU'\n`)

    const cwdBefore = process.cwd()
    process.chdir(root)
    try {
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      try {
        assert.equal(bundler.manifestExternal, resolve('app/modularjs/manifest.civet'))
        const stats = await bundler.compile()
        assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
        const code = readExternalBundle(outDir, stats.manifest.__external)
        assert.match(code, /MARQUEUR_CIVET_GAGNE/)
        assert.doesNotMatch(code, /MARQUEUR_COFFEE_PERDU/, 'le manifest.coffee ne doit PAS être lu quand .civet existe')
      } finally {
        await bundler.close()
      }
    } finally {
      process.chdir(cwdBefore)
    }
  })

  it('(d) manifestExternal explicite (chemin custom) → respecté', async () => {
    const { root, srcDir, outDir } = mkProject()
    const customDir = join(root, 'custom')
    mkdirSync(customDir, { recursive: true })
    const customManifest = join(customDir, 'mon-manifeste.civet')
    writeFileSync(customManifest, `globalThis.__mjsMarkerD = 'MARQUEUR_CUSTOM'\n`)

    const bundler = new Bundler({
      sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'),
      manifestExternal: customManifest,
    })
    try {
      assert.equal(bundler.manifestExternal, resolve(customManifest), 'le chemin explicite doit être respecté tel quel')
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
      const code = readExternalBundle(outDir, stats.manifest.__external)
      assert.match(code, /MARQUEUR_CUSTOM/)
    } finally {
      await bundler.close()
    }
  })
})

describe('coffeeAdapter — avertissement de dépréciation (une fois par fichier/processus)', function () {
  this.timeout(30000)

  it('(e) un composant <script lang="coffee"> compilé deux fois n\'avertit qu\'une seule fois', async () => {
    const src = `<script lang="coffee">\n$count = 0\n</script>\n<p>{$count}</p>\n`
    const warned: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }
    try {
      await transpile(src, { moduleName: 'mcd-coffee-warn-once' })
      await transpile(src, { moduleName: 'mcd-coffee-warn-once' })
    } finally {
      console.warn = origWarn
    }
    const depWarnings = warned.filter(w => w.includes('CoffeeScript dépréciée'))
    assert.equal(depWarnings.length, 1, `un seul avertissement attendu (dédup par fichier/processus), reçu : ${JSON.stringify(depWarnings)}`)
    assert.match(depWarnings[0], /mcd-coffee-warn-once\.script/)
  })

  // Cas supplémentaire — garde-fou pour un
  // risque de FAUX POSITIF découvert en relisant les appelants de l'adaptateur :
  // le generator encode TOUJOURS les handlers d'événements inline en Coffee en
  // interne (marqueur synthétique `<moduleName>.inlines`, cf.
  // transpiler/index.ts), quel que soit le langage réellement choisi par le
  // dev. Sans exclusion, un composant 100% Civet avec un simple `@click={…}`
  // aurait déclenché l'avertissement Coffee à TORT.
  it('un composant Civet (défaut) avec handler inline @click={...} n\'avertit PAS (marqueur synthétique .inlines exclu)', async () => {
    const src = `<script>\n$count = 0\n</script>\n<button @click={$count++}>{$count}</button>\n`
    const warned: string[] = []
    const origWarn = console.warn
    console.warn = (...args: unknown[]) => { warned.push(String(args[0])) }
    try {
      await transpile(src, { moduleName: 'mcd-civet-inline-handler-no-warn' })
    } finally {
      console.warn = origWarn
    }
    const depWarnings = warned.filter(w => w.includes('CoffeeScript dépréciée'))
    assert.equal(depWarnings.length, 0, `un composant Civet avec handler inline ne doit pas déclencher l'avertissement Coffee. reçu : ${JSON.stringify(depWarnings)}`)
  })
})
