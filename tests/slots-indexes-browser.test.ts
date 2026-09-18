// Slots indexés `<@slot {i}/>` dans un {for} (mjs_slots.ts, `_mjs_injectSlots`) montés dans un
// Chromium RÉEL, projet construit avec `runtime: []` : la brique n'entre au cœur que parce que le
// code compilé l'appelle. Chromium et pas happy-dom : `_mjs_injectSlots` tourne au constructeur, et
// seul un vrai navigateur construit par MISE À NIVEAU un élément déjà présent dans la page (script
// chargé après le HTML) avec ses enfants en place — happy-dom construit toujours l'élément avant
// d'y attacher ses enfants, l'index n'y serait jamais posé.
//
// Garde de disponibilité — même motif que tests/lightdom-imbrique-css-browser.test.ts : Chromium
// absent → skip propre.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { findConfig, resolveBundlerOpts } from '../src/bundler/config.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function isChromiumAvailable(): Promise<boolean> {
  try {
    const playwright = await import('playwright')
    return existsSync(playwright.chromium.executablePath())
  } catch {
    return false
  }
}

describe('slots indexés (Chromium réel) — `_mjs_injectSlots` joint à l\'usage', function () {
  this.timeout(60000)
  let chromiumReady = false

  before(async function () {
    this.timeout(10000)
    chromiumReady = await isChromiumAvailable()
    if (!chromiumReady) {
      console.log('  ℹ️  Chromium non installé, test des slots indexés skippé. Activer : `npx playwright install chromium`')
    }
  })

  after(async () => { await terminateSharedWorkerPool() })

  it('{for} de `<@slot {i}/>` : chaque enfant sans attribut reçoit slot="N" et atterrit dans son slot ; slot par défaut : enfants intacts', async function () {
    if (!chromiumReady) { this.skip(); return }
    const { chromium } = await import('playwright')
    const root   = mjsTmp('slots-browser')
    const srcDir = join(root, 'app/modularjs')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'onglets.mjs'), ['<script>', '$tabs = [\'a\', \'b\']', '</script>', '<div class="grille">{for i, t in $tabs}<div class="case"><@slot {i}/></div>{end}</div>'].join('\n'))
    writeFileSync(join(srcDir, 'boite.mjs'), '<div class="cadre"><@slot/></div>\n')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js', runtime: [] }))
    const found = findConfig(root)
    assert.ok(found, 'mjs.config.json doit être trouvé')
    const bundler = new Bundler(resolveBundlerOpts(found!.config, found!.configDir) as any)
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files    = readdirSync(outDir).filter((f) => f.endsWith('.js'))
    const coreFile = files.find((f) => /^mjs_core-/.test(f))!
    const comps    = files.filter((f) => /^(onglets|boite)-[a-f0-9]{8}\.js$/.test(f)).map((f) => stripEsm(readFileSync(join(outDir, f), 'utf-8')))
    assert.equal(comps.length, 2, `composants attendus dans : ${files.join(', ')}`)
    const script   = `${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${comps.join('\n')}`
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body><mjs-onglets><p class="c">un</p><p class="c">deux</p><p class="c" slot="0">garde</p></mjs-onglets><mjs-boite><p class="d">libre</p></mjs-boite><script>${script}</script></body></html>`

    const browser = await chromium.launch()
    try {
      const page = await browser.newPage()
      await page.setContent(pageHtml, { waitUntil: 'load' })
      await page.waitForTimeout(200)
      const result = await page.evaluate(() => {
        const onglets: any   = document.querySelector('mjs-onglets')
        const boite: any     = document.querySelector('mjs-boite')
        const slot1: any     = onglets._shadow.querySelector('slot[name="1"]')
        const parDefaut: any = boite._shadow.querySelector('slot:not([name])')
        return {
          erreurs:    document.querySelectorAll('.mjs-error').length,
          attributs:  Array.from(onglets.querySelectorAll('.c')).map((c: any) => c.getAttribute('slot')),
          nbIndexes:  onglets._shadow.querySelectorAll('slot[name]').length,
          dansSlot1:  slot1 ? slot1.assignedElements().map((e: any) => e.textContent) : null,
          libreAttr:  boite.querySelector('.d').hasAttribute('slot'),
          parDefaut:  parDefaut ? parDefaut.assignedElements().map((e: any) => e.textContent) : null
        }
      })
      assert.equal(result.erreurs, 0, 'aucun composant en erreur')
      assert.deepEqual(result.attributs, ['0', '1', '0'], 'index posé sur les enfants sans attribut, attribut existant gardé')
      assert.equal(result.nbIndexes, 2, 'un slot indexé par ligne du {for}')
      assert.deepEqual(result.dansSlot1, ['deux'], 'le second enfant atterrit dans le slot 1')
      assert.equal(result.libreAttr, false, 'slot par défaut : aucun attribut posé')
      assert.deepEqual(result.parDefaut, ['libre'], 'le navigateur route seul l\'enfant dans le slot par défaut')
    } finally {
      await browser.close()
    }
  })
})
