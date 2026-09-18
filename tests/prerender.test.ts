// Prérendu des PAGES au build : le bloc `render` → fichiers HTML (DSD).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { prerenderPages, urlToFile } from '../src/server/prerender.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('prerender — pages au build', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('urlToFile : / → index.html, /blog → blog.html, /a/b → a/b.html', () => {
    assert.equal(urlToFile('/'), 'index.html')
    assert.equal(urlToFile('/blog'), 'blog.html')
    assert.equal(urlToFile('/a/b'), 'a/b.html')
    assert.equal(urlToFile('/blog/'), 'blog.html')
  })

  it('prérend les pages concrètes ; signale les non-prérendables', async function () {
    this.timeout(30000)
    const root = mjsTmp('prerender')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), `
<script lang="coffee">
$titre = "Accueil"
</script>
<h1 class="t">{$titre}</h1>
`)
    const config = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: {
        default: 'prerender' as const,
        routes: {
          '/':            { component: 'mjs-home' },                              // concrète → générée
          '/produit/:id': { component: 'mjs-home', mode: 'prerender' as const },  // paramétrée → skip
          '/app':         { component: 'mjs-home', mode: 'csr' as const },        // csr → skip
        },
      },
    }

    const report = await prerenderPages(config, root)

    // La home est générée en Declarative Shadow DOM, réactivité résolue
    const home = report.generated.find(g => g.url === '/')
    assert.ok(home, 'la home doit être générée')
    assert.ok(existsSync(home!.file), 'le fichier de page doit exister sur disque')
    assert.ok(home!.file.endsWith(join('mjs_pages', 'index.html')), 'écrite en mjs_pages/index.html')
    const out = readFileSync(home!.file, 'utf-8')
    assert.match(out, /<mjs-home[^>]*><template shadowrootmode="open">/, 'DSD présent')
    assert.match(out, /Accueil/, 'le binding {$titre} doit être résolu au serveur')

    // Rien n'est silencieux : paramétrée + csr signalées
    assert.ok(report.skipped.some(s => s.url === '/produit/:id'), 'route paramétrée signalée')
    assert.ok(report.skipped.some(s => s.url === '/app'), 'route csr signalée')
    assert.equal(report.generated.length, 1, 'une seule page concrète prérendable')
  })

  it('no-op sans bloc render', async () => {
    const report = await prerenderPages({ sourceDir: 'src' }, '/tmp')
    assert.equal(report.generated.length, 0)
    assert.equal(report.skipped.length, 0)
  })

  // La voie de
  // prérendu de `mjs build` appelait `createSSRRenderer` SANS transmettre
  // `stylesheetsDir`/`sigil`/`contextAlias` (contrairement à la voie `mjs serve`,
  // déjà corrigée). Un projet à `stylesheetsDir` non standard (CAS RÉEL)
  // prérendait des pages NON STYLÉES, silencieusement. Preuve
  // INDIRECTE mais fiable (identique à ssr-forwards-sigil-context-styles) : un
  // SASS cassé dans le dossier CUSTOM ne fait throw QUE s'il est réellement scanné.
  it('prerenderPages transmet stylesheetsDir custom au Bundler interne (dossier bien scanné)', async function () {
    this.timeout(30000)
    const root = mjsTmp('prerender-styles')
    const srcDir = join(root, 'src')
    const stylesDir = join(root, 'mes-styles-a-moi')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(stylesDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), '<p>ok</p>')
    writeFileSync(join(stylesDir, 'casse.scss'), '.x { color: ; !!! pas du sass valide')
    const config = {
      sourceDir: 'src', outputDir: 'public/out',
      stylesheetsDir: 'mes-styles-a-moi',
      render: { default: 'prerender' as const, routes: { '/': { component: 'mjs-home' } } },
    }
    await assert.rejects(
      prerenderPages(config as any, root),
      /erreur|Error/i,
      'AVANT le fix : stylesheetsDir custom non transmis → ce dossier (et son SASS cassé) jamais scanné → aucune erreur, mais pages silencieusement non stylées')
  })
})
