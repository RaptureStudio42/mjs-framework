// Régression du correctif method="dialog" (tests/ujs-form-method-dialog.test.ts) — ce correctif traite `_method`
// (champ caché), `formmethod` et `method` de façon UNIFORME : dès que la méthode résolue vaut
// DIALOG, sortie sans `preventDefault`. Correct pour `method`/`formmethod` (attributs HTML réels :
// le navigateur ferme le `<dialog>` nativement). FAUX pour un champ caché `_method=dialog` dans un
// `<form method="post" action="/posts">` : `_method` n'est PAS un attribut HTML connu du navigateur,
// donc laisser filer soumet le formulaire avec SON vrai `method="post"` réel — navigation réseau
// réelle et SILENCIEUSE vers l'action, `<dialog>` jamais fermé, aucune erreur.
//
// Correctif : le défaut natif DIALOG ne vaut que si la méthode vient d'un ATTRIBUT HTML
// (`formmethod` du soumissionnaire, sinon `method` du `<form>`) ; un `_method=dialog` est refusé
// explicitement (`µ.error`), comme avant (avant : `preventDefault` inconditionnel + refus par
// `_mjs_navDispatch`).
//
// Méthode : DOM RÉEL (happy-dom) — vrai `<dialog>`, vrai `<form>`, vrai listener
// `document.addEventListener('submit', …)`, vrai `btn.click()`, jamais un
// événement factice : c'est précisément l'angle mort qui a laissé passer la régression (l'ancien test
// n'observait que `defaultPrevented` sur un event synthétique, sans modèle de l'action par
// défaut réelle du navigateur).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ────────────────────────────────────────────────────────────────────────────
// HARNAIS — DOM réel happy-dom, code source EXTRAIT tel quel (mêmes marqueurs
// que la suite officielle), listener document-level réel, événements réels.
// ────────────────────────────────────────────────────────────────────────────
function makeHarness(bodyHTML: string) {
  const window: any = new Window({ url: 'http://x/whatever' })
  const document: any = window.document
  document.body.innerHTML = bodyHTML

  const errors: any[] = []
  const dispatchCalls: any[] = []
  const ajaxRequests: any[] = []
  const µ: any = {
    warn() {},
    error(...a: any[]) { errors.push(a) },
    log() {},
    realTarget: (e: any) => (typeof e.composedPath === 'function' ? e.composedPath()[0] : e.target),
  }
  µ._mjs_ajaxRequest = (o: any) => { ajaxRequests.push(o) }

  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, document, window)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractMarked(UJS_SRC, '_mjs_navDispatch'))(µ, window, document, window.FormData, window.URL, window.DOMParser)
  const realNavDispatch = µ._mjs_navDispatch
  µ._mjs_navDispatch = function (...a: any[]) { dispatchCalls.push(a); return realNavDispatch.apply(µ, a) }
  new Function('µ', extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire'))(µ)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractMarked(UJS_SRC, '_mjs_ujsOnSubmit'))(µ, window, document, window.FormData, window.URL, window.DOMParser)
  document.addEventListener('submit', µ._mjs_ujsOnSubmit)

  return { window, document, µ, errors, dispatchCalls, ajaxRequests }
}

describe('`_method=dialog` (champ) N\'EST PAS un attribut HTML method/formmethod', function () {
  it('`_method=dialog` dans <form method="post" action="/posts"> sous <dialog> ouvert : navigation native BLOQUÉE, dialog reste ouvert, refus explicite (1 µ.error)', function () {
    const h = makeHarness('<dialog id="dlg"><form id="f" method="post" action="/posts"><input type="hidden" name="_method" value="dialog"><button id="btn" type="submit">OK</button></form></dialog>')
    const dlg = h.document.getElementById('dlg')
    const btn = h.document.getElementById('btn')
    dlg.showModal()
    const before = h.window.location.href
    btn.click()
    assert.equal(h.window.location.href, before, 'aucune navigation native vers /posts (method réel du <form>)')
    assert.equal(dlg.open, true, 'le dialog reste ouvert : _method=dialog n\'est pas un défaut natif du navigateur')
    assert.equal(h.dispatchCalls.length, 0, '_method=dialog refusé, jamais envoyé comme un verbe HTTP')
    assert.equal(h.ajaxRequests.length, 0)
    assert.equal(h.errors.length, 1, 'refus explicite loggé une fois (µ.error)')
  })

  it('<form method="dialog"> (attribut HTML, sans `_method`) : fermeture NATIVE, non-régression', function () {
    const h = makeHarness('<dialog id="dlg"><form id="f" method="dialog"><button id="btn" type="submit">OK</button></form></dialog>')
    const dlg = h.document.getElementById('dlg')
    const btn = h.document.getElementById('btn')
    dlg.showModal()
    btn.click()
    assert.equal(dlg.open, false, 'fermeture native laissée au navigateur (comportement intact)')
    assert.equal(h.dispatchCalls.length, 0)
    assert.equal(h.errors.length, 0)
  })

  it('`formmethod="dialog"` sur un bouton EXTÉRIEUR au form (form="f") : fermeture native', function () {
    const h = makeHarness('<dialog id="dlg"><form id="f" method="post" action="/posts"></form><button id="btn" form="f" formmethod="dialog" type="submit">OK</button></dialog>')
    const dlg = h.document.getElementById('dlg')
    const btn = h.document.getElementById('btn')
    dlg.showModal()
    assert.equal(btn.form && btn.form.id, 'f', 'précondition : happy-dom associe form="id" correctement')
    btn.click()
    assert.equal(dlg.open, false, 'fermeture native : formmethod=dialog du bouton externe respecté')
    assert.equal(h.dispatchCalls.length, 0)
    assert.equal(h.errors.length, 0)
  })

  it('non-régression : `_method=PUT` + `formmethod=dialog` sur le bouton : `_method` gagne, PUT intercepté (ordre INCHANGÉ)', function () {
    const h = makeHarness('<form id="f" method="post" action="/posts/42"><input type="hidden" name="_method" value="PUT"><button id="btn" type="submit" formmethod="dialog">OK</button></form>')
    const btn = h.document.getElementById('btn')
    btn.click()
    assert.equal(h.dispatchCalls.length, 1, 'la soumission doit partir : _method gagne sur formmethod')
    assert.equal(h.dispatchCalls[0][1], 'PUT', 'verbe résolu = PUT, pas DIALOG')
    assert.equal(h.errors.length, 0)
  })
})
