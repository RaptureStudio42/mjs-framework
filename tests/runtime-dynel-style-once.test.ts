// Deux régressions du correctif précédent :
// (1) `style=""` parasite — `cur.style` est TOUJOURS truthy (tout nœud DOM porte un
// CSSStyleDeclaration), la garde précédente (`if (cur.style) nn.style.cssText = …`) ne protégeait
// donc rien : un <@element>/<@module> SANS aucun style héritait d'un `style=""` vide dès le
// premier remplacement de nœud. (2) `.once` qui se redéclenche — `_mjs_once_fired`
// (mjs_element.ts) est une `WeakMap<nœud, Set<clé>>` : le nouveau nœud émis par le correctif de resynchronisation est une clé
// neuve, un modificateur `.once` déjà déclenché repart donc à CHAQUE remplacement ultérieur
// (hits 1→2→3 sur 3 remplacements successifs).
//
// Harnais calqué sur tests/runtime-dynel-events-resync.test.ts (Bundler réel + happy-dom, seule
// façon de faire tourner les VRAIS effets/routes émis par le générateur — le mécanisme `.once`
// vit dans mjs_element.ts, hors de portée d'un harnais direct sur mjs_runes.ts seul).

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
  const root = mjsTmp('a3r2j-'+ tagBase)
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

describe('<@element>/<@module> : style="" parasite corrigé + .once ne se redéclenche plus après remplacement', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  // <@element $tag>x</@element>, $tag='p' dès le 1er rendu, AUCUN style : le nœud réel ne
  // doit porter aucun attribut `style` parasite (régression du correctif précédent : `cur.style` toujours truthy).
  it('<@element> sans aucun style : le nœud réel remplacé ne porte pas d\'attribut style parasite', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
</script>
<@element $tag>x</@element>
`
    const { window, el } = await mountComponent('a3r2jt1', src)
    const p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder <div> dès le 1er rendu')
    assert.equal(p.hasAttribute('style'), false, 'aucun style n\'a jamais été posé : pas de style="" parasite sur le nœud réel')
    window.close?.()
  })

  // Non-régression : un style STATIQUE porté par <@element> doit survivre au
  // remplacement de nœud (le filet explicite du cssText reste utile pour un style posé par un
  // effet @style.* juste avant le remplacement, cf. commentaire mjs_runes.ts).
  it('non-régression : <@element style="color:red"> conserve son style statique après remplacement', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
</script>
<@element $tag style="color:red">x</@element>
`
    const { window, el } = await mountComponent('a3r2jt2', src)
    const p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder <div> dès le 1er rendu')
    assert.equal(p.hasAttribute('style'), true, 'le style statique doit rester présent')
    assert.match(p.getAttribute('style') || '', /color:\s*red/, 'la couleur statique doit survivre au remplacement')
    window.close?.()
  })

  // <@element $tag @click.once={…}> : $tag='p' dès le 1er rendu (1er remplacement), puis
  // 2 bascules successives (p→span→a). Le clic ne doit incrémenter QU'UNE FOIS au total, quel
  // que soit le nombre de remplacements de nœud qui suivent (régression du correctif de resynchronisation : `_mjs_once_fired`
  // est une WeakMap PAR NŒUD, le nouveau nœud est une clé neuve).
  it('<@element @click.once> : un seul déclenchement au total, malgré 2 remplacements de nœud successifs', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
$hits = 0
</script>
<@element $tag @click.once={$hits = $hits + 1}>Hits: {$hits}</@element>
<button id="tospan" @click={$tag = 'span'}>tospan</button>
<button id="toa" @click={$tag = 'a'}>toa</button>
`
    const { window, el } = await mountComponent('a3r2jt3', src)

    let p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder <div> dès le 1er rendu')
    p.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._state.hits, 1, 'le 1er clic doit incrémenter')

    el._shadow.querySelector('#tospan').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const span: any = el._shadow.querySelector('span')
    assert.ok(span, 'le <span> doit avoir remplacé le <p>')
    span.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._state.hits, 1, 'le clic après le 1er remplacement (p→span) ne doit PAS redéclencher .once')

    el._shadow.querySelector('#toa').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const a: any = el._shadow.querySelector('a')
    assert.ok(a, 'le <a> doit avoir remplacé le <span>')
    a.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._state.hits, 1, 'le clic après le 2e remplacement (span→a) ne doit PAS redéclencher .once')

    window.close?.()
  })

  // Non-régression : $tag='div' au 1er rendu (aucun remplacement, comme le placeholder)
  // → .once JAMAIS déclenché avant la bascule div→span → le 1er clic APRÈS la bascule doit
  // toujours déclencher .once une fois (le transfert d'entrée ne doit rien casser quand il n'y a
  // rien à transférer).
  it('non-régression : .once jamais déclenché avant la bascule déclenche normalement une fois après', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'div'
$hits = 0
</script>
<@element $tag @click.once={$hits = $hits + 1}>Hits: {$hits}</@element>
<button id="tospan" @click={$tag = 'span'}>tospan</button>
`
    const { window, el } = await mountComponent('a3r2jt4', src)

    assert.equal(el._state.hits, 0, 'aucun clic avant la bascule : compteur à 0')
    el._shadow.querySelector('#tospan').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const span: any = el._shadow.querySelector('span')
    assert.ok(span, 'le <span> doit avoir remplacé le placeholder <div> à la bascule')

    span.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(el._state.hits, 1, 'le 1er clic après la bascule doit déclencher .once normalement')

    window.close?.()
  })
})
