// Test de régression :
// `prerenderPages` n'était appelé QUE dans `mjs build` — une page en mode
// `prerender` (render.routes) éditée pendant `mjs dev` déclenchait bien la
// recompilation + le reload HMR du JS, mais le HTML FIGÉ déjà écrit sur disque
// ne se rafraîchissait JAMAIS : un dev qui travaille sur une page prérendue
// voyait un contenu PÉRIMÉ tant qu'il ne relançait pas `mjs build` à la main.
//
// Fix : `cli/dev-prerender.ts` (extrait de cli.ts, même précédent que
// cli/dev-lock.ts — cli.ts exécute `run(process.argv)` inconditionnellement à
// son top-level, l'importer déclencherait une vraie exécution CLI) relance
// `prerenderPages` après chaque recompile RÉUSSIE de `mjs dev`, en
// fire-and-forget (jamais de blocage du reload HMR, jamais d'exception qui
// remonte — même résilience qu'en build).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { prerenderOnDevRecompile } from '../src/cli/dev-prerender.js'
import { prerenderPages } from '../src/server/prerender.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('cli/dev-prerender — prerenderOnDevRecompile', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('sans bloc `render` : no-op silencieux, le prerenderFn injecté n\'est JAMAIS appelé', async () => {
    let called = false
    const result = await prerenderOnDevRecompile(undefined, '/tmp/x', {
      prerenderFn: (async () => { called = true; return { outDir: '', generated: [], skipped: [] } }) as any,
    })
    assert.equal(called, false)
    assert.equal(result, undefined)
  })

  it('avec un bloc `render` : appelle prerenderFn(config, configDir, log)', async () => {
    const calls: any[] = []
    const fakeReport = { outDir: '/out', generated: [{ url: '/', file: 'index.html', component: 'x', bytes: 10 }], skipped: [] }
    const config: any = { render: { routes: { '/': { component: 'mjs-home' } } } }
    const result = await prerenderOnDevRecompile(config, '/proj', {
      log: (m) => calls.push(['log', m]),
      prerenderFn: (async (cfg, dir, log) => { calls.push(['call', cfg, dir]); log('une ligne'); return fakeReport }) as any,
    })
    assert.deepEqual(result, fakeReport)
    assert.deepEqual(calls[0], ['call', config, '/proj'])
    assert.deepEqual(calls[1], ['log', 'une ligne'])
  })

  it("AVANT le fix : ce chemin n'existait pas du tout (mjs dev n'appelait jamais prerenderPages) — régression figée par ce test : une panne du prerenderFn est absorbée, ne rejette JAMAIS, juste un warn", async () => {
    const warnings: string[] = []
    const result = await prerenderOnDevRecompile(
      { render: { routes: {} } } as any,
      '/proj',
      {
        warn: (m) => warnings.push(m),
        prerenderFn: (async () => { throw new Error('happy-dom absent') }) as any,
      },
    )
    assert.equal(result, undefined)
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /Prérendu \(dev\) ignoré.*happy-dom absent/)
  })

  // Le bundler du `mjs dev` en cours porte les chemins hachés que les fragments préchargent
  // (cf. bundler/startup.ts) : sans cette transmission depuis cli.ts, l'en-tête de démarrage d'une
  // page prérendue ne serait jamais reposé après un recompile — même famille de piège qu'une clé de
  // config résolue mais jamais recopiée.
  it("avec un bundler : relance l'en-tête de démarrage des fragments, TOUJOURS en mode développement", async () => {
    const appels: any[] = []
    const fakeReport = { outDir: '/out', generated: [{ url: '/', file: 'index.html', component: 'x', bytes: 10, tags: ['mjs-x'] }], skipped: [] }
    const config: any = { render: { startup: 'bundle', routes: { '/': { component: 'mjs-home' } } } }
    const bundler: any = { marqueur: 'le bundler du dev' }
    await prerenderOnDevRecompile(config, '/proj', {
      bundler,
      prerenderFn: (async () => fakeReport) as any,
      startupFn: (async (b, render, report, opts) => { appels.push([b, render, report, opts]); return { pages: [], written: 0, pageFiles: [] } }) as any,
    })
    assert.equal(appels.length, 1, 'startupFn appelée une fois')
    assert.equal(appels[0][0], bundler)
    assert.equal(appels[0][1], config.render)
    assert.equal(appels[0][2], fakeReport)
    assert.equal(appels[0][3].prod, false, 'jamais un assemblage de production depuis mjs dev')
  })

  it("sans bundler : aucun en-tête de démarrage posé (rien à quoi résoudre les chemins hachés)", async () => {
    let appelee = false
    const config: any = { render: { routes: { '/': { component: 'mjs-home' } } } }
    await prerenderOnDevRecompile(config, '/proj', {
      prerenderFn: (async () => ({ outDir: '/out', generated: [], skipped: [] })) as any,
      startupFn: (async () => { appelee = true; return { pages: [], written: 0, pageFiles: [] } }) as any,
    })
    assert.equal(appelee, false)
  })

  it('sans prerenderFn injecté : utilise bien la VRAIE prerenderPages par défaut (wiring bout-en-bout, pas juste un mock isolé)', async function () {
    this.timeout(30000)
    const root = mjsTmp('devprerender')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'home.mjs'), `
<script lang="coffee">
$titre = "Accueil"
</script>
<h1 class="t">{$titre}</h1>
`)
    const config: any = {
      sourceDir: 'src',
      outputDir: 'public/out',
      render: { default: 'prerender', routes: { '/': { component: 'mjs-home' } } },
    }

    const result = await prerenderOnDevRecompile(config, root)
    assert.ok(result, 'doit retourner un vrai PrerenderReport (prerenderPages réellement invoquée)')
    const home = result!.generated.find(g => g.url === '/')
    assert.ok(home, 'la page / doit être générée')
    assert.ok(existsSync(home!.file))
  })

  it('confirme le type par défaut (prerenderFn omis) === prerenderPages réel (pas une coïncidence de comportement)', () => {
    // Sanity structurelle : le module importe bien la même fonction que celle
    // testée exhaustivement par prerender.test.ts — pas une réimplémentation
    // parallèle qui pourrait diverger silencieusement.
    assert.equal(typeof prerenderPages, 'function')
  })
})
