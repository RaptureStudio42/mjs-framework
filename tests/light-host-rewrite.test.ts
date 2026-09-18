// mode léger (`@lightDom`, `mjs-light`) : `:host` tombait
// jusqu'ici sur le PARENT (feuille adoptée par le document ou l'ancêtre le plus proche) — il n'y
// a pas de vrai host, la règle ne matchait rien, le composant léger restait `display: inline`.
// Correctif : réécriture AU RUNTIME de `:host`/`:host(X)`/`:host-context(X)` en nom de balise
// (`mjs-big-red-button`/`mjs-big-red-button.large`/`.dark mjs-big-red-button`), UNE fois par
// composant (cache par balise + texte), sur les 4 sites d'injection légers de mjs_element.ts
// (baseCss imbriqué, baseCss document, variant, µ._hotCss) + le SSR (renderToString.ts).
// Harnais Bundler réel repris de tests/csp-runtime.test.ts (describe « mjs_element.ts (mode
// mjs-light) »), enrichi du stub fetch de tests/mjs-layout-runtime.test.ts (variants) et du
// patron µ._hotCss de tests/runtime-hotcss.test.ts. Chemin OMBRE (pas de mjs-light) : jamais
// touché, :host y reste correct par construction (vrai shadow root).

import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { Window } from 'happy-dom'
import { Bundler, terminateSharedWorkerPool } from '../src/bundler/index.js'
import { renderToString } from '../src/server/renderToString.js'
import { lightHostCss } from '../src/server/light-host-css.js'
import { mjsTmp } from './helpers/tmp.js'
import { assertAbsent } from './helpers/dom-assert.js'

// composant léger de référence : les 3 formes de :host (nu, à argument, -context), un sélecteur
// combiné (`:host, .x`), un sélecteur sans rapport (`.ghost`), un pseudo-état (`:hover`), un
// media query autour d'un :host, ::slotted (jamais touché) et une variable --host-x (ne doit
// jamais être confondue avec :host par un matching naïf sur la sous-chaîne « host »).
const HOSTLIGHT_STYLE = [
  ':host',
  '  padding: 20px',
  ':host(.large)',
  '  padding: 40px',
  ':host-context(.dark) .t',
  '  text-decoration: underline',
  ':host(:not(.a)) .b',
  '  opacity: 0.5',
  ':host, .x',
  '  opacity: 1',
  '.ghost',
  '  opacity: 0',
  '.t:hover',
  '  text-decoration: line-through',
  '@media (min-width: 1px)',
  '  :host',
  '    display: block',
  '::slotted(span)',
  '  opacity: 0.2',
  ':host',
  '  --host-x: 5px',
].join('\n')

const HOSTLIGHT_COMPONENT = [
  '<script lang="coffee">',
  '$titre = "salut"',
  '</script>',
  '<p class="t">{$titre}</p>',
  '<style>',
  HOSTLIGHT_STYLE,
  '</style>',
].join('\n')

const stripEsm = (s: string): string => s
  .replace(/^\s*import\s+[^;]+;\s*$/gm, '')
  .replace(/^\s*export\s+\{[^}]*\}\s*;?\s*$/gm, '')
  .replace(/\bexport\s+default\s+/g, '')
  .replace(/\bexport\s+/g, '')
  .replace(/import\.meta\.url/g, "'http://localhost/'")

const sheetText = (sheet: any): string => Array.from(sheet.cssRules).map((r: any) => r.cssText).join(' ')

// compile hostlight.mjs + jumeau.mjs (CSS byte-identique, balise différente — sert au test de
// dédoublonnage par balise), charge le core + les deux composants dans une Window happy-dom
// fraîche, `fetch` stubé (404 par défaut, `setFetch` pour changer la réponse — variants).
// `withVariant` : hostlight DÉCLARE `<style name="bandeau">` — seule origine réelle de `_mjs_layouts`
// et du variant embarqué au build, la page hôte n'a plus qu'à le demander par `layout="bandeau"`
async function loadHarness(withVariant = false) {
  const root   = mjsTmp('host-rewrite')
  const srcDir = join(root, 'src')
  const outDir = join(root, 'out')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(join(srcDir, 'hostlight.mjs'), withVariant ? [HOSTLIGHT_COMPONENT, '<style name="bandeau">', '.t', '  color: green', '</style>'].join('\n') : HOSTLIGHT_COMPONENT)
  writeFileSync(join(srcDir, 'jumeau.mjs'), HOSTLIGHT_COMPONENT)

  const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
  const stats   = await bundler.compile()
  assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

  const window: any   = new Window({ url: 'http://localhost/' })
  const document: any = window.document
  let fetchImpl: (url: string) => Promise<any> = async () => ({ ok: false, status: 404 })
  const fetchCalls: string[] = []
  window.fetch = (url: string) => { fetchCalls.push(url); return fetchImpl(url) }

  const files      = readdirSync(outDir)
  const coreFile   = files.find((f: string) => /^mjs_core-/.test(f))
  const hostFile   = files.find((f: string) => /^hostlight-/.test(f))
  const jumeauFile = files.find((f: string) => /^jumeau-/.test(f))
  assert.ok(coreFile && hostFile && jumeauFile, `sortie du build inattendue : ${files.join(', ')}`)
  window.eval([
    stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
    'globalThis.µ = µ;',
    stripEsm(readFileSync(join(outDir, hostFile!), 'utf-8')),
    stripEsm(readFileSync(join(outDir, jumeauFile!), 'utf-8')),
  ].join('\n'))

  const Ctor       = window.customElements.get('mjs-hostlight')
  const CtorJumeau = window.customElements.get('mjs-jumeau')
  assert.ok(Ctor && CtorJumeau, 'les deux composants doivent être définis')

  return {
    window, document, Ctor, CtorJumeau, fetchCalls,
    setFetch(impl: (url: string) => Promise<any>) { fetchImpl = impl },
  }
}

describe('mode mjs-light, réécriture :host en nom de balise', function () {
  this.timeout(60000)
  after(async () => { await terminateSharedWorkerPool() })

  describe('injection document (non-CSP)', function () {
    it('le <style> léger ne contient plus AUCUN :host et porte les sélecteurs par balise', async () => {
      const { document, Ctor } = await loadHarness()
      Ctor.mjsLight = true
      document.body.innerHTML = '<mjs-hostlight mjs-light></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      const styleEl = document.head.querySelector('style[data-mjs-light="mjs-hostlight"]')
      assert.ok(styleEl, 'le <style> léger doit être posé')
      const css = styleEl.textContent
      assert.equal(css.indexOf(':host'), -1, 'aucun :host ne doit subsister : '+css)
      assert.notEqual(css.indexOf('mjs-hostlight{display:block}'), -1, 'display:block réécrit — bug corrigé (composant léger restait display:inline)')
      assert.notEqual(css.indexOf('mjs-hostlight{padding:20px}'), -1, ':host nu → balise')
      assert.notEqual(css.indexOf('mjs-hostlight.large{padding:40px}'), -1, ':host(.large) → balise.large')
      assert.notEqual(css.indexOf('.dark mjs-hostlight .t{'), -1, ':host-context(.dark) .t → .dark balise .t')
      assert.notEqual(css.indexOf('mjs-hostlight:not(.a) .b{'), -1, ':host(:not(.a)) .b → balise:not(.a) .b, parenthèses imbriquées')
      assert.notEqual(css.indexOf('mjs-hostlight,.x{'), -1, ':host, .x → balise,.x (compressé par sass, sans espace)')
      assert.notEqual(css.indexOf('.ghost{opacity:0}'), -1, 'sélecteur sans rapport intact')
      assert.notEqual(css.indexOf('.t:hover{text-decoration:line-through}'), -1, ':hover intact')
      assert.notEqual(css.indexOf('::slotted(span){opacity:.2}'), -1, '::slotted jamais touché (aucun sens sans shadow)')
      assert.notEqual(css.indexOf('mjs-hostlight{--host-x: 5px}'), -1, 'variable --host-x jamais confondue avec :host, :host porteur réécrit')
    })

    it('deux INSTANCES du même composant léger → UNE seule feuille (déduplication)', async () => {
      const { document, Ctor } = await loadHarness()
      Ctor.mjsLight = true
      document.body.innerHTML = '<mjs-hostlight mjs-light></mjs-hostlight><mjs-hostlight mjs-light></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      const styles = document.head.querySelectorAll('style[data-mjs-light="mjs-hostlight"]')
      assert.equal(styles.length, 1, 'une seule feuille pour 2 instances de LA MÊME balise')
    })

    it('deux composants DIFFÉRENTS au CSS identique → DEUX feuilles (une par balise, réécrites différemment)', async () => {
      const { document, Ctor, CtorJumeau } = await loadHarness()
      Ctor.mjsLight = true
      CtorJumeau.mjsLight = true
      document.body.innerHTML = '<mjs-hostlight mjs-light></mjs-hostlight><mjs-jumeau mjs-light></mjs-jumeau>'
      await new Promise(r => setTimeout(r, 80))
      const hostStyle   = document.head.querySelector('style[data-mjs-light="mjs-hostlight"]')
      const jumeauStyle = document.head.querySelector('style[data-mjs-light="mjs-jumeau"]')
      assert.ok(hostStyle && jumeauStyle, 'les deux balises doivent avoir leur PROPRE feuille malgré le CSS source identique')
      assert.notEqual(hostStyle.textContent, jumeauStyle.textContent, 'chaque feuille porte SON tag, jamais celui du voisin')
      assert.notEqual(hostStyle.textContent.indexOf('mjs-hostlight{padding:20px}'), -1)
      assert.notEqual(jumeauStyle.textContent.indexOf('mjs-jumeau{padding:20px}'), -1)
    })

    it('composant en OMBRE (sans mjs-light) : :host CONSERVÉ, chemin inchangé', async () => {
      const { document } = await loadHarness()
      document.body.innerHTML = '<mjs-hostlight></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      const el: any   = document.body.firstElementChild
      const sheet: any = el._shadow.adoptedStyleSheets.find((s: any) => sheetText(s).indexOf('--host-x') !== -1)
      assert.ok(sheet, 'la feuille du composant doit être adoptée dans le shadow')
      assert.match(sheetText(sheet), /:host/, ':host doit rester intact en mode ombre — vrai shadow root, sélecteur correct')
    })

    it('sous µ._csp vrai : la feuille constructible adoptée porte aussi le sélecteur par balise', async () => {
      const { window, document, Ctor } = await loadHarness()
      window.µ._csp = true
      Ctor.mjsLight = true
      const baseline = window.document.adoptedStyleSheets.length
      document.body.innerHTML = '<mjs-hostlight mjs-light></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      assert.equal(document.head.querySelectorAll('style[data-mjs-light="mjs-hostlight"]').length, 0, 'aucun <style> posé sous csp')
      const news          = window.document.adoptedStyleSheets.slice(baseline)
      const hasRewritten  = news.some((s: any) => sheetText(s).indexOf('mjs-hostlight') !== -1)
      const stillHasHost  = news.some((s: any) => sheetText(s).indexOf(':host') !== -1)
      assert.ok(hasRewritten, 'la feuille constructible doit porter le sélecteur par balise')
      assert.equal(stillHasHost, false, 'aucune feuille adoptée ne doit plus contenir :host')
    })
  })

  describe('variant léger (layout=)', function () {
    it('layout déclaré, mjs-light : le <style> du variant ne contient plus :host', async () => {
      const { document, Ctor, setFetch } = await loadHarness(true)
      Ctor.mjsLight = true
      setFetch(async () => ({ ok: true, status: 200, text: async () => ':host{color:blue}.t{color:green}' }))
      document.body.innerHTML = '<mjs-hostlight mjs-light layout="bandeau"></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      const styleEl = document.head.querySelector('style[data-mjs-light-layout="mjs-hostlight"]')
      assert.ok(styleEl, 'le <style> du variant léger doit être posé')
      const css = styleEl.textContent
      assert.equal(css.indexOf(':host'), -1, ':host doit être réécrit dans le variant aussi : '+css)
      assert.notEqual(css.indexOf('mjs-hostlight{color:blue}'), -1)
      assert.notEqual(css.indexOf('.t{color:green}'), -1, 'le reste du variant est intact')
    })
  })

  describe('µ._hotCss sur un composant léger', function () {
    it('le <style data-mjs-css> est remplacé par le texte RÉÉCRIT, Set de dédup réindexé sur ce texte réécrit', async () => {
      const { window, document, Ctor } = await loadHarness()
      Ctor.mjsLight = true
      document.body.innerHTML = '<mjs-hostlight mjs-light></mjs-hostlight>'
      await new Promise(r => setTimeout(r, 80))
      const µ: any     = window.µ
      const styleEl    = document.head.querySelector('style[data-mjs-css="mjs-hostlight"]')
      assert.ok(styleEl)
      const newCss = ':host{display:inline}.t{color:pink}'
      const ok     = µ._hotCss({ components: { 'mjs-hostlight': newCss } })
      assert.equal(ok, true)
      assert.equal(styleEl.textContent.indexOf(':host'), -1, ':host doit être réécrit par _hotCss aussi')
      assert.notEqual(styleEl.textContent.indexOf('mjs-hostlight{display:inline}'), -1)
      assert.ok(µ._mjs_lightStyleInjected.has(styleEl.textContent), 'le Set de dédup doit indexer le texte RÉÉCRIT, celui réellement posé dans le DOM')
    })
  })

  describe('léger imbriqué dans un hôte à shadow', function () {
    it('la feuille voyage dans le shadow de l\'ancêtre, réécrite — jamais dans document.head', async () => {
      const root   = mjsTmp('host-rewrite-nested')
      const srcDir = join(root, 'src')
      const outDir = join(root, 'out')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'hostlight.mjs'), HOSTLIGHT_COMPONENT)
      writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="wrap">
  <@hostlight mjs-light>
</div>
`)
      const bundler = new Bundler({ sourceDir: srcDir, outputDir: outDir, manifestPath: join(root, 'bundle.js') })
      const stats   = await bundler.compile()
      assert.equal(stats.errors.length, 0, stats.errors.map((e: any) => e.message).join('\n'))

      const window: any   = new Window({ url: 'http://localhost/' })
      const document: any = window.document
      const files     = readdirSync(outDir)
      const coreFile  = files.find((f: string) => /^mjs_core-/.test(f))
      const hostFile  = files.find((f: string) => /^hostlight-/.test(f))
      const outerFile = files.find((f: string) => /^outer-/.test(f))
      assert.ok(coreFile && hostFile && outerFile, `sortie du build inattendue : ${files.join(', ')}`)
      window.eval([
        stripEsm(readFileSync(join(outDir, coreFile!), 'utf-8')),
        'globalThis.µ = µ;',
        stripEsm(readFileSync(join(outDir, hostFile!), 'utf-8')),
        stripEsm(readFileSync(join(outDir, outerFile!), 'utf-8')),
      ].join('\n'))

      // ceinture — happy-dom ne pose pas l'attribut avant le constructor pour un enfant composé
      // (cf. commentaire renderToString.ts) : repli officiel du runtime, propriété
      // statique sur la classe (identique aux autres harnais, cf. runtime-hotcss.test.ts)
      window.customElements.get('mjs-hostlight').mjsLight = true
      document.body.innerHTML = '<mjs-outer></mjs-outer>'
      await new Promise(r => setTimeout(r, 100))
      const outer: any = document.body.querySelector('mjs-outer')
      const inner: any = outer._shadow.querySelector('mjs-hostlight')
      assert.ok(inner, 'le sous-composant léger doit être monté dans le shadow de outer')
      assert.equal(inner._mjs_isLight, true, 'le sous-composant imbriqué doit bien être détecté en mode léger')
      const styleEl = outer._shadow.querySelector('style[data-mjs-light="mjs-hostlight"]')
      assert.ok(styleEl, 'la feuille du léger imbriqué doit être posée DANS le shadow de outer')
      assertAbsent(document.head.querySelector('style[data-mjs-light="mjs-hostlight"]'), 'jamais dans document.head : la frontière shadow ne doit pas être traversée')
      const css = styleEl.textContent
      assert.equal(css.indexOf(':host'), -1, ':host doit être réécrit même imbriqué : '+css)
      assert.notEqual(css.indexOf('mjs-hostlight{padding:20px}'), -1)
    })
  })

  describe('SSR — léger imbriqué', function () {
    it('le HTML sérialisé ne contient plus :host et porte le sélecteur par balise', async () => {
      const root   = mjsTmp('host-rewrite-ssr')
      const srcDir = join(root, 'src')
      mkdirSync(srcDir, { recursive: true })
      writeFileSync(join(srcDir, 'hostlight.mjs'), HOSTLIGHT_COMPONENT)
      writeFileSync(join(srcDir, 'outer.mjs'), `
<div class="wrap">
  <@hostlight mjs-light>
</div>
`)
      const res = await renderToString({ sourceDir: srcDir, tag: 'mjs-outer' })
      // `mjs-outer` a lui-même un VRAI shadow (pas léger) : SON :host{display:block} à lui reste
      // légitime (host réel) — seul le :host du LÉGER IMBRIQUÉ nous intéresse ici, forme unique à
      // sa propre règle de padding, jamais partagée avec outer
      assert.equal(res.html.indexOf(':host{padding:20px}'), -1, ':host du léger imbriqué ne doit plus apparaître brut : '+res.html)
      assert.notEqual(res.html.indexOf('mjs-hostlight{padding:20px}'), -1, 'le sélecteur par balise doit apparaître')
      assert.notEqual(res.html.indexOf('mjs-hostlight{display:block}'), -1, 'le préfixe display:block du léger imbriqué est réécrit aussi')
    })
  })

  describe('parité client/serveur — µ._lightHostCss (runtime) vs lightHostCss (server)', function () {
    it('mêmes entrées → mêmes sorties, sur les 3 formes de :host et un cas de tag différent', async () => {
      const { window } = await loadHarness()
      const clientFn: (css: string, tag: string) => string = window.µ._lightHostCss
      const cases: [string, string][] = [
        [':host{padding:20px}', 'mjs-hostlight'],
        [':host(.large){color:red}', 'mjs-hostlight'],
        [':host-context(.dark) .t{color:blue}', 'mjs-hostlight'],
        [':host(:not(.a)) .b{opacity:.5}', 'mjs-hostlight'],
        [':host,.x{opacity:1}', 'mjs-hostlight'],
        ['.ghost{opacity:0}::slotted(span){opacity:.2}:host{--host-x: 5px}', 'mjs-hostlight'],
        [':host{color:red}', 'mjs-other'],
      ]
      for (const [css, tag] of cases) {
        const clientOut = clientFn(css, tag)
        const serverOut = lightHostCss(css, tag)
        assert.equal(serverOut, clientOut, `divergence pour ${JSON.stringify({ css, tag })}`)
      }
      assert.notEqual(lightHostCss(':host{color:red}', 'mjs-hostlight'), lightHostCss(':host{color:red}', 'mjs-other'), 'le tag doit changer la sortie')
    })

    it('suites de :host chaînés (sans espace) = UN seul composé ; contenu de guillemets jamais réécrit', async () => {
      const { window } = await loadHarness()
      const clientFn: (css: string, tag: string) => string = window.µ._lightHostCss
      const pinned: [string, string, string][] = [
        [':host-context(.a):host(.b){}', 'mjs-x', '.a mjs-x.b{}'],
        [':host(.b):host-context(.a){}', 'mjs-x', '.a mjs-x.b{}'],
        [':host-context(.a):host-context(.c) .t{}', 'mjs-x', '.a .c mjs-x .t{}'],
        [':host(.b):host(.c){}', 'mjs-x', 'mjs-x.b.c{}'],
        [':host:hover{}', 'mjs-x', 'mjs-x:hover{}'],
        [':host(.b):hover{}', 'mjs-x', 'mjs-x.b:hover{}'],
        [':host::before{}', 'mjs-x', 'mjs-x::before{}'],
        ['content: ":host"', 'mjs-x', 'content: ":host"'],
        ['content: "a\\"b"', 'mjs-x', 'content: "a\\"b"'],
      ]
      for (const [css, tag, expected] of pinned) {
        assert.equal(clientFn(css, tag), expected, `client : ${css}`)
        assert.equal(lightHostCss(css, tag), expected, `serveur : ${css}`)
      }
    })
  })
})
