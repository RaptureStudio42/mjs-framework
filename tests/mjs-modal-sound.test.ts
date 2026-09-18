// Tests neufs — couche sonore opt-in (µ.config.modalSound, __modalSound, mjs_modal.ts) :
// false (défaut) = silence ; true = signatures WebAudio embarquées par type
// (AudioContext lazy, réutilisé) ; objet {type: url} = fichier par type (`new Audio(url).play()`),
// type absent → repli signature ; `sound` par appel prime toujours. TOUT le chemin son est sous
// try/catch muet (politique autoplay) — jamais un crash, même sans AudioContext. Même méthode que
// mjs-modal-fire.test.ts (cf. son en-tête) ; happy-dom ne fournit PAS AudioContext par défaut
// (seulement `Audio`, l'élément HTML) — stub minimal ci-dessous.

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

function loadModal(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${PAGE_CACHE_SRC}\n${MODAL_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}

// stub minimal d'AudioContext — compte les oscillateurs créés (1 par note()).
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

describe('mjs_modal — couche sonore opt-in (µ.config.modalSound)', function () {
  it('modalSound défaut false : aucun appel AudioContext (chemin son jamais tenté)', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : défaut false')
    µ.modal.fire({ icon: 'success' })
    assert.equal(oscillators.length, 0)
  })

  it('modalSound:true — icon success ouvre 2 oscillateurs (2 notes)', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'success' })
    assert.equal(oscillators.length, 2)
  })

  it('modalSound:true — icon error ouvre 1 oscillateur', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'error' })
    assert.equal(oscillators.length, 1)
  })

  it('modalSound:true — icon warning ouvre 2 oscillateurs (2 notes)', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'warning' })
    assert.equal(oscillators.length, 2)
  })

  it('modalSound:true — icon info ouvre 1 oscillateur', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'info' })
    assert.equal(oscillators.length, 1)
  })

  it("modalSound:true — icon 'question' : silence, aucun oscillateur", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'question' })
    assert.equal(oscillators.length, 0)
  })

  it('modalSound:true — aucune icône fournie : silence, aucun oscillateur', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ text: 'sans icône' })
    assert.equal(oscillators.length, 0)
  })

  it('modalSound:true — µ.modal.notify (type par défaut info) joue la signature notify (1 oscillateur)', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x')
    assert.equal(oscillators.length, 1)
  })

  it("modalSound:true — µ.modal.notify({type:'error'}) joue la signature error (1 oscillateur)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { type: 'error' })
    assert.equal(oscillators.length, 1)
  })

  it("modalSound = objet {success:'/x.mp3'} — icon success joue le FICHIER (stub Audio appelé), pas de signature", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.config.modalSound = { success: '/x.mp3' }
    µ.modal.fire({ icon: 'success' })
    assert.deepEqual(calls, ['/x.mp3'])
    assert.equal(oscillators.length, 0, 'pas de repli signature quand le fichier est fourni')
  })

  it("modalSound = objet SANS le type demandé — repli sur la signature embarquée (type absent de l'objet)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.config.modalSound = { success: '/x.mp3' }
    µ.modal.fire({ icon: 'error' })
    assert.equal(calls.length, 0)
    assert.equal(oscillators.length, 1, 'repli signature error (1 note)')
  })

  it("sound:false PAR APPEL l'emporte sur modalSound:true (silence malgré la config globale)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'success', sound: false })
    assert.equal(oscillators.length, 0)
  })

  it("sound:'/custom.mp3' PAR APPEL l'emporte sur modalSound:true (fichier, pas de signature)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    const { calls } = stubAudio(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'success', sound: '/custom.mp3' })
    assert.deepEqual(calls, ['/custom.mp3'])
    assert.equal(oscillators.length, 0)
  })

  it("sound:'error' PAR APPEL force la signature 'error' MÊME avec modalSound:false (override par nom, prioritaire sur la config globale)", function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    assert.equal(µ.config.modalSound, false, 'précondition : opt-in désactivé')
    µ.modal.fire({ icon: 'success', sound: 'error' })
    assert.equal(oscillators.length, 1, "signature error = 1 note (pas 2, comme success) — jouée malgré modalSound:false")
  })

  it('opts.sound PAR APPEL fonctionne aussi sur notify()', function () {
    const { window, µ } = loadModal()
    const { oscillators } = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.notify('x', { sound: false })
    assert.equal(oscillators.length, 0)
  })

  it("AudioContext ABSENT (jamais stubbé) : aucun crash, la modale s'ouvre normalement", function () {
    const { document, µ } = loadModal()
    µ.config.modalSound = true
    assert.doesNotThrow(() => { µ.modal.fire({ icon: 'success' }) })
    assert.ok(box(document), "la modale s'ouvre malgré le son en échec")
  })

  it('AudioContext qui THROW à la construction : aucun crash (try/catch muet)', function () {
    const { window, document, µ } = loadModal()
    window.AudioContext = function () { throw new Error('non autorisé') }
    µ.config.modalSound = true
    assert.doesNotThrow(() => { µ.modal.fire({ icon: 'success' }) })
    assert.ok(box(document))
  })

  it("fichier audio dont .play() REJETTE (politique autoplay) : aucun crash, aucune exception non gérée", function () {
    const { window, document, µ } = loadModal()
    window.Audio = function () { return { play: () => Promise.reject(new Error('autoplay refusé')) } }
    µ.config.modalSound = { success: '/x.mp3' }
    assert.doesNotThrow(() => { µ.modal.fire({ icon: 'success' }) })
    assert.ok(box(document))
  })

  it('AudioContext lazy : réutilisé entre deux sons (1 seule instance créée)', async function () {
    const { window, document, µ } = loadModal()
    // NB : `created` est une propriété-getter — lue par ACCÈS (ctxStub.created), jamais
    // déstructurée (une déstructuration figerait sa valeur au moment de l'appel, ici 0).
    const ctxStub = stubAudioContext(window)
    µ.config.modalSound = true
    µ.modal.fire({ icon: 'success' })
    box(document).querySelector('.mjs-modal-confirm').click()
    µ.modal.fire({ icon: 'info' })
    assert.equal(ctxStub.created, 1, 'un seul AudioContext créé, réutilisé au 2e son')
    assert.equal(ctxStub.oscillators.length, 3, '2 notes (success) + 1 note (info)')
  })
})
