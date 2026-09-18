// @title, élément survolé DÉTACHÉ du DOM PENDANT l'affichage
// (composant démonté, branche {if} réactive qui masque, etc.) — aucun mouseout/mouseleave natif
// n'est synthétisé par un retrait programmatique (comportement standard des navigateurs, pas un
// artefact happy-dom). Sans garde, la bulle restait affichée pour toujours, orpheline (aria-
// describedby pointant un nœud disparu). Correctif : MutationObserver DÉDIÉ (__titleDetachObserver,
// jamais partagé avec l'observateur d'attributs) sur la racine en childList+subtree — ferme la
// bulle dès que `target.isConnected` devient faux, retiré à la fermeture (zéro fuite). Même
// harnais DIRECT (window.eval, PAS de Bundler) que tests/mjs-modal-close.test.ts (cf. son
// en-tête) — suffisant ici : µ._mjs_titleAttach(document) est posé au CHARGEMENT du module (dernière
// ligne de mjs_title.ts), aucun composant compilé requis pour des éléments en LIGHT DOM.
//
// PIÈGE DE HARNAIS (cf. tests/helpers/dom-assert.ts) : jamais `assert.equal(<accès DOM>, null)` —
// un nœud happy-dom passé à node:assert fait exploser la RAM du run. `assertAbsent()` ci-dessous.

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

const INIT_SRC  = stripEsm(readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_init.ts'), 'utf-8'))
const TITLE_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_title.ts'), 'utf-8')

function loadTitle(): { window: any; document: any; µ: any } {
  const window: any = new Window({ url: 'http://localhost/' })
  window.eval(`${INIT_SRC}\n${TITLE_SRC}\nglobalThis.µ = µ;`)
  return { window, document: window.document, µ: window.µ }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

describe("mjs_title — élément détaché du DOM pendant l'affichage", function () {
  it("el.remove() PENDANT l'affichage referme la bulle (aucun mouseout natif nécessaire)", async function () {
    const { window, document } = loadTitle()
    document.body.innerHTML = `<button id="d1" mjs-title="Astuce" mjs-title-conf='{"delay":10}'>x</button>`
    const el = document.getElementById('d1')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.ok(document.querySelector('.mjs-title-visible'), 'bulle visible avant détachement')

    el.remove()
    await sleep(20)
    assertAbsent(document.querySelector('.mjs-title-visible'), 'bulle retirée après el.remove(), sans autre interaction')
  })

  it('après fermeture par détachement, une NOUVELLE cible rouvre la bulle normalement (état bien nettoyé)', async function () {
    const { window, document } = loadTitle()
    document.body.innerHTML = `
      <button id="d2" mjs-title="Astuce 2" mjs-title-conf='{"delay":10}'>x</button>
      <button id="d3" mjs-title="Astuce 3" mjs-title-conf='{"delay":10}'>y</button>
    `
    const el2 = document.getElementById('d2')
    el2.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.ok(document.querySelector('.mjs-title-visible'))
    el2.remove()
    await sleep(20)
    assertAbsent(document.querySelector('.mjs-title-visible'))

    const el3 = document.getElementById('d3')
    el3.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    const bubble = document.querySelector('.mjs-title-visible')
    assert.ok(bubble, 'la bulle réapparaît normalement pour une autre cible')
    assert.equal(bubble.textContent, 'Astuce 3')
  })

  it("l'observateur DÉDIÉ au détachement est bien déconnecté à la fermeture (zéro fuite)", async function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval(`${INIT_SRC}\n${TITLE_SRC}\nglobalThis.µ = µ;`)
    let disconnectCalls = 0
    const origDisconnect = window.MutationObserver.prototype.disconnect
    window.MutationObserver.prototype.disconnect = function (...args: any[]) { disconnectCalls++; return origDisconnect.apply(this, args) }

    document.body.innerHTML = `<button id="d4" mjs-title="Astuce 4" mjs-title-conf='{"delay":10}'>x</button>`
    const el = document.getElementById('d4')
    el.dispatchEvent(new window.MouseEvent('mouseover', { bubbles: true }))
    await sleep(30)
    assert.ok(document.querySelector('.mjs-title-visible'))

    const before = disconnectCalls
    el.remove()
    await sleep(20)
    assertAbsent(document.querySelector('.mjs-title-visible'))
    assert.ok(disconnectCalls > before, "disconnect() rappelé sur (au moins) l'observateur de détachement à la fermeture forcée")
  })
})
