// mjs-layout-runtime.test.ts — attribut `layout=` (variant), synonyme déprécié `template=` SANS message, nom inconnu refusé SANS fetch ni
// entrée de cache, cache-busting `?v=<empreinte>`, injection `document.head` dédupliquée en mode
// `mjs-light`. Pipeline RÉEL (Bundler → mjs_core + composant COMPILÉS puis MONTÉS dans happy-dom,
// patron tests/runtime-hotcss.test.ts) — jamais une copie recodée à la main de `_mjs_applyLayout`.
//
// `this._mjs_layouts` (contrat émis par le compilateur : `{nom: empreinte}`, transpiler/index.ts
// § injectTemplate) est réellement posé par le CONSTRUCTEUR généré dès que le composant déclare
// au moins un `<style name="…">` (COMPONENT_WITH_LAYOUT, ci-dessous) — le test du cache-busting
// `?v=` relit CETTE empreinte au lieu de la fabriquer, en la comparant aux octets du satellite
// écrit par le build. Les tests qui n'ont besoin que du NOM (pas de la valeur d'empreinte) gardent la
// fixture SANS variant et posent `_mjs_layouts` à la main sur le PROTOTYPE — `_mjs_applyLayout`
// ne lit que `this._mjs_layouts`, peu importe qui l'a écrit (constructeur généré ou test).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { createHash } from 'node:crypto'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { mjsTmp } from './helpers/tmp.js'

const COMPONENT = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
].join('\n')

// même composant, PLUS un variant réellement déclaré (`<style name="bandeau">`) — sert au
// test qui verrouille la correspondance empreinte compilée ↔ octets du satellite ↔ URL demandée
const COMPONENT_WITH_LAYOUT = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  '.t',
  '  color: red',
  '</style>',
  '<style name="bandeau">',
  '.t',
  '  color: blue',
  '</style>',
].join('\n')

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

// Compile la fixture `layout-demo.mjs` (COMPONENT par défaut, ou `componentSrc` fourni — sert à
// COMPONENT_WITH_LAYOUT pour le test d'empreinte réelle) dans un dossier temp isolé, charge le
// core + le composant dans une Window happy-dom FRAÎCHE, `fetch` stubé (404 par défaut, `setFetch`
// pour changer la réponse), `µ.warn` capté. Retourne le CONSTRUCTEUR RÉEL (pour poser
// `_mjs_layouts`/`mjsLight` avant montage), `outDir` (lire les satellites RÉELLEMENT écrits par
// le build) et les compteurs d'assertion.
async function loadHarness(componentSrc: string = COMPONENT) {
  const root   = mjsTmp('layout')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'layout-demo.mjs'), componentSrc)

  // `runtime: ['layout_variant', 'theme']` — DÉTACHÉ du cœur (mjs_layout_variant.ts, DÉTECTÉ par scan
  // `layout=`/`template=`) : ce harnais appelle `_mjs_applyLayout(nom)` DIRECTEMENT (ci-dessous),
  // jamais via un attribut `layout="…"` écrit dans la fixture .mjs — le scan ne le verrait pas.
  // `theme` forcé explicitement : le test « les deux feuilles de thème » vérifie l'adoption dans
  // le shadow (mjs_element.ts, _mjs_applyLayout) — un besoin indépendant de ce que COMPONENT lit.
  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), runtime: ['layout_variant', 'theme'] })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document

  const fetchCalls: string[] = []
  let fetchImpl: (url: string) => Promise<any> = async () => ({ ok: false, status: 404 })
  window.fetch = (url: string) => { fetchCalls.push(url); return fetchImpl(url) }

  const files    = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const compFile = files.find((f: string) => /^layout-demo-/.test(f))
  assert.ok(coreFile && compFile, `sortie du build inattendue : ${files.join(', ')}`)
  window.eval([
    stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    'globalThis.µ = µ;',
    stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
  ].join('\n'))

  const warned: any[] = []
  window.µ.warn = (...args: any[]) => { warned.push(args) }

  const Ctor = window.customElements.get('mjs-layout-demo')
  assert.ok(Ctor, 'le composant doit être défini sous mjs-layout-demo')

  return {
    window, document, Ctor, fetchCalls, warned, outDir,
    setFetch(impl: (url: string) => Promise<any>) { fetchImpl = impl },
  }
}

describe('mjs_element — _mjs_applyLayout (attribut layout=, variants)', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('layout="bandeau" DÉCLARÉ (empreinte RÉELLE du build) : une seule requête, URL avec ?v=<empreinte du satellite>', async () => {
    const { document, fetchCalls, outDir, setFetch } = await loadHarness(COMPONENT_WITH_LAYOUT)
    const satelliteCss = readFileSync(join(outDir, 'layout-demo.bandeau.css'), 'utf-8')
    const realStamp    = createHash('md5').update(satelliteCss).digest('hex').slice(0, 8)
    setFetch(async () => ({ ok: true, status: 200, text: async () => satelliteCss }))
    document.body.innerHTML = '<mjs-layout-demo layout="bandeau"></mjs-layout-demo>'
    const el: any = document.body.firstElementChild
    assert.equal(el._mjs_layouts && el._mjs_layouts.bandeau, realStamp, "l'empreinte embarquée dans le JS doit correspondre aux octets du satellite écrit par le build")
    await new Promise(r => setTimeout(r, 80))
    assert.equal(fetchCalls.length, 1, 'une seule requête réseau (cache par URL entre les 2 déclenchements internes)')
    assert.match(fetchCalls[0], new RegExp(`layout-demo\\.bandeau\\.css\\?v=${realStamp}$`), fetchCalls[0])
  })

  // Un thème de DOCUMENT (`<div theme="sombre">`) écrit DANS un composant ne matchait
  // AUCUNE règle : une feuille du document ne franchit pas la frontière shadow. Mesuré au
  // navigateur (chip d'une carte en zone `theme="tuto-or"` : gris avant, #d4af37 après), corrigé
  // en adoptant les DEUX feuilles de thème dans chaque shadow. Ce test verrouille le câblage.
  it('les deux feuilles de thème (framework + application) sont adoptées DANS le shadow', async () => {
    const { document } = await loadHarness()
    document.body.innerHTML = '<mjs-layout-demo></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 60))
    const el: any = document.body.firstElementChild
    const adoptees = el._shadow.adoptedStyleSheets
    const µ: any = (document.defaultView as any).µ
    assert.ok(µ._mjs_themeSheet, 'la feuille de thème du framework doit exister au boot')
    assert.ok(µ._mjs_themeAppSheet, "la feuille de thème de l'application doit exister au boot, même vide")
    assert.ok(adoptees.includes(µ._mjs_themeSheet), 'feuille de thème du framework absente du shadow')
    assert.ok(adoptees.includes(µ._mjs_themeAppSheet), "feuille de thème de l'application absente du shadow")
  })

  // Un nom de variant inconnu CRASHE le composant (système
  // d'erreur du framework), il ne se contente plus d'un avertissement : écrit en dur il ne
  // compile même pas, calculé il n'est rattrapable qu'ici.
  it('layout="typo" NON déclaré : le composant CRASHE (système d\'erreur MJS), ZÉRO fetch, ZÉRO entrée de cache', async () => {
    const { window, document, Ctor, fetchCalls } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    document.body.innerHTML = '<mjs-layout-demo></mjs-layout-demo>'
    const el: any = document.body.firstElementChild
    await el._mjs_applyLayout('typo')
    assert.equal(el._mjs_has_crashed, true, 'le composant doit être passé par _mjs_catchError')
    assert.ok(el.classList.contains('mjs-error'), 'la classe mjs-error doit être posée')
    const panneau = el._shadow.querySelector('.mjs-fatal-error')
    assert.ok(panneau, 'sans boundary <@failed>, le panneau fatal doit être affiché')
    assert.match(panneau.textContent, /mjs-layout-demo/, 'le tag du composant doit apparaître')
    assert.match(panneau.textContent, /typo/, 'le nom demandé doit apparaître')
    assert.match(panneau.textContent, /bandeau/, 'la liste des noms connus doit apparaître')
    assert.equal(fetchCalls.length, 0, 'aucune requête réseau pour un nom refusé')
    assert.equal(Object.keys(window.µ._mjs_styleVariantCache || {}).length, 0, 'aucune entrée de cache posée pour un nom refusé')
  })

  it('layout="typo" NON déclaré, posé en HTML : le panneau d\'erreur SURVIT au montage (double appel interne + rendu)', async () => {
    const { document, Ctor } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    document.body.innerHTML = '<mjs-layout-demo layout="typo"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    const el: any = document.body.firstElementChild
    assert.equal(el._mjs_has_crashed, true, 'le composant doit avoir crashé au montage')
    assert.ok(el._shadow.querySelector('.mjs-fatal-error'), "le panneau d'erreur ne doit pas être écrasé par la suite du montage")
  })

  it('template="bandeau" (forme dépréciée) : même effet que layout=, AUCUN message', async () => {
    const { document, Ctor, fetchCalls, warned, setFetch } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    // satellite PRÉSENT (le sujet du test est le synonyme déprécié, pas le fichier manquant —
    // le défaut du stub 404 déclencherait sinon À TORT l'avertissement de fichier manquant)
    setFetch(async () => ({ ok: true, status: 200, text: async () => '.t{color:green}' }))
    document.body.innerHTML = '<mjs-layout-demo template="bandeau"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(fetchCalls.length, 1, 'la forme dépréciée déclenche bien le chargement (une seule requête)')
    assert.match(fetchCalls[0], /layout-demo\.bandeau\.css\?v=a1b2c3d4$/, fetchCalls[0])
    assert.equal(warned.length, 0, 'template= est un synonyme accepté SANS message')
  })

  it('composant SANS _mjs_layouts (aucun variant déclaré) : repli historique intact, fetch tenté, URL NUE (sans ?v=)', async () => {
    const { document, Ctor, fetchCalls, warned, setFetch } = await loadHarness()
    void Ctor // _mjs_layouts volontairement JAMAIS posé sur le prototype ici
    // satellite PRÉSENT (le sujet du test est le repli historique, pas le fichier manquant)
    setFetch(async () => ({ ok: true, status: 200, text: async () => '.t{color:green}' }))
    document.body.innerHTML = '<mjs-layout-demo></mjs-layout-demo>'
    const el: any = document.body.firstElementChild
    await el._mjs_applyLayout('ancien')
    assert.equal(fetchCalls.length, 1, 'le repli historique tente bien le chargement')
    assert.match(fetchCalls[0], /layout-demo\.ancien\.css$/, fetchCalls[0])
    assert.ok(!fetchCalls[0].includes('?v='), 'sans _mjs_layouts, aucune empreinte connue → URL nue')
    assert.equal(warned.length, 0, "le compilateur n'a rien déclaré, rien à contredire")
  })

  it('layout="bandeau" DÉCLARÉ mais satellite ABSENT (404) : 1 avertissement (tag/nom/URL/noms connus), ZÉRO entrée de cache résiduelle', async () => {
    const { window, document, Ctor, fetchCalls, warned } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    document.body.innerHTML = '<mjs-layout-demo layout="bandeau"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(fetchCalls.length, 1, 'une seule requête réseau malgré le double appel interne')
    assert.equal(warned.length, 1, 'un seul avertissement malgré le double appel interne')
    const message = String(warned[0][0])
    assert.match(message, /mjs-layout-demo/, 'le tag du composant doit apparaître')
    assert.match(message, /bandeau/, 'le nom demandé doit apparaître')
    assert.match(message, /layout-demo\.bandeau\.css/, 'URL demandée doit apparaître')
    assert.equal(Object.keys(window.µ._mjs_styleVariantCache || {}).length, 0, 'un résultat vide ne reste jamais en cache — la promesse est retirée')
  })

  it('second montage après un 404 : la requête est RETENTÉE (le satellite a pu redevenir disponible)', async () => {
    const { document, Ctor, fetchCalls } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    document.body.innerHTML = '<mjs-layout-demo layout="bandeau"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(fetchCalls.length, 1, 'premier montage : une tentative')
    document.body.innerHTML = ''
    document.body.innerHTML = '<mjs-layout-demo layout="bandeau"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    assert.equal(fetchCalls.length, 2, "second montage : nouvelle tentative — l'entrée de cache vide n'est jamais figée à vie")
  })

  it('mode mjs-light : le variant est injecté dans document.head, DÉDUPLIQUÉ entre 2 montages au même CSS', async () => {
    const { document, Ctor, fetchCalls, setFetch } = await loadHarness()
    Ctor.prototype._mjs_layouts = { bandeau: 'a1b2c3d4' }
    Ctor.mjsLight = true // happy-dom ne pose pas l'attribut avant constructor (cf. runtime-hotcss.test.ts)
    setFetch(async () => ({ ok: true, status: 200, text: async () => '.t{color:blue}' }))
    document.body.innerHTML =
      '<mjs-layout-demo mjs-light layout="bandeau"></mjs-layout-demo>' +
      '<mjs-layout-demo mjs-light layout="bandeau"></mjs-layout-demo>'
    await new Promise(r => setTimeout(r, 80))
    const styles = document.head.querySelectorAll('style[data-mjs-light-layout="mjs-layout-demo"]')
    assert.equal(styles.length, 1, 'déduplication : un seul <style> pour les 2 instances au même CSS de variant')
    assert.equal(styles[0].textContent, '.t{color:blue}')
    assert.ok(fetchCalls.length >= 1, 'au moins une tentative de chargement')
  })
})
