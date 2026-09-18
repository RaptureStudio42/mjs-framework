// `@flip={duration: <expression>}` — la durée CALCULÉE n'était pas gardée.
//
// Le générateur lisait l'objet à la regex (`duration\s*:\s*(\d+)`) et figeait le
// nombre trouvé dans l'attribut `mjs-flip` au moment de la COMPILATION. Écrit
// `@flip={duration: 2500 * $ralenti}`, le compilateur ne retenait donc que
// `2500` : build vert, console muette, animation qui ne suivait pas le curseur —
// exactement le genre de panne qu'on ne voit qu'à l'œil, sur une leçon de tuto.
//
// Fix : les champs de l'objet sont découpés à profondeur ET chaînes équilibrées
// (`easing: 'cubic-bezier(0.25, 1, 0.5, 1)'` porte des virgules qui ne séparent
// rien) ; un champ non littéral part en LIAISON sur `mjs-flip*` (même code
// d'update que n'importe quel attribut dynamique), le repli statique restant
// écrit dans le template. Le runtime relit les trois attributs à CHAQUE
// animation (runtime/mjs_flip.ts) — une liaison y suffit.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('@flip — durée/delay/easing CALCULÉS (liaison au lieu du gel au build)', function () {
  this.timeout(20000)
  after(async () => { await terminateSharedWorkerPool() })

  async function compileComp(html: string): Promise<{ errors: string[]; code: string | null }> {
    const root   = mjsTmp('flipdyn')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'comp.mjs'), html)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    let code: string | null = null
    if (stats.errors.length === 0) {
      const compFile = readdirSync(outDir).find(f => /^comp-/.test(f))!
      code = readFileSync(join(outDir, compFile), 'utf-8')
    }
    await bundler.close()
    return { errors: stats.errors.map(e => e.message), code }
  }

  // liste `<li>` animée — le contexte RÉEL de @flip (le wrapper runtime ne
  // s'active que sur une réconciliation de liste).
  function liste(flipAttr: string): string {
    return `
<script lang="coffee">
  $todos   = [{ id: 1 }, { id: 2 }]
  $ralenti = 1
</script>
<ul>
  {for todo in $todos by id}
    <li ${flipAttr}>{todo.id}</li>
  {end}
</ul>
`
  }

  it('durée LITTÉRALE : figée dans le template, aucune liaison (comportement inchangé)', async () => {
    const r = await compileComp(liste('@flip={duration: 2500}'))
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /setAttribute\("mjs-flip", "2500"\)/, 'le littéral reste écrit dans le template cloné')
    assert.doesNotMatch(r.code!, /_mjs_updAttrNode\([^)]*'mjs-flip'/, 'aucune liaison ne doit être émise pour un littéral')
  })

  it("durée CALCULÉE : liaison émise, et le repli statique `mjs-flip='200'` reste posé", async () => {
    const r = await compileComp(liste('@flip={duration: 2500 * $ralenti}'))
    assert.deepEqual(r.errors, [])
    assert.doesNotMatch(r.code!, /setAttribute\("mjs-flip", "2500"\)/, "AVANT le fix : la regex retenait `2500` et jetait `* $ralenti` en silence")
    assert.match(r.code!, /setAttribute\("mjs-flip", "200"\)/, 'repli statique — le nœud reste détectable par le runtime avant le 1er update')
    assert.match(r.code!, /const _mjsFlipVal_\w+ = 2500 \* [^;]*ralenti;/, 'la durée est relue à chaque rendu')
    assert.match(r.code!, /_mjs_updAttrNode\([^,]+, 'mjs-flip', \(_mjsFlipVal_\w+ == null \|\| _mjsFlipVal_\w+ === false\) \? "200" : _mjsFlipVal_\w+\)/, 'et coalescée vers la durée de repli plutôt que de retirer l\'attribut')
  })

  it('durée calculée : même expression JS que le contournement manuel `mjs-flip={…}`, au secours près', async () => {
    const directive   = await compileComp(liste('@flip={duration: 2500 * $ralenti}'))
    const contournage = await compileComp(liste("@flip={duration: 200} mjs-flip={2500 * $ralenti}"))
    assert.deepEqual(directive.errors, [])
    assert.deepEqual(contournage.errors, [])
    const exprDirective   = directive.code!.match(/const _mjsFlipVal_\w+ = ([^;]+);/)![1]
    const exprContournage = contournage.code!.match(/_mjs_updAttrNode\([^,]+, 'mjs-flip', (.+?)\); \}/)![1]
    assert.equal(exprDirective, exprContournage, 'la directive doit transpiler l\'expression comme le chemin dynamique éprouvé')
  })

  it("easing littéral à virgules (`cubic-bezier(0.25, 1, 0.5, 1)`) : figé, jamais découpé", async () => {
    const r = await compileComp(liste("@flip={duration: 300, easing: 'cubic-bezier(0.25, 1, 0.5, 1)', delay: 600}"))
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /setAttribute\("mjs-flip", "300"\)/)
    assert.match(r.code!, /setAttribute\("mjs-flip-delay", "600"\)/)
    assert.match(r.code!, /setAttribute\("mjs-flip-easing", "cubic-bezier\(0\.25, 1, 0\.5, 1\)"\)/, 'les virgules DANS la chaîne ne séparent aucun champ')
  })

  it('champs mixtes : le calculé part en liaison, les littéraux restent figés', async () => {
    const r = await compileComp(liste("@flip={duration: 400, delay: 100 * $ralenti, easing: 'ease-in'}"))
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /setAttribute\("mjs-flip", "400"\)/)
    assert.match(r.code!, /setAttribute\("mjs-flip-easing", "ease-in"\)/)
    assert.doesNotMatch(r.code!, /setAttribute\("mjs-flip-delay"/, 'un delay calculé ne doit PAS être figé dans le template')
    assert.match(r.code!, /const _mjsFlipVal_\w+ = 100 \* [^;]+;[^;]*_mjs_updAttrNode\([^,]+, 'mjs-flip-delay'/, 'le delay calculé est relu à chaque rendu')
    assert.match(r.code!, /'mjs-flip-delay', \(_mjsFlipVal_\w+ == null \|\| _mjsFlipVal_\w+ === false\) \? "0" :/, 'le delay calculé porte lui aussi son secours')
  })

  it('easing calculé : secours = la courbe par défaut du runtime, littéral JS bien formé', async () => {
    const r = await compileComp(liste("@flip={duration: 300, easing: $courbe}"))
    assert.deepEqual(r.errors, [])
    assert.match(r.code!, /'mjs-flip-easing', \(_mjsFlipVal_\w+ == null \|\| _mjsFlipVal_\w+ === false\) \? "cubic-bezier\(0\.25, 1, 0\.5, 1\)" :/)
  })

  // Clé DUPLIQUÉE : `splitFlipEntries` ne déduplique pas, un même champ peut donc être à la
  // fois littéral et calculé. Le littéral part alors en SECOURS — et un `007` glissé NU en
  // position d'expression JS donne « Octal literals are not allowed in strict mode » :
  // `assertValidEsm` refuse le module, le composant n'est PAS émis. D'où l'encodage systématique
  // du secours en littéral JS (`JSON.stringify`), pour les trois champs.
  for (const champ of ['duration', 'delay'] as const) {
    it(`clé \`${champ}\` dupliquée (littéral à zéro en tête + calculé) : compile, secours encodé`, async () => {
      const attr = champ === 'duration'
        ? '@flip={duration: 007, duration: 50 * $ralenti}'
        : '@flip={duration: 300, delay: 007, delay: 50 * $ralenti}'
      const r = await compileComp(liste(attr))
      assert.deepEqual(r.errors, [], 'un littéral octal-like ne doit pas faire échouer le build')
      assert.match(r.code!, /\? "007" :/, 'le secours est une CHAÎNE, jamais un token JS nu')
    })
  }

  // Une durée calculée peut valoir `undefined` — config pas encore chargée, champ absent,
  // drapeau à `false`. `_mjs_updAttrNode` RETIRE alors l'attribut (sémantique normale des
  // attributs), et `hasAttribute('mjs-flip')` est la porte d'entrée de TOUT le mécanisme
  // FLIP (runtime/mjs_flip.ts) : le nœud devient invisible du système et n'est plus jamais
  // animé, sans un mot. D'où la valeur de secours. Les trois cas ci-dessous montent le
  // composant POUR DE VRAI (happy-dom) : un contrôle sur le codegen ne verrait rien.
  async function monter(nom: string, source: string): Promise<{ el: any; window: any }> {
    const root   = mjsTmp(`flipnul-${nom}`)
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${nom}.mjs`), source)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats   = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))
    const fichiers = readdirSync(outDir)
    const sansEsm  = (t: string) => t.replace(/^\s*import\s+[^;]+;\s*$/gm, '').replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '').replace(/\bexport\s+default\s+/g, '').replace(/\bexport\s+/g, '').replace(/import\.meta\.url/g, "'http://localhost/'")
    const coeur    = sansEsm(readFileSync(join(outDir, fichiers.find(f => /^mjs_core-/.test(f))!), 'utf-8'))
    const compo    = sansEsm(readFileSync(join(outDir, fichiers.find(f => new RegExp(`^${nom}-`).test(f))!), 'utf-8'))
    const window: any = new Window({ url: 'http://localhost/' })
    window.eval(`${coeur}\nglobalThis.µ = µ;\n${compo}`)
    window.document.body.innerHTML = `<mjs-${nom}></mjs-${nom}>`
    await bundler.close()
    await new Promise(r => setTimeout(r, 80))
    return { el: window.document.body.firstElementChild, window }
  }

  it("durée calculée qui vaut `undefined` en `{for}` : `mjs-flip` reste POSÉ (secours), le FLIP n'est pas désactivé", async () => {
    const { el } = await monter('flipnulfor', ['<script lang="coffee">', '  $todos = [{ id: 1 }, { id: 2 }]', '  $cfg   = {}', '</script>', '<ul>', '  {for todo in $todos by id}', '    <li @flip={duration: $cfg.d}>{todo.id}</li>', '  {end}', '</ul>'].join('\n'))
    const lis = [...el._shadow.querySelectorAll('li')]
    assert.equal(lis.length, 2)
    for (const li of lis) {
      assert.equal(li.hasAttribute('mjs-flip'), true, 'SANS secours : attribut retiré → le nœud sort du mécanisme FLIP, en silence')
      assert.equal(li.getAttribute('mjs-flip'), '200', 'le secours est la durée de repli du champ')
    }
  })

  it('durée calculée qui vaut `undefined` au root : même secours', async () => {
    const { el } = await monter('flipnulroot', ['<script lang="coffee">', '  $cfg = {}', '</script>', '<div @flip={duration: $cfg.d}>x</div>'].join('\n'))
    const div = el._shadow.querySelector('div')
    assert.equal(div.hasAttribute('mjs-flip'), true)
    assert.equal(div.getAttribute('mjs-flip'), '200')
  })

  it("delay calculé qui vaut `undefined` : `mjs-flip-delay='0'` posé, pas d'attribut retiré", async () => {
    const { el } = await monter('flipnuldelay', ['<script lang="coffee">', '  $cfg = {}', '</script>', '<div @flip={duration: 300, delay: $cfg.d}>x</div>'].join('\n'))
    const div = el._shadow.querySelector('div')
    assert.equal(div.getAttribute('mjs-flip'), '300')
    assert.equal(div.getAttribute('mjs-flip-delay'), '0', 'le défaut du runtime, mais ÉCRIT — lisible dans l\'inspecteur')
  })

  it('easing calculé qui vaut `undefined` : la courbe par défaut est posée en clair', async () => {
    const { el } = await monter('flipnuleasing', ['<script lang="coffee">', '  $cfg = {}', '</script>', '<div @flip={duration: 300, easing: $cfg.e}>x</div>'].join('\n'))
    const div = el._shadow.querySelector('div')
    assert.equal(div.getAttribute('mjs-flip-easing'), 'cubic-bezier(0.25, 1, 0.5, 1)')
  })

  it("durée qui DEVIENT nulle en cours de vie : l'attribut ne disparaît pas", async () => {
    const { el, window } = await monter('flipnulvie', ['<script lang="coffee">', '  $d = 500', '</script>', '<div @flip={duration: $d}>x</div>'].join('\n'))
    const div = el._shadow.querySelector('div')
    assert.equal(div.getAttribute('mjs-flip'), '500')
    window.eval('µ._set(document.body.firstElementChild, "d", undefined)')
    await new Promise(r => setTimeout(r, 60))
    assert.equal(div.hasAttribute('mjs-flip'), true, 'une valeur devenue nulle ne doit pas désarmer le FLIP')
    assert.equal(div.getAttribute('mjs-flip'), '200')
  })
})
