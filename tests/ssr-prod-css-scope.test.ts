// Prérendu de PRODUCTION — le fragment porte le CSS scopé de chaque composant, light DOM compris.
// Les propriétés internes `_mjs_*` sont RACCOURCIES en production (esbuild `mangleProps: /^_mjs_/`,
// cache partagé entre fichiers) : un code serveur qui lit `el._mjs_baseCss`/`el._mjs_isLight` PAR
// SON NOM sur un élément né du bundle minifié ne trouve rien — le `<style>` du
// `<template shadowrootmode>` part en silence, et le visiteur reçoit une page prérendue NON STYLÉE.
// Le runtime expose donc un accès à nom LONG (`µ._ssrInfo(el)`, jamais raccourci) que les deux
// moteurs de rendu lisent.
//
// Le mode DÉVELOPPEMENT (non minifié) sert de témoin : mêmes assertions, mêmes attentes.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { prerenderPages } from '../src/server/prerender.js'
import { createSSRRenderer } from '../src/server/renderToString.js'

type Env    = 'dev' | 'prod'
type Moteur = 'happy-dom' | 'browser'

interface Projet { root: string; srcDir: string; outDir: string }

// accueil à deux étages : la racine, son sous-composant à shadow et un sous-composant light
// portent CHACUN une feuille scopée dont le sélecteur sert de témoin dans le fragment
function fixture(prefix: string, moteur: Moteur): Projet {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'carte.mjs'), ['<p class="carte-wrap">CARTE-TEXTE</p>', '<style>', '  .carte-wrap', '    color: seagreen', '</style>', ''].join('\n'))
  writeFileSync(join(srcDir, 'leger.mjs'), ['<p class="leger-wrap">LEGER-TEXTE</p>', '<style>', '  .leger-wrap', '    color: tomato', '</style>', ''].join('\n'))
  writeFileSync(join(srcDir, 'hote.mjs'), ['<div class="hote-wrap">', '  <p class="hote-marque">HOTE-TEXTE</p>', '  <@carte>', '  <@leger mjs-light>', '</div>', '<style>', '  .hote-wrap', '    color: rebeccapurple', '</style>', ''].join('\n'))
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'src', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out',
    render: { default: 'prerender', engine: { prerender: moteur }, routes: { '/': { component: 'mjs-hote' } } },
  }, null, 2))
  return { root, srcDir, outDir }
}

// construit le projet PUIS prérend, comme `mjs build` : même environnement pour les deux passes
async function prerendre(p: Projet, env: Env): Promise<string> {
  const found = findConfig(p.root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const bundler = new Bundler({ ...resolveBundlerOpts(found!.config, found!.configDir), env } as any)
  const stats   = await bundler.compile()
  await bundler.close()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const report = await prerenderPages(found!.config, found!.configDir, () => {}, { env })
  assert.deepEqual(report.skipped, [], 'aucune page ne doit être sautée')
  const page = report.generated.find(g => g.url === '/')
  assert.ok(page, 'la page / doit être générée')
  return readFileSync(page!.file, 'utf-8')
}

function compter(texte: string, motif: RegExp): number {
  return (texte.match(motif) || []).length
}

async function chromiumDisponible(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  }
  catch {
    return false
  }
}

describe('prérendu — CSS scopé sous les noms courts de production', function () {
  this.timeout(180000)

  after(async () => { await terminateSharedWorkerPool() })

  for(const moteur of ['happy-dom', 'browser'] as Moteur[]) {
    for(const env of ['prod', 'dev'] as Env[]) {
      it(`moteur '${moteur}', ${env} — le fragment porte la feuille de chaque composant`, async function () {
        if(moteur === 'browser' && !(await chromiumDisponible())) this.skip()
        const texte     = await prerendre(fixture(`prod-css-${moteur}-${env}`, moteur), env)
        const templates = compter(texte, /<template shadowrootmode=/g)
        const feuilles  = compter(texte, /<style\b/g)
        assert.equal(templates, 2, `2 <template shadowrootmode> attendus (hote + carte, jamais leger) — fragment : ${texte}`)
        assert.equal(feuilles, 3, `3 feuilles attendues (hote, carte, leger aplati), vues ${feuilles} — les propriétés \`_mjs_*\` sont raccourcies en production : le rendu serveur ne doit plus les lire par leur nom`)
        assert.match(texte, /\.hote-wrap\s*\{/, 'la feuille de la racine doit voyager dans le fragment')
        assert.match(texte, /\.carte-wrap\s*\{/, 'la feuille du sous-composant à shadow doit voyager dans le fragment')
        assert.match(texte, /\.leger-wrap\s*\{/, 'la feuille du sous-composant light doit voyager avec son contenu aplati')
      })
    }
  }

  for(const env of ['prod', 'dev'] as Env[]) {
    it(`${env} — renderToString rend le CSS scopé de la racine dans \`css\``, async function () {
      const p        = fixture(`prod-css-champ-${env}`, 'happy-dom')
      const renderer = await createSSRRenderer({ sourceDir: p.srcDir, outputDir: p.outDir, manifestPath: join(p.outDir, 'bundle.js'), env })
      try {
        const res = await renderer.renderToString('mjs-hote')
        assert.match(res.css, /\.hote-wrap\s*\{/, 'le champ `css` du résultat doit porter la feuille scopée de la racine')
        assert.ok(!/<mjs-leger[^>]*><template/.test(res.html), `le sous-composant light ne doit porter AUCUN <template shadowrootmode> — HTML : ${res.html}`)
      }
      finally {
        await renderer.close()
      }
    })
  }
})
