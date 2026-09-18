// Régression (bug confirmé au banc navigateur E2E) —
// `{for}` non keyé (sans `by`) tatouait chaque item-objet d'une propriété
// `_mjsId` ÉNUMÉRABLE (clé implicite de reconciliation, _mjs_reconcileList).
// L'hypothèse du commentaire d'origine (« pas sérialisé en pratique ») était
// fausse : JSON.stringify/spread/Object.keys la récupéraient — un store
// serveur {hits:42} devenait {hits:42,_mjsId:"mjs-3"} côté appli, flux temps
// réel compris. Fix : `_mjsId` posé en propriété NON-énumérable
// (Object.defineProperty), avec repli silencieux (pas de tatouage, pas de
// crash) sur les objets non extensibles.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script lang="coffee">
$items = [
  {hits: 1}
  {hits: 2}
  Object.freeze({hits: 3})
]
</script>
<ul>
{for it in $items}
  <li class="row">{it.hits}</li>
{end}
</ul>
`

describe('{for} non keyé — `_mjsId` implicite NON-énumérable (bug E2E)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('JSON.stringify/Object.keys ne fuient pas `_mjsId` ; clé stable entre 2 rendus ; item gelé sans crash', async () => {
    const root = mjsTmp('mjsidhidden')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'mjsidhidden.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^mjsidhidden-/.test(f))
    assert.ok(coreFile && compFile)
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-mjsidhidden></mjs-mjsidhidden>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    // Rendu initial : pas de crash (item gelé compris), 3 lignes correctes.
    const rowsInit = el._shadow.querySelectorAll('li.row')
    assert.equal(rowsInit.length, 3)
    assert.equal(rowsInit[0].textContent.trim(), '1')
    assert.equal(rowsInit[1].textContent.trim(), '2')
    assert.equal(rowsInit[2].textContent.trim(), '3')

    // `_mjsId` ne fuit ni en JSON.stringify, ni en Object.keys, ni en spread —
    // et la LECTURE directe continue de fonctionner (non-énumérable ≠ illisible).
    const leak = window.eval(`
      const c = document.querySelector('mjs-mjsidhidden');
      const it = c._state.items[0];
      JSON.stringify({
        json: JSON.stringify(it),
        keys: Object.keys(it),
        spread: JSON.stringify({...it}),
        direct: it._mjsId,
      });
    `)
    const parsed = JSON.parse(leak)
    assert.equal(parsed.json, '{"hits":1}', "JSON.stringify d'un item ne doit PAS contenir _mjsId")
    assert.deepEqual(parsed.keys, ['hits'], 'Object.keys(item) doit rester propre (pas de _mjsId énumérable)')
    assert.equal(parsed.spread, '{"hits":1}', 'le spread {...item} ne doit PAS récupérer _mjsId')
    assert.ok(parsed.direct && parsed.direct.startsWith('mjs-'), 'la LECTURE directe item._mjsId doit toujours fonctionner')

    // Clé stable entre 2 rendus : mêmes items, un 2e passage de `_mjs_renderStruct`
    // (rejoue toute la reconciliation) doit retomber sur les MÊMES noeuds DOM
    // pour les items non gelés — preuve que le tatouage `_mjsId` a persisté.
    const rowsBefore = el._shadow.querySelectorAll('li.row')
    window.eval(`document.querySelector('mjs-mjsidhidden')._mjs_renderStruct();`)
    await new Promise((r) => setTimeout(r, 80))
    const rowsAfter = el._shadow.querySelectorAll('li.row')
    assert.equal(rowsAfter.length, 3, 'toujours 3 lignes après le 2e rendu (item gelé compris, pas de crash)')
    assert.equal(rowsAfter[0].textContent.trim(), '1')
    assert.equal(rowsAfter[1].textContent.trim(), '2')
    assert.equal(rowsAfter[2].textContent.trim(), '3')
    assert.equal(rowsAfter[0], rowsBefore[0], 'item[0] (non gelé) : MÊME noeud DOM après le 2e rendu — clé implicite stable')
    assert.equal(rowsAfter[1], rowsBefore[1], 'item[1] (non gelé) : MÊME noeud DOM après le 2e rendu — clé implicite stable')
  })
})

// Occurrence sœur — le générateur (compile.ts) posait
// directement `parentItem._mjsId ??= 'mjs-' + (++this._mjs_id_gen)` pour dériver le
// cacheId d'un `{for}` IMBRIQUÉ non keyé : même motif fautif que ci-dessus
// (énumérable, crash sur objet gelé) mais sur l'item du `{for}` PARENT. Fix :
// `this._mjs_mjsTag(parentItem)`, MÊME méthode partagée que `_mjs_reconcileList`.
describe('{for} imbriqué non keyé — cacheId parent via `_mjs_mjsTag` (occurrence sœur, compile.ts)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('JSON.stringify du parent ne fuit pas `_mjsId` ; parent gelé sans crash ; DOM interne stable entre 2 rendus', async () => {
    // µ.raw() sur les items du groupe gelé : évite un bug SÉPARÉ (pré-existant,
    // hors périmètre ici) — la réactivité profonde (_mjs_wrapDeep) re-proxifie
    // toute propriété objet/array lue à travers un item réactif, ce qui viole
    // l'invariant Proxy sur une prop non-configurable/non-writable (créée par
    // Object.freeze) et fait planter TOUT le rendu. µ.raw() désactive le
    // tracking profond sur ce tableau précis, ce qui isole le test sur ce
    // qu'on vérifie réellement ici : le tatouage `_mjsId` du parent gelé.
    const COMPONENT_NESTED = `
<script lang="coffee">
$groups = [
  {name: 'a', items: [1, 2]}
  {name: 'b', items: [3, 4]}
  Object.freeze({name: 'c', items: µ.raw([5, 6])})
]
</script>
<div>
{for grp in $groups}
  <ul class="group">
  {for n in grp.items}
    <li class="item">{n}</li>
  {end}
  </ul>
{end}
</div>
`
    const root = mjsTmp('mjsidnested')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'mjsidnested.mjs'), COMPONENT_NESTED)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^mjsidnested-/.test(f))
    assert.ok(coreFile && compFile)
    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")
    window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
    document.body.innerHTML = '<mjs-mjsidnested></mjs-mjsidnested>'
    const el: any = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))

    // Rendu initial : 3 groupes, 2 items chacun (item gelé compris, pas de crash).
    const groupsInit = el._shadow.querySelectorAll('ul.group')
    assert.equal(groupsInit.length, 3)
    assert.deepEqual([...groupsInit[0].querySelectorAll('li.item')].map((n: any) => n.textContent.trim()), ['1', '2'])
    assert.deepEqual([...groupsInit[1].querySelectorAll('li.item')].map((n: any) => n.textContent.trim()), ['3', '4'])
    assert.deepEqual([...groupsInit[2].querySelectorAll('li.item')].map((n: any) => n.textContent.trim()), ['5', '6'])

    // `_mjsId` du PARENT (grp) ne fuit pas — c'est le cacheId du {for} imbriqué
    // (compile.ts, this._mjs_mjsTag(grp)) qui le tatoue, pas seulement _mjs_reconcileList.
    const leak = window.eval(`
      const c = document.querySelector('mjs-mjsidnested');
      const g0 = c._state.groups[0];
      const g2 = c._state.groups[2];
      JSON.stringify({
        json0: JSON.stringify(g0),
        keys0: Object.keys(g0),
        spread0: JSON.stringify({...g0}),
        direct0: g0._mjsId,
        frozen2: Object.isFrozen(g2),
        json2: JSON.stringify(g2),
        keys2: Object.keys(g2),
      });
    `)
    const parsed = JSON.parse(leak)
    assert.equal(parsed.json0, '{"name":"a","items":[1,2]}', "JSON.stringify du parent ne doit PAS contenir _mjsId")
    assert.deepEqual(parsed.keys0, ['name', 'items'], 'Object.keys(parent) doit rester propre')
    assert.equal(parsed.spread0, '{"name":"a","items":[1,2]}', 'le spread {...parent} ne doit PAS récupérer _mjsId')
    assert.ok(parsed.direct0 && parsed.direct0.startsWith('mjs-'), 'la LECTURE directe grp._mjsId doit toujours fonctionner')
    assert.ok(parsed.frozen2, 'le 3e groupe est bien gelé (pré-requis du test)')
    assert.equal(parsed.json2, '{"name":"c","items":[5,6]}', 'parent gelé : toujours pas de _mjsId (repli silencieux, pas de tatouage)')
    assert.deepEqual(parsed.keys2, ['name', 'items'], 'parent gelé : Object.keys reste propre')

    // Identité DOM stable entre 2 rendus pour un parent NON gelé : preuve que le
    // cacheId du {for} imbriqué (dérivé de grp._mjsId) est resté stable — sinon
    // le cache interne du {for} imbriqué serait manqué et reconstruit à neuf.
    const itemsBefore = [...groupsInit[0].querySelectorAll('li.item')]
    window.eval(`document.querySelector('mjs-mjsidnested')._mjs_renderStruct();`)
    await new Promise((r) => setTimeout(r, 80))
    const groupsAfter = el._shadow.querySelectorAll('ul.group')
    const itemsAfter = [...groupsAfter[0].querySelectorAll('li.item')]
    assert.equal(groupsAfter.length, 3, 'toujours 3 groupes après le 2e rendu (groupe gelé compris, pas de crash)')
    assert.deepEqual([...groupsAfter[2].querySelectorAll('li.item')].map((n: any) => n.textContent.trim()), ['5', '6'], 'groupe gelé : contenu toujours correct après le 2e rendu')
    assert.equal(itemsAfter.length, 2)
    assert.equal(itemsAfter[0], itemsBefore[0], 'item[0] du groupe[0] (parent non gelé) : MÊME nœud DOM après le 2e rendu — cacheId imbriqué stable')
    assert.equal(itemsAfter[1], itemsBefore[1], 'item[1] du groupe[0] (parent non gelé) : MÊME nœud DOM après le 2e rendu — cacheId imbriqué stable')
  })
})
