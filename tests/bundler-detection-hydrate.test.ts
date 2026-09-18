// mjs_hydrate.ts (`_mjs_hydrate` + les trois approches d'adoption du DOM serveur : marqueurs,
// walk positionnel, diff), rattachées D'OFFICE au cœur jusqu'ici (méthodes de classe dans
// mjs_element.ts). Elles ne servent QUE si une page est rendue par le serveur dans un mode
// d'hydratation — `ssr:markers`, `ssr:positional`, `ssr:diff` — jamais en `csr`, `prerender` ni
// `ssr`/`ssr:replace` (le défaut « rendre puis remplacer », qui jette la photo serveur et
// reconstruit la vue). Signal : le bloc `render` de la configuration (`render.default` et le
// `mode` de chaque route), plus le forçage `runtime: ['hydrate']` pour un serveur qui rend par
// l'API sans bloc `render`.
//
// Filet : une page qui DEMANDE l'hydratation (drapeau posé par le serveur) alors que le cœur
// n'embarque pas le module ne casse pas — un avertissement, puis le chemin « rendre puis
// remplacer », qui rend la même vue.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { mjsTmp } from './helpers/tmp.js'

// patch de prototype de mjs_hydrate.ts, tel qu'écrit (build de développement : rien n'est
// minifié, le marqueur survit à l'identique)
const MARQUE_HYDRATE = 'µ.Element.prototype._mjs_hydrateA = function'

const SOURCES = { 'hop.mjs': '<script>\n$t = \'ok\'\n</script>\n<p>{$t}</p>\n' }

async function construire(cfgExtra: any, prefix = 'detect-hydrate'): Promise<string> {
  const root   = mjsTmp(prefix)
  const srcDir = join(root, 'app/modularjs')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const [name, content] of Object.entries(SOURCES)) writeFileSync(join(srcDir, name), content)
  writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({
    sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'out/bundle.js', urlPrefix: '/out', ...cfgExtra
  }))
  const found = findConfig(root)
  assert.ok(found, 'mjs.config.json doit être trouvé')
  const opts    = resolveBundlerOpts(found!.config, found!.configDir)
  const bundler = new Bundler(opts as any)
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  return outDir
}

function contenuCoeur(outDir: string): string {
  const coeur = readdirSync(outDir).find((f) => /^mjs_core-/.test(f))
  assert.ok(coeur, 'mjs_core-*.js doit exister')
  return readFileSync(join(outDir, coeur!), 'utf-8')
}

// cœur + composants d'un build 'split', concaténés en script CLASSIQUE (modèle :
// tests/ssr-adopt-browser.test.ts)
const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

function lireBundle(outputDir: string): string {
  const files    = readdirSync(outputDir).filter(f => f.endsWith('.js'))
  const coeur    = files.find(f => /^mjs_core-/.test(f))!
  const coreCode = stripEsm(readFileSync(join(outputDir, coeur), 'utf-8'))
  const comps    = files.filter(f => f !== coeur && f !== 'bundle.js').map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8'))).join('\n')
  return `${coreCode}\nglobalThis.µ = µ;\n${comps}`
}

async function chromiumDisponible(): Promise<any> {
  try {
    const playwright = await import('playwright')
    if(!existsSync(playwright.chromium.executablePath())) return null
    return await playwright.chromium.launch({ chromiumSandbox: false })
  }
  catch {
    return null
  }
}

describe('mjs_hydrate.ts — joint selon le bloc render, build RÉEL', function () {
  this.timeout(120000)

  after(async () => { await terminateSharedWorkerPool() })

  it('aucun bloc render : ABSENT', async function () {
    const coeur = contenuCoeur(await construire({}))
    assert.equal(coeur.includes(MARQUE_HYDRATE), false)
    assert.equal(coeur.includes('_mjs_walkAdopt'), false, 'aucune trace du module dans le cœur')
  })

  it("render.default: 'prerender' seul : ABSENT", async function () {
    const coeur = contenuCoeur(await construire({ render: { default: 'prerender', routes: { '/': { component: 'mjs-hop' } } } }))
    assert.equal(coeur.includes(MARQUE_HYDRATE), false)
  })

  it("render.default: 'ssr' (≡ ssr:replace, rendre puis remplacer) : ABSENT", async function () {
    const coeur = contenuCoeur(await construire({ render: { default: 'ssr', routes: { '/': { component: 'mjs-hop' } } } }))
    assert.equal(coeur.includes(MARQUE_HYDRATE), false)
  })

  it("render.default: 'ssr:markers' : PRÉSENT", async function () {
    assert.ok(contenuCoeur(await construire({ render: { default: 'ssr:markers', routes: { '/': { component: 'mjs-hop' } } } })).includes(MARQUE_HYDRATE))
  })

  it("render.default: 'ssr:positional' : PRÉSENT", async function () {
    assert.ok(contenuCoeur(await construire({ render: { default: 'ssr:positional', routes: { '/': { component: 'mjs-hop' } } } })).includes(MARQUE_HYDRATE))
  })

  it("une SEULE route en mode 'ssr:diff' (défaut prerender) : PRÉSENT", async function () {
    const cfg = { render: { default: 'prerender', routes: { '/': { component: 'mjs-hop' }, '/x': { component: 'mjs-hop', mode: 'ssr:diff' } } } }
    assert.ok(contenuCoeur(await construire(cfg)).includes(MARQUE_HYDRATE))
  })

  it("runtime: ['hydrate'] sans bloc render : présent quand même (explicite gagne)", async function () {
    assert.ok(contenuCoeur(await construire({ runtime: ['hydrate'] })).includes(MARQUE_HYDRATE))
  })
})

describe("mjs_hydrate.ts — page qui demande l'hydratation sans le module", function () {
  this.timeout(180000)
  let browser: any = null

  before(async function () {
    this.timeout(60000)
    browser = await chromiumDisponible()
    if(!browser) console.log('  ℹ️  Chromium non installé : montage sauté.')
  })

  after(async () => {
    if(browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('avertit UNE fois et rend quand même la vue (chemin « rendre puis remplacer »)', async function () {
    const root   = mjsTmp('hydrate-sans-module')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'carte.mjs'), '<script lang="coffee">\n$v = "X"\n</script>\n<div class="carte"><h2>v={$v}</h2><p>{$v}</p></div>\n')

    // rendu serveur en mode marqueurs : le HTML porte le DSD + le drapeau d'hydratation ; le
    // cœur construit ici n'a AUCUN bloc render, donc pas de module d'hydratation
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html, hydrateScript } = await renderer.renderToString('mjs-carte', { ssrMode: 'markers' } as any)
    await renderer.close()
    assert.ok(hydrateScript && hydrateScript.length > 0, 'le serveur doit poser le drapeau d\'hydratation')
    assert.equal(lireBundle(outDir).includes(MARQUE_HYDRATE), false, 'ce cœur ne doit pas porter le module')
    if(!browser) return

    const page               = await browser.newPage()
    const messages: string[] = []
    page.on('pageerror', (e: Error) => messages.push('pageerror: ' + e.message))
    page.on('console', (m: any) => messages.push(m.type() + ': ' + m.text()))
    try {
      await page.setContent(`<!doctype html><html><head><meta charset="utf-8"></head><body>\n${html}\n${hydrateScript}\n<script>${lireBundle(outDir)}</script>\n</body></html>`, { waitUntil: 'networkidle' })
      await page.waitForTimeout(150)
      // textes seulement (jamais un nœud dans une assertion) : le titre, le paragraphe, et le
      // nombre de titres — un doublon signalerait une photo serveur laissée en place
      const rendu = await page.evaluate(() => {
        const el = document.querySelector('mjs-carte') as any
        if(!el || !el.shadowRoot) return { titre: '(sans ombre)', p: '', titres: 0 }
        return {
          titre:  (el.shadowRoot.querySelector('h2')?.textContent ?? '').trim(),
          p:      (el.shadowRoot.querySelector('p')?.textContent ?? '').trim(),
          titres: el.shadowRoot.querySelectorAll('h2').length,
        }
      })
      assert.deepEqual(rendu, { titre: 'v=X', p: 'X', titres: 1 }, `la vue doit être rendue malgré tout — console : ${messages.join(' / ') || 'vide'}`)
      assert.equal(messages.some(m => m.includes('pageerror')), false, `aucune erreur de page : ${messages.join(' / ')}`)
      const avertissements = messages.filter(m => m.includes('hydratation demandée par la page'))
      assert.equal(avertissements.length, 1, `l'absence du module doit être signalée UNE fois — console : ${messages.join(' / ') || 'vide'}`)
    }
    finally {
      await page.close()
    }
  })
})
