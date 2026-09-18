// javascript:/data:/tel:/mailto: sur un <a> : comportement DÉJÀ correct (jamais
// interceptés par UJS, laissés au navigateur ou neutralisés, zéro fetch) mais ZÉRO test jusqu'ici
// (grep sur toute la suite tests/ujs-*.test.ts : aucune occurrence) — ce fichier fige le contrat.
//
// Mécanisme observé (mjs_ujs.ts:2064 puis :2075,
// happy-dom ET Chromium identiques) : `.origin` d'une URL javascript:/data:/tel: est TOUJOURS
// l'origine opaque `"null"` — l'origin check générique (:2064, `link.origin !== window.location.origin`)
// sort donc déjà AVANT le check protocole explicite (:2075, `javascript:`/`mailto:` nommés). Pour un
// site servi en http(s) normal, ce check explicite est donc du CODE MORT pour ces 3 protocoles
// (jamais atteint) ; `mailto:`, lui, y est nommé et donc rattrapé s'il devait un jour être atteint.
// Aucun nettoyage demandé : le check explicite reste en place tel quel.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function makeClickHandler() {
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', 'FormData', extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick'))
}

function makeClickEvent(link: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    stopImmediatePropagation() {},
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    target: link,
  }
}

describe('mjs_ujs — µ._mjs_ujsOnClick : javascript:/data:/tel:/mailto: jamais interceptés, zéro fetch', function () {
  let window: any
  let document: any
  let dispatchCalls: any[]
  let µ: any
  let handler: Function

  before(function () {
    window = new Window({ url: 'http://localhost/app' })
    document = window.document
    document.body.innerHTML = `
      <a id="js" href="javascript:window.__hit=1">js</a>
      <a id="data" href="data:text/html,%3Cscript%3Ealert(1)%3C/script%3E">data</a>
      <a id="tel" href="tel:+123456789">tel</a>
      <a id="mail" href="mailto:x@y.z">mail</a>
    `
    dispatchCalls = []
    µ = {
      realTarget: (e: any) => e.target,
      _mjs_navNoUjs: () => false,
      _mjs_navWarnNoUjsMethod: () => {},
      _mjs_navDispatch: (...a: any[]) => { dispatchCalls.push(a) },
      warn() {}, error() {}, log() {},
    }
    handler = makeClickHandler()
  })

  function click(id: string) {
    const link = document.getElementById(id)
    const e = makeClickEvent(link)
    handler(e, µ, window, document, window.DOMParser, window.FormData)
    return e
  }

  it('javascript: — .origin opaque ("null"), jamais intercepté (preventDefault jamais posé, laissé au navigateur)', function () {
    const link = document.getElementById('js')
    assert.equal(link.origin, 'null', 'contrat sondé : origine opaque')
    const e = click('js')
    assert.equal(e.defaultPrevented, false)
  })

  it('data: — .origin opaque, jamais intercepté', function () {
    const link = document.getElementById('data')
    assert.equal(link.origin, 'null')
    const e = click('data')
    assert.equal(e.defaultPrevented, false)
  })

  it('tel: — .origin opaque, jamais intercepté (aucun check protocole dédié, l\'origin check suffit)', function () {
    const link = document.getElementById('tel')
    assert.equal(link.origin, 'null')
    const e = click('tel')
    assert.equal(e.defaultPrevented, false)
  })

  it('mailto: — .origin opaque, jamais intercepté (rattrapé aussi par le check protocole explicite, redondant ici)', function () {
    const link = document.getElementById('mail')
    assert.equal(link.origin, 'null')
    const e = click('mail')
    assert.equal(e.defaultPrevented, false)
  })

  it('zéro fetch pour les 4 clics cumulés : µ._mjs_navDispatch jamais appelé', function () {
    assert.deepEqual(dispatchCalls, [], "aucun des 4 protocoles ne doit atteindre le pipeline réseau ujs")
  })
})
