// tests/layout-prop-reactive.test.ts — `layout={$expr}` posé en PROP (pas en
// attribut) par le parent doit rejouer le variant. Pipeline RÉEL (Bundler → mjs_core
// + composant COMPILÉS puis MONTÉS dans happy-dom, patron tests/mjs-layout-runtime.test.ts) —
// jamais une réimplémentation à la main de `_set`/`_mjs_applyLayout`.
//
// Couvre : relais `_set('layout'|'template', v)` → `_mjs_applyLayout(v || 'default')` ; sortie rapide
// « primitive inchangée » toujours respectée (pas de rejeu sur la même valeur reposée) ;
// reconnexion qui relit `_state` AVANT les attributs (une prop posée par le parent survit à un
// déplacement DOM) ; garde anti-croisement (`_mjs_layoutSeq`) sur deux `_mjs_applyLayout` concurrents.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
].join('\n')

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// Composant HOMONYME : il déclare LUI-MÊME `$layout` (un état métier « list »/« grid », rien à
// voir avec le style) ET un variant nommé pour un autre besoin. Le relais de `_set` doit
// lui laisser la main — sinon `$layout = 'list'` fait crasher son propre montage.
const COMPONENT_HOMONYME = [
  '<script lang="coffee">',
  '$layout = "list"',
  '</script>',
  '<p class="t">{$layout}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
  '<style name="compact">',
  '.t',
  '  color: blue',
  '</style>',
].join('\n')

// Compile une fixture dans un dossier temp isolé, charge le core + le composant dans une Window
// happy-dom FRAÎCHE, `fetch` stubé (404 par défaut, `setFetch` pour changer la réponse).
// Retourne le CONSTRUCTEUR RÉEL (fixture par défaut : sans `_mjs_layouts` déclaré — repli
// historique, aucun nom refusé, cf. mjs-layout-runtime.test.ts).
async function loadHarness(source = COMPONENT, modName = 'layout-prop-demo') {
  const root   = mjsTmp('layout-prop')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${modName}.mjs`), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document

  const fetchCalls: string[] = []
  let fetchImpl: (url: string) => Promise<any> = async () => ({ ok: false, status: 404 })
  window.fetch = (url: string) => { fetchCalls.push(url); return fetchImpl(url) }

  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => f.startsWith(`${modName}-`) && f.endsWith('.js'))
  assert.ok(coreFile && compFile, `sortie du build inattendue : ${files.join(', ')}`)
  window.eval([
    stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    'globalThis.µ = µ;',
    stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
  ].join('\n'))

  const Ctor = window.customElements.get(`mjs-${modName}`)
  assert.ok(Ctor, `le composant doit être défini sous mjs-${modName}`)

  return {
    window, document, Ctor, fetchCalls,
    setFetch(impl: (url: string) => Promise<any>) { fetchImpl = impl },
  }
}

// espionne `_mjs_applyLayout` SANS exécuter la vraie méthode : isole le relais testé (`_set` /
// `connectedCallback`) du fetch et de la validation de nom, qui ne sont pas le sujet ici.
function spyApplyLayout(el: any): string[] {
  const calls: string[] = []
  el._mjs_applyLayout = (name: string) => { calls.push(name); return Promise.resolve() }
  return calls
}

describe('mjs_element — layout={$expr} posé en PROP', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it("_set('layout', 'banner') sur un composant monté déclenche _mjs_applyLayout('banner')", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-layout-prop-demo></mjs-layout-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    const calls = spyApplyLayout(el)
    el._set('layout', 'banner')
    assert.deepEqual(calls, ['banner'], 'la prop layout doit relayer vers _mjs_applyLayout')
  })

  it("_set('layout', '') (retour à vide) déclenche _mjs_applyLayout('default')", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-layout-prop-demo></mjs-layout-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    el._state.layout = 'banner' // précondition : un variant déjà en place, posé directement en état
    const calls = spyApplyLayout(el)
    el._set('layout', '')
    assert.deepEqual(calls, ['default'], 'une valeur vide doit retomber sur le variant par défaut')
  })

  it("repositionner la MÊME valeur ('banner' deux fois de suite) ne rejoue PAS _mjs_applyLayout", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-layout-prop-demo></mjs-layout-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    const calls = spyApplyLayout(el)
    el._set('layout', 'banner')
    el._set('layout', 'banner')
    assert.deepEqual(calls, ['banner'], 'la sortie rapide « primitive inchangée » doit tenir sur le 2e appel')
  })

  it("un composant dont le variant a été posé en PROP, reconnecté, réapplique 'banner' et non 'default'", async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<div id="a"></div><div id="b"></div>'
    const a = document.getElementById('a')
    const b = document.getElementById('b')
    a.innerHTML = '<mjs-layout-prop-demo></mjs-layout-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = a.firstElementChild
    el._set('layout', 'banner') // vrai chemin : une prop posée par le parent, jamais en attribut
    const calls = spyApplyLayout(el)
    a.removeChild(el)
    b.appendChild(el) // reconnexion : disconnectedCallback puis connectedCallback
    await new Promise(r => setTimeout(r, 60))
    assert.deepEqual(calls, ['banner'], "la reconnexion doit relire le dernier variant appliqué AVANT de retomber sur 'default'")
  })

  // scénario RÉEL : un fetch 'banner' lent, demandé en PREMIER,
  // ne doit pas écraser le 'default' demandé APRÈS lui et déjà résolu (aucun fetch nécessaire) —
  // pipeline `_mjs_applyLayout` réel (pas de spy ici), fetch mocké avec un délai contrôlé.
  it("garde anti-croisement : la réponse tardive d'un fetch 'banner' n'écrase pas le 'default' demandé après", async () => {
    const { document, setFetch } = await loadHarness()
    document.body.innerHTML = '<mjs-layout-prop-demo></mjs-layout-prop-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    setFetch(async () => {
      await new Promise(r => setTimeout(r, 60)) // fetch VOLONTAIREMENT lent
      return { ok: true, status: 200, text: async () => '.t{color:banner-marker}' }
    })
    const slow = el._mjs_applyLayout('banner') // requête lancée en PREMIER, résolution la plus TARDIVE
    await el._mjs_applyLayout('default')       // demandé APRÈS, gagne tout de suite (aucun fetch)
    await slow
    await new Promise(r => setTimeout(r, 20))
    const adopted: any[] = Array.from(el._shadow.adoptedStyleSheets)
    const texts = adopted.map((s: any) => Array.from(s.cssRules).map((r: any) => r.cssText).join(' ')).join(' ')
    assert.ok(!texts.includes('banner-marker'), "la réponse tardive de 'banner' ne doit pas réapparaître après le 'default' demandé ensuite")
  })
})

// HOMONYMIE — sans garde, le relais de `_set` faisait de
// `layout`/`template` des noms d'état RÉSERVÉS dans tout composant : un `$layout = 'list'`
// métier partait dans `_mjs_applyLayout('list')`, qui refuse un nom absent de `_mjs_layouts` en
// faisant CRASHER le composant. Ici, `$layout` appartient au composant, pas au moteur de style.
describe('mjs_element — `$layout` déclaré par le composant lui-même (homonymie)', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it("un composant qui déclare son propre \\$layout monte SANS crasher, malgré un variant nommé", async () => {
    const { document } = await loadHarness(COMPONENT_HOMONYME, 'layout-homonyme-demo')
    document.body.innerHTML = '<mjs-layout-homonyme-demo></mjs-layout-homonyme-demo>'
    await new Promise(r => setTimeout(r, 120))
    const el: any = document.body.firstElementChild
    assert.ok(el._mjs_layouts && Object.prototype.hasOwnProperty.call(el._mjs_layouts, 'compact'), 'la fixture doit bien déclarer un variant nommé')
    assert.ok(el._mjs_var_bits && Object.prototype.hasOwnProperty.call(el._mjs_var_bits, 'layout'), 'la fixture doit bien déclarer son propre $layout')
    assert.ok(!el._mjs_has_crashed, "le composant ne doit pas crasher au montage à cause de son propre \\$layout")
    assert.equal(el._state.layout, 'list', "son \\$layout métier doit garder sa valeur")
  })

  it("écrire son \\$layout métier ne rejoue AUCUN variant", async () => {
    const { document } = await loadHarness(COMPONENT_HOMONYME, 'layout-homonyme-demo')
    document.body.innerHTML = '<mjs-layout-homonyme-demo></mjs-layout-homonyme-demo>'
    await new Promise(r => setTimeout(r, 120))
    const el: any = document.body.firstElementChild
    const calls = spyApplyLayout(el)
    el._set('layout', 'grid')
    assert.deepEqual(calls, [], "le composant garde la main sur son propre \\$layout")
    assert.equal(el._state.layout, 'grid', "l'état métier doit quand même être écrit")
  })
})
