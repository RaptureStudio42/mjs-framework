// Test de régression — port du tuto "snippets-render" sur le pattern
// sous-composant à attributs (équivalent MJS du snippet Svelte paramétré).
//
// Verrouille 3 comportements qui se sont stabilisés ensemble :
//
//   A. SELF-CLOSING des custom elements
//      Trois `<mjs-monkey emoji=… />` consécutifs doivent donner 3 instances
//      distinctes — pas un parent qui consume les frères. Le parser MJS doit
//      réécrire `<mjs-X />` en `<mjs-X></mjs-X>` AVANT que le parser HTML
//      naïf ne les nest.
//
//   B. ATTRIBUT HTML → $var SANS DÉCLARATION
//      Le composant `monkey` utilise `{$emoji}` / `{$description}` dans son
//      template sans aucun `<script>$emoji = ''</script>` : les attributs HTML
//      `emoji=` et `description=` doivent suffire à alimenter les variables
//      réactives (pas besoin d'un default vide juste pour les déclarer).
//
//   C. @display contents
//      Le custom element doit poser `display: contents` sur :host pour devenir
//      transparent au flow du parent (sinon avec un CSS grid à 4 colonnes, le
//      composant occupe 1 cellule au lieu de 4 — les enfants ne peuvent pas
//      participer au grid du parent).
//
// Ces 3 points sont les blocs de construction du nouveau tuto
// /tuto#/snippets-render (table monkey 🙈🙉🙊 portée en grid CSS).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

const MONKEY = `
<style @display="contents">
  .cell
    padding: 0.5em 0.8em
</style>

<div class="cell">{$emoji}</div>
<div class="cell">{$description}</div>
<div class="cell code">\\u{$emoji.charCodeAt(0).toString(16)}</div>
`

const GRID = `
<style>
  .grid
    display: grid
    grid-template-columns: max-content 1fr max-content
</style>

<div class="grid">
  <mjs-monkey emoji="🙈" description="see no evil" />
  <mjs-monkey emoji="🙉" description="hear no evil" />
  <mjs-monkey emoji="🙊" description="speak no evil" />
</div>
`

describe('snippets-render — sous-composant à attributs (port du snippet Svelte)', function () {
  this.timeout(40000)

  let win: any = null
  let el: any = null
  let monkeyBundle: string = ''

  before(async function () {
    const root = mjsTmp('snippets-render')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'monkey.mjs'), MONKEY)
    writeFileSync(join(srcDir, 'grid.mjs'), GRID)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    win = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const monkeyFile = files.find((f: string) => /^monkey-/.test(f))
    const gridFile = files.find((f: string) => /^grid-/.test(f))
    assert.ok(coreFile && monkeyFile && gridFile,
      `core + composants compilés. files: ${files.join(', ')}`)

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    monkeyBundle = readFileSync(join(outDir, monkeyFile!), 'utf-8')
    const monkeyCode = stripEsm(monkeyBundle)
    const gridCode = stripEsm(readFileSync(join(outDir, gridFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${monkeyCode}\n${gridCode}`)

    assert.ok(win.customElements.get('mjs-monkey'), 'mjs-monkey enregistré')
    assert.ok(win.customElements.get('mjs-grid'), 'mjs-grid enregistré')

    document.body.innerHTML = '<mjs-grid></mjs-grid>'
    el = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 60))
    assert.ok(el._shadow, 'shadow root du grid monté')
  })

  after(async () => {
    win?.close?.()
    await terminateSharedWorkerPool()
  })

  // ── A. self-closing custom elements ────────────────────────────────────────
  it('A — `<mjs-monkey />` × 3 self-closing → 3 instances distinctes en frères', () => {
    const monkeys = el._shadow.querySelectorAll('mjs-monkey')
    assert.equal(monkeys.length, 3,
      `3 <mjs-monkey> attendus en frères, pas imbriqués. got: ${monkeys.length}`)
    // Aucun monkey ne doit contenir un autre monkey (cas où le self-closing
    // serait ignoré → parent qui consume tout).
    for (const m of monkeys) {
      assertAbsent(m.querySelector('mjs-monkey'), 'un <mjs-monkey> ne doit pas contenir un autre <mjs-monkey>')
    }
  })

  // ── B. attribut HTML → $var sans déclaration ──────────────────────────────
  it('B — attributs HTML alimentent $emoji/$description sans `<script>` déclaratif', () => {
    const monkeys = Array.from(el._shadow.querySelectorAll('mjs-monkey')) as any[]
    const expected = [
      { emoji: '🙈', description: 'see no evil' },
      { emoji: '🙉', description: 'hear no evil' },
      { emoji: '🙊', description: 'speak no evil' },
    ]
    for (let i = 0; i < 3; i++) {
      const shadow = monkeys[i]._shadow?.innerHTML ?? ''
      assert.ok(shadow.includes(expected[i].emoji),
        `monkey #${i} : son shadow doit contenir l'emoji "${expected[i].emoji}" interpolé depuis l'attribut HTML (sans \`<script>\` qui déclare $emoji). got shadow: ${shadow.slice(0, 200)}`)
      assert.ok(shadow.includes(expected[i].description),
        `monkey #${i} : son shadow doit contenir la description "${expected[i].description}" interpolée depuis l'attribut HTML. got shadow: ${shadow.slice(0, 200)}`)
    }
  })

  it('B (bis) — $emoji est utilisable comme expression (charCodeAt) sans `<script>` déclaratif', () => {
    const monkey0 = el._shadow.querySelector('mjs-monkey')
    const shadow = monkey0._shadow?.innerHTML ?? ''
    // 🙈 = U+1F648 = surrogate pair D83D DE48 → charCodeAt(0).toString(16) = 'd83d'
    assert.match(shadow, /\\ud83d|d83d/i,
      `l'expression \`{$emoji.charCodeAt(0).toString(16)}\` doit s'évaluer sur l'emoji bindé. got shadow: ${shadow.slice(0, 300)}`)
  })

  // ── C. @display contents ──────────────────────────────────────────────────
  it('C — `@display contents` produit `:host{display:contents}` dans le bundle compilé', () => {
    // Normalise les espaces pour matcher tolérant.
    const normalized = monkeyBundle.replace(/\s+/g, '')
    assert.match(normalized, /:host\{[^}]*display:contents/,
      `le bundle monkey doit poser \`display: contents\` sur :host (sinon CSS grid du parent ne voit pas les 4 cellules). excerpt :host{...}: ${monkeyBundle.match(/:host\s*\{[^}]*\}/)?.[0] ?? '(pas trouvé)'}`)
  })
})
