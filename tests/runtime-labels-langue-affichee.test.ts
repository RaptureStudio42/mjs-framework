// Les libellés du runtime (src/runtime-labels.ts, µ._runtimeLabels) suivent
// désormais la LANGUE AFFICHÉE, choisie au runtime, jamais figée au build. Avant ce correctif, le
// manifest posait UNE SEULE langue (`µ._runtimeLabels = RUNTIME_LABELS[getMessagesLang()]`, forme
// PLATE `{ modal: …, toast: … }`) : un site basculé en anglais montrait un toast titré « Succès »
// avec un corps anglais. Le manifest émet maintenant TOUTES les
// langues (`{ fr: {…}, en: {…} }` + `µ._runtimeLabelsLang`, langue de repli du build) — le choix
// se fait à l'affichage, par `µ._mjs_label`/`µ._mjs_labelLang` (mjs_page_cache.ts, DÉTACHÉ du cœur).
// Même méthode que mjs-modal-notify.test.ts (harnais direct INIT_SRC + PAGE_CACHE_SRC +
// MODAL_SRC, pas de Bundler) pour les cas modale/toast ; + ROUTER_SRC pour le routeur, table
// RÉELLE de src/runtime-labels.ts.
//
// Deux ajouts : (1) la langue DEMANDÉE au store (`µ._mjs_storeRaw.__mjsLang`)
// prime désormais sur `µ._mjs_i18nEffectiveLang()` (qui reste en retard tant qu'un swap i18n est en
// vol) — un toast tiré dans le même tick qu'un clic « EN » sortait encore en français
// (cas ci-dessous inversé) ; (2) `µ._mjs_i18nLookup` (mjs_i18n.ts, simulé
// ici) permet au dictionnaire du PROJET de surcharger une clé `mjs.<groupe>.<clé>` avant la table
// fr/en du framework — prouvé bout-en-bout (build RÉEL) dans
// tests/runtime-labels-surcharge-projet.test.ts.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { RUNTIME_LABELS } from '../src/runtime-labels.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

function stripEsm(s: string): string {
  return s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
}

const INIT_SRC = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')
const ROUTER_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

function loadRouter(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${ROUTER_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

// titres de TOUS les toasts actuellement affichés, dans l'ordre de création — jamais les nœuds
// eux-mêmes (assertion sur un tableau de chaînes uniquement).
function toastTitles(document: any): string[] {
  return Array.from(document.body.querySelectorAll('.mjs-toast-title')).map((el: any) => el.textContent)
}

describe('mjs_init — µ._mjs_label/µ._mjs_labelLang : la langue AFFICHÉE choisit le libellé', function () {
  it('toast : bascule EN PLEIN VOL (même fenêtre, sans rechargement) — le nouveau toast suit <html lang>, l\'ancien garde le sien', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'en'
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success'])
    document.documentElement.lang = 'fr'
    µ.modal.notify('y', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success', 'Succès'], 'le 1er toast déjà rendu ne bouge pas, le 2e suit la langue courante')
  })

  it("toast : sous-étiquette régionale ignorée — <html lang=\"en-US\"> résout comme 'en'", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'en-US'
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success'])
  })

  it("toast : langue affichée absente de la table ('de') → repli sur µ._runtimeLabelsLang, puis en, puis fr", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'de'
    µ._runtimeLabelsLang = 'fr'
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Succès'], 'µ._runtimeLabelsLang (langue de repli du build) prime sur une langue affichée inconnue')
    delete µ._runtimeLabelsLang
    µ.modal.notify('y', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Succès', 'Success'], 'sans langue de repli du build, repli sur en')
  })

  it('modale : le bouton annuler suit la langue affichée (fr/en)', function () {
    const en = loadModal()
    en.µ._runtimeLabels = { fr: { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' } }, en: { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' } } }
    en.document.documentElement.lang = 'en'
    en.µ.modal.fire({ text: 'x', showCancelButton: true })
    assert.equal(en.document.body.querySelector('.mjs-modal-cancel').textContent, 'Cancel')

    const fr = loadModal()
    fr.µ._runtimeLabels = { fr: { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' } }, en: { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' } } }
    fr.document.documentElement.lang = 'fr'
    fr.µ.modal.fire({ text: 'x', showCancelButton: true })
    assert.equal(fr.document.body.querySelector('.mjs-modal-cancel').textContent, 'Annuler')
  })

  it('priorité : la langue DEMANDÉE au store (µ._mjs_storeRaw.__mjsLang) gagne sur µ._mjs_i18nEffectiveLang', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'fr'
    µ._mjs_i18nEffectiveLang = function() { return 'fr' }
    µ._mjs_storeRaw = { __mjsLang: 'en' }
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success'], "un toast tiré dans le même tick qu'un clic « EN » doit sortir en anglais, même si µ._mjs_i18nEffectiveLang n'a pas fini son swap")
  })

  it("priorité : sans µ._mjs_i18nEffectiveLang, la langue demandée au store (µ._mjs_storeRaw.__mjsLang) gagne sur <html lang>", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'fr'
    µ._mjs_storeRaw = { __mjsLang: 'en' }
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Success'], 'la langue du store prime sur <html lang> quand le module i18n est absent')
  })

  it("surcharge projet : µ._mjs_i18nLookup('mjs.toast.success') prime sur la table fr/en du framework", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    µ._mjs_i18nLookup = function(cle: string) { return ({ 'mjs.toast.success': 'Bravo' } as Record<string, string>)[cle] }
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Bravo'], 'le dictionnaire du projet (clé racine mjs.toast.success) gagne sur la table du framework')
  })

  it('surcharge projet : µ._mjs_i18nLookup rendant undefined pour la clé → repli sur la table du framework', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'fr'
    µ._mjs_i18nLookup = function() { return undefined }
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Succès'], "µ._mjs_i18nLookup sans réponse pour cette clé n'empêche pas le repli sur la table")
  })

  it('surcharge projet : µ._mjs_i18nLookup absent (module i18n non bundlé) → repli sur la table, aucun crash', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { toast: { success: 'Succès' } }, en: { toast: { success: 'Success' } } }
    document.documentElement.lang = 'fr'
    assert.equal(µ._mjs_i18nLookup, undefined, 'précondition : rien posé par ce harnais (module i18n absent du build)')
    assert.doesNotThrow(() => { µ.modal.notify('x', { type: 'success' }) })
    assert.deepEqual(toastTitles(document), ['Succès'])
  })

  it("surcharge projet : modale — µ._mjs_i18nLookup('mjs.modal.cancel') prime sur la table (ex. langue allemande)", function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { fr: { modal: { ok: 'OK', cancel: 'Annuler', deny: 'Non' } }, en: { modal: { ok: 'OK', cancel: 'Cancel', deny: 'No' } } }
    µ._mjs_i18nLookup = function(cle: string) { return ({ 'mjs.modal.cancel': 'Abbrechen' } as Record<string, string>)[cle] }
    µ.modal.fire({ text: 'x', showCancelButton: true })
    assert.equal(document.body.querySelector('.mjs-modal-cancel').textContent, 'Abbrechen')
  })

  it('µ._runtimeLabels absent : repli statique fr, jamais un crash', function () {
    const { document, µ } = loadModal()
    assert.equal(µ._runtimeLabels, undefined, 'précondition : rien posé par ce harnais (pas de manifest)')
    assert.doesNotThrow(() => { µ.modal.notify('x', { type: 'success' }) })
    assert.deepEqual(toastTitles(document), ['Succès'])
  })

  it('ancienne forme PLATE (`{ toast: {…} }`) : PLUS LUE — repli statique fr, comme si µ._runtimeLabels était absent', function () {
    const { document, µ } = loadModal()
    µ._runtimeLabels = { toast: { success: 'Yes' } }
    µ.modal.notify('x', { type: 'success' })
    assert.deepEqual(toastTitles(document), ['Succès'], "l'ancienne forme plate n'est plus consultée, repli sur le statique fr")
  })
})

describe('mjs_router + µ._mjs_label — routeur et clé ujs.sendFailed suivent la langue affichée', function () {
  it("µ.Router._mjs_routerLabel('notFound') suit <html lang>, avec la VRAIE table de src/runtime-labels.ts", function () {
    const { document, µ } = loadRouter()
    µ._runtimeLabels = RUNTIME_LABELS
    document.documentElement.lang = 'en'
    assert.equal(µ.Router._mjs_routerLabel('notFound'), 'Page not found')
    document.documentElement.lang = 'fr'
    assert.equal(µ.Router._mjs_routerLabel('notFound'), 'Page introuvable')
  })

  it("µ._mjs_label('ujs', 'sendFailed') suit <html lang>, avec la VRAIE table de src/runtime-labels.ts", function () {
    const { document, µ } = loadRouter()
    µ._runtimeLabels = RUNTIME_LABELS
    document.documentElement.lang = 'en'
    assert.equal(µ._mjs_label('ujs', 'sendFailed'), 'Sending failed — the server did not respond.')
  })
})
