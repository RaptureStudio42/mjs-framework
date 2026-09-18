// Runtime µ._hotCss (rechargement CSS à chaud en dev) : pipeline
// RÉEL (Bundler → mjs_core + composant chargés dans happy-dom, qui fournit
// nativement CSSStyleSheet constructible + replaceSync + adoptedStyleSheets).
//
// Vérifie :
//   - l'index µ._mjs_componentStyleByTag est rempli à l'adoption (sans toucher au
//     cache par texte existant) ;
//   - _hotCss mute la feuille ADOPTÉE en place (les shadow roots vivantes
//     voient le nouveau CSS sans re-mount) et réindexe le cache par texte
//     (nouvelle clé ajoutée, ANCIENNE conservée : une instance future d'une
//     classe déjà chargée porte encore l'ancien littéral _mjs_baseCss) ;
//   - retours `false` (repli reload côté snippet) : composant jamais chargé,
//     feuille partagée entre tags divergents, feuille µ.CSS/root inconnue ;
//   - mode mjs-light : <style data-mjs-css> remplacé + Set de dédup réindexé ;
//   - feuilles partagées µ.CSS[name] et mjs_root : replaceSync en place.

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { mjsTmp } from './helpers/tmp.js'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'

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

const stripEsm = (s: string) => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

async function loadHarness() {
  const root = mjsTmp('hotcss')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hotcss.mjs'), COMPONENT)
  writeFileSync(join(srcDir, 'jumeau.mjs'), COMPONENT)  // CSS byte-identique → feuille PARTAGÉE

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  const files = readdirSync(outDir)
  const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
  const hotcssFile = files.find((f: string) => /^hotcss-/.test(f))
  const jumeauFile = files.find((f: string) => /^jumeau-/.test(f))
  assert.ok(coreFile && hotcssFile && jumeauFile)
  window.eval([
    stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    'globalThis.µ = µ;',
    stripEsm(readFileSync(join(outDir, hotcssFile!), 'utf-8')),
    stripEsm(readFileSync(join(outDir, jumeauFile!), 'utf-8')),
  ].join('\n'))
  return { window, document }
}

const sheetText = (sheet: any): string => Array.from(sheet.cssRules).map((r: any) => r.cssText).join(' ')

describe('runtime — µ._hotCss (rechargement CSS à chaud)', function () {
  this.timeout(60000)

  after(async () => { await terminateSharedWorkerPool() })

  it('adoption : µ._mjs_componentStyleByTag rempli, cache par texte INCHANGÉ dans son rôle', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    const sheet = µ._mjs_componentStyleByTag.get('mjs-hotcss')
    assert.ok(sheet, 'la feuille adoptée doit être indexée par tag')
    assert.equal(µ._mjs_componentStyleCache.get(el._mjs_baseCss), sheet, 'même objet que le cache par texte (aucune 2e feuille créée)')
    assert.ok(el._shadow.adoptedStyleSheets.includes(sheet), 'la feuille indexée est bien CELLE adoptée par la shadow root')
    assert.match(sheetText(sheet), /color: red/)
  })

  it('hot-swap : replaceSync EN PLACE → la shadow root vivante voit le nouveau CSS, cache réindexé (ancienne clé conservée)', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss><mjs-jumeau></mjs-jumeau>'
    const el: any = document.body.firstElementChild
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    const sheet = µ._mjs_componentStyleByTag.get('mjs-hotcss')
    const oldKey = el._mjs_baseCss
    const newCss = ':host{display:block}.t{color:blue}'

    // jumeau au CSS identique = feuille PARTAGÉE : le payload doit couvrir les
    // DEUX tags avec le même CSS pour que la mutation soit sûre (cf. plus bas
    // le cas divergent → false)
    const ok = µ._hotCss({ components: { 'mjs-hotcss': newCss, 'mjs-jumeau': newCss } })
    assert.equal(ok, true)
    assert.match(sheetText(sheet), /color: blue/)
    assert.ok(!sheetText(sheet).includes('red'))
    assert.ok(el._shadow.adoptedStyleSheets.includes(sheet), 'AUCUN ré-attachement : la même feuille, mutée en place')
    assert.equal(µ._mjs_componentStyleCache.get(newCss), sheet, 'nouvelle clé texte → feuille mutée (montages au nouveau littéral)')
    assert.equal(µ._mjs_componentStyleCache.get(oldKey), sheet, 'ANCIENNE clé conservée : une instance future de la classe déjà chargée (ancien littéral) doit retomber sur la feuille mutée, pas en recréer une périmée')

    // instance future de la classe déjà chargée (ancien littéral _mjs_baseCss)
    document.body.insertAdjacentHTML('beforeend', '<mjs-hotcss id="future"></mjs-hotcss>')
    const future: any = document.getElementById('future')
    await new Promise(r => setTimeout(r, 80))
    assert.ok(future._shadow.adoptedStyleSheets.includes(sheet), 'le montage futur réutilise la feuille MUTÉE (pas de style périmé)')
  })

  it('feuille PARTAGÉE entre tags divergents → false (repli reload, jamais de repeinte croisée)', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss><mjs-jumeau></mjs-jumeau>'
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    const sheet = µ._mjs_componentStyleByTag.get('mjs-hotcss')
    assert.equal(µ._mjs_componentStyleByTag.get('mjs-jumeau'), sheet, 'précondition : CSS identique = feuille partagée')

    const ok = µ._hotCss({ components: { 'mjs-hotcss': ':host{display:block}.t{color:blue}' } })
    assert.equal(ok, false, 'muter la feuille repeindrait AUSSI mjs-jumeau : swap refusé')
    assert.match(sheetText(sheet), /color: red/, 'la feuille partagée ne doit PAS avoir été mutée')
  })

  it('composant jamais chargé (classe non définie) → false (µ.paths périmé, un import lazy ferait 404)', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss>'
    await new Promise(r => setTimeout(r, 80))

    const ok = window.µ._hotCss({ components: { 'mjs-inconnu': '.t{color:blue}' } })
    assert.equal(ok, false)
  })

  it('feuilles partagées µ.CSS[name] : replaceSync en place ; nom inconnu → false', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss>'
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    const theme = new window.CSSStyleSheet()
    theme.replaceSync('.a{color:red}')
    µ.CSS['theme'] = theme

    assert.equal(µ._hotCss({ sheets: { theme: '.a{color:blue}' } }), true)
    assert.match(sheetText(theme), /color: blue/)

    assert.equal(µ._hotCss({ sheets: { fantome: '.z{color:blue}' } }), false, 'feuille jamais chargée par cette page → doute → reload')
  })

  it('mjs_root : replaceSync via µ._mjs_rootStyleSheet ; handle absent → false', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss>'
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    assert.equal(µ._hotCss({ root: 'body{margin:0}' }), false, 'aucun mjs_root adopté par cette page → doute → reload')

    const rootSheet = new window.CSSStyleSheet()
    rootSheet.replaceSync('body{margin:8px}')
    µ._mjs_rootStyleSheet = rootSheet
    assert.equal(µ._hotCss({ root: 'body{margin:0}' }), true)
    assert.match(sheetText(rootSheet), /margin: 0/)
  })

  it('mode mjs-light : <style data-mjs-css> remplacé + Set de dédup réindexé', async () => {
    const { window, document } = await loadHarness()
    // happy-dom ne pose pas l'attribut avant le constructor → repli OFFICIEL
    // prévu par le runtime : propriété statique `mjsLight` sur la classe
    // (cf. commentaire du constructor, mjs_element.ts)
    window.eval('customElements.get("mjs-hotcss").mjsLight = true')
    document.body.innerHTML = '<mjs-hotcss mjs-light></mjs-hotcss>'
    await new Promise(r => setTimeout(r, 80))

    const µ: any = window.µ
    const styleEl = document.head.querySelector('style[data-mjs-css="mjs-hotcss"]')
    assert.ok(styleEl, 'le <style> light doit porter le marqueur data-mjs-css')
    const oldText = styleEl.textContent
    assert.ok(µ._mjs_lightStyleInjected.has(oldText))

    const newCss = ':host{display:block}.t{color:blue}'
    // Le <style> light posé dans le DOM passe désormais par µ._lightHostCss
    // AVANT d'être écrit (:host n'a aucun sens hors shadow, réécrit en nom de balise) : le texte
    // réellement posé, et celui indexé au Set de dédup, est donc CELUI-CI, pas le `newCss` brut
    // envoyé au payload — même sort que oldText plus haut (déjà sans :host dans sa fixture).
    const expectedCss = 'mjs-hotcss{display:block}.t{color:blue}'
    // pas de jumeau monté ici : la feuille du cache n'est partagée par personne
    const ok = µ._hotCss({ components: { 'mjs-hotcss': newCss, 'mjs-jumeau': newCss } })
    assert.equal(ok, true)
    assert.equal(styleEl.textContent, expectedCss, 'textContent du <style> light remplacé en place, :host réécrit en nom de balise')
    assert.ok(µ._mjs_lightStyleInjected.has(expectedCss), 'Set de dédup : nouveau texte (réécrit) ajouté')
    assert.ok(!µ._mjs_lightStyleInjected.has(oldText), 'Set de dédup : ancien texte retiré')
  })

  it('payload vide/nul : true (rien à faire), jamais un crash', async () => {
    const { window, document } = await loadHarness()
    document.body.innerHTML = '<mjs-hotcss></mjs-hotcss>'
    await new Promise(r => setTimeout(r, 80))

    assert.equal(window.µ._hotCss({}), true)
    assert.equal(window.µ._hotCss(null), true)
    assert.equal(window.µ._hotCss({ components: {}, sheets: {} }), true)
  })

  // Sous µ._csp, un composant léger n'a NI shadow NI <style data-mjs-css> : sa
  // feuille est une CSSStyleSheet CONSTRUCTIBLE adoptée par document (ou le shadow de l'ancêtre,
  // hors périmètre ici). Avant correctif, aucune table ne la retient pour _hotCss : le HMR croit
  // le remplacement fait (retour true) mais la feuille RÉELLEMENT adoptée reste périmée — ROUGE
  // sans le correctif (sheetText(sheet) garde `color: red`, jamais `color: blue`).
  describe('mode mjs-light + CSP : feuille constructible adoptée par document, pas de <style>', function () {
    it('_hotCss retrouve la feuille adoptée par document et la mute en place', async () => {
      const root = mjsTmp('hotcss-light-csp')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      const component = [
        '<script lang="coffee">',
        '$titre = "salut"',
        '</script>',
        '<p class="t">{$titre}</p>',
        '<style>',
        ':host',
        '  padding: 1px',
        '.t',
        '  color: red',
        '</style>',
      ].join('\n')
      writeFileSync(join(srcDir, 'hotcsslight.mjs'), component)

      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

      const window: any = new Window({ url: 'http://localhost/' })
      const document: any = window.document
      const files = readdirSync(outDir)
      const coreFile = files.find((f: string) => /^mjs_core-/.test(f))
      const compFile = files.find((f: string) => /^hotcsslight-/.test(f))
      assert.ok(coreFile && compFile, `sortie du build inattendue : ${files.join(', ')}`)
      window.eval([
        stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
        'globalThis.µ = µ;',
        stripEsm(readFileSync(join(outDir, compFile!), 'utf-8')),
      ].join('\n'))
      // happy-dom ne pose pas l'attribut mjs-light avant le constructor → repli officiel du
      // runtime (propriété statique, cf. commentaire du constructor, mjs_element.ts)
      window.eval('customElements.get("mjs-hotcsslight").mjsLight = true')

      const µ: any = window.µ
      µ._csp = true
      try {
        const baseline = document.adoptedStyleSheets.length
        document.body.innerHTML = '<mjs-hotcsslight mjs-light></mjs-hotcsslight>'
        await new Promise(r => setTimeout(r, 80))

        assert.equal(document.querySelectorAll('style[data-mjs-css="mjs-hotcsslight"]').length, 0, 'sous CSP, aucun <style> ne doit être posé')
        const news = document.adoptedStyleSheets.slice(baseline)
        // cssRules[i].cssText est du CSSOM RE-SÉRIALISÉ (espace avant l'accolade, ex.
        // `mjs-hotcsslight { padding: 1px; }`), pas le texte compressé du compilateur —
        // recherche par sous-chaîne SANS l'accolade, comme les autres tests de ce fichier (`/color: blue/`)
        const sheet = news.find((s: any) => sheetText(s).indexOf('mjs-hotcsslight') !== -1)
        assert.ok(sheet, 'la feuille constructible du composant léger doit être adoptée par document')

        const ok = µ._hotCss({ components: { 'mjs-hotcsslight': ':host{color:blue}' } })
        assert.equal(ok, true)
        assert.match(sheetText(sheet), /color: blue/, 'la MÊME feuille adoptée doit porter le nouveau CSS réécrit — sans le correctif, HMR silencieusement inopérant sous CSP')
        assert.notEqual(sheetText(sheet).indexOf('mjs-hotcsslight'), -1, 'sélecteur toujours réécrit par balise')
      } finally {
        µ._csp = false
      }
    })
  })

  // mjs_hotcss.ts (ce fichier) est un module d'INSPECTION/OUTILLAGE dev-only, même règle que
  // mjs_debug/mjs_devinspect/mjs_devpanel (cf. bundler/index.ts, bundleRuntime()) : seul le
  // snippet HMR de `mjs dev` (server/hmr.ts) l'appelle, jamais un bundle servi tel quel.
  describe('µ._hotCss — dev seulement (même règle que le panneau d\'inspection)', function () {
    async function coreFor(prod: boolean): Promise<string> {
      const root = mjsTmp('hotcss-env')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'hce.mjs'), '<p>x</p>\n')
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js'), ...(prod ? { env: 'prod' as const } : {}) })
      const stats = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))
      const files = readdirSync(outDir)
      return readFileSync(join(outDir, files.find(f => /^mjs_core-/.test(f))!), 'utf-8')
    }

    it('ABSENT du bundle de production — zéro poids chez qui déploie', async () => {
      const core = await coreFor(true)
      assert.equal(/µ\._hotCss\s*=/.test(core), false, 'µ._hotCss ne doit pas être dans un bundle de production')
    })

    it('présent en construction de développement (défaut)', async () => {
      const core = await coreFor(false)
      assert.ok(/µ\._hotCss\s*=/.test(core), 'µ._hotCss doit être présent en développement')
    })
  })
})
