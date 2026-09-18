// Non-régression — reproduction SUR PIÈCE d'un cas réel :
// {for} IMBRIQUÉ, boucle interne `by unit` dont le champ `unit` N'EXISTE PAS
// clef INSTABLE d'un rendu à l'autre, itération MULTI-RACINES (<div.service>
// + {if app} + {if open}). Symptôme d'origine : « 51 → 58 nœuds au 2e rendu »,
// la ligne principale remplacée, ses `{if}` frères LAISSÉS DERRIÈRE.
// Prouvé par sabotage de `_mjs_liveEntryNodes` : sans le correctif, .floor 4 → 8.

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
  const root = mjsTmp('services')
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

describe('{for} imbriqué à clef INSTABLE (change à chaque rendu)', function () {
  this.timeout(60000)
  after(async () => { await terminateSharedWorkerPool() })

  const COMPONENT = `
<script lang="coffee">
$gen = 0
$open = ''
mk = (g) ->
  [
    { name: 'apps', services: [ { label: 'puma', floor: 2, k: 'p' + g }, { label: 'redis', floor: 1, k: 'r' + g } ] }
    { name: 'machine', services: [ { label: 'php-fpm', floor: 3, k: 'f' + g }, { label: 'nginx', floor: 1, k: 'n' + g } ] }
  ]
$groups = mk(0)
rebuild = ->
  $gen = $gen + 1
  $groups = mk($gen)
</script>
<div>
  <button class="rebuild-btn" @click={rebuild()}>rebuild</button>
  <div class="wrap">
    {for group in $groups by name}
      <div class="group">
        <div class="group-name">{group.name}</div>
        {for service in group.services by k}
          <div class="service">{service.label}</div>
          {if service.floor}
            <div class="floor">plancher {service.floor}</div>
          {end}
          {if $open==service.label}
            <div class="ssh">ssh</div>
          {end}
        {end}
      </div>
    {end}
  </div>
</div>
`

  it('clef instable — la ligne ET ses `{if}` frères sont évincés ensemble', async function () {
    const { win, el } = await mount(COMPONENT, 'services-bad')
    const count = () => ({
      service: el._shadow.querySelectorAll('div.service').length,
      floor:   el._shadow.querySelectorAll('div.floor').length,
      total:   el._shadow.querySelectorAll('div.group > *').length,
    })
    const mesures: any[] = [{ rendu: 0, ...count() }]
    for (let i = 1; i <= 4; i++) {
      el._shadow.querySelector('button.rebuild-btn').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
      await new Promise(r => setTimeout(r, 80))
      mesures.push({ rendu: i, ...count() })
    }
    console.log('CLEF INSTABLE :', JSON.stringify(mesures))
    for (const m of mesures) {
      assert.equal(m.service, 4, `rendu ${m.rendu} : .service attendu 4, trouvé ${m.service}`)
      assert.equal(m.floor, 4, `rendu ${m.rendu} : .floor attendu 4, trouvé ${m.floor}`)
    }
    win.close?.()
  })

  // Variante : la clef ne CHANGE pas, elle est MORTE — `by unit` sur un champ
  // absent (cas réel d'un renommage de champ) ⇒ `undefined` pour tous les items,
  // donc dédoublonnage + clef unique conservée d'un rendu à l'autre.
  it('clef morte (`by champInexistant`) — pas d\'accumulation non plus', async function () {
    const { win, el } = await mount(COMPONENT.replace('by k}', 'by unit}'), 'services-dead')
    const count = () => ({
      service: el._shadow.querySelectorAll('div.service').length,
      floor:   el._shadow.querySelectorAll('div.floor').length,
    })
    const mesures: any[] = [{ rendu: 0, ...count() }]
    for (let i = 1; i <= 3; i++) {
      el._shadow.querySelector('button.rebuild-btn').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
      await new Promise(r => setTimeout(r, 80))
      mesures.push({ rendu: i, ...count() })
    }
    console.log('CLEF MORTE :', JSON.stringify(mesures))
    for (const m of mesures) assert.equal(m.floor, m.service, `rendu ${m.rendu} : .floor (${m.floor}) doit suivre .service (${m.service})`)
    win.close?.()
  })
})
