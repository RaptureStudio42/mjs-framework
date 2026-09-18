// Test NEUF — pont UJS ↔ Shadow DOM fermé.
// 2 symptômes prouvés en live : (1) `@confirm` sur un
// bouton NU (sans <a> englobant) dans un composant → suppression SANS popup
// (leçon tuto 32-4 : items 3→2, popups=0) ; (2) plus largement, les listeners
// UJS document-level ne voient jamais les cibles réelles dans les shadow
// FERMÉS (retargeting natif du navigateur) — liens/formulaires des composants
// échappaient à l'interception.
//
// Fix (mjs_ujs.ts + mjs_element.ts) :
//  - µ._mjs_ujsOnClick/µ._mjs_ujsOnSubmit (anciens handlers anonymes document-level,
//    désormais NOMMÉS) sont réutilisés tels quels par µ._mjs_ujsShadowAttach(root),
//    posé sur CHAQUE shadow root RÉEL (mjs_element.ts, constructor) — à ce
//    niveau, `e.target`/`closest()` voient le VRAI nœud cliqué (on est déjà
//    à l'intérieur de la frontière shadow, rien à retargeter).
//  - Le pont écoute AVANT `_mjs_bindEvents` (délégation @click du composant : même
//    constructor, `super()` — qui pose le pont — PUIS seulement plus tard
//    `[[EVENTS]]` → `this._mjs_bindEvents(...)`, cf. transpiler/template.ts) : un
//    refus `@confirm` (`e.stopImmediatePropagation()`) coupe donc la remontée
//    AVANT que le routeur d'événements du composant ne voie l'event.
//
// Note méthode (limite happy-dom RÉELLE, mais neutralisée pour (ii)/(iii)
// depuis le correctif ci-dessous — IMPORTANT pour comprendre POURQUOI
// le compte de confirm est maintenant EXACT) — vérifié empiriquement (sonde
// dédiée, avant d'écrire ce test) : happy-dom N'ÉMULE PAS le retargeting
// natif de composedPath() pour un shadow CLOSED (un listener `document`-level
// y voit le VRAI nœud interne, pas le host). Ce gap happy-dom est PRÉCISÉMENT
// le comportement natif d'un shadow OPEN dans un VRAI navigateur (SSR
// shadowMode:'open', reprise dans mjs_element.ts) : là aussi, `µ.realTarget`
// (composedPath()[0]) voit la vraie cible aux DEUX niveaux (pont ET document),
// sans qu'aucun retargeting ne les isole — un défaut réel
// (repro : deux `window.confirm` pour un seul clic accepté). Fix : un
// marqueur PAR ÉVÉNEMENT `e._mjs_mjsConfirmGated` (mjs_ujs.ts, gate @confirm de
// µ._mjs_ujsOnClick) — le 1er passage (pont OU document, peu importe l'ordre) le
// pose, le 2ᵉ saute le gate. Résultat : `confirmCalls.length` est désormais
// EXACTEMENT 1 sur un accord, QUE ce 2ᵉ passage soit dû au gap happy-dom
// (closed, ce harnais) OU au comportement natif d'un shadow OPEN (navigateur
// réel) — le marqueur couvre les deux origines par le même mécanisme, cf.
// (iv) qui l'isole directement (double appel du handler RÉEL sur le MÊME
// objet event, sans dépendre d'aucun retargeting). Le refus (i), lui, a
// TOUJOURS été exact à 1 : `stopImmediatePropagation` coupe la remontée AVANT
// même de bubbler, ce qui vaut aussi bien en closed qu'en open. Par ailleurs,
// `addEventListener` DÉDUPLIQUE nativement un listener strictement identique
// (même fonction + mêmes options) — vérifié en happy-dom aussi — donc le test
// (iii) espionne DIRECTEMENT `addEventListener` pour prouver que la garde
// `_mjs_mjsUjsBound` court-circuite AVANT tout nouvel appel, plutôt que de se
// reposer sur cette dédup native (qui masquerait une garde absente).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = `
<script>
$count = 3
remove = -> $count = $count - 1
</script>
<button @confirm="Vraiment supprimer ?" @click={remove()}>Supprimer</button>
<p id="cnt">{$count}</p>
`

describe('mjs_ujs — pont shadow fermé : @confirm hissé + stopImmediatePropagation (symptôme tuto 32-4)', function () {
  this.timeout(40000)

  let window: any = null
  let el: any = null
  let confirmCalls: string[] = []
  let confirmReturn = true

  function count(): string {
    return el._shadow.querySelector('#cnt').textContent
  }

  function click() {
    const btn = el._shadow.querySelector('button')
    // MouseEvent (pas Event nu) : µ._mjs_ujsOnClick garde `e.button !== 0` en tête
    // de gate @confirm — un `Event` simple laisse `.button` à `undefined`
    // (!== 0), sortie AVANT même d'atteindre la confirmation.
    btn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, composed: true, button: 0 }))
  }

  before(async function () {
    const root = mjsTmp('ujs-shadow-confirm')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'delitem.mjs'), COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    window = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^delitem-/.test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')

    const stripEsm = (s: string) => s
      .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
      .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
      .replace(/\bexport\s+default\s+/g, '')
      .replace(/\bexport\s+/g, '')
      .replace(/import\.meta\.url/g, "'http://localhost/'")

    const coreCode = stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))
    const compCode = stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)

    // Stub window.confirm : compte les appels, renvoie `confirmReturn` (piloté par chaque `it`).
    window.confirm = function (msg: string) { confirmCalls.push(msg); return confirmReturn }
    // Ce fichier teste le PONT SHADOW et le `stopImmediatePropagation` d'un refus, pas la
    // boîte elle-même : on force la voie SYNCHRONE (boîte native) pour que la décision soit
    // rendue dans le même tour d'événement. Le défaut du framework (`confirm: true`, modale
    // maison ASYNCHRONE) a sa propre couverture dans ujs-confirm-config.test.ts.
    ;(window as any).µ.config.confirm = false

    assert.ok(window.customElements.get('mjs-delitem'), 'mjs-delitem enregistré')
    document.body.innerHTML = '<mjs-delitem></mjs-delitem>'
    el = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 50))
    assert.ok(el._shadow, 'shadow root monté')
    assert.equal(count(), '3', 'état initial : 3')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it("(i) refus @confirm sur un bouton NU (sans <a>) : le handler @click du composant N'EST PAS appelé, confirm demandé EXACTEMENT 1 fois", async function () {
    confirmCalls = []
    confirmReturn = false
    click()
    await new Promise((r) => setTimeout(r, 50))
    assert.equal(confirmCalls.length, 1, 'window.confirm doit être demandé exactement 1 fois')
    assert.equal(count(), '3', "AVANT le fix : la suppression s'exécutait SANS popup (symptôme tuto 32-4) — ici le refus doit bloquer remove()")
  })

  it('(ii) accord @confirm : le handler @click du composant EST appelé', async function () {
    confirmCalls = []
    confirmReturn = true
    click()
    await new Promise((r) => setTimeout(r, 50))
    // EXACTEMENT 1 (marqueur `_mjs_mjsConfirmGated`, cf. note
    // méthode en tête de fichier) : sans lui, ce clic bubble du pont (shadow)
    // jusqu'à `document` sur le MÊME objet event et redemandait confirm une 2e fois.
    assert.equal(confirmCalls.length, 1, `confirm attendu exactement 1 fois, obtenu ${confirmCalls.length}`)
    assert.equal(count(), '2', 'remove() doit avoir tourné UNE SEULE fois : 3 → 2 (pas 3 → 1 ni 3 inchangé)')
  })

  it('(iii) double µ._mjs_ujsShadowAttach sur le même root : la garde `_mjs_mjsUjsBound` empêche un second addEventListener (pas de double popup, pas de double exécution)', async function () {
    // Le shadow a déjà été attaché UNE fois par le constructor (mjs_element.ts).
    // Espionnage ciblé de addEventListener sur CE root : prouve que le 2e appel
    // ressort AVANT même d'y toucher (marqueur `_mjs_mjsUjsBound`) — cf. le
    // commentaire d'en-tête sur pourquoi la dédup native ne suffit pas à
    // distinguer "la garde fonctionne" de "le navigateur déduplique tout seul".
    let addCalls = 0
    const origAdd = el._shadow.addEventListener.bind(el._shadow)
    el._shadow.addEventListener = function (...args: any[]) { addCalls++; return origAdd(...args) }
    window.µ._mjs_ujsShadowAttach(el._shadow)
    el._shadow.addEventListener = origAdd
    assert.equal(addCalls, 0, 'la garde `_mjs_mjsUjsBound` doit court-circuiter AVANT tout nouvel addEventListener')

    confirmCalls = []
    confirmReturn = true
    click()
    await new Promise((r) => setTimeout(r, 50))
    // EXACTEMENT 1, même raison qu'en (ii) (marqueur `_mjs_mjsConfirmGated`) — la
    // preuve de non-duplication PAR LE DOUBLE ATTACH reste `addCalls === 0`
    // ci-dessus ; celle-ci confirme juste l'absence de régression combinée.
    assert.equal(confirmCalls.length, 1, `confirm attendu exactement 1 fois, obtenu ${confirmCalls.length}`)
    assert.equal(count(), '1', 'et remove() toujours appelé UNE seule fois : 2 → 1 (pas 2 → 0 ni 2 inchangé)')
  })

  it('(iv) double passage du MÊME objet Event (en shadow OPEN, pont ET document voient tous deux la vraie cible, aucun retargeting ne les isole) : window.confirm demandé UNE SEULE fois', function () {
    confirmCalls = []
    confirmReturn = true
    const btn = el._shadow.querySelector('button')
    // Fake event minimal (même technique que les tests regex-extraction UJS
    // voisins, ex. ujs-confirm-method.test.ts) plutôt qu'un vrai dispatch : un
    // MouseEvent hors dispatch actif a `composedPath()` VIDE par spec (piège),
    // alors que `µ.realTarget` l'appelle inconditionnellement — ce fake fixe
    // `composedPath` à `[btn]`, peu importe l'état de dispatch.
    const e: any = {
      defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true },
      stopImmediatePropagation() {},
      button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
      composedPath: () => [btn],
      target: btn,
    }
    // Pont (shadow root) PUIS document — MÊME objet `e`, exactement ce qu'un
    // clic réel ferait bubbler nativement en shadow OPEN (aucun retargeting
    // n'isole les deux passages l'un de l'autre, contrairement au closed).
    window.µ._mjs_ujsOnClick(e)
    window.µ._mjs_ujsOnClick(e)
    assert.equal(confirmCalls.length, 1, 'le 2e passage sur le MÊME event doit sauter le gate — marqueur `_mjs_mjsConfirmGated`')
  })

  it('(v) µ.confirm remplacé par une PROMESSE résolue true : le handler @click du composant tourne EXACTEMENT 1 fois après résolution, window.confirm (stub) jamais appelé', async function () {
    // count() vaut '1' à ce stade (3 → 2 en (ii), 2 → 1 en (iii), (iv) ne
    // touche pas l'état — appels directs du handler, aucun vrai dispatch).
    let windowConfirmCalls = 0
    const savedWindowConfirm = window.confirm
    window.confirm = function () { windowConfirmCalls++; return true }
    let muConfirmCalls = 0
    const savedMuConfirm = window.µ.confirm
    window.µ.confirm = function () { muConfirmCalls++; return Promise.resolve(true) }

    click()
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(muConfirmCalls, 1, 'µ.confirm demandé exactement 1 fois')
    assert.equal(windowConfirmCalls, 0, 'window.confirm ne doit JAMAIS être appelé : µ.confirm est remplacé')
    assert.equal(count(), '0', 'remove() a tourné UNE SEULE fois après résolution de la promesse : 1 → 0')

    window.confirm = savedWindowConfirm
    window.µ.confirm = savedMuConfirm
  })

  it('(vi) µ.confirm remplacé par une PROMESSE résolue false : le handler @click du composant ne tourne JAMAIS, mjs-confirm reste présent à la fin', async function () {
    const before = count() // '0', laissé par (v)
    const btn = el._shadow.querySelector('button')
    let muConfirmCalls = 0
    const savedMuConfirm = window.µ.confirm
    window.µ.confirm = function () { muConfirmCalls++; return Promise.resolve(false) }

    click()
    await new Promise((r) => setTimeout(r, 50))

    assert.equal(muConfirmCalls, 1)
    assert.equal(count(), before, 'refus : remove() jamais appelé, count inchangé')
    assert.equal(btn.hasAttribute('mjs-confirm'), true, 'mjs-confirm toujours présent : jamais neutralisé sur un refus')

    window.µ.confirm = savedMuConfirm
  })
})
