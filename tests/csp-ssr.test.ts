// Volet RENDU SERVEUR de `csp: true` : sous ce mode, le HTML sérialisé ne
// contient plus AUCUN `<style>` inline, attribut `style=`, ni `<script>` sans `src` — le CSS sort
// en `<link>`, le drapeau d'hydratation par un attribut du nœud racine (`data-mjs-ssr-hydrate`,
// relu par mjs_init.ts au boot). `csp` absent (défaut) : sortie BYTE-identique à avant.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { renderToString } from '../src/server/renderToString.js'
import { findConfig } from '../src/bundler/config.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp, sweepRegistered } from './helpers/tmp.js'

after(() => sweepRegistered())

// composant partagé : un peu de style, un peu d'état (pour activer une hydratation non-'replace').
function writeComponent(srcDir: string): void {
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
}

describe('csp ssr — rendu serveur sous csp: true', function () {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('aucun <style> ni attribut style= dans le HTML rendu ; le CSS sort en <link>', async function () {
    this.timeout(30000)
    const root   = mjsTmp('csp-ssr-style')
    const srcDir = join(root, 'src')
    writeComponent(srcDir)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-greet', css: 'split', csp: true })

    assert.doesNotMatch(res.html, /<style/, 'aucun <style> inline sous csp')
    assert.doesNotMatch(res.html, /\sstyle="/, 'aucun attribut style= sous csp')
    assert.match(res.html, /<link rel="stylesheet" href="[^"]+\.css">/, 'le CSS sort en <link>')
    assert.match(res.html, /Bonjour Monde/, 'le rendu reste correct')
  })

  it('aucun <script> sans src dans le HTML rendu ; le drapeau d\'hydratation est un attribut', async function () {
    this.timeout(30000)
    const root   = mjsTmp('csp-ssr-hydrate')
    const srcDir = join(root, 'src')
    writeComponent(srcDir)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-greet', css: 'split', csp: true, ssrMode: 'positional' })

    // aucun <script> sans src — hydrateScript doit rester vide sous csp
    assert.equal(res.hydrateScript, '', 'sous csp, le flag ne voyage plus par un <script> inline')
    assert.doesNotMatch(res.html, /<script(?![^>]*\ssrc=)/, 'aucun <script> sans src dans le HTML')
    // le drapeau vit dans un attribut du nœud racine, avec le mode dispatché ('positional' → 'b')
    assert.match(res.html, /<mjs-greet[^>]*\sdata-mjs-ssr-hydrate="b"/, 'le drapeau d\'hydratation est posé en attribut')
  })

  it('mode replace : aucun mode d\'hydratation à signaler, aucun attribut posé', async function () {
    this.timeout(30000)
    const root   = mjsTmp('csp-ssr-replace')
    const srcDir = join(root, 'src')
    writeComponent(srcDir)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-greet', css: 'split', csp: true, ssrMode: 'replace' })

    assert.equal(res.hydrateScript, '')
    assert.doesNotMatch(res.html, /data-mjs-ssr-hydrate/, 'ssr:replace ne pose aucun drapeau, csp ou non')
  })

  it('csp absent (défaut) : sortie IDENTIQUE à avant — <style> inline, script inline pour l\'hydratation', async function () {
    this.timeout(30000)
    const root   = mjsTmp('csp-ssr-defaut')
    const srcDir = join(root, 'src')
    writeComponent(srcDir)

    const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-greet', ssrMode: 'positional' })

    assert.match(res.html, /<style>[\s\S]*tomato[\s\S]*<\/style>/, 'le CSS reste inline hors csp')
    assert.doesNotMatch(res.html, /<link rel="stylesheet"/, 'aucun <link> hors csp')
    assert.doesNotMatch(res.html, /data-mjs-ssr-hydrate/, 'aucun attribut d\'hydratation hors csp')
    assert.match(res.hydrateScript, /<script>window\.__mjs_ssrHydrate="b"<\/script>/, 'le flag reste un script inline hors csp')
  })

  // SABOTAGE réel — recopie renderToString.ts avec une garde retirée, importe la copie (chemins
  // relatifs inchangés, elle vit à côté de l'original), rend pour de vrai sous csp: true, prouve
  // que l'assertion structurante rougit alors — puis efface la copie (finally).
  async function renderWithPatchedGuard(patch: (src: string) => string) {
    const { readFileSync, writeFileSync: write, unlinkSync } = await import('node:fs')
    const serverDir = new URL('../src/server/', import.meta.url)
    const original   = readFileSync(new URL('renderToString.ts', serverDir), 'utf-8')
    const patched    = patch(original)
    assert.notEqual(patched, original, 'le patch doit réellement modifier la source (sinon le sabotage est un no-op)')
    const sabotageName = `renderToString.__sabotage_${Date.now()}_${Math.random().toString(36).slice(2)}.ts`
    const sabotagePath = new URL(sabotageName, serverDir)
    write(sabotagePath, patched)
    try {
      const mod: any = await import(sabotagePath.href)
      return await mod.renderToString({ sourceDir: sourceDirForSabotage, tag: 'mjs-greet', css: 'split', csp: true, ssrMode: 'positional' })
    } finally {
      unlinkSync(sabotagePath)
    }
  }

  let sourceDirForSabotage: string
  before(() => {
    const root = mjsTmp('csp-ssr-sabotage-src')
    sourceDirForSabotage = join(root, 'src')
    writeComponent(sourceDirForSabotage)
  })

  it('SABOTAGE — neutraliser le mode strict sur l\'émetteur de feuille fait rougir l\'assertion "aucun <style>"', async function () {
    this.timeout(30000)
    const res = await renderWithPatchedGuard(src => {
      const needle = 'const feuille: FeuilleBalise = cspStrict'
      if (!src.includes(needle)) throw new Error('point de garde style introuvable — sabotage à revoir')
      return src.replace(needle, 'const feuille: FeuilleBalise = (false as boolean)')
    })
    assert.throws(() => {
      assert.doesNotMatch(res.html, /<style/, 'aucun <style> inline sous csp')
    }, /aucun <style> inline sous csp/, 'sans la garde csp, un <style> inline est bel et bien présent — le test l\'attrape')
  })

  it('SABOTAGE — retirer la garde du mode strict sur le drapeau d\'hydratation fait rougir l\'assertion sur l\'attribut', async function () {
    this.timeout(30000)
    const res = await renderWithPatchedGuard(src => {
      const needle = "if (cspStrict) {\n          attrs += ` data-mjs-ssr-hydrate=\"${_mode}\"`"
      if (!src.includes(needle)) throw new Error('point de garde hydratation introuvable — sabotage à revoir')
      return src.replace(needle, "if (false) {\n          attrs += ` data-mjs-ssr-hydrate=\"${_mode}\"`")
    })
    assert.throws(() => {
      assert.match(res.html, /<mjs-greet[^>]*\sdata-mjs-ssr-hydrate="b"/, 'le drapeau d\'hydratation est posé en attribut')
    }, /le drapeau d'hydratation est posé en attribut/, 'sans la garde csp, aucun attribut n\'est posé — le test l\'attrape')
  })

  it('couple refusé : csp: true + css: \'bundle\' — message de catalogue au chargement du config', () => {
    const root = mjsTmp('csp-bundle-refuse')
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ csp: true, css: 'bundle' }))
    assert.throws(() => findConfig(root), /csp: true est incompatible avec css: 'bundle'/,
      'le couple csp+bundle doit être refusé au chargement, message du catalogue fr')
  })
})
