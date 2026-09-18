// Transitions de page (µ.viewTransition / @viewTransition / document.startViewTransition) —
// couvre la validation de config (booléen ET nom de préréglage), la compilation des 3 niveaux
// (config → module → <@view>/balise, valeurs on/off ET nom), et la résolution runtime du
// routeur : cascade false|true|'nom', dégradé gracieux (API absente) + reduced-motion,
// résolution ACTIVE (_vtResolveActive) + application du préréglage avant startViewTransition.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readdirSync, readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Window } from 'happy-dom'
import { findConfig, VT_PRESET_BASES, isVtPresetValue, parseVtValue } from '../src/bundler/config.js'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { transpile } from '../src/transpiler/index.js'
import { extractSections } from '../src/transpiler/sections.js'
import { assertAbsent } from './helpers/dom-assert.js'
import { mjsTmp } from './helpers/tmp.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROUTER = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_router.ts'), 'utf-8')
const VT_PRESETS = readFileSync(join(__dirname, '..', 'src', 'runtime', 'mjs_vt_presets.ts'), 'utf-8')

describe('viewTransition — validation de config', () => {
  const mkConfig = (val: string): string => {
    const root = mjsTmp('vt-cfg')
    writeFileSync(join(root, 'mjs.config.json'), `{ "viewTransition": ${val} }`)
    return root
  }

  it('rejette les booléens — "none" (désactivé, défaut) ou un nom de préréglage, jamais true/false', () => {
    assert.throws(() => findConfig(mkConfig('true')), /viewTransition invalide/)
    assert.throws(() => findConfig(mkConfig('false')), /viewTransition invalide/)
    assert.ok(findConfig(mkConfig('"none"')))
  })

  it('accepte un nom de préréglage de la bibliothèque (implique activé)', () => {
    assert.ok(findConfig(mkConfig('"cube"')))
    assert.ok(findConfig(mkConfig('"zoom"')))
    assert.ok(findConfig(mkConfig('"flip"')))
    assert.ok(findConfig(mkConfig('"cube={ dir: up }"')))
  })

  it('les BASES sont exactement celles attendues (13, dont 8 directionnelles) — le suffixe :direction et les alias suffixés sont RETIRÉS de la validation', () => {
    assert.deepEqual([...VT_PRESET_BASES].sort(), ['bars', 'blocks', 'cube', 'fade', 'flip', 'iris', 'reveal', 'slide', 'swipe', 'turn', 'volet', 'zoom', 'zoom-out'].sort())
    for (const v of ['fade', 'cube', 'zoom-out']) assert.ok(isVtPresetValue(v), v)
    // 'cube:up'/'turn:right'/'bars:left'/'swipe:down' : le format `base:direction` est
    // encore compris en INTERNE (reconstruction post-parsing, cf. isVtPresetValue) —
    // mais 'slide-left'/'cube-up'/'turn-right' (anciens ALIAS suffixés) sont bel et
    // bien retirés, ce ne sont plus des valeurs reconnues.
    for (const v of ['cube:diagonal', 'fade:left', 'iris:up', 'blocks:down', 'inconnu', 'zoom-in', 'slide-left', 'cube-up', 'turn-right']) assert.equal(isVtPresetValue(v), false, v)
  })

  it('rejette une valeur non-booléenne hors bibliothèque de préréglages', () => {
    assert.throws(() => findConfig(mkConfig('"always"')), /viewTransition invalide/)
    assert.throws(() => findConfig(mkConfig('1')), /viewTransition invalide/)
    assert.throws(() => findConfig(mkConfig('"fade:left"')), /viewTransition invalide/)
  })

  it('rejette le suffixe `:direction` (RETIRÉ) — message dédié, distinct du "invalide" générique', () => {
    assert.throws(() => findConfig(mkConfig('"cube:left"')), /la direction ne s'écrit plus dans le nom/)
  })

  it('rejette un alias suffixé historique (slide-left…) — RETIRÉ, devient un nom inconnu', () => {
    assert.throws(() => findConfig(mkConfig('"slide-left"')), /viewTransition invalide/)
  })

  it('rejette duration avec unité (ms/s) — nombre NU en ms uniquement, façon setTimeout', () => {
    assert.throws(() => findConfig(mkConfig('"cube={ duration: 600ms }"')), /un nombre nu en millisecondes/)
    assert.throws(() => findConfig(mkConfig('"cube={ duration: 0.6s }"')), /un nombre nu en millisecondes/)
    assert.ok(findConfig(mkConfig('"cube={ duration: 600 }"')), 'le nombre nu, lui, reste valide')
  })
})

describe('viewTransition — compilation des 3 niveaux (syntaxe OBJET)', () => {
  after(async () => { await terminateSharedWorkerPool() })

  it('config → µ.viewTransition ; @viewTransition.none module → _mjs_viewTransition ; <@view> AVEC NOM → data-mjs-vt ; balise .hero → @style.view-transition-name', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-cc')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    // @viewTransition.none racine (niveau 2) + @viewTransition.fade sur <@view> (niveau 3,
    // AVEC nom — la forme nue est interdite sur <@view>, cf. describe dédié plus
    // bas) + raccourci @viewTransition.hero sur une balise ordinaire (bonus @style.X) +
    // config (niveau 1). Le <code> affiche l'ANCIENNE syntaxe `@viewTransition="off"` → ne
    // DOIT PAS être converti ni lever d'erreur (masquage <pre>/<code>, cf.
    // extractDirectives/preprocessHtml).
    writeFileSync(
      join(src, 'vt-demo.page.mjs'),  // <@view> exige le marqueur .page.mjs
      `<style @viewTransition.none></style>\n\n<@view main @viewTransition.fade>\n<div @viewTransition.hero></div>\n` +
      `<p><code>&lt;a @viewTransition="off"&gt;</code></p>\n`,
    )
    const bundler = new Bundler({
      sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js'),
      viewTransition: 'fade',
    })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-demo-/.test(f))!), 'utf-8')
    const manifest = readFileSync(join(out, 'bundle.js'), 'utf-8')
    assert.match(manifest, /µ\.viewTransition = "fade";/, 'config → µ.viewTransition au manifeste')
    assert.match(comp, /_mjs_viewTransition = "none"/, 'directive racine module @viewTransition.none → _mjs_viewTransition')
    assert.match(comp, /data-mjs-vt=['"]fade['"]/, 'attribut <@view @viewTransition.fade> → data-mjs-vt="fade" sur metamjs-view')
    assert.match(comp, /view-transition-name/, 'raccourci @viewTransition.hero → @style.view-transition-name (setProperty)')
    assert.match(comp, /&lt;a @viewTransition/, 'le <code> d\'exemple garde @viewTransition="off" littéral (pas de conversion ni d\'erreur, masquage)')
  })

  it('directive de module avec un NOM de préréglage → _mjs_viewTransition="cube" ; <@view @viewTransition.zoom> → data-mjs-vt="zoom" ; config chaîne → µ.viewTransition="fade" (émis TEL QUEL, pas juste true)', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-preset')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(
      join(src, 'vt-preset-demo.page.mjs'),  // <@view> exige le marqueur .page.mjs
      `<style @viewTransition.cube></style>\n\n<@view main @viewTransition.zoom>\n<div>contenu</div>\n`,
    )
    const bundler = new Bundler({
      sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js'),
      viewTransition: 'fade',
    })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-preset-demo-/.test(f))!), 'utf-8')
    const manifest = readFileSync(join(out, 'bundle.js'), 'utf-8')
    assert.match(manifest, /µ\.viewTransition = "fade";/, 'config chaîne → µ.viewTransition émis tel quel (pas coercé en true)')
    assert.match(comp, /_mjs_viewTransition = "cube"/, 'directive racine module avec un NOM → _mjs_viewTransition porte le nom')
    assert.match(comp, /data-mjs-vt=['"]zoom['"]/, 'attribut <@view @viewTransition.zoom> → data-mjs-vt="zoom" (pas juste "on")')
  })

  it('priorité (option `priority:`, façon z-index) : @viewTransition.NOM={ priority: 5 } → _mjs_viewTransitionPriority ; <@view @viewTransition.nom={ priority: 3 }> → data-mjs-vt-p ; le canal NOM porte la chaîne VERBATIM (options comprises)', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-prio')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(
      join(src, 'vt-prio-demo.page.mjs'),  // <@view> exige le marqueur .page.mjs
      `<style @viewTransition.cube={ dir: up, priority: 5 }></style>\n\n<@view main @viewTransition.turn={ dir: right, priority: 3 }>\n<div>contenu</div>\n`,
    )
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-prio-demo-/.test(f))!), 'utf-8')
    assert.ok(comp.includes('_mjs_viewTransition = "cube={ dir: up, priority: 5 }"'), 'directive racine → le canal NOM porte la chaîne VERBATIM (options comprises, clé COURTE dir), relue au runtime par µ._mjs_vtParse')
    assert.match(comp, /_mjs_viewTransitionPriority = 5/, 'directive racine → priorité EXTRAITE vers son canal séparé (inchangé)')
    assert.ok(comp.includes('static _mjs_vt = "cube={ dir: up, priority: 5 }"'), 'miroir statique de classe (résolution côté arrivée, pas encore montée) — verbatim lui aussi')
    assert.match(comp, /static _mjs_vtp = 5/, 'miroir statique de la priorité')
    // Verbatim ÉCHAPPÉ (`{`/`}` → entités HTML) : sinon le pipeline générique
    // d'attributs statiques prendrait un `{` littéral pour une interpolation JS
    // (cf. escapeVtAttrValue, transpiler/index.ts) — décodé par le navigateur à
    // getAttribute(), µ._mjs_vtParse reçoit le texte réel au runtime.
    assert.ok(comp.includes("data-mjs-vt='turn=&#123; dir: right, priority: 3 &#125;'"), '<@view @viewTransition.turn={ dir: right, priority: 3 }> → data-mjs-vt verbatim ÉCHAPPÉ (statique, pas d\'interpolation)')
    assert.match(comp, /data-mjs-vt-p=['"]3['"]/, '<@view @viewTransition.turn={ dir: right, priority: 3 }> → data-mjs-vt-p="3" (canal séparé, INCHANGÉ)')

    // Bout-en-bout : un VRAI DOM (happy-dom) décode les entités HTML au parsing —
    // getAttribute() doit rendre le texte RÉEL (µ._mjs_vtParse le reçoit tel quel).
    const win = new Window({ url: 'http://localhost/' })
    const host = win.document.createElement('div')
    host.innerHTML = "<metamjs-view data-mjs-vt='turn=&#123; dir: right, priority: 3 &#125;'></metamjs-view>"
    const view = host.firstElementChild!
    assert.equal(view.getAttribute('data-mjs-vt'), 'turn={ dir: right, priority: 3 }', 'décodage DOM natif des entités &#123;/&#125; → texte verbatim réel')
  })

  it('sans priorité donnée : défaut 1 partout (directive racine ET <@view>)', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-prio-def')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(
      join(src, 'vt-prio-def.page.mjs'),  // <@view> exige le marqueur .page.mjs
      `<style @viewTransition.fade></style>\n\n<@view main @viewTransition.turn={ direction: down }>\n<div>contenu</div>\n`,
    )
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-prio-def-/.test(f))!), 'utf-8')
    assert.match(comp, /_mjs_viewTransitionPriority = 1/, 'défaut 1 sans option priority')
    assert.ok(comp.includes("data-mjs-vt='turn=&#123; direction: down &#125;'"), '<@view @viewTransition.turn={ direction: down }> → data-mjs-vt verbatim ÉCHAPPÉ (clé LONGUE direction)')
    assert.doesNotMatch(comp, /data-mjs-vt-p=/, 'pas de data-mjs-vt-p émis sans priorité explicite sur la balise')
  })

  it('<@view @viewTransition.fade={ dur: 300 }> → data-mjs-vt porte les options verbatim (clé COURTE dur, nombre nu) ; @style.view-transition-name={expr} intact sur balise ordinaire', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-dyn')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(
      join(src, 'vt-dyn-demo.page.mjs'),  // <@view> exige le marqueur .page.mjs
      `<@view main @viewTransition.fade={ dur: 300 }>\n` +
      `<img @style.view-transition-name={'p-' + 1}>\n` +
      `<div>contenu</div>\n`,
    )
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    await bundler.compile()
    await bundler.close()

    const files = readdirSync(out)
    const comp = readFileSync(join(out, files.find(f => /^vt-dyn-demo-/.test(f))!), 'utf-8')
    // Verbatim ÉCHAPPÉ (cf. commentaire équivalent plus haut, test priorité) —
    // sans l'échappement, `dur: 300` casserait la compilation si pris pour une
    // interpolation (le pipeline générique d'attributs évalue tout `{...}` littéral).
    assert.ok(comp.includes("data-mjs-vt='fade=&#123; dur: 300 &#125;'"), '<@view @viewTransition.fade={ dur: 300 }> → data-mjs-vt verbatim ÉCHAPPÉ (options comprises, clé courte)')
    assert.doesNotMatch(comp, /data-mjs-vt-p=/, 'pas de priority dans les options → pas de data-mjs-vt-p')
    assert.match(comp, /view-transition-name/, '@style.view-transition-name={expr} sur balise ordinaire reste compilé (setProperty), inchangé')
  })

  it('sans config viewTransition : le manifeste ne contient PAS µ.viewTransition (émission conditionnelle)', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-cc2')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(join(src, 'plain.mjs'), `<div>rien</div>\n`)
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js') })
    await bundler.compile()
    await bundler.close()

    const manifest = readFileSync(join(out, 'bundle.js'), 'utf-8')
    assert.doesNotMatch(manifest, /µ\.viewTransition/, 'clé absente de la config → pas de ligne émise (pas de changement des manifestes existants)')
  })

  it('config viewTransition explicite "none" : même résultat qu\'absente — pas de ligne émise', async function () {
    this.timeout(30000)
    const root = mjsTmp('vt-cc3')
    const src = join(root, 'src'); mkdirSync(src)
    const out = join(root, 'out')
    writeFileSync(join(src, 'plain.mjs'), `<div>rien</div>\n`)
    const bundler = new Bundler({ sourceDir: src, outputDir: out, manifestPath: join(out, 'bundle.js'), viewTransition: 'none' })
    await bundler.compile()
    await bundler.close()

    const manifest = readFileSync(join(out, 'bundle.js'), 'utf-8')
    assert.doesNotMatch(manifest, /µ\.viewTransition/, '"none" explicite → aussi pas de ligne émise (équivalent absent)')
  })
})

describe('viewTransition — parseVtValue (grammaire objet, unitaire — bundler/config.ts)', () => {
  it('name-only, none → ok avec base/dir corrects ; le nom garde son tiret interne (zoom-out, une VRAIE base)', () => {
    assert.deepEqual(parseVtValue('cube'), { ok: true, value: { base: 'cube', dir: null, durationMs: null, priority: null } })
    assert.deepEqual(parseVtValue('zoom-out'), { ok: true, value: { base: 'zoom-out', dir: null, durationMs: null, priority: null } })
    assert.deepEqual(parseVtValue('none'), { ok: true, value: { base: 'none', dir: null, durationMs: null, priority: null } })
  })

  it('RETRAIT — le suffixe `:direction` dans le nom est une erreur dédiée (plus une direction silencieuse)', () => {
    const r = parseVtValue('cube:left')
    assert.equal(r.ok, false)
    assert.match((r as any).error, /la direction ne s'écrit plus dans le nom/)
    assert.match((r as any).error, /'direction'\/'dir'/)
  })

  it('RETRAIT — les anciens alias suffixés (slide-left…) ne sont plus splittés : le nom reste tel quel (tiret interne, base "inconnue")', () => {
    // pas de `:` dans 'slide-left' → parseVtValue ne le rejette PAS elle-même (elle
    // ne vérifie pas l'appartenance à la bibliothèque, cf. son commentaire de tête) ;
    // c'est isVtPresetValue (config) qui le juge inconnu — cf. describe config plus haut.
    assert.deepEqual(parseVtValue('slide-left'), { ok: true, value: { base: 'slide-left', dir: null, durationMs: null, priority: null } })
  })

  it('objet complet — clés LONGUES (direction/duration/priority) combinées, duration en nombre NU', () => {
    const r = parseVtValue('cube={ direction: left, duration: 600, priority: 2 }')
    assert.deepEqual(r, { ok: true, value: { base: 'cube', dir: 'left', durationMs: 600, priority: 2 } })
  })

  it('objet complet — clés COURTES (dir/dur/p), mixables librement avec les longues', () => {
    assert.deepEqual(parseVtValue('cube={ dir: left, dur: 600, p: 2 }'), { ok: true, value: { base: 'cube', dir: 'left', durationMs: 600, priority: 2 } })
    assert.deepEqual(parseVtValue('cube={ direction: left, dur: 600, priority: 2 }'), { ok: true, value: { base: 'cube', dir: 'left', durationMs: 600, priority: 2 } }, 'mixe courte/longue toléré tant que ce n\'est pas la MÊME option 2×')
  })

  it('duration : SEUL le nombre NU (ms implicite, comme setTimeout) est valide — ms/s suffixés RETIRÉS', () => {
    assert.equal((parseVtValue('cube={ duration: 600 }') as any).value.durationMs, 600)
    assert.equal(parseVtValue('cube={ duration: 600ms }').ok, false, 'suffixe ms retiré')
    assert.equal(parseVtValue('cube={ duration: 0.6s }').ok, false, 'suffixe s retiré')
    assert.match((parseVtValue('cube={ duration: 600ms }') as any).error, /un nombre nu en millisecondes/)
  })

  it('guillemets facultatifs autour des valeurs, espaces libres', () => {
    const r = parseVtValue(`cube={  direction:  "left" , priority:'2'  }`)
    assert.equal(r.ok, true)
    assert.deepEqual((r as any).value, { base: 'cube', dir: 'left', durationMs: null, priority: 2 })
  })

  it('clé inconnue → erreur listant les 3 clés (forme longue/courte) ; "duraction" → suggestion de proximité "duration"/"dur"', () => {
    const bad = parseVtValue('cube={ couleur: rouge }')
    assert.equal(bad.ok, false)
    assert.match((bad as any).error, /clé inconnue 'couleur'/)
    assert.match((bad as any).error, /direction\/dir, duration\/dur, priority\/p/)
    const typo = parseVtValue('cube={ duraction: 600 }')
    assert.equal(typo.ok, false)
    assert.match((typo as any).error, /clé inconnue 'duraction'.*tu voulais dire 'duration'\/'dur'/)
  })

  it('clé en double (forme courte ET longue de la même option) → erreur dédiée', () => {
    const r = parseVtValue('cube={ dir: left, direction: right }')
    assert.equal(r.ok, false)
    assert.match((r as any).error, /clé en double/)
    assert.match((r as any).error, /'direction'/)
    assert.match((r as any).error, /'dir'/)
    const r2 = parseVtValue('cube={ duration: 600, dur: 900 }')
    assert.equal(r2.ok, false)
    assert.match((r2 as any).error, /clé en double/)
    const r3 = parseVtValue('cube={ priority: 1, priority: 2 }')
    assert.equal(r3.ok, false, 'la même clé répétée telle quelle est aussi une double')
  })

  it('direction sur base NON directionnelle → erreur listant les 8 bases directionnelles', () => {
    const r = parseVtValue('fade={ direction: left }')
    assert.equal(r.ok, false)
    assert.match((r as any).error, /directionnelle/)
    for (const b of ['slide', 'volet', 'reveal', 'flip', 'cube', 'turn', 'swipe', 'bars']) assert.match((r as any).error, new RegExp(b))
    const r2 = parseVtValue('fade:left')
    assert.equal(r2.ok, false, 'un `:` dans le nom échoue désormais AVANT même la vérification de directionnalité')
  })

  it('direction invalide (hors left/right/up/down) → erreur', () => {
    const r = parseVtValue('cube={ direction: diagonal }')
    assert.equal(r.ok, false)
    assert.match((r as any).error, /direction invalide/)
  })

  it('duration mal formée (non numérique, ou ≤ 0) → erreur explicite', () => {
    assert.equal(parseVtValue('cube={ duration: abc }').ok, false)
    assert.equal(parseVtValue('cube={ duration: 0 }').ok, false)
    assert.equal(parseVtValue('cube={ duration: -5 }').ok, false)
  })

  it('priority mal formée (non entier ≥ 0) → erreur explicite', () => {
    assert.equal(parseVtValue('cube={ priority: abc }').ok, false)
    assert.equal(parseVtValue('cube={ priority: -1 }').ok, false)
    assert.equal(parseVtValue('cube={ priority: 1.5 }').ok, false)
  })

  it('valeur vide ou malformée → ok:false sans throw', () => {
    assert.equal(parseVtValue('').ok, false)
    assert.equal(parseVtValue('   ').ok, false)
  })
})

describe('viewTransition — config accepte la syntaxe OBJET (parseVtValue câblé dans validateConfig)', () => {
  const mkConfig = (val: string): string => {
    const root = mjsTmp('vt-cfg-obj')
    writeFileSync(join(root, 'mjs.config.json'), `{ "viewTransition": ${val} }`)
    return root
  }
  it('accepte "base={ direction, duration, priority }" (clés longues)', () => {
    assert.ok(findConfig(mkConfig('"cube={ direction: left, duration: 600, priority: 2 }"')))
  })
  it('accepte "base={ dir, dur, p }" (clés courtes, mixables)', () => {
    assert.ok(findConfig(mkConfig('"cube={ dir: left, dur: 600, p: 2 }"')))
    assert.ok(findConfig(mkConfig('"cube={ direction: left, dur: 600 }"')))
  })
  it('rejette une base inconnue même avec des options syntaxiquement valides', () => {
    assert.throws(() => findConfig(mkConfig('"n-existe-pas={ duration: 600 }"')), /viewTransition invalide/)
  })
  it('rejette une clé d\'option invalide (propage le message de parseVtValue)', () => {
    assert.throws(() => findConfig(mkConfig('"cube={ duraction: 600 }"')), /viewTransition invalide.*clé inconnue/)
  })
  it('rejette une clé en double (forme courte + longue)', () => {
    assert.throws(() => findConfig(mkConfig('"cube={ dir: left, direction: right }"')), /viewTransition invalide.*clé en double/)
  })
})

describe('viewTransition — rejets de compilation (migration : formes anciennes, littéraux on/off, suffixe :direction interdits)', function () {
  this.timeout(30000)
  after(async () => { await terminateSharedWorkerPool() })

  // ── 1. 'off' n'existe pas ────────────────────────────────────────────────
  it("erreur 1 — 'off' explicite (racine, <@view>, forme point ET ancienne) → \"'off' n'existe pas\"", async () => {
    await assert.rejects(transpile('@viewTransition.off\n<div>x</div>', { moduleName: 'vt-off-1' }), /'off' n'existe pas/)
    await assert.rejects(transpile('@viewTransition off\n<div>x</div>', { moduleName: 'vt-off-2' }), /'off' n'existe pas/)
    await assert.rejects(transpile('@viewTransition = "off"\n<div>x</div>', { moduleName: 'vt-off-3' }), /'off' n'existe pas/)
    await assert.rejects(transpile('@vt.off\n<div>x</div>', { moduleName: 'vt-off-4' }), /'off' n'existe pas/)
    await assert.rejects(
      transpile('<@view main @viewTransition.off>', { moduleName: 'vt-off-5' }),
      /'off' n'existe pas/,
    )
    await assert.rejects(
      transpile('<@view main @viewTransition="off">', { moduleName: 'vt-off-6' }),
      /'off' n'existe pas/,
    )
  })

  // ── 2. 'on' est implicite ────────────────────────────────────────────────
  it("erreur 2 — 'on' explicite (racine, <@view>) → \"'on' est implicite\"", async () => {
    await assert.rejects(transpile('@viewTransition.on\n<div>x</div>', { moduleName: 'vt-on-1' }), /'on' est implicite/)
    await assert.rejects(transpile('@viewTransition on\n<div>x</div>', { moduleName: 'vt-on-2' }), /'on' est implicite/)
    await assert.rejects(
      transpile('<@view main @viewTransition.on>', { moduleName: 'vt-on-3' }),
      /'on' est implicite/,
    )
  })

  // ── 3. ancienne forme ESPACE (racine) ────────────────────────────────────
  it("erreur 3 — ancienne écriture '@viewTransition <nom> [priorité]' (racine, espace) → message de migration", async () => {
    await assert.rejects(transpile('@viewTransition cube 5\n<div>x</div>', { moduleName: 'vt-legacy-1' }), /ancienne écriture '@viewTransition <nom> \[priorité\]'/)
    await assert.rejects(transpile('@viewTransition zoom\n<div>x</div>', { moduleName: 'vt-legacy-2' }), /ancienne écriture/)
    await assert.rejects(transpile('@viewTransition = "zoom"\n<div>x</div>', { moduleName: 'vt-legacy-3' }), /ancienne écriture/)
  })

  // ── 4. ancienne forme VALEUR STATIQUE (<@view>/balise) ───────────────────
  it('erreur 4 — ancienne forme statique @viewTransition="nom" (balise ET <@view>) → message de migration', async () => {
    await assert.rejects(transpile('<div @viewTransition="hero"></div>', { moduleName: 'vt-static-1' }), /@viewTransition="hero" remplacé/)
    await assert.rejects(
      transpile('<@view main @viewTransition="zoom">', { moduleName: 'vt-static-2' }),
      /remplacé/,
    )
    // sur une balise ordinaire, @style.view-transition-name reste la voie dynamique valide :
    await assert.doesNotReject(transpile(`<img @style.view-transition-name={'p-' + 1}>`, { moduleName: 'vt-dynamic-ok' }))
  })

  // ── 5. étiquette CALCULÉE et CONDITIONNELLE (balise ordinaire) — RETIRÉES ─
  it('erreur 5 — @viewTransition={expr} (étiquette calculée) → erreur, message oriente vers @style.view-transition-name={expr}', async () => {
    await assert.rejects(
      transpile(`<img @viewTransition={'p-' + 1}>`, { moduleName: 'vt-calc-1' }),
      /étiquette calculée retirée.*@style\.view-transition-name=\{'p-' \+ 1\}/s,
    )
  })

  it('erreur 6 — @viewTransition{cond}="nom" (étiquette conditionnelle) → erreur, message oriente vers @style.view-transition-name{cond}="nom"', async () => {
    await assert.rejects(
      transpile('<img @viewTransition{$featured}="hero">', { moduleName: 'vt-cond-1' }),
      /étiquette conditionnelle retirée.*@style\.view-transition-name\{\$featured\}="hero"/s,
    )
  })

  // espace ou tabulation avant le `=` : la grammaire MJS les tolère partout ailleurs
  // (`@click ={f}`), la détection doit donc les tolérer aussi — sinon un simple espace
  // contourne l'erreur et retombe en écouteur d'événement fantôme « viewTransition »
  it('erreur 5 (bis) — `@viewTransition ={expr}` (espace avant le =) → même erreur, pas de contournement', async () => {
    await assert.rejects(transpile(`<img @viewTransition ={'p-' + 1}>`, { moduleName: 'vt-calc-space' }), /étiquette calculée retirée/s)
    await assert.rejects(transpile(`<img @viewTransition\t={'p-' + 1}>`, { moduleName: 'vt-calc-tab' }), /étiquette calculée retirée/s)
  })

  it('erreur 6 (bis) — `@viewTransition{cond} ="nom"` (espace avant le =) → même erreur, pas de contournement', async () => {
    await assert.rejects(transpile('<img @viewTransition{$featured} ="hero">', { moduleName: 'vt-cond-space' }), /étiquette conditionnelle retirée/s)
  })

  // ── 5. options malformées (clé inconnue/en double, direction invalide/non-directionnelle, duration/priority) ──
  it('erreur 5 — options malformées sur la directive racine → messages précis (dont suggestion "duraction")', async () => {
    await assert.rejects(transpile('@viewTransition.cube={ duraction: 600 }\n<div>x</div>', { moduleName: 'vt-opt-1' }), /clé inconnue 'duraction'.*tu voulais dire 'duration'\/'dur'/)
    await assert.rejects(transpile('@viewTransition.fade={ direction: left }\n<div>x</div>', { moduleName: 'vt-opt-2' }), /directionnelle/)
    await assert.rejects(transpile('@viewTransition.cube={ dir: left, direction: right }\n<div>x</div>', { moduleName: 'vt-opt-3' }), /clé en double/)
    await assert.rejects(transpile('@viewTransition.cube={ duration: abc }\n<div>x</div>', { moduleName: 'vt-opt-4' }), /un nombre nu en millisecondes/)
    await assert.rejects(transpile('@viewTransition.cube={ priority: -1 }\n<div>x</div>', { moduleName: 'vt-opt-5' }), /priority invalide/)
  })

  // ── 6. RETRAIT — suffixe `:direction` dans le nom ─────────────────────
  it("erreur 6 — suffixe ':direction' dans le nom (racine, <@view>, avec ou sans options) → \"la direction ne s'écrit plus dans le nom\"", async () => {
    await assert.rejects(transpile('@viewTransition.cube:left\n<div>x</div>', { moduleName: 'vt-dir-1' }), /la direction ne s'écrit plus dans le nom — écris @viewTransition\.cube=\{ dir: left \}\./)
    await assert.rejects(transpile('@viewTransition.cube:left={ priority: 2 }\n<div>x</div>', { moduleName: 'vt-dir-2' }), /la direction ne s'écrit plus dans le nom/)
    await assert.rejects(
      transpile('<@view main @viewTransition.cube:left>', { moduleName: 'vt-dir-3' }),
      /la direction ne s'écrit plus dans le nom — écris @viewTransition\.cube=\{ dir: left \}\./,
    )
    await assert.rejects(
      transpile('<@view main @viewTransition.turn:right={ priority: 3 }>', { moduleName: 'vt-dir-4' }),
      /la direction ne s'écrit plus dans le nom — écris @viewTransition\.cube=\{ dir: left \}\./,
    )
  })

  // transpiler.vt-direction-plus-dans-nom est PARTAGÉ entre
  // @viewTransition (racine/<@view>/<style>/balise — forme à POINT) et @pageTransition (lien — pas
  // de forme à point, une CHAÎNE `nom={...}`) : le message DOIT proposer l'exemple propre à chacun,
  // pas le même pour les deux. Texte EXACT (égalité stricte sur .message), pas une simple regex.
  it("erreur 6 (ter) — texte EXACT des deux variantes : @viewTransition garde son exemple à point, @pageTransition reçoit le sien (chaîne)", async () => {
    await assert.rejects(transpile('@viewTransition.cube:left\n<div>x</div>', { moduleName: 'vt-dir-exact-1' }), (err: any) => {
      assert.equal(err.message, "'vt-dir-exact-1' : [ModularJS] @viewTransition : la direction ne s'écrit plus dans le nom — écris @viewTransition.cube={ dir: left }.")   // préfixe du module
      return true
    })
    await assert.rejects(transpile('<a href="/x" @pageTransition="cube:left">Suivant</a>\n', { moduleName: 'pt-dir-exact-1' }), (err: any) => {
      assert.equal(err.message, '\'pt-dir-exact-1\' : [ModularJS] @pageTransition : la direction ne s\'écrit plus dans le nom — écris @pageTransition="cube={ dir: left }".')   // préfixe du module
      return true
    })
  })

  it('erreur 5 (bis) — options sur <@view> propagent le même message que parseVtValue', async () => {
    await assert.rejects(
      transpile('<@view main @viewTransition.cube={ duraction: 600 }>', { moduleName: 'vt-opt-view' }),
      /clé inconnue 'duraction'/,
    )
  })

  it('options `={...}` sur une balise ORDINAIRE (pas <@view>) → réservées aux niveaux de navigation', async () => {
    await assert.rejects(
      transpile('<div @viewTransition.hero={ duration: 300 }></div>', { moduleName: 'vt-morph-opts' }),
      /options réservées aux niveaux de navigation/,
    )
  })

  // ── 7. RETRAIT — @viewTransition/@vt NU sur <@view> (« @view nue interdite ») ──
  it("erreur 7 — @viewTransition/@vt NU sur <@view> (sans nom) → \"n'a pas d'effet propre\", la RACINE de module garde la forme nue", async () => {
    await assert.rejects(
      transpile('<@view main @viewTransition>', { moduleName: 'vt-view-bare-1' }),
      /@viewTransition nu sur une <@view> n'a pas d'effet propre — précise un nom \(@viewTransition\.fade\) ; la forme nue \(activer avec héritage\) n'existe qu'à la racine d'un module\./,
    )
    await assert.rejects(
      transpile('<@view main @viewTransition>', { moduleName: 'vt-view-bare-2' }),
      /@viewTransition nu sur une <@view> n'a pas d'effet propre — précise un nom \(@viewTransition\.fade\)/,
    )
    // la RACINE de module, elle, garde la forme nue (activer avec héritage) — RELOGÉE en
    // attribut de <style> (plus une directive à la racine du fichier) :
    await assert.doesNotReject(transpile('<style @viewTransition></style>\n<div>x</div>', { moduleName: 'vt-bare-ok' }))
    await assert.doesNotReject(transpile('<style @viewTransition.none></style>\n<div>x</div>', { moduleName: 'vt-none-ok' }))
    // et <@view> AVEC un nom reste valable :
    await assert.doesNotReject(transpile('<@view main @viewTransition.fade>', { moduleName: 'vt-view-named-ok-1' }))
    await assert.doesNotReject(transpile('<@view main @viewTransition.zoom>', { moduleName: 'vt-view-named-ok-2' }))
    await assert.doesNotReject(transpile('<@view main @viewTransition.none>', { moduleName: 'vt-view-none-ok' }))
  })

  // ── 8. DURCISSEMENT — les deux écritures que <style> AVALAIT ────
  //
  // Mesuré avant correctif : `extractStyleViewTransition` rendait `null` sur `.cube:left` et sur
  // `={expr}`, c'est-à-dire EXACTEMENT ce que rend « pas d'attribut du tout » — ni transition, ni
  // message, ni au build ni au runtime, alors que la doc les annonçait comme des erreurs de
  // compilation. Les mêmes écritures étaient déjà refusées ailleurs (racine, `<@view>`, balise) :
  // ce n'était pas un trou de grammaire, un trou de COUVERTURE.
  //
  // Le contrôle du NOM, lui, a été retiré ensuite : il fermait la porte au
  // préréglage maison posé dans `µ._vtPresets`, que le compilateur ne peut pas connaître. Les deux
  // refus qui restent portent sur la FORME, jamais sur un dictionnaire — cf. « erreur 8 (sexies) ».
  it("erreur 8 — suffixe ':direction' sur <style> → même message que <@view> (parité des positions)", async () => {
    await assert.rejects(transpile('<style @viewTransition.cube:left></style>\n<p>x</p>', { moduleName: 'vt-style-dir-1' }), /la direction ne s'écrit plus dans le nom — écris @viewTransition\.cube=\{ dir: left \}\./)
    await assert.rejects(transpile('<style @viewTransition.turn:right={ priority: 3 }></style>\n<p>x</p>', { moduleName: 'vt-style-dir-2' }), /la direction ne s'écrit plus dans le nom/)
  })

  it('erreur 8 (bis) — @viewTransition={expr} sur <style> → étiquette calculée refusée, comme sur une balise', async () => {
    await assert.rejects(transpile("<style @viewTransition={'p-' + 1}></style>\n<p>x</p>", { moduleName: 'vt-style-calc' }), /étiquette calculée retirée/)
  })

  it("erreur 8 (quater) — le filet : un @viewTransition présent mais hors grammaire ne part plus à la poubelle", async () => {
    await assert.rejects(transpile('<style @viewTransition.cube:sideways></style>\n<p>x</p>', { moduleName: 'vt-style-net-1' }), /forme invalide/)
    // `@viewTransition-truc` n'est pas un `@viewTransition.<nom>` mais un attribut à part entière : c'est la garde des
    // attributs de section (`checkSectionAttrs`) qui le refuse, avant la grammaire VT — refus tout aussi net
    await assert.rejects(transpile('<style @viewTransition-truc></style>\n<p>x</p>', { moduleName: 'vt-style-net-2' }), /attribut inconnu/)
  })

  it("erreur 8 (quinquies) — ':direction' dans un nom de MORPH (balise ordinaire, <a>) → refusé lui aussi", async () => {
    // La classe de caractères du nom de morph excluait le `:` : la regex entière échouait, et
    // l'attribut n'était donc NI traduit NI signalé — même silence que sur <style>. Un nom de morph
    // finit en `view-transition-name` CSS, un custom-ident où le `:` n'a pas cours.
    await assert.rejects(transpile('<div @viewTransition.cube:left></div>', { moduleName: 'vt-morph-colon-1' }), /la direction ne s'écrit plus dans le nom/)
    await assert.rejects(transpile('<a href="/x" @viewTransition.turn:right>y</a>', { moduleName: 'vt-morph-colon-2' }), /la direction ne s'écrit plus dans le nom/)
  })

  it("erreur 8 (sexies) — le contrôle du NOM est RETIRÉ : un préréglage maison compile aux deux niveaux", async () => {
    // `µ._vtPresets` est un dictionnaire ordinaire que l'appli garnit à son démarrage : le
    // compilateur, qui ne lit pas ce code-là, ne peut pas savoir que `diamant` existera. Le refuser
    // fermait la porte à un effet de marque — et la faute de frappe, elle, reste rattrapée par le
    // `µ.warn` de `µ._mjs_vtApplyPreset`, à l'endroit où l'on sait enfin ce que le dictionnaire contient.
    await assert.doesNotReject(transpile('<style @viewTransition.diamant></style>\n<p>x</p>', { moduleName: 'vt-style-maison-1' }))
    await assert.doesNotReject(transpile('<@view main @viewTransition.diamant>', { moduleName: 'vt-view-maison-1' }))
    await assert.doesNotReject(transpile('<style @viewTransition.diamant={ priority: 3 }></style>\n<p>x</p>', { moduleName: 'vt-style-maison-2' }))
  })

  it('non-régression du durcissement — les 13 bases, none, la forme nue et le MORPH LIBRE passent toujours', async () => {
    for (const base of ['fade', 'slide', 'zoom', 'zoom-out', 'volet', 'reveal', 'flip', 'cube', 'turn', 'iris', 'swipe', 'bars', 'blocks']) {
      await assert.doesNotReject(transpile(`<style @viewTransition.${base}></style>\n<p>x</p>`, { moduleName: `vt-base-ok-${base}` }), `base ${base} refusée à tort`)
    }
    await assert.doesNotReject(transpile('<style @viewTransition.none></style>\n<p>x</p>', { moduleName: 'vt-none-ok-2' }))
    await assert.doesNotReject(transpile('<style @viewTransition></style>\n<p>x</p>', { moduleName: 'vt-bare-ok-2' }))
    // ⚠ SUR UNE BALISE ORDINAIRE le nom n'est PAS un préréglage : c'est un nom de MORPH libre, qui
    // apparie deux éléments de part et d'autre d'une navigation. `pastille` et `hero` existent pour
    // de vrai dans les projets réels — les vérifier contre les 13 bases les casserait.
    await assert.doesNotReject(transpile('<div @viewTransition.pastille></div>', { moduleName: 'vt-morph-ok-1' }))
    await assert.doesNotReject(transpile('<span @viewTransition.hero></span>', { moduleName: 'vt-morph-ok-2' }))
  })

  it('non-régression : @pageTransition="nom"/"off" sur un LIEN <a> (mécanisme page/UJS, DISTINCT) reste valide, aucune erreur', async () => {
    await assert.doesNotReject(transpile('<a href="/x" @pageTransition="slide-left">Suivant</a>', { moduleName: 'vt-link-ok-1' }))
    await assert.doesNotReject(transpile('<a href="/x" @pageTransition="off">Rester</a>', { moduleName: 'vt-link-ok-2' }))
  })

  it('@vt="…" sur un LIEN <a> est REFUSÉ — renommé @pageTransition', async () => {
    await assert.rejects(
      transpile('<a href="/x" @vt="zoom">Suivant</a>', { moduleName: 'vt-link-refuse-1' }),
      /@vt ne s'écrit plus ainsi : c'est désormais @pageTransition\.\nRemplace la ligne « @vt="zoom" » par : @pageTransition="zoom"/,
    )
    await assert.rejects(
      transpile('<a href="/x" @vt="off">Rester</a>', { moduleName: 'vt-link-refuse-2' }),
      /@vt ne s'écrit plus ainsi : c'est désormais @pageTransition/,
    )
  })
})

describe('viewTransition — résolution runtime du routeur (_mjs_vtResolve / _mjs_vtEnabled / _vtResolveActive)', function () {
  // Globals posés/restaurés PAR TEST (même précaution que router-navigate-reentrance.test.ts :
  // Node fournit un CustomEvent natif incompatible avec les instances happy-dom, et un autre
  // fichier de test du même process Mocha peut avoir déjà posé sa propre Window avant celui-ci).
  let __prevWindow: any, __prevDocument: any, __prevCustomEvent: any, __prevCustomElements: any
  // le faux requestAnimationFrame posé par loadRouter, lui, se rend UNE fois pour tout le describe
  // (les rideaux planifient des frames qui retombent d'un test à l'autre) — sans ce rendu il fuite
  // dans les fichiers SUIVANTS du même process Mocha, cf. transition-tick-abort-resolves.test.ts
  let __prevRaf: any
  before(() => { __prevRaf = (globalThis as any).requestAnimationFrame })
  after(() => { if(__prevRaf !== undefined) (globalThis as any).requestAnimationFrame = __prevRaf; else delete (globalThis as any).requestAnimationFrame })   //absent au départ = retiré, jamais laissé fuiter
  beforeEach(() => {
    __prevWindow = (globalThis as any).window
    __prevDocument = (globalThis as any).document
    __prevCustomEvent = (globalThis as any).CustomEvent
    __prevCustomElements = (globalThis as any).customElements
  })
  afterEach(() => {
    ;(globalThis as any).window = __prevWindow
    ;(globalThis as any).document = __prevDocument
    ;(globalThis as any).CustomEvent = __prevCustomEvent
    ;(globalThis as any).customElements = __prevCustomElements
  })

  function loadRouter(win: any) {
    const µ: any = { log() {}, warn() {}, error() {} }
    const g: any = globalThis
    g.window = win
    g.document = win.document
    g.CustomEvent = win.CustomEvent
    g.customElements = win.customElements
    // getComputedStyle : global du navigateur (implicite via `window` en vrai navigateur) —
    // le code exécuté par `new Function` ne ferme QUE sur la portée globale véritable, donc
    // sans cette ligne l'appel bare `getComputedStyle(...)` de µ._mjs_vtGhost (mjs_vt_presets.ts)
    // lève un ReferenceError. happy-dom peut renvoyer une déclaration VIDE (length 0) : accepté,
    // la copie de styles boucle alors sur rien.
    g.getComputedStyle = typeof win.getComputedStyle === 'function' ? win.getComputedStyle.bind(win) : g.getComputedStyle
    // idem pour requestAnimationFrame (µ._mjs_vtCurtainRun, mjs_vt_presets.ts) : bare global,
    // absent de happy-dom sur certaines versions — repli setTimeout(~1 frame) sinon.
    g.requestAnimationFrame = typeof win.requestAnimationFrame === 'function' ? win.requestAnimationFrame.bind(win) : (cb: any) => setTimeout(cb, 16)
    new Function('µ', ROUTER)(µ)
    // couche de lévitation (_mjs_vtCollectNamed/_mjs_vtHoistStart/_mjs_vtHoistSwap/_mjs_vtHoistEnd) : définie
    // dans mjs_vt_presets.ts, un fichier SOURCE DISTINCT de mjs_router.ts — chargé ici aussi
    // pour que les tests de lévitation (describe dédié plus bas) trouvent ces fonctions sur µ.
    new Function('µ', VT_PRESETS)(µ)
    return µ
  }

  it('sans document.startViewTransition (dégradé gracieux) → _mjs_vtEnabled() false', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    assert.equal(µ.Router._mjs_vtEnabled(), false, "happy-dom n'implémente pas startViewTransition — dégradé gracieux attendu")
  })

  it('_mjs_vtEnabled() : true dès que l\'API existe et prefers-reduced-motion n\'est pas actif — GATE PURE, indépendante de toute vue/composant (_mjs_awareComponents vide)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    win.document.startViewTransition = function (cb: any) { cb() }
    const µ = loadRouter(win)
    assert.equal(µ.Router._mjs_vtEnabled(), true, 'la gate ne parcourt plus les vues — plus besoin de composant enregistré')
  })

  it('prefers-reduced-motion: reduce → _mjs_vtEnabled() false même si l\'API existe (accessibilité, gate seule)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    win.document.startViewTransition = function (cb: any) { cb() }
    win.matchMedia = () => ({ matches: true })
    const µ = loadRouter(win)
    assert.equal(µ.Router._mjs_vtEnabled(), false)
  })

  it('_mjs_vtResolve : data-mjs-vt="off" sur la vue gagne sur @viewTransition="on" du composant ET sur µ.viewTransition=true → false', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = true
    const comp = { _mjs_viewTransition: 'on' }
    const node = { getAttribute: (n: string) => (n === 'data-mjs-vt' ? 'off' : null) }
    assert.equal(µ.Router._mjs_vtResolve(comp, node), false)
  })

  it('_mjs_vtResolve : data-mjs-vt="zoom" (nom de préréglage) sur la vue gagne sur tout le reste → "zoom" (chaîne, pas un booléen)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = true
    const comp = { _mjs_viewTransition: 'off' }
    const node = { getAttribute: (n: string) => (n === 'data-mjs-vt' ? 'zoom' : null) }
    assert.equal(µ.Router._mjs_vtResolve(comp, node), 'zoom')
  })

  it('_mjs_vtResolve : @viewTransition du composant gagne sur µ.viewTransition (défaut global) quand aucun attribut n\'est posé → true', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = false
    const comp = { _mjs_viewTransition: 'on' }
    const node = { getAttribute: () => null }
    assert.equal(µ.Router._mjs_vtResolve(comp, node), true, 'la directive racine du composant doit gagner même si le défaut global dit "off"')
  })

  it('_mjs_vtResolve : @viewTransition="slide-left" du composant (nom) gagne sur µ.viewTransition quand aucun attribut de vue n\'est posé → "slide-left"', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = true
    const comp = { _mjs_viewTransition: 'slide-left' }
    const node = { getAttribute: () => null }
    assert.equal(µ.Router._mjs_vtResolve(comp, node), 'slide-left')
  })

  it('_mjs_vtResolve : µ.viewTransition=true seul (aucun attribut, aucune directive module) → true', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = true
    assert.equal(µ.Router._mjs_vtResolve(null, null), true)
  })

  it('_mjs_vtResolve : µ.viewTransition="fade" (config en CHAÎNE) seul → "fade"', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = 'fade'
    assert.equal(µ.Router._mjs_vtResolve(null, null), 'fade')
  })

  it('_mjs_vtResolve : aucun niveau réglé → false (défaut)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    assert.equal(µ.Router._mjs_vtResolve(null, null), false)
  })

  it('_mjs_vtResolve : µ.viewTransition="none" (valeur config « désactivé ») → false, jamais traité comme un nom', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = 'none'
    assert.equal(µ.Router._mjs_vtResolve(null, null), false)
  })

  it('_mjs_vtResolve : data-mjs-vt="none" sur la vue ≡ "off" — coupe même si composant et config sont actifs', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    const µ = loadRouter(win)
    µ.viewTransition = 'fade'
    const node = { getAttribute: (n: string) => (n === 'data-mjs-vt' ? 'none' : null) }
    assert.equal(µ.Router._mjs_vtResolve({ _mjs_viewTransition: 'zoom' }, node), false)
  })

  function makeRoutedComponent(win: any, dataMjsVt: string) {
    const document = win.document
    const comp: any = document.createElement('div')
    const view: any = document.createElement('metamjs-view')
    view.id = 'main'
    view.setAttribute('data-mjs-vt', dataMjsVt)
    comp._shadow = comp // simplifie : querySelector direct sur comp
    comp.appendChild(view)
    comp.routes = { main: { '/x': 'page-x' } }
    return comp
  }

  it('_vtResolveActive() : true si au moins une vue routée résout "on" (document.startViewTransition stubbé)', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    win.document.startViewTransition = function (cb: any) { cb() }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'on'))
    assert.equal(µ.Router._vtResolveActive(), true)
  })

  it('_vtResolveActive() : résout le NOM du préréglage (pas juste true) quand la vue en porte un', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    win.document.startViewTransition = function (cb: any) { cb() }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'zoom'))
    assert.equal(µ.Router._vtResolveActive(), 'zoom')
  })

  it('_vtResolveActive() : false si aucune vue routée n\'est enregistrée', () => {
    const win: any = new Window({ url: 'http://localhost/' })
    win.document.startViewTransition = function (cb: any) { cb() }
    const µ = loadRouter(win)
    assert.equal(µ.Router._vtResolveActive(), false)
  })

  it('navigate() : résolution en CHAÎNE (préréglage) → µ._mjs_vtApplyPreset appelé AVANT document.startViewTransition (ordre vérifié)', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    const order: string[] = []
    win.document.startViewTransition = function (cb: any) { order.push('start'); cb() }
    const µ = loadRouter(win)
    µ._mjs_vtApplyPreset = (name: string) => { order.push('apply:' + name) }
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'slide-left'))

    µ.Router.navigate('#/x', false)

    assert.deepEqual(order, ['apply:slide-left', 'start'], 'le préréglage doit être posé AVANT que la transition ne démarre')
  })

  it('navigate() : résolution booléenne "on" → µ._mjs_vtApplyPreset(true) (purge de la feuille d\'un préréglage précédent) puis document.startViewTransition', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let started = false
    win.document.startViewTransition = function (cb: any) { started = true; cb() }
    const µ = loadRouter(win)
    const applyCalls: any[] = []
    µ._mjs_vtApplyPreset = (v: any) => { applyCalls.push(v) }
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'on'))

    µ.Router.navigate('#/x', false)

    assert.equal(started, true, 'startViewTransition doit démarrer (résolution "on")')
    assert.deepEqual(applyCalls, [true], 'résolution true → _mjs_vtApplyPreset(true) vide la feuille du préréglage précédent')
  })

  it('navigate() : aucune vue active → document.startViewTransition n\'est PAS appelé (chemin synchrone historique)', () => {
    const win: any = new Window({ url: 'http://localhost/#/x' })
    let started = false
    win.document.startViewTransition = function (cb: any) { started = true; cb() }
    const µ = loadRouter(win)
    µ.Router._mjs_awareComponents.add(makeRoutedComponent(win, 'off'))

    µ.Router.navigate('#/x', false)

    assert.equal(started, false)
  })

  describe('_mjs_vtWinner — départage départ/arrivée par priorité (2ᵉ argument @viewTransition, défaut 1)', () => {
    it('aucun des deux côtés → null (rien à départager)', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      assert.equal(µ.Router._mjs_vtWinner(null, null), null)
    })

    it('un seul côté résout → ce côté gagne d\'office', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const from = { value: 'fade', priority: 1 }
      const to = { value: 'cube-left', priority: 1 }
      assert.equal(µ.Router._mjs_vtWinner(from, null), from)
      assert.equal(µ.Router._mjs_vtWinner(null, to), to)
    })

    it('égalité de priorité (défaut 1 des deux côtés) → la page de DÉPART gagne toujours', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const from = { value: 'fade', priority: 1 }
      const to = { value: 'cube-left', priority: 1 }
      assert.equal(µ.Router._mjs_vtWinner(from, to), from)
    })

    it('priorité de l\'ARRIVÉE strictement plus grande → l\'arrivée gagne malgré le départ', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const from = { value: 'fade', priority: 1 }
      const to = { value: 'cube-left', priority: 5 }
      assert.equal(µ.Router._mjs_vtWinner(from, to), to)
    })

    it('priorité du DÉPART strictement plus grande → le départ gagne (renforcé, pas juste le défaut)', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const from = { value: 'fade', priority: 9 }
      const to = { value: 'cube-left', priority: 2 }
      assert.equal(µ.Router._mjs_vtWinner(from, to), from)
    })
  })

  describe('_mjs_vtSideResolve — la préférence PROPRE d\'une page routée prime sur l\'outlet/le composant routeur', () => {
    it('leaf (instance montée) avec sa propre directive @viewTransition → prioritaire, même si l\'outlet dit autre chose', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const leaf = { _mjs_viewTransition: 'cube-left', _mjs_viewTransitionPriority: 5 }
      const comp = { _mjs_viewTransition: 'fade' }
      const node = { getAttribute: (n: string) => (n === 'data-mjs-vt' ? 'zoom' : null) }
      assert.deepEqual(µ.Router._mjs_vtSideResolve(leaf, comp, node), { value: 'cube-left', priority: 5 })
    })

    it('leaf (classe pas encore montée, miroir statique _mjs_vt/_mjs_vtp) → même résolution qu\'une instance', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const leafClass = { _mjs_vt: 'turn', _mjs_vtp: 3 }
      assert.deepEqual(µ.Router._mjs_vtSideResolve(leafClass, null, null), { value: 'turn', priority: 3 })
    })

    it('leaf sans directive propre → repli sur la cascade outlet/composant/config (_mjs_vtResolveWithPriority)', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const leaf = { _mjs_viewTransition: undefined }
      const comp = { _mjs_viewTransition: 'fade', _mjs_viewTransitionPriority: 2 }
      const node = { getAttribute: () => null }
      assert.deepEqual(µ.Router._mjs_vtSideResolve(leaf, comp, node), { value: 'fade', priority: 2 })
    })

    it('aucun côté (ni leaf ni comp ni config ni attribut) → null (ne participe pas au départage)', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      assert.equal(µ.Router._mjs_vtSideResolve(null, null, null), null)
    })
  })

  describe('_mjs_vtResolveNavigation / navigate() — bout-en-bout, priorité posée sur la page CIBLE', () => {
    function makeNavTestComponent(win: any, fromLeaf: any) {
      const document = win.document
      const comp: any = document.createElement('div')
      const view: any = document.createElement('metamjs-view')
      view.id = 'main'
      if (fromLeaf) { view.appendChild(fromLeaf) }
      comp._shadow = comp
      comp.appendChild(view)
      comp.routes = { main: { '/y': 'page-y' } }
      return comp
    }

    it('la page CIBLE (arrivée) porte une priorité plus grande que la page de départ → son nom gagne', () => {
      const win: any = new Window({ url: 'http://localhost/#/y' })
      win.document.startViewTransition = function (cb: any) { cb() }
      const µ = loadRouter(win)

      class ArrivalLeaf extends win.HTMLElement {}
      ;(ArrivalLeaf as any)._mjs_vt = 'cube-left'
      ;(ArrivalLeaf as any)._mjs_vtp = 5
      // enregistré sous le TAG préfixé (mjs-page-y), comme le fait toute vraie
      // compilation — la route, elle, porte le nom NU ('page-y') : c'est la
      // dérivation `mjs-${module}` de _mjs_vtResolveNavigation qui fait le pont
      // (régression réelle : customElements.get(nom nu) → undefined → la CIBLE
      // ne participait jamais au départage en conditions réelles)
      win.customElements.define('mjs-page-y', ArrivalLeaf)

      const fromLeaf = win.document.createElement('div')
      fromLeaf._mjs_viewTransition = 'fade'
      fromLeaf._mjs_viewTransitionPriority = 1

      const applied: string[] = []
      µ._mjs_vtApplyPreset = (name: string) => applied.push(name)
      µ.Router._mjs_awareComponents.add(makeNavTestComponent(win, fromLeaf))

      const winner = µ.Router._mjs_vtResolveNavigation('/y')
      assert.deepEqual(winner, { value: 'cube-left', priority: 5 })

      µ.Router.navigate('#/y', false)
      assert.deepEqual(applied, ['cube-left'], 'la CIBLE (priorité 5) doit gagner sur le DÉPART (priorité 1 par défaut)')
    })

    it('priorités égales (1 par défaut des deux côtés) → la page de DÉPART gagne (comportement par défaut demandé)', () => {
      const win: any = new Window({ url: 'http://localhost/#/y' })
      win.document.startViewTransition = function (cb: any) { cb() }
      const µ = loadRouter(win)

      class ArrivalLeaf2 extends win.HTMLElement {}
      ;(ArrivalLeaf2 as any)._mjs_vt = 'cube-left'
      // pas de _mjs_vtp → défaut 1 ; tag préfixé, cf. le test précédent
      win.customElements.define('mjs-page-y', ArrivalLeaf2)

      const fromLeaf = win.document.createElement('div')
      fromLeaf._mjs_viewTransition = 'fade'
      fromLeaf._mjs_viewTransitionPriority = 1

      const applied: string[] = []
      µ._mjs_vtApplyPreset = (name: string) => applied.push(name)
      µ.Router._mjs_awareComponents.add(makeNavTestComponent(win, fromLeaf))

      µ.Router.navigate('#/y', false)
      assert.deepEqual(applied, ['fade'], 'égalité de priorité → le DÉPART (fade) doit gagner, pas la cible (cube-left)')
    })
  })

  describe('couche de lévitation (#mjs-vt-hoist) — éléments nommés en shadow levés au-dessus du body', function () {
    it('_mjs_vtCollectNamed : trouve les noms INLINE à travers les _shadow imbriqués', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const host = win.document.createElement('div')
      const inner = win.document.createElement('div')
      const named = win.document.createElement('span')
      // happy-dom ne reconnaît pas l'accesseur camelCase viewTransitionName pour la
      // lecture depuis l'attribut : setAttribute pour que le sélecteur du runtime
      // ([style*="view-transition-name"]) matche, PUIS l'assignation camelCase (même
      // instance .style, persiste) pour que la lecture runtime (el.style.viewTransitionName)
      // fonctionne aussi — sans ce doublon, happy-dom seul ne satisfait ni l'un ni l'autre.
      named.setAttribute('style', 'view-transition-name: hero')
      named.style.viewTransitionName = 'hero'
      const sh1: any = host.attachShadow({ mode: 'open' })
      ;(host as any)._shadow = sh1
      sh1.appendChild(inner)
      const sh2: any = inner.attachShadow({ mode: 'open' })
      ;(inner as any)._shadow = sh2
      sh2.appendChild(named)
      win.document.body.appendChild(host)
      const out = µ._mjs_vtCollectNamed()
      assert.equal(out.length, 1)
      assert.equal(out[0].name, 'hero')
      assert.equal(out[0].el, named)
    })

    it('_mjs_vtHoistStart/_mjs_vtHoistSwap/_mjs_vtHoistEnd : fantôme nommé dans la couche, original masqué, restauration complète', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const host = win.document.createElement('div')
      const named = win.document.createElement('span')
      // happy-dom ne reconnaît pas l'accesseur camelCase viewTransitionName pour la
      // lecture depuis l'attribut : setAttribute pour que le sélecteur du runtime
      // ([style*="view-transition-name"]) matche, PUIS l'assignation camelCase (même
      // instance .style, persiste) pour que la lecture runtime (el.style.viewTransitionName)
      // fonctionne aussi — sans ce doublon, happy-dom seul ne satisfait ni l'un ni l'autre.
      named.setAttribute('style', 'view-transition-name: hero')
      named.style.viewTransitionName = 'hero'
      const sh: any = host.attachShadow({ mode: 'open' })
      ;(host as any)._shadow = sh
      sh.appendChild(named)
      win.document.body.appendChild(host)

      const state = µ._mjs_vtHoistStart()
      assert.ok(state, 'des éléments nommés existent → un état est renvoyé')
      const layer = win.document.getElementById('mjs-vt-hoist')
      assert.ok(layer, 'la couche est posée dans le body')
      assert.equal(layer.children.length, 1)
      assert.equal(layer.children[0].style.viewTransitionName, 'hero', 'le fantôme porte le nom')
      assert.equal(named.style.visibility, 'hidden', 'l\'original est masqué (pas de double dans le cliché racine)')

      named.style.viewTransitionName = ''
      µ._mjs_vtHoistSwap(state)
      assert.equal(named.style.visibility, '', 'la visibilité du DÉPART est restaurée au swap (page cachée en LRU comprise)')
      assert.equal(layer.children.length, 0, 'plus rien de nommé côté arrivée → couche vide')

      µ._mjs_vtHoistEnd(state)
      assertAbsent(win.document.getElementById('mjs-vt-hoist'), 'la couche est démontée par _mjs_vtHoistEnd')
    })

    it('_mjs_vtHoistSwapSettled : les styles d\'ARRIVÉE qui atterrissent un battement après l\'injection sont quand même levés (les statiques du composant arrivent après appendChild)', async () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const host = win.document.createElement('div')
      const named = win.document.createElement('span')
      named.setAttribute('style', 'view-transition-name: hero')
      named.style.viewTransitionName = 'hero'
      const sh: any = host.attachShadow({ mode: 'open' })
      ;(host as any)._shadow = sh
      sh.appendChild(named)
      win.document.body.appendChild(host)

      const state = µ._mjs_vtHoistStart()
      assert.ok(state)
      // simule le swap : le départ perd son nom, l'ARRIVÉE ne sera nommée qu'au
      // prochain battement (comme les styles statiques d'un composant injecté)
      named.setAttribute('style', '')
      const arrivee = win.document.createElement('span')
      sh.appendChild(arrivee)
      setTimeout(() => {
        arrivee.setAttribute('style', 'view-transition-name: hero')
        arrivee.style.viewTransitionName = 'hero'
      }, 0)

      await µ._mjs_vtHoistSwapSettled(state)
      const layer = win.document.getElementById('mjs-vt-hoist')
      assert.equal(layer.children.length, 1, 'le fantôme d\'arrivée doit exister malgré le nom posé en retard')
      assert.equal(layer.children[0].style.viewTransitionName, 'hero')
      assert.equal(arrivee.style.visibility, 'hidden', 'l\'original d\'arrivée est masqué une fois levé')
      µ._mjs_vtHoistEnd(state)
    })

    it('navigate() sous VT : la couche vit pendant TOUTE l\'animation et disparaît à finished (résolue OU rejetée — jamais ready : new(nom) est une image VIVANTE du fantôme)', async () => {
      const win: any = new Window({ url: 'http://localhost/#/y' })
      let finishedResolve: any
      const finished = new Promise((res) => { finishedResolve = res })
      win.document.startViewTransition = function (cb: any) { cb(); return { ready: Promise.resolve(), finished } }
      const µ = loadRouter(win)
      µ.viewTransition = 'fade'

      const comp: any = win.document.createElement('div')
      const view: any = win.document.createElement('metamjs-view')
      view.id = 'main'
      const leaf: any = win.document.createElement('div')
      const named = win.document.createElement('span')
      // happy-dom ne reconnaît pas l'accesseur camelCase viewTransitionName pour la
      // lecture depuis l'attribut : setAttribute pour que le sélecteur du runtime
      // ([style*="view-transition-name"]) matche, PUIS l'assignation camelCase (même
      // instance .style, persiste) pour que la lecture runtime (el.style.viewTransitionName)
      // fonctionne aussi — sans ce doublon, happy-dom seul ne satisfait ni l'un ni l'autre.
      named.setAttribute('style', 'view-transition-name: hero')
      named.style.viewTransitionName = 'hero'
      leaf.appendChild(named)
      view.appendChild(leaf)
      comp._shadow = comp
      comp.appendChild(view)
      comp.routes = { main: { '/y': 'page-y' } }
      win.document.body.appendChild(comp)
      µ.Router._mjs_awareComponents.add(comp)

      µ.Router.navigate('#/y', false)
      assert.ok(win.document.getElementById('mjs-vt-hoist'), 'couche présente après le callback (captures en cours)')
      await new Promise((r) => setTimeout(r, 0))
      assert.ok(win.document.getElementById('mjs-vt-hoist'), 'couche TOUJOURS là après ready — le fantôme alimente new(nom) pendant l\'animation')
      finishedResolve()
      await finished
      await new Promise((r) => setTimeout(r, 0))
      assertAbsent(win.document.getElementById('mjs-vt-hoist'), 'couche démontée à finished')
    })

    it('course : un nettoyage TARDIF (transition sautée) ne ré-affiche pas un original repris par la transition suivante, et la visibilité INITIALE n\'est jamais empoisonnée', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      const host = win.document.createElement('div')
      const named = win.document.createElement('span')
      named.setAttribute('style', 'view-transition-name: hero')
      named.style.viewTransitionName = 'hero'
      const sh: any = host.attachShadow({ mode: 'open' })
      ;(host as any)._shadow = sh
      sh.appendChild(named)
      win.document.body.appendChild(host)

      const s1 = µ._mjs_vtHoistStart()
      const s2 = µ._mjs_vtHoistStart()
      assert.ok(s1 && s2)
      µ._mjs_vtHoistEnd(s1)
      assert.equal(named.style.visibility, 'hidden', 'state1 périmé (owner=state2) ne restaure RIEN — sinon double nom à la capture old')
      µ._mjs_vtHoistEnd(s2)
      assert.equal(named.style.visibility, '', 'state2 restaure la visibilité INITIALE (pas le hidden posé par state1)')
    })
  })

  describe('rideaux « à travers le noir » (µ._mjs_vtCurtainRun)', function () {
    this.timeout(5000)
    it('_mjs_vtParse : RETRAIT — suffixe :direction et alias suffixés ne sont plus splittés, repli tolérant sur la partie avant le `:` (4 champs, durationMs/priority null par défaut)', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      assert.deepEqual(µ._mjs_vtParse('cube:up'), { base: 'cube', dir: null, durationMs: null, priority: null }, "repli sur 'cube', la direction 'up' n'est PLUS honorée")
      assert.deepEqual(µ._mjs_vtParse('slide-left'), { base: 'slide-left', dir: null, durationMs: null, priority: null }, "alias RETIRÉ — plus de split, le nom reste tel quel (base inconnue)")
      assert.deepEqual(µ._mjs_vtParse('turn-right'), { base: 'turn-right', dir: null, durationMs: null, priority: null })
      assert.deepEqual(µ._mjs_vtParse('fade'), { base: 'fade', dir: null, durationMs: null, priority: null })
      assert.equal(µ._mjs_vtParse('cube:diagonal').base, 'cube', "TOUT `:` dans le nom replie avant le `:` — peu importe ce qui suit (même une 'direction' invalide)")
    })

    it('_mjs_vtParse : syntaxe OBJET — clés longues ET courtes (dir/dur/p) mixables, duration en nombre NU, guillemets facultatifs', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      assert.deepEqual(
        µ._mjs_vtParse('cube={ direction: left, duration: 600, priority: 2 }'),
        { base: 'cube', dir: 'left', durationMs: 600, priority: 2 },
      )
      assert.deepEqual(
        µ._mjs_vtParse('cube={ dir: left, dur: 600, p: 2 }'),
        { base: 'cube', dir: 'left', durationMs: 600, priority: 2 },
        'les 3 clés en forme COURTE, même résultat',
      )
      assert.equal(µ._mjs_vtParse('cube={ duration: 600 }').durationMs, 600, 'entier nu = ms')
      assert.equal(µ._mjs_vtParse(`cube={ direction: "left" }`).dir, 'left', 'guillemets doubles autour de la valeur tolérés')
      assert.equal(µ._mjs_vtParse(`cube={ direction: 'left' }`).dir, 'left', 'guillemets simples tolérés')
    })

    it("_mjs_vtParse : RETRAIT — duration AVEC unité (ms/s) → µ.warn + option ignorée (nombre nu uniquement, façon setTimeout)", () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const warns: any[] = []
      const µ0: any = { log() {}, warn: (...a: any[]) => warns.push(a) }
      const g: any = globalThis
      g.window = win; g.document = win.document; g.CustomEvent = win.CustomEvent; g.customElements = win.customElements
      new Function('µ', VT_PRESETS)(µ0)
      const r = µ0._mjs_vtParse('cube={ duration: 600ms }')
      assert.equal(r.durationMs, null, 'duration ignorée (unité non acceptée)')
      assert.equal(warns.length, 1)
      assert.match(warns[0][0], /un nombre nu en millisecondes/)
      const r2 = µ0._mjs_vtParse('cube={ duration: 0.6s }')
      assert.equal(r2.durationMs, null)
      assert.equal(warns.length, 2)
    })

    it("_mjs_vtParse : suffixe ':direction' RETIRÉ dans le nom → µ.warn + repli, PUIS l'option direction (si présente) s'applique normalement (plus de « double » possible par cette voie)", () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const warns: any[] = []
      const µ0: any = { log() {}, warn: (...a: any[]) => warns.push(a) }
      const g: any = globalThis
      g.window = win; g.document = win.document; g.CustomEvent = win.CustomEvent; g.customElements = win.customElements
      new Function('µ', VT_PRESETS)(µ0)
      const r = µ0._mjs_vtParse('cube:left={ direction: right, priority: 3 }')
      assert.equal(r.base, 'cube', "repli sur 'cube', le suffixe ':left' est écarté")
      assert.equal(r.dir, 'right', "l'option direction s'applique SANS conflit — le dir du suffixe a été mis à null avant le parsing des options")
      assert.equal(r.priority, 3)
      assert.equal(warns.length, 1, 'un seul warn — celui du suffixe retiré (plus de notion de double par cette voie)')
      assert.match(warns[0][0], /la direction ne s'écrit plus dans le nom/)
    })

    it("_mjs_vtParse : clé en double (forme courte ET longue de la MÊME option) → µ.warn, 2e occurrence ignorée", () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const warns: any[] = []
      const µ0: any = { log() {}, warn: (...a: any[]) => warns.push(a) }
      const g: any = globalThis
      g.window = win; g.document = win.document; g.CustomEvent = win.CustomEvent; g.customElements = win.customElements
      new Function('µ', VT_PRESETS)(µ0)
      const r = µ0._mjs_vtParse('cube={ dir: left, direction: right, priority: 3 }')
      assert.equal(r.dir, 'left', 'la 1re occurrence (dir: left) est conservée, la 2e (direction: right) ignorée')
      assert.equal(r.priority, 3, 'les AUTRES options valides restent parsées malgré le warn')
      assert.equal(warns.length, 1)
      assert.match(warns[0][0], /clé 'direction' en double/)
    })

    it("_mjs_vtParse : clé d'option inconnue → µ.warn (liste les 3 clés valides, forme longue/courte), option ignorée, le reste tolérant", () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const warns: any[] = []
      const µ0: any = { log() {}, warn: (...a: any[]) => warns.push(a) }
      const g: any = globalThis
      g.window = win; g.document = win.document; g.CustomEvent = win.CustomEvent; g.customElements = win.customElements
      new Function('µ', VT_PRESETS)(µ0)
      const r = µ0._mjs_vtParse('cube={ couleur: rouge, priority: 1 }')
      assert.equal(r.base, 'cube')
      assert.equal(r.priority, 1)
      assert.equal(warns.length, 1)
      assert.match(warns[0][0], /clé inconnue 'couleur'/)
      assert.match(warns[0][0], /direction\/dir, duration\/dur, priority\/p/)
    })

    it('_mjs_vtParse : chaîne malformée (accolade non fermée) → µ.warn + repli name-only (tronqué au premier \'=\'), jamais de crash', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const warns: any[] = []
      const µ0: any = { log() {}, warn: (...a: any[]) => warns.push(a) }
      const g: any = globalThis
      g.window = win; g.document = win.document; g.CustomEvent = win.CustomEvent; g.customElements = win.customElements
      new Function('µ', VT_PRESETS)(µ0)
      const r = µ0._mjs_vtParse('cube=oops sans accolade')
      assert.equal(r.base, 'cube', "repli sur le nom tronqué à '='")
      assert.equal(r.durationMs, null)
      assert.equal(warns.length, 1)
      assert.match(warns[0][0], /valeur malformée/)
    })
    it('cycle complet : couvre (calque + classe cover) → swap SOUS le noir → révèle → démonte', async () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      let swapped = false
      const ok = µ._mjs_vtCurtainRun('iris', () => { swapped = true })
      assert.equal(ok, true)
      const layer = win.document.getElementById('mjs-vt-curtain')
      assert.ok(layer, 'calque posé')
      assert.equal(layer.className, 'mjs-vtc-cover')
      const sheetEl = win.document.getElementById('mjs-vt-curtain-css')
      assert.ok(sheetEl, 'feuille du rideau injectée')
      assert.match(sheetEl.textContent, /--mjs-vtc-r/, 'rayon animé par la propriété enregistrée (anti-clignotement)')
      assert.doesNotMatch(sheetEl.textContent, /mask-size/, 'plus de mask-size animé sur le cycle réel _mjs_vtCurtainRun')
      assert.equal(swapped, false, 'le swap attend le noir complet')
      await new Promise((r) => setTimeout(r, 420))
      assert.equal(swapped, true, 'swap exécuté après coverMs')
      await new Promise((r) => setTimeout(r, 700))
      assertAbsent(win.document.getElementById('mjs-vt-curtain'), 'calque démonté après la révélation')
      assertAbsent(win.document.getElementById('mjs-vt-curtain-css'), 'feuille du rideau démontée')
    })
    it('duration (nombre nu) met à l\'échelle le CSS ET les minuteries JS (coverMs/revealMs) par le MÊME facteur (iris : défaut 340+380=720ms, duration:360 → facteur 0.5)', async () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      let swapped = false
      const ok = µ._mjs_vtCurtainRun('iris={ duration: 360 }', () => { swapped = true })
      assert.equal(ok, true)
      const sheetEl = win.document.getElementById('mjs-vt-curtain-css')
      assert.match(sheetEl.textContent, /\.17s/, 'coverMs scalé ×0.5 dans le CSS (.34s → .17s)')
      assert.match(sheetEl.textContent, /\.19s/, 'revealMs scalé ×0.5 dans le CSS (.38s → .19s)')
      assert.equal(swapped, false, 'le swap attend toujours le noir complet (coverMs scalé, pas 0)')
      await new Promise((r) => setTimeout(r, 220))
      assert.equal(swapped, true, 'swap exécuté après le coverMs SCALÉ (~170ms), pas le coverMs par défaut (340ms)')
      await new Promise((r) => setTimeout(r, 350))
      assertAbsent(win.document.getElementById('mjs-vt-curtain'), 'calque démonté après le revealMs SCALÉ (~190ms) + marge')
    })
    it('base non-rideau → false, aucun calque', () => {
      const win: any = new Window({ url: 'http://localhost/' })
      const µ = loadRouter(win)
      assert.equal(µ._mjs_vtCurtainRun('cube', () => {}), false)
      assertAbsent(win.document.getElementById('mjs-vt-curtain'))
    })
    it('navigate() : un préréglage rideau court-circuite startViewTransition', async () => {
      const win: any = new Window({ url: 'http://localhost/#/y' })
      let vtCalled = false
      win.document.startViewTransition = function (cb: any) { vtCalled = true; cb(); return { ready: Promise.resolve(), finished: Promise.resolve() } }
      const µ = loadRouter(win)
      µ.viewTransition = 'bars'
      const comp: any = win.document.createElement('div')
      const view: any = win.document.createElement('metamjs-view')
      view.id = 'main'
      comp._shadow = comp
      comp.appendChild(view)
      comp.routes = { main: { '/y': 'page-y' } }
      win.document.body.appendChild(comp)
      µ.Router._mjs_awareComponents.add(comp)
      µ.Router.navigate('#/y', false)
      assert.equal(vtCalled, false, 'rideau → PAS de startViewTransition')
      assert.ok(win.document.getElementById('mjs-vt-curtain'), 'calque rideau posé')
      // vidange le cycle complet du rideau ('bars' : coverMs 620 + revealMs 640) avant
      // de rendre la main — sinon le setTimeout différé de _mjs_vtCurtainRun (swap = _mjsInject
      // du routeur) survit au test et explose plus tard, sur un tout autre fichier/describe,
      // quand `document` global a déjà été restauré par un autre beforeEach/afterEach.
      await new Promise((r) => setTimeout(r, 1500))
    })
  })
})

// L'alias `@vt` sur l'attribut de <style> a VÉCU une nuit :
// REFUSÉ désormais, seule `@viewTransition` (forme POINTÉE) reste — même
// grammaire que `<@view @viewTransition.<nom>={…}>` (sections.ts,
// extractStyleViewTransition). L'ancienne forme à guillemets `="…"` est REFUSÉE
// elle aussi (n'a vécu qu'une nuit).
describe('<style @viewTransition.<nom>={…}> — forme pointée, alias @vt et guillemets refusés', () => {
  it('<style @viewTransition.cube={ dir: left }> → valeur et priorité extraites', async () => {
    const r = extractSections('<style @viewTransition.cube={ dir: left }></style>\n<p>x</p>')
    assert.equal(r.style.moduleViewTransition, 'cube={ dir: left }')
  })

  it('<style @viewTransition.zoom> → nom seul, sans options', async () => {
    const r = extractSections('<style @viewTransition.zoom></style>\n<p>x</p>')
    assert.equal(r.style.moduleViewTransition, 'zoom')
  })

  it('<style @viewTransition> nu → sentinel "on"', async () => {
    const r = extractSections('<style @viewTransition></style>\n<p>x</p>')
    assert.equal(r.style.moduleViewTransition, 'on')
  })

  it('<style @viewTransition="cube={ dir: left }"> (forme à guillemets) → REFUSÉE', async () => {
    await assert.rejects(
      transpile('<style @viewTransition="cube={ dir: left }"></style>\n<p>x</p>', { moduleName: 'vt-style-quoted' }),
      /@viewTransition="…" avec guillemets n'existe plus/,
    )
  })

  it('<style @vt.cube={…}> (alias) → REFUSÉ, message oriente vers @viewTransition', async () => {
    await assert.rejects(
      transpile('<style @vt.cube={ dir: left }></style>\n<p>x</p>', { moduleName: 'vt-style-alias' }),
      /@vt n'est pas un alias sur <style>.*@viewTransition/,
    )
  })
})
