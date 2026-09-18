// µevery — rune TIMER de composant :
// tire une PREMIÈRE fois au montage, puis toutes les N ms, et se nettoie au démontage.
//
// Trois contrats vérifiés au montage RÉEL (happy-dom), pas sur la sortie du compilateur :
//   1. le 1er tir a lieu tout de suite (c'est la raison d'être de la rune) ;
//   2. il coexiste avec un `µmount ->` de l'utilisateur — la file `_mjs_mount_cbs` ne
//      passe PAS par `_mjs_hooks.mount`, qui n'a qu'une case par nom (piège des deux µmount) ;
//   3. le démontage arrête l'intervalle (sinon fuite + effet de bord sur DOM détaché).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'
import { cleanJs } from '../src/generator/utils.ts'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// compile un composant unique et rend une fenêtre happy-dom prête à le monter
async function monterComposant(nom: string, source: string) {
  const root   = mjsTmp('every')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, nom + '.mjs'), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any      = new Window({ url: 'http://localhost/' })
  const files         = readdirSync(outDir)
  const coreFile      = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile      = files.find((f: string) => new RegExp('^' + nom + '-').test(f))
  assert.ok(coreFile && compFile, 'core + composant compilés')
  win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  return win
}

describe('rune µevery — timer de composant (tir immédiat, période, nettoyage)', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('tire DÈS le montage, puis à intervalle, et s\'arrête au démontage', async function () {
    const win = await monterComposant('tictac', '<p>{$n}</p>\n<script>\n$n = 0\nµevery 40, ->\n  $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-tictac')
    doc.body.appendChild(el)

    // 1er tir : immédiat (après le 1er rendu, donc bien avant 40 ms)
    await new Promise(r => setTimeout(r, 25))
    assert.equal(el._state.n, 1, 'le 1er tir a lieu au montage, pas au bout du délai')

    // puis la période
    await new Promise(r => setTimeout(r, 100))
    const apres = el._state.n
    assert.ok(apres >= 3, `intervalle actif (n = ${apres}, attendu ≥ 3)`)

    // démontage → clearInterval (teardown définitif, cf. _mjs_onDestroy)
    doc.body.removeChild(el)
    await new Promise(r => setTimeout(r, 150))
    const fige = el._state.n
    await new Promise(r => setTimeout(r, 120))
    assert.equal(el._state.n, fige, `le timer est arrêté au démontage (n figé à ${fige})`)

    win.close?.()
  })

  it('coexiste avec un `µmount ->` de l\'utilisateur (aucun des deux n\'écrase l\'autre)', async function () {
    const win = await monterComposant('duo', '<p>{$n}</p>\n<script>\n$n = 0\n@vuAuMontage = false\nµmount ->\n  @vuAuMontage = true\nµevery 40, ->\n  $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-duo')
    doc.body.appendChild(el)
    await new Promise(r => setTimeout(r, 25))

    assert.equal(el.vuAuMontage, true, 'le µmount utilisateur a bien joué')
    assert.equal(el._state.n, 1, 'le µevery a bien tiré, sans écraser le hook')

    win.close?.()
  })

  it('deux µevery dans le même composant tournent tous les deux', async function () {
    const win = await monterComposant('paire', '<p>{$a}/{$b}</p>\n<script>\n$a = 0\n$b = 0\nµevery 40, ->\n  $a = $a + 1\nµevery 40, ->\n  $b = $b + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-paire')
    doc.body.appendChild(el)
    await new Promise(r => setTimeout(r, 25))

    assert.equal(el._state.a, 1, '1er µevery tiré')
    assert.equal(el._state.b, 1, '2e µevery tiré (la file est une LISTE, pas une case)')

    win.close?.()
  })

  // Exemple DOCUMENTÉ (docs/16-cycle-de-vie.md) : la main d'arrêt rendue par la rune,
  // appelée depuis le corps lui-même — compte à rebours qui se coupe tout seul.
  it("rend une main d'arrêt : le compte à rebours s'arrête sur place", async function () {
    const win = await monterComposant('rebours', '<p>{$reste}</p>\n<script>\n  $reste = 3\n\n  arreter = µevery 30, ->\n    $reste = $reste - 1\n    arreter() if $reste is 0\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-rebours')
    doc.body.appendChild(el)

    await new Promise(r => setTimeout(r, 250))
    assert.equal(el._state.reste, 0, 'arrêté pile à 0, sans passer en négatif')

    win.close?.()
  })

  // Composant CRASHÉ : tout le reste du runtime s'arrête sur `_mjs_has_crashed` — le timer
  // aussi, sinon il rejoue son erreur à chaque période (39 fois en 200 ms avant correctif).
  it('un tick qui jette arrête le timer au lieu de boucler sur son erreur', async function () {
    const win = await monterComposant('boum', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 20, ->\n    $n = $n + 1\n    throw new Error(\'boum\')\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-boum')
    doc.body.appendChild(el)

    await new Promise(r => setTimeout(r, 220))
    assert.equal(el._state.n, 1, 'un seul tick : le composant crashé ne rejoue pas son erreur en boucle')

    win.close?.()
  })

  // Retiré du DOM avant même d'avoir été monté : la file de montage ne doit rien démarrer.
  it('retiré avant le montage : aucun tick', async function () {
    const win = await monterComposant('mortne', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 20, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-mortne')
    doc.body.appendChild(el)
    doc.body.removeChild(el)

    await new Promise(r => setTimeout(r, 200))
    assert.equal(el._state.n, 0, 'jamais monté pour de bon → jamais démarré')

    win.close?.()
  })

  // La rune se pose au SETUP du composant : hors d'un <script>, elle n'a personne à qui
  // s'accrocher et finirait en ReferenceError muet au navigateur. Même garde que µderived.
  it('refusée dans une interpolation / un handler', () =>
    assert.throws(() => cleanJs('µevery 1000, -> 1'), /µevery/))
})
