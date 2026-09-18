// Régression : le générateur émettait des identifiants NUS
// (`v`, `startNode`, `endNode`, `cfn`) dans le corps de `updateFn` d'un
// `{for}`, absents de `RESERVED_TEMPLATE_NAMES` (le parseur ne les rejetait
// donc PAS à la compilation). Un item de boucle nommé ainsi provoquait :
//   - `v`          → crash TDZ dur : `const v = v.id` (ReferenceError)
//   - `startNode`/`endNode` → corruption SILENCIEUSE : lecture de l'ancre
//     DOM interne au lieu de l'item utilisateur, sans la moindre erreur
//   - `cfn`        → même risque (variable de contrôle de branche `{if}`)
//
// Fix : ces temporaires sont renommés `_mjs_cfn`/`_mjs_ifStart`/`_mjs_ifEnd`/
// `_mjs_keyStart`/`_mjs_keyEnd`/`_mjs_keyVal` dans generator/compile.ts.
//
// Ces tests vérifient le comportement RUNTIME réel (via happy-dom, composant
// bundlé et monté) — pas seulement "ça compile" : `const v = v.id` est un
// crash au RUNTIME (TDZ), pas à la compilation, un test qui ne ferait que
// vérifier `transpile()` sans exécuter le composant ne l'aurait pas détecté.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

async function mountComponent(name: string, source: string): Promise<{ window: any; el: any; document: any }> {
  const root = mjsTmp(`rn-${name}`)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, `${name}.mjs`), source)

  const bundler = new Bundler({
    sourceDir: srcDir,
    outputDir: outDir,
    manifestPath: join(root, 'bundle.js'),
  })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window = new Window({ url: 'http://localhost/' })
  const document: any = window.document

  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
  assert.ok(coreFile && compFile, 'core et composant compilés')

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")
  const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
  const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))

  // Capture les erreurs runtime (ReferenceError etc.) qui, sans cette
  // capture, seraient juste loguées par happy-dom sans faire échouer le test.
  const errors: any[] = []
  window.addEventListener('error', (e: any) => errors.push(e.error ?? e.message))

  window.eval(`
    ${coreCode}
    globalThis.µ = µ;
    ${compCode}
  `)

  const tag = `mjs-${name}`
  document.body.innerHTML = `<${tag}></${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise(r => setTimeout(r, 80))

  if (errors.length > 0) {
    throw new Error(`Erreur(s) runtime pendant le montage de ${tag} : ${errors.map(String).join(' | ')}`)
  }

  return { window, el, document }
}

describe('noms réservés — item de {for} nommé comme un temporaire interne', function () {
  this.timeout(40000)

  after(async () => {
    await terminateSharedWorkerPool()
  })

  it("item nommé `v` dans {for}+{key} : NE CRASH PLUS (ex-TDZ « Cannot access 'v' before initialization »)", async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,name:"a"},{id:2,name:"b"}]',
      '</script>',
      '<ul>',
      '{for v in $rows}',
      '{key v.id}',
      '<li>{v.name}</li>',
      '{end}',
      '{end}',
      '</ul>',
    ].join('\n')
    const { el } = await mountComponent('rnv', src)
    const items = el._shadow.querySelectorAll('li')
    assert.equal(items.length, 2, 'les 2 items doivent être rendus (pas de crash au mount)')
    assert.equal(items[0].textContent.trim(), 'a')
    assert.equal(items[1].textContent.trim(), 'b')
  })

  it("item nommé `startNode` dans {for}+{if} : affiche l'item réel, pas l'ancre interne", async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,active:true,label:"un"},{id:2,active:false,label:"deux"}]',
      '</script>',
      '<ul>',
      '{for startNode in $rows}',
      '{if startNode.active}',
      '<li class="on">{startNode.label}</li>',
      '{end}',
      '{end}',
      '</ul>',
    ].join('\n')
    const { el } = await mountComponent('rnstart', src)
    const on = el._shadow.querySelectorAll('li.on')
    assert.equal(on.length, 1, 'une seule row active doit être rendue')
    assert.equal(on[0].textContent.trim(), 'un', "le texte doit être l'item RÉEL (\"un\"), pas une valeur issue de l'ancre DOM interne")
  })

  it("item nommé `endNode` dans {for}+{key} : la clé réfère bien à l'item, pas à l'ancre", async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,label:"x"}]',
      '</script>',
      '<ul>',
      '{for endNode in $rows}',
      '{key endNode.id}',
      '<li>{endNode.label}</li>',
      '{end}',
      '{end}',
      '</ul>',
    ].join('\n')
    const { el } = await mountComponent('rnend', src)
    const items = el._shadow.querySelectorAll('li')
    assert.equal(items.length, 1)
    assert.equal(items[0].textContent.trim(), 'x')
  })

  it("item nommé `cfn` dans {for}+{if} : ne casse pas le contrôle de branche", async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,active:true,label:"ok"}]',
      '</script>',
      '<ul>',
      '{for cfn in $rows}',
      '{if cfn.active}',
      '<li>{cfn.label}</li>',
      '{end}',
      '{end}',
      '</ul>',
    ].join('\n')
    const { el } = await mountComponent('rncfn', src)
    const items = el._shadow.querySelectorAll('li')
    assert.equal(items.length, 1)
    assert.equal(items[0].textContent.trim(), 'ok')
  })

  it("item PARENT nommé `startNode` dans {for}+{for} imbriqué : la sous-liste itère l'item réel, pas l'ancre", async () => {
    // compile.ts:685 — la boucle interne émettait `const startNode = __nodes[...]`
    // (ancre du wrapper) qui SHADOWAIT l'item parent `startNode` : `startNode.subs`
    // lisait `.subs` de l'ancre DOM (undefined) → sous-liste VIDE, silencieusement.
    const src = [
      '<script lang="coffee">',
      '$list = [{id:1, subs:[{k:"a"},{k:"b"}]}, {id:2, subs:[{k:"c"}]}]',
      '</script>',
      '<ul>',
      '{for startNode in $list}',
      '<li>{startNode.id}<ul>{for x in startNode.subs}<li class="sub">{x.k}</li>{end}</ul></li>',
      '{end}',
      '</ul>',
    ].join('\n')
    const { el } = await mountComponent('rnnestedstart', src)
    const subs = el._shadow.querySelectorAll('li.sub')
    assert.equal(subs.length, 3, "les 3 sous-items doivent être rendus (AVANT le fix : 0, `startNode.subs` lu sur l'ancre)")
    assert.deepEqual([...subs].map((n: any) => n.textContent.trim()), ['a', 'b', 'c'])
  })

  it("variable SCRIPT `startNode` lue par un {for} dans une branche {success} : itère la var réelle, pas l'ancre", async () => {
    // compile.ts:647 — {for} en branche {await} sans loop parent : les vars
    // TOP-LEVEL du script sont en scope. `const startNode = __nodes[...]` shadowait
    // la var `startNode` du <script> → `startNode.items` lisait l'ancre (undefined).
    const src = [
      '<script lang="coffee">',
      'startNode = { items: [{k:"a"},{k:"b"}] }',
      '$promise = Promise.resolve(42)',
      '</script>',
      '{await $promise}',
      '<p>...</p>',
      '{success val}',
      '<ul>{for x in startNode.items}<li class="ai">{x.k}</li>{end}</ul>',
      '{end}',
    ].join('\n')
    const { el } = await mountComponent('rnawaitstart', src)
    const items = el._shadow.querySelectorAll('li.ai')
    assert.equal(items.length, 2, "AVANT le fix : 0 item (`startNode.items` lu sur l'ancre DOM interne)")
    assert.deepEqual([...items].map((n: any) => n.textContent.trim()), ['a', 'b'])
  })

  it('cas nominal (item nommé `item`, aucun risque) : toujours correct après le fix', async () => {
    const src = [
      '<script lang="coffee">',
      '$rows = [{id:1,name:"a"}]',
      '</script>',
      '<ul>{for item in $rows}{key item.id}<li>{item.name}</li>{end}{end}</ul>',
    ].join('\n')
    const { el } = await mountComponent('rnnominal', src)
    assert.equal(el._shadow.querySelector('li').textContent.trim(), 'a')
  })
})

// Cas exploratoire (pas un "tueur" confirmé comme les 4 ci-dessus, mais un
// risque THÉORIQUE) : `node` comme NOM D'ITEM de
// {for} est déjà bloqué à la compilation (RESERVED_TEMPLATE_NAMES, vérifié
// juste au-dessus). Le risque réel ici est différent :
// generator/attributes/index.ts déclare des temporaires `node`/`t`/`o`/…
// en `const` À L'INTÉRIEUR de chaque bloc de binding — CE N'EST PAS couvert
// par `rejectReservedName` (qui ne garde QUE item/index de {for}, nom de
// {const}, arg de {success}/{error}) si le nom `node` désigne plutôt une
// VARIABLE DE SCRIPT TOP-LEVEL (pas un item de boucle), lue depuis un binding
// hors {for}. Ce test vérifie empiriquement CE scénario précis, pour trancher
// : casse → nouveau CRITIQUE à traiter ; tient → risque théorique seulement
// (generator/attributes/index.ts pourra approfondir plus tard).
describe('cas exploratoire — variable SCRIPT top-level nommée `node`, lue dans un binding @style (generator/attributes/index.ts)', function () {
  this.timeout(40000)
  after(async () => { await terminateSharedWorkerPool() })

  it('$node top-level (PAS un item de {for}), lu dans @style.color={node} sur un élément HORS {for} : la couleur doit être celle du script user', async () => {
    const src = [
      '<script lang="coffee">',
      'node = "green"',
      '</script>',
      '<p @style.color={node}>hello</p>',
    ].join('\n')
    const { el } = await mountComponent('probenodetop', src)
    const p = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit exister')
    assert.equal(p.style.color, 'green', "la couleur doit venir de LA variable user `node`, pas d'un temporaire interne homonyme")
  })
})

describe('RESERVED_TEMPLATE_NAMES — nettoyage (test en boîte noire via transpile())', () => {
  // RESERVED_TEMPLATE_NAMES est un détail d'implémentation privé du parseur ;
  // on vérifie son EFFET (rejet ou non à la compilation) via l'API publique
  // plutôt que d'exporter une constante interne juste pour le test.

  it('`__arr` (vrai fantôme, 0 émission nulle part dans src/) : un item ainsi nommé compile SANS erreur', async function () {
    this.timeout(40000) // démarrage à froid du worker-pool : évite le flake 2000ms
    const { transpile } = await import('../src/transpiler/index.js')
    const src = ['<script>$rows = [1,2]</script>', '{for __arr in $rows}<li>{__arr}</li>{end}'].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rn-arr-allowed' })
    assert.ok(output.length > 0, '__arr doit être un nom d\'item valide (purgé de la liste, plus jamais émis par le générateur)')
  })

  it("CORRECTION EN COURS DE ROUTE — `__built`/`_item` restent RÉSERVÉS (signalés à tort comme fantômes : ils sont activement émis dans generator/compile.ts, invisible à un grep classique à cause des octets NUL du fichier — voir commentaire RESERVED_TEMPLATE_NAMES)", async () => {
    const { transpile } = await import('../src/transpiler/index.js')
    for (const name of ['__built', '_item']) {
      const src = [`<script>$rows = [1,2]</script>`, `{for ${name} in $rows}<li>{${name}}</li>{end}`].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: `mjs-rn-${name}-still-blocked` }),
        /NOM RÉSERVÉ/,
        `${name} doit rester bloqué à la compilation (encore activement émis par le générateur)`
      )
    }
  })

  it("`e`/`el` restent réservés (contrat documenté des handlers, pas une fuite à masquer)", async () => {
    const { transpile } = await import('../src/transpiler/index.js')
    for (const name of ['e', 'el']) {
      const src = [`<script>$rows = [1]</script>`, `{for ${name} in $rows}<li>{${name}}</li>{end}`].join('\n')
      await assert.rejects(
        () => transpile(src, { moduleName: `mjs-rn-${name}-blocked` }),
        /NOM RÉSERVÉ/,
        `${name} doit rester bloqué (utilisé nu dans TOUS les handlers d'événements)`
      )
    }
  })

  it('un item de {for} nommé `v` (ou startNode/endNode/cfn) compile SANS erreur — le fix renomme les internes plutôt que d\'élargir la liste noire', async () => {
    // Contraste volontaire avec l'ancien comportement : avant le fix de
    // generator/compile.ts, ces noms n'étaient PAS dans RESERVED_TEMPLATE_NAMES
    // et compilaient quand même, en cassant au runtime. Le fix choisi est de
    // renommer les temporaires internes (voir describe ci-dessus) plutôt que
    // d'interdire ces noms au dev — ce test documente ce choix.
    const { transpile } = await import('../src/transpiler/index.js')
    const src = [
      '<script>$rows = [{id:1}]</script>',
      '{for v in $rows}{key v.id}<li>{v.id}</li>{end}{end}',
    ].join('\n')
    const { output } = await transpile(src, { moduleName: 'mjs-rn-v-allowed' })
    assert.ok(output.length > 0)
  })
})
