// Runtime : directive @title (mjs_title.ts). Même harnais que
// tests/ujs-shadow-confirm.test.ts : Bundler réel → mjs_core-*.js + composant compilés, évalués
// dans une fenêtre happy-dom, interactions par VRAIS événements DOM (dispatchEvent).
//
// LIMITE happy-dom — Popover ABSENT : `'showPopover' in
// HTMLElement.prototype` vaut `false` (vérifié empiriquement avant d'écrire ce fichier). Le
// premier bloc ci-dessous exerce donc TOUJOURS le repli documenté par mjs_title.ts (bulle unique
// dans `document.body`, position fixed) — c'est le comportement RÉEL de tout navigateur qui n'a
// pas encore le Popover API. Le second bloc PATCHE `HTMLElement.prototype.showPopover/
// hidePopover` AVANT de charger le cœur (le feature-detect de mjs_title.ts tourne au chargement
// du module) pour exercer pour de vrai le chemin Popover — bulle née DANS la racine shadow du
// composant, stylable depuis son propre SASS.
//
// Minuteries : délais RÉELS courts (20-40ms) + `setTimeout`/sleep, pas d'horloge fake — même
// choix que les tests ujs-nav-* voisins.
//
// Piège débusqué en écrivant ce fichier (dette RÉELLE, pas un artefact de test) : un shadow
// OUVERT (ou happy-dom, qui reproduit ce même gap même en shadow FERMÉ — cf. le bandeau de
// tests/ujs-shadow-confirm.test.ts) laisse un mouseover/focusin composé BUBBLER du shadow root
// jusqu'à `document` SANS retargeting — le pont racine ET le boot document voient donc CHACUN le
// même événement. Sans garde, le second passage (`this === document`) écrasait le `root` shadow
// déjà résolu par le premier passage, et la bulle finissait TOUJOURS en repli body même avec
// Popover disponible — fixé par un marqueur `e._mjs_mjsTitleHandled` (même famille que
// `e._mjs_mjsConfirmGated`, mjs_ujs.ts), cf. mjs_title.ts.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { assertAbsent } from './helpers/dom-assert.js'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

// Appui long tactile : happy-dom n'expose pas TouchEvent, `touches` est injecté à la main
// sur un Event générique (le code de mjs_title.ts ne lit que `e.touches[0].clientX/clientY`).
const touchEvent = (win: any, type: string, x: number, y: number) => {
  const e = new win.Event(type, { bubbles: true })
  Object.defineProperty(e, 'touches', { value: [{ clientX: x, clientY: y }] })
  return e
}

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// Compile un projet MINIMAL (aucun composant réellement exercé dans le bloc « repli ») pour
// obtenir un vrai mjs_core-*.js — les scénarios de ce bloc posent leurs propres éléments en LIGHT
// DOM directement dans document.body (µ._mjs_titleAttach(document), posé au boot du module, couvre
// déjà tout élément hors composant).
async function buildCore(extraComponent?: { name: string; src: string }) {
  const root = mjsTmp('title-runtime')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'placeholder.mjs'), `<script>\n$x = 0\n</script>\n<div>ph</div>`)
  if (extraComponent) writeFileSync(join(srcDir, `${extraComponent.name}.mjs`), extraComponent.src)
  // mjs_title n'est plus dans le cœur d'office : demandé explicitement, ces tests exercent le module sans source qui pose @title
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['title'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  assert.ok(coreFile, 'mjs_core-*.js introuvable')
  const compFile = extraComponent ? files.find((f: string) => new RegExp(`^${extraComponent.name}-`).test(f)) : undefined
  return {
    coreCode: stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    compCode: compFile ? stripEsm(readFileSync(join(outDir, compFile), 'utf-8')) : null,
  }
}

describe('runtime @title — repli body (Popover ABSENT, comportement RÉEL happy-dom)', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null

  before(async function () {
    const { coreCode } = await buildCore()
    window = new Window({ url: 'http://localhost/' })
    document = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;`)
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  afterEach(() => {
    // ferme toute bulle laissée ouverte par le test précédent (µ._mjs_titleAttach est posé UNE fois
    // au boot — inutile/impossible de tout réinitialiser, on referme juste proprement).
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  })

  it('apparition APRÈS le délai sur mouseover — jamais avant', async () => {
    document.body.innerHTML = `<button id="t1" mjs-title="Astuce rapide" mjs-title-conf='{"delay":40}'>x</button>`
    document.getElementById('t1').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(15)
    assertAbsent(document.querySelector('.mjs-title-visible'), 'ne doit PAS être visible avant le délai')
    await sleep(50)
    const bubble = document.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'doit être visible après le délai')
    assert.equal(bubble.textContent, 'Astuce rapide')
  })

  it('annulation : mouseout AVANT la fin du délai → la bulle ne s\'affiche jamais', async () => {
    document.body.innerHTML = `<button id="t2" mjs-title="Ne doit pas apparaître" mjs-title-conf='{"delay":40}'>x</button>`
    const el = document.getElementById('t2')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(10)
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(60)
    assertAbsent(document.querySelector('.mjs-title-visible'))
  })

  it('focusin affiche après délai, focusout referme IMMÉDIATEMENT', async () => {
    document.body.innerHTML = `<button id="t3" mjs-title="Astuce clavier" mjs-title-conf='{"delay":20}'>x</button>`
    const el = document.getElementById('t3')
    el.dispatchEvent(new window.FocusEvent('focusin', { bubbles: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.classList.contains('mjs-title-visible'))
    assert.equal(bubble.textContent, 'Astuce clavier')
    el.dispatchEvent(new window.FocusEvent('focusout', { bubbles: true }))
    await sleep(5)
    assert.equal(bubble.classList.contains('mjs-title-visible'), false)
  })

  it('textContent TOUJOURS échappé — un <b> littéral dans le texte ne devient jamais un vrai élément', async () => {
    document.body.innerHTML = `<i id="t4" mjs-title="&lt;b&gt;Alerte&lt;/b&gt;" mjs-title-conf='{"delay":10}'>x</i>`
    document.getElementById('t4').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    assert.equal(bubble.textContent, '<b>Alerte</b>')
    assertAbsent(bubble.querySelector('b'), 'aucun VRAI <b> ne doit exister dans la bulle')
  })

  it('MutationObserver : mjs-title changé PENDANT que la bulle est visible met à jour le texte', async () => {
    document.body.innerHTML = `<u id="t5" mjs-title="Texte initial" mjs-title-conf='{"delay":10}'>x</u>`
    const el = document.getElementById('t5')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.equal(document.querySelector('.mjs-title').textContent, 'Texte initial')
    el.setAttribute('mjs-title', 'Texte mis à jour')
    await sleep(10)
    assert.equal(document.querySelector('.mjs-title').textContent, 'Texte mis à jour')
  })

  // @title={{ expr }} : mjs-title-html POSE son contenu en innerHTML (élément
  // RÉEL), jamais en textContent. Délégation étendue (__titleAncestor) : `[mjs-title],
  // [mjs-title-html]` — un élément qui ne porte QUE mjs-title-html doit quand même déclencher la
  // bulle (test ci-dessous).
  it('mjs-title-html : un <b> devient un VRAI élément dans la bulle (HTML brut, PAS échappé)', async () => {
    document.body.innerHTML = `<i id="t11" mjs-title-html="&lt;b&gt;Gras&lt;/b&gt;" mjs-title-conf='{"delay":10}'>x</i>`
    document.getElementById('t11').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('b'), 'un <b> RÉEL doit exister dans la bulle')
    assert.equal(bubble.querySelector('b').textContent, 'Gras')
  })

  it('mjs-title-html : un <script> posé reste INERTE (règle HTML de innerHTML — jamais exécuté)', async () => {
    window.eval(`globalThis.__mjsTitleScriptRan = false;`)
    document.body.innerHTML = `<em id="t12" mjs-title-html="&lt;script&gt;globalThis.__mjsTitleScriptRan = true&lt;/script&gt;Texte" mjs-title-conf='{"delay":10}'>x</em>`
    document.getElementById('t12').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    assert.equal(window.__mjsTitleScriptRan, false, "un <script> injecté via innerHTML ne doit JAMAIS s'exécuter (règle HTML standard, même comportement qu'un vrai navigateur)")
    assert.equal(bubble.querySelectorAll('script').length, 1, 'le nœud <script> existe bien dans le DOM (inerte, pas absent)')
  })

  it('MutationObserver : mjs-title-html changé PENDANT que la bulle est visible remplace le HTML (élément réel, pas juste le texte)', async () => {
    document.body.innerHTML = `<u id="t13" mjs-title-html="&lt;b&gt;v1&lt;/b&gt;" mjs-title-conf='{"delay":10}'>x</u>`
    const el = document.getElementById('t13')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    let bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('b'), 'v1 : <b> doit exister')
    el.setAttribute('mjs-title-html', '<i>v2</i>')
    await sleep(10)
    bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('i'), 'v2 : <i> doit exister après mutation')
    assertAbsent(bubble.querySelector('b'), 'v1 (<b>) ne doit plus être présent après remplacement du HTML')
  })

  it('coexistence mjs-title + mjs-title-html sur le MÊME élément : le HTML GAGNE (choix explicite du double-accolade)', async () => {
    document.body.innerHTML = `<i id="t14" mjs-title="repli texte" mjs-title-html="&lt;b&gt;gagne&lt;/b&gt;" mjs-title-conf='{"delay":10}'>x</i>`
    document.getElementById('t14').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('b'), 'le contenu HTML doit gagner sur le texte de repli')
    assert.equal(bubble.querySelector('b').textContent, 'gagne')
  })

  it('délégation étendue : un élément ne portant QUE mjs-title-html (sans mjs-title) déclenche quand même la bulle', async () => {
    document.body.innerHTML = `<span id="t15" mjs-title-html="&lt;i&gt;seul&lt;/i&gt;" mjs-title-conf='{"delay":10}'>x</span>`
    document.getElementById('t15').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'la bulle doit apparaître même sans mjs-title')
    assert.ok(bubble.querySelector('i'), 'contenu HTML attendu')
  })

  it('attribut mjs-title RETIRÉ pendant que la bulle est visible → fermeture', async () => {
    document.body.innerHTML = `<s id="t6" mjs-title="Texte" mjs-title-conf='{"delay":10}'>x</s>`
    const el = document.getElementById('t6')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.ok(document.querySelector('.mjs-title-visible'))
    el.removeAttribute('mjs-title')
    await sleep(10)
    assertAbsent(document.querySelector('.mjs-title-visible'))
  })

  it('aria-describedby posé à l\'apparition, retiré à la fermeture — jeton EXISTANT préservé', async () => {
    document.body.innerHTML = `<span id="t7" aria-describedby="existing-desc" mjs-title="Astuce" mjs-title-conf='{"delay":10}'>x</span>`
    const el = document.getElementById('t7')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    const during = el.getAttribute('aria-describedby').split(/\s+/)
    assert.ok(during.includes('existing-desc'), 'le jeton existant doit survivre')
    assert.ok(during.includes(bubble.id), 'le jeton de la bulle doit être ajouté')
    el.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(5)
    assert.equal(el.getAttribute('aria-describedby'), 'existing-desc', 'seul le jeton de la bulle est retiré')
  })

  it('config GLOBALE (µ.config.title.delay) respectée ; mjs-title-conf de l\'élément la bat', async () => {
    window.eval(`µ.config.title.delay = 15;`)
    document.body.innerHTML = `
      <button id="t8g" mjs-title="Config globale">x</button>
      <button id="t8e" mjs-title="Config élément" mjs-title-conf='{"delay":200}'>y</button>
    `
    const g = document.getElementById('t8g')
    g.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(35)
    assert.ok(document.querySelector('.mjs-title-visible'), 'délai global (15ms) doit avoir suffi après 35ms')
    g.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(5)

    const e = document.getElementById('t8e')
    e.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(35)
    assertAbsent(document.querySelector('.mjs-title-visible'), 'mjs-title-conf (200ms) doit BATTRE le global (35ms écoulées, pas assez)')
    await sleep(200)
    assert.ok(document.querySelector('.mjs-title-visible'), 'visible une fois les 200ms de mjs-title-conf écoulées')
    window.eval(`µ.config.title.delay = 400;`) // restaure le défaut pour les tests suivants
  })

  it('Escape ferme la bulle visible', async () => {
    document.body.innerHTML = `<button id="t9" mjs-title="Astuce" mjs-title-conf='{"delay":10}'>x</button>`
    document.getElementById('t9').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.ok(document.querySelector('.mjs-title-visible'))
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
    await sleep(5)
    assertAbsent(document.querySelector('.mjs-title-visible'))
  })

  it('bulle UNIQUE réutilisée : 2 déclencheurs successifs → même noeud DOM (jamais recréé)', async () => {
    document.body.innerHTML = `
      <button id="t10a" mjs-title="Premier" mjs-title-conf='{"delay":10}'>a</button>
      <button id="t10b" mjs-title="Second" mjs-title-conf='{"delay":10}'>b</button>
    `
    const a = document.getElementById('t10a')
    const b = document.getElementById('t10b')
    a.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(25)
    const bubble1 = document.querySelector('.mjs-title')
    a.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true }))
    await sleep(5)
    b.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(25)
    const bubble2 = document.querySelector('.mjs-title')
    assert.equal(bubble1, bubble2, 'même instance DOM réutilisée')
    assert.equal(bubble2.textContent, 'Second')
    assert.equal(document.querySelectorAll('.mjs-title').length, 1, 'jamais 2 bulles à la fois')
  })

  it('attache par racine UNIQUE : 2e appel µ._mjs_titleAttach(document) → 0 addEventListener supplémentaire', async () => {
    let addCalls = 0
    const origAdd = document.addEventListener.bind(document)
    document.addEventListener = function (...args: any[]) { addCalls++; return origAdd(...args) }
    window.µ._mjs_titleAttach(document)
    document.addEventListener = origAdd
    assert.equal(addCalls, 0, 'la garde WeakSet doit court-circuiter AVANT tout nouvel addEventListener')
  })

  it('µ._mjs_titleResolveSide (pur) : bascule top→bottom / bottom→top si la place manque, repli top sur valeur inconnue', () => {
    const rs = window.µ._mjs_titleResolveSide
    assert.equal(rs('top', { top: 100, bottom: 120 }, 40, 8, 800), 'top', 'assez de place au-dessus : respecte top')
    assert.equal(rs('top', { top: 10, bottom: 30 }, 40, 8, 800), 'bottom', 'pas assez de place au-dessus : bascule en dessous')
    assert.equal(rs('bottom', { top: 100, bottom: 120 }, 40, 8, 800), 'bottom', 'assez de place en dessous : respecte bottom')
    assert.equal(rs('bottom', { top: 400, bottom: 780 }, 40, 8, 800), 'top', 'pas assez de place en dessous (proche du bas) : bascule au-dessus')
    assert.equal(rs('gauche', { top: 100, bottom: 120 }, 40, 8, 800), 'top', 'valeur non reconnue : repli top')
  })

  // Appui long tactile : constantes internes de mjs_title.ts (TITLE_TOUCH_PRESS_MS=500,
  // TITLE_TOUCH_LINGER_MS=1500, dérive=10px), non configurables — les délais ci-dessous laissent
  // volontairement une marge confortable autour de ces seuils fixes.

  it('appui tactile 500ms → bulle affichée', async () => {
    document.body.innerHTML = `<button id="tt1" mjs-title="Astuce tactile" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt1')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(600)
    const bubble = document.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'doit être visible après 500ms d\'appui')
    assert.equal(bubble.textContent, 'Astuce tactile')
  })

  it('relâcher à ~300ms → jamais affichée', async () => {
    document.body.innerHTML = `<button id="tt2" mjs-title="Ne doit pas apparaître" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt2')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(300)
    el.dispatchEvent(touchEvent(window, 'touchend', 10, 10))
    await sleep(400) // total 700ms : bien après le seuil de 500ms qui aurait déclenché sans annulation
    assertAbsent(document.querySelector('.mjs-title-visible'), 'relâché avant les 500ms : jamais affichée')
  })

  it('dérive 20px pendant l\'appui → annulé', async () => {
    document.body.innerHTML = `<button id="tt3" mjs-title="Ne doit pas apparaître" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt3')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(100)
    el.dispatchEvent(touchEvent(window, 'touchmove', 30, 10)) // dérive de 20px (seuil : 10px)
    await sleep(500) // total 600ms : bien après le seuil de 500ms
    assertAbsent(document.querySelector('.mjs-title-visible'), 'dérive au-delà du seuil : appui annulé')
  })

  it('bulle tactile affichée puis touchend → encore visible à ~1000ms, disparue après ~1600ms', async () => {
    document.body.innerHTML = `<button id="tt4" mjs-title="Astuce tactile" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt4')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(600)
    assert.ok(document.querySelector('.mjs-title-visible'), 'doit être visible après 500ms d\'appui')
    el.dispatchEvent(touchEvent(window, 'touchend', 10, 10))
    await sleep(1000)
    assert.ok(document.querySelector('.mjs-title-visible'), 'survit encore 1000ms après le relâcher (linger 1500ms)')
    await sleep(700) // total 1700ms depuis le relâcher : au-delà des 1500ms de survie
    assertAbsent(document.querySelector('.mjs-title-visible'), 'fermée une fois le linger de 1500ms dépassé')
  })

  it('contextmenu pendant une bulle tactile affichée → menu contextuel étouffé', async () => {
    document.body.innerHTML = `<button id="tt5" mjs-title="Astuce tactile" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt5')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(600)
    assert.ok(document.querySelector('.mjs-title-visible'), 'doit être visible après 500ms d\'appui')
    const ctx = new window.Event('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(ctx)
    assert.equal(ctx.defaultPrevented, true, 'bulle tactile affichée : le menu contextuel est étouffé')
  })

  it('contextmenu SANS bulle tactile affichée → jamais étouffé', async () => {
    document.body.innerHTML = `<button id="tt6" mjs-title="Astuce tactile" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt6')
    const ctx = new window.Event('contextmenu', { bubbles: true, cancelable: true })
    el.dispatchEvent(ctx)
    assert.equal(ctx.defaultPrevented, false, 'aucune bulle tactile affichée : jamais étouffé')
  })

  it('mouseover synthétique < 800ms après touchstart → ignoré (pas de double programmation)', async () => {
    document.body.innerHTML = `<button id="tt7" mjs-title="Astuce tactile" mjs-title-conf='{"delay":400}'>x</button>`
    const el = document.getElementById('tt7')
    el.dispatchEvent(touchEvent(window, 'touchstart', 10, 10))
    await sleep(10)
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true })) // synthétique mobile après le toucher, doit être ignoré
    await sleep(440) // t≈450ms : passé le seuil buggé (10+400=410) mais avant le vrai seuil tactile (500)
    assertAbsent(document.querySelector('.mjs-title-visible'), 'le mouseover synthétique ne doit rien programmer')
    await sleep(100) // t≈550ms : le vrai appui tactile (500ms) a désormais eu le temps d'aboutir
    assert.ok(document.querySelector('.mjs-title-visible'), 'la voie tactile reste fonctionnelle malgré le mouseover synthétique')
  })
})

// Le SEUL test de sécurité existant
// ci-dessus (« un <script> posé reste INERTE ») ne prouve QUE le cas rassurant. `mjs_title.ts`
// pose `content.value` en `innerHTML` SANS AUCUN nettoyage : un attribut `onerror`/`onload` EST
// une exécution de code que `innerHTML` respecte (spec HTML « event handler content attributes »),
// prouvé en Chromium. Ce bloc le prouve ici aussi, pour qu'on ne lise
// jamais le test `<script>` voisin comme une promesse de sécurité de la bulle HTML.
//
// Window DÉDIÉ (pas le Window partagé du premier bloc) : `enableJavaScriptEvaluation` est
// désactivé PAR DÉFAUT dans happy-dom (garde-fou du simulateur, absent d'un VRAI navigateur, qui
// compile TOUJOURS un attribut on* en gestionnaire vivant) — vérifié empiriquement AVANT d'écrire
// ce test : sans ce réglage, `img.onerror` reste `null` après le parse, ce qui masquerait la
// faille au lieu de la prouver. Chargement d'image jamais simulé par happy-dom (aucune requête
// réseau émise pour <img src>, vérifié empiriquement — l'événement 'error' n'arrive jamais tout
// seul) : dispatché à la main, même limite déjà documentée pour TouchEvent (`touchEvent` plus
// haut) — ce qui est prouvé n'est pas « le réseau échoue », c'est « l'attribut onerror est un
// VRAI gestionnaire câblé, prêt à s'exécuter au premier déclenchement de l'événement qu'il cible ».
describe('runtime @title — sécurité : mjs-title-html exécute un gestionnaire inline (PAS un bac à sable)', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null

  before(async function () {
    const { coreCode } = await buildCore()
    window = new Window({
      url: 'http://localhost/',
      // happy-dom REFUSE par défaut de compiler un attribut on* en gestionnaire (garde-fou du
      // simulateur, cf. bandeau plus haut) — activé ICI seulement, pour reproduire le
      // comportement RÉEL d'un navigateur, jamais sur le Window partagé du premier bloc.
      settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true },
    })
    document = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;`)
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('mjs-title-html="<img src=x onerror=...>" : le gestionnaire onerror s\'exécute VRAIMENT', async () => {
    window.eval(`globalThis.__mjsTitleOnerrorRan = false;`)
    document.body.innerHTML = `<em id="t12x" mjs-title-html="&lt;img src=x onerror=&quot;globalThis.__mjsTitleOnerrorRan = true&quot;&gt;" mjs-title-conf='{"delay":10}'>x</em>`
    document.getElementById('t12x').dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title')
    const img = bubble.querySelector('img')
    assert.ok(img, 'le <img> injecté par mjs-title-html doit exister dans la bulle')
    assert.equal(typeof img.onerror, 'function', "l'attribut onerror doit être un VRAI gestionnaire câblé, pas du texte mort")
    img.dispatchEvent(new window.Event('error'))
    assert.equal(window.__mjsTitleOnerrorRan, true, "l'attribut onerror posé via innerHTML doit s'exécuter — la bulle HTML n'est PAS un bac à sable (contrairement au <script>, cf. test voisin)")
  })
})

describe('runtime @title — mode Popover (patché AVANT chargement du cœur) : bulle DANS le shadow du composant', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null
  let el: any = null

  before(async function () {
    const COMPONENT = `
<script>
$x = 0
</script>
<button id="shadowbtn" @title="Info du composant">Bouton</button>
`
    const { coreCode, compCode } = await buildCore({ name: 'titledemo', src: COMPONENT })
    window = new Window({ url: 'http://localhost/' })
    document = window.document
    // Popover natif : feature-detect AU CHARGEMENT du module (mjs_title.ts, `__titlePopoverOk`) —
    // le polyfill doit donc être en place AVANT d'évaluer le cœur, pas après.
    window.eval(`
      HTMLElement.prototype.showPopover = function () { this.setAttribute('data-popover-open', ''); };
      HTMLElement.prototype.hidePopover = function () { this.removeAttribute('data-popover-open'); };
    `)
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${compCode}`)
    document.body.innerHTML = '<mjs-titledemo></mjs-titledemo>'
    el = document.body.firstElementChild
    await sleep(50)
    assert.ok(el._shadow, 'shadow root monté')
  })

  after(async () => {
    // Vérifié empiriquement : `HTMLElement`/son prototype sont un SINGLETON de classe côté
    // happy-dom, PARTAGÉ par toutes les `Window` du même process. Sans ce retrait, le patch posé
    // dans `before()` fuit vers CHAQUE Window créée ensuite (y compris dans un describe SUIVANT) :
    // un composant compilé après ce bloc verrait `__titlePopoverOk` à `true` sans l'avoir demandé
    // (mjs_title.ts fait son feature-detect une seule fois, au chargement du module).
    delete window?.HTMLElement?.prototype?.showPopover
    delete window?.HTMLElement?.prototype?.hidePopover
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('bulle créée DANS la racine shadow du composant (PAS dans document.body) + popover ouvert', async () => {
    const btn = el._shadow.querySelector('#shadowbtn')
    btn.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true, composed: true }))
    await sleep(500) // délai par défaut (400ms, aucune config sur cet élément)
    assertAbsent(document.querySelector('.mjs-title'), 'aucune bulle en repli body en mode Popover')
    const bubble = el._shadow.querySelector('.mjs-title')
    assert.ok(bubble, 'la bulle doit vivre DANS le shadow root')
    assert.equal(bubble.textContent, 'Info du composant')
    assert.equal(bubble.hasAttribute('data-popover-open'), true, 'showPopover() doit avoir été appelé')
    btn.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, cancelable: true, composed: true }))
  })

  it('la feuille µ._mjs_titleSheet est adoptée DANS cette racine shadow (stylable depuis le SASS du composant)', () => {
    assert.notEqual(el._shadow.adoptedStyleSheets.indexOf(window.µ._mjs_titleSheet), -1)
  })
})

// @title={{ expr }} sur un VRAI composant compilé : prouve le couple complet
// compilateur (mjs-title-html={expr} réactif, cf. tests/transpiler-title.test.ts) + runtime
// (innerHTML, MutationObserver) bout en bout, comme tests/head-title.test.ts (@click={$n += 1}
// + .click() pour déclencher la réactivité depuis le test).
describe('runtime @title — forme HTML réactive ({{ }}, composant réel)', function () {
  this.timeout(40000)

  let window: any = null
  let document: any = null
  let host: any = null

  before(async function () {
    const COMPONENT = `
<script>
$html = '<b>v1</b>'
</script>

<button id="togglebtn" @click={$html = '<i>v2</i>'}>toggle</button>
<span id="reactspan" title="titre natif" @title={{ $html }}>Survole-moi</span>
`
    const { coreCode, compCode } = await buildCore({ name: 'titlehtml', src: COMPONENT })
    window = new Window({ url: 'http://localhost/' })
    document = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;\nµ.config.title.delay = 10;\n${compCode}`)
    document.body.innerHTML = '<mjs-titlehtml></mjs-titlehtml>'
    host = document.body.firstElementChild
    await sleep(30)
    assert.ok(host._shadow, 'shadow root monté')
  })

  after(async () => {
    window?.close?.()
    await terminateSharedWorkerPool()
  })

  it('bulle initiale : <b> RÉEL (HTML brut, pas texte échappé) + title natif substitué', async () => {
    const trigger = host._shadow.querySelector('#reactspan')
    trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true, composed: true }))
    await sleep(40)
    const bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('b'), '<b> réel attendu dans la bulle')
    assert.equal(bubble.querySelector('b').textContent, 'v1')
    assert.equal(trigger.hasAttribute('title'), false, 'le title natif doit être substitué (P5a), même en forme HTML')
    trigger.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, cancelable: true, composed: true }))
    await sleep(5)
    assert.equal(trigger.getAttribute('title'), 'titre natif', 'restitué à l\'identique à la fermeture')
  })

  it('réactif : un clic qui change $html met à jour la bulle EN DIRECT (bulle restée visible)', async () => {
    const trigger = host._shadow.querySelector('#reactspan')
    trigger.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true, cancelable: true, composed: true }))
    await sleep(40)
    host._shadow.querySelector('#togglebtn').click()
    await sleep(20)
    const bubble = document.querySelector('.mjs-title')
    assert.ok(bubble.querySelector('i'), '<i> attendu après la bascule réactive de $html')
    assertAbsent(bubble.querySelector('b'), 'v1 (<b>) ne doit plus être présent après la bascule')
    trigger.dispatchEvent(new window.MouseEvent('mouseout', { bubbles: true, cancelable: true, composed: true }))
  })
})
