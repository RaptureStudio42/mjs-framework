// Routage d'événements ORPHELIN après remplacement de nœud par <@element>/<@module>. Un
// `@click={…}` posé DIRECTEMENT sur <@element $tag @click={…}> compile un id de routage porté
// par une PROP `_mjs_ids` sur le nœud lui-même (mjs_element.ts::_mjs_registerRefs/_mjs_bindEvents). Or
// µ._updDynEl/µ._updModule créent un nouveau nœud, copient attributs + style.cssText
// mais pas `_mjs_ids` : la délégation d'événements (root.addEventListener sur le shadow) ne
// retrouve plus l'id sur le nœud REMPLACÉ — un clic direct sur <@element>/<@module> cesse de
// répondre dès le 1er remplacement de nœud (cas quasi général, le placeholder étant un <div>
// codé en dur ; tout $tag différent déclenche un remplacement au 1er rendu).
//
// Harnais calqué sur tests/runtime-dynel-refs-resync.test.ts (Bundler réel + happy-dom, seule
// façon de faire tourner les VRAIS effets/routes émis par le générateur). Le test avec un
// composant réel (<@module>) reprend en plus le patron multi-fichiers de tests/binding-cast-composant.test.ts
// (eval mjs_core- puis CHAQUE composant compilé, dans n'importe quel ordre — aucune instanciation
// avant `document.body.innerHTML`, donc l'ordre d'eval entre composants n'a pas d'importance).

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

// Compile UN OU PLUSIEURS composants .mjs (source complète) dans un dossier tmp dédié, les
// évalue dans une Window happy-dom fraîche, monte `<mjs-{mainTagBase}>` et retourne
// `{ window, document, el }`. `files` = { tagBase: source } ; `mainTagBase` DOIT être une des
// clés de `files`, c'est le composant qu'on monte réellement dans le body.
async function mountComponent(mainTagBase: string, files: Record<string, string>): Promise<{ window: any; document: any; el: any }> {
  const root = mjsTmp('a3r2i-'+ mainTagBase)
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  for (const tagBase in files) writeFileSync(join(srcDir, tagBase +'.mjs'), files[tagBase])
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, `compilation ${mainTagBase} : ${stats.errors.map((e: any) => e.message).join('\n')}`)
  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const outFiles = readdirSync(outDir)
  const coreFile = outFiles.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'core doit être compilé')
  let script = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')) +'\nglobalThis.µ = µ;\n'
  for (const tagBase in files) {
    const compFile = outFiles.find((f: string) => new RegExp('^'+ tagBase +'-').test(f))
    assert.ok(compFile, tagBase +' doit être compilé parmi : '+ outFiles.join(', '))
    script += stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')) +'\n'
  }
  window.eval(script)
  const tag = 'mjs-'+ mainTagBase
  document.body.innerHTML = `<${tag}></${tag}>`
  const el: any = document.body.firstElementChild
  await new Promise((r) => setTimeout(r, 50))
  return { window, document, el }
}

describe('<@element>/<@module> : routage d\'événements resynchronisé après remplacement de nœud', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  // <@element $tag @click={…}> : $tag='p' DÈS LE DÉPART (remplacement au tout 1er
  // rendu, cas quasi général) → clic sur le <p> réel incrémente ; bascule p→span (2e
  // remplacement) → clic sur le <span> réel incrémente toujours.
  it('<@element> $tag=\'p\' dès le 1er rendu : clic incrémente ; bascule p→span : clic incrémente toujours', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
$hits = 0
</script>
<@element $tag @click={$hits = $hits + 1}>Hits: {$hits}</@element>
<button id="tospan" @click={$tag = 'span'}>tospan</button>
`
    const { window, el } = await mountComponent('a3r2ievta', { a3r2ievta: src })

    // Setup — remplacement dès le 1er rendu : le <p> réel existe.
    let p: any = el._shadow.querySelector('p')
    assert.ok(p, 'le <p> doit avoir remplacé le placeholder <div> dès le 1er rendu')
    assert.match(p.textContent, /Hits:\s*0/, 'compteur initial')

    // Clic DIRECT sur le <p> réel : le routage doit retrouver l'id malgré le remplacement.
    p.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    p = el._shadow.querySelector('p')
    assert.match(p.textContent, /Hits:\s*1/, 'le clic sur le <p> réel doit incrémenter (routage @click resynchronisé)')

    // Bascule p → span : nouveau remplacement, la liaison @click doit suivre le nouveau nœud.
    el._shadow.querySelector('#tospan').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const span: any = el._shadow.querySelector('span')
    assert.ok(span, 'le <span> doit avoir remplacé le <p>')
    assert.equal(!!el._shadow.querySelector('p'), false, 'le <p> ne doit plus être dans le DOM')

    span.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.match(span.textContent, /Hits:\s*2/, 'le clic sur le <span> (2e remplacement) doit toujours incrémenter')

    window.close?.()
  })

  // <@module $comp @click={…}> avec un composant RÉEL (custom element MJS enregistré, pas
  // juste un tag natif) : le clic sur le composant remonté doit répondre.
  it('<@module> $comp = composant réel : clic sur le composant remonté incrémente', async function () {
    this.timeout(30000)
    const box = `<div class="realbox">boîte réelle</div>`
    const src = `
<script lang="coffee">
$comp = 'mjs-a3r2ievtbox'
$hits = 0
</script>
<@module $comp @click={$hits = $hits + 1}>contenu</@module>
<p id="hits">Hits: {$hits}</p>
`
    const { window, el } = await mountComponent('a3r2ievtc', { a3r2ievtc: src, a3r2ievtbox: box })

    const boxEl: any = el._shadow.querySelector('mjs-a3r2ievtbox')
    assert.ok(boxEl, 'le composant réel doit avoir remplacé le placeholder <div> dès le 1er rendu')
    assert.match(el._shadow.querySelector('#hits').textContent, /Hits:\s*0/, 'compteur initial')

    boxEl.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.match(el._shadow.querySelector('#hits').textContent, /Hits:\s*1/, 'le clic sur le composant remonté doit incrémenter (routage resynchronisé)')

    window.close?.()
  })

  // Modificateur `.prevent` : le corps ET le preventDefault doivent rester actifs après le
  // remplacement de nœud (le modificateur est encodé dans la route, adressée par le MÊME id que
  // celui qu'on recopie — si le routage ne suit pas, ni le corps ni le modificateur ne jouent).
  it('@click.prevent conservé après le remplacement de nœud', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'a'
$hits = 0
</script>
<@element $tag @click.prevent={$hits = $hits + 1}>clic</@element>
`
    const { window, el } = await mountComponent('a3r2ievtd', { a3r2ievtd: src })

    const a: any = el._shadow.querySelector('a')
    assert.ok(a, 'le <a> doit avoir remplacé le placeholder <div> dès le 1er rendu')

    const evt = new window.MouseEvent('click', { bubbles: true, cancelable: true })
    a.dispatchEvent(evt)
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(evt.defaultPrevented, true, '.prevent doit toujours appeler preventDefault après le remplacement')
    assert.equal(el._state.hits, 1, 'le corps du handler doit aussi s\'exécuter (routage OK, pas seulement le modificateur)')

    window.close?.()
  })

  // Enfant du <@element> avec son propre @click : toujours routé après un ou plusieurs
  // remplacements (NON-RÉGRESSION : les enfants sont DÉPLACÉS vers le nouveau nœud, pas
  // recréés — ce mécanisme existait déjà avant ce correctif, il ne doit pas le casser).
  it('enfant du <@element> avec son propre @click : toujours routé (déplacé, pas recréé)', async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'p'
$hits = 0
</script>
<@element $tag><button id="childbtn" @click={$hits = $hits + 1}>enfant</button></@element>
<button id="tospan" @click={$tag = 'span'}>tospan</button>
<p id="hits">Hits: {$hits}</p>
`
    const { window, el } = await mountComponent('a3r2ievte', { a3r2ievte: src })

    let btn: any = el._shadow.querySelector('#childbtn')
    assert.ok(btn, 'le bouton enfant doit exister dès le 1er rendu (déjà remplacé une fois)')
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.match(el._shadow.querySelector('#hits').textContent, /Hits:\s*1/, 'le clic sur l\'enfant doit incrémenter après le 1er remplacement')

    // 2e remplacement (p → span) : l'enfant est DÉPLACÉ vers le <span>, toujours routé.
    el._shadow.querySelector('#tospan').dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    btn = el._shadow.querySelector('#childbtn')
    assert.ok(btn, 'le bouton enfant doit avoir suivi le <span>')
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    assert.match(el._shadow.querySelector('#hits').textContent, /Hits:\s*2/, 'le clic sur l\'enfant doit toujours incrémenter après le 2e remplacement')

    window.close?.()
  })

  // Non-régression : $tag reste 'div' (identique au placeholder), aucun remplacement de
  // nœud ne se produit jamais ; la liaison @click doit rester vivante comme avant ce correctif.
  it("non-régression : \$tag='div' (jamais remplacé) : @click reste vivant", async function () {
    this.timeout(30000)
    const src = `
<script lang="coffee">
$tag = 'div'
$hits = 0
</script>
<@element $tag @click={$hits = $hits + 1}>Hits: {$hits}</@element>
`
    const { window, el } = await mountComponent('a3r2ievtf', { a3r2ievtf: src })

    const div1: any = el._shadow.querySelector('div[mjs-el]') || el._shadow.querySelector('div')
    assert.ok(div1, 'le <div> (même tag que le placeholder) doit exister')

    div1.dispatchEvent(new window.MouseEvent('click', { bubbles: true }))
    await new Promise((r) => setTimeout(r, 50))
    const div2: any = el._shadow.querySelector('div')
    assert.equal(div2, div1, 'jamais remplacé : même référence de nœud avant/après le clic')
    assert.match(div2.textContent, /Hits:\s*1/, 'le clic doit incrémenter sur le nœud jamais remplacé')

    window.close?.()
  })
})
