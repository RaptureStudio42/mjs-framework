// un toast (µmodal.notify) joue la
// signature sonore de SON TYPE, comme une modale joue celle de son icône (succès deux notes,
// avertissement deux bips, info une note, erreur la scie). Avant ce correctif, mjs_modal.ts
// l.697 envoyait `rec.type === 'error' ? 'error' : 'notify'` à __modalSound — TOUT type autre
// qu'error retombait sur le ping générique 'notify' (880 Hz, 1 oscillateur), alors que
// success/warning/info ont pourtant leur PROPRE signature (__modalPlaySignature, l.~420). Même
// harnais que tests/modal-sound-true-par-appel.test.ts (window.eval de mjs_init.ts +
// mjs_modal.ts sur happy-dom), stub AudioContext étendu pour relever fréquence ET forme de
// chaque oscillateur (pas seulement leur nombre) — seule façon de distinguer la signature
// 'info' (660, sine) du ping générique 'notify' (880, sine), tous deux à 1 oscillateur.
//
// LIMITE CONSTATÉE (empirique) : le cas « toast SANS
// type → ping notify » n'a PAS de test ici — notify() (mjs_modal.ts
// l.1073, `type = __TOAST_TYPES[opts.type] ? opts.type : 'info'`) normalise déjà tout type
// absent/inconnu en 'info' AVANT que `rec` n'atteigne __toastDisplay/l.697, et un seul point de
// création de `rec` existe (l.1081) : rec.type est TOUJOURS l'une des 4 valeurs canoniques,
// jamais autre chose. Un appel `notify('x')` sans opts n'est donc pas distinguable d'un appel
// `notify('x', {type:'info'})` à ce point du code — les deux jouent la MÊME signature. Le repli
// « sinon notify » du correctif (l.697) reste du code défensif jamais exercé par l'API publique
// aujourd'hui. Volontairement non testé plutôt qu'une assertion inventée pour le maquiller en vert.

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

const INIT_SRC  = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const PAGE_CACHE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_page_cache.ts'), 'utf-8')
const MODAL_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_modal.ts'), 'utf-8')

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

// stub AudioContext qui relève AUSSI fréquence + forme de chaque oscillateur (copie étendue du
// patron de modal-sound-true-par-appel.test.ts/mjs-modal-sound.test.ts, qui ne comptaient que leur nombre).
function stubAudioContext(window: any): { oscillators: { freq: number; forme: string }[] } {
  const oscillators: { freq: number; forme: string }[] = []
  function FakeCtx(this: any) { this.currentTime = 0; this.destination = {} }
  FakeCtx.prototype.createOscillator = function () {
    const osc = { type: '', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} }
    oscillators.push({ get freq() { return osc.frequency.value }, get forme() { return osc.type } } as any)
    return osc
  }
  FakeCtx.prototype.createGain = function () {
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
  window.AudioContext = FakeCtx
  return { oscillators }
}

describe('mjs_modal — toast : signature sonore PAR TYPE', function () {
  it("type 'success' — signature success : 2 oscillateurs, fréquences 587 puis 880", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'success' })
    assert.equal(oscillators.length, 2, 'success = 2 notes')
    assert.deepEqual(oscillators.map((o) => o.freq), [587, 880])
  })

  it("type 'warning' — signature warning : 2 oscillateurs à 440 en square", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'warning' })
    assert.equal(oscillators.length, 2, 'warning = 2 bips')
    assert.deepEqual(oscillators.map((o) => o.freq), [440, 440])
    assert.ok(oscillators.every((o) => o.forme === 'square'), 'forme square pour warning')
  })

  it("type 'info' — signature info : 1 oscillateur à 660", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'info' })
    assert.equal(oscillators.length, 1, 'info = 1 note')
    assert.equal(oscillators[0].freq, 660)
  })

  it("type 'error' — signature error : 1 oscillateur à 160 en sawtooth (la scie)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'error' })
    assert.equal(oscillators.length, 1, 'error = 1 note')
    assert.equal(oscillators[0].freq, 160)
    assert.equal(oscillators[0].forme, 'sawtooth')
  })

  it('contre-cas — modalSound coupé (défaut) et aucun `sound` par appel : rien ne joue, quel que soit le type', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : gate désactivé par défaut')
    µ.modal.notify('x', { type: 'success' })
    assert.equal(oscillators.length, 0, 'gate coupé = silence, même pour un type qui a sa signature')
  })
})
