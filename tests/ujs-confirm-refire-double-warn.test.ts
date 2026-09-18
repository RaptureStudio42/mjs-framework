// µ._mjs_ujsConfirmRefire avalait en
// silence le 2e échec de son repli ultime (`try { target.requestSubmit(); } catch (e) {}`, ligne
// ~2040) : un catch qui échoue ne doit jamais rendre
// « rien à faire » indiscernable de « rien à protéger ». Le 1er échec est déjà averti (`µ.warn`
// existant, INCHANGÉ) ; le SECOND ne l'était pas — le formulaire restait alors non soumis, sans
// AUCUN signal, ni dans les logs ni dans les tests. Correctif : un second µ.warn, nommant l'erreur
// réelle du repli, dans ce dernier catch.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function installConfirmRefire(µ: any) {
  new Function('µ', extractMarked(UJS_SRC, '_mjs_ujsConfirmRefire'))(µ)
}

describe('mjs_ujs — µ._mjs_ujsConfirmRefire : le repli ultime ne doit jamais avaler une 2e erreur en silence', function () {
  it('requestSubmit() lève DEUX fois de suite : 2 µ.warn distincts, le second nomme l\'erreur du repli', function () {
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')), error: () => {}, log: () => {} }
    installConfirmRefire(µ)

    let calls = 0
    const target: any = {
      requestSubmit: () => { calls++; throw new Error('boom-' + calls) },
    }
    // ni .form ni .matches exploitables, aucun submitter/clickTarget : tombe direct sur le
    // `target.requestSubmit()` nu (comportement d'origine), 1er échec attendu.
    const confirmEl: any = {
      tagName: 'BUTTON',
      getAttribute: () => 'Sûr ?',
      removeAttribute: () => {},
      setAttribute: () => {},
    }

    assert.doesNotThrow(() => µ._mjs_ujsConfirmRefire(confirmEl, target, null, null))

    assert.equal(calls, 2, 'requestSubmit doit avoir été tenté 2 fois (appel initial + repli ultime)')
    assert.equal(warnCalls.length, 2, "AVANT le fix : 1 seul warn — le 2e échec (repli ultime) était avalé par un catch vide")
    assert.match(warnCalls[0], /a échoué après acceptation/, 'le 1er warn (déjà présent) est inchangé')
    assert.match(warnCalls[1], /ÉGALEMENT échoué|non soumis/i, "le 2e warn (nouveau) doit nommer l'échec du repli lui-même")
    assert.match(warnCalls[1], /boom-2/, "le 2e warn doit nommer l'erreur RÉELLE du repli (pas un message générique)")
  })

  it('contre-épreuve : requestSubmit() réussit du premier coup -> aucun warn', function () {
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')), error: () => {}, log: () => {} }
    installConfirmRefire(µ)
    const target: any = { requestSubmit: () => {} }
    const confirmEl: any = { tagName: 'BUTTON', getAttribute: () => null, removeAttribute: () => {}, setAttribute: () => {} }

    µ._mjs_ujsConfirmRefire(confirmEl, target, null, null)

    assert.equal(warnCalls.length, 0)
  })

  it('contre-épreuve : requestSubmit() lève UNE fois puis réussit au repli -> 1 seul warn (le 1er, existant)', function () {
    const warnCalls: string[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a.join(' ')), error: () => {}, log: () => {} }
    installConfirmRefire(µ)
    let calls = 0
    const target: any = { requestSubmit: () => { calls++; if (calls === 1) { throw new Error('premier-echec'); } } }
    const confirmEl: any = { tagName: 'BUTTON', getAttribute: () => null, removeAttribute: () => {}, setAttribute: () => {} }

    µ._mjs_ujsConfirmRefire(confirmEl, target, null, null)

    assert.equal(calls, 2)
    assert.equal(warnCalls.length, 1, 'le repli a réussi : pas de 2e warn')
  })
})
