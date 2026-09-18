// Tests neufs — validation des options de `µ.modal.fire()` (__modalNormalize, mjs_modal.ts).
//
// Le problème résolu : tout le corps de fire() vit dans l'executor de `new Promise(...)`, où la
// moindre exception est convertie en REJET par le constructeur de Promise. L'en-tête du fichier
// promettait « jamais de rejet » ; 8 entrées hostiles sur 13 le démentaient. La parade retenue :
// valider ET RECOPIER les options AVANT la promesse.
//
// Deux propriétés à tenir, et ce fichier les vérifie séparément :
//   A. un appel MALFORMÉ lève SYNCHRONEMENT, avec un message qui nomme l'option fautive — donc
//      aucune promesse n'existe, donc aucun rejet possible ;
//   B. un appel BIEN FORMÉ, même avec des valeurs pénibles (getters qui changent de réponse,
//      objets sans prototype, Map d'un autre réalm), produit une promesse qui ne rejette JAMAIS.
//
// La recopie compte autant que la validation : un getter peut renvoyer une valeur saine à la
// vérification et une bombe à la seconde lecture. C'est l'objet du test « lu une seule fois ».

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

function box(document: any): any {
  return document.body.querySelector('.mjs-modal-box')
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

// Lance `fire(options)` et rapporte ce qui s'est réellement passé : une exception synchrone, un
// rejet de promesse, ou une résolution. Sert à prouver qu'on est TOUJOURS dans le premier ou le
// troisième cas, jamais le deuxième.
async function outcome(µ: any, options: any): Promise<{ threw: any; rejected: any; promise: any }> {
  let threw: any = null
  let rejected: any = null
  let promise: any = null
  try {
    promise = µ.modal.fire(options)
    promise.then(() => {}, (e: any) => { rejected = e })
  } catch (e) {
    threw = e
  }
  await wait(20)
  return { threw, rejected, promise }
}

describe('mjs_modal — validation des options (aucun rejet de promesse, jamais)', function () {
  // --------------------------------------------------------------------------
  // A. appels malformés → exception SYNCHRONE nommée
  // --------------------------------------------------------------------------

  it('un `title` dont le toString explose : lève en nommant `title`, pas de promesse', async function () {
    const { µ } = loadModal()
    const piege = { toString() { throw new Error('boum') } }
    const r = await outcome(µ, { title: piege })
    assert.ok(r.threw, 'doit lever SYNCHRONEMENT')
    assert.match(String(r.threw.message), /`title`/, "le message doit nommer l'option fautive")
    assert.match(String(r.threw.message), /boum/, "et rapporter la cause d'origine")
    assert.equal(r.rejected, null)
    assert.equal(r.promise, null, 'aucune promesse ne doit avoir été créée')
  })

  it('un getter piégé (`customClass` qui lève à la lecture) : lève en nommant le chemin complet', async function () {
    const { µ } = loadModal()
    const opts: any = {}
    Object.defineProperty(opts, 'customClass', { get() { throw new Error('accès refusé') }, enumerable: true })
    const r = await outcome(µ, opts)
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /customClass/)
    assert.equal(r.rejected, null)
  })

  it('une classe personnalisée qui n\'est pas du texte : chemin `customClass.<clé>` dans le message', async function () {
    const { µ } = loadModal()
    const r = await outcome(µ, { customClass: { box: Symbol('nope') } })
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /customClass\.box/)
    assert.equal(r.rejected, null)
  })

  it('`preConfirm` qui n\'est pas une fonction : lève, type reçu indiqué', async function () {
    const { µ } = loadModal()
    const r = await outcome(µ, { preConfirm: 'plus tard' })
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /`preConfirm`.*fonction.*string/s)
    assert.equal(r.rejected, null)
  })

  it('`timer: NaN` : lève (un nombre non fini n\'est pas une durée)', async function () {
    const { µ } = loadModal()
    const r = await outcome(µ, { timer: NaN })
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /`timer`/)
    assert.equal(r.rejected, null)
  })

  it('`inputOptions` d\'un type impossible (nombre) : lève', async function () {
    const { µ } = loadModal()
    const r = await outcome(µ, { input: 'select', inputOptions: 42 })
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /`inputOptions`.*objet.*Map/s)
    assert.equal(r.rejected, null)
  })

  it('options d\'un type impossible (chaîne au lieu d\'un objet) : lève', async function () {
    const { µ } = loadModal()
    const r = await outcome(µ, 'confirmer ?')
    assert.ok(r.threw)
    assert.match(String(r.threw.message), /options.*objet.*string/s)
    assert.equal(r.rejected, null)
  })

  it('`icon` d\'un type faux (nombre) : lève ; mais un NOM inconnu se contente d\'un avertissement', async function () {
    const { µ, warnings, document } = loadModal()
    const r = await outcome(µ, { icon: 3 })
    assert.ok(r.threw, 'un type faux est une erreur de programmation → lève')

    // Doctrine : type juste + valeur inconnue = tolérance documentée, mais plus jamais du silence.
    const b = loadModal()
    b.µ.modal.fire({ icon: 'succes', title: 'coquille' })   // « success » mal orthographié
    assert.equal(b.warnings.length, 1, 'exactement un avertissement')
    assert.match(b.warnings[0], /icône inconnue.*succes/)
    assertAbsent(box(b.document).querySelector('.mjs-modal-icon'), 'aucune icône posée')
    assert.ok(box(b.document).querySelector('.mjs-modal-title'), 'le reste de la modale s\'affiche normalement')
    assert.equal(warnings.length, 0)
    assert.ok(document)
  })

  it('`input` inconnu : avertissement + repli sur « text » (comportement historique préservé)', function () {
    const { µ, warnings, document } = loadModal()
    µ.modal.fire({ input: 'radio' })
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /input inconnu.*radio.*text/s)
    const el = box(document).querySelector('.mjs-modal-input')
    assert.equal(el.tagName, 'INPUT')
    assert.equal(el.type, 'text')
  })

  // --------------------------------------------------------------------------
  // B. appels bien formés, valeurs pénibles → aucune exception, aucun rejet
  // --------------------------------------------------------------------------

  it('chaque option n\'est lue QU\'UNE FOIS : un getter qui se piège au 2e appel ne peut pas nuire', async function () {
    const { µ } = loadModal()
    let lectures = 0
    const opts: any = { showCancelButton: true }
    Object.defineProperty(opts, 'title', {
      enumerable: true,
      get() { lectures++; if (lectures > 1) { throw new Error('2e lecture piégée') } return 'Titre' },
    })
    const r = await outcome(µ, opts)
    assert.equal(r.threw, null, 'aucune exception : la valeur saine du 1er appel a été recopiée')
    assert.equal(r.rejected, null, 'et surtout aucun rejet')
    assert.equal(lectures, 1, "c'est tout l'enjeu : on recopie, on ne se contente pas de valider")
  })

  it('un objet sans prototype (Object.create(null)) reste accepté', async function () {
    const { µ, document } = loadModal()
    const opts: any = Object.create(null)
    opts.title = 'Sans prototype'
    opts.text = 'ça marche'
    const r = await outcome(µ, opts)
    assert.equal(r.threw, null)
    assert.equal(r.rejected, null)
    assert.equal(box(document).querySelector('.mjs-modal-title').textContent, 'Sans prototype')
  })

  it('une vraie Map en `inputOptions` : options rendues dans l\'ordre d\'insertion, aucun rejet', async function () {
    const { µ, document } = loadModal()
    const r = await outcome(µ, { input: 'select', inputOptions: new Map([['x', 'Xray'], ['y', 'Yankee']]) })
    assert.equal(r.threw, null)
    assert.equal(r.rejected, null)
    const rendus = Array.from(box(document).querySelectorAll('option')) as any[]
    assert.deepEqual(rendus.map((o) => [o.value, o.textContent]), [['x', 'Xray'], ['y', 'Yankee']])
  })

  it('valeurs non textuelles mais convertibles (nombre, booléen) : converties, pas refusées', async function () {
    const { µ, document } = loadModal()
    const r = await outcome(µ, { title: 42, text: true, confirmButtonText: 7 })
    assert.equal(r.threw, null)
    assert.equal(r.rejected, null)
    assert.equal(box(document).querySelector('.mjs-modal-title').textContent, '42')
    assert.equal(box(document).querySelector('.mjs-modal-content').textContent, 'true')
    assert.equal(box(document).querySelector('.mjs-modal-confirm').textContent, '7')
  })

  it('`fire()` sans argument, et `fire(null)` : modale par défaut, aucune erreur', async function () {
    for (const arg of [undefined, null]) {
      const { µ, document } = loadModal()
      const r = await outcome(µ, arg)
      assert.equal(r.threw, null, `fire(${String(arg)}) ne doit pas lever`)
      assert.equal(r.rejected, null)
      assert.ok(box(document).querySelector('.mjs-modal-confirm'), 'un bouton de confirmation par défaut')
    }
  })

  it('le chemin réellement emprunté par @confirm reste intact de bout en bout', async function () {
    const { µ, document } = loadModal()
    // Exactement les options que mjs_ujs.ts passe (µ.config.confirm = true) — le seul appel
    // interne au framework, celui qui ne doit jamais casser.
    const p = µ.modal.fire({ text: 'Supprimer ?', icon: 'question', showCancelButton: true })
    let rejected: any = null
    p.then(() => {}, (e: any) => { rejected = e })
    assert.equal(box(document).querySelector('.mjs-modal-content').textContent, 'Supprimer ?')
    assert.ok(box(document).querySelector('.mjs-modal-icon-question'))
    assert.ok(box(document).querySelector('.mjs-modal-cancel'))
    box(document).querySelector('.mjs-modal-confirm').click()
    const res = await p
    assert.equal(res.isConfirmed, true)
    assert.equal(rejected, null)
  })

  it('inputValue : booléen pour une case à cocher, texte pour le reste (normalisation par type)', async function () {
    const a = loadModal()
    await outcome(a.µ, { input: 'checkbox', inputValue: 'une chaîne non vide' })
    assert.equal((box(a.document).querySelector('.mjs-modal-input') as any).checked, true)

    const b = loadModal()
    await outcome(b.µ, { input: 'text', inputValue: 1234 })
    assert.equal((box(b.document).querySelector('.mjs-modal-input') as any).value, '1234')
  })
})
