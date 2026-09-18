// Liaison réactive ORPHELINE après remplacement de nœud par <@element>/<@module>. Une liaison
// posée sur <@element $tag @style.color={$c} title={$t}> compile vers `this._mjs_nodes.sN` : la
// référence est figée sur le PREMIER nœud (le placeholder cloné). Dès que µ._updDynEl/
// µ._updModule remplacent le nœud (`cur.replaceWith(nn)`), les effets continuent d'écrire sur
// le nœud DÉTACHÉ — la liaison est morte pour toujours, sans erreur. Cas quasi général (le
// placeholder est un <div> codé en dur ; tout $tag différent déclenche un remplacement au 1er
// rendu).
//
// Harnais calqué sur tests/runtime-e2e.test.ts et ses probes e2e (Bundler réel +
// happy-dom, composants .mjs écrits dans un dossier tmp puis compilés — seule façon de faire
// tourner les VRAIS effets réactifs émis par le générateur, contrairement au harnais brut de
// tests/runtime-dynamic-element-accept.test.ts qui appelle µ._updDynEl/µ._updModule directement sans
// passer par le script compilé d'un composant).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// Compile UN composant .mjs (source complète) dans un dossier tmp dédié, l'évalue dans une
// Window happy-dom fraîche, monte `<mjs-{tagBase}>` et retourne `{ window, document, el }`.
async function mountComponent(tagBase: string, source: string): Promise<{ window: any; document: any; el: any }> {
  const root = mjsTmp('a3r2h-'+ tagBase)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, tagBase +'.mjs'), source)
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, `compilation ${tagBase} : ${stats.errors.map((e: any) => e.message).join('\n')}`)
  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp('^'+ tagBase +'-').test(f))
  assert.ok(coreFile && compFile, 'core et '+ tagBase +' doivent être compilés')
  window.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  const tag = 'mjs-'+ tagBase
  document.body.innerHTML = `<${tag}></${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise((r) => setTimeout(r, 50))
  return { window, document, el }
}

describe('<@element>/<@module> : liaisons réactives resynchronisées après remplacement de nœud', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  // <@element $tag @style.color={$c} title={$t}> : $tag = 'p' DÈS LE DÉPART
  // (remplacement au tout 1er rendu, le cas quasi général) puis bascules successives
  // p → span → p. Les liaisons color/title doivent suivre le nœud COURANT à chaque étape, et
  // l'ancien nœud détaché ne doit plus apparaître dans `component._mjs_nodes`.
  it('<@element> $tag=\'p\' dès le 1er rendu, puis p→span→p : color/title suivent le nœud courant, ancien nœud plus référencé', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
$c = 'red'
$t = 'A'
</script>
<@element $tag @style.color={$c} title={$t}>contenu</@element>
<button id="tospan" @click={$tag = 'span'}>tospan</button>
<button id="topagain" @click={$tag = 'p'}>topagain</button>
<button id="c2" @click={$c = 'blue'}>c2</button>
<button id="c3" @click={$c = 'green'}>c3</button>
<button id="t2" @click={$t = 'B'}>t2</button>
`
    const { window, el } = await mountComponent('dynelrefa', src)

    // (a) setup — remplacement dès le 1er rendu : le <p> réel existe.
    let p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder <div> dès le 1er rendu')

    // (b) $c change → la couleur du <p> RÉEL change.
    el._shadow.querySelector('#c2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    p = el._shadow.querySelector('p')
    assert.match(p.getAttribute('style') || '', /color:\s*blue/, 'la couleur du <p> réel doit suivre $c après le remplacement')

    // (c) title={$t} (attribut réactif) suit lui aussi.
    el._shadow.querySelector('#t2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    p = el._shadow.querySelector('p')
    assert.equal(p.getAttribute('title'), 'B', 'title doit suivre $t après le remplacement')

    // (d) bascule p → span : la liaison suit le nœud courant, l'ancien <p> n'est plus
    // référencé.
    const oldP = p
    el._shadow.querySelector('#tospan').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const span: any = el._shadow.querySelector('span')
    assert.ok(span, 'le <span> doit avoir remplacé le <p>')
    assert.equal(!!el._shadow.querySelector('p'), false, 'le <p> ne doit plus être dans le DOM')
    assert.match(span.getAttribute('style') || '', /color:\s*blue/, 'le <span> hérite de la couleur courante à la bascule')
    assert.equal(span.getAttribute('title'), 'B', 'le <span> hérite du title courant à la bascule')
    assert.equal(oldP.isConnected, false, 'l\'ancien <p> doit être détaché du DOM')
    assert.equal(Object.values(el._mjs_nodes || {}).includes(oldP), false, 'l\'ancien <p> ne doit plus être référencé dans component._mjs_nodes')

    // (e) bascule span → p (nouvelle instance de <p>, pas la même référence qu'en (c)) :
    // la liaison continue de suivre le nœud courant.
    const oldSpan = span
    el._shadow.querySelector('#topagain').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const p2: any = el._shadow.querySelector('p')
    assert.ok(p2, 'un nouveau <p> doit avoir remplacé le <span>')
    assert.notEqual(p2, oldP, 'le nouveau <p> doit être une AUTRE instance que le <p> initial')
    assert.match(p2.getAttribute('style') || '', /color:\s*blue/, 'le nouveau <p> hérite de la couleur courante')
    assert.equal(oldSpan.isConnected, false, 'l\'ancien <span> doit être détaché du DOM')
    assert.equal(Object.values(el._mjs_nodes || {}).includes(oldSpan), false, 'l\'ancien <span> ne doit plus être référencé dans component._mjs_nodes')

    // (f) une mutation réactive APRÈS plusieurs bascules doit toucher le nœud COURANT,
    // pas un des nœuds abandonnés en route.
    el._shadow.querySelector('#c3').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const p3: any = el._shadow.querySelector('p')
    assert.match(p3.getAttribute('style') || '', /color:\s*green/, 'la couleur doit suivre $c sur le nœud courant après plusieurs bascules')
    assert.doesNotMatch(oldP.getAttribute('style') || '', /color:\s*green/, 'l\'ancien nœud détaché ne doit PAS avoir reçu la nouvelle couleur')

    window.close?.()
  })

  // Non-régression : $tag reste 'div' (identique au placeholder), aucun remplacement de
  // nœud ne se produit jamais ; la liaison doit rester vivante comme avant ce correctif.
  it("non-régression : \$tag='div' (jamais remplacé) : la liaison @style.color reste vivante", async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'div'
$c = 'red'
</script>
<@element $tag @style.color={$c}>contenu</@element>
<button id="c2" @click={$c = 'blue'}>c2</button>
`
    const { window, el } = await mountComponent('dynelrefb', src)
    const div1: any = el._shadow.querySelector('div[style]') || el._shadow.querySelector('div')
    assert.ok(div1, 'le <div> (même tag que le placeholder) doit exister')
    assert.match(div1.getAttribute('style') || '', /color:\s*red/, 'couleur initiale')

    el._shadow.querySelector('#c2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const div2: any = el._shadow.querySelector('div[style]') || el._shadow.querySelector('div')
    assert.equal(div2, div1, 'jamais remplacé : même référence de nœud avant/après la mutation')
    assert.match(div2.getAttribute('style') || '', /color:\s*blue/, 'la couleur doit suivre $c sur le nœud jamais remplacé')

    window.close?.()
  })

  // <@module $comp @style.opacity={$o}> : même mécanique que <@element>, remplacement dès
  // le 1er rendu (placeholder <div mjs-mod>, $comp='span' ≠ 'div').
  it("<@module> \$comp='span' dès le 1er rendu : @style.opacity suit le nœud courant", async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$comp = 'span'
$o = '0.5'
</script>
<@module $comp @style.opacity={$o}>contenu</@module>
<button id="o2" @click={$o = '0.9'}>o2</button>
`
    const { window, el } = await mountComponent('dynelrefc', src)
    let span: any = el._shadow.querySelector('span')
    assert.ok(span, 'le <span> doit avoir remplacé le placeholder <div> dès le 1er rendu')
    assert.match(span.getAttribute('style') || '', /opacity:\s*0\.5/, 'opacity initiale portée par le nœud réel')

    el._shadow.querySelector('#o2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    span = el._shadow.querySelector('span')
    assert.match(span.getAttribute('style') || '', /opacity:\s*0\.9/, 'opacity doit suivre $o après le remplacement')

    window.close?.()
  })

  // Masqué ($tag=null) puis $c change PENDANT le masquage puis $tag='p' (démasquage +
  // remplacement simultanés) : couleur à jour sur le NOUVEAU nœud, aucun display:none résiduel.
  it("masqué puis \$c change puis \$tag='p' : couleur à jour sur le nouveau nœud, aucun display:none résiduel", async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = null
$c = 'red'
</script>
<@element $tag @style.color={$c}>contenu</@element>
<button id="c2" @click={$c = 'blue'}>c2</button>
<button id="show" @click={$tag = 'p'}>show</button>
`
    const { window, el } = await mountComponent('dynelrefd', src)
    let hidden: any = el._shadow.querySelector('div')
    assert.ok(hidden, 'le placeholder masqué doit rester en place')
    assert.match(hidden.getAttribute('style') || '', /display:\s*none/, 'masqué dès le 1er rendu ($tag=null)')

    el._shadow.querySelector('#c2').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    hidden = el._shadow.querySelector('div')
    assert.match(hidden.getAttribute('style') || '', /color:\s*blue/, 'la couleur se pose sur le nœud masqué (jamais remplacé à ce stade)')
    assert.match(hidden.getAttribute('style') || '', /display:\s*none/, 'toujours masqué')

    el._shadow.querySelector('#show').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder au démasquage')
    assert.match(p.getAttribute('style') || '', /color:\s*blue/, 'la couleur mémorisée pendant le masquage doit être visible sur le nouveau nœud')
    assert.doesNotMatch(p.getAttribute('style') || '', /display:\s*none/, 'aucun display:none résiduel sur le nouveau nœud')

    window.close?.()
  })
})
