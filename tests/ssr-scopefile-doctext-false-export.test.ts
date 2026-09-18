// Test de régression — découvert en testant un vrai projet en conditions réelles :
// `ssrScopeFile` (renderToString.ts) détecte les exports d'un fichier compilé
// via une regex qui scanne du TEXTE, pas une vraie grammaire JS — un
// "risque mineur" documenté et explicitement ACCEPTÉ à l'origine ("chaîne
// littérale ressemblant à un import/export").
//
// **Reproduit sur un vrai projet** : une page de DOCUMENTATION (sans AUCUN
// `<script>`) qui affiche, dans son template, la phrase « Svelte impose le
// mot-clé `export function clear()` » — texte 100% inerte, juste une
// explication pour le lecteur — était matchée par le regex d'export comme si
// `clear` était réellement exporté. `ssrScopeFile` émettait alors
// `return { clear };` en fin d'IIFE pour un nom JAMAIS déclaré dans le vrai
// code → `ReferenceError: clear is not defined` À L'ÉVAL, faisant échouer
// TOUT le rendu du bundle SSR concaténé — pas seulement la page fautive :
// UN SEUL throw dans le `window.eval()` géant avorte le rendu de N'IMPORTE
// QUELLE page du même projet, y compris des pages totalement indépendantes.
//
// Fix : masquer chaînes/template literals AVANT les regex import/export
// (même technique que compile.ts et lintSingletonConsume), avec une
// exception pour la chaîne d'URL après `from` (nécessaire à la résolution
// des VRAIS imports) — restaurer le texte original ensuite.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR — ssrScopeFile ne confond plus un export MENTIONNÉ EN TEXTE avec un vrai export', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  it("page de DOC sans <script>, qui affiche « export function clear() » en texte : le rendu réussit (AVANT : ReferenceError)", async function () {
    const root = mjsTmp('ssr-doctext')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // Répro EXACTE d'un cas réel rencontré :
    // AUCUN <script>, juste du texte de doc mentionnant une syntaxe JS.
    writeFileSync(join(srcDir, 'doc.mjs'), `
<div class="text">
  <p>Là où Svelte impose le mot-clé <code>export function clear()</code> pour exposer une méthode publique, MJS n'en a pas besoin.</p>
</div>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-doc' })
    assert.match(res.html, /Svelte impose le mot-clé/,
      "AVANT le fix : `ReferenceError: clear is not defined` à l'éval — plus AUCUN rendu (même pages sans rapport) ne fonctionnait")
    // Le texte affiché doit rester INTACT (la restauration ne doit RIEN perdre).
    assert.match(res.html, /export function clear\(\)/,
      'le texte de doc affiché doit survivre verbatim (la restauration après masquage ne doit rien altérer)')
  })

  it("un DEUXIÈME composant du MÊME projet (sans rapport avec la doc) n'est plus non plus affecté", async function () {
    const root = mjsTmp('ssr-doctext2')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'doc.mjs'), `<p>Exemple : <code>export function clear() {}</code></p>`)
    writeFileSync(join(srcDir, 'other.mjs'), `
<script lang="coffee">
$titre = "Page indépendante"
</script>
<h1 class="t">{$titre}</h1>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-other' })
    assert.match(res.html, /Page indépendante/,
      "AVANT le fix : le throw provoqué par doc.mjs (concaténé dans le MÊME window.eval()) faisait " +
      "échouer le rendu de CE composant aussi, bien qu'il n'ait aucun rapport avec la doc fautive")
  })

  it("un VRAI export (fonction déclarée) continue d'être détecté et fonctionne normalement (pas de régression)", async function () {
    const root = mjsTmp('ssr-realexport')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'tint.module.civet'), `export tint := -> 'ROUGE'\n`)
    writeFileSync(join(srcDir, 'page.mjs'), `@import tint 'tint.module.civet'\n\n<p class="r">{tint()}</p>\n`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-page' })
    assert.match(res.html, /ROUGE/, 'un VRAI export cross-module doit toujours fonctionner')
  })

  it("`@import default` d'un module local (export défaut) : SSR round-trip complet (AVANT : SyntaxError)", async function () {
    const root = mjsTmp('ssr-import-default')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // Module à EXPORT DÉFAUT (civet) — versant export : `export default fn` laissait
    // une fonction anonyme en statement après retrait du mot-clé → "Function
    // statements require a function name", et n'exposait jamais le défaut.
    writeFileSync(join(srcDir, 'greet.module.civet'), `export default -> 'BONJOUR-DEFAUT'\n`)
    // Composant qui l'importe via `@import default` (compile en `import greet from
    // '...'`) — versant import : cette forme n'était NI destructurée NI retirée →
    // `import` orphelin jusqu'à l'éval → SyntaxError avortant TOUT le bundle SSR.
    writeFileSync(join(srcDir, 'page.mjs'), `@import default greet 'greet.module.civet'\n\n<p class="g">{greet()}</p>\n`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-page' })
    assert.match(res.html, /BONJOUR-DEFAUT/,
      "AVANT le fix : `import greet from '...'` (défaut) survivait à l'éval → SyntaxError, ET le module n'exposait pas son `export default` → `.default` undefined")
  })

  it("un VRAI import cross-module survit au masquage (l'URL après `from` n'est pas masquée)", async function () {
    const root = mjsTmp('ssr-realimport')
    const srcDir = join(root, 'src')
    mkdirSync(srcDir, { recursive: true })
    // Le composant MENTIONNE aussi "from" en texte libre (piège potentiel :
    // masquer par erreur l'URL réelle si le masquage était trop agressif).
    writeFileSync(join(srcDir, 'tint.module.civet'), `export tint := -> 'BLEU'\n`)
    writeFileSync(join(srcDir, 'page.mjs'), `
<script lang="coffee">
</script>
@import tint 'tint.module.civet'
<p class="txt">Cette couleur vient from un module externe.</p>
<p class="r">{tint()}</p>
`)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-page' })
    assert.match(res.html, /BLEU/,
      "un texte libre mentionnant 'from' ne doit pas interférer avec l'import réel")
  })
})
