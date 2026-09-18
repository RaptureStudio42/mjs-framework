// Résolution du CONTENANT de navigation
// `µ._mjs_navMountZone(doc, target)` : une navigation remplace le CONTENU d'un
// contenant. Le contenant = `target` (sélecteur CSS de la fiche JSON) s'il est
// présent ET résolu, sinon `<body>`. Remplace l'ancienne cascade
// #app-root/1er enfant mjs-*/`<body>` — RETIRÉE : plus de recherche
// de composant racine dans `<body>`, plus de suivi 'mjs-child'. `target`
// introuvable (sélecteur CSS invalide compris — `querySelector` qui jette est
// absorbé, la navigation ne doit jamais mourir là-dessus) retombe sur la
// dernière zone SUIVIE (`µ._mjs_navZone`, posée par un `method:'replace'`
// antérieur) si elle est encore connectée, sinon `<body>` + avertissement
// (une fois par sélecteur DISTINCT).
//
// Méthode : extraction du corps SOURCE de `µ._mjs_navMountZone` par regex (même
// technique que les tests ujs-submit-*/ujs-click-crosspage-no-approot),
// exécutée via `new Function` avec un `document` FAKE minimal (`body`/
// `querySelector`, ce dont la fonction a besoin). L'état module
// `µ._mjs_navTargetWarned`/`µ._mjs_navZone` (déclarés juste avant la fonction dans le
// fichier réel) est fourni par le harnais au même titre que `µ.warn` —
// n'affecte pas le comportement réellement testé (le CORPS de la fonction).

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { extractMarked } from './helpers/extract-marked.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractNavMountZoneStatement(src: string): string {
  return extractMarked(src, '_mjs_navMountZone')
}

// `document` FAKE lié À LA DÉFINITION (2e argument de `new Function`) ET
// utilisé comme ARGUMENT d'appel — nécessaire pour que la garde interne
// `doc === document` (avertissement UNE fois par sélecteur, jamais pour un
// document PARSÉ différent) puisse être vraie dans ce harnais.
function makeNavMountZone(µ: any, doc: any): (d?: any, target?: any) => { zone: any, mode: string, target: any } {
  if (µ._mjs_navTargetWarned === undefined) { µ._mjs_navTargetWarned = {} }
  if (µ._mjs_navZone === undefined) { µ._mjs_navZone = null }
  new Function('µ', 'document', extractNavMountZoneStatement(UJS_SRC))(µ, doc)
  return µ._mjs_navMountZone
}

function makeDoc(body: any, els: Record<string, any> = {}) {
  return {
    body,
    querySelector(sel: string) {
      if (sel === '>>>') { throw new Error("'>>>' n'est pas un sélecteur CSS valide") }
      return Object.prototype.hasOwnProperty.call(els, sel) ? els[sel] : null
    },
  }
}

describe('mjs_ujs — µ._mjs_navMountZone : contenant de navigation', function () {
  it("target présent et TROUVÉ → { zone: élément, mode: 'target', target }", function () {
    const µ: any = { warn: () => { throw new Error('ne doit jamais être appelé : target trouvé') } }
    const body = { tag: 'body' }
    const panel = { tag: 'panel' }
    const doc = makeDoc(body, { '#panel': panel })
    const navMountZone = makeNavMountZone(µ, doc)
    const result = navMountZone(doc, '#panel')
    assert.equal(result.zone, panel)
    assert.equal(result.mode, 'target')
    assert.equal(result.target, '#panel')
  })

  it("target absent (null/undefined) → { zone: body, mode: 'body', target: null }, aucun avertissement", function () {
    const µ: any = { warn: () => { throw new Error("ne doit jamais être appelé : l'absence de target est le cas nominal, pas une anomalie") } }
    const body = { tag: 'body' }
    const doc = makeDoc(body)
    const navMountZone = makeNavMountZone(µ, doc)
    assert.deepEqual(navMountZone(doc, null), { zone: body, mode: 'body', target: null })
    assert.deepEqual(navMountZone(doc, undefined), { zone: body, mode: 'body', target: null })
  })

  it("target introuvable (aucune zone suivie) → repli <body> + avertissement UNE FOIS pour deux navigations du même sélecteur", function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const body = { tag: 'body' }
    const doc = makeDoc(body) // '#panel' ne résout jamais
    const navMountZone = makeNavMountZone(µ, doc)

    const r1 = navMountZone(doc, '#panel')
    assert.equal(r1.zone, body)
    assert.equal(r1.mode, 'body')
    assert.equal(r1.target, null, 'target retombé à null : plus de trace de la cible ratée dans le retour')
    assert.equal(warnCalls.length, 1, '1re navigation vers #panel introuvable : un avertissement')
    assert.match(warnCalls[0][0], /#panel/)
    assert.match(warnCalls[0][0], /introuvable/)

    const r2 = navMountZone(doc, '#panel')
    assert.equal(r2.zone, body)
    assert.equal(warnCalls.length, 1, '2e navigation, MÊME sélecteur : PAS un 2e avertissement')
  })

  it('sélecteur DISTINCT introuvable → avertissement SÉPARÉ (pas partagé avec un sélecteur déjà signalé)', function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const doc = makeDoc({ tag: 'body' })
    const navMountZone = makeNavMountZone(µ, doc)

    navMountZone(doc, '#panel')
    navMountZone(doc, '#autre')
    assert.equal(warnCalls.length, 2, 'deux sélecteurs distincts introuvables : deux avertissements, un par sélecteur')
  })

  it("sélecteur CSS INVALIDE ('>>>') : aucune exception, repli <body> + avertissement (querySelector qui jette est absorbé)", function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const body = { tag: 'body' }
    const doc = makeDoc(body)
    const navMountZone = makeNavMountZone(µ, doc)

    let result: any
    assert.doesNotThrow(() => { result = navMountZone(doc, '>>>') }, 'un sélecteur CSS cassé ne doit JAMAIS faire jeter la navigation')
    assert.equal(result.zone, body)
    assert.equal(result.mode, 'body')
    assert.equal(warnCalls.length, 1)
  })

  it("target introuvable MAIS µ._mjs_navZone encore connecté (et ≠ body) → c'est LUI la cible (mode 'replaced'), AUCUN avertissement", function () {
    const µ: any = { warn: () => { throw new Error('ne doit jamais être appelé : la zone suivie prend le relais, pas une anomalie') } }
    const body = { tag: 'body' }
    const replacedModule = { tag: 'module-installe', isConnected: true }
    const doc = makeDoc(body) // '#panel' introuvable
    const navMountZone = makeNavMountZone(µ, doc)
    µ._mjs_navZone = replacedModule

    const result = navMountZone(doc, '#panel')
    assert.equal(result.zone, replacedModule)
    assert.equal(result.mode, 'replaced')
    assert.equal(result.target, '#panel', "le sélecteur d'origine reste porté (traçabilité), même en mode 'replaced'")
  })

  it('µ._mjs_navZone déconnecté (isConnected: false) : NE prend PAS le relais, repli <body> normal + avertissement', function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const body = { tag: 'body' }
    const staleModule = { tag: 'ancien-module', isConnected: false }
    const doc = makeDoc(body)
    const navMountZone = makeNavMountZone(µ, doc)
    µ._mjs_navZone = staleModule

    const result = navMountZone(doc, '#panel')
    assert.equal(result.zone, body)
    assert.equal(result.mode, 'body')
    assert.equal(warnCalls.length, 1)
  })

  it("document PARSÉ différent (réponse réseau), target introuvable : AUCUN avertissement (la garde ne compte que le document COURANT)", function () {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const liveDoc = makeDoc({ tag: 'live-body' })
    const navMountZone = makeNavMountZone(µ, liveDoc)

    // document RÉPONSE : un objet DIFFÉRENT de `liveDoc` (celui lié à la
    // définition) — simule le doc parsé par DOMParser, jamais == au live.
    const parsedDoc = makeDoc({ tag: 'parsed-body' })
    const result = navMountZone(parsedDoc, '#panel')
    assert.equal(result.mode, 'body')
    assert.equal(warnCalls.length, 0, "un document parsé (réponse) hors-document ne déclenche jamais l'avertissement")
  })

  it('doc par défaut (aucun argument) : utilise le `document` lié à la définition', function () {
    const µ: any = { warn: () => {} }
    const body = { tag: 'body' }
    const doc = makeDoc(body)
    const navMountZone = makeNavMountZone(µ, doc)
    const result = (navMountZone as any)()
    assert.equal(result.zone, body)
    assert.equal(result.mode, 'body')
  })
})
