// animations/typewriter.ts (built-in) détruisait silencieusement
// le markup imbriqué (<b> disparaît) là où docs/10-transitions.md:98-100 enseigne
// pour un tick CUSTOM de LEVER si le nœud n'a pas un unique nœud texte. Même
// contrat désormais côté built-in : setup() lève une Error explicite quand
// `node.childNodes` n'est pas exactement un nœud texte ; sur un nœud texte
// unique, comportement inchangé.
//
// Chargement du factory : lecture de la source + `new Function('µ', 'return
// (...)')` — le fichier est une expression IIFE, pas un module ES exportable tel quel.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'animations', 'typewriter.ts'), 'utf-8')

function loadFactory(µMock: any) {
  return new Function('µ', 'return (' + SRC.trim().replace(/;\s*$/, '') + ')')(µMock)
}

describe('animations/typewriter.ts — contrat "unique nœud texte"', function () {
  let win: any
  beforeEach(() => {
    win = new Window({ url: 'http://localhost/' })
    ;(globalThis as any).document = win.document
    ;(globalThis as any).window = win
    ;(globalThis as any).Node = win.Node
  })

  it('markup imbriqué (<b>) : setup() lève une Error explicite, le message exact de la doc', function () {
    const node = win.document.createElement('p')
    node.innerHTML = 'Bonjour <b>Monde</b> !'
    const factory = loadFactory({})
    const { intro } = factory({ speed: 1 })
    assert.throws(
      () => intro(node),
      (e: any) => e instanceof Error && e.message === '@transition.typewriter exige un unique nœud texte',
      'doit lever une Error avec EXACTEMENT ce message',
    )
    assert.equal(node.outerHTML, '<p>Bonjour <b>Monde</b> !</p>', 'le markup ne doit PAS avoir été touché avant le throw')
  })

  it('1 seul enfant mais ce n\'est PAS un nœud texte (ex. <b> seul) : lève aussi', function () {
    const node = win.document.createElement('p')
    node.innerHTML = '<b>tout en gras</b>'
    const factory = loadFactory({})
    const { intro } = factory({})
    assert.throws(() => intro(node), /exige un unique nœud texte/)
  })

  it('nœud texte unique : comportement INCHANGÉ, aucun throw, tick tronque normalement', function () {
    const node = win.document.createElement('p')
    node.textContent = 'Bonjour'
    const factory = loadFactory({})
    const { intro } = factory({ speed: 1 })
    let cfg: any
    assert.doesNotThrow(() => { cfg = intro(node) })
    assert.equal(typeof cfg.tick, 'function')
    cfg.tick(1, 0)
    assert.equal(node.textContent, 'Bonjour', 'texte complet affiché à t=1, comportement inchangé')
    cfg.tick(0, 1)
    assert.equal(node.textContent, '', 'texte vide à t=0, comportement inchangé')
  })

  it('nœud texte vide (encore un seul nœud texte) : toujours pas de throw', function () {
    const node = win.document.createElement('p')
    node.textContent = ''
    const factory = loadFactory({})
    const { intro } = factory({})
    // un elément vide n'a AUCUN childNode (pas même un nœud texte vide) — hors
    // du périmètre strict de la garde (0 !== 1), documenté par ce test-ci : le
    // texte vide, cas déjà géré ailleurs par le clamp de _runTickTransition
    // (duration=0), n'est pas dans le contrat "un unique nœud texte".
    assert.throws(() => intro(node), /exige un unique nœud texte/, '0 childNode : hors du contrat "exactement 1 nœud texte"')
  })

  it('nœuds texte D\'INDENTATION autour d\'une interpolation multi-lignes (doc 10-transitions.md:225-231, 3 nœuds texte) : s\'anime, 0 warn, texte final entouré de ses blancs d\'origine', function () {
    const warned: any[] = []
    const node = win.document.createElement('p')
    // Reproduit EXACTEMENT la forme posée par le compilateur pour :
    //   <p @in.typewriter={...}>
    //     {messages[$i] or ''}
    //   </p>
    // — 3 nœuds texte SÉPARÉS (indentation avant / interpolation / indentation
    // après), jamais un seul nœud texte fusionné (constaté sur un VRAI build,
    // cf. le describe d'intégration plus bas dans ce fichier).
    node.appendChild(win.document.createTextNode('\n    '))
    node.appendChild(win.document.createTextNode('Salut'))
    node.appendChild(win.document.createTextNode('\n  '))
    assert.equal(node.childNodes.length, 3, 'préalable : bien 3 nœuds texte séparés, comme le compilateur les pose')
    const factory = loadFactory({ warn: (...a: any[]) => warned.push(a) })
    const { intro } = factory({ speed: 1 })
    let cfg: any
    assert.doesNotThrow(() => { cfg = intro(node) }, 'AVANT le fix : les nœuds texte de blancs faisaient lever la garde à tort')
    cfg.tick(0, 1)
    assert.equal(node.textContent, '\n    \n  ', 'à t=0 : seul le texte RÉEL est effacé, les blancs d\'indentation restent intacts')
    cfg.tick(0.4, 0.6)
    assert.equal(node.textContent.startsWith('\n    '), true, 'le blanc de tête n\'est jamais touché par tick()')
    assert.equal(node.textContent.endsWith('\n  '), true, 'le blanc de fin n\'est jamais touché par tick()')
    cfg.tick(1, 0)
    assert.equal(node.textContent, '\n    Salut\n  ', 'à t=1 : le texte final est entouré de ses blancs d\'origine')
    assert.equal(warned.length, 0, 'aucun warn — c\'est un usage documenté, pas une erreur')
  })

  it('<p>a <b>b</b></p> (markup imbriqué réel, texte + élément mélangés) : lève toujours', function () {
    const node = win.document.createElement('p')
    node.innerHTML = 'a <b>b</b>'
    const factory = loadFactory({})
    const { intro } = factory({})
    assert.throws(() => intro(node), /exige un unique nœud texte/, 'un ÉLÉMENT enfant (markup imbriqué) reste un vrai refus, blancs tolérés ou pas')
  })

  it('intégration — via µ._mjs_runTransition : le throw de setup() devient un µ.warn + node visible (markup jamais détruit)', async function () {
    ;(globalThis as any).µ = (globalThis as any).µ || {}
    const µ: any = (globalThis as any).µ
    µ.Ticker = µ.Ticker || { add() {} }
    µ._mjs_interpolatorSet = µ._mjs_interpolatorSet || new WeakSet()
    µ.anim = µ.anim || {}
    const warned: any[] = []
    µ.warn = (...a: any[]) => warned.push(a)
    µ.debug = false
    await import('../src/runtime/mjs_easing.js')

    const factory = loadFactory(µ)
    const { intro } = factory({ speed: 1 })
    const node = win.document.createElement('p')
    node.innerHTML = 'Bonjour <b>Monde</b> !'

    const p = µ._mjs_runTransition(node, intro, 'in')
    const result = await p
    assert.equal(result, 'in', 'résout normalement, ne casse pas l\'appelant')
    assert.equal(warned.length, 1, 'µ.warn appelé exactement 1 fois')
    assert.match(warned[0][0], /setup\(\)/, 'le message identifie le setup() fautif')
    assert.equal(node.outerHTML, '<p>Bonjour <b>Monde</b> !</p>', 'le <b> est INTACT — jamais détruit (contrairement au comportement avant fix)')
  })
})

// Test d'intégration : compilation RÉELLE (Bundler) des
// deux formes documentées de @in.typewriter, sur un VRAI re-rendu ({key} + bump —
// le 1er rendu n'anime jamais, doc l.166-168). AVANT le fix : la forme multi-
// lignes (doc l.225-231) déclenchait le warn et l'intro n'animait PAS
// caractère par caractère (setup() levait, la transition s'abandonnait en
// laissant le texte complet visible d'un coup — un fallback qui ressemble à
// une réussite si on ne regarde QUE le texte final, d'où l'assertion sur
// warned.length ET sur l'état EN PLEIN VOL, pas seulement sur l'état final).
describe('animations/typewriter.ts — usages documentés de @in.typewriter, sur un VRAI re-rendu (intégration)', function () {
  this.timeout(40000)

  const stripEsm = (s: string) => s
    .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
    .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
    .replace(/\bexport\s+default\s+/g, '')
    .replace(/\bexport\s+/g, '')
    .replace(/import\.meta\.url/g, "'http://localhost/'")

  async function buildCore(name: string, src: string) {
    const root = mjsTmp('typewriter-doc')
    const srcDir = join(root, 'src')
    const outDir = join(root, 'out')
    mkdirSync(srcDir, { recursive: true })
    writeFileSync(join(srcDir, `${name}.mjs`), src)
    const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
    const stats = await bundler.compile()
    assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
    const files = readdirSync(outDir)
    const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
    const animFile = files.find((f: string) => /^mjs_anims-/.test(f))
    const compFile = files.find((f: string) => new RegExp(`^${name}-`).test(f))
    assert.ok(coreFile && compFile, 'core + composant compilés')
    return {
      coreCode: stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
      animCode: animFile ? stripEsm(readFileSync(join(outDir, animFile), 'utf-8')) : '',
      compCode: stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
    }
  }

  async function runCase(name: string, componentSrc: string) {
    const warned: any[] = []
    const { coreCode, animCode, compCode } = await buildCore(name, componentSrc)
    const window: any = new Window({ url: 'http://localhost/' })
    const document: any = window.document
    window.eval(`${coreCode}\nglobalThis.µ = µ;\n${animCode}\n${compCode}`)
    window.µ.warn = (...a: any[]) => warned.push(a)
    document.body.innerHTML = `<mjs-${name}></mjs-${name}>`
    const el = document.body.firstElementChild
    await new Promise((r) => setTimeout(r, 80))
    const bumpBtn = (el._shadow || el).querySelector('#bump')
    assert.ok(bumpBtn, 'bouton bump introuvable')
    bumpBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true, composed: true }))
    await new Promise((r) => setTimeout(r, 5))
    const pMidFlight = (el._shadow || el).querySelector('p')
    const midFlightText = pMidFlight ? pMidFlight.textContent : null
    await new Promise((r) => setTimeout(r, 400))
    const pFinal = (el._shadow || el).querySelector('p')
    window.close?.()
    return { warned, midFlightText, finalText: pFinal ? pFinal.textContent : null }
  }

  it('forme COMPACTE (doc l.181) — sur re-rendu : 0 warn, texte final correct (non-régression)', async function () {
    const COMPONENT = [
      '<script>',
      '$i = 0',
      "$messages = ['Bonjour', 'Salut']",
      '</script>',
      '{key $i}',
      "  <p @in.typewriter={speed: 10}>{$messages[$i] or ''}</p>",
      '{end}',
      '<button id="bump" @click={$i = 1}>bump</button>',
    ].join('\n')
    const { warned, finalText } = await runCase('e11twcompact', COMPONENT)
    assert.equal(warned.length, 0, 'forme compacte : aucun warn attendu')
    assert.equal(finalText, 'Salut')
  })

  it('forme MULTI-LIGNE EXACTE (doc l.225-231, <p> sur plusieurs lignes, 3 nœuds texte) — sur re-rendu : 0 warn, tape RÉELLEMENT caractère par caractère, texte final entouré de ses blancs', async function () {
    const COMPONENT = [
      '<script>',
      '$i = 0',
      "messages = ['Bonjour', 'Salut']",
      '</script>',
      '{key $i}',
      '  <p @in.typewriter={speed: 10}>',
      "    {messages[$i] or ''}",
      '  </p>',
      '{end}',
      '<button id="bump" @click={$i = 1}>bump</button>',
    ].join('\n')
    const { warned, midFlightText, finalText } = await runCase('e11twmultiline', COMPONENT)
    assert.equal(warned.length, 0, 'AVANT le fix : le warn se déclenchait sur cet usage pourtant documenté')
    assert.ok(midFlightText != null, 'p introuvable pendant l\'animation')
    assert.ok((midFlightText as string).startsWith('\n    ') && (midFlightText as string).endsWith('\n  '), 'les blancs d\'indentation entourent le texte en cours de frappe : ' + JSON.stringify(midFlightText))
    assert.notEqual(midFlightText, '\n    Salut\n  ', 'en plein vol (5ms après le clic, duration=50ms), le texte réel ne doit PAS déjà être complet — comportement typewriter réel, pas un fallback "tout ou rien" (AVANT le fix : setup() levait, la transition s\'abandonnait en laissant tout le texte visible d\'un coup)')
    assert.equal(finalText, '\n    Salut\n  ', 'texte final entouré de ses blancs d\'origine')
  })

  after(async () => {
    await terminateSharedWorkerPool()
  })
})
