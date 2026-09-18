// SSR — renderToString produit le HTML d'un composant en
// Declarative Shadow DOM (réactivité résolue, styles scopés inlinés).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString, createSSRRenderer } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString (render-then-replace)', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('rend un composant statique en Declarative Shadow DOM, styles inclus', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-static')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'greet.mjs'), `
<script lang="coffee">
$name = "Monde"
</script>
<p class="hello">Bonjour {$name}</p>
<style>
  .hello
    color: tomato
</style>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-greet' })

    // Wrapper Declarative Shadow DOM présent
    assert.match(res.html, /<mjs-greet[^>]*><template shadowrootmode="open">/,
      'le HTML doit envelopper le rendu dans un <template shadowrootmode="open">')
    // Le contenu est rendu, réactivité résolue ($name → "Monde")
    assert.match(res.html, /Bonjour Monde/, 'le binding {$name} doit être résolu')
    assert.match(res.shadowHtml, /class="hello"/, 'le markup du shadow doit être sérialisé')
    // Le CSS scopé est ré-inliné dans le DSD (adoptedStyleSheets → <style>)
    assert.match(res.html, /<style>[\s\S]*tomato[\s\S]*<\/style>/,
      'le CSS du composant doit être inliné dans le <template>')
    assert.equal(res.light, false, 'composant en mode shadow (pas light)')
  })

  it('résout un dérivé / interpolation au rendu serveur', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-derived')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'sum.mjs'), `
<script lang="coffee">
$a = 3
$b = 4
$total = $a + $b
</script>
<output class="r">{$a} + {$b} = {$total}</output>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-sum' })
    assert.match(res.html, /3 \+ 4 = 7/, 'le dérivé auto $total doit être calculé au rendu serveur')
  })

  it('réutilise un renderer pour plusieurs rendus (compile une fois)', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-reuse')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'box.mjs'), `
<script lang="coffee">
$label = "vide"
</script>
<div class="box">{$label}</div>
`)

    const renderer = await createSSRRenderer({ sourceDir: srcDir })
    try {
      const a = await renderer.renderToString('mjs-box')
      const b = await renderer.renderToString('mjs-box')
      assert.match(a.html, /vide/, 'rendu 1 OK')
      assert.match(b.html, /vide/, 'rendu 2 OK (renderer réutilisé)')
      // Isolation : deux rendus distincts, deux Window happy-dom
      assert.ok(a.html === b.html, 'deux rendus identiques pour les mêmes entrées')
    } finally {
      await renderer.close()
    }
  })

  it('rend une prop OBJET passée en JSON (attribut auto-ré-hydraté)', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-objprop')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'card.mjs'), `
<script lang="coffee">
</script>
<div class="card">{$item.name} — {$item.price}€</div>
`)
    const res = await renderToString({
      sourceDir: srcDir,
      tag: 'mjs-card',
      props: { item: { name: 'Stylo', price: 3 } },
    })
    assert.match(res.html, /Stylo — 3€/, 'la prop objet doit être ré-hydratée et rendue côté serveur')
    assert.match(res.html, /item=/, 'la prop objet voyage dans un attribut sur la balise')
  })

  it('attend la résolution d\'un {await} (rendu async fiable, pas de délai fixe)', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-async')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // La promesse résout à 100 ms — au-delà de l'ancien délai fixe (50 ms).
    // L'attente fiable doit patienter jusqu'à la résolution et rendre 'CHARGE'.
    writeFileSync(join(srcDir, 'async-box.mjs'), `
<script lang="coffee">
$p = new Promise((resolve) -> setTimeout((-> resolve("CHARGE")), 100))
</script>
{await $p}<span class="pending">chargement</span>{success val}<span class="done">{val}</span>{error err}<span class="err">erreur</span>{end}
`)
    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-async-box' })
    assert.match(res.html, /CHARGE/, 'le rendu doit attendre la résolution de la promesse {await} (>50 ms)')
    assert.doesNotMatch(res.html, /chargement/, 'le pending state ne doit pas subsister dans le rendu final')
  })

  it('l\'espace legacy µ.shared (option `shared`, transition finie) n\'est plus sérialisé', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-shared-gone')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'banner.mjs'), `
<script lang="coffee">
</script>
<div class="g">Bannière</div>
`)
    // Option `shared` retirée : passer une clé `shared` (résiduelle côté
    // appelant JS non typé) est un no-op silencieux, pas une erreur — et
    // n'écrit jamais de balise __mjs_shared.
    const res = await renderToString({
      sourceDir: srcDir,
      tag: 'mjs-banner',
      ...({ shared: { user: 'Ada' } } as object),
    })
    assert.doesNotMatch(res.sharedScript, /id="__mjs_shared"/, 'aucun <script> µ.shared legacy n\'est produit')
    assert.doesNotMatch(res.sharedScript, /Ada/, 'la clé `shared` fournie est ignorée, jamais sérialisée')
  })

  it('sérialise le store global $$ (µ.store) côté serveur', async function () {
    this.timeout(30000)
    const root = mjsTmp('ssr-store')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'banner.mjs'), `
<script lang="coffee">
</script>
<div class="g">Bonjour {$$user}</div>
`)
    const res = await renderToString({
      sourceDir: srcDir,
      tag: 'mjs-banner',
      store: { user: 'Ada' },
    })
    assert.match(res.html, /Bonjour Ada/, 'le rendu serveur lit le store global $$ injecté')
    assert.match(res.sharedScript, /id="__mjs_store"/, 'un <script> de store global est produit')
    assert.match(res.sharedScript, /Ada/, 'le script contient le store global sérialisé')
  })

  // FOOTGUN trouvé en vérifiant le passage aux options RÉSOLUES — sans
  // `outputDir`, le renderer possède un dossier TEMPORAIRE, supprimé à `close()`. Si `manifestPath`
  // pouvait alors venir de `bundlerOpts` (donc de `mjs.config.json`), un appelant qui suit la voie
  // recommandée (« passe les options résolues ») ÉCRASAIT un fichier réel du projet avec un
  // manifeste pointant vers des assets sur le point de disparaître.
  it('dossier temporaire + bundlerOpts : le manifestPath de la CONFIG n\'écrase pas le fichier du projet', async function () {
    this.timeout(30000)
    const root   = mjsTmp('ssr-manifest-temp')
    const srcDir = join(root, 'src')
    const distDir = join(root, 'dist')
    mkdirSync(srcDir, { recursive: true })
    mkdirSync(distDir, { recursive: true })
    writeFileSync(join(srcDir, 'box.mjs'), '<div class="b">ok</div>\n')
    const manifestProjet = join(distDir, 'bundle-officiel.js')
    writeFileSync(manifestProjet, '// MANIFESTE DU PROJET — ne doit pas bouger\n')

    const renderer = await createSSRRenderer({ sourceDir: srcDir, bundlerOpts: { manifestPath: manifestProjet } as any })
    try {
      await renderer.renderToString('mjs-box')
      assert.equal(readFileSync(manifestProjet, 'utf-8'), '// MANIFESTE DU PROJET — ne doit pas bouger\n',
        'le manifeste réel du projet doit être INTACT')
    } finally {
      await renderer.close()
    }
    assert.ok(existsSync(manifestProjet), 'et il doit toujours exister après close()')
  })
})
