// Test NEUF — cache par instance de la résolution d'ancêtre §§ (_mjs_getRCtx,
// mjs_element.ts). Même méthode « vrai Bundler + happy-dom » que
// ujs-shadow-confirm.test.ts (compilation réelle de composants .mjs, montage,
// assertions runtime) : le cache est un détail d'implémentation interne à
// _mjs_getRCtx, seule une compilation+exécution réelle prouve que la
// sémantique de lecture reste EXACTEMENT celle d'un parcours frais (invariant)
// tout en évitant de reparcourir l'arbre à chaque lecture.
//
// Composants :
//  - rctxprovidera.mjs : déclare §§theme (bleu), expose 2 boutons (.mute mute
//    la couleur EN PLACE, .reassign réaffecte tout §§theme à un nouvel objet),
//    <@slot/> pour le lecteur enfant.
//  - rctxproviderb.mjs : 2e fournisseur, §§theme figé (jaune) — sert à
//    l'isolation par instance et à la cible du déplacement.
//  - rctxreader.mjs : affiche {§§theme.couleur}.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

// mute/reassign en flèche GRASSE (=>, pas ->) : appelées en appel NU (mute())
// depuis le handler @click compilé — sans le binding lexical de =>, `this`
// (requis par this._mjs_getRCtx/setRCtx) se perdrait à l'appel (cf. feedback_arrow_style).
const PROVIDER_A = `
<script>
§§theme = couleur: 'bleu'
mute = => §§theme.couleur = 'rouge'
reassign = => §§theme = couleur: 'vert'
</script>
<button class="mute" @click={mute()}>mute</button>
<button class="reassign" @click={reassign()}>reassign</button>
<@slot/>
`

const PROVIDER_B = `
<script>
§§theme = couleur: 'jaune'
</script>
<@slot/>
`

const READER = `
<p id="val">{§§theme.couleur}</p>
`

describe('mjs_element — cache par instance de _mjs_getRCtx (résolution §§)', function () {
  this.timeout(40000)

  let window: any = null
  let providerA: any = null
  let providerB: any = null
  let readerX: any = null
  let readerY: any = null

  function val(reader: any): string {
    return reader._shadow.querySelector('#val').textContent
  }
  function clickEl(shadow: any, selector: string) {
    const btn = shadow.querySelector(selector)
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  }

  before(async function () {
    const root = mjsTmp('rctx-cache')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'rctxprovidera.mjs'), PROVIDER_A)
    writeFileSync(join(srcDir, 'rctxproviderb.mjs'), PROVIDER_B)
    writeFileSync(join(srcDir, 'rctxreader.mjs'), READER)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const providerAFile = files.find((f: string) => /^rctxprovidera-/.test(f))
    const providerBFile = files.find((f: string) => /^rctxproviderb-/.test(f))
    const readerFile = files.find((f: string) => /^rctxreader-/.test(f))
    assert.ok(coreFile && providerAFile && providerBFile && readerFile, 'core + les 3 composants compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const providerACode = stripEsm(readFileSync(join(outDir, providerAFile!), 'utf-8'))
    const providerBCode = stripEsm(readFileSync(join(outDir, providerBFile!), 'utf-8'))
    const readerCode = stripEsm(readFileSync(join(outDir, readerFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${providerACode}\n${providerBCode}\n${readerCode}`)

    assert.ok(window.customElements.get('mjs-rctxprovidera'), 'mjs-rctxprovidera enregistré')
    assert.ok(window.customElements.get('mjs-rctxproviderb'), 'mjs-rctxproviderb enregistré')
    assert.ok(window.customElements.get('mjs-rctxreader'), 'mjs-rctxreader enregistré')

    document.body.innerHTML =
      '<mjs-rctxprovidera id="pa"><mjs-rctxreader id="rx"></mjs-rctxreader></mjs-rctxprovidera>' +
      '<mjs-rctxproviderb id="pb"><mjs-rctxreader id="ry"></mjs-rctxreader></mjs-rctxproviderb>'
    providerA = document.getElementById('pa')
    providerB = document.getElementById('pb')
    readerX = document.getElementById('rx')
    readerY = document.getElementById('ry')
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(providerA._shadow && providerB._shadow && readerX._shadow && readerY._shadow, 'les 4 composants sont montés')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('résolution de base : le lecteur sous le fournisseur affiche sa valeur', function () {
    assert.equal(val(readerX), 'bleu')
  })

  it('deux instances du MÊME lecteur sous deux fournisseurs différents — chacune affiche la valeur de SON ancêtre (cache par instance, jamais partagé par classe)', function () {
    assert.equal(val(readerX), 'bleu')
    assert.equal(val(readerY), 'jaune')
  })

  it('mutation interne (§§theme.couleur = …) chez le fournisseur — le lecteur re-rend la nouvelle valeur (même objet réactif, rien à invalider)', async function () {
    clickEl(providerA._shadow, '.mute')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(val(readerX), 'rouge')
  })

  // ÉCART DE MOYEN (assertion de fond inchangée) : contrairement à la mutation
  // EN PLACE ci-dessus (propriété mutée sur le MÊME proxy → notification
  // standard), une RÉ-AFFECTATION ne mute aucune propriété du proxy déjà lu
  // par readerX — rien ne notifie ce lecteur DÉJÀ rendu pour qu'il relise
  // §§theme (seul un remount, cf. test de déplacement plus bas, force un
  // nouveau rendu complet). Ce gap de propagation réactive est PRÉ-EXISTANT et
  // hors périmètre ici (qui ne touche QUE le cache de _mjs_getRCtx, pas la
  // notification de _mjs_setRCtx) — on prouve donc « la lecture suivante voit
  // 'vert' » par un appel direct (= la lecture suivante du mécanisme de
  // résolution lui-même), au lieu du rendu réactif du template.
  it('ré-affectation complète (§§theme = nouvel objet) chez le fournisseur — la lecture SUIVANTE voit la nouvelle valeur (invalidation par epoch via _mjs_setRCtx)', async function () {
    clickEl(providerA._shadow, '.reassign')
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(readerX._mjs_getRCtx('theme').couleur, 'vert')
  })

  it("blanche-boîte cache : après 2 lectures stables, l'entrée 'theme' a epoch === µ._mjs_rctxEpoch et l'objet d'entrée est IDENTIQUE entre les 2 lectures", function () {
    const v1 = readerX._mjs_getRCtx('theme')
    assert.ok(readerX._mjs_rctx_cache, 'le cache existe après une lecture')
    const entry1 = readerX._mjs_rctx_cache.get('theme')
    assert.ok(entry1, "l'entrée 'theme' existe")
    assert.equal(entry1.epoch, window.µ._mjs_rctxEpoch, "epoch de l'entrée = epoch courant")
    assert.equal(entry1.value.couleur, 'vert', 'valeur cohérente avec la ré-affectation précédente')

    const v2 = readerX._mjs_getRCtx('theme')
    const entry2 = readerX._mjs_rctx_cache.get('theme')
    assert.equal(v1, v2, 'même valeur retournée entre les 2 lectures')
    assert.equal(entry1, entry2, "MÊME OBJET d'entrée entre 2 lectures stables (pas re-créé)")
  })

  it("déplacement : le lecteur déplacé (appendChild) sous l'AUTRE fournisseur résout désormais l'autre valeur, entrée de cache renouvelée", async function () {
    const entryBefore = readerX._mjs_rctx_cache.get('theme')
    providerB.appendChild(readerX) // retiré de providerA (disconnect), réinséré sous providerB (connect)
    await new Promise((r) => setTimeout(r, 50))

    // lecture directe (indépendante du timing de re-rendu réactif du template) :
    // preuve immédiate que _mjs_getRCtx suit bien la nouvelle topologie.
    const freshValue = readerX._mjs_getRCtx('theme')
    assert.equal(freshValue.couleur, 'jaune', "déplacé sous providerB : résout désormais SA valeur")
    const entryAfter = readerX._mjs_rctx_cache.get('theme')
    assert.notEqual(entryBefore, entryAfter, "l'entrée de cache est renouvelée après le déplacement (epoch bumped par connect/disconnect)")

    assert.equal(val(readerX), 'jaune', 'le template re-rendu reflète lui aussi la nouvelle valeur')
  })
})
