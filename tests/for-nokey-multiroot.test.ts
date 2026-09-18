// {for} SANS `by`, itération multi-racines
// (élément + {if} frère), liste REFABRIQUÉE à chaque rendu (objets NEUFS,
// mêmes données). Mesure le nombre de nœuds sur 3 rendus successifs.
// À supprimer en fin d'enquête si non concluant / redondant.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function mount(component: string, tag: string) {
  const root = mjsTmp('nokey')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${tag}.mjs`), component)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const win: any = new Window({ url: 'http://localhost/' })
  const document: any = win.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${tag}-`).test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
  win.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
  document.body.innerHTML = `<mjs-${tag}></mjs-${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))
  return { win, document, el }
}

describe('{for} sans `by`, listes refabriquées, objets neufs', function () {
  this.timeout(60000)
  after(async () => { await terminateSharedWorkerPool() })

  // Scénario A — 3 lignes, {if} toujours VRAI dès le départ, 2 nœuds racine
  // par itération (<li> + <span>). 3 rendus successifs, données identiques,
  // TABLEAU rebâti (objets neufs) à chaque rendu via un compteur $gen.
  it('A — 3 lignes, {if} vrai dès le départ, rebuild complet × 3 rendus', async function () {
    const COMPONENT = `
<script lang="coffee">
$gen = 0
$rows = [
  { label: 'a', tagged: true }
  { label: 'b', tagged: true }
  { label: 'c', tagged: true }
]
rebuild = ->
  $gen = $gen + 1
  $rows = [
    { label: 'a', tagged: true }
    { label: 'b', tagged: true }
    { label: 'c', tagged: true }
  ]
</script>
<div>
  <button class="rebuild-btn" @click={rebuild()}>rebuild</button>
  <ul>
    {for row in $rows}
      <li>{row.label}</li>
      {if row.tagged}<span class="tag">*</span>{end}
    {end}
  </ul>
</div>
`
    const { win, el } = await mount(COMPONENT, 'scen-a')
    const countLi = () => el._shadow.querySelectorAll('li').length
    const countTag = () => el._shadow.querySelectorAll('span.tag').length
    const countAll = () => el._shadow.querySelectorAll('ul > *').length

    const mesures: any[] = []
    mesures.push({ rendu: 0, li: countLi(), tag: countTag(), total: countAll() })

    for (let i = 1; i <= 3; i++) {
      el._shadow.querySelector('button.rebuild-btn')
        .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
      await new Promise(r => setTimeout(r, 80))
      mesures.push({ rendu: i, li: countLi(), tag: countTag(), total: countAll() })
    }

    console.log('SCENARIO A (2 nœuds/itération, if toujours vrai) :', JSON.stringify(mesures))
    for (const m of mesures) {
      assert.equal(m.li, 3, `rendu ${m.rendu} : <li> attendu 3, trouvé ${m.li}`)
      assert.equal(m.tag, 3, `rendu ${m.rendu} : <span.tag> attendu 3, trouvé ${m.tag}`)
    }
    win.close?.()
  })

  // Scénario B — {if} bascule ALÉATOIREMENT (mais déterministe par rendu) faux
  // puis vrai à chaque item, à CHAQUE rendu ; objets neufs à chaque fois.
  it('B — {if} bascule à chaque rendu (faux→vrai→faux), rebuild complet × 3', async function () {
    const COMPONENT = `
<script lang="coffee">
$gen = 0
$rows = [
  { label: 'a', tagged: false }
  { label: 'b', tagged: false }
  { label: 'c', tagged: false }
]
rebuild = ->
  $gen = $gen + 1
  t = ($gen % 2) == 1
  $rows = [
    { label: 'a', tagged: t }
    { label: 'b', tagged: t }
    { label: 'c', tagged: t }
  ]
</script>
<div>
  <button class="rebuild-btn" @click={rebuild()}>rebuild</button>
  <ul>
    {for row in $rows}
      <li>{row.label}</li>
      {if row.tagged}<span class="tag">*</span>{end}
    {end}
  </ul>
</div>
`
    const { win, el } = await mount(COMPONENT, 'scen-b')
    const countLi = () => el._shadow.querySelectorAll('li').length
    const countTag = () => el._shadow.querySelectorAll('span.tag').length

    const mesures: any[] = []
    mesures.push({ rendu: 0, li: countLi(), tag: countTag() })
    for (let i = 1; i <= 4; i++) {
      el._shadow.querySelector('button.rebuild-btn')
        .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
      await new Promise(r => setTimeout(r, 80))
      mesures.push({ rendu: i, li: countLi(), tag: countTag() })
    }
    console.log('SCENARIO B (if bascule à chaque rendu) :', JSON.stringify(mesures))
    for (const m of mesures) {
      assert.equal(m.li, 3, `rendu ${m.rendu} : <li> attendu 3, trouvé ${m.li}`)
    }
    win.close?.()
  })

  // Scénario C — 7 lignes, 3 nœuds racine par
  // itération (<li> + <span if> + <em if>), rebuild complet × 3.
  it('C — 7 lignes, 3 nœuds racine/itération, rebuild complet × 3', async function () {
    const mkRows = () => Array.from({ length: 7 }, (_, i) => `{ label: 'row${i}', tagged: true, marked: true }`).join('\n    ')
    const COMPONENT = `
<script lang="coffee">
$gen = 0
$rows = [
    ${mkRows()}
]
rebuild = ->
  $gen = $gen + 1
  $rows = [
    ${mkRows()}
  ]
</script>
<div>
  <button class="rebuild-btn" @click={rebuild()}>rebuild</button>
  <ul>
    {for row in $rows}
      <li>{row.label}</li>
      {if row.tagged}<span class="tag">*</span>{end}
      {if row.marked}<em class="mark">!</em>{end}
    {end}
  </ul>
</div>
`
    const { win, el } = await mount(COMPONENT, 'scen-c')
    const countLi = () => el._shadow.querySelectorAll('li').length
    const countTag = () => el._shadow.querySelectorAll('span.tag').length
    const countMark = () => el._shadow.querySelectorAll('em.mark').length
    const countAll = () => el._shadow.querySelectorAll('ul > *').length

    const mesures: any[] = []
    mesures.push({ rendu: 0, li: countLi(), tag: countTag(), mark: countMark(), total: countAll() })
    for (let i = 1; i <= 3; i++) {
      el._shadow.querySelector('button.rebuild-btn')
        .dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
      await new Promise(r => setTimeout(r, 80))
      mesures.push({ rendu: i, li: countLi(), tag: countTag(), mark: countMark(), total: countAll() })
    }
    console.log('SCENARIO C (7 lignes, 3 noeuds/iteration) :', JSON.stringify(mesures))
    for (const m of mesures) {
      assert.equal(m.li, 7, `rendu ${m.rendu} : <li> attendu 7, trouvé ${m.li}`)
      assert.equal(m.total, 21, `rendu ${m.rendu} : total attendu 21, trouvé ${m.total}`)
    }
    win.close?.()
  })
})
