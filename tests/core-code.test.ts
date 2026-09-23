// Test neuf — module cœur code (bloc de code à copier) : COMPORTEMENT runtime en
// happy-dom, patron calqué sur tests/core-select.test.ts (bundler réel, core + chunks des
// composants chargés dans une vraie Window happy-dom, interaction via dispatchEvent,
// traversée du shadow fermé via `el._shadow`). Le gabarit hôte utilise <@code> (raccourci
// résolu par le CŒUR, catalogue src/core-modules/ sans override) ; la résolution BUILD
// (manifeste, chunk, réécriture du gabarit — normalement dans un fichier `*-build.test.ts`
// séparé, cf. core-select-build.test.ts) est regroupée ICI, en fin de suite, dans une
// seconde describe.
//
// Limite de happy-dom (20.11.0) rencontrée ICI, absente des suites existantes qui
// n'appellent jamais `.innerText` : `:defined` y est mal évalué sur les éléments NATIFS
// (pre/code/div…), qui matchent donc `:not(:defined)` — la feuille anti-FOUC du cœur
// (`[mjs-loading],:not(:defined):not([mjs-ssr])`, runtime/mjs_init.ts) leur pose alors
// `display:none!important` dès qu'elle est adoptée par le document, et `getComputedStyle`
// fait retomber `innerText` à `''` pour n'importe quel élément. Sans conséquence ICI :
// `sourceOf()` (code.mjs) lit `el.innerText or el.textContent`, et `textContent` — non
// affecté par ce bug, lui — préserve exactement le texte d'un `<pre>` (retours à la ligne
// et blancs de fin compris), donc les blocs projetés se lisent correctement malgré tout.
// Vérifié par compilation réelle (Bundler + Window happy-dom), jamais par supposition.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const HOST = `<div id="code-basic">
  <@code>
    <pre><code>hello()</code></pre>
  </@code>
</div>

<div id="code-clip-single">
  <@code>
    <pre><code>x = 1
y = 2   
</code></pre>
  </@code>
</div>

<div id="code-clip-two">
  <@code>
    <pre><code>premier bloc</code></pre>
    <pre><code>second bloc</code></pre>
  </@code>
</div>

<div id="code-fallback-ok">
  <@code>
    <pre><code>alpha</code></pre>
  </@code>
</div>

<div id="code-fallback-fail">
  <@code>
    <pre><code>beta</code></pre>
  </@code>
</div>

<div id="code-labels">
  <@code label="Copy code" copied-label="Copied!">
    <pre><code>gamma</code></pre>
  </@code>
</div>

<div id="code-plain">
  <@code>npm install modularjs-framework</@code>
</div>

<div id="code-plain-multi">
  <@code>
    ligne une
      ligne deux indentee
    ligne trois
  </@code>
</div>

<div id="code-lines">
  <@code><code data-file="app.mjs">
      <div>ligne un</div>
      <div>ligne deux</div>
      <br>
      <div>ligne trois</div>
    </code></@code>
</div>
`

describe('core-code — comportement runtime (happy-dom, bundler réel)', function () {
  this.timeout(60000)

  let window: any = null
  let document: any = null
  let hote: any = null

  function code(id: string): any {
    return hote._shadow.querySelector(`#${id} mjs-code`)
  }
  function btn(id: string): any {
    return code(id)._shadow.querySelector('button.copy')
  }
  function click(el: any) {
    el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true }))
  }
  async function tick(ms = 30) {
    await new Promise((r) => setTimeout(r, ms))
  }

  before(async function () {
    const root = mjsTmp('core-code-behavior')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'hote.mjs'), HOST)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    window = new Window({ url: 'http://localhost/' })
    document = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const codeFile = files.find((f: string) => /^code-/.test(f))
    const hoteFile = files.find((f: string) => /^hote-/.test(f))
    assert.ok(coreFile && codeFile && hoteFile, 'core + code + hote compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const combined = [coreFile, codeFile, hoteFile].map((f: string) => stripEsm(readFileSync(join(outDir, f!), 'utf-8'))).join('\n')
    window.eval(`${combined}\nglobalThis.µ = µ;`)

    document.body.innerHTML = '<mjs-hote></mjs-hote>'
    await new Promise((r) => setTimeout(r, 80))
    hote = document.body.firstElementChild
    assert.ok(hote._shadow, 'hôte monté')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  describe('rendu', () => {
    it('bouton copy[part=button] avec aria-label/title « Copier le code » ; le <pre> reste dans le DOM léger, jamais dans le shadow', () => {
      const b = code('code-basic')._shadow.querySelector('button.copy[part="button"]')
      assert.ok(b, 'le bouton copy[part=button] doit exister dans le shadow')
      assert.equal(b.getAttribute('aria-label'), 'Copier le code')
      assert.equal(b.getAttribute('title'), 'Copier le code')
      assert.ok(code('code-basic').querySelector('pre'), 'le <pre> doit rester un enfant du DOM léger de <mjs-code>')
      const box = code('code-basic')._shadow.querySelector('pre.box')
      assert.ok(box, 'le shadow porte son enveloppe pre.box')
      assert.equal(box.classList.contains('block'), false, 'un <pre> projeté laisse l\'enveloppe NEUTRE (pas de classe block)')
    })
  })

  describe('copie — presse-papier (navigator.clipboard.writeText simulé)', () => {
    it('texte reçu joint et blancs de fin retirés ; classe ok + aria-label « Copié ! » après résolution', async () => {
      const received: string[] = []
      window.navigator.clipboard.writeText = (text: string) => { received.push(text); return Promise.resolve() }
      const b = btn('code-clip-single')
      click(b)
      await tick()
      assert.deepEqual(received, ['x = 1\ny = 2'], 'le bloc "x = 1\\ny = 2   \\n" doit être reçu trimmé, saut de ligne interne préservé')
      assert.equal(b.classList.contains('ok'), true)
      assert.equal(b.getAttribute('aria-label'), 'Copié !')
    })

    it('deux blocs projetés : textes joints par un saut de ligne', async () => {
      const received: string[] = []
      window.navigator.clipboard.writeText = (text: string) => { received.push(text); return Promise.resolve() }
      click(btn('code-clip-two'))
      await tick()
      assert.deepEqual(received, ['premier bloc\nsecond bloc'])
    })
  })

  describe('copie — repli sans presse-papier (document.execCommand)', () => {
    it('navigator.clipboard absent, execCommand rend true : commande "copy" appelée, classe ok posée', async () => {
      Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
      const calls: string[] = []
      document.execCommand = (cmd: string) => { calls.push(cmd); return true }
      const b = btn('code-fallback-ok')
      click(b)
      await tick()
      assert.deepEqual(calls, ['copy'])
      assert.equal(b.classList.contains('ok'), true)
    })

    // même repli, mais execCommand échoue (retour navigateur, presse-papier verrouillé…) :
    // selectAndCopy() rend false, copy() n'appelle jamais done() → aucune classe ok
    it('execCommand rend false : commande "copy" appelée quand même, PAS de classe ok', async () => {
      Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
      const calls: string[] = []
      document.execCommand = (cmd: string) => { calls.push(cmd); return false }
      const b = btn('code-fallback-fail')
      click(b)
      await tick()
      assert.deepEqual(calls, ['copy'])
      assert.equal(b.classList.contains('ok'), false)
    })
  })

  describe('forme courte — <@code>texte</@code>, sans <pre> ni <code> à écrire', () => {
    it('texte nu projeté : l\'enveloppe du shadow passe en mode bloc (classe block)', () => {
      const box = code('code-plain')._shadow.querySelector('pre.box')
      assert.ok(box, 'enveloppe présente')
      assert.equal(box.classList.contains('block'), true, 'aucun <pre> projeté ⇒ le module habille le code lui-même')
      assertAbsent(code('code-plain').querySelector('pre'), 'aucun <pre> à écrire dans le DOM léger')
    })

    it('le bouton de copie est là, et un clic copie le texte projeté', async () => {
      const received: string[] = []
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (text: string) => { received.push(text); return Promise.resolve() } }, configurable: true })
      const b = btn('code-plain')
      assert.ok(b, 'bouton présent en forme courte')
      click(b)
      await tick()
      assert.deepEqual(received, ['npm install modularjs-framework'])
    })

    it('indentation commune du gabarit retirée, indentation RELATIVE conservée', async () => {
      const received: string[] = []
      Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: (text: string) => { received.push(text); return Promise.resolve() } }, configurable: true })
      click(btn('code-plain-multi'))
      await tick()
      assert.deepEqual(received, ['ligne une\n  ligne deux indentee\nligne trois'])
      assert.equal(code('code-plain-multi').textContent, 'ligne une\n  ligne deux indentee\nligne trois', 'le DOM léger lui-même est dédenté')
    })

    it('gabarit en <div> par ligne (éditeur de tuto) : pas de \\n résiduel entre les lignes', async () => {
      // chaque <div> pose déjà sa propre ligne par le CSS (display:block) ; le texte purement
      // blanc laissé ENTRE eux par l'indentation du gabarit n'est QUE de l'espacement — un \n
      // résiduel s'y ajouterait à celui du <div> et doublerait chaque saut de ligne (régression 22/09)
      // <@slot {i}> (tuto-editor) projette UN SEUL élément <code data-file> déjà structuré :
      // le texte à dédenter est dans SES enfants, pas dans le wrapper — c'est ce niveau-là qui compte
      const wrapper = code('code-lines').querySelector('code')
      assert.ok(wrapper, 'le <code data-file> projeté reste dans le DOM léger')
      const kids = Array.from(wrapper.childNodes) as any[]
      const blancsResiduels = kids.filter((n: any) => n.nodeType === 3 && n.nodeValue.length > 0 && n.nodeValue.trim() === '')
      assert.deepEqual(blancsResiduels.map((n: any) => JSON.stringify(n.nodeValue)), [], 'nœud 100% blanc non vidé')
    })
  })

  describe('attributs label / copied-label', () => {
    it('label="Copy code" copied-label="Copied!" : aria-label/title suivent, « Copied! » après un clic réussi', async () => {
      const b = btn('code-labels')
      assert.equal(b.getAttribute('aria-label'), 'Copy code')
      assert.equal(b.getAttribute('title'), 'Copy code')
      Object.defineProperty(window.navigator, 'clipboard', { value: undefined, configurable: true })
      document.execCommand = () => true
      click(b)
      await tick()
      assert.equal(b.getAttribute('aria-label'), 'Copied!')
    })
  })
})

describe('core-code — résolution RÉELLE via <@code> (catalogue src/core-modules/)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  async function buildProject(files: Record<string, string>): Promise<{ root: string; outDir: string; stats: any }> {
    const root = mjsTmp('core-code-build')
    const srcDir = join(root, 'app/modularjs')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    for (const [rel, content] of Object.entries(files)) writeFileSync(join(srcDir, rel), content)
    writeFileSync(join(root, 'mjs.config.json'), JSON.stringify({ sourceDir: 'app/modularjs', outputDir: 'out', manifestPath: 'bundle.js' }))
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    return { root, outDir, stats }
  }

  function messages(stats: any): string {
    return stats.errors.map((e: any) => e.message).join('\n')
  }

  function readComponent(outDir: string, name: string): string {
    const files = readdirSync(outDir)
    const f = files.find((f) => new RegExp(`^${name}-[a-f0-9]{8}\\.js$`).test(f))
    assert.ok(f, `${name}-*.js doit exister dans ${outDir} (trouvés : ${files.join(', ')})`)
    return readFileSync(join(outDir, f!), 'utf-8')
  }

  it('un projet qui n\'écrit pas <@code> : le manifeste ne porte pas code', async () => {
    const { stats } = await buildProject({ 'hote.mjs': '<p>rien à copier ici</p>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.equal(stats.manifest['code'], undefined, 'code ne doit pas apparaître si rien ne le référence')
  })

  it('<@code> seul : build vert, manifeste porte code (clé PLATE), chunk émis, gabarit réécrit <mjs-code>', async () => {
    const { outDir, stats } = await buildProject({ 'hote.mjs': '<@code><pre><code>x = 1</code></pre></@code>' })
    assert.equal(stats.errors.length, 0, messages(stats))
    assert.ok(stats.manifest['code'], 'manifeste doit exposer code')
    const files = readdirSync(outDir)
    assert.ok(files.some((f) => /^code-[a-f0-9]{8}\.js$/.test(f)), `chunk code-*.js attendu parmi : ${files.join(', ')}`)
    assert.match(readComponent(outDir, 'hote'), /<mjs-code\b/)
  })
})
