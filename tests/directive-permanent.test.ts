// Directive @permanent → mjs-permanent (preprocessHtml, transpiler/index.ts), même
// famille que @no-ujs (transpiler/index.ts:2470) : forme NUE, casse insensible, masquage
// <pre>/<code>. Fichier NEUF (aucun fichier existant ne compile cette directive — mjs-permanent
// n'était jusqu'ici qu'un attribut plat écrit à la main, cf. tests/ujs-nav-permanent.test.ts pour
// le volet RUNTIME pur, extraction de source + `new Function`, aucune compilation).
//
// Volet COMPILE (transpile() direct, même style que tests/bundler-import-directive-masking.test.ts
// § @noUJS) + UN test bout en bout qui réutilise le harnais runtime existant
// (tests/ujs-nav-permanent.test.ts : extractMarked('helpers-navigation') + happy-dom) pour prouver
// que l'élément produit par LA DIRECTIVE (pas l'attribut plat) est bien transplanté.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { transpile } from '../src/transpiler/index.js'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

describe('preprocessHtml — directive @permanent → mjs-permanent', () => {
  it('<div @permanent id="lecteur"> → mjs-permanent posé, id intact', async () => {
    const { output } = await transpile('<div @permanent id="lecteur">Lecteur</div>', { moduleName: 'perm1' })
    assert.match(output, /mjs-permanent/, 'attribut mjs-permanent absent de la sortie compilée')
    assert.match(output, /id=['"]lecteur['"]/, "l'id doit rester intact")
  })

  it('casse insensible : @Permanent et @PERMANENT sont aussi réécrits (même politique que @no-ujs)', async () => {
    const r1 = await transpile('<div @Permanent id="a">x</div>', { moduleName: 'perm2' })
    const r2 = await transpile('<div @PERMANENT id="b">x</div>', { moduleName: 'perm3' })
    assert.match(r1.output, /mjs-permanent/)
    assert.match(r2.output, /mjs-permanent/)
  })

  it("un @permanent affiché comme EXEMPLE dans un <pre>/<code> n'est PAS réécrit (masquage)", async () => {
    const { output } = await transpile('<p>Exemple :</p>\n<pre><code>&lt;audio @permanent id="radio"&gt;</code></pre>\n<div>x</div>\n', { moduleName: 'perm4' })
    assert.doesNotMatch(output, /mjs-permanent/, 'un @permanent affiché comme démo de code ne doit pas être réécrit comme une VRAIE directive')
    assert.match(output, /@permanent/, 'le texte de démo reste affiché tel quel')
  })

  it('@permanentx (nom différent, PAS un @permanent) → non touché, aucune conversion', async () => {
    const { output } = await transpile('<div @permanentx id="c">x</div>', { moduleName: 'perm5' })
    assert.doesNotMatch(output, /mjs-permanent/, '@permanentx ne doit pas être confondu avec @permanent')
  })

  it('attribut plat mjs-permanent écrit à la main → continue de fonctionner (non-régression)', async () => {
    const { output } = await transpile('<audio mjs-permanent id="radio-player" controls></audio>', { moduleName: 'perm6' })
    assert.match(output, /mjs-permanent/)
    assert.match(output, /id=['"]radio-player['"]/)
  })

  it('@permanent="nom" (avec valeur, guillemets doubles) → ERREUR de compile explicite, message renvoie vers id', async () => {
    await assert.rejects(
      () => transpile('<div @permanent="nom" id="radio">x</div>', { moduleName: 'perm7' }),
      /@permanent="nom".*ne prend jamais de valeur.*id/s,
    )
  })

  it("@permanent='nom' (avec valeur, guillemets simples) → même ERREUR", async () => {
    await assert.rejects(
      () => transpile(`<div @permanent='nom' id="radio">x</div>`, { moduleName: 'perm8' }),
      /ne prend jamais de valeur/,
    )
  })
})

describe('directive @permanent — bout en bout : compilé puis transplanté par le runtime', function () {
  it('un élément compilé avec @permanent (id intact) est retrouvé et transplanté par µ._mjs_navTransplantPermanents', async function () {
    const { output } = await transpile('<div @permanent id="radio">Lecteur</div>', { moduleName: 'permrt' })
    const m = output.match(/_mjs_cloneTpl\("([^"]*)"\)/)
    assert.ok(m, '_mjs_cloneTpl introuvable dans la sortie compilée')
    const html = m![1]
    assert.match(html, /mjs-permanent/, 'le HTML runtime doit porter mjs-permanent')

    const win: any = new Window({ url: 'http://localhost/' })
    const document: any = win.document
    // même bloc « helpers de zone de navigation » que tests/ujs-nav-permanent.test.ts —
    // µ._mjs_navTransplantPermanents et ses dépendances y vivent
    function installHelpers(µ: any, doc: any, window: any) {
      new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, doc, window)
    }
    const µ: any = { warn() {}, error() {}, log() {} }
    installHelpers(µ, document, win)

    const zone: any = document.createElement('div')
    document.body.appendChild(zone)
    zone.innerHTML = html
    const vivant: any = zone.querySelector('#radio')
    assert.ok(vivant, "l'élément compilé (@permanent) introuvable après insertion DOM")
    assert.ok(vivant.hasAttribute('mjs-permanent'), 'attribut mjs-permanent posé par le compilateur, retrouvé au runtime')

    // `nodes` qui arrive : un homologue partageant le même id, scénario réaliste de
    // µ._mjs_navInstallNodes (même patron que tests/ujs-nav-permanent.test.ts)
    const wrapper: any = document.createElement('div')
    const entrant: any = document.createElement('div')
    entrant.id = 'radio'
    wrapper.appendChild(entrant)

    µ._mjs_navTransplantPermanents(zone, [wrapper])

    assert.equal(vivant.parentNode, wrapper, "l'élément produit par LA DIRECTIVE a bien été transplanté dans le nouvel arbre")

    win.close?.()
  })
})
