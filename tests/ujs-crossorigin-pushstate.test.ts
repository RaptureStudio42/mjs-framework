// µ._mjs_navApplyJson posait `dest` (finalUrl || json.url) TEL QUEL dans
// window.history.pushState, aux 2 sites (branche 404 ET branche nominale), sans le filtre
// cross-origin que µ._mjs_finalPathFor applique déjà au MÊME risque (docs/21-navigation.md
// « on ne pilote pas une URL hors de notre origine »). Un `dest` hors origine (redirection
// serveur suivie nativement par fetch vers un autre host, ou `json.url` absolu mal formé)
// levait un SecurityError SYNCHRONE et NON CATCHÉ — la navigation restait bloquée en silence.
//
// Angle mort des tests existants (ujs-nav-json.test.ts et voisins) : `window.history` y est
// TOUJOURS un mock `pushState(){}` qui ne peut PAS reproduire un SecurityError — ce fichier
// utilise donc un VRAI happy-dom `Window`, seul moyen
// d'obtenir la sémantique RÉELLE de pushState.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// µ._mjs_navApplyJson vit dans le grand bloc 'helpers-navigation' (µ._mjs_navMountZone -> µ._mjs_navRequest) ;
// µ._mjs_finalPathFor est un bloc séparé, juste au-dessus.
function installNav(µ: any, document: any, window: any) {
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, '_mjs_finalPathFor'))(µ, document, window)
  new Function('µ', 'document', 'window', extractMarked(UJS_SRC, 'helpers-navigation'))(µ, document, window)
}

function makeMu(hardNavCalls: string[]) {
  return {
    paths: { produit: 'xxx-hash.js' },
    version: 'v1',
    _mjs_resSet: (_p: any) => {},
    _mjs_hardNav: (dest: string) => { hardNavCalls.push(dest) },
    Router: { navigate: () => {}, _mjs_updateUrlStore: () => {} },
    warn: () => {},
    error: () => {},
    log: () => {},
  }
}

describe('mjs_ujs — µ._mjs_navApplyJson : dest cross-origin jamais envoyé à pushState/replaceState', function () {
  it('(a) branche NOMINALE (module string) : url cross-origin -> pas de SecurityError, µ._mjs_hardNav appelé, URL affichée inchangée', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const hardNavCalls: string[] = []
    const µ: any = makeMu(hardNavCalls)
    installNav(µ, document, window)

    let threw = false
    let errMsg = ''
    try {
      µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: 'https://evil.example/phishing', title: null, version: 'v1' }, null, { push: true })
    } catch (e: any) {
      threw = true
      errMsg = String(e)
    }

    assert.equal(threw, false, 'AVANT le fix : pushState levait un SecurityError non catché ('+ errMsg +')')
    assert.deepEqual(hardNavCalls, ['https://evil.example/phishing'], 'µ._mjs_hardNav doit être appelé avec dest, en repli du pushState refusé')
    assert.equal(window.location.href, 'http://localhost/', "l'URL affichée ne doit PAS avoir bougé (pushState jamais atteint, µ._mjs_hardNav est un stub ici)")
  })

  it('(b) branche 404 (module:null) : url cross-origin -> pas de SecurityError, µ._mjs_hardNav appelé', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const hardNavCalls: string[] = []
    const µ: any = makeMu(hardNavCalls)
    installNav(µ, document, window)

    let threw = false
    let errMsg = ''
    try {
      µ._mjs_navApplyJson({ module: null, props: {}, url: 'https://evil.example/404-ish', title: null, version: 'v1' }, null, { push: true })
    } catch (e: any) {
      threw = true
      errMsg = String(e)
    }

    assert.equal(threw, false, 'AVANT le fix : pushState levait un SecurityError non catché ('+ errMsg +')')
    assert.deepEqual(hardNavCalls, ['https://evil.example/404-ish'], 'µ._mjs_hardNav doit être appelé avec dest, en repli du pushState refusé')
    assert.equal(window.location.href, 'http://localhost/', "l'URL affichée ne doit PAS avoir bougé")
  })

  it('(c) contre-épreuve : url SAME-origin -> pushState réel a bien lieu, µ._mjs_hardNav jamais appelé', function () {
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    const hardNavCalls: string[] = []
    const µ: any = makeMu(hardNavCalls)
    installNav(µ, document, window)

    assert.doesNotThrow(() => {
      µ._mjs_navApplyJson({ module: 'mjs-produit', props: {}, url: '/produits/42', title: null, version: 'v1' }, null, { push: true })
    })

    assert.equal(hardNavCalls.length, 0, 'même origine : aucun repli hardNav')
    assert.equal(window.location.pathname, '/produits/42', 'pushState réel a bien déplacé la localisation affichée')
  })
})
