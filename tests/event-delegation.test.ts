// Tests runtime — modèle d'événements MJS (délégation + .propagate / .self /
// .stop). Compile UN composant couvrant tous les cas (1/2/3 niveaux), le
// charge dans happy-dom, dispatche de vrais events et certifie quels handlers
// se déclenchent et dans quel ordre.
//
// Verrouille le refacto « .propagate = retirer le return du routeur » : un
// seul listener, remontée parentNode, `.propagate` poursuit la remontée,
// `.stop` (stopPropagation → cancelBubble) la coupe.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
log = (m) -> globalThis.__evtlog.push(m)
</script>
<div data-z="A">
  <button @click={log('A')}>x</button>
</div>

<div data-z="B" @click={log('B-out')}>
  <button @click={log('B-in')}>x</button>
</div>

<div data-z="C" @click={log('C-out')}>
  <button @click.propagate={log('C-in')}>x</button>
</div>

<div data-z="D" @click.self={log('D-self')}>
  <span>x</span>
</div>

<div data-z="D2" @click={log('D2')}>
  <span>x</span>
</div>

<div data-z="E" @click={log('E1')}>
  <div @click={log('E2')}>
    <button @click={log('E3')}>x</button>
  </div>
</div>

<div data-z="F" @click={log('F1')}>
  <div @click={log('F2')}>
    <button @click.propagate={log('F3')}>x</button>
  </div>
</div>

<div data-z="G" @click={log('G1')}>
  <div @click.propagate={log('G2')}>
    <button @click.propagate={log('G3')}>x</button>
  </div>
</div>

<div data-z="H" @click={log('H1')}>
  <div @click.propagate.stop={log('H2')}>
    <button @click.propagate={log('H3')}>x</button>
  </div>
</div>

<div data-z="I" @click={log('I-out')}>
  <button @click.stop={log('I-in')}>x</button>
</div>

<div data-z="J">
  <button @click.once={log('J')}>x</button>
</div>

<div data-z="K" @click={log('K-out')}>
  <button @click.propagate.once={log('K-in')}>x</button>
</div>

<div data-z="L" @touchmove={log('L')}>x</div>
`

describe('événements — délégation runtime (.propagate / .self / .stop)', function () {
  this.timeout(40000)

  let win: any = null
  let el: any = null

  // fire(sel, type) : reset le log, dispatche un événement composé sur
  // l'élément ciblé, renvoie la liste des handlers déclenchés (dans l'ordre).
  function fire(sel: string, type = 'click'): string[] {
    win.__evtlog = []
    const node = el._shadow?.querySelector(sel)
    if (!node) throw new Error(`introuvable: ${sel}`)
    node.dispatchEvent(new win.Event(type, { bubbles: true, cancelable: true, composed: true }))
    return win.__evtlog.slice()
  }

  before(async function () {
    // 1. Compile le composant + runtime
    const root = mjsTmp('evt')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'evttest.mjs'), COMPONENT)

    const bundler = new Bundler({
      sourceDir: srcDir,
      outputDir: outDir,
      manifestPath: join(root, 'bundle.js'),
    })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    // 2. Charge dans happy-dom
    win = new Window({ url: 'http://localhost/' })
    win.__evtlog = []
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^evttest-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    assert.ok(win.customElements.get('mjs-evttest'), 'mjs-evttest enregistré')
    document.body.innerHTML = '<mjs-evttest></mjs-evttest>'
    el = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 50))
    assert.ok(el._shadow, 'shadow root monté')
  })

  after(async () => {
    win?.close?.()
    await terminateSharedWorkerPool()
  })

  // ── 1 niveau ──────────────────────────────────────────────────────────────
  it('1 niveau — le handler se déclenche', () => {
    assert.deepEqual(fire('[data-z="A"] button'), ['A'])
  })

  // ── 2 niveaux ─────────────────────────────────────────────────────────────
  it('2 niveaux SANS propagate — seul le plus proche (enfant) se déclenche', () => {
    assert.deepEqual(fire('[data-z="B"] button'), ['B-in'])
  })

  it('2 niveaux SANS propagate — clic sur le parent lui-même → handler parent', () => {
    assert.deepEqual(fire('[data-z="B"]'), ['B-out'])
  })

  it('2 niveaux AVEC .propagate sur l\'enfant — enfant PUIS parent', () => {
    assert.deepEqual(fire('[data-z="C"] button'), ['C-in', 'C-out'])
  })

  // ── .self ─────────────────────────────────────────────────────────────────
  it('.self — clic sur un enfant sans handler → le parent .self NE se déclenche PAS', () => {
    assert.deepEqual(fire('[data-z="D"] span'), [])
  })

  it('.self — clic sur le parent lui-même → le handler .self se déclenche', () => {
    assert.deepEqual(fire('[data-z="D"]'), ['D-self'])
  })

  it('SANS .self — clic sur un enfant sans handler → le parent se déclenche quand même', () => {
    assert.deepEqual(fire('[data-z="D2"] span'), ['D2'])
  })

  // ── 3 niveaux ─────────────────────────────────────────────────────────────
  it('3 niveaux SANS propagate — seul le niveau le plus profond', () => {
    assert.deepEqual(fire('[data-z="E"] button'), ['E3'])
  })

  it('3 niveaux — .propagate sur le niveau 3 seul → niveau 3 puis 2 (s\'arrête à 2)', () => {
    assert.deepEqual(fire('[data-z="F"] button'), ['F3', 'F2'])
  })

  it('3 niveaux — .propagate sur niveaux 3 et 2 → remontée complète 3→2→1', () => {
    assert.deepEqual(fire('[data-z="G"] button'), ['G3', 'G2', 'G1'])
  })

  // ── combo .propagate + .stop à 3 niveaux ──────────────────────────────────
  it('3 niveaux — combo : .propagate partout + .stop au niveau 2 → 3 puis 2, le 1 est coupé', () => {
    assert.deepEqual(fire('[data-z="H"] button'), ['H3', 'H2'])
  })

  // ── .stop ─────────────────────────────────────────────────────────────────
  it('.stop — le handler se déclenche normalement', () => {
    assert.deepEqual(fire('[data-z="I"] button'), ['I-in'])
  })

  it('.stop — coupe réellement l\'événement DOM (un listener document ne le reçoit plus)', () => {
    let docCount = 0
    const onDoc = () => { docCount++ }
    win.document.addEventListener('click', onDoc)
    try {
      docCount = 0
      fire('[data-z="B"] button')        // pas de .stop
      assert.equal(docCount, 1, 'sans .stop : le document reçoit le click')

      docCount = 0
      fire('[data-z="I"] button')        // .stop
      assert.equal(docCount, 0, 'avec .stop : le document ne reçoit rien')
    } finally {
      win.document.removeEventListener('click', onDoc)
    }
  })

  // ── .once ─────────────────────────────────────────────────────────────────
  it('.once — le handler se déclenche au 1er event puis plus jamais', () => {
    assert.deepEqual(fire('[data-z="J"] button'), ['J'], '1er clic')
    assert.deepEqual(fire('[data-z="J"] button'), [], '2e clic : route retirée')
    assert.deepEqual(fire('[data-z="J"] button'), [], '3e clic : toujours rien')
  })

  it('.once + .propagate — combo : tire une fois en remontant, puis seul le parent reste', () => {
    assert.deepEqual(fire('[data-z="K"] button'), ['K-in', 'K-out'], '1er clic : enfant (once) puis parent')
    assert.deepEqual(fire('[data-z="K"] button'), ['K-out'], '2e clic : enfant consommé, parent toujours là')
  })

  // ── auto-passive ──────────────────────────────────────────────────────────
  it('auto-passive — un handler @touchmove se déclenche normalement (listener passif)', () => {
    assert.deepEqual(fire('[data-z="L"]', 'touchmove'), ['L'])
  })
})
