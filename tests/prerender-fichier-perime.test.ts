// Un échec de RENDU sur une page DÉCLARÉE ne doit jamais
// laisser passer le HTML PÉRIMÉ d'un build antérieur : le fichier de sortie de cette route est
// supprimé, et le skip est marqué `fatal` (distingué d'un skip attendu — route paramétrée, mode
// non buildable) pour que l'appelant (cli.ts) puisse faire échouer le build.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { prerenderPages } from '../src/server/prerender.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('prerender — page en échec : fichier périmé supprimé, skip marqué fatal', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it("build #2 (route pointant vers un composant qui n'existe plus) : le HTML du build #1 est supprimé, pas laissé périmé", async function () {
    this.timeout(30000)
    const root = mjsTmp('prerender-stale')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), `<h1>version SAINE — build #1</h1>`)

    const configSain = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: { default: 'prerender' as const, routes: { '/': { component: 'mjs-home' } } },
    }
    const report1 = await prerenderPages(configSain, root)
    const home = report1.generated.find(g => g.url === '/')
    assert.ok(home, 'build #1 : la page doit être générée')
    assert.ok(existsSync(home!.file), 'build #1 : le fichier doit exister sur disque')
    assert.match(readFileSync(home!.file, 'utf-8'), /version SAINE — build #1/)
    const fichier = home!.file

    // build #2 — MÊME URL, mais la route pointe maintenant vers un tag qui n'existe pas
    // (renommage/typo de composant) : le rendu de CETTE page échoue.
    const configCasse = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: { default: 'prerender' as const, routes: { '/': { component: 'mjs-nexistepas' } } },
    }
    const report2 = await prerenderPages(configCasse, root)
    assert.equal(report2.generated.length, 0, 'build #2 : rien de généré (le seul composant référencé est en échec)')
    assert.equal(report2.skipped.length, 1)
    assert.equal(report2.skipped[0].url, '/')
    assert.ok(report2.skipped[0].fatal, 'AVANT le fix : le skip par échec de RENDU n\'était pas distingué des skips attendus (route paramétrée/mode non buildable)')
    assert.ok(
      !existsSync(fichier),
      'AVANT le fix : le fichier du build #1 restait sur disque, PÉRIMÉ — servi tel quel par le back sans que rien ne le signale',
    )
  })

  it('skip ATTENDU (route paramétrée) : jamais marqué fatal, aucun fichier à supprimer', async function () {
    this.timeout(30000)
    const root = mjsTmp('prerender-skip-attendu')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), `<h1>ok</h1>`)
    const config = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: {
        default: 'prerender' as const,
        routes: { '/produit/:id': { component: 'mjs-home', mode: 'prerender' as const } },
      },
    }
    const report = await prerenderPages(config, root)
    assert.equal(report.skipped.length, 1)
    assert.ok(!report.skipped[0].fatal, 'une route paramétrée est un skip VOULU, jamais fatal')
  })
})
