// Test de régression — `hasPendingAwait`/
// `settleRender` ne regardaient QUE `_mjs_awaitStates` de la RACINE. Un
// SOUS-COMPOSANT imbriqué avec son PROPRE `{await}` encore pending était
// invisible : `_mjs_awaitStates` est PAR INSTANCE, l'invalidation d'un await
// imbriqué se fait sur l'ENFANT, jamais remontée à la racine. Le serveur
// pouvait donc considérer le rendu "stable" et sérialiser prématurément,
// alors qu'un `{await}` imbriqué est encore pending — divergence SSR/client
// (flash de contenu) une fois `settleMs` dépassé sur une vraie page plus lente.
//
// Fix : `collectAwaitStates` walk récursivement TOUT l'arbre (shadow ET light
// DOM) collectant `_mjs_awaitStates` de chaque composant rencontré.
//
// PIÈGE découvert en écrivant ce test (cf. commentaire dans renderToString.ts) :
// mjs_element.ts attache le Shadow DOM en mode `'closed'` par défaut — la
// propriété NATIVE `el.shadowRoot` renvoie donc TOUJOURS null/undefined pour
// une instance MJS normale. Un premier correctif basé sur `el.shadowRoot`
// compilait sans erreur (`any`) mais ne traversait JAMAIS aucun
// sous-composant — silencieusement inopérant. Le framework garde SA PROPRE
// référence dans `el._shadow` (celle que ce fichier utilise déjà pour
// sérialiser la racine) : c'est CETTE référence qu'il faut suivre. D'où les
// fixtures ci-dessous qui n'exposent JAMAIS `.shadowRoot` (exactement comme
// une vraie instance MJS fermée) — si le code régresse vers `.shadowRoot`,
// le walk ne trouve plus rien et les tests échouent.
//
// Autre piège découvert (limite depuis LEVÉE) : le HTML final
// (`res.html`) ne pouvait PAS servir de signal ici — `el._shadow.innerHTML` (sérialisation NATIVE,
// UN SEUL niveau) ne montrait jamais le contenu du shadow d'un DESCENDANT, par nature de
// l'encapsulation Shadow DOM (limite connue, commentée en tête de renderToString.ts).
// `renderToString()` sérialise désormais RÉCURSIVEMENT (fonction `serializeShadow`,
// renderToString.ts) — mais CE test-ci construit son PROPRE window/eval à la main (pas d'appel à
// `renderToString()`, cf. plus bas), donc ce point n'est plus la raison de préférer
// `hasPendingAwait`/l'inspection DOM directe ICI : la vraie raison qui reste, c'est le TIMING
// (ci-dessous), toujours valable.
// Mesurer le TIMING de `settleRender` (ex. « doit prendre ~150ms pas plus »)
// s'est aussi avéré peu fiable : `settleRender` compte des ticks nominaux
// (`elapsed += step`) et non le temps réel écoulu, et le pipeline de
// re-render (microtasks) retarde les callbacks `setTimeout` de son polling de
// façon variable selon la charge machine. On teste donc directement la
// fonction exportée (comportement pending → non-pending, avec marge
// confortable), jamais le HTML final ni un seuil de durée serré.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { collectAwaitStates, hasPendingAwait } from '../src/server/renderToString.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

describe('SSR renderToString — collectAwaitStates/hasPendingAwait couvrent les SOUS-composants (pas seulement la racine)', function () {
  describe('unité — fixtures synthétiques (miroir exact de la forme MJS réelle : `_shadow` distinct de `.shadowRoot`, jamais exposé)', function () {
    // Le rendu serveur ne lit JAMAIS une propriété interne par son nom (raccourcie dès que le bundle
    // est minifié) : il passe par l'accès à nom long du cœur (`µ._ssrInfo`, runtime/mjs_element.ts),
    // atteint depuis le nœud via `ownerDocument.defaultView`. Les fixtures portent donc ce cœur, sinon
    // elles éprouveraient un chemin que la production n'emprunte pas.
    const coeur: any = { _ssrInfo: (el: any) => ({ baseCss: el._mjs_baseCss, isLight: el._mjs_isLight === true, nodes: el._mjs_nodes, awaitStates: el._mjs_awaitStates, renderScheduled: el._mjs_render_scheduled === true }) }
    const doc: any   = { defaultView: { µ: coeur } }
    const noeud      = (props: any): any => Object.assign({ ownerDocument: doc }, props)

    it("un enfant PENDING dans `_shadow.children` (mode shadow) : détecté malgré l'absence de tout {await} sur la racine", function () {
      const child: any = noeud({
        _mjs_awaitStates: new Map([['a1', { status: 'pending', data: null, error: null }]]),
        children: [],
      })
      const root: any = noeud({
        _shadow: { children: [child] },   // PAS de `.shadowRoot` — comme une vraie instance MJS (mode closed)
        children: [],
      })
      assert.equal(hasPendingAwait(root), true,
        "l'enfant est dans _shadow.children (mode closed) — hasPendingAwait doit le trouver via `_shadow`, jamais via `.shadowRoot` (toujours absent ici)")
    })

    it('le MÊME enfant une fois résolu (status success) : plus considéré pending', function () {
      const child: any = noeud({
        _mjs_awaitStates: new Map([['a1', { status: 'success', data: 'X', error: null }]]),
        children: [],
      })
      const root: any = noeud({ _shadow: { children: [child] }, children: [] })
      assert.equal(hasPendingAwait(root), false)
    })

    it('enfant PENDING imbriqué à 2 niveaux (petit-enfant, via `_shadow` PUIS `children`) : toujours détecté', function () {
      const grandchild: any = noeud({
        _mjs_awaitStates: new Map([['a1', { status: 'pending', data: null, error: null }]]),
        children: [],
      })
      // Le petit-fils arrive en LIGHT DOM à l'intérieur du shadow de l'enfant
      // (ex. slotted content) — `children`, pas `_shadow`, pour CE niveau.
      const child: any = noeud({ _shadow: { children: [] }, children: [grandchild] })
      const root: any  = noeud({ _shadow: { children: [child] }, children: [] })
      assert.equal(hasPendingAwait(root), true, 'la récursion doit descendre au-delà du premier niveau')
    })

    it("mode `mjs-light` (`_shadow === el`, pas de vrai shadow) : détecté via `children`, sans double parcours ni boucle infinie", function () {
      const child: any = noeud({
        _mjs_awaitStates: new Map([['a1', { status: 'pending', data: null, error: null }]]),
        children: [],
      })
      const root: any = noeud({})
      root._shadow = root   // mimique exactement mjs_element.ts : `this._shadow = this` en mode light
      root.children = [child]
      const states = collectAwaitStates(root)
      // Le root lui-même n'a pas de _mjs_awaitStates propre ⇒ un seul état collecté (celui de l'enfant),
      // PAS deux (ce qui prouverait un double parcours _shadow/children sur le même sous-arbre).
      assert.equal(states.length, 1, `_shadow === el doit être traversé UNE fois, pas via les deux branches (trouvé ${states.length} état(s))`)
      assert.equal(hasPendingAwait(root), true)
    })

    it('aucun {await} nulle part (racine ni descendants) : false', function () {
      const root: any = noeud({ _shadow: { children: [noeud({ children: [] })] }, children: [] })
      assert.equal(hasPendingAwait(root), false)
    })

    it('await PENDING sur la RACINE elle-même (comportement pré-existant, non régressé)', function () {
      const root: any = noeud({
        _mjs_awaitStates: new Map([['a1', { status: 'pending', data: null, error: null }]]),
        _shadow: { children: [] },
        children: [],
      })
      assert.equal(hasPendingAwait(root), true)
    })

    it("aucun cœur atteignable depuis le nœud : rien de collecté — l'absence d'accès ne se DÉGUISE pas en « rien en attente »", function () {
      const orphelin: any = { _mjs_awaitStates: new Map([['a1', { status: 'pending', data: null, error: null }]]), children: [] }
      assert.equal(collectAwaitStates(orphelin).length, 0, "un nœud détaché de tout document ne rend aucun état : le lecteur passe par µ._ssrInfo, jamais par le nom interne")
    })
  })

  describe('intégration — vrai composant compilé, vrai runtime, vrai happy-dom (pas de seuil de timing serré)', function () {
    this.timeout(30000)

    after(async () => {
      await terminateSharedWorkerPool()
    })

    it("un `<mjs-child>` imbriqué avec son PROPRE {await} : hasPendingAwait(racine) suit l'état RÉEL de l'enfant dans le temps", async function () {
      const root = mjsTmp('ssr-nested-await')
      const srcDir = join(root, 'src')
      const outputDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })

      // L'enfant a un {await} qui résout à 150ms. La racine n'a ELLE-MÊME
      // aucun {await} — juste le tag de l'enfant — donc AVANT le fix,
      // hasPendingAwait(racine) valait `false` en permanence (aveugle à
      // l'enfant), peu importe l'état réel de celui-ci.
      writeFileSync(join(srcDir, 'child.mjs'), `
<script lang="coffee">
$p = new Promise((resolve) -> setTimeout((-> resolve("ENFANT-CHARGE")), 150))
</script>
{await $p}<span class="pending">chargement-enfant</span>{success val}<span class="done">{val}</span>{end}
`)
      writeFileSync(join(srcDir, 'parent.mjs'), `
<script lang="coffee">
</script>
<div class="wrapper"><mjs-child></mjs-child></div>
`)

      const bundler = new Bundler({ sourceDir: srcDir, outputDir, manifestPath: join(outputDir, 'bundle.js') })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map(e => e.message).join('\n'))

      const stripEsm = (s: string): string => s
        .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
        .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
        .replace(/\bexport\s+default\s+/g, '')
        .replace(/\bexport\s+/g, '')
        .replace(/import\.meta\.url/g, "'http://localhost/'")

      const jsFiles = readdirSync(outputDir).filter(f => f.endsWith('.js'))
      const coreFile = jsFiles.find(f => /^mjs_core-/.test(f))!
      const coreCode = stripEsm(readFileSync(join(outputDir, coreFile), 'utf-8'))
      const files = jsFiles.filter(f => f !== coreFile && f !== 'bundle.js')
      // Pas d'imports croisés entre child/parent dans ce fixture : stripEsm + concat
      // suffit (pas besoin du scoping par fichier complet de renderToString.ts).
      const componentCode = files.map(f => stripEsm(readFileSync(join(outputDir, f), 'utf-8'))).join('\n')

      const window: any = new Window({ url: 'http://localhost/' })
      const document = window.document
      try {
        window.eval(`${coreCode}\nglobalThis.µ = µ;\nµ._isServer = true;\n${componentCode}`)
        document.body.innerHTML = '<mjs-parent></mjs-parent>'
        const el = document.body.firstElementChild

        // Juste après le montage (bien avant les 150ms de résolution) : l'enfant
        // doit être vu comme pending PAR LA RACINE.
        await new Promise(r => setTimeout(r, 20))
        assert.equal(hasPendingAwait(el), true,
          "AVANT le fix (`.shadowRoot`, toujours null en mode closed) : hasPendingAwait(racine) valait `false` ici, alors que l'enfant est RÉELLEMENT pending — settleRender aurait sérialisé prématurément")

        // Largement après la résolution (150ms + marge confortable, pas un seuil serré) :
        // l'enfant doit être vu comme réglé PAR LA RACINE.
        await new Promise(r => setTimeout(r, 400))
        assert.equal(hasPendingAwait(el), false,
          "après résolution de l'enfant, la racine doit refléter son état réel (plus pending)")

        // Et l'état interne de l'enfant doit bien montrer le contenu résolu
        // (confirme qu'on observe la même instance que celle qui a réellement
        // résolu, pas un artefact du fixture).
        const childEl = el._shadow?.querySelector('mjs-child')
        assert.match(String(childEl?._shadow?.innerHTML ?? ''), /ENFANT-CHARGE/,
          "le contenu résolu doit être présent dans le shadow INTERNE de l'enfant (`_shadow`, pas `.shadowRoot`)")
      } finally {
        try { window.close?.() } catch { /* ignore */ }
        await bundler.close()
      }
    })
  })
})
