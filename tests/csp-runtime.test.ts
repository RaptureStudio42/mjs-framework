// Volet RUNTIME NAVIGATEUR de `csp: true` : les 7
// `document.createElement('style')` du runtime basculent sur une feuille CONSTRUCTIBLE
// (`new CSSStyleSheet()` + `replaceSync` + `adoptedStyleSheets`) sous `µ._csp`, et restent
// OCTET POUR OCTET identiques à l'existant quand le drapeau est absent (défaut).
// Sites couverts : mjs_easing.ts (.shared keyframes), mjs_router.ts + mjs_ujs.ts (panneau
// 404, µ._mjs_routeErrorCss), mjs_element.ts ×2 (mode mjs-light : baseCss + variant),
// mjs_vt_presets.ts ×2 (rideau + préréglages pseudos).

import assert from 'node:assert/strict'
import { strict as nodeAssert } from 'node:assert'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { extractMarked } from './helpers/extract-marked.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(__dirname, '..', 'src', 'runtime')
const EASING_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_easing.ts'), 'utf-8')
const ROUTER_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_router.ts'), 'utf-8')
const UJS_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_ujs.ts'), 'utf-8')
const VT_PRESETS_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_vt_presets.ts'), 'utf-8')

// ──────────────────────────────────────────────────────────────────────────
// SONDE DES GLOBAUX — chaque chargement de ce fichier pose sur `globalThis` (Node, pas la fenêtre
// happy-dom) ce que le source évalué par `new Function` doit y trouver ; tout est RENDU ensuite, à
// la valeur d'arrivée ou à l'absence. Relevé pris à l'entrée du fichier, comparé après son dernier
// test : un global de plus polluerait les fichiers SUIVANTS du même process mocha, et deux suites
// l'ont déjà payé (la queue manuelle de transition-tick-abort-resolves, les 29 tests de
// ujs-nav-lifecycle-events).
// ──────────────────────────────────────────────────────────────────────────
const clesGlobales = (): string[] => Object.keys(globalThis).sort((a, b) => a < b ? -1 : a > b ? 1 : 0)
let clesALArrivee: string[] = []

describe('csp runtime — globaux à l\'arrivée', function () {
  it('relève les clés de globalThis avant tout chargement de runtime', () => {
    clesALArrivee = clesGlobales()
    assert.ok(clesALArrivee.length > 0, 'le relevé d\'arrivée ne peut pas être vide')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mjs_easing.ts — @keyframes `.shared`
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — mjs_easing.ts (.shared keyframes)', function () {
  // `g.document`/`g.CSSStyleSheet` posées sur globalThis (Node, pas la fenêtre happy-dom) pour que
  // le code source évalué par `new Function` les trouve — jamais nettoyées sinon, elles pointent
  // sur une fenêtre déjà morte et polluent les fichiers de test SUIVANTS dans le même process mocha.
  // RENDUES à leur valeur d'arrivée, jamais simplement supprimées (même patron que le bloc des
  // transitions de page plus bas) : un fichier de test qui passe AVANT celui-ci peut avoir posé sa
  // propre `document` sur globalThis, qu'un `delete` en aveugle ferait disparaître — le relevé de
  // sortie de ce fichier tombait alors sur un global de MOINS. Capture à l'ARRIVÉE ; ce qui était
  // absent est le seul cas où l'on supprime.
  const GLOBAUX_EASING = ['document', 'CSSStyleSheet']
  const __avantEasing  = new Map<string, { present: boolean; valeur: any }>()
  before(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_EASING) __avantEasing.set(nom, { present: nom in g, valeur: g[nom] })
  })
  afterEach(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_EASING) {
      const avant = __avantEasing.get(nom)
      if(avant?.present) g[nom] = avant.valeur
      else delete g[nom]
    }
  })

  function load(win: any, csp: boolean, src: string = EASING_SRC) {
    const g: any = globalThis
    g.document = win.document
    g.CSSStyleSheet = win.CSSStyleSheet
    const µ: any = { log() {}, warn() {}, error() {}, anim: {}, _csp: csp }
    new Function('µ', src)(µ)
    return µ
  }

  it('sous µ._csp absent : <style id="_mjs_anim_keyframes"> créé comme avant, aucune feuille adoptée', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win, false)
    µ.anim._mjs_acquireKeyframes('kf1', () => [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }])
    const el = win.document.getElementById('_mjs_anim_keyframes')
    assert.ok(el, 'le <style> historique existe')
    assert.match(el.textContent, /@keyframes kf1/)
    assert.equal(win.document.adoptedStyleSheets.length, 0, 'aucune feuille adoptée hors mode csp')
  })

  it('sous µ._csp vrai : AUCUN <style> créé, la règle vit dans une feuille adoptée, release retire la règle', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win, true)
    µ.anim._mjs_acquireKeyframes('kf2', () => [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }])
    assertAbsent(win.document.getElementById('_mjs_anim_keyframes'), 'aucun <style> posé')
    assert.equal(win.document.querySelectorAll('style').length, 0)
    assert.equal(win.document.adoptedStyleSheets.length, 1, 'une feuille constructible adoptée')
    assert.match(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /@keyframes kf2/)
    µ.anim._mjs_releaseKeyframes('kf2')
    assert.equal(win.document.adoptedStyleSheets[0].cssRules.length, 0, 'la règle est retirée par index, feuille conservée')
  })

  it('SABOTAGE — retirer la garde `µ._csp` de `ensureSheet` fait rougir l\'assertion "aucun <style>"', () => {
    // `if (µ._csp) {` revient 3 fois (ensureSheet, _mjs_acquireKeyframes, _mjs_releaseKeyframes) : neutraliser
    // seulement la 1re avec `.replace` laisse les 2 autres croire au csp actif sur un <style> DOM
    // (pas une CSSStyleSheet) → TypeError avant même d'atteindre l'assertion. `.replaceAll` simule
    // une garde absente PARTOUT, comportement cohérent, et fait rougir pour la bonne raison.
    const sabotaged = EASING_SRC.replaceAll('if (µ._csp) {', 'if (false) {')
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win, true, sabotaged)
    µ.anim._mjs_acquireKeyframes('kf3', () => [{ offset: 0, opacity: 0 }, { offset: 1, opacity: 1 }])
    assert.throws(() => {
      assertAbsent(win.document.getElementById('_mjs_anim_keyframes'), 'aucun <style> posé')
    }, /aucun <style> posé/, 'sans la garde, un <style> est bel et bien créé — le test attrape la régression')
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mjs_router.ts — panneau « route introuvable »
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — mjs_router.ts (panneau 404)', function () {
  // mêmes globaux, même patron de restitution que le bloc mjs_easing.ts ci-dessus
  const GLOBAUX_ROUTER = ['document', 'CSSStyleSheet']
  const __avantRouter  = new Map<string, { present: boolean; valeur: any }>()
  before(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_ROUTER) __avantRouter.set(nom, { present: nom in g, valeur: g[nom] })
  })
  afterEach(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_ROUTER) {
      const avant = __avantRouter.get(nom)
      if(avant?.present) g[nom] = avant.valeur
      else delete g[nom]
    }
  })

  function scene(csp: boolean, src: string = ROUTER_SRC) {
    const win: any = new Window({ url: 'http://localhost/' })
    const g: any = globalThis
    g.document = win.document
    g.CSSStyleSheet = win.CSSStyleSheet
    const µ: any = { log() {}, warn() {}, error() {}, config: {}, _mjs_routeErrorCss: '.mjs-route-error{color:red}', _csp: csp }
    new Function('µ', src)(µ)
    const viewNode: any = win.document.createElement('metamjs-view')
    viewNode.id = 'main'
    const comp: any = {
      tagName: 'MJS-APP',
      _shadow: { querySelector: (sel: string) => sel.includes('#main') ? viewNode : null },
      querySelector: () => null,
      routes: { main: { '/': 'home' } },
    }
    µ.Router._mjs_awareComponents.add(comp)
    µ.Router._mjs_injectViewsForComponent(comp, '/nimportequoi')
    return { µ, win, viewNode }
  }

  it('sous µ._csp absent : <style> à côté du panneau, comme avant', () => {
    const { µ, viewNode } = scene(false)
    µ.Router._mjs_checkNoMatch('/nimportequoi')
    assert.ok(viewNode.querySelector('style'), 'le <style> historique est présent')
    assert.equal(µ.Router._mjs_routeErrorSheetAdopted, false)
  })

  it('sous µ._csp vrai : aucun <style>, feuille constructible adoptée UNE FOIS sur document', () => {
    const { µ, win, viewNode } = scene(true)
    µ.Router._mjs_checkNoMatch('/nimportequoi')
    assertAbsent(viewNode.querySelector('style'), 'aucun <style> dans le panneau')
    assert.equal(win.document.adoptedStyleSheets.length, 1)
    assert.match(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /mjs-route-error/)
    // second déclenchement : pas de 2e feuille adoptée
    µ.Router._mjs_checkNoMatch('/x')
    assert.equal(win.document.adoptedStyleSheets.length, 1, 'la feuille du panneau est réutilisée, pas redupliquée')
  })

  it('SABOTAGE — retirer la garde fait rougir l\'assertion "aucun <style>"', () => {
    const sabotaged = ROUTER_SRC.replace(
      "if (µ._csp) {\n      if (!this._mjs_routeErrorSheetAdopted) {",
      "if (false) {\n      if (!this._mjs_routeErrorSheetAdopted) {"
    )
    assert.notEqual(sabotaged, ROUTER_SRC, 'le remplacement doit avoir trouvé sa cible')
    const { µ, viewNode } = scene(true, sabotaged)
    µ.Router._mjs_checkNoMatch('/nimportequoi')
    assert.throws(() => {
      assertAbsent(viewNode.querySelector('style'), 'aucun <style> dans le panneau')
    }, /aucun <style>/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mjs_ujs.ts — panneau « route introuvable » (second site, µ._mjs_navShowNotFound)
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — mjs_ujs.ts (panneau 404, _mjs_navShowNotFound)', function () {
  afterEach(() => { delete (globalThis as any).CSSStyleSheet })

  function scene(csp: boolean, src: string = UJS_SRC) {
    const win: any = new Window({ url: 'http://localhost/' })
    const g: any = globalThis
    g.CSSStyleSheet = win.CSSStyleSheet
    const block = extractMarked(src, 'helpers-navigation')
    const µ: any = { log() {}, warn() {}, error() {}, config: {}, _mjs_routeErrorCss: '.mjs-route-error{color:red}', _csp: csp, Router: null }
    new Function('µ', 'document', 'window', block)(µ, win.document, win)
    return { µ, win }
  }

  it('sous µ._csp absent : <style> frère du texte dans `box`, comme avant', () => {
    const { µ, win } = scene(false)
    µ._mjs_navShowNotFound('/nope', null, 'replace', undefined)
    const box = win.document.body.querySelector('[data-mjs-route-error]')
    assert.ok(box, 'panneau posé')
    assert.ok(box.querySelector('style'), 'le <style> historique est frère du texte')
    assert.equal(win.document.adoptedStyleSheets.length, 0)
  })

  it('sous µ._csp vrai : aucun <style>, feuille constructible adoptée UNE FOIS', () => {
    const { µ, win } = scene(true)
    µ._mjs_navShowNotFound('/nope', null, 'replace', undefined)
    const box = win.document.body.querySelector('[data-mjs-route-error]')
    assert.ok(box)
    assertAbsent(box.querySelector('style'), 'aucun <style> dans le panneau')
    assert.equal(win.document.adoptedStyleSheets.length, 1)
    assert.match(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /mjs-route-error/)
  })

  it('SABOTAGE — retirer la garde fait rougir l\'assertion "aucun <style>"', () => {
    const sabotaged = UJS_SRC.replace(
      "if (µ._csp) {\n    // sous",
      "if (false) {\n    // sous"
    )
    assert.notEqual(sabotaged, UJS_SRC, 'le remplacement doit avoir trouvé sa cible')
    const { µ, win } = scene(true, sabotaged)
    µ._mjs_navShowNotFound('/nope', null, 'replace', undefined)
    const box = win.document.body.querySelector('[data-mjs-route-error]')
    assert.throws(() => {
      assertAbsent(box.querySelector('style'), 'aucun <style> dans le panneau')
    }, /aucun <style>/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mjs_vt_presets.ts — rideau (_mjs_vtCurtainRun) et préréglages pseudos (_mjs_vtApplyPreset)
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — mjs_vt_presets.ts (@viewTransition)', function () {
  // le faux requestAnimationFrame posé sur globalThis par loadVt fuitait dans les fichiers SUIVANTS
  // du même process Mocha : transition-tick-abort-resolves.test.ts pose SA queue manuelle au
  // CHARGEMENT, on l'écrasait à l'EXÉCUTION, ses 3 tests tombaient. Capture à l'ARRIVÉE (dans
  // before(), pas en tête de fichier : au chargement la valeur d'origine n'est pas encore la bonne),
  // rendu à la FIN de la suite et non à chaque test : un timer différé du rideau
  // `_mjs_vtCurtainRun` retombe pendant un test suivant, lui retirer le rAF en cours de route ferait
  // 2 échecs fantômes. Node n'en fournit pas : ABSENT à l'arrivée, il est RETIRÉ — un global de plus
  // est une pollution comme une autre (cf. la sonde en tête de fichier), même quand sa valeur était
  // `undefined`.
  const __rafArrivee: { present: boolean; valeur: any } = { present: false, valeur: undefined }
  before(() => {
    __rafArrivee.present = 'requestAnimationFrame' in globalThis
    __rafArrivee.valeur  = (globalThis as any).requestAnimationFrame
  })
  after(() => {
    if(__rafArrivee.present) (globalThis as any).requestAnimationFrame = __rafArrivee.valeur
    else delete (globalThis as any).requestAnimationFrame
  })
  // `g.window`/`document`/`CSSStyleSheet`/`CustomEvent`/`customElements`/`getComputedStyle` posées
  // sur globalThis à chaque `loadVt` — jamais nettoyées sinon, elles pointent sur une fenêtre morte
  // et polluent les fichiers de test SUIVANTS dans le même process mocha (`requestAnimationFrame`
  // à part, cf. before/after ci-dessus : sa restauration est repoussée à la FIN du fichier).
  // Chacune est RENDUE à sa valeur d'arrivée, jamais simplement supprimée : `CustomEvent` EXISTE
  // dans Node sans le moindre navigateur, `delete` le faisait donc disparaître d'un process où
  // personne ne l'avait posé — 29 tests de `ujs-nav-lifecycle-events` tombaient quand ce fichier
  // passait avant eux. Capture à l'ARRIVÉE (`before`, comme le rAF) ; ce qui était ABSENT est le
  // seul cas où l'on supprime.
  const GLOBAUX_VT = ['window', 'document', 'CSSStyleSheet', 'CustomEvent', 'customElements', 'getComputedStyle']
  const __avantVt  = new Map<string, { present: boolean; valeur: any }>()
  before(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_VT) __avantVt.set(nom, { present: nom in g, valeur: g[nom] })
  })
  afterEach(() => {
    const g: any = globalThis
    for(const nom of GLOBAUX_VT) {
      const avant = __avantVt.get(nom)
      if(avant?.present) g[nom] = avant.valeur
      else delete g[nom]
    }
  })

  function loadVt(win: any, csp: boolean, src: string = VT_PRESETS_SRC) {
    const g: any = globalThis
    g.window = win
    g.document = win.document
    g.CSSStyleSheet = win.CSSStyleSheet
    g.CustomEvent = win.CustomEvent
    g.customElements = win.customElements
    g.getComputedStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle.bind(win) : g.getComputedStyle
    g.requestAnimationFrame = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (cb: any) => setTimeout(cb, 16)
    const µ: any = { log() {}, warn() {}, error() {}, _csp: csp }
    new Function('µ', src)(µ)
    return µ
  }

  it('rideau, sous µ._csp absent : <style id="mjs-vt-curtain-css"> comme avant', async () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, false)
    const ok = µ._mjs_vtCurtainRun('iris', () => {})
    assert.equal(ok, true)
    const sheetEl = win.document.getElementById('mjs-vt-curtain-css')
    assert.ok(sheetEl, 'le <style> historique du rideau est présent')
    assert.equal(win.document.adoptedStyleSheets.length, 0)
  })

  it('rideau, sous µ._csp vrai : aucun <style>, feuille constructible adoptée et réutilisée', async () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, true)
    const ok = µ._mjs_vtCurtainRun('iris', () => {})
    assert.equal(ok, true)
    assertAbsent(win.document.getElementById('mjs-vt-curtain-css'), 'aucun <style> du rideau')
    assert.equal(win.document.adoptedStyleSheets.length, 1)
    // happy-dom `replaceSync` ne parse pas les pseudo-éléments fonctionnels `::view-transition-*(root)`
    // (rejetés silencieusement) : la feuille du rideau ne les contient de toute façon pas — le CSS de
    // 'iris' est le voile `.mjs-vtc-veil`, sans rapport avec les pseudos view-transition
    assert.match(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /mjs-vtc-veil/)
    // draine le setTimeout(coverMs)+rAF×2+setTimeout(revealMs+80) du rideau : sinon il fuit dans les
    // describe suivants (mjs_element.ts) et y explose sur un requestAnimationFrame déjà restauré
    await new Promise(r => setTimeout(r, 900))
  })

  it('préréglages pseudos, sous µ._csp absent : <style id="mjs-vt-presets"> comme avant', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, false)
    µ._mjs_vtApplyPreset('fade')
    const sheetEl = win.document.getElementById('mjs-vt-presets')
    assert.ok(sheetEl, 'le <style> historique des préréglages est présent')
    assert.match(sheetEl.textContent, /view-transition/)
    assert.equal(win.document.adoptedStyleSheets.length, 0)
  })

  it('préréglages pseudos, sous µ._csp vrai : aucun <style>, feuille constructible adoptée UNE FOIS puis remplacée', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, true)
    µ._mjs_vtApplyPreset('fade')
    assertAbsent(win.document.getElementById('mjs-vt-presets'), 'aucun <style> des préréglages')
    assert.equal(win.document.adoptedStyleSheets.length, 1)
    // même limite happy-dom que ci-dessus : seul le `@keyframes` (pas les pseudos view-transition)
    // survit au parsing de `replaceSync` — 'mjs-vt-fade' identifie sans ambiguïté le préréglage
    assert.match(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /mjs-vt-fade/)
    µ._mjs_vtApplyPreset('zoom')
    assert.equal(win.document.adoptedStyleSheets.length, 1, 'même feuille réutilisée, pas redupliquée')
    assert.doesNotMatch(win.document.adoptedStyleSheets[0].cssRules[0].cssText, /fade/i, 'contenu remplacé (replaceSync), pas cumulé')
  })

  it('SABOTAGE (rideau) — retirer la garde fait rougir l\'assertion "aucun <style>"', async () => {
    const sabotaged = VT_PRESETS_SRC.replace(
      "if (µ._csp) {\n    if (!µ._mjs_vtCurtainCspSheet) {",
      "if (false) {\n    if (!µ._mjs_vtCurtainCspSheet) {"
    )
    assert.notEqual(sabotaged, VT_PRESETS_SRC, 'le remplacement doit avoir trouvé sa cible')
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, true, sabotaged)
    µ._mjs_vtCurtainRun('iris', () => {})
    assert.throws(() => {
      assertAbsent(win.document.getElementById('mjs-vt-curtain-css'), 'aucun <style> du rideau')
    }, /aucun <style>/)
    // draine le setTimeout(coverMs)+rAF×2+setTimeout(revealMs+80) du rideau, cf. commentaire plus haut
    await new Promise(r => setTimeout(r, 900))
  })

  it('SABOTAGE (préréglages) — retirer la garde fait rougir l\'assertion "aucun <style>"', () => {
    // `if (µ._csp) {` et `if (!µ._csp && !sheet) {` sont DEUX gardes distinctes dans `_mjs_vtApplyPreset` :
    // neutraliser seulement la 1re laisse la 2e (µ._csp toujours vrai) empêcher la création du <style>
    // de repli → `sheet` reste `null`, `setCss` plante avant même d'atteindre l'assertion. `.replaceAll`
    // neutralise les deux gardes ensemble, comportement cohérent (mode non-csp simulé de bout en bout).
    const sabotaged = VT_PRESETS_SRC.replaceAll('µ._csp', 'false')
    assert.notEqual(sabotaged, VT_PRESETS_SRC, 'le remplacement doit avoir trouvé sa cible')
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadVt(win, true, sabotaged)
    µ._mjs_vtApplyPreset('fade')
    assert.throws(() => {
      assertAbsent(win.document.getElementById('mjs-vt-presets'), 'aucun <style> des préréglages')
    }, /aucun <style>/)
  })
})

// ──────────────────────────────────────────────────────────────────────────
// mjs_element.ts — mode `mjs-light` (baseCss + variant), pipeline RÉEL
// (Bundler → mjs_core + composant COMPILÉS puis MONTÉS dans happy-dom, patron
// tests/runtime-hotcss.test.ts et tests/mjs-layout-runtime.test.ts).
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — mjs_element.ts (mode mjs-light)', function () {
  this.timeout(60000)

  const COMPONENT = [
    '<script lang="coffee">',
    '$titre = "salut"',
    '</script>',
    '<p class="t">{$titre}</p>',
    '<style>',
    '.t',
    '  color: red',
    '</style>',
  ].join('\n')

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")

  // `withVariant` : le composant DÉCLARE `<style name="bandeau">` — seule origine réelle de
  // `_mjs_layouts` et du variant embarqué au build ; la page le demande par `layout="bandeau"`
  async function loadHarness(withVariant = false) {
    const root = mjsTmp('csp-light')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'csplight.mjs'), withVariant ? [COMPONENT, '<style name="bandeau">', '.t', '  color: blue', '</style>'].join('\n') : COMPONENT)

    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const fetchCalls: string[] = []
    window.fetch = (url: string) => { fetchCalls.push(url); return Promise.resolve({ ok: true, status: 200, text: async () => '.t{color:blue}' }) }

    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^csplight-/.test(f))
    assert.ok(coreFile && compFile, `sortie du build inattendue : ${files.join(', ')}`)
    window.eval([
      stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
      'globalThis.µ = µ;',
      stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
    ].join('\n'))

    const Ctor = window.customElements.get('mjs-csplight')
    assert.ok(Ctor, 'le composant doit être défini sous mjs-csplight')
    Ctor.mjsLight = true
    return { window, document, Ctor, fetchCalls }
  }

  it('site 1 (baseCss) — sous µ._csp absent : <style data-mjs-light> comme avant', async () => {
    const { window, document } = await loadHarness()
    // baseline : mjs_core adopte SES PROPRES feuilles de base (`:not(:defined)`, thème, modale…) dès
    // le chargement, indépendamment de `_csp` — seul le DELTA imputable au mode mjs-light nous intéresse
    const baseline = window.document.adoptedStyleSheets.length
    document.body.innerHTML = '<mjs-csplight mjs-light></mjs-csplight>'
    await new Promise(r => setTimeout(r, 80))
    const styles = document.head.querySelectorAll('style[data-mjs-light="mjs-csplight"]')
    assert.equal(styles.length, 1, 'le <style> historique est posé')
    assert.equal(window.document.adoptedStyleSheets.length, baseline, 'aucune feuille supplémentaire adoptée')
  })

  it('site 1 (baseCss) — sous µ._csp vrai : aucun <style data-mjs-light>, feuille constructible adoptée', async () => {
    const { window, document } = await loadHarness()
    window.µ._csp = true
    const baseline = window.document.adoptedStyleSheets.length
    document.body.innerHTML = '<mjs-csplight mjs-light></mjs-csplight>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(document.head.querySelectorAll('style[data-mjs-light="mjs-csplight"]').length, 0, 'aucun <style> posé')
    assert.ok(window.document.adoptedStyleSheets.length > baseline, 'au moins une feuille de plus (baseCss)')
    const hasRed = window.document.adoptedStyleSheets.some((s: any) => Array.from(s.cssRules).some((r: any) => /color: red/.test(r.cssText)))
    assert.ok(hasRed, 'la feuille du baseCss est bien adoptée avec son CSS')
  })

  it('site 2 (variant) — sous µ._csp absent : <style data-mjs-light-layout> comme avant', async () => {
    const { document } = await loadHarness(true)
    document.body.innerHTML = '<mjs-csplight mjs-light layout="bandeau"></mjs-csplight>'
    await new Promise(r => setTimeout(r, 80))
    const styles = document.head.querySelectorAll('style[data-mjs-light-layout="mjs-csplight"]')
    assert.equal(styles.length, 1, 'le <style> historique du variant est posé')
    assert.equal(styles[0].textContent, '.t{color:blue}')
  })

  it('site 2 (variant) — sous µ._csp vrai : aucun <style data-mjs-light-layout>, feuille constructible adoptée', async () => {
    const { window, document } = await loadHarness(true)
    window.µ._csp = true
    document.body.innerHTML = '<mjs-csplight mjs-light layout="bandeau"></mjs-csplight>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(document.head.querySelectorAll('style[data-mjs-light-layout="mjs-csplight"]').length, 0, 'aucun <style> posé')
    // 2 feuilles adoptées : la baseCss (montée avant le variant) + le variant
    assert.ok(window.document.adoptedStyleSheets.length >= 1)
    const hasBlue = window.document.adoptedStyleSheets.some((s: any) => Array.from(s.cssRules).some((r: any) => /color: blue/.test(r.cssText)))
    assert.ok(hasBlue, 'la feuille du variant est bien adoptée avec son CSS')
  })

  it('SABOTAGE (site 1) — retirer la garde fait rougir l\'assertion "aucun <style>"', async () => {
    const root = mjsTmp('csp-light-sab')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, 'csplightsab.mjs'), COMPONENT)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0)
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const compFile = files.find((f: string) => /^csplightsab-/.test(f))
    // le garde-fou `µ._csp` du mode mjs-light vit dans la classe de base `mjs_element.ts`, donc dans
    // le bundle PARTAGÉ `mjs_core-*.js` — pas dans le fichier compilé du composant `csplightsab-*.js`
    const compiledCore = readFileSync(join(outDir, coreFile!), 'utf-8')
    const sabotagedCore = compiledCore.replace(
      "if (µ._csp) {\n            var lightStyleSheet",
      "if (false) {\n            var lightStyleSheet"
    )
    assert.notEqual(sabotagedCore, compiledCore, 'le remplacement doit avoir trouvé sa cible dans le bundle compilé')
    window.eval([
      stripEsm(sabotagedCore),
      'globalThis.µ = µ;',
      stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
    ].join('\n'))
    window.µ._csp = true
    const Ctor = window.customElements.get('mjs-csplightsab')
    Ctor.mjsLight = true
    document.body.innerHTML = '<mjs-csplightsab mjs-light></mjs-csplightsab>'
    await new Promise(r => setTimeout(r, 80))
    assert.throws(() => {
      nodeAssert.equal(document.head.querySelectorAll('style[data-mjs-light="mjs-csplightsab"]').length, 0, 'aucun <style> posé')
    }, /aucun <style>/)
  })

  after(async () => { await terminateSharedWorkerPool() })
})

// ──────────────────────────────────────────────────────────────────────────
// Sortie du fichier : le relevé des globaux doit être celui de l'arrivée
// ──────────────────────────────────────────────────────────────────────────
describe('csp runtime — aucun global laissé derrière', function () {
  it('les clés de globalThis sont exactement celles de l\'arrivée', () => {
    assert.deepEqual(clesGlobales(), clesALArrivee, 'un global posé par un chargement de ce fichier n\'a pas été rendu')
  })
})
