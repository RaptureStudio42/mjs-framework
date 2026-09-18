// Tests neufs — le plafond des toasts devient « CE QUI TIENT À L'ÉCRAN ». Le plafond
// numérique µ.config.notifyMax reste en vigueur, mais la place réellement disponible dans la
// fenêtre le borne à son tour : un toast qui ferait déborder la pile hors de l'écran RESTE en
// file (jamais perdu, jamais affiché à moitié) et apparaît quand une place se libère — la règle
// « zéro éviction » est intacte, aucun toast affiché n'est chassé. Deux garde-fous
// vérifiés ici aussi : un toast SEUL n'est jamais refusé (mieux vaut un toast qui dépasse qu'un
// écran vide), et l'absence de moteur de mise en page (hauteur mesurée à 0 : SSR, happy-dom nu)
// ne borne RIEN — sans mesure fiable, notifyMax redevient seul juge.
//
// Méthode : happy-dom ne calcule aucune géométrie, on POSE donc une fausse mise en page FIDÈLE au
// CSS réel (.mjs-toasts : display:flex, gap:8px, ancrage à 16px) — hauteur de contenu = n × toast
// + (n−1) × gap, et surtout un rectangle DYNAMIQUE dont seul le bord ANCRÉ est fixe, comme en CSS.
// C'est ce qui rend le cas « ancrage bas » discriminant : une mesure prise du mauvais côté ne
// laisserait passer qu'un seul toast.
//
// Les deux derniers cas couvrent un point limite supplémentaire : un placement libre qui
// pose `top` ET `bottom` donne au conteneur une hauteur résolue par la FENÊTRE, constante quel que
// soit son contenu — mesurer la boîte (offsetHeight) y est aveugle au débordement dans un sens et
// refuse tout dans l'autre. Seul le CONTENU (scrollHeight) dit la vérité.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stripEsm(s: string): string {
  return s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
}

const INIT_SRC = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')
const GAP = 8 // .mjs-toasts { gap: 8px } — feuille µ._mjs_modalSheet
let restaurer: (() => void) | null = null

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

// fausse mise en page : le conteneur est créé À L'AVANCE (__toastEnsureContainer le retrouvera par
// son .mjs-toasts) pour pouvoir l'instrumenter avant le premier notify(). `haut`/`bas` = les deux
// ancrages posés (en px depuis les bords) ; les deux ensemble = boîte à hauteur RÉSOLUE par la
// fenêtre, exactement comme le CSS d'un placement libre `{ top, bottom }`.
function fakeLayout(window: any, document: any, o: { vh: number; toastH: number; haut?: number; bas?: number; remonte?: boolean }): any {
  const box = document.createElement('div')
  box.className = 'mjs-toasts'
  document.body.appendChild(box)
  Object.defineProperty(window, 'innerHeight', { get: () => o.vh, configurable: true }) // lue à chaque fois : le test peut agrandir la fenêtre en mutant o.vh

  const pas = o.toastH + GAP
  const contenu = () => { const n = box.querySelectorAll('.mjs-toast').length; return n ? n * o.toastH + (n - 1) * GAP : 0 }
  const boite = () => (o.haut != null && o.bas != null ? o.vh - o.haut - o.bas : contenu()) // top+bottom : hauteur imposée par la FENÊTRE, contenu ou pas
  // rect d'un toast : l'ancrage seul est fixe. Ancré en bas SANS `top` → flex column-reverse,
  // l'ordre visuel est l'inverse de l'ordre du DOM ; sinon column, ordre visuel = ordre du DOM.
  const rectToast = (el: any) => {
    const kids = Array.from(box.querySelectorAll('.mjs-toast'))
    const n = kids.length
    const i = kids.indexOf(el)
    const renverse = o.remonte != null ? o.remonte : (o.bas != null && o.haut == null) // flux inversé : le contenu part du BAS de la boîte et monte
    const debut = renverse ? o.vh - o.bas! - contenu() : (o.haut != null ? o.haut : 16)
    const top = debut + (renverse ? n - 1 - i : i) * pas
    return { top: top, bottom: top + o.toastH, height: o.toastH }
  }
  // happy-dom partage HTMLElement.prototype entre fenêtres : la retouche est RENDUE après chaque
  // test (afterEach), sinon elle fuiterait sur les autres fichiers de tests avec un conteneur périmé.
  const proto = window.HTMLElement.prototype
  const avant = Object.getOwnPropertyDescriptor(proto, 'getBoundingClientRect')
  restaurer = () => { if (avant) { Object.defineProperty(proto, 'getBoundingClientRect', avant) } else { delete (proto as any).getBoundingClientRect } }
  Object.defineProperty(proto, 'getBoundingClientRect', { configurable: true, value: function (this: any) { return this.classList && this.classList.contains('mjs-toast') ? rectToast(this) : { top: 0, bottom: 0, height: 0 } } })
  Object.defineProperty(box, 'offsetHeight', { configurable: true, get: boite })
  Object.defineProperty(box, 'scrollHeight', { configurable: true, get: () => Math.max(contenu(), boite()) }) // scrollHeight a pour PLANCHER la hauteur de boîte — c'est ce qui le rend inutilisable ici
  return box
}

function toasts(document: any): any[] {
  return Array.from(document.body.querySelector('.mjs-toasts')?.querySelectorAll('.mjs-toast') ?? [])
}
function messages(document: any): string[] {
  return toasts(document).map((t) => t.querySelector('.mjs-toast-message').textContent)
}

describe('mjs_modal — plafond « ce qui tient à l\'écran »', function () {
  afterEach(function () { if (restaurer) { restaurer(); restaurer = null } })

  it('illimité + place pour 4 : 8 notify() → 4 affichés seulement, les 4 autres EN FILE (aucun nœud dans le DOM)', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 300, toastH: 60 }) // place = 300 − 16 (ancrage) − 16 (marge) = 268 ; 4 toasts + 3 gaps = 264, le 5e (332) déborde
    µ.config.notifyMax = false
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 4, 'seuls les 4 qui tiennent sont affichés')
    assert.deepEqual(messages(document), ['n1', 'n2', 'n3', 'n4'], "les 4 premiers, dans l'ordre")
  })

  it('ZÉRO éviction : le refusé n\'est pas perdu — une place libérée le fait apparaître, en FIFO strict', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 300, toastH: 60 })
    µ.config.notifyMax = false
    for (let i = 1; i <= 6; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 4, 'précondition : 4 affichés, n5 et n6 en file')

    toasts(document)[0].querySelector('.mjs-toast-close').click()
    assert.deepEqual(messages(document), ['n2', 'n3', 'n4', 'n5'], 'n1 fermé, n5 dépilé à sa place')
    toasts(document)[0].querySelector('.mjs-toast-close').click()
    assert.deepEqual(messages(document), ['n3', 'n4', 'n5', 'n6'], 'puis n6 — jamais un autre ordre')
  })

  it('un toast SEUL n\'est JAMAIS refusé, même s\'il dépasse tout seul (écran minuscule)', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 50, toastH: 60 }) // place = 18, un seul toast en fait déjà 60
    µ.config.notifyMax = false
    µ.modal.notify('seul', { duration: 0 })
    assert.equal(toasts(document).length, 1, 'mieux vaut un toast qui dépasse quun écran vide')
    µ.modal.notify('second', { duration: 0 })
    assert.equal(toasts(document).length, 1, 'le second, lui, attend en file')
  })

  it('ancrage BAS : la place se mesure depuis le BAS du conteneur — mesurer du mauvais côté ne laisserait passer quun seul toast', function () {
    const { window, document, µ } = loadModal()
    const box = fakeLayout(window, document, { vh: 300, toastH: 60, bas: 16 }) // seul le bord bas est fixe : le haut remonte à mesure que la pile grandit
    µ.config.notifyMax = false
    µ.config.notifyPosition = 'bottom-right'
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.ok(box.className.indexOf('mjs-toasts-bottom-right') !== -1, 'précondition : conteneur bien ancré en bas')
    assert.equal(toasts(document).length, 4, 'même plafond effectif que lancrage haut — 4, et pas 1')
  })

  it('le plafond NUMÉRIQUE reste le plus fort quand il est plus bas que la place disponible', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 900, toastH: 60 }) // place = 868 → 12 toasts tiendraient
    µ.config.notifyMax = 3
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 3, 'notifyMax=3 borne avant la place')
  })

  it('AUCUN moteur de mise en page (hauteur mesurée à 0) : rien n\'est borné, notifyMax redevient seul juge', function () {
    const { document, µ } = loadModal() // happy-dom nu : scrollHeight/getBoundingClientRect à zéro
    µ.config.notifyMax = false
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 8, 'comportement historique strictement inchangé sans mesure fiable')
  })

  it('un toast refusé faute de place ne programme AUCUN timer — il démarre sa durée PLEINE à son affichage réel', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 300, toastH: 60 })
    µ.config.notifyMax = false
    for (let i = 1; i <= 4; i++) { µ.modal.notify('n' + i, { duration: 0 }) }

    const delays: any[] = []
    const orig = window.setTimeout
    window.setTimeout = function (fn: any, ms: any, ...rest: any[]) { delays.push(ms); return orig(fn, ms, ...rest) }
    µ.modal.notify('tardif', { duration: 4242 })
    assert.equal(delays.includes(4242), false, 'refusé faute de place : aucun timer programmé')

    toasts(document)[0].querySelector('.mjs-toast-close').click() // libère une place
    window.setTimeout = orig
    assert.ok(messages(document).includes('tardif'), 'le tardif est apparu')
    assert.ok(delays.includes(4242), 'son timer (durée PLEINE) na été programmé quà son affichage réel')
  })

  // Placement libre `{ top, bottom }` : la boîte a une hauteur imposée par la fenêtre, constante.
  // Mesurer la BOÎTE y serait aveugle (tout passe, la pile sort de l'écran) — c'est le CONTENU
  // qui doit être mesuré.
  it('placement libre top ET bottom : le débordement est vu quand même (la boîte ment, pas le contenu)', function () {
    const { window, document, µ } = loadModal()
    const box = fakeLayout(window, document, { vh: 800, toastH: 60, haut: 700, bas: 50 }) // boîte figée à 50px de haut ; place réelle sous le haut = 800 − 700 − 16 = 84
    µ.config.notifyMax = false
    µ.config.notifyPosition = { top: '700px', bottom: '50px', right: '16px' }
    for (let i = 1; i <= 10; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.ok(box.className.indexOf('mjs-toasts-custom') !== -1, 'précondition : placement libre')
    assert.equal(box.offsetHeight, 50, 'précondition : la boîte garde la MÊME hauteur, 10 toasts ou pas')
    assert.equal(toasts(document).length, 1, 'un seul tient sous les 84px réels — les 9 autres en file')
  })

  it('placement libre top ET bottom, grande boîte : aucune famine — la pile se remplit jusquà la vraie place', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 800, toastH: 60, haut: 30, bas: 5 }) // boîte figée à 765px (> place 754) : mesurer la boîte refuserait TOUT dès le 2e
    µ.config.notifyMax = false
    µ.config.notifyPosition = { top: '30px', bottom: '5px', right: '16px' }
    for (let i = 1; i <= 14; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 11, '11 toasts (740px) tiennent sous 754px, le 12e (808px) non')
  })

  // Le bord contrôlé est CONSTATÉ, pas déduit de l'ancrage. Déduire
  // était faux dès que notifyFlow inverse le flux d'un conteneur à double ancrage — la pile
  // grandissait vers le haut pendant que le calcul surveillait le bas, et rien n'était refusé.
  it('placement libre top ET bottom + flux INVERSÉ : la pile monte, c\'est le HAUT qui est contrôlé', function () {
    const { window, document, µ } = loadModal()
    fakeLayout(window, document, { vh: 800, toastH: 60, haut: 700, bas: 50, remonte: true }) // contenu ancré au bas de la boîte (750), il monte
    µ.config.notifyMax = false
    µ.config.notifyFlow = 'up'
    µ.config.notifyPosition = { top: '700px', bottom: '50px', right: '16px' }
    for (let i = 1; i <= 14; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 10, '10 toasts remontent jusquà 22px du haut ; le 11e passerait sous la marge de 16px')
  })

  // Le conteneur vit dans document.body : une navigation qui remplace le corps de la page peut
  // l'emporter avec ses toasts sans passer par __toastRemove — le compteur dit alors « 4 affichés »
  // sur un conteneur vide. La mesure ne doit pas planter là-dessus.
  it('conteneur vidé par un tiers (navigation) alors que le compteur le croit plein : aucun plantage', function () {
    const { window, document, µ } = loadModal()
    const box = fakeLayout(window, document, { vh: 300, toastH: 60 })
    µ.config.notifyMax = false
    for (let i = 1; i <= 4; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 4, 'précondition : 4 affichés')

    while (box.firstChild) { box.removeChild(box.firstChild) } // le corps de page est remplacé sous les pieds du module
    assert.doesNotThrow(() => { µ.modal.notify('après', { duration: 0 }) }, 'la mesure ne plante pas sur un conteneur vide')
    assert.deepEqual(messages(document), ['après'], 'le toast suivant sort quand même')
  })
})

// Une fenêtre qui s'AGRANDIT libère de la place. Sans réveil, la file n'avance qu'au retrait d'un
// toast — et une pile de permanents (duration:0) la bloquerait pour toujours.
describe('mjs_modal — la file repart quand la fenêtre grandit', function () {
  afterEach(function () { if (restaurer) { restaurer(); restaurer = null } })

  it('agrandir la fenêtre draine la file, sans attendre le moindre retrait', function () {
    const { window, document, µ } = loadModal()
    const geo = { vh: 300, toastH: 60 }
    fakeLayout(window, document, geo)
    µ.config.notifyMax = false
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) } // permanents : aucun ne se retirera jamais tout seul
    assert.equal(toasts(document).length, 4, 'précondition : 4 affichés, 4 en file')

    geo.vh = 900
    window.dispatchEvent(new window.Event('resize'))
    assert.equal(toasts(document).length, 8, 'les 4 en attente sont apparus dès le redimensionnement')
    assert.deepEqual(messages(document), ['n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'n7', 'n8'], 'FIFO préservé')
  })

  it('rétrécir la fenêtre ne CHASSE personne — zéro éviction, même hors écran', function () {
    const { window, document, µ } = loadModal()
    const geo = { vh: 900, toastH: 60 }
    fakeLayout(window, document, geo)
    µ.config.notifyMax = false
    for (let i = 1; i <= 8; i++) { µ.modal.notify('n' + i, { duration: 0 }) }
    assert.equal(toasts(document).length, 8, 'précondition : les 8 tiennent')

    geo.vh = 300
    window.dispatchEvent(new window.Event('resize'))
    assert.equal(toasts(document).length, 8, 'aucun toast affiché n\'est retiré par un rétrécissement')
  })

  it('aucun écouteur de redimensionnement tant que rien n\'a été mis en file', function () {
    const { window, µ } = loadModal()
    const poses: string[] = []
    const orig = window.addEventListener.bind(window)
    window.addEventListener = function (type: string, ...rest: any[]) { poses.push(type); return orig(type, ...rest) }
    µ.modal.notify('seul', { duration: 0 })
    assert.equal(poses.includes('resize'), false, 'un toast affiché directement ne pose aucun écouteur')
    µ.config.notifyMax = 1
    µ.modal.notify('en file', { duration: 0 })
    assert.equal(poses.filter((t) => t === 'resize').length, 1, "l'écouteur est posé à la première mise en file, et UNE seule fois")
    µ.modal.notify('encore', { duration: 0 })
    assert.equal(poses.filter((t) => t === 'resize').length, 1, 'jamais un deuxième écouteur')
  })
})

// µ.config.notifyFlow — l'ORDRE d'empilement, indépendant du sens de croissance (dicté, lui, par
// l'ancrage). Sert surtout au placement libre, qui n'a pas de préréglage pour le décider.
describe('mjs_modal — sens du flux des toasts (µ.config.notifyFlow)', function () {
  function classes(document: any): string[] {
    return Array.from(document.body.querySelector('.mjs-toasts').className.split(' ')).filter((c: any) => c.indexOf('mjs-toasts-') === 0) as string[]
  }

  it("défaut (config non touchée) : AUCUNE classe de flux — le préréglage de position décide seul", function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right'])
  })

  for (const v of ['up', 'down']) {
    it(`notifyFlow = '${v}' : classe mjs-toasts-flow-${v} posée EN PLUS de la position`, function () {
      const { document, µ } = loadModal()
      µ.config.notifyFlow = v
      µ.config.notifyPosition = { bottom: '16px', right: '16px' }
      µ.modal.notify('x')
      assert.deepEqual(classes(document), ['mjs-toasts-custom', 'mjs-toasts-flow-' + v], 'placement libre + flux forcé')
    })
  }

  it("notifyFlow = 'auto' explicite : équivalent à l'absence de réglage, aucune classe de flux", function () {
    const { document, µ } = loadModal()
    µ.config.notifyFlow = 'auto'
    µ.modal.notify('x')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right'])
  })

  it('valeur inconnue : µ.warn appelé, repli auto (aucune classe de flux)', function () {
    const { document, µ } = loadModal()
    const warned: any[] = []
    µ.warn = (...args: any[]) => { warned.push(args) }
    µ.config.notifyFlow = 'diagonal'
    µ.modal.notify('x')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right'])
    assert.equal(warned.length, 1, 'exactement un avertissement par affichage sur une valeur invalide')
  })

  it('relecture À CHAUD : changer notifyFlow entre deux notify() retourne la pile COURANTE', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('un')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right'])
    µ.config.notifyFlow = 'up'
    µ.modal.notify('deux')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right', 'mjs-toasts-flow-up'])
    µ.config.notifyFlow = 'auto'
    µ.modal.notify('trois')
    assert.deepEqual(classes(document), ['mjs-toasts-top-right'], 'la classe de flux disparaît, jamais empilée avec la précédente')
  })

  it('la feuille de style porte bien les deux règles de flux', function () {
    const { µ } = loadModal()
    const css = µ._mjs_modalSheet.cssRules ? Array.from(µ._mjs_modalSheet.cssRules).map((r: any) => r.cssText).join('\n') : ''
    const src = MODAL_SRC
    assert.match(src, /\.mjs-toasts-flow-down\)\{flex-direction:column\}/, 'flux bas = column')
    assert.match(src, /\.mjs-toasts-flow-up\)\{flex-direction:column-reverse\}/, 'flux haut = column-reverse')
    assert.ok(src.indexOf('.mjs-toasts-flow-') > src.indexOf('.mjs-toasts-custom'), 'les règles de flux viennent APRÈS les préréglages : à spécificité nulle, c\'est l\'ordre qui tranche')
    void css
  })
})
