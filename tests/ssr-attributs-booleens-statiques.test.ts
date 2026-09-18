// SSR — un attribut booléen HTML écrit EN DUR dans le HTML du
// composant (nu ou en forme `={true}`) survit-il au rendu serveur ?
// Hypothèse de départ (infirmée) : `checked`/`selected` seraient écrits par
// le runtime via la propriété IDL (node.checked = true) sans setAttribute,
// et le « dirty checkedness flag » du DOM empêcherait la sérialisation de
// refléter l'attribut de contenu.
//
// Résultat (10 cas sur 10) : les 5 attributs
// (checked, selected, disabled, open, required), forme nue ET `={true}`,
// survivent tous au SSR — HTML sérialisé conforme dans les 10 cas.
//
// MAIS le côté NÉGATIF, lui, est cassé — il ne se voit qu'en testant aussi `false`,
// pas seulement `true`. Sur la forme dynamique,
// le générateur pose INCONDITIONNELLEMENT le témoin `attr=''` dans le HTML
// statique (src/generator/attributes/index.ts, dynamic()), puis le runtime
// écrit la seule propriété IDL (src/runtime/mjs_element.ts, _mjs_updAttrNode, via
// MJS_BOOLEAN_PROPS) — jamais removeAttribute. Avec une valeur `false`, le
// témoin reste donc dans le HTML servi : une case rendue COCHÉE côté serveur
// alors que l'état dit décochée, jusqu'à l'hydratation.
//
// Mesuré cas par cas : SEULS `checked` et `selected` sont touchés — ceux que
// la spec DOM soumet au dirty flag, dont la propriété IDL ne se reflète pas
// sur l'attribut de contenu. `disabled`, `open` et `required` se reflètent
// normalement et sortent propres : ils sont testés VERTS ci-dessous. Les deux
// cassés SONT CORRIGÉS : `µ._mjs_updAttrNode` miroite
// l'attribut de contenu pour `checked`/`selected` quand `µ._isServer` — le client,
// lui, ne bouge pas d'un octet (l'attribut y porte la valeur par défaut du
// formulaire, celle que rejoue un reset). Les deux tests sont donc actifs.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { renderToString } from '../src/server/renderToString.js'
import { terminateSharedWorkerPool } from '../src/bundler/index.js'

async function renderAttr(tag: string, html: string) {
  const root   = mjsTmp('ssr-boolattr')
  const srcDir = join(root, 'src')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, tag.replace(/^mjs-/, '')+'.mjs'), `
<script lang="coffee">
</script>
${html}
`)
  return renderToString({ sourceDir: srcDir, tag })
}

describe('SSR — attributs booléens écrits en dur dans le HTML du composant', () => {
  after(async () => {
    await terminateSharedWorkerPool()
  })

  it('checked nu (<input type="checkbox" checked>) survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-check-nu', '<input type="checkbox" checked>')
    assert.match(res.shadowHtml, /<input[^>]*\bchecked\b/,
      `attribut "checked" absent du HTML SSR (forme nue) — HTML produit : ${res.shadowHtml}`)
  })

  it('checked={true} survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-check-dyn', '<input type="checkbox" checked={true}>')
    assert.match(res.shadowHtml, /<input[^>]*\bchecked\b/,
      `attribut "checked" absent du HTML SSR (forme ={true}) — HTML produit : ${res.shadowHtml}`)
  })

  it('selected nu (<option selected>) survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-sel-nu', '<select><option value="a" selected>a</option></select>')
    assert.match(res.shadowHtml, /<option[^>]*\bselected\b/,
      `attribut "selected" absent du HTML SSR (forme nue) — HTML produit : ${res.shadowHtml}`)
  })

  it('selected={true} survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-sel-dyn', '<select><option value="a" selected={true}>a</option></select>')
    assert.match(res.shadowHtml, /<option[^>]*\bselected\b/,
      `attribut "selected" absent du HTML SSR (forme ={true}) — HTML produit : ${res.shadowHtml}`)
  })

  it('disabled nu (<button disabled>) survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-dis-nu', '<button disabled>x</button>')
    assert.match(res.shadowHtml, /<button[^>]*\bdisabled\b/,
      `attribut "disabled" absent du HTML SSR (forme nue) — HTML produit : ${res.shadowHtml}`)
  })

  it('disabled={true} survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-dis-dyn', '<button disabled={true}>x</button>')
    assert.match(res.shadowHtml, /<button[^>]*\bdisabled\b/,
      `attribut "disabled" absent du HTML SSR (forme ={true}) — HTML produit : ${res.shadowHtml}`)
  })

  it('open nu (<details open>) survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-open-nu', '<details open><summary>s</summary>c</details>')
    assert.match(res.shadowHtml, /<details[^>]*\bopen\b/,
      `attribut "open" absent du HTML SSR (forme nue) — HTML produit : ${res.shadowHtml}`)
  })

  it('open={true} survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-open-dyn', '<details open={true}><summary>s</summary>c</details>')
    assert.match(res.shadowHtml, /<details[^>]*\bopen\b/,
      `attribut "open" absent du HTML SSR (forme ={true}) — HTML produit : ${res.shadowHtml}`)
  })

  it('required nu (<input required>) survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-req-nu', '<input type="text" required>')
    assert.match(res.shadowHtml, /<input[^>]*\brequired\b/,
      `attribut "required" absent du HTML SSR (forme nue) — HTML produit : ${res.shadowHtml}`)
  })

  it('required={true} survit au SSR', async function () {
    this.timeout(30000)
    const res = await renderAttr('mjs-req-dyn', '<input type="text" required={true}>')
    assert.match(res.shadowHtml, /<input[^>]*\brequired\b/,
      `attribut "required" absent du HTML SSR (forme ={true}) — HTML produit : ${res.shadowHtml}`)
  })
  // --- côté NÉGATIF : bogue réel, en attente de décision (cf. en-tête) ---

  // ces trois-là sortent PROPRES — pas de dirty flag, la propriété IDL se reflète
  for(const [nom, tag, html, attr] of [
    ['disabled', 'mjs-disabled-faux', '<button disabled={false}>b</button>', 'disabled'],
    ['open',     'mjs-open-faux',     '<details open={false}><p>c</p></details>', 'open'],
    ['required', 'mjs-required-faux', '<input required={false}>', 'required'],
  ] as [string, string, string, string][]) {
    it(`${nom}={false} ne laisse pas l'attribut dans le HTML SSR`, async function () {
      this.timeout(30000)
      const res = await renderAttr(tag, html)
      assert.doesNotMatch(res.shadowHtml, new RegExp(`\\b${attr}\\b`), `témoin ${attr} resté dans le HTML SSR alors que la valeur est false — HTML produit : ${res.shadowHtml}`)
    })
  }

  // ces deux-là ÉTAIENT cassés (dirty flag, témoin fantôme conservé) — corrigés :
  // `µ._mjs_updAttrNode` miroite l'attribut de contenu pour `checked` et
  // `selected`, AU SERVEUR SEULEMENT (cf. src/runtime/mjs_element.ts)
  for(const [nom, tag, html, attr] of [
    ['checked',  'mjs-check-faux',    '<input type="checkbox" checked={false}>', 'checked'],
    ['selected', 'mjs-selected-faux', '<select><option selected={false}>a</option></select>', 'selected'],
  ] as [string, string, string, string][]) {
    it(`${nom}={false} ne laisse pas l'attribut dans le HTML SSR`, async function () {
      this.timeout(30000)
      const res = await renderAttr(tag, html)
      assert.doesNotMatch(res.shadowHtml, new RegExp(`\\b${attr}\\b`), `témoin ${attr} resté dans le HTML SSR alors que la valeur est false — HTML produit : ${res.shadowHtml}`)
    })
  }
})
