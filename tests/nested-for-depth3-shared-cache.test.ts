// Régression — TROIS `{for}` imbriqués : la boucle la plus
// interne DUPLIQUE son contenu au premier rafraîchissement.
//
// Mécanisme : `compileFor` (compile.ts) ne compose le `uniqueCacheId` d'une boucle imbriquée que sur
// son parent DIRECT — sa clef si le parent est keyé, sinon `_mjs_mjsTag(objet)`, ou l'INDEX pour des
// items primitifs. À trois niveaux, le discriminant du grand-parent n'entre nulle part : deux
// branches sœurs du grand-parent produisent alors le MÊME cacheId pour leur boucle interne, et se
// partagent les mêmes cases de cache. Au rafraîchissement, `_mjs_reconcileList` retrouve les clefs de la
// DERNIÈRE branche rendue, déplace SES nœuds entre les ancres de la PREMIÈRE, et les nœuds que
// celle-ci avait créés restent en place, inconnus du cache → contenu affiché en double.
//
// Repro observée en production : chaque valeur affichée
// deux fois dans les huit prisons, les deux valeurs courantes surlignées toutes les deux.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

// la boucle du milieu itère des CHAÎNES sans `by` — la forme qui
// retombe sur l'index. `valeurs()` rend des objets NEUFS à chaque rendu, comme toute liste dérivée
const COMPONENT = `
<script lang="coffee">
$prisons = [
  { nom: 'alpha' }
  { nom: 'beta' }
]
$cles = ['maxretry', 'findtime']
valeurs = (prison, cle)-> [ { v: "#{cle}-1" }, { v: "#{cle}-2" } ]
rafraichir = -> $prisons = [ { nom: 'alpha' }, { nom: 'beta' } ]
</script>
<div>
  {for prison in $prisons by nom}
    <section class="prison" data-nom="{prison.nom}">
      {for cle in $cles}
        <div class="reglage" data-cle="{cle}">
          {for offerte in valeurs(prison, cle) by v}<b>{offerte.v}</b>{end}
        </div>
      {end}
    </section>
  {end}
</div>
<button id="btn" @click={rafraichir}>refresh</button>
`

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

describe('compilation — trois {for} imbriqués : chaque branche a son propre cache', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('le contenu de la boucle la plus interne ne double pas au rafraîchissement', async function () {
    const root   = mjsTmp('depth3')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'depth3.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any      = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files    = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^depth3-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-depth3></mjs-depth3>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    // une entrée par couple prison/clef, avec les valeurs affichées dessous
    const dump = () => Object.fromEntries(
      [...el._shadow.querySelectorAll('section.prison')].flatMap((s: any) =>
        [...s.querySelectorAll('div.reglage')].map((d: any) =>
          [`${s.getAttribute('data-nom')}·${d.getAttribute('data-cle')}`, [...d.querySelectorAll('b')].map((n: any) => n.textContent)]
        )
      )
    )

    const attendu = {
      'alpha·maxretry': [ 'maxretry-1', 'maxretry-2' ],
      'alpha·findtime': [ 'findtime-1', 'findtime-2' ],
      'beta·maxretry':  [ 'maxretry-1', 'maxretry-2' ],
      'beta·findtime':  [ 'findtime-1', 'findtime-2' ],
    }

    assert.deepEqual(dump(), attendu, 'premier rendu : deux valeurs par couple prison/clef')

    // LE RAFRAICHISSEMENT, ET C'EST LUI QUI REVELE LE PARTAGE : le tableau parent est reassigne avec
    // les MEMES clefs — les rows sont donc mises a jour, pas recreees, et chaque boucle interne
    // rejoue son `_mjs_updList` sur le cache que sa soeur a ecrase au premier rendu
    el._shadow.querySelector('#btn').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.deepEqual(
      dump(),
      attendu,
      'AVANT le fix : alpha affichait quatre valeurs par reglage (les siennes plus celles de beta, deplacees depuis le cache partage)',
    )

    win.close?.()
  })


  it("un grand-parent non keyé sur des chaînes garde lui aussi son propre cache (chemin `_mjs_idx_N`)", async function () {
    const COMPONENT_NU = `
<script lang="coffee">
$groupes = ['nord', 'sud']
$cles = ['un', 'deux']
valeurs = (groupe, cle)-> [ { v: "#{groupe}-#{cle}-1" }, { v: "#{groupe}-#{cle}-2" } ]
rafraichir = -> $groupes = ['nord', 'sud']
</script>
<div>
  {for groupe in $groupes}
    <section class="groupe" data-nom="{groupe}">
      {for cle in $cles}
        <div class="reglage" data-cle="{cle}">
          {for offerte in valeurs(groupe, cle) by v}<b>{offerte.v}</b>{end}
        </div>
      {end}
    </section>
  {end}
</div>
<button id="btn" @click={rafraichir}>refresh</button>
`
    const root   = mjsTmp('depth3nu')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'depth3nu.mjs'), COMPONENT_NU)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const files    = readdirSync(outDir)
    const compFile = files.find((f: string) => /^depth3nu-/.test(f))!
    const compile  = readFileSync(join(outDir, compFile), 'utf-8')

    // le discriminant du grand-parent passe par son handle d'index interne, jamais par `index` nu :
    // à ce niveau, la boucle des clefs a déjà pris ce nom-là
    assert.match(compile, /_mjs_idx_0/, "le discriminant du grand-parent doit s'appuyer sur `_mjs_idx_0`")

    const win: any      = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const coreFile      = files.find((f: string) => /^mjs_core-/.test(f))!
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(compile)}`)

    document.body.innerHTML = '<mjs-depth3nu></mjs-depth3nu>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const dump = () => Object.fromEntries(
      [...el._shadow.querySelectorAll('section.groupe')].flatMap((s: any) =>
        [...s.querySelectorAll('div.reglage')].map((d: any) =>
          [`${s.getAttribute('data-nom')}·${d.getAttribute('data-cle')}`, [...d.querySelectorAll('b')].length]
        )
      )
    )

    const attendu = { 'nord·un': 2, 'nord·deux': 2, 'sud·un': 2, 'sud·deux': 2 }
    assert.deepEqual(dump(), attendu, 'premier rendu : deux valeurs par couple groupe/clef')

    el._shadow.querySelector('#btn').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))
    assert.deepEqual(dump(), attendu, 'AVANT le fix : quatre valeurs par couple — les quatre branches partageaient deux caches')

    win.close?.()
  })
})
