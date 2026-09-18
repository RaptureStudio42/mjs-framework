// Bibliothèque de préréglages @viewTransition (mjs_vt_presets.ts) + leur branchement
// UJS (swap du contenant de navigation enveloppé dans document.startViewTransition quand
// la garde ET la résolution sont actives) + conversion de la directive de lien @pageTransition → mjs-vt
// (compilateur, même famille que @confirm/@method, cf. tests/preload.test.ts pour le
// précédent le plus proche). mjs_ujs.ts attache des listeners PERMANENTS dès l'import —
// même convention que les autres tests ujs-*.test.ts : extraction du corps SOURCE (regex
// + comptage d'accolades), exécutée via `new Function`, jamais le fichier entier chargé.

import { strict as assert } from 'node:assert'
import { readFileSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { extractMarked, extractMarkedBody } from './helpers/extract-marked.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'
import { transpile } from '../src/transpiler/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const VT_PRESETS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_vt_presets.ts'), 'utf-8')
const UJS_SRC = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_ujs.ts'), 'utf-8')

// ════════════════════════════════════════════════════════════════════════════
// mjs_vt_presets.ts — la bibliothèque elle-même
// ════════════════════════════════════════════════════════════════════════════
function loadVtPresets(µ: any, doc: any) {
  new Function('µ', 'document', VT_PRESETS_SRC)(µ, doc)
}

function makeFakeDocument() {
  const byId = new Map<string, any>()
  return {
    getElementById(id: string) { return byId.has(id) ? byId.get(id) : null },
    createElement(tag: string) { return { tagName: String(tag).toUpperCase(), id: '', textContent: '' } },
    head: {
      appendChild(el: any) { if (el && el.id) byId.set(el.id, el) },
    },
  }
}

describe('mjs_vt_presets — bibliothèque de préréglages', function () {
  it('bases pseudos + rideaux en phase avec config.ts', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    assert.deepEqual(Object.keys(µ._vtPresets).sort(), ['cube', 'fade', 'flip', 'reveal', 'slide', 'turn', 'volet', 'zoom', 'zoom-out'].sort())
    assert.deepEqual(Object.keys(µ._mjs_vtCurtains).sort(), ['bars', 'blocks', 'iris', 'swipe'].sort())
  })

  const pseudoBases = (() => {
    const µ0: any = { warn() {} }
    loadVtPresets(µ0, makeFakeDocument())
    return Object.keys(µ0._vtPresets)
  })()

  for (const name of pseudoBases) {
    it(`préréglage '${name}' : CSS non vide ciblant ::view-transition-old/new(root)`, () => {
      const µ: any = { warn() {} }
      loadVtPresets(µ, makeFakeDocument())
      const entry = µ._vtPresets[name]
      const css = typeof entry === 'function' ? entry('left') : entry
      assert.equal(typeof css, 'string')
      assert.ok(css.trim().length > 0, `'${name}' : CSS vide`)
      assert.match(css, /::view-transition-(old|new)\(root\)/, `'${name}' : doit cibler ::view-transition-old/new(root)`)
    })
  }

  it('rideau iris : rayon animé par @property --mjs-vtc-r (masque à couverture totale constante), zéro mask-size animé, raccord fermeture≡ouverture, invariants rideau conservés', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    const css = µ._mjs_vtCurtains.iris.css()
    assert.match(css, /@property --mjs-vtc-r\{syntax:'<percentage>';inherits:false;initial-value:0%\}/, 'propriété --mjs-vtc-r enregistrée (percentage, non hérité)')
    assert.match(css, /@keyframes mjs-vtc-iris-close\{from\{--mjs-vtc-r:0%\}to\{--mjs-vtc-r:110%\}\}/, 'fermeture anime le rayon 0%→110%')
    assert.match(css, /@keyframes mjs-vtc-iris-open\{from\{--mjs-vtc-r:0%\}to\{--mjs-vtc-r:110%\}\}/, 'ouverture anime le rayon 0%→110% — MÊMES bornes que la fermeture (raccord sans saut)')
    assert.doesNotMatch(css, /mask-size/, 'plus de mask-size animé (cause du clignotement : boîte de masque sous-dimensionnée au 1er instant du révéler)')
    assert.match(css, /radial-gradient\(circle,/, 'masque toujours en radial-gradient (pas de régression vers une autre technique)')
    assert.doesNotMatch(css, /clip-path/, 'jamais de clip-path (mesuré peu fiable en conditions réelles, cf. commentaire de tête RIDEAUX)')
    assert.doesNotMatch(css, /::view-transition/, 'rideau = vrai DOM au-dessus du body, jamais les pseudos View Transitions')
  })
})

describe('µ._mjs_vtApplyPreset — injection/remplacement de la feuille unique', function () {
  it('injecte une <style id="mjs-vt-presets"> dans document.head avec le CSS du préréglage demandé', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.ok(sheet, 'la feuille doit avoir été créée')
    assert.equal(sheet.textContent, µ._vtPresets.fade)
  })

  it('un 2e appel avec un AUTRE préréglage REMPLACE le contenu de la MÊME feuille (pas une 2e feuille créée)', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    const first = doc.getElementById('mjs-vt-presets')
    µ._mjs_vtApplyPreset('zoom')
    const second = doc.getElementById('mjs-vt-presets')
    assert.equal(first, second, 'même élément réutilisé, pas recréé')
    assert.equal(second.textContent, µ._vtPresets.zoom)
  })

  it('nom inconnu : µ.warn appelé (liste les noms valides), AUCUNE feuille créée', () => {
    const warnCalls: any[] = []
    const µ: any = { warn: (...a: any[]) => warnCalls.push(a) }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('n-existe-pas')
    assert.equal(warnCalls.length, 1)
    assert.match(warnCalls[0][0], /préréglage inconnu/)
    assert.match(warnCalls[0][0], /fade/, 'la liste des noms valides doit apparaître dans le message')
    assertAbsent(doc.getElementById('mjs-vt-presets'))
  })

  it('nom inconnu APRÈS un préréglage valide : µ.warn + la feuille existante est VIDÉE (anti feuille périmée)', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    µ._mjs_vtApplyPreset('n-existe-pas')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.ok(sheet, 'la feuille doit exister (créée par le 1er appel)')
    assert.equal(sheet.textContent, '', 'un nom inconnu doit vider la feuille périmée, pas la laisser avec l\'ancien CSS')
  })

  it('_mjs_vtApplyPreset(true) — résolution « on » native : vide la feuille d\'un préréglage précédent', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('zoom')
    µ._mjs_vtApplyPreset(true)
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.equal(sheet.textContent, '', 'résolution "on" (true) doit vider la feuille du préréglage précédent')
  })

  it('µ._isServer=true : no-op total, jamais côté serveur', () => {
    const µ: any = { warn() {}, _isServer: true }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    assertAbsent(doc.getElementById('mjs-vt-presets'))
  })

  it('_mjs_vtApplyPreset(\'cube:up\') : le suffixe :direction n\'est plus honoré, µ.warn + repli sur la direction PAR DÉFAUT de la base (cube → left, PAS up)', () => {
    const warns: any[] = []
    const µ: any = { warn: (...a: any[]) => warns.push(a) }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('cube:up')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.match(sheet.textContent, /rotateY/, 'repli sur le défaut de cube (left), PAS rotateX (up)')
    assert.match(sheet.textContent, /-50vw/, 'repli sur le défaut de cube (left) : axe horizontal, PAS -50vh')
    assert.equal(warns.length, 1, 'un warn signale le suffixe retiré')
    assert.match(warns[0][0], /la direction ne s'écrit plus dans le nom/)
  })

  it('_mjs_vtApplyPreset(\'cube={ dir: up }\') → CSS de la fabrique cube direction up (rotateX, -50vh) — la SEULE façon d\'orienter, via la clé d\'option', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('cube={ dir: up }')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.match(sheet.textContent, /rotateX\(90deg\)/)
    assert.match(sheet.textContent, /-50vh/)
  })

  it('alias historique \'slide-right\' n\'existe plus : nom inconnu → µ.warn, feuille vidée (comme tout préréglage inconnu)', () => {
    const warns: any[] = []
    const µ: any = { warn: (...a: any[]) => warns.push(a) }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    µ._mjs_vtApplyPreset('slide-right')
    assert.equal(doc.getElementById('mjs-vt-presets').textContent, '', 'nom inconnu → feuille périmée VIDÉE, pas l\'ancien CSS de fade')
    assert.equal(warns.length, 1)
    assert.match(warns[0][0], /préréglage inconnu/)
  })

  it('duration (nombre NU) met le CSS généré à l\'échelle proportionnelle à la durée par défaut de la base (fade : .5s par défaut, duration:1000 → ×2 → 1s)', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade={ duration: 1000 }')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.match(sheet.textContent, /animation-duration:1s/, 'jeton temporel ×2 (.5s → 1s)')
  })

  it('sans duration : CSS strictement identique au préréglage brut (facteur 1, identité, zéro régression)', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.equal(sheet.textContent, µ._vtPresets.fade)
  })

  it('duration: sur un préréglage DIRECTIONNEL (cube={ dir: up }), l\'échelle s\'applique aussi bien que le CSS soit issu de la fabrique', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    // cube : défaut 600ms (.6s) ; duration:300 → facteur 0.5 → .3s
    µ._mjs_vtApplyPreset('cube={ dir: up, duration: 300 }')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.match(sheet.textContent, /rotateX\(90deg\)/, 'direction toujours honorée (fabrique appelée avec dir=up)')
    assert.match(sheet.textContent, /animation-duration:0\.3s/, 'échelle appliquée même avec direction (.6s → .3s)')
  })

  it('duration (clé COURTE dur) équivaut à la forme longue', () => {
    const µ: any = { warn() {} }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade={ dur: 1000 }')
    const sheet = doc.getElementById('mjs-vt-presets')
    assert.match(sheet.textContent, /animation-duration:1s/, 'clé courte "dur" : même échelle que la forme longue "duration"')
  })

  it('_mjs_vtApplyPreset d\'un RIDEAU (iris) : pas de feuille pseudo (vide la feuille existante), pas de warn', () => {
    const warns: any[] = []
    const µ: any = { warn: (...a: any[]) => warns.push(a) }
    const doc = makeFakeDocument()
    loadVtPresets(µ, doc)
    µ._mjs_vtApplyPreset('fade')
    µ._mjs_vtApplyPreset('iris')
    assert.equal(doc.getElementById('mjs-vt-presets').textContent, '')
    assert.equal(warns.length, 0)
  })
})

describe('préréglages — invariants CSS (fabriques directionnelles, fidélité à l\'implémentation interne antérieure)', () => {
  const gen = (µ: any, base: string, dir: string) => { const e = µ._vtPresets[base]; return typeof e === 'function' ? e(dir) : e }
  it('perspective sur image-pair (JAMAIS -group) pour flip/cube/turn, dans les 4 directions', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    for (const base of ['flip', 'cube', 'turn']) for (const dir of ['left', 'right', 'up', 'down']) {
      const css = gen(µ, base, dir)
      assert.match(css, /::view-transition-image-pair\(root\)\{perspective:/, `${base}:${dir}`)
      assert.doesNotMatch(css, /::view-transition-group\(root\)\{perspective/, `${base}:${dir}`)
    }
  })
  it('mix-blend-mode:normal partout où des couches opaques s\'empilent', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    for (const base of ['volet', 'reveal', 'flip', 'cube', 'turn']) for (const dir of ['left', 'right', 'up', 'down']) assert.match(gen(µ, base, dir), /mix-blend-mode:normal/, `${base}:${dir}`)
    for (const base of ['zoom', 'zoom-out']) assert.match(gen(µ, base, 'left'), /mix-blend-mode:normal/, base)
  })
  it('z-index:1 sur l\'ancienne quand c\'est elle qui révèle (reveal/turn, 4 directions)', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    for (const base of ['reveal', 'turn']) for (const dir of ['left', 'right', 'up', 'down']) assert.match(gen(µ, base, dir), /z-index:1/, `${base}:${dir}`)
  })
  it('cube : axe partagé façon flux — -50vw horizontal, -50vh vertical', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    assert.match(gen(µ, 'cube', 'left'), /transform-origin:50% 50% -50vw/)
    assert.match(gen(µ, 'cube', 'right'), /transform-origin:50% 50% -50vw/)
    assert.match(gen(µ, 'cube', 'up'), /transform-origin:50% 50% -50vh/)
    assert.match(gen(µ, 'cube', 'down'), /transform-origin:50% 50% -50vh/)
  })
  it('les RIDEAUX ne touchent jamais aux pseudos et n\'utilisent plus clip-path', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    for (const [name, spec0] of Object.entries(µ._mjs_vtCurtains)) {
      const spec: any = typeof spec0 === 'function' ? (spec0 as any)('down') : spec0
      assert.doesNotMatch(spec.css(), /::view-transition/, name)
      assert.doesNotMatch(spec.css(), /clip-path/, name)
      assert.ok(spec.coverMs > 0 && spec.revealMs > 0, name)
    }
  })
  it('fade dure .5s (visible), plus les .2s d\'origine', () => {
    const µ: any = { warn() {} }
    loadVtPresets(µ, makeFakeDocument())
    assert.match(µ._vtPresets.fade, /animation-duration:\.5s/)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// mjs_ujs.ts — µ._mjs_vtResolvePage / µ._mjs_vtWrapSwap (unitaires, fonctions extraites)
// ════════════════════════════════════════════════════════════════════════════
function extractVtResolvePageStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_vtResolvePage')
}
function extractVtWrapSwapStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_vtWrapSwap')
}
function installVt(µ: any, doc: any = {}) {
  new Function('µ', 'document', extractVtResolvePageStatement() + '\n' + extractVtWrapSwapStatement())(µ, doc)
}

describe('µ._mjs_vtResolvePage — résolution PAGE (attribut du lien > config)', function () {
  it('attribut mjs-vt="on" → true', () => {
    const µ: any = {}
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage({ getAttribute: () => 'on' }), true)
  })
  it('attribut mjs-vt="off" → false', () => {
    const µ: any = {}
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage({ getAttribute: () => 'off' }), false)
  })
  it('attribut mjs-vt="volet" (nom de préréglage) → "volet" (chaîne, pas un booléen)', () => {
    const µ: any = {}
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage({ getAttribute: () => 'volet' }), 'volet')
  })
  it('pas d\'attribut sur le lien → repli sur µ.viewTransition (config)', () => {
    const µ: any = { viewTransition: 'reveal' }
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage({ getAttribute: () => null }), 'reveal')
  })
  it('pas de lien du tout (popstate/submit) → repli sur µ.viewTransition (config)', () => {
    const µ: any = { viewTransition: true }
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage(null), true)
  })
  it('ni attribut ni config → false', () => {
    const µ: any = {}
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage(null), false)
  })
  it('µ.viewTransition="none" (config « désactivé ») → false', () => {
    const µ: any = { viewTransition: 'none' }
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage(null), false)
  })
  it('attribut mjs-vt="none" sur le lien ≡ "off" — coupe explicitement', () => {
    const µ: any = { viewTransition: 'fade' }
    installVt(µ)
    assert.equal(µ._mjs_vtResolvePage({ getAttribute: () => 'none' }), false)
  })
})

describe('µ._mjs_vtWrapSwap — enveloppe (ou pas) le swap dans document.startViewTransition', function () {
  it('gate OFF (µ.Router._mjs_vtEnabled() false) → swap() direct, document.startViewTransition PAS appelé', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => false } }
    let started = false
    const doc = { startViewTransition: (cb: any) => { started = true; cb() } }
    installVt(µ, doc)
    const calls: string[] = []
    µ._mjs_vtWrapSwap(null, () => calls.push('swap'))
    assert.deepEqual(calls, ['swap'], 'le swap doit quand même avoir lieu, juste pas enveloppé')
    assert.equal(started, false)
  })

  it('µ.Router absent (runtime tree-shaké sans "router") → repli silencieux sur swap() direct, jamais un crash', () => {
    const µ: any = {}
    const doc = { startViewTransition: () => { throw new Error('ne doit jamais être appelé') } }
    installVt(µ, doc)
    const calls: string[] = []
    assert.doesNotThrow(() => µ._mjs_vtWrapSwap(null, () => calls.push('swap')))
    assert.deepEqual(calls, ['swap'])
  })

  it('gate ON mais résolution "off" (aucun attribut lien, config désactivée) → swap() direct, API pas invoquée', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: false }
    let started = false
    const doc = { startViewTransition: (cb: any) => { started = true; cb() } }
    installVt(µ, doc)
    const calls: string[] = []
    µ._mjs_vtWrapSwap(null, () => calls.push('swap'))
    assert.deepEqual(calls, ['swap'])
    assert.equal(started, false)
  })

  it('gate ON + résolution "on" (config) → µ._mjs_vtApplyPreset(true) purge la feuille, puis startViewTransition', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: true }
    const applyCalls: any[] = []
    µ._mjs_vtApplyPreset = (n: any) => applyCalls.push(n)
    let started = false
    const doc = { startViewTransition: (cb: any) => { started = true; cb() } }
    installVt(µ, doc)
    const calls: string[] = []
    µ._mjs_vtWrapSwap(null, () => calls.push('swap'))
    assert.deepEqual(calls, ['swap'], 'le callback doit quand même avoir tourné (exécuté par startViewTransition)')
    assert.equal(started, true)
    assert.deepEqual(applyCalls, [true], 'résolution booléenne → _mjs_vtApplyPreset(true) purge la feuille périmée')
  })

  it('gate ON + résolution en CHAÎNE (préréglage) → µ._mjs_vtApplyPreset(nom) appelé AVANT document.startViewTransition, puis le swap tourne', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'zoom' }
    const order: string[] = []
    µ._mjs_vtApplyPreset = (n: string) => order.push('apply:' + n)
    const doc = { startViewTransition: (cb: any) => { order.push('start'); cb() } }
    installVt(µ, doc)
    µ._mjs_vtWrapSwap(null, () => order.push('swap'))
    assert.deepEqual(order, ['apply:zoom', 'start', 'swap'])
  })

  it('cascade : attribut mjs-vt du LIEN gagne sur la config', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: 'zoom' }
    const applyCalls: string[] = []
    µ._mjs_vtApplyPreset = (n: string) => applyCalls.push(n)
    const doc = { startViewTransition: (cb: any) => cb() }
    installVt(µ, doc)
    const link = { getAttribute: (n: string) => (n === 'mjs-vt' ? 'slide-right' : null) }
    µ._mjs_vtWrapSwap(link, () => {})
    assert.deepEqual(applyCalls, ['slide-right'], "l'attribut du lien doit gagner sur µ.viewTransition")
  })

  it('cascade : lien mjs-vt="off" désactive explicitement, même si la config est active', () => {
    const µ: any = { Router: { _mjs_vtEnabled: () => true }, viewTransition: true }
    let started = false
    const doc = { startViewTransition: (cb: any) => { started = true; cb() } }
    installVt(µ, doc)
    const calls: string[] = []
    const link = { getAttribute: (n: string) => (n === 'mjs-vt' ? 'off' : null) }
    µ._mjs_vtWrapSwap(link, () => calls.push('swap'))
    assert.deepEqual(calls, ['swap'])
    assert.equal(started, false)
  })

  it('éléments nommés présents → hooks de lévitation appelés autour du swap (start → swap → hoistSwap → finished → end ; JAMAIS ready : new(nom) est une image vivante du fantôme)', () => {
    const order: string[] = []
    const state = { layer: null, hidden: [] }
    let finishedThen: any
    const µ: any = {
      Router: { _mjs_vtEnabled: () => true },
      viewTransition: 'fade',
      _mjs_vtApplyPreset: () => order.push('apply'),
      _mjs_vtHoistStart: () => { order.push('start'); return state },
      _mjs_vtHoistSwapSettled: (s: any) => { order.push('hoistSwap'); assert.equal(s, state) },
      _mjs_vtHoistEnd: (s: any) => { order.push('end'); assert.equal(s, state) },
    }
    const doc = { startViewTransition: (cb: any) => { cb(); return { ready: { then: () => { throw new Error('le nettoyage ne doit PAS être branché sur ready') } }, finished: { then: (ok: any) => { finishedThen = ok } } } } }
    installVt(µ, doc)
    µ._mjs_vtWrapSwap(null, () => order.push('swap'))
    finishedThen()
    assert.deepEqual(order, ['apply', 'start', 'swap', 'hoistSwap', 'end'])
  })

  it('résolution RIDEAU → µ._mjs_vtCurtainRun prend la main, startViewTransition PAS appelé', () => {
    const order: string[] = []
    const µ: any = {
      Router: { _mjs_vtEnabled: () => true },
      viewTransition: 'bars:left',
      _mjs_vtCurtainRun: (v: any, swap: any) => { order.push('curtain:' + v); swap(); return true },
      _mjs_vtApplyPreset: () => order.push('apply'),
    }
    const doc = { startViewTransition: () => { order.push('vt'); return {} } }
    installVt(µ, doc)
    µ._mjs_vtWrapSwap(null, () => order.push('swap'))
    assert.deepEqual(order, ['curtain:bars:left', 'swap'])
  })
})

// ════════════════════════════════════════════════════════════════════════════
// mjs_ujs.ts — intégration réelle : les points de swap du contenant de navigation
// (handlers click/popstate/submit), avec µ._mjs_vtWrapSwap RÉEL (extrait de la
// source, pas un mock) branché sur un document.startViewTransition bouchonné.
// ════════════════════════════════════════════════════════════════════════════
function extractClickBody(): string {
  // µ._mjs_ujsOnClick (nommé, ex-handler anonyme document.addEventListener('click', …)
  // — renommé, pont shadow fermé) : même corps, autre marqueur.
  return extractMarkedBody(UJS_SRC, '_mjs_ujsOnClick')
}
function extractPopstateBody(): string {
  return extractMarkedBody(UJS_SRC, 'popstate-listener')
}
function extractNavDispatchStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_navDispatch')
}
function extractFinalPathForStatement(): string {
  return extractMarked(UJS_SRC, '_mjs_finalPathFor')
}
function makeClickHandler() {
  return new Function('e', 'µ', 'window', 'document', 'DOMParser', 'FormData', extractClickBody())
}
function makePopstateHandler() {
  return new Function('e', 'µ', 'window', 'document', extractPopstateBody())
}
// Bloc des helpers de zone de navigation (µ._mjs_navMountZone → µ._mjs_navRequest,
// contigus, cf. leur bandeau commun) : les 3 points de swap (click/popstate/
// submit) en dépendent désormais (le chemin HTML n'a jamais de `target`,
// µ._mjs_navMountZone(document, null) résout donc toujours <body> ; µ.ajax.xxx
// remplacé par le canal interne µ._mjs_navRequest/µ._mjs_ajaxRequest) — extraction
// MÉCANIQUE requise pour que ce fichier continue de tourner (son INTENTION —
// l'enveloppement réel dans document.startViewTransition — est inchangée).
function extractHelpersBlock(): string {
  return extractMarked(UJS_SRC, 'helpers-navigation')
}
function installMountCascade(µ: any, doc: any, win: any) {
  new Function('µ', 'document', 'window', extractHelpersBlock())(µ, doc, win)
}
function installNavDispatch(µ: any, win: any, doc: any, DOMParser: any = class {}) {
  // Adaptateur — µ._mjs_navRequest (canal interne) appelle µ._mjs_ajaxRequest ; ce
  // fichier vérifie le dispatch µ.ajax.post EXISTANT, jamais l'en-tête
  // X-MJS-Nav (hors périmètre ici) : on redirige simplement vers le µ.ajax
  // mocké par CE test, arguments dans le MÊME ORDRE que le vrai code.
  if (typeof µ._mjs_ajaxRequest !== 'function') {
    µ._mjs_ajaxRequest = function (opts: any) {
      if (!µ.ajax) return
      const m = opts.method.toLowerCase()
      if (m === 'get' || m === 'delete') return µ.ajax[m] && µ.ajax[m](opts.url, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
      return µ.ajax[m] && µ.ajax[m](opts.url, opts.data, opts.success, opts.error, opts.always, opts.timeout, opts.signal)
    }
  }
  installMountCascade(µ, doc, win)
  new Function('µ', 'window', 'document', 'FormData', 'URL', 'DOMParser', extractNavDispatchStatement())(µ, win, doc, FakeFormData, class {}, DOMParser)
}

function makeLink(attrs: Record<string, string> = {}, urlBits: Record<string, string> = {}) {
  const attributes: Record<string, string> = Object.assign({}, attrs)
  const link: any = Object.assign({
    tagName: 'A',
    hasAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) },
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(attributes, name) ? attributes[name] : null },
    // `target.closest('a')` doit retrouver le lien lui-même (le clic cible directement
    // le <a>, pas un enfant) ; `closest('[mjs-confirm]')` retombe aussi sur `this`
    // (hasAttribute filtre ensuite l'absence réelle de l'attribut) — même idiome que
    // ujs-click-samepage-duplicate-pushstate.test.ts.
    closest(_sel: string) { return this },
    origin: 'http://x', target: '', protocol: 'http:',
    pathname: '/', search: '', hash: '', href: 'http://x/',
  }, urlBits)
  return link
}
function makeClickEvent(target: any) {
  return {
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true },
    button: 0, metaKey: false, ctrlKey: false, shiftKey: false, altKey: false,
    composedPath: () => [target],
    target,
  }
}
class FakeFormData {
  private map = new Map<string, any>()
  append(k: string, v: any) { this.map.set(k, v) }
  get(k: string) { return this.map.has(k) ? this.map.get(k) : null }
  *[Symbol.iterator]() { yield* this.map }
}

// µ commun aux intégrations : installe µ._mjs_vtResolvePage/_mjs_vtWrapSwap RÉELS (extraits de
// la source), un µ.Router._mjs_vtEnabled contrôlable, et les utilitaires que les handlers
// appellent SANS garde `typeof === 'function'` (donc obligatoires ici, cf. mjs_ujs.ts).
function makeIntegrationMu(doc: any, vtGate: boolean, win?: any) {
  const applyCalls: string[] = []
  const µ: any = {
    realTarget: (e: any) => e.target,
    warn() {}, error() {}, log() {},
    _mjs_navSeq: 0,
    _mjs_lastUjsPath: '/',
    Router: { _mjs_vtEnabled: () => vtGate, navigate() {} },
    _mjs_saveScroll() {}, _mjs_restoreScroll() {},
    _applyCalls: applyCalls,
    _mjs_vtApplyPreset: (n: string) => applyCalls.push(n),
  }
  installVt(µ, doc)
  installMountCascade(µ, doc, win || {})
  return µ
}

// conteneur MINIATURE avec de VRAIES sémantiques childNodes (lecture, PAS retrait — le
// retrait réel n'a lieu qu'au µ._mjs_zoneFill suivant, cf. mjs_ujs.ts) ET replaceChildren
// (µ._mjs_zoneFill) — sert de `document.body` dans ces intégrations (le chemin HTML
// n'a jamais de `target`, le contenant EST toujours <body>).
function makeContainer(initialChildren: any[] = []): any {
  const c: any = { children: initialChildren.slice() }
  Object.defineProperty(c, 'childNodes', { get: () => c.children.slice() })
  c.replaceChildren = (...nodes: any[]) => { c.by = nodes[0]; c.children = nodes.slice() }
  return c
}

describe('mjs_ujs — swap du contenant de navigation réellement enveloppé (intégration, µ._mjs_vtWrapSwap extrait de la source)', function () {
  it('click cache-hit : gate+résolution actives (préréglage sur le lien) → document.startViewTransition appelé, préréglage appliqué, le swap a bien lieu', () => {
    const cachedNode = { tag: 'cached' }
    const currentRoot = makeContainer()
    const doc: any = { body: currentRoot }
    let vtStarted = false
    doc.startViewTransition = (cb: any) => { vtStarted = true; cb() }
    const µ = makeIntegrationMu(doc, true)
    µ.pageCache = { has: (p: string) => p === '/other', get: () => [cachedNode], set() {} }
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const link = makeLink({ 'mjs-vt': 'zoom' }, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData)

    assert.equal(vtStarted, true, 'document.startViewTransition doit avoir été invoqué')
    assert.deepEqual(µ._applyCalls, ['zoom'], 'le préréglage du LIEN doit avoir été appliqué')
    assert.equal(currentRoot.by, cachedNode, 'le swap doit avoir eu lieu (à l\'intérieur du callback)')
  })

  it('click cache-hit : gate OFF (µ.Router._mjs_vtEnabled false) → PAS de document.startViewTransition, le swap a quand même lieu (chemin direct)', () => {
    const cachedNode = { tag: 'cached' }
    const currentRoot = makeContainer()
    const doc: any = { body: currentRoot, startViewTransition: () => { throw new Error('ne doit pas être appelé') } }
    const µ = makeIntegrationMu(doc, false)
    µ.pageCache = { has: (p: string) => p === '/other', get: () => [cachedNode], set() {} }
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    const link = makeLink({ 'mjs-vt': 'zoom' }, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData)

    assert.equal(currentRoot.by, cachedNode, 'le swap direct doit quand même avoir lieu')
    assert.deepEqual(µ._applyCalls, [])
  })

  it('click cache-hit : µ._mjs_vtWrapSwap absent du tout (comme dans les autres tests ujs-*.test.ts existants) → chemin historique inchangé', () => {
    const cachedNode = { tag: 'cached' }
    const currentRoot = makeContainer()
    const doc: any = { body: currentRoot }
    const µ: any = {
      realTarget: (e: any) => e.target, warn() {}, error() {}, log() {},
      _mjs_navSeq: 0, _mjs_lastUjsPath: '/', Router: { navigate() {} },
      _mjs_saveScroll() {}, _mjs_restoreScroll() {},
      pageCache: { has: (p: string) => p === '/other', get: () => [cachedNode], set() {} },
    }
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} } }
    installMountCascade(µ, doc, win)
    const link = makeLink({}, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    assert.doesNotThrow(() => handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData))
    assert.equal(currentRoot.by, cachedNode, 'aucune régression : le swap direct a toujours lieu sans µ._mjs_vtWrapSwap')
  })

  it('click réseau (cache-miss) : gate+résolution actives → document.startViewTransition appelé, swap ET correction de redirection (navDest) toujours corrects', () => {
    const newNode = { tag: 'fresh' }
    const liveRoot = makeContainer()
    const doc: any = { body: liveRoot }
    let vtStarted = false
    doc.startViewTransition = (cb: any) => { vtStarted = true; cb() }
    const µ = makeIntegrationMu(doc, true)
    µ.pageCache = { has: () => false, get() { return undefined }, set() {} }
    µ.viewTransition = 'fade' // pas d'attribut sur CE lien → repli config
    let capturedSuccess: any
    // Le handler click délègue au fetch conscient du préchargement (µ._mjs_ajaxGet, cf.
    // section PRÉCHARGEMENT de mjs_ujs.ts) — PAS directement à µ.ajax.get.
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    const pushStateCalls: any[] = []
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState: (...a: any[]) => pushStateCalls.push(a) }, scrollTo() {} }
    // `_swapClickNet` (dans le callback enveloppé) appelle µ._mjs_finalPathFor (résolution
    // de redirection serveur) — utilitaire RÉEL extrait, pas réimplémenté à la main.
    new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
    const link = makeLink({}, { pathname: '/other', href: 'http://x/other' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } }, FakeFormData)

    assert.ok(typeof capturedSuccess === 'function', 'le fetch réseau doit avoir été déclenché (cache-miss)')
    capturedSuccess('<html><body>contenu</body></html>', 'http://x/other')

    assert.equal(vtStarted, true)
    assert.deepEqual(µ._applyCalls, ['fade'], 'résolution config (pas de mjs-vt sur ce lien) → préréglage "fade" appliqué')
    assert.equal(liveRoot.by, newNode, 'le swap réseau doit avoir eu lieu DANS le callback (closures navDest/finalPath toujours correctes après enveloppement)')
  })

  it('click réseau (cache-miss) : réponse JSON (protocole) + µ.viewTransition config → document.startViewTransition invoqué UNE FOIS (le chemin JSON ignorait mjs-vt avant ce correctif)', () => {
    const liveRoot = makeContainer()
    const doc: any = { body: liveRoot, createElement: (tag: string) => ({ tag }) }
    let vtStartCount = 0
    doc.startViewTransition = (cb: any) => { vtStartCount++; cb() }
    const µ = makeIntegrationMu(doc, true)
    µ.pageCache = { has: () => false, get() { return undefined }, set() {} }
    µ.viewTransition = 'fade' // pas d'attribut sur CE lien → repli config
    µ.paths = { produit: 'xxx-hash.js' }
    µ._mjs_resSet = () => {}
    let capturedSuccess: any
    µ._mjs_ajaxGet = (_url: string, success: any) => { capturedSuccess = success }
    const win: any = { location: { pathname: '/', search: '', hash: '', origin: 'http://x' }, history: { pushState() {} }, scrollTo() {} }
    new Function('µ', 'window', extractFinalPathForStatement())(µ, win)
    const link = makeLink({}, { pathname: '/produit/42', href: 'http://x/produit/42' })

    const handler = makeClickHandler()
    handler(makeClickEvent(link), µ, win, doc, class {}, FakeFormData)

    assert.ok(typeof capturedSuccess === 'function', 'le fetch réseau doit avoir été déclenché (cache-miss)')
    capturedSuccess({ module: 'mjs-produit', props: { id: '42' }, url: '/produit/42', title: null, version: undefined }, 'http://x/produit/42')

    assert.equal(vtStartCount, 1, 'document.startViewTransition doit avoir été invoqué UNE FOIS pour le swap JSON (AVANT ce correctif : jamais enveloppé)')
    assert.deepEqual(µ._applyCalls, ['fade'], 'résolution config (pas de mjs-vt sur ce lien) → préréglage "fade" appliqué')
    assert.equal(liveRoot.by.tag, 'mjs-produit', 'le composant JSON doit avoir été monté DANS le callback enveloppé par µ._mjs_vtWrapSwap')
  })

  it('popstate cache-hit : gate+résolution actives (config) → document.startViewTransition appelé, swap effectué (pas de lien → résolution config seule)', () => {
    const cachedNode = { tag: 'cached-pop' }
    const currentRoot = makeContainer()
    const doc: any = { body: currentRoot }
    let vtStarted = false
    doc.startViewTransition = (cb: any) => { vtStarted = true; cb() }
    const µ = makeIntegrationMu(doc, true)
    µ.viewTransition = 'reveal'
    µ.pageCache = { has: (p: string) => p === '/dest', get: () => [cachedNode], set() {} }
    µ._mjs_scrollPos = { get: () => null }
    const win: any = {
      location: { pathname: '/dest', search: '', hash: '', origin: 'http://x' },
      history: {},
    }
    µ._mjs_lastUjsPath = '/leaving'

    const handler = makePopstateHandler()
    handler({}, µ, win, doc)

    assert.equal(vtStarted, true)
    assert.deepEqual(µ._applyCalls, ['reveal'], 'popstate : pas de lien déclencheur → résolution config seule')
    assert.equal(currentRoot.by, cachedNode)
  })

  it('submit (µ._mjs_navDispatch.done) : gate+résolution actives (config) → document.startViewTransition appelé, swap effectué', () => {
    const newNode = { tag: 'submitted' }
    const liveRoot = makeContainer()
    const doc: any = { body: liveRoot }
    let vtStarted = false
    doc.startViewTransition = (cb: any) => { vtStarted = true; cb() }
    const µ = makeIntegrationMu(doc, true)
    µ.viewTransition = 'volet'
    µ.pageCache = { clear() {} }
    µ._mjs_preloadCache = { clear() {} }
    µ._mjs_preloaded = { clear() {} }
    let capturedSuccess: any
    µ.ajax = { post: (_u: string, _p: any, success: any) => { capturedSuccess = success } }
    const win: any = { location: { href: 'http://x/posts', origin: 'http://x' }, history: { pushState() {} } }
    installNavDispatch(µ, win, doc, class ParserWithRoot { parseFromString() { return { body: { childNodes: [newNode] } } } })

    µ._mjs_navDispatch('http://x/posts', 'POST', new FakeFormData(), {})
    assert.ok(typeof capturedSuccess === 'function')
    capturedSuccess('<html><body>ok</body></html>', 'http://x/posts')

    assert.equal(vtStarted, true)
    assert.deepEqual(µ._applyCalls, ['volet'])
    assert.equal(liveRoot.by, newNode)
  })
})

// ════════════════════════════════════════════════════════════════════════════
// Compilateur — @pageTransition="nom|on|off" sur un lien → mjs-vt (masquage <pre>/<code> compris)
// ════════════════════════════════════════════════════════════════════════════
describe('compilateur — @pageTransition (lien) → mjs-vt', function () {
  after(async () => { await terminateSharedWorkerPool() })

  it('@pageTransition="slide-left" et @pageTransition="off" sur des <a> → mjs-vt="…" ; @pageTransition dans un <code> d\'exemple NON converti (masquage)', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-link')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(
      join(src, 'vt-link-demo.mjs'),
      `<a href="/x" @pageTransition="slide-left">Suivant</a>\n<a href="/y" @pageTransition="off">Rester</a>\n` +
      `<p><code>&lt;a @pageTransition="zoom"&gt;</code></p>\n`,
    )
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-link-demo-/.test(f))!), 'utf-8')
    assert.match(comp, /mjs-vt=['"]slide-left['"]/, '@pageTransition="slide-left" → mjs-vt="slide-left"')
    assert.match(comp, /mjs-vt=['"]off['"]/, '@pageTransition="off" → mjs-vt="off"')
    assert.match(comp, /&lt;a @pageTransition/, 'le <code> d\'exemple garde @pageTransition littéral (pas de conversion, masquage)')
  })

  it('@vt="…" sur un <a> est REFUSÉ à la compilation — orientation vers @pageTransition', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-link-refuse')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(join(src, 'vt-link-refuse.mjs'), `<a href="/x" @vt="zoom">Suivant</a>\n`)
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    const stats = await bundler.compile()
    await bundler.close()

    assert.equal(stats.errors.length, 1, 'attendait exactement 1 erreur de compilation')
    assert.match(
      stats.errors[0].message,
      /@vt ne s'écrit plus ainsi : c'est désormais @pageTransition\.\nRemplace la ligne « @vt="zoom" » par : @pageTransition="zoom"/,
    )
  })

  it('@pageTransition="cube={ dir: left }" (guillemets doubles) → mjs-vt porte la chaîne verbatim, accolades échappées en entités', async () => {
    const { output } = await transpile('<a href="/x" @pageTransition="cube={ dir: left }">Suivant</a>\n', { moduleName: 'pt-obj-dq' })
    assert.match(output, /mjs-vt=['"]cube=&#123; dir: left &#125;['"]/)
  })

  it('@pageTransition=\'cube={ dir: left }\' (guillemets simples) → même résultat', async () => {
    const { output } = await transpile(`<a href="/x" @pageTransition='cube={ dir: left }'>Suivant</a>\n`, { moduleName: 'pt-obj-sq' })
    assert.match(output, /mjs-vt=['"]cube=&#123; dir: left &#125;['"]/)
  })

  it('"fade", "on" et "off" restent inchangés (non-régression du nom simple et des mots réservés)', async () => {
    const fade = await transpile('<a href="/x" @pageTransition="fade">Suivant</a>\n', { moduleName: 'pt-fade' })
    assert.match(fade.output, /mjs-vt=['"]fade['"]/)
    const on = await transpile('<a href="/x" @pageTransition="on">Suivant</a>\n', { moduleName: 'pt-on' })
    assert.match(on.output, /mjs-vt=['"]on['"]/)
    const off = await transpile('<a href="/x" @pageTransition="off">Suivant</a>\n', { moduleName: 'pt-off' })
    assert.match(off.output, /mjs-vt=['"]off['"]/)
  })

  // Même MESSAGE (transpiler.vt-direction-plus-dans-nom)
  // que les 4 autres positions, mais PAS le même EXEMPLE : @pageTransition n'a pas de forme à
  // point sur un lien (`@pageTransition.cube={...}` n'existe pas), la vraie forme est une CHAÎNE
  // (signe égal, guillemets) — l'exemple proposé doit donc être PROPRE à cette position.
  it('@pageTransition="cube:left" (suffixe :direction) → ERREUR, exemple PROPRE à @pageTransition (chaîne, pas le point des 4 autres positions)', async () => {
    await assert.rejects(
      transpile('<a href="/x" @pageTransition="cube:left">Suivant</a>\n', { moduleName: 'pt-dir-1' }),
      /la direction ne s'écrit plus dans le nom — écris @pageTransition="cube=\{ dir: left \}"\./,
    )
  })

  it('@pageTransition="cube={ dir: gauche }" et "cube={ duree: 600 }" → erreur de parsing citant l\'attribut', async () => {
    await assert.rejects(
      transpile('<a href="/x" @pageTransition="cube={ dir: gauche }">Suivant</a>\n', { moduleName: 'pt-parse-1' }),
      /@pageTransition="cube=\{ dir: gauche \}" : direction invalide 'gauche'/,
    )
    await assert.rejects(
      transpile('<a href="/x" @pageTransition="cube={ duree: 600 }">Suivant</a>\n', { moduleName: 'pt-parse-2' }),
      /@pageTransition="cube=\{ duree: 600 \}" : clé inconnue 'duree'/,
    )
  })

  it('@pageTransition="cube={ priority: 3 }" → REFUSÉ (décision : priority sans effet niveau lien, cascade à 2 niveaux)', async () => {
    await assert.rejects(
      transpile('<a href="/x" @pageTransition="cube={ priority: 3 }">Suivant</a>\n', { moduleName: 'pt-priority' }),
      /@pageTransition="cube=\{ priority: 3 \}" : 'priority'\/'p' n'a pas d'effet sur un lien/,
    )
  })

  it('@pageTransition="cube:sideways" (mot après `:` non reconnu) → forme invalide (le filet, parité avec <@view>/<style>)', async () => {
    await assert.rejects(
      transpile('<a href="/x" @pageTransition="cube:sideways">Suivant</a>\n', { moduleName: 'pt-invalid' }),
      /forme invalide/,
    )
  })

  it('@pageTransition="cube={ dir: left }" dans un <pre><code> d\'exemple reste littéral (masquage)', async () => {
    const { output } = await transpile('<p>Exemple :</p>\n<pre><code>&lt;a @pageTransition="cube={ dir: left }"&gt;</code></pre>\n<div>x</div>\n', { moduleName: 'pt-mask' })
    assert.doesNotMatch(output, /mjs-vt=/, 'un @pageTransition affiché comme démo de code dans <pre>/<code> ne doit pas être réécrit comme une VRAIE directive')
    assert.match(output, /@pageTransition/, 'le texte de démo reste affiché tel quel')
  })

  it('bout en bout — le mjs-vt compilé (forme objet) est lu tel quel par µ._mjs_vtResolvePage/µ._mjs_vtParse, sans avertissement', async () => {
    const { output } = await transpile('<a href="/x" @pageTransition="cube={ dir: left }">Suivant</a>\n', { moduleName: 'pt-e2e' })
    const m = output.match(/mjs-vt=['"]([^'"]*)['"]/)
    assert.ok(m, 'mjs-vt présent dans la sortie compilée')
    const decoded = m![1].replace(/&quot;/g, '"').replace(/&#123;/g, '{').replace(/&#125;/g, '}')
    assert.equal(decoded, 'cube={ dir: left }')
    const warnings: string[] = []
    const µ: any = { warn: (msg: string) => warnings.push(msg) }
    installVt(µ)
    loadVtPresets(µ, makeFakeDocument())
    const resolved = µ._mjs_vtResolvePage({ getAttribute: () => decoded })
    assert.equal(resolved, decoded)
    const parsed = µ._mjs_vtParse(resolved)
    assert.deepEqual(parsed, { base: 'cube', dir: 'left', durationMs: null, priority: null })
    assert.deepEqual(warnings, [])
  })
})
