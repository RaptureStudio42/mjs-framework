// Régression : dans le handler `popstate`, la callback de succès du fetch
// réseau (cache miss) réutilise `_mzCur.zone` — capturé de manière SYNCHRONE,
// AVANT même que la requête ne parte — comme `liveRoot` au moment du swap,
// APRÈS le round-trip réseau (asynchrone). Le handler de CLIC fait l'inverse
// et RE-INTERROGE `µ._mjs_navMountZone(document, null)` à ce même point precis,
// avec un commentaire explicite ("Re-query (pas la closure) : le root capturé
// peut avoir été remplacé entre-temps — remplir un nœud détaché était un
// no-op muet.") — commentaire TOUJOURS présent dans le fichier (cf.
// mjs_ujs.ts, handler de clic), mais dont le CODE associé n'a pas été reporté
// dans le handler popstate lors du passage à l'ancienne cascade de montage —
// la cascade a depuis disparu (le chemin HTML a toujours `target: null`,
// le contenant EST toujours `<body>`), mais le PRINCIPE (re-interroger, pas
// réutiliser une closure) reste identique et tout aussi nécessaire : ce test
// simule un `document.body` qui change d'IDENTITÉ (pas de position dans
// l'arbre) pendant le round-trip.
//
// Scénario concret : un retour arrière (popstate) déclenche un refetch réseau
// (cache miss) ; PENDANT ce round-trip, le contenant de montage vivant change
// d'identité (ex. hydratation SSR qui remplace le composant racine par une
// instance fraîchement montée, ou tout autre code qui recompose le DOM) SANS
// bumper `µ._mjs_navSeq` (donc sans déclencher le garde anti-course existant). Le
// swap doit alors cibler le contenant COURANT (frais), pas la référence
// capturée avant le fetch — sans quoi, dans un vrai navigateur, remplir un
// nœud détaché est un no-op muet et la page affichée ne change jamais alors
// que l'URL, elle, a déjà bougé.
//
// Méthode : même technique que ujs-popstate-anchor-clears-views.test.ts
// (extraction du corps RÉEL du handler + du bloc helpers via `new
// Function`, mocks contrôlés).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractPopstateBody(src: string): string {
  return extractMarkedBody(src, 'popstate-listener')
}

function extractHelpersBlock(src: string): string {
  return extractMarked(src, 'helpers-navigation')
}

function makeHandler(µ: any, win: any, doc: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock(UJS_SRC))(µ, doc, win)
  const body = extractPopstateBody(UJS_SRC)
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', body)
}

describe("mjs_ujs — popstate (cache miss réseau) : le contenant swappé doit être RE-INTERROGÉ, pas une closure capturée avant le fetch", function () {
  it("le contenant (document.body) change d'identité PENDANT le round-trip réseau : le swap doit cibler le contenant FRAIS (comme le handler de clic), pas l'ancienne référence", function () {
    const filledA: any[] = []
    const filledB: any[] = []
    const zoneA: any = { tag: 'zoneA', childNodes: [] as any[], replaceChildren(...nodes: any[]) { filledA.push(nodes) } }
    const zoneB: any = { tag: 'zoneB', childNodes: [] as any[], replaceChildren(...nodes: any[]) { filledB.push(nodes) } }
    const fetchedRoot: any = { tag: 'fetchedRoot' }

    const win: any = { location: { pathname: '/b', search: '', hash: '' } }
    // `doc.body` MUTABLE : zoneA au moment de l'appel synchrone (capture
    // pré-fetch), puis reciblé sur zoneB avant l'invocation de la callback
    // réseau — simule un remplacement du contenant « entre-temps » (hydratation
    // ou autre code qui recompose le DOM).
    const doc: any = { body: zoneA }

    let capturedSuccess: any
    const µ: any = {
      _mjs_lastUjsPath: '/a', _mjs_navSeq: 0,
      pageCache: { has: () => false, get: () => null, set() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      warn() {}, error() {}, log() {},
      _mjs_finalPathFor: (_finalUrl: any, fallback: string) => fallback,
      _mjs_ajaxRequest: (opts: any) => { capturedSuccess = opts.success; return Promise.resolve() },
    }

    const handler = makeHandler(µ, win, doc)
    class FakeDOMParser {
      parseFromString() { return { body: { childNodes: [fetchedRoot] } } }
    }

    handler({}, µ, win, doc, FakeDOMParser)
    assert.ok(typeof capturedSuccess === 'function', 'µ._mjs_ajaxRequest doit avoir été appelé avec un callback success (cache miss → fetch réseau)')

    // « Entre-temps » : le contenant vivant change d'identité AVANT que le fetch ne résolve.
    doc.body = zoneB

    capturedSuccess('<html><body>contenu B</body></html>', 'http://x/b')

    assert.equal(filledB.length, 1,
      "le swap doit cibler le contenant FRAIS (re-interrogé à l'instant du swap, comme le handler de clic) — 0 reçu : le contenant frais n'a jamais été touché")
    assert.deepEqual(filledB[0], [fetchedRoot], 'le contenant frais doit recevoir le nouveau contenu fetché')
    assert.equal(filledA.length, 0,
      "AVANT le fix : le swap ciblait encore l'ancien contenant (zoneA, capturé AVANT le fetch asynchrone) — un no-op muet sur un vrai nœud détaché")
  })
})
