// @confirm forme OBJET { text, ok, cancel } — partie RUNTIME (µ.confirm, mjs_ujs.ts). Le
// compilateur émet du JSON STRICT dans l'attribut mjs-confirm (cf. tests/transpiler-callback-
// confirm.test.ts pour la partie compilation) ; ce fichier couvre la LECTURE : JSON.parse sous try,
// text/ok/cancel posés PAR-DESSUS les défauts existants (confirmButtonText/cancelButtonText),
// repli texte brut si le JSON est cassé, repli window.confirm qui utilise `.text`. La forme
// chaîne (comportement historique) reste inchangée — non re-testée en détail ici (déjà couverte
// par tests/ujs-confirm-config.test.ts), sauf UNE régression ciblée sur la forme de l'objet passé
// à µ.modal.fire (pas de confirmButtonText/cancelButtonText ajoutés à tort).
//
// Même motif d'isolation/duplication que ujs-confirm-config.test.ts (extraction du bloc COMPLET
// `var _confirmCfgWarned = false; µ.confirm = function(message, el) {...}`, `new Function`,
// jamais d'exécution réelle du module) — µ.confirm s'appelle ici DIRECTEMENT (message, el),
// sans passer par les gates clic/submit (déjà couvertes ailleurs, hors périmètre de ce fichier).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// bloc COMPLET du routeur par défaut : `_confirmCfgWarned` vit dans la fermeture de µ.confirm —
// l'extraire sans sa déclaration laisserait une ReferenceError à l'exécution.
function extractConfirmDefaultBlock(): string {
  return extractMarked(UJS_SRC, 'confirm-default')
}
function installConfirmDefault(µ: any, win: any) {
  new Function('µ', 'window', extractConfirmDefaultBlock())(µ, win)
}

describe('mjs_ujs — @confirm forme objet (runtime, µ.confirm)', function () {
  it("(1) JSON valide {text,ok,cancel} : µ.modal.fire reçoit text/confirmButtonText/cancelButtonText dérivés de l'objet", function () {
    const fireCalls: any[] = []
    const win: any = { confirm: () => { throw new Error('ne doit pas être appelé : µ.modal présent') } }
    const modal = { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true }) } }
    const µ: any = { config: { confirm: true }, modal, warn() {} }
    installConfirmDefault(µ, win)

    µ.confirm(JSON.stringify({ text: 'Vraiment supprimer ?', ok: 'Supprimer', cancel: 'Annuler' }), null)

    assert.equal(fireCalls.length, 1)
    assert.deepEqual(fireCalls[0], { text: 'Vraiment supprimer ?', icon: 'question', showCancelButton: true, confirmButtonText: 'Supprimer', cancelButtonText: 'Annuler' })
  })

  it('(2) JSON valide avec SEULEMENT `text` (ok/cancel absents) : aucune clé confirmButtonText/cancelButtonText ajoutée', function () {
    const fireCalls: any[] = []
    const win: any = { confirm: () => true }
    const modal = { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true }) } }
    const µ: any = { config: { confirm: true }, modal, warn() {} }
    installConfirmDefault(µ, win)

    µ.confirm(JSON.stringify({ text: 'Continuer ?' }), null)

    assert.deepEqual(fireCalls[0], { text: 'Continuer ?', icon: 'question', showCancelButton: true }, 'défauts existants seuls, comme la forme chaîne')
  })

  it('(3) régression forme CHAÎNE (inchangée) : µ.modal.fire reçoit EXACTEMENT {text, icon, showCancelButton}', function () {
    const fireCalls: any[] = []
    const win: any = { confirm: () => true }
    const modal = { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true }) } }
    const µ: any = { config: { confirm: true }, modal, warn() {} }
    installConfirmDefault(µ, win)

    µ.confirm('Supprimer ?', null)

    assert.deepEqual(fireCalls[0], { text: 'Supprimer ?', icon: 'question', showCancelButton: true })
  })

  it('(4) JSON CASSÉ (commence par { mais invalide) : repli texte brut, aucun crash', function () {
    const fireCalls: any[] = []
    const win: any = { confirm: () => true }
    const modal = { fire: (opts: any) => { fireCalls.push(opts); return Promise.resolve({ isConfirmed: true }) } }
    const µ: any = { config: { confirm: true }, modal, warn() {} }
    installConfirmDefault(µ, win)

    assert.doesNotThrow(() => µ.confirm('{not valid json', null))
    assert.deepEqual(fireCalls[0], { text: '{not valid json', icon: 'question', showCancelButton: true })
  })

  it("(5) repli window.confirm (module modal absent) : reçoit LE TEXTE PARSÉ (.text), pas le JSON brut", function () {
    const confirmCalls: string[] = []
    const win: any = { confirm: (msg: string) => { confirmCalls.push(msg); return true } }
    const µ: any = { config: { confirm: true }, warn() {} } // pas de µ.modal
    installConfirmDefault(µ, win)

    const r = µ.confirm(JSON.stringify({ text: 'Vraiment ?', ok: 'Oui' }), null)

    assert.deepEqual(confirmCalls, ['Vraiment ?'])
    assert.equal(r, true)
  })

  it("(6) µ.confirm réassigné directement par l'application : reçoit la valeur BRUTE (JSON non parsé)", function () {
    const received: any[] = []
    const win: any = { confirm: () => { throw new Error('ne doit pas être appelé') } }
    const µ: any = { config: { confirm: true }, warn() {} }
    installConfirmDefault(µ, win) // pose d'abord le routeur par défaut…
    const raw = JSON.stringify({ text: 'x', ok: 'y' })
    µ.confirm = function (message: string, _el: any) { received.push(message); return true } // …puis réassignation

    µ.confirm(raw, null)

    assert.deepEqual(received, [raw], 'la réassignation directe court-circuite le parsing : elle voit le JSON BRUT')
  })
})
