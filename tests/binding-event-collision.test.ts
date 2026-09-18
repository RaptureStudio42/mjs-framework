// Régression — collision SILENCIEUSE entre une
// liaison two-way et une directive `@événement` posées sur le même élément.
//
// La table de routes émise par le générateur était un dictionnaire
// événement → { id du nœud : index du handler } : UNE valeur par couple
// (événement, nœud), écrite par `state.events[evt][id] = idx`. Une liaison
// `value=!{$x}` et une directive `@input={…}` sur le même `<input>` partagent
// le même id de routage → la seconde écrasait la première, sans le moindre
// avertissement, et le perdant dépendait de l'ORDRE DES ATTRIBUTS :
//   `<input value=!{$x} @input={f()}>`  → la liaison mourait ($x figé)
//   `<input @input={f()} value=!{$x}>`  → le handler de l'app mourait
// Même piège entre deux liaisons qui partagent un événement : `volume=!{}` et
// `muted=!{}` écoutent tous deux `volumechange`.
//
// Correctif : la route accepte une LISTE `[[idx, flags], …]` et le routeur
// (`_mjs_bindEvents`) exécute TOUS les handlers du couple, liaisons d'abord — la
// directive lit donc la variable déjà à jour. Ce fichier verrouille les deux
// moitiés : les tables réellement émises par le compilateur, et le
// comportement runtime (happy-dom, vrais événements dispatchés).
//
// Il couvre aussi les SIX liaisons média (currentTime / duration / paused /
// volume / muted / playbackRate) qui n'avaient jusqu'ici aucun test — c'est
// très exactement pour ça qu'elles avaient fini oubliées.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { compile } from '../src/generator/index.js'

// Les vars liées à une propriété DOM que le composant ÉCRIT au mount sont
// initialisées : happy-dom applique la validation stricte du navigateur
// (`volume = undefined` → TypeError, `textarea.value = undefined` → crash
// interne). Les vars purement lues (`$a`, `$d`…) restent auto-déclarées.
const COMPONENT = `
<script lang="coffee">
log  = (m, v) -> globalThis.__collog.push(m + ':' + v)
$c    = ''
$pos  = 0
$pau  = true
$vol  = 1
$mut  = false
$rate = 1
</script>

<input class="a" value=!{$a} @input={log('dir-a', $a)}>
<b class="out-a">{$a}</b>

<input class="b" @input={log('dir-b', $b)} value=!{$b}>
<b class="out-b">{$b}</b>

<textarea class="c" value=!{$c} @input={log('dir-c', $c)}></textarea>
<b class="out-c">{$c}</b>

<input class="d" type="checkbox" checked=!{$d} @change={log('dir-d', $d)}>
<b class="out-d">{$d}</b>

<select class="e" value=!{$e} @change={log('dir-e', $e)}>
  <option value="x">x</option>
  <option value="y">y</option>
</select>
<b class="out-e">{$e}</b>

<audio class="f" currentTime=!{$pos} paused=!{$pau} volume=!{$vol} muted=!{$mut} playbackRate=!{$rate} duration=!{$dur} @timeupdate={log('dir-tu', $pos)} @play={log('dir-play', $pau)}></audio>
<b class="out-pos">{$pos}</b><b class="out-vol">{$vol}</b><b class="out-mut">{$mut}</b><b class="out-rate">{$rate}</b><b class="out-dur">{$dur}</b><b class="out-pau">{$pau}</b>

<input class="g" value=!{$g} @input.once={log('dir-g', $g)}>
<b class="out-g">{$g}</b>

<div class="h-out" @input={log('h-out', 'x')}>
  <input class="h" value=!{$h} @input.propagate={log('dir-h', $h)}>
</div>
<b class="out-h">{$h}</b>
`

// ── Moitié 1 : les tables de routes réellement émises ───────────────────────
describe('collision liaison ↔ directive — tables de routes émises', () => {
  const routes = (tpl: string) => (compile(tpl, {}) as any)[2]

  it('liaison SEULE — forme courte `idx` conservée (aucune inflation du bundle)', () => {
    assert.deepEqual(routes('<input value=!{$x}>'), { input: { b1: 0 } })
  })

  it('directive SEULE — forme courte `idx`, et `[idx, flags]` avec modificateur', () => {
    assert.deepEqual(routes('<button @click={f()}>x</button>'), { click: { e1: 0 } })
    assert.deepEqual(routes('<button @click.once={f()}>x</button>'), { click: { e1: [0, 2] } })
  })

  it('liaison PUIS directive — les DEUX sont dans la route, liaison en tête', () => {
    assert.deepEqual(routes('<input value=!{$x} @input={f()}>'), { input: { b1: [[0, 0], [1, 0]] } })
  })

  it('directive PUIS liaison — la liaison passe QUAND MÊME en tête (ordre des attributs indifférent)', () => {
    // La liaison est compilée en 2ᵉ (inline nº1) mais s'exécute en 1ʳᵉ.
    assert.deepEqual(routes('<input @input={f()} value=!{$x}>'), { input: { e1: [[1, 0], [0, 0]] } })
  })

  it('deux LIAISONS qui partagent un événement (volume + muted → volumechange) survivent toutes les deux', () => {
    assert.deepEqual(routes('<audio volume=!{$v} muted=!{$m}></audio>'), { volumechange: { m1: [[0, 0], [1, 0]] } })
  })

  it('média — currentTime/paused + @play/@timeupdate : chaque couple garde liaison ET directive', () => {
    const r = routes('<audio currentTime=!{$p} paused=!{$pa} @play={j()} @timeupdate={t()}></audio>')
    assert.deepEqual(r.timeupdate, { m1: [[0, 0], [3, 0]] })   // liaison currentTime, puis @timeupdate
    assert.deepEqual(r.play,       { m1: [[1, 0], [2, 0]] })   // liaison paused, puis @play
    assert.deepEqual(r.pause,      { m1: 1 })                  // liaison paused seule → forme courte
  })

  it('média, directives écrites EN PREMIER — les liaisons restent en tête de liste', () => {
    const r = routes('<audio @play={j()} @timeupdate={t()} currentTime=!{$p} paused=!{$pa}></audio>')
    assert.deepEqual(r.play,       { e1: [[3, 0], [0, 0]] })
    assert.deepEqual(r.timeupdate, { e1: [[2, 0], [1, 0]] })
  })

  it('select — PAS de collision : la liaison écoute `input`, la directive `change`', () => {
    // Contre-exemple utile : `bindingStandard` mappe `value` → `input` (et
    // `checked` → `change`, `open` → `toggle`). Un `<select value=!{} @change>`
    // n'a donc jamais été touché par le bogue — les deux routes sont disjointes.
    const r = routes('<select value=!{$v} @change={c()}><option>a</option></select>')
    assert.deepEqual(r, { input: { b1: 0 }, change: { b1: 1 } })
  })
})

// ── Moitié 2 : le comportement runtime ─────────────────────────────────────
describe('collision liaison ↔ directive — runtime (happy-dom)', function () {
  this.timeout(40000)

  let win: any  = null
  let el: any   = null
  let doc: any  = null

  const q    = (sel: string) => el._shadow.querySelector(sel)
  const txt  = (sel: string) => q(sel).textContent
  const tick = () => new Promise(r => setTimeout(r, 20))

  // Dispatche un événement RÉEL sur l'élément ciblé et renvoie le journal des
  // directives déclenchées. `bubbles:false` par défaut — les événements média
  // ne remontent pas, et le routeur les voit quand même (listener en CAPTURE).
  async function fire(sel: string, type: string, bubbles = true) {
    win.__collog = []
    q(sel).dispatchEvent(new win.Event(type, { bubbles, cancelable: true, composed: bubbles }))
    await tick()
    return win.__collog.slice()
  }

  before(async function () {
    const root   = mjsTmp('coll')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'colltest.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    win = new Window({ url: 'http://localhost/' })
    win.__collog = []
    doc = win.document
    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^colltest-/.test(f))
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

    assert.ok(win.customElements.get('mjs-colltest'), 'mjs-colltest enregistré')
    doc.body.innerHTML = '<mjs-colltest></mjs-colltest>'
    el = doc.body.firstElementChild
    await tick()
    assert.ok(el._shadow, 'shadow root monté')
  })

  after(async () => {
    win?.close?.()
    await terminateSharedWorkerPool()
  })

  it('input — la liaison suit la frappe ET la directive se déclenche, dans cet ordre', async () => {
    q('.a').value = 'bonjour'
    const journal = await fire('.a', 'input')
    assert.equal(txt('.out-a'), 'bonjour', 'la liaison est vivante ($a suit la frappe)')
    // La valeur portée par le journal PROUVE l'ordre : la directive a lu $a
    // APRÈS que la liaison l'ait écrite.
    assert.deepEqual(journal, ['dir-a:bonjour'])
  })

  it('input, attributs en ordre INVERSE (@input écrit avant value=!) — même résultat', async () => {
    q('.b').value = 'inverse'
    const journal = await fire('.b', 'input')
    assert.equal(txt('.out-b'), 'inverse')
    assert.deepEqual(journal, ['dir-b:inverse'])
  })

  it('textarea — liaison + @input cohabitent', async () => {
    q('.c').value = 'un texte'
    const journal = await fire('.c', 'input')
    assert.equal(txt('.out-c'), 'un texte')
    assert.deepEqual(journal, ['dir-c:un texte'])
  })

  it('checkbox — checked=! + @change cohabitent', async () => {
    q('.d').checked = true
    const journal = await fire('.d', 'change')
    assert.equal(txt('.out-d'), 'true')
    assert.deepEqual(journal, ['dir-d:true'])
  })

  it('select — routes disjointes : `input` alimente la liaison, `change` la directive', async () => {
    q('.e').value = 'y'
    await fire('.e', 'input')
    assert.equal(txt('.out-e'), 'y', 'la liaison suit sur input')
    assert.deepEqual(await fire('.e', 'change'), ['dir-e:y'], 'la directive tire sur change')
  })

  it('.once sur la directive — le handler ne tire qu\'une fois, la liaison continue de vivre', async () => {
    q('.g').value = 'premier'
    assert.deepEqual(await fire('.g', 'input'), ['dir-g:premier'])
    assert.equal(txt('.out-g'), 'premier')

    q('.g').value = 'second'
    assert.deepEqual(await fire('.g', 'input'), [], 'la directive .once est désarmée')
    assert.equal(txt('.out-g'), 'second', 'la liaison, elle, N\'est PAS désarmée')
  })

  it('.propagate sur la directive — liaison, puis directive, puis l\'ancêtre', async () => {
    q('.h').value = 'monte'
    const journal = await fire('.h', 'input')
    assert.equal(txt('.out-h'), 'monte')
    assert.deepEqual(journal, ['dir-h:monte', 'h-out:x'])
  })

  // ── les SIX liaisons média ───────────────────────────────────────────────
  it('média — currentTime=! suit timeupdate, et @timeupdate se déclenche aussi', async () => {
    q('.f').currentTime = 12.5
    const journal = await fire('.f', 'timeupdate', false)
    assert.equal(txt('.out-pos'), '12.5')
    assert.deepEqual(journal, ['dir-tu:12.5'])
  })

  it('média — volume=! ET muted=! survivent au MÊME événement volumechange', async () => {
    const f = q('.f')
    f.volume = 0.25
    f.muted  = true
    await fire('.f', 'volumechange', false)
    assert.equal(txt('.out-vol'), '0.25', 'liaison volume vivante')
    assert.equal(txt('.out-mut'), 'true', 'liaison muted vivante')
  })

  it('média — playbackRate=! suit ratechange', async () => {
    q('.f').playbackRate = 2
    await fire('.f', 'ratechange', false)
    assert.equal(txt('.out-rate'), '2')
  })

  it('média — duration=! suit durationchange (lecture seule)', async () => {
    // `duration` n'est pas assignable (getter natif) : on le force sur
    // l'instance, comme le ferait le navigateur au chargement des métadonnées.
    Object.defineProperty(q('.f'), 'duration', { value: 180, configurable: true })
    await fire('.f', 'durationchange', false)
    assert.equal(txt('.out-dur'), '180')
  })

  it('média — paused=! suit play/pause, et @play se déclenche aussi', async () => {
    const f = q('.f')
    const p = f.play()
    if (p && p.catch) p.catch(() => {})
    const journal = await fire('.f', 'play', false)
    assert.equal(txt('.out-pau'), 'false', 'liaison paused vivante')
    assert.deepEqual(journal, ['dir-play:false'])

    f.pause()
    await fire('.f', 'pause', false)
    assert.equal(txt('.out-pau'), 'true')
  })
})
