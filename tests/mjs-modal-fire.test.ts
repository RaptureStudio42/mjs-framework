// Tests neufs — µ.modal.fire(options) (mjs_modal.ts), modale maison inspirée de SweetAlert2.
// Ce fichier couvre le RENDU de base
// (title/text/html, icônes, boutons confirm/deny/cancel, customClass) et la forme du résultat
// pour chaque bouton — les fichiers voisins couvrent la fermeture (escape/backdrop/timer,
// mjs-modal-dismiss.test.ts), les inputs+validation (mjs-modal-input.test.ts) et le focus trap +
// retour de focus (mjs-modal-focus.test.ts).
//
// Méthode : contrairement aux tests ujs-confirm-*.test.ts (extraction regex du texte source,
// isolation de mjs_ujs.ts qui attache des listeners PERMANENTS à document/window dès l'import),
// mjs_modal.ts n'attache RIEN de permanent au chargement (juste la feuille adoptée µ._mjs_modalSheet,
// posée UNE fois) — on peut donc charger le VRAI fichier tel quel dans un happy-dom Window frais
// par test (`new Window()` isole complètement le `document`/adoptedStyleSheets d'un test à
// l'autre). mjs_init.ts est chargé AVANT (fournit µ.warn/µ.error/µ.config, jamais consommé
// autrement ici) — même patron d'assemblage que le bundler réel (mjs_init.ts précède
// mjs_modal.ts dans CANONICAL, bundler/index.ts).

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { assertAbsent } from './helpers/dom-assert.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stripEsm(s: string): string {
  return s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
}

const INIT_SRC = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}

describe('mjs_modal — µ.modal.fire : rendu de base (title/text/html/icônes/boutons)', function () {
  it('feuille adoptée µ._mjs_modalSheet posée UNE fois au chargement, classes mjs-modal-* dedans', function () {
    const { document, µ } = loadModal()
    assert.ok(µ._mjs_modalSheet, 'µ._mjs_modalSheet doit exister')
    assert.ok(document.adoptedStyleSheets.includes(µ._mjs_modalSheet), 'adoptée sur le document')
    const rules = Array.from(µ._mjs_modalSheet.cssRules).map((r: any) => r.selectorText || r.cssText)
    assert.ok(rules.some((r: any) => String(r).includes('mjs-modal-backdrop')), 'la feuille contient bien .mjs-modal-backdrop')
  })

  // Verrou anti-régression (replis bg/fg passés aux variables de thème) : la
  // feuille se teinte par variables CSS, jamais plus une seule couleur en dur hors repli de
  // var(--mjs-modal-…)/var(--mjs-…) — sinon une appli en thème sombre rouvrirait une modale
  // blanche. Vérifié sur le texte SOURCE (l'argument de replaceSync), pas sur
  // `µ._mjs_modalSheet.cssRules` : happy-dom réécrit sa CSSOM et y perd silencieusement `var()`
  // sur `color`/`background`/`border-radius` (vérifié empiriquement — seul `box-shadow` survit),
  // un comportement qui n'existe PAS dans un vrai navigateur (le mécanisme réel, lui, est
  // couvert par tests/mjs-modal-fire.test.ts en rendu, vérifié aussi au navigateur).
  // `sansRepliVar` retire chaque `var(--mjs-…, repli)` (replis AVEC parenthèse imbriquée
  // compris, ex. rgba(0,0,0,.55) OU un var(--mjs-…) de thème sans repli propre) : ce qui reste ne
  // doit plus contenir aucune couleur.
  it('feuille source — plus aucune couleur en dur hors repli de var(), replis exacts vérifiés (dont les variables de thème)', function () {
    const m = MODAL_SRC.match(/µ\._mjs_modalSheet\.replaceSync\(`([\s\S]*?)`\);/)
    assert.ok(m, 'le texte source passé à replaceSync doit être repérable')
    const cssText = m![1]
    function sansRepliVar(s: string): string {
      let out = ''
      let i = 0
      while (i < s.length) {
        const m = /^var\(--mjs-[a-z0-9-]+,\s*/i.exec(s.slice(i))
        if (!m) { out += s[i]; i++; continue }
        let j = i + m[0].length
        let depth = 1
        while (j < s.length && depth > 0) {
          if (s[j] === '(') { depth++ }
          else if (s[j] === ')') { depth--; if (depth === 0) { break } }
          j++
        }
        i = j + 1 // saute la parenthèse fermante du var(...) lui-même
      }
      return out
    }
    const reste = sansRepliVar(cssText)
    const couleurs = reste.match(/#[0-9a-fA-F]{3,8}\b|rgba?\([^)]*\)/g)
    assert.equal(couleurs, null, `couleur en dur restée hors var() : ${JSON.stringify(couleurs)}`)
    // Modale : bg/fg reposent sur les variables de thème — plus de littéral #fff/#222 en repli.
    assert.match(cssText, /--mjs-modal-bg,\s*var\(--mjs-surface\)/, 'repli --mjs-modal-bg attendu var(--mjs-surface)')
    assert.match(cssText, /--mjs-modal-fg,\s*var\(--mjs-fg\)/, 'repli --mjs-modal-fg attendu var(--mjs-fg)')
    assert.match(cssText, /--mjs-modal-backdrop,\s*rgba\(0,\s*0,\s*0,\s*\.55\)/, 'repli --mjs-modal-backdrop attendu rgba(0,0,0,.55)')
    assert.match(cssText, /--mjs-modal-confirm-bg,\s*#3085d6/, 'repli --mjs-modal-confirm-bg attendu #3085d6')
    // Toast : le fond est un DÉGRADÉ, repli de --mjs-toast-bg, bâti sur la variable unique
    // --mjs-toast-color (qui pilote aussi l'icône et la barre de vie) et sur
    // --mjs-toast-bg-base pour son extrémité sombre ; texte, ombre et rayon sur variables dédiées.
    // Aucune bordure : l'accent de type passe entièrement par le dégradé et la barre.
    assert.match(cssText, /--mjs-toast-bg,\s*linear-gradient\(to right,\s*color-mix\(in srgb,\s*var\(--mjs-toast-color\) 80%,\s*transparent\),\s*var\(--mjs-toast-bg-base,\s*#22242F\) 25%\)/, 'repli --mjs-toast-bg attendu : dégradé bâti sur --mjs-toast-color et --mjs-toast-bg-base')
    assert.match(cssText, /--mjs-toast-color:var\(--mjs-toast-border,\s*var\(--mjs-modal-border,\s*var\(--mjs-border\)\)\)/, 'repli neutre --mjs-toast-color attendu var(--mjs-toast-border, var(--mjs-modal-border, var(--mjs-border)))')
    assert.doesNotMatch(cssText, /:where\(\.mjs-toast\)\{[^}]*[;{]border:/, 'le toast ne pose plus de bordure — le dégradé et la barre de vie portent seuls la couleur de type')
    assert.match(cssText, /--mjs-toast-fg,\s*#fff/, 'repli --mjs-toast-fg attendu #fff (texte clair sur le dégradé sombre)')
    assert.match(cssText, /--mjs-toast-shadow,\s*0 10px 30px -8px var\(--mjs-shadow\),\s*0 2px 8px -4px var\(--mjs-shadow\)/, "repli du box-shadow du toast attendu '0 10px 30px -8px var(--mjs-shadow), 0 2px 8px -4px var(--mjs-shadow)'")
    assert.match(cssText, /border-radius:var\(--mjs-toast-radius,\s*5px\)/, 'repli du rayon du toast attendu 5px')
  })

  // Verrou — le test générique ci-dessus accepte toute couleur POURVU qu'elle soit imbriquée
  // dans un var(--mjs-…, …), même un #444/#fdecea en dur planqué dedans (c'était exactement le bug
  // mesuré Chromium/thème sombre : boîte+toasts déjà aux variables de thème, mais .mjs-modal-content/
  // .mjs-modal-validation-message/.mjs-modal-cancel/.mjs-modal-input/.mjs-modal-spinner gardaient
  // un repli clair en dur, illisible sur fond sombre). Liste EXPLICITE des sélecteurs contrôlés,
  // chacun ancré sur une variable de thème RÉELLE (--mjs-fg/--mjs-fg-muted/--mjs-surface/--mjs-hover/
  // --mjs-border, cf. µ._mjs_themeSheet, mjs_init.ts) plutôt qu'un simple var() quelconque : une
  // régression future sur l'un d'eux rougit CE test nommément, sélecteur par sélecteur.
  it('éléments internes — replis de couleur ancrés sur une variable de thème (--mjs-fg/--mjs-fg-muted/--mjs-surface/--mjs-hover/--mjs-border), pas une couleur en dur nue', function () {
    const m = MODAL_SRC.match(/µ\._mjs_modalSheet\.replaceSync\(`([\s\S]*?)`\);/)
    assert.ok(m, 'le texte source passé à replaceSync doit être repérable')
    const cssText = m![1]
    function ruleBody(selector: string): string {
      const re = new RegExp(':where\\(' + selector.replace(/\./g, '\\.') + '\\)\\{([^}]*)\\}')
      const rm = cssText.match(re)
      assert.ok(rm, `règle ${selector} introuvable dans la feuille`)
      return rm![1]
    }
    const attendus: Array<[string, string, RegExp]> = [
      ['.mjs-modal-content', 'color', /color:var\(--mjs-modal-muted,\s*var\(--mjs-fg-muted,\s*#444\)\)/],
      ['.mjs-modal-input', 'background-color', /background-color:var\(--mjs-modal-input-bg,\s*var\(--mjs-surface,\s*transparent\)\)/],
      ['.mjs-modal-input', 'color', /color:var\(--mjs-modal-input-fg,\s*var\(--mjs-fg,\s*inherit\)\)/],
      ['.mjs-modal-input', 'border', /border:1px solid var\(--mjs-modal-border,\s*var\(--mjs-border,\s*#d0d0d0\)\)/],
      ['.mjs-modal-validation-message', 'background', /background:var\(--mjs-modal-error-bg,\s*color-mix\(in srgb,\s*var\(--mjs-modal-icon-error,\s*#d64545\)\s*14%,\s*transparent\)\)/],
      ['.mjs-modal-validation-message', 'color', /color:var\(--mjs-modal-error-fg,\s*var\(--mjs-modal-icon-error,\s*#d64545\)\)/],
      ['.mjs-modal-cancel', 'background', /background:var\(--mjs-modal-cancel-bg,\s*var\(--mjs-hover,\s*#e8e8e8\)\)/],
      ['.mjs-modal-cancel', 'color', /color:var\(--mjs-modal-cancel-fg,\s*var\(--mjs-fg,\s*#333\)\)/],
      ['.mjs-modal-spinner', 'border', /border:4px solid var\(--mjs-modal-spinner-track,\s*var\(--mjs-border,\s*#e0e0e0\)\)/],
    ]
    for (const [selector, prop, re] of attendus) {
      const body = ruleBody(selector)
      assert.match(body, re, `${selector} → ${prop} doit replier sur une variable de thème (trouvé : ${body})`)
    }
    // croix de fermeture des toasts : hérite la couleur du toast déjà thémé (--mjs-toast-fg…),
    // jamais une couleur propre en dur — reste lisible dans les deux thèmes.
    assert.match(ruleBody('.mjs-toast-close'), /color:inherit/, '.mjs-toast-close doit hériter la couleur du toast (thémée), pas de couleur propre')
  })

  it('fire({}) sans aucune option : boîte + backdrop insérés dans document.body, bouton confirm SEUL présent (libellé fr par défaut)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({})
    const b = box(document)
    assert.ok(b, 'la boîte doit être insérée synchroniquement')
    assert.ok(document.body.querySelector('.mjs-modal-backdrop'), 'le backdrop doit être inséré')
    assert.equal(b.querySelectorAll('.mjs-modal-btn').length, 1, 'aucune option showDenyButton/showCancelButton : un seul bouton')
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'OK', 'libellé fr par défaut (pas de µ._runtimeLabels posé = repli statique)')
  })

  it('title (texte, jamais interprété comme HTML)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ title: '<b>Titre</b>' })
    const t = box(document).querySelector('.mjs-modal-title')
    assert.equal(t.textContent, '<b>Titre</b>')
    assertAbsent(t.querySelector('b'), 'title passe par textContent : jamais interprété comme HTML')
  })

  it('text (texte brut, jamais interprété)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ text: '<i>contenu</i>' })
    const c = box(document).querySelector('.mjs-modal-content')
    assert.equal(c.textContent, '<i>contenu</i>')
    assertAbsent(c.querySelector('i'), 'text passe par textContent')
  })

  it('html (contenu de confiance, interprété — contrat explicite comme @html côté template)', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ html: '<i>contenu</i>' })
    const c = box(document).querySelector('.mjs-modal-content')
    assert.ok(c.querySelector('i'), 'html doit être interprété (innerHTML)')
    assert.equal(c.querySelector('i').textContent, 'contenu')
  })

  it('ni title, ni text, ni html : aucun .mjs-modal-title/.mjs-modal-content, pas de crash', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ showCancelButton: true })
    const b = box(document)
    assertAbsent(b.querySelector('.mjs-modal-title'))
    assertAbsent(b.querySelector('.mjs-modal-content'))
    assert.equal(b.querySelectorAll('.mjs-modal-btn').length, 2, 'confirm + cancel malgré tout')
  })

  for (const icon of ['success', 'error', 'warning', 'info', 'question']) {
    it(`icon:'${icon}' — classe mjs-modal-icon-${icon} posée, SVG inline présent, aria-hidden`, function () {
      const { document, µ } = loadModal()
      µ.modal.fire({ icon })
      const iconEl = box(document).querySelector('.mjs-modal-icon')
      assert.ok(iconEl, 'div icône doit exister')
      assert.ok(iconEl.classList.contains('mjs-modal-icon-' + icon))
      assert.ok(iconEl.querySelector('svg'), 'SVG inline, pas une balise <img> externe')
      assertAbsent(iconEl.querySelector('img'), 'jamais une image externe')
      assert.equal(iconEl.getAttribute('aria-hidden'), 'true')
    })
  }

  it("icon inconnue/absente : aucun .mjs-modal-icon, pas de crash (jamais un plantage sur une option mal orthographiée)", function () {
    const { document, µ } = loadModal()
    assert.doesNotThrow(() => { µ.modal.fire({ icon: 'bogus' }) })
    assertAbsent(box(document).querySelector('.mjs-modal-icon'))
  })

  it('showCancelButton/showDenyButton contrôlent la présence des boutons ; confirm toujours présent, ordre confirm→deny→cancel', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ showCancelButton: true, showDenyButton: true })
    const btns = Array.from(box(document).querySelectorAll('.mjs-modal-actions .mjs-modal-btn')) as any[]
    assert.equal(btns.length, 3)
    assert.ok(btns[0].classList.contains('mjs-modal-confirm'))
    assert.ok(btns[1].classList.contains('mjs-modal-deny'))
    assert.ok(btns[2].classList.contains('mjs-modal-cancel'))
  })

  it('confirmButtonText/cancelButtonText/denyButtonText overrident les libellés par défaut', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({ showCancelButton: true, showDenyButton: true, confirmButtonText: 'Go', cancelButtonText: 'Nope', denyButtonText: 'Jamais' })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'Go')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Nope')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'Jamais')
  })

  it('customClass {backdrop, box, icon, title, htmlContainer, actions, confirmButton, denyButton, cancelButton} — classes AJOUTÉES (pas remplacées), zéro style inline', function () {
    const { document, µ } = loadModal()
    µ.modal.fire({
      title: 'T', text: 'X', icon: 'info', showCancelButton: true, showDenyButton: true,
      customClass: {
        backdrop: 'app-backdrop', box: 'app-box', icon: 'app-icon', title: 'app-title',
        htmlContainer: 'app-content', actions: 'app-actions',
        confirmButton: 'app-confirm', denyButton: 'app-deny', cancelButton: 'app-cancel',
      },
    })
    const backdropEl = document.body.querySelector('.mjs-modal-backdrop')
    const b = box(document)
    assert.ok(backdropEl.classList.contains('mjs-modal-backdrop') && backdropEl.classList.contains('app-backdrop'), 'classe AJOUTÉE, pas remplacée')
    assert.ok(b.classList.contains('mjs-modal-box') && b.classList.contains('app-box'))
    assert.ok(b.querySelector('.mjs-modal-icon').classList.contains('app-icon'))
    assert.ok(b.querySelector('.mjs-modal-title').classList.contains('app-title'))
    assert.ok(b.querySelector('.mjs-modal-content').classList.contains('app-content'))
    assert.ok(b.querySelector('.mjs-modal-actions').classList.contains('app-actions'))
    assert.ok(b.querySelector('.mjs-modal-confirm').classList.contains('app-confirm'))
    assert.ok(b.querySelector('.mjs-modal-deny').classList.contains('app-deny'))
    assert.ok(b.querySelector('.mjs-modal-cancel').classList.contains('app-cancel'))
    // zéro style inline sur le DOM (règle nº1 MJS) : aucun élément généré par fire() ne porte
    // l'attribut `style`.
    const all = [backdropEl, ...Array.from(b.querySelectorAll('*'))]
    for (const el of all) { assert.equal(el.hasAttribute('style'), false, `${el.tagName} ne doit porter aucun style inline`) }
  })

  // NB : `r` est un objet créé DANS LE RÉALM happy-dom (via window.eval) — son prototype diffère
  // de celui du réalm Node de ce fichier de test. `assert.deepEqual`/`deepStrictEqual` compare
  // aussi les prototypes en mode strict et lève "same structure but are not reference-equal" sur
  // un objet par ailleurs identique champ à champ — on compare donc champ par champ plutôt qu'un
  // objet entier (robuste, indépendant du réalm, et le détail du diagnostic est même meilleur).
  it('résultat CONFIRM : {isConfirmed:true, isDenied:false, isDismissed:false, value:undefined, dismiss:undefined} (aucun input)', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    box(document).querySelector('.mjs-modal-confirm').click()
    const r = await p
    assert.equal(r.isConfirmed, true)
    assert.equal(r.isDenied, false)
    assert.equal(r.isDismissed, false)
    assert.equal(r.value, undefined)
    assert.equal(r.dismiss, undefined)
  })

  it('résultat DENY : {isConfirmed:false, isDenied:true, isDismissed:false, value:undefined, dismiss:undefined}', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', showDenyButton: true })
    box(document).querySelector('.mjs-modal-deny').click()
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDenied, true)
    assert.equal(r.isDismissed, false)
    assert.equal(r.value, undefined)
    assert.equal(r.dismiss, undefined)
  })

  it("résultat CANCEL : {isConfirmed:false, isDenied:false, isDismissed:true, value:undefined, dismiss:'cancel'}", async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x', showCancelButton: true })
    box(document).querySelector('.mjs-modal-cancel').click()
    const r = await p
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDenied, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.value, undefined)
    assert.equal(r.dismiss, 'cancel')
  })

  it('confirm/deny/cancel retirent la boîte ET le backdrop du DOM après résolution', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    assert.ok(box(document), 'présent avant clic')
    box(document).querySelector('.mjs-modal-confirm').click()
    await p
    assert.equal(box(document), null, 'la boîte doit disparaître')
    assertAbsent(document.body.querySelector('.mjs-modal-backdrop'), 'le backdrop doit disparaître')
  })

  it('jamais de rejet — même un scénario de fermeture improbable résout toujours la promesse', async function () {
    const { document, µ } = loadModal()
    const p = µ.modal.fire({ text: 'x' })
    box(document).querySelector('.mjs-modal-confirm').click()
    await assert.doesNotReject(p)
  })
})

describe('mjs_modal — libellés par défaut fr/en (µ._runtimeLabels, forme { fr: …, en: … }) + repli si absent', function () {
  it('µ._runtimeLabels absent (usage standalone hors bundler complet) : repli statique fr codé en dur, jamais un crash', function () {
    const { document, µ } = loadModal()
    assert.equal(µ._runtimeLabels, undefined, "précondition : rien posé par ce harnais (pas de manifest)")
    assert.doesNotThrow(() => { µ.modal.fire({ showCancelButton: true, showDenyButton: true }) })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'OK')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Annuler')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'Non')
  })

  it("µ._runtimeLabels = manifest fr (structure RUNTIME_LABELS.fr réelle) : OK/Annuler/Non", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' } } }
    µ.modal.fire({ showCancelButton: true, showDenyButton: true })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'OK')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Annuler')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'Non')
  })

  it("µ._runtimeLabels = manifest fr+en (structure RUNTIME_LABELS réelle), langue AFFICHÉE 'en' : OK/Cancel/No", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' } }, en: { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' } } }
    document.documentElement.lang = 'en'
    µ.modal.fire({ showCancelButton: true, showDenyButton: true })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'OK')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Cancel')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'No')
  })

  it('options.confirmButtonText/cancelButtonText/denyButtonText priment TOUJOURS sur µ._runtimeLabels', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { en: { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' } } }
    µ.modal.fire({ showCancelButton: true, showDenyButton: true, confirmButtonText: 'Go', cancelButtonText: 'Nope', denyButtonText: 'Jamais' })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'Go')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Nope')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'Jamais')
  })

  it('µ._runtimeLabels présent mais PARTIEL (une clé manquante) : repli PAR CLÉ sur le statique fr', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { modal: { ok: 'OK' } } } // cancel/deny manquants (vieux manifest hypothétique)
    µ.modal.fire({ showCancelButton: true, showDenyButton: true })
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-confirm').textContent, 'OK')
    assert.equal(b.querySelector('.mjs-modal-cancel').textContent, 'Annuler', 'repli fr pour la clé manquante')
    assert.equal(b.querySelector('.mjs-modal-deny').textContent, 'Non', 'repli fr pour la clé manquante')
  })
})
