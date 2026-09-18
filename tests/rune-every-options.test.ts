// µevery — HASH D'OPTIONS (les cinq d'un coup) et
// correctif de la transition d'entrée au montage.
//
// Le hash est FACULTATIF, entre le délai et la fonction : `µevery 3000, pause: true, ->`.
// Cinq clés, vérifiées ici au montage RÉEL (happy-dom), pas sur la sortie du compilateur :
//   immediate: false  · times: n · while: -> cond · pause: true · onStop: ->
//
// Le dernier bloc couvre un défaut de FOND : une écriture faite par un
// callback de montage repassait par le fast-path SYNCHRONE de `_mjs_invalidate`, avec
// `_mjs_initial_render` encore levé — donc toute transition d'entrée sautait. C'était
// visible sur la leçon `blocs-key` : le 1er message s'affichait d'un bloc, le 2e avait
// bien son typewriter.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function monterComposant(nom: string, source: string, optsBundler: any = {}) {
  const root   = mjsTmp('every-opts')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, nom + '.mjs'), source)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...optsBundler })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const win: any = new Window({ url: 'http://localhost/' })
  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => new RegExp('^' + nom + '-').test(f))
  const animFile = files.find((f: string) => /^mjs_anims-/.test(f))            // les anims sont émises À PART (mjs_anims-<hash>.js), pas dans le core
  assert.ok(coreFile && compFile, 'core + composant compilés')
  const anims = animFile ? stripEsm(readFileSync(join(outDir, animFile), 'utf-8')) : ''
  win.eval(`${stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8'))}\nglobalThis.µ = µ;\n${anims}\n${stripEsm(readFileSync(join(outDir, compFile!), 'utf-8'))}`)
  return win
}

const dodo = (ms: number) => new Promise(r => setTimeout(r, ms))

describe('rune µevery — hash d\'options', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('`immediate: false` — pas de tir au montage, 1er tir après le délai', async function () {
    const win = await monterComposant('tardif', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 80, immediate: false, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-tardif')
    doc.body.appendChild(el)

    await dodo(40)
    assert.equal(el._state.n, 0, 'rien au montage : le 1er tir est repoussé au délai')
    await dodo(100)
    assert.ok(el._state.n >= 1, `tir après le délai (n = ${el._state.n})`)

    win.close?.()
  })

  it('`times: n` — n tirs puis arrêt automatique, sans main d\'arrêt écrite à la main', async function () {
    const win = await monterComposant('trois', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, times: 3, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-trois')
    doc.body.appendChild(el)

    await dodo(300)
    assert.equal(el._state.n, 3, 'exactement 3 tirs (le tir du montage compte pour un)')

    win.close?.()
  })

  it('`times: 1` — un seul tir, aucun intervalle posé', async function () {
    const win = await monterComposant('unique', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, times: 1, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-unique')
    doc.body.appendChild(el)

    await dodo(200)
    assert.equal(el._state.n, 1, 'un tir et c\'est tout')

    win.close?.()
  })

  it('`while: -> cond` — continue tant que vrai, et ne tire PAS le tour où la condition tombe', async function () {
    const win = await monterComposant('tantque', '<p>{$n}</p>\n<script>\n  $n = 0\n  @tirs = 0\n\n  µevery 30, while: (-> $n < 3), ->\n    @tirs = @tirs + 1\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-tantque')
    doc.body.appendChild(el)

    await dodo(300)
    assert.equal(el._state.n, 3, 'arrêté dès que la condition tombe')
    assert.equal(el.tirs, 3, 'le tour de la condition fausse ne tire pas la fonction')

    win.close?.()
  })

  it('`onStop: ->` — appelé UNE seule fois, main d\'arrêt puis démontage compris', async function () {
    const win = await monterComposant('adieu', '<p>{$n}</p>\n<script>\n  $n = 0\n  @adieux = 0\n\n  arreter = µevery 25, onStop: (-> @adieux = @adieux + 1), ->\n    $n = $n + 1\n    arreter() if $n is 2\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-adieu')
    doc.body.appendChild(el)

    await dodo(200)
    assert.equal(el._state.n, 2, 'la main d\'arrêt a bien coupé')
    assert.equal(el.adieux, 1, 'onStop appelé une fois')

    doc.body.removeChild(el)
    await dodo(120)
    assert.equal(el.adieux, 1, 'le démontage ne rappelle pas onStop (arrêt déjà consommé)')

    win.close?.()
  })

  it('`onStop: ->` — part aussi quand c\'est le DÉMONTAGE qui arrête le timer', async function () {
    const win = await monterComposant('adieu2', '<p>{$n}</p>\n<script>\n  $n = 0\n  @adieux = 0\n\n  µevery 25, onStop: (-> @adieux = @adieux + 1), ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const el: any  = doc.createElement('mjs-adieu2')
    doc.body.appendChild(el)
    await dodo(60)
    doc.body.removeChild(el)
    await dodo(120)

    assert.equal(el.adieux, 1, 'onStop appelé au démontage, quelle que soit la cause de l\'arrêt')

    win.close?.()
  })

  // L'hibernation du pageCache est le cas RÉEL : le sous-arbre quitte le DOM mais n'est
  // PAS détruit (µ._mjs_isPageCached exempte le composant de la destruction différée). Un simple
  // parking dans un <div> détaché, lui, DÉTRUIT le composant — et n'aurait rien prouvé.
  it('`pause: true` — suspend pendant l\'hibernation, reprend au retour', async function () {
    const win = await monterComposant('sieste', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 25, pause: true, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const µ: any   = (win as any).µ
    µ._mjs_isPageCached = () => true                                   // page parquée par le cache du routeur
    const el: any   = doc.createElement('mjs-sieste')
    const parc: any = doc.createElement('div')
    doc.body.appendChild(el)
    await dodo(60)

    const avant = el._state.n
    parc.appendChild(el)                                           // déconnexion → µsleep
    await dodo(150)
    assert.equal(el._state.n, avant, `suspendu pendant l'hibernation (figé à ${avant})`)

    doc.body.appendChild(el)                                       // reconnexion → µawake
    await dodo(120)
    assert.ok(el._state.n > avant, `reprend au retour dans le DOM (n = ${el._state.n})`)

    win.close?.()
  })

  // CONTRE-ÉPREUVE — sans l'option, le piège documenté (docs/16) est toujours là :
  // le timer d'une page hibernée continue de tourner hors écran.
  it('sans `pause`, le timer continue de tourner pendant l\'hibernation (défaut inchangé)', async function () {
    const win = await monterComposant('insomnie', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 25, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const µ: any   = (win as any).µ
    µ._mjs_isPageCached = () => true
    const el: any   = doc.createElement('mjs-insomnie')
    const parc: any = doc.createElement('div')
    doc.body.appendChild(el)
    await dodo(60)

    const avant = el._state.n
    parc.appendChild(el)
    await dodo(150)
    assert.ok(el._state.n > avant, `continue sans l'option (n = ${el._state.n}, avant ${avant})`)

    win.close?.()
  })

  // Le try/catch qui entoure le tick est SYNCHRONE : un corps async qui rejette APRÈS
  // son premier `await` lui échappait — aucune frontière d'erreur, `_mjs_has_crashed` jamais
  // posé, timer qui rejoue indéfiniment, et un unhandledRejection par tick (fatal sous
  // Node). Et l'exemple vedette de la doc est justement un corps `await`.
  it('corps ASYNC qui rejette : routé vers la frontière d\'erreur, pas en unhandledRejection', async function () {
    const win = await monterComposant('asyncboum', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  sonder = -> new Promise((_, ko)-> setTimeout((-> ko(new Error(\'sonde KO\'))), 5))\n\n  µevery 30, ->\n    $n = $n + 1\n    await sonder()\n</script>')
    const doc: any = win.document
    const rejets: any[] = []
    const surRejet = (e: any) => rejets.push(e)
    process.on('unhandledRejection', surRejet)

    const el: any = doc.createElement('mjs-asyncboum')
    doc.body.appendChild(el)
    await dodo(250)
    process.off('unhandledRejection', surRejet)

    assert.equal(rejets.length, 0, 'aucun rejet non traité : ' + rejets.map(String).join(' | '))
    assert.equal(el._mjs_has_crashed, true, 'l\'échec est parti vers la frontière d\'erreur du composant')
    assert.ok(el._state.n <= 2, `le timer s'arrête au lieu de rejouer son erreur (n = ${el._state.n})`)

    win.close?.()
  })

  // Une condition `while` async rend une PROMESSE, toujours vraie : la répétition ne
  // s'arrêterait jamais, en silence. On avertit et on arrête.
  it('`while` async : avertissement explicite et arrêt, au lieu d\'une boucle sans fin', async function () {
    const win = await monterComposant('whileasync', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, while: (-> Promise.resolve(false)), ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const dits: string[] = []
    const µ: any = (win as any).µ
    const brut = µ.warn
    µ.warn = (...a: any[]) => { dits.push(a.map(String).join(' ')) }

    const el: any = doc.createElement('mjs-whileasync')
    doc.body.appendChild(el)
    await dodo(200)
    µ.warn = brut

    assert.ok(dits.some(d => /while/.test(d) && /SYNCHRONE/.test(d)), 'la condition async est signalée : ' + JSON.stringify(dits))
    assert.equal(el._state.n, 0, 'arrêté avant tout tir, plutôt que de tourner sans fin')

    win.close?.()
  })

  // Clés HÉRITÉES : `for…in` les énumère. Inatteignable via le DSL (le compilateur
  // n'émet que des littéraux), mais `µ.every` est appelable directement en JS.
  it('options posées sur un PROTOTYPE : pas de faux « option inconnue »', async function () {
    const win = await monterComposant('proto', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const µ: any = (win as any).µ
    const dits: string[] = []
    const brut = µ.warn
    µ.warn = (...a: any[]) => { dits.push(a.map(String).join(' ')) }

    const el: any = doc.createElement('mjs-proto')
    doc.body.appendChild(el)
    await dodo(60)
    // appel direct, hors DSL : hash construit sur un prototype porteur d'une clé étrangère
    µ.activeComponent = el
    const opts = Object.create({ cleEtrangere: 1 })
    opts.pause = true
    const arreter = µ.every(1000, opts, () => {})
    µ.activeComponent = null
    if (typeof arreter === 'function') arreter()
    µ.warn = brut

    assert.ok(!dits.some(d => /cleEtrangere/.test(d)), 'la clé héritée ne déclenche aucun avertissement : ' + JSON.stringify(dits))

    win.close?.()
  })

  it('option inconnue : avertissement, et le timer tourne quand même', async function () {
    const win = await monterComposant('typo', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, pouse: true, ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const dits: string[] = []
    const µ: any = (win as any).µ
    const brut = µ.warn
    µ.warn = (...a: any[]) => { dits.push(a.map(String).join(' ')) }

    const el: any = doc.createElement('mjs-typo')
    doc.body.appendChild(el)
    await dodo(60)
    µ.warn = brut

    assert.ok(dits.some(d => /pouse/.test(d)), 'la faute de frappe est signalée : ' + JSON.stringify(dits))
    assert.ok(el._state.n >= 1, 'le timer tourne malgré la clé inconnue')

    win.close?.()
  })

  it('valeur de mauvais type : avertissement et repli sur le défaut de la clé', async function () {
    const win = await monterComposant('maltype', '<p>{$n}</p>\n<script>\n  $n = 0\n\n  µevery 30, times: \'trois\', ->\n    $n = $n + 1\n</script>')
    const doc: any = win.document
    const dits: string[] = []
    const µ: any = (win as any).µ
    const brut = µ.warn
    µ.warn = (...a: any[]) => { dits.push(a.map(String).join(' ')) }

    const el: any = doc.createElement('mjs-maltype')
    doc.body.appendChild(el)
    await dodo(150)
    µ.warn = brut

    assert.ok(dits.some(d => /times/.test(d)), 'le mauvais type est signalé : ' + JSON.stringify(dits))
    assert.ok(el._state.n >= 3, 'sans limite exploitable, le timer tourne sans plafond')

    win.close?.()
  })
})

// ---------------------------------------------------------------------------
// Transition d'entrée déclenchée PAR le montage.
// On espionne `µ._mjs_whenLayouted`, le premier maillon franchi APRÈS la garde
// `!_mjsThis._mjs_initial_render` du generator : s'il est appelé, l'intro est partie.
// ---------------------------------------------------------------------------
describe('µevery × transition d\'entrée : le tir du montage anime, le 1er rendu non', function () {
  this.timeout(40000)

  after(async () => { await terminateSharedWorkerPool() })

  it('un `{key}` changé par le tir de montage joue bien sa transition d\'entrée', async function () {
    const win = await monterComposant('anime', '<script>\n  $i =: -1\n\n  µevery 400, ->\n    $i = $i + 1\n</script>\n\n{key $i}\n  <p @in.fade>{$i}</p>\n{end}')
    const doc: any = win.document
    const µ: any   = (win as any).µ
    const intros: string[] = []
    µ._mjs_whenLayouted = (node: any) => { intros.push(node.tagName) }   // on n'exécute PAS l'anim : on constate qu'elle est demandée

    const el: any = doc.createElement('mjs-anime')
    doc.body.appendChild(el)
    await dodo(80)

    assert.equal(el._state.i, 0, 'le tir du montage a bien eu lieu')
    assert.deepEqual(intros, ['P'], 'intro demandée pour le <p> recréé par le changement de clé')

    win.close?.()
  })

  // CONTRE-ÉPREUVE — la règle de base tient toujours : ce que le PREMIER rendu peint
  // n'anime pas (sinon toute la page clignoterait au chargement).
  it('sans µevery, le 1er rendu ne joue AUCUNE transition d\'entrée', async function () {
    const win = await monterComposant('calme', '<script>\n  $i = 0\n</script>\n\n{key $i}\n  <p @in.fade>{$i}</p>\n{end}')
    const doc: any = win.document
    const µ: any   = (win as any).µ
    const intros: string[] = []
    µ._mjs_whenLayouted = (node: any) => { intros.push(node.tagName) }

    const el: any = doc.createElement('mjs-calme')
    doc.body.appendChild(el)
    await dodo(80)

    assert.deepEqual(intros, [], 'aucune intro sur le rendu initial')

    win.close?.()
  })
})
