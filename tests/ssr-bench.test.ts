// SSR — bench comparatif des stratégies de reprise en main, en vrai navigateur
// (Playwright). Mesure les nœuds DOM créés au boot pour chaque mode :
//   - render-then-replace (référence) : recrée toute la vue et la swappe.
//   - A (marqueurs)   : adopte via marqueurs, n'appelle pas factory → ~0 création.
//   - B (walk positionnel) / C (diff) : créent le fragment (factory) pour
//     connaître la structure, mais réutilisent le DOM serveur.
//
// Le bench est informatif (chiffres loggés) ; les assertions ne portent que sur
// les invariants robustes (rendu correct partout, A crée nettement moins que la
// référence).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { readdirSync, readFileSync } from 'node:fs'
import { chromium, type Browser } from 'playwright'
import { createSSRRenderer, type SSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

function readBundleScript(outputDir: string): string {
  const files = readdirSync(outputDir).filter(f => f.endsWith('.js'))
  const coreFile = files.find(f => /^mjs_core-/.test(f))!
  const coreCode = stripEsm(readFileSync(join(outputDir, coreFile), 'utf-8'))
  const comps = files
    .filter(f => f !== coreFile && f !== 'bundle.js')
    .map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8')))
    .join('\n')
  return `${coreCode}\nglobalThis.µ = µ;\n${comps}`
}

describe('SSR bench — reprise en main (Playwright)', () => {
  let browser: Browser | null = null
  let renderer: SSRRenderer | null = null
  let outDir = ''

  before(async function () {
    this.timeout(60000)
    browser = await chromium.launch()
    const root = mjsTmp('bench')
    const srcDir = join(root, 'src')
    outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // Composant « riche » sans blocs structurels : beaucoup d'éléments +
    // interpolations, pour que la création de nœuds soit mesurable.
    writeFileSync(join(srcDir, 'card.mjs'), `
<script lang="coffee">
$v = "X"
</script>
<div class="card">
  <h2>v={$v}</h2>
  <p>{$v}</p><p>{$v}</p><p>{$v}</p><p>{$v}</p><p>{$v}</p>
  <p>{$v}</p><p>{$v}</p><p>{$v}</p><p>{$v}</p><p>{$v}</p>
  <span class="s">{$v}</span><span class="s">{$v}</span><span class="s">{$v}</span>
</div>
`)
    // `runtime: ['hydrate']` : ce banc rend par l'API, sans bloc `render` d'où déduire un mode
    // d'hydratation — sans lui, le cœur construit ici n'embarque pas les approches d'adoption et
    // les trois modes comparés retomberaient tous sur « rendre puis remplacer »
    renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir, bundlerOpts: { runtime: ['hydrate'] } })
  })

  after(async () => {
    if (renderer) await renderer.close()
    if (browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('compare les nœuds DOM créés au boot : render-then-replace vs A / B / C', async function () {
    this.timeout(120000)
    const bundleScript = readBundleScript(outDir)
    const modes: Array<{ name: string; opt: any }> = [
      { name: 'render-then-replace', opt: { ssrMode: 'replace' } },
      { name: 'A (marqueurs)', opt: { ssrMode: 'markers' } },
      { name: 'B (walk positionnel)', opt: { ssrMode: 'positional' } },
      { name: 'C (diff léger)', opt: { ssrMode: 'diff' } },
    ]
    const results: Array<{ mode: string; created: number; ok: boolean }> = []

    for (const m of modes) {
      const { html, hydrateScript } = await renderer!.renderToString('mjs-card', m.opt)
      // Instrumentation de la création de nœuds, posée AVANT le bundle.
      const instr = `<script>
        window.__created = 0;
        var _ce = document.createElement.bind(document);
        document.createElement = function(t){ window.__created++; return _ce(t); };
        var _ct = document.createTextNode.bind(document);
        document.createTextNode = function(t){ window.__created++; return _ct(t); };
        var _cn = Node.prototype.cloneNode;
        Node.prototype.cloneNode = function(deep){
          var r = _cn.call(this, deep);
          window.__created += 1 + ((deep && r.querySelectorAll) ? r.querySelectorAll('*').length : 0);
          return r;
        };
      </` + `script>`
      const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${instr}
${hydrateScript || ''}
<script>${bundleScript}</script>
</body></html>`
      const page = await browser!.newPage()
      await page.setContent(pageHtml, { waitUntil: 'networkidle' })
      await page.waitForTimeout(80)
      const created = await page.evaluate(() => (window as any).__created as number)
      const ok = await page.evaluate(() => {
        const el = document.querySelector('mjs-card') as any
        return !!(el && el.shadowRoot && /v=X/.test(el.shadowRoot.textContent || ''))
      })
      results.push({ mode: m.name, created, ok })
      await page.close()
    }

    // Tableau comparatif (informatif).
    // eslint-disable-next-line no-console
    console.log('\n  === BENCH hydratation — nœuds DOM créés au boot (1 composant riche) ===')
    for (const r of results) {
      // eslint-disable-next-line no-console
      console.log(`    ${r.mode.padEnd(22)} : ${String(r.created).padStart(5)} nœuds  ${r.ok ? '✓ rendu OK' : '✗ RENDU KO'}`)
    }
    // eslint-disable-next-line no-console
    console.log('')

    // Invariants robustes.
    for (const r of results) {
      assert.ok(r.ok, `${r.mode} doit rendre correctement`)
    }
    const replace = results.find(r => /replace/.test(r.mode))!.created
    const a = results.find(r => /^A/.test(r.mode))!.created
    assert.ok(
      a < replace,
      `l'approche A (${a} nœuds) doit en créer nettement moins que render-then-replace (${replace})`,
    )
  })
})
