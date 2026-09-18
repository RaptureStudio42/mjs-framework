// Barre de progression retardée : OPT-IN via `µ.config.navProgress` (absent/`false` = zéro
// ligne exécutée, zéro élément inséré). `true` = seuil 500ms, un NOMBRE = ce seuil en ms. Élément
// `<div class="mjs-nav-progress" role="progressbar" aria-hidden="true">` inséré dans `document.body`
// SEULEMENT si la navigation dépasse le seuil, retiré à la fin (succès/échec/abandon). Timer + élément
// GLOBAUX (comme `µ.nav.active`) : deux navigations enchaînées ne doivent jamais empiler ni l'un ni
// l'autre.
//
// Méthode : extraction de la SOURCE réelle (µ._mjs_navProgressStart/µ._mjs_navProgressStop + leur état), même
// technique que les fichiers voisins (tests/ujs-nav-cache-policy.test.ts). `setTimeout`/`clearTimeout`
// INJECTÉS comme paramètres de la `Function` générée (comme `document`/`window` ailleurs dans ce
// fichier) et remplacés par une horloge FAKE entièrement pilotée à la main : déterministe (aucune
// vraie attente), et permet de prouver qu'un timer non déclenché ne produit JAMAIS d'élément — pas
// seulement « n'en a pas encore produit après une courte attente réelle ».

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const __dirname = dirname(fileURLToPath(import.meta.url))
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

function extractProgressBlock(src: string): string {
  const startIdx = src.indexOf('µ._mjs_navProgressTimer = null;')
  assert.ok(startIdx >= 0, 'µ._mjs_navProgressTimer introuvable (structure du fichier a changé ?)')
  const endMarker = '// Installe un TABLEAU de nœuds'
  const endIdx = src.indexOf(endMarker, startIdx)
  assert.ok(endIdx >= 0, 'bandeau µ._mjs_navInstallNodes introuvable après le bloc progression (structure du fichier a changé ?)')
  return src.slice(startIdx, endIdx)
}

function installProgress(µ: any, document: any, setTimeoutFn: any, clearTimeoutFn: any) {
  new Function('µ', 'document', 'setTimeout', 'clearTimeout', extractProgressBlock(UJS_SRC))(µ, document, setTimeoutFn, clearTimeoutFn)
}

// Horloge FAKE : `setTimeout`/`clearTimeout` n'attendent RIEN, chaque timer armé reste en attente
// dans `scheduled` jusqu'à `fire(id)` (déclenché à la main) ou `clearTimeoutFn(id)` (annulé).
function fakeTimers() {
  let nextId = 1
  const scheduled = new Map<number, { fn: Function, delay: number }>()
  const setTimeoutFn = (fn: Function, delay: number) => { const id = nextId++; scheduled.set(id, { fn, delay }); return id }
  const clearTimeoutFn = (id: number) => { scheduled.delete(id) }
  return {
    scheduled,
    setTimeoutFn,
    clearTimeoutFn,
    fire(id: number) {
      const t = scheduled.get(id)
      assert.ok(t, `timer ${id} introuvable (jamais armé, ou déjà annulé/déclenché)`)
      scheduled.delete(id)
      t!.fn()
    },
  }
}

// Élément/document FAKE : juste ce que µ._mjs_navProgressStart/Stop touchent réellement
// (createElement/className/setAttribute/appendChild/removeChild).
function makeEl(tag: string): any {
  const el: any = {
    tag, className: '', parentNode: null as any, children: [] as any[], _attrs: {} as Record<string, string>,
    setAttribute(k: string, v: string) { el._attrs[k] = v },
    getAttribute(k: string) { return Object.prototype.hasOwnProperty.call(el._attrs, k) ? el._attrs[k] : null },
    appendChild(c: any) { el.children.push(c); c.parentNode = el; return c },
    removeChild(c: any) { el.children = el.children.filter((x: any) => x !== c); c.parentNode = null; return c },
  }
  return el
}
function makeDoc(): any {
  const body = makeEl('body')
  return { body, createElement: (tag: string) => makeEl(tag) }
}

describe('mjs_ujs — µ._mjs_navProgressStart/Stop : désactivée par défaut', function () {
  it('µ.config absent : aucun timer, aucun élément — zéro ligne exécutée', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = {}
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()

    assert.equal(µ._mjs_navProgressTimer, null)
    assert.equal(µ._mjs_navProgressEl, null)
    assert.equal(timers.scheduled.size, 0)
    assert.equal(doc.body.children.length, 0)
  })

  it('µ.config.navProgress = false : idem, repli sûr explicite', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: false } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()

    assert.equal(µ._mjs_navProgressTimer, null)
    assert.equal(timers.scheduled.size, 0)
    assert.equal(doc.body.children.length, 0)
  })
})

describe('mjs_ujs — µ._mjs_navProgressStart/Stop : activée, seuil', function () {
  it('µ.config.navProgress = true : seuil PAR DÉFAUT 500ms', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()

    assert.equal(timers.scheduled.size, 1)
    assert.equal(timers.scheduled.get(µ._mjs_navProgressTimer)!.delay, 500)
  })

  it('µ.config.navProgress = 700 (nombre) : ce nombre EST le seuil, en ms', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: 700 } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()

    assert.equal(timers.scheduled.get(µ._mjs_navProgressTimer)!.delay, 700)
  })
})

describe('mjs_ujs — µ._mjs_navProgressStart/Stop : navigation plus rapide que le seuil', function () {
  it('le timer est annulé avant d\'avoir sonné : AUCUN élément n\'apparaît jamais', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()
    assert.equal(timers.scheduled.size, 1)
    µ._mjs_navProgressStop() // navigation terminée AVANT que le seuil ne sonne

    assert.equal(timers.scheduled.size, 0, 'le timer est annulé, pas seulement ignoré')
    assert.equal(µ._mjs_navProgressTimer, null)
    assert.equal(µ._mjs_navProgressEl, null)
    assert.equal(doc.body.children.length, 0, 'aucun élément n\'a jamais été inséré')
  })
})

describe('mjs_ujs — µ._mjs_navProgressStart/Stop : navigation plus lente que le seuil', function () {
  it('le seuil sonne : élément inséré (classe + attributs), retiré à la fin de la navigation', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()
    timers.fire(µ._mjs_navProgressTimer) // le seuil sonne : la navigation traîne encore

    assert.equal(doc.body.children.length, 1)
    const el = doc.body.children[0]
    assert.equal(el.tag, 'div')
    assert.equal(el.className, 'mjs-nav-progress', 'la classe SEULE — aucun style posé en JS')
    assert.equal(el.getAttribute('role'), 'progressbar')
    assert.equal(el.getAttribute('aria-hidden'), 'true')
    assert.equal(µ._mjs_navProgressEl, el)

    µ._mjs_navProgressStop() // fin de la navigation (succès, ici)

    assert.equal(doc.body.children.length, 0, 'retiré à la fin')
    assert.equal(µ._mjs_navProgressEl, null)
    assert.equal(µ._mjs_navProgressTimer, null)
  })

  it('échec réseau / abandon : même µ._mjs_navProgressStop, l\'élément est retiré tout autant', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()
    timers.fire(µ._mjs_navProgressTimer)
    assert.equal(doc.body.children.length, 1)

    µ._mjs_navProgressStop() // échec/abandon/repli natif : TOUJOURS le même helper

    assert.equal(doc.body.children.length, 0)
  })

  it('µ._mjs_navProgressStop appelé DEUX FOIS (defensif) : pas de crash, idempotent', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart()
    timers.fire(µ._mjs_navProgressTimer)

    assert.doesNotThrow(() => { µ._mjs_navProgressStop(); µ._mjs_navProgressStop() })
    assert.equal(doc.body.children.length, 0)
  })
})

describe('mjs_ujs — µ._mjs_navProgressStart/Stop : deux navigations enchaînées', function () {
  it('un 2e µ._mjs_navProgressStart pendant que le 1er est encore en vol (timer OU élément) : jamais empilé', function () {
    const timers = fakeTimers()
    const doc = makeDoc()
    const µ: any = { config: { navProgress: true } }
    installProgress(µ, doc, timers.setTimeoutFn, timers.clearTimeoutFn)

    µ._mjs_navProgressStart() // nav 1
    const firstTimerId = µ._mjs_navProgressTimer
    µ._mjs_navProgressStart() // nav 2 démarre avant la fin de la 1re (ex. la 1re est abandonnée en vol)

    assert.equal(µ._mjs_navProgressTimer, firstTimerId, 'le 2e appel ne réarme PAS un second timer')
    assert.equal(timers.scheduled.size, 1, 'un seul timer en attente')

    timers.fire(firstTimerId)
    assert.equal(doc.body.children.length, 1, 'un seul élément inséré')
    const el = doc.body.children[0]

    µ._mjs_navProgressStart() // nav 3 démarre alors que l'élément est déjà affiché
    assert.equal(doc.body.children.length, 1, 'toujours un seul élément — pas empilé')
    assert.equal(µ._mjs_navProgressEl, el, 'même élément, pas un doublon')

    µ._mjs_navProgressStop() // fin de la DERNIÈRE navigation en vol
    assert.equal(doc.body.children.length, 0)
  })
})
