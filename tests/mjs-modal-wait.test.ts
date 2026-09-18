// Tests neufs — µ.modal.wait(arg) (mjs_modal.ts) : modale d'attente — spinner,
// zéro bouton, non fermable par l'utilisateur (allowOutsideClick/allowEscapeKey false, pas de
// timer par défaut), titre par défaut 'Veuillez patienter…', arg chaîne/objet même convention
// que les raccourcis. Rend { close() } qui résout la modale sous-jacente en
// {isDismissed:true, dismiss:'close'}. Même méthode que mjs-modal-fire.test.ts (cf. son en-tête).

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
function backdropEl(document: any): any {
  return document.body.querySelector('.mjs-modal-backdrop')
}
function wait(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

describe('mjs_modal — µ.modal.wait (modale d\'attente)', function () {
  it('spinner présent (div.mjs-modal-spinner)', function () {
    const { document, µ } = loadModal()
    µ.modal.wait()
    assert.ok(box(document).querySelector('.mjs-modal-spinner'))
  })

  it('zéro bouton', function () {
    const { document, µ } = loadModal()
    µ.modal.wait()
    assert.equal(box(document).querySelectorAll('.mjs-modal-btn').length, 0)
  })

  it("titre par défaut 'Veuillez patienter…'", function () {
    const { document, µ } = loadModal()
    µ.modal.wait()
    assert.equal(box(document).querySelector('.mjs-modal-title').textContent, 'Veuillez patienter…')
  })

  it('focus initial sur la boîte (tabindex="-1", zéro bouton/input — même repli que showConfirmButton:false)', function () {
    const { document, µ } = loadModal()
    µ.modal.wait()
    assert.equal(document.activeElement, box(document))
  })

  it('allowOutsideClick:false — clic backdrop ne ferme PAS', async function () {
    const { window, document, µ } = loadModal()
    µ.modal.wait()
    backdropEl(document).dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    await wait(20)
    assert.ok(box(document), 'reste ouverte')
  })

  it('allowEscapeKey:false — Échap ne ferme PAS', async function () {
    const { window, document, µ } = loadModal()
    µ.modal.wait()
    document.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }))
    await wait(20)
    assert.ok(box(document), 'reste ouverte')
  })

  it('pas de timer par défaut — ne se ferme jamais toute seule', async function () {
    const { document, µ } = loadModal()
    µ.modal.wait()
    await wait(30)
    assert.ok(box(document), 'toujours ouverte')
  })

  it('close() (handle rendu) ferme effectivement la modale', function () {
    const { document, µ } = loadModal()
    const handle = µ.modal.wait()
    assert.ok(box(document), 'ouverte avant close()')
    handle.close()
    assert.equal(box(document), null, 'fermée après close()')
  })

  it("close() résout la modale sous-jacente avec {isConfirmed:false, isDenied:false, isDismissed:true, value:undefined, dismiss:'close'}", async function () {
    const { µ } = loadModal()
    let capturedPromise: any = null
    const origFire = µ.modal.fire
    µ.modal.fire = function (opts: any) { capturedPromise = origFire(opts); return capturedPromise }
    const handle = µ.modal.wait()
    µ.modal.fire = origFire
    assert.ok(capturedPromise, 'fire() doit avoir été appelé en interne')
    handle.close()
    const r = await capturedPromise
    assert.equal(r.isConfirmed, false)
    assert.equal(r.isDenied, false)
    assert.equal(r.isDismissed, true)
    assert.equal(r.value, undefined)
    assert.equal(r.dismiss, 'close')
  })

  it('arg chaîne → text (titre par défaut conservé)', function () {
    const { document, µ } = loadModal()
    µ.modal.wait('Téléversement en cours')
    const b = box(document)
    assert.equal(b.querySelector('.mjs-modal-content').textContent, 'Téléversement en cours')
    assert.equal(b.querySelector('.mjs-modal-title').textContent, 'Veuillez patienter…')
  })

  it("arg objet → fusionné PAR-DESSUS les défauts (l'objet gagne, ex. titre overridé)", function () {
    const { document, µ } = loadModal()
    µ.modal.wait({ title: 'Patiente...' })
    assert.equal(box(document).querySelector('.mjs-modal-title').textContent, 'Patiente...')
  })

  // DÉFAUT — une SEULE variable globale retenait « la » modale courante. Une modale ouverte
  // par-dessus l'écrasait, et la poignée rendue par wait() — qui passait par µ.modal.close() —
  // fermait alors la MAUVAISE. Le spinner restait à l'écran pour toujours : son keydown global
  // jamais retiré, sa promesse jamais résolue, le focus jamais rendu.
  //
  // ⚠ Les assertions ne portent QUE sur des booléens/nombres : passer un nœud happy-dom à
  // `assert.equal` fait sérialiser l'arbre entier pour le message d'écart — la suite s'y fige.
  describe('poignée liée à SA modale, jamais à « la modale courante »', function () {
    it('un success() ouvert par-dessus : close() ferme bien le SPINNER, pas le success', async function () {
      const { document, µ } = loadModal()
      const attente = µ.modal.wait('Chargement…')
      µ.modal.success('Étape 1 finie')                       // progression affichée par-dessus
      attente.close()
      await wait(0)
      assert.equal(document.body.querySelectorAll('.mjs-modal-box').length, 1, 'une seule boîte doit rester ouverte')
      assert.equal(!!document.body.querySelector('.mjs-modal-spinner'), false, "AVANT : c'est le success qui se fermait, le spinner restait à vie")
    })

    it('µ.modal.close() ne devient pas muet quand une modale se ferme sous une autre', async function () {
      const { document, µ } = loadModal()
      const attente = µ.modal.wait('Chargement…')
      µ.modal.success('par-dessus')
      attente.close()                        // ferme le spinner ; ne doit PAS oublier le success
      await wait(0)
      µ.modal.close()                        // doit fermer le success resté ouvert
      await wait(0)
      assert.equal(document.body.querySelectorAll('.mjs-modal-box').length, 0, 'AVANT : la référence globale était mise à null par la modale qui se fermait')
    })

    it('la promesse du spinner est résolue par SA poignée (isDismissed, dismiss:close)', async function () {
      const { µ } = loadModal()
      let recu: any = null
      µ.modal.fire({ title: 'Attente', spinner: true, showConfirmButton: false, allowOutsideClick: false, allowEscapeKey: false }).then((r: any) => { recu = r })
      // la poignée de wait() est le mécanisme visé ; ici on prouve la symétrie via µ.modal.close()
      µ.modal.close()
      await wait(0)
      assert.equal(recu && recu.isDismissed, true)
      assert.equal(recu && recu.dismiss, 'close')
    })
  })

})
