// Test NEUF — entités HTML d'un attribut STATIQUE non décodées sur le
// chemin DOM (setAttribute/prop directe construits par appel, cf. src/generator/paths.ts
// emitAttrSet) : SEUL le chemin HTML (cloneNode d'un template parsé, `staticAttr` dans
// attributes/index.ts) bénéficie du décodage natif du navigateur au parse. Symptôme
// prouvé : `title="a &amp; b"` reste LITTÉRAL (`getAttribute('title') === 'a &amp; b'`)
// au lieu de `'a & b'` — même souci pour la forme objet de `@confirm` (échappée par
// `escapeVtAttrValue`, transpiler/index.ts) : `mjs-confirm` porte du JSON avec ses
// entités NON décodées, illisible par `JSON.parse`.
//
// DÉCLENCHEUR RÉEL du chemin DOM (preuve par compilation directe)
// — PAS un simple `{for}` : `compileFor`/`compileIf`/`compileKey`
// réutilisent le ctx du walker parent (`ctx.type` reste 'root' ou 'for'), et
// `dynamic()` (attributes/index.ts) y route TOUJOURS un attribut dynamique via
// `ctx.updates` (`_mjs_updAttr`/`_mjs_updAttrNode`), jamais par un marqueur `${...}` inline
// dans le HTML — `generateCreateFnBody` (paths.ts) choisit donc `_mjs_cloneTpl` (chemin
// HTML, entités déjà correctes) même DANS un `{for}` tant qu'aucun `${` littéral n'y
// figure. SEUL `compileAwait` fixe `ctx.type = 'await'` pour le corps de ses branches
// (`{success}`/`{error}`) — la SEULE valeur `ni root ni for` — et SEULE cette valeur
// fait passer `dynamic()` par sa branche finale, qui écrit `attrName='${expr}'` EN
// CLAIR dans le HTML : `hasInterpolations` devient vrai, `generateCreateFnBody` bascule
// alors en mode impératif (`document.createElement`/`setAttribute`/prop directe) POUR
// TOUT le sous-arbre de la branche, entités des attributs STATIQUES voisins comprises.
// Un attribut `data-y={x}` (dynamique, sans rapport avec le bug) sert donc de simple
// DÉCLENCHEUR à côté de chaque attribut statique testé.
//
// Modèle : tests/ujs-shadow-confirm.test.ts (Bundler + happy-dom + window.eval du bundle).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script>
$p = Promise.resolve(1)
</script>
<div id="case-b">
<b title="a &amp; b &#123;x&#125; &quot;q&quot;">t</b>
</div>
<div id="case-await">
{await $p}
<p>...</p>
{success x}
<b id="case-a" title="a &amp; b &#123;x&#125; &quot;q&quot;" data-y={x}>t</b>
<button id="case-c" @confirm={ text: 'Supprimer ?', ok: 'Oui', cancel: 'Non' } data-y={x}>x</button>
<b id="case-d" title="a & b" data-y={x}>t</b>
{error err2}
<p>err</p>
{end}
</div>
`

describe("generator/paths — décodage des entités HTML d'un attribut STATIQUE sur le chemin DOM", function () {
  this.timeout(40000)

  let window: any = null
  let root: any = null

  before(async function () {
    const dir = mjsTmp('attr-static-entities')
    const srcDir = join(dir, 'src')
    const outDir = join(dir, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'entities.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(dir, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^entities-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    assert.ok(window.customElements.get('mjs-entities'), 'mjs-entities enregistré')
    document.body.innerHTML = '<mjs-entities></mjs-entities>'
    root = document.body.firstElementChild
    // le montage ET la résolution de `$p` (promesse déjà résolue) tournent en microtask/tick
    await new Promise((r) => setTimeout(r, 80))
    assert.ok(root._shadow, 'shadow root monté')
    assert.ok(root._shadow.querySelector('#case-a'), 'branche {success} affichée (promesse résolue)')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('(a) chemin DOM ({await}/{success} + attribut dynamique voisin) : title avec entités nommées + numériques décodé', function () {
    const b = root._shadow.querySelector('#case-a')
    assert.equal(b.getAttribute('title'), 'a & b {x} "q"')
  })

  it('(b) chemin HTML (hors {await}), même attribut : déjà décodé (cohérence)', function () {
    const b = root._shadow.querySelector('#case-b b')
    assert.equal(b.getAttribute('title'), 'a & b {x} "q"')
  })

  it('(c) chemin DOM, forme objet @confirm : JSON décodable', function () {
    const btn = root._shadow.querySelector('#case-c')
    const raw = btn.getAttribute('mjs-confirm')
    assert.deepEqual(JSON.parse(raw), { text: 'Supprimer ?', ok: 'Oui', cancel: 'Non' })
  })

  it("(d) chemin DOM, esperluette NUE (pas une entité) : reste intacte", function () {
    const b = root._shadow.querySelector('#case-d')
    assert.equal(b.getAttribute('title'), 'a & b')
  })
})
