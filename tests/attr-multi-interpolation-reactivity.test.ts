// Test de non-régression — bug trouvé (tooltip breadcrumb doc/tuto figé
// après navigation client, seul F5 rafraîchissait). Un attribut avec DEUX
// interpolations séparées par du texte littéral (`title="{$a} — {$b}"`) faisait
// échouer `getEffectVars` (generator/state.ts) : la regex "bloc unique"
// (`/^!?\{(.+)\}$/`, gourmande) matchait AUSSI ce cas multi-blocs (du premier `{`
// au dernier `}`), produisant un `codeToAnalyze` invalide (accolades internes non
// refermées) → acorn.parse échouait → catch silencieux → deps = [] → effet classé
// mountOnly à tort, JAMAIS re-déclenché — alors même que $a ET $b apparaissent
// bien EN CLAIR dans le binding (ce n'est PAS le piège §1 documenté — les deux
// vars sont visibles, c'est un bug de PARSING qui les rend invisibles quand même).
//
// Preuve par exécution réelle (vrai Bundler + happy-dom, compile + montage +
// clic) — une assertion sur la forme du JS généré ne suffit pas pour un bug de
// dispatch réactif au runtime.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const COMPONENT = `
<script>
$a = 'un'
$b = 1

@bump = ->
  $a = 'deux'
  $b = 2
</script>

<p id="out" title="{$a} — {$b}">{$a}</p>
<button class="bump" @click={@bump()}>bump</button>
`

async function compileComponent(): Promise<string> {
  const root = mjsTmp('attrmulti')
  const srcDir = join(root, 'src'), outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'attrmulti.mjs'), COMPONENT)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'b.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const compFile = readdirSync(outDir).find((f: string) => f.startsWith('attrmulti-'))!
  const coreFile = readdirSync(outDir).find((f: string) => /^mjs_core-/.test(f))!
  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  return `${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile), 'utf-8'))}`
}

describe('attribut à DEUX interpolations ("{$a} — {$b}") — réactivité (generator/state.ts getEffectVars)', function () {
  this.timeout(40000)
  let window: any = null
  let el: any = null
  const errors: any[] = []

  function title(): string {
    return el._shadow.querySelector('#out').getAttribute('title')
  }
  function text(): string {
    return el._shadow.querySelector('#out').textContent
  }
  function click(selector: string) {
    const btn = el._shadow.querySelector(selector)
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  }

  before(async function () {
    const code = await compileComponent()
    window = new Window({ url: 'http://localhost/' })
    window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))
    const document: any = window.document
    window.eval(code)
    assert.ok(window.customElements.get('mjs-attrmulti'), 'composant enregistré')
    document.body.innerHTML = '<mjs-attrmulti id="c"></mjs-attrmulti>'
    el = document.getElementById('c')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(el._shadow, 'composant monté')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('valeur initiale : title="un — 1"', () => {
    assert.equal(title(), 'un — 1')
  })

  it('après mutation de $a ET $b : le texte visible ET le title se mettent À JOUR (pas mount-only)', async () => {
    click('.bump')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(text(), 'deux', 'le texte visible (un seul binding par nœud) doit refléter la mutation')
    assert.equal(title(), 'deux — 2', 'AVANT le fix : restait figé à "un — 1" (effet jamais dans effectsByVar, mountOnly)')
  })

  it('aucune erreur JS levée', () => {
    assert.equal(errors.length, 0, `aucune exception attendue : ${errors.map(String).join(' | ')}`)
  })
})
