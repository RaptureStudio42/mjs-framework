// Tests neufs — µ.sound(type, chemin) — un chemin relatif SANS `/`, `./` ni
// `http` en tête (ex. 'sons/ok.mp3') était ignoré EN SILENCE (ni fichier reconnu ni signature
// connue) : la fonction retombait sur le bip WebAudio du `type` demandé, sans le moindre µ.warn.
// Correctif (__modalPlayOverride, mjs_modal.ts) : toute chaîne qui n'est PAS le nom d'une des 5
// signatures est désormais un chemin de fichier, résolu contre document.baseURI ; une résolution
// impossible avertit explicitement au lieu de se taire. Les chemins DÉJÀ reconnus ('/'|'.'|'http'
// en tête) restent joués TELS QUELS (non touchés — cf. mjs-modal-sound.test.ts/
// mjs-modal-sound-public.test.ts, non-régression prouvée par ailleurs). Même harnais que
// tests/mjs-modal-sound-public.test.ts (cf. son en-tête).

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

function loadModal(): { window: any; document: any; µ: any; warnings: string[] } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  const warnings: string[] = []
  window.µ.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  return { window, document: window.document, µ: window.µ, warnings }
}

// stub minimal d'AudioContext (copie du patron de mjs-modal-sound.test.ts)
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

function stubAudio(window: any): { calls: string[] } {
  const calls: string[] = []
  window.Audio = function (url: string) { calls.push(url); return { play: () => Promise.resolve() } }
  return { calls }
}

describe('mjs_modal — µ.sound : chemin relatif sans préfixe reconnu', function () {
  it("µ.sound('notify', 'sons/ok.mp3') — l'Audio stubbé reçoit l'URL ABSOLUE résolue contre document.baseURI", function () {
    const { window, µ, warnings } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.sound('notify', 'sons/ok.mp3')
    assert.deepEqual(calls, ['http://localhost/sons/ok.mp3'])
    assert.equal(oscillators.length, 0, 'plus de repli silencieux sur la signature du type')
    assert.equal(warnings.length, 0, 'un chemin résoluble ne doit déclencher aucun avertissement')
  })

  it("chaîne inconnue NON résoluble en URL → µ.warn appelé, aucun son joué", function () {
    const { window, µ, warnings } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.sound('success', 'a://[bad')
    assert.equal(calls.length, 0)
    assert.equal(oscillators.length, 0, 'jamais un repli muet sur une AUTRE source que celle demandée')
    assert.equal(warnings.length, 1, 'µ.warn appelé exactement une fois')
    assert.match(warnings[0], /a:\/\/\[bad/)
  })

  it("comportement PRÉSERVÉ pour un chemin DÉJÀ préfixé ('/x.mp3') — littéral, non résolu (non-régression)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.sound('success', '/x.mp3')
    assert.deepEqual(calls, ['/x.mp3'], 'chemin déjà reconnu : joué TEL QUEL, jamais résolu en absolu')
    assert.equal(oscillators.length, 0)
  })

  it("le même correctif profite à µ.modal.fire({sound: '…'}) (recette PARTAGÉE __modalPlayOverride)", function () {
    const { window, µ, warnings } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    assert.equal(µ.config.modalSound, false, 'précondition : gate désactivé, sans incidence sur un override explicite')
    µ.modal.fire({ icon: 'success', text: 'x', sound: 'sons/ding.mp3' })
    assert.deepEqual(calls, ['http://localhost/sons/ding.mp3'])
    assert.equal(oscillators.length, 0)
    assert.equal(warnings.length, 0)
  })
})
