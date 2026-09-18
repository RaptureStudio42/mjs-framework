// Tests neufs — µ.modal.notify(message, opts) : habillage visuel enrichi (icône par type, titre
// par défaut, structure icône/contenu/croix, barre de vie en haut). Complète
// mjs-modal-notify.test.ts (empilement, fermeture, durée — inchangés) : ce fichier couvre le
// RENDU visuel introduit. Même méthode d'assemblage que les fichiers voisins (cf.
// en-tête de mjs-modal-notify.test.ts) : chargement direct des sources runtime, pas de Bundler.

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

function toast(document: any): any {
  return document.body.querySelector('.mjs-toast')
}

const TITRES_PAR_DEFAUT: Array<[string, string]> = [['success', 'Succès'], ['error', 'Erreur'], ['warning', 'Attention'], ['info', 'Info']]

describe('mjs_modal — µ.modal.notify, habillage visuel enrichi (icônes + titre)', function () {
  it(".mjs-toast-icon présente et contient un <svg> — le SVG de type:'success' diffère de celui de type:'error'", function () {
    const succes = loadModal()
    succes.µ.modal.notify('x', { type: 'success' })
    const iconSuccess = toast(succes.document).querySelector('.mjs-toast-icon')
    assert.ok(iconSuccess, 'une icône (.mjs-toast-icon) doit être présente sur le toast')
    assert.ok(iconSuccess.querySelector('svg'), "l'icône doit contenir un <svg>")

    const erreur = loadModal()
    erreur.µ.modal.notify('x', { type: 'error' })
    const iconError = toast(erreur.document).querySelector('.mjs-toast-icon')
    assert.ok(iconError.querySelector('svg'), "l'icône du type 'error' doit aussi contenir un <svg>")
    assert.notEqual(iconSuccess.innerHTML, iconError.innerHTML, "le SVG du type 'success' doit différer de celui du type 'error'")
  })

  for (const [type, attendu] of TITRES_PAR_DEFAUT) {
    it(`titre par défaut du type '${type}' : « ${attendu} »`, function () {
      const { document, µ } = loadModal()
      µ.modal.notify('x', { type })
      const titleEl = toast(document).querySelector('.mjs-toast-title')
      assert.ok(titleEl, `un titre par défaut doit apparaître pour le type ${type}`)
      assert.equal(titleEl.textContent, attendu, `le titre par défaut du type ${type} doit être « ${attendu} »`)
    })
  }

  it("opts.title: 'Panier' impose le titre, quel que soit le type", function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { type: 'error', title: 'Panier' })
    const titleEl = toast(document).querySelector('.mjs-toast-title')
    assert.ok(titleEl, 'opts.title doit produire un élément .mjs-toast-title')
    assert.equal(titleEl.textContent, 'Panier', "le titre imposé par opts.title doit être repris tel quel, pas le titre par défaut du type")
  })

  it('opts.title: false — aucun .mjs-toast-title, le message reste présent (toast compact, une seule ligne)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('mon message', { title: false })
    const t = toast(document)
    assertAbsent(t.querySelector('.mjs-toast-title'), 'opts.title:false ne doit émettre aucun élément titre')
    assert.equal(t.querySelector('.mjs-toast-message').textContent, 'mon message', 'le message doit rester présent même sans titre')
  })

  it("opts.title reste du TEXTE — une charge active passée en titre n'est jamais interprétée comme HTML", function () {
    const { document, µ } = loadModal()
    const charge = '<img src=x onerror="window.__toastXss = 1">'
    µ.modal.notify('message', { title: charge })
    const titleEl = toast(document).querySelector('.mjs-toast-title')
    assert.equal(titleEl.textContent, charge, 'le titre doit rester le texte littéral, balises comprises')
    assertAbsent(titleEl.querySelector('img'), 'jamais interprété comme HTML — aucun élément <img> créé depuis le titre')
    assert.equal(toast(document).querySelectorAll('img').length, 0, 'aucun <img> nulle part dans le toast')
  })

  it('le message reste en textContent dans .mjs-toast-content .mjs-toast-message (non-régression : une balise passée ne crée aucun élément)', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('<b>x</b>')
    const msgEl = toast(document).querySelector('.mjs-toast-content .mjs-toast-message')
    assert.ok(msgEl, 'le message doit vivre dans .mjs-toast-content .mjs-toast-message')
    assert.equal(msgEl.textContent, '<b>x</b>', 'le message doit rester le texte littéral, balises comprises')
    assertAbsent(msgEl.querySelector('b'), 'jamais interprété comme HTML — aucun élément <b> créé')
  })

  it('ordre des enfants du toast : icône, contenu, croix', function () {
    const { document, µ } = loadModal()
    µ.modal.notify('x', { duration: 0 }) // duration:0 : pas de barre de vie, on isole les 3 enfants attendus
    const classes = Array.from(toast(document).children as any[]).map((el: any) => el.className)
    assert.deepEqual(classes, ['mjs-toast-icon', 'mjs-toast-content', 'mjs-toast-close'], `ordre attendu icône/contenu/croix, obtenu ${JSON.stringify(classes)}`)
  })

  it('µ._runtimeLabels.fr.toast.success prime sur le repli statique (forme { fr: … }, valeur restaurée après le test)', function () {
    const { document, µ } = loadModal()
    const avant = µ._runtimeLabels
    µ._runtimeLabels = { fr: { toast: { success: 'Yes' } } }
    try {
      µ.modal.notify('x', { type: 'success' })
      assert.equal(toast(document).querySelector('.mjs-toast-title').textContent, 'Yes', 'µ._runtimeLabels.fr.toast.success doit primer sur le repli fr codé en dur')
    } finally {
      µ._runtimeLabels = avant
    }
    assert.equal(µ._runtimeLabels, avant, 'µ._runtimeLabels doit être restauré après le test')
  })

  // Le conteneur est cherché depuis <html>, jamais depuis <body> seul : un toast demandé avant que
  // le corps de page existe (script du <head>, non différé) pose sa pile sur <html>, et l'appel
  // suivant doit la RETROUVER là plutôt que d'en créer une seconde.
  it('conteneur posé hors de <body> (sous <html>) : RÉUTILISÉ, jamais doublé', function () {
    const { document, µ } = loadModal()
    const orphelin = document.createElement('div')
    orphelin.className = 'mjs-toasts'
    document.documentElement.appendChild(orphelin)
    µ.modal.notify('x')
    assert.equal(document.documentElement.querySelectorAll('.mjs-toasts').length, 1, 'un seul conteneur .mjs-toasts doit exister')
    assert.equal(orphelin.querySelectorAll('.mjs-toast').length, 1, 'le toast doit atterrir dans le conteneur déjà présent')
  })

  it('la barre de vie (.mjs-toast-barre) est ancrée en HAUT du toast (top:0), pas en bas', function () {
    const { window, document, µ } = loadModal()
    µ.modal.notify('x', { duration: 1000 })
    const barre = toast(document).querySelector('.mjs-toast-barre')
    assert.ok(barre, 'barre de vie attendue (duration > 0)')
    assert.equal(window.getComputedStyle(barre).top, '0px', 'la barre de vie doit être collée au bord HAUT du toast')
  })
})
