// Deux chemins d'attribut
// en `{for}` émettaient encore un `setAttribute` BRUT, contournant le filtre
// `µ._mjs_safeAttr` (blocage `javascript:`/`data:text/html`) alors que la branche
// dynamique NON filtrée (`href={item.url}`) était déjà routée par `µ._mjs_updAttrNode` :
//
//   1. Interpolation QUOTÉE `href="{item.url}"` (attributes/index.ts, branche for
//      de `interpolation()`) — données d'item, souvent distantes.
//   2. Fast-path ternaire FILTRÉ `href={item.id === $sel ? item.url : '#'}`
//      (dispatch filtered de `dynamic()`) — la valeur matchée partait en
//      `setAttribute(String(value))` nu.
//
// Les deux sont désormais routés par `µ._mjs_updAttrNode` → `µ._mjs_safeAttr`.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// Compile un composant unique, l'évalue dans un happy-dom isolé, monte
// `<mjs-NOM>` et rend l'élément hôte prêt à être introspecté (shadow).
async function buildAndMount(src: string, name: string): Promise<any> {
  const root   = mjsTmp(`xss-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), src)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return el
}

describe('µ._mjs_safeAttr en {for} — interpolation quotée & ternaire filtré (XSS)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('href="{item.url}" (interpolation QUOTÉE) avec javascript: : neutralisée', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1, url: "javascript:alert(1)"}, {id:2, url: "https://ok.example/"}]',
      '</script>',
      '<ul>{for row in $rows}<li><a href="{row.url}">x</a></li>{end}</ul>',
    ].join('\n')

    const el = await buildAndMount(src, 'xssinterp')
    const links = el._shadow.querySelectorAll('a')
    assert.equal(links.length, 2)
    assert.notEqual(links[0].getAttribute('href'), 'javascript:alert(1)', 'AVANT le fix : setAttribute brut → javascript: écrit')
    assert.equal(links[0].getAttribute('href'), '', 'valeur dangereuse bloquée, placeholder vide conservé')
    assert.equal(links[1].getAttribute('href'), 'https://ok.example/', 'URL légitime : passe normalement')
  })

  it("href={item.id === $sel ? item.url : '#'} (ternaire FILTRÉ) avec javascript: : neutralisée", async () => {
    const src = [
      '<script lang="coffee">',
      '$sel = 1',
      '$rows = [{id:1, url: "javascript:alert(1)"}, {id:2, url: "https://ok.example/"}]',
      '</script>',
      "<ul>{for row in $rows}<li><a href={row.id === $sel ? row.url : '#'}>x</a></li>{end}</ul>",
    ].join('\n')

    const el = await buildAndMount(src, 'xssternary')
    const links = el._shadow.querySelectorAll('a')
    assert.equal(links.length, 2)
    // row 1 : id===sel → branche MATCH → href = row.url (javascript:) → doit être bloqué.
    assert.notEqual(links[0].getAttribute('href'), 'javascript:alert(1)', 'AVANT le fix : branche match → setAttribute(String(url)) nu → javascript: écrit')
    assert.equal(links[0].getAttribute('href'), '', 'valeur dangereuse bloquée, placeholder vide conservé')
    // row 2 : id!==sel → branche UNMATCH → href = '#'.
    assert.equal(links[1].getAttribute('href'), '#', "branche unmatch : '#' posé normalement")
  })
})
