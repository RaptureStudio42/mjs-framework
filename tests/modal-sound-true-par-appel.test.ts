// Tests neufs — bogue : « je n'entends pas le son sur les notifications » — `µmodal.notify('…', {type:'success',
// sound:true})` ne jouait rien. Cause : `sound` accepte booléen OU chaîne (__modalNormalize,
// mjs_modal.ts) mais `__modalPlayOverride` ne consommait que `false` et les chaînes — `true`
// retombait sur `__modalSound`, qui applique le GATE `µ.config.modalSound` (coupé par défaut) →
// silence. Un `sound:true` PAR APPEL doit contourner ce gate et jouer la signature embarquée du
// type demandé (fichier de `µ.config.modalSound` objet pour ce type s'il existe, sinon signature
// WebAudio), exactement comme `sound:'success'` ou `µ.sound('success')` le font déjà. Même
// harnais que tests/modal-sound-relative-path.test.ts (cf. son en-tête) et
// tests/mjs-modal-sound.test.ts (stub AudioContext, comptage d'oscillateurs).

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

// stub minimal d'AudioContext (copie du patron de mjs-modal-sound.test.ts) — compte les
// oscillateurs créés (1 par note()) : la preuve qu'une signature a bien été JOUÉE.
function stubAudioContext(window: any): { oscillators: any[] } {
  const oscillators: any[] = []
  function FakeCtx(this: any) { this.currentTime = 0; this.destination = {} }
  FakeCtx.prototype.createOscillator = function () {
    const osc = { type: '', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} }
    oscillators.push(osc)
    return osc
  }
  FakeCtx.prototype.createGain = function () {
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
  window.AudioContext = FakeCtx
  return { oscillators }
}

describe('mjs_modal — µ.modal.notify({sound:true}) contourne le gate PAR APPEL', function () {
  it("modalSound défaut false — notify({type:'success', sound:true}) joue quand même (signature 'success' du toast, 2 oscillateurs)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : gate désactivé par défaut')
    µ.modal.notify('x', { type: 'success', sound: true })
    assert.equal(oscillators.length, 2, 'sound:true doit contourner le gate et jouer la signature success (2 notes)')
  })

  it("contre-cas — `sound` absent avec modalSound coupé : gate conservé, rien ne joue", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : gate désactivé par défaut')
    µ.modal.notify('x', { type: 'success' })
    assert.equal(oscillators.length, 0, 'sans override, le gate coupé reste muet')
  })

  it("contre-cas — `sound:false` avec modalSound:true : silence PAR APPEL conservé", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'success', sound: false })
    assert.equal(oscillators.length, 0, 'sound:false reste un silence explicite, même gate ouvert')
  })
})
