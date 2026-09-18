// Régression — CONFIRMÉE EMPIRIQUEMENT
// avant fix : une row poolée (`_mjs_reconcileList`, pool actif
// dès qu'un composant n'a AUCUN hook destroy) contenant un `{for}` imbriqué
// duplique son contenu quand son sous-arbre DOM est réutilisé pour un item
// DIFFÉRENT.
//
// Mécanisme : le pool réutilise le sous-arbre DOM d'une row détruite EN
// L'ÉTAT (attributs/texte statiques intacts, seule `updateFn` est ré-appliquée
// ensuite). Pour le `{for}` imbriqué, `updateFn` recalcule un `uniqueCacheId`
// dérivé du discriminant du NOUVEL item (forcément différent de l'ancien) —
// `_mjs_reconcileList` ne l'ayant JAMAIS vu, il le traite comme un cache FRAIS
// (vide), alors que le DOM entre ses marqueurs contient encore les <li> de
// l'ANCIEN occupant du slot poolé → les nouveaux <li> s'AJOUTENT aux anciens
// au lieu de les remplacer.
//
// Repro empirique AVANT fix :
//   ETAT INITIAL   : id=1:[a] | id=2:[b,c] | id=3:[d]
//   APRES REMOVE 2 : id=1:[a] | id=3:[d]                (id=2 pooled)
//   APRES INSERT 4 : id=1:[a] | id=4:[b,c,e,f] | id=3:[d]   ← b,c FANTÔMES
//
// Fix : `compileFor` (compile.ts) marque `state.hasDestroyHooks = true` dès
// qu'un `{for}` imbriqué est compilé (`ctx.loops.length > 0`) → désactive le
// pool pour TOUT LE COMPOSANT (le pool suppose que seuls attributs/texte
// changent ; faux dès qu'un {for} imbriqué produit un nombre variable
// d'enfants indexés par un cache séparé). Plus sûr qu'un vidage chirurgical
// du sous-arbre au moment du pop (qui exigerait de tracer aussi l'ancre de
// FIN, pas seulement le début, et de gérer une imbrication à N niveaux).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const COMPONENT = `
<script lang="coffee">
$rows = [
  { id: 1, kids: ['a'] }
  { id: 2, kids: ['b', 'c'] }
  { id: 3, kids: ['d'] }
]
removeRow2 = -> $rows.splice(1, 1)
insertRow4 = -> $rows.splice(1, 0, { id: 4, kids: ['e', 'f'] })
</script>
<div>
  {for row in $rows by id}
    <section class="row" data-id="{row.id}">
      {for k in row.kids}<li>{k}</li>{end}
    </section>
  {end}
</div>
<button id="btnRemove" @click={removeRow2}>remove</button>
<button id="btnInsert" @click={insertRow4}>insert</button>
`

describe('runtime — pool + {for} imbriqué : pas de contenu fantôme au ré-usage', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it("réutiliser le slot poolé de la row id=2 pour une nouvelle row id=4 ne mélange PAS les <li> de l'ancien et du nouvel item", async function () {
    const root = mjsTmp('poolnest')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'poolnest.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^poolnest-/.test(f))
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

    document.body.innerHTML = '<mjs-poolnest></mjs-poolnest>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const dump = () => Object.fromEntries(
      [...el._shadow.querySelectorAll('section.row')].map((s: any) =>
        [s.getAttribute('data-id'), [...s.querySelectorAll('li')].map((n: any) => n.textContent)]
      )
    )

    assert.deepEqual(dump(), { '1': ['a'], '2': ['b', 'c'], '3': ['d'] }, 'état initial : 3 rows')

    // Supprime id=2 — son sous-arbre est pooled (composant sans hooks destroy
    // AUTRES QUE ce {for} imbriqué — précisément ce que ce test vérifie).
    el._shadow.querySelector('#btnRemove').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))
    assert.deepEqual(dump(), { '1': ['a'], '3': ['d'] }, 'id=2 retirée')

    // Insère id=4 à la MÊME position (1) — candidat naturel à la réutilisation
    // du slot poolé de l'ex-id=2.
    el._shadow.querySelector('#btnInsert').dispatchEvent(new win.Event('click', { bubbles: true, composed: true }))
    await new Promise(r => setTimeout(r, 80))

    const after = dump()
    assert.deepEqual(
      after,
      { '1': ['a'], '4': ['e', 'f'], '3': ['d'] },
      "AVANT le fix : row id=4 affichait ['b','c','e','f'] (contenu fantôme de l'ex-id=2 mélangé au nouveau) — repro confirmée empiriquement avant ce fix",
    )

    win.close?.()
  })

  it("un composant SANS {for} imbriqué garde le pool ACTIF (pas de régression perf pour le cas commun)", async function () {
    const SIMPLE = `
<script lang="coffee">
$rows = [{id:1,label:'a'},{id:2,label:'b'},{id:3,label:'c'}]
removeRow2 = -> $rows.splice(1, 1)
</script>
<div>
  {for row in $rows by id}<div class="row">{row.label}</div>{end}
</div>
<button id="btnRemove" @click={removeRow2}>del</button>
`
    const root = mjsTmp('poolsimple')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'poolsimple.mjs'), SIMPLE)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^poolsimple-/.test(f))
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)

    document.body.innerHTML = '<mjs-poolsimple></mjs-poolsimple>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    assert.equal(el.constructor._mjs_noDestroyHooks, true, 'sans {for} imbriqué, le pool O23 doit rester actif (pas de régression perf)')
    win.close?.()
  })
})
