// SSR — volet CŒUR (vrai navigateur) : le cycle « render-then-replace »
// complet, validé dans Chromium (Playwright) qui parse nativement le Declarative
// Shadow DOM (impossible en happy-dom).
//
// Scénario : on génère le HTML serveur (renderToString), on construit une page
// complète (DSD + bundle), Chromium la parse → le composant adopte le shadow du
// serveur, vide la « photo », reconstruit la vraie vue (swap) et reprend la main.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { chromium, type Browser } from 'playwright'
import { createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

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

describe('SSR adoption DSD — cycle complet en vrai navigateur (Playwright)', () => {
  let browser: Browser | null = null

  before(async function () {
    this.timeout(60000)
    browser = await chromium.launch()
  })

  after(async () => {
    if (browser) await browser.close()
    await terminateSharedWorkerPool()
  })

  it('adopte le shadow serveur, swap la vue, reprend la main (interactif)', async function () {
    this.timeout(60000)
    const root = mjsTmp('ssr-pw')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'counter.mjs'), `
<script lang="coffee">
$count = 0
incr = => $count = $count + 1
</script>
<button @click={incr()}>Count: {$count}</button>
`)

    // 1. Rendu serveur → HTML avec DSD.
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html } = await renderer.renderToString('mjs-counter')
    await renderer.close()
    assert.match(html, /shadowrootmode="open"/, 'le HTML serveur doit contenir un DSD')
    assert.match(html, /Count: 0/, 'le HTML serveur doit être pré-rendu')

    // 2. Page complète : le DSD d'abord (parsé → shadow attaché), puis le bundle
    //    (define → upgrade → le constructor voit le shadow → adoption).
    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
<script>${bundleScript}</script>
</body></html>`

    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    // Laisse la microtask de premier rendu + le swap s'effectuer.
    await page.waitForTimeout(80)

    // 3a. Le composant a-t-il ADOPTÉ le shadow du serveur ?
    const adopted = await page.evaluate(() => {
      const el = document.querySelector('mjs-counter') as any
      return el && el._mjs_ssrAdopt === true
    })
    assert.equal(adopted, true, 'le composant doit avoir adopté le DSD serveur (_mjs_ssrAdopt)')

    // 3b. Swap correct : la photo a été remplacée par la vraie vue, SANS doublon.
    //     (shadowRoot accessible car le DSD/shadow est en mode "open".)
    const view = await page.evaluate(() => {
      const el = document.querySelector('mjs-counter') as any
      const btns = el.shadowRoot.querySelectorAll('button')
      return { count: btns.length, text: btns[0] ? btns[0].textContent : null }
    })
    assert.equal(view.count, 1, 'un seul <button> (pas de doublon photo + vue)')
    assert.match(view.text ?? '', /Count: 0/, 'la vue reflète l\'état initial')

    // 3c. Interactivité reprise : un vrai clic incrémente.
    await page.evaluate(() => {
      const el = document.querySelector('mjs-counter') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const after = await page.evaluate(() => {
      const el = document.querySelector('mjs-counter') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(after ?? '', /Count: 1/,
      'après clic, le compteur passe à 1 → interactivité opérationnelle après reprise en main')

    await page.close()
  })

  it('prop OBJET : survit au cycle complet serveur → client (swap + mutation)', async function () {
    this.timeout(60000)
    const root = mjsTmp('ssr-pw-obj')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'card.mjs'), `
<script lang="coffee">
incr = => $item = { label: $item.label, n: $item.n + 1 }
</script>
<button @click={incr()}>{$item.label}: {$item.n}</button>
`)

    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html } = await renderer.renderToString('mjs-card', { props: { item: { label: 'Compteur', n: 5 } } })
    await renderer.close()
    assert.match(html, /Compteur: 5/, 'rendu serveur avec la prop objet (JSON)')

    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    // La prop objet a été ré-hydratée côté client (sinon $item serait undefined).
    const text0 = await page.evaluate(() => {
      const el = document.querySelector('mjs-card') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(text0 ?? '', /Compteur: 5/, 'prop objet ré-hydratée côté client après le swap')

    // Mutation de la prop objet via un clic.
    await page.evaluate(() => {
      const el = document.querySelector('mjs-card') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const text1 = await page.evaluate(() => {
      const el = document.querySelector('mjs-card') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(text1 ?? '', /Compteur: 6/, 'la mutation de la prop objet fonctionne après reprise en main')

    await page.close()
  })

  it('store global $$ : réhydraté au boot client (inline, façon __NUXT__)', async function () {
    this.timeout(60000)
    const root = mjsTmp('ssr-pw-store')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'banner.mjs'), `
<script lang="coffee">
</script>
<div class="g">Bonjour {$$user}</div>
`)
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir })
    const { html, sharedScript } = await renderer.renderToString('mjs-banner', { store: { user: 'Ada' } })
    await renderer.close()
    assert.match(html, /Bonjour Ada/, 'rendu serveur avec $$')
    assert.match(sharedScript, /Ada/, 'script d\'état global produit')

    // Le sharedScript est placé AVANT le bundle → mjs_init le réhydrate au boot.
    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${sharedScript}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    // Après reprise en main, le composant relit $$user depuis µ.store réhydraté
    // (sinon, sans réhydratation, le contenu reconstruit serait « Bonjour  »).
    const text = await page.evaluate(() => {
      const el = document.querySelector('mjs-banner') as any
      return el.shadowRoot.querySelector('.g').textContent
    })
    assert.match(text ?? '', /Bonjour Ada/, '$$ réhydraté côté client au boot')

    await page.close()
  })

  it('hydratation A (marqueurs) : adopte les nœuds serveur + reste interactif', async function () {
    this.timeout(60000)
    const root = mjsTmp('hydA')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'cnt.mjs'), `
<script lang="coffee">
$count = 5
incr = => $count = $count + 1
</script>
<button class="cnt" @click={incr()}>compteur : {$count}</button>
`)
    // `runtime: ['hydrate']` : ce rendu par l'API n'a aucun bloc `render` d'où déduire un mode
    // d'hydratation — sans lui, le cœur construit ici n'embarque pas les approches d'adoption
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir, bundlerOpts: { runtime: ['hydrate'] } })
    const { html, hydrateScript } = await renderer.renderToString('mjs-cnt', { ssrMode: 'markers' })
    await renderer.close()
    // Marqueurs présents dans le HTML serveur + flag d'activation produit.
    assert.match(html, /mjs-h=/, 'le HTML serveur doit porter des marqueurs d\'hydratation (mjs-h)')
    assert.match(hydrateScript, /__mjs_ssrHydrate/, 'un flag d\'activation client est produit')

    const bundleScript = readBundleScript(outDir)
    // hydrateScript AVANT le bundle (mjs_init lit le flag au boot).
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${hydrateScript}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    // a. Le composant a été HYDRATÉ par adoption (et non recréé).
    const hydrated = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el && el._mjs_hydrated === true
    })
    assert.equal(hydrated, true, 'le composant doit être hydraté par adoption (_mjs_hydrated)')

    // b. Les marqueurs ont été nettoyés du DOM final.
    const leftover = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('[mjs-h]') ? 'reste' : 'propre'
    })
    assert.equal(leftover, 'propre', 'les attributs mjs-h doivent être retirés après hydratation')

    // c. Interactivité sur le nœud adopté : le clic incrémente.
    const t0 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(t0 ?? '', /compteur : 5/, 'état initial conservé')
    await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const t1 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(t1 ?? '', /compteur : 6/, 'interactivité opérationnelle après hydratation par adoption')

    await page.close()
  })

  it('hydratation B (walk positionnel) : adopte sans marqueurs + reste interactif', async function () {
    this.timeout(60000)
    const root = mjsTmp('hydB')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'cnt.mjs'), `
<script lang="coffee">
$count = 5
incr = => $count = $count + 1
</script>
<button class="cnt" @click={incr()}>compteur : {$count}</button>
`)
    // `runtime: ['hydrate']` : ce rendu par l'API n'a aucun bloc `render` d'où déduire un mode
    // d'hydratation — sans lui, le cœur construit ici n'embarque pas les approches d'adoption
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir, bundlerOpts: { runtime: ['hydrate'] } })
    const { html, hydrateScript } = await renderer.renderToString('mjs-cnt', { ssrMode: 'positional' })
    await renderer.close()
    // Approche B : HTML PROPRE (aucun marqueur), le mode 'b' porté par le flag.
    assert.doesNotMatch(html, /mjs-h=/, 'approche B : pas de marqueurs dans le HTML serveur')
    assert.match(hydrateScript, /"b"/, 'le flag d\'activation porte le mode b')

    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${hydrateScript}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    const hydrated = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el && el._mjs_hydrated === true
    })
    assert.equal(hydrated, true, 'le composant doit être hydraté par walk positionnel (_mjs_hydrated)')

    // Regex ANCRÉE (`$`) : une regex non ancrée `/compteur : 5/` matcherait
    // aussi bien « compteur : 55 » — un duplicat serveur+client (nœud orphelin
    // après splitText(0) sur placeholder vide) passerait inaperçu.
    const t0 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match((t0 ?? '').trim(), /compteur : 5$/, 'état initial conservé, sans duplication')
    await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const t1 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match((t1 ?? '').trim(), /compteur : 6$/, 'interactivité opérationnelle après walk positionnel, sans duplication')

    await page.close()
  })

  it('hydratation B (walk positionnel) : texte serveur fusionné statique+dynamique, aucune duplication (régression)', async function () {
    this.timeout(60000)
    const root = mjsTmp('hydB-merge')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    // Le parseur HTML fusionne le text node statique « compteur : » et le
    // placeholder dynamique « 5 » en UN SEUL text node serveur. Côté fragment
    // client (factory), le placeholder est encore VIDE (rempli au 1er effect
    // seulement) → deux text nodes distincts, l'un vide. Le walk positionnel
    // doit réaligner ça SANS laisser de reliquat texte orphelin.
    writeFileSync(join(srcDir, 'cnt.mjs'), `
<script lang="coffee">
$count = 5
incr = => $count = $count + 1
</script>
<button class="cnt" @click={incr()}>compteur : {$count}</button>
`)
    // `runtime: ['hydrate']` : ce rendu par l'API n'a aucun bloc `render` d'où déduire un mode
    // d'hydratation — sans lui, le cœur construit ici n'embarque pas les approches d'adoption
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir, bundlerOpts: { runtime: ['hydrate'] } })
    const { html, hydrateScript } = await renderer.renderToString('mjs-cnt', { ssrMode: 'positional' })
    await renderer.close()
    assert.match(html, /compteur : 5/, 'le HTML serveur doit contenir le texte fusionné statique+dynamique')

    const bundleScript = readBundleScript(outDir)
    // Tampon posé AVANT le bundle, sur le <button> serveur : sert à prouver
    // l'ADOPTION (même objet, pas une reconstruction) après hydratation.
    const probe = `<script>
      (function() {
        var el  = document.querySelector('mjs-cnt');
        var btn = el && el.shadowRoot && el.shadowRoot.querySelector('button');
        if (btn) btn.__mjs_stamp_serveur = true;
      })();
    </` + `script>`
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${hydrateScript}
${probe}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    const t0 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      const btn = el.shadowRoot.querySelector('button')
      return { text: btn.textContent, count: el.shadowRoot.querySelectorAll('button').length, stamped: btn.__mjs_stamp_serveur === true }
    })
    assert.equal((t0.text ?? '').trim(), 'compteur : 5', 'texte STRICTEMENT « compteur : 5 », aucune duplication (ex. « compteur : 55 »)')
    assert.equal(t0.count, 1, 'un seul <button> (pas de doublon photo + vue)')
    assert.equal(t0.stamped, true, 'le <button> hydraté est bien le même objet que le <button> serveur (adoption, pas reconstruction)')

    await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const t1 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      const btn = el.shadowRoot.querySelector('button')
      return { text: btn.textContent, stamped: btn.__mjs_stamp_serveur === true }
    })
    assert.equal((t1.text ?? '').trim(), 'compteur : 6', 'après clic, toujours aucune duplication')
    assert.equal(t1.stamped, true, 'toujours le même <button> après interaction')

    await page.close()
  })

  it('hydratation C (diff léger) : adopte sans marqueurs + reste interactif', async function () {
    this.timeout(60000)
    const root = mjsTmp('hydC')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'cnt.mjs'), `
<script lang="coffee">
$count = 5
incr = => $count = $count + 1
</script>
<button class="cnt" @click={incr()}>compteur : {$count}</button>
`)
    // `runtime: ['hydrate']` : ce rendu par l'API n'a aucun bloc `render` d'où déduire un mode
    // d'hydratation — sans lui, le cœur construit ici n'embarque pas les approches d'adoption
    const renderer = await createSSRRenderer({ sourceDir: srcDir, outputDir: outDir, bundlerOpts: { runtime: ['hydrate'] } })
    const { html, hydrateScript } = await renderer.renderToString('mjs-cnt', { ssrMode: 'diff' })
    await renderer.close()
    assert.doesNotMatch(html, /mjs-h=/, 'approche C : pas de marqueurs dans le HTML serveur')
    assert.match(hydrateScript, /"c"/, 'le flag d\'activation porte le mode c')

    const bundleScript = readBundleScript(outDir)
    const pageHtml = `<!doctype html><html><head><meta charset="utf-8"></head><body>
${html}
${hydrateScript}
<script>${bundleScript}</script>
</body></html>`
    const page = await browser!.newPage()
    await page.setContent(pageHtml, { waitUntil: 'networkidle' })
    await page.waitForTimeout(80)

    const hydrated = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el && el._mjs_hydrated === true
    })
    assert.equal(hydrated, true, 'le composant doit être hydraté par diff (_mjs_hydrated)')

    const t0 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(t0 ?? '', /compteur : 5/, 'état initial conservé')
    await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      el.shadowRoot.querySelector('button').click()
    })
    await page.waitForTimeout(50)
    const t1 = await page.evaluate(() => {
      const el = document.querySelector('mjs-cnt') as any
      return el.shadowRoot.querySelector('button').textContent
    })
    assert.match(t1 ?? '', /compteur : 6/, 'interactivité opérationnelle après diff')

    await page.close()
  })
})
