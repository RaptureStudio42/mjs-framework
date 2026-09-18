// Garde-fou — `mjs build
// --output X --manifest Y` : le build principal (`new Bundler({...})` dans
// cli.ts) respectait déjà ces overrides, mais `prerenderPages(found.config,
// found.configDir, …)` (cli.ts) → prerender.ts re-dérivait `outputDir`/
// `manifestPath`/`sourceDir` DIRECTEMENT depuis `mjs.config.json`, ignorant
// `args.output`/`args.manifest` — le prérendu recompilait puis ÉCRASAIT les
// vrais fichiers du projet (`<défaut outputDir>/../mjs_pages`) même quand le
// build principal avait été explicitement redirigé ailleurs.
//
// Test via un VRAI SOUS-PROCESSUS (même motif que cli-check-writes-warning.
// test.ts : cli.ts exécute `run(process.argv)` inconditionnellement à son
// top-level, l'importer directement serait dangereux) — sur un projet
// FIXTURE minimal créé dans un dossier temporaire, JAMAIS un projet réel.

import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, writeFileSync, existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { fileURLToPath } from 'node:url'

const repoRoot = join(dirname(fileURLToPath(import.meta.url)), '..')

function fixtureProject(): string {
  const root = mjsTmp('build-override')
  mkdirSync(join(root, 'app', 'modularjs'), { recursive: true })
  writeFileSync(join(root, 'app', 'modularjs', 'home.mjs'), `
<script lang="coffee">
$titre = "Accueil"
</script>
<h1 class="t">{$titre}</h1>
`)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs',
    outputDir: 'public/modularjs',
    render: {
      default: 'prerender',
      routes: { '/': { component: 'mjs-home' } },
    },
  }, null, 2))
  return root
}

describe("cli.ts — 'mjs build --output/--manifest' : le prérendu respecte les overrides", function () {
  this.timeout(40000)

  it('build REDIRIGÉ (--output/--manifest hors du projet) : AUCUN fichier écrit dans le projet, tout va dans les chemins redirigés', () => {
    const projectRoot = fixtureProject()
    const redirectDir = mjsTmp('build-override-redirect')
    const redirectedOutput = join(redirectDir, 'out-there')
    const redirectedManifest = join(redirectedOutput, 'bundle.js')

    const result = spawnSync('npx', [
      'tsx', 'src/cli.ts', 'build',
      '--root', projectRoot,
      '--output', redirectedOutput,
      '--manifest', redirectedManifest,
    ], { cwd: repoRoot, encoding: 'utf-8' })

    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)

    // AVANT le fix : `prerenderPages` re-dérivait `outputDir` depuis
    // `mjs.config.json` (public/modularjs, le défaut du fixture) IGNORANT
    // `--output` — `outDir` (mjs_pages) atterrissait alors DANS le projet
    // (public/mjs_pages), à côté de son bundle par défaut, ÉCRASANT ce qui s'y
    // trouvait. Le fix doit garantir qu'AUCUN répertoire `public/` n'apparaît
    // du tout dans le projet quand la sortie est intégralement redirigée.
    assert.ok(
      !existsSync(join(projectRoot, 'public')),
      "AVANT le fix : `public/` (outputDir par défaut) était créé/écrit dans le PROJET malgré --output/--manifest redirigés — incident d'écrasement",
    )

    // Le prérendu (mjs_pages) doit suivre le MÊME outputDir redirigé : sibling
    // de `redirectedOutput`, pas du défaut `mjs.config.json`.
    const redirectedPage = join(redirectDir, 'mjs_pages', 'index.html')
    assert.ok(existsSync(redirectedPage), `page prérendue attendue en ${redirectedPage} (dérivée de --output redirigé)`)
    const pageHtml = readFileSync(redirectedPage, 'utf-8')
    assert.match(pageHtml, /Accueil/, 'le binding {$titre} doit être résolu au serveur, dans le fichier REDIRIGÉ')
    assert.match(pageHtml, /<mjs-home[^>]*><template shadowrootmode="open">/, 'DSD présent, même sortie que le prérendu standard')

    // Le bundle compilé (assets hashés) doit être dans `redirectedOutput`,
    // jamais dans le projet — preuve que le build principal ET le renderer
    // interne de prerenderPages compilent tous deux vers le MÊME chemin
    // redirigé (pas de double compilation vers deux endroits différents).
    assert.ok(existsSync(redirectedOutput), `outputDir redirigé attendu en ${redirectedOutput}`)
    const compiled = readdirSync(redirectedOutput)
    assert.ok(compiled.some(f => f.startsWith('home-')), 'composant compilé attendu dans outputDir redirigé')
  })

  it('build SANS override : comportement inchangé (outputDir/mjs_pages par défaut, dans le projet)', () => {
    const projectRoot = fixtureProject()

    const result = spawnSync('npx', ['tsx', 'src/cli.ts', 'build', '--root', projectRoot], {
      cwd: repoRoot, encoding: 'utf-8',
    })

    assert.equal(result.status, 0, `stderr:\n${result.stderr}\nstdout:\n${result.stdout}`)

    const defaultPage = join(projectRoot, 'public', 'mjs_pages', 'index.html')
    assert.ok(existsSync(defaultPage), `non-régression : sans override, la page prérendue doit rester en ${defaultPage} (comme avant le fix)`)
    const pageHtml = readFileSync(defaultPage, 'utf-8')
    assert.match(pageHtml, /Accueil/)

    const compiled = readdirSync(join(projectRoot, 'public', 'modularjs'))
    assert.ok(compiled.some(f => f.startsWith('home-')), 'non-régression : outputDir par défaut toujours bien compilé')
  })
})
