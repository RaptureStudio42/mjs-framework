// Tests neufs — µ.sound(type, override) : appel PUBLIC de la couche sonore de la modale,
// utilisable PARTOUT dans l'app, pas seulement depuis µ.modal.fire/notify. Joue TOUJOURS quand on
// l'appelle explicitement : le gate µ.config.modalSound=false NE S'APPLIQUE PAS ici (il ne gate
// que les sons AUTOMATIQUES des modales/toasts, __modalSound). Source, dans l'ordre : override
// (false=silence, chaîne fichier '/'|'.'|'http'=fichier, nom de signature connu=cette signature)
// sinon le mapping fichier de µ.config.modalSound OBJET pour ce type, sinon la signature
// WebAudio du type. Type inconnu → µ.warn, aucun son. Même harnais que mjs-modal-sound.test.ts
// (cf. son en-tête) — happy-dom ne fournit PAS AudioContext par défaut, stub minimal repris ici.

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

function loadModal(): { window: any; document: any; µ: any; warnings: string[] } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  const warnings: string[] = []
  window.µ.warn = (...args: any[]) => { warnings.push(args.join(' ')) }
  return { window, document: window.document, µ: window.µ, warnings }
}

// stub minimal d'AudioContext — compte les oscillateurs créés (1 par note()) — copie EXACTE du
// patron de mjs-modal-sound.test.ts.
function stubAudioContext(window: any): { oscillators: any[]; created: number } {
  const oscillators: any[] = []
  const counter = { created: 0 }
  function FakeCtx(this: any) {
    counter.created++
    this.currentTime = 0
    this.destination = {}
  }
  FakeCtx.prototype.createOscillator = function () {
    const osc = { type: '', frequency: { value: 0 }, connect: () => {}, start: () => {}, stop: () => {} }
    oscillators.push(osc)
    return osc
  }
  FakeCtx.prototype.createGain = function () {
    return { gain: { setValueAtTime: () => {}, exponentialRampToValueAtTime: () => {} }, connect: () => {} }
  }
  window.AudioContext = FakeCtx
  return { oscillators, get created() { return counter.created } }
}

function stubAudio(window: any): { calls: string[] } {
  const calls: string[] = []
  window.Audio = function (url: string) {
    calls.push(url)
    return { play: () => Promise.resolve() }
  }
  return { calls }
}

describe('mjs_modal — µ.sound(type, override) : appel public', function () {
  it("µ.sound('success') JOUE même avec µ.config.modalSound:false (le gate ne s'applique pas à l'appel public)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : gate désactivé')
    µ.sound('success')
    assert.equal(oscillators.length, 2, 'signature success = 2 notes, jouée malgré le gate')
  })

  it('µ.sound() sans argument = signature notify (1 oscillateur)', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.sound()
    assert.equal(oscillators.length, 1)
  })

  it('override false = silence, quel que soit le type demandé', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.sound('success', false)
    assert.equal(oscillators.length, 0)
  })

  it("mapping objet µ.config.modalSound = {error:'/e.mp3'} — µ.sound('error') joue le FICHIER, µ.sound('success') retombe sur la signature (type absent du mapping)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.config.modalSound = { error: '/e.mp3' }
    µ.sound('error')
    assert.deepEqual(calls, ['/e.mp3'])
    assert.equal(oscillators.length, 0, 'pas de repli signature quand le fichier est mappé')
    µ.sound('success')
    assert.equal(oscillators.length, 2, 'success absent du mapping → signature (2 notes)')
  })

  it('type inconnu → µ.warn, aucun son', function () {
    const { window, µ, warnings } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.sound('bogus')
    assert.equal(oscillators.length, 0, 'aucun son pour un type inconnu')
    assert.equal(warnings.length, 1, 'µ.warn appelé exactement une fois')
    assert.match(warnings[0], /bogus/)
  })

  it("override chaîne fichier ('/x.mp3') l'emporte sur le type ET sur µ.config.modalSound", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.config.modalSound = true
    µ.sound('success', '/x.mp3')
    assert.deepEqual(calls, ['/x.mp3'])
    assert.equal(oscillators.length, 0)
  })

  it("override nom de signature ('error') l'emporte sur le type demandé", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.sound('success', 'error')
    assert.equal(oscillators.length, 1, 'signature error = 1 note (pas 2, comme success)')
  })

  it('AudioContext ABSENT (jamais stubbé) : aucun crash', function () {
    const { µ } = loadModal()
    assert.doesNotThrow(() => { µ.sound('success') })
  })
})
