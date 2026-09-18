// Régression : `@group=!{item.x}` dans un
// `{for}` posait un `name='mjs-grp-...'` STATIQUE (dérivé du seul texte de
// l'expression, ex. "item-rep") — IDENTIQUE sur toutes les rows du template
// partagé. Deux groupes de radios indépendants (une question par row) se
// retrouvaient dans le MÊME groupe HTML natif : cocher la réponse de la
// question 2 décochait VISUELLEMENT la réponse de la question 1 (exclusivité
// radio native jouant entre rows). Fix : `node.name` réécrit à chaque update
// avec un suffixe qui varie par row (index de boucle).
//
// Régression : ce suffixe INCONDITIONNEL cassait l'idiome
// INVERSE — `{for opt in $menu}<input type="radio" @group=!{$choice}>` (une
// option par row, UN SEUL groupe partagé via une var EXTERNE). Un name différent
// par row → navigation flèches morte (groupes de 1), Tab arrêté sur chaque radio,
// soumission par name cassée. Fix affiné : on ne suffixe QUE si l'expression liée
// DÉPEND de la boucle (item/index). Les deux cas sont couverts ci-dessous.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { mjsTmp } from './helpers/tmp.js'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

describe('@group dans {for} — noms de radios distincts par row', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('deux rows de radios (même texte de var) reçoivent des name= DIFFÉRENTS, et cocher l\'une ne décoche pas l\'autre', async () => {
    const src = [
      '<script lang="coffee">',
      '$quiz = [{id:1, rep: null}, {id:2, rep: null}]',
      '</script>',
      '<div>',
      '{for row in $quiz}',
      '<div class="q">',
      '<input class="oui" type="radio" value="oui" @group=!{row.rep}>',
      '<input class="non" type="radio" value="non" @group=!{row.rep}>',
      '</div>',
      '{end}',
      '</div>',
    ].join('\n')

    const root = mjsTmp('grpfor')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'grpfor.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^grpfor-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-grpfor></mjs-grpfor>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const qs = el._shadow.querySelectorAll('.q')
    assert.equal(qs.length, 2, 'les 2 rows doivent être rendues')
    const row1Oui = qs[0].querySelector('.oui')
    const row2Oui = qs[1].querySelector('.oui')

    assert.notEqual(row1Oui.name, row2Oui.name, "AVANT le fix : même name='mjs-grp-row-rep' sur les 2 rows")

    // Coche la réponse "oui" de la row 2.
    row2Oui.checked = true
    row2Oui.dispatchEvent(new window.Event('change', { bubbles: true }))
    await new Promise(r => setTimeout(r, 80))

    assert.equal(row2Oui.checked, true, 'la row 2 doit rester cochée')
    assert.equal(
      row1Oui.checked,
      false,
      "AVANT le fix : cocher la row 2 aurait pu décocher visuellement la row 1 (même groupe radio natif) — ici on vérifie juste qu'elle n'a jamais été affectée"
    )
  })

  it('var EXTERNE partagée `@group=!{$choice}` (une option par row) : name IDENTIQUE sur toutes les rows', async () => {
    const src = [
      '<script lang="coffee">',
      "$choice = 'b'",
      "$menu = ['a', 'b', 'c']",
      '</script>',
      '<div>',
      '{for opt in $menu}',
      '<input class="opt" type="radio" value={opt} @group=!{$choice}>',
      '{end}',
      '</div>',
    ].join('\n')

    const root = mjsTmp('grpshared')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'grpshared.mjs'), src)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^grpshared-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-grpshared></mjs-grpshared>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const opts = [...el._shadow.querySelectorAll('.opt')]
    assert.equal(opts.length, 3, 'les 3 options doivent être rendues')
    // Cœur du fix : UN SEUL groupe → même `name` partout (sinon flèches/Tab
    // cassés). AVANT le fix : `mjs-grp-choice-0/-1/-2` (3 groupes de 1).
    assert.equal(opts[0].name, opts[1].name, 'les options partagent le MÊME name (groupe unique)')
    assert.equal(opts[1].name, opts[2].name, 'les options partagent le MÊME name (groupe unique)')
    // L'option correspondant à $choice ('b') est cochée.
    assert.equal(opts[1].checked, true, "l'option value='b' (=$choice) doit être cochée")
    assert.equal(opts[0].checked, false)
    assert.equal(opts[2].checked, false)
  })
})
