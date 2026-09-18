// bogue PRÉEXISTANT (mesuré sous Chromium) : une transition `.shared`
// (`@transition.fade.shared`, `@transition.iris.shared`…) posée sur un nœud qui vit dans un
// composant EN OMBRE (mode par défaut de ModularJS) ne joue JAMAIS et l'élément n'est jamais
// retiré du DOM. Cause : `ensureSheet()` injecte le `@keyframes` dans le DOCUMENT, or les noms de
// `@keyframes` sont À PORTÉE D'ARBRE (tree-scoped) — un nœud dans un shadow root ne voit pas un
// `@keyframes` du document. Le correctif fait vivre la feuille LÀ OÙ VIT LE NŒUD (sa racine).
//
// Chargement de mjs_easing.ts : mécanisme de tests/csp-runtime.test.ts (l.22-50) — EASING_SRC lu
// une fois, `document`/`CSSStyleSheet` posés sur globalThis AVANT `new Function('µ', EASING_SRC)(µ)`,
// retirés en afterEach pour ne pas polluer les fichiers suivants dans le même run mocha.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))
const RUNTIME_DIR = join(__dirname, '..', 'src', 'runtime')
const EASING_SRC = readFileSync(join(RUNTIME_DIR, 'mjs_easing.ts'), 'utf-8')

// keyframes triviales, offset 0→1 — le contenu n'importe pas ici, seule la PORTÉE est sous test
function builder() {
  return [{ opacity: 0, offset: 0 }, { opacity: 1, offset: 1 }]
}

describe('.shared keyframes dans un shadow root', function () {
  afterEach(() => {
    const g: any = globalThis
    delete g.document
    delete g.CSSStyleSheet
  })

  function load(win: any, csp: boolean = false) {
    const g: any = globalThis
    g.document = win.document
    g.CSSStyleSheet = win.CSSStyleSheet
    const µ: any = { log() {}, warn() {}, error() {}, anim: {}, _csp: csp }
    new Function('µ', EASING_SRC)(µ)
    return µ
  }

  it('(a) nœud dans un shadow root : le <style> vit DANS la racine, rien dans le document, animationend résout et nettoie', async () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win)
    const host: any = win.document.createElement('div')
    win.document.body.appendChild(host)
    const sh: any = host.attachShadow({ mode: 'open' })
    const node: any = win.document.createElement('div')
    sh.appendChild(node)

    const p = µ.anim._mjs_runShared(node, '_kf_t1', builder, { duration: 10, direction: 'in' })

    const styleInShadow: any = sh.querySelector('style[data-mjs-anim-keyframes]')
    assert.equal(styleInShadow !== null, true, 'le <style> des keyframes doit vivre dans le shadow root')
    assert.match(String(styleInShadow.textContent), /@keyframes _kf_t1/)
    assert.equal(win.document.getElementById('_mjs_anim_keyframes') !== null, false, 'rien injecté dans le document pour un nœud en ombre')
    assert.equal(node.style.animation.indexOf('_kf_t1 10ms'), 0, `attendu un animation commençant par « _kf_t1 10ms », reçu « ${node.style.animation} »`)

    node.dispatchEvent(new win.Event('animationend', { bubbles: true }))
    await p

    assert.equal(String(styleInShadow.textContent).includes('_kf_t1'), false, 'la règle est retirée du texte (refs à 0 → nœud texte retiré)')
    assert.equal(node.style.animation, '', "l'animation d'avant (vide) est restaurée")
  })

  it('(b) deux nœuds dans le même shadow root, même nom : une seule feuille, une seule occurrence, refs comptés avant retrait', async () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win)
    const host: any = win.document.createElement('div')
    win.document.body.appendChild(host)
    const sh: any = host.attachShadow({ mode: 'open' })
    const node1: any = win.document.createElement('div')
    const node2: any = win.document.createElement('div')
    sh.appendChild(node1)
    sh.appendChild(node2)

    const p1 = µ.anim._mjs_runShared(node1, '_kf_t2', builder, { duration: 10, direction: 'in' })
    const p2 = µ.anim._mjs_runShared(node2, '_kf_t2', builder, { duration: 10, direction: 'in' })

    assert.equal(sh.querySelectorAll('style[data-mjs-anim-keyframes]').length, 1, 'une seule feuille pour la racine, réutilisée par le 2e nœud')
    const styleEl: any = sh.querySelector('style[data-mjs-anim-keyframes]')
    const occurrences = String(styleEl.textContent).split('@keyframes _kf_t2').length - 1
    assert.equal(occurrences, 1, 'une seule occurrence de la règle (2e acquire = juste un incrément de refs)')

    node1.dispatchEvent(new win.Event('animationend', { bubbles: true }))
    await p1
    assert.equal(String(styleEl.textContent).includes('_kf_t2'), true, 'refs encore à 1 (node2 en cours) : la règle reste après la 1re fin')

    node2.dispatchEvent(new win.Event('animationend', { bubbles: true }))
    await p2
    assert.equal(String(styleEl.textContent).includes('_kf_t2'), false, 'refs à 0 après la 2e fin : la règle est partie')
  })

  it('(c) deux shadow roots différents reçoivent chacun leur propre feuille', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win)
    const host1: any = win.document.createElement('div')
    const host2: any = win.document.createElement('div')
    win.document.body.appendChild(host1)
    win.document.body.appendChild(host2)
    const sh1: any = host1.attachShadow({ mode: 'open' })
    const sh2: any = host2.attachShadow({ mode: 'open' })
    const node1: any = win.document.createElement('div')
    const node2: any = win.document.createElement('div')
    sh1.appendChild(node1)
    sh2.appendChild(node2)

    µ.anim._mjs_runShared(node1, '_kf_t2c', builder, { duration: 10, direction: 'in' })
    µ.anim._mjs_runShared(node2, '_kf_t2c', builder, { duration: 10, direction: 'in' })

    assert.equal(sh1.querySelectorAll('style[data-mjs-anim-keyframes]').length, 1, 'feuille propre à sh1')
    assert.equal(sh2.querySelectorAll('style[data-mjs-anim-keyframes]').length, 1, 'feuille propre à sh2')
  })

  it('(d) sous µ._csp : feuille constructible adoptée SUR LA RACINE (le shadow root), pas sur le document', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win, true)
    const host: any = win.document.createElement('div')
    win.document.body.appendChild(host)
    const sh: any = host.attachShadow({ mode: 'open' })
    const node: any = win.document.createElement('div')
    sh.appendChild(node)

    µ.anim._mjs_runShared(node, '_kf_t3', builder, { duration: 10, direction: 'in' })

    assert.equal(sh.adoptedStyleSheets.length, 1, 'une feuille adoptée sur le shadow root')
    assert.equal(sh.adoptedStyleSheets[0].cssRules.length, 1)
    const rule: any = sh.adoptedStyleSheets[0].cssRules[0]
    const exposedName = typeof rule.name === 'string' && rule.name ? rule.name : null
    if (exposedName !== null) {
      assert.equal(exposedName, '_kf_t3', 'happy-dom expose CSSKeyframesRule.name — vérifié en source (20.11.0)')
    } else {
      assert.equal(String(rule.cssText).includes('_kf_t3'), true, "repli cssText — happy-dom n'expose pas .name ici")
    }
    assert.equal(win.document.adoptedStyleSheets.length, 0, 'rien adopté sur le document')
  })

  it('(e) nœud directement dans le document (pas d\'ombre) : comportement inchangé, témoin du tri par racine', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = load(win)
    const node: any = win.document.createElement('div')
    win.document.body.appendChild(node)

    µ.anim._mjs_runShared(node, '_kf_t4', builder, { duration: 10, direction: 'in' })

    assert.equal(win.document.getElementById('_mjs_anim_keyframes') !== null, true, 'le tri par racine ne casse pas le cas document : <style> historique toujours créé')
  })
})
